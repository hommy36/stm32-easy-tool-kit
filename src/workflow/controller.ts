import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolInstallation, errorText } from '../core/types';
import { ToolState } from '../tools/state';
import { Lease, acquireOperationLock } from '../core/operationLock';
import { BuildCancelled, BuildService, ProcessTreeUncertain } from '../build/service';
import { BuildModel } from '../build/fileApi';
import { PresetMetadata } from '../build/presets';
import { optimizationLevel } from '../build/optimization';
import { readFeatures, saveFeatures } from '../project/features';
import { inputInventory } from '../build/inventory';
import { BuildEvidence, InputScope, assertEvidenceCurrent, collectInputFiles, fingerprintInputs, fingerprintTools, inspectArmElf, isWithin } from '../build/artifacts';
import { DebugProbe, ProjectSettings, SavedProject, debugProbes, defaultProjectSettings, probeLabel, probeOf, projectKeyUri, validateProjectSettings } from '../project/types';
import { ProjectStore } from '../project/store';
import { isCmakeProject, readChipSuggestion } from '../project/discover';
import { detectChipTargets } from '../project/targetDetection';
import { BuildBackend, HardwareWorkflow, OwnedDebugSession, Phase, WorkbenchView, WorkflowAction, WorkflowHost, WorkflowSnapshot } from './types';

interface Configured { signature: string; cmakeFingerprint: string; model: BuildModel; }
interface ActiveDebug { id: string; session: OwnedDebugSession; leases: Lease[]; stopped: boolean; cleanup: Promise<void>; }
const sameDirectory = (left: string, right: string): boolean => process.platform === 'win32'
  ? path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);

export class WorkflowController {
  private snapshot: WorkflowSnapshot = { phase: 'idle', message: t("请选择已有 STM32 CMake 工程"), revision: 0 };
  private readonly listeners = new Set<(value: WorkflowSnapshot) => unknown>();
  readonly onDidChange = (listener: (value: WorkflowSnapshot) => unknown): { dispose(): void } => {
    this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } };
  };
  private activeUri?: string;
  private running?: Promise<void>;
  private editing = false;
  private abort?: AbortController;
  private activeDebug?: ActiveDebug;
  private stopping?: Promise<void>;
  private readonly metadata = new Map<string, PresetMetadata>();
  private readonly metadataSources = new Map<string, string>();
  private readonly configured = new Map<string, Configured>();
  private readonly approvals = new Map<string, Set<string>>();
  private readonly presetLoads = new Map<string, Promise<PresetMetadata>>();
  constructor(private readonly store: ProjectStore, private readonly toolSource: { list(): Promise<ToolInstallation[]>; readonly isBusy?: boolean },
    private readonly host: WorkflowHost, private readonly hardware: HardwareWorkflow, private readonly lockDirectory: string,
    private readonly buildFactory: (tools: ToolInstallation[]) => BuildBackend = tools => new BuildService(tools, host.log.bind(host), host.guard.bind(host)),
    initialProjectUri?: string) { this.activeUri = initialProjectUri; }

  getSnapshot(): WorkflowSnapshot { return { ...this.snapshot }; }
  async connectOwned(start: (settings: ProjectSettings, tools: ToolInstallation[], signal: AbortSignal, id: string) => Promise<OwnedDebugSession>): Promise<void> {
    this.assertEditable(); this.host.guard();
    const uri = await this.ensureProjectUri(); this.assertEditable();
    const abort = new AbortController(), id = randomUUID(); this.abort = abort;
    const leases: Lease[] = [];
    const task = (async () => {
      try {
        const project = await this.project(uri);
        leases.push(await acquireOperationLock(this.lockDirectory, `hardware:${probeOf(project.settings)}`));
        this.host.guard(); abort.signal.throwIfAborted();
        const session = await start(project.settings, await this.toolSource.list(), abort.signal, id);
        if (abort.signal.aborted) { await session.stop(); throw new BuildCancelled(); }
        let active: ActiveDebug;
        const cleanup = session.finished.then(() => this.finishDebug(active), error => this.finishDebug(active, error));
        active = { id, session, leases, stopped: false, cleanup }; this.activeDebug = active;
        this.publish('debugging', 'Connected to existing firmware. No build or download performed.');
        void cleanup.catch(error => { this.publish('uncertain', errorText(error)); });
      } catch (error) {
        if (error instanceof ProcessTreeUncertain) this.publish('uncertain', error.message);
        else { for (const lease of leases.reverse()) await lease.release(); this.publish(abort.signal.aborted ? 'cancelled' : 'failed', errorText(error)); }
        throw error;
      }
    })();
    this.running = task; this.publish('debug-starting', 'Connecting to existing firmware.', { operationId: id, projectUri: uri });
    try { await task; } finally { if (this.running === task) this.running = undefined; if (!this.activeDebug) this.abort = undefined; this.publish(this.snapshot.phase, this.snapshot.message); }
  }
  refreshProjectSettings(): void { this.publish(this.snapshot.phase, this.snapshot.message); }
  async editFeatureFiles<T>(operation: () => Promise<T>): Promise<T> {
    this.assertEditable(); this.host.guard(); this.editing = true;
    this.publish(this.snapshot.phase, this.snapshot.message);
    try { return await operation(); }
    finally { this.editing = false; this.publish(this.snapshot.phase, this.snapshot.message); }
  }
  get isWorkflowBusy(): boolean { return this.editing || !!this.running || !!this.activeDebug || this.snapshot.phase === 'uncertain'; }
  get isBusy(): boolean { return !!this.toolSource.isBusy || this.isWorkflowBusy; }
  private publish(phase: Phase, message: string, extra: Partial<WorkflowSnapshot> = {}): void {
    this.snapshot = { ...this.snapshot, ...extra, phase, message, revision: this.snapshot.revision + 1 };
    for (const listener of this.listeners) {
      try { listener(this.getSnapshot()); } catch (error) { this.host.log('stderr', t("界面刷新失败: {0}\n", errorText(error))); }
    }
  }
  async activeProject(): Promise<SavedProject | undefined> {
    const projects = this.host.projects();
    let uri = this.activeUri ? projects.find(project => projectKeyUri(project.uri) === projectKeyUri(this.activeUri!))?.uri : undefined;
    if (!uri) uri = projects.length === 1 ? projects[0].uri : undefined;
    if (!uri) return undefined;
    if (this.activeUri !== uri) { this.activeUri = uri; await this.host.rememberProject(uri); }
    return this.project(uri);
  }
  async view(): Promise<WorkbenchView> {
    const project = await this.activeProject();
    const configured = project ? this.configured.get(project.settings.projectUri) : undefined;
    const identity = configured ? JSON.parse(configured.signature) as unknown[] : undefined;
    const currentModel = project && identity && typeof identity[0] === 'string' && sameDirectory(identity[0], project.settings.sourceDirectory)
      && identity[1] === project.settings.configurePreset && (identity[2] ?? undefined) === project.settings.buildPreset ? configured?.model : undefined;
    const metadataSource = project && this.metadataSources.get(project.settings.projectUri);
    return { project, metadata: project && metadataSource && sameDirectory(metadataSource, project.settings.sourceDirectory) ? this.metadata.get(project.settings.projectUri) : undefined,
      model: currentModel, snapshot: this.getSnapshot() };
  }
  async selectProject(uri?: string): Promise<void> {
    this.assertEditable();
    const projects = this.host.projects();
    const choice = uri ?? (projects.length === 1 ? projects[0].uri : await this.host.chooseProject(projects));
    if (!choice) return;
    const selected = await this.project(choice);
    this.activeUri = selected.settings.projectUri;
    await this.host.rememberProject(this.activeUri);
    this.publish('idle', t("已选择工程"), { projectUri: this.activeUri, evidence: undefined });
  }
  async ensureProjectUri(): Promise<string> {
    let project = await this.activeProject();
    if (!project) { await this.selectProject(); project = await this.activeProject(); }
    if (!project) throw new BuildCancelled();
    return project.settings.projectUri;
  }
  private busyReason(): string | undefined {
    if (this.toolSource.isBusy) return t('工具安装或检查尚未结束');
    if (this.editing) return t('设置正在保存');
    if (this.activeDebug) return t('调试会话尚未结束');
    if (this.running) return t('当前构建或烧录尚未结束');
    if (this.snapshot.phase === 'uncertain') return t('上次操作状态不确定');
    return undefined;
  }
  private assertEditable(): void {
    const reason = this.busyReason();
    if (reason) throw new Error(t('已有操作或调试正在进行：{0}', reason));
  }
  private async project(uri: string): Promise<SavedProject> {
    const entry = this.host.projects().find(project => projectKeyUri(project.uri) === projectKeyUri(uri));
    if (!entry) throw new Error(t("工程不属于当前工作区，请明确选择工作区文件夹"));
    const stored = await this.store.read(uri);
    if (stored) {
      if (!isWithin(await fs.realpath(entry.directory), await fs.realpath(stored.settings.sourceDirectory))) throw new Error(t("保存的源码目录已不属于当前工作区文件夹"));
      // VS Code may lowercase / URI-encode a drive letter after restart. Keep
      // the persisted identity compatible while using the active folder URI.
      return { ...stored, settings: await this.suggestTarget({ ...stored.settings, projectUri: entry.uri }) };
    }
    const settings = defaultProjectSettings(entry.uri, entry.directory);
    const suggestion = await readChipSuggestion(entry.directory);
    if (suggestion) settings.chipLabel = suggestion.label;
    return { revision: 0, settings: await this.suggestTarget(settings) };
  }
  private async suggestTarget(settings: ProjectSettings): Promise<ProjectSettings> {
    if (settings.targetScript) return settings;
    const scripts = (await this.toolSource.list()).find(tool => tool.id === 'openocd')?.scriptsDirectory;
    if (!scripts) return settings;
    const candidates = await detectChipTargets(settings.sourceDirectory, scripts);
    if (candidates.length !== 1) return settings;
    return candidates[0].available ? { ...settings, chipLabel: candidates[0].label, targetScript: candidates[0].targetScript, scriptKind: undefined, chipConfirmed: false }
      : { ...settings, chipLabel: candidates[0].label };
  }
  async saveSettings(value: ProjectSettings, expectedRevision: number): Promise<SavedProject> {
    this.assertEditable();
    this.editing = true;
    try {
      this.host.guard();
      const settings = validateProjectSettings(value);
      const current = await this.project(settings.projectUri);
      const entry = this.host.projects().find(project => project.uri === settings.projectUri)!;
      if (!isWithin(await fs.realpath(entry.directory), await fs.realpath(settings.sourceDirectory))) throw new Error(t("源码目录必须位于所选工作区文件夹中"));
      const saved = await this.store.save(settings, expectedRevision);
      if (current.settings.configurePreset !== settings.configurePreset || current.settings.buildPreset !== settings.buildPreset || current.settings.sourceDirectory !== settings.sourceDirectory) this.configured.delete(settings.projectUri);
      if (current.settings.sourceDirectory !== settings.sourceDirectory) this.metadata.delete(settings.projectUri);
      this.publish('idle', t("工程设置已保存"), { projectUri: settings.projectUri, evidence: undefined });
      return saved;
    } finally {
      this.editing = false;
      this.publish(this.snapshot.phase, this.snapshot.message);
    }
  }
  async deleteSettings(uri: string, expectedRevision: number, revokeAuthorization: () => Promise<unknown>): Promise<void> {
    this.assertEditable();
    this.editing = true;
    try {
      this.host.guard();
      const current = await this.project(uri);
      if (current.revision !== expectedRevision) throw new Error(t('工程设置已被另一窗口更新，请重新加载后保存'));
      const entry = this.host.projects().find(project => projectKeyUri(project.uri) === projectKeyUri(uri))!;
      await revokeAuthorization();
      await this.store.remove(uri, entry.directory, expectedRevision);
      this.configured.delete(uri); this.metadata.delete(uri); this.metadataSources.delete(uri); this.approvals.delete(uri);
      this.publish('idle', t('工程配置已删除，请重新选择构建方案'), { projectUri: uri, evidence: undefined, operationId: undefined, lastFlash: undefined });
    } finally {
      this.editing = false;
      this.publish(this.snapshot.phase, this.snapshot.message);
    }
  }
  async loadChoices(uri?: string): Promise<PresetMetadata> {
    const projectUri = uri ?? await this.ensureProjectUri();
    const existing = this.presetLoads.get(projectUri);
    if (existing) return existing;
    const task = this.loadPresets(projectUri);
    this.presetLoads.set(projectUri, task);
    try { return await task; }
    finally { if (this.presetLoads.get(projectUri) === task) this.presetLoads.delete(projectUri); }
  }
  private async loadPresets(projectUri: string): Promise<PresetMetadata> {
    this.assertEditable();
    const controller = new AbortController();
    this.abort = controller;
    this.publish('configuring', t("正在读取已有构建方案（不配置工程）"), { projectUri });
    try {
      const project = await this.project(projectUri);
      this.host.guard();
      if (!await isCmakeProject(project.settings.sourceDirectory)) throw new Error(t("所选源码目录没有 CMakeLists.txt；请打开已有 CMake 工程"));
      const backend = this.buildFactory(await this.toolSource.list());
      const metadata = await backend.presets(project.settings.sourceDirectory, controller.signal,
        { allowExternal: file => this.approve(projectUri, file, 'Presets include') });
      this.host.guard();
      if (controller.signal.aborted) throw new BuildCancelled();
      const latest = await this.project(projectUri);
      if (latest.revision !== project.revision) return metadata;
      this.metadata.set(projectUri, metadata);
      this.metadataSources.set(projectUri, project.settings.sourceDirectory);
      this.publish('idle', t("已有构建方案已读取"));
      return metadata;
    } catch (error) { this.publish(error instanceof BuildCancelled ? 'cancelled' : 'failed', errorText(error)); throw error; }
    finally {
      if (this.abort === controller) this.abort = undefined;
      this.publish(this.snapshot.phase, this.snapshot.message);
    }
  }
  async importSettings(settings: ProjectSettings, expectedRevision: number, tools: ToolState,
    prepare: (signal: AbortSignal) => Promise<ToolInstallation[]>): Promise<SavedProject> {
    this.assertEditable(); this.editing = true;
    const abort = new AbortController(); this.abort = abort;
    this.publish('configuring', t('正在检查并导入 CLion 配置'), { projectUri: settings.projectUri, evidence: undefined });
    try {
      this.host.guard();
      validateProjectSettings(settings);
      const current = await this.project(settings.projectUri);
      const active = await this.activeProject();
      if (!active || projectKeyUri(active.settings.projectUri) !== projectKeyUri(settings.projectUri)) throw new Error(t('页面已过期或工程已切换，请刷新后重试'));
      if (current.revision !== expectedRevision || current.settings.sourceDirectory !== settings.sourceDirectory) throw new Error(t('工程设置已被另一窗口更新，请重新加载后保存'));
      return await tools.withSelections(() => prepare(abort.signal), async () => {
        this.host.guard();
        if (abort.signal.aborted) throw new BuildCancelled();
        const saved = await this.store.save(settings, expectedRevision);
        this.metadata.delete(settings.projectUri); this.configured.delete(settings.projectUri);
        this.publish('idle', t('CLion 配置已导入；请重新配置 CMake，并核对烧录设置'));
        return saved;
      });
    } catch (error) { const failure = abort.signal.aborted ? new BuildCancelled() : error; this.publish(abort.signal.aborted ? 'cancelled' : 'failed', errorText(failure)); throw failure; }
    finally { if (this.abort === abort) this.abort = undefined; this.editing = false; this.publish(this.snapshot.phase, this.snapshot.message); }
  }
  async selectOptimization(value: string, expectedRevision: string): Promise<void> {
    const level = optimizationLevel(value);
    await this.editFeatureFiles(async () => {
      const project = await this.activeProject();
      if (!project) throw new Error(t("请先选择构建方案"));
      const { settings } = await readFeatures(project.settings.sourceDirectory);
      await saveFeatures(project.settings.sourceDirectory, { ...settings, build: { ...settings.build, optimization: level } }, expectedRevision);
      this.configured.delete(project.settings.projectUri);
      this.publish('idle', t('优化等级已设为 {0}，下次编译时生效', level === 'default' ? t('默认（跟随构建方案）') : `-${level}`), { evidence: undefined });
    });
  }
  async selectConfigurePreset(selectedName?: string): Promise<void> {
    const uri = await this.ensureProjectUri();
    const metadata = await this.loadChoices(uri);
    const name = selectedName ?? await this.host.chooseConfigure(metadata.configure);
    if (!name) return;
    if (!metadata.configure.some(item => item.name === name)) throw new Error(t("构建方案已失效，请刷新方案列表"));
    const current = await this.project(uri);
    const compatible = metadata.compatibleBuilds(name);
    const build = compatible.find(item => item.name === name) ?? (compatible.length === 1 ? compatible[0] : undefined);
    await this.saveSettings({ ...current.settings, configurePreset: name, buildPreset: build?.name,
      targetId: undefined, configuration: undefined, preferredTarget: undefined }, current.revision);
  }
  async selectBuildPreset(): Promise<void> {
    const uri = await this.ensureProjectUri();
    const metadata = await this.loadChoices(uri);
    const current = await this.project(uri);
    if (!current.settings.configurePreset) throw new Error(t("请先选择构建方案"));
    const name = await this.host.chooseBuild(metadata.compatibleBuilds(current.settings.configurePreset));
    if (name === undefined) return;
    await this.saveSettings({ ...current.settings, buildPreset: name || undefined, targetId: undefined, configuration: undefined }, current.revision);
  }
  async selectProbe(value: string): Promise<void> {
    if (!debugProbes.includes(value as DebugProbe)) throw new Error(t('请选择有效的调试探针'));
    const probe = value as DebugProbe;
    this.assertEditable();
    this.editing = true;
    try {
      this.host.guard();
      const current = await this.activeProject();
      if (!current) throw new Error(t('请先选择工程'));
      if (probeOf(current.settings) === probe) return;
      await this.store.save({ ...current.settings, probe }, current.revision);
      this.publish('idle', t('调试探针已切换为 {0}', probeLabel(probe)), { projectUri: current.settings.projectUri });
    } finally {
      this.editing = false;
      this.publish(this.snapshot.phase, this.snapshot.message);
    }
  }
  async selectTarget(selectedId?: string, configuration?: string): Promise<void> {
    this.assertEditable();
    const uri = await this.ensureProjectUri();
    if (!(await this.view()).model) await this.run('configure', uri);
    const current = await this.project(uri);
    const model = this.configured.get(uri)?.model;
    if (!model) throw new Error(t("请先成功配置工程"));
    const target = selectedId ? model.targets.find(item => item.id === selectedId && item.configuration === configuration) : await this.host.chooseTarget(model.targets);
    if (selectedId && !target) throw new Error(t("固件目标已失效，请重新配置 CMake"));
    if (!target) return;
    if (!model.targets.some(item => item.id === target.id && item.configuration === target.configuration)) throw new Error(t("目标选择已失效"));
    await this.saveSettings({ ...current.settings, targetId: target.id, configuration: target.configuration, preferredTarget: target.name }, current.revision);
  }
  run(action: WorkflowAction, projectUri: string): Promise<void> {
    const reason = this.busyReason();
    if (reason) return Promise.reject(new Error(t('已有操作或调试正在进行：{0}', reason)));
    const controller = new AbortController();
    const id = randomUUID();
    this.abort = controller;
    const operation = Promise.resolve().then(() => this.perform(action, projectUri, id, controller));
    this.running = operation;
    this.publish('saving', t("正在保存当前工程文档"), { operationId: id, projectUri, evidence: undefined });
    void operation.finally(() => {
      if (this.running === operation) this.running = undefined;
      if (!this.activeDebug && this.abort === controller) this.abort = undefined;
      this.publish(this.snapshot.phase, this.snapshot.message);
    }).catch(() => {});
    return operation;
  }
  private async perform(action: WorkflowAction, uri: string, id: string, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    const leases: Lease[] = [];
    let retained = false;
    let uncertain = false;
    const gate = () => { this.host.guard(); if (signal.aborted) throw new BuildCancelled(); };
    try {
      gate();
      let saved = await this.project(uri);
      if (!await isCmakeProject(saved.settings.sourceDirectory)) throw new Error(t("当前目录没有 CMakeLists.txt，请打开已有 CMake 工程"));
      await this.host.saveDocuments(saved.settings.sourceDirectory);
      gate();
      const persisted = await this.store.read(uri);
      if (saved.revision > 0 && saved.settings.targetScript && !persisted?.settings.targetScript) saved = await this.store.save(saved.settings, saved.revision);
      const tools = await this.toolSource.list();
      if (!tools.some(tool => tool.id === 'armGnu' && tool.executables.gcc)) throw new Error(t("请先选择或安装 Arm GNU 工具链"));
      const toolFingerprint = await fingerprintTools(tools);
      const backend = this.buildFactory(tools);
      const metadata = await backend.presets(saved.settings.sourceDirectory, signal, { allowExternal: file => this.approve(uri, file, 'Presets include') });
      this.metadata.set(uri, metadata);
      this.metadataSources.set(uri, saved.settings.sourceDirectory);
      gate();
      let configureName = saved.settings.configurePreset;
      if (!configureName || !metadata.configure.some(item => item.name === configureName)) {
        configureName = metadata.configure.find(item => item.name === 'Debug')?.name
          ?? metadata.configure.find(item => item.name === 'auto-debug')?.name
          ?? (metadata.configure.length === 1 ? metadata.configure[0].name : await this.host.chooseConfigure(metadata.configure));
      }
      if (!configureName) throw new BuildCancelled();
      const compatible = metadata.compatibleBuilds(configureName);
      const explicitDirect = saved.revision > 0 && saved.settings.configurePreset === configureName && saved.settings.buildPreset === undefined;
      const buildName = explicitDirect ? undefined : compatible.some(item => item.name === saved.settings.buildPreset) ? saved.settings.buildPreset
        : compatible.find(item => item.name === configureName)?.name ?? (compatible.length === 1 ? compatible[0].name : undefined);
      if (saved.settings.configurePreset !== configureName || saved.settings.buildPreset !== buildName || saved.revision === 0) {
        saved = await this.store.save({ ...saved.settings, configurePreset: configureName, buildPreset: buildName,
          targetId: saved.settings.configurePreset === configureName ? saved.settings.targetId : undefined,
          configuration: saved.settings.configurePreset === configureName ? saved.settings.configuration : undefined }, saved.revision);
      }
      const selection = { ...metadata.resolve(configureName, buildName) };
      const features = await readFeatures(selection.sourceDirectory);
      selection.optimization = features.settings.build?.optimization ?? 'default';
      selection.inputFiles = [...selection.inputFiles];
      const featuresFile = path.join(selection.sourceDirectory, '.vscode', 'stm32-easy.features.json');
      try { await fs.access(featuresFile); selection.inputFiles.push(featuresFile); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      gate();
      const binary = path.resolve(selection.binaryDirectory);
      if (!isWithin(saved.settings.sourceDirectory, binary) && !await this.approve(uri, binary, t("构建输出目录"))) throw new BuildCancelled();
      leases.push(await acquireOperationLock(this.lockDirectory, `build:${await this.canonicalDirectory(binary)}`));
      const signature = JSON.stringify([selection.sourceDirectory, selection.configurePreset, selection.buildPreset, selection.binaryDirectory,
        selection.configureArgs, selection.buildArgs, selection.configureArgs ? selection.configureEnvironment : undefined, toolFingerprint, selection.optimization, features.revision]);
      let cached = this.configured.get(uri);
      let fresh = action === 'configure' || !cached || cached.signature !== signature;
      if (!fresh && cached) {
        try { fresh = cached.cmakeFingerprint !== await fingerprintInputs([...cached.model.cmakeInputFiles, ...selection.inputFiles]); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') fresh = true; else throw error; }
      }
      if (fresh) {
        this.publish('configuring', t("正在配置工程"));
        this.configured.delete(uri);
        const model = await backend.configure(selection, signal);
        gate();
        await this.scope(uri, saved.settings.sourceDirectory, metadata, model, tools, selection.inputFiles);
        cached = { signature, model, cmakeFingerprint: await fingerprintInputs([...model.cmakeInputFiles, ...selection.inputFiles]) };
        this.configured.set(uri, cached);
      }
      if (!cached) throw new Error(t("没有可用的配置结果"));
      if ((await readFeatures(selection.sourceDirectory)).revision !== features.revision) throw new Error(t("工程配置已变化，请重新构建"));
      if (action === 'configure') {
        const targets = cached.model.targets.filter(item => !selection.configuration || item.configuration === selection.configuration);
        const preferred = targets.filter(target => target.name === saved.settings.preferredTarget);
        const automatic = targets.length === 1 ? targets[0] : preferred.length === 1 ? preferred[0] : undefined;
        if (automatic) {
          const target = automatic;
          if (saved.settings.targetId !== target.id || saved.settings.configuration !== target.configuration) {
            await this.store.save({ ...saved.settings, targetId: target.id, configuration: target.configuration, preferredTarget: target.name }, saved.revision);
          }
        }
        this.publish('idle', automatic ? t("配置完成，已选择固件目标") : t("配置完成，请选择固件目标")); return;
      }
      gate();
      let target = cached.model.targets.find(item => item.id === saved.settings.targetId
        && (saved.settings.configuration === undefined || item.configuration === saved.settings.configuration));
      const pool = cached.model.targets.filter(item => !selection.configuration || item.configuration === selection.configuration);
      const preferred = pool.filter(target => target.name === saved.settings.preferredTarget);
      if (!target || !pool.includes(target)) target = pool.length === 1 ? pool[0] : preferred.length === 1 ? preferred[0] : await this.host.chooseTarget(pool);
      if (!target || !pool.some(item => item.id === target!.id && item.configuration === target!.configuration)) throw new BuildCancelled();
      if (saved.settings.targetId !== target.id || saved.settings.configuration !== target.configuration) {
        saved = await this.store.save({ ...saved.settings, targetId: target.id, configuration: target.configuration, preferredTarget: target.name }, saved.revision);
      }
      const approveDependency = (file: string) => this.approve(uri, file, t("实际构建依赖"));
      let dependencyModel = cached.model;
      let dependencies = await backend.inputs(selection, target, signal, true, approveDependency);
      if (!dependencies.complete) {
        this.publish('building', t("正在首次编译 {0}，建立实际依赖清单", target.name));
        dependencyModel = await backend.build(selection, target, signal);
        gate();
        const warmedTarget = dependencyModel.targets.find(item => item.id === target!.id && item.configuration === target!.configuration);
        if (!warmedTarget) throw new Error(t("首次编译后目标身份改变，请重新配置"));
        target = warmedTarget;
        dependencies = await backend.inputs(selection, target, signal, false, approveDependency);
      }
      const inputScope = await this.scope(uri, saved.settings.sourceDirectory, metadata, dependencyModel, tools, [...selection.inputFiles, ...dependencies.files], dependencies.directories);
      this.publish('building', t("正在校验源码、头文件与实际依赖"));
      const beforeFiles = await collectInputFiles(inputScope, [...target.sourceFiles, ...dependencyModel.cmakeInputFiles, ...selection.inputFiles, ...dependencies.files]);
      await this.host.assertDocumentsCurrent({ inputScope, inputFiles: beforeFiles });
      const beforeInventory = (await inputInventory(inputScope)).fingerprint;
      const before = await fingerprintInputs(beforeFiles);
      gate();
      this.publish('building', t("正在编译 {0} ({1})", target.name, target.configuration || selection.configurePreset));
      const model = await backend.build(selection, target, signal);
      gate();
      const builtTarget = model.targets.find(item => item.id === target!.id && item.configuration === target!.configuration);
      if (!builtTarget) throw new Error(t("构建后目标身份改变，请重新配置"));
      const afterDependencies = await backend.inputs(selection, builtTarget, signal, false, approveDependency);
      this.publish('building', t("正在对比构建前后输入并校验固件证据"));
      const afterScope = await this.scope(uri, saved.settings.sourceDirectory, metadata, model, tools, [...selection.inputFiles, ...afterDependencies.files], afterDependencies.directories);
      const inputFiles = await collectInputFiles(afterScope, [...builtTarget.sourceFiles, ...model.cmakeInputFiles, ...selection.inputFiles, ...afterDependencies.files]);
      const inventoryFingerprint = (await inputInventory(afterScope)).fingerprint;
      const after = await fingerprintInputs(inputFiles);
      if (before !== after || beforeInventory !== inventoryFingerprint) throw new Error(t("源码/头文件/配置或实际依赖在编译期间发生变化，请重新构建，未执行硬件操作"));
      const valid: string[] = [];
      for (const artifact of builtTarget.artifacts) {
        try { await inspectArmElf(artifact); valid.push(artifact); }
        catch (error) { this.host.log('stderr', t("产物未被选作 ARM ELF: {0}: {1}\n", artifact, errorText(error))); }
      }
      const artifact = valid.length === 1 ? valid[0] : valid.length ? await this.host.chooseArtifact(valid) : undefined;
      if (!artifact || !valid.includes(artifact)) throw new Error(t("当前目标没有已确认的可执行 ARM ELF，未执行硬件操作"));
      const evidence: BuildEvidence = { projectUri: uri, configurePreset: selection.configurePreset, buildPreset: selection.buildPreset,
        targetId: target.id, configuration: target.configuration, binaryDirectory: binary, artifact,
        artifactSha256: (await inspectArmElf(artifact)).sha256, inputFiles, inputScope: afterScope,
        toolFingerprint, inputFingerprint: after, revision: saved.revision, inventoryFingerprint,
        dependencyVerified: afterDependencies.complete && !afterDependencies.hardwareIssue };
      this.configured.set(uri, { signature, model, cmakeFingerprint: await fingerprintInputs([...model.cmakeInputFiles, ...selection.inputFiles]) });
      if (action !== 'build' && afterDependencies.hardwareIssue) throw new Error(afterDependencies.hardwareIssue);
      const current = await this.project(uri);
      if (action === 'build') {
        if (current.revision !== evidence.revision || projectKeyUri(current.settings.projectUri) !== projectKeyUri(evidence.projectUri)
          || current.settings.configurePreset !== evidence.configurePreset || current.settings.buildPreset !== evidence.buildPreset
          || current.settings.targetId !== evidence.targetId) throw new Error(t("工程配置已变化，请重新构建"));
        await this.host.assertDocumentsCurrent(evidence);
      } else {
        await assertEvidenceCurrent(evidence, current, await this.toolSource.list());
        await this.host.assertDocumentsCurrent(evidence);
      }
      gate();
      if (action === 'build') { this.publish('idle', afterDependencies.hardwareIssue ? t("编译成功；{0}", afterDependencies.hardwareIssue) : t("编译成功"), { evidence }); return; }
      if (!saved.settings.targetScript) throw new Error(t('请先自动识别或选择芯片配置脚本'));
      leases.push(await acquireOperationLock(this.lockDirectory, `hardware:${probeOf(saved.settings)}`));
      this.publish('confirming', t("等待确认固件、目标与复位操作"), { evidence });
      if (!await this.host.confirmHardware(action, saved.settings, evidence)) throw new BuildCancelled();
      gate();
      await assertEvidenceCurrent(evidence, await this.project(uri), await this.toolSource.list());
      await this.host.assertDocumentsCurrent(evidence);
      gate();
      if (action === 'flash') {
        this.publish('flashing', t("正在烧录并校验；取消可能留下不完整固件"));
        await this.hardware.flash(evidence, { ...saved.settings, chipConfirmed: true }, tools, signal);
        gate();
        this.publish('idle', t("烧录并校验成功，目标已复位运行"), { evidence,
          lastFlash: { projectUri: uri, artifact, at: new Date().toISOString() } });
      } else {
        this.publish('debug-starting', t("正在启动调试并连接目标"));
        const session = await this.hardware.debug(evidence, { ...saved.settings, chipConfirmed: true }, tools, id, signal);
        try { gate(); }
        catch (error) { await session.stop(); await session.finished; throw error; }
        retained = true;
        let active: ActiveDebug;
        const cleanup = session.finished.then(() => this.finishDebug(active), error => this.finishDebug(active, error));
        active = { id, session, leases, stopped: false, cleanup };
        this.activeDebug = active;
        this.publish('debugging', t("调试会话已启动；连接/断点状态请查看原生调试界面"), { evidence });
        void cleanup.catch(error => {
          this.publish('uncertain', errorText(error)); this.host.log('stderr', `${errorText(error)}\n`);
        });
      }
    } catch (error) {
      uncertain = error instanceof ProcessTreeUncertain;
      this.publish(uncertain ? 'uncertain' : error instanceof BuildCancelled || signal.aborted ? 'cancelled' : 'failed', errorText(error), { evidence: undefined });
      this.host.log('stderr', `${errorText(error)}\n`);
      throw error;
    } finally {
      if (!retained && !uncertain) {
        try { for (const lease of [...leases].reverse()) await lease.release(); }
        catch (error) { this.publish('uncertain', t("无法安全释放操作锁: {0}", errorText(error))); throw error; }
      }
    }
  }
  private async finishDebug(active: ActiveDebug, error?: unknown): Promise<void> {
    if (this.activeDebug !== active) return;
    if (error instanceof ProcessTreeUncertain) { this.publish('uncertain', errorText(error)); return; }
    for (const lease of [...active.leases].reverse()) await lease.release();
    this.activeDebug = undefined;
    this.abort = undefined;
    this.publish(error ? 'failed' : active.stopped ? 'cancelled' : 'idle', error ? errorText(error) : t("调试已结束"));
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (this.activeDebug) {
        const active = this.activeDebug;
        active.stopped = true;
        await active.session.stop();
        await active.cleanup;
      } else {
        this.abort?.abort();
        if (this.running) { try { await this.running; } catch (error) { if (!(error instanceof BuildCancelled)) this.host.log('stderr', `${errorText(error)}\n`); } }
        if (!this.running && !this.editing && this.snapshot.phase === 'uncertain') {
          const locks = await fs.readdir(this.lockDirectory).catch(() => [] as string[]);
          if (!locks.length) this.publish('idle', t('已清除内存中的占用状态；未发现构建或硬件锁'));
        }
      }
    })();
    try { await this.stopping; } finally { this.stopping = undefined; }
  }
  private async approve(uri: string, file: string, kind: string): Promise<boolean> {
    const key = path.resolve(file).toLowerCase();
    const approvals = this.approvals.get(uri) ?? new Set<string>();
    this.approvals.set(uri, approvals);
    if (approvals.has(key)) return true;
    this.host.guard();
    if (!await this.host.confirmExternal(file, kind, uri)) return false;
    this.host.guard();
    approvals.add(key);
    return true;
  }
  private async canonicalDirectory(directory: string): Promise<string> {
    try { return await fs.realpath(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(directory);
      if (parent === directory) throw error;
      return path.join(await this.canonicalDirectory(parent), path.basename(directory));
    }
  }
  private async scope(uri: string, source: string, metadata: PresetMetadata, model: BuildModel, tools: ToolInstallation[], dependencies: string[] = [], dependencyDirectories: string[] = []): Promise<InputScope> {
    const roots = await Promise.all([source, ...tools.map(tool => path.basename(tool.root).toLowerCase() === 'bin' ? path.dirname(tool.root) : tool.root)].map(file => fs.realpath(file)));
    const includeDirectories = [...new Set([...model.targets.flatMap(target => target.includeDirectories), ...dependencyDirectories])];
    for (const file of [...model.cmakeInputFiles, ...includeDirectories, ...dependencies]) {
      let actual: string;
      try { actual = await fs.realpath(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (!roots.some(root => isWithin(root, actual))) {
        if (!await this.approve(uri, actual, t("外部构建输入/头文件目录"))) throw new BuildCancelled();
        try { roots.push((await fs.stat(actual)).isDirectory() ? actual : path.dirname(actual)); }
        catch { roots.push(path.dirname(actual)); }
      }
    }
    const binaryDirectories = [model.binaryDirectory];
    for (const item of metadata.configure) {
      try { binaryDirectories.push(metadata.resolve(item.name).binaryDirectory); }
      catch (error) { this.host.log('stderr', t("未解析其他配置的输出目录 {0}: {1}\n", item.name, errorText(error))); }
    }
    const scope: InputScope = { sourceDirectory: source, binaryDirectories: [...new Set(binaryDirectories)], includeDirectories, allowedExternalRoots: roots };
    scope.allowedExternalRoots = (await inputInventory(scope, file => this.approve(uri, file, t("符号链接输入目录")))).roots;
    const toolRoots = tools.map(tool => path.basename(tool.root).toLowerCase() === 'bin' ? path.dirname(tool.root) : tool.root);
    const external: string[] = [];
    for (const root of scope.allowedExternalRoots) {
      if (isWithin(source, root) || toolRoots.some(tool => isWithin(tool, root)) || binaryDirectories.some(directory => isWithin(directory, root))) continue;
      try { if (!(await fs.stat(root)).isDirectory()) continue; } catch { continue; }
      if (external.some(directory => isWithin(directory, root))) continue;
      for (let index = external.length - 1; index >= 0; index--) if (isWithin(root, external[index])) external.splice(index, 1);
      external.push(root);
      if (external.length >= 32) break;
    }
    if (external.length) await this.host.rememberExternalRoots?.(uri, external.sort());
    return scope;
  }
}
