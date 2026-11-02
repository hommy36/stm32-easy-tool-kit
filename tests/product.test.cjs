require('../out/i18n').setLanguage('zh-CN');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { capabilities, cortexCompatible, repairForError } = require('../out/ui/presentation');
const { validateConsoleMessage } = require('../out/ui/consoleProtocol');
const { validateSettingsMessage } = require('../out/ui/settingsProtocol');
const { ToolState } = require('../out/tools/state');
const { ProjectStore } = require('../out/project/store');
const { defaultProjectSettings, authorizationFrom, authorizationMatches } = require('../out/project/types');
const { WorkflowController } = require('../out/workflow/controller');
const { BuildCancelled } = require('../out/build/service');
const baseSettings = { ...defaultProjectSettings('file:///D:/demo', 'D:\\demo'), configurePreset: 'Debug', configuration: 'Debug', targetId: 'fw', chipLabel: 'STM32F407', chipConfirmed: true, targetScript: 'target/stm32f4x.cfg' };
const tools = ['armGnu','cmake','ninja','openocd'].map(id => ({ id, available: true, checks: [] }));
const input = { settings: baseSettings, cmakeProject: true, tools, busy: false, trusted: true, supported: true, cortex: true };

test('compile-only setup does not require chip, OpenOCD or Cortex-Debug', () => {
  const result = capabilities({ ...input, settings: { ...baseSettings, chipConfirmed: false }, tools: tools.slice(0,3), cortex: false });
  assert.equal(result.build.enabled, true); assert.equal(result.flash.enabled, false); assert.equal(result.flash.repair,'tools');
});
for (const [label, patch] of [['no workspace',{settings:undefined}],['non-CMake',{cmakeProject:false}],['untrusted',{trusted:false}],['unsupported',{supported:false}],['operation busy',{busy:true}],['missing compiler',{tools:tools.slice(1)}]]) {
  test(`availability: ${label}`, () => { const result=capabilities({...input,...patch}); for(const value of Object.values(result)) assert.equal(value.enabled,false); });
}
test('debug dependency and path restriction do not block build or flash', () => {
  for(const patch of [{cortex:false},{artifact:'D:\\中文\\firmware.elf'}]) {
    const r=capabilities({...input,...patch}); assert.ok(r.build.enabled); assert.ok(r.flash.enabled); assert.equal(r.debug.enabled,false);
  }
});
test('Cortex-Debug version boundaries', () => {
  for(const value of ['1.12.1','1.13.0']) assert.ok(cortexCompatible(value));
  for(const value of ['1.12.0','2.0.0','bad',undefined]) assert.equal(cortexCompatible(value),false);
});
test('error recovery routes to useful destinations', () => {
  assert.equal(repairForError('编译失败'), 'problems'); assert.equal(repairForError('请先选择或安装 CMake'),'tools');
  assert.equal(repairForError('页面已过期，请重新加载设置'),'reload'); assert.equal(repairForError('请核对芯片'),'dap');
});
test('console messages reject injected commands and stale-shape context', () => {
  const msg={type:'action',action:'preset',projectUri:'file:///D:/demo',revision:1,snapshotRevision:2,value:'Debug'};
  assert.equal(validateConsoleMessage(msg).value,'Debug');
  assert.equal(validateConsoleMessage({...msg,action:'probe',value:'st-link'}).action,'probe');
  for(const patch of [{action:'workbench.action.terminal.sendSequence'},{revision:-1},{command:'shell'},{value:''}]) assert.throws(()=>validateConsoleMessage({...msg,...patch}));
});
test('settings protocol validates save-and-configure and per-tool actions', () => {
  const context={projectUri:baseSettings.projectUri,revision:1,snapshotRevision:2};
  assert.equal(validateSettingsMessage({type:'saveAndConfigure',...context,settings:baseSettings}).type,'saveAndConfigure');
  assert.equal(validateSettingsMessage({type:'toolAction',...context,tool:'cmake',action:'check'}).tool,'cmake');
  assert.throws(()=>validateSettingsMessage({type:'save',...context,settings:{...baseSettings,speedKHz:0}}));
  assert.throws(()=>validateSettingsMessage({type:'save',...context,settings:baseSettings,authorize:true}));
});
test('hardware authorization remains compatible and invalidates for all relevant changes', () => {
  const sha='a'.repeat(64), record=authorizationFrom(baseSettings,sha);
  assert.ok(authorizationMatches(baseSettings,record,sha));
  for(const patch of [{configurePreset:'Release'},{buildPreset:'Other'},{configuration:'Release'},{targetId:'fw2'},{chipLabel:'STM32F401'},{targetScript:'target/other.cfg'},{backend:'hid'},{speedKHz:4000},{serial:'B'},{stopAtMain:false},{chipConfirmed:false}]) assert.equal(authorizationMatches({...baseSettings,...patch},record,sha),false);
  assert.equal(authorizationMatches(baseSettings,record,'b'.repeat(64)),false);
});

test('debug probe switches immediately for the active project and rejects unknown values', async()=>{
  const f=await fixture();
  assert.equal((await f.controller.view()).project.settings.probe,'cmsis-dap');
  await f.controller.selectProbe('st-link');
  assert.equal((await f.store.read(f.uri)).settings.probe,'st-link');
  assert.equal(f.controller.getSnapshot().phase,'idle');
  await assert.rejects(f.controller.selectProbe('ftdi'),/请选择有效的调试探针/);
  assert.equal((await f.store.read(f.uri)).settings.probe,'st-link');
});

async function fixture() {
  await fs.mkdir(path.resolve('.cache'),{recursive:true});
  const root=await fs.mkdtemp(path.resolve('.cache/product-test-'));
  const source=path.join(root,'source'), binary=path.join(source,'build'), toolRoot=path.join(root,'tools');
  await Promise.all([source,binary,toolRoot].map(dir=>fs.mkdir(dir,{recursive:true})));
  const cmake=path.join(source,'CMakeLists.txt'), main=path.join(source,'main.c'), gcc=path.join(toolRoot,'gcc.exe');
  await fs.writeFile(cmake,'project(firmware C)'); await fs.writeFile(main,'int main(void){return 0;}'); await fs.writeFile(gcc,'test tool identity; never executed');
  const artifact=path.join(binary,'firmware.elf'); const elf=Buffer.alloc(52); elf.writeUInt32BE(0x7f454c46); elf[4]=1;elf[5]=1;elf[6]=1;elf.writeUInt16LE(2,16);elf.writeUInt16LE(40,18);await fs.writeFile(artifact,elf);
  const uri=pathToFileURL(source).toString(), store=new ProjectStore(path.join(root,'projects')), state=new ToolState(path.join(root,'active'));
  await state.select({id:'armGnu',root:toolRoot,version:'test',source:'external',executables:{gcc}});
  let projects=[{uri,directory:source,label:'firmware'}], remembered, flash=0, configured=0;
  const target={id:'firmware::id',name:'firmware',configuration:'Debug',artifacts:[artifact],sourceFiles:[main],includeDirectories:[]};
  const model={sourceDirectory:source,binaryDirectory:binary,targets:[target],cmakeInputFiles:[cmake],cache:new Map(),indexToken:'test'};
  const metadata={configure:[{name:'Debug',displayName:'Debug'},{name:'Release',displayName:'Release'}],builds:[],inputFiles:[cmake],compatibleBuilds:()=>[],resolve:(name,build)=>({sourceDirectory:source,binaryDirectory:binary,configurePreset:name,buildPreset:build,configuration:'Debug',inputFiles:[cmake]})};
  const backend={presets:async()=>metadata,configure:async()=>{configured++;return model;},build:async()=>model,inputs:async()=>({files:[main],directories:[],complete:true})};
  const host={guard(){},projects:()=>projects,saveDocuments:async()=>{},assertDocumentsCurrent:async()=>{},chooseProject:async()=>undefined,chooseConfigure:async()=> 'Debug',chooseBuild:async()=>'',chooseTarget:async()=>target,chooseArtifact:async files=>files[0],confirmExternal:async()=>true,confirmHardware:async()=>true,rememberProject:async value=>{remembered=value;},log(){}};
  const controller=new WorkflowController(store,state,host,{flash:async()=>{flash++;},debug:async()=>{throw Error('not used');}},path.join(root,'locks'),()=>backend);
  return {root,source,uri,store,state,controller,backend,model,target,host,main,setProjects:p=>{projects=p;},get remembered(){return remembered;},get flash(){return flash;},get configured(){return configured;}};
}
test('CLion import locks tools and build, and cancellation preserves all settings', async()=>{
  const f=await fixture();const saved=(await f.controller.view()).project;
  const oldTools=await f.state.list();let started;const ready=new Promise(resolve=>{started=resolve;});
  const operation=f.controller.importSettings({...saved.settings,configurePreset:'CLion:Debug'},saved.revision,f.state,signal=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new BuildCancelled()),{once:true});started();
  }));
  const rejected=assert.rejects(operation,BuildCancelled);await ready;
  assert.ok(f.state.isBusy);await assert.rejects(f.controller.run('build',f.uri));
  await assert.rejects(f.state.exclusive(async()=>{}));await f.controller.stop();await rejected;
  assert.deepEqual(await f.state.list(),oldTools);assert.equal((await f.controller.view()).project.revision,saved.revision);
  assert.equal(f.controller.getSnapshot().phase,'cancelled');assert.equal(f.controller.isBusy,false);
});

test('CLion import rolls tools back when another window saves during validation', async()=>{
  const f=await fixture();const saved=(await f.controller.view()).project,oldTools=await f.state.list();
  await assert.rejects(f.controller.importSettings({...saved.settings,configurePreset:'CLion:Debug'},saved.revision,f.state,async()=>{
    await f.store.save({...saved.settings,chipLabel:'updated elsewhere'},saved.revision);
    return oldTools.map(tool=>({...tool,version:'changed'}));
  }));
  assert.deepEqual(await f.state.list(),oldTools);assert.equal((await f.store.read(f.uri)).settings.chipLabel,'updated elsewhere');
});

test('imported firmware name selects only a matching File API target and is cleared on profile change',async()=>{
  const f=await fixture();const saved=(await f.controller.view()).project;
  f.model.targets.push({...f.target,id:'other',name:'other'});
  await f.controller.saveSettings({...saved.settings,preferredTarget:'other'},saved.revision);
  await f.controller.run('configure',f.uri);assert.equal((await f.store.read(f.uri)).settings.targetId,'other');
  await f.controller.selectConfigurePreset('Release');assert.equal((await f.store.read(f.uri)).settings.preferredTarget,undefined);
});

test('active project persists when external folders turn workspace into multi-root', async()=>{
  const f=await fixture();await f.controller.view();assert.equal(f.remembered,f.uri);
  f.setProjects([{uri:f.uri,directory:f.source,label:'firmware'},{uri:'file:///D:/external',directory:'D:\\external',label:'lib'}]);
  assert.equal((await f.controller.view()).project.settings.projectUri,f.uri);
});

test('shared configuration works for builds and changing it during a build blocks hardware',async()=>{
  const f=await fixture(),initial=(await f.controller.view()).project;
  await f.controller.saveSettings({...initial.settings,shareInProject:true,configurePreset:'Debug',targetScript:'target/stm32f4x.cfg',chipConfirmed:true},initial.revision);
  await f.controller.run('build',f.uri);assert.ok(f.controller.getSnapshot().evidence);
  f.backend.build=async()=>{
    const file=path.join(f.source,'.vscode/stm32-easy.json'),config=JSON.parse(await fs.readFile(file,'utf8'));config.configurePreset='Release';await fs.writeFile(file,JSON.stringify(config));return f.model;
  };
  await assert.rejects(f.controller.run('flash',f.uri),/变化|已被/);assert.equal(f.flash,0);
  assert.equal((await f.controller.view()).model,undefined);
});

test('no chip checkbox is required; cancelling the hardware dialog blocks execution',async()=>{
  const f=await fixture(),initial=(await f.controller.view()).project;
  await f.controller.saveSettings({...initial.settings,targetScript:'target/stm32f4x.cfg',chipConfirmed:false},initial.revision);
  let confirmations=0;f.host.confirmHardware=async()=>{confirmations++;return false;};
  await assert.rejects(f.controller.run('flash',f.uri),BuildCancelled);assert.equal(confirmations,1);assert.equal(f.flash,0);
  f.host.confirmHardware=async()=>{confirmations++;return true;};await f.controller.run('flash',f.uri);assert.equal(f.flash,1);assert.equal(confirmations,2);
  assert.equal((await f.store.read(f.uri)).settings.chipConfirmed,false);
  assert.equal(capabilities({...input,settings:{...baseSettings,chipConfirmed:false}}).flash.enabled,true);
});

test('a unique installed project target is suggested without overwriting an existing board script',async()=>{
  const f=await fixture(),scripts=path.join(f.root,'scripts');await fs.mkdir(path.join(scripts,'target'),{recursive:true});await fs.writeFile(path.join(scripts,'target/stm32h7x.cfg'),'');
  await fs.writeFile(path.join(f.source,'board.ioc'),'Mcu.CPN=STM32H723VGT6');
  await f.state.select({id:'openocd',root:f.root,executables:{openocd:path.join(f.root,'openocd.exe')},scriptsDirectory:scripts,version:'test',source:'external'});
  const suggested=(await f.controller.view()).project;assert.equal(suggested.settings.targetScript,'target/stm32h7x.cfg');
  await f.controller.saveSettings({...suggested.settings,targetScript:'board/custom.cfg',scriptKind:'board'},suggested.revision);
  assert.equal((await f.controller.view()).project.settings.targetScript,'board/custom.cfg');
});
test('multi-root workspace without selection does not guess the hardware project', async()=>{
  const f=await fixture();f.setProjects([{uri:f.uri,directory:f.source,label:'firmware'},{uri:'file:///D:/other',directory:'D:\\other',label:'other'}]);
  assert.equal((await f.controller.view()).project,undefined);
});
test('legacy drive-letter casing and URI encoding survive workspace reload',async()=>{
  const f=await fixture();await f.store.save(defaultProjectSettings(f.uri,f.source),0);
  const current=f.uri.replace(/^file:\/\/\/([A-Za-z]):/,(_match,drive)=>`file:///${drive.toLowerCase()}%3A`);
  f.setProjects([{uri:current,directory:f.source,label:'firmware'}]);
  assert.equal((await f.controller.view()).project.settings.projectUri,current);
  await f.controller.run('configure',await f.controller.ensureProjectUri());
  assert.ok((await f.store.read(current)).settings.targetId);
});
test('single target auto-selects on configure; changing build preset invalidates old model',async()=>{
  const f=await fixture();await f.controller.run('configure',f.uri);
  const saved=await f.store.read(f.uri);assert.equal(saved.settings.targetId,f.target.id);
  await f.controller.saveSettings({...saved.settings,buildPreset:'custom'},saved.revision);
  assert.equal((await f.controller.view()).model,undefined);
});
test('multiple targets require selection; preset change clears previous target',async()=>{
  const f=await fixture();f.model.targets.push({...f.target,id:'other',name:'other'});await f.controller.run('configure',f.uri);
  assert.equal((await f.store.read(f.uri)).settings.targetId,undefined);
  await f.controller.selectTarget(f.target.id,'Debug');await f.controller.selectConfigurePreset('Release');
  assert.equal((await f.store.read(f.uri)).settings.targetId,undefined);
});
test('tool operations block builds and reject overlapping tool changes',async()=>{
  const f=await fixture();let release;const done=new Promise(resolve=>{release=resolve;});
  const op=f.state.exclusive(()=>done);assert.ok(f.controller.isBusy);
  await assert.rejects(f.controller.run('build',f.uri),/已有操作/);
  await assert.rejects(f.state.exclusive(async()=>{}),/已有工具/);
  release();await op;assert.equal(f.controller.isBusy,false);
});
test('stale settings cannot overwrite another window; schema 1 remains valid',async()=>{
  const f=await fixture();const old=defaultProjectSettings(f.uri,f.source);const saved=await f.store.save({...old,setupComplete:true},0);
  await assert.rejects(f.store.save({...old,chipLabel:'other'},0),/另一窗口/);
  assert.deepEqual(await f.store.read(f.uri),saved);
});
test('compile-only workflow builds without OpenOCD and records current ELF',async()=>{
  const f=await fixture();await f.controller.run('build',f.uri);assert.equal(f.controller.getSnapshot().phase,'idle');assert.ok(f.controller.getSnapshot().evidence);assert.equal(f.flash,0);
});
test('failed build never flashes an old ELF and can retry',async()=>{
  const f=await fixture();await f.controller.run('build',f.uri);f.backend.build=async()=>{throw Error('编译失败');};
  await assert.rejects(f.controller.run('flash',f.uri),/编译失败/);assert.equal(f.flash,0);assert.equal(f.controller.getSnapshot().evidence,undefined);
  f.backend.build=async()=>f.model;await f.controller.run('build',f.uri);assert.equal(f.controller.getSnapshot().message,'编译成功');
});
test('stop cancels owned build and releases busy state, duplicate run rejected',async()=>{
  const f=await fixture();let started;const ready=new Promise(resolve=>{started=resolve;});
  f.backend.configure=async(_selection,signal)=>{started();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new BuildCancelled()),{once:true}));};
  const running=f.controller.run('flash',f.uri);const rejected=assert.rejects(running,/取消/);await ready;
  await assert.rejects(f.controller.run('build',f.uri),/已有操作/);await f.controller.stop();await rejected;
  assert.equal(f.flash,0);assert.equal(f.controller.isBusy,false);assert.equal(f.controller.getSnapshot().phase,'cancelled');
});


test('delete configuration clears cached targets and evidence, revokes approval, and rejects stale pages',async()=>{
  const f=await fixture();await f.controller.run('build',f.uri);const before=(await f.controller.view()).project;
  let revoked=0;await f.controller.deleteSettings(f.uri,before.revision,async()=>{revoked++;});
  const view=await f.controller.view();assert.equal(revoked,1);assert.equal(view.model,undefined);assert.equal(view.metadata,undefined);
  assert.equal(view.snapshot.evidence,undefined);assert.equal(view.project.settings.configurePreset,undefined);assert.equal(f.controller.isBusy,false);
  await assert.rejects(f.controller.deleteSettings(f.uri,before.revision,async()=>{revoked++;}));assert.equal(revoked,1);
  const context={projectUri:f.uri,revision:view.project.revision,snapshotRevision:view.snapshot.revision};
  assert.equal(validateSettingsMessage({type:'deleteSettings',...context}).type,'deleteSettings');
  assert.throws(()=>validateSettingsMessage({type:'deleteSettings',...context,path:'C:/arbitrary'}));
});

test('delete configuration cannot interrupt a build or race tool changes; failed revocation preserves settings',async()=>{
  const f=await fixture();await f.controller.run('build',f.uri);const before=(await f.controller.view()).project;
  await assert.rejects(f.controller.deleteSettings(f.uri,before.revision,async()=>{throw Error('revoke failure');}),/revoke failure/);
  assert.equal((await f.store.read(f.uri)).revision,before.revision);assert.equal(f.controller.isBusy,false);
  await f.state.exclusive(async()=>{await assert.rejects(f.controller.deleteSettings(f.uri,before.revision,async()=>{}));});
  let release,started;const ready=new Promise(resolve=>{started=resolve;});f.backend.build=async()=>{started();await new Promise(resolve=>{release=resolve;});return f.model;};
  const run=f.controller.run('build',f.uri);await ready;
  await assert.rejects(f.controller.deleteSettings(f.uri,before.revision,async()=>{}));release();await run;
});

test('Windows source path case does not hide configured targets or metadata',async()=>{
 if(process.platform!=='win32')return;
 const f=await fixture(),initial=(await f.controller.view()).project;
 const lower=f.source.toLowerCase();await f.controller.saveSettings({...initial.settings,sourceDirectory:lower,configurePreset:'Debug'},initial.revision);
 f.backend.presets=async()=>({configure:[{name:'Debug'}],builds:[],inputFiles:[path.join(f.source,'CMakeLists.txt')],compatibleBuilds:()=>[],resolve:()=>({sourceDirectory:f.source,binaryDirectory:path.join(f.source,'build'),configurePreset:'Debug',configuration:'Debug',inputFiles:[path.join(f.source,'CMakeLists.txt')]})});
 await f.controller.run('configure',f.uri);const view=await f.controller.view();assert.ok(view.model);assert.equal(view.model.targets[0].name,'firmware');assert.ok(view.metadata);
});
test('configuration without a Build Preset remains visible but a genuinely changed selection does not',async()=>{
 const f=await fixture();await f.controller.run('configure',f.uri);
 let view=await f.controller.view();assert.equal(view.project.settings.buildPreset,undefined);assert.ok(view.model);
 assert.equal(view.model.targets[0].id,f.target.id);
 await f.controller.saveSettings({...view.project.settings,configurePreset:'Release'},view.project.revision);
 assert.equal((await f.controller.view()).model,undefined);
});
