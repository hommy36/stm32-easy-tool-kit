import { MemoryRegion, MemoryReport, MemorySection, MemorySymbol, MemoryComparison } from './types';

const hex = (text: string): number => Number.parseInt(text.replace(/^0x/, ''), 16);
export function parseSections(text: string): MemorySection[] {
  const result: MemorySection[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*\d+\s+(\S+)\s+([\da-f]+)\s+([\da-f]+)\s+([\da-f]+)\s+[\da-f]+\s+2\*\*\d+/i.exec(lines[i]);
    if (!match) continue;
    const flags = lines[i + 1] ?? '';
    result.push({ name: match[1], size: hex(match[2]), vma: hex(match[3]), lma: hex(match[4]),
      alloc: /\bALLOC\b/.test(flags), load: /\bLOAD\b/.test(flags), readonly: /\bREADONLY\b/.test(flags),
      code: /\bCODE\b/.test(flags), reserved: /(?:heap|stack)/i.test(match[1]) });
  }
  if (!result.length) throw new Error('ELF section table is unavailable.');
  return result;
}
export interface MapData { regions: MemoryRegion[]; outputs: { name: string; address: number; size: number }[]; objects: { start: number; end: number; name: string }[]; output?: string; }
const emptyRegion = (name: string, origin: number, capacity: number | undefined, attributes: string, source: MemoryRegion['source']): MemoryRegion =>
  ({ name, origin, capacity, attributes, source, used: 0, extent: 0, holes: 0, reserved: 0, spans: [] });
export function parseMap(text: string): MapData {
  const result: MapData = { regions: [], outputs: [], objects: [] };
  let memory = false, linked = false, pending = '';
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === 'Memory Configuration') { memory = true; continue; }
    if (/^Linker script and memory map/.test(line)) { memory = false; linked = true; continue; }
    if (memory) {
      const match = /^(\S+)\s+(0x[\da-f]+)\s+(0x[\da-f]+)\s*(\S*)/i.exec(line);
      if (match && match[1] !== '*default*') result.regions.push(emptyRegion(match[1], hex(match[2]), hex(match[3]), match[4], 'map'));
    }
    if (!linked) continue;
    const output = /^OUTPUT\((.+?)\s+elf32-/.exec(line); if (output) result.output = output[1].replace(/^"|"$/g, '');
    const section = /^(\.[^\s]+)\s+(0x[\da-f]+)\s+(0x[\da-f]+)/i.exec(line);
    if (section) result.outputs.push({ name: section[1], address: hex(section[2]), size: hex(section[3]) });
    else if (/^\.[^\s]+\s*$/.test(line)) { pending = line.trim(); continue; }
    else if (pending) {
      const continuation = /^\s+(0x[\da-f]+)\s+(0x[\da-f]+)/i.exec(line);
      if (continuation) result.outputs.push({ name: pending, address: hex(continuation[1]), size: hex(continuation[2]) });
    }
    pending = '';
    const object = /^\s+(?:\.\S+\s+)?(0x[\da-f]+)\s+(0x[\da-f]+)\s+(.+?(?:\.(?:o|obj)|\.a\([^)]*\)))\s*$/i.exec(line);
    if (object && hex(object[2])) result.objects.push({ start: hex(object[1]), end: hex(object[1]) + hex(object[2]), name: object[3] });
  }
  return result;
}
export function mapMatchesSections(data: MapData, sections: MemorySection[]): boolean {
  const relevant = sections.filter(section => section.alloc && section.size);
  return relevant.length > 0 && relevant.every(section => data.outputs.some(output => output.name === section.name && output.address === section.vma && output.size === section.size));
}
export function parseScriptRegions(text: string): MemoryRegion[] {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(line => line.split('//')[0]).join('\n');
  const body = /\bMEMORY\s*\{([^}]+)\}/.exec(clean)?.[1] ?? '';
  const regions: MemoryRegion[] = [];
  const literal = (value: string): number => { const match = /^(0x[\da-f]+|\d+)([KM]?)$/i.exec(value.trim()); return match ? Number(match[1]) * (match[2].toUpperCase() === 'K' ? 1024 : match[2].toUpperCase() === 'M' ? 1048576 : 1) : NaN; };
  for (const match of body.matchAll(/(\w+)\s*(?:\(([^)]*)\))?\s*:\s*ORIGIN\s*=\s*([^,\n]+),\s*LENGTH\s*=\s*([^;\r\n}]+)/g)) {
    const origin = literal(match[3]), capacity = literal(match[4]);
    if (Number.isSafeInteger(origin) && Number.isSafeInteger(capacity) && capacity > 0) regions.push(emptyRegion(match[1], origin, capacity, match[2] ?? '', 'script'));
  }
  return regions;
}
export function unionBytes(intervals: { start: number; end: number }[]): number {
  let result = 0, end = -1;
  for (const interval of [...intervals].filter(item => item.end > item.start).sort((a,b) => a.start - b.start || a.end - b.end)) {
    result += Math.max(0, interval.end - Math.max(end, interval.start)); end = Math.max(end, interval.end);
  }
  return result;
}
export function accountRegions(definitions: MemoryRegion[], sections: MemorySection[]): MemoryRegion[] {
  const regions = definitions.map(region => ({ ...region, spans: [] as MemoryRegion['spans'] }));
  const piece = (section: MemorySection, start: number, end: number, kind: 'runtime' | 'load') => {
    let region = regions.find(item => item.capacity !== undefined && start >= item.origin && end <= item.origin + item.capacity);
    if (!region) {
      const name = kind === 'load' ? 'Unmapped load' : 'Unmapped runtime';
      region = regions.find(item => item.name === name);
      if (!region) { region = emptyRegion(name, start, undefined, '', 'unknown'); regions.push(region); }
      region.origin = Math.min(region.origin, start);
    }
    if (!region.spans.some(span => span.start === start && span.end === end && span.section === section.name)) region.spans.push({ start, end, section: section.name, kind });
  };
  const add = (section: MemorySection, start: number, kind: 'runtime' | 'load') => {
    const end=start+section.size;
    const cuts=[start,end,...definitions.flatMap(r=>r.capacity===undefined?[]:[r.origin,r.origin+r.capacity]).filter(n=>n>start&&n<end)].sort((a,b)=>a-b);
    for(let i=1;i<cuts.length;i++)if(cuts[i]>cuts[i-1])piece(section,cuts[i-1],cuts[i],kind);
  };
  for (const section of sections.filter(item => item.alloc && item.size > 0)) {
    add(section, section.vma, 'runtime');
    if (section.load && section.lma !== section.vma) add(section, section.lma, 'load');
  }
  for (const region of regions) {
    region.used = unionBytes(region.spans);
    region.reserved = unionBytes(region.spans.filter(span => sections.some(section => section.name === span.section && section.reserved)));
    region.extent = region.spans.length ? Math.max(...region.spans.map(span => span.end)) - region.origin : 0;
    region.holes = Math.max(0, region.extent - region.used);
    if (region.capacity !== undefined) region.free = Math.max(0, region.capacity - region.used);
  }
  return regions;
}
export function parseSymbols(text: string): MemorySymbol[] {
  const symbols: MemorySymbol[] = [];
  const aliases = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([\da-f]+)\s+([\da-f]+)\s+([a-zA-Z?])\s+(.+?)(?:\t(.+?):(\d+)(?:\s.*)?)?$/i.exec(line);
    if (!match) continue;
    const address = hex(match[1]), size = hex(match[2]);
    if (!size || /[aAnNuU]/.test(match[3])) continue;
    const key = `${address}:${size}`;
    symbols.push({ id: `${match[4]}:${address}:${symbols.length}`, name: match[4], address, size, type: match[3],
      source: match[5], line: match[6] ? Number(match[6]) : undefined, alias: aliases.has(key) });
    aliases.add(key);
  }
  return symbols;
}
export function attributeSymbols(symbols: MemorySymbol[], regions: MemoryRegion[], sections: MemorySection[], objects: MapData['objects']): void {
  const sorted = [...objects].sort((a,b) => a.start - b.start || a.end - b.end);
  for (const symbol of symbols) {
    const section = sections.find(item => item.alloc && symbol.address >= item.vma && symbol.address < item.vma + item.size);
    symbol.section = section?.name;
    symbol.region = regions.find(item => item.spans.some(span => span.kind === 'runtime' && span.section === section?.name && symbol.address >= span.start && symbol.address < span.end))?.name;
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (sorted[mid].start <= symbol.address) lo = mid + 1; else hi = mid; }
    const object = sorted[lo - 1];
    if (object && symbol.address < object.end) symbol.object = object.name;
  }
}
export function compareReports(current: MemoryReport, baseline: MemoryReport): MemoryComparison {
  if (current.key !== baseline.key) throw new Error('Cannot compare different projects, configurations or targets.');
  const aggregate = (report: MemoryReport) => {
    const map = new Map<string, { name: string; object?: string; size: number }>();
    for (const symbol of report.symbols.filter(item => !item.alias)) { const key = `${symbol.name}\0${symbol.object ?? symbol.source ?? ''}\0${symbol.section ?? ''}`; const old = map.get(key); map.set(key, { name: symbol.name, object: symbol.object, size: (old?.size ?? 0) + symbol.size }); }
    return map;
  };
  const before = aggregate(baseline), after = aggregate(current);
  return { baselineId: baseline.id,
    regions: [...new Set([...baseline.regions, ...current.regions].map(region => region.name))].map(name => { const a = baseline.regions.find(r => r.name === name)?.used ?? 0, b = current.regions.find(r => r.name === name)?.used ?? 0; return { name, before: a, after: b, delta: b-a }; }),
    symbols: [...new Set([...before.keys(), ...after.keys()])].map(key => { const a = before.get(key), b = after.get(key); return { name: (b ?? a)!.name, object: (b ?? a)!.object, before: a?.size ?? 0, after: b?.size ?? 0, delta: (b?.size ?? 0)-(a?.size ?? 0), kind: (!a ? 'added' : !b ? 'removed' : 'changed') as 'added' | 'removed' | 'changed' }; }).filter(item => item.delta !== 0).sort((a,b) => Math.abs(b.delta)-Math.abs(a.delta)) };
}
