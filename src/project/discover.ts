import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { targetForChip } from './targetDetection';

export function suggestChip(ioc: string): { label: string; targetScript?: string } | undefined {
  const match = /^Mcu\.CPN=([^\r\n]+)$/m.exec(ioc);
  const label = match?.[1].trim();
  if (!label || label.length > 128 || !/^[A-Za-z0-9_-]+$/.test(label)) return undefined;
  return { label, targetScript: targetForChip(label) };
}

export async function readChipSuggestion(sourceDirectory: string): Promise<ReturnType<typeof suggestChip>> {
  const files = (await fs.readdir(sourceDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.ioc'));
  if (files.length !== 1) return undefined;
  const file = path.join(sourceDirectory, files[0].name);
  if ((await fs.stat(file)).size > 2097152) throw new Error(t(".ioc 文件超过读取限制"));
  return suggestChip(await fs.readFile(file, 'utf8'));
}

export async function isCmakeProject(directory: string): Promise<boolean> {
  try { return (await fs.stat(path.join(directory, 'CMakeLists.txt'))).isFile(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
