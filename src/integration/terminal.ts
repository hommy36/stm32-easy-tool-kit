import { t } from '../i18n';
import * as vscode from 'vscode';
import { mergeToolPath, toolBinDirectories } from '../core/paths';
import { ToolInstallation } from '../core/types';

export function openToolTerminal(tools: ToolInstallation[]): void {
  if (!tools.length) throw new Error(t("尚未配置工具，请先安装或选择已有工具"));
  const terminal = vscode.window.createTerminal({ name: t("STM32 工具链"), env: mergeToolPath(process.env, toolBinDirectories(tools)) });
  terminal.show();
}
