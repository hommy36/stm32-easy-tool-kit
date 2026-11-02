import { t, setLanguage } from './i18n';
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { ToolState } from './tools/state';
import { registerCommands } from './commands';
import { registerPathVariables } from './integration/variables';
import { ProjectStore } from './project/store';
import { WorkflowController } from './workflow/controller';
import { WorkflowHost } from './workflow/types';
import { registerWorkflowCommands } from './workflow/commands';
import { registerWorkbenchUi } from './ui/workbenchTree';
import { registerStatusBar } from './ui/statusBar';
import { BuildDiagnostics } from './ui/buildDiagnostics';
import { assertEvidenceCurrent, isWithin } from './build/artifacts';
import { configureVerificationCache, flushVerificationCache, verificationCache } from './build/verificationCache';
import { BuildCancelled } from './build/service';
import { DapRuntime, scriptFingerprint } from './dap/config';
import { authorizationFrom, authorizationMatches, isTrustedPath, normalizeTrustedPath, HardwareAuthorization } from './project/types';
import { TrustStore } from './project/trust';
import { flashFirmware } from './dap/flash';
import { startGdbServer } from './dap/server';
import { DebugSessionOwner, assertDebugPathsSupported, ensureCortexDebug } from './debug/session';
import { redact } from './ui/diagnostics';
import { ToolInstallation } from './core/types';
import { openSettings } from './ui/settingsPanel';
import { openCubeMx } from './tools/cubemx';
import { DocumentTracker } from './project/documents';
import { importClion } from './integration/clionImport';
import { registerEditorIntegration } from './integration/editor';

let activeController: WorkflowController | undefined;
export function executionGuard(): void {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error(t("首版仅支持 Windows x64 的本地 VS Code"));
  if (vscode.env.remoteName || vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme !== 'file')) throw new Error(t("首版不支持 WSL/SSH/容器或虚拟工作区；请在本地窗口使用"));
  if (!vscode.workspace.isTrusted) throw new Error(t("工作区未受信任：仅提供静态说明，不下载、执行工具或修改设置"));
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  setLanguage(vscode.env.language);
  const output = vscode.window.createOutputChannel(t("STM32 工具链"));
  const buildOutput = vscode.window.createOutputChannel(t("STM32 构建"));
  const state = new ToolState(path.join(context.globalStorageUri.fsPath, 'active'));
  const store = new ProjectStore(path.join(context.globalStorageUri.fsPath, 'projects'), async () => (await state.list()).find(tool => tool.id === 'openocd')?.scriptsDirectory);
  const trust = new TrustStore(path.join(context.globalStorageUri.fsPath, 'trust'));
  const approvedScripts = new Map<string, { file: string; sha256: string }>();
  const strictHashing = (): boolean => vscode.workspace.getConfiguration('stm32Easy').get<boolean>('verification.strictHashing', false);
  const cache = configureVerificationCache(path.join(context.globalStorageUri.fsPath, 'evidence-cache', 'v1.json'), strictHashing());
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('stm32Easy.verification.strictHashing')) cache.setStrict(strictHashing());
  }));
  const diagnostics = new BuildDiagnostics();
  const documents = new DocumentTracker(() => vscode.workspace.textDocuments);
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => documents.changed(event.document)));
  const host: WorkflowHost = {
    guard: executionGuard,
    projects: () => (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
      .map(folder => ({ uri: folder.uri.toString(), directory: folder.uri.fsPath, label: folder.name })),
    saveDocuments: async directory => {
      diagnostics.setDirectory(directory);
      for (const document of vscode.workspace.textDocuments) {
        if (document.uri.scheme === 'file' && isWithin(directory, document.uri.fsPath) && document.isDirty && !await document.save()) throw new Error(t("无法保存文档: {0}", document.uri.fsPath));
      }
      documents.capture(directory);
    },
    assertDocumentsCurrent: evidence => documents.assertCurrent(evidence),
    chooseProject: async projects => {
      if (!projects.length) { await vscode.window.showInformationMessage(t("请先通过“文件 → 打开文件夹”打开已有 STM32 CMake 工程。")); return undefined; }
      return (await vscode.window.showQuickPick(projects.map(project => ({ label: project.label, description: project.directory, uri: project.uri })), { title: t("STM32 · 选择工程"), ignoreFocusOut: true }))?.uri;
    },
    chooseConfigure: async choices => (await vscode.window.showQuickPick(choices.map(choice => ({ label: choice.displayName ?? choice.name, description: choice.name, name: choice.name })), { title: t("STM32 · 选择构建方案"), ignoreFocusOut: true }))?.name,
    chooseBuild: async choices => (await vscode.window.showQuickPick([{ label: t("直接构建目录"), name: '' }, ...choices.map(choice => ({ label: choice.displayName ?? choice.name, description: choice.name, name: choice.name }))], { title: t("STM32 · 选择构建预设"), ignoreFocusOut: true }))?.name,
    chooseTarget: async targets => (await vscode.window.showQuickPick(targets.map(target => ({ label: target.name, description: target.configuration, target })), { title: t("STM32 · 选择可执行固件目标"), ignoreFocusOut: true }))?.target,
    chooseArtifact: async files => vscode.window.showQuickPick(files, { title: t("STM32 · 选择本次构建的 ARM ELF"), ignoreFocusOut: true }),
    confirmExternal: async (file, kind, projectUri) => {
      try {
        if (projectUri && isTrustedPath((await trust.read(projectUri)).trustedPaths, file)) return true;
      } catch (error) { output.appendLine(t("读取信任记录失败: {0}", redact(String(error)))); }
      let root = file;
      try { root = (await fs.stat(file)).isDirectory() ? file : path.dirname(file); } catch { root = path.dirname(file); }
      const choice = await vscode.window.showWarningMessage(t("{0}位于工程或已选工具目录之外：\n{1}\n\n将信任该目录及其子目录：\n{2}\n\nPresets/CMake/目标脚本可能执行代码；只允许你信任的内容。", kind, file, root), { modal: true }, t("信任此目录并记住"), t("仅本次信任"));
      if (!choice) return false;
      if (choice === t("信任此目录并记住") && projectUri) {
        try {
          const normalized = normalizeTrustedPath(root);
          await trust.update(projectUri, record => {
            const paths = record.trustedPaths.filter(item => !(item === normalized || item.startsWith(`${normalized}\\`) || normalized.startsWith(`${item}\\`)));
            record.trustedPaths = [...paths, normalized].slice(0, 256);
          });
        } catch (error) { void vscode.window.showWarningMessage(t("信任记录未能保存（本次仍继续）：{0}", redact(String(error)).slice(0, 200))); }
      }
      return true;
    },
    confirmHardware: async (action, settings, evidence) => {
      const openocd = (await state.list()).find(tool => tool.id === 'openocd');
      if (!settings.targetScript) throw new Error(t('请先自动识别或选择芯片配置脚本'));
      const target = await fs.realpath(path.resolve(openocd?.scriptsDirectory ?? settings.sourceDirectory, settings.targetScript));
      const sha = await scriptFingerprint(target);
      const confirmed = { ...settings, chipConfirmed: true };
      let authorized: HardwareAuthorization | undefined;
      try { authorized = (await trust.read(settings.projectUri)).authorization; }
      catch (error) { output.appendLine(t("读取自动授权失败: {0}", redact(String(error)))); }
      if (authorizationMatches(confirmed, authorized, sha)) { approvedScripts.set(settings.projectUri, { file: target, sha256: sha }); return true; }
      const choice = await vscode.window.showWarningMessage(t('确认芯片与烧录配置'), { modal: true, detail: t('操作：{0}\n工程：{1}\n芯片：{2}\n配置脚本：{3}\n固件：{4}\nCMSIS-DAP / SWD · {5} kHz · {6}\n\n请确认芯片与脚本匹配。带电机等执行器的设备请先切断动力电源。确认并记住后，配置未变时不再询问。', action === 'flash' ? t('烧录、校验并复位运行') : t('烧录固件并复位调试'), settings.sourceDirectory, settings.chipLabel ?? t('手动确认的目标'), target, evidence.artifact, settings.speedKHz, settings.backend) }, t('确认并记住'), t('仅本次执行'));
      if (!choice) return false;
      if (await scriptFingerprint(target) !== sha) throw new Error(t('芯片配置脚本在确认期间发生变化，请重新执行'));
      if (choice === t("确认并记住") && sha) {
        try { await trust.update(settings.projectUri, record => { record.authorization = authorizationFrom(confirmed, sha); }); }
        catch (error) { void vscode.window.showWarningMessage(t("自动授权未能保存（本次仍继续）：{0}", redact(String(error)).slice(0, 200))); }
      }
      approvedScripts.set(settings.projectUri, { file: target, sha256: sha });
      return true;
    },
    rememberProject: async uri => { await context.workspaceState.update('workbenchProject', uri); },
    rememberExternalRoots: async (projectUri, roots) => { await context.globalState.update(`externals:${projectUri}`, roots.slice(0, 32)); },
    log: (stream, text, diagnosticDirectory) => {
      if (diagnosticDirectory) diagnostics.setDirectory(diagnosticDirectory);
      buildOutput.append(redact(text)); diagnostics.append(stream, text);
    }
  };
  const runtime = (tools: ToolInstallation[], projectUri?: string): DapRuntime => ({ tools, guard: executionGuard, log: host.log,
    approvedScript: projectUri ? approvedScripts.get(projectUri) : undefined,
    trustScript: file => host.confirmExternal(file, t("OpenOCD 目标脚本（可执行 Tcl）"), projectUri),
    verify: async evidence => {
      executionGuard();
      const latest = await store.read(evidence.projectUri);
      if (!latest) throw new Error(t("工程设置已移除，请重新构建"));
      await assertEvidenceCurrent(evidence, latest, await state.list());
      await documents.assertCurrent(evidence);
      executionGuard();
    } });
  const controller = new WorkflowController(store, state, host, {
    flash: (evidence, settings, tools, signal) => flashFirmware(evidence, settings, signal, runtime(tools, evidence.projectUri)),
    debug: async (evidence, settings, tools, operationId, signal) => {
      assertDebugPathsSupported(evidence, settings);
      await ensureCortexDebug();
      executionGuard();
      if (signal.aborted) throw new BuildCancelled();
      const environment = runtime(tools, evidence.projectUri);
      const server = await startGdbServer(settings, signal, { ...environment, beforeStart: () => environment.verify(evidence) });
      const owner = new DebugSessionOwner(server, signal, text => host.log('stdout', text));
      try {
        const folder = vscode.workspace.workspaceFolders?.find(item => item.uri.toString() === settings.projectUri);
        if (!folder) throw new Error(t("调试工程已从工作区移除"));
        const { makeDebugConfiguration } = await import('./debug/session');
        await owner.start(folder, makeDebugConfiguration(evidence, tools, server, settings, operationId), async () => {
          await environment.verify(evidence);
          if (!vscode.workspace.workspaceFolders?.some(item => item.uri.toString() === settings.projectUri)) throw new Error(t("调试工程已从工作区移除"));
          executionGuard();
          if (signal.aborted) throw new BuildCancelled();
        });
        return owner;
      } catch (error) { await owner.stop(); throw error; }
    }
  }, path.join(context.globalStorageUri.fsPath, 'operation-locks'), undefined, context.workspaceState.get<string>('workbenchProject'));
  activeController = controller;
  context.subscriptions.push(...registerEditorIntegration(context, controller, executionGuard, message => buildOutput.appendLine(message)));
  for (const pattern of ['**/.vscode/stm32-easy.json', '**/.stm32-easy.json']) {
    const sharedWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    context.subscriptions.push(sharedWatcher, sharedWatcher.onDidChange(() => controller.refreshProjectSettings()),
      sharedWatcher.onDidCreate(() => controller.refreshProjectSettings()), sharedWatcher.onDidDelete(() => controller.refreshProjectSettings()));
  }
  let loggedOperation: string | undefined;
  context.subscriptions.push(output, buildOutput, diagnostics);
  context.subscriptions.push(...registerCommands(context, state, output, () => {
    executionGuard();
    if (controller.isWorkflowBusy) throw new Error(t("当前工作台操作或调试尚未结束，请先停止或等待，再更换/检查工具或修改路径设置"));
  }), ...registerPathVariables(state, executionGuard));
  context.subscriptions.push(...registerWorkflowCommands(context, controller, store, state), ...registerWorkbenchUi(context, controller, state), ...registerStatusBar(controller, state));
  const openSettingsPanel = async (options?: { setup?: boolean; tools?: boolean; page?: 'build' | 'dap' | 'advanced' }) => {
    try { await openSettings(context, store, controller, state, options); }
    catch (error) { void vscode.window.showErrorMessage(`STM32: ${redact(String(error)).slice(0, 500)}`); }
  };
  context.subscriptions.push(vscode.commands.registerCommand('stm32Easy.workbench.settings', () => openSettingsPanel()),
    vscode.commands.registerCommand('stm32Easy.workbench.importClion', async () => {
      try { await importClion(controller, state, executionGuard); }
      catch (error) { if (!(error instanceof BuildCancelled)) { buildOutput.appendLine(redact(String(error))); void vscode.window.showErrorMessage(redact(String(error))); } }
    }),
    vscode.commands.registerCommand('stm32Easy.workbench.tools', () => openSettingsPanel({ tools: true })),
    vscode.commands.registerCommand('stm32Easy.workbench.dap', () => openSettingsPanel({ page: 'dap' })),
    vscode.commands.registerCommand('stm32Easy.workbench.setup', () => openSettingsPanel({ setup: true })), vscode.commands.registerCommand('stm32Easy.workbench.externals', async () => {
      try {
        const project = (await controller.view()).project;
        if (!project) { void vscode.window.showInformationMessage(t("请先选择一个已有 CMake 工程。")); return; }
        const roots = context.globalState.get<string[]>(`externals:${project.settings.projectUri}`) ?? [];
        if (!roots.length) { void vscode.window.showInformationMessage(t("尚未记录外部依赖。请先配置或编译一次，插件会把工程外的构建输入目录记录下来。")); return; }
        const picked = await vscode.window.showQuickPick(roots.map(root => ({ label: path.basename(root), description: root, root, picked: true })),
          { title: t("STM32 · 外部依赖目录"), canPickMany: true, ignoreFocusOut: true });
        if (!picked?.length) return;
        const choice = await vscode.window.showWarningMessage(t("将添加 {0} 个外部目录并自动关联编辑器编译配置：\n{1}", picked.length, picked.map(item => item.root).join('\n')),
          { modal: true }, t("添加到工作区"), t("在资源管理器中显示"));
        if (!choice) return;
        if (choice === t("在资源管理器中显示")) {
          for (const item of picked) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.root));
          return;
        }
        const normalize = (value: string) => path.win32.normalize(value).toLowerCase();
        const existing = new Set((vscode.workspace.workspaceFolders ?? []).map(folder => normalize(folder.uri.fsPath)));
        const folders = picked.filter(item => !existing.has(normalize(item.root)))
          .map(item => ({ uri: vscode.Uri.file(item.root), name: path.basename(item.root) }));
        if (!folders.length) { void vscode.window.showInformationMessage(t("这些目录已经在工作区中。")); return; }
        const start = vscode.workspace.workspaceFolders?.length ?? 0;
        if (!vscode.workspace.updateWorkspaceFolders(start, 0, ...folders)) void vscode.window.showWarningMessage(t("未能添加工作区文件夹；可改用“在资源管理器中显示”。"));
      } catch (error) { void vscode.window.showErrorMessage(`STM32: ${redact(String(error)).slice(0, 300)}`); }
    }), vscode.commands.registerCommand('stm32Easy.workbench.cubeMx', async (resource?: vscode.Uri) => {
      try { executionGuard(); await openCubeMx(context, controller, buildOutput, resource); }
      catch (error) { void vscode.window.showErrorMessage(`STM32: ${redact(String(error)).slice(0, 300)}`); }
    }), vscode.commands.registerCommand('stm32Easy.workbench.showBuildLog', () => buildOutput.show(true)),
    vscode.commands.registerCommand('stm32Easy.workbench.openCortexDebug', () => vscode.commands.executeCommand('extension.open', 'marus25.cortex-debug')),
    vscode.commands.registerCommand('stm32Easy.clearVerificationCache', async () => {
      await verificationCache().clear();
      void vscode.window.showInformationMessage(t("STM32 校验缓存已清除；下次下载或调试会重新计算内容哈希。"));
    }),
    controller.onDidChange(snapshot => {
      if (snapshot.operationId && snapshot.operationId !== loggedOperation) {
        loggedOperation = snapshot.operationId;
        diagnostics.begin();
        if (vscode.workspace.getConfiguration('stm32Easy').get<boolean>('clearBuildOutput', true)) buildOutput.clear();
        if (['saving', 'configuring', 'building', 'flashing', 'debug-starting'].includes(snapshot.phase)
          && vscode.workspace.getConfiguration('stm32Easy').get<boolean>('autoRevealOutput', true)) buildOutput.show(true);
      }
      if (['idle', 'failed', 'cancelled', 'uncertain'].includes(snapshot.phase)) diagnostics.flush();
    }));
  if (!context.globalState.get<boolean>('workbenchWelcomeShown')) {
    await context.globalState.update('workbenchWelcomeShown', true);
    void vscode.window.showInformationMessage(t("STM32 工作台已就绪：从活动栏 STM32 选择已有 CMake 工程，配置、编译、烧录和调试。"), t("打开工作台")).then(choice => {
      if (choice) void vscode.commands.executeCommand('stm32Easy.project.focus');
    });
  }
}
export async function deactivate(): Promise<void> { await activeController?.stop(); activeController = undefined; await flushVerificationCache(); }
