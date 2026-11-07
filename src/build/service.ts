import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ToolInstallation } from '../core/types';
import { JobRequest, JobResult, runJob } from '../core/jobProcess';
import { buildToolEnvironment } from './environment';
import { BuildModel, FirmwareTarget, fileApiStamp, prepareFileApi, readBuildModel } from './fileApi';
import { PresetAccess } from './presetGraph';
import { PresetChoice, PresetMetadata, ResolvedSelection, filterCmakeAvailable, loadPresetMetadata } from './presets';
import { DependencyInputs, argumentValue, commandWords, linkerArguments, linkerScriptInputs, makeDependencies, ninjaDependencies, ninjaInputNames, readCompilations, readDependencyFile } from './dependencies';
import { isWithin } from './artifacts';
import { ClionProject, clionMetadata, readClionProject, readClionInstallations } from '../integration/clionConfig';
import { BuildFailureSummary } from './failureSummary';
import { optimizationConfigureArgs, verifyOptimization } from './optimization';

export class BuildCancelled extends Error { constructor() { super(t("构建已取消")); } }
export class ProcessTreeUncertain extends Error { constructor(message: string) { super(message); } }
export type BuildLog = (stream: 'stdout' | 'stderr', text: string, diagnosticDirectory?: string) => void;

const metadataLimit = 32;
const presetCache = new Map<string, PresetMetadata>();
const ninjaCache = new Map<string, unknown>();
function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  cache.set(key, value);
  if (cache.size > metadataLimit) cache.delete(cache.keys().next().value as string);
  return value;
}
async function fileSignature(files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const file of files) {
    const resolved = path.resolve(file).toLowerCase();
    try { const stat = await fs.stat(file); parts.push(`${resolved}\0${stat.size}\0${stat.mtimeMs}`); }
    catch { parts.push(`${resolved}\0missing`); }
  }
  return parts.sort().join('\n');
}

export class BuildService {
  readonly environment: NodeJS.ProcessEnv;
  private readonly cmake: string;
  constructor(private readonly tools: ToolInstallation[], private readonly log: BuildLog,
    private readonly guard: () => void, private readonly runner: (request: JobRequest) => Promise<JobResult> = runJob,
    private readonly clionInstallations = readClionInstallations) {
    this.cmake = tools.find(tool => tool.id === 'cmake')?.executables.cmake ?? '';
    if (!path.isAbsolute(this.cmake)) throw new Error(t("请先选择或安装 CMake"));
    this.environment = buildToolEnvironment(process.env, tools);
  }
  async presets(sourceDirectory: string, signal: AbortSignal, access: PresetAccess = {}): Promise<PresetMetadata> {
    this.guard();
    const nativeExists = await Promise.all(['CMakePresets.json', 'CMakeUserPresets.json'].map(async file => {
      try { return (await fs.stat(path.join(sourceDirectory, file))).isFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    }));
    let project: ClionProject;
    let clion: PresetMetadata;
    try {
      project = await readClionProject(sourceDirectory);
      const installations = project.profiles.some(profile => profile.enabled && !profile.fromPreset) ? await this.clionInstallations() : [];
      clion = clionMetadata(project, sourceDirectory, this.environment, installations);
    } catch (error) {
      if (!nativeExists.some(Boolean)) return this.automaticPresets(sourceDirectory);
      // An unrelated broken IDE file must not prevent existing CMake Presets from working.
      this.log('stderr', `${t('无法导入 CLion 配置：{0}', String(error))}\n`);
      return this.nativePresets(sourceDirectory, signal, access);
    }
    if (!nativeExists.some(Boolean) && clion.configure.length) return clion;
    if (!nativeExists.some(Boolean)) return this.automaticPresets(sourceDirectory);
    const native = await this.nativePresets(sourceDirectory, signal, access);
    const names = new Set(native.configure.map(choice => choice.name));
    const compatible = clion.configure.filter(choice => !names.has(choice.name));
    return { configure: [...native.configure, ...compatible], builds: native.builds, inputFiles: native.inputFiles,
      compatibleBuilds: name => names.has(name) ? native.compatibleBuilds(name) : [],
      resolve: (name, build) => names.has(name) ? native.resolve(name, build) : clion.resolve(name, build) };
  }
  private async automaticPresets(sourceDirectory: string): Promise<PresetMetadata> {
    const arm = this.tools.find(tool => tool.id === 'armGnu');
    const gcc = arm?.executables.gcc, gpp = arm?.executables.gpp;
    const ninja = this.tools.find(tool => tool.id === 'ninja')?.executables.ninja;
    let toolchain: string | undefined;
    for (const candidate of ['cmake/gcc-arm-none-eabi.cmake', 'cmake/arm-none-eabi.cmake']) {
      const file = path.join(sourceDirectory, candidate);
      try { if ((await fs.stat(file)).isFile()) { toolchain = file; break; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!toolchain && !(gcc && gpp)) {
      throw new Error(t('未检测到 CMakePresets，且没有可用的 ARM 工具链；请先在工具管理中选择 Arm GNU 工具链'));
    }
    const source = path.resolve(sourceDirectory);
    const inputFiles = [path.join(source, 'CMakeLists.txt'), ...(toolchain ? [toolchain] : [])];
    const resolve = (name: string): ResolvedSelection => {
      const configuration = name === 'auto-debug' ? 'Debug' : name === 'auto-release' ? 'Release' : undefined;
      if (!configuration) throw new Error(t('未找到可选配置: {0}/{1}', 'configure', name));
      const binaryDirectory = path.join(source, 'build', configuration);
      const args = ['-S', source, '-B', binaryDirectory, '-G', 'Ninja', `-DCMAKE_BUILD_TYPE=${configuration}`];
      if (toolchain) args.push(`-DCMAKE_TOOLCHAIN_FILE=${toolchain.replace(/\\/g, '/')}`);
      else {
        args.push(`-DCMAKE_C_COMPILER=${gcc!.replace(/\\/g, '/')}`, `-DCMAKE_CXX_COMPILER=${gpp!.replace(/\\/g, '/')}`,
          `-DCMAKE_ASM_COMPILER=${gcc!.replace(/\\/g, '/')}`, '-DCMAKE_SYSTEM_NAME=Generic',
          '-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY');
      }
      if (ninja) args.push(`-DCMAKE_MAKE_PROGRAM=${ninja.replace(/\\/g, '/')}`);
      return { sourceDirectory: source, binaryDirectory, configurePreset: name, configuration, generator: 'Ninja',
        inputFiles, configureEnvironment: this.environment, cleanFirst: false, packageOnly: false,
        configureArgs: args, buildArgs: [] };
    };
    const choice = (name: string, configuration: string): PresetChoice => ({ name,
      displayName: t('自动 {0}', configuration), description: t('未检测到 CMakePresets；使用本机工具链直接配置。') });
    return { configure: [choice('auto-debug', 'Debug'), choice('auto-release', 'Release')], builds: [], inputFiles,
      compatibleBuilds: () => [], resolve };
  }
  private async nativePresets(sourceDirectory: string, signal: AbortSignal, access: PresetAccess): Promise<PresetMetadata> {
    const metadata = await loadPresetMetadata(sourceDirectory, this.environment, access);
    const signature = await fileSignature([...metadata.inputFiles, this.cmake]);
    const key = `${path.resolve(sourceDirectory).toLowerCase()}\0${signature}`;
    const cached = presetCache.get(key);
    if (cached) return cached;
    const configureOutput = await this.execute(sourceDirectory, ['--list-presets=configure'], signal, true);
    const buildOutput = await this.execute(sourceDirectory, ['--list-presets=build'], signal, true);
    const configure = filterCmakeAvailable(metadata.configure, configureOutput);
    const builds = filterCmakeAvailable(metadata.builds, buildOutput);
    const allowedConfigure = new Set(configure.map(item => item.name));
    const allowedBuild = new Set(builds.map(item => item.name));
    return remember(presetCache, key, { configure, builds, inputFiles: metadata.inputFiles,
      compatibleBuilds: name => metadata.compatibleBuilds(name).filter(item => allowedBuild.has(item.name)),
      resolve: (name, buildName) => {
        if (!allowedConfigure.has(name) || buildName && !allowedBuild.has(buildName)) throw new Error(t("所选配置当前不可用，请重新选择"));
        return metadata.resolve(name, buildName);
      } });
  }
  async configure(selection: ResolvedSelection, signal: AbortSignal): Promise<BuildModel> {
    await this.validateSelection(selection);
    this.guard();
    if (signal.aborted) throw new BuildCancelled();
    await this.checkCache(selection);
    const previous = await fileApiStamp(selection.binaryDirectory);
    await prepareFileApi(selection.binaryDirectory);
    const optimizationArgs = await optimizationConfigureArgs(selection);
    await this.execute(selection.sourceDirectory, [...(selection.configureArgs ?? ['--preset', selection.configurePreset]), '-DCMAKE_EXPORT_COMPILE_COMMANDS:BOOL=ON', ...optimizationArgs], signal, false,
      selection.configureArgs ? selection.configureEnvironment : this.environment);
    await verifyOptimization(selection);
    const model = await readBuildModel(selection.binaryDirectory);
    if (model.indexToken === previous) throw new Error(t("CMake 未生成新的 File API 配置结果，拒绝使用旧目标"));
    await this.checkModel(model, selection);
    return model;
  }
  async build(selection: ResolvedSelection, target: FirmwareTarget, signal: AbortSignal): Promise<BuildModel> {
    await this.validateSelection(selection);
    if (selection.cleanFirst || selection.packageOnly) throw new Error(t("此构建预设含清理/仅解析包操作，不能用于安全固件构建；请选择其他已有构建预设"));
    await this.checkCache(selection);
    await verifyOptimization(selection);
    const before = await readBuildModel(selection.binaryDirectory);
    await this.checkModel(before, selection);
    if (!before.targets.some(item => item.id === target.id && item.configuration === target.configuration)) throw new Error(t("构建目标已变化，请重新配置/选择"));
    const args = selection.buildPreset ? ['--build', '--preset', selection.buildPreset, '--target', target.name]
      : ['--build', selection.binaryDirectory, '--target', target.name];
    if (target.configuration) args.push('--config', target.configuration);
    if (selection.buildArgs) args.push(...selection.buildArgs);
    if (before.cache.get('CMAKE_GENERATOR')?.startsWith('Ninja')) args.push('--', '-d', 'keepdepfile');
    await this.execute(selection.sourceDirectory, args, signal, false, selection.buildPreset ? this.environment : selection.configureEnvironment, selection.binaryDirectory);
    await verifyOptimization(selection);
    const model = await readBuildModel(selection.binaryDirectory);
    await this.checkModel(model, selection);
    return model;
  }
  async inputs(selection: ResolvedSelection, target: FirmwareTarget, signal: AbortSignal,
    allowMissing: boolean, approve: (file: string) => Promise<boolean>): Promise<DependencyInputs> {
    await this.validateSelection(selection);
    const model = await readBuildModel(selection.binaryDirectory);
    await this.checkModel(model, selection);
    const generator = model.cache.get('CMAKE_GENERATOR');
    if (!generator?.startsWith('Ninja')) return { files: [], complete: true, hardwareIssue: t("此生成器尚无实际依赖验证；可以编译，但不能进入下载/调试。请使用已有的 Ninja 配置。") };
    const ninja = this.tools.find(tool => tool.id === 'ninja')?.executables.ninja;
    if (!ninja || !path.isAbsolute(ninja)) throw new Error(t("请先选择 Ninja"));
    const prefix: string[] = [];
    if (generator === 'Ninja Multi-Config') {
      if (!target.configuration || /[\\/:\x00-\x1f]/.test(target.configuration)) throw new Error(t("多配置 Ninja 的配置名无效"));
      prefix.push('-f', `build-${target.configuration}.ninja`);
    }
    const query = async (args: string[]): Promise<string> => {
      this.guard();
      if (signal.aborted) throw new BuildCancelled();
      let output = '', error = '';
      const result = await this.runner({ executable: ninja, args: [...prefix, '-t', ...args], cwd: selection.binaryDirectory,
        env: this.environment, signal, timeoutMs: 30000, onOutput: (stream, text) => {
          if (stream === 'stdout') output += text; else error = (error + text).slice(-8192);
          if (output.length > 16777216) throw new Error(t("Ninja 依赖元数据超过大小限制"));
        } });
      if (!result.treeExited) throw new ProcessTreeUncertain(t("无法确认 Ninja 依赖查询进程树已退出"));
      if (signal.aborted || result.reason === 'cancelled') throw new BuildCancelled();
      if (result.reason !== 'exit' || result.exitCode !== 0) throw new Error(t("Ninja 依赖查询失败，请检查 Ninja 版本与日志: {0}", result.error ?? error));
      return output;
    };
    const resolve = (file: string) => path.resolve(selection.binaryDirectory, file);
    const key = (file: string) => resolve(file).toLowerCase();
    const buildFile = prefix.includes('-f') ? path.join(selection.binaryDirectory, prefix[prefix.indexOf('-f') + 1]) : path.join(selection.binaryDirectory, 'build.ninja');
    const signature = await fileSignature([buildFile]);
    const cachedQuery = async <T>(cacheKey: string, compute: () => Promise<T>): Promise<T> => {
      const hit = ninjaCache.get(cacheKey) as T | undefined;
      if (hit !== undefined) return hit;
      return remember(ninjaCache, cacheKey, await compute()) as T;
    };
    const names = await cachedQuery(`inputs\0${signature}\0${target.name}`,
      async () => ninjaInputNames(await query(['inputs', '--', target.name])));
    const commands = await cachedQuery(`compdb\0${signature}`, async () => readCompilations(await query(['compdb', '-x'])));
    const outputs = new Set(commands.map(entry => key(entry.output)));
    const selected = new Set([...names.map(key), ...target.artifacts.map(key)]);
    const files = new Set<string>();
    const directories = new Set<string>();
    let complete = true, compilationCount = 0;
    let hardwareIssue: string | undefined;
    const roots = await Promise.all([selection.sourceDirectory, ...this.tools.map(tool => path.basename(tool.root).toLowerCase() === 'bin' ? path.dirname(tool.root) : tool.root)].map(file => fs.realpath(file)));
    const allowRead = async (file: string): Promise<void> => {
      const actual = await fs.realpath(file);
      if (!roots.some(root => isWithin(root, actual))) {
        this.guard();
        if (!await approve(actual)) throw new BuildCancelled();
        roots.push(actual);
      }
      this.guard();
      if (signal.aborted) throw new BuildCancelled();
    };
    for (const name of names) {
      if (outputs.has(key(name))) continue;
      const file = resolve(name);
      try { if ((await fs.stat(file)).isFile()) files.add(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; complete = false; }
    }
    let fallback: Map<string, string[]> | undefined;
    for (const entry of commands.filter(item => selected.has(key(item.output)) && item.command)) {
      if (path.resolve(entry.directory).toLowerCase() !== path.resolve(selection.binaryDirectory).toLowerCase()) throw new Error(t("Ninja 编译目录发生变化，无法确认依赖"));
      const words = commandWords(entry.command);
      for (let index = 0; index < words.length; index++) {
        const word = words[index];
        const flag = ['-isystem', '-iquote', '-idirafter', '-I'].find(value => word.startsWith(value));
        if (flag) {
          const value = word === flag ? words[++index] : word.slice(flag.length);
          if (!value || value.startsWith('=')) throw new Error(t("无法确认编译器头文件搜索路径"));
          directories.add(resolve(value));
        }
        const specs = /^(?:--?specs)=(.+)$/.exec(word)?.[1];
        if (specs && !['nano.specs', 'nosys.specs'].includes(specs) || /^(?:--sysroot(?:=|$)|-isysroot|-B)/.test(word)) hardwareIssue = t("构建含自定义 specs/sysroot/工具搜索前缀，当前版本不能确认其隐式输入；仅编译，不进入下载/调试。");
      }
      if (words.some((word, index) => word.toLowerCase() === 'cd' && words[index + 1] !== '.')) throw new Error(t("构建命令切换了工作目录，当前版本无法确认其依赖路径"));
      const linker = linkerArguments(words);
      if (linker.search.some(file => file.startsWith('=') || file.startsWith('$SYSROOT'))) throw new Error(t("暂不能确认带 sysroot 的链接搜索目录"));
      const search = [entry.directory, ...linker.search.map(resolve)];
      const scripts = [...linker.scripts, ...linker.files.filter(file => /\.(?:ld|lds)$/i.test(file))];
      for (const file of await linkerScriptInputs(scripts, search, allowRead, directory => directories.add(directory))) files.add(file);
      for (const name of linker.files) if (!outputs.has(key(name))) files.add(resolve(name));
      for (const library of linker.libraries) {
        const filename = library.startsWith(':') ? library.slice(1) : `lib${library}.a`;
        for (const directory of search) {
          const file = path.resolve(directory, filename);
          try { if ((await fs.stat(file)).isFile()) { files.add(file); break; } }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
      if (!words.includes('-c')) continue;
      compilationCount++;
      const arm = this.tools.find(tool => tool.id === 'armGnu');
      if (![arm?.executables.gcc, arm?.executables.gpp].some(file => file && words.some(word => path.isAbsolute(word) && path.resolve(word).toLowerCase() === path.resolve(file).toLowerCase()))) {
        const actual = words.find(word => /(?:^|[\\/])arm-none-eabi-(?:gcc|g\+\+)(?:\.exe)?$/i.test(word)) ?? words[0] ?? t('(未设置)');
        hardwareIssue = t('Arm 编译器路径不一致，暂停烧录/调试。\n实际命令：{0}\n当前选择：{1}\n请在“管理工具 → Arm GNU → 选择已有”选择实际编译器目录，再重新编译；不需要更换 OpenOCD。', actual,
          [arm?.executables.gcc, arm?.executables.gpp].filter(Boolean).join(' / ') || t('(未设置)'));
      }
      if (/\.s$/i.test(entry.file)) {
        try {
          const source = resolve(entry.file);
          await allowRead(source);
          if (/^\s*\.(?:include|incbin)\b/m.test(await readDependencyFile(source))) hardwareIssue = t("汇编含 .include/.incbin，当前版本不能确认其完整输入；仅编译，不进入下载/调试。");
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; complete = false; }
      }
      const depfile = argumentValue(words, '-MF');
      let dependencies: string[] | undefined;
      if (depfile) {
        const file = await fs.realpath(selection.binaryDirectory);
        const dependencyPath = resolve(depfile);
        if (!isWithin(file, dependencyPath)) throw new Error(t("编译依赖文件不在构建目录内"));
        try {
          if (!isWithin(file, await fs.realpath(dependencyPath))) throw new Error(t("编译依赖文件符号链接越出构建目录"));
          dependencies = makeDependencies(await readDependencyFile(dependencyPath));
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (!dependencies) {
        fallback ??= ninjaDependencies(await query(['deps']));
        const values = [...fallback].find(([output]) => key(output) === key(entry.output))?.[1];
        if (values?.length) {
          let valid = true;
          for (const name of values) {
            try { if (!(await fs.stat(resolve(name))).isFile()) valid = false; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; valid = false; }
          }
          if (valid) dependencies = values;
        }
      }
      if (!dependencies?.some(file => key(file) === key(entry.file))) complete = false;
      if (dependencies) for (const file of dependencies) files.add(resolve(file));
    }
    if (!compilationCount) hardwareIssue = t("没有找到可验证的 Arm 编译单元；仅编译，不进入下载/调试。");
    for (const name of ['build.ninja', 'CMakeFiles/rules.ninja', ...(target.configuration ? [`build-${target.configuration}.ninja`, `CMakeFiles/impl-${target.configuration}.ninja`] : [])]) {
      const file = resolve(name);
      try { if ((await fs.stat(file)).isFile()) files.add(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!complete && !allowMissing) throw new Error(t("无法确认实际编译依赖，请先在正常构建目录重新编译以生成 GCC/Ninja 依赖文件；未执行硬件操作"));
    return { files: [...files], complete, directories: [...directories], hardwareIssue };
  }
  private async validateSelection(selection: ResolvedSelection): Promise<void> {
    if (!path.isAbsolute(selection.sourceDirectory) || !path.isAbsolute(selection.binaryDirectory)) throw new Error(t("工程/构建目录不是绝对路径"));
    if (path.resolve(selection.sourceDirectory).toLowerCase() === path.resolve(selection.binaryDirectory).toLowerCase()) throw new Error(t("拒绝在源码根目录构建"));
    if (selection.declaredCmakeExecutable && !await this.sameFile(selection.declaredCmakeExecutable, this.cmake)) throw new Error(t("预设指定的 CMake 与当前授权工具不同，请先在工具设置中确认选择"));
    if (selection.generator?.startsWith('Ninja') && !this.tools.some(tool => tool.id === 'ninja' && tool.executables.ninja)) throw new Error(t("当前预设使用 Ninja，请先选择或安装 Ninja"));
  }
  private async sameFile(left: string, right: string): Promise<boolean> {
    if (!path.isAbsolute(left) || !path.isAbsolute(right)) return false;
    try { return (await fs.realpath(left)).toLowerCase() === (await fs.realpath(right)).toLowerCase(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  private async checkCache(selection: ResolvedSelection): Promise<void> {
    let data: string;
    try {
      const file = path.join(selection.binaryDirectory, 'CMakeCache.txt');
      if ((await fs.stat(file)).size > 16777216) throw new Error(t("CMakeCache 超过大小限制"));
      data = await fs.readFile(file, 'utf8');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const cache = new Map<string, string>();
    for (const line of data.split(/\r?\n/)) {
      const match = /^([^/#][^:]*):[^=]+=(.*)$/.exec(line);
      if (match) cache.set(match[1], match[2]);
    }
    await this.checkIdentity(cache, selection);
  }
  private async checkModel(model: BuildModel, selection: ResolvedSelection): Promise<void> {
    if ((await fs.realpath(model.sourceDirectory)).toLowerCase() !== (await fs.realpath(selection.sourceDirectory)).toLowerCase()) throw new Error(t("CMake 配置结果属于另一个源码工程"));
    await this.checkIdentity(model.cache, selection);
  }
  private async checkIdentity(cache: Map<string, string>, selection: ResolvedSelection): Promise<void> {
    const home = cache.get('CMAKE_HOME_DIRECTORY');
    if (home && path.resolve(home).toLowerCase() !== path.resolve(selection.sourceDirectory).toLowerCase()) throw new Error(t("现有缓存属于另一个源码目录；插件不会删除缓存，请使用正确的配置目录"));
    const generator = cache.get('CMAKE_GENERATOR');
    if (generator && selection.generator && generator !== selection.generator) throw new Error(t("现有缓存 generator 与所选配置冲突；插件不会清理缓存，请选择独立的已有配置"));
    const arm = this.tools.find(tool => tool.id === 'armGnu');
    for (const [key, name] of [['CMAKE_C_COMPILER', 'gcc'], ['CMAKE_CXX_COMPILER', 'gpp']] as const) {
      const actual = cache.get(key);
      if (!actual) continue;
      const selected = arm?.executables[name];
      if (!selected || !await this.sameFile(actual, selected)) throw new Error(t("工程实际 {0} 与当前所选 Arm 工具不同: {1}。请核对 toolchain/Presets 显式路径，不会自动覆盖。", key, actual));
    }
  }
  private async execute(cwd: string, args: string[], signal: AbortSignal, capture = false, env = this.environment, diagnosticDirectory = cwd): Promise<string> {
    this.guard();
    if (signal.aborted) throw new BuildCancelled();
    let stdout = '';
    const failure = new BuildFailureSummary();
    this.log('stdout', `\n[CMake] ${args.map(arg => JSON.stringify(arg)).join(' ')}\n`, diagnosticDirectory);
    const result = await this.runner({ executable: this.cmake, args, cwd, env, timeoutMs: capture ? 30000 : 600000, signal,
      onOutput: (stream, text) => {
        this.log(stream, text, diagnosticDirectory);
        failure.append(stream, text);
        if (capture && stream === 'stdout') {
          stdout += text;
          if (stdout.length > 2097152) throw new Error(t("CMake 配置列表超过大小限制"));
        }
      } });
    if (!result.treeExited) throw new ProcessTreeUncertain(t("无法确认 CMake 作业进程树已退出，保留占用状态；请检查日志"));
    if (signal.aborted || result.reason === 'cancelled') throw new BuildCancelled();
    if (result.reason !== 'exit' || result.exitCode !== 0) throw new Error(`CMake ${result.reason === 'timeout' ? t("超时") : t("执行失败")} (${result.exitCode ?? t("无退出码")}): ${result.error || failure.finish()}`);
    return stdout;
  }
}
