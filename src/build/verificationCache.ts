import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface CachedHash { size: number; mtimeMs: number; ctimeMs: number; ino: number; sha256: string; usedAt: number; }
export interface CachedInventory {
  fingerprint: string; roots: string[];
  dirs: { path: string; mtimeMs: number }[];
  usedAt: number;
}
interface Shape {
  version: 1;
  hashes: Record<string, CachedHash>;
  tools: Record<string, { value: string; usedAt: number }>;
  inventories: Record<string, CachedInventory>;
}
const limits = { hashes: 50000, tools: 128, inventories: 2048 };
const empty = (): Shape => ({ version: 1, hashes: {}, tools: {}, inventories: {} });

export class VerificationCache {
  private data: Shape = empty();
  private readyPromise?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private strictValue = false;
  constructor(private readonly file?: string) {}
  setStrict(value: boolean): void { this.strictValue = value; }
  get strict(): boolean { return this.strictValue; }
  async ready(): Promise<void> {
    if (!this.file) return;
    this.readyPromise ??= (async () => {
      try {
        const stat = await fs.stat(this.file!);
        if (!stat.isFile() || stat.size > 67108864) return;
        const raw: unknown = JSON.parse(await fs.readFile(this.file!, 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        const value = raw as Record<string, unknown>;
        if (value.version !== 1 || typeof value.hashes !== 'object' || typeof value.tools !== 'object'
          || typeof value.inventories !== 'object') return;
        this.data = { version: 1, hashes: value.hashes as Shape['hashes'], tools: value.tools as Shape['tools'],
          inventories: value.inventories as Shape['inventories'] };
        this.prune();
      } catch { this.data = empty(); }
    })();
    await this.readyPromise;
  }
  private key(file: string): string { return path.win32.normalize(file).toLowerCase(); }
  async getHash(file: string, stat: { size: number; mtimeMs: number; ctimeMs: number; ino: number }): Promise<string | undefined> {
    if (this.strictValue) return undefined;
    await this.ready();
    const item = this.data.hashes[this.key(file)];
    if (!item || item.size !== stat.size || item.mtimeMs !== stat.mtimeMs
      || item.ctimeMs !== stat.ctimeMs || item.ino !== stat.ino) return undefined;
    item.usedAt = Date.now();
    return item.sha256;
  }
  async setHash(file: string, stat: { size: number; mtimeMs: number; ctimeMs: number; ino: number }, sha256: string): Promise<void> {
    await this.ready();
    this.data.hashes[this.key(file)] = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
      ino: stat.ino, sha256, usedAt: Date.now() };
    this.prune();
    this.touch();
  }
  async getTool(key: string): Promise<string | undefined> {
    await this.ready();
    const item = this.data.tools[key];
    if (!item) return undefined;
    item.usedAt = Date.now();
    return item.value;
  }
  async setTool(key: string, value: string): Promise<void> {
    await this.ready();
    this.data.tools[key] = { value, usedAt: Date.now() };
    this.prune();
    this.touch();
  }
  async getInventory(key: string): Promise<CachedInventory | undefined> {
    await this.ready();
    const item = this.data.inventories[key];
    if (!item) return undefined;
    item.usedAt = Date.now();
    return item;
  }
  async setInventory(key: string, value: Omit<CachedInventory, 'usedAt'>): Promise<void> {
    await this.ready();
    this.data.inventories[key] = { ...value, usedAt: Date.now() };
    this.prune();
    this.touch();
  }
  async clear(): Promise<void> {
    this.data = empty();
    await this.flush();
  }
  private prune(): void {
    const trim = <T extends { usedAt: number }>(record: Record<string, T>, maximum: number): Record<string, T> => {
      const keys = Object.keys(record);
      if (keys.length <= maximum) return record;
      const keep = new Set(keys.sort((left, right) => record[right].usedAt - record[left].usedAt).slice(0, maximum));
      const next: Record<string, T> = {};
      for (const key of keys) if (keep.has(key)) next[key] = record[key];
      return next;
    };
    this.data.hashes = trim(this.data.hashes, limits.hashes);
    this.data.tools = trim(this.data.tools, limits.tools);
    this.data.inventories = trim(this.data.inventories, limits.inventories);
  }
  private touch(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 400);
    this.timer.unref?.();
  }
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.file) return;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(this.data));
      await fs.rename(temporary, this.file);
    } catch { /* cache is an optimization; failures never block builds */ }
  }
}

let shared = new VerificationCache();
export function configureVerificationCache(file: string | undefined, strict: boolean): VerificationCache {
  shared = new VerificationCache(file);
  shared.setStrict(strict);
  return shared;
}
export function verificationCache(): VerificationCache { return shared; }
export function flushVerificationCache(): Promise<void> { return shared.flush(); }
