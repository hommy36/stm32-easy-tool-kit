// Actual installed VSIX workflow, started by clion-host-driver in an isolated profile.
// Do not use --extensionTestsPath: VS Code refuses native dialogs in test mode.
// The native import preview must be accepted in the isolated window.
const vscode=require('vscode');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
exports.run=async()=>{
  const context=JSON.parse(await fs.readFile(path.resolve(__dirname,'../.cache/clion-host-context.json'),'utf8'));
  const extension=vscode.extensions.getExtension('local-stm32-tools.stm32-easy-tool-kit');
  assert.equal(extension.packageJSON.version,context.version);await extension.activate();
  const files=['CMakeLists.txt','.idea/workspace.xml','.run/probe.run.xml','board.cfg'];
  const before=await Promise.all(files.map(file=>fs.readFile(path.join(context.source,file),'utf8')));
  await vscode.commands.executeCommand('stm32Easy.project.focus');
  await vscode.commands.executeCommand('stm32Easy.workbench.setup');
  await vscode.commands.executeCommand('stm32Easy.workbench.importClion');
  const {ProjectStore}=require(path.join(extension.extensionPath,'out/project/store'));
  const {ToolState}=require(path.join(extension.extensionPath,'out/tools/state'));
  const saved=await new ProjectStore(path.join(context.storage,'projects')).read(vscode.Uri.file(context.source).toString());
  if(!saved){console.error('Import did not save a project; inspect the isolated window.');await new Promise(resolve=>setTimeout(resolve,45000));}
  assert.equal(saved.settings.configurePreset,'CLion:Debug');assert.equal(saved.settings.scriptKind,'board');
  assert.equal(saved.settings.chipConfirmed,false);assert.equal(saved.settings.preferredTarget,'firmware');
  assert.equal(saved.settings.targetScript.toLowerCase(),path.join(context.source,'board.cfg').toLowerCase());
  const tools=await new ToolState(path.join(context.storage,'active')).list();assert.equal(tools.length,4);
  assert.equal(tools.find(tool=>tool.id==='openocd').source,'external');
  for(let index=0;index<files.length;index++)assert.equal(await fs.readFile(path.join(context.source,files[index]),'utf8'),before[index]);
  await assert.rejects(fs.stat(path.join(context.source,'CMakePresets.json')),{code:'ENOENT'});
  await vscode.commands.executeCommand('stm32Easy.workbench.settings');
  const result={version:extension.packageJSON.version,extensionPath:extension.extensionPath,profile:saved.settings.configurePreset,
    boardImported:true,chipRequiresConfirmation:true,toolsChecked:tools.map(tool=>({id:tool.id,version:tool.version})),sourceFilesUnchanged:true,hardwareTested:false};
  await fs.writeFile(path.join(context.output,'clion-host-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  if(process.env.STM32_I18N_INSPECT==='1')await new Promise(resolve=>setTimeout(resolve,45000));
};
