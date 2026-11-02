import { t } from '../i18n';
import * as vscode from 'vscode';
import { isDeepStrictEqual } from 'node:util';
import { ToolInstallation, SettingPatch, CheckResult } from '../core/types';
import { toolBinDirectories } from '../core/paths';
import { IntegrationJournal } from './journal';
const allowed = new Set(['cmake.cmakePath', 'cmake.environment', 'cortex-debug.armToolchainPath', 'cortex-debug.gdbPath', 'cortex-debug.openocdPath']);

function environment(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(t("cmake.environment 不是可安全合并的对象"));
  return { ...value as Record<string, unknown> };
}

export function buildPathValue(before: unknown, directories: string[]): string {
  if (before !== undefined && typeof before !== 'string') throw new Error(t("现有 CMake PATH 不是字符串，拒绝覆盖"));
  const inherited = typeof before === 'string' ? before : '${env:PATH}';
  const prefix = [...new Set(directories)].filter(directory => !inherited.split(';').some(part => part.toLowerCase() === directory.toLowerCase()));
  return [...prefix, inherited].filter(Boolean).join(';');
}

function supports(extensionId: string, fullKey: string): boolean {
  const extension = vscode.extensions.getExtension(extensionId);
  if (!extension) return false;
  const manifest = extension.packageJSON as unknown as { contributes?: { configuration?: unknown } };
  const configuration = manifest.contributes?.configuration;
  const sections: unknown[] = Array.isArray(configuration) ? configuration : [configuration];
  return sections.some(section => {
    if (!section || typeof section !== 'object') return false;
    const properties = (section as { properties?: Record<string, unknown> }).properties;
    return Boolean(properties && Object.hasOwn(properties, fullKey));
  });
}

export function buildIntegrationPatch(tools: ToolInstallation[]): SettingPatch[] {
  const patches: SettingPatch[] = [];
  const add = (extensionId: string, section: string, key: string, after: string | undefined) => {
    if (!after || !supports(extensionId, `${section}.${key}`)) return;
    const before = vscode.workspace.getConfiguration(section).inspect<unknown>(key)?.globalValue;
    if (!isDeepStrictEqual(before, after)) patches.push({ section, key, before, after });
  };
  const arm = tools.find(tool => tool.id === 'armGnu');
  const cmake = tools.find(tool => tool.id === 'cmake');
  const openocd = tools.find(tool => tool.id === 'openocd');
  add('ms-vscode.cmake-tools', 'cmake', 'cmakePath', cmake?.executables.cmake);
  if (tools.length && supports('ms-vscode.cmake-tools', 'cmake.environment')) {
    const before = vscode.workspace.getConfiguration('cmake').inspect<unknown>('environment')?.globalValue;
    const env = environment(before);
    const keys = Object.keys(env).filter(key => key.toLowerCase() === 'path');
    if (keys.length > 1) throw new Error(t("现有 cmake.environment 同时有 PATH/Path，无法安全合并，请先手动消除歧义"));
    const property = keys[0] ?? 'PATH';
    const after = buildPathValue(env[property], toolBinDirectories(tools));
    if (env[property] !== after) patches.push({ section: 'cmake', key: 'environment', property, before: env[property], after, parentBefore: before });
  }
  add('marus25.cortex-debug', 'cortex-debug', 'armToolchainPath', arm ? toolBinDirectories([arm])[0] : undefined);
  add('marus25.cortex-debug', 'cortex-debug', 'gdbPath', arm?.executables.gdb);
  add('marus25.cortex-debug', 'cortex-debug', 'openocdPath', openocd?.executables.openocd);
  return patches;
}

function readPatch(patch: SettingPatch): unknown {
  const global = vscode.workspace.getConfiguration(patch.section).inspect<unknown>(patch.key)?.globalValue;
  return patch.property ? environment(global)[patch.property] : global;
}

async function writePatch(patch: SettingPatch, value: unknown): Promise<void> {
  if (!allowed.has(`${patch.section}.${patch.key}`)) throw new Error(t("拒绝写入未获许可的设置键"));
  const configuration = vscode.workspace.getConfiguration(patch.section);
  if (!patch.property) { await configuration.update(patch.key, value, vscode.ConfigurationTarget.Global); return; }
  if (patch.section !== 'cmake' || patch.key !== 'environment' || patch.property.toLowerCase() !== 'path') throw new Error(t("不允许的设置子项"));
  const env = environment(configuration.inspect<unknown>(patch.key)?.globalValue);
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
  if (pathKey && pathKey !== patch.property) throw new Error(t("PATH 键被用户改变，拒绝覆盖"));
  if (value === undefined) delete env[patch.property]; else env[patch.property] = value;
  const emptyValue = patch.parentBefore === undefined || patch.parentBefore === null ? patch.parentBefore : {};
  await configuration.update(patch.key, Object.keys(env).length ? env : emptyValue, vscode.ConfigurationTarget.Global);
}

export function integrationOverrides(patches: SettingPatch[]): string[] {
  const resources = vscode.workspace.workspaceFolders?.map(folder => ({ name: folder.name, uri: folder.uri })) ?? [];
  const scopes = [{ name: t("工作区"), uri: undefined }, ...resources];
  return [...new Set(patches.flatMap(patch => scopes.flatMap(scope => {
    const inspection = vscode.workspace.getConfiguration(patch.section, scope.uri).inspect<unknown>(patch.key);
    return inspection?.workspaceValue !== undefined || inspection?.workspaceFolderValue !== undefined
      ? [t("{0}: {1}.{2} 存在工程级覆盖；本次只更新用户级值，最终生效值请核对。", scope.name, patch.section, patch.key)] : [];
  })))];
}

export async function applyIntegrationPatch(patches: SettingPatch[], journal: IntegrationJournal): Promise<void> {
  return journal.runExclusive(async () => {
    const original = await journal.read();
    const merged = original.map(item => ({ ...item }));
    const completed: SettingPatch[] = [];
    try {
      for (const patch of patches) {
        if (!isDeepStrictEqual(readPatch(patch), patch.before)) throw new Error(t("设置已发生变化，请重新预览: {0}.{1}", patch.section, patch.key));
        const previous = merged.find(item => item.section === patch.section && item.key === patch.key && item.property === patch.property);
        if (previous && isDeepStrictEqual(patch.before, previous.after)) previous.after = patch.after;
        else {
          if (previous) merged.splice(merged.indexOf(previous), 1);
          merged.push(patch);
        }
        await journal.write(merged);
        if (!isDeepStrictEqual(readPatch(patch), patch.before)) throw new Error(t("设置在预览后被修改，已停止: {0}.{1}", patch.section, patch.key));
        completed.push(patch);
        await writePatch(patch, patch.after);
      }
    } catch (error) {
      for (const patch of completed.reverse()) {
        if (isDeepStrictEqual(readPatch(patch), patch.after)) await writePatch(patch, patch.before);
      }
      await journal.write(original);
      throw error;
    }
  });
}

export async function restoreIntegrationPatch(journal: IntegrationJournal): Promise<CheckResult[]> {
  return journal.runExclusive(async () => {
    const patches = await journal.read();
    const pending: SettingPatch[] = [];
    const results: CheckResult[] = [];
    for (const patch of patches) {
      const current = readPatch(patch);
      if (!isDeepStrictEqual(current, patch.after)) {
        results.push({ code: 'settings.changed', status: 'warning', summary: t("保留用户新值: {0}.{1}", patch.section, patch.key), evidence: [] });
        continue;
      }
      try {
        await writePatch(patch, patch.before);
        results.push({ code: 'settings.restored', status: 'ok', summary: t("已恢复 {0}.{1}", patch.section, patch.key), evidence: [] });
      } catch (error) {
        pending.push(patch);
        results.push({ code: 'settings.error', status: 'error', summary: t("恢复失败: {0}.{1}", patch.section, patch.key), evidence: [String(error)] });
      }
    }
    await journal.write(pending);
    return results;
  });
}
