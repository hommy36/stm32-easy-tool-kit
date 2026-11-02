import { t } from './i18n';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { ToolState } from './tools/state';
import { loadCatalog } from './tools/catalog';
import { findCandidates, validateExistingTool } from './tools/detect';
import { checkInstallation } from './tools/check';
import { installRelease } from './tools/install';
import { ToolId, ToolRelease, ToolInstallation, CheckResult, toolIds, toolNames, errorText } from './core/types';
import { openToolTerminal } from './integration/terminal';
import { applyIntegrationPatch, buildIntegrationPatch, integrationOverrides, restoreIntegrationPatch } from './integration/settings';
import { dapGuide } from './dap/guide';
import { diagnose, redact } from './ui/diagnostics';
import { FileSettingsJournal } from './integration/journal';

export function registerCommands(context: vscode.ExtensionContext, state: ToolState,
  output: vscode.OutputChannel, guard: () => void): vscode.Disposable[] {
  const journal = new FileSettingsJournal(path.join(context.globalStorageUri.fsPath, 'integration'));
  const log = (text: string) => output.appendLine(redact(text));
  const register = (name: string, action: (...args: unknown[]) => Promise<void>, execute = true) => vscode.commands.registerCommand(`stm32Easy.${name}`, async (...args: unknown[]) => {
    try {
      if (execute) guard();
      await action(...args);
    } catch (error) {
      const text = redact(errorText(error));
      log(text);
      log(diagnose(text));
      output.show(true);
      void vscode.window.showErrorMessage(`STM32: ${text.slice(0, 500)}`);
    }
  });
  const exclusive = (action: () => Promise<void>) => state.exclusive(action);
  const chooseTool = async (id?: unknown): Promise<ToolId | undefined> => {
    if (typeof id === 'string' && toolIds.includes(id as ToolId)) return id as ToolId;
    return (await vscode.window.showQuickPick(toolIds.map(value => ({ label: toolNames[value], id: value })), { title: t("选择工具") }))?.id;
  };
  const logChecks = (name: string, checks: CheckResult[]) => {
    log(`\n=== ${name} ===`);
    for (const check of checks) log(`[${check.status}] ${check.summary}\n${check.evidence.join('\n')}`);
  };
  const verifyTools = async (id?: ToolId): Promise<ToolInstallation[]> => {
    const tools = (await state.list()).filter(tool => !id || tool.id === id);
    if (!tools.length) throw new Error(t("尚未配置工具，请先安装或选择已有工具"));
    let failed = false;
    for (const tool of tools) {
      const checks = await checkInstallation(tool);
      state.results.set(tool.id, checks);
      logChecks(toolNames[tool.id], checks);
      failed ||= checks.some(check => check.status === 'error');
    }
    state.refresh();
    if (failed) throw new Error(t("存在工具检查错误，请先修复，具体原因见日志"));
    return tools;
  };
  const install = async (release: ToolRelease, archive?: string) => {
    const custom = vscode.workspace.getConfiguration('stm32Easy').get<string>('toolsDirectory', '').trim();
    const directory = custom || path.join(context.globalStorageUri.fsPath, 'tools');
    if (!path.isAbsolute(directory)) throw new Error(t("工具根目录必须为绝对路径"));
    const confirmed = await vscode.window.showInformationMessage(
      t("{0} {1}\n{2} MiB ZIP\n来源: {3}\n许可: {4}\n安装目录: {5}\n不会删除或覆盖旧安装，也不会修改工程文件。", toolNames[release.id], release.version, Math.ceil(release.archiveBytes / 1024 / 1024), release.url, release.licenseUrl, directory),
      { modal: true }, archive ? t("校验并导入") : t("下载并安装"));
    if (!confirmed) return;
    guard();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `STM32: ${toolNames[release.id]}`, cancellable: true }, async (progress, token) => {
      const controller = new AbortController();
      const cancellation = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) controller.abort();
      try {
        const proxy = vscode.workspace.getConfiguration('http').get<string>('proxy', '') || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
        const tool = await installRelease(release, directory, controller.signal, archive, {
          proxy, progress: message => progress.report({ message }), activate: async item => { guard(); await state.select(item); }
        });
        state.results.delete(tool.id);
        state.refresh();
        log(t("已安装 {0} {1}: {2}", toolNames[tool.id], tool.version, tool.root));
        void vscode.window.showInformationMessage(t("{0} 已安装，可返回工作台继续配置工程。", toolNames[tool.id]));
      } finally { cancellation.dispose(); }
    });
  };

  return [
    register('installTools', async (argument?: unknown) => exclusive(async () => {
      const catalog = loadCatalog();
      if (typeof argument === 'string' && toolIds.includes(argument as ToolId)) {
        const release = catalog.find(item => item.id === argument);
        if (!release) throw new Error(t("清单中没有该工具"));
        await install(release); return;
      }
      const selected = await vscode.window.showQuickPick(catalog.map(release => ({ label: toolNames[release.id], description: release.version, picked: true, release })), { title: t("选择要安装的固定版本工具"), canPickMany: true });
      if (!selected) return;
      for (const item of selected) await install(item.release);
    })),
    register('importToolArchive', async (argument?: unknown) => exclusive(async () => {
      const id = await chooseTool(argument);
      if (!id) return;
      const release = loadCatalog().find(item => item.id === id);
      if (!release) throw new Error(t("清单中没有该工具"));
      const files = await vscode.window.showOpenDialog({ title: t("导入 {0} {1} 的原始 ZIP", toolNames[id], release.version), canSelectMany: false, filters: { ZIP: ['zip'] } });
      if (files?.[0]) await install(release, files[0].fsPath);
    })),
    register('selectExistingTool', async (argument?: unknown) => exclusive(async () => {
      const id = await chooseTool(argument);
      if (!id) return;
      const candidates = await findCandidates(id, log);
      const choices = [
        ...candidates.map(root => ({ label: root, description: t("已发现的程序目录，尚未执行检查"), root })),
        { label: t("浏览安装目录…"), description: t("手动选择已有安装，无需修改系统 PATH"), root: '' }
      ];
      const sources = id === 'openocd' ? t("PATH 和 CLion 的已有配置") : 'PATH';
      const choice = await vscode.window.showQuickPick(choices, {
        title: t("选择 {0} 已有安装（不会自动执行候选程序）", toolNames[id]),
        placeHolder: candidates.length ? t("已查找 {0}；请选择或手动浏览", sources)
          : t("{0} 中未发现可访问的程序；不代表未安装，请浏览安装目录", sources)
      });
      if (!choice) return;
      let root = choice.root;
      if (!root) root = (await vscode.window.showOpenDialog({ title: t("选择安装目录或 bin 目录"), canSelectFolders: true, canSelectFiles: false, canSelectMany: false }))?.[0]?.fsPath ?? '';
      if (!root) return;
      const confirmed = await vscode.window.showWarningMessage(t("即将执行此目录中的工具以检查版本，请确认来源可信：\n{0}\n不会执行工程脚本或连接目标。", root), { modal: true }, t("信任并检查"));
      if (!confirmed) return;
      guard();
      const tool = await validateExistingTool(id, root);
      await state.select(tool);
      state.results.delete(id);
      log(t("已选择外部工具 {0}: {1}", toolNames[id], root));
    })),
    register('checkEnvironment', async (argument?: unknown) => exclusive(async () => {
      const id = typeof argument === 'string' && toolIds.includes(argument as ToolId) ? argument as ToolId : undefined;
      const tools = await verifyTools(id);
      const missing = (id ? [id] : toolIds).filter(id => !tools.some(tool => tool.id === id));
      output.show(true);
      void vscode.window.showInformationMessage(missing.length ? t("已检查选定工具。尚未配置: {0}", missing.map(id => toolNames[id]).join(', ')) : t("{0}检查完成，详细结果见工具管理。此检查不连接硬件。", id ? toolNames[id] : t("工具环境")));
    })),
    register('openTerminal', async () => exclusive(async () => { openToolTerminal(await verifyTools()); })),
    register('copyToolPath', async argument => {
      const id = await chooseTool(argument);
      if (!id) return;
      const tool = await state.get(id);
      const selected = await vscode.window.showQuickPick([
        ...Object.entries(tool.executables).map(([label, file]) => ({ label, description: file, file })),
        ...(tool.scriptsDirectory ? [{ label: 'OpenOCD scripts', description: tool.scriptsDirectory, file: tool.scriptsDirectory }] : [])
      ], { title: t("选择要复制的绝对路径") });
      if (selected) { await vscode.env.clipboard.writeText(selected.file); void vscode.window.showInformationMessage(t("路径已复制")); }
    }),
    register('applyIntegration', async () => exclusive(async () => {
      const tools = await verifyTools();
      const patches = buildIntegrationPatch(tools);
      for (const id of ['ms-vscode.cmake-tools', 'marus25.cortex-debug']) {
        if (!vscode.extensions.getExtension(id)) log(t("未安装 {0}，跳过其设置；可在扩展市场手动安装。", id));
      }
      if (!patches.length) {
        void vscode.window.showInformationMessage(t("没有可应用的路径变更。可能已经配置，或对应扩展尚未安装；仍请核对工程级覆盖。"));
        return;
      }
      const overrides = integrationOverrides(patches);
      const preview = [t("# STM32 工具路径预览"), '', t("只修改 VS Code 用户设置，会影响其他工作区；不修改工程文件。"), '', ...patches.map(patch => t("{0}.{1}{2}\n旧值: {3}\n新值: {4}", patch.section, patch.key, patch.property ? `.${patch.property}` : '', JSON.stringify(patch.before) ?? t("(未设置)"), JSON.stringify(patch.after))), '', ...overrides,
        t("Presets/launch.json 的显式路径也可能覆盖用户设置；插件不会修改它们。")].join('\n');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: redact(preview), language: 'markdown' }));
      if (!await vscode.window.showWarningMessage(t("是否按预览应用用户级工具路径？这会影响其他工作区，可通过“恢复工具路径设置”撤销。"), { modal: true }, t("应用用户设置"))) return;
      guard();
      await applyIntegrationPatch(patches, journal);
      log(t("工具路径已写入用户设置。请核对现有工程配置/Presets 的优先级。"));
      void vscode.window.showInformationMessage(overrides.length ? t("用户级路径已更新，但存在工程级覆盖，请查看预览提示。") : t("用户级路径已更新。请用你的现有工程验证 configure/build；插件未改交叉编译设置。"));
    })),
    register('restoreIntegration', async () => exclusive(async () => {
      if (!await vscode.window.showWarningMessage(t("仅恢复仍等于插件应用值的设置，保留用户后来修改的值。继续？"), { modal: true }, t("恢复"))) return;
      guard();
      logChecks(t("恢复工具路径设置"), await restoreIntegrationPatch(journal));
      output.show(true);
    })),
    register('showDapGuide', async () => {
      const tools = await state.list();
      const configuration = vscode.workspace.getConfiguration('stm32Easy');
      const rawBackend = configuration.get<string>('dap.backend', 'auto');
      const backend = rawBackend === 'hid' || rawBackend === 'usb_bulk' ? rawBackend : 'auto';
      const content = dapGuide(tools.find(tool => tool.id === 'openocd'), backend, configuration.get<string>('dap.serial', ''));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content, language: 'markdown' }));
    }, false),
    register('showLog', async () => { output.show(); }, false)
  ];
}
