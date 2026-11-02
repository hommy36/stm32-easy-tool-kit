const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
require('../out/i18n').setLanguage('en');
const { parseXml, parseClionProject, readClionProject, profileSelection, clionMetadata, parseClionToolchains, expandClion, cachedToolPaths } = require('../out/integration/clionConfig');
const { BuildService } = require('../out/build/service');
const { ToolState } = require('../out/tools/state');
const { replaceFile } = require('../out/core/atomicFile');
const { buildConfigArgs, buildFlashArgs, tclWord } = require('../out/dap/config');
const { defaultProjectSettings, authorizationFrom, authorizationMatches, validateProjectSettings } = require('../out/project/types');
const load = Module._load; Module._load = function(id,...rest) { return id === 'vscode' ? {} : load.call(this,id,...rest); };
const { matchClionPreset, boardSettings } = require('../out/integration/clionImport'); Module._load = load;
const source = path.resolve('.cache/clion-unit/source');
const profileXml = `<project><component name="CMakeSettings"><configurations>
<configuration PROFILE_NAME="Arm Debug" ENABLED="true" CONFIG_NAME="Debug" TOOLCHAIN_NAME="ARM" GENERATION_DIR="$PROJECT_DIR$/cmake-build-debug" GENERATION_OPTIONS="-DFEATURE:BOOL=ON -DCMAKE_C_FLAGS=&quot;-Wall -Wextra&quot;" BUILD_OPTIONS="-j 4 --verbose"><envs><env name="MODE" value="motor"/></envs></configuration>
<configuration PROFILE_NAME="Release" ENABLED="false" CONFIG_NAME="Release"/>
<configuration PROFILE_NAME="Debug - Debug" ENABLED="true" FROM_PRESET="true" GENERATION_DIR="$PROJECT_DIR$/build/Debug"/>
</configurations></component><component name="PropertiesComponent"><![CDATA[{"ignored":true}]]></component></project>`;
const runXml = `<component name="ProjectRunConfigurationManager"><configuration name="board" type="com.jetbrains.cidr.embedded.openocd.conf.type" CONFIG_NAME="Arm Debug" TARGET_NAME="firmware"><openocd board-config="$PROJECT_DIR$/board&amp;probe.cfg" reset-type="INIT" download-type="UPDATED_ONLY"><debugger kind="GDB" isBundled="true"/></openocd></configuration></component>`;
const profile = parseClionProject(profileXml, path.join(source,'.idea/workspace.xml')).profiles[0];

test('CLion XML reads profiles, environment and complete OpenOCD run settings', () => {
  const data = parseClionProject(profileXml, 'workspace.xml');
  assert.equal(data.profiles.length,3); assert.equal(data.profiles[1].enabled,false); assert.equal(data.profiles[2].fromPreset,true);
  assert.equal(data.profiles[0].environment.MODE,'motor'); assert.deepEqual(data.profiles[0].unsupported,[]);
  const run = parseClionProject(runXml,'board.run.xml').runs[0];
  assert.equal(run.boardScript,'$PROJECT_DIR$/board&probe.cfg');assert.equal(run.profile,'Arm Debug');assert.equal(run.target,'firmware');assert.equal(run.reset,'INIT');
});
test('XML rejects entity expansion, malformed closing tags, duplicate attributes and large inputs', () => {
  for(const xml of ['<!DOCTYPE a [<!ENTITY x SYSTEM "file:///secret">]><a/>','<a></b>','<a name="x" name="y"/>','<a>','x'.repeat(2097153)])assert.throws(()=>parseXml(xml));
});
test('profile arguments preserve quoting, environment and build options without writing Presets', () => {
  const selection=profileSelection(profile,source,{Path:'C:\\tools',KEEP:'yes'});
  assert.equal(selection.binaryDirectory,path.join(source,'cmake-build-debug'));
  assert.ok(selection.configureArgs.includes('-DCMAKE_C_FLAGS=-Wall -Wextra'));
  assert.ok(selection.configureArgs.includes('-DCMAKE_BUILD_TYPE=Debug'));
  assert.deepEqual(selection.buildArgs,['-j','4','--verbose']);assert.equal(selection.configureEnvironment.MODE,'motor');assert.equal(selection.configureEnvironment.KEEP,'yes');
  assert.equal(selection.configurePreset,'CLion:Arm Debug');
  const isolated=profileSelection({...profile,inheritEnvironment:false},source,{KEEP:'yes'});assert.equal(isolated.configureEnvironment.KEEP,undefined);
});
test('profile rejects command mode, target overrides, unresolved macros and unsafe build modes', () => {
  for(const options of ['-P run.cmake','--build build','-S elsewhere','--install build','-DFOO=$UNKNOWN$','-G'])assert.throws(()=>profileSelection({...profile,options},source,{}));
  for(const buildOptions of ['--clean-first','--target other','-- --dry-run'])assert.throws(()=>profileSelection({...profile,buildOptions},source,{}));
  assert.throws(()=>profileSelection({...profile,unsupported:['REMOTE=true']},source,{}));
  assert.throws(()=>expandClion('$MISSING$',source,{}));
});
test('toolchain custom compiler, CMake and Ninja paths are preserved; remote toolchains blocked', () => {
  const chain=parseClionToolchains('<application><component name="CPPToolchains"><toolchains><toolchain name="ARM" toolSetKind="MINGW" customCCompilerPath="D:/Arm/bin/arm-none-eabi-gcc.exe" customCXXCompilerPath="D:/Arm/bin/arm-none-eabi-g++.exe" customCMakePath="D:/CMake/bin/cmake.exe" customMakePath="D:/Ninja/ninja.exe"/></toolchains></component></application>')[0];
  const selection=profileSelection(profile,source,{},chain);
  assert.equal(selection.declaredCmakeExecutable,'D:/CMake/bin/cmake.exe');assert.ok(selection.configureArgs.includes('-DCMAKE_C_COMPILER=D:/Arm/bin/arm-none-eabi-gcc.exe'));
  assert.throws(()=>profileSelection(profile,source,{}, {...chain,unsupported:['toolSetKind=WSL']}));
});
test('preset-backed CLion profile resolves by actual output directory, never splits names heuristically', () => {
  const metadata={configure:[{name:'Debug'},{name:'Release'}],resolve:name=>({binaryDirectory:path.join(source,'build',name)})};
  const preset=parseClionProject(profileXml,'workspace.xml').profiles[2];
  assert.deepEqual(matchClionPreset(preset,source,{},metadata),['Debug']);
  assert.deepEqual(matchClionPreset({...preset,directory:undefined},source,{},metadata),[]);
});
test('board import preserves original script, speed and serial; does not load CMSIS-DAP twice', () => {
  const content='source [find interface/cmsis-dap.cfg]\nsource [find target/stm32f4x.cfg]\nreset_config none\nadapter speed 4000\nadapter serial "probe-1"\ncmsis_dap_backend hid';
  assert.deepEqual(boardSettings(content),{speedKHz:4000,backend:'hid',serial:'probe-1',probe:'cmsis-dap'});
  assert.equal(boardSettings('adapter serial probe-2').serial,'probe-2');
  assert.equal(boardSettings('source [find interface/stlink.cfg]\ntransport select hla_swd\nhla_serial "st-1"').probe,'st-link');
  assert.equal(boardSettings('adapter driver jlink\nadapter serial "jl-1"').probe,'jlink');
  assert.throws(()=>boardSettings('source [find interface/ftdi/x.cfg]'));assert.throws(()=>boardSettings('transport select jtag'));
  const settings={...defaultProjectSettings('file:///D:/project','D:/project'),targetScript:'D:/project/board.cfg',chipConfirmed:true,scriptKind:'board'};
  const args=buildConfigArgs(settings,'D:/OpenOCD/scripts');
  assert.ok(args.includes(`source ${tclWord(path.resolve('D:/project/board.cfg'))}`));assert.equal(args.includes('adapter driver cmsis-dap'),false);
  assert.ok(args.some(arg=>arg.includes('requires CMSIS-DAP')));assert.ok(args.some(arg=>arg.includes('requires SWD')));
  assert.match(buildFlashArgs(settings,'D:/OpenOCD/scripts','D:/project/app.elf').at(-1),/verify reset exit$/);
  const legacy=buildConfigArgs({...settings,scriptKind:undefined},'D:/OpenOCD/scripts');assert.ok(legacy.includes('adapter driver cmsis-dap'));
});
test('board script type invalidates remembered hardware authorization while old target records remain compatible', () => {
  const settings={...defaultProjectSettings('file:///D:/project','D:/project'),targetScript:'target/stm32f4x.cfg',chipConfirmed:true,configurePreset:'Debug',configuration:'Debug',targetId:'fw'};
  const record=authorizationFrom(settings,'a'.repeat(64));delete record.scriptKind;
  assert.ok(authorizationMatches(settings,record,'a'.repeat(64)));
  assert.equal(authorizationMatches({...settings,scriptKind:'board'},record,'a'.repeat(64)),false);
  assert.throws(()=>validateProjectSettings({...settings,scriptKind:'shell'}));
});
async function fixture(){await fs.mkdir('.cache',{recursive:true});const root=await fs.mkdtemp(path.resolve('.cache/clion-test-'));await fs.mkdir(path.join(root,'.idea'));return root;}
test('local profiles override shared ones and .run OpenOCD configurations are discovered',async()=>{
  const root=await fixture();await fs.writeFile(path.join(root,'.idea/cmake.xml'),profileXml);
  await fs.writeFile(path.join(root,'.idea/workspace.xml'),profileXml.replace('cmake-build-debug','local-output'));
  await fs.mkdir(path.join(root,'.run'));await fs.writeFile(path.join(root,'.run/board.run.xml'),runXml);
  const data=await readClionProject(root);assert.equal(data.profiles[0].directory,'$PROJECT_DIR$/local-output');assert.equal(data.runs.length,1);
  const metadata=clionMetadata(data,root,{},[{toolchains:[{name:'ARM',kind:'MINGW',environment:{},unsupported:[]}],files:[]}]);
  assert.deepEqual(metadata.configure.map(x=>x.name),['CLion:Arm Debug']);assert.equal(metadata.resolve('CLion:Arm Debug').binaryDirectory,path.join(root,'local-output'));
});
test('BuildService can list CLion-only projects without invoking CMake --list-presets or generating files',async()=>{
  const root=await fixture();const xml=profileXml.replace(' TOOLCHAIN_NAME="ARM"','');await fs.writeFile(path.join(root,'.idea/workspace.xml'),xml);
  let invocations=0;const service=new BuildService([{id:'cmake',executables:{cmake:path.join(root,'cmake.exe')},root,version:'test',source:'external'}],()=>{},()=>{},async()=>{invocations++;throw Error('unexpected');},async()=>[]);
  const metadata=await service.presets(root,new AbortController().signal);
  assert.ok(metadata.configure.some(x=>x.name==='CLion:Arm Debug'));assert.equal(invocations,0);
  assert.equal(await fs.readFile(path.join(root,'.idea/workspace.xml'),'utf8'),xml);
  await assert.rejects(fs.stat(path.join(root,'CMakePresets.json')),{code:'ENOENT'});
});
test('cached tool paths require matching CMake source identity',async()=>{
  const root=await fixture(),binary=path.join(root,'build');await fs.mkdir(binary);
  await fs.writeFile(path.join(binary,'CMakeCache.txt'),`CMAKE_HOME_DIRECTORY:INTERNAL=${root}\nCMAKE_COMMAND:INTERNAL=D:/cmake.exe\n`);
  assert.equal((await cachedToolPaths(root,binary)).CMAKE_COMMAND,'D:/cmake.exe');
  await assert.rejects(cachedToolPaths(path.join(root,'other'),binary),/another project/);
});
test('tool import rolls back all selections on a project commit conflict',async()=>{
  const root=await fixture(),state=new ToolState(path.join(root,'active'));
  const original={id:'cmake',root,version:'old',source:'external',executables:{cmake:path.join(root,'old.exe')}};
  await state.select(original);
  await assert.rejects(state.withSelections(async()=>[{...original,version:'new'},{...original,id:'ninja'}],async()=>{throw Error('revision conflict');}),/revision conflict/);
  assert.deepEqual(await state.list(),[original]);assert.equal(state.isBusy,false);
  await assert.rejects(state.withSelections(async()=>{throw Error('tool check failed');},async()=>{}),/tool check failed/);
  assert.deepEqual(await state.list(),[original]);
});

test('atomic replacement retries transient sharing violations and propagates permanent failures',async()=>{
  let attempts=0;await replaceFile('temporary','record',async(source,target)=>{
    assert.equal(source,'temporary');assert.equal(target,'record');if(++attempts<3)throw Object.assign(Error('sharing'),{code:'EPERM'});
  });assert.equal(attempts,3);
  attempts=0;await assert.rejects(replaceFile('temporary','record',async()=>{attempts++;throw Object.assign(Error('missing'),{code:'ENOENT'});}),{code:'ENOENT'});assert.equal(attempts,1);
  attempts=0;await assert.rejects(replaceFile('temporary','record',async()=>{attempts++;throw Object.assign(Error('locked'),{code:'EBUSY'});}),{code:'EBUSY'});assert.equal(attempts,7);
});
