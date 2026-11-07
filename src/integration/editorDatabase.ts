export function mergeDatabases(current: unknown, previous: string | undefined, database: string): string[] {
  const values = typeof current === 'string' ? [current] : Array.isArray(current) && current.every(value => typeof value === 'string') ? current as string[] : [];
  return [database, ...values.filter(value => value && value !== previous && value !== database)];
}

const C_STANDARD = /^-std=(?:gnu(?:89|90|99|11|17|18|2x|23)|c(?:89|90|99|11|17|18|2x|23))$/;
const CXX_STANDARD = /^-std=(?:gnu\+\+|c\+\+)(?:98|03|11|14|17|20|23|2b|2c)$/;
const C_STANDARD_IN_COMMAND = /(^|\s)(-std=(?:gnu(?:89|90|99|11|17|18|2x|23)|c(?:89|90|99|11|17|18|2x|23)))(?=\s|$)/g;
const CXX_STANDARD_IN_COMMAND = /(^|\s)-std=(?:gnu\+\+|c\+\+)(?:98|03|11|14|17|20|23|2b|2c)(?=\s|$)/;

/** C++ sources must not receive a C-only -std flag; clangd rejects it even though GCC only warns. */
export function sanitizeCompileCommands(raw: unknown): { commands: unknown[]; changed: boolean } {
  if (!Array.isArray(raw)) return { commands: [], changed: false };
  let changed = false;
  const commands = raw.map(entry => {
    if (!entry || typeof entry !== 'object') return entry;
    const value = entry as Record<string, unknown>;
    if (typeof value.file !== 'string' || !/\.(?:cpp|cc|cxx|c\+\+|mm)$/i.test(value.file)) return entry;
    if (typeof value.command === 'string') {
      const hasCxx = CXX_STANDARD_IN_COMMAND.test(value.command);
      const command = value.command.replace(C_STANDARD_IN_COMMAND, (_match, prefix: string) => {
        changed = true;
        return hasCxx ? prefix : `${prefix}-std=gnu++17`;
      });
      return changed ? { ...value, command } : entry;
    }
    if (Array.isArray(value.arguments) && value.arguments.every(item => typeof item === 'string')) {
      const tokens = value.arguments as string[];
      const hasCxx = tokens.some(token => CXX_STANDARD.test(token));
      if (!tokens.some(token => C_STANDARD.test(token))) return entry;
      changed = true;
      const argumentsValue = hasCxx
        ? tokens.filter(token => !C_STANDARD.test(token))
        : tokens.map(token => C_STANDARD.test(token) ? '-std=gnu++17' : token);
      return { ...value, arguments: argumentsValue };
    }
    return entry;
  });
  return { commands, changed };
}

export function compilerDrivers(commands: unknown): string[] {  if (!Array.isArray(commands)) return [];
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

