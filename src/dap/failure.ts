/** Keep OpenOCD diagnostics ahead of the banner and probe capability listing. */
export function openocdFailureSummary(output: string): string {
  const lines = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const errors = [...new Set(lines.filter(line => /\bError\s*:|\*\*.*Failed.*\*\*/i.test(line)).map(line => {
    const index = line.search(/\bError\s*:/i);
    return (index >= 0 ? line.slice(index) : line).slice(0, 600);
  }))];
  // Event headers are generic; show the underlying Tcl/driver error first.
  const details = errors.filter(line => !/Execution of event .* failed:\s*$/i.test(line) && !/^Error\s*:\s*$/i.test(line));
  if (details.length) return details.slice(0, 8).join('\n');
  return (errors.length ? errors.slice(0, 8) : lines.slice(-6).map(line => line.slice(-600))).join('\n');
}
