const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
module.exports=async({evaluate,send,cdp,state,report,width,lang,style,directory})=>{
 await evaluate('document.getElementById("tab-0").click();document.getElementById("tree-accessible").open=true');
 for(let depth=0;depth<6;depth++){
  if(await evaluate('!document.getElementById("hex-view").hidden'))break;
  await evaluate('document.querySelector("#tree-list button").click()');
 }
 assert.equal(await evaluate('document.getElementById("hex-view").hidden'),false,'list drill reaches a symbol');
 let request=await evaluate('sent.filter(m=>m.type==="hex").at(-1)');assert.equal(request.context,state.context);assert.equal(request.offset,0);
 const page={symbolId:request.id,name:'verified_symbol',section:'.text',address:0x8000000,loadAddress:0x8000000,total:520,offset:0,bytes:Array.from({length:256},(_,i)=>i),storage:'elf'};
 await send({type:'hex',reportId:report.id,request:request.request,page});
 assert.equal(await evaluate('document.querySelectorAll(".hex-byte").length'),256);
 assert.ok(await evaluate('document.querySelector(".hex-ascii").textContent.length===16'));
 await evaluate('document.querySelector(".hex-byte").click()');assert.ok(await evaluate('document.getElementById("hex-selection").textContent.includes("HEX 00")'));
 await evaluate('document.getElementById("hex-next").click()');request=await evaluate('sent.filter(m=>m.type==="hex").at(-1)');assert.equal(request.offset,256);
 await send({type:'hex',reportId:report.id,request:request.request-1,page});assert.equal(await evaluate('document.querySelectorAll(".hex-byte").length'),0,'stale replies discarded');
 await send({type:'hex',reportId:report.id,request:request.request,page:{...page,offset:256}});
 await evaluate('document.getElementById("hex-jump").value="0x08000204";document.getElementById("hex-jump-form").dispatchEvent(new Event("submit",{cancelable:true}))');
 request=await evaluate('sent.filter(m=>m.type==="hex").at(-1)');assert.equal(request.offset,512);
 await send({type:'hex',reportId:report.id,request:request.request,page:{...page,offset:512,bytes:[1,2,3,4,65,66,67,68]}});
 assert.ok(await evaluate('document.getElementById("hex-selection").textContent.includes("HEX 41")'));assert.equal(await evaluate('document.getElementById("hex-next").disabled'),true);
 assert.ok(await evaluate('document.documentElement.scrollWidth<=window.innerWidth+2'),'HEX must fit '+[lang,style,width]);
 await evaluate('document.getElementById("hex-previous").click()');request=await evaluate('sent.filter(m=>m.type==="hex").at(-1)');assert.equal(request.offset,256);
 await send({type:'hex',reportId:report.id,request:request.request,page:{...page,offset:256}});
 const screenshot=async name=>{await evaluate('document.getElementById("memory-explorer").scrollIntoView()');await new Promise(r=>setTimeout(r,320));const shot=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(directory,lang+'-'+style+'-'+name+'.png'),Buffer.from(shot.data,'base64'));};
 if(width===1280){
  // Screenshots use real file bytes when the local F4 fixture is available.
  try {
   const {ElfByteReader}=require('../out/memory/hex');
   const symbol=report.symbols.find(s=>s.size>=256&&s.section==='.text'&&!s.alias);
   const section=report.sections.find(s=>s.name===symbol.section);
   const actual=await new ElfByteReader().read(path.resolve('test',report.artifact),report.artifactSha256,section,symbol,0);
   await evaluate('document.getElementById("tab-1").click();document.getElementById("search").value="";document.getElementById("search").dispatchEvent(new Event("input"))');
   await new Promise(r=>setTimeout(r,200));const symbolRequest=await evaluate('sent.filter(m=>m.type==="symbols").at(-1)');
   await send({type:'symbols',reportId:report.id,request:symbolRequest.request,page:0,total:1,rows:[symbol]});
   await evaluate('document.querySelector("#symbols .hex-link").click()');request=await evaluate('sent.filter(m=>m.type==="hex").at(-1)');
   assert.equal(request.id,symbol.id);await send({type:'hex',reportId:report.id,request:request.request,page:actual});
  } catch(error){if(error.code!=='ENOENT')throw error;}
  await screenshot('hex');
 }
 await send({...state,phase:'stale'});assert.equal(await evaluate('document.querySelectorAll(".hex-byte").length'),0,'stale report clears bytes');
 await send(state);await evaluate('document.getElementById("tree-reset").click()');
 for(let zoom=0;zoom<16;zoom++){
  if(await evaluate('!document.getElementById("hex-view").hidden'))break;
  await evaluate('document.getElementById("tree-zoom-in").click()');
 }
 assert.equal(await evaluate('document.getElementById("hex-view").hidden'),false,'repeated zoom reaches HEX');request=await evaluate('sent.filter(m=>m.type==="hex").at(-1)');
 await send({type:'hex',reportId:report.id,request:request.request,page:{...page,symbolId:request.id,storage:'nobits',bytes:[]}});
 assert.equal(await evaluate('document.querySelectorAll(".hex-byte").length'),0);assert.equal(await evaluate('document.getElementById("hex-next").disabled'),true);
 await evaluate('document.getElementById("tree-back").click()');assert.equal(await evaluate('document.getElementById("hex-view").hidden'),true);
 if(width===1280)await screenshot('symbols');
 if(width===1280){
  // Exercise browser mouse events rather than invoking explorer methods.
  const bounds=await evaluate('(()=>{const r=document.getElementById("treemap").getBoundingClientRect();return {x:r.left+70,y:r.top+60};})()');
  await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...bounds});
  for(let i=0;i<5;i++)await cdp('Input.dispatchMouseEvent',{type:'mouseWheel',...bounds,deltaX:0,deltaY:-100});
  assert.equal(await evaluate('document.getElementById("hex-view").hidden'),false,'wheel zoom on symbol reaches HEX');
  await evaluate('document.getElementById("tree-back").click()');
  await evaluate('document.getElementById("memory-explorer").scrollIntoView()');await new Promise(r=>setTimeout(r,320));
  const clickPoint=await evaluate('(()=>{const r=document.getElementById("treemap").getBoundingClientRect();return {x:r.left+70,y:r.top+60};})()');
  await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...clickPoint});
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...clickPoint,button:'left',clickCount:1});
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...clickPoint,button:'left',clickCount:1});
  assert.equal(await evaluate('document.getElementById("hex-view").hidden'),false,'clicking a chart symbol reaches HEX');
 }
};
