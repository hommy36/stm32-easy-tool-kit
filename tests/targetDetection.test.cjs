const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
require('../out/i18n').setLanguage('en');
const {detectChipTargets,targetForChip}=require('../out/project/targetDetection');
const {defaultProjectSettings}=require('../out/project/types');
const {resolveDapConfiguration,scriptFingerprint}=require('../out/dap/config');
const {pathToFileURL}=require('node:url');
async function fixture(){const root=await fs.mkdtemp(path.resolve('.cache/target-test-')),source=path.join(root,'source'),scripts=path.join(root,'scripts');await fs.mkdir(source);await fs.mkdir(path.join(scripts,'target'),{recursive:true});return{root,source,scripts};}
test('family mapping handles L0/L1 names, H7RS separately, and does not guess unsupported devices',()=>{
  for(const [chip,file] of [['STM32F407VET6','stm32f4x.cfg'],['STM32H723VGT6','stm32h7x.cfg'],['STM32H7R7L8H6','stm32h7rsx.cfg'],['STM32L053R8','stm32l0.cfg'],['STM32L152RE','stm32l1.cfg'],['STM32WB55RG','stm32wbx.cfg']])assert.equal(targetForChip(chip),'target/'+file);
  assert.equal(targetForChip('STM32MP157'),undefined);assert.equal(targetForChip('some-board'),undefined);
});
test('IOC chip and installed canonical target are matched without choosing dual-bank alternatives',async()=>{
  const f=await fixture();await fs.writeFile(path.join(f.source,'board.ioc'),'Mcu.CPN=STM32H723VGT6\n');
  await fs.writeFile(path.join(f.scripts,'target/stm32h7x.cfg'),'');await fs.writeFile(path.join(f.scripts,'target/stm32h7x_dual_bank.cfg'),'');
  const choices=await detectChipTargets(f.source,f.scripts);assert.equal(choices.length,1);assert.equal(choices[0].targetScript,'target/stm32h7x.cfg');assert.equal(choices[0].available,true);assert.equal(choices[0].label,'STM32H723VGT6');
});
test('CMake and startup/linker names work without IOC; SDK directories are not scanned',async()=>{
  const f=await fixture();await fs.writeFile(path.join(f.source,'CMakeLists.txt'),'target_compile_definitions(fw PRIVATE STM32F407xx)');
  await fs.writeFile(path.join(f.source,'startup_stm32f407xx.s'),'');await fs.mkdir(path.join(f.source,'Drivers'));await fs.writeFile(path.join(f.source,'Drivers/other.h'),'STM32H723');
  await fs.writeFile(path.join(f.scripts,'target/stm32f4x.cfg'),'');
  const choices=await detectChipTargets(f.source,f.scripts);assert.equal(choices.length,1);assert.ok(choices[0].evidence.includes('startup_stm32f407xx.s'));
});
test('conflicting families and missing installed scripts remain explicit candidates',async()=>{
  const f=await fixture();await fs.writeFile(path.join(f.source,'board.ioc'),'Mcu.CPN=STM32H7R7L8H6');await fs.writeFile(path.join(f.source,'CMakeLists.txt'),'STM32F407xx');await fs.writeFile(path.join(f.scripts,'target/stm32f4x.cfg'),'');
  const choices=await detectChipTargets(f.source,f.scripts);assert.equal(choices.length,2);assert.equal(choices.find(x=>x.label.startsWith('STM32H7')).available,false);
});
test('approved script fingerprint is checked before probing or opening hardware',async()=>{
  const f=await fixture(),script=path.join(f.scripts,'target/stm32f4x.cfg');await fs.writeFile(script,'reset_config none');let probes=0;
  const settings={...defaultProjectSettings(pathToFileURL(f.source).toString(),f.source),chipConfirmed:true,targetScript:'target/stm32f4x.cfg'};
  const runtime={tools:[{id:'openocd',executables:{openocd:path.join(f.root,'openocd.exe')},scriptsDirectory:f.scripts}],guard(){},log(){},trustScript:async()=>true,verify:async()=>{},
    approvedScript:{file:script,sha256:await scriptFingerprint(script)},probe:async()=>{probes++;return{exitCode:0,timedOut:false,cancelled:false};}};
  await fs.writeFile(script,'changed after confirmation');await assert.rejects(resolveDapConfiguration(settings,new AbortController().signal,runtime),/changed during confirmation/);assert.equal(probes,0);
});
