const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
require('../out/i18n').setLanguage('en');
const {BuildService}=require('../out/build/service');
const tools=(options={})=>[
 {id:'cmake',version:'x',root:'C:/fake/cmake',source:'external',executables:{cmake:'C:/fake/cmake/cmake.exe'}},
 {id:'ninja',version:'x',root:'C:/fake/ninja',source:'external',executables:{ninja:'C:/fake/ninja/ninja.exe'}},
 ...(options.arm===false?[]:[{id:'armGnu',version:'x',root:'C:/fake/arm/bin',source:'external',executables:{gcc:'C:/fake/arm/bin/arm-none-eabi-gcc.exe',gpp:'C:/fake/arm/bin/arm-none-eabi-g++.exe'}}]),
];
const never=async()=>{throw new Error('automatic preset discovery must not execute tools');};
test('automatic presets use the project toolchain without writing presets',async()=>{
 const source=await fs.mkdtemp(path.join(os.tmpdir(),'stm32-auto-'));
 await fs.writeFile(path.join(source,'CMakeLists.txt'),'project(x C)\n');
 await fs.mkdir(path.join(source,'cmake'));
 await fs.writeFile(path.join(source,'cmake','gcc-arm-none-eabi.cmake'),'# toolchain\n');
 const service=new BuildService(tools(),()=>{},()=>{},never);
 const metadata=await service.presets(source,new AbortController().signal);
 assert.deepEqual(metadata.configure.map(item=>item.name),['auto-debug','auto-release']);
 assert.deepEqual(metadata.configure.map(item=>item.displayName),['Auto Debug','Auto Release']);
 const selection=metadata.resolve('auto-debug');
 assert.equal(selection.binaryDirectory,path.join(source,'build','Debug'));
 assert.ok(selection.configureArgs.includes(`-DCMAKE_TOOLCHAIN_FILE=${path.join(source,'cmake','gcc-arm-none-eabi.cmake').replace(/\\/g,'/')}`));
 assert.ok(selection.configureArgs.includes('-G'));
 assert.deepEqual(metadata.compatibleBuilds('auto-debug'),[]);
 await fs.rm(source,{recursive:true,force:true});
});
test('automatic presets fall back to selected ARM compilers',async()=>{
 const source=await fs.mkdtemp(path.join(os.tmpdir(),'stm32-auto-'));
 await fs.writeFile(path.join(source,'CMakeLists.txt'),'project(x C CXX)\n');
 const service=new BuildService(tools(),()=>{},()=>{},never);
 const selection=(await service.presets(source,new AbortController().signal)).resolve('auto-release');
 assert.equal(selection.binaryDirectory,path.join(source,'build','Release'));
 assert.ok(selection.configureArgs.includes('-DCMAKE_C_COMPILER=C:/fake/arm/bin/arm-none-eabi-gcc.exe'));
 assert.ok(selection.configureArgs.includes('-DCMAKE_CXX_COMPILER=C:/fake/arm/bin/arm-none-eabi-g++.exe'));
 assert.ok(selection.configureArgs.includes('-DCMAKE_SYSTEM_NAME=Generic'));
 await fs.rm(source,{recursive:true,force:true});
});
test('automatic presets require an ARM toolchain when no project toolchain exists',async()=>{
 const source=await fs.mkdtemp(path.join(os.tmpdir(),'stm32-auto-'));
 await fs.writeFile(path.join(source,'CMakeLists.txt'),'project(x C)\n');
 const service=new BuildService(tools({arm:false}),()=>{},()=>{},never);
 await assert.rejects(()=>service.presets(source,new AbortController().signal),/Arm GNU/);
 await fs.rm(source,{recursive:true,force:true});
});
