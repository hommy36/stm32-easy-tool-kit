import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CheckResult, ToolId, ToolInstallation } from '../core/types';
import { checkInstallation } from './check';
import { findClionOpenOcdDirectories } from './clion';

export const executableNames: Record<ToolId, Record<string, string>> = {
  armGnu: { gcc: 'arm-none-eabi-gcc.exe', gpp: 'arm-none-eabi-g++.exe', gdb: 'arm-none-eabi-gdb.exe', objcopy: 'arm-none-eabi-objcopy.exe', objdump: 'arm-none-eabi-objdump.exe', nm: 'arm-none-eabi-nm.exe', size: 'arm-none-eabi-size.exe' },
  cmake: { cmake: 'cmake.exe' }, ninja: { ninja: 'ninja.exe' }, openocd: { openocd: 'openocd.exe' }
};

export async function exists(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw error;
  }
}

export async function findCandidates(id: ToolId, warn: (message: string) => void = () => {}): Promise<string[]> {
  const firstName = Object.values(executableNames[id])[0];
  const envPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const candidates: string[] = [];
  for (const directory of envPath.split(path.delimiter)) {
    if (directory && path.isAbsolute(directory) && await exists(path.join(directory, firstName))) candidates.push(directory);
  }
  if (id === 'openocd') candidates.push(...await findClionOpenOcdDirectories(undefined, warn));
  const seen = new Set<string>();
  return candidates.filter(directory => {
    const key = path.normalize(directory).replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function validateExistingTool(id: ToolId, selected: string, signal?: AbortSignal, checked?: (results: CheckResult[]) => void): Promise<ToolInstallation> {
  if (!path.isAbsolute(selected)) throw new Error(t("请选择绝对安装路径"));
  const root = await fs.realpath(selected);
  const executables: Record<string, string> = {};
  for (const [key, name] of Object.entries(executableNames[id])) {
    const file = await exists(path.join(root, 'bin', name)) ? path.join(root, 'bin', name) : path.join(root, name);
    if (!await exists(file)) throw new Error(t("缺少工具文件: {0}", file));
    executables[key] = file;
  }
  let scriptsDirectory: string | undefined;
  if (id === 'openocd') {
    const bases = [root, path.dirname(root)];
    for (const base of bases) {
      for (const suffix of ['share/openocd/scripts', 'openocd/scripts', 'scripts']) {
        const directory = path.join(base, suffix);
        if (await exists(path.join(directory, 'interface/cmsis-dap.cfg'))) { scriptsDirectory = directory; break; }
      }
      if (scriptsDirectory) break;
    }
    if (!scriptsDirectory) throw new Error(t("未找到 OpenOCD scripts/interface/cmsis-dap.cfg，请选择完整发行包目录"));
  }
  const tool: ToolInstallation = { id, version: 'external', root, source: 'external', executables, scriptsDirectory };
  const results = await checkInstallation(tool, signal);
  signal?.throwIfAborted();
  const failed = results.filter(result => result.status === 'error');
  if (failed.length) throw new Error(failed.map(result => `${result.summary}\n${result.evidence.join('\n')}`).join('\n'));
  const version = results.find(result => result.code === 'version')?.evidence[0];
  tool.version = version?.split(/\r?\n/)[0].trim().slice(0, 180) ?? 'external';
  checked?.(results);
  return tool;
}
