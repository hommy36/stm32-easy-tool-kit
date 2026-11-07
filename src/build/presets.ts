import { t } from '../i18n';
import * as path from 'node:path';
import { PresetAccess, PresetNode, presetText, readPresetGraph } from './presetGraph';
import { fieldString, presetExpander } from './presetMacros';

export interface PresetChoice { name: string; displayName: string; description?: string; }
export interface ResolvedSelection {
  sourceDirectory: string;
  binaryDirectory: string;
  configurePreset: string;
  buildPreset?: string;
  generator?: string;
  configuration?: string;
  declaredCmakeExecutable?: string;
  inputFiles: string[];
  configureEnvironment: NodeJS.ProcessEnv;
  cleanFirst: boolean;
  packageOnly: boolean;
  /** Internal CLion profile invocation; never written into the user's Presets. */
  configureArgs?: string[];
  buildArgs?: string[];
  optimization?: import('./optimization').OptimizationLevel;
}
export interface PresetMetadata {
  configure: PresetChoice[];
  builds: PresetChoice[];
  inputFiles: string[];
  resolve(configureName: string, buildName?: string): ResolvedSelection;
  compatibleBuilds(configureName: string): PresetChoice[];
}

export async function loadPresetMetadata(sourceDirectory: string, parentEnv: NodeJS.ProcessEnv, access: PresetAccess = {}): Promise<PresetMetadata> {
  const graph = await readPresetGraph(sourceDirectory, parentEnv, access);
  const choice = (node: PresetNode): PresetChoice => ({ name: node.name,
    displayName: node.raw.displayName === undefined ? node.name : presetText(node.raw.displayName, 'displayName'),
    description: node.raw.description === undefined ? undefined : presetText(node.raw.description, 'description') });
  const visible = (kind: PresetNode['kind']) => graph.nodes.filter(node => node.kind === kind && node.raw.hidden !== true).map(choice);
  const find = (kind: PresetNode['kind'], name: string): PresetNode => {
    const node = graph.nodes.find(item => item.kind === kind && item.name === name && item.raw.hidden !== true);
    if (!node) throw new Error(t("未找到可选配置: {0}/{1}", kind, name));
    return node;
  };
  const configureReference = (node: PresetNode): string => {
    const field = fieldString(graph.resolve(node), 'configurePreset');
    if (!field) throw new Error(t("构建配置没有 configurePreset: {0}", node.name));
    return String(field.value);
  };
  return {
    configure: visible('configure'), builds: visible('build'), inputFiles: graph.files,
    compatibleBuilds: name => graph.nodes.filter(node => node.kind === 'build' && node.raw.hidden !== true
      && configureReference(node) === name).map(choice),
    resolve: (configureName, buildName) => {
      const node = find('configure', configureName);
      const fields = graph.resolve(node);
      const generatorValue = fieldString(fields, 'generator');
      const generator = generatorValue ? presetText(generatorValue.value, 'generator') : '';
      if (/\$\w*\{/.test(generator)) throw new Error(t("Presets generator 不支持宏"));
      const expander = presetExpander({ sourceDirectory: graph.sourceDirectory, presetName: node.name, generator,
        environment: fields.environment, parentEnv });
      const binaryValue = fieldString(fields, 'binaryDir');
      if (!binaryValue) throw new Error(t("配置没有可确定的 binaryDir，请选择定义了构建目录的现有配置"));
      const binary = expander.expand(binaryValue);
      if (!binary) throw new Error(t("Presets binaryDir 为空"));
      const binaryDirectory = path.resolve(graph.sourceDirectory, binary);
      if (path.win32.normalize(binaryDirectory).toLowerCase() === path.win32.normalize(graph.sourceDirectory).toLowerCase()) throw new Error(t("不支持在源码根目录中构建，请选择独立构建目录的现有配置"));
      let configuration: string | undefined;
      let cleanFirst = false;
      let packageOnly = false;
      if (buildName) {
        const buildNode = find('build', buildName);
        if (configureReference(buildNode) !== configureName) throw new Error(t("构建配置不属于当前配置预设"));
        const build = graph.resolve(buildNode);
        const config = fieldString(build, 'configuration');
        const buildEnvironment = new Map(build.environment);
        const directEnvironment = buildNode.raw.environment;
        const directKeys = new Set(directEnvironment && typeof directEnvironment === 'object' ? Object.keys(directEnvironment) : []);
        if (build.fields.get('inheritConfigureEnvironment')?.value !== false) {
          for (const [name, value] of fields.environment) if (!directKeys.has(name)) buildEnvironment.set(name, value);
        }
        const buildExpander = presetExpander({ sourceDirectory: graph.sourceDirectory, presetName: buildName,
          generator, environment: buildEnvironment, parentEnv });
        configuration = config ? buildExpander.expand(config) : undefined;
        cleanFirst = build.fields.get('cleanFirst')?.value === true;
        packageOnly = build.fields.get('resolvePackageReferences')?.value === 'only';
      }
      const executable = fieldString(fields, 'cmakeExecutable');
      return { sourceDirectory: graph.sourceDirectory, binaryDirectory, configurePreset: configureName, buildPreset: buildName,
        generator: generator || undefined, configuration, inputFiles: graph.files,
        declaredCmakeExecutable: executable ? expander.expand(executable) : undefined,
        configureEnvironment: expander.environment(), cleanFirst, packageOnly };
    }
  };
}

export function filterCmakeAvailable(choices: PresetChoice[], stdout: string): PresetChoice[] {
  const available = new Set<string>();
  for (const line of stdout.replace(/\r/g, '').split('\n')) {
    if (!line.trim()) continue;
    if (/^Available (?:configure|build) presets(?: on this platform)?:$/.test(line)) continue;
    if (!line.startsWith('  "')) throw new Error(t("无法识别 CMake 配置列表输出，请查看日志"));
    const matches = choices.filter(choice => {
      const prefix = `  "${choice.name}"`;
      if (!line.startsWith(prefix)) return false;
      const tail = line.slice(prefix.length).trim();
      return !tail || tail === `- ${choice.displayName}`;
    });
    if (matches.length !== 1 || available.has(matches[0].name)) throw new Error(t("CMake 配置列表与文件不一致或名称有歧义，请重新加载"));
    available.add(matches[0].name);
  }
  return choices.filter(choice => available.has(choice.name));
}
