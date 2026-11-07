import { t } from '../i18n';
import * as net from 'node:net';
import * as path from 'node:path';
import { runProcess } from '../core/process';
import { runJob } from '../core/jobProcess';
import { mergeToolPath, toolBinDirectories } from '../core/paths';
import { BuildCancelled, ProcessTreeUncertain } from '../build/service';
import { ProjectSettings } from '../project/types';
import { DapConfiguration, DapRuntime, buildConfigArgs, portCommand, resolveDapConfiguration, scriptFingerprint } from './config';
import { isC5Target, verifyC5Files } from './c5';

export interface OwnedGdbServer {
  host: '127.0.0.1'; port: number;
  rtt?: { port: number; controlPort: number; command(command: string): Promise<string> };
  finished: Promise<void>;
  stop(): Promise<void>;
}
export interface ServerRuntime extends DapRuntime {
  beforeStart(): Promise<void>;
  mode?: 'launch' | 'attach';
  rtos?: 'FreeRTOS';
  rtt?: { address: number; searchBytes: number; channel: number };
  ownerCheck?: (port: number, pid: number) => Promise<boolean>;
}
class PortOwnerMismatch extends Error { }

export function tcpListenerOwned(stdout: string, port: number, pid: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(pid) || pid < 1) return false;
  const matching = stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(columns =>
    columns.length === 5 && columns[0].toUpperCase() === 'TCP' && columns[1] === `127.0.0.1:${port}`
    && columns[2] === '0.0.0.0:0');
  return matching.length === 1 && matching[0][4] === String(pid);
}
export async function verifyLoopbackOwner(port: number, pid: number): Promise<boolean> {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT;
  if (!root || !path.isAbsolute(root)) throw new Error(t("无法定位系统网络连接查询工具"));
  const result = await runProcess({ executable: path.join(root, 'System32/netstat.exe'), args: ['-ano', '-p', 'TCP'], timeoutMs: 10000 });
  if (result.exitCode !== 0 || result.timedOut || result.stderr.includes(t("输出已达到上限"))) throw new Error(t("无法核实 GDB 端口归属，不会连接未知服务"));
  return tcpListenerOwned(result.stdout, port, pid);
}
async function freePort(): Promise<number> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error(t("无法分配本地 GDB 端口"))); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}
export function buildServerArgs(settings: ProjectSettings, configuration: DapConfiguration, port: number, options?: { mode?: 'launch' | 'attach'; rtos?: 'FreeRTOS'; controlPort?: number }): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t("GDB 端口无效"));
  return [...buildConfigArgs({ ...settings, targetScript: configuration.targetScript }, configuration.scriptsDirectory, configuration.dialect),
    '-c', 'bindto 127.0.0.1', '-c', portCommand(configuration.dialect, 'gdb', port),
    '-c', portCommand(configuration.dialect, 'tcl', options?.controlPort ?? 'disabled'), '-c', portCommand(configuration.dialect, 'telnet', 'disabled'),
    ...(options?.rtos ? ['-c', '[target current] configure -rtos FreeRTOS'] : []),
    '-c', 'init', ...(options?.mode === 'attach' ? [] : ['-c', 'halt'])];
}

export async function startGdbServer(settings: ProjectSettings, signal: AbortSignal, runtime: ServerRuntime): Promise<OwnedGdbServer> {
  const configuration = await resolveDapConfiguration(settings, signal, runtime);
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    try { return await startOnce(settings, configuration, port, signal, runtime); }
    catch (error) { if (!(error instanceof PortOwnerMismatch) || attempt === 2) throw error; }
  }
  throw new Error(t("无法获得属于本次作业的 GDB 端口"));
}
async function startOnce(settings: ProjectSettings, configuration: DapConfiguration, port: number,
  signal: AbortSignal, runtime: ServerRuntime): Promise<OwnedGdbServer> {
  runtime.guard();
  if (signal.aborted) throw new BuildCancelled();
  if (await scriptFingerprint(configuration.targetScript) !== configuration.targetSha256) throw new Error(t("目标脚本已变化，请重新确认"));
  await runtime.beforeStart();
  if (await scriptFingerprint(configuration.targetScript) !== configuration.targetSha256) throw new Error(t("目标脚本已变化，请重新确认"));
  if (isC5Target(settings)) await verifyC5Files(configuration.scriptsDirectory, configuration.targetScript);
  runtime.guard();
  if (signal.aborted) throw new BuildCancelled();
  const controller = new AbortController();
  let stopRequested = false;
  let ended = false;
  let pid = 0;
  let tail = '';
  let controlPort = runtime.rtt ? await freePort() : undefined;
  while (controlPort === port) controlPort = await freePort();
  let rttPort = runtime.rtt ? await freePort() : undefined;
  while (rttPort !== undefined && (rttPort === controlPort || rttPort === port)) rttPort = await freePort();
  let readyResolve!: () => void;
  let startedResolve!: () => void;
  const ready = new Promise<void>(resolve => { readyResolve = resolve; });
  const started = new Promise<void>(resolve => { startedResolve = resolve; });
  const abort = () => { stopRequested = true; controller.abort(); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const job = (runtime.runner ?? runJob)({ executable: configuration.executable, args: buildServerArgs(settings, configuration, port, { mode: runtime.mode, rtos: runtime.rtos, controlPort }),
    cwd: settings.sourceDirectory, env: mergeToolPath(process.env, toolBinDirectories(runtime.tools)),
    timeoutMs: 86400000, signal: controller.signal,
    onStarted: value => { pid = value; startedResolve(); },
    onOutput: (stream, text) => {
      runtime.log(stream, text);
      tail = (tail + text).slice(-65536);
      if (tail.includes(`Listening on port ${port} for gdb connections`)) readyResolve();
    } });
  const finished = job.then(result => {
    ended = true;
    signal.removeEventListener('abort', abort);
    if (!result.treeExited) throw new ProcessTreeUncertain(t("无法确认 OpenOCD 调试服务器已退出，保留探针占用"));
    if (!stopRequested && !signal.aborted) throw new Error(t("OpenOCD 调试服务器意外退出 ({0}): {1}", result.exitCode ?? t("无退出码"), result.error ?? tail.slice(-4096)));
  });
  void finished.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startupTimeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(t("OpenOCD 调试服务器启动超时"))), 20000); });
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      stopRequested = true;
      controller.abort();
      const result = await job;
      if (!result.treeExited) throw new ProcessTreeUncertain(t("OpenOCD 服务器停止状态不确定，不能释放探针"));
    })();
    return stopping;
  };
  try {
    await Promise.race([Promise.all([started, ready]), finished.then(() => { throw signal.aborted ? new BuildCancelled() : new Error(t("服务器尚未就绪就已退出")); }), startupTimeout]);
    runtime.guard();
    if (signal.aborted) throw new BuildCancelled();
    if (ended || !await (runtime.ownerCheck ?? verifyLoopbackOwner)(port, pid)) throw new PortOwnerMismatch(t("GDB 端口不属于本次 OpenOCD，拒绝连接"));
    runtime.guard();
    if (signal.aborted) throw new BuildCancelled();
    if (ended) throw new Error(t("OpenOCD 在端口核验期间已退出"));
    let rtt: OwnedGdbServer['rtt'];
    if (runtime.rtt && controlPort && rttPort) {
      if (!await (runtime.ownerCheck ?? verifyLoopbackOwner)(controlPort, pid)) throw new Error('RTT control port ownership mismatch.');
      const command = async (text: string) => {
        const response = await tclCommand(controlPort!, `set __stme_code [catch {${text}} __stme_result]; format "%d\n%s" $__stme_code $__stme_result`, signal);
        const first = response.indexOf('\n');
        if (first < 0 || response.slice(0,first).trim() !== '0') throw new Error(`OpenOCD RTT command failed: ${response}`);
        return response.slice(first+1);
      };
      await command(`rtt setup 0x${runtime.rtt.address.toString(16)} ${runtime.rtt.searchBytes} {SEGGER RTT}`);
      await command('rtt polling_interval 100');
      await command(`rtt server start ${rttPort} ${runtime.rtt.channel}`);
      if (!await (runtime.ownerCheck ?? verifyLoopbackOwner)(rttPort, pid)) throw new Error('RTT data port ownership mismatch.');
      rtt = { port: rttPort, controlPort, command };
    }
    return { host: '127.0.0.1', port, finished, stop, rtt };
  } catch (error) {
    await stop();
    throw error;
  } finally { if (timer) clearTimeout(timer); }
}
export function tclCommand(port: number, command: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve,reject) => {
    signal.throwIfAborted();
    if (!Number.isInteger(port) || port < 1 || port > 65535 || command.includes(String.fromCharCode(26))) { reject(new Error('Invalid Tcl request.')); return; }
    const socket = net.createConnection({ host: '127.0.0.1', port }); let response = ''; let settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); socket.destroy(); if (error) reject(error); else resolve(response.replace(/\x1a[\s\S]*$/, '')); };
    const abort = () => finish(new Error('RTT request cancelled.')); signal.addEventListener('abort', abort, { once: true });
    socket.setTimeout(5000, () => finish(new Error('RTT control timed out.')));
    socket.on('connect', () => socket.write(command + String.fromCharCode(26)));
    socket.on('data', chunk => { response += chunk.toString('utf8'); if (response.length > 65536) finish(new Error('RTT response too large.')); else if (response.includes(String.fromCharCode(26))) finish(); });
    socket.on('error', finish); socket.on('end', () => { if (!settled) finish(new Error('Incomplete RTT control response.')); });
  });
}
