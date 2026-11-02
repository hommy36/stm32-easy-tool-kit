import { t } from '../i18n';
import * as path from 'node:path';
import { LocatedValue, PresetFields, parentVariable } from './presetGraph';

export interface MacroContext {
  sourceDirectory: string; presetName: string; generator: string;
  environment: Map<string, LocatedValue>; parentEnv: NodeJS.ProcessEnv;
}

export function presetExpander(context: MacroContext): {
  expand(value: LocatedValue): string;
  environment(): NodeJS.ProcessEnv;
} {
  const active = new Set<string>();
  const expanded = new Map<string, string>();
  const variable = (name: string): string => {
    if (!name) throw new Error(t("Presets 环境宏名称为空"));
    if (expanded.has(name)) return expanded.get(name)!;
    const value = context.environment.get(name);
    if (!value || value.value === null) return parentVariable(context.parentEnv, name);
    if (active.has(name) || active.size >= 64) throw new Error(t("Presets 环境宏循环: {0}", name));
    active.add(name);
    const result = expand(value);
    active.delete(name);
    expanded.set(name, result);
    return result;
  };
  const expand = (located: LocatedValue): string => {
    if (typeof located.value !== 'string' || located.value.length > 32768 || /\$(?:\w*)\{[^}]*$/.test(located.value)) throw new Error(t("Presets 文本或宏无效"));
    const value = located.value.replace(/\$(\w*)\{([^}]*)\}/g, (_whole, namespace: string, name: string) => {
      if (namespace === 'env') return variable(name);
      if (namespace === 'penv') return parentVariable(context.parentEnv, name);
      if (namespace) throw new Error(t("Presets 不支持供应商宏: ${0}{{1}}", namespace, name));
      const values: Record<string, string> = {
        sourceDir: context.sourceDirectory, sourceParentDir: path.dirname(context.sourceDirectory),
        sourceDirName: path.basename(context.sourceDirectory), presetName: context.presetName,
        generator: context.generator, hostSystemName: 'Windows', fileDir: path.dirname(located.file),
        dollar: '$', pathListSep: path.delimiter
      };
      if (!Object.hasOwn(values, name)) throw new Error(t("Presets 未知宏: {0}", name));
      if (name === 'hostSystemName' && located.version < 3 || name === 'fileDir' && located.version < 4
        || name === 'pathListSep' && located.version < 5) throw new Error(t("Presets 版本不支持宏 {0}", name));
      return values[name];
    });
    if (value.length > 32768 || /[\x00-\x1f]/.test(value)) throw new Error(t("Presets 宏展开结果无效或超过长度限制"));
    return value;
  };
  return {
    expand,
    environment: () => {
      const env: NodeJS.ProcessEnv = { ...context.parentEnv };
      for (const [name, value] of context.environment) if (value.value !== null) {
        for (const previous of Object.keys(env)) if (previous.toLowerCase() === name.toLowerCase()) delete env[previous];
        Object.defineProperty(env, name, { value: variable(name), configurable: true, enumerable: true, writable: true });
      }
      return env;
    }
  };
}

export function fieldString(fields: PresetFields, name: string): LocatedValue | undefined {
  const value = fields.fields.get(name);
  if (value && (typeof value.value !== 'string' || !value.value)) throw new Error(t("Presets {0} 必须为非空文本", name));
  return value;
}
