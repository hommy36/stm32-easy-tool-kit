const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {pathToFileURL}=require('node:url');
require('../out/i18n').setLanguage('en');
const {ProjectStore}=require('../out/project/store');
const {defaultProjectSettings}=require('../out/project/types');
const {parseShared,sharedPath}=require('../out/project/shared');
async function fixture(){
  const root=await fs.mkdtemp(path.resolve('.cache/share-test-')),project=path.join(root,'project');await fs.mkdir(project);
  const uri=pathToFileURL(project).toString(),store=new ProjectStore(path.join(root,'local'));
  return {root,project,uri,store,settings:{...defaultProjectSettings(uri,project),shareInProject:true,configurePreset:'Debug',preferredTarget:'firmware',chipLabel:'STM32F407',targetScript:'target/stm32f4x.cfg',chipConfirmed:true,serial:'LOCAL-PROBE',targetId:'local-id',configuration:'Debug'}};
}
test('project configuration is portable and excludes tools, local identity, serial and authorization',async()=>{
  const f=await fixture(),saved=await f.store.save(f.settings,0),text=await fs.readFile(sharedPath(f.uri),'utf8');
  const config=JSON.parse(text);assert.equal(config.sourceDirectory,'.');assert.equal(config.firmwareTarget,'firmware');
  for(const value of [f.root,'LOCAL-PROBE','local-id','chipConfirmed','projectUri','executables','artifactPath'])assert.equal(text.includes(value),false,value);
  assert.equal(saved.settings.chipConfirmed,true);assert.equal(saved.settings.serial,'LOCAL-PROBE');
  const other=new ProjectStore(path.join(f.root,'teammate'));
  const received=await other.read(f.uri);assert.equal(received.settings.configurePreset,'Debug');assert.equal(received.settings.shareInProject,true);
  assert.equal(received.settings.chipConfirmed,false);assert.equal(received.settings.serial,undefined);assert.equal(received.settings.targetId,undefined);
  assert.equal(received.settings.preferredTarget,'firmware');
});
test('normal saves update shared configuration, and disabling sharing keeps the file unchanged',async()=>{
  const f=await fixture(),saved=await f.store.save(f.settings,0);
  const next=await f.store.save({...saved.settings,speedKHz:4000},saved.revision);
  assert.equal(JSON.parse(await fs.readFile(sharedPath(f.uri),'utf8')).speedKHz,4000);
  const before=await fs.readFile(sharedPath(f.uri),'utf8');
  await f.store.save({...next.settings,shareInProject:false,speedKHz:8000},next.revision);
  assert.equal(await fs.readFile(sharedPath(f.uri),'utf8'),before);assert.equal((await f.store.read(f.uri)).settings.speedKHz,8000);
});
test('manual edits and another user saving invalidate old drafts and local chip confirmation',async()=>{
  const f=await fixture(),saved=await f.store.save(f.settings,0),file=sharedPath(f.uri);
  const config=JSON.parse(await fs.readFile(file,'utf8'));config.speedKHz=2500;await fs.writeFile(file,JSON.stringify(config));
  const changed=await f.store.read(f.uri);assert.notEqual(changed.revision,saved.revision);assert.equal(changed.settings.chipConfirmed,false);
  await assert.rejects(f.store.save({...saved.settings,speedKHz:5000},saved.revision),/updated/i);
  const teammate=new ProjectStore(path.join(f.root,'teammate')),their=await teammate.read(f.uri);
  await teammate.save({...their.settings,speedKHz:3000},their.revision);
  await assert.rejects(f.store.save(changed.settings,changed.revision),/updated/i);
  assert.equal((await f.store.read(f.uri)).settings.speedKHz,3000);
});
test('shared project and script paths relocate with a cloned project',async()=>{
  const f=await fixture();await fs.mkdir(path.join(f.project,'firmware'));await fs.mkdir(path.join(f.project,'openocd'));
  const script=path.join(f.project,'openocd/board.cfg');await fs.writeFile(script,'reset_config none');
  await f.store.save({...f.settings,sourceDirectory:path.join(f.project,'firmware'),targetScript:script,scriptKind:'board'},0);
  const clone=path.join(f.root,'clone');await fs.cp(f.project,clone,{recursive:true});
  const received=await new ProjectStore(path.join(f.root,'clone-local')).read(pathToFileURL(clone).toString());
  assert.equal(received.settings.sourceDirectory,path.join(clone,'firmware'));assert.equal(received.settings.targetScript,path.join(clone,'openocd/board.cfg'));
});
test('external standalone OpenOCD configuration is copied without changing its original',async()=>{
  const f=await fixture(),scripts=path.join(f.root,'scripts');await fs.mkdir(path.join(scripts,'target'),{recursive:true});await fs.mkdir(path.join(scripts,'interface'));
  await fs.writeFile(path.join(scripts,'target/stm32f4x.cfg'),'target');await fs.writeFile(path.join(scripts,'interface/cmsis-dap.cfg'),'interface');
  const external=path.join(f.root,'board.cfg'),content='source [find interface/cmsis-dap.cfg]\nsource [find target/stm32f4x.cfg]\nreset_config none\n';await fs.writeFile(external,content);
  const store=new ProjectStore(path.join(f.root,'local'),async()=>scripts);
  const saved=await store.save({...f.settings,targetScript:external,scriptKind:'board'},0);
  assert.equal(saved.settings.chipConfirmed,false);assert.ok(saved.settings.targetScript.startsWith(path.join(f.project,'.vscode','stm32-easy')));
  assert.equal(await fs.readFile(saved.settings.targetScript,'utf8'),content);assert.equal(await fs.readFile(external,'utf8'),content);
  assert.equal((await fs.readFile(sharedPath(f.uri),'utf8')).includes(f.root),false);
});
test('unsafe external script and unsupported shared fields fail without partial settings',async()=>{
  const f=await fixture(),external=path.join(f.root,'board.cfg');await fs.writeFile(external,'source C:/private/custom.cfg');
  await assert.rejects(f.store.save({...f.settings,targetScript:external},0),/local paths/i);
  assert.equal(await f.store.read(f.uri),undefined);await assert.rejects(fs.stat(sharedPath(f.uri)),{code:'ENOENT'});
  const base={version:1,sourceDirectory:'.',backend:'auto',speedKHz:1000,stopAtMain:true};
  for(const patch of [{tools:{}},{authorization:{}},{sourceDirectory:'../elsewhere'},{sourceDirectory:'C:/machine'},{targetScript:{base:'project',path:'../board.cfg'}}])assert.throws(()=>parseShared(JSON.stringify({...base,...patch}),f.uri));
});

test('local persistence failure rolls the shared file back atomically',async()=>{
  const f=await fixture(),saved=await f.store.save(f.settings,0),before=await fs.readFile(sharedPath(f.uri),'utf8');
  const original=fs.rename;fs.rename=async(source,target)=>{
    if(path.dirname(target)===path.join(f.root,'local'))throw Object.assign(Error('injected storage failure'),{code:'ENOSPC'});
    return original(source,target);
  };
  try{await assert.rejects(f.store.save({...saved.settings,speedKHz:4000},saved.revision),/storage failure/);}
  finally{fs.rename=original;}
  assert.equal(await fs.readFile(sharedPath(f.uri),'utf8'),before);assert.equal((await f.store.read(f.uri)).revision,saved.revision);
  await assert.rejects(fs.stat(sharedPath(f.uri)+'.lock'),{code:'ENOENT'});
});

test('existing shared write lock prevents simultaneous writes from a second local store',async()=>{
  const f=await fixture(),saved=await f.store.save(f.settings,0),before=await fs.readFile(sharedPath(f.uri),'utf8');
  await fs.writeFile(sharedPath(f.uri)+'.lock','another window');
  await assert.rejects(f.store.save({...saved.settings,speedKHz:4000},saved.revision),/Another window/);
  assert.equal(await fs.readFile(sharedPath(f.uri),'utf8'),before);
  assert.equal(await fs.readFile(sharedPath(f.uri)+'.lock','utf8'),'another window');
});


test('legacy root configuration migrates on save even when contents are identical',async()=>{
  const f=await fixture(),{portableConfiguration,legacySharedPath}=require('../out/project/shared');
  const legacy=legacySharedPath(f.uri),text=(await portableConfiguration(f.settings)).text;
  await fs.writeFile(legacy,text);
  const old=await f.store.read(f.uri);assert.equal(old.settings.configurePreset,'Debug');
  await f.store.save(old.settings,old.revision);
  assert.equal(await fs.readFile(sharedPath(f.uri),'utf8'),text);assert.equal(await fs.readFile(legacy,'utf8'),text);
  const newer=JSON.parse(text);newer.speedKHz=2000;await fs.writeFile(legacy,JSON.stringify(newer));
  assert.equal((await f.store.read(f.uri)).settings.speedKHz,f.settings.speedKHz,'canonical file takes precedence');
  await fs.writeFile(sharedPath(f.uri),'invalid');await assert.rejects(f.store.read(f.uri));
});

test('failed migration removes only the new file and retains the legacy version',async()=>{
  const f=await fixture(),{portableConfiguration,legacySharedPath}=require('../out/project/shared');
  const legacy=legacySharedPath(f.uri),text=(await portableConfiguration(f.settings)).text;await fs.writeFile(legacy,text);
  const old=await f.store.read(f.uri),original=fs.rename;
  fs.rename=async(source,target)=>{if(path.dirname(target)===path.join(f.root,'local'))throw Error('migration failure');return original(source,target);};
  try{await assert.rejects(f.store.save(old.settings,old.revision),/migration failure/);}finally{fs.rename=original;}
  await assert.rejects(fs.stat(sharedPath(f.uri)),{code:'ENOENT'});assert.equal(await fs.readFile(legacy,'utf8'),text);
  assert.equal((await f.store.read(f.uri)).revision,old.revision);
});

test('deleting configuration resets local selections, removes both shared files, and preserves project assets',async()=>{
  const f=await fixture(),{legacySharedPath}=require('../out/project/shared');
  const saved=await f.store.save(f.settings,0),text=await fs.readFile(sharedPath(f.uri),'utf8');await fs.writeFile(legacySharedPath(f.uri),text);
  const keep=['CMakeLists.txt','.vscode/settings.json','.vscode/launch.json','.vscode/stm32-easy/openocd/user.cfg','.idea/cmake.xml'];
  for(const name of keep){await fs.mkdir(path.dirname(path.join(f.project,name)),{recursive:true});await fs.writeFile(path.join(f.project,name),'keep me');}
  const reset=await f.store.remove(f.uri,f.project,saved.revision);
  for(const name of [sharedPath(f.uri),legacySharedPath(f.uri)])await assert.rejects(fs.stat(name),{code:'ENOENT'});
  for(const name of keep)assert.equal(await fs.readFile(path.join(f.project,name),'utf8'),'keep me');
  for(const key of ['configurePreset','targetScript','chipLabel','serial','targetId','preferredTarget'])assert.equal(reset.settings[key],undefined,key);
  assert.equal(reset.settings.chipConfirmed,false);assert.equal(reset.settings.shareInProject,false);
  assert.equal((await f.store.read(f.uri)).revision,reset.revision);
  await assert.rejects(f.store.save(saved.settings,saved.revision),/updated/i);
  const newStore=new ProjectStore(path.join(f.root,'new-user'));assert.equal(await newStore.read(f.uri),undefined);
});

test('failed delete restores both configuration files and a stale delete changes nothing',async()=>{
  const f=await fixture(),{legacySharedPath}=require('../out/project/shared');
  const saved=await f.store.save(f.settings,0),text=await fs.readFile(sharedPath(f.uri),'utf8');await fs.writeFile(legacySharedPath(f.uri),text);
  await assert.rejects(f.store.remove(f.uri,f.project,0),/updated/i);
  const original=fs.rename;fs.rename=async(source,target)=>{if(path.dirname(target)===path.join(f.root,'local'))throw Error('delete failure');return original(source,target);};
  try{await assert.rejects(f.store.remove(f.uri,f.project,saved.revision),/delete failure/);}finally{fs.rename=original;}
  for(const file of [sharedPath(f.uri),legacySharedPath(f.uri)])assert.equal(await fs.readFile(file,'utf8'),text);
  assert.equal((await f.store.read(f.uri)).revision,saved.revision);
});

test('configuration directory cannot redirect writes or deletes outside the project',async()=>{
  const f=await fixture(),outside=path.join(f.root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'stm32-easy.json'),'keep me');
  await fs.symlink(outside,path.join(f.project,'.vscode'),'junction');
  await assert.rejects(f.store.save(f.settings,0),/symbolic|outside/i);
  await assert.rejects(f.store.remove(f.uri,f.project,0),/symbolic|outside/i);
  assert.equal(await fs.readFile(path.join(outside,'stm32-easy.json'),'utf8'),'keep me');
});
