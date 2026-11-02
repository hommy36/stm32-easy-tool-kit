import { t } from '../i18n';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { errorText } from './types';

export interface JobRequest {
  executable: string; args: string[]; cwd: string;
  env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal;
  onOutput(stream: 'stdout' | 'stderr', text: string): void;
  onStarted?: (pid: number) => void;
}
export interface JobResult {
  exitCode: number | null;
  reason: 'exit' | 'cancelled' | 'timeout' | 'failed';
  treeExited: boolean;
  error?: string;
}

export function runJob(request: JobRequest): Promise<JobResult> {
  if (request.signal.aborted) return Promise.resolve({ exitCode: null, reason: 'cancelled', treeExited: true });
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error(t("作业进程仅支持 Windows x64"));
  if (!path.isAbsolute(request.executable) || !path.isAbsolute(request.cwd)
    || !Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 2147483647
    || request.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error(t("作业参数无效"));
  const source = path.resolve(__dirname, '../../resources/windows-job-host.cs').replace(/'/g, "''");
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -Path '${source}' -ReferencedAssemblies 'System.Web.Extensions'; [Stm32JobHost]::Run()`;
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error(t("无法定位系统 PowerShell"));
  const executable = path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return new Promise(resolve => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { shell: false, windowsHide: true, cwd: request.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let received: JobResult | undefined;
    let protocolError: string | undefined;
    let started = false;
    let prepared = false;
    let cancelled = false;
    let forcedTimeout = false;
    let buffer = '';
    let hostError = '';
    const protocolDecoder = new StringDecoder('utf8');
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const send = (type: 'cancel' | 'resume') => {
      if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(`${JSON.stringify({ type })}\n`);
    };
    const cancel = () => { cancelled = true; send('cancel'); };
    const fail = (text: string) => { protocolError ??= text; send('cancel'); };
    const timeout = setTimeout(() => {
      forcedTimeout = true;
      send('cancel');
      child.stdin.end();
      const kill = setTimeout(() => child.kill(), 15000);
      kill.unref();
    }, request.timeoutMs + 30000);
    timeout.unref();
    const parse = (line: string) => {
      const raw: unknown = JSON.parse(line);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(t("作业协议不是对象"));
      const frame = raw as Record<string, unknown>;
      if (received) throw new Error(t("作业结束后收到多余消息"));
      if (frame.type === 'prepared' || frame.type === 'started') {
        if (!Number.isSafeInteger(frame.pid) || Number(frame.pid) < 1) throw new Error(t("作业 PID 无效"));
        if (frame.type === 'prepared') {
          if (prepared) throw new Error(t("重复的作业准备消息"));
          prepared = true;
          if (request.signal.aborted || cancelled || protocolError || forcedTimeout) send('cancel'); else send('resume');
        } else {
          if (!prepared || started) throw new Error(t("作业启动顺序无效"));
          started = true;
          request.onStarted?.(Number(frame.pid));
        }
      } else if (frame.type === 'output') {
        if (frame.stream !== 'stdout' && frame.stream !== 'stderr' || typeof frame.data !== 'string'
          || frame.data.length > 8192 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) throw new Error(t("作业输出消息无效"));
        const text = decoders[frame.stream].write(Buffer.from(frame.data, 'base64'));
        if (text) request.onOutput(frame.stream, text);
      } else if (frame.type === 'finished') {
        if (!['exit', 'cancelled', 'timeout', 'failed'].includes(String(frame.reason))
          || typeof frame.treeExited !== 'boolean' || frame.exitCode !== null && !Number.isInteger(frame.exitCode)
          || frame.error !== null && frame.error !== undefined && typeof frame.error !== 'string') throw new Error(t("作业结果消息无效"));
        received = { exitCode: frame.exitCode as number | null, reason: frame.reason as JobResult['reason'],
          treeExited: frame.treeExited, error: typeof frame.error === 'string' ? frame.error : undefined };
        child.stdin.end();
      } else throw new Error(t("未知作业协议消息"));
    };
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += protocolDecoder.write(chunk);
      if (buffer.length > 262144) { fail(t("作业协议缓冲区超过限制")); buffer = ''; return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try { parse(line); } catch (error) { fail(errorText(error)); }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { if (hostError.length < 16384) hostError += chunk.toString('utf8').slice(0, 16384 - hostError.length); });
    child.stdin.on('error', error => { if (!received) protocolError ??= errorText(error); });
    child.on('error', error => { protocolError ??= errorText(error); });
    request.signal.addEventListener('abort', cancel, { once: true });
    child.on('close', code => {
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', cancel);
      for (const stream of ['stdout', 'stderr'] as const) {
        const text = decoders[stream].end();
        if (text) { try { request.onOutput(stream, text); } catch (error) { protocolError ??= errorText(error); } }
      }
      const result = received ?? { exitCode: null, reason: 'failed' as const, treeExited: !prepared };
      if (cancelled) result.reason = 'cancelled';
      if (forcedTimeout) result.reason = 'timeout';
      if (protocolError || hostError || code !== 0 || buffer.trim()) {
        result.reason = 'failed';
        result.error = protocolError || hostError || t("作业宿主异常退出: {0}", code);
      }
      if (!received && prepared) result.treeExited = false;
      resolve(result);
    });
    child.stdin.write(`${JSON.stringify({ executable: request.executable, args: request.args, cwd: request.cwd,
      env: request.env, timeoutMs: request.timeoutMs })}\n`);
    if (request.signal.aborted) cancel();
  });
}
