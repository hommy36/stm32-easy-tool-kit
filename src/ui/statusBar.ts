import { t } from '../i18n';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { WorkflowController } from '../workflow/controller';
import { ToolState } from '../tools/state';

export function registerStatusBar(controller: WorkflowController, tools: ToolState): vscode.Disposable[] {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 120);
  item.command = 'stm32Easy.project.focus';
  let generation = 0;
  const refresh = async () => {
    const current = ++generation;
    try {
      const view = await controller.view();
      if (current !== generation) return;
      const settings = view.project?.settings;
      const active = view.snapshot.projectUri === settings?.projectUri;
      const status = tools.isBusy ? t("正在处理工具") : active ? view.snapshot.message : t("待操作");
      item.text = `${controller.isBusy ? '$(sync~spin)' : '$(circuit-board)'} ${settings ? `${path.basename(settings.sourceDirectory)} · ${settings.configurePreset ?? t("未选方案")}` : 'STM32'} · ${status.length > 20 ? status.slice(0, 20) + '…' : status}`;
      item.tooltip = t("{0}\n打开 STM32 工作台", status);
      item.show();
    } catch { item.text = t("$(error) STM32 设置异常"); item.show(); }
  };
  void refresh();
  return [item, controller.onDidChange(() => { void refresh(); }), tools.onDidChange(() => { void refresh(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void refresh(); })];
}
