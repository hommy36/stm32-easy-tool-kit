import { t } from '../i18n';
import { consoleBody } from './consoleHtml';
import * as vscode from 'vscode';
import { WorkflowController } from '../workflow/controller';
import { ToolState } from '../tools/state';
import { workbenchState } from './workbenchState';
import { webviewDocument } from './webview';
import { validateConsoleMessage, consoleCommands } from './consoleProtocol';
import { redact } from './diagnostics';

export class WorkbenchConsole implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private generation = 0;
  private handling = false;
  private ensuring = false;
  private readonly subscriptions: vscode.Disposable[] = [];
  constructor(private readonly context: vscode.ExtensionContext, private readonly controller: WorkflowController, private readonly tools: ToolState) {
    const refresh = () => { void this.refresh(); };
    this.subscriptions.push(controller.onDidChange(refresh), tools.onDidChange(refresh),
      vscode.workspace.onDidChangeWorkspaceFolders(refresh), vscode.workspace.onDidGrantWorkspaceTrust(refresh),
      vscode.extensions.onDidChange(refresh));
  }
  async refresh(): Promise<void> {
    const generation = ++this.generation;
    try {
      const state = await workbenchState(this.controller, this.tools);
      if (generation !== this.generation) return;
      await vscode.commands.executeCommand('setContext', 'stm32Easy.workbenchBusy', state.busy);
      await vscode.commands.executeCommand('setContext', 'stm32Easy.workbenchProject', !!state.project);
      for (const [key, value] of Object.entries(state.capabilities)) await vscode.commands.executeCommand('setContext', `stm32Easy.can${key[0].toUpperCase()}${key.slice(1)}`, value.enabled);
      await this.view?.webview.postMessage({ type: 'state', ...state });
    } catch (error) { await this.view?.webview.postMessage({ type: 'error', message: redact(String(error)) }); }
  }
  private async ensurePresets(): Promise<void> {
    if (this.ensuring || this.controller.isBusy) return;
    this.ensuring = true;
    try {
      const view = await this.controller.view();
      if (view.project && !view.metadata) await this.controller.loadChoices(view.project.settings.projectUri);
    } catch { /* the published failure is shown by refresh */ }
    finally { this.ensuring = false; }
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const resources = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'workbench');
    view.webview.options = { enableScripts: true, localResourceRoots: [resources] };
    view.webview.html = webviewDocument(view.webview, resources, 'STM32 Easy Tool Kit', 'console.js', consoleBody());
    const receive = view.webview.onDidReceiveMessage(async (raw: unknown) => {
      let acquired = false;
      try {
        const message = validateConsoleMessage(raw);
        if (message.type === 'ready') { await this.ensurePresets(); await this.refresh(); return; }
        if (message.action === 'stop') { await this.controller.stop(); return; }
        if (this.handling) throw new Error(t("当前操作正在处理，请稍候"));
        this.handling = true; acquired = true;
        const state = await workbenchState(this.controller, this.tools);
        const mutable = ['project', 'preset', 'target', 'build', 'flash', 'debug', 'configure', 'loadChoices', 'cubeMx', 'terminal', 'externals', 'clion'];
        if (mutable.includes(message.action)) {
          if (state.busy) throw new Error(t("当前操作尚未结束，请先停止或等待完成"));
          if (message.projectUri !== (state.project?.settings.projectUri ?? '') || message.revision !== (state.project?.revision ?? 0)
            || message.snapshotRevision !== state.snapshot.revision) throw new Error(t("页面已过期或工程已切换，请刷新后重试"));
        }
        if (message.action === 'project') { await this.controller.selectProject(message.value); await this.ensurePresets(); }
        else if (message.action === 'preset') await this.controller.selectConfigurePreset(message.value);
        else if (message.action === 'target') await this.controller.selectTarget(message.value, message.configuration);
        else if (message.action === 'loadChoices') await this.controller.loadChoices();
        else if (message.action !== 'refresh') await vscode.commands.executeCommand(consoleCommands[message.action]);
      } catch (error) { await view.webview.postMessage({ type: 'error', message: redact(String(error)) }); }
      finally { if (acquired) this.handling = false; await this.refresh(); await view.webview.postMessage({ type: 'complete' }); }
    });
    const visible = view.onDidChangeVisibility(() => { if (view.visible) void this.ensurePresets().then(() => this.refresh()); });
    view.onDidDispose(() => { receive.dispose(); visible.dispose(); if (this.view === view) this.view = undefined; });
    void this.refresh();
  }
  dispose(): void { for (const subscription of this.subscriptions) subscription.dispose(); }
}
export function registerWorkbenchUi(context: vscode.ExtensionContext, controller: WorkflowController, tools: ToolState): vscode.Disposable[] {
  const provider = new WorkbenchConsole(context, controller, tools);
  void provider.refresh();
  return [provider, vscode.window.registerWebviewViewProvider('stm32Easy.project', provider)];
}
