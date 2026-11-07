import * as path from 'node:path';
import { runProcess } from '../core/process';
export interface ProbeDevice { name:string; driver:string; status:string; code:number; }
export function parseProbeDevices(text:string):ProbeDevice[]{const raw=JSON.parse(text.trim()||'[]');return (Array.isArray(raw)?raw:[raw]).filter(row=>row&&typeof row.Name==='string').slice(0,64).map(row=>({name:row.Name.slice(0,180),driver:String(row.Service??'unknown').slice(0,80),status:String(row.Status??'Unknown'),code:Number(row.ConfigManagerErrorCode)}));}
/** Read-only PnP inventory. Matching names do not establish a usable debug interface. */
export async function discoverProbeDevices():Promise<ProbeDevice[]>{
 const root=process.env.SystemRoot;if(!root)throw new Error('Windows system directory unavailable.');
 const command="$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; @(Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match 'ST.?LINK|CMSIS.?DAP|DAPLink|J.?Link' -and $_.Present } | Select-Object Name,Service,Status,ConfigManagerErrorCode) | ConvertTo-Json -Compress";
 const result=await runProcess({executable:path.join(root,'System32/WindowsPowerShell/v1.0/powershell.exe'),args:['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],timeoutMs:12000});
 if(result.exitCode!==0||result.timedOut)throw new Error('Windows PnP inventory unavailable: '+result.stderr.slice(0,500));return parseProbeDevices(result.stdout);
}

