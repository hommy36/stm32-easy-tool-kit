import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { SerialService } from '../serial/service';
import { featureLocale, featureText as f } from './featureLocale';
import { escapeHtml } from '../i18n';
export class SerialPanel {
  private panel?:vscode.WebviewPanel;private service=new SerialService();private entries:{at:number;text:string;hex:string}[]=[];private pending:{at:number;text:string;hex:string}[]=[];private bytes=0;private decoder=new StringDecoder('utf8');private timer?:ReturnType<typeof setTimeout>;
  constructor(private readonly context:vscode.ExtensionContext,private readonly guard:()=>void){
    this.service.events.on('data',(data:Buffer)=>{const entry={at:Date.now(),text:this.decoder.write(data),hex:data.toString('hex').replace(/(..)/g,'$1 ')};this.entries.push(entry);this.pending.push(entry);this.bytes+=entry.text.length+entry.hex.length;while(this.entries.length>2000||this.bytes>2097152){const old=this.entries.shift()!;this.bytes-=old.text.length+old.hex.length;}while(this.pending.length>256)this.pending.shift();if(!this.timer)this.timer=setTimeout(()=>{this.timer=undefined;const entries=this.pending.splice(0);void this.panel?.webview.postMessage({type:'append',entries});},100);});
    this.service.events.on('status',message=>void this.panel?.webview.postMessage({type:'status',message}));
  }
  open():void{if(this.panel){this.panel.reveal();return;}this.guard();const root=vscode.Uri.joinPath(this.context.extensionUri,'resources','workbench');const panel=vscode.window.createWebviewPanel('stm32Easy.serial',f('Serial terminal'),vscode.ViewColumn.Active,{enableScripts:true,localResourceRoots:[root]});this.panel=panel;
    const uri=(file:string)=>panel.webview.asWebviewUri(vscode.Uri.joinPath(root,file));const nonce=randomBytes(24).toString('base64');const label=(key:string)=>escapeHtml(f(key));
    const button=(action:string,key:string)=>'<button class="secondary" data-action="'+action+'">'+label(key)+'</button>';
    panel.webview.html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src '+"'none'; style-src "+panel.webview.cspSource+"; script-src 'nonce-"+nonce+"'"+'"><link rel="stylesheet" href="'+uri('workbench.css')+'"><link rel="stylesheet" href="'+uri('memory.css')+'"></head><body><main class="studio"><p class="eyebrow">STM32 EASY TOOL KIT</p><h1>'+label('Serial terminal')+'</h1><div class="serial-controls"><label>'+label('Port')+'<select id="port"></select></label><label>'+label('Baud rate')+'<input type="number" id="baud" value="115200" min="300" max="4000000"></label>'+button('ports','Refresh ports')+button('connect','Connect')+button('disconnect','Disconnect')+'</div><p id="status" role="status"></p><div class="filter-row"><input id="filter" placeholder="'+label('Filter')+'" aria-label="'+label('Filter')+'"><select id="format" aria-label="Format"><option>Text</option><option>HEX</option></select><button id="pause" class="secondary">'+label('Pause display')+'</button>'+button('save','Save log')+button('clear','Clear')+'</div><label class="check"><input id="timestamps" type="checkbox" checked>'+label('Timestamp')+'</label><pre id="output" class="serial-output"></pre><div class="serial-send"><input id="send" list="history" aria-label="'+label('Send')+'"><datalist id="history"></datalist><select id="ending" aria-label="Line ending"><option value="none">None</option><option value="lf" selected>LF</option><option value="crlf">CRLF</option></select>'+button('send','Send')+'</div></main><script nonce="'+nonce+'">window.featureMessages='+JSON.stringify(featureLocale()).replace(/</g,'\\u003c')+';</script><script nonce="'+nonce+'" src="'+uri('serial.js')+'"></script></body></html>';
    const receive=panel.webview.onDidReceiveMessage(async raw=>{try{this.guard();if(!raw||typeof raw.action!=='string')return;
      if(raw.action==='ports'){await panel.webview.postMessage({type:'ports',ports:await this.service.ports(),saved:this.context.workspaceState.get('serialSettings')});await panel.webview.postMessage({type:'log',entries:this.entries});}
      else if(raw.action==='connect'){this.decoder=new StringDecoder('utf8');await this.service.connect(path.join(this.context.extensionUri.fsPath,'resources','windows-serial-host.cs'),raw.port,Number(raw.baud));await this.context.workspaceState.update('serialSettings',{port:raw.port,baud:Number(raw.baud)});}
      else if(raw.action==='disconnect')await this.service.close();
      else if(raw.action==='send'){if(typeof raw.value!=='string'||raw.value.length>16384)throw new Error('Invalid serial payload.');let bytes:Buffer;if(raw.format==='HEX'){const value=raw.value.replace(/\s/g,'');if(!/^(?:[\da-f]{2})*$/i.test(value))throw new Error('HEX input must contain complete bytes.');bytes=Buffer.from(value,'hex');}else bytes=Buffer.from(raw.value+(raw.ending==='lf'?'\n':raw.ending==='crlf'?'\r\n':''));this.service.write(bytes);}
      else if(raw.action==='clear'){this.entries=[];this.pending=[];this.bytes=0;await panel.webview.postMessage({type:'log',entries:[]});}
      else if(raw.action==='save'){const file=await vscode.window.showSaveDialog({filters:{Log:['log']}});if(file)await vscode.workspace.fs.writeFile(file,Buffer.from(this.entries.map(entry=>new Date(entry.at).toISOString()+' '+entry.text).join('')));}
    }catch(error){await panel.webview.postMessage({type:'status',message:String(error)});}});panel.onDidDispose(()=>{receive.dispose();this.panel=undefined;void this.service.close();});
  }
  dispose():void{this.panel?.dispose();this.service.dispose();if(this.timer)clearTimeout(this.timer);}
}

