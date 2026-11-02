import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { ToolState } from '../tools/state';
import { toolIds, toolNames } from '../core/types';
import { WorkflowController } from '../workflow/controller';
import { isCmakeProject } from '../project/discover';
import { capabilities, cortexCompatible, repairForError, repairLabel, ToolSummary } from './presentation';

export async function toolSummaries(state: ToolState): Promise<ToolSummary[]> {
  const tools = await state.list();
  return Promise.all(toolIds.map(async id => {
    const tool = tools.find(item => item.id === id);
    const checks = state.results.get(id) ?? [];
    let exists = !!tool;
    if (tool) {
      try {
        for (const file of Object.values(tool.executables)) if (!(await fs.stat(file)).isFile()) exists = false;
        if (id === 'openocd' && (!tool.scriptsDirectory || !(await fs.stat(tool.scriptsDirectory)).isDirectory())) exists = false;
      } catch { exists = false; }
    }
    const failed = checks.some(check => check.status === 'error');
    const status = !tool ? t("未配置") : !exists ? t("文件失效，请重新选择") : failed ? t("检查失败") : checks.some(check => check.status === 'warning') ? t("检查有提醒") : checks.length ? t("检查完成") : t("已配置，尚未检查");
    return { id, name: toolNames[id], root: tool?.root, version: tool?.version, source: tool?.source,
      available: exists && !failed, status, checks };
  }));
}
export async function workbenchState(controller: WorkflowController, tools: ToolState) {
  const view = await controller.view();
  const settings = view.project?.settings;
  const summaries = await toolSummaries(tools);
  const artifact = view.snapshot.evidence?.projectUri === settings?.projectUri ? view.snapshot.evidence?.artifact : undefined;
  const cmakeProject = !!settings && await isCmakeProject(settings.sourceDirectory);
  const cortex = cortexCompatible(vscode.extensions.getExtension('marus25.cortex-debug')?.packageJSON.version);
  const supported = process.platform === 'win32' && process.arch === 'x64' && !vscode.env.remoteName
    && !(vscode.workspace.workspaceFolders ?? []).some(folder => folder.uri.scheme !== 'file');
  const input = { settings, cmakeProject, tools: summaries, supported, trusted: vscode.workspace.isTrusted, cortex, artifact };
  const repair = repairForError(view.snapshot.message);
  return {
    project: view.project, projects: (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
      .map(folder => ({ uri: folder.uri.toString(), label: folder.name })),
    configurations: view.metadata?.configure.map(choice => ({ name: choice.name, label: choice.displayName || choice.name })) ?? [],
    targets: view.model?.targets.map(target => ({ id: target.id, configuration: target.configuration, name: target.name })) ?? [],
    metadataLoaded: !!view.metadata, cmakeProject, tools: summaries, artifact, cortex,
    snapshot: view.snapshot, busy: controller.isBusy, toolBusy: tools.isBusy, workflowBusy: controller.isWorkflowBusy,
    repair: { action: repair, label: repairLabel(repair) },
    readiness: capabilities({ ...input, busy: false }),
    capabilities: capabilities({ ...input, busy: controller.isBusy })
  };
}
