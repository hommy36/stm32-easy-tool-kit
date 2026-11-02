import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

export type CubeMxRunner = (executable: string, ioc: string) => void;

const skipDirectories = new Set(['.git', '.svn', '.cache', '.idea', 'node_modules', '__pycache__']);
function skipped(name: string): boolean {
  return skipDirectories.has(name) || /^build$|^cmake-build-/i.test(name);
}

export async function findIocFiles(directory: string, depth = 3, limit = 200): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, level: number): Promise<void> => {
    if (found.length >= limit || level > depth) return;
    let entries: Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (found.length >= limit) return;
      if (skipped(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file, level + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.ioc')) found.push(file);
    }
  };
  await walk(directory, 0);
  return found.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
}

export async function executableExists(file: string): Promise<boolean> {
  if (!file || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.exe') return false;
  try { const stat = await fs.stat(file); return stat.isFile(); }
  catch { return false; }
}

export function commonCubeMxPaths(environment: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [environment.ProgramFiles, environment['ProgramFiles(x86)']].filter((value): value is string => Boolean(value));
  const suffix = path.join('STMicroelectronics', 'STM32Cube', 'STM32CubeMX', 'STM32CubeMX.exe');
  return roots.map(root => path.join(root, suffix));
}

export const spawnCubeMx: CubeMxRunner = (executable, ioc) => {
  const child = spawn(executable, [ioc], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
};
