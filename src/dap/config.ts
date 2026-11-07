import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ToolInstallation } from '../core/types';
import { JobRequest, JobResult } from '../core/jobProcess';
import { RunRequest, RunResult } from '../core/types';
import { runProcess } from '../core/process';
import { BuildCancelled } from '../build/service';
import { BuildEvidence, isWithin } from '../build/artifacts';
import { ProjectSettings, probeOf, validateProjectSettings } from '../project/types';
import { isC5Target, verifyC5Files, c5CheckCommands, c5EventScopeCommand } from './c5';

export type DapDialect = 'modern' | 'legacy';
export interface DapRuntime {
  approvedScript?: { file: string; sha256: string };
  tools: ToolInstallation[];
  guard(): void;
  log(stream: 'stdout' | 'stderr', text: string): void;
  trustScript(file: string): Promise<boolean>;
  verify(evidence: BuildEvidence): Promise<void>;
  runner?: (request: JobRequest) => Promise<JobResult>;
  probe?: (request: RunRequest) => Promise<RunResult>;
}
export interface DapConfiguration {
  executable: string; scriptsDirectory: string; targetScript: string;
  targetSha256: string; dialect: DapDialect;
}

export function tclWord(value: string): string {
  if (typeof value !== 'string' || value.length > 32768 || /[\x00-\x1f]/.test(value)) throw new Error(t("Tcl 参数含控制字符或长度无效"));
  return `"${value.replace(/[\\"$\[\]]/g, character => `\\${character}`)}"`;
}
function targetPath(settings: ProjectSettings, scriptsDirectory: string): string {
  if (!settings.targetScript || !settings.chipConfirmed) throw new Error(t("尚未确认芯片和目标脚本"));
  const script = settings.targetScript;
  if (!/\.(?:cfg|tcl)$/i.test(script) || path.parse(script).root.length === 1
    || !path.isAbsolute(script) && script.includes(':')) throw new Error(t("目标脚本路径无效"));
  const file = path.resolve(scriptsDirectory, script);
  if (!path.isAbsolute(script) && !isWithin(scriptsDirectory, file)) throw new Error(t("相对目标脚本不能越过 OpenOCD scripts"));
  return file;
}
function driverCommands(settings: ProjectSettings, dialect: DapDialect): string[] {
  const probe = probeOf(settings);
  if (dialect === 'modern') {
    if (probe === 'st-link') return ['adapter driver st-link'];
    if (probe === 'jlink') return ['adapter driver jlink'];
    return ['adapter driver cmsis-dap', `cmsis-dap backend ${settings.backend}`];
  }
  if (probe === 'st-link') return ['source [find interface/stlink.cfg]'];
  if (probe === 'jlink') return ['source [find interface/jlink.cfg]'];
  return ['adapter driver cmsis-dap', `cmsis_dap_backend ${settings.backend}`];
}
function serialCommands(settings: ProjectSettings, dialect: DapDialect): string[] {
  if (!settings.serial) return [];
  const probe = probeOf(settings);
  if (probe === 'st-link' && dialect === 'legacy') return [`hla_serial ${tclWord(settings.serial)}`];
  if (probe === 'jlink' && dialect === 'legacy') throw new Error(t('旧版 OpenOCD 不支持 J-Link 序列号选择，请升级 OpenOCD'));
  return [`adapter serial ${tclWord(settings.serial)}`];
}
function transportCommand(settings: ProjectSettings, dialect: DapDialect): string {
  return probeOf(settings) === 'st-link' && dialect === 'legacy' ? 'transport select hla_swd' : 'transport select swd';
}
function adapterGuard(settings: ProjectSettings): string {
  const probe = probeOf(settings);
  if (probe === 'st-link') return 'if {[adapter name] ne "st-link" && [adapter name] ne "hla"} {error "STM32 Easy Tool Kit requires ST-Link"}';
  if (probe === 'jlink') return 'if {[adapter name] ne "jlink"} {error "STM32 Easy Tool Kit requires J-Link"}';
  return 'if {[adapter name] ne "cmsis-dap"} {error "STM32 Easy Tool Kit requires CMSIS-DAP"}';
}
export function buildConfigArgs(raw: ProjectSettings, scriptsDirectory: string, dialect: DapDialect = 'legacy'): string[] {
  const settings = validateProjectSettings(raw);
  if (!path.isAbsolute(scriptsDirectory)) throw new Error(t("OpenOCD scripts 必须为绝对路径"));
  const target = targetPath(settings, scriptsDirectory);
  const probe = probeOf(settings);
  if (settings.scriptKind === 'board') {
    // A CLion board file owns interface/target/reset configuration. Do not load the interface twice.
    const args = ['-s', scriptsDirectory, '-c', `source ${tclWord(target)}`, '-c', adapterGuard(settings),
      '-c', 'if {[transport select] ne "swd" && [transport select] ne "hla_swd"} {error "STM32 Easy Tool Kit requires SWD"}'];
    if (probe === 'cmsis-dap') args.push('-c', `${dialect === 'modern' ? 'cmsis-dap backend' : 'cmsis_dap_backend'} ${settings.backend}`);
    for (const command of serialCommands(settings, dialect)) args.push('-c', command);
    args.push('-c', `adapter speed ${settings.speedKHz}`);
    return args;
  }
  const args = ['-s', scriptsDirectory];
  for (const command of driverCommands(settings, dialect)) args.push('-c', command);
  for (const command of serialCommands(settings, dialect)) args.push('-c', command);
  args.push('-c', transportCommand(settings, dialect), '-c', `source ${tclWord(target)}`, '-c', `adapter speed ${settings.speedKHz}`);
  if (isC5Target(settings)) args.push('-c', c5EventScopeCommand);
  return args;
}
export function buildFlashArgs(settings: ProjectSettings, scriptsDirectory: string, artifact: string, dialect: DapDialect = 'legacy'): string[] {
  if (!path.isAbsolute(artifact)) throw new Error(t("固件路径必须为绝对路径"));
  return [...buildConfigArgs(settings, scriptsDirectory, dialect), '-c', `program ${tclWord(artifact)} verify reset exit`];
}
export function portCommand(dialect: DapDialect, kind: 'gdb' | 'tcl' | 'telnet', value: number | 'disabled'): string {
  return `${kind}${dialect === 'modern' ? ' port' : '_port'} ${value}`;
}

export async function scriptFingerprint(file: string): Promise<string> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 2097152) throw new Error(t("目标脚本不是普通文件或超过 2 MiB"));
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}
export async function resolveDapConfiguration(raw: ProjectSettings, signal: AbortSignal, runtime: DapRuntime): Promise<DapConfiguration> {
  runtime.guard();
  if (signal.aborted) throw new BuildCancelled();
  const settings = validateProjectSettings(raw);
  const tool = runtime.tools.find(item => item.id === 'openocd');
  const executable = tool?.executables.openocd;
  if (!tool?.scriptsDirectory || !executable || !path.isAbsolute(executable)) throw new Error(t("请先选择完整的 OpenOCD（包含 scripts）"));
  const scriptsDirectory = await fs.realpath(tool.scriptsDirectory);
  const c5 = isC5Target(settings);
  if (c5) await verifyC5Files(scriptsDirectory, targetPath(settings, scriptsDirectory));
  const targetScript = await fs.realpath(targetPath(settings, scriptsDirectory));
  if (!isWithin(scriptsDirectory, targetScript) && !await runtime.trustScript(targetScript)) throw new BuildCancelled();
  const targetSha256 = await scriptFingerprint(targetScript);
  if (runtime.approvedScript && (path.resolve(runtime.approvedScript.file).toLowerCase() !== targetScript.toLowerCase()
    || runtime.approvedScript.sha256 !== targetSha256)) throw new Error(t('芯片配置脚本在确认期间发生变化，请重新执行'));
  const probe = runtime.probe ?? runProcess;
  let dialect: DapDialect | undefined;
  for (const candidate of ['modern', 'legacy'] as const) {
    runtime.guard();
    if (signal.aborted) throw new BuildCancelled();
    const commands = [
      ...driverCommands(settings, candidate),
      ...serialCommands(settings, candidate),
      transportCommand(settings, candidate),
      portCommand(candidate, 'gdb', 3333),
      portCommand(candidate, 'tcl', 'disabled'),
      portCommand(candidate, 'telnet', 'disabled'),
    ];
    const result = await probe({ executable, args: ['-s', scriptsDirectory, ...commands.flatMap(command => ['-c', command]), '-c', 'shutdown'],
      timeoutMs: 10000, signal });
    if (result.cancelled || signal.aborted) throw new BuildCancelled();
    if (result.exitCode === 0 && !result.timedOut) { dialect = candidate; break; }
  }
  if (!dialect) throw new Error(t("当前 OpenOCD 不支持所选探针或 SWD 参数，请检查版本和后端能力"));
  if (c5) {
    const result = await probe({ executable, args: [...buildConfigArgs({ ...settings, targetScript }, scriptsDirectory, dialect),
      ...c5CheckCommands.flatMap(command => ['-c', command])], timeoutMs: 10000, signal });
    if (result.cancelled || signal.aborted) throw new BuildCancelled();
    if (result.exitCode !== 0 || result.timedOut || !`${result.stdout}\n${result.stderr}`.includes('STM32_EASY_C5_READY')) {
      throw new Error(t('STM32C5 驱动配置检查失败；需要含 stldr 的 OpenOCD 和直接 DAP 连接，旧 HLA 不支持。{0}', (result.stderr || result.stdout).slice(-1500)));
    }
  }
  runtime.guard();
  if (signal.aborted) throw new BuildCancelled();
  return { executable, scriptsDirectory, targetScript, targetSha256, dialect };
}
