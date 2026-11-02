// Read-only user sources; settings and language-service caches stay in the isolated profile.
// Set STM32_VERIFY_PROJECT to an absolute STM32 CMake project path before running.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),vscode=require('vscode');
exports.run=async context=>{
 const root=path.resolve(__dirname,'..'),source=process.env.STM32_VERIFY_PROJECT;
 assert.ok(source&&path.isAbsolute(source),'set STM32_VERIFY_PROJECT to an absolute STM32 CMake project path');
 const extension=vscode.extensions.getExtension('local-stm32-tools.stm32-easy-tool-kit');await extension.activate();
 const load=name=>require(path.join(extension.extensionPath,'out',name));
 const {readBuildModel}=load('build/fileApi'),{ProjectStore}=load('project/store'),{WorkflowController}=load('workflow/controller');
 // The installed extension already owns its compatibility command. Suppress only
 // duplicate registration in this second integration instance; configuration APIs stay real.
 const vm=require('node:vm'),{createRequire}=require('node:module'),editorFile=path.join(extension.extensionPath,'out/integration/editor.js');
 const editorExports={},localRequire=createRequire(editorFile),testVscode=Object.assign({},vscode,{commands:Object.assign({},vscode.commands,{registerCommand:()=>({dispose(){}})})});
 vm.runInThisContext('(function(require,exports){'+await fs.readFile(editorFile,'utf8')+'\n})')(name=>name==='vscode'?testVscode:localRequire(name),editorExports);
 const {registerEditorIntegration}=editorExports;
 const uri=vscode.Uri.file(source).toString(),model=await readBuildModel(path.join(source,'build/Debug'));
 const store=new ProjectStore(path.join(root,'.cache/editor-0511-local'));
 const {defaultProjectSettings}=load('project/types');let saved=await store.read(uri);
 saved=await store.save({...defaultProjectSettings(uri,source.toLowerCase()),shareInProject:false,configurePreset:'Debug'},saved?.revision??0);
 const host={projects:()=>[{uri,directory:source,label:'main'}],rememberProject:async()=>{},log(){}};
 const controller=new WorkflowController(store,{list:async()=>[]},host,{},path.join(root,'.cache/editor-0511-locks'),undefined,uri);
 // Reproduce the exact cache identity from CMake: uppercase source and omitted Build Preset.
 controller.configured.set(uri,{signature:JSON.stringify([model.sourceDirectory,'Debug',undefined,model.binaryDirectory]),model,cmakeFingerprint:''});
 assert.ok((await controller.view()).model,'configured model must survive case/null differences');
 const logs=[];context.subscriptions.push(...registerEditorIntegration(context,controller,()=>{},text=>logs.push(text)));
 const cpp=vscode.extensions.getExtension('ms-vscode.cpptools');assert.ok(cpp);await cpp.activate();
 const file=vscode.Uri.file(path.join(source,'User_File/Controller/Src/Chassis.cpp')),document=await vscode.workspace.openTextDocument(file);
 await vscode.window.showTextDocument(document);
 const text=document.getText(),anchor=text.indexOf('ahrs.get_roll');assert.ok(anchor>=0);
 let names=[],diagnostics=[];
 for(let attempt=0;attempt<24;attempt++){
   await new Promise(resolve=>setTimeout(resolve,2500));
   const completion=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',file,document.positionAt(anchor+5),'.');
   names=(completion?.items??[]).map(item=>typeof item.label==='string'?item.label:item.label.label);
   diagnostics=vscode.languages.getDiagnostics(file).map(item=>({source:item.source,message:item.message}));
   if(names.some(name=>name.includes('get_roll'))&&!diagnostics.some(item=>/Unit\.h|includePath/.test(item.message)))break;
 }
 const result={version:extension.packageJSON.version,modelVisible:true,database:vscode.workspace.getConfiguration('C_Cpp').get('default.compileCommands'),completionNames:names,diagnostics,logs,userSourceEdited:document.isDirty};
 await fs.writeFile(path.join(root,'.cache/editor-0511-result.json'),JSON.stringify(result,null,2));
 assert.ok(names.some(name=>name.includes('get_roll')),'real C/C++ must supply AHRS members');assert.equal(document.isDirty,false);
 assert.equal(diagnostics.some(item=>/Unit\.h|includePath/.test(item.message)),false,'Unit.h must resolve');
};
