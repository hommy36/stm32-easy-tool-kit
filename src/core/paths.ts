import { t } from '../i18n';
import * as path from 'node:path';

export function mergeToolPath(env: NodeJS.ProcessEnv, directories: string[]): NodeJS.ProcessEnv {
  const result = { ...env };
  const keys = Object.keys(result).filter(key => key.toLowerCase() === 'path');
  const inherited = keys.flatMap(key => (result[key] ?? '').split(path.delimiter));
  for (const key of keys) delete result[key];
  const seen = new Set<string>();
  result.PATH = [...directories, ...inherited].filter(value => {
    if (!value) return false;
    const normalized = path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).join(path.delimiter);
  return result;
}

export function resolveArchiveEntry(root: string, entry: string): string {
  if (!entry || /[\x00-\x1f:]/.test(entry) || /^[\\/]/.test(entry)) {
    throw new Error(t("不安全的压缩包路径: {0}", JSON.stringify(entry)));
  }
  const segments = entry.replace(/\\/g, '/').replace(/\/$/, '').split('/');
  if (segments.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(t("不安全的压缩包路径: {0}", JSON.stringify(entry)));
  }
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(path.resolve(root), resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(t("压缩包条目越过安装目录"));
  }
  return resolved;
}

export function toolBinDirectories(tools: { executables: Record<string, string> }[]): string[] {
  return [...new Set(tools.flatMap(tool => Object.values(tool.executables).map(file => path.dirname(file))))];
}
