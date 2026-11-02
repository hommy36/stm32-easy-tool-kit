import { t } from '../i18n';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { WorkflowController } from '../workflow/controller';
import { redact } from '../ui/diagnostics';
import { CubeMxRunner, commonCubeMxPaths, executableExists, findIocFiles, spawnCubeMx } from './cubemxDiscovery';

async function chooseExecutable(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration('stm32Easy').get<string>('cubeMxPath', '');
  const remembered = context.globalState.get<string>('cubeMxExecutable');
  for (const candidate of [configured, remembered, ...commonCubeMxPaths()]) {
    if (candidate && await executableExists(candidate)) {
      if (candidate !== remembered) await context.globalState.update('cubeMxExecutable', candidate);
      return candidate;
    }
  }
  const picked = await vscode.window.showOpenDialog({
    title: t("选择 STM32CubeMX.exe"),
    canSelectMany: false,
    filters: { 'STM32CubeMX': ['exe'] },
    defaultUri: remembered ? vscode.Uri.file(path.dirname(remembered)) : undefined,
  });
  const file = picked?.[0]?.fsPath;
  if (!file) return undefined;
  if (!await executableExists(file)) {
    void vscode.window.showErrorMessage(t("所选文件不是可执行的 STM32CubeMX.exe。"));
    return undefined;
  }
  await context.globalState.update('cubeMxExecutable', file);
  output.appendLine(t("已记住 STM32CubeMX 路径: {0}", file));
  return file;
}

export async function openCubeMx(context: vscode.ExtensionContext, controller: WorkflowController,
  output: vscode.OutputChannel, resource?: vscode.Uri, runner: CubeMxRunner = spawnCubeMx): Promise<void> {
  const project = (await controller.view()).project;
  let ioc = resource?.fsPath.toLowerCase().endsWith('.ioc') ? resource.fsPath : undefined;
  if (!ioc) {
    if (!project) { void vscode.window.showInformationMessage(t("请先在 STM32 工作台选择一个已有 CMake 工程。")); return; }
    const files = await findIocFiles(project.settings.sourceDirectory);
    if (!files.length) {
      const picked = await vscode.window.showOpenDialog({ title: t("选择工程使用的 .ioc 文件"), canSelectMany: false,
        filters: { [t("CubeMX 工程")]: ['ioc'] }, defaultUri: vscode.Uri.file(project.settings.sourceDirectory) });
      ioc = picked?.[0]?.fsPath;
      if (!ioc) return;
    } else if (files.length === 1) ioc = files[0];
    else {
      const picked = await vscode.window.showQuickPick(files.map(file => ({ label: path.basename(file),
        description: path.relative(project.settings.sourceDirectory, file), file })), { title: t("STM32 · 选择要打开的 .ioc 文件"), ignoreFocusOut: true });
      if (!picked) return;
      ioc = picked.file;
    }
  }
  const executable = await chooseExecutable(context, output);
  if (!executable) return;
  try {
    runner(executable, ioc);
    output.appendLine(t("启动 STM32CubeMX: {0} \"{1}\"", executable, ioc));
    void vscode.window.setStatusBarMessage(t("已启动 STM32CubeMX"), 4000);
  } catch (error) {
    void vscode.window.showErrorMessage(t("启动 STM32CubeMX 失败: {0}", redact(String(error)).slice(0, 300)));
  }
}
