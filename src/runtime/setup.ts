import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FirmwareTarget } from '../build/fileApi';
import { inspectArmElf, isWithin } from '../build/artifacts';
import { captureTool } from '../memory/service';
import { parseSections, parseSymbols } from '../memory/parsers';
import { ElfByteReader } from '../memory/hex';
import { ToolInstallation } from '../core/types';
import { FeatureSettings } from '../project/features';
import { replaceFile } from '../core/atomicFile';

export interface MonitorIdentity { address: number; firmwareId?: string; }
/** Use the active ELF, never a cached report or a guessed target-name firmware ID. */
export async function detectMonitor(file: string, sha: string, tools: ToolInstallation[], signal: AbortSignal): Promise<MonitorIdentity | undefined> {
  const arm = tools.find(tool => tool.id === 'armGnu');
  if (!arm?.executables.nm || !arm.executables.objdump) throw new Error('Arm GNU objdump and nm are required for memory analysis.');
  if ((await inspectArmElf(file)).sha256 !== sha) throw new Error('ELF changed since analysis. Rebuild or refresh the report.');
  const [names, headers] = await Promise.all([
    captureTool(arm.executables.nm, ['-S', '-n', '--defined-only', file], signal),
    captureTool(arm.executables.objdump, ['-h', file], signal)
  ]);
  const symbols = parseSymbols(names), sections = parseSections(headers);
  const rtt = symbols.filter(symbol => symbol.name === '_STM32_EASY_RTT');
  let result: MonitorIdentity | undefined;
  if (rtt.length === 1) {
    const control = rtt[0];
    if (control.size < 48 || control.address % 4 || !sections.some(s => s.alloc && !s.readonly && control.address >= s.vma && control.address + control.size <= s.vma + s.size)) throw new Error('RTT control block is outside writable ELF memory.');
    result = { address: control.address };
    const ids = symbols.filter(symbol => symbol.name === 'stme_firmware_id');
    if (ids.length === 1) {
      const id = ids[0], section = sections.find(s => s.alloc && s.load && id.address >= s.vma && id.address + id.size <= s.vma + s.size);
      if (!section || id.size < 2 || id.size > 81) throw new Error('Invalid monitor firmware ID in ELF.');
      const page = await new ElfByteReader().read(file, sha, section, id, 0);
      const bytes = Buffer.from(page.bytes), end = bytes.indexOf(0);
      const value = bytes.subarray(0, end).toString('ascii');
      if (end < 1 || bytes.subarray(0, end).some(byte => byte > 127) || !/^[A-Za-z0-9_.-]{1,80}$/.test(value)) throw new Error('Invalid monitor firmware ID in ELF.');
      result.firmwareId = value;
    }
  }
  signal.throwIfAborted();
  if ((await inspectArmElf(file)).sha256 !== sha) throw new Error('ELF changed while reading bytes. Refresh the report.');
  return result;
}
export function monitorDefaults(current: FeatureSettings, identity: Required<MonitorIdentity>): FeatureSettings {
  return { ...current, version: 1, runtime: { ...current.runtime, enabled: true, autoDetect: true,
    address: identity.address, firmwareId: identity.firmwareId, searchBytes: 48, channel: 0,
    samplePeriodMs: current.runtime?.samplePeriodMs ?? 1000,
    cacheCoherent: current.runtime?.cacheCoherent ?? false } };
}
export interface SetupChange { file: string; before?: string; after: string; }
export interface MonitorSetupPlan { source: string; mode: 'bare' | 'freertos'; changes: SetupChange[]; }
export async function planSamplingUpdate(source: string, targetName: string, periodMs: 100 | 200 | 500 | 1000): Promise<SetupChange> {
  if (![100,200,500,1000].includes(periodMs)) throw new Error('Unsupported heap sampling period.');
  if (!/^[A-Za-z_][A-Za-z0-9_.+-]*$/.test(targetName)) throw unsupported();
  const root = await fs.realpath(source), file = path.join(source, 'CMakeLists.txt'), before = await localText(root, file);
  const component = path.join(source, 'stm32-easy-monitor');
  const setup = await localText(root, path.join(component, 'stm32_easy_setup.c'));
  const setupCmake = await localText(root, path.join(component, 'stm32_easy_setup.cmake'));
  const marker = '# STM32 Easy Monitor (remove this block to unlink the component)';
  if (!before.includes(marker) || !setup.includes('const char stme_firmware_id[]') || !setupCmake.includes('stm32_easy_monitor(${target})')) throw unsupported();
  const lines = before.split(/\r?\n/), call = 'stm32_easy_setup(' + targetName + ')';
  const callLines = lines.flatMap((line, index) => line.trim() === call ? [index] : []);
  if (callLines.length !== 1) throw unsupported();
  const prefix = 'target_compile_definitions(' + targetName + ' PRIVATE STME_HEAP_PERIOD_MS=';
  const definitions = lines.flatMap((line, index) => {
    const value = line.trim();
    return value.startsWith(prefix) && /^\d+\)$/.test(value.slice(prefix.length)) ? [index] : [];
  });
  if (definitions.length > 1) throw unsupported();
  if (definitions.length === 1) {
    const index = definitions[0], indent = lines[index].match(/^\s*/)?.[0] ?? '';
    lines[index] = indent + prefix + periodMs + ')';
  } else lines.splice(callLines[0] + 1, 0, prefix + periodMs + ')');
  const newline = before.includes('\r\n') ? '\r\n' : '\n';
  const after = lines.join(newline);
  return {file, before, after};
}
const unsupported = () => new Error('Automatic integration requires a standard CubeMX HAL main loop or FreeRTOS static-task configuration. Use the firmware integration guide for this project.');
function insertBlock(text: string, block: string, code: string): string {
  const begin = `/* USER CODE BEGIN ${block} */`, end = `/* USER CODE END ${block} */`;
  if (text.split(begin).length !== 2 || text.split(end).length !== 2 || text.indexOf(end) < text.indexOf(begin)) throw unsupported();
  return text.replace(begin, begin + (text.includes('\r\n') ? '\r\n' : '\n') + code);
}
function initFunctionEnd(text: string): number | undefined {
  const definitions = [...text.matchAll(/\bvoid\s+MX_FREERTOS_Init\s*\(\s*void\s*\)\s*\{/g)];
  if (definitions.length !== 1) return undefined;
  let depth = 1, quote = '', lineComment = false, blockComment = false, escaped = false;
  for (let i = definitions[0].index! + definitions[0][0].length; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = ''; continue; }
    if (c === '/' && next === '/') { lineComment = true; i++; continue; }
    if (c === '/' && next === '*') { blockComment = true; i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return undefined;
}
function addBeforeInitEnd(text: string): string {
  const end = initFunctionEnd(text);
  if (end === undefined) throw unsupported();
  const signature = [...text.matchAll(/\bvoid\s+MX_FREERTOS_Init\s*\(\s*void\s*\)\s*\{/g)][0];
  const body = text.slice(signature.index! + signature[0].length, end);
  if (!/\b(?:osThreadNew|xTaskCreate(?:Static|Restricted|PinnedToCore)?)\s*\(/.test(body)) throw unsupported();
  return text.slice(0, end) + '  stme_setup_start();\n' + text.slice(end);
}
async function localText(root: string, file: string): Promise<string> {
  if (!isWithin(root, await fs.realpath(file))) throw new Error('Monitor setup files must stay inside the project.');
  if ((await fs.stat(file)).size > 2097152) throw unsupported();
  return fs.readFile(file, 'utf8');
}
export async function planMonitorSetup(source: string, target: FirmwareTarget, resources: string): Promise<MonitorSetupPlan> {
  const root = await fs.realpath(source);
  if (!/^[A-Za-z_][A-Za-z0-9_.+-]*$/.test(target.name)) throw unsupported();
  const directory = path.join(source, 'stm32-easy-monitor');
  if (await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; })) throw new Error('Monitor component directory already exists. Build its integration or use the firmware guide.');
  const mainFiles = target.sourceFiles.filter(file => path.basename(file).toLowerCase() === 'main.c');
  if (mainFiles.length !== 1) throw unsupported();
  const mainFile = mainFiles[0], main = await localText(root, mainFile);
  if (!/\bHAL_Init\s*\(/.test(main) || /\bstme_/.test(main)) throw unsupported();
  const rtos = /\b(?:osKernelStart|vTaskStartScheduler)\s*\(/.test(main);
  if (!rtos && /cmsis_os|FreeRTOS|tx_kernel_enter|osThread/i.test(main)) throw unsupported();
  const changes: SetupChange[] = [];
  let heap = false;
  if (rtos) {
    const configs: string[] = [];
    for (const dir of target.includeDirectories) {
      const candidate = path.join(dir, 'FreeRTOSConfig.h');
      if (await fs.stat(candidate).catch(() => undefined)) configs.push(await fs.realpath(candidate));
    }
    const unique = [...new Set(configs)];
    if (unique.length !== 1) throw unsupported();
    const config = await localText(root, unique[0]);
    for (const name of ['configSUPPORT_STATIC_ALLOCATION', 'INCLUDE_vTaskDelay', 'INCLUDE_xTaskGetSchedulerState']) {
      if (!new RegExp('^\\s*#define\\s+' + name + '\\s+1\\b', 'm').test(config)) throw unsupported();
    }
    const candidates = target.sourceFiles.filter(file => path.basename(file).toLowerCase() === 'freertos.c');
    if (candidates.length !== 1) throw unsupported();
    const file = candidates[0], sourceText = await localText(root, file);
    if (/\bstme_/.test(sourceText)) throw unsupported();
    const hooks = sourceText.includes('/* USER CODE BEGIN RTOS_THREADS */');
    const after = hooks ? insertBlock(insertBlock(sourceText, 'Includes', '#include "stm32_easy_setup.h"'), 'RTOS_THREADS', '  stme_setup_start();')
      : '#include "stm32_easy_setup.h"\n' + addBeforeInitEnd(sourceText);
    changes.push({ file, before: sourceText, after });
    // Weak API binding in the adapter checks actual linked allocator capability.
    heap = true;
  } else {
    if (!/while\s*\(\s*1\s*\)\s*\{[\s\S]*?\/\* USER CODE BEGIN 3 \*\//.test(main)) throw unsupported();
    const after = insertBlock(insertBlock(insertBlock(main, 'Includes', '#include "stm32_easy_setup.h"'), '2', '  stme_setup_start();'), '3', '    stme_setup_poll(HAL_GetTick());');
    changes.push({file: mainFile, before: main, after});
  }
  const cmakeFile = path.join(source, 'CMakeLists.txt'), cmake = await localText(root, cmakeFile);
  if (/stm32_easy_monitor|stm32-easy-monitor/.test(cmake)) throw new Error('Monitor integration already exists. Build the target before configuring monitoring.');
  changes.push({file: cmakeFile, before: cmake, after: cmake + '\n# STM32 Easy Monitor (remove this block to unlink the component)\ninclude("${CMAKE_CURRENT_LIST_DIR}/stm32-easy-monitor/stm32_easy_setup.cmake")\nstm32_easy_setup(' + target.name + ')\n'});
  for (const name of ['stm32_easy_monitor.c', 'stm32_easy_monitor.h', 'stm32_easy_monitor.cmake', 'README.md', 'README.zh-CN.md']) {
    changes.push({file: path.join(directory, name), after: await fs.readFile(path.join(resources, name), 'utf8')});
  }
  const id = 'stme-' + randomUUID();
  const header = '#ifndef STM32_EASY_SETUP_H\n#define STM32_EASY_SETUP_H\n#include <stdint.h>\nvoid stme_setup_start(void);\nvoid stme_setup_poll(uint32_t ms);\n#endif\n';
  const common = '#include "stm32_easy_setup.h"\n#include "stm32_easy_monitor.h"\n#include "main.h"\nconst char stme_firmware_id[] __attribute__((used, externally_visible)) = "' + id + '";\n/* Override with an application boot counter for reliable restart identity. */\n__attribute__((weak)) uint32_t stme_setup_boot_id(void) { return SysTick->VAL; }\n';
  const adapter = rtos ? common + `
#include "FreeRTOS.h"
#include "task.h"
#if !configSUPPORT_STATIC_ALLOCATION || !INCLUDE_vTaskDelay || !INCLUDE_xTaskGetSchedulerState
#error Monitor setup requires static tasks, vTaskDelay and xTaskGetSchedulerState
#endif
static StaticTask_t monitor_task;
static StackType_t monitor_stack[512];
static TaskHandle_t monitor_handle;
/* Weak references do not pull an unlinked or different allocator into the image. */
extern size_t xPortGetFreeHeapSize(void) __attribute__((weak));
extern size_t xPortGetMinimumEverFreeHeapSize(void) __attribute__((weak));
#if configUSE_TRACE_FACILITY && (tskKERNEL_VERSION_MAJOR > 10 || (tskKERNEL_VERSION_MAJOR == 10 && tskKERNEL_VERSION_MINOR >= 3))
extern void vPortGetHeapStats(HeapStats_t *stats) __attribute__((weak));
#define STME_SETUP_HEAP_STATS 1
#endif
static int read_heap(stme_heap_t *heap) {
#ifdef STME_SETUP_HEAP_STATS
  if (vPortGetHeapStats) {
    HeapStats_t stats; vPortGetHeapStats(&stats);
    heap->free = (uint32_t)stats.xAvailableHeapSpaceInBytes;
    heap->minimum = (uint32_t)stats.xMinimumEverFreeBytesRemaining;
    heap->largest = (uint32_t)stats.xSizeOfLargestFreeBlockInBytes;
    return 1;
  }
#endif
  if (!xPortGetFreeHeapSize) return 0;
  heap->free = (uint32_t)xPortGetFreeHeapSize();
  if (xPortGetMinimumEverFreeHeapSize) heap->minimum = (uint32_t)xPortGetMinimumEverFreeHeapSize();
  return 1;
}
static void monitor_run(void *argument) {
  (void)argument;
  stme_init(stme_firmware_id, stme_setup_boot_id());
  stme_set_heap_provider(read_heap);
  (void)stme_register_task((void *)monitor_handle, sizeof(monitor_stack));
  for (;;) { stme_poll(HAL_GetTick()); vTaskDelay(pdMS_TO_TICKS(100) ? pdMS_TO_TICKS(100) : 1); }
}
void stme_setup_start(void) {
  monitor_handle = xTaskCreateStatic(monitor_run, "STM32 monitor", 512, NULL, tskIDLE_PRIORITY, monitor_stack, &monitor_task);
}
void stme_setup_poll(uint32_t ms) { (void)ms; }
` : common + '\nvoid stme_setup_start(void) { stme_init(stme_firmware_id, stme_setup_boot_id()); }\nvoid stme_setup_poll(uint32_t ms) { stme_poll(ms); }\n';
  const setupCmake = 'include("${CMAKE_CURRENT_LIST_DIR}/stm32_easy_monitor.cmake")\nfunction(stm32_easy_setup target)\n  stm32_easy_monitor(${target})\n  target_sources(${target} PRIVATE "${STM32_EASY_MONITOR_DIR}/stm32_easy_setup.c")\n  target_link_options(${target} PRIVATE "-Wl,--undefined=stme_firmware_id")\n' + (heap ? '  target_compile_definitions(${target} PRIVATE STME_USE_FREERTOS=1)\n' : '') + 'endfunction()\n';
  for (const [name, after] of [['stm32_easy_setup.h', header], ['stm32_easy_setup.c', adapter], ['stm32_easy_setup.cmake', setupCmake]]) changes.push({file: path.join(directory, name), after});
  return {source, mode: rtos ? 'freertos' : 'bare', changes};
}
/** Validate every original first; roll back only bytes that still belong to this transaction. */
export async function applyMonitorSetup(plan: MonitorSetupPlan): Promise<void> {
  const root = await fs.realpath(plan.source), directory = path.join(plan.source, 'stm32-easy-monitor');
  const lock = await fs.open(path.join(plan.source, '.stm32-easy-monitor.lock'), 'wx');
  const applied: SetupChange[] = []; let created = false;
  try {
    for (const change of plan.changes) {
      if (!isWithin(root, path.resolve(change.file))) throw new Error('Monitor setup files must stay inside the project.');
      if (change.before !== undefined && await localText(root, change.file) !== change.before) throw new Error('Project files changed after preview. Run monitor setup again.');
      if (change.before === undefined && path.dirname(change.file) !== directory) throw unsupported();
    }
    await fs.mkdir(directory); created = true;
    for (const change of plan.changes) {
      if (change.before === undefined) await fs.writeFile(change.file, change.after, {flag:'wx'});
      else {
        if (await localText(root, change.file) !== change.before) throw new Error('Project files changed after preview. Run monitor setup again.');
        const temporary = change.file + '.' + randomUUID() + '.tmp';
        try { await fs.writeFile(temporary, change.after, {flag:'wx'}); await replaceFile(temporary, change.file); }
        finally { await fs.rm(temporary, {force:true}); }
      }
      applied.push(change);
    }
  } catch (error) {
    for (const change of applied.reverse()) {
      if (await fs.readFile(change.file, 'utf8').catch(() => undefined) === change.after) {
        if (change.before === undefined) await fs.rm(change.file);
        else await fs.writeFile(change.file, change.before);
      }
    }
    if (created) await fs.rmdir(directory).catch(() => {});
    throw error;
  } finally { await lock.close(); await fs.rm(path.join(plan.source, '.stm32-easy-monitor.lock'), {force:true}); }
}
export async function applySamplingUpdate(source: string, change: SetupChange): Promise<void> {
  const root = await fs.realpath(source), lockFile = path.join(root, '.stm32-easy-monitor.lock');
  const lock = await fs.open(lockFile, 'wx');
  const file = path.resolve(change.file), temporary = file + '.' + randomUUID() + '.tmp';
  try {
    if (!isWithin(root, await fs.realpath(file)) || await fs.readFile(file, 'utf8') !== change.before) throw new Error('Project files changed after preview. Run the sampling update again.');
    await fs.writeFile(temporary, change.after, {flag:'wx'});
    await replaceFile(temporary, file);
  } finally { await lock.close(); await fs.rm(temporary, {force:true}); await fs.rm(lockFile, {force:true}); }
}
