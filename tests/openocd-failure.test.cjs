const test=require('node:test'),assert=require('node:assert/strict');
const {openocdFailureSummary}=require('../out/dap/failure');
test('OpenOCD Tcl cause survives banner, long installed paths and repeated event errors',()=>{
 const output='xPack Open On-Chip Debugger\n'+ 'Info : CMSIS-DAP: supported\n'.repeat(100)
  +'Error: [stm32c5x.cpu] Execution of event examine-end failed:\n'
  +'C:/'+ 'long-package/'.repeat(40) +'stm32c5x.cfg:142: Error: can\'t read "_CHIPNAME": no such variable\n'
  +'Error: Please check if you have set correctly the loader file\nError: auto_probe failed\n** Programming Failed **\n'
  +'Error: auto_probe failed\nembedded:startup.tcl:1893: Error: \n';
 const summary=openocdFailureSummary(output);
 assert.match(summary.slice(0,100),/can't read "_CHIPNAME"/);assert.doesNotMatch(summary,/xPack|Info :|long-package/);
 assert.equal(summary.match(/auto_probe failed/g).length,1);
});
test('OpenOCD fallback preserves last context when no Error line is present',()=>{
 assert.equal(openocdFailureSummary('banner\ncustom adapter failure\n').split('\n').at(-1),'custom adapter failure');
 assert.match(openocdFailureSummary('Error : unable to connect\n'),/unable to connect/);
});
