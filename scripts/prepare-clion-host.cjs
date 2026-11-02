// Run real-smoke.cjs <active-records> --clion first. Creates only isolated test data under .cache.
const fs=require('node:fs/promises'),path=require('node:path');
(async()=>{
  const root=path.resolve('.cache/clion-host-profile'),user=path.join(root,'User');
  const storage=path.join(user,'globalStorage/local-stm32-tools.stm32-easy-tool-kit');
  const result=JSON.parse(await fs.readFile('.cache/release-smoke-latest.json','utf8')),source=result.source;
  if(!result.clion || !path.resolve(source).startsWith(path.resolve('.cache')+path.sep))throw Error('Run the isolated CLion real smoke test first');
  await fs.mkdir(user,{recursive:true});
  await fs.writeFile(path.join(user,'settings.json'),JSON.stringify({'security.workspace.trust.enabled':false,'workbench.startupEditor':'none','window.title':'CLion Import Verification','workbench.colorTheme':'Default Dark Modern'}));
  await fs.mkdir(path.join(storage,'active'),{recursive:true});
  for(const id of ['armGnu','cmake','ninja'])await fs.copyFile(path.join(result.root,'active',id+'.json'),path.join(storage,'active',id+'.json'));
  await fs.mkdir(path.join(source,'.run'),{recursive:true});
  await fs.writeFile(path.join(source,'board.cfg'),'source [find interface/cmsis-dap.cfg]\nsource [find target/stm32f4x.cfg]\nreset_config none\nadapter speed 2000\n');
  await fs.writeFile(path.join(source,'.run/probe.run.xml'),'<component name="ProjectRunConfigurationManager"><configuration name="Probe" type="com.jetbrains.cidr.embedded.openocd.conf.type" CONFIG_NAME="Debug" TARGET_NAME="firmware"><openocd board-config="$PROJECT_DIR$/board.cfg" reset-type="INIT" download-type="UPDATED_ONLY"/></configuration></component>');
  const version=JSON.parse(await fs.readFile('package.json','utf8')).version;
  await fs.writeFile('.cache/clion-host-context.json',JSON.stringify({version,source,storage,output:result.root},null,2));
  console.log(JSON.stringify({source,root,storage}));
})().catch(error=>{console.error(error);process.exitCode=1});
