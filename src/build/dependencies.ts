import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface Compilation { directory: string; command: string; file: string; output: string; }
export interface DependencyInputs { files: string[]; complete: boolean; directories?: string[]; hardwareIssue?: string; }

export function commandWords(command: string, depth = 0): string[] {
  if (depth > 8) throw new Error(t("构建命令嵌套超限"));
  const wrapper = /^\s*(?:"(?:[^"]*[\\/])?cmd(?:\.exe)?"|(?:[^\s"]*[\\/])?cmd(?:\.exe)?)\s+(?:\/[ds]\s+)*\/c\s+([\s\S]+)$/i.exec(command);
  if (wrapper) {
    const body = wrapper[1].trim();
    return commandWords(body.startsWith('"') && body.endsWith('"') ? body.slice(1, -1) : body, depth + 1);
  }
  const words: string[] = [];
  let word = '', quoted = false, started = false;
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (character === '\\') {
      let end = index;
      while (command[end] === '\\') end++;
      const count = end - index;
      if (command[end] === '"') {
        word += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) word += '"'; else quoted = !quoted;
        index = end;
      } else { word += '\\'.repeat(count); index = end - 1; }
      started = true;
    } else if (character === '"') { quoted = !quoted; started = true; }
    else if (/\s/.test(character) && !quoted) {
      if (started) { words.push(word); word = ''; started = false; }
    } else { word += character; started = true; }
  }
  if (quoted) throw new Error(t("构建命令引号不完整，无法确认依赖"));
  if (started) words.push(word);
  return words;
}

export function readCompilations(text: string): Compilation[] {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw) || raw.length > 20000) throw new Error(t("Ninja 编译命令数量超限或格式无效"));
  return raw.map(value => {
    if (!value || typeof value !== 'object') throw new Error(t("Ninja 编译命令无效"));
    const entry = value as Record<string, unknown>;
    for (const key of ['directory', 'command', 'file', 'output']) {
      if (typeof entry[key] !== 'string' || (entry[key] as string).length > 1048576 || /[\x00\r\n]/.test(entry[key] as string)) throw new Error(t("Ninja 编译命令字段无效"));
    }
    if (!path.isAbsolute(entry.directory as string)) throw new Error(t("Ninja 编译目录不是绝对路径"));
    return entry as unknown as Compilation;
  });
}

export function makeDependencies(text: string): string[] {
  const joined = text.replace(/\\\r?\n/g, ' ');
  const line = joined.split(/\r?\n/).find(value => value.trim());
  if (!line) throw new Error(t("编译依赖文件为空"));
  const separator = /:(?:[ \t]|$)/.exec(line);
  if (!separator) throw new Error(t("编译依赖文件缺少主规则"));
  const inputs = line.slice(separator.index + 1);
  const files: string[] = [];
  let word = '';
  for (let index = 0; index < inputs.length; index++) {
    const character = inputs[index];
    if (character === '\\' && /[\s#:$\\]/.test(inputs[index + 1] ?? '')) word += inputs[++index];
    else if (character === '$' && inputs[index + 1] === '$') { word += '$'; index++; }
    else if (character === '#') break;
    else if (/\s/.test(character)) { if (word) { files.push(word); word = ''; } }
    else word += character;
  }
  if (word) files.push(word);
  if (!files.length || files.length > 20000) throw new Error(t("编译依赖文件数量无效"));
  return files;
}

export function ninjaInputNames(text: string): string[] {
  const files = text.split(/\r?\n/).filter(Boolean).map(line => {
    if (line.startsWith('"')) {
      const words = commandWords(line);
      if (words.length !== 1) throw new Error(t("Ninja 输入路径格式无效"));
      return words[0];
    }
    if (/[\x00-\x1f]/.test(line)) throw new Error(t("Ninja 输入路径格式无效"));
    return line;
  });
  if (files.length > 20000) throw new Error(t("Ninja 输入数量超限"));
  return files;
}

export function ninjaDependencies(text: string): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  let output: string | undefined, expected = 0;
  const finish = () => { if (output && entries.get(output)!.length !== expected) throw new Error(t("Ninja 依赖记录数量不完整")); };
  for (const line of text.split(/\r?\n/)) {
    const header = /^(.*): #deps (\d+), .* \((VALID|STALE)\)$/.exec(line);
    if (header) {
      finish();
      output = header[3] === 'VALID' ? header[1] : undefined;
      expected = Number(header[2]);
      if (output) entries.set(output, []);
    } else if (line.startsWith('    ')) { if (output) entries.get(output)!.push(line.slice(4)); }
    else if (line.trim()) throw new Error(t("Ninja 依赖记录格式无法识别"));
  }
  finish();
  return entries;
}

export function argumentValue(words: string[], flag: string): string | undefined {
  const index = words.findIndex(word => word === flag || word.startsWith(flag) && word.length > flag.length);
  return index < 0 ? undefined : words[index] === flag ? words[index + 1] : words[index].slice(flag.length);
}

export function linkerArguments(words: string[]): { scripts: string[]; search: string[]; libraries: string[]; files: string[] } {
  const linker: string[] = [];
  const scripts: string[] = [], search: string[] = [], libraries: string[] = [], files: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word.startsWith('@') || word.startsWith('-Wl,@')) throw new Error(t("存在未展开的 response 文件，无法确认实际构建依赖"));
    if (word.startsWith('-Wl,')) linker.push(...word.slice(4).split(','));
    else if (word === '-Xlinker') { if (!words[index + 1]) throw new Error(t("链接参数不完整")); linker.push(words[++index]); }
    else linker.push(word);
  }
  for (let index = 0; index < linker.length; index++) {
    const word = linker[index];
    const value = (flag: string) => word === flag ? linker[++index] : word.slice(flag.length);
    if (word === '-T' || word.startsWith('-T') && word.length > 2) scripts.push(value('-T'));
    else if (word === '--script' || word.startsWith('--script=')) scripts.push(word === '--script' ? linker[++index] : word.slice(9));
    else if (word === '-L' || word.startsWith('-L') && word.length > 2) search.push(value('-L'));
    else if (word === '--library-path' || word.startsWith('--library-path=')) search.push(word === '--library-path' ? linker[++index] : word.slice(15));
    else if (word === '-l' || word.startsWith('-l') && word.length > 2) libraries.push(value('-l'));
    else if (/\.(?:a|lib|ld|lds|o|obj)$/i.test(word) && !word.startsWith('-')) files.push(word);
  }
  if ([...scripts, ...search, ...libraries].some(value => !value)) throw new Error(t("链接输入参数不完整"));
  return { scripts, search, libraries, files };
}

export async function readDependencyFile(file: string): Promise<string> {
  if (/^(?:\.env(?:\..*)?|.*\.(?:pwd|kdbx|key|pem))$/i.test(path.basename(file))) throw new Error(t("拒绝读取可能包含秘密的依赖文件"));
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 8388608) throw new Error(t("构建依赖文件超过大小限制或不是普通文件"));
  const text = await fs.readFile(file, 'utf8');
  if (text.length > 8388608 || text.includes('\0')) throw new Error(t("构建依赖文件无效或超限"));
  return text;
}

export async function linkerScriptInputs(scripts: string[], search: string[], allowRead: (file: string) => Promise<void>, reportDirectory: (directory: string) => void): Promise<string[]> {
  const files = new Map<string, string>();
  const directories = [...search];
  const resolve = async (name: string) => {
    if (name.startsWith('=') || name.startsWith('$SYSROOT')) throw new Error(t("暂不能确认带 sysroot 的链接脚本依赖"));
    for (const directory of directories) {
      const file = path.resolve(directory, name);
      try { if ((await fs.stat(file)).isFile()) return file; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    throw new Error(t("找不到链接脚本输入: {0}", name));
  };
  const visit = async (file: string, depth: number): Promise<void> => {
    if (depth > 32 || files.size > 20000) throw new Error(t("链接脚本依赖超限"));
    const canonical = await fs.realpath(file);
    if (files.has(canonical.toLowerCase())) return;
    await allowRead(canonical);
    files.set(canonical.toLowerCase(), canonical);
    const text = (await readDependencyFile(canonical)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/#[^\r\n]*/g, '');
    const name = (raw: string) => raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    for (const match of text.matchAll(/\bSEARCH_DIR\s*\(\s*("[^"]*"|[^\s)]+)\s*\)/g)) {
      const value = name(match[1]);
      if (value.startsWith('=') || value.startsWith('$SYSROOT')) throw new Error(t("暂不能确认带 sysroot 的链接搜索目录"));
      directories.push(path.resolve(search[0], value));
    }
    for (const match of text.matchAll(/\bINCLUDE\s+("[^"]*"|[^\s;]+)/g)) await visit(await resolve(name(match[1])), depth + 1);
    const pattern = /\b(?:INPUT|GROUP|STARTUP)\s*\(/g;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const start = pattern.lastIndex;
      let end = start, balance = 1, quoted = false;
      for (; end < text.length && balance; end++) {
        if (text[end] === '"') quoted = !quoted;
        if (!quoted) { if (text[end] === '(') balance++; else if (text[end] === ')') balance--; }
      }
      if (balance || quoted) throw new Error(t("链接脚本输入括号不完整"));
      pattern.lastIndex = end;
      const body = text.slice(start, end - 1).replace(/\bAS_NEEDED\s*\(/g, '').replace(/[(),]/g, ' ');
      for (const token of body.match(/"[^"]*"|[^\s]+/g) ?? []) {
        const input = name(token);
        if (input.startsWith('-l')) throw new Error(t("链接脚本包含隐式 -l 输入，当前版本不能确认其闭包，请使用显式库路径"));
        const dependency = await resolve(input);
        if (/\.(?:a|lib|o|obj)$/i.test(dependency)) {
          await allowRead(dependency);
          files.set((await fs.realpath(dependency)).toLowerCase(), dependency);
        } else await visit(dependency, depth + 1);
      }
    }
  };
  for (const script of scripts) await visit(await resolve(script), 0);
  for (const directory of directories) reportDirectory(directory);
  return [...files.values()];
}
