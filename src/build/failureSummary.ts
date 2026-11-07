import { t } from '../i18n';

/** Retain actual diagnostics even when a long Ninja link command fills the output tail. */
export class BuildFailureSummary {
  private pending = { stdout: '', stderr: '' };
  private contexts: Partial<Record<'stdout' | 'stderr', { text: string; remaining: number }>> = {};
  private diagnostics: string[] = [];
  private tail = '';
  append(stream: 'stdout' | 'stderr', text: string): void {
    this.tail = (this.tail + text).slice(-8192);
    const lines = (this.pending[stream] + text).split(/\r?\n/);
    this.pending[stream] = (lines.pop() ?? '').slice(-32768);
    for (const line of lines) this.consume(stream, line);
  }
  private remember(line: string): void {
    const compact = line.slice(0, 1200);
    if (!this.diagnostics.includes(compact)) this.diagnostics.push(compact);
    if (this.diagnostics.length > 20) this.diagnostics.shift();
  }
  private flush(stream: 'stdout' | 'stderr'): void {
    const context = this.contexts[stream];
    if (context) this.remember(context.text.trimEnd());
    delete this.contexts[stream];
  }
  private consume(stream: 'stdout' | 'stderr', line: string): void {
    const clean = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
    // CMake places its explanation on indented lines after the error heading.
    const context = this.contexts[stream];
    if (context) {
      if ((!clean || /^\s/.test(line)) && context.remaining > 0) {
        context.text = (context.text + '\n' + clean).slice(0, 1200);
        if (--context.remaining === 0 || context.text.length >= 1200) this.flush(stream);
        return;
      }
      this.flush(stream);
    }
    if (/^CMake Error\b/.test(clean)) {
      this.contexts[stream] = { text: clean, remaining: 12 };
      return;
    }
    if (!/(?:fatal error:|\berror:|undefined reference|multiple definition|region\b.*(?:overflowed|will not fit)|section\b.*(?:will not fit|overlap)|cannot (?:find|open)|unrecognized (?:option|command-line)|file format not recognized|syntax error|CMake Error)/i.test(clean)) return;
    // Drop the linker executable prefix, keeping object/source location and the diagnostic.
    const compact = clean.replace(/^.*?\b(?:ld(?:\.bfd)?|collect2)\.exe:\s*/i, '');
    this.remember(compact);
  }
  finish(): string {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (this.pending[stream]) this.consume(stream, this.pending[stream]);
      this.pending[stream] = '';
      this.flush(stream);
    }
    if (this.diagnostics.some(line => /Error evaluating generator expression:[\s\S]*\$<QUOTE>[\s\S]*Expression did not evaluate to a known generator expression/.test(line))) {
      return t('当前 CMake 不支持 $<QUOTE>；该工程需要 CMake 3.30 或以上。请在管理工具中选择或安装新版 CMake，再重新配置。') + '\n' + this.diagnostics.join('\n');
    }
    const meaningful = this.diagnostics.filter(line => !/^(?:collect2: )?error: ld returned \d+ exit status/.test(line));
    if (meaningful.length) return meaningful.join('\n');
    if (this.diagnostics.length) return this.diagnostics.join('\n');
    const lines = this.tail.trim().split(/\r?\n/).filter(line => line.trim());
    return lines.slice(-6).map(line => line.length > 1200 ? '…' + line.slice(-1200) : line).join('\n');
  }
}
