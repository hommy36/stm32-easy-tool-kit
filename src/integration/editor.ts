import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { t } from '../i18n';
import { WorkflowController } from '../workflow/controller';

import { compilerDrivers, mergeClangdArguments, mergeDatabases } from './editorDatabase';

// Use one workspace-level database for all roots, including added external libraries.
// Never copy compiler paths into the shared STM32 project configuration.
export function registerEditorIntegration(context: vscode.ExtensionContext, controller: WorkflowController,
  guard: () => void, log: (message: string) => void): vscode.Disposable[] {
  let updating = false;
  let pendingFolders = false;
  let resync = false;
  let lastOverrides = '';
  const sync = async (allowConfigure = false) => {
    pendingFolders ||= allowConfigure;
    if (updating || controller.isBusy) return;
    guard();
    const hasCpptools = !!vscode.extensions.getExtension('ms-vscode.cpptools');
    const hasClangd = !!vscode.extensions.getExtension('llvm-vs-code-extensions.vscode-clangd');
    if (!hasCpptools && !hasClangd) {
      return;
    }
    updating = true;
    try {
      let view = await controller.view();
      const configure = pendingFolders; pendingFolders = false;
      if (configure && view.project?.settings.configurePreset && !view.model) {
        await controller.run('configure', view.project.settings.projectUri); view = await controller.view();
      }
      if (!view.project || !view.model) return;
      const identity = view.project;
      const database = path.join(view.model.binaryDirectory, 'compile_commands.json');
      let stat;
      try { stat = await fs.stat(database); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !configure) throw error;
        await controller.run('configure', identity.settings.projectUri);
        resync = true;
        // Configure may select a different target or revision: sync the new snapshot.
        return;
      }
      if (!stat.isFile() || stat.size > 33554432) throw new Error(t('编译数据库缺失或无效，请重新配置 CMake'));
      const commands: unknown = JSON.parse(await fs.readFile(database, 'utf8'));
      if (!Array.isArray(commands) || !commands.length || commands.length > 20000) throw new Error(t('编译数据库缺失或无效，请重新配置 CMake'));
      const drivers = compilerDrivers(commands);
      const folder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.toString() === identity.settings.projectUri);
      if (!folder) return;
      const relative = path.relative(folder.uri.fsPath, database);
      const reference = !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
        ? `\${workspaceFolder:${folder.name}}/${relative.replace(/\\/g, '/')}` : database;
      const current = await controller.view();
      if (controller.isBusy || current.project?.revision !== identity.revision || current.project.settings.projectUri !== identity.settings.projectUri) return;
      guard();
      if (hasCpptools) {
        const config = vscode.workspace.getConfiguration('C_Cpp');
        const old = context.workspaceState.get<string>('editor.database');
        const before = config.inspect<unknown>('default.compileCommands')?.workspaceValue;
        const next = mergeDatabases(before, old, reference);
        if (JSON.stringify(next) !== JSON.stringify(before)) await config.update('default.compileCommands', next, vscode.ConfigurationTarget.Workspace);
        await context.workspaceState.update('editor.database', reference);
        const overrides = (vscode.workspace.workspaceFolders ?? []).filter(root => {
          const cpp = vscode.workspace.getConfiguration('C_Cpp', root.uri);
          return !!cpp.get('default.configurationProvider') || cpp.inspect('default.compileCommands')?.workspaceFolderValue !== undefined;
        });
        const conflict = overrides.map(root => root.name).join(', ');
        if (conflict && conflict !== lastOverrides) {
          log(t('编译数据库已设置，但以下文件夹存在配置提供程序或文件夹级覆盖，请检查 C/C++ 配置：{0}', conflict));
        }
        lastOverrides = conflict;
      }
      if (hasClangd) {
        const clangd = vscode.workspace.getConfiguration('clangd');
        const before = clangd.inspect<unknown>('arguments')?.workspaceValue;
        const next = mergeClangdArguments(before ?? clangd.get<unknown>('arguments'), path.dirname(database), drivers);
        if (JSON.stringify(next) !== JSON.stringify(before)) {
          await clangd.update('arguments', next, vscode.ConfigurationTarget.Workspace);
          void vscode.commands.executeCommand('clangd.restart').then(() => undefined, () => undefined);
        }
      }
      log(t('编辑器编译数据库已同步：{0}', database));
    } finally {
      updating = false;
      if (resync || pendingFolders) { resync = false; void sync().catch(error => log(String(error))); }
    }
  };
  // Keep the old command ID for shortcuts, without exposing another setup step.
  const run = (configure = false) => { void sync(configure).catch(error => log(String(error))); };
  run();
  return [vscode.commands.registerCommand('stm32Easy.workbench.editor', () => sync(true).catch(error => log(String(error)))),
    controller.onDidChange(() => { if (!controller.isBusy) void sync(false).catch(error => log(String(error))); }),
    vscode.workspace.onDidChangeWorkspaceFolders(event => { run(event.added.length > 0); }),
    vscode.extensions.onDidChange(() => run())];
}
