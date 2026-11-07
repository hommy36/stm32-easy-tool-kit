import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface FirmwareTarget {
  id: string; name: string; configuration: string;
  artifacts: string[]; sourceFiles: string[]; includeDirectories: string[]; linkFragments?: string[];
}
export interface BuildModel {
  sourceDirectory: string; binaryDirectory: string;
  targets: FirmwareTarget[]; cmakeInputFiles: string[];
  cache: Map<string, string>; indexToken: string;
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(t("CMake File API 对象格式无效"));
  return raw as Record<string, unknown>;
}
function text(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 32768 || /[\x00-\x1f]/.test(raw)) throw new Error(t("CMake File API 文本无效"));
  return raw;
}
function array(raw: unknown, maximum = 20000): unknown[] {
  if (!Array.isArray(raw) || raw.length > maximum) throw new Error(t("CMake File API 数组无效或超限"));
  return raw;
}
function replyDirectory(binaryDirectory: string): string { return path.join(binaryDirectory, '.cmake/api/v1/reply'); }

export async function prepareFileApi(binaryDirectory: string): Promise<void> {
  if (!path.isAbsolute(binaryDirectory)) throw new Error(t("构建目录必须为绝对路径"));
  const query = path.join(binaryDirectory, '.cmake/api/v1/query/client-stm32-easy');
  await fs.mkdir(query, { recursive: true });
  for (const request of ['codemodel-v2', 'cache-v2', 'cmakeFiles-v1', 'toolchains-v1']) {
    const file = path.join(query, request);
    try { await fs.writeFile(file, '', { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}

async function latestIndex(binaryDirectory: string): Promise<{ file: string; token: string } | undefined> {
  const directory = replyDirectory(binaryDirectory);
  let entries: string[];
  try { entries = await fs.readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const files = entries.filter(name => /^index-[A-Za-z0-9_.-]+\.json$/.test(name)).sort();
  if (!files.length) return undefined;
  const file = path.join(directory, files[files.length - 1]);
  const stat = await fs.stat(file);
  return { file, token: `${path.basename(file)}:${stat.mtimeMs}:${stat.size}` };
}
export async function fileApiStamp(binaryDirectory: string): Promise<string | undefined> {
  return (await latestIndex(binaryDirectory))?.token;
}

export async function readBuildModel(binaryDirectory: string): Promise<BuildModel> {
  const latest = await latestIndex(binaryDirectory);
  if (!latest) throw new Error(t("还没有本插件的 CMake 配置结果，请先配置"));
  const replyRoot = await fs.realpath(replyDirectory(binaryDirectory));
  const read = async (name: string, limit = 16777216): Promise<Record<string, unknown>> => {
    if (!name || path.basename(name) !== name || /[\\/:\x00-\x1f]/.test(name) || !name.endsWith('.json')) throw new Error(t("CMake File API 文件引用越界"));
    const file = await fs.realpath(path.join(replyRoot, name));
    if (path.relative(replyRoot, path.dirname(file)) !== '') throw new Error(t("CMake File API 文件引用越界"));
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > limit) throw new Error(t("CMake File API 文件无效或超过大小限制"));
    const data = await fs.readFile(file, 'utf8');
    if (data.length > limit) throw new Error(t("CMake File API 文件超过大小限制"));
    return object(JSON.parse(data));
  };
  const index = await read(path.basename(latest.file), 2097152);
  const replies = object(object(index.reply)['client-stm32-easy']);
  const kind = async (name: string, major: number): Promise<Record<string, unknown>> => {
    const ref = object(replies[`${name}-v${major}`]);
    if (ref.error || ref.kind !== name || object(ref.version).major !== major) throw new Error(t("CMake File API 不支持 {0}-v{1}", name, major));
    return read(text(ref.jsonFile));
  };
  const codemodel = await kind('codemodel', 2);
  const paths = object(codemodel.paths);
  const sourceDirectory = path.resolve(text(paths.source));
  const actualBinary = path.resolve(text(paths.build));
  if (path.win32.normalize(actualBinary).toLowerCase() !== path.win32.normalize(binaryDirectory).toLowerCase()) throw new Error(t("CMake File API 构建目录身份不匹配"));
  const cacheData = await kind('cache', 2);
  const cache = new Map<string, string>();
  for (const entry of array(cacheData.entries)) { const value = object(entry); cache.set(text(value.name), text(value.value)); }
  const inputData = await kind('cmakeFiles', 1);
  const cmakeInputFiles = array(inputData.inputs).flatMap(raw => {
    const entry = object(raw);
    return entry.isGenerated === true ? [] : [path.resolve(sourceDirectory, text(entry.path))];
  });
  const targets: FirmwareTarget[] = [];
  for (const raw of array(codemodel.configurations, 256)) {
    const configuration = object(raw);
    const configurationName = text(configuration.name);
    for (const targetRef of array(configuration.targets, 4096)) {
      const reference = object(targetRef);
      const target = await read(text(reference.jsonFile), 8388608);
      if (target.type !== 'EXECUTABLE') continue;
      if (target.id !== reference.id || target.name !== reference.name) throw new Error(t("CMake File API 目标引用身份不匹配"));
      targets.push({ id: text(target.id), name: text(target.name), configuration: configurationName,
        linkFragments: target.link ? array(object(target.link).commandFragments ?? []).map(raw => text(object(raw).fragment)) : [],
        artifacts: target.artifacts === undefined ? [] : array(target.artifacts, 256).map(raw => path.resolve(actualBinary, text(object(raw).path))),
        sourceFiles: target.sources === undefined ? [] : array(target.sources).flatMap(raw => {
          const source = object(raw);
          return source.isGenerated === true ? [] : [path.resolve(sourceDirectory, text(source.path))];
        }),
        includeDirectories: [...new Set(array(target.compileGroups ?? [], 4096).flatMap(raw =>
          array(object(raw).includes ?? []).map(include => path.resolve(sourceDirectory, text(object(include).path)))))] });
    }
  }
  return { sourceDirectory, binaryDirectory: actualBinary, targets, cmakeInputFiles, cache, indexToken: latest.token };
}
