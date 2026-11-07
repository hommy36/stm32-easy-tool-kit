import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
export interface RuntimeTask { id: number; name: string; state?: number; priority?: number; free?: number; capacity?: number; }
export interface RuntimeSnapshot {
  version: 1; firmware: string; boot: number; sequence: number; ticks: number; receivedAt: number; source: 'rtt' | 'paused';
  heap?: { total?: number; free?: number; minimum?: number; largest?: number }; tasks?: RuntimeTask[];
  registers?: Record<string, number>; stack?: { current?: number; peak?: number; capacity?: number };
  dropped: number; gaps: number; warnings: string[]; tasksTicks?: number; sessionId?: string;
}
const unsigned = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
export function parseRuntimeFrame(line: string, now = Date.now()): RuntimeSnapshot {
  if (line.length > 65536 || !line.startsWith('SE1 ')) throw new Error('Unsupported telemetry frame.');
  const raw = JSON.parse(line.slice(4));
  if (raw.v !== 1 || typeof raw.fw !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(raw.fw) || !unsigned(raw.boot) || !unsigned(raw.seq) || !unsigned(raw.ms) || !unsigned(raw.drop)) throw new Error('Invalid telemetry identity.');
  const optional = (value: unknown): number | undefined => { if (value === undefined || value === null) return undefined; if (!unsigned(value)) throw new Error('Invalid telemetry metric.'); return value; };
  const result: RuntimeSnapshot = { version: 1, firmware: raw.fw, boot: raw.boot, sequence: raw.seq, ticks: raw.ms, receivedAt: now, source: 'rtt', dropped: raw.drop, gaps: 0, warnings: [] };
  if (raw.tasks_ms !== undefined) result.tasksTicks = optional(raw.tasks_ms);
  if (raw.tasks_incomplete === true) result.warnings.push('Task list exceeds the fixed snapshot capacity; increase STME_MAX_TASKS.');
  if (raw.frame_overflow === true) result.warnings.push('Firmware telemetry frame exceeds its fixed buffer. Increase STME_FRAME_BYTES and STME_BUFFER_BYTES or reduce task capacity.');
  if (raw.heap) {
    result.heap = { total: optional(raw.heap.total), free: optional(raw.heap.free), minimum: optional(raw.heap.min), largest: optional(raw.heap.largest) };
    const h = result.heap; if (h.total !== undefined && h.free !== undefined && h.free > h.total || h.free !== undefined && h.largest !== undefined && h.largest > h.free || h.minimum !== undefined && h.free !== undefined && h.minimum > h.free) throw new Error('Inconsistent heap metrics.');
  }
  if (raw.stack) { result.stack = { current: optional(raw.stack.current), peak: optional(raw.stack.peak), capacity: optional(raw.stack.capacity) }; const s = result.stack; if (s.capacity !== undefined && (s.current !== undefined && s.current > s.capacity || s.peak !== undefined && s.peak > s.capacity)) throw new Error('Inconsistent stack metrics.'); }
  if (raw.tasks !== undefined) {
    if (!Array.isArray(raw.tasks) || raw.tasks.length > 128) throw new Error('Too many tasks.');
    const ids = new Set<number>();
    result.tasks = raw.tasks.map((task: Record<string, unknown>) => {
      if (!unsigned(task.id) || ids.has(task.id) || typeof task.name !== 'string' || task.name.length > 64 || /[\x00-\x1f]/.test(task.name)) throw new Error('Invalid task identity.'); ids.add(task.id);
      const free = optional(task.free), capacity = optional(task.capacity); if (free !== undefined && capacity !== undefined && free > capacity) throw new Error('Task stack exceeds capacity.');
      return { id: task.id, name: task.name, free, capacity, state: optional(task.state), priority: optional(task.priority) };
    });
  }
  return result;
}
export class RuntimeMonitorService {
  readonly events = new EventEmitter();
  status: 'disconnected' | 'connecting' | 'live' | 'paused' | 'error' = 'disconnected';
  message = ''; latest?: RuntimeSnapshot; readonly history: RuntimeSnapshot[] = [];
  private buffer = ''; private expected?: string; private previous?: RuntimeSnapshot; private sessionId = randomUUID();
  get observedRateHz(): number | undefined {
    const latest = this.latest;
    if (this.status !== 'live' || !latest || latest.source !== 'rtt' || Date.now() - latest.receivedAt > 10000) return undefined;
    const recent = this.history.slice(-31).filter(sample => sample.source === 'rtt' && sample.firmware === latest.firmware && sample.boot === latest.boot && sample.sessionId === latest.sessionId);
    if (recent.length < 2) return undefined;
    const elapsed = (latest.ticks - recent[0].ticks) >>> 0;
    return elapsed > 0 && elapsed < 0x80000000 ? (recent.length - 1) * 1000 / elapsed : undefined;
  }
  reset(firmware?: string): void { this.sessionId=randomUUID();this.buffer = ''; this.expected = firmware; this.previous = undefined; this.latest = undefined; this.history.length = 0; this.setStatus('connecting', 'Waiting for RTT telemetry.'); }
  setStatus(status: RuntimeMonitorService['status'], message = ''): void { this.status = status; this.message = message; this.events.emit('change'); }
  feed(chunk: string, now = Date.now()): void {
    this.buffer += chunk; if (this.buffer.length > 131072) { this.buffer = ''; this.setStatus('error', 'Telemetry buffer limit exceeded.'); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, ''); this.buffer = this.buffer.slice(newline + 1); if (!line.startsWith('SE1 ')) continue;
      try {
        const sample = parseRuntimeFrame(line, now);
        sample.sessionId=this.sessionId;
        if(sample.heap?.total && sample.heap.minimum!==undefined && sample.heap.minimum/sample.heap.total<0.1)sample.warnings.push('Historical heap free space is below 10%.');
        for(const task of sample.tasks??[])if(task.capacity&&task.free!==undefined&&task.free/task.capacity<0.1)sample.warnings.push(`Task ${task.name}: historical stack free space is below 10%.`);
        if (this.expected && sample.firmware !== this.expected) { this.setStatus('error', 'Firmware identity mismatch; samples rejected.'); continue; }
        const previous = this.previous;
        if (previous && previous.firmware === sample.firmware && previous.boot === sample.boot && ((sample.ticks - previous.ticks) >>> 0) < 0x80000000) {
          const delta = (sample.sequence - previous.sequence) >>> 0; if (delta === 0) continue; if (delta > 0x7fffffff) throw new Error('Out-of-order telemetry.');
          sample.gaps = previous.gaps + Math.max(0, delta - 1);
        } else if (previous) { sample.warnings.push('Target restarted or telemetry session changed.'); this.history.length = 0; }
        if (!this.expected) sample.warnings.push('Firmware identity is not pinned; select the expected build in feature settings.');
        this.previous = sample; this.accept(sample); this.setStatus('live');
      } catch (error) { this.setStatus('error', String(error)); }
    }
  }
  accept(snapshot: RuntimeSnapshot): void {
    this.latest = snapshot; this.history.push(snapshot);
    while (this.history.length && (this.history.length > 6000 || snapshot.receivedAt - this.history[0].receivedAt > 600000)) this.history.shift();
    this.events.emit('change');
  }
  dispose(): void { this.events.removeAllListeners(); this.history.length = 0; }
}
