import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { WorkflowController } from '../workflow/controller';
import { ToolState } from '../tools/state';
import { workbenchState } from './workbenchState';
import { readFeatures } from '../project/features';
import { featureText as f } from './featureLocale';
import { escapeHtml } from '../i18n';
import { randomBytes } from 'node:crypto';
import { diagnose, redact } from './diagnostics';
import { discoverProbeDevices } from '../dap/discovery';

export async function openDiagnostics(context:vscode.ExtensionContext,controller:WorkflowController,tools:ToolState,guard:()=>void):Promise<void>{
  guard();const state=await workbenchState(controller,tools),source=state.project?.settings.sourceDirectory;
  const rows:{status:string;name:string;evidence:string;action?:string}[]=[];
  for(const [name,capability]of Object.entries(state.readiness))rows.push({status:capability.enabled?'OK':'CHECK',name,evidence:capability.reason,action:capability.repair==='tools'?'tools':capability.repair==='cortex'?'openCortexDebug':'settings'});
  for(const tool of state.tools)rows.push({status:tool.available?'OK':'CHECK',name:tool.name,evidence:[tool.version,tool.status,...tool.checks.flatMap(check=>check.evidence)].filter(Boolean).join('\n'),action:'tools'});
  if(source){
    const cpp=vscode.workspace.getConfiguration('C_Cpp',vscode.Uri.file(source));
    rows.push({status:cpp.get('default.configurationProvider')?'CHECK':'INFO',name:'Microsoft C/C++',evidence:JSON.stringify({compileCommands:cpp.get('default.compileCommands'),provider:cpp.get('default.configurationProvider'),installed:!!vscode.extensions.getExtension('ms-vscode.cpptools')},null,2),action:'settings'});
    rows.push({status:'INFO',name:'clangd',evidence:JSON.stringify({arguments:vscode.workspace.getConfiguration('clangd',vscode.Uri.file(source)).get('arguments'),installed:!!vscode.extensions.getExtension('llvm-vs-code-extensions.vscode-clangd')},null,2)});
    if(await fs.stat(path.join(source,'.vscode','c_cpp_properties.json')).catch(()=>undefined))rows.push({status:'CHECK',name:'Editor overrides',evidence:'c_cpp_properties.json exists. Folder configuration can override the generated compilation database.'});
    const view=await controller.view();if(view.model){const cache=view.model.cache;rows.push({status:'INFO',name:'CMake cache',evidence:JSON.stringify({directory:view.model.binaryDirectory,source:cache.get('CMAKE_HOME_DIRECTORY'),generator:cache.get('CMAKE_GENERATOR'),compiler:cache.get('CMAKE_C_COMPILER')},null,2),action:'freshDirectoryGuide'});}
    try{const feature=(await readFeatures(source)).settings;for(const[id,version]of Object.entries(feature.tools??{})){const tool=state.tools.find(t=>t.id===id);rows.push({status:tool?.version===version?'OK':'CHECK',name:`Version: ${id}`,evidence:`Expected: ${version} · Local: ${tool?.version??'missing'}`,action:'tools'});}}catch(error){rows.push({status:'CHECK',name:'Feature settings',evidence:String(error),action:'features'});}
  }
  const settings=state.project?.settings;
  try{const devices=await discoverProbeDevices();
    rows.push({status:devices.length?'FOUND':'UNKNOWN',name:'USB discovery',evidence:devices.length?devices.map(d=>d.name).join('\n'):'No matching PnP device names found. This does not prove that every compatible probe is absent.',action:'guide'});
    rows.push({status:devices.length&&devices.every(d=>d.code===0)?'OS READY':'UNVERIFIED',name:'Driver health',evidence:devices.length?devices.map(d=>`${d.name}: ${d.driver} / ${d.status} / PnP code ${d.code}`).join('\n')+'\nWindows driver health does not prove OpenOCD can open the debug interface.':'Driver readiness is unknown.',action:'guide'});
  }catch(error){rows.push({status:'UNKNOWN',name:'USB discovery / driver health',evidence:String(error),action:'guide'});}
  rows.push({status:'UNVERIFIED',name:'Target connection',evidence:'Only an explicit connection test can establish whether OpenOCD initializes this target. Historical build results do not grant hardware access.',action:'probeCheck'});
  if(state.snapshot.phase==='failed'||state.snapshot.phase==='uncertain')rows.push({status:'CHECK',name:'Last operation',evidence:state.snapshot.message+'\n'+diagnose(state.snapshot.message),action:'showBuildLog'});
  const root=vscode.Uri.joinPath(context.extensionUri,'resources','workbench'),panel=vscode.window.createWebviewPanel('stm32Easy.diagnostics',f('Diagnostics'),vscode.ViewColumn.Active,{enableScripts:true,localResourceRoots:[root]});
  const nonce=randomBytes(24).toString('base64');const css=(name:string)=>panel.webview.asWebviewUri(vscode.Uri.joinPath(root,name));
  panel.webview.html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'"><link rel="stylesheet" href="${css('workbench.css')}"><link rel="stylesheet" href="${css('memory.css')}"></head><body><main class="studio"><header class="studio-header"><div><p class="eyebrow">STM32 EASY TOOL KIT</p><h1>${escapeHtml(f('Diagnostics'))}</h1><p>${escapeHtml(settings?.chipLabel??'')}</p></div><button data-action="export">${escapeHtml(f('Export diagnostics'))}</button></header>${rows.map(row=>`<section class="diagnostic-row"><span class="badge">${row.status}</span><div><h2>${escapeHtml(row.name)}</h2><pre>${escapeHtml(redact(row.evidence))}</pre></div>${row.action?`<button class="secondary" data-action="${row.action}">${escapeHtml(f('Next action'))}</button>`:''}</section>`).join('')}</main><script nonce="${nonce}">const api=acquireVsCodeApi();document.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>api.postMessage({action:button.dataset.action}));</script></body></html>`;
  const subscription=panel.webview.onDidReceiveMessage(async raw=>{try{guard();if(!raw||typeof raw.action!=='string')return;if(raw.action==='export'){
    const file=await vscode.window.showSaveDialog({filters:{JSON:['json']}});if(!file)return;let content=redact(JSON.stringify({createdAt:new Date().toISOString(),chip:settings?.chipLabel,probe:settings?.probe,rows},null,2));
    for(const prefix of [source,process.env.USERPROFILE,...state.tools.map(tool=>tool.root)].filter((item):item is string=>!!item))content=content.split(JSON.stringify(prefix).slice(1,-1)).join('<local-path>');
    if(settings?.serial)content=content.split(settings.serial).join('<probe-serial>');await vscode.workspace.fs.writeFile(file,Buffer.from(content));
  }else if(raw.action==='freshDirectoryGuide'){const doc=await vscode.workspace.openTextDocument({language:'markdown',content:'# Separate build directory\n\nUse a new binaryDir in your own CMakeUserPresets.json (for example build/Debug-clean), then select that preset and configure. This preserves the old cache. For automatic presets, choose the other configuration or add a user preset. No cache is deleted automatically.'});await vscode.window.showTextDocument(doc);}
  else if(raw.action==='guide')await vscode.commands.executeCommand('stm32Easy.showDapGuide');
  else if(['tools','settings','features','probeCheck','openCortexDebug','showBuildLog'].includes(raw.action))await vscode.commands.executeCommand(`stm32Easy.workbench.${raw.action}`);
  }catch(error){void vscode.window.showErrorMessage(String(error));}});panel.onDidDispose(()=>subscription.dispose());
}
