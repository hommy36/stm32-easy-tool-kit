import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface ChipTarget { label: string; targetScript: string; evidence: string[]; available: boolean; }
/** Prefer the canonical family script; never infer a dual-bank variant or another probe. */
export function targetForChip(chip: string): string | undefined {
  const name = chip.toUpperCase();
  if (/^STM32H7[RS]/.test(name)) return 'target/stm32h7rsx.cfg';
  const family = /^STM32(WBA|WB|WL|F[012347]|G[04]|H[57]|L[0145]|U[035]|C[05]|N6)/.exec(name)?.[1]?.toLowerCase();
  if (!family) return undefined;
  return `target/stm32${family}${['l0','l1'].includes(family) ? '' : 'x'}.cfg`;
}
const tokens = (text: string): string[] => [...new Set((text.match(/\bSTM32(?:WBA|WB|WL|[FGHLUCN]\d)[A-Za-z0-9]*/gi) ?? []).map(value => value.toUpperCase()))];
export async function detectChipTargets(source: string, scripts?: string): Promise<ChipTarget[]> {
  const root = await fs.realpath(source), entries = await fs.readdir(root, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() && (entry.name.toLowerCase().endsWith('.ioc') || entry.name === 'CMakeLists.txt')).map(entry => path.join(root, entry.name));
  for (const directory of ['cmake', 'Core/Inc']) {
    try {
      const folder = path.join(root, directory), actual = await fs.realpath(folder);
      if (!within(root, actual)) continue;
      const children = await fs.readdir(folder, { withFileTypes: true });
      files.push(...children.filter(entry => entry.isFile() && (directory === 'cmake' ? entry.name.endsWith('.cmake') : /^stm32\w+_hal_conf\.h$/i.test(entry.name))).map(entry => path.join(folder, entry.name)));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const matches = new Map<string, ChipTarget>();
  const add = (chip: string, file: string) => {
    const targetScript = targetForChip(chip); if (!targetScript) return;
    const existing = matches.get(targetScript);
    if (existing) {
      if (chip.replace(/X+$/, '').length > existing.label.replace(/X+$/, '').length) existing.label = chip;
      if (!existing.evidence.includes(file)) existing.evidence.push(file);
    } else matches.set(targetScript, { label: chip, targetScript, evidence: [file], available: false });
  };
  for (const entry of entries.filter(entry => entry.isFile() && /\.(ld|s)$/i.test(entry.name))) for (const chip of tokens(entry.name.replace(/[_-]/g,' '))) add(chip, entry.name);
  let total = 0;
  for (const file of files.sort((a,b) => Number(b.endsWith('.ioc')) - Number(a.endsWith('.ioc'))).slice(0,64)) {
    const actual = await fs.realpath(file); if (!within(root, actual)) continue;
    const stat = await fs.stat(file); if (stat.size > 1048576 || (total += stat.size) > 4194304) continue;
    const text = await fs.readFile(file, 'utf8'), relative = path.relative(root, file);
    if (file.toLowerCase().endsWith('.ioc')) {
      const chip = /^Mcu\.(?:CPN|Name)=([^\r\n]+)/m.exec(text)?.[1];
      if (chip) for (const value of tokens(chip)) add(value, relative);
    } else for (const chip of tokens(text)) add(chip, relative);
  }
  const result: ChipTarget[] = [];
  for (const item of matches.values()) {
    if (scripts) {
      try { item.available = (await fs.stat(path.join(scripts, item.targetScript))).isFile(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    result.push(item);
  }
  return result.sort((a,b) => a.label.localeCompare(b.label));
}
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
