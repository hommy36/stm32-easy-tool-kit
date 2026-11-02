import { t } from '../i18n';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DapBackend } from '../core/types';

export type DebugProbe = 'cmsis-dap' | 'st-link' | 'jlink';
export const debugProbes: DebugProbe[] = ['cmsis-dap', 'st-link', 'jlink'];
export function probeOf(settings: ProjectSettings): DebugProbe {
  return settings.probe ?? 'cmsis-dap';
}
export function probeLabel(probe: DebugProbe | undefined): string {
  const value = probe ?? 'cmsis-dap';
  return value === 'st-link' ? 'ST-Link' : value === 'jlink' ? 'J-Link' : 'DAPLink / CMSIS-DAP';
}
export interface HardwareAuthorization {
  scriptKind?: 'target' | 'board';
  probe?: DebugProbe;
  targetScript: string;
  targetSha256: string;
  targetId: string;
  configurePreset: string;
  buildPreset?: string;
  configuration: string;
  chipLabel?: string;
  backend: DapBackend;
  speedKHz: number;
  serial?: string;
  stopAtMain: boolean;
  acceptedAt: string;
}
export interface ProjectSettings {
  shareInProject?: boolean;
  scriptKind?: 'target' | 'board';
  preferredTarget?: string;
  schemaVersion: 1;
  projectUri: string;
  sourceDirectory: string;
  configurePreset?: string;
  buildPreset?: string;
  configuration?: string;
  targetId?: string;
  targetScript?: string;
  chipLabel?: string;
  chipConfirmed: boolean;
  backend: DapBackend;
  speedKHz: number;
  serial?: string;
  stopAtMain: boolean;
  setupComplete?: boolean;
  artifactPath?: string;
  probe?: DebugProbe;
}

export interface SavedProject { revision: number; settings: ProjectSettings; }

const optionalStrings = ['configurePreset', 'buildPreset', 'configuration', 'targetId', 'targetScript', 'chipLabel', 'serial', 'artifactPath', 'preferredTarget'] as const;
const dapBackends = ['auto', 'hid', 'usb_bulk'];
const keys = new Set(['schemaVersion', 'projectUri', 'sourceDirectory', 'chipConfirmed', 'backend', 'speedKHz', 'stopAtMain',
  'setupComplete', 'scriptKind', 'shareInProject', 'probe', ...optionalStrings]);
const authorizationKeys = new Set(['targetScript', 'targetSha256', 'targetId', 'configurePreset', 'buildPreset', 'configuration',
  'chipLabel', 'backend', 'speedKHz', 'serial', 'stopAtMain', 'acceptedAt', 'scriptKind', 'probe']);

export function normalizeTrustedPath(value: string): string {
  if (!path.isAbsolute(value) || path.parse(value).root.length < 2 || /[\x00-\x1f]/.test(value) || value.length > 4096) throw new Error(t("信任路径无效"));
  const normalized = path.win32.normalize(value).replace(/[\\/]+$/, '');
  if (path.parse(normalized).root === normalized) throw new Error(t("信任路径不能是磁盘根目录"));
  return normalized.toLowerCase();
}
export function validateAuthorization(raw: unknown): HardwareAuthorization {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(t("硬件授权记录无效"));
  const value = raw as Record<string, unknown>;
  if (value.scriptKind !== undefined && !['target','board'].includes(String(value.scriptKind))) throw new Error(t('配置脚本类型无效'));
  if (value.probe !== undefined && !debugProbes.includes(value.probe as DebugProbe)) throw new Error(t('调试探针类型无效'));
  if (Object.keys(value).some(key => !authorizationKeys.has(key))) throw new Error(t("硬件授权记录含未知字段"));
  const text = (key: string) => typeof value[key] === 'string' && (value[key] as string).length > 0
    && (value[key] as string).length <= 4096 && !/[\x00-\x1f]/.test(value[key] as string);
  if (!text('targetScript') || !text('targetId') || !text('configurePreset') || !text('configuration')
    || typeof value.targetSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.targetSha256)
    || typeof value.backend !== 'string' || !dapBackends.includes(value.backend)
    || typeof value.speedKHz !== 'number' || !Number.isInteger(value.speedKHz) || value.speedKHz < 1 || value.speedKHz > 10000
    || typeof value.stopAtMain !== 'boolean' || typeof value.acceptedAt !== 'string' || !Number.isFinite(Date.parse(value.acceptedAt))) {
    throw new Error(t("硬件授权记录字段无效"));
  }
  for (const key of ['buildPreset', 'chipLabel', 'serial'] as const) {
    const item = value[key];
    if (item !== undefined && (typeof item !== 'string' || !item.length || item.length > (key === 'serial' ? 256 : 4096) || /[\x00-\x1f]/.test(item))) throw new Error(t("硬件授权记录 {0} 无效", key));
  }
  return { ...value } as unknown as HardwareAuthorization;
}

export function projectKeyUri(uri: string): string {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'file:' || parsed.hostname || parsed.search || parsed.hash) throw new Error(t("工程必须是本地文件夹 URI"));
  const directory = fileURLToPath(parsed);
  if (!path.isAbsolute(directory) || path.parse(directory).root.length < 2) throw new Error(t("工程路径必须为完整绝对路径"));
  return path.win32.normalize(directory).replace(/[\\/]+$/, '').toLowerCase();
}

export function validateProjectSettings(raw: unknown): ProjectSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(t("工程设置不是对象"));
  const value = raw as Record<string, unknown>;
  if (value.scriptKind !== undefined && !['target','board'].includes(String(value.scriptKind))) throw new Error(t('配置脚本类型无效'));
  if (value.probe !== undefined && !debugProbes.includes(value.probe as DebugProbe)) throw new Error(t('调试探针类型无效'));
  if (Object.keys(value).some(key => !keys.has(key))) throw new Error(t("工程设置含未知字段"));
  if (value.schemaVersion !== 1 || typeof value.projectUri !== 'string' || typeof value.sourceDirectory !== 'string'
    || typeof value.chipConfirmed !== 'boolean' || typeof value.stopAtMain !== 'boolean'
    || typeof value.backend !== 'string' || !['auto', 'hid', 'usb_bulk'].includes(value.backend)
    || typeof value.speedKHz !== 'number' || !Number.isInteger(value.speedKHz) || value.speedKHz < 1 || value.speedKHz > 10000) {
    throw new Error(t("工程设置字段无效"));
  }
  projectKeyUri(value.projectUri);
  if (!path.isAbsolute(value.sourceDirectory) || path.parse(value.sourceDirectory).root.length < 2
    || /[\x00-\x1f]/.test(value.sourceDirectory)) throw new Error(t("源码目录必须为完整绝对路径"));
  for (const key of optionalStrings) {
    const text = value[key];
    if (text !== undefined && (typeof text !== 'string' || !text.length || text.length > (key === 'serial' ? 256 : 4096)
      || /[\x00-\x1f]/.test(text))) throw new Error(t("工程设置 {0} 无效", key));
  }
  if (value.chipConfirmed && !value.targetScript) throw new Error(t("请先选择目标脚本，再确认芯片"));
  if (value.setupComplete !== undefined && typeof value.setupComplete !== 'boolean') throw new Error(t("工程设置 setupComplete 无效"));
  if (value.shareInProject !== undefined && typeof value.shareInProject !== 'boolean') throw new Error(t('随工程保存选项无效'));
  if (value.artifactPath !== undefined && !path.isAbsolute(value.artifactPath as string)) throw new Error(t("工程设置 artifactPath 必须是绝对路径"));
  return { ...value } as unknown as ProjectSettings;
}

export function defaultProjectSettings(projectUri: string, sourceDirectory: string): ProjectSettings {
  return validateProjectSettings({ schemaVersion: 1, projectUri, sourceDirectory, chipConfirmed: false,
    backend: 'auto', speedKHz: 1000, stopAtMain: true, shareInProject: true, probe: 'cmsis-dap' });
}

export function validateTrustedPaths(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 256) throw new Error(t("信任路径列表无效"));
  const items = raw.map(item => {
    if (typeof item !== 'string') throw new Error(t("信任路径必须是字符串"));
    return normalizeTrustedPath(item);
  });
  if (new Set(items).size !== items.length) throw new Error(t("信任路径重复"));
  return items;
}
export function isTrustedPath(paths: string[] | undefined, file: string): boolean {
  if (!paths?.length) return false;
  let normalized: string;
  try { normalized = normalizeTrustedPath(file); }
  catch { return false; }
  return paths.some(trusted => normalized === trusted || normalized.startsWith(`${trusted}\\`));
}
export function authorizationFrom(settings: ProjectSettings, targetSha256: string, acceptedAt = new Date().toISOString()): HardwareAuthorization {
  if (!settings.targetScript || !settings.targetId || !settings.configurePreset || !settings.configuration || !settings.chipConfirmed) {
    throw new Error(t("请先确认工程、构建配置、目标、芯片和目标脚本，再启用自动授权"));
  }
  return { targetScript: settings.targetScript, targetSha256, targetId: settings.targetId,
    scriptKind: settings.scriptKind, probe: probeOf(settings),
    configurePreset: settings.configurePreset, buildPreset: settings.buildPreset, configuration: settings.configuration,
    chipLabel: settings.chipLabel, backend: settings.backend, speedKHz: settings.speedKHz, serial: settings.serial,
    stopAtMain: settings.stopAtMain, acceptedAt };
}
export function authorizationMatches(settings: ProjectSettings, accepted: HardwareAuthorization | undefined, targetSha256: string): boolean {
  if (!accepted || !settings.chipConfirmed || !settings.targetScript) return false;
  return accepted.targetScript === settings.targetScript && accepted.targetSha256 === targetSha256
    && (accepted.scriptKind ?? 'target') === (settings.scriptKind ?? 'target')
    && (accepted.probe ?? 'cmsis-dap') === probeOf(settings)
    && accepted.targetId === settings.targetId && accepted.configurePreset === settings.configurePreset
    && accepted.buildPreset === settings.buildPreset && accepted.configuration === settings.configuration
    && accepted.chipLabel === settings.chipLabel && accepted.backend === settings.backend
    && accepted.speedKHz === settings.speedKHz && accepted.serial === settings.serial
    && accepted.stopAtMain === settings.stopAtMain;
}
