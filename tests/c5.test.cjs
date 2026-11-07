const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const tar=require('tar-stream'),{gzipSync}=require('node:zlib');
const {extractTarArchive}=require('../out/tools/extractTar');
const {loadC5Release}=require('../out/tools/catalog');
const {isC5Target,verifyC5Files,c5CheckCommands}=require('../out/dap/c5');
const {resolveDapConfiguration}=require('../out/dap/config');
const {buildFlashArgs}=require('../out/dap/config');
const {buildServerArgs}=require('../out/dap/server');
const {c5EventScopeCommand}=require('../out/dap/c5');
const {defaultProjectSettings}=require('../out/project/types');
const {pathToFileURL}=require('node:url');
require('../out/i18n').setLanguage('en');
const limits={maxEntries:20,maxExtractedBytes:4096,maxFileBytes:2048};
async function fixture(t, entries){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'stm32-c5-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const pack=tar.pack(),chunks=[];pack.on('data',chunk=>chunks.push(chunk));
 const done=new Promise((resolve,reject)=>{pack.on('end',resolve);pack.on('error',reject);});
 for(const entry of entries)pack.entry(entry.header,entry.body??'');
 pack.finalize();await done;
 const archive=path.join(root,'bundle.tar.gz'),output=path.join(root,'out');await fs.mkdir(output);await fs.writeFile(archive,gzipSync(Buffer.concat(chunks)));
 return {root,archive,output};
}
test('TAR installer handles distribution root and nested paths',async t=>{
 const f=await fixture(t,[{header:{name:'.',type:'directory'}},{header:{name:'./bin',type:'directory'}},{header:{name:'./bin/openocd.exe'},body:'binary'},{header:{name:'openocd/scripts/target/stm32c5x.cfg'},body:'cfg'}]);
 await extractTarArchive(f.archive,f.output,limits,new AbortController().signal);
 assert.equal(await fs.readFile(path.join(f.output,'bin/openocd.exe'),'utf8'),'binary');
});
for(const [name,entries] of [
 ['traversal',[{header:{name:'../escape'},body:'x'}]],
 ['absolute',[{header:{name:'/absolute'},body:'x'}]],
 ['drive',[{header:{name:'C:/escape'},body:'x'}]],
 ['link',[{header:{name:'evil',type:'symlink',linkname:'../escape'}}]],
 ['hardlink',[{header:{name:'evil',type:'link',linkname:'../escape'}}]],
 ['duplicate',[{header:{name:'bin/A.exe'},body:'x'},{header:{name:'bin/a.exe'},body:'x'}]]
]) test('TAR rejects '+name,async t=>{
 const f=await fixture(t,entries);
 await assert.rejects(extractTarArchive(f.archive,f.output,limits,new AbortController().signal));
 await assert.rejects(fs.stat(path.join(f.root,'escape')),/ENOENT/);
});
test('TAR entry, file and total expansion limits are enforced',async t=>{
 const f=await fixture(t,[{header:{name:'a'},body:'12345'},{header:{name:'b'},body:'12345'}]);
 for(const patch of [{maxEntries:1},{maxFileBytes:4},{maxExtractedBytes:8}]){
  const out=await fs.mkdtemp(path.join(f.root,'out-'));
  await assert.rejects(extractTarArchive(f.archive,out,{...limits,...patch},new AbortController().signal));
 }
});
test('TAR truncation/cancellation does not activate or complete extraction',async t=>{
 const f=await fixture(t,[{header:{name:'a'},body:'payload'}]);
 const abort=new AbortController();abort.abort();
 await assert.rejects(extractTarArchive(f.archive,f.output,limits,abort.signal));
 const bytes=await fs.readFile(f.archive);await fs.writeFile(f.archive,bytes.subarray(0,bytes.length-9));
 await assert.rejects(extractTarArchive(f.archive,f.output,limits,new AbortController().signal));
});
test('C5 catalog pins a complete third-party archive and uses only configuration checks',()=>{
 const release=loadC5Release();assert.equal(release.archiveFormat,'tar.gz');assert.equal(release.archiveBytes,2767295);
 assert.match(release.url,/5e6fb45b08c6f86b552b49b3c5fa66e35acb0ceb/);assert.equal(release.scriptsDirectory,'openocd/scripts');
 assert.equal(isC5Target({chipLabel:'STM32C593RET6'}),true);assert.equal(isC5Target({targetScript:'target/stm32c5x.cfg'}),true);
 assert.equal(isC5Target({chipLabel:'STM32F405'}),false);assert.equal(c5CheckCommands.at(-1),'shutdown');
 assert.equal(c5CheckCommands.some(x=>/^(init|reset|halt|program|flash write)/.test(x)),false);
});
test('C5 readiness directs old OpenOCD users to the experimental installer',()=>{
 const {capabilities}=require('../out/ui/presentation');
 const settings={...defaultProjectSettings('file:///D:/demo','D:/demo'),chipLabel:'STM32C593RET6'};
 const ready=capabilities({settings,cmakeProject:true,tools:['armGnu','cmake','ninja','openocd'].map(id=>({id,available:true})),busy:false,trusted:true,supported:true,cortex:true});
 assert.equal(ready.flash.enabled,false);assert.equal(ready.flash.repair,'tools');assert.match(ready.flash.reason,/Experimental STM32C5/);
 assert.equal(ready.build.enabled,true);
 const configured=capabilities({settings:{...settings,targetScript:'target/stm32c5x.cfg'},cmakeProject:true,tools:['armGnu','cmake','ninja','openocd'].map(id=>({id,available:true})),busy:false,trusted:true,supported:true,cortex:true});
 assert.equal(configured.flash.enabled,true);
});
test('C5 missing or modified loader fails before launching OpenOCD',async t=>{
 const f=await fixture(t,[]);let calls=0;
 await assert.rejects(verifyC5Files(f.output),/local flash loaders/);
 const settings={...defaultProjectSettings(pathToFileURL(f.root).href,f.root),chipLabel:'STM32C593RET6',targetScript:'target/stm32c5x.cfg',chipConfirmed:true};
 await assert.rejects(resolveDapConfiguration(settings,new AbortController().signal,{tools:[{id:'openocd',scriptsDirectory:f.output,executables:{openocd:path.join(f.root,'openocd.exe')}}],guard(){},trustScript:async()=>true,probe:async()=>{calls++;}}),/local flash loaders/);
 assert.equal(calls,0);
});
test('C5 callback repair precedes flash/init for every direct probe and leaves other targets alone',()=>{
 const scripts=path.resolve('.cache/scripts'),targetScript=path.join(scripts,'target/stm32c5x.cfg');
 for(const probe of ['cmsis-dap','st-link','jlink']){
  const settings={...defaultProjectSettings('file:///D:/demo','D:/demo'),chipLabel:'STM32C593RET6',targetScript,chipConfirmed:true,probe};
  const flash=buildFlashArgs(settings,scripts,path.resolve('.cache/app.elf'),'modern');
  assert.ok(flash.indexOf(c5EventScopeCommand)>flash.findIndex(x=>x.startsWith('source ')));
  assert.ok(flash.indexOf(c5EventScopeCommand)<flash.findIndex(x=>x.startsWith('program ')));
  for(const mode of ['launch','attach']){
   const args=buildServerArgs(settings,{scriptsDirectory:scripts,targetScript,dialect:'modern'},3333,{mode});
   assert.ok(args.indexOf(c5EventScopeCommand)<args.indexOf('init'));assert.ok(args.includes(c5EventScopeCommand));
  }
  const other=buildFlashArgs({...settings,chipLabel:'STM32F405',targetScript:'target/stm32f4x.cfg'},scripts,path.resolve('.cache/app.elf'),'modern');
  assert.equal(other.includes(c5EventScopeCommand),false);
 }
});
