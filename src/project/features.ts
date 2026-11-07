import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { replaceFile } from '../core/atomicFile';
import { isWithin } from '../build/artifacts';
import { OptimizationLevel, optimizationLevel } from '../build/optimization';
export interface FeatureSettings {
  build?: { optimization?: OptimizationLevel };
  version: 1; memory?: { budgets?: Record<string, number> };
  runtime?: { enabled?: boolean; autoDetect?: boolean; address?: number; searchBytes?: number; channel?: number; firmwareId?: string; cacheCoherent?: boolean; samplePeriodMs?: 100 | 200 | 500 | 1000 };
  debug?: { svd?: string; rtos?: 'FreeRTOS'; core?: 'm0' | 'm3' | 'm4' | 'm7' | 'm33';
    stack?: { low: number; high: number; pointer: 'msp' | 'psp' }; heapImplementation?: 'heap_4' | 'heap_5' };
  tools?: Record<string, string>;
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export function validateFeatures(value: unknown): FeatureSettings {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item);
  if (!object(value)) throw new Error('Feature settings must be an object.');
  const settings = value as unknown as FeatureSettings;
  if (settings.version !== 1 || Object.keys(settings).some(key => !['version','build','memory','runtime','debug','tools'].includes(key))) throw new Error('Unsupported feature configuration.');
  for (const key of ['build','memory','runtime','debug','tools'] as const) if (settings[key] !== undefined && !object(settings[key])) throw new Error(`Feature ${key} must be an object.`);
  if (settings.build) {
    if (Object.keys(settings.build).some(key => key !== 'optimization')) throw new Error('Invalid build feature configuration.');
    if (settings.build.optimization !== undefined) optimizationLevel(settings.build.optimization);
  }
  if (settings.memory?.budgets !== undefined && !object(settings.memory.budgets)) throw new Error('Memory budgets must be an object.');
  const integer = (value: unknown, maximum = 0xffffffff) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
  if (settings.runtime) {
    const r = settings.runtime;
    if (Object.keys(r).some(key => !['enabled','autoDetect','address','searchBytes','channel','firmwareId','cacheCoherent','samplePeriodMs'].includes(key)) || r.autoDetect !== undefined && typeof r.autoDetect !== 'boolean' ||
      r.enabled !== undefined && typeof r.enabled !== 'boolean' || r.cacheCoherent !== undefined && typeof r.cacheCoherent !== 'boolean' ||
      r.samplePeriodMs !== undefined && ![100,200,500,1000].includes(r.samplePeriodMs) ||
      r.address !== undefined && !integer(r.address) || r.searchBytes !== undefined && (!integer(r.searchBytes, 16777216) || r.searchBytes < 24) ||
      r.channel !== undefined && !integer(r.channel, 15) || r.firmwareId !== undefined && !/^[A-Za-z0-9_.-]{1,80}$/.test(r.firmwareId)) throw new Error('Invalid RTT configuration.');
    if (r.enabled && (r.address === undefined || !r.firmwareId)) throw new Error('RTT requires a control-block address and expected firmware ID.');
    if (r.address !== undefined && r.address + (r.searchBytes ?? 256) > 0x100000000) throw new Error('RTT address range exceeds 32-bit memory.');
  }
  if (settings.memory) {
    if (Object.keys(settings.memory).some(key => key !== 'budgets') || settings.memory.budgets && (typeof settings.memory.budgets !== 'object' || Object.entries(settings.memory.budgets).some(([key,v]) => key.length > 128 || !integer(v)))) throw new Error('Invalid memory budgets.');
  }
  if (settings.debug) {
    const d = settings.debug;
    if (Object.keys(d).some(key => !['svd','rtos','core','stack','heapImplementation'].includes(key)) || d.rtos !== undefined && d.rtos !== 'FreeRTOS' || d.core !== undefined && !['m0','m3','m4','m7','m33'].includes(d.core) ||
      d.svd !== undefined && (typeof d.svd !== 'string' || path.isAbsolute(d.svd) || /(^|[\\/])\.\.([\\/]|$)|[\x00-\x1f]/.test(d.svd))) throw new Error('Invalid debug feature configuration.');
    if (d.stack !== undefined && (!object(d.stack) || !integer(d.stack.low) || !integer(d.stack.high) || d.stack.high <= d.stack.low || !['msp','psp'].includes(d.stack.pointer) || Object.keys(d.stack).some(key=>!['low','high','pointer'].includes(key)))) throw new Error('Invalid explicit stack bounds.');
    if (d.heapImplementation !== undefined && !['heap_4','heap_5'].includes(d.heapImplementation)) throw new Error('Unsupported paused heap implementation.');
  }
  if (settings.tools && (typeof settings.tools !== 'object' || Object.entries(settings.tools).some(([key,v]) => !['armGnu','cmake','ninja','openocd'].includes(key) || typeof v !== 'string' || v.length > 180))) throw new Error('Invalid tool version requirements.');
  return settings;
}
export async function readFeatures(source: string): Promise<{ settings: FeatureSettings; revision: string }> {
  const file = path.join(source, '.vscode', 'stm32-easy.features.json');
  try { if(!isWithin(await fs.realpath(source),await fs.realpath(file)))throw new Error('Feature settings escape the project.'); if ((await fs.stat(file)).size > 65536) throw new Error('Feature settings exceed 64 KiB.'); const text = await fs.readFile(file, 'utf8'); return { settings: validateFeatures(JSON.parse(text)), revision: digest(text) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { settings: { version: 1 }, revision: digest('') }; throw error; }
}
export async function saveFeatures(source: string, settings: FeatureSettings, expected: string): Promise<void> {
  validateFeatures(settings); const directory = path.join(source, '.vscode'); await fs.mkdir(directory, { recursive: true });
  if (!(await fs.realpath(directory)).toLowerCase().startsWith((await fs.realpath(source)).toLowerCase() + path.sep)) throw new Error('Feature directory escapes project.');
  const file = path.join(directory, 'stm32-easy.features.json'), temporary = `${file}.${randomUUID()}.tmp`;
  const lock = await fs.open(`${file}.lock`, 'wx');
  try { await lock.writeFile(JSON.stringify({ pid: process.pid })); if ((await readFeatures(source)).revision !== expected) throw new Error('Feature settings changed; reload before saving.');
    await fs.writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx' }); await replaceFile(temporary, file);
  } finally { await lock.close(); await fs.rm(`${file}.lock`, { force: true }); await fs.rm(temporary, { force: true }); }
}
