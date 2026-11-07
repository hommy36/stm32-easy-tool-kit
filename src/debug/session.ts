import { t } from '../i18n';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ToolInstallation } from '../core/types';
import { BuildEvidence } from '../build/artifacts';
import { BuildCancelled, ProcessTreeUncertain } from '../build/service';
import { OwnedGdbServer } from '../dap/server';
import { ProjectSettings } from '../project/types';
import { cortexCompatible } from '../ui/presentation';

export class CortexDebugUnavailable extends Error { }
type DebugApi = Pick<typeof vscode, 'debug' | 'extensions'>;
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function bounded<T>(promise: PromiseLike<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(promise), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ProcessTreeUncertain(message)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
export async function ensureCortexDebug(api: DebugApi = vscode): Promise<void> {
  const extension = api.extensions.getExtension('marus25.cortex-debug');
  const version = extension?.packageJSON && typeof extension.packageJSON === 'object' ? extension.packageJSON.version : undefined;
  if (!extension || !cortexCompatible(version)) {
    throw new CortexDebugUnavailable(t("调试需要 Cortex-Debug 1.12.1 或兼容的 1.x 版本；请安装或更新后重试。编译和独立烧录不受影响。"));
  }
  await extension.activate();
}
export function assertDebugPathsSupported(evidence: BuildEvidence, settings: ProjectSettings): void {
  if ([evidence.artifact, settings.sourceDirectory].some(file => /[^\x20-\x7e]/.test(file))) {
    throw new Error(t("首版 Windows 调试仅支持源码目录与 ELF 的 ASCII 路径（不能含中文等非 ASCII 字符）。当前 GDB MI 无法可靠加载这些路径；编译和独立烧录不受此限制。未启动 OpenOCD，不会复制固件或改动你的工程。"));
  }
}
export function makeDebugConfiguration(evidence: BuildEvidence, tools: ToolInstallation[], server: OwnedGdbServer,
  settings: ProjectSettings, operationId: string): vscode.DebugConfiguration {
  assertDebugPathsSupported(evidence, settings);
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(operationId)) throw new Error(t("调试作业标识无效"));
  const arm = tools.find(tool => tool.id === 'armGnu');
  const gdbPath = arm?.executables.gdb;
  const objdumpPath = arm?.executables.objdump;
  if (!gdbPath || !objdumpPath || !path.isAbsolute(gdbPath) || !path.isAbsolute(objdumpPath)
    || !path.isAbsolute(evidence.artifact)) throw new Error(t("缺少完整的 Arm GNU 调试工具或 ELF 路径"));
  if (server.host !== '127.0.0.1' || !Number.isInteger(server.port) || server.port < 1 || server.port > 65535) throw new Error(t("调试服务器地址无效"));
  return { type: 'cortex-debug', request: 'launch', name: `STM32 ${operationId}`, servertype: 'external',
    cwd: settings.sourceDirectory, executable: evidence.artifact, gdbTarget: `${server.host}:${server.port}`,
    armToolchainPath: path.dirname(gdbPath), gdbPath, objdumpPath, toolchainPrefix: 'arm-none-eabi',
    runToEntryPoint: settings.stopAtMain ? 'main' : '' };
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class DebugSessionOwner {
  onPaused?: () => void;
  onContinued?: () => void;
  private paused = false;
  get ownedSession(): vscode.DebugSession | undefined { return this.session; }
  get isPaused(): boolean { return this.paused && !this.ended; }
  readonly finished: Promise<void>;
  private readonly completion = deferred<void>();
  private readonly launched = deferred<void>();
  private readonly terminated = deferred<void>();
  private session?: vscode.DebugSession;
  private ended = false;
  private stopping?: Promise<void>;
  private request?: Thenable<boolean>;
  private readonly subscriptions: vscode.Disposable[] = [];
  private started = false;
  constructor(private readonly server: OwnedGdbServer, private readonly signal: AbortSignal,
    private readonly log: (text: string) => void, private readonly api: DebugApi = vscode) {
    this.finished = this.completion.promise;
  }
  async start(folder: vscode.WorkspaceFolder, configuration: vscode.DebugConfiguration, beforeLaunch: () => Promise<void>): Promise<void> {
    if (this.stopping) throw new BuildCancelled();
    if (this.started) throw new Error(t("调试会话不能重复启动"));
    this.started = true;
    const matches = (session: vscode.DebugSession) => session.type === 'cortex-debug'
      && session.name === configuration.name && session.workspaceFolder?.uri.toString() === folder.uri.toString();
    const own = (session: vscode.DebugSession) => {
      if (!matches(session)) return false;
      if (this.session && this.session.id !== session.id) return false;
      this.session = session;
      return true;
    };
    const fail = (error: unknown) => { this.launched.reject(error); void this.cleanup(error).catch(() => {}); };
    const abort = () => fail(new BuildCancelled());
    try {
      await ensureCortexDebug(this.api);
      if (this.signal.aborted) throw new BuildCancelled();
      this.subscriptions.push(this.api.debug.onDidStartDebugSession(session => {
        if (own(session)) this.log(t("调试适配器已启动，等待目标连接；这不表示已停在 main。\n"));
      }), this.api.debug.onDidTerminateDebugSession(session => {
        if (!own(session)) return;
        this.ended = true;
        this.terminated.resolve();
        this.launched.reject(new Error(t("调试会话在启动完成前已结束")));
        void this.cleanup().catch(() => {});
      }), this.api.debug.registerDebugAdapterTrackerFactory('cortex-debug', {
        createDebugAdapterTracker: session => {
          if (!own(session)) return undefined;
          return {
            onDidSendMessage: (raw: unknown) => {
              const message = record(raw);
              if (message?.type === 'response' && message.command === configuration.request) {
                if (message.success === true) { this.log(t("调试启动请求已成功；停止位置以原生调试视图为准。\n")); this.launched.resolve(); }
                else fail(new Error(t("调试启动失败: {0}", typeof message.message === 'string' ? message.message : t("DAP launch 被拒绝"))));
              } else if (message?.type === 'event' && message.event === 'stopped') {
                this.paused = true; this.onPaused?.();
                const body = record(message.body);
                this.log(t("目标已暂停 ({0})，未推断为 main。\n", typeof body?.reason === 'string' ? body.reason : t("原因见调试视图")));
              } else if (message?.type === 'event' && message.event === 'continued') { this.paused = false; this.onContinued?.(); }
            },
            onError: error => fail(error),
            onExit: () => { if (!this.ended) fail(new Error(t("调试适配器已退出"))); }
          };
        }
      }));
      this.signal.addEventListener('abort', abort, { once: true });
      void this.server.finished.then(() => { if (!this.stopping) fail(new Error(t("OpenOCD 调试服务器已停止"))); }, fail);
      await beforeLaunch();
      if (this.stopping) { await this.finished; throw new BuildCancelled(); }
      if (this.signal.aborted) throw new BuildCancelled();
      this.request = this.api.debug.startDebugging(folder, configuration);
      const accepted = await bounded(this.request, 45000, t("无法确认调试启动请求的状态，保留占用"));
      if (!accepted) throw new Error(t("VS Code 未能启动 Cortex-Debug"));
      if (this.signal.aborted) throw new BuildCancelled();
      await bounded(this.launched.promise, 45000, t("未收到调试 launch 响应，停止状态需要确认"));
      if (this.stopping) await this.stopping;
      if (this.signal.aborted) throw new BuildCancelled();
      if (this.ended) throw new Error(t("调试会话已结束"));
    } catch (error) {
      await this.cleanup(error);
      throw error;
    } finally { this.signal.removeEventListener('abort', abort); }
    this.signal.addEventListener('abort', abort, { once: true });
    this.subscriptions.push({ dispose: () => this.signal.removeEventListener('abort', abort) });
  }
  stop(): Promise<void> { this.launched.reject(new BuildCancelled()); return this.cleanup(); }
  private cleanup(error?: unknown): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = Promise.resolve().then(async () => {
      let failure = error;
      let uncertain = error instanceof ProcessTreeUncertain ? error : undefined;
      try { if (this.request) await bounded(this.request, 45000, t("调试启动尚未退出，无法释放占用")); }
      catch (requestError) {
        failure = requestError;
        if (requestError instanceof ProcessTreeUncertain) uncertain ??= requestError;
      }
      if (this.session && !this.ended) {
        try {
          await this.api.debug.stopDebugging(this.session);
          await bounded(this.terminated.promise, 10000, t("无法确认所属调试会话已经退出，保留占用"));
        } catch (stopError) {
          failure = stopError;
          if (!this.ended) uncertain ??= new ProcessTreeUncertain(t("无法确认所属调试会话已停止，保留占用: {0}", String(stopError)));
        }
      }
      try { await this.server.stop(); }
      catch (serverError) { uncertain ??= serverError instanceof ProcessTreeUncertain ? serverError : new ProcessTreeUncertain(t("无法确认 OpenOCD 已停止: {0}", String(serverError))); }
      if (!uncertain || this.ended) for (const item of this.subscriptions.splice(0)) item.dispose();
      if (uncertain) { this.completion.reject(uncertain); throw uncertain; }
      if (failure) this.completion.reject(failure);
      else this.completion.resolve();
    });
    return this.stopping;
  }
}
