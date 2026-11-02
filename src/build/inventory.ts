import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { InputScope } from './artifacts';
import { VerificationCache, verificationCache } from './verificationCache';

async function inventoryKey(scope: InputScope, metadata: boolean): Promise<string> {
  const record = [metadata, await fs.realpath(scope.sourceDirectory),
    ...await Promise.all((scope.includeDirectories ?? []).map(file => fs.realpath(file))),
    ...(scope.allowedExternalRoots ?? []).map(file => path.resolve(file)),
    ...scope.binaryDirectories.map(file => path.resolve(file))].map(value => typeof value === 'string' ? value.toLowerCase() : value);
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

export async function inputInventory(scope: InputScope, approve?: (file: string) => Promise<boolean>, metadata = false,
  cache: VerificationCache = verificationCache()): Promise<{ fingerprint: string; roots: string[] }> {
  const roots = await Promise.all([scope.sourceDirectory, ...(scope.allowedExternalRoots ?? [])].map(file => fs.realpath(file)));
  const excluded = scope.binaryDirectories.map(file => path.resolve(file));
  const within = (root: string, file: string) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  const key = await inventoryKey(scope, metadata);
  const cached = await cache.getInventory(key);
  if (cached) {
    const stable = await Promise.all(cached.dirs.map(async directory => {
      try { return (await fs.stat(directory.path)).mtimeMs === directory.mtimeMs; }
      catch { return false; }
    }));
    if (stable.every(Boolean)) return { fingerprint: cached.fingerprint, roots: cached.roots };
  }
  const records: string[] = [], visited = new Set<string>(), dirs: { path: string; mtimeMs: number }[] = [];
  let count = 0;
  const walk = async (file: string, depth: number): Promise<void> => {
    if (depth > 64 || ++count > 40000) throw new Error(t("构建输入目录清单超过范围限制"));
    if (excluded.some(root => within(root, file))) return;
    const stat = await fs.lstat(file);
    const canonical = stat.isSymbolicLink() ? await fs.realpath(file) : file;
    if (excluded.some(root => within(root, canonical))) return;
    if (!roots.some(root => within(root, canonical))) {
      if (!approve || !await approve(canonical)) throw new Error(t("符号链接输入位于未确认范围外: {0}", canonical));
      roots.push(canonical);
    }
    const actual = stat.isSymbolicLink() ? await fs.stat(canonical) : stat;
    records.push(`${file.toLowerCase()}\0${canonical.toLowerCase()}\0${actual.isDirectory() ? 'd' : 'f'}${metadata && actual.isFile() ? `\0${actual.size}\0${actual.mtimeMs}\0${actual.ctimeMs}` : ''}`);
    if (!actual.isDirectory() || visited.has(canonical.toLowerCase())) return;
    if (path.parse(canonical).root === canonical) throw new Error(t("拒绝扫描整个磁盘作为输入目录"));
    visited.add(canonical.toLowerCase());
    dirs.push({ path: canonical, mtimeMs: actual.mtimeMs });
    for (const entry of await fs.readdir(canonical, { withFileTypes: true })) {
      if (['.git', '.svn', '.cache', 'node_modules', '__pycache__'].includes(entry.name) || /^(?:\.env(?:\..*)?|.*\.(?:pwd|kdbx|key|pem))$/i.test(entry.name)) continue;
      await walk(path.join(canonical, entry.name), depth + 1);
    }
  };
  for (const directory of [scope.sourceDirectory, ...(scope.includeDirectories ?? [])]) {
    try { await walk(await fs.realpath(directory), 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const fingerprint = createHash('sha256').update(records.sort().join('\n')).digest('hex');
  await cache.setInventory(key, { fingerprint, roots, dirs });
  return { fingerprint, roots };
}
