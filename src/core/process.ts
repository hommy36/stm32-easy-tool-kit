import { t } from '../i18n';
import { spawn } from 'node:child_process';
import { RunRequest, RunResult, errorText } from './types';

export function runProcess(request: RunRequest): Promise<RunResult> {
  return new Promise(resolve => {
    const result: RunResult = { exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: false };
    if (request.signal?.aborted) {
      resolve({ ...result, cancelled: true });
      return;
    }
    let child;
    try {
      child = spawn(request.executable, request.args, {
        shell: false, windowsHide: true, cwd: request.cwd, env: request.env ?? process.env
      });
    } catch (error) {
      resolve({ ...result, stderr: errorText(error) });
      return;
    }
    const limit = 2 * 1024 * 1024;
    let truncated = false;
    const append = (key: 'stdout' | 'stderr', chunk: Buffer) => {
      const remaining = limit - result[key].length;
      if (remaining > 0) result[key] += chunk.toString('utf8').slice(0, remaining);
      if (chunk.length > remaining) truncated = true;
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', error => { result.stderr += errorText(error); });
    const timer = setTimeout(() => { result.timedOut = true; child.kill(); }, request.timeoutMs);
    const cancel = () => { result.cancelled = true; child.kill(); };
    request.signal?.addEventListener('abort', cancel, { once: true });
    child.on('close', code => {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', cancel);
      result.exitCode = code;
      if (truncated) result.stderr += t("\n[输出已达到上限，后续内容已截断]");
      resolve(result);
    });
    if (request.signal?.aborted) cancel();
  });
}
