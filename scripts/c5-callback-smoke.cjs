// Software-only: memory reads/writes and stldr binding are replaced before callbacks run.
const assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {c5EventScopeCommand,verifyC5Files}=require('../out/dap/c5');
(async()=>{
 const root=path.resolve(process.argv[2]||'.cache/c5-runtime'),scripts=path.join(root,'openocd/scripts'),exe=path.join(root,'bin/openocd.exe');
 await verifyC5Files(scripts);
 for(const [id,kib,loader] of [['0x44F',128,'STM32C53x_C54x.xldr'],['0x44E',512,'STM32C55x_C56x.xldr'],['0x45A',512,'STM32C59x_C5Ax.xldr']]){
  for(const patched of [false,true]){
   const mock=`
proc stm32c5x_dbgmcu_mmw {args} {}
proc stm32c5x_mrw {args} {return ${id}}
proc mrh {args} {return ${kib}}
rename stldr actual_stldr
set bindings {}
proc stldr {args} {global bindings; lappend bindings $args}
proc simulate_event {} {eval [stm32c5x.cpu cget -event examine-end]}
simulate_event
if {[llength $bindings] != 2} {error {loader not bound}}
if {[lindex [lindex $bindings 0] 0] ne {set_loader}} {error {wrong binding command}}
if {[lindex [lindex $bindings 0] 1] ne {stm32c5x.flash}} {error {wrong bank}}
if {[file tail [lindex [lindex $bindings 0] 2]] ne {${loader}}} {error {wrong loader}}
if {[lindex $bindings 1] ne {set_size stm32c5x.flash ${kib*1024}}} {error {wrong size}}
simulate_event
if {[llength $bindings] != 2} {error {unexpected rebind}}
echo C5_CALLBACK_PASS
`;
   const result=spawnSync(exe,['-s',scripts,'-c','adapter driver cmsis-dap','-c','transport select swd','-f','target/stm32c5x.cfg',...(patched?['-c',c5EventScopeCommand]:[]),'-c',mock,'-c','shutdown'],{windowsHide:true,encoding:'utf8',timeout:10000});
   if(result.error)throw result.error;
   const output=result.stdout+result.stderr;
   if(patched){assert.equal(result.status,0,output);assert.match(output,/C5_CALLBACK_PASS/);}
   else{assert.notEqual(result.status,0);assert.match(output,/can't read "_CHIPNAME"/);}
   console.log(id+' '+(patched?'fixed callback: correct loader, size and repeat behavior':'original callback: reported failure reproduced'));
  }
 }
 console.log('No init, probe access, hardware memory operations or programming performed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
