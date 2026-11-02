import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ToolInstallation } from '../core/types';
import { SavedProject, projectKeyUri } from '../project/types';
import { inputInventory } from './inventory';
import { VerificationCache, verificationCache } from './verificationCache';

export interface BuildEvidence {
  projectUri: string; configurePreset: string; buildPreset?: string;
  configuration: string; targetId: string;
  binaryDirectory: string; artifact: string; artifactSha256: string;
  inputFiles: string[];
  toolFingerprint: string; inputFingerprint: string; revision: number;
  inputScope: InputScope;
  inventoryFingerprint: string;
  dependencyVerified: boolean;
}
export interface InputScope {
  sourceDirectory: string;
  binaryDirectories: string[];
  includeDirectories?: string[];
  allowedExternalRoots?: string[];
}

export function isWithin(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function secret(file: string): boolean {
  return /^(?:\.env(?:\..*)?|.*\.(?:pwd|kdbx|key|pem))$/i.test(path.basename(file));
}
async function hashFile(file: string, maximum: number, elf = false, cache?: VerificationCache): Promise<{ sha256: string; bytes: number }> {
  if (secret(file)) throw new Error(t("拒绝读取可能包含秘密的构建输入: {0}", path.basename(file)));
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximum) throw new Error(t("构建输入不是普通文件或超过大小限制"));
    const reused = await cache?.getHash(file, before);
    if (reused) return { sha256: reused, bytes: before.size };
    if (elf) {
      const header = Buffer.alloc(52);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead !== 52 || header.readUInt32BE(0) !== 0x7f454c46 || header[4] !== 1 || header[5] !== 1 || header[6] !== 1
        || ![2, 3].includes(header.readUInt16LE(16)) || header.readUInt16LE(18) !== 40) throw new Error(t("固件不是可执行的 32 位小端 ARM ELF"));
    }
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
      bytes += chunk.length;
      if (bytes > maximum) throw new Error(t("构建输入在读取时超过大小限制"));
      hash.update(chunk);
    }
    const after = await handle.stat();
    const current = await fs.stat(file);
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current.ino !== after.ino || current.dev !== after.dev || current.size !== after.size || current.mtimeMs !== after.mtimeMs) throw new Error(t("构建输入在检查期间发生变化，请重新构建"));
    const sha256 = hash.digest('hex');
    await cache?.setHash(file, before, sha256);
    return { sha256, bytes };
  } finally { await handle.close(); }
}
export function inspectArmElf(file: string, cache?: VerificationCache): Promise<{ sha256: string; bytes: number }> { return hashFile(file, 1073741824, true, cache); }

export async function fingerprintInputs(files: string[], cache: VerificationCache = verificationCache()): Promise<string> {
  if (files.length > 20000) throw new Error(t("构建输入文件超过 20000 个"));
  const unique = new Map<string, string>();
  for (const file of files) {
    if (!path.isAbsolute(file)) throw new Error(t("构建输入必须是绝对路径"));
    const canonical = await fs.realpath(file);
    unique.set(canonical.toLowerCase(), canonical);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  for (const [key, file] of [...unique].sort(([left], [right]) => left.localeCompare(right))) {
    const content = await hashFile(file, 33554432, false, cache);
    bytes += content.bytes;
    if (bytes > 536870912) throw new Error(t("构建输入累计超过 512 MiB"));
    hash.update(`${key}\0${content.bytes}\0${content.sha256}\n`);
  }
  return hash.digest('hex');
}

async function toolCacheKey(tools: ToolInstallation[]): Promise<string> {
  const records = [];
  for (const tool of [...tools].sort((a, b) => a.id.localeCompare(b.id))) {
    const files = [];
    for (const [name, file] of Object.entries(tool.executables).sort(([a], [b]) => a.localeCompare(b))) {
      const canonical = await fs.realpath(file);
      const stat = await fs.stat(canonical);
      if (!stat.isFile()) throw new Error(t("工具路径不是文件"));
      files.push([name, canonical.toLowerCase(), stat.size, stat.mtimeMs, stat.ctimeMs]);
    }
    const root = path.basename(tool.root).toLowerCase() === 'bin' ? path.dirname(tool.root) : tool.root;
    let support: unknown = null;
    if (tool.id === 'armGnu') {
      const dirs = [root];
      try {
        for (const entry of await fs.readdir(root, { withFileTypes: true })) if (entry.isDirectory()) dirs.push(path.join(root, entry.name));
      } catch { dirs.length = 0; }
      support = await Promise.all(dirs.map(async directory => [directory.toLowerCase(), (await fs.stat(directory)).mtimeMs]));
    }
    records.push([tool.id, tool.version, tool.root, tool.scriptsDirectory, files, support]);
  }
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

export async function fingerprintTools(tools: ToolInstallation[], cache: VerificationCache = verificationCache()): Promise<string> {
  const key = await toolCacheKey(tools);
  const cached = await cache.getTool(key);
  if (cached) return cached;
  const records = [];
  for (const tool of [...tools].sort((a, b) => a.id.localeCompare(b.id))) {
    const files = [];
    for (const [name, file] of Object.entries(tool.executables).sort(([a], [b]) => a.localeCompare(b))) {
      const canonical = await fs.realpath(file);
      const stat = await fs.stat(canonical);
      if (!stat.isFile()) throw new Error(t("工具路径不是文件"));
      files.push([name, canonical.toLowerCase(), stat.size, stat.mtimeMs, stat.ctimeMs]);
    }
    const root = path.basename(tool.root).toLowerCase() === 'bin' ? path.dirname(tool.root) : tool.root;
    const support = tool.id === 'armGnu' ? (await inputInventory({ sourceDirectory: root, binaryDirectories: [] }, undefined, true, cache)).fingerprint : undefined;
    records.push([tool.id, tool.version, tool.root, tool.scriptsDirectory, files, support]);
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(records)).digest('hex');
  await cache.setTool(key, fingerprint);
  return fingerprint;
}

export async function collectInputFiles(scope: InputScope, explicitFiles: string[]): Promise<string[]> {
  const source = await fs.realpath(scope.sourceDirectory);
  const allowed = await Promise.all([source, ...(scope.allowedExternalRoots ?? [])].map(file => fs.realpath(file)));
  const excluded = scope.binaryDirectories.map(file => path.resolve(file));
  const files = new Map<string, string>();
  const visited = new Set<string>();
  const permitted = (file: string) => allowed.some(root => isWithin(root, file));
  const excludedFile = (file: string) => excluded.some(root => isWithin(root, file));
  const add = async (file: string, explicit = false) => {
    const canonical = await fs.realpath(file);
    if (!explicit && excludedFile(canonical)) return;
    if (!permitted(canonical)) throw new Error(t("构建输入位于未确认的工程/工具范围外: {0}", canonical));
    if (secret(canonical)) throw new Error(t("拒绝读取可能包含秘密的构建输入: {0}", path.basename(canonical)));
    files.set(canonical.toLowerCase(), canonical);
    if (files.size > 20000) throw new Error(t("构建输入文件超过 20000 个"));
  };
  const walk = async (directory: string, headersOnly: boolean, depth = 0): Promise<void> => {
    if (depth > 64) throw new Error(t("构建输入目录深度超过 64 层"));
    const canonical = await fs.realpath(directory);
    if (excludedFile(canonical)) return;
    if (!permitted(canonical)) throw new Error(t("头文件目录位于未确认范围外: {0}", canonical));
    if (path.parse(canonical).root === canonical) throw new Error(t("拒绝扫描整个磁盘作为头文件目录"));
    const key = `${canonical.toLowerCase()}\0${headersOnly}`;
    if (visited.has(key)) return;
    visited.add(key);
    for (const entry of await fs.readdir(canonical, { withFileTypes: true })) {
      const file = path.join(canonical, entry.name);
      const entryStat = entry.isSymbolicLink() ? await fs.stat(file) : entry;
      if (entryStat.isDirectory()) {
        if (!['.git', '.svn', '.cache', 'node_modules', '__pycache__'].includes(entry.name)) await walk(file, headersOnly, depth + 1);
      } else if (entryStat.isFile() && !secret(file)) {
        const extension = path.extname(entry.name);
        const header = /\.(?:h|hh|hpp|hxx|inc|inl)$/i.test(extension) || headersOnly && !extension;
        if (header || !headersOnly && (/\.(?:c|cc|cpp|cxx|s|asm|ld|ioc|cmake)$/i.test(extension)
          || ['CMakeLists.txt', 'CMakePresets.json', 'CMakeUserPresets.json'].includes(entry.name))) await add(file);
      }
    }
  };
  for (const file of explicitFiles) await add(file, true);
  await walk(source, false);
  for (const directory of scope.includeDirectories ?? []) {
    try { await walk(directory, true); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return [...files.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

export async function assertEvidenceCurrent(evidence: BuildEvidence, saved: SavedProject, tools: ToolInstallation[], requireDependencies = true,
  cache: VerificationCache = verificationCache()): Promise<void> {
  if (requireDependencies && !evidence.dependencyVerified) throw new Error(t("实际构建依赖未确认，不能下载或调试"));
  if ((await inputInventory(evidence.inputScope, undefined, false, cache)).fingerprint !== evidence.inventoryFingerprint) throw new Error(t("输入文件目录清单已变化，请重新构建"));
  const settings = saved.settings;
  if (saved.revision !== evidence.revision || projectKeyUri(settings.projectUri) !== projectKeyUri(evidence.projectUri)
    || path.resolve(settings.sourceDirectory).toLowerCase() !== path.resolve(evidence.inputScope.sourceDirectory).toLowerCase()
    || settings.configurePreset !== evidence.configurePreset || settings.buildPreset !== evidence.buildPreset
    || settings.targetId !== evidence.targetId || settings.configuration !== undefined && settings.configuration !== evidence.configuration) throw new Error(t("工程配置已变化，请重新构建"));
  if (await fingerprintTools(tools, cache) !== evidence.toolFingerprint) throw new Error(t("所选工具已变化，请重新构建"));
  const files = await collectInputFiles(evidence.inputScope, evidence.inputFiles);
  if (await fingerprintInputs(files, cache) !== evidence.inputFingerprint) throw new Error(t("源码/头文件/配置已变化，请重新构建"));
  if ((await inspectArmElf(evidence.artifact, cache)).sha256 !== evidence.artifactSha256) throw new Error(t("ELF 内容已变化，请重新构建"));
}
