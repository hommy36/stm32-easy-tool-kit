import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CheckResult, ToolId, ToolInstallation, toolIds } from '../core/types';
import { replaceFile } from '../core/atomicFile';

export class ToolState {
  readonly results = new Map<ToolId, CheckResult[]>();
  private readonly listeners = new Set<() => void>();
  private operating = false;
  get isBusy(): boolean { return this.operating; }
  readonly onDidChange = (listener: () => void): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  refresh(): void { for (const listener of this.listeners) listener(); }
  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.operating) throw new Error(t("已有工具操作正在进行，请等待完成"));
    this.operating = true;
    this.refresh();
    try { return await action(); }
    finally { this.operating = false; this.refresh(); }
  }
  constructor(private readonly directory: string) {}

  /** Validate everything before activation; restore previous tool choices if the project commit fails. */
  async withSelections<T>(prepare: () => Promise<ToolInstallation[]>, commit: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const previous = await this.list();
      const previousResults = new Map(this.results);
      const selections = await prepare();
      const touched: ToolId[] = [];
      try {
        for (const tool of selections) { touched.push(tool.id); await this.select(tool); }
        return await commit();
      } catch (error) {
        for (const id of touched.reverse()) {
          const old = previous.find(tool => tool.id === id);
          if (old) await this.select(old);
          else { await fs.rm(path.join(this.directory, `${id}.json`), { force: true }); this.results.delete(id); }
        }
        for (const id of touched) {
          const checks = previousResults.get(id);
          if (checks) this.results.set(id, checks);
        }
        this.refresh(); throw error;
      }
    });
  }

  async list(): Promise<ToolInstallation[]> {
    const tools: ToolInstallation[] = [];
    for (const id of toolIds) {
      try {
        const raw: unknown = JSON.parse(await fs.readFile(path.join(this.directory, `${id}.json`), 'utf8'));
        if (!raw || typeof raw !== 'object') throw new Error(t("工具状态损坏: {0}", id));
        const value = raw as Record<string, unknown>;
        if (value.id !== id || typeof value.root !== 'string' || !path.isAbsolute(value.root)
          || typeof value.version !== 'string' || !['managed', 'external'].includes(String(value.source))
          || !value.executables || typeof value.executables !== 'object' || Array.isArray(value.executables)
          || !Object.values(value.executables).every(file => typeof file === 'string' && path.isAbsolute(file))
          || Object.keys(value.executables).length === 0
          || (value.scriptsDirectory !== undefined && (typeof value.scriptsDirectory !== 'string' || !path.isAbsolute(value.scriptsDirectory)))) {
          throw new Error(t("工具状态字段无效: {0}", id));
        }
        tools.push(raw as ToolInstallation);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return tools;
  }

  async select(tool: ToolInstallation): Promise<void> {
    if (!toolIds.includes(tool.id)) throw new Error(t("工具 ID 无效"));
    await fs.mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, `${tool.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(tool, null, 2), { flag: 'wx' });
      await replaceFile(temporary, target);
      this.results.delete(tool.id);
      this.refresh();
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async get(id: ToolId): Promise<ToolInstallation> {
    const tool = (await this.list()).find(item => item.id === id);
    if (!tool) throw new Error(t("尚未配置 {0}，请先安装或选择已有工具", id));
    return tool;
  }
}
