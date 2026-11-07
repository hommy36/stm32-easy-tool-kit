// No hardware access: installs only into .cache and runs configuration + shutdown checks.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {loadC5Release}=require('../out/tools/catalog');
const {installRelease}=require('../out/tools/install');
const {checkInstallation}=require('../out/tools/check');
const {resolveDapConfiguration,buildFlashArgs}=require('../out/dap/config');
const {defaultProjectSettings}=require('../out/project/types');
const {verifyC5Files}=require('../out/dap/c5');
(async()=>{
 const release=loadC5Release(),signal=new AbortController().signal;
 const destination=await fs.mkdtemp(path.resolve('.cache/c5-installed-'));
 const tool=await installRelease(release,destination,signal,path.resolve(process.argv[2] || '.cache/c5-openocd.tar.gz'),{progress:console.log});
 await fs.writeFile('.cache/c5-installed-tool.json',JSON.stringify(tool,null,2));
 const checks=await checkInstallation(tool);assert.equal(checks.some(x=>x.status==='error'),false,JSON.stringify(checks));
 for(const probe of ['cmsis-dap','st-link','jlink']){
  const settings={...defaultProjectSettings(pathToFileURL(destination).href,destination),chipLabel:'STM32C593RET6',targetScript:'target/stm32c5x.cfg',chipConfirmed:true,probe};
  const config=await resolveDapConfiguration(settings,signal,{tools:[tool],guard(){},log(){},trustScript:async()=>true,verify:async()=>{}});
  const args=buildFlashArgs(settings,config.scriptsDirectory,path.resolve('.cache/firmware.elf'),config.dialect);
  assert.match(args.at(-1),/program .* verify reset exit/);
  console.log(probe+' config passed; '+config.dialect+'; flash command prepared only (not executed).');
 }
 const loader=path.join(tool.scriptsDirectory,'flash_loaders/stm32c5/STM32C59x_C5Ax.xldr');
 const original=await fs.readFile(loader);
 try {await fs.writeFile(loader,'changed');await assert.rejects(verifyC5Files(tool.scriptsDirectory)); console.log('Changed loader rejected.');}
 finally{await fs.writeFile(loader,original);}
 await verifyC5Files(tool.scriptsDirectory);
 console.log('Installation and software checks passed: '+tool.root);
})().catch(e=>{console.error(e);process.exitCode=1;});
