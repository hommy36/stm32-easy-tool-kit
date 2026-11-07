import { escapeHtml } from '../i18n';
import { MemoryReport } from './types';
export function portableReport(report: MemoryReport): Omit<MemoryReport, 'projectUri'> { const { projectUri: _projectUri, ...portable } = report; return portable; }
export function exportReport(report: MemoryReport, format: 'json' | 'csv' | 'html'): string {
  if (format === 'json') return JSON.stringify(portableReport(report), null, 2);
  if (format === 'csv') {
    const cell = (value: unknown) => { let text = String(value ?? ''); if (/^[=+@\-]/.test(text)) text = `'${text}`; return String.fromCharCode(34) + text.replace(/"/g, '""') + String.fromCharCode(34); };
    return [['Region','Section','Symbol','Object','Address','Bytes','Source','Line'], ...report.symbols.map(s => [s.region,s.section,s.name,s.object,`0x${s.address.toString(16)}`,s.size,s.source,s.line])].map(row => row.map(cell).join(',')).join('\r\n');
  }
  return `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>STM32 Memory Report</title><style>body{font:15px system-ui;max-width:1100px;margin:40px auto;padding:20px;color:#23304a}table{border-collapse:collapse;width:100%;margin:24px 0}td,th{text-align:left;border-bottom:1px solid #dce1e8;padding:10px}td:last-child{font-variant-numeric:tabular-nums}</style><h1>${escapeHtml(report.target)} · Memory</h1><p>${escapeHtml(report.createdAt)} · ${escapeHtml(report.configuration)} · ${escapeHtml(report.artifactSha256)}</p><table><tr><th>Region</th><th>Used</th><th>Capacity</th><th>Remaining</th></tr>${report.regions.map(r => `<tr><td>${escapeHtml(r.name)}</td><td>${r.used} B</td><td>${r.capacity ?? 'Unknown'}</td><td>${r.free ?? 'Unknown'}</td></tr>`).join('')}</table><p>${report.warnings.map(escapeHtml).join('<br>')}</p><h2>Largest symbols</h2><table><tr><th>Name</th><th>Object</th><th>Bytes</th></tr>${[...report.symbols].sort((a,b)=>b.size-a.size).slice(0,1000).map(s=>`<tr><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.object ?? '')}</td><td>${s.size}</td></tr>`).join('')}</table><p>Static allocation is not runtime peak usage. Symbol aliases may overlap.</p></html>`;
}
