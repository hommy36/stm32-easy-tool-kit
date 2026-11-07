const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
require('../out/i18n').setLanguage('en');
const {mergeDatabases,mergeClangdArguments,compilerDrivers,sanitizeCompileCommands}=require('../out/integration/editorDatabase');
test('C++ compile commands never pass a C-only standard flag to clangd',()=>{
 const db=[
  {file:'D:/p/a.cpp',command:'D:/tc/arm-none-eabi-g++ -std=gnu11 -I. -c a.cpp'},
  {file:'D:/p/b.c',command:'D:/tc/arm-none-eabi-gcc -std=gnu11 -c b.c'},
  {file:'D:/p/c.cpp',command:'D:/tc/arm-none-eabi-g++ -std=gnu++17 -std=gnu11 -c c.cpp'},
  {file:'D:/p/d.cc',arguments:['D:/tc/arm-none-eabi-g++','-std=c11','-c','d.cc']},
 ];
 const result=sanitizeCompileCommands(db);assert.equal(result.changed,true);
 assert.match(result.commands[0].command,/-std=gnu\+\+17/);assert.doesNotMatch(result.commands[0].command,/-std=gnu11/);
 assert.equal(result.commands[1].command,db[1].command);
 assert.doesNotMatch(result.commands[2].command,/-std=gnu11/);assert.match(result.commands[2].command,/-std=gnu\+\+17/);
 assert.deepEqual(result.commands[3].arguments,['D:/tc/arm-none-eabi-g++','-std=gnu++17','-c','d.cc']);
 assert.equal(sanitizeCompileCommands([{file:'D:/p/b.c',command:'gcc -std=gnu11 -c b.c'}]).changed,false);
});
test('editor database replacement retains unrelated projects and removes stale profile references',()=>{
 assert.deepEqual(mergeDatabases(['other.json','old.json'],'old.json','new.json'),['new.json','other.json']);
 assert.deepEqual(mergeDatabases('manual.json',undefined,'new.json'),['new.json','manual.json']);
 assert.deepEqual(mergeDatabases(['new.json'],undefined,'new.json'),['new.json']);
 assert.deepEqual(mergeClangdArguments(undefined,'D:\\p\\build'),['--compile-commands-dir=D:/p/build']);
 assert.deepEqual(mergeClangdArguments(['--background-index','--compile-commands-dir=old','--compile-commands-dir','old'],'D:/p/build'),
   ['--compile-commands-dir=D:/p/build','--background-index']);
 assert.deepEqual(mergeClangdArguments('--clang-tidy','/p'),['--compile-commands-dir=/p','--clang-tidy']);
 assert.deepEqual(mergeClangdArguments(['--query-driver=D:/old/arm-none-eabi-gcc.exe,D:/clang/bin/clang'],'D:/p/build',['D:\\new\\arm-none-eabi-g++.exe']),
   ['--compile-commands-dir=D:/p/build','--query-driver=D:/clang/bin/clang,D:/new/arm-none-eabi-g++.exe']);
 assert.deepEqual(compilerDrivers([{command:'D:\\tc\\bin\\arm-none-eabi-g++.exe -c a.cpp'},{command:'"D:/tc/bin/arm-none-eabi-gcc.exe" -c b.c'},{command:'gcc -c c.c'}]),
   ['D:\\tc\\bin\\arm-none-eabi-g++.exe','D:/tc/bin/arm-none-eabi-gcc.exe']);
});
async function fixture(options={}){
 const root=await fs.mkdtemp(path.resolve('.cache/editor-')),binary=path.join(root,'build');await fs.mkdir(binary);
 const initialCommands = typeof options.commands === 'function' ? options.commands({root,binary}) : options.commands ?? [{directory:binary,file:path.join(root,'external','lib.c'),command:'D:/tools/arm-none-eabi-gcc -I../external/include -DSTM32F407 -c ../external/lib.c'}];
 await fs.writeFile(path.join(binary,'compile_commands.json'),JSON.stringify(initialCommands));
 const uri={toString:()=> 'file:///main',fsPath:root},folders=[{name:'main',uri},{name:'external',uri:{toString:()=> 'file:///external',fsPath:path.join(root,'external')}}];
 const values=new Map(),updates=[],messages=[],commands={},state=new Map(),executed=[];let listener,folderListener;
 const vscode={ConfigurationTarget:{Workspace:2},workspace:{workspaceFolders:folders,getConfiguration:()=>({inspect:key=>({workspaceValue:values.get(key)}),get:()=>undefined,update:async(key,value,target)=>{updates.push({key,value,target});values.set(key,value);}}),onDidChangeWorkspaceFolders:callback=>{folderListener=callback;return {dispose(){}};}},extensions:{getExtension:id=>(options.cpptools!==false&&id==='ms-vscode.cpptools')||(options.clangd&&id==='llvm-vs-code-extensions.vscode-clangd')?{}:undefined,onDidChange:()=>({dispose(){}})},window:{showInformationMessage:async text=>messages.push(text),showWarningMessage:async text=>messages.push(text),showErrorMessage:async text=>messages.push(text)},commands:{registerCommand:(name,callback)=>{commands[name]=callback;return {dispose(){}};},executeCommand:async name=>{executed.push(name);}}};
 const context={workspaceState:{get:key=>state.get(key),update:async(key,value)=>state.set(key,value)},globalStorageUri:{fsPath:path.join(root,'storage')}};
 let current={project:{revision:1,settings:{projectUri:'file:///main'}},model:{binaryDirectory:binary}},configured=0;
 const controller={isBusy:false,view:async()=>current,ensureProjectUri:async()=> 'file:///main',run:async()=>{configured++;},onDidChange:callback=>{listener=callback;return {dispose(){}};}};
 const file=path.resolve('out/integration/editor.js'),local=createRequire(file),exports={};vm.runInThisContext('(function(require,exports){'+await fs.readFile(file,'utf8')+'\n})')(name=>name==='vscode'?vscode:local(name),exports);
 exports.registerEditorIntegration(context,controller,()=>{},()=>{});
 return {root,binary,controller,updates,messages,state,commands,executed,add:async()=>{folderListener({added:[folders[1]]});await new Promise(resolve=>setTimeout(resolve,40));},change:async()=>{listener();await new Promise(resolve=>setTimeout(resolve,30));},set current(value){current=value;},get configured(){return configured;}};
}
test('configuration completion automatically shares the current database across roots without opt-in',async()=>{
 const f=await fixture();await f.change();assert.equal(f.configured,0);
 assert.equal(JSON.stringify(f.updates),JSON.stringify([{key:'default.compileCommands',value:['${workspaceFolder:main}/build/compile_commands.json'],target:2}]));
 assert.equal(f.state.has('editor.enabled'),false);assert.equal(JSON.stringify(f.updates).includes('compilerPath'),false);
 const next=path.join(f.root,'release');await fs.mkdir(next);await fs.copyFile(path.join(f.binary,'compile_commands.json'),path.join(next,'compile_commands.json'));
 f.current={project:{revision:2,settings:{projectUri:'file:///main'}},model:{binaryDirectory:next}};await f.change();
 assert.equal(JSON.stringify(f.updates.at(-1).value),JSON.stringify(['${workspaceFolder:main}/release/compile_commands.json']));
});
test('clangd receives the compile database directory and restarts only when it changes',async()=>{
 const f=await fixture({clangd:true});await f.change();
 const update=f.updates.find(item=>item.key==='arguments');
 assert.equal(JSON.stringify(update.value),JSON.stringify([`--compile-commands-dir=${f.binary.replace(/\\/g,'/')}`,'--query-driver=D:/tools/arm-none-eabi-gcc']));
 assert.ok(f.executed.includes('clangd.restart'));
 const count=f.updates.length;await f.change();
 assert.equal(f.updates.length,count,'unchanged clangd arguments are not rewritten');
});
test('C++ sources with a C standard flag get a sanitized database for clangd and C/C++',async()=>{
 const f=await fixture({clangd:true,commands:({root,binary})=>[{directory:binary,file:path.join(root,'a.cpp'),command:'D:/tools/arm-none-eabi-g++ -std=gnu11 -c a.cpp'}]});
 await f.change();
 const args=f.updates.find(item=>item.key==='arguments')?.value;
 assert.ok(Array.isArray(args));
 const dir=args[0].replace('--compile-commands-dir=','');
 assert.ok(dir.replace(/\\/g,'/').startsWith(path.join(f.root,'storage').replace(/\\/g,'/')),dir);
 const text=await fs.readFile(path.join(dir,'compile_commands.json'),'utf8');
 assert.match(text,/-std=gnu\+\+17/);assert.doesNotMatch(text,/-std=gnu11/);
 const cpp=f.updates.find(item=>item.key==='default.compileCommands')?.value;
 assert.ok(Array.isArray(cpp)&&cpp[0].includes('storage')&&cpp[0].endsWith('compile_commands.json'),JSON.stringify(cpp));
});
test('automatic integration defers folder additions while busy and resumes on completion',async()=>{
 const f=await fixture();f.controller.isBusy=true;await f.add();assert.equal(f.updates.length,0);
 f.controller.isBusy=false;await f.change();assert.equal(f.updates.length,1);
 await fs.writeFile(path.join(f.binary,'compile_commands.json'),'[]');await f.change();assert.equal(f.updates.length,1);
});
test('adding an external root configures once when no model is cached, without a repair command',async()=>{
 const f=await fixture();await f.change();
 f.current={project:{revision:2,settings:{projectUri:'file:///main',configurePreset:'Debug'}}};
 let runs=0;f.controller.run=async()=>{runs++;f.current={project:{revision:3,settings:{projectUri:'file:///main',configurePreset:'Debug'}},model:{binaryDirectory:f.binary}};};
 f.updates.length=0;await f.add();
 assert.equal(runs,1);assert.equal(f.updates.length,0,'existing matching workspace setting is reused');
 assert.equal(f.messages.length,0,'automatic success does not interrupt the user');
});
