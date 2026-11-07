const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module');
const {repairForError}=require('../out/ui/presentation');
const {setLanguage}=require('../out/i18n');
const handlers=new Map(),dialogs=[],executed=[];
const api={commands:{registerCommand:(id,handler)=>{handlers.set(id,handler);return{dispose(){}};},executeCommand:async id=>executed.push(id)},window:{showErrorMessage:async(message,...items)=>{dialogs.push({message,items});return items[0];}}};
const original=Module._load;Module._load=function(id,...rest){if(id==='vscode')return api;return original.call(this,id,...rest);};
const {registerWorkflowCommands}=require('../out/workflow/commands');Module._load=original;
test('compiler mismatch directs both old and new translated messages to tools',()=>{
 for(const text of ['实际编译命令没有引用所选 Arm GCC/G++','The actual compilation command does not reference the selected Arm GCC/G++.','Arm 编译器路径不一致，暂停烧录/调试。','Arm compiler paths differ; flash/debug are blocked.'])assert.equal(repairForError(text),'tools');
});
test('workflow failure has one log action and a useful compiler repair action',async()=>{
 setLanguage('en');let reason='unknown workflow failure';
 registerWorkflowCommands({}, {stop:async()=>{throw Error(reason);}}, {}, {});
 await handlers.get('stm32Easy.workbench.stop')();
 assert.equal(dialogs[0].items.length,1);assert.equal(executed[0],'stm32Easy.workbench.showBuildLog');
 reason='Arm compiler paths differ; flash/debug are blocked.\nActual command: D:/tools/arm-none-eabi-gcc.exe\nSelected: C:/tools/arm-none-eabi-gcc.exe';
 await handlers.get('stm32Easy.workbench.stop')();
 assert.equal(dialogs[1].items.length,2);assert.equal(new Set(dialogs[1].items).size,2);
 assert.match(dialogs[1].message,/D:\/tools/);assert.match(dialogs[1].message,/C:\/tools/);
 assert.equal(executed[1],'stm32Easy.workbench.tools');
});
