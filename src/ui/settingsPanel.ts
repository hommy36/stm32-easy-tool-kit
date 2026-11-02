import { t } from '../i18n';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ProjectStore } from '../project/store';
import { TrustStore } from '../project/trust';
import { WorkflowController } from '../workflow/controller';
import { ToolState } from '../tools/state';
import { BuildCancelled } from '../build/service';
import { redact } from './diagnostics';
import { webviewDocument } from './webview';
import { settingsBody } from './settingsHtml';
import { workbenchState } from './workbenchState';
import { MessageContext, validateSettingsMessage } from './settingsProtocol';
import { authorizationMatches } from '../project/types';
import { scriptFingerprint } from '../dap/config';
import { detectChipTargets } from '../project/targetDetection';
import { isWithin } from '../build/artifacts';
import * as fs from 'node:fs/promises';
export { validateSettingsMessage } from './settingsProtocol';

export async function assertSettingsContext(message: MessageContext, controller: WorkflowController): Promise<void> {
  if (controller.isBusy) throw new Error(t("操作进行中，请先停止或等待完成"));
  const view = await controller.view();
  if (controller.isBusy || message.projectUri !== (view.project?.settings.projectUri ?? '') || message.revision !== (view.project?.revision ?? 0)
    || message.snapshotRevision !== controller.getSnapshot().revision) throw new Error(t("页面已过期或工程已切换，请放弃修改并重新加载设置"));
}
interface PanelOptions { setup?: boolean; page?: 'build' | 'dap' | 'advanced'; tools?: boolean; }
const panels = new Map<string, { panel: vscode.WebviewPanel; navigate(options: PanelOptions): void }>();
export async function openSettings(context: vscode.ExtensionContext, _store: ProjectStore, controller: WorkflowController,
  state: ToolState, options: PanelOptions = {}): Promise<void> {
  const key = options.tools ? 'tools' : 'settings';
  const existing = panels.get(key);
  if (existing) { existing.panel.reveal(); existing.navigate(options); return; }
  const resources = vscode.Uri.joinPath(context.extensionUri, 'resources', 'workbench');
  const panel = vscode.window.createWebviewPanel(`stm32Easy.${key}`, options.tools ? t("STM32 工具管理") : options.setup ? t("STM32 配置工程") : t("STM32 工程设置"), vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [resources], retainContextWhenHidden: true });
  panel.webview.html = webviewDocument(panel.webview, resources, panel.title, 'settings.js', settingsBody(!!options.tools));
  const trust = new TrustStore(path.join(context.globalStorageUri.fsPath, 'trust'));
  let disposed = false;
  let handling = false;
  let generation = 0;
  const send = async (replaceDraft = false) => {
    const current = ++generation;
    const view = await controller.view();
    const model = await workbenchState(controller, state);
    const settings = view.project?.settings;
    let authorized = false;
    let authorizationStored = false;
    if (settings) {
      const record = (await trust.read(settings.projectUri)).authorization;
      authorizationStored = !!record;
      if (record && settings.targetScript) {
        try {
          const openocd = (await state.list()).find(tool => tool.id === 'openocd');
          authorized = authorizationMatches({ ...settings, chipConfirmed: true }, record, await scriptFingerprint(path.resolve(openocd?.scriptsDirectory ?? settings.sourceDirectory, settings.targetScript)));
        } catch { authorized = false; }
      }
    }
    const configurations = view.metadata?.configure.map(choice => {
      let binaryDirectory = t("无法解析，请检查 Presets");
      try { binaryDirectory = view.metadata!.resolve(choice.name).binaryDirectory; } catch (error) { binaryDirectory = String(error); }
      return { ...choice, binaryDirectory, builds: view.metadata!.compatibleBuilds(choice.name) };
    }) ?? [];
    if (!disposed && current === generation) await panel.webview.postMessage({ type: 'state', ...model, configurations, authorized, authorizationStored,
      replaceDraft, options, snapshotRevision: controller.getSnapshot().revision });
  };
  const report = async (error: unknown) => { if (!disposed) await panel.webview.postMessage({ type: 'error', message: redact(String(error)) }); };
  const refresh = () => { if (!handling) void send().catch(report); };
  panels.set(key, { panel, navigate: next => { options = next; void panel.webview.postMessage({ type: 'navigate', options }); refresh(); } });
  const subscriptions: vscode.Disposable[] = [];
  subscriptions.push(panel.webview.onDidReceiveMessage(async raw => {
    let acquired = false;
    try {
      const message = validateSettingsMessage(raw);
      if (message.type === 'ready') {
        try {
          const view = await controller.view();
          if (view.project && !view.metadata) await controller.loadChoices(view.project.settings.projectUri);
        } catch (error) { await report(error); }
        await send(); return;
      }
      if (message.type === 'openLog') { await vscode.commands.executeCommand('stm32Easy.workbench.showBuildLog'); return; }
      if (message.type === 'openCortex') { await vscode.commands.executeCommand('stm32Easy.workbench.openCortexDebug'); return; }
      if (message.type === 'openFolder') { await vscode.commands.executeCommand('vscode.openFolder'); return; }
      if (message.type === 'stop') { await controller.stop(); return; }
      if (!('projectUri' in message)) return;
      if (handling) throw new Error(t("设置操作尚未完成，请稍候"));
      handling = true; acquired = true;
      if (message.type === 'cancel') { await send(true); return; }
      await assertSettingsContext(message, controller);
      if (message.type === 'selectProject') { await controller.selectProject(message.value); await send(true); return; }
      if (message.type === 'toolAction') {
        const commands = { select: 'stm32Easy.selectExistingTool', install: 'stm32Easy.installTools', check: 'stm32Easy.checkEnvironment', import: 'stm32Easy.importToolArchive', copy: 'stm32Easy.copyToolPath' };
        await vscode.commands.executeCommand(commands[message.action], message.tool); await send(); return;
      }
      if (!message.projectUri) throw new Error(t("请先选择已有 CMake 工程"));
      if (message.type === 'deleteSettings') {
        const project = vscode.workspace.workspaceFolders?.find(folder => folder.uri.toString() === message.projectUri);
        const confirm = t('删除配置');
        const answer = await vscode.window.showWarningMessage(t('删除当前工程的插件配置？'), {
          modal: true, detail: t('工程：{0}\n将清除本机工程设置、.vscode/stm32-easy.json、旧版 .stm32-easy.json 和已记住的硬件确认，并放弃未保存修改。源码、Presets、CLion 配置、工具安装及 OpenOCD 脚本会保留。', project?.uri.fsPath ?? message.projectUri)
        }, confirm);
        if (answer !== confirm) return;
        await assertSettingsContext(message, controller);
        await controller.deleteSettings(message.projectUri, message.revision, () => trust.update(message.projectUri, record => { delete record.authorization; }));
        await send(true); return;
      }
      if (message.type === 'detectTargetScript') {
        const folder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.toString() === message.projectUri);
        if (!folder || message.settings.projectUri !== message.projectUri
          || !isWithin(await fs.realpath(folder.uri.fsPath), await fs.realpath(message.settings.sourceDirectory))) throw new Error(t('源码目录必须位于所选工作区文件夹中'));
        const scripts = (await state.list()).find(tool => tool.id === 'openocd')?.scriptsDirectory;
        if (!scripts) throw new Error(t('请配置 OpenOCD'));
        const candidates = await detectChipTargets(message.settings.sourceDirectory, scripts);
        if (!candidates.length) throw new Error(t('没有找到与工程芯片匹配的已安装 target 脚本，请检查芯片信息、OpenOCD 版本或手动浏览'));
        const selected = candidates.length === 1 ? candidates[0] : (await vscode.window.showQuickPick(candidates.map(candidate => ({
          label: candidate.label, description: `${candidate.targetScript}${candidate.available ? '' : ` · ${t('未安装')}`}`, detail: candidate.evidence.join(', '), candidate
        })), { title: t('工程中发现多个芯片系列，请选择当前目标'), ignoreFocusOut: true }))?.candidate;
        await assertSettingsContext(message, controller);
        if (selected && !selected.available) throw new Error(t('所选 OpenOCD 没有该芯片的 target 脚本，请更新 OpenOCD 或手动选择兼容脚本'));
        if (selected) await panel.webview.postMessage({ type: 'pickedTargetScript', file: selected.targetScript, chipLabel: selected.label, scriptKind: 'target' });
        return;
      }
      if (message.type === 'importClion') { await vscode.commands.executeCommand('stm32Easy.workbench.importClion'); await send(true); return; }
      if (message.type === 'save' || message.type === 'saveAndConfigure' || message.type === 'finishBuild') {
        if (message.settings.projectUri !== message.projectUri) throw new Error(t("设置工程身份无效"));
        const settings = message.type === 'finishBuild' ? { ...message.settings, setupComplete: true } : message.settings;
        await controller.saveSettings(settings, message.revision);
        // A failed configure must still acknowledge the successfully saved draft.
        await send(true);
        if (message.type !== 'save') await controller.run(message.type === 'finishBuild' ? 'build' : 'configure', message.projectUri);
        await send(true);
        await panel.webview.postMessage({ type: 'saved', action: message.type });
      } else if (message.type === 'loadChoices') { await controller.loadChoices(message.projectUri); await send(); }
      else if (message.type === 'revokeAuthorization') { await trust.update(message.projectUri, record => { delete record.authorization; }); await send(); }
      else if (message.type === 'pickTargetScript') {
        const openocd = (await state.list()).find(tool => tool.id === 'openocd');
        const files = await vscode.window.showOpenDialog({ title: t("选择可信的芯片配置脚本"), canSelectMany: false,
          defaultUri: openocd?.scriptsDirectory ? vscode.Uri.file(path.join(openocd.scriptsDirectory, 'target')) : undefined, filters: { 'OpenOCD scripts': ['cfg', 'tcl'] } });
        if (files?.[0]) { await assertSettingsContext(message, controller); await panel.webview.postMessage({ type: 'pickedTargetScript', file: files[0].fsPath }); }
      }
    } catch (error) { if (!(error instanceof BuildCancelled)) await report(error); }
    finally {
      if (acquired) { handling = false; await send().catch(report); }
      if (!disposed) await panel.webview.postMessage({ type: 'operationComplete' });
    }
  }), controller.onDidChange(snapshot => {
    void panel.webview.postMessage({ type: 'status', busy: controller.isBusy, workflowBusy: controller.isWorkflowBusy, snapshotRevision: snapshot.revision, message: snapshot.message });
    refresh();
  }), state.onDidChange(refresh), vscode.workspace.onDidChangeWorkspaceFolders(refresh), vscode.extensions.onDidChange(refresh));
  context.subscriptions.push(panel.onDidDispose(() => { disposed = true; panels.delete(key); for (const subscription of subscriptions) subscription.dispose(); }), panel);
}
