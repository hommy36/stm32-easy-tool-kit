import { explorerBody } from './memoryExplorerHtml';
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { MemoryAnalysisService } from '../memory/service';
import { exportReport } from '../memory/export';
import { RuntimeMonitorService } from '../runtime/monitor';
import { escapeHtml } from '../i18n';
import { featureLocale, featureText as f } from './featureLocale';
import { isWithin } from '../build/artifacts';

export { allocationTree } from '../memory/tree';
import { allocationTree } from '../memory/tree';
export function memoryBody(): string {
  const button = (action: string, label: string) => `<button class="secondary" data-action="${action}">${escapeHtml(f(label))}</button>`;
  return `<main class="studio"><header class="studio-header"><div><p class="eyebrow">STM32 EASY TOOL KIT</p><h1>${escapeHtml(f('Memory studio'))}</h1><p id="identity" class="hint"></p></div><div class="actions">${button('refresh','Refresh analysis')}${button('cancel','Cancel analysis')}${button('export','Export')}</div></header>
  <nav class="studio-tabs" role="tablist">${['Overview','Layout & symbols','Build comparison','Runtime monitor'].map((label,i)=>`<button role="tab" id="tab-${i}" aria-controls="pane-${i}" data-tab="${i}" aria-selected="${i===0}">${escapeHtml(f(label))}</button>`).join('')}</nav>
  <div id="notice" class="studio-notice" role="status"></div><section id="pane-0" role="tabpanel" aria-labelledby="tab-0"><details id="memory-summary"><summary>${escapeHtml(f('Region usage'))}<span id="region-summary-text"></span></summary><div id="regions" class="metric-grid"></div></details>${explorerBody()}<div id="warnings" class="studio-notice"></div></section>
  <section id="pane-1" role="tabpanel" aria-labelledby="tab-1" hidden><div class="studio-card"><h2>${escapeHtml(f('Address layout'))}</h2><div id="layout" class="address-layout"></div></div><div class="studio-card"><h2>${escapeHtml(f('Symbol details'))}</h2><div class="filter-row"><input id="search" aria-label="${escapeHtml(f('Search symbols or files'))}" placeholder="${escapeHtml(f('Search symbols or files'))}"><select id="region-filter" aria-label="${escapeHtml(f('Region'))}"></select><select id="type-filter" aria-label="${escapeHtml(f('All types'))}"><option value="">${escapeHtml(f('All types'))}</option><option value="code">${escapeHtml(f('Functions'))}</option><option value="data">${escapeHtml(f('Data'))}</option></select><select id="sort" aria-label="Sort"><option value="size">${escapeHtml(f('Size'))}</option><option value="name">${escapeHtml(f('Name'))}</option><option value="address">${escapeHtml(f('Address'))}</option></select></div><div class="table-scroll"><table><thead><tr>${['Name','Size','Address','Region','Object / source'].map(label=>`<th>${escapeHtml(f(label))}</th>`).join('')}</tr></thead><tbody id="symbols"></tbody></table></div><div class="pager"><button id="previous" class="secondary">${escapeHtml(f('Previous'))}</button><span id="page-label"></span><button id="next" class="secondary">${escapeHtml(f('Next'))}</button></div></div></section>
  <section id="pane-2" role="tabpanel" aria-labelledby="tab-2" hidden><div class="actions">${button('pin','Pin baseline')}${button('unpin','Clear baseline')}</div><div class="studio-card"><div id="comparison-regions" class="metric-grid"></div><div id="comparison"></div></div></section>
  <section id="pane-3" role="tabpanel" aria-labelledby="tab-3" hidden><p class="hint">${escapeHtml(f('Experimental runtime support; verify your board and probe combination.'))}</p><div class="actions runtime-actions"><button class="primary" data-action="monitorSetup">${escapeHtml(f('One-click monitor setup'))}</button>${button('monitor','Connect & monitor')}${button('sampling','Heap sampling rate')}${button('snapshot','Paused snapshot')}${button('stop','Stop connection')}<details><summary>${escapeHtml(f('Advanced settings'))}</summary><div class="actions">${button('features','Configure features')}${button('component','Get firmware component')}</div></details></div><p class="hint">${escapeHtml(f('First use: set up monitoring, flash the generated firmware, then connect. Existing components are detected from ELF.'))}</p><div class="runtime-status" id="runtime-status" role="status"></div><p id="observed-rate" class="hint"></p><div id="runtime-cards" class="metric-grid"></div><div class="studio-card"><div class="card-heading"><h2>${escapeHtml(f('Heap trend'))}</h2><div class="actions"><select id="time-range" aria-label="Time range"><option value="60000">1 min</option><option value="300000">5 min</option><option value="600000" selected>10 min</option></select><button id="pause-display" class="secondary">${escapeHtml(f('Pause display'))}</button>${button('samples','Export samples')}</div></div><div id="trend" class="chart" role="img" aria-label="${escapeHtml(f('Heap trend'))}"></div></div><div class="studio-card"><details><summary>${escapeHtml(f('Sample history'))}</summary><div class="table-scroll" id="sample-history"></div></details><h2>${escapeHtml(f('Task stacks'))}</h2><div id="tasks" class="table-scroll"></div><h2>${escapeHtml(f('Runtime registers'))}</h2><pre id="registers"></pre></div></section></main>`;
}
export class MemoryPanel {
  private panel?: vscode.WebviewPanel; private subscriptions: { dispose(): void }[] = []; private runtimeTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly context: vscode.ExtensionContext, private readonly memory: MemoryAnalysisService, private readonly runtime: RuntimeMonitorService,
    private readonly source: () => Promise<string | undefined>, private readonly action: (name: string) => Promise<void>,
    private readonly identity: () => Promise<string> = async()=>'', private readonly closed:()=>void = ()=>{}) {
    this.subscriptions.push(memory.onChange(() => void this.send().catch(error=>this.panel?.webview.postMessage({type:'error',message:String(error)}))));
    const changed = () => { if (!this.runtimeTimer) this.runtimeTimer = setTimeout(() => { this.runtimeTimer = undefined; void this.sendRuntime(); }, 200); };
    runtime.events.on('change',changed); this.subscriptions.push({ dispose:()=>runtime.events.off('change',changed) });
  }
  open(): void {
    if (this.panel) { this.panel.reveal(); return; }
    const root = vscode.Uri.joinPath(this.context.extensionUri,'resources');
    const panel = vscode.window.createWebviewPanel('stm32Easy.memory',f('Memory studio'),vscode.ViewColumn.Active,{ enableScripts:true,localResourceRoots:[root],retainContextWhenHidden:true }); this.panel = panel;
    const nonce = randomBytes(24).toString('base64'), uri = (file:string)=>panel.webview.asWebviewUri(vscode.Uri.joinPath(root,file)).toString();
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${panel.webview.cspSource} data:; connect-src 'none'"><link rel="stylesheet" href="${uri('workbench/workbench.css')}"><link rel="stylesheet" href="${uri('workbench/memory.css')}"></head><body>${memoryBody()}<script nonce="${nonce}">window.featureMessages=${JSON.stringify(featureLocale()).replace(/</g,'\u003c')};</script><script nonce="${nonce}" src="${uri('vendor/echarts.min.js')}"></script><script nonce="${nonce}" src="${uri('workbench/memoryExplorer.js')}"></script><script nonce="${nonce}" src="${uri('workbench/memory.js')}"></script></body></html>`;
    const receive = panel.webview.onDidReceiveMessage(async raw => {
      try {
        if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return;
        if (raw.type === 'ready') { await this.send(); await this.sendRuntime(); return; }
        if (raw.context !== await this.identity()) throw new Error('Project context changed. Reopen the memory panel.');
        const report = this.memory.state.report;
        if (raw.type === 'symbols') { if (raw.reportId !== report?.id) return; await this.sendSymbols(raw); return; }
        if (raw.type === 'hex') {
          if (typeof raw.reportId !== 'string' || typeof raw.id !== 'string' || !Number.isSafeInteger(raw.request) || !Number.isSafeInteger(raw.offset)) return;
          try {
            const page = await this.memory.readHex(raw.reportId,raw.id,raw.offset);
            if (this.panel !== panel || raw.context !== await this.identity() || this.memory.state.report?.id !== raw.reportId || this.memory.state.phase !== 'ready') return;
            await panel.webview.postMessage({type:'hex',reportId:raw.reportId,request:raw.request,page});
          } catch(error) {
            if (this.panel === panel) await panel.webview.postMessage({type:'hexError',reportId:raw.reportId,request:raw.request,message:error instanceof Error ? error.message : String(error)});
          }
          return;
        }
        if (raw.type === 'source') {
          if (!report || raw.reportId !== report.id) return; const symbol = report.symbols.find(item=>item.id===raw.id); if (!symbol) return;
          const root = await this.source(); if (!root || !symbol.source) { await vscode.env.clipboard.writeText(`0x${symbol.address.toString(16)}`); return; }
          const file = await fs.realpath(path.resolve(root,symbol.source)); if (!isWithin(await fs.realpath(root),file)) throw new Error('Source path is outside the current project.');
          const editor = await vscode.window.showTextDocument(vscode.Uri.file(file)); const line = Math.max(0,Math.min(editor.document.lineCount-1,(symbol.line ?? 1)-1)); editor.selection = new vscode.Selection(line,0,line,0); editor.revealRange(new vscode.Range(line,0,line,0)); return;
        }
        if (raw.type !== 'action' || typeof raw.action !== 'string') return;
        if (['pin','unpin','export'].includes(raw.action) && (!report || raw.reportId !== report.id || this.memory.state.phase !== 'ready')) throw new Error('Report is stale.');
        if (raw.action === 'pin' || raw.action === 'unpin') await this.memory.pin(raw.action === 'pin');
        else if (raw.action === 'export' && report) { const format = await vscode.window.showQuickPick(['html','csv','json']); if (!format) return; const file = await vscode.window.showSaveDialog({ defaultUri:vscode.Uri.file(path.join(await this.source() ?? '', `memory-report.${format}`)), filters:{ [format]:[format] } }); if (file) await vscode.workspace.fs.writeFile(file,Buffer.from(exportReport(report,format as 'html'|'csv'|'json'))); }
        else if (raw.action === 'samples') { const file = await vscode.window.showSaveDialog({ filters:{JSON:['json']} }); if (file) await vscode.workspace.fs.writeFile(file,Buffer.from(JSON.stringify(this.runtime.history,null,2))); }
        else if (['refresh','cancel','monitor','monitorSetup','sampling','snapshot','stop','features','component'].includes(raw.action)) await this.action(raw.action);
      } catch (error) { await panel.webview.postMessage({type:'error',message:String(error)}); }
    });
    panel.onDidDispose(()=>{ receive.dispose(); this.panel = undefined; this.closed(); });
  }
  private async send(): Promise<void> {
    if (!this.panel) return; const context=await this.identity(),state = this.memory.state, report = state.report;
    await this.panel?.webview.postMessage({type:'state',context,phase:state.phase,message:state.message,pinned:state.pinned,
      report:report ? {...report,symbols:undefined,tree:allocationTree(report),symbolCount:report.symbols.length}:undefined,
      comparison:state.comparison ? {...state.comparison,totalSymbols:state.comparison.symbols.length,symbols:state.comparison.symbols.slice(0,300)}:undefined});
  }
  private async sendSymbols(raw: Record<string, unknown>): Promise<void> {
    const report = this.memory.state.report; if (!report) return;
    const query = typeof raw.query === 'string' ? raw.query.slice(0,256).toLowerCase() : '';
    const rows = report.symbols.filter(s=>(!raw.region || s.region===raw.region) && (!raw.kind || (raw.kind==='code' ? /[tTwW]/.test(s.type) : !/[tTwW]/.test(s.type))) && (!query || `${s.name} ${s.object ?? ''} ${s.source ?? ''}`.toLowerCase().includes(query)))
      .sort(raw.sort==='name' ? (a,b)=>a.name.localeCompare(b.name) : raw.sort==='address' ? (a,b)=>a.address-b.address : (a,b)=>b.size-a.size);
    const page = Math.max(0,Math.min(Math.ceil(rows.length/100)-1,Number.isInteger(raw.page) ? Number(raw.page) : 0));
    await this.panel?.webview.postMessage({type:'symbols',reportId:report.id,request:raw.request,page,total:rows.length,rows:rows.slice(page*100,page*100+100)});
  }
  private async sendRuntime(): Promise<void> { await this.panel?.webview.postMessage({type:'runtime',status:this.runtime.status,observedRateHz:this.runtime.observedRateHz,message:this.runtime.message,latest:this.runtime.latest,history:this.runtime.history.filter(s=>s.source==='rtt').map(s=>({at:s.receivedAt,free:s.heap?.free,minimum:s.heap?.minimum,largest:s.heap?.largest,gaps:s.gaps,drop:s.dropped}))}); }
  dispose(): void { this.panel?.dispose(); if(this.runtimeTimer)clearTimeout(this.runtimeTimer); for(const item of this.subscriptions)item.dispose(); }
}
