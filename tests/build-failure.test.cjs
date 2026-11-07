const test=require('node:test'),assert=require('node:assert/strict');
const {BuildFailureSummary}=require('../out/build/failureSummary');
const {BuildService}=require('../out/build/service');
const path=require('node:path');
const {repairForError}=require('../out/ui/presentation');
test('CubeMX2 QUOTE diagnostic preserves multiline reason and suggests CMake upgrade',()=>{
  const summary=new BuildFailureSummary();
  summary.append('stderr','CMake Error at cmake/components.cmake:79 (target_link_libraries):\n  Error evaluating generator expression:\n\n    $<QU');
  summary.append('stdout','-- Configuring done\n');
  summary.append('stderr','OTE>\n\n  Expression did not evaluate to a known generator expression\nCall Stack (most recent call first):\n  CMakeLists.txt:15 (include)\n');
  const result=summary.finish();
  assert.match(result,/CMake 3\.30/);assert.match(result,/\$<QUOTE>/);
  assert.match(result,/components\.cmake:79/);assert.match(result,/known generator expression/);
  assert.equal(repairForError(result),'tools');assert.equal(summary.finish(),result);
});
test('CMake missing source messages retain their explanation without an upgrade hint',()=>{
  const summary=new BuildFailureSummary();
  summary.append('stderr','CMake Error at CMakeLists.txt:12 (add_executable):\n  Cannot find source file:\n\n    missing.c');
  assert.match(summary.finish(),/Cannot find source file:[\s\S]*missing\.c/);
  assert.doesNotMatch(summary.finish(),/CMake 3\.30/);
});
test('CMake error context stays bounded even with excessive continuation lines',()=>{
  const summary=new BuildFailureSummary();
  summary.append('stderr','CMake Error: custom failure\n'+('  '+ 'x'.repeat(500)+'\n').repeat(2000));
  assert.ok(summary.finish().length<=1200);
});
test('Ninja long C5 link command does not obscure actual undefined symbols',()=>{
  const summary=new BuildFailureSummary();
  summary.append('stdout','[38/38] Linking C executable THM_C5_Framework.elf\nFAILED: THM_C5_Framework.elf\n'+ 'command '.repeat(2000)+'\n');
  summary.append('stdout','D:/tools/bin/ld.exe: generated/app.c.obj: undefined ref');
  summary.append('stderr','unrelated stderr output\n');
  summary.append('stdout',"erence to `vApplicationGetIdleTaskMemory'\ncollect2.exe: error: ld returned 1 exit status\nninja: build stopped: subcommand failed.\n");
  assert.equal(summary.finish(),"generated/app.c.obj: undefined reference to `vApplicationGetIdleTaskMemory'");
});
test('linker memory overflow and script diagnostics survive later build progress',()=>{
  const summary=new BuildFailureSummary();
  summary.append('stderr',"ld.exe: region `RAM' overflowed by 256 bytes\nld.exe: firmware.ld:42: syntax error\n");
  summary.append('stdout','[1/10] compile\n'.repeat(2000));
  assert.match(summary.finish(),/RAM.*overflowed/);assert.match(summary.finish(),/firmware.ld:42: syntax error/);
});
test('unknown errors keep final context and tolerate final unterminated lines',()=>{
  const summary=new BuildFailureSummary();summary.append('stdout','progress\ncustom build command failed');
  assert.match(summary.finish(),/custom build command failed/);
  summary.append('stderr',"ld.exe: cannot open linker script file c593.ld: No such file");
  assert.match(summary.finish(),/^cannot open linker script/);
});
test('CMake execution surfaces failure summary while streaming the complete log',async()=>{
  const logs=[],service=new BuildService([{id:'cmake',root:process.cwd(),executables:{cmake:path.resolve('cmake.exe')}}],(_s,text)=>logs.push(text),()=>{},async request=>{
    request.onOutput('stdout','[38/38] Linking\n'+ 'obj '.repeat(3000)+'\n');
    request.onOutput('stdout',"ld.exe: undefined reference to `HAL_GetTick'\nninja: build stopped: subcommand failed.\n");
    return {exitCode:1,reason:'exit',treeExited:true};
  });
  await assert.rejects(service.execute(process.cwd(),['--build','.'],new AbortController().signal),/CMake .*undefined reference to `HAL_GetTick'/);
  assert.ok(logs.join('').includes('obj '.repeat(3000)));
});
