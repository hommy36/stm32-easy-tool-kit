import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { runProcess } from '../core/process';
export class SerialService {
  readonly events = new EventEmitter(); private child?: ChildProcessWithoutNullStreams; private closing?: Promise<void>; private opened=false;
  private powershell():string{const root=process.env.SystemRoot;if(!root||!path.isAbsolute(root))throw new Error('Cannot locate Windows PowerShell.');return path.join(root,'System32/WindowsPowerShell/v1.0/powershell.exe');}
  async ports():Promise<string[]>{const result=await runProcess({executable:this.powershell(),args:['-NoProfile','-NonInteractive','-Command','[System.IO.Ports.SerialPort]::GetPortNames()'],timeoutMs:10000});if(result.exitCode!==0)throw new Error(result.stderr);return result.stdout.split(/\r?\n/).map(s=>s.trim()).filter(s=>/^COM[1-9][0-9]{0,3}$/.test(s)).sort();}
  async connect(resource:string,port:string,baud:number):Promise<void>{
    if(this.child)throw new Error('Close the current serial connection first.');if(!/^COM[1-9][0-9]{0,3}$/.test(port)||!Number.isInteger(baud)||baud<300||baud>4000000)throw new Error('Invalid serial settings.');
    const script="$ErrorActionPreference='Stop'; Add-Type -Path '"+resource.replace(/'/g,"''")+"' -ReferencedAssemblies 'System.Web.Extensions'; [Stm32SerialHost]::Run()";
    const child=spawn(this.powershell(),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});this.child=child;this.closing=undefined;
    this.opened=false;
    const connected=new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);this.events.off('status',status);child.off('close',closed);};
      const status=(value:string)=>{if(value==='open'){this.opened=true;cleanup();resolve();}else if(value!=='closed'){cleanup();child.kill();reject(new Error(value));}};
      const closed=()=>{cleanup();reject(new Error('Serial port closed before opening.'));};
      const timer=setTimeout(()=>{cleanup();child.kill();reject(new Error('Serial connection timed out.'));},15000);
      this.events.on('status',status);child.once('close',closed);
    });
    let buffer='';child.stdout.setEncoding('utf8');child.stdout.on('data',text=>{buffer+=text;if(buffer.length>131072){child.kill();this.events.emit('status','Serial output protocol limit exceeded.');return;}let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);try{const frame=JSON.parse(line);if(frame.type==='data'&&typeof frame.data==='string'&&frame.data.length<8192)this.events.emit('data',Buffer.from(frame.data,'base64'));else this.events.emit('status',frame.message??frame.type);}catch{this.events.emit('status','Invalid serial host output.');}}});
    child.stderr.on('data',chunk=>this.events.emit('status',String(chunk).slice(0,2000)));child.on('error',error=>this.events.emit('status',error.message));
    child.on('close',()=>{if(this.child===child){this.child=undefined;this.opened=false;}this.events.emit('status','closed');});child.stdin.on('error',error=>this.events.emit('status',error.message));
    child.stdin.write(JSON.stringify({port,baud})+'\n');await connected;
  }
  write(bytes:Buffer):void{if(!this.child||!this.opened||this.closing)throw new Error('Serial port is not connected.');if(bytes.length>8192)throw new Error('Serial writes are limited to 8 KiB.');if(this.child.stdin.writableLength>65536)throw new Error('Serial queue is full.');this.child.stdin.write(JSON.stringify({type:'write',data:bytes.toString('base64')})+'\n');}
  close():Promise<void>{if(this.closing)return this.closing;const child=this.child;if(!child)return Promise.resolve();this.closing=new Promise(resolve=>{const timer=setTimeout(()=>child.kill(),1500);child.once('close',()=>{clearTimeout(timer);resolve();});child.stdin.end(JSON.stringify({type:'close'})+'\n');});return this.closing;}
  dispose():void{void this.close();this.events.removeAllListeners();}
}

