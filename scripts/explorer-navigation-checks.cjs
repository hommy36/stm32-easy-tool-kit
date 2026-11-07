const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
module.exports=async({evaluate,cdp,width,lang,style,directory})=>{
 const depth=()=>evaluate('document.querySelectorAll("#tree-breadcrumb .crumb").length');
 const click=async id=>{await evaluate('document.getElementById('+JSON.stringify(id)+').click()');};
 await click('tree-reset');await wait(300);
 assert.equal(await depth(),1);
 assert.equal(await evaluate('document.getElementById("tree-zoom-out").disabled'),true);
 assert.equal(await evaluate('document.getElementById("memory-summary").open'),false);
 await evaluate('document.getElementById("memory-summary").open=true');
 assert.ok(await evaluate('document.getElementById("regions").getBoundingClientRect().height>0'));
 await evaluate('document.getElementById("memory-summary").open=false');
 await click('tree-zoom-in');
 assert.equal(await evaluate('document.getElementById("tree-zoom-level").textContent'),'135%');
 assert.equal(await evaluate('echarts.getInstanceByDom(document.getElementById("treemap")).getZr().animation.isFinished()'),false,'zoom animates chart geometry');
 await wait(260);
 assert.equal(await evaluate('echarts.getInstanceByDom(document.getElementById("treemap")).getZr().animation.isFinished()'),true,'zoom animation completes');
 await click('tree-zoom-out');
 assert.equal(await evaluate('document.getElementById("tree-zoom-level").textContent'),'100%');
 assert.equal(await depth(),1);
 // At every layer, minus must undo drilldown rather than stopping at 100%.
 await evaluate('document.querySelector("#tree-list button").click()');
 assert.equal(await depth(),2);
 assert.ok(await evaluate('document.getElementById("treemap").getAnimations().length>0'),'drilldown has a visible transition');
 await click('tree-zoom-out');assert.equal(await depth(),1);
 for(let i=0;i<15;i++){if(await evaluate('!document.getElementById("hex-view").hidden'))break;await click('tree-zoom-in');}
 assert.equal(await evaluate('document.getElementById("hex-view").hidden'),false);
 const hexDepth=await depth();assert.equal(await evaluate('document.getElementById("tree-zoom-out").hidden'),false);
 await click('tree-zoom-out');assert.equal(await depth(),hexDepth-1);
 assert.equal(await evaluate('document.getElementById("hex-view").hidden'),true);
 for(let i=0;i<8;i++){if(await depth()===1)break;await click('tree-zoom-out');}
 assert.equal(await depth(),1);
 // Expanded view is reversible and preserves navigation; it uses editor height.
 const originalHeight=await evaluate('document.getElementById("treemap").getBoundingClientRect().height');
 await click('tree-expand');await wait(320);
 assert.equal(await evaluate('document.getElementById("tree-expand").getAttribute("aria-pressed")'),'true');
 assert.ok(await evaluate('document.getElementById("treemap").getBoundingClientRect().height')>originalHeight);
 assert.ok(await evaluate('(()=>{const c=echarts.getInstanceByDom(document.getElementById("treemap")),s=c.getModel().getSeriesByIndex(0),root=s.getViewRoot(),h=c.getHeight(),bottom=Math.max(...root.children.map(n=>{const l=n.getLayout();return l.y+l.height;}));return Math.abs(bottom-h)<35;})()'),'expanded chart fills the canvas height');
 assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+2'));
 if(width===1280){const shot=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(directory,lang+'-'+style+'-expanded.png'),Buffer.from(shot.data,'base64'));}
 await evaluate('document.getElementById("tree-expand").focus()');await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 assert.equal(await evaluate('document.getElementById("tree-expand").getAttribute("aria-pressed")'),'false');
 assert.equal(await depth(),1);
 // Actual wheel events: smoothly zoom in/out, then leave the current layer.
 await evaluate('document.querySelector("#tree-list button").click();document.getElementById("treemap").scrollIntoView({block:"center"})');await wait(320);
 const point=await evaluate('(()=>{const r=document.getElementById("treemap").getBoundingClientRect();return {x:r.left+70,y:Math.max(50,r.top+70)};})()');
 await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
 await cdp('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:-60});await wait(130);
 assert.ok(parseInt(await evaluate('document.getElementById("tree-zoom-level").textContent'))>100);
 await cdp('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:100});await wait(150);
 assert.equal(await evaluate('document.getElementById("tree-zoom-level").textContent'),'100%');
 await cdp('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:100});await wait(320);
 assert.equal(await depth(),1,'reverse wheel returns to parent');
 // Root scrolling is not trapped after the view is fully zoomed out.
 assert.equal(await evaluate('document.getElementById("treemap").dispatchEvent(new WheelEvent("wheel",{deltaY:100,cancelable:true}))'),true);
 if(width===1280){
  await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await evaluate('document.querySelector("#tree-list button").click()');
  assert.equal(await evaluate('document.getElementById("treemap").getAnimations().length'),0);
  assert.equal(await evaluate('echarts.getInstanceByDom(document.getElementById("treemap")).getOption().animation'),false);
  await cdp('Emulation.setEmulatedMedia',{features:[]});await click('tree-reset');await wait(300);
 }
};
