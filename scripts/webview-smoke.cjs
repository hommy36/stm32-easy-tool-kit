// Exercises the actual Webview DOM/scripts in a local, headless Edge process.
// No external pages or user browser profiles are accessed.
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const {settingsBody}=require('../out/ui/settingsHtml');
const {defaultProjectSettings}=require('../out/project/types');
const {capabilities}=require('../out/ui/presentation');
const {consoleBody}=require('../out/ui/consoleHtml');
const {setLanguage,getLanguage,webviewLocale,t}=require('../out/i18n');
setLanguage('zh-CN');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  const root=await fs.mkdtemp(path.resolve('.cache/webview-smoke-'));
  const localeScript=await fs.readFile('resources/workbench/i18n.js','utf8');
  const css=await fs.readFile('resources/workbench/workbench.css','utf8');
  const themes={dark:['#1f1f1f','#252526','#cccccc','#9d9d9d','#0078d4','#313131','#444444','#4daafc'],light:['#ffffff','#f3f3f3','#333333','#606060','#0066b8','#ffffff','#cccccc','#005fb8'],contrast:['#000000','#000000','#ffffff','#ffffff','#000000','#000000','#ffffff','#ffff00']};
  let theme='dark';
  const server=http.createServer(async(req,res)=>{
    const isConsole=req.url==='/console'; const colors=themes[theme];
    const variables=`--vscode-editor-background:${colors[0]};--vscode-sideBar-background:${colors[1]};--vscode-foreground:${colors[2]};--vscode-descriptionForeground:${colors[3]};--vscode-button-background:${colors[4]};--vscode-button-hoverBackground:${colors[4]};--vscode-button-foreground:#fff;--vscode-input-background:${colors[5]};--vscode-input-foreground:${colors[2]};--vscode-dropdown-background:${colors[5]};--vscode-dropdown-foreground:${colors[2]};--vscode-input-border:${colors[6]};--vscode-panel-border:${colors[6]};--vscode-focusBorder:${colors[7]};--vscode-textLink-foreground:${colors[7]};--vscode-button-secondaryBackground:${colors[5]};--vscode-button-secondaryForeground:${colors[2]};--vscode-textBlockQuote-background:${colors[1]};--vscode-errorForeground:#e05050;--vscode-font-family:'Segoe UI',sans-serif;--vscode-font-size:13px;--vscode-list-activeSelectionBackground:${colors[4]};--vscode-list-activeSelectionForeground:#fff;`;
    const js=await fs.readFile(`resources/workbench/${isConsole?'console':'settings'}.js`,'utf8');
    // VS Code injects body padding before the extension stylesheet.
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="${getLanguage()}"><meta charset="utf-8"><style>body{margin:0;padding:0 20px}</style><style>:root{${variables}}${css}</style><body>${isConsole?consoleBody():settingsBody(false)}<script>window.stm32Locale=${webviewLocale()};${localeScript}</script><script>window.sent=[];window.savedState=null;window.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>savedState,setState:s=>savedState=s});</script><script>${js}</script></body></html>`);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  console.log('Starting isolated browser: '+root);
  const browser=spawn(process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',['--headless=new','--no-first-run','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${path.join(root,'profile')}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let browserLog='';browser.stderr.on('data',data=>{browserLog+=data;});
  let ws;
  try {
    let port;
    for(let i=0;i<100;i++){try{port=(await fs.readFile(path.join(root,'profile','DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{await delay(100);}}
    assert.ok(port,'Headless Edge must start');
    console.log('Browser debugging port: '+port);
    const tab=await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT',signal:AbortSignal.timeout(5000)})).json();
    ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
    let id=0;const waiting=new Map();
    ws.onmessage=event=>{const data=JSON.parse(event.data);if(data.id){const pending=waiting.get(data.id);if(pending){waiting.delete(data.id);data.error?pending.reject(Error(JSON.stringify(data.error))):pending.resolve(data.result);}}};
    const cdp=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{waiting.delete(key);reject(Error('CDP timeout: '+method));},8000);waiting.set(key,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});ws.send(JSON.stringify({id:key,method,params}));});
    const evaluate=async expression=>{const value=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw Error(JSON.stringify(value.exceptionDetails));return value.result.value;};
    const send=data=>evaluate(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(data)}}));true`);
    const open=async route=>{await cdp('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/${route}`});for(let i=0;i<100;i++){if(await evaluate('Boolean(window.sent?.length)'))return;await delay(30);}throw Error('Page did not initialize');};
    await cdp('Page.enable');
    const settings={...defaultProjectSettings('file:///D:/sample','D:\\sample'),configurePreset:'Debug',targetId:'fw',configuration:'Debug'};
    const toolList=['armGnu','cmake','ninja','openocd'].map(id=>({id,name:id,available:id!=='openocd',status:id==='openocd'?'未配置':'检查完成',version:'1.0',checks:[]}));
    const ready=capabilities({settings,cmakeProject:true,tools:toolList,busy:false,trusted:true,supported:true,cortex:false});
    const base={type:'state',project:{revision:1,settings},projects:[{uri:settings.projectUri,label:'motor-control'}],configurations:[{name:'Debug',displayName:'Debug',label:'Debug',binaryDirectory:'D:\\sample\\build\\Debug',builds:[{name:'debug-build',displayName:'Debug build'}]},{name:'Release',displayName:'Release',label:'Release',builds:[]}],targets:[{id:'fw',name:'firmware',configuration:'Debug'}],tools:toolList,cmakeProject:true,cortex:false,busy:false,workflowBusy:false,toolBusy:false,readiness:ready,capabilities:ready,snapshot:{revision:1,projectUri:settings.projectUri,phase:'idle',message:'编译成功'},snapshotRevision:1,repair:{action:'log',label:'查看构建日志'},options:{},authorized:false,authorizationStored:false};
    const results=[];
    async function check(name, action){await action();results.push(name);console.log('PASS '+name);}
    await open('settings');await send(base);
    await check('save-and-configure submits the unsaved draft in one action',async()=>{
      await evaluate(`document.getElementById('configurePreset').value='Release';document.getElementById('configurePreset').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('configurePreset').dispatchEvent(new Event('change'));document.getElementById('configure').click()`);
      const msg=await evaluate('sent.at(-1)');assert.equal(msg.type,'saveAndConfigure');assert.equal(msg.settings.configurePreset,'Release');assert.equal(msg.settings.targetId,undefined);
      await send({type:'operationComplete'});
    });
    await check('background refresh preserves unsaved fields',async()=>{await send(base);assert.equal(await evaluate("document.getElementById('configurePreset').value"),'Release');});
    await check('cross-window update preserves draft but blocks saving',async()=>{
      await send({...base,project:{...base.project,revision:2}});assert.equal(await evaluate("document.getElementById('configurePreset').value"),'Release');assert.equal(await evaluate("document.getElementById('save').disabled"),true);
    });
    await check('discard reloads current settings',async()=>{await send({...base,replaceDraft:true});assert.equal(await evaluate("document.getElementById('configurePreset').value"),'Debug');assert.equal(await evaluate("document.getElementById('save').disabled"),false);});
    await check('save-with-project defaults on, toggles in draft, and preserves the real firmware name',async()=>{
      assert.equal(await evaluate("document.getElementById('shareInProject').checked"),true);
      await evaluate("document.getElementById('shareInProject').click();document.getElementById('save').click()");
      const message=await evaluate('sent.at(-1)');assert.equal(message.type,'save');assert.equal(message.settings.shareInProject,false);assert.equal(message.settings.preferredTarget,'firmware');
      await send({type:'operationComplete'});await send({...base,project:{...base.project,settings:{...base.project.settings,shareInProject:false}}});assert.equal(await evaluate("document.getElementById('shareInProject').checked"),false);
      await send({...base,project:{...base.project,revision:999}});assert.equal(await evaluate("document.getElementById('save').disabled"),true);
      await send({...base,replaceDraft:true});assert.equal(await evaluate("document.getElementById('shareInProject').checked"),true);
    });
    await check('target auto-detection updates the draft without a confirmation checkbox',async()=>{
      await send({...base,replaceDraft:true});await send({type:'navigate',options:{page:'dap'}});
      assert.equal(await evaluate("document.getElementById('chipConfirmed')===null"),true);
      await evaluate("document.getElementById('detectTargetScript').click()");assert.equal((await evaluate('sent.at(-1)')).type,'detectTargetScript');
      await send({type:'pickedTargetScript',file:'target/stm32h7x.cfg',chipLabel:'STM32H723VGT6',scriptKind:'target'});await send({type:'operationComplete'});
      assert.equal(await evaluate("document.getElementById('chipLabel').value"),'STM32H723VGT6');assert.equal(await evaluate("document.getElementById('targetScript').value"),'target/stm32h7x.cfg');
      await send({...base,replaceDraft:true});
    });
    await check('probe selection persists and disables the DAPLink backend field',async()=>{
      await send({...base,replaceDraft:true});await send({type:'navigate',options:{page:'advanced'}});
      assert.equal(await evaluate("document.getElementById('probe').value"),'cmsis-dap');
      assert.equal(await evaluate("document.getElementById('backend').disabled"),false);
      await evaluate("document.getElementById('probe').value='st-link';document.getElementById('probe').dispatchEvent(new Event('change',{bubbles:true}))");
      assert.equal(await evaluate("document.getElementById('backend').disabled"),true);
      assert.match(await evaluate("document.getElementById('dapSummary').textContent"),/ST-Link/);
      await evaluate("document.getElementById('save').click()");
      const message=await evaluate('sent.at(-1)');assert.equal(message.settings.probe,'st-link');
      await send({type:'operationComplete'});
      await send({...base,replaceDraft:true,project:{...base.project,settings:{...base.project.settings,probe:'st-link'}}});
      assert.equal(await evaluate("document.getElementById('probe').value"),'st-link');
      assert.equal(await evaluate("document.getElementById('backend').disabled"),true);
      await evaluate("document.getElementById('probe').value='cmsis-dap';document.getElementById('probe').dispatchEvent(new Event('change',{bubbles:true}))");
      assert.equal(await evaluate("document.getElementById('backend').disabled"),false);
      await send({...base,replaceDraft:true});
    });
    await check('empty saved preset defaults to Debug once presets are available',async()=>{
      await send({...base,replaceDraft:true,project:{...base.project,settings:{...base.project.settings,configurePreset:undefined}}});
      assert.equal(await evaluate("document.getElementById('configurePreset').value"),'Debug');
      await send({...base,replaceDraft:true});
    });
    await check('tools stay usable without a project',async()=>{
      await send({type:'navigate',options:{tools:true}});await send({...base,project:undefined,projects:[],options:{tools:true}});
      assert.equal(await evaluate("document.querySelector('[data-tool=cmake]').disabled"),false);
      await evaluate("document.querySelector('[data-tool=cmake]').click()");assert.equal((await evaluate('sent.at(-1)')).tool,'cmake');await send({type:'operationComplete'});
    });
    await check('onboarding can select a project in a multi-root workspace',async()=>{
      await send({type:'navigate',options:{setup:true}});await send({...base,project:undefined,options:{setup:true}});
      assert.equal(await evaluate("document.getElementById('projectChoice').matches(':disabled')"),false);
    });
    await check('empty SWD speed shows the invalid field, not hidden validation',async()=>{
      await send({...base,replaceDraft:true});await send({type:'navigate',options:{page:'advanced'}});
      await evaluate("document.getElementById('speedKHz').value='';document.getElementById('speedKHz').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('save').click()");
      assert.equal(await evaluate('document.activeElement.id'),'speedKHz');
    });
    await check('sidebar switches the debug probe at any time',async()=>{
      await open('console');await send(base);
      assert.equal(await evaluate("document.getElementById('probe').value"),'cmsis-dap');
      await evaluate("document.getElementById('probe').value='st-link';document.getElementById('probe').dispatchEvent(new Event('change'))");
      const message=await evaluate('sent.at(-1)');assert.equal(message.action,'probe');assert.equal(message.value,'st-link');
      await send({type:'complete'});
      await send({...base,project:{...base.project,settings:{...base.project.settings,probe:'st-link'}}});
      assert.equal(await evaluate("document.getElementById('probe').value"),'st-link');
      assert.match(await evaluate("document.getElementById('probeDetail').textContent"),/ST-Link/);
      await send(base);
    });
    for(const locale of ['zh-CN','en']) {
      setLanguage(locale);
      base.tools=toolList.map(tool=>({...tool,status:t(tool.id==='openocd'?'未配置':'检查完成')}));
      base.readiness=base.capabilities=capabilities({settings,cmakeProject:true,tools:toolList,busy:false,trusted:true,supported:true,cortex:false});
      base.snapshot.message=t('编译成功');base.repair.label=t('查看构建日志');
    for(const selectedTheme of Object.keys(themes)){
      theme=selectedTheme;
      for(const width of [320,1000]){
        await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
        await open('settings');await send(base);
        assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'),`settings overflow ${locale} ${theme} ${width}`);
        assert.equal(await evaluate("document.documentElement.lang"),locale);
        assert.equal(await evaluate("document.getElementById('configure').textContent"),t('保存并配置'));
        const shot=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(root,`settings-${locale}-${theme}-${width}.png`),Buffer.from(shot.data,'base64'));
        await send({type:'navigate',options:{setup:true,page:'build'}});
        await send({...base,busy:true,workflowBusy:true,snapshot:{...base.snapshot,message:t('正在读取已有构建方案（不配置工程）')}});
        const running=await evaluate(`(()=>{const stop=document.getElementById('stop'),steps=document.getElementById('stepper');return {gap:steps.getBoundingClientRect().top-stop.getBoundingClientRect().bottom,disabled:stop.disabled,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
        assert.ok(running.gap>=16,`stop overlaps onboarding ${locale} ${theme} ${width}`);assert.equal(running.disabled,false);assert.equal(running.overflow,false);
        await evaluate("document.getElementById('stop').click()");assert.equal((await evaluate('sent.at(-1)')).type,'stop');
        const runningShot=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(root,`running-${locale}-${theme}-${width}.png`),Buffer.from(runningShot.data,'base64'));
        await send(base);await send({type:'navigate',options:{page:'advanced'}});
        assert.equal(await evaluate("document.getElementById('deleteConfiguration').hidden"),false);
        assert.equal(await evaluate("document.getElementById('deleteSettings').textContent"),t('删除已有配置…'));
        assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'delete settings layout');
        await evaluate("document.getElementById('deleteSettings').click()");
        assert.equal((await evaluate('sent.at(-1)')).type,'deleteSettings');
        assert.equal(await evaluate("document.getElementById('deleteSettings').disabled"),true,'duplicate delete disabled');
        await send({type:'operationComplete'});
        await send({...base,busy:true,workflowBusy:true});
        assert.equal(await evaluate("document.getElementById('deleteSettings').disabled"),true,'busy delete disabled');
        await send(base);
        await evaluate("document.getElementById('deleteSettings').scrollIntoView({block:'center'})");
        const deletionShot=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(root,`delete-${locale}-${theme}-${width}.png`),Buffer.from(deletionShot.data,'base64'));
        await send({type:'navigate',options:{}});
        if(width===1000){
          await send({type:'navigate',options:{tools:true}});
          // Some host themes omit secondary button tokens or make them transparent.
          await evaluate(`document.documentElement.style.setProperty('--vscode-button-secondaryBackground','transparent');true`);
          const buttons=await evaluate(`Array.from(document.querySelectorAll('.tool-row:first-child button')).map(button=>({text:button.textContent,background:getComputedStyle(button).backgroundColor,border:getComputedStyle(button).borderTopColor,style:button.className}))`);
          assert.equal(buttons.length,5);
          for(const button of buttons.slice(0,4)){assert.equal(button.style,'secondary');assert.notEqual(button.background,'rgba(0, 0, 0, 0)');assert.notEqual(button.border,'rgba(0, 0, 0, 0)');}
          assert.equal(buttons[4].style,'link');
          assert.equal(buttons[0].text,t('选择已有'));assert.equal(buttons[3].text,t('离线导入'));
          if(locale==='en')assert.equal(await evaluate('/[\\u3400-\\u9fff]/.test(document.body.innerText)'),false,'English tools must not contain Chinese UI text');
          const toolsShot=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(root,`tools-${locale}-${theme}.png`),Buffer.from(toolsShot.data,'base64'));
        }
      }
      await cdp('Emulation.setDeviceMetricsOverride',{width:320,height:1000,deviceScaleFactor:1,mobile:false});
      await open('console');await send(base);
      assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'),`console overflow ${theme}`);
      const spacing=await evaluate(`({bodyLeft:getComputedStyle(document.body).paddingLeft,bodyRight:getComputedStyle(document.body).paddingRight,left:document.getElementById('project').getBoundingClientRect().left,right:document.documentElement.clientWidth-document.getElementById('project').getBoundingClientRect().right})`);
      assert.deepEqual(spacing,{bodyLeft:'0px',bodyRight:'0px',left:12,right:12},`host padding reset ${theme}`);
      assert.equal(await evaluate("document.getElementById('flash').disabled"),true);
      assert.equal(await evaluate("document.querySelector('.console-heading strong').textContent"),'motor-control');
      assert.equal(await evaluate("document.getElementById('build').textContent"),t('编译'));
      if(locale==='en')assert.equal(await evaluate('/[\\u3400-\\u9fff]/.test(document.body.innerText)'),false,'English console must not contain Chinese UI text');
      await send({...base,optimization:{level:'default',revision:'a'.repeat(64)}});
      assert.equal(await evaluate("document.getElementById('optimization').value"),'default');
      await evaluate("document.getElementById('optimization').value='Os';document.getElementById('optimization').dispatchEvent(new Event('change'))");
      const optMessage=await evaluate('sent.at(-1)');assert.equal(optMessage.action,'optimization');assert.equal(optMessage.value,'Os');assert.equal(optMessage.featureRevision,'a'.repeat(64));
      assert.equal(await evaluate("document.getElementById('optimization').disabled"),true);
      await send({type:'complete'});await send({...base,optimization:{level:'Os',revision:'b'.repeat(64)}});
      assert.equal(await evaluate("document.getElementById('optimizationHint').hidden"),false);
      const layout=await evaluate("({preset:document.getElementById('preset').getBoundingClientRect().toJSON(),opt:document.getElementById('optimization').getBoundingClientRect().toJSON()})");
      assert.equal(layout.preset.y,layout.opt.y);assert.ok(layout.opt.x>=layout.preset.right+7);assert.ok(layout.opt.right<=320);
      await evaluate("document.getElementById('optimization').focus()");assert.equal(await evaluate('document.activeElement.id'),'optimization');
      await send({...base,busy:true,optimization:{level:'Os',revision:'b'.repeat(64)}});assert.equal(await evaluate("document.getElementById('optimization').disabled"),true);
      await send({...base,optimization:{level:'Os',revision:'b'.repeat(64)}});
      const shot=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(root,`console-${locale}-${theme}-320.png`),Buffer.from(shot.data,'base64'));
      await send({...base,project:undefined,projects:[],snapshot:{revision:1,phase:'idle',message:t('请选择已有 STM32 CMake 工程')}});
      assert.equal(await evaluate("document.querySelectorAll('#capabilities .readiness').length"),3,'empty workspace renders all readiness rows without a flash history');
      assert.equal(await evaluate("document.querySelector('.console-heading strong').textContent"),'STM32 Easy Tool Kit');
      assert.equal(await evaluate("document.getElementById('history').textContent"),'');
    }
    results.push(`${locale}: dark/light/high-contrast DOM and layout at 320px / 1000px`);
    }
    await fs.writeFile(path.join(root,'result.json'),JSON.stringify({results,root},null,2));await fs.writeFile('.cache/webview-smoke-latest.json',JSON.stringify({results,root},null,2));
    await cdp('Browser.close').catch(()=>{});console.log('Screenshots: '+root);
  }finally{ws?.close();browser.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.writeFile(path.join(root,'browser.log'),browserLog);}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
