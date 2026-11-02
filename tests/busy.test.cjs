const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
require('../out/i18n').setLanguage('en');
const {WorkflowController}=require('../out/workflow/controller');
const host={projects:()=>[],guard(){},log(){},rememberProject:async()=>{},assertDocumentsCurrent:async()=>{},saveDocuments:async()=>{},confirmExternal:async()=>false,confirmHardware:async()=>false,
  chooseProject:async()=>undefined,chooseConfigure:async()=>undefined,chooseBuild:async()=>undefined,chooseTarget:async()=>undefined,chooseArtifact:async()=>undefined};
function controller(lockDirectory,tools={}){
 const store={read:async()=>undefined,save:async()=>{throw new Error('unexpected save');}};
 return new WorkflowController(store,{list:async()=>[],...tools},host,{},lockDirectory);
}
test('busy errors name the actual blocker',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'stm32-busy-'));
 const workflow=controller(directory);
 workflow.snapshot.phase='uncertain';
 await assert.rejects(()=>workflow.run('build','file:///x'),/The previous operation ended in an uncertain state/);
 const tools=controller(directory,{isBusy:true});
 await assert.rejects(()=>tools.run('build','file:///x'),/Tool installation or check is still running/);
 await fs.rm(directory,{recursive:true,force:true});
});
test('stop clears an uncertain in-memory state only when no operation locks exist',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'stm32-busy-'));
 const clean=controller(directory);clean.snapshot.phase='uncertain';await clean.stop();
 assert.equal(clean.getSnapshot().phase,'idle');
 await fs.writeFile(path.join(directory,'build.lock'),'{"pid":1}');
 const locked=controller(directory);locked.snapshot.phase='uncertain';await locked.stop();
 assert.equal(locked.getSnapshot().phase,'uncertain','locks must keep the busy state');
 await fs.rm(directory,{recursive:true,force:true});
});
