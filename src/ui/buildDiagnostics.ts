import * as path from 'node:path';
import * as vscode from 'vscode';

export interface GccDiagnostic { file: string; line: number; column: number; severity: 'error' | 'warning' | 'note'; message: string; }
export function parseGccDiagnostic(text: string, cwd: string): GccDiagnostic | undefined {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const match = /^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.+)$/.exec(clean.trim());
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1 || Number(match[3] ?? 1) < 1) return undefined;
  const file = path.resolve(cwd, match[1]);
  return { file, line: Number(match[2]) - 1, column: Number(match[3] ?? 1) - 1,
    severity: match[4] === 'fatal error' ? 'error' : match[4] as GccDiagnostic['severity'], message: match[5] };
}
export class BuildDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('stm32Easy');
  private readonly files = new Map<string, vscode.Diagnostic[]>();
  private tails = { stdout: '', stderr: '' };
  private cwd = process.cwd();
  counts(): { errors: number; warnings: number } {
    const rows = [...this.files.values()].flat(); return { errors: rows.filter(item=>item.severity===vscode.DiagnosticSeverity.Error).length, warnings: rows.filter(item=>item.severity===vscode.DiagnosticSeverity.Warning).length };
  }
  begin(): void { this.collection.clear(); this.files.clear(); this.tails = { stdout: '', stderr: '' }; }
  setDirectory(directory: string): void {
    if (path.resolve(directory).toLowerCase() !== path.resolve(this.cwd).toLowerCase()) this.flush();
    this.cwd = directory;
  }
  append(stream: 'stdout' | 'stderr', text: string): void {
    const lines = (this.tails[stream] + text).split(/\r?\n/);
    this.tails[stream] = lines.pop()?.slice(-32768) ?? '';
    for (const line of lines) this.consume(line);
  }
  flush(): void { for (const text of Object.values(this.tails)) if (text) this.consume(text); this.tails = { stdout: '', stderr: '' }; }
  private consume(line: string): void {
    const parsed = parseGccDiagnostic(line, this.cwd);
    if (!parsed) return;
    const diagnostics = this.files.get(parsed.file) ?? [];
    if (diagnostics.length >= 1000 || this.files.size >= 1000 && !this.files.has(parsed.file)) return;
    const diagnostic = new vscode.Diagnostic(new vscode.Range(parsed.line, parsed.column, parsed.line, parsed.column + 1), parsed.message,
      parsed.severity === 'error' ? vscode.DiagnosticSeverity.Error : parsed.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
    diagnostic.source = 'STM32 GCC';
    diagnostics.push(diagnostic);
    this.files.set(parsed.file, diagnostics);
    this.collection.set(vscode.Uri.file(parsed.file), diagnostics);
  }
  dispose(): void { this.collection.dispose(); }
}
