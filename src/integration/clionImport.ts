import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { t } from '../i18n';
import { CheckResult, ToolId, ToolInstallation, toolNames } from '../core/types';
import { ToolState } from '../tools/state';
import { findCandidates, validateExistingTool } from '../tools/detect';
import { BuildCancelled } from '../build/service';
import { buildToolEnvironment } from '../build/environment';
import { loadPresetMetadata, PresetMetadata, ResolvedSelection } from '../build/presets';
import { WorkflowController } from '../workflow/controller';
import { defaultProjectSettings, DebugProbe, probeLabel } from '../project/types';
import { ClionProfile, ClionRun, cachedToolPaths, expandClion, profileSelection, readClionInstallations, readClionProject, readConfig, selectClionToolchain } from './clionConfig';

export function matchClionPreset(profile: ClionProfile, source: string, environment: NodeJS.ProcessEnv, metadata: PresetMetadata): string[] {
  const directory = profile.directory ? path.resolve(source, expandClion(profile.directory, source, environment)).toLowerCase() : undefined;
  const candidates = metadata.configure.filter(choice => {
    if (choice.name === profile.name) return true;
    try { return !!directory && path.resolve(metadata.resolve(choice.name).binaryDirectory).toLowerCase() === directory; } catch { return false; }
  });
  return candidates.map(choice => choice.name);
}
export function boardSettings(text: string): { speedKHz?: number; backend?: 'auto' | 'hid' | 'usb_bulk'; serial?: string; probe?: DebugProbe } {
  const lines = text.split(/\r?\n/).map(line => line.replace(/#.*$/, '').trim());
  if (lines.some(line => /interface\/(?!cmsis-dap\.cfg|stlink\.cfg|stlink-dap\.cfg|jlink\.cfg)[\w./-]+\.cfg|adapter\s+driver\s+(?!cmsis-dap\b|st-link\b|jlink\b)\S+|transport\s+select\s+(?!swd\b|hla_swd\b)\S+/.test(line))) {
    throw new Error(t('该 OpenOCD 配置使用不支持的探针或通信方式；当前支持 DAPLink、ST-Link、J-Link 的 SWD'));
  }
  const last = (pattern: RegExp) => lines.map(line => { const match = pattern.exec(line); return match?.[1] ?? match?.[2]; }).filter((value): value is string => !!value).at(-1);
  const speed = last(/^(?:adapter\s+speed|adapter_khz)\s+(\d+)\s*$/);
  const backend = last(/^(?:cmsis-dap\s+backend|cmsis_dap_backend)\s+(auto|hid|usb_bulk)\s*$/) as 'auto' | 'hid' | 'usb_bulk' | undefined;
  const serial = last(/^(?:adapter\s+serial|hla_serial)\s+(?:"([^"$\[\]]+)"|([^\s$\[\]]+))\s*$/) ?? undefined;
  const probe: DebugProbe = lines.some(line => /adapter\s+driver\s+jlink\b/.test(line))
    ? 'jlink' : lines.some(line => /adapter\s+driver\s+st-link\b/.test(line))
      ? 'st-link' : lines.some(line => /interface\/(?:stlink|stlink-dap)\.cfg\b/.test(line))
        ? 'st-link' : lines.some(line => /interface\/jlink\.cfg\b/.test(line)) ? 'jlink' : 'cmsis-dap';
  if (speed && (+speed < 1 || +speed > 10000)) throw new Error(t('配置脚本中的 SWD 速度超出 1–10000 kHz'));
  return { speedKHz: speed ? +speed : undefined, backend, serial, probe };
}
async function signature(files: string[]): Promise<string> {
  const digest = createHash('sha256');
  for (const file of [...new Set(files)].sort()) { digest.update(file); digest.update(await readConfig(file) ?? '<missing>'); }
  return digest.digest('hex');
}
async function existingFile(file: string | undefined): Promise<boolean> {
  if (!file || !path.isAbsolute(file)) return false;
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}
export async function importClion(controller: WorkflowController, tools: ToolState, guard: () => void): Promise<void> {
  guard();
  if (controller.isBusy) throw new Error(t('当前操作尚未结束'));
  const project = (await controller.view()).project;
  if (!project) throw new Error(t('请先选择工程'));
  const source = project.settings.sourceDirectory, selectedTools = await tools.list();
  const defaults = defaultProjectSettings(project.settings.projectUri, source);
  const environment = buildToolEnvironment(process.env, selectedTools);
  const data = await readClionProject(source), installations = await readClionInstallations();
  const originalFiles = [...data.files, ...installations.flatMap(item => item.files)];
  const originalSignature = await signature(originalFiles);
  if (JSON.stringify(data) !== JSON.stringify(await readClionProject(source))
    || JSON.stringify(installations) !== JSON.stringify(await readClionInstallations())) {
    throw new Error(t('CLion 配置在预览后发生变化，请重新导入'));
  }
  const profiles = data.profiles.filter(profile => profile.enabled);
  if (!profiles.length) throw new Error(t('未找到启用的 CLion CMake Profile，请先在 CLion 中保存配置'));
  const picked = profiles.length === 1 ? profiles[0] : (await vscode.window.showQuickPick(profiles.map(profile => ({
    label: profile.name, description: profile.fromPreset ? 'CMake Preset' : profile.toolchain ?? t('默认工具链'), profile
  })), { title: t('选择要沿用的 CLion CMake Profile'), ignoreFocusOut: true }))?.profile;
  if (!picked) return;
  const chain = selectClionToolchain(picked, installations);
  if (chain?.toolchain.unsupported.length) throw new Error(t('无法导入 CLion 配置：{0}', chain.toolchain.unsupported.join(', ')));
  let selection: ResolvedSelection;
  let buildPreset: string | undefined;
  if (picked.fromPreset) {
    const native = await loadPresetMetadata(source, environment, { allowExternal: async file => !!await vscode.window.showWarningMessage(
      t('读取工程外的 Presets 文件：{0}', file), { modal: true }, t('继续')) });
    const matches = matchClionPreset(picked, source, environment, native);
    let name = matches.length === 1 ? matches[0] : (await vscode.window.showQuickPick(native.configure.map(item => ({
      label: item.displayName || item.name, description: item.name, name: item.name
    })), { title: t('选择此 CLion Profile 对应的现有 Configure Preset'), ignoreFocusOut: true }))?.name;
    if (!name) return;
    const builds = native.compatibleBuilds(name);
    buildPreset = builds.find(build => build.name === name)?.name ?? (builds.length === 1 ? builds[0].name : undefined);
    if (builds.length > 1 && !buildPreset) {
      const choice = await vscode.window.showQuickPick(builds.map(build => ({ label: build.displayName || build.name, name: build.name })),
        { title: t('构建预设（Build Preset）'), ignoreFocusOut: true });
      if (!choice) return;
      buildPreset = choice.name;
    }
    selection = native.resolve(name, buildPreset);
  } else selection = profileSelection(picked, source, environment, chain?.toolchain);
  let run: ClionRun | undefined;
  const matchingRuns = data.runs.filter(run => !run.profile || run.profile === picked.name);
  const runs = matchingRuns.length ? matchingRuns : data.runs;
  if (runs.length === 1) run = runs[0];
  else if (runs.length > 1) {
    const choice = await vscode.window.showQuickPick([
    ...runs.map(run => ({ label: run.name, description: run.boardScript, run })),
    { label: t('暂不导入 OpenOCD 配置'), description: '', run: undefined }
    ], { title: t('选择 CLion OpenOCD 运行配置'), ignoreFocusOut: true });
    if (!choice) return;
    run = choice.run;
  }
  const script = run ? path.resolve(source, expandClion(run.boardScript, source, environment)) : undefined;
  const scriptText = script ? await readConfig(script) : undefined;
  if (script && scriptText === undefined) throw new Error(t('找不到 OpenOCD 配置脚本：{0}', script));
  const board = scriptText !== undefined ? boardSettings(scriptText) : {};
  const selectionSignature = await signature(selection.inputFiles);
  const cached = await cachedToolPaths(source, selection.binaryDirectory);
  const hints: Partial<Record<ToolId, string>> = {
    armGnu: cached.CMAKE_C_COMPILER ?? chain?.toolchain.compiler,
    cmake: chain?.toolchain.cmake,
    ninja: chain?.toolchain.buildTool ?? cached.CMAKE_MAKE_PROGRAM,
    openocd: run ? (chain?.installation.openocd ?? installations.find(item => item.openocd)?.openocd) : undefined
  };
  // A native MinGW compiler is not an Arm compiler; CMake toolchain files may select Arm independently.
  if (hints.armGnu && !/(?:^|[\\/])arm-none-eabi-gcc(?:\.exe)?$/i.test(hints.armGnu)) hints.armGnu = undefined;
  if (hints.ninja && !/(?:^|[\\/])ninja(?:\.exe)?$/i.test(hints.ninja)) throw new Error(t('CLion 构建工具不是 Ninja；请先选择兼容的 Ninja Profile'));
  const candidates: { id: ToolId; directory: string; executable: string }[] = [];
  for (const id of (run ? ['armGnu','cmake','ninja','openocd'] : ['armGnu','cmake','ninja']) as ToolId[]) {
    let file = hints[id] ? expandClion(hints[id]!, source, environment) : undefined;
    if (!file) file = selectedTools.find(tool => tool.id === id)?.executables[id === 'armGnu' ? 'gcc' : id];
    if (!file && id === 'cmake' && await existingFile(cached.CMAKE_COMMAND)) file = cached.CMAKE_COMMAND;
    if (!file) {
      const dirs = await findCandidates(id); const basename = id === 'armGnu' ? 'arm-none-eabi-gcc.exe' : `${id}.exe`;
      if (dirs.length) file = path.join(dirs[0], basename);
    }
    let directory = await existingFile(file) ? path.dirname(file!) : undefined;
    if (!directory) directory = (await vscode.window.showOpenDialog({ title: t('选择 {0} 的安装目录或 bin 目录（CLion 路径缺失或失效）', toolNames[id]),
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false }))?.[0]?.fsPath;
    if (!directory) return;
    candidates.push({ id, directory, executable: file ?? directory });
  }
  const watched = [...data.files, ...selection.inputFiles, ...chain?.installation.files ?? [], ...(script ? [script] : [])];
  const before = await signature(watched);
  if (await signature(originalFiles) !== originalSignature || await signature(selection.inputFiles) !== selectionSignature
    || script && await readConfig(script) !== scriptText) throw new Error(t('CLion 配置在预览后发生变化，请重新导入'));
  const summary = [
    t('构建方案：{0}', selection.configurePreset), t('构建目录：{0}', selection.binaryDirectory),
    t('CMake 参数：{0}', selection.configureArgs?.slice(4).map(arg => JSON.stringify(arg)).join(' ') || `--preset ${selection.configurePreset}`),
    ...candidates.map(tool => `${toolNames[tool.id]}: ${tool.directory}`),
    ...(run ? [t('OpenOCD 配置：{0}', script), t('固件目标：{0}', run.target ?? t('配置后识别 / 选择固件目标')),
      t('探针：{0}；SWD：{1} kHz；序列号：{2}', probeLabel(board.probe ?? defaults.probe ?? 'cmsis-dap'), board.speedKHz ?? defaults.speedKHz, board.serial ?? '—'),
      t('沿用原脚本的芯片和复位设置；仍先编译、完整烧录并校验，调试端口由插件分配。')] : [t('未找到 OpenOCD 运行配置，保留当前烧录设置。')]),
    t('工具选择对本机工程共享。确认后仅检查工具，不连接硬件；导入后需重新核对芯片。')
  ].join('\n');
  if (!await vscode.window.showInformationMessage(t('导入 CLion 配置'), { modal: true, detail: summary }, t('导入并检查工具'))) return;
  const settings = { ...project.settings, configurePreset: selection.configurePreset, buildPreset, targetId: undefined, configuration: undefined, preferredTarget: run?.target,
    ...(script ? { targetScript: script, scriptKind: 'board' as const, chipConfirmed: false, backend: board.backend ?? defaults.backend,
      probe: board.probe ?? defaults.probe, speedKHz: board.speedKHz ?? defaults.speedKHz, serial: board.serial } : {}) };
  const checks = new Map<ToolId, CheckResult[]>();
  await controller.importSettings(settings, project.revision, tools, async signal => {
    guard();
    if (await signature(watched) !== before) throw new Error(t('CLion 配置在预览后发生变化，请重新导入'));
    const installations: ToolInstallation[] = [];
    for (const item of candidates) {
      if (signal.aborted) throw new BuildCancelled();
      installations.push(await validateExistingTool(item.id, item.directory, signal, results => checks.set(item.id, results)));
    }
    if (await signature(watched) !== before) throw new Error(t('CLion 配置在检查期间发生变化，请重新导入'));
    return installations;
  });
  for (const [id, results] of checks) tools.results.set(id, results);
  tools.refresh();
  void vscode.window.showInformationMessage(t('CLion 配置已导入；请重新配置 CMake，并核对烧录设置'));
}
