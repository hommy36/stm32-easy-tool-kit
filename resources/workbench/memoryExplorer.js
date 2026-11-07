/* Packaged UI; all byte data arrives from the verified active ELF through the host. */
(() => {
  const f=key=>window.featureMessages[key]??key;
  const $=id=>document.getElementById(id);
  const bytes=n=>n<1024?n+' B':(n/1024).toLocaleString(undefined,{maximumFractionDigits:2})+' KiB';
  const hex=n=>'0x'+n.toString(16).toUpperCase().padStart(8,'0');
  const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
  const palette=name=>{const upper=name.toUpperCase();if(/FLASH|ROM/.test(upper))return '#4C96E8';if(/DTCM/.test(upper))return '#D69A42';if(/CCM|ITCM/.test(upper))return '#A28BE0';if(/AXI/.test(upper))return '#7D99EF';if(/RAM|SRAM/.test(upper))return '#3AAF9D';let hash=0;for(const c of name)hash=(hash*31+c.charCodeAt(0))>>>0;return ['#4C96E8','#3AAF9D','#D69A42','#A28BE0','#D880A7'][hash%5];};
  const blend=(a,b,t)=>'#'+[1,3,5].map(i=>Math.round(parseInt(a.slice(i,i+2),16)*(1-t)+parseInt(b.slice(i,i+2),16)*t).toString(16).padStart(2,'0')).join('');
  class MemoryExplorer {
    constructor(api,context,filter){
      this.api=api;this.context=context;this.filter=filter;this.focus=[];this.index=new Map();this.request=0;this.pageOffset=0;this.zoom=1;this.origin={x:.5,y:.5};this.motion=matchMedia('(prefers-reduced-motion: reduce)');
      this.chart=window.echarts?.init($('treemap'),null,{renderer:'canvas'});
      this.chart?.on('click',info=>{if(info.data?.id)this.enter(info.data.id);});
      this.chart?.on('mouseover',info=>{const item=this.index.get(info.data?.id);this.hovered=item?.id;if(item)this.describe(item);});
      this.chart?.on('mouseout',()=>{this.hovered=undefined;this.describe(this.current());});
      $('treemap').addEventListener('wheel',e=>this.wheel(e),{passive:false,capture:true});
      $('hex-view').addEventListener('wheel',e=>{if(e.ctrlKey&&e.deltaY>0){e.preventDefault();this.back();}},{passive:false});
      $('tree-back').onclick=()=>this.back();$('tree-reset').onclick=()=>this.reset();
      for(const [id,value] of [['tree-zoom-in','+'],['tree-zoom-out','−']]){const b=$(id);b.title=b.textContent;b.setAttribute('aria-label',b.textContent);b.textContent=value;}
      $('tree-zoom-in').onclick=()=>this.changeZoom(1.35);$('tree-zoom-out').onclick=()=>this.changeZoom(1/1.35);
      $('tree-details').onclick=()=>{this.expand(false);this.filter(this.current()?.region??'',true);};
      $('tree-expand').onclick=()=>this.expand(!this.expanded);
      $('hex-previous').onclick=()=>this.readHex(Math.max(0,this.pageOffset-256));
      $('hex-next').onclick=()=>this.readHex(this.pageOffset+256);
      $('hex-jump-form').onsubmit=e=>{e.preventDefault();const value=$('hex-jump').value.trim();if(!/^0x[\da-f]+$/i.test(value)){this.hexError('Enter a hexadecimal address beginning with 0x.');return;}const address=Number(value),start=this.hexPage?.address;if(start===undefined||address<start||address>=start+this.hexPage.total){this.hexError('Address is outside this symbol.');return;}this.pendingAddress=address;this.readHex(Math.floor((address-start)/256)*256);};
      $('memory-explorer').addEventListener('keydown',e=>{if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;if(e.key==='Escape'){e.preventDefault();this.expanded?this.expand(false):this.back();}else if(e.altKey&&e.key==='ArrowLeft'){e.preventDefault();this.back();}else if(e.key==='-'||e.key==='+'){e.preventDefault();this.changeZoom(e.key==='+'?1.35:1/1.35);}});
      this.resize=new ResizeObserver(entries=>{const r=entries[0].contentRect;if(!r.width||!r.height)return;const size=r.width+':'+r.height;if(size===this.chartSize)return;this.chartSize=size;cancelAnimationFrame(this.resizeFrame);this.resizeFrame=requestAnimationFrame(()=>{this.chartView=undefined;this.draw(0);});});this.resize.observe($('treemap'));
    }
    update(report,phase){
      const changed=this.report?.id!==report?.id,phaseChanged=this.phase!==phase,direct=this.current();this.report=report;this.phase=phase;
      if(changed){this.focus=[];this.hexPage=undefined;this.request++;this.zoom=1;this.zoomTarget=undefined;this.hovered=undefined;this.origin={x:.5,y:.5};this.chartView=undefined;}
      if(phaseChanged&&phase!=='ready'){this.request++;this.hexPage=undefined;}
      this.index.clear();const visit=(nodes,parent)=>{for(const item of nodes??[]){this.index.set(item.id,{...item,parent});visit(item.children,item.id);}};visit(report?.tree);
      if(!changed&&direct?.id.startsWith('direct:'))this.index.set(direct.id,direct);
      this.focus=this.focus.filter(id=>this.index.has(id));this.render();if(phaseChanged&&phase==='ready'&&this.current()?.symbolId&&!this.hexPage)this.readHex(0);
    }
    current(){return this.index.get(this.focus.at(-1));}
    enter(id){const item=this.index.get(id);if(!item)return;
      if(item.kind==='more'){this.filter(item.region,true);return;}
      if(item.kind==='unattributed'){this.describe(item);$('tree-help').textContent=f('Unattributed bytes include linker reservations and padding. Use layout and symbols to inspect them.');return;}
      const path=[];let next=item;while(next){path.unshift(next.id);next=this.index.get(next.parent);}this.focus=path.filter(key=>this.index.get(key)?.name!=='Project objects');this.zoom=1;this.origin={x:.5,y:.5};this.zoomTarget=undefined;this.hovered=undefined;this.hexPage=undefined;this.request++;this.filter(item.region,false);this.render('in');
      if(item.symbolId)this.readHex(0);
    }
    openSymbol(symbol){
      let found=[...this.index.values()].find(item=>item.symbolId===symbol.id&&item.region===symbol.region)??[...this.index.values()].find(item=>item.symbolId===symbol.id);
      if(!found){const id='direct:'+symbol.id;found={id,name:symbol.name,label:symbol.name,kind:'symbol',symbolId:symbol.id,region:symbol.region??'',value:symbol.size,address:symbol.address,endAddress:symbol.address+symbol.size,runtimeAddress:symbol.address};this.index.set(id,found);}
      this.enter(found.id);$('memory-explorer').scrollIntoView({block:'start',behavior:'auto'});
    }
    reset(){this.focus=[];this.request++;this.hexPage=undefined;this.zoom=1;this.origin={x:.5,y:.5};this.zoomTarget=undefined;this.hovered=undefined;this.filter('',false);this.render('out');}
    back(){if(!this.focus.length){if(this.zoom>1)this.reset();return;}this.focus.pop();this.request++;this.hexPage=undefined;this.zoom=1;this.origin={x:.5,y:.5};this.zoomTarget=undefined;this.hovered=undefined;this.filter(this.current()?.region??'',false);this.render('out');}
    expand(value){
      if(this.expanded===value)return;this.expanded=value;const studio=$('memory-explorer').closest('.studio');
      if(value){this.savedScroll=window.scrollY;studio.classList.add('explorer-expanded');window.scrollTo(0,0);}else{studio.classList.remove('explorer-expanded');requestAnimationFrame(()=>window.scrollTo(0,this.savedScroll??0));}
      $('tree-expand').textContent=f(value?'Exit expanded view':'Expand view');$('tree-expand').setAttribute('aria-pressed',String(value));
      requestAnimationFrame(()=>{this.chartView=undefined;this.draw(0);this.animateSurface(value?'in':'out');});
    }
    animateSurface(direction){
      if(!direction||this.motion.matches)return;this.surfaceAnimation?.cancel();const surface=this.current()?.symbolId?$('hex-view'):$('treemap');
      this.surfaceAnimation=surface.animate([{opacity:.3,transform:direction==='out'?'scale(1.045)':'scale(.96)'},{opacity:1,transform:'scale(1)'}],{duration:260,easing:'cubic-bezier(.2,.8,.2,1)'});
    }
    wheel(event){
      if(!event.deltaY||Math.abs(event.deltaX)>Math.abs(event.deltaY))return;
      // Release page scrolling when the overview is already fully zoomed out.
      if(event.deltaY>0&&!this.focus.length&&this.zoom<=1)return;
      event.preventDefault();event.stopImmediatePropagation();const direction=Math.sign(event.deltaY),now=performance.now();
      if(now<(this.wheelUntil??0)&&direction===this.wheelDirection)return;
      this.wheelDirection=direction;const rect=$('treemap').getBoundingClientRect();
      if(!this.zoomTarget){this.zoomTarget=this.hovered;this.origin={x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))};}
      const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?rect.height:1);
      this.changeZoom(Math.exp(-Math.max(-100,Math.min(100,delta))/330),true);
    }
    syncControls(){
      const isHex=!!this.current()?.symbolId;
      $('tree-back').disabled=!this.focus.length;$('tree-reset').disabled=!this.focus.length&&this.zoom<=1;
      $('tree-zoom-in').hidden=false;$('tree-zoom-out').hidden=false;$('tree-zoom-in').disabled=isHex||!this.visible().length;
      $('tree-zoom-out').disabled=!isHex&&!this.focus.length&&this.zoom<=1;
      $('tree-zoom-level').textContent=isHex?'HEX':Math.round(this.zoom*100)+'%';
    }
    describe(item){
      $('tree-selection-name').textContent=item?f(item.label):f('All allocated regions');
      $('tree-selection-name').title=item?.name??'';
      $('tree-selection-detail').textContent=item?[bytes(item.value),item.address!==undefined?hex(item.address)+(item.endAddress!==undefined?' – '+hex(item.endAddress-1):''):'',item.kind==='symbol'?f('Open HEX bytes'):f('Click a block to explore')].filter(Boolean).join(' · '):f('Area represents allocated bytes. Colors identify memory regions.');
    }
    color(item,index){const base=palette(item.region);const dark=this.dark();return item.kind==='unattributed'?(dark?'#343C4A':'#E1E6ED'):blend(base,dark?'#142338':'#FFFFFF',dark?0.48+(index%5)*0.045:0.76-(index%5)*0.035);}
    dark(){const rgb=getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();const match=rgb.match(/^#([\da-f]{6})$/i);if(match){const n=parseInt(match[1],16);return ((n>>16)*.299+((n>>8)&255)*.587+(n&255)*.114)<145;}return !document.body.classList.contains('vscode-light');}
    changeZoom(factor,fromWheel=false){
      if(this.current()?.symbolId){if(factor<1)this.back();return;}
      if(factor<1&&this.zoom<=1.001){if(this.focus.length){this.wheelUntil=performance.now()+280;this.back();}return;}
      if(factor>1&&!this.zoomTarget)this.zoomTarget=this.hovered;
      const next=Math.max(1,Math.min(5,this.zoom*factor));
      if(factor>1&&next>=2){
        const hovered=this.index.get(this.zoomTarget),candidate=hovered&&!['unattributed','more'].includes(hovered.kind)?hovered:this.visible().filter(n=>!['unattributed','more'].includes(n.kind)).sort((a,b)=>b.value-a.value)[0];
        if(candidate){this.wheelUntil=performance.now()+280;this.enter(candidate.id);return;}
      }
      this.zoom=next;if(this.zoom===1){this.zoomTarget=undefined;this.origin={x:.5,y:.5};}
      this.syncControls();this.draw(fromWheel?100:220,true);
    }
    render(direction){
      const item=this.current(),isHex=!!item?.symbolId;$('memory-explorer').dataset.mode=isHex?'hex':'tree';
      this.syncControls();$('treemap').hidden=isHex;
      $('hex-view').hidden=!isHex;$('tree-accessible').hidden=isHex;
      $('tree-help').textContent=f(isHex?'ELF image bytes only. This view does not read live target memory.':'Scroll up to zoom in; scroll down to zoom out or return. Click a block to enter. Alt+Left goes back.');
      const crumb=$('tree-breadcrumb');crumb.replaceChildren();const root=node('button',f('All regions'),'crumb');root.onclick=()=>this.reset();crumb.append(root);
      for(const id of this.focus){const entry=this.index.get(id);if(!entry)continue;crumb.append(node('span','/','crumb-separator'));const b=node('button',f(entry.label),'crumb');b.title=entry.name;if(id===item?.id)b.setAttribute('aria-current','location');b.onclick=()=>this.enter(id);crumb.append(b);}
      $('tree-legend').replaceChildren(...(this.report?.regions??[]).filter(r=>r.used).map(region=>{const button=node('button',undefined,'region-key');const dot=node('span',undefined,'region-dot');dot.style.backgroundColor=palette(region.name);button.append(dot,node('span',region.name),node('span',bytes(region.used),'region-total'));button.onclick=()=>{const entry=[...this.index.values()].find(n=>n.kind==='region'&&n.region===region.name);if(entry)this.enter(entry.id);};return button;}));
      this.describe(item);
      if(isHex){$('hex-title').textContent=item.name;$('hex-source').textContent=f('ELF image');if(!this.hexPage)this.loading();if(this.phase!=='ready')this.hexError('Report is stale.');this.animateSurface(direction);return;}
      this.draw();this.list();this.animateSurface(direction);
    }
    visible(){const item=this.current();return item?(item.children??[]).flatMap(n=>n.name==='Project objects'?n.children??[]:[n]):(this.report?.tree??[]).filter(n=>n.value>0);}
    draw(duration=260,geometryOnly=false){if(!this.chart||this.current()?.symbolId)return;
      if(geometryOnly){const box=100*this.zoom;this.chart.setOption({animation:!this.motion.matches,series:[{id:'allocation',animation:!this.motion.matches,animationDurationUpdate:this.motion.matches?0:duration,left:(100-box)*this.origin.x+'%',top:(100-box)*this.origin.y+'%',width:box+'%',height:box+'%'}]});return;}
      const fg=getComputedStyle(document.body).getPropertyValue('--vscode-foreground').trim()||'#ddd',dark=this.dark(),highContrast=document.body.className.includes('high-contrast');
      const map=(item,i)=>{let children;if(!this.current()&&item.kind==='region'&&item.children){children=item.children.flatMap(c=>c.name==='Project objects'?c.children??[]:[c]).map((c,j)=>map(c,j));}return {...item,displayName:f(item.label),name:f(item.label),children,itemStyle:{color:this.color(item,i),borderColor:highContrast?fg:(dark?'#202B3A':'#FFFFFF'),borderWidth:1,gapWidth:4},label:{color:fg},upperLabel:{color:fg}};};
      const data=this.visible().map(map),box=100*this.zoom,view=this.report?.id+':'+(this.current()?.id??'root'),changed=this.chartView!==view;this.chartView=view;
      if(changed)this.chart.resize();this.chart.setOption({animation:!this.motion.matches,animationDuration:0,animationDurationUpdate:this.motion.matches?0:duration,animationEasing:'cubicOut',textStyle:{fontFamily:'Segoe UI, sans-serif'},backgroundColor:'transparent',tooltip:{show:false},series:[{id:'allocation',type:'treemap',data,animation:!this.motion.matches,animationDurationUpdate:this.motion.matches?0:duration,animationEasing:'cubicOut',left:(100-box)*this.origin.x+'%',top:(100-box)*this.origin.y+'%',width:box+'%',height:box+'%',roam:false,scaleLimit:{min:1,max:6},nodeClick:false,breadcrumb:{show:false},squareRatio:1.35,visibleMin:20,childrenVisibleMin:60,label:{show:true,position:'insideTopLeft',padding:12,fontSize:12,lineHeight:20,overflow:'truncate',formatter:info=>{const d=info.data;return d.displayName+'\n'+bytes(d.value)+(d.kind==='symbol'&&d.address!==undefined?'\n'+hex(d.address):'');}},upperLabel:{show:true,height:30,fontSize:12,fontWeight:600,formatter:info=>info.name+'   '+bytes(info.value)},itemStyle:{borderWidth:1,gapWidth:4,borderColor:dark?'#202B3A':'#FFFFFF'},emphasis:{itemStyle:{borderColor:highContrast?fg:'#69ADFB',borderWidth:2},label:{color:fg}},levels:[{upperLabel:{show:false},itemStyle:{borderWidth:0,gapWidth:10}},{itemStyle:{borderWidth:0,gapWidth:4}},{itemStyle:{borderWidth:1,gapWidth:4}}]} ]},{notMerge:changed,lazyUpdate:false});
    }
    list(){const entries=this.visible();$('tree-list').replaceChildren(...entries.slice(0,150).map(item=>{const b=node('button',undefined,'allocation-row');b.append(node('span',f(item.label)),node('span',bytes(item.value),'number'),node('code',item.address===undefined?'—':hex(item.address)));b.title=item.name;b.onclick=()=>this.enter(item.id);return b;}));$('tree-count').textContent=entries.length+' '+f('entries');}
    loading(){$('hex-status').textContent=f('Reading verified ELF bytes…');$('hex-table').replaceChildren();$('hex-addresses').replaceChildren();$('hex-page-label').textContent='';$('hex-selection').textContent='';$('hex-previous').disabled=true;$('hex-next').disabled=true;$('hex-jump').disabled=true;}
    hexError(message){$('hex-status').textContent=f(message);$('hex-status').classList.add('error');}
    readHex(offset){const item=this.current();if(!item?.symbolId||!this.report)return;this.loading();$('hex-status').classList.remove('error');if(this.phase!=='ready'){this.hexError('Report is stale.');return;}this.pageOffset=offset;this.api.postMessage({type:'hex',context:this.context(),reportId:this.report.id,id:item.symbolId,offset,request:++this.request});}
    receive(message){if(this.phase!=='ready'||message.reportId!==this.report?.id||message.request!==this.request)return;if(message.type==='hexError'){this.hexError(message.message);return;}const page=message.page;if(page.symbolId!==this.current()?.symbolId)return;this.hexPage=page;this.pageOffset=page.offset;
      $('hex-status').textContent=f(page.storage==='nobits'?'No file bytes: BSS / NOLOAD reserves RAM. Values exist only at runtime.':'ELF image bytes only. This view does not read live target memory.');
      $('hex-addresses').replaceChildren(...[['VMA',hex(page.address)],['LMA',page.loadAddress===undefined?'—':hex(page.loadAddress)],[f('Size'),bytes(page.total)]].map(([label,value])=>{const e=node('div',undefined,'hex-fact');e.append(node('span',label),node('code',value));return e;}));
      $('hex-page-label').textContent=page.storage==='nobits'?f('No stored bytes'):(page.offset+1)+'–'+(page.offset+page.bytes.length)+' / '+page.total+' B';$('hex-previous').disabled=page.storage!=='elf'||page.offset===0;$('hex-next').disabled=page.storage!=='elf'||page.offset+page.bytes.length>=page.total;$('hex-jump').disabled=page.storage!=='elf';$('hex-jump').value=hex(page.address+page.offset);
      const table=node('table',undefined,'hex-table');const head=node('tr');head.append(node('th',f('Address')));for(let j=0;j<16;j++)head.append(node('th',j.toString(16).toUpperCase().padStart(2,'0')));head.append(node('th','ASCII'));table.append(head);
      for(let i=0;i<page.bytes.length;i+=16){const row=node('tr'),address=page.address+page.offset+i;row.append(node('th',hex(address),'hex-row-address'));for(let j=0;j<16;j++){const cell=node('td');if(i+j<page.bytes.length){const value=page.bytes[i+j],button=node('button',value.toString(16).toUpperCase().padStart(2,'0'),'hex-byte'+(value===0?' zero':''));button.dataset.address=String(address+j);button.setAttribute('aria-label',hex(address+j)+' = '+button.textContent);button.onclick=()=>{$('hex-table').querySelectorAll('[aria-pressed]').forEach(b=>b.removeAttribute('aria-pressed'));button.setAttribute('aria-pressed','true');$('hex-selection').textContent=hex(address+j)+'   HEX '+button.textContent+'   DEC '+value+'   BIN '+value.toString(2).padStart(8,'0');};cell.append(button);}row.append(cell);}row.append(node('td',page.bytes.slice(i,i+16).map(v=>v>=32&&v<=126?String.fromCharCode(v):'·').join(''),'hex-ascii'));table.append(row);}
      $('hex-table').replaceChildren(table);if(page.storage==='nobits')$('hex-table').replaceChildren();
      if(this.pendingAddress!==undefined){$('hex-table').querySelector('[data-address="'+this.pendingAddress+'"]')?.click();this.pendingAddress=undefined;}
    }
  }
  window.MemoryExplorer=MemoryExplorer;window.memoryRegionColor=palette;
})();

