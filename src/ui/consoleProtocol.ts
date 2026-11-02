import { t } from '../i18n';
export const consoleCommands = {
  build: 'stm32Easy.workbench.build', flash: 'stm32Easy.workbench.buildAndFlash', debug: 'stm32Easy.workbench.debug',
  stop: 'stm32Easy.workbench.stop', configure: 'stm32Easy.workbench.configure', setup: 'stm32Easy.workbench.setup',
  settings: 'stm32Easy.workbench.settings', tools: 'stm32Easy.workbench.tools', dap: 'stm32Easy.workbench.dap',
  cortex: 'stm32Easy.workbench.openCortexDebug', problems: 'workbench.actions.view.problems', reload: 'stm32Easy.workbench.settings',
  log: 'stm32Easy.workbench.showBuildLog', cubeMx: 'stm32Easy.workbench.cubeMx', externals: 'stm32Easy.workbench.externals',
  terminal: 'stm32Easy.openTerminal', guide: 'stm32Easy.showDapGuide', openFolder: 'vscode.openFolder'
  , clion: 'stm32Easy.workbench.importClion'
} as const;
type Action = keyof typeof consoleCommands | 'refresh' | 'project' | 'preset' | 'target' | 'probe' | 'loadChoices';
export type ConsoleMessage = { type: 'ready' } | { type: 'action'; action: Action; projectUri: string; revision: number; snapshotRevision: number; value?: string; configuration?: string };
export function validateConsoleMessage(raw: unknown): ConsoleMessage {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(t("工作台消息无效"));
  const value = raw as Record<string, unknown>;
  if (value.type === 'ready' && Object.keys(value).length === 1) return { type: 'ready' };
  const allowed = ['type', 'action', 'projectUri', 'revision', 'snapshotRevision', 'value', 'configuration'];
  const actions = [...Object.keys(consoleCommands), 'refresh', 'project', 'preset', 'target', 'probe', 'loadChoices'];
  if (value.type !== 'action' || typeof value.action !== 'string' || !actions.includes(value.action)
    || Object.keys(value).some(key => !allowed.includes(key)) || typeof value.projectUri !== 'string' || value.projectUri.length > 8192
    || ![value.revision, value.snapshotRevision].every(item => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0)
    || ['value', 'configuration'].some(key => value[key] !== undefined && (typeof value[key] !== 'string' || (value[key] as string).length > 8192))) throw new Error(t("工作台消息字段无效"));
  if (['project', 'preset', 'target', 'probe'].includes(value.action) && (typeof value.value !== 'string' || !value.value)) throw new Error(t("请选择有效选项"));
  return value as unknown as ConsoleMessage;
}
