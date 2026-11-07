import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { BuildEvidence, inspectArmElf, isWithin } from '../build/artifacts';
import { FirmwareTarget } from '../build/fileApi';
import { commandWords } from '../build/dependencies';
import { ToolInstallation } from '../core/types';
import { replaceFile } from '../core/atomicFile';
import { AnalysisState, MemoryReport } from './types';
import { ElfByteReader, HexPage } from './hex';
import { accountRegions, attributeSymbols, compareReports, mapMatchesSections, parseMap, parseScriptRegions, parseSections, parseSymbols } from './parsers';

export function analysisKey(evidence: Pick<BuildEvidence, 'projectUri' | 'configurePreset' | 'buildPreset' | 'configuration' | 'targetId'>): string {
  return createHash('sha256').update(JSON.stringify([evidence.projectUri.toLowerCase(), evidence.configurePreset, evidence.buildPreset ?? '', evidence.configuration, evidence.targetId])).digest('hex');
}
export function mapPathFromFragments(fragments: string[], directory: string): string | undefined {
  const words = fragments.flatMap(fragment => commandWords(fragment)).flatMap(word => word.startsWith('-Wl,') ? word.slice(4).split(',') : [word]).filter(word => word !== '-Xlinker');
  const found: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '-Map' || words[i] === '--Map') { if (words[i + 1]) found.push(words[++i]); }
    else if (/^--?Map=/.test(words[i])) found.push(words[i].slice(words[i].indexOf('=') + 1));
    else if (words[i].startsWith('-Map') && words[i].length > 4) found.push(words[i].slice(4));
  }
  const paths = [...new Set(found.map(file => path.resolve(directory, file)))];
  return paths.length === 1 ? paths[0] : undefined;
}
export function captureTool(executable: string, args: string[], signal: AbortSignal, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
    const chunks: Buffer[] = []; let bytes = 0, error = '', failure: Error | undefined;
    const stop = () => { failure ??= new Error('Analysis cancelled.'); child.kill(); };
    const timeout = setTimeout(() => { failure = new Error('Analysis tool timed out.'); child.kill(); }, 60000);
    signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024 * 1024) { failure = new Error('Analysis output exceeds 64 MiB.'); child.kill(); } else chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-8192); });
    child.on('error', reason => { failure = reason; });
    child.on('close', code => { clearTimeout(timeout); signal.removeEventListener('abort', stop); if (failure || code !== 0) reject(failure ?? new Error(`${path.basename(executable)}: ${error || code}`)); else resolve(Buffer.concat(chunks).toString('utf8')); });
    if (signal.aborted) stop();
  });
}
async function readLimited(file: string, maximum = 64 * 1024 * 1024): Promise<string> {
  const stat = await fs.stat(file); if (!stat.isFile() || stat.size > maximum) throw new Error('Analysis input is too large or is not a file.');
  return fs.readFile(file, 'utf8');
}
export class MemoryAnalysisService {
  state: AnalysisState = { phase: 'empty' };
  private generation = 0; private abort?: AbortController; private listeners = new Set<() => void>();
  private history = new Map<string, MemoryReport[]>(); private pinned = new Map<string, MemoryReport>();
  private liveArtifact?: {reportId:string;file:string}; private readonly bytes = new ElfByteReader();
  constructor(private readonly directory: string) {}
  onChange(listener: () => void): { dispose(): void } { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; }
  private emit(): void { for (const listener of this.listeners) listener(); }
  invalidate(clear = false): void { this.abort?.abort(); this.liveArtifact=undefined;this.bytes.clear();this.generation++; this.state = !clear && this.state.report ? { ...this.state, phase: 'stale' } : { phase: 'empty' }; this.emit(); }
  cancel(): void { this.invalidate(); }
  dispose(): void { this.abort?.abort(); this.listeners.clear(); }
  async analyze(evidence: BuildEvidence, target: FirmwareTarget, tools: ToolInstallation[], budgets: Record<string, number> = {}): Promise<void> {
    this.liveArtifact=undefined;this.bytes.clear();
    this.abort?.abort(); const abort = new AbortController(); this.abort = abort; const generation = ++this.generation;
    this.state = { phase: 'analyzing' }; this.emit(); const start = Date.now();
    try {
      const arm = tools.find(tool => tool.id === 'armGnu');
      if (!arm?.executables.objdump || !arm.executables.nm) throw new Error('Arm GNU objdump and nm are required for memory analysis.');
      const initial = await inspectArmElf(evidence.artifact);
      if (initial.sha256 !== evidence.artifactSha256) throw new Error('ELF changed after the build; rebuild before analysis.');
      const [sectionText, symbolText] = await Promise.all([captureTool(arm.executables.objdump, ['-h', evidence.artifact], abort.signal),
        captureTool(arm.executables.nm, ['-S', '-n', '-l', '-C', '--defined-only', evidence.artifact], abort.signal)]);
      const sections = parseSections(sectionText), symbols = parseSymbols(symbolText), warnings: string[] = [];
      let definitions: ReturnType<typeof parseScriptRegions> = [], objects: ReturnType<typeof parseMap>['objects'] = [], mapFile: string | undefined;
      const candidate = mapPathFromFragments(target.linkFragments ?? [], evidence.binaryDirectory);
      if (candidate) {
        try {
          const actual = await fs.realpath(candidate);
          if (!isWithin(evidence.binaryDirectory, actual) && !isWithin(evidence.inputScope.sourceDirectory, actual)) throw new Error('MAP is outside the project and build directories.');
          const mapBefore = await fs.stat(actual);
          const data = parseMap(await readLimited(actual));
          const mapAfter = await fs.stat(actual);
          if (mapBefore.mtimeMs !== mapAfter.mtimeMs || mapBefore.size !== mapAfter.size) throw new Error('MAP changed during analysis; result discarded.');
          const outputMatches = !data.output || path.resolve(evidence.binaryDirectory, data.output).toLowerCase() === path.resolve(evidence.artifact).toLowerCase();
          const fresh = (await fs.stat(actual)).mtimeMs + 3000 >= (await fs.stat(evidence.artifact)).mtimeMs;
          if (!outputMatches || !fresh || !mapMatchesSections(data, sections)) throw new Error('MAP does not match the current ELF; MAP data was ignored.');
          definitions = data.regions; objects = data.objects; mapFile = actual;
        } catch (error) { warnings.push(String(error)); }
      } else warnings.push('No target-bound MAP file. Add target_link_options(<target> PRIVATE -Wl,-Map=<target>.map) for object attribution.');
      if (!definitions.length) {
        for (const file of evidence.inputFiles.filter(file => /\.(?:ld|lds)$/i.test(file))) { try { definitions.push(...parseScriptRegions(await readLimited(file, 8 * 1024 * 1024))); } catch (error) { warnings.push(String(error)); } }
        definitions = [...new Map(definitions.map(region => [`${region.name}:${region.origin}:${region.capacity}`, region])).values()];
        if (definitions.some((a,i) => definitions.some((b,j) => i !== j && a.origin < b.origin + b.capacity! && b.origin < a.origin + a.capacity!))) { definitions = []; warnings.push('Ambiguous overlapping MEMORY definitions; capacities are unavailable.'); }
      }
      const regions = accountRegions(definitions, sections);
      for (const region of regions) if (budgets[region.name] !== undefined && region.used > budgets[region.name]) warnings.push(`${region.name}: ${region.used} B exceeds the configured ${budgets[region.name]} B budget (warning only).`);
      if (regions.some(region => region.capacity === undefined)) warnings.push('Some addresses have no verified memory capacity; percentages are unavailable.');
      attributeSymbols(symbols, regions, sections, objects);
      const relative = (file: string) => isWithin(evidence.inputScope.sourceDirectory, file) ? path.relative(evidence.inputScope.sourceDirectory, file).replace(/\\/g, '/') : path.basename(file);
      for (const symbol of symbols) {
        if (symbol.source) { const source = path.resolve(evidence.binaryDirectory, symbol.source); symbol.source = isWithin(evidence.inputScope.sourceDirectory, source) ? relative(source) : undefined; }
        if (symbol.object) symbol.object = relative(path.resolve(evidence.binaryDirectory, symbol.object));
      }
      if ((await inspectArmElf(evidence.artifact)).sha256 !== initial.sha256) throw new Error('ELF changed during analysis; result discarded.');
      if (generation !== this.generation || abort.signal.aborted) return;
      const report: MemoryReport = { version: 1, id: randomUUID(), key: analysisKey(evidence), createdAt: new Date().toISOString(), projectUri: evidence.projectUri,
        target: target.name, configuration: evidence.configuration, preset: evidence.configurePreset, artifact: relative(evidence.artifact), artifactSha256: initial.sha256,
        map: mapFile ? relative(mapFile) : undefined, status: warnings.length ? 'partial' : 'complete', warnings, regions, sections, symbols, toolVersion: arm.version, durationMs: Date.now() - start };
      await this.loadHistory(report.key);
      if (generation !== this.generation || abort.signal.aborted) return;
      const history = this.history.get(report.key) ?? [], baseline = this.pinned.get(report.key) ?? history[0];
      this.history.set(report.key, [report, ...history.filter(old => old.artifactSha256 !== report.artifactSha256)].slice(0, 20));
      this.liveArtifact={reportId:report.id,file:evidence.artifact};
      this.state = { phase: 'ready', report, comparison: baseline ? compareReports(report, baseline) : undefined, pinned: this.pinned.has(report.key) }; this.emit();
      try { await this.saveHistory(report.key); } catch (error) { report.warnings.push(`History could not be saved: ${String(error)}`); report.status = 'partial'; }
    } catch (error) { if (generation === this.generation && !abort.signal.aborted) { this.state = { phase: 'failed', message: String(error) }; this.emit(); } }
  }
  async readHex(reportId:string,symbolId:string,offset:number):Promise<HexPage>{
    const report=this.state.report,artifact=this.liveArtifact,generation=this.generation;
    if(this.state.phase!=='ready'||report?.id!==reportId||artifact?.reportId!==reportId)throw new Error('Report is stale.');
    const symbol=report.symbols.find(s=>s.id===symbolId),section=symbol&&report.sections.find(s=>s.name===symbol.section&&symbol.address>=s.vma&&symbol.address+symbol.size<=s.vma+s.size);
    if(!symbol||!section)throw new Error('Symbol has no verified ELF section.');
    const result=await this.bytes.read(artifact.file,report.artifactSha256,section,symbol,offset);
    if(generation!==this.generation||this.state.report?.id!==reportId||this.state.phase!=='ready')throw new Error('Report is stale.');
    return result;
  }
  private async loadHistory(key: string): Promise<void> {
    if (this.history.has(key)) return;
    while(this.history.size>=3){const oldest=this.history.keys().next().value as string;this.history.delete(oldest);this.pinned.delete(oldest);}
    try { const raw = JSON.parse(await readLimited(path.join(this.directory, `${key}.json`), 128 * 1024 * 1024));
      const valid = (item: MemoryReport) => item?.version === 1 && item.key === key && typeof item.id==='string' && Array.isArray(item.symbols) && item.symbols.every(s=>s&&typeof s.name==='string'&&Number.isSafeInteger(s.address)&&Number.isSafeInteger(s.size)&&s.size>=0) && Array.isArray(item.regions) && item.regions.every(r=>r&&typeof r.name==='string'&&Number.isSafeInteger(r.used)&&r.used>=0&&Array.isArray(r.spans)) && Array.isArray(item.sections);
      this.history.set(key, Array.isArray(raw.history) ? raw.history.filter(valid).slice(0,20) : []); if (valid(raw.pinned)) this.pinned.set(key, raw.pinned);
    } catch { this.history.set(key, []); }
  }
  private async saveHistory(key: string): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true }); const file = path.join(this.directory, `${key}.json`), temporary = `${file}.${randomUUID()}.tmp`;
    const history = this.history.get(key) ?? [];
    let payload = JSON.stringify({ history, pinned: this.pinned.get(key) });
    while (history.length > 1 && Buffer.byteLength(payload) > 96 * 1024 * 1024) { history.pop(); payload = JSON.stringify({ history, pinned: this.pinned.get(key) }); }
    if (Buffer.byteLength(payload) > 120 * 1024 * 1024) throw new Error('History exceeds the 120 MiB safety limit. Export the current report manually.');
    try { await fs.writeFile(temporary, payload, { flag: 'wx' }); await replaceFile(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  async pin(enabled: boolean): Promise<void> { const report = this.state.report; if (!report || this.state.phase !== 'ready') return;
    if (enabled) this.pinned.set(report.key, report); else this.pinned.delete(report.key); this.state.pinned = enabled;
    const baseline = enabled ? report : this.history.get(report.key)?.[1]; this.state.comparison = baseline ? compareReports(report, baseline) : undefined;
    await this.saveHistory(report.key); this.emit(); }
}
