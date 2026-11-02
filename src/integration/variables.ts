import { t } from '../i18n';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { ToolState } from '../tools/state';
import { ToolId } from '../core/types';

export function registerPathVariables(state: ToolState, guard: () => void): vscode.Disposable[] {
  const definitions: [string, ToolId, string][] = [
    ['gcc', 'armGnu', 'gcc'], ['gdb', 'armGnu', 'gdb'], ['cmake', 'cmake', 'cmake'],
    ['ninja', 'ninja', 'ninja'], ['openocd', 'openocd', 'openocd'],
    ['openocdScripts', 'openocd', 'scripts'], ['armBin', 'armGnu', 'bin']
  ];
  return definitions.map(([name, id, field]) => vscode.commands.registerCommand(`stm32Easy.path.${name}`, async () => {
    guard();
    const tool = await state.get(id);
    const value = field === 'scripts' ? tool.scriptsDirectory : field === 'bin' ? path.dirname(tool.executables.gcc) : tool.executables[field];
    if (!value) throw new Error(t("选定工具缺少 {0} 路径", name));
    await vscode.workspace.fs.stat(vscode.Uri.file(value));
    return value;
  }));
}
