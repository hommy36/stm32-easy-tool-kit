const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),yauzl=require('yauzl');
async function main(){
  const version=JSON.parse(await fs.readFile('package.json','utf8')).version;
  const file=path.resolve(process.argv[2]||`stm32-easy-tool-kit-${version}.vsix`),entries=new Map();
  await new Promise((resolve,reject)=>yauzl.open(file,{lazyEntries:true},(error,zip)=>{
    if(error)return reject(error);zip.on('error',reject);zip.on('end',resolve);
    zip.on('entry',entry=>{
      if(entry.fileName.endsWith('/'))return zip.readEntry();
      zip.openReadStream(entry,(error,stream)=>{if(error)return reject(error);const chunks=[];stream.on('error',reject);stream.on('data',chunk=>chunks.push(chunk));stream.on('end',()=>{entries.set(entry.fileName,Buffer.concat(chunks));zip.readEntry();});});
    });zip.readEntry();
  }));
  for(const [name,content] of entries){
    assert.equal(/^extension\/(?:\.cache|src|tests|scripts|\.codex|\.agents)\//.test(name),false,name);
    if(/\.(?:js|json|md|html|css|svg|xml)$/.test(name))assert.equal(/C:[\\/]+Users[\\/]+32460|D:[\\/]+AI[\\/]+AI_program|D:[\\/]+RoboMaster/i.test(content.toString('utf8')),false,name+' contains a local development path');
  }
  assert.equal(JSON.parse(entries.get('extension/package.json').toString()).version,version);
  for(const name of ['out/project/shared.js','out/project/targetDetection.js','out/integration/clionImport.js','docs/project-configuration.md','docs/clion-compatibility.md'])assert.ok(entries.has('extension/'+name),name);
  const result={version,files:entries.size,bytes:(await fs.stat(file)).size,sha256:crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'),excludedDevelopmentFiles:true,noPersonalDevelopmentPaths:true};
  await fs.writeFile('.cache/vsix-audit-latest.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
