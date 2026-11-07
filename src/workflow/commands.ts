import { t } from '../i18n';
import * as vscode from 'vscode';
import { ProjectStore } from '../project/store';
import { BuildCancelled } from '../build/service';
import { errorText } from '../core/types';
import { redact } from '../ui/diagnostics';
import { WorkflowController } from './controller';
import { WorkflowAction } from './types';
import { CortexDebugUnavailable } from '../debug/session';
import { ToolState } from '../tools/state';
import { workbenchState } from '../ui/workbenchState';
import { repairForError, repairLabel } from '../ui/presentation';
import { consoleCommands } from '../ui/consoleProtocol';

export function registerWorkflowCommands(_context: vscode.ExtensionContext, controller: WorkflowController,
  _store: ProjectStore, tools: ToolState): vscode.Disposable[] {
  const register = (name: string, action: (...args: unknown[]) => Promise<void>) => vscode.commands.registerCommand(`stm32Easy.workbench.${name}`, async (...args: unknown[]) => {
    try { await action(...args); }
    catch (error) {
      if (error instanceof BuildCancelled) return;
      const repair = error instanceof CortexDebugUnavailable ? 'cortex' : repairForError(errorText(error));
      const primary = repairLabel(repair);
      const actions = [...new Set([primary, t("查看构建日志")])];
      const choice = await vscode.window.showErrorMessage(`STM32: ${redact(errorText(error)).slice(0, 500)}`, ...actions);
      if (choice === primary) await vscode.commands.executeCommand(consoleCommands[repair]);
      else if (choice) await vscode.commands.executeCommand('stm32Easy.workbench.showBuildLog');
    }
  });
  const run = (action: WorkflowAction) => async () => {
    const uri = await controller.ensureProjectUri();
    const view = await workbenchState(controller, tools);
    const availability = view.capabilities[action === 'configure' ? 'build' : action];
    if (!availability.enabled) {
      const label = availability.repair ? repairLabel(availability.repair) : undefined;
      const choice = await vscode.window.showWarningMessage(availability.reason, ...(label ? [label] : []));
      if (choice && availability.repair) await vscode.commands.executeCommand(consoleCommands[availability.repair]);
      return;
    }
    await controller.run(action, uri);
  };
  return [
    register('configure', run('configure')),
    register('build', run('build')),
    register('buildAndFlash', run('flash')),
    register('debug', run('debug')),
    register('stop', async () => controller.stop()),
    register('selectProject', async value => {
      if (value !== undefined && typeof value !== 'string') throw new Error(t("工程选择参数无效"));
      await controller.selectProject(value);
      const settings = (await controller.view()).project?.settings;
      if (settings && (!settings.configurePreset || !(await workbenchState(controller, tools)).readiness.build.enabled)
        && vscode.workspace.getConfiguration('stm32Easy').get<boolean>('autoSetup', true)) {
        void vscode.commands.executeCommand('stm32Easy.workbench.setup');
      }
    }),
    register('selectPreset', async () => controller.selectConfigurePreset()),
    register('selectBuildPreset', async () => controller.selectBuildPreset()),
    register('selectTarget', async () => controller.selectTarget())
  ];
}
