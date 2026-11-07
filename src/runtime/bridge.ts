import * as net from 'node:net';
import { DebugSessionOwner } from '../debug/session';
import { OwnedGdbServer } from '../dap/server';
import { RuntimeMonitorService, RuntimeSnapshot } from './monitor';
import { FeatureSettings } from '../project/features';

export class RttConnection {
  private socket?: net.Socket; private timer?: ReturnType<typeof setInterval>; private starting = false; private disposed = false;
  constructor(private readonly server: OwnedGdbServer, private readonly monitor: RuntimeMonitorService, private readonly firmware: string) {}
  async start(): Promise<void> {
    if (!this.server.rtt) throw new Error('RTT was not configured for this debug server.');
    this.monitor.reset(this.firmware);
    const socket = net.createConnection({ host: '127.0.0.1', port: this.server.rtt.port }); this.socket = socket; socket.setEncoding('utf8');
    socket.on('data', chunk => this.monitor.feed(String(chunk)));
    socket.on('error', error => this.monitor.setStatus('error', error.message));
    socket.on('close', () => { if(this.timer)clearInterval(this.timer);if (!this.disposed) this.monitor.setStatus('disconnected', 'RTT connection closed.'); });
    await new Promise<void>((resolve,reject) => { const timer = setTimeout(() => { socket.destroy(); reject(new Error('RTT data connection timed out.')); }, 5000); socket.once('connect', () => { clearTimeout(timer); resolve(); }); socket.once('error', error => { clearTimeout(timer); reject(error); }); });
    let attempts = 0;
    const begin = async () => {
      if (this.disposed || this.starting) return;
      if (this.monitor.latest && Date.now() - this.monitor.latest.receivedAt < 10000) return;
      if (this.monitor.latest) this.monitor.setStatus('connecting', 'Samples are stale; checking RTT again.');
      this.starting = true;
      try { await this.server.rtt!.command('rtt start'); if (++attempts >= 30) { this.monitor.setStatus('error', 'No valid RTT samples. Check firmware ID, control-block address, initialization and cache coherence.'); if (this.timer) clearInterval(this.timer); } }
      catch (error) { this.monitor.setStatus('error', String(error)); if (this.timer) clearInterval(this.timer); }
      finally { this.starting = false; }
    };
    this.timer = setInterval(() => void begin(), 1000); void begin();
    void this.server.finished.then(() => this.dispose(), () => this.dispose());
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; if (this.timer) clearInterval(this.timer); this.socket?.destroy(); this.monitor.setStatus('disconnected', 'Target connection ended.'); }
}
export async function capturePaused(owner: DebugSessionOwner, monitor: RuntimeMonitorService, debug?: FeatureSettings['debug']): Promise<void> {
  const session = owner.ownedSession; if (!session || !owner.isPaused) throw new Error('Pause the owned debug session before reading a snapshot.');
  const registers: Record<string, number> = {}, warnings: string[] = [];
  const expressions: [string,string][] = [['sp','$sp'], ['msp','$msp'], ['psp','$psp'], ['pc','$pc']];
  if (debug?.core && debug.core !== 'm0') expressions.push(['cfsr','*(unsigned int*)0xE000ED28'], ['hfsr','*(unsigned int*)0xE000ED2C']);
  if(debug?.rtos==='FreeRTOS' && debug.heapImplementation) expressions.push(['heapFree','xFreeBytesRemaining'],['heapMinimum','xMinimumEverFreeBytesRemaining']);
  for (const [name,expression] of expressions) {
    if (!owner.isPaused || owner.ownedSession !== session) throw new Error('Target resumed; snapshot discarded.');
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([session.customRequest('evaluate', { expression, context: 'watch' }), new Promise<never>((_resolve,reject) => { timer = setTimeout(() => reject(new Error('Snapshot timed out.')), 3000); })]).finally(() => { if (timer) clearTimeout(timer); });
      const match = /^\s*(0x[0-9a-f]+|\d+)(?:\s+<[^>]*>)?\s*$/i.exec(String(response?.result ?? '')); if (match && Number(match[1]) <= 0xffffffff) registers[name] = Number(match[1]); else warnings.push(`${name}: unavailable`);
    } catch { warnings.push(`${name}: unavailable`); }
  }
  if (!owner.isPaused || owner.ownedSession !== session) throw new Error('Target resumed; snapshot discarded.');
  if (registers.cfsr !== undefined) { for (const [bit,label] of [[0,'Instruction access fault'],[1,'Data access fault'],[8,'Instruction bus error'],[9,'Precise data bus error'],[10,'Imprecise data bus error'],[16,'Undefined instruction'],[17,'Invalid state'],[24,'Unaligned access'],[25,'Divide by zero']] as const) if (registers.cfsr & (1 << bit)) warnings.push(label); }
  const snapshot: RuntimeSnapshot = { version: 1, firmware: 'owned-debug-session', sessionId: session.id, boot: 0, sequence: 0, ticks: 0, receivedAt: Date.now(), source: 'paused', registers, dropped: 0, gaps: 0, warnings };
  const bounds=debug?.stack;
  if(bounds){const sp=registers[bounds.pointer];if(sp!==undefined&&sp>=bounds.low&&sp<=bounds.high)snapshot.stack={current:bounds.high-sp,capacity:bounds.high-bounds.low};else warnings.push('Stack pointer is unavailable or outside the configured bounds.');}
  else warnings.push('Stack bounds are unknown; depth is unavailable.');
  if(registers.heapFree!==undefined||registers.heapMinimum!==undefined){if(registers.heapFree!==undefined&&registers.heapMinimum!==undefined&&registers.heapMinimum>registers.heapFree)warnings.push('Heap counters are inconsistent; snapshot may be inside an allocator operation.');else snapshot.heap={free:registers.heapFree,minimum:registers.heapMinimum};delete registers.heapFree;delete registers.heapMinimum;}
  else warnings.push('Heap counters unavailable; enable supported heap symbols or use the optional component.');
  monitor.accept(snapshot); monitor.setStatus('paused', 'Read-only paused snapshot; stack bounds are user verified and heap counters require matching debug symbols.');
}
