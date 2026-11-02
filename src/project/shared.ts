import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { t } from '../i18n';
import { replaceFile } from '../core/atomicFile';
import { DebugProbe, ProjectSettings, defaultProjectSettings, validateProjectSettings } from './types';

export const sharedFileName = 'stm32-easy.json';
export interface SharedConfiguration {
  version: 1;
  sourceDirectory: string;
  configurePreset?: string;
  buildPreset?: string;
  configuration?: string;
  firmwareTarget?: string;
  chipLabel?: string;
  targetScript?: { base: 'project' | 'openocd'; path: string };
  scriptKind?: 'target' | 'board';
  backend: 'auto' | 'hid' | 'usb_bulk';
  probe?: DebugProbe;
  speedKHz: number;
  stopAtMain: boolean;
}
export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
export const sharedPath = (uri: string): string => path.join(fileURLToPath(uri), '.vscode', sharedFileName);
export const legacySharedPath = (uri: string): string => path.join(fileURLToPath(uri), '.stm32-easy.json');
const contained = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};
function relativePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[:\x00-\x1f]/.test(value)
    || path.win32.isAbsolute(value) || value.replace(/\\/g, '/').split('/').includes('..')) {
    throw new Error(t('共享配置只允许工程内相对路径或 OpenOCD 内置脚本路径'));
  }
  return value.replace(/\\/g, '/');
}
export async function sharedDirectory(uri: string, create = true): Promise<string> {
  const root = await fs.realpath(fileURLToPath(uri)), directory = path.join(root, '.vscode');
  if (create) await fs.mkdir(directory, { recursive: true });
  try {
    if (!contained(root, await fs.realpath(directory))) throw new Error(t('共享配置目录不能通过符号链接指向工程外'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return directory;
}
export async function readSharedFile(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 65536) throw new Error(t('工程共享配置必须是小于 64 KiB 的普通文件'));
    const text = await fs.readFile(file, 'utf8');
    if (Buffer.byteLength(text) > 65536) throw new Error(t('工程共享配置必须是小于 64 KiB 的普通文件'));
    return text;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function sharedText(uri: string): Promise<string | undefined> {
  await sharedDirectory(uri, false);
  return await readSharedFile(sharedPath(uri)) ?? await readSharedFile(legacySharedPath(uri));
}
export function parseShared(text: string, uri: string): ProjectSettings {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(t('工程共享配置格式无效'));
  const config = raw as Record<string, unknown>;
  const allowed = ['version','sourceDirectory','configurePreset','buildPreset','configuration','firmwareTarget','chipLabel','targetScript','scriptKind','backend','probe','speedKHz','stopAtMain'];
  if (config.version !== 1 || Object.keys(config).some(key => !allowed.includes(key))) throw new Error(t('工程共享配置含未知字段或版本不受支持'));
  const root = fileURLToPath(uri), source = path.resolve(root, relativePath(config.sourceDirectory));
  let targetScript: string | undefined;
  if (config.targetScript !== undefined) {
    const script = config.targetScript;
    if (!script || typeof script !== 'object' || Array.isArray(script)
      || Object.keys(script).some(key => !['base','path'].includes(key))) throw new Error(t('共享脚本配置格式无效'));
    const value = script as Record<string, unknown>, relative = relativePath(value.path);
    if (!['project','openocd'].includes(String(value.base))) throw new Error(t('共享脚本配置格式无效'));
    targetScript = value.base === 'project' ? path.resolve(root, relative) : relative;
  }
  return validateProjectSettings({ ...defaultProjectSettings(uri, source), shareInProject: true,
    configurePreset: config.configurePreset, buildPreset: config.buildPreset, configuration: config.configuration,
    preferredTarget: config.firmwareTarget, chipLabel: config.chipLabel, targetScript, scriptKind: config.scriptKind,
    backend: config.backend, probe: config.probe, speedKHz: config.speedKHz, stopAtMain: config.stopAtMain });
}
export async function portableConfiguration(settings: ProjectSettings, openocdScripts?: string): Promise<{ text: string; settings: ProjectSettings; created?: string }> {
  const root = await fs.realpath(fileURLToPath(settings.projectUri));
  const source = await fs.realpath(settings.sourceDirectory);
  if (!contained(root, source)) throw new Error(t('源码目录必须位于所选工作区文件夹中'));
  let value = { ...settings }, script: SharedConfiguration['targetScript'], created: string | undefined;
  if (settings.targetScript) {
    if (!path.isAbsolute(settings.targetScript)) script = { base: 'openocd', path: relativePath(settings.targetScript) };
    else {
      const actual = await fs.realpath(settings.targetScript);
      if (contained(root, actual)) script = { base: 'project', path: path.relative(root, actual).replace(/\\/g, '/') };
      else if (openocdScripts && contained(await fs.realpath(openocdScripts), actual)) {
        script = { base: 'openocd', path: path.relative(await fs.realpath(openocdScripts), actual).replace(/\\/g, '/') };
        value.targetScript = script.path; value.chipConfirmed = false;
      } else {
        const stat = await fs.stat(actual);
        if (stat.size > 2097152 || !stat.isFile()) throw new Error(t('目标脚本不是普通文件或超过 2 MiB'));
        const content = await fs.readFile(actual, 'utf8');
        const lines = content.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
        for (const line of lines) {
          if (/[A-Za-z]:[\\/]|\\\\/.test(line)) throw new Error(t('外部脚本含本机路径，请将脚本及依赖整理到工程内后再共享'));
          if (/\bsource\b/.test(line)) {
            const include = /^source\s+\[find\s+([\w./-]+)\]\s*(?:#.*)?$/.exec(line)?.[1];
            if (!include || !openocdScripts || include.split('/').includes('..')) throw new Error(t('外部脚本含本机路径，请将脚本及依赖整理到工程内后再共享'));
            if (!(await fs.stat(path.join(openocdScripts, include))).isFile()) throw new Error(t('外部脚本含本机路径，请将脚本及依赖整理到工程内后再共享'));
          }
        }
        const directory = path.join(await sharedDirectory(settings.projectUri), 'stm32-easy', 'openocd');
        await fs.mkdir(path.dirname(directory), { recursive: true });
        if (!contained(root, await fs.realpath(path.dirname(directory)))) throw new Error(t('共享配置目录不能通过符号链接指向工程外'));
        await fs.mkdir(directory, { recursive: true });
        if (!contained(root, await fs.realpath(directory))) throw new Error(t('共享配置目录不能通过符号链接指向工程外'));
        const name = `${digest(content).slice(0,16)}-${path.basename(actual).replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
        const file = path.join(directory, name);
        try { await fs.writeFile(file, content, { flag: 'wx' }); created = file; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await fs.lstat(file)).isSymbolicLink()
            || await fs.readFile(file, 'utf8') !== content) throw error;
        }
        script = { base: 'project', path: path.relative(root, file).replace(/\\/g, '/') };
        value.targetScript = file; value.chipConfirmed = false;
      }
    }
  }
  const config: SharedConfiguration = { version: 1, sourceDirectory: path.relative(root, source).replace(/\\/g, '/') || '.',
    configurePreset: settings.configurePreset, buildPreset: settings.buildPreset, configuration: settings.configuration,
    firmwareTarget: settings.preferredTarget, chipLabel: settings.chipLabel, targetScript: script, scriptKind: settings.scriptKind,
    backend: settings.backend, probe: settings.probe, speedKHz: settings.speedKHz, stopAtMain: settings.stopAtMain };
  const text = JSON.stringify(config, null, 2) + '\n';
  parseShared(text, settings.projectUri);
  return { text, settings: value, created };
}
export async function writeShared(uri: string, text: string): Promise<void> {
  await sharedDirectory(uri);
  await writeSharedFile(sharedPath(uri), text);
}
export async function writeSharedFile(file: string, text: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, text, { flag: 'wx' }); await replaceFile(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
