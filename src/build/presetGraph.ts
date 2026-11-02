import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type PresetKind = 'configure' | 'build';
export interface LocatedValue { value: unknown; file: string; version: number; }
export interface PresetNode { name: string; kind: PresetKind; file: string; version: number; raw: Record<string, unknown>; }
export interface PresetFields { fields: Map<string, LocatedValue>; environment: Map<string, LocatedValue>; }
export interface PresetGraph {
  sourceDirectory: string; files: string[]; nodes: PresetNode[];
  resolve(node: PresetNode): PresetFields;
}
export interface PresetAccess { allowExternal?: (file: string) => Promise<boolean>; }

export function plainObject(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}
export function presetText(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !raw.length || raw.length > 32768 || /[\x00-\x1f]/.test(raw)) throw new Error(t("Presets {0} 必须是非空文本", field));
  return raw;
}
export function parentVariable(env: NodeJS.ProcessEnv, name: string): string {
  const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
  return (key ? env[key] : undefined) ?? '';
}

export async function readPresetGraph(sourceDirectory: string, env: NodeJS.ProcessEnv, access: PresetAccess = {}): Promise<PresetGraph> {
  const source = await fs.realpath(sourceDirectory);
  const files = new Map<string, { file: string; includes: Set<string> }>();
  const nodes: PresetNode[] = [];
  const inFlight = new Set<string>();
  const canonical = (file: string) => path.win32.normalize(file).toLowerCase();
  const within = (file: string) => { const relative = path.relative(source, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  const visit = async (input: string, optional = false): Promise<string | undefined> => {
    let file: string;
    try { file = await fs.realpath(input); } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const key = canonical(file);
    if (inFlight.has(key)) throw new Error(t("Presets include 循环: {0}", file));
    if (files.has(key)) return key;
    if (files.size >= 64 || inFlight.size >= 64) throw new Error(t("Presets include 超过 64 个文件/层级"));
    if (/^(?:\.env(?:\..*)?|.*\.(?:pwd|kdbx|key))$/i.test(path.basename(file))) throw new Error(t("拒绝读取可能包含秘密的 Presets include"));
    if (!within(file) && !await access.allowExternal?.(file)) throw new Error(t("Presets include 位于工程外，需要确认访问: {0}", file));
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 2097152) throw new Error(t("Presets 文件无效或超过 2 MiB: {0}", file));
    const text = await fs.readFile(file, 'utf8');
    const raw: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!plainObject(raw) || !Number.isInteger(raw.version) || Number(raw.version) < 1 || Number(raw.version) > 10) throw new Error(t("不支持的 Presets 格式版本: {0}", file));
    const version = Number(raw.version);
    const entry = { file, includes: new Set<string>() };
    files.set(key, entry);
    inFlight.add(key);
    if (raw.include !== undefined) {
      if (version < 4 || !Array.isArray(raw.include)) throw new Error(t("Presets include 格式无效: {0}", file));
      for (const item of raw.include) {
        let include = presetText(item, 'include');
        include = include.replace(/\$(\w*)\{([^}]*)\}/g, (_whole, namespace: string, name: string) => {
          if (version >= 7 && namespace === 'penv' && name) return parentVariable(env, name);
          if (version >= 9 && !namespace) {
            const values: Record<string, string> = { sourceDir: source, sourceParentDir: path.dirname(source), sourceDirName: path.basename(source),
              fileDir: path.dirname(file), hostSystemName: 'Windows', pathListSep: path.delimiter, dollar: '$' };
            if (Object.hasOwn(values, name)) return values[name];
          }
          throw new Error(t("当前 include 不支持宏 {0}{{1}}: {2}", namespace, name, file));
        });
        if (/\$(?:\w*)\{/.test(include)) throw new Error(t("Presets include 宏不完整: {0}", file));
        const child = await visit(path.resolve(path.dirname(file), include));
        if (child) entry.includes.add(child);
      }
    }
    for (const [kind, field] of [['configure', 'configurePresets'], ['build', 'buildPresets']] as const) {
      if (raw[field] === undefined) continue;
      if (kind === 'build' && version < 2 || !Array.isArray(raw[field])) throw new Error(t("Presets {0} 格式无效: {1}", field, file));
      for (const value of raw[field]) {
        if (!plainObject(value)) throw new Error(t("Presets {0} 条目格式无效", field));
        const name = presetText(value.name, 'name');
        if (value.hidden !== undefined && typeof value.hidden !== 'boolean') throw new Error(t("Presets hidden 格式无效"));
        nodes.push({ name, kind, file, version, raw: value });
      }
    }
    inFlight.delete(key);
    return key;
  };
  const project = await visit(path.join(source, 'CMakePresets.json'), true);
  const user = await visit(path.join(source, 'CMakeUserPresets.json'), true);
  if (!project && !user) throw new Error(t("工程没有现有 CMakePresets.json / CMakeUserPresets.json；插件不会自动生成"));
  if (project && user) files.get(user)?.includes.add(project);
  const registry = new Map<string, PresetNode>();
  for (const node of nodes) {
    const key = `${node.kind}\0${node.name}`;
    if (registry.has(key)) throw new Error(t("Presets 名称重复: {0}/{1}", node.kind, node.name));
    registry.set(key, node);
  }
  const reachable = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return [...(files.get(from)?.includes ?? [])].some(child => reachable(child, to, seen));
  };
  const resolving = new Set<string>();
  const cache = new Map<PresetNode, PresetFields>();
  const resolve = (node: PresetNode): PresetFields => {
    const cached = cache.get(node);
    if (cached) return cached;
    const key = `${node.kind}\0${node.name}`;
    if (resolving.has(key) || resolving.size >= 64) throw new Error(t("Presets inherits 循环或超过 64 层: {0}", node.name));
    resolving.add(key);
    const fields = new Map<string, LocatedValue>();
    const environment = new Map<string, LocatedValue>();
    const inherits = node.raw.inherits === undefined ? [] : typeof node.raw.inherits === 'string' ? [node.raw.inherits] : node.raw.inherits;
    if (!Array.isArray(inherits)) throw new Error(t("Presets inherits 格式无效: {0}", node.name));
    for (const name of inherits) {
      const parent = registry.get(`${node.kind}\0${presetText(name, 'inherits')}`);
      if (!parent || !reachable(canonical(node.file), canonical(parent.file))) throw new Error(t("Presets 无可访问的父配置: {0} -> {1}", node.name, String(name)));
      const result = resolve(parent);
      for (const [field, value] of result.fields) if (!fields.has(field) && !['name', 'hidden', 'inherits', 'displayName', 'description'].includes(field)
        && !(field === 'condition' && value.value === null)) fields.set(field, value);
      for (const [field, value] of result.environment) if (!environment.has(field)) environment.set(field, value);
    }
    for (const [field, value] of Object.entries(node.raw)) {
      if (field === 'environment') {
        if (!plainObject(value)) throw new Error(t("Presets environment 格式无效: {0}", node.name));
        for (const [variable, content] of Object.entries(value)) {
          if (!variable || /[=\x00-\x1f]/.test(variable) || content !== null && typeof content !== 'string') throw new Error(t("Presets 环境变量无效"));
          environment.set(variable, { value: content, file: node.file, version: node.version });
        }
      } else fields.set(field, { value, file: node.file, version: node.version });
    }
    resolving.delete(key);
    const result = { fields, environment };
    cache.set(node, result);
    return result;
  };
  for (const node of nodes) resolve(node);
  return { sourceDirectory: source, files: [...files.values()].map(item => item.file), nodes, resolve };
}
