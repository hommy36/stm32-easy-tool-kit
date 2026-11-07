const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const {planMonitorSetup, applyMonitorSetup, planSamplingUpdate, applySamplingUpdate, monitorDefaults} = require('../out/runtime/setup');
const {validateFeatures} = require('../out/project/features');
const resources = path.resolve('resources/firmware');
const block = name => `/* USER CODE BEGIN ${name} */\n/* USER CODE END ${name} */`;
async function fixture(run, rtos=false) {
  const source=await fs.mkdtemp(path.join(os.tmpdir(),'stm32-setup-'));
  const main=path.join(source,'main.c'), cmake=path.join(source,'CMakeLists.txt');
  const text=`${block('Includes')}\nint main(void) { HAL_Init();\n${block('2')}\n${rtos?'osKernelStart();':''}\nwhile (1) {\n${block('3')}\n} }\n`;
  await fs.writeFile(main,text); await fs.writeFile(cmake,'project(app C)\nadd_executable(app main.c)\n');
  const target={name:'app',id:'app::id',configuration:'Debug',sourceFiles:[main],includeDirectories:[source],artifacts:[]};
  if(rtos){const file=path.join(source,'freertos.c');await fs.writeFile(file,block('Includes')+'\nvoid MX_FREERTOS_Init(void) {\n'+block('RTOS_THREADS')+'\n}\n');target.sourceFiles.push(file);await fs.writeFile(path.join(source,'FreeRTOSConfig.h'),'#define configSUPPORT_STATIC_ALLOCATION 1\n#define INCLUDE_vTaskDelay 1\n#define INCLUDE_xTaskGetSchedulerState 1\n');}
  try {await run({source,target,main,cmake,text});} finally {await fs.rm(source,{recursive:true,force:true});}
}
test('CubeMX bare integration previews all changes and preserves user content',()=>fixture(async f=>{
  const plan=await planMonitorSetup(f.source,f.target,resources);
  assert.equal(plan.mode,'bare');assert.equal(await fs.readFile(f.main,'utf8'),f.text);
  const main=plan.changes.find(c=>c.file===f.main);
  assert.ok(main.after.includes('stme_setup_start();'));assert.ok(main.after.includes('stme_setup_poll(HAL_GetTick());'));
  await applyMonitorSetup(plan);assert.equal(await fs.readFile(f.main,'utf8'),main.after);
  await assert.rejects(planMonitorSetup(f.source,f.target,resources),/already exists/);
}));
test('FreeRTOS integration uses scheduler hook and a static task without main-loop polling',()=>fixture(async f=>{
  const plan=await planMonitorSetup(f.source,f.target,resources);assert.equal(plan.mode,'freertos');
  assert.ok(!plan.changes.some(c=>c.file===f.main));
  const adapter=plan.changes.find(c=>c.file.endsWith('stm32_easy_setup.c')).after;
  assert.match(adapter,/xTaskCreateStatic/);assert.match(adapter,/monitor_stack\[512\]/);assert.match(adapter,/vPortGetHeapStats/);
  assert.doesNotMatch(adapter,/xTaskCreate\(|configTOTAL_HEAP_SIZE/);
  await applyMonitorSetup(plan);
},true));
test('custom CMSIS-RTOS init without CubeMX markers inserts monitor after existing task creation',()=>fixture(async f=>{
  const file=f.target.sourceFiles.find(name=>name.endsWith('freertos.c'));
  const source='#include "FreeRTOS.h"\n#include "cmsis_os.h"\nvoid MX_FREERTOS_Init(void) {\n  osThreadNew(StartTask, NULL, NULL);\n  const char *brace = "}"; /* } is not the function end */\n  if (1) { osThreadNew(OtherTask, NULL, NULL); }\n}\n';
  await fs.writeFile(file,source);
  const plan=await planMonitorSetup(f.source,f.target,resources), change=plan.changes.find(item=>item.file===file);
  assert.equal(plan.mode,'freertos');assert.ok(change.after.startsWith('#include "stm32_easy_setup.h"\n'));
  assert.ok(change.after.indexOf('osThreadNew(OtherTask')<change.after.indexOf('stme_setup_start();'));
  assert.ok(change.after.includes('const char *brace = "}"; /* } is not the function end */'));
  await applyMonitorSetup(plan);
},true));
test('unsupported static task config and ambiguous user markers do not modify files',async()=>{
  await fixture(async f=>{await fs.writeFile(path.join(f.source,'FreeRTOSConfig.h'),'#define configSUPPORT_STATIC_ALLOCATION 0\n');await assert.rejects(planMonitorSetup(f.source,f.target,resources),/standard CubeMX/);assert.equal(await fs.readFile(f.main,'utf8'),f.text);},true);
  await fixture(async f=>{await fs.appendFile(f.main,block('3'));await assert.rejects(planMonitorSetup(f.source,f.target,resources),/standard CubeMX/);});
});
test('preview conflicts reject the entire apply before changing any files',()=>fixture(async f=>{
  const plan=await planMonitorSetup(f.source,f.target,resources);await fs.appendFile(f.cmake,'# concurrent edit\n');
  await assert.rejects(applyMonitorSetup(plan),/changed after preview/);
  assert.equal(await fs.readFile(f.main,'utf8'),f.text);
  await assert.rejects(fs.stat(path.join(f.source,'stm32-easy-monitor')), {code:'ENOENT'});
}));
test('failed new-file write rolls back only this transaction and removes its lock',()=>fixture(async f=>{
  const plan=await planMonitorSetup(f.source,f.target,resources);
  plan.changes.push(plan.changes.find(c=>c.before===undefined)); // exclusive create fails after earlier edits
  await assert.rejects(applyMonitorSetup(plan),{code:'EEXIST'});
  assert.equal(await fs.readFile(f.main,'utf8'),f.text);
  await assert.rejects(fs.stat(path.join(f.source,'.stm32-easy-monitor.lock')),{code:'ENOENT'});
  await assert.rejects(fs.stat(path.join(f.source,'stm32-easy-monitor')),{code:'ENOENT'});
}));
test('unsafe target names and source files outside the project cannot be integrated',()=>fixture(async f=>{
  await assert.rejects(planMonitorSetup(f.source,{...f.target,name:'app); execute_process(bad)'},resources));
  await assert.rejects(planMonitorSetup(f.source,{...f.target,sourceFiles:[path.resolve('test/Core/Src/main.c')]},resources),/inside the project/);
}));
test('automatic defaults preserve unrelated configuration and never infer cache coherence',()=>{
  const original={version:1,memory:{budgets:{RAM:1024}},debug:{svd:'chip.svd'},tools:{cmake:'3.28'},runtime:{enabled:false,firmwareId:'old',address:3}};
  const saved=monitorDefaults(original,{firmwareId:'from-elf',address:0x20001000});
  assert.equal(saved.runtime.firmwareId,'from-elf');assert.equal(saved.runtime.autoDetect,true);assert.equal(saved.runtime.cacheCoherent,false);
  assert.deepEqual(saved.debug,original.debug);assert.deepEqual(saved.memory,original.memory);assert.deepEqual(saved.tools,original.tools);
  assert.equal(original.runtime.enabled,false);validateFeatures(saved);
  assert.throws(()=>validateFeatures({...saved,runtime:{...saved.runtime,autoDetect:'yes'}}));
  for(const period of [100,200,500,1000])validateFeatures({...saved,runtime:{...saved.runtime,samplePeriodMs:period}});
  for(const period of [0,50,250,'100',null])assert.throws(()=>validateFeatures({...saved,runtime:{...saved.runtime,samplePeriodMs:period}}));
});
test('RTT control-block scan window matches the 32-bit RTT header and one descriptor',()=>{
  const identity={firmwareId:'probe',address:0x20000000};
  assert.equal(monitorDefaults({version:1},identity).runtime.searchBytes,48);
  assert.ok(identity.address%4===0);
});
test('heap sampling update changes only the generated target definition and replaces prior rates',()=>fixture(async f=>{
  await fs.writeFile(f.cmake,[
    'project(app C)',
    'add_executable(app main.c)',
    '# STM32 Easy Monitor (remove this block to unlink the component)',
    'include("stm32-easy-monitor/stm32_easy_setup.cmake")',
    'stm32_easy_setup(app)'
  ].join('\n')+'\n');
  const directory=path.join(f.source,'stm32-easy-monitor');await fs.mkdir(directory);
  await fs.writeFile(path.join(directory,'stm32_easy_setup.c'),'const char stme_firmware_id[] = "test";\n');
  await fs.writeFile(path.join(directory,'stm32_easy_setup.cmake'),'stm32_easy_monitor('+'$'+'{target})\n');
  const first=await planSamplingUpdate(f.source,'app',200);
  assert.match(first.after,/stm32_easy_setup\(app\)\r?\ntarget_compile_definitions\(app PRIVATE STME_HEAP_PERIOD_MS=200\)/);
  await applySamplingUpdate(f.source,first);
  const second=await planSamplingUpdate(f.source,'app',100);
  assert.match(second.after,/STME_HEAP_PERIOD_MS=100/);assert.doesNotMatch(second.after,/STME_HEAP_PERIOD_MS=200/);
  await applySamplingUpdate(f.source,second);
  assert.equal(await fs.readFile(f.cmake,'utf8'),second.after);
}));
test('sampling update rejects manual integration and stale preview changes',()=>fixture(async f=>{
  await fs.writeFile(f.cmake,'project(app C)\nadd_executable(app main.c)\n');
  await assert.rejects(planSamplingUpdate(f.source,'app',200));
  const dir=path.join(f.source,'stm32-easy-monitor');await fs.mkdir(dir);
  await fs.writeFile(path.join(dir,'stm32_easy_setup.c'),'const char stme_firmware_id[] = "test";');
  await fs.writeFile(path.join(dir,'stm32_easy_setup.cmake'),'stm32_easy_monitor('+'$'+'{target})');
  await fs.writeFile(f.cmake,[
    'project(app C)',
    'add_executable(app main.c)',
    '# STM32 Easy Monitor (remove this block to unlink the component)',
    'stm32_easy_setup(app)'
  ].join('\n')+'\n');
  const change=await planSamplingUpdate(f.source,'app',500);await fs.appendFile(f.cmake,'# concurrent change\n');
  await assert.rejects(applySamplingUpdate(f.source,change),/changed after preview/);
}));
