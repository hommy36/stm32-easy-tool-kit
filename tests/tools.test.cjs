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
test('per-tool check and install do not run all four tools or reopen a picker',async()=>{
  await fs.mkdir('.cache',{recursive:true}); const root=await fs.mkdtemp(path.resolve('.cache/tool-command-'));
  const state=new ToolState(root);
  for(const id of ['armGnu','cmake','ninja','openocd']) await state.select({id,version:'test',root,source:'external',executables:{program:process.execPath}});
  registerCommands({globalStorageUri:{fsPath:root}},state,{appendLine(){},show(){}},()=>{});
  await handlers.get('stm32Easy.checkEnvironment')('cmake');
  assert.deepEqual(checked,['cmake']);assert.equal(state.results.get('cmake')[0].status,'ok');assert.equal(state.results.has('ninja'),false);
  await handlers.get('stm32Easy.installTools')('ninja');assert.deepEqual(installed,['ninja']);assert.equal(picks,0);assert.equal(state.isBusy,false);assert.deepEqual(errors,[]);
});
