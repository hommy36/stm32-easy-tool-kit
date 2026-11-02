// Isolated native UI driver. It only opens settings and verifies files after the tester clicks Save.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),vscode=require('vscode');
exports.activate=async()=>{
  try{
    const context=JSON.parse(await fs.readFile(path.resolve(__dirname,'../../.cache/shared-host-context.json'),'utf8'));
    const extension=vscode.extensions.getExtension('local-stm32-tools.stm32-easy-tool-kit');assert.equal(extension.packageJSON.version,context.version);await extension.activate();
    await vscode.commands.executeCommand('stm32Easy.project.focus');await vscode.commands.executeCommand('stm32Easy.workbench.settings');
    const file=path.join(context.source,'.vscode/stm32-easy.json');
    let config;
    for(let n=0;n<360;n++){
      try{config=JSON.parse(await fs.readFile(file,'utf8'));if(config.targetScript?.path==='target/stm32h7x.cfg')break;}catch(error){if(error.code!=='ENOENT')throw error;}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert.equal(config?.targetScript?.path,'target/stm32h7x.cfg');assert.equal(config.chipLabel,'STM32H723VGT6');
    const text=JSON.stringify(config);for(const key of ['tools','executables','chipConfirmed','serial','projectUri','artifactPath'])assert.equal(text.includes('"'+key+'"'),false);
    assert.equal(text.includes(':\\'),false);
    const {ProjectStore}=require(path.join(extension.extensionPath,'out/project/store'));
    const teammate=await new ProjectStore(path.join(context.output,'teammate-local')).read(vscode.Uri.file(context.source).toString());
    assert.equal(teammate.settings.shareInProject,true);assert.equal(teammate.settings.chipConfirmed,false);assert.equal(teammate.settings.targetScript,'target/stm32h7x.cfg');
    await fs.writeFile(path.join(context.output,'shared-host-result.json'),JSON.stringify({version:extension.packageJSON.version,actualSave:true,automaticTarget:true,sharedFieldsOnly:true,freshLocalStoreReadsProject:true,hardwareTested:false},null,2));
  }catch(error){await fs.writeFile(path.resolve(__dirname,'../../.cache/shared-host-error.log'),String(error.stack));}
};
