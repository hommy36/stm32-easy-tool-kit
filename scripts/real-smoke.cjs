// Real compiler smoke test. All generated sources/settings stay under .cache.
// Usage: node scripts/real-smoke.cjs <directory containing active tool JSON records>
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {ToolState}=require('../out/tools/state');
const {ProjectStore}=require('../out/project/store');
const {WorkflowController}=require('../out/workflow/controller');
async function main(){
  if(!process.argv[2])throw Error('Provide a tool records directory. No tools are downloaded.');
  const tools=(await new ToolState(path.resolve(process.argv[2])).list()).filter(tool=>tool.id!=='openocd');
  for(const id of ['armGnu','cmake','ninja'])assert.ok(tools.some(tool=>tool.id===id),`Missing ${id}`);
  const root=await fs.mkdtemp(path.resolve('.cache/release-smoke-'));const source=path.join(root,'firmware');await fs.mkdir(source);
  const cmake='cmake_minimum_required(VERSION 3.22)\nproject(product_smoke C)\nadd_executable(firmware main.c)\nset_target_properties(firmware PROPERTIES SUFFIX .elf)\ntarget_compile_options(firmware PRIVATE -mcpu=cortex-m4 -mthumb -ffreestanding)\ntarget_link_options(firmware PRIVATE -mcpu=cortex-m4 -mthumb -nostdlib -Wl,-e,main)\n';
  const sourceText='int main(void) { volatile unsigned counter=0; for(;;) counter++; }\n';
  const cacheVariables={CMAKE_C_COMPILER:tools.find(t=>t.id==='armGnu').executables.gcc.replaceAll('\\','/'),CMAKE_MAKE_PROGRAM:tools.find(t=>t.id==='ninja').executables.ninja.replaceAll('\\','/'),CMAKE_SYSTEM_NAME:'Generic',CMAKE_TRY_COMPILE_TARGET_TYPE:'STATIC_LIBRARY',CMAKE_BUILD_TYPE:'Debug'};
  const presets=JSON.stringify({version:3,configurePresets:[{name:'Debug',displayName:'Debug',generator:'Ninja',binaryDir:'${sourceDir}/build/Debug',cacheVariables}]},null,2);
  const clion=process.argv.includes('--clion');
  const xmlEscape=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
  const configuration=clion?`<project><component name="CMakeSettings"><configurations><configuration PROFILE_NAME="Debug" ENABLED="true" CONFIG_NAME="Debug" GENERATION_DIR="$PROJECT_DIR$/build/Debug" GENERATION_OPTIONS="${xmlEscape(Object.entries(cacheVariables).map(([key,value])=>`-D${key}=\"${value}\"`).join(' '))}"/></configurations></component></project>`:presets;
  const configurationFile=path.join(source,clion?'.idea/workspace.xml':'CMakePresets.json');
  if(clion)await fs.mkdir(path.join(source,'.idea'));
  await fs.writeFile(path.join(source,'CMakeLists.txt'),cmake);await fs.writeFile(path.join(source,'main.c'),sourceText);await fs.writeFile(configurationFile,configuration);
  const uri=pathToFileURL(source).toString(),state=new ToolState(path.join(root,'active')),store=new ProjectStore(path.join(root,'projects'));for(const tool of tools)await state.select(tool);
  let log='';const host={guard(){},projects:()=>[{uri,directory:source,label:'firmware'}],saveDocuments:async()=>{},assertDocumentsCurrent:async()=>{},chooseProject:async()=>uri,chooseConfigure:async choices=>choices[0]?.name,chooseBuild:async()=>'',chooseTarget:async targets=>targets[0],chooseArtifact:async files=>files[0],confirmExternal:async()=>true,confirmHardware:async()=>{throw Error('Hardware must not be reached');},rememberProject:async()=>{},log:(_stream,text)=>{log+=text;}};
  const controller=new WorkflowController(store,state,host,{flash:async()=>{throw Error('Hardware forbidden');},debug:async()=>{throw Error('Hardware forbidden');}},path.join(root,'locks'));
  const sharing=process.argv.includes('--shared');
  if(sharing){const initial=(await controller.view()).project;await controller.saveSettings({...initial.settings,shareInProject:true},initial.revision);}
  await controller.run('configure',uri);assert.ok((await store.read(uri)).settings.targetId);
  await controller.run('build',uri);const first=controller.getSnapshot();assert.ok(first.evidence);
  await fs.writeFile(path.join(source,'main.c'),'#error intentional_product_smoke_failure\n');
  await assert.rejects(controller.run('flash',uri));assert.equal(controller.getSnapshot().phase,'failed');assert.equal(controller.getSnapshot().evidence,undefined);
  await fs.writeFile(path.join(source,'main.c'),sourceText);await controller.run('build',uri);assert.ok(controller.getSnapshot().evidence);
  assert.equal(await fs.readFile(path.join(source,'CMakeLists.txt'),'utf8'),cmake);assert.equal(await fs.readFile(configurationFile,'utf8'),configuration);
  if(clion)await assert.rejects(fs.stat(path.join(source,'CMakePresets.json')),{code:'ENOENT'});
  await fs.writeFile(path.join(root,'build.log'),log);
  if(sharing){const portable=JSON.parse(await fs.readFile(path.join(source,'.vscode/stm32-easy.json'),'utf8'));assert.equal(portable.firmwareTarget,'firmware');assert.equal(portable.sourceDirectory,'.');assert.equal(portable.tools,undefined);}
  const result={root,source,clion,sharing,artifact:controller.getSnapshot().evidence.artifact,tools:tools.map(t=>({id:t.id,version:t.version})),configure:true,build:true,failedBuildBlocksHardware:true,retry:true,projectConfigurationUnchanged:true,hardwareTested:false};
  await fs.writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));await fs.writeFile('.cache/release-smoke-latest.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
