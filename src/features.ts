import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { WorkflowController } from './workflow/controller';
import { ToolState } from './tools/state';
import { BuildDiagnostics } from './ui/buildDiagnostics';
import { MemoryAnalysisService, analysisKey } from './memory/service';
import { MemoryPanel } from './ui/memoryPanel';
import { RuntimeMonitorService } from './runtime/monitor';
import { RttConnection, capturePaused } from './runtime/bridge';
import { DebugSessionOwner, ensureCortexDebug, makeDebugConfiguration } from './debug/session';
import { DapRuntime, resolveDapConfiguration } from './dap/config';
import { OwnedGdbServer, startGdbServer } from './dap/server';
import { ProjectSettings } from './project/types';
import { FeatureSettings, readFeatures, saveFeatures } from './project/features';
import { ToolInstallation } from './core/types';
import { BuildEvidence, inspectArmElf, isWithin } from './build/artifacts';
import { setEnhancementSummary } from './ui/enhancementState';
import { featureText as f } from './ui/featureLocale';
import { openDiagnostics } from './ui/diagnosticPanel';
import { SerialPanel } from './ui/serialPanel';
import { applyMonitorSetup, applySamplingUpdate, detectMonitor, monitorDefaults, planMonitorSetup, planSamplingUpdate } from './runtime/setup';
import { getLanguage } from './i18n';

export class FeatureCoordinator {
  readonly memory: MemoryAnalysisService; readonly monitor = new RuntimeMonitorService();
  private panel: MemoryPanel; private serial: SerialPanel; private owner?: DebugSessionOwner; private rtt?: RttConnection; private binding = 0; private viewedIdentity=''; private summaryProject?:string;
  private subscriptions: {dispose():void}[] = []; private lastEvidence = ''; private operation?: string; private started = 0; private metricDone?: string; private disposed=false; private viewGeneration=0;
  private settingUp = false;
  constructor(private readonly context: vscode.ExtensionContext, private readonly controller: WorkflowController, private readonly tools: ToolState, private readonly diagnostics: BuildDiagnostics,
    private readonly guard:()=>void, private readonly runtime:(tools:ToolInstallation[],uri?:string)=>DapRuntime) {
    this.memory=new MemoryAnalysisService(path.join(context.globalStorageUri.fsPath,'memory-reports'));
    this.panel=new MemoryPanel(context,this.memory,this.monitor,async()=> (await controller.view()).project?.settings.sourceDirectory,name=>this.action(name),()=>this.contextToken(),()=>{if(!this.owner&&this.rtt)void controller.stop().catch(error=>this.monitor.setStatus('error',String(error)));});
    this.serial=new SerialPanel(context,guard);
    this.subscriptions.push(this.memory.onChange(()=>{ const report=this.memory.state.report; if(report){this.summaryProject=report.projectUri;setEnhancementSummary(report.projectUri,{memory:this.memory.state.phase==='ready'?report.regions.map(r=>({name:r.name,used:r.used,capacity:r.capacity})):undefined,analysis:this.memory.state.phase});controller.refreshProjectSettings();}else if(this.summaryProject){setEnhancementSummary(this.summaryProject,{memory:undefined,analysis:this.memory.state.phase});this.summaryProject=undefined;controller.refreshProjectSettings();} }));
    this.subscriptions.push(controller.onDidChange(snapshot=>{
      if(snapshot.operationId && snapshot.operationId!==this.operation){this.operation=snapshot.operationId;if(['saving','configuring','building'].includes(snapshot.phase)){this.started=Date.now();this.metricDone=undefined;this.lastEvidence='';this.memory.invalidate();}else this.metricDone=snapshot.operationId;}
      if(snapshot.projectUri && snapshot.operationId && this.metricDone!==snapshot.operationId && (snapshot.evidence || ['idle','failed','cancelled'].includes(snapshot.phase))){
        this.diagnostics.flush();this.metricDone=snapshot.operationId;setEnhancementSummary(snapshot.projectUri,{elapsedMs:Date.now()-this.started,...diagnostics.counts()});
      }
      void this.changed().catch(error=>this.monitor.setStatus('error',String(error)));
    }));
    const register=(name:string,callback:()=>Promise<void>|void)=>this.subscriptions.push(vscode.commands.registerCommand(`stm32Easy.workbench.${name}`,async()=>{try{this.guard();await callback();}catch(error){void vscode.window.showErrorMessage(f(error instanceof Error?error.message:String(error)));}}));
    register('memory',()=>this.panel.open());register('analyzeMemory',()=>this.analyze());register('runtime',()=>this.action('monitor'));register('monitorSetup',()=>this.setupMonitor());register('snapshot',()=>this.action('snapshot'));
    register('features',()=>this.configureFeatures());register('diagnostics',()=>openDiagnostics(context,controller,tools,guard));register('serial',()=>this.serial.open());
    register('attach',()=>this.attach(false));register('probeCheck',()=>this.probeCheck());register('artifacts',async()=>{const evidence=controller.getSnapshot().evidence;if(!evidence)throw new Error('Build the active target first.');await vscode.commands.executeCommand('revealFileInOS',vscode.Uri.file(evidence.artifact));});
    register('debugControl',async()=>{const session=this.owner?.ownedSession;if(!session)throw new Error('No owned debug session.');const choice=await vscode.window.showQuickPick(['Pause','Continue','Reset']);if(!choice)return;const threads=await session.customRequest('threads');const threadId=threads?.threads?.[0]?.id;if(!threadId)throw new Error('No target thread.');if(choice==='Reset')await session.customRequest('restart',{});else await session.customRequest(choice==='Pause'?'pause':'continue',{threadId});});
    this.watchCubeMx();
    const featuresWatcher=vscode.workspace.createFileSystemWatcher('**/.vscode/stm32-easy.features.json');
    const featureChanged=(uri:vscode.Uri)=>{void (async()=>{const source=(await controller.view()).project?.settings.sourceDirectory;if(!source||!isWithin(source,uri.fsPath))return;this.lastEvidence='';this.memory.invalidate(true);if(this.rtt)await controller.stop();await this.changed();})().catch(error=>this.monitor.setStatus('error',String(error)));};
    this.subscriptions.push(featuresWatcher,featuresWatcher.onDidChange(featureChanged),featuresWatcher.onDidDelete(featureChanged),featuresWatcher.onDidCreate(featureChanged));
  }
  private async changed():Promise<void>{
    const generation=++this.viewGeneration,view=await this.controller.view();if(this.disposed||generation!==this.viewGeneration)return;
    const settings=view.project?.settings,evidence=view.snapshot.evidence;
    const identity=JSON.stringify([settings?.projectUri,settings?.configurePreset,settings?.buildPreset,settings?.configuration,settings?.targetId]);
    if(identity!==this.viewedIdentity){this.viewedIdentity=identity;this.lastEvidence='';this.memory.invalidate(true);if(!this.owner&&!this.rtt){this.monitor.reset();this.monitor.setStatus('disconnected');}}
    const current=evidence&&settings&&evidence.projectUri===settings.projectUri&&evidence.configurePreset===settings.configurePreset&&evidence.buildPreset===settings.buildPreset&&evidence.configuration===settings.configuration&&evidence.targetId===settings.targetId&&evidence.revision===view.project?.revision;
    if(!current){if(this.memory.state.phase!=='empty'){this.lastEvidence='';this.memory.invalidate(true);}return;}
    const token=`${analysisKey(evidence)}:${evidence.artifactSha256}`;
    if(token===this.lastEvidence)return;const target=view.model?.targets.find(item=>item.id===evidence.targetId&&item.configuration===evidence.configuration);if(!target)return;
    const tools = await this.tools.list();
    const feature = await readFeatures(settings.sourceDirectory).catch(error=>{this.monitor.setStatus('error',String(error));return {settings:{version:1} as FeatureSettings};});
    if (this.disposed || generation !== this.viewGeneration) return;
    this.lastEvidence=token;void this.memory.analyze(evidence,target,tools,feature.settings.memory?.budgets);
  }
  private async analyze():Promise<void>{this.guard();if(this.controller.isBusy)throw new Error('Wait until the current operation finishes.');this.lastEvidence='';await this.changed();if(this.memory.state.phase==='empty'||this.memory.state.phase==='stale')throw new Error('Build the active target before analysis.');}
  async debugOptions(settings:ProjectSettings):Promise<FeatureSettings>{
    const feature=(await readFeatures(settings.sourceDirectory)).settings;
    if(feature.runtime?.enabled && /^STM32H7/i.test(settings.chipLabel??'') && !feature.runtime.cacheCoherent)throw new Error('H7 RTT requires a verified non-cacheable buffer configuration; set runtime.cacheCoherent only after configuring it.');
    if (feature.runtime?.enabled && feature.runtime.autoDetect) {
      const evidence = await this.monitorEvidence(settings);
      const identity = await detectMonitor(evidence.artifact, evidence.artifactSha256, await this.tools.list(), AbortSignal.timeout(60000));
      if (!identity) throw new Error('Monitor component is absent from the current ELF. Run one-click monitor setup.');
      feature.runtime = {...feature.runtime, address: identity.address, firmwareId: identity.firmwareId ?? feature.runtime.firmwareId, searchBytes:48, channel:0};
    }
    return feature;
  }
  private async monitorEvidence(settings: ProjectSettings): Promise<BuildEvidence> {
    const view = await this.controller.view(), evidence = view.snapshot.evidence;
    if (!evidence || !view.project || view.project.settings.projectUri !== settings.projectUri || evidence.projectUri !== settings.projectUri ||
      evidence.targetId !== settings.targetId || evidence.configurePreset !== settings.configurePreset || evidence.buildPreset !== settings.buildPreset ||
      evidence.configuration !== settings.configuration || evidence.revision !== view.project.revision) throw new Error('Build the active target first.');
    return evidence;
  }
  async bind(owner:DebugSessionOwner|undefined,server:OwnedGdbServer,feature:FeatureSettings):Promise<void>{
    const binding=++this.binding;
    this.owner=owner;this.rtt?.dispose();this.rtt=undefined;
    if(owner){owner.onPaused=()=>{void capturePaused(owner,this.monitor,feature.debug).catch(error=>this.monitor.setStatus('error',String(error)));};owner.onContinued=()=>{if(!server.rtt)this.monitor.setStatus('connecting','Target running; paused snapshot retained.');};}
    void server.finished.then(()=>{if(binding===this.binding)this.unbind(owner);},()=>{if(binding===this.binding)this.unbind(owner);});
    if(server.rtt&&feature.runtime?.firmwareId){const connection=new RttConnection(server,this.monitor,feature.runtime.firmwareId);this.rtt=connection;try{await connection.start();}catch(error){connection.dispose();this.unbind(owner);throw error;}}
    else if(owner?.isPaused)void capturePaused(owner,this.monitor,feature.debug).catch(error=>this.monitor.setStatus('error',String(error)));
  }
  private unbind(owner?:DebugSessionOwner):void{if(this.owner===owner){this.owner=undefined;this.rtt?.dispose();this.rtt=undefined;this.monitor.setStatus('disconnected');}}
  private async attach(monitorOnly:boolean):Promise<void>{
    this.guard();
    if(this.owner||this.rtt){this.panel.open();if(monitorOnly&&!this.rtt)throw new Error('The active debug server has no RTT channel. Stop it, enable RTT, then reconnect.');return;}
    await this.controller.connectOwned(async(settings,tools,signal,id)=>{
      const feature=await this.debugOptions(settings);if(monitorOnly&&!feature.runtime?.enabled)throw new Error('Enable RTT in feature settings and install the optional firmware component first.');
      const expectedContext = await this.contextToken();
      const beforeStart = async()=>{this.guard();signal.throwIfAborted();if (await this.contextToken() !== expectedContext) throw new Error('Project or feature configuration changed. Connect again.');};
      const environment=this.runtime(tools,settings.projectUri);
      const configuration=await resolveDapConfiguration({...settings,chipConfirmed:true},signal,{...environment,approvedScript:undefined});
      environment.approvedScript={file:configuration.targetScript,sha256:configuration.targetSha256};
      const choice=await vscode.window.showWarningMessage(f('Connect to {0} using {1}? Script: {2} (SHA256 {3}). No download or reset commands are sent; custom scripts may change target state.',settings.chipLabel??settings.targetScript,settings.probe??'cmsis-dap',configuration.targetScript,configuration.targetSha256.slice(0,16)),{modal:true},f('Connect'));if(!choice)throw new Error('Connection cancelled.');
      let evidence:BuildEvidence|undefined;
      if(!monitorOnly){evidence=this.controller.getSnapshot().evidence;if(!evidence||evidence.projectUri!==settings.projectUri||evidence.targetId!==settings.targetId)throw new Error('Select an ELF by successfully building this target before attaching.');if((await inspectArmElf(evidence.artifact)).sha256!==evidence.artifactSha256)throw new Error('ELF changed; rebuild before attaching.');await ensureCortexDebug();}
      const server=await startGdbServer({...settings,chipConfirmed:true},signal,{...environment,beforeStart,mode:'attach',rtos:feature.debug?.rtos,rtt:feature.runtime?.enabled?{address:feature.runtime.address!,searchBytes:feature.runtime.searchBytes??256,channel:feature.runtime.channel??0}:undefined});
      let attached:DebugSessionOwner|undefined;
      try{
        if(monitorOnly){await this.bind(undefined,server,feature);this.panel.open();await this.waitForTelemetry(signal);return server;}
        const folder=vscode.workspace.workspaceFolders?.find(item=>item.uri.toString()===settings.projectUri);if(!folder)throw new Error('Project folder closed.');
        const owner=new DebugSessionOwner(server,signal,()=>{}),config=makeDebugConfiguration(evidence!,tools,server,settings,id);config.request='attach';delete config.runToEntryPoint;
        attached=owner;
        if(feature.debug?.svd)config.svdFile=await this.svdPath(settings.sourceDirectory,feature.debug.svd);
        await beforeStart();await owner.start(folder,config,beforeStart);await this.bind(owner,server,feature);return owner;
      }catch(error){if(attached)await attached.stop();else await server.stop();throw error;}
    });
  }
  async svdPath(source:string,file:string):Promise<string>{const actual=await fs.realpath(path.resolve(source,file));if(!isWithin(await fs.realpath(source),actual))throw new Error('SVD path escapes the project.');return actual;}
  private async contextToken():Promise<string>{const view=await this.controller.view();const settings=view.project?.settings;return JSON.stringify([settings?.projectUri,settings?.targetId,settings?.configurePreset,settings?.configuration,view.project?.revision,settings?(await readFeatures(settings.sourceDirectory)).revision:'']);}
  private async waitForTelemetry(signal:AbortSignal):Promise<void>{
    if(this.monitor.status==='live')return;
    await new Promise<void>((resolve,reject)=>{const done=(error?:Error)=>{clearTimeout(timer);this.monitor.events.off('change',changed);signal.removeEventListener('abort',abort);error?reject(error):resolve();};const changed=()=>{if(this.monitor.status==='live')done();else if(['error','disconnected'].includes(this.monitor.status))done(new Error(this.monitor.message||'RTT disconnected.'));};const abort=()=>done(new Error('Connection cancelled.'));const timer=setTimeout(()=>done(new Error('No matching RTT telemetry after 15 seconds. Verify firmware ID, initialization, address and memory accessibility.')),15000);this.monitor.events.on('change',changed);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();else changed();});
  }
  private async probeCheck():Promise<void>{
    await this.controller.connectOwned(async(settings,tools,signal)=>{
      const expectedContext=await this.contextToken();
      const environment=this.runtime(tools,settings.projectUri),configuration=await resolveDapConfiguration({...settings,chipConfirmed:true},signal,{...environment,approvedScript:undefined});
      environment.approvedScript={file:configuration.targetScript,sha256:configuration.targetSha256};
      const ok=await vscode.window.showWarningMessage(f('Test {0} with {1}? Script: {2} (SHA256 {3}). Custom scripts may change target state.',settings.chipLabel??settings.targetScript,settings.probe??'cmsis-dap',configuration.targetScript,configuration.targetSha256.slice(0,16)),{modal:true},f('Test connection'));if(!ok)throw new Error('Connection cancelled.');
      const server=await startGdbServer({...settings,chipConfirmed:true},signal,{...environment,mode:'attach',beforeStart:async()=>{this.guard();signal.throwIfAborted();if(await this.contextToken()!==expectedContext)throw new Error('Project changed. Repeat the connection test.');}});
      await server.stop();void vscode.window.showInformationMessage('OpenOCD initialized the configured target and exited. This does not verify flash or breakpoint behavior.');
      return {finished:Promise.resolve(),stop:async()=>{}};
    });
  }
  private async action(name:string):Promise<void>{
    this.guard();if(name==='refresh')return this.analyze();if(name==='cancel'){this.memory.cancel();return;}if(name==='stop')return this.controller.stop();
    if(name==='monitor')return this.attach(true);if(name==='monitorSetup')return this.setupMonitor();if(name==='sampling')return this.setupSampling();if(name==='snapshot'){if(!this.owner)throw new Error('Start or attach an owned debugger first.');const source=(await this.controller.view()).project?.settings.sourceDirectory;return capturePaused(this.owner,this.monitor,source?(await readFeatures(source)).settings.debug:undefined);}
    if(name==='features')return this.configureFeatures();if(name==='component')return this.exportComponent();
  }
  private async configureFeatures():Promise<void>{
    const source=(await this.controller.view()).project?.settings.sourceDirectory;if(!source)throw new Error('Select a project first.');if(this.controller.isBusy)throw new Error('Stop the active operation before changing features.');
    const current=await readFeatures(source);const file=vscode.Uri.file(path.join(source,'.vscode','stm32-easy.features.json'));
    if(!(await fs.stat(file.fsPath).catch(()=>undefined)))await saveFeatures(source,{version:1,memory:{budgets:{}},runtime:{enabled:false,searchBytes:256,channel:0},debug:{},tools:{}},current.revision);
    await vscode.window.showTextDocument(file);
  }
  private async setupMonitor():Promise<void>{
    this.guard();
    if(this.settingUp || this.controller.isBusy)throw new Error('Stop the active operation before configuring monitoring.');
    this.settingUp = true;
    try { await this.performMonitorSetup(); } finally { this.settingUp = false; }
  }
  private async performMonitorSetup(): Promise<void> {
    let view = await this.controller.view(), settings = view.project?.settings;
    if (!settings) throw new Error('Select a project first.');
    if (!view.snapshot.evidence) {
      await this.controller.run('build', settings.projectUri);
      view = await this.controller.view(); settings = view.project?.settings;
      if (!settings) throw new Error('Select a project first.');
    }
    const originalContext = await this.contextToken();
    const assertCurrent = async () => { this.guard(); if (this.disposed || await this.contextToken() !== originalContext) throw new Error('Project context changed. Reopen the memory panel.'); };
    await assertCurrent();
    let evidence = await this.monitorEvidence(settings);
    const identify = async () => vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:f('Detecting monitor settings from ELF…'),cancellable:true}, async (_progress, token) => {
      const abort = new AbortController(), subscription = token.onCancellationRequested(()=>abort.abort());
      try { if(token.isCancellationRequested)abort.abort(); return await detectMonitor(evidence.artifact,evidence.artifactSha256,await this.tools.list(),abort.signal); }
      finally { subscription.dispose(); }
    });
    let identity = await identify(); let integrated = false;
    if (!identity) {
      const target = (await this.controller.view()).model?.targets.find(item=>item.id===settings.targetId&&item.configuration===settings.configuration);
      if (!target) throw new Error('Build the active target first.');
      if (/^STM32H7/i.test(settings.chipLabel ?? '')) {
        await this.monitorGuide(); throw new Error('H7 automatic firmware integration requires manual buffer placement and MPU configuration. Follow the firmware guide, then run setup again.');
      }
      let plan;
      try { plan = await planMonitorSetup(settings.sourceDirectory,target,path.join(this.context.extensionUri.fsPath,'resources','firmware')); }
      catch(error) { await this.monitorGuide(); throw error; }
      const preview = [f('Monitor integration preview'), f('Changes are limited to CubeMX USER CODE blocks, the root CMake include and a new component directory.'),
        f('The FreeRTOS adapter reserves 512 stack words and fixed buffers. Bare-metal heap and stack bounds need application adapters. Boot IDs use SysTick by default; override with a persistent boot counter for reliable restart detection.'),
        ...plan.changes.map(change=>`\n--- ${path.relative(settings.sourceDirectory,change.file)} (${change.before===undefined?'new':'modified'})\n${change.after}`)].join('\n\n');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({content:preview,language:'plaintext'}),{preview:true});
      if (await vscode.window.showInformationMessage(f('Review the integration preview. Apply these files and build the current target?'),{modal:true},f('Apply and build')) !== f('Apply and build')) return;
      await this.controller.editFeatureFiles(async()=>{
        await assertCurrent();
        if (vscode.workspace.textDocuments.some(doc=>doc.isDirty&&plan.changes.some(change=>path.resolve(change.file).toLowerCase()===path.resolve(doc.uri.fsPath).toLowerCase()))) throw new Error('Save edited project files, then run monitor setup again.');
        await applyMonitorSetup(plan);
      });
      integrated = true;
      await this.controller.run('build', settings.projectUri);
      await assertCurrent(); evidence = await this.monitorEvidence(settings); identity = await identify();
      if (!identity) throw new Error('Monitor component is absent from the current ELF. Run one-click monitor setup.');
    }
    const current = await readFeatures(settings.sourceDirectory);
    if (/^STM32H7/i.test(settings.chipLabel ?? '') && !current.settings.runtime?.cacheCoherent) {
      await this.monitorGuide();
      throw new Error('H7 requires a verified non-cacheable RTT buffer and MPU configuration before monitoring can be enabled.');
    }
    let firmwareId = identity.firmwareId;
    if (!firmwareId) {
      firmwareId = await vscode.window.showInputBox({title:f('Firmware identity'),prompt:f('Legacy component: enter the exact firmware ID passed to stme_init (one time).'),value:current.settings.runtime?.firmwareId,
        validateInput:value=>/^[A-Za-z0-9_.-]{1,80}$/.test(value)?undefined:f('Use 1–80 letters, digits, dots, underscores or hyphens.')});
      if (firmwareId === undefined) return;
    }
    const saved = monitorDefaults(current.settings,{address:identity.address,firmwareId});
    await this.controller.editFeatureFiles(async()=>{await assertCurrent();if((await inspectArmElf(evidence.artifact)).sha256!==evidence.artifactSha256)throw new Error('ELF changed since analysis. Rebuild or refresh the report.');await saveFeatures(settings.sourceDirectory,saved,current.revision);});
    const message = integrated ? f('Monitor integration built and configured. Flash this new firmware using the usual Flash or Debug action, then connect.') : f('Monitoring is configured from the active ELF. Firmware ID: {0}, RTT address: 0x{1}.',firmwareId,identity.address.toString(16).toUpperCase());
    const answer = await vscode.window.showInformationMessage(message,...(integrated?[]:[f('Connect & monitor')]),f('Open settings'));
    if(answer===f('Connect & monitor'))await this.action('monitor');
    else if(answer===f('Open settings'))await this.configureFeatures();
  }
  private async monitorGuide(): Promise<void> {
    const name=getLanguage()==='zh-CN'?'README.zh-CN.md':'README.md';
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(this.context.extensionUri.fsPath,'resources','firmware',name)));
  }
  private async setupSampling(): Promise<void> {
    this.guard();
    if(this.controller.isBusy)throw new Error('Stop the monitor connection before changing firmware sampling.');
    if(this.settingUp)throw new Error('Wait until the current operation finishes.');
    this.settingUp=true;
    try { await this.performSamplingSetup(); } finally { this.settingUp=false; }
  }
  private async performSamplingSetup(): Promise<void> {
    const view=await this.controller.view(),settings=view.project?.settings;
    if(!settings)throw new Error('Select a project first.');
    const context=await this.contextToken();
    const target=view.model?.targets.find(item=>item.id===settings.targetId&&item.configuration===settings.configuration);
    if(!target)throw new Error('Build the active target first.');
    const current=await readFeatures(settings.sourceDirectory),selected=current.settings.runtime?.samplePeriodMs??1000;
    if(!current.settings.runtime?.enabled||current.settings.runtime.address===undefined||!current.settings.runtime.firmwareId)throw new Error('Run one-click monitor setup before changing the heap sampling rate.');
    const options=[1000,500,200,100].map(value=>({label:`${1000/value} Hz (${value} ms)`,description:value===selected?f('Current setting'):'',value:value as 100|200|500|1000}));
    const choice=await vscode.window.showQuickPick(options,{title:f('Heap sampling rate'),placeHolder:f('Firmware rebuild and flash required. Task stack details remain at 5 s.')});
    if(!choice)return;
    const change=await planSamplingUpdate(settings.sourceDirectory,target.name,choice.value);
    const preview=`${f('Heap sampling rate')}: ${1000/selected} Hz → ${1000/choice.value} Hz\n\n${path.relative(settings.sourceDirectory,change.file)}\n\n--- Before\n${change.before}\n--- After\n${change.after}\n\n${f('The firmware source setting changes here. The target must be rebuilt and flashed before the new rate is active. 100 ms may increase CPU load or dropped RTT frames.')}`;
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({content:preview,language:'plaintext'}),{preview:true});
    const confirm=f('Apply sampling rate and rebuild');
    if(await vscode.window.showWarningMessage(f('Apply this firmware sampling change and build? The currently running firmware remains unchanged until you flash the new image.'),{modal:true},confirm)!==confirm)return;
    const saved:FeatureSettings={...current.settings,version:1,runtime:{...current.settings.runtime,samplePeriodMs:choice.value}};
    await this.controller.editFeatureFiles(async()=>{
      this.guard();
      if(this.disposed||await this.contextToken()!==context)throw new Error('Project context changed. Reopen the memory panel.');
      if(vscode.workspace.textDocuments.some(doc=>doc.isDirty&&path.resolve(doc.uri.fsPath).toLowerCase()===path.resolve(change.file).toLowerCase()))throw new Error('Save edited project files, then run monitor setup again.');
      await applySamplingUpdate(settings.sourceDirectory,change);
      try{await saveFeatures(settings.sourceDirectory,saved,current.revision);}
      catch(error){await applySamplingUpdate(settings.sourceDirectory,{file:change.file,before:change.after,after:change.before!});throw error;}
    });
    await this.controller.run('build',settings.projectUri);
    void vscode.window.showInformationMessage(f('Build complete. Flash the new firmware to activate the {0} Hz heap sampling rate.',1000/choice.value));
  }
  private async exportComponent():Promise<void>{
    const folders=await vscode.window.showOpenDialog({canSelectFiles:false,canSelectFolders:true,canSelectMany:false,openLabel:f('Get firmware component')});if(!folders?.[0])return;
    const target=path.join(folders[0].fsPath,'stm32-easy-monitor');if(await fs.stat(target).catch(()=>undefined))throw new Error('stm32-easy-monitor already exists. Choose another directory.');
    await fs.cp(path.join(this.context.extensionUri.fsPath,'resources','firmware'),target,{recursive:true,errorOnExist:true,force:false});
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(target,getLanguage()==='zh-CN'?'README.zh-CN.md':'README.md')));
  }
  private watchCubeMx():void{
    const changed=new Set<string>();let timer:ReturnType<typeof setTimeout>|undefined,asking=false;
    const flush=async()=>{if(asking||this.controller.isBusy||!changed.size)return;const source=(await this.controller.view()).project?.settings.sourceDirectory;if(!source)return;const files=[...changed].filter(file=>isWithin(source,file));changed.clear();if(!files.length)return;asking=true;
      try{const answer=await vscode.window.showInformationMessage(`CubeMX / CMake inputs changed (${files.length}). Reconfigure to refresh targets and code completion?`,'Reconfigure','View changes');if(answer==='Reconfigure')await this.controller.run('configure',await this.controller.ensureProjectUri());else if(answer==='View changes'){const document=await vscode.workspace.openTextDocument({content:files.map(file=>path.relative(source,file)).join('\n'),language:'plaintext'});await vscode.window.showTextDocument(document);}}finally{asking=false;}};
    for(const pattern of ['**/*.ioc','**/cmake/stm32cubemx/CMakeLists.txt']){const watcher=vscode.workspace.createFileSystemWatcher(pattern);const add=(uri:vscode.Uri)=>{changed.add(uri.fsPath);if(timer)clearTimeout(timer);timer=setTimeout(()=>void flush(),1500);};this.subscriptions.push(watcher,watcher.onDidChange(add),watcher.onDidCreate(add));}
    this.subscriptions.push(this.controller.onDidChange(()=>{if(!this.controller.isBusy)void flush();}),{dispose:()=>{if(timer)clearTimeout(timer);}});
  }
  dispose():void{this.disposed=true;this.panel.dispose();this.serial.dispose();this.rtt?.dispose();this.memory.dispose();this.monitor.dispose();for(const subscription of this.subscriptions)subscription.dispose();}
}
