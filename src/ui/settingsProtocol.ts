import { t } from '../i18n';
import { ProjectSettings, validateProjectSettings } from '../project/types';
import { ToolId, toolIds } from '../core/types';
export interface MessageContext { projectUri: string; revision: number; snapshotRevision: number; }
export type SettingsMessage = { type: 'ready' | 'openLog' | 'openCortex' | 'openFolder' | 'stop' }
  | ({ type: 'save' | 'saveAndConfigure' | 'finishBuild' | 'detectTargetScript'; settings: ProjectSettings } & MessageContext)
  | ({ type: 'cancel' | 'loadChoices' | 'pickTargetScript' | 'revokeAuthorization' | 'importClion' | 'deleteSettings' } & MessageContext)
  | ({ type: 'selectProject'; value: string } & MessageContext)
  | ({ type: 'toolAction'; tool: ToolId; action: 'select' | 'install' | 'check' | 'import' | 'copy' } & MessageContext);
export function validateSettingsMessage(raw: unknown): SettingsMessage {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(t("设置消息无效"));
  const value = raw as Record<string, unknown>;
  const simple = ['ready', 'openLog', 'openCortex', 'openFolder', 'stop'];
  if (typeof value.type === 'string' && simple.includes(value.type) && Object.keys(value).length === 1) return value as SettingsMessage;
  const saving = ['save', 'saveAndConfigure', 'finishBuild', 'detectTargetScript'].includes(String(value.type));
  const types = ['save', 'saveAndConfigure', 'finishBuild', 'detectTargetScript', 'cancel', 'loadChoices', 'pickTargetScript', 'revokeAuthorization', 'selectProject', 'toolAction', 'importClion', 'deleteSettings'];
  const allowed = ['type', 'projectUri', 'revision', 'snapshotRevision', ...(saving ? ['settings'] : value.type === 'toolAction' ? ['tool', 'action'] : value.type === 'selectProject' ? ['value'] : [])];
  if (typeof value.type !== 'string' || !types.includes(value.type) || Object.keys(value).some(key => !allowed.includes(key))
    || typeof value.projectUri !== 'string' || value.projectUri.length > 8192
    || ![value.revision, value.snapshotRevision].every(item => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0)) throw new Error(t("设置消息上下文无效"));
  if (saving) validateProjectSettings(value.settings);
  if (value.type === 'selectProject' && (typeof value.value !== 'string' || !value.value || value.value.length > 8192)) throw new Error(t("工程选择无效"));
  if (value.type === 'toolAction' && (!toolIds.includes(value.tool as ToolId) || !['select', 'install', 'check', 'import', 'copy'].includes(String(value.action)))) throw new Error(t("工具动作无效"));
  return value as unknown as SettingsMessage;
}
