export function mergeDatabases(current: unknown, previous: string | undefined, database: string): string[] {
  const values = typeof current === 'string' ? [current] : Array.isArray(current) && current.every(value => typeof value === 'string') ? current as string[] : [];
  return [database, ...values.filter(value => value && value !== previous && value !== database)];
}

export function compilerDrivers(commands: unknown): string[] {
  if (!Array.isArray(commands)) return [];
  const drivers = new Set<string>();
  for (const entry of commands.slice(0, 20000)) {
    if (!entry || typeof entry !== 'object') continue;
    const command = (entry as { command?: unknown }).command;
    if (typeof command !== 'string') continue;
    const token = /^\s*(?:"([^"]+)"|(\S+))/.exec(command);
    const compiler = token ? token[1] ?? token[2] : '';
    if (compiler && /[\\/]arm-none-eabi-(?:gcc|g\+\+)(?:\.exe)?$/i.test(compiler)) drivers.add(compiler);
  }
  return [...drivers];
}

export function mergeClangdArguments(current: unknown, databaseDirectory: string, drivers: string[] = []): string[] {
  const values = typeof current === 'string' ? [current]
    : Array.isArray(current) && current.every(value => typeof value === 'string') ? current as string[] : [];
  const kept: string[] = [];
  const existingDrivers: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === '--compile-commands-dir') { index++; continue; }
    if (value.startsWith('--compile-commands-dir=')) continue;
    if (value === '--query-driver') {
      if (values[index + 1]) { existingDrivers.push(...values[index + 1].split(',')); index++; }
      continue;
    }
    if (value.startsWith('--query-driver=')) { existingDrivers.push(...value.slice('--query-driver='.length).split(',')); continue; }
    kept.push(value);
  }
  const merged = [...new Set([
    ...existingDrivers.filter(value => value && !/[\\/]arm-none-eabi-(?:gcc|g\+\+)(?:\.exe)?$/i.test(value)),
    ...drivers,
  ].map(value => value.replace(/\\/g, '/')))];
  const result = [`--compile-commands-dir=${databaseDirectory.replace(/\\/g, '/')}`];
  if (merged.length) result.push(`--query-driver=${merged.join(',')}`);
  return [...result, ...kept];
}

