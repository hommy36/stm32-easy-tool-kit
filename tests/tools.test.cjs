require('../out/i18n').setLanguage('zh-CN');
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const path = require('node:path');
const handlers = new Map(), checked = [], installed = [], errors = [];
let picks = 0;
const api = {
  commands: { registerCommand: (id, action) => { handlers.set(id,action);return {dispose(){}}; } },
  workspace: { getConfiguration: () => ({get:(_key,fallback)=>fallback}) },
  window: {
    showQuickPick:async()=>{picks++;return undefined;}, showInformationMessage:async()=> '下载并安装',
    showErrorMessage:async message=>{errors.push(message);},
    withProgress:async(_options, action)=>action({report(){}},{isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})})
  }, ProgressLocation: { Notification: 15 }
};
const original=Module._load;
Module._load=function(id,...rest){ if(id==='vscode')return api;return original.call(this,id,...rest); };
require('../out/tools/check').checkInstallation=async tool=>{checked.push(tool.id);return [{code:'version',status:'ok',summary:'verified',evidence:[]}];};
require('../out/tools/install').installRelease=async(release,_directory,_signal,_archive,callbacks)=>{
  installed.push(release.id);const tool={id:release.id,version:release.version,root:path.resolve('.cache'),source:'managed',executables:{program:process.execPath}};await callbacks.activate(tool);return tool;
};
const {registerCommands}=require('../out/commands');
Module._load=original;
const {ToolState}=require('../out/tools/state');
test('OpenOCD installation offers C5 explicitly and cancellation installs nothing',async t=>{
  const root=await fs.mkdtemp(path.resolve('.cache/c5-picker-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const state=new ToolState(path.join(root,'active')),previous=api.window.showQuickPick;
  const before=installed.length;
  api.window.showQuickPick=async choices=>{
    assert.equal(choices.length,2);
    assert.match(choices[0].description,/第三方/);
    assert.equal(choices[0].release.archiveFormat,'tar.gz');
    return undefined;
  };
  t.after(()=>{api.window.showQuickPick=previous;});
  registerCommands({globalStorageUri:{fsPath:root}},state,{appendLine(){},show(){}},()=>{});
  await handlers.get('stm32Easy.installTools')('openocd');
  assert.equal(installed.length,before);assert.equal(state.isBusy,false);
});
test('per-tool check and install do not run all four tools or reopen a picker',async()=>{
  await fs.mkdir('.cache',{recursive:true}); const root=await fs.mkdtemp(path.resolve('.cache/tool-command-'));
  const state=new ToolState(root);
  for(const id of ['armGnu','cmake','ninja','openocd']) await state.select({id,version:'test',root,source:'external',executables:{program:process.execPath}});
  registerCommands({globalStorageUri:{fsPath:root}},state,{appendLine(){},show(){}},()=>{});
  await handlers.get('stm32Easy.checkEnvironment')('cmake');
  assert.deepEqual(checked,['cmake']);assert.equal(state.results.get('cmake')[0].status,'ok');assert.equal(state.results.has('ninja'),false);
  await handlers.get('stm32Easy.installTools')('ninja');assert.deepEqual(installed,['ninja']);assert.equal(picks,0);assert.equal(state.isBusy,false);assert.deepEqual(errors,[]);
});
test('select existing activates a downloaded tool with its original managed identity',async t=>{
  const root=await fs.mkdtemp(path.resolve('.cache/tool-picker-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const installRoot=path.join(root,'tools','ninja','1.12.1','installation');
  await fs.mkdir(installRoot,{recursive:true});
  await fs.writeFile(path.join(installRoot,'ninja.exe'),'placeholder; checks mocked');
  await fs.writeFile(path.join(installRoot,'stm32-easy-installation.json'),JSON.stringify({id:'ninja',version:'1.12.1',installationId:'installation',sha256:'a'.repeat(64)}));
  const state=new ToolState(path.join(root,'active'));
  const previous=api.window.showQuickPick;
  api.window.showQuickPick=async choices=>{
    const choice=choices.find(item=>item.candidate?.installationRoot===installRoot);
    assert.ok(choice);assert.match(choice.description,/插件下载/);return choice;
  };
  api.window.showWarningMessage=async()=> '信任并检查';
  t.after(()=>{api.window.showQuickPick=previous;delete api.window.showWarningMessage;});
  registerCommands({globalStorageUri:{fsPath:root}},state,{appendLine(){},show(){}},()=>{});
  await handlers.get('stm32Easy.selectExistingTool')('ninja');
  const selected=await state.get('ninja');
  assert.equal(selected.source,'managed');assert.equal(selected.root,installRoot);
  assert.equal(selected.version,'1.12.1');assert.equal(selected.executables.ninja,path.join(installRoot,'ninja.exe'));
  assert.equal(state.isBusy,false);assert.deepEqual(errors,[]);
});
