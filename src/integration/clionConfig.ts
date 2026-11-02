import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { t } from '../i18n';
import { commandWords } from '../build/dependencies';
import type { PresetMetadata, ResolvedSelection } from '../build/presets';

interface XmlNode { tag: string; attributes: Record<string, string>; children: XmlNode[]; }
const fail = (detail: string): never => { throw new Error(t('无法导入 CLion 配置：{0}', detail)); };
export function parseXml(text: string): XmlNode {
  if (text.length > 2097152 || /<!DOCTYPE|<!ENTITY/i.test(text)) fail('XML size or declaration');
  const decode = (value: string) => value.replace(/&([^;]+);/g, (_match, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    const code = /^#x[\da-f]+$/i.test(entity) ? parseInt(entity.slice(2), 16) : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : 0;
    if (!code || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) fail('XML entity');
    return String.fromCodePoint(code);
  });
  const root: XmlNode = { tag: '#document', attributes: {}, children: [] }, stack = [root];
  const clean = text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, '');
  let offset = 0, count = 0;
  const tokens = /<\/?[\w:.-]+(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>/g;
  for (const match of clean.matchAll(tokens)) {
    const between = clean.slice(offset, match.index);
    if (between.includes('<') || stack.length === 1 && between.trim()) fail('XML text or malformed tag');
    offset = match.index! + match[0].length;
    if (++count > 20000 || stack.length > 64) fail('XML nesting/count');
    const tag = /^<\/?([\w:.-]+)/.exec(match[0])![1];
    if (match[0].startsWith('</')) { if (stack.length === 1 || stack.pop()!.tag !== tag) fail('XML closing tag'); continue; }
    const attributes: Record<string, string> = Object.create(null);
    for (const attribute of match[0].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      if (Object.hasOwn(attributes, attribute[1])) fail('Duplicate XML attribute');
      attributes[attribute[1]] = decode(attribute[2] ?? attribute[3]);
    }
    const node = { tag, attributes, children: [] }; stack.at(-1)!.children.push(node);
    if (!/\/\s*>$/.test(match[0])) stack.push(node);
  }
  if (clean.slice(offset).trim() || stack.length !== 1) fail('Incomplete XML');
  return root;
}
function descendants(root: XmlNode, tag: string): XmlNode[] {
  return root.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...descendants(child, tag)]);
}
export async function readConfig(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 2097152) fail(`File too large: ${file}`);
    const text = await fs.readFile(file, 'utf8');
    if (Buffer.byteLength(text) > 2097152) fail(`File grew while reading: ${file}`);
    return text;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export interface ClionProfile {
  name: string; enabled: boolean; fromPreset: boolean; buildType?: string; directory?: string;
  options: string; buildOptions: string; toolchain?: string; environment: Record<string, string>;
  inheritEnvironment: boolean; source: string; unsupported: string[];
}
export interface ClionRun {
  name: string; profile?: string; target?: string; boardScript: string; source: string;
  reset?: string; download?: string;
}
export interface ClionProject { profiles: ClionProfile[]; runs: ClionRun[]; files: string[]; }
export function parseClionProject(xml: string, source: string): ClionProject {
  const root = parseXml(xml), profiles: ClionProfile[] = [], runs: ClionRun[] = [];
  for (const component of descendants(root, 'component')) {
    if (['CMakeSettings', 'CMakeSharedSettings'].includes(component.attributes.name)) {
      for (const node of descendants(component, 'configuration')) {
        const a = node.attributes;
        if (!a.PROFILE_NAME) continue;
        const environment: Record<string, string> = Object.create(null);
        for (const env of descendants(node, 'env')) {
          const { name, value } = env.attributes;
          if (!name || /[=\x00-\x1f]/.test(name) || value === undefined || /[\x00]/.test(value)) fail('Environment variable');
          environment[name] = value;
        }
        const known = new Set(['PROFILE_NAME','ENABLED','FROM_PRESET','CONFIG_NAME','GENERATION_DIR','GENERATION_OPTIONS','BUILD_OPTIONS','TOOLCHAIN_NAME','PASS_PARENT_ENVS','PASS_PARENT_ENVS_2','USE_DEFAULT_BUILD_OPTIONS']);
        const unsupported = Object.keys(a).filter(key => !known.has(key) && a[key] && a[key] !== 'false').map(key => `${key}=${a[key]}`);
        if (descendants(node, 'environmentScript').length || descendants(node, 'envFile').length) unsupported.push('Environment scripts/files');
        profiles.push({ name: a.PROFILE_NAME, enabled: a.ENABLED !== 'false', fromPreset: a.FROM_PRESET === 'true',
          buildType: a.CONFIG_NAME, directory: a.GENERATION_DIR, options: a.GENERATION_OPTIONS ?? '', buildOptions: a.BUILD_OPTIONS ?? '',
          toolchain: a.TOOLCHAIN_NAME, environment, inheritEnvironment: a.PASS_PARENT_ENVS !== 'false' && a.PASS_PARENT_ENVS_2 !== 'false', source, unsupported });
      }
    }
  }
  for (const node of descendants(root, 'configuration')) {
    if (node.attributes.type !== 'com.jetbrains.cidr.embedded.openocd.conf.type' || node.attributes.default === 'true') continue;
    const openocd = node.children.find(child => child.tag === 'openocd');
    if (!openocd?.attributes['board-config']) continue;
    runs.push({ name: node.attributes.name, profile: node.attributes.CONFIG_NAME, target: node.attributes.RUN_TARGET_NAME ?? node.attributes.TARGET_NAME,
      boardScript: openocd.attributes['board-config'], source, reset: openocd.attributes['reset-type'], download: openocd.attributes['download-type'] });
  }
  return { profiles, runs, files: [source] };
}
export async function readClionProject(directory: string): Promise<ClionProject> {
  const files = [path.join(directory, '.idea', 'cmake.xml'), path.join(directory, '.idea', 'workspace.xml')];
  for (const folder of ['.idea/runConfigurations', '.run']) {
    try {
      const entries = await fs.readdir(path.join(directory, folder));
      if (entries.length > 256) fail('Too many run configurations');
      files.push(...entries.filter(name => name.endsWith('.xml')).sort().map(name => path.join(directory, folder, name)));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const profiles = new Map<string, ClionProfile>(), runs = new Map<string, ClionRun>(), inputs: string[] = [];
  for (const file of files) {
    const text = await readConfig(file); if (text === undefined) continue;
    const parsed = parseClionProject(text, file); inputs.push(file);
    // CLion local profiles override shared profiles with the same name.
    for (const profile of parsed.profiles) profiles.set(profile.name, profile);
    for (const run of parsed.runs) runs.set(run.name, run);
  }
  return { profiles: [...profiles.values()], runs: [...runs.values()], files: inputs };
}
export function expandClion(value: string, project: string, environment: NodeJS.ProcessEnv): string {
  let result = value.replace(/\$PROJECT_DIR\$/g, project).replace(/\$USER_HOME\$/g, os.homedir());
  result = result.replace(/\$([A-Za-z_][\w]*)\$/g, (_match, name: string) => {
    const key = Object.keys(environment).find(key => key.toLowerCase() === name.toLowerCase());
    if (!key || environment[key] === undefined) return fail(`Unresolved macro: $${name}$`);
    return environment[key]!;
  });
  if (/\$[^$\s]+\$|\$\{|\$\(/.test(result) || /[\x00-\x1f]/.test(result)) fail(`Unsupported macro/control character: ${value}`);
  return result;
}
export function profileSelection(profile: ClionProfile, sourceDirectory: string, parentEnv: NodeJS.ProcessEnv, toolchain?: ClionToolchain): ResolvedSelection {
  if (profile.fromPreset) fail('Preset-backed profile must use its existing Configure Preset');
  if (profile.unsupported.length) fail(profile.unsupported.join(', '));
  if (toolchain?.unsupported.length) fail(toolchain.unsupported.join(', '));
  const environment = { ...(profile.inheritEnvironment ? parentEnv : {}) };
  for (const [name, value] of Object.entries({ ...toolchain?.environment, ...profile.environment })) {
    for (const key of Object.keys(environment)) if (key.toLowerCase() === name.toLowerCase()) delete environment[key];
    environment[name] = expandClion(value, sourceDirectory, parentEnv);
  }
  const options = commandWords(expandClion(profile.options, sourceDirectory, environment));
  const args: string[] = []; let generator: string | undefined, buildType = profile.buildType;
  for (let index = 0; index < options.length; index++) {
    const arg = options[index];
    if (['-D','-U','-G','-C','--toolchain'].includes(arg)) {
      const value = options[++index]; if (!value || value.startsWith('-')) fail(`Missing value for ${arg}`);
      if (arg === '-G') generator = value;
      if (arg === '-D' && /^CMAKE_BUILD_TYPE(?::\w+)?=/.test(value)) buildType = value.slice(value.indexOf('=') + 1);
      args.push(arg, value);
    } else if (/^-(?:D|U|G|C).+/.test(arg) || /^--toolchain=.+/.test(arg) || /^-W(?:no-)?(?:dev|deprecated|error=dev|error=deprecated)$/.test(arg) || /^--(?:warn-uninitialized|warn-unused-vars|no-warn-unused-cli)$/.test(arg)) {
      if (arg.startsWith('-G')) generator = arg.slice(2);
      if (/^-DCMAKE_BUILD_TYPE(?::\w+)?=/.test(arg)) buildType = arg.slice(arg.indexOf('=') + 1);
      args.push(arg);
    } else fail(`Unsupported CMake option: ${arg}`);
  }
  if (!generator) { generator = 'Ninja'; args.push('-G', generator); }
  for (const [variable, value] of [['CMAKE_C_COMPILER', toolchain?.compiler], ['CMAKE_CXX_COMPILER', toolchain?.cppCompiler], ['CMAKE_MAKE_PROGRAM', toolchain?.buildTool]]) {
    if (value && !args.some(arg => new RegExp(`^(?:-D)?${variable}(?::\\w+)?=`).test(arg))) {
      const expanded = expandClion(value, sourceDirectory, environment);
      if (!path.isAbsolute(expanded)) fail(`Tool path must be absolute: ${expanded}`);
      args.push(`-D${variable}=${expanded}`);
    }
  }
  if (buildType && !args.some(arg => /^(?:-D)?CMAKE_BUILD_TYPE(?::\w+)?=/.test(arg))) args.push(`-DCMAKE_BUILD_TYPE=${buildType}`);
  const binaryDirectory = path.resolve(sourceDirectory, expandClion(profile.directory || `cmake-build-${(buildType || profile.name).toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`, sourceDirectory, environment));
  if (path.resolve(sourceDirectory).toLowerCase() === binaryDirectory.toLowerCase()) fail('In-source build');
  const buildArgs = commandWords(expandClion(profile.buildOptions, sourceDirectory, environment));
  // Only concurrency/verbosity controls are transferable; no clean, target or directory overrides.
  for (let index = 0; index < buildArgs.length; index++) {
    const arg = buildArgs[index];
    if (['-j','--parallel'].includes(arg)) { if (/^\d+$/.test(buildArgs[index + 1] ?? '')) index++; }
    else if (!/^(?:-j\d+|--parallel=\d+|-v|--verbose)$/.test(arg)) fail(`Unsupported build option: ${arg}`);
  }
  return { sourceDirectory, binaryDirectory, configurePreset: `CLion:${profile.name}`, generator, configuration: buildType,
    inputFiles: [profile.source], configureEnvironment: environment, cleanFirst: false, packageOnly: false,
    declaredCmakeExecutable: toolchain?.cmake ? expandClion(toolchain.cmake, sourceDirectory, environment) : undefined,
    configureArgs: ['-S', sourceDirectory, '-B', binaryDirectory, ...args], buildArgs };
}
export function clionMetadata(project: ClionProject, sourceDirectory: string, environment: NodeJS.ProcessEnv, installations: ClionInstallation[] = []): PresetMetadata {
  const profiles = project.profiles.filter(profile => !profile.fromPreset && profile.enabled);
  return { configure: profiles.map(profile => ({ name: `CLion:${profile.name}`, displayName: `CLion · ${profile.name}` })), builds: [], inputFiles: project.files,
    compatibleBuilds: () => [], resolve: (name, build) => {
      const profile = profiles.find(item => `CLion:${item.name}` === name);
      if (!profile || build) return fail('CLion profile selection');
      const selected = selectClionToolchain(profile, installations);
      return { ...profileSelection(profile, sourceDirectory, environment, selected?.toolchain), inputFiles: [...project.files, ...selected?.installation.files ?? []] };
    } };
}

export interface ClionToolchain {
  name: string; kind: string; cmake?: string; compiler?: string; cppCompiler?: string; buildTool?: string;
  environment: Record<string, string>; unsupported: string[];
}
export interface ClionInstallation { directory: string; toolchains: ClionToolchain[]; openocd?: string; home?: string; files: string[]; }
export function selectClionToolchain(profile: ClionProfile, installations: ClionInstallation[]): { installation: ClionInstallation; toolchain: ClionToolchain } | undefined {
  for (const installation of installations) {
    const toolchain = profile.toolchain ? installation.toolchains.find(chain => chain.name === profile.toolchain) : installation.toolchains[0];
    if (toolchain) return { installation, toolchain };
  }
  if (profile.toolchain) fail(`Toolchain not found: ${profile.toolchain}`);
  return undefined;
}
export function parseClionToolchains(xml: string): ClionToolchain[] {
  const root = parseXml(xml);
  return descendants(root, 'toolchain').map(node => {
    const a = node.attributes, environment: Record<string, string> = Object.create(null);
    const unsupported = ['MINGW', 'SYSTEM'].includes(a.toolSetKind ?? 'MINGW') ? [] : [`toolSetKind=${a.toolSetKind}`];
    for (const env of descendants(node, 'env')) {
      if (!env.attributes.name || /[=\x00-\x1f]/.test(env.attributes.name) || env.attributes.value === undefined) fail('Toolchain environment');
      environment[env.attributes.name] = env.attributes.value;
    }
    const environmentTags = (node: XmlNode): boolean => node.children.every(child => ['environment','envs','env'].includes(child.tag) && environmentTags(child));
    if (!environmentTags(node)
      || descendants(node, 'environment').some(env => Object.keys(env.attributes).some(key => /script|file/i.test(key)))) unsupported.push('Custom toolchain environment');
    return { name: a.name, kind: a.toolSetKind ?? 'MINGW', cmake: a.customCMakePath, compiler: a.customCCompilerPath,
      cppCompiler: a.customCXXCompilerPath, buildTool: a.customMakePath, environment, unsupported };
  });
}
export async function readClionInstallations(base = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'JetBrains')): Promise<ClionInstallation[]> {
  let entries: string[];
  try { entries = await fs.readdir(base); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const result: ClionInstallation[] = [];
  for (const name of entries.filter(name => /^CLion\d+\.\d+(?:\.\d+)?$/.test(name)).sort((a,b) => b.localeCompare(a, undefined, { numeric: true }))) {
    const directory = path.join(base, name), files: string[] = [], chains = new Map<string, ClionToolchain>();
    let openocd: string | undefined;
    for (const suffix of ['options/toolchains.xml','options/windows/toolchains.xml','options/embedded-support.xml','options/windows/embedded-support.xml']) {
      const file = path.join(directory, suffix), text = await readConfig(file); if (!text) continue;
      files.push(file);
      if (suffix.endsWith('toolchains.xml')) for (const chain of parseClionToolchains(text)) chains.set(chain.name, chain);
      else for (const component of descendants(parseXml(text), 'component').filter(node => node.attributes.name === 'EmbeddedDevelopment')) {
        openocd = descendants(component, 'option').find(node => node.attributes.name === 'openOcdLocation')?.attributes.value ?? openocd;
      }
    }
    const home = (await readConfig(path.join(directory, '.home')))?.trim();
    if (chains.size || openocd) result.push({ directory, toolchains: [...chains.values()], openocd, home: home && path.isAbsolute(home) ? home : undefined, files });
  }
  return result;
}

/** Only read the cache belonging to this source tree; never execute it or edit it. */
export async function cachedToolPaths(source: string, binary: string): Promise<Record<string, string>> {
  const text = await readConfig(path.join(binary, 'CMakeCache.txt'));
  if (!text) return {};
  const values = Object.fromEntries([...text.matchAll(/^(CMAKE_[A-Z_]+):[^=\r\n]+=(.*)$/gm)].map(match => [match[1], match[2].trim()]));
  if (!values.CMAKE_HOME_DIRECTORY || path.resolve(values.CMAKE_HOME_DIRECTORY).toLowerCase() !== path.resolve(source).toLowerCase()) fail('CMake cache belongs to another project');
  const files = path.join(binary, 'CMakeFiles');
  try {
    for (const version of (await fs.readdir(files)).filter(name => /^\d+\.\d+(?:\.\d+)?$/.test(name)).sort((a,b) => b.localeCompare(a, undefined, { numeric: true })).slice(0,1)) {
      for (const language of ['C','CXX']) {
        const compiler = await readConfig(path.join(files, version, `CMake${language}Compiler.cmake`));
        const value = compiler && new RegExp(`set\\(CMAKE_${language}_COMPILER\\s+"([^"\\r\\n]+)"\\)`).exec(compiler)?.[1];
        if (value) values[`CMAKE_${language}_COMPILER`] = value;
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return values;
}
