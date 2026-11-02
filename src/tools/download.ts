import { t } from '../i18n';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ToolRelease } from '../core/types';

export async function verifyArchive(file: string, release: ToolRelease, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if ((await fsp.stat(file)).size !== release.archiveBytes) throw new Error(t("工具包大小不匹配，文件可能损坏或不是所选版本"));
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk as Buffer);
  if (hash.digest('hex') !== release.sha256) throw new Error(t("SHA-256 校验失败，拒绝解压和执行"));
}

export async function snapshotArchive(source: string, target: string, release: ToolRelease, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if ((await fsp.stat(source)).size !== release.archiveBytes) throw new Error(t("工具包大小不匹配，拒绝创建快照"));
  let received = 0;
  const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    received += chunk.length;
    if (received > release.archiveBytes) callback(new Error(t("离线包在复制时发生变化，超过清单大小")));
    else callback(null, chunk);
  } });
  await pipeline(fs.createReadStream(source), limiter, fs.createWriteStream(target, { flags: 'wx' }), { signal });
  await verifyArchive(target, release, signal);
}

export function validateDownloadUrl(value: string, hosts: string[]): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname)) {
    throw new Error(t("下载或重定向地址不在允许的 HTTPS 域名中"));
  }
  return url;
}

async function downloadOnce(release: ToolRelease, file: string, signal: AbortSignal, proxy: string | undefined,
  progress: (received: number) => void, address = release.url, redirects = 0): Promise<void> {
  signal.throwIfAborted();
  const url = validateDownloadUrl(address, release.allowedDownloadHosts);
  if (redirects > 5) throw new Error(t("下载重定向超过 5 次"));
  if (proxy && !/^https?:\/\//i.test(proxy)) throw new Error(t("首版只支持显式 HTTP/HTTPS 代理，其他代理请使用离线导入"));
  const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const request = https.get(url, {
      agent: proxy ? new HttpsProxyAgent(proxy) : undefined,
      signal, headers: { 'User-Agent': 'STM32-Easy-Tool-Kit/0.1.0', 'Accept-Encoding': 'identity' }
    });
    const timer = setTimeout(() => request.destroy(new Error(t("下载响应超时"))), 30000);
    request.once('response', incoming => { clearTimeout(timer); resolve(incoming); });
    request.once('error', error => { clearTimeout(timer); reject(error); });
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
    const location = response.headers.location;
    response.destroy();
    if (!location) throw new Error(t("下载重定向缺少 Location"));
    return downloadOnce(release, file, signal, proxy, progress, new URL(location, url).href, redirects + 1);
  }
  if (response.statusCode !== 200) { response.destroy(); throw new Error(t("工具下载失败，HTTP {0}", response.statusCode)); }
  if (response.headers['content-length'] && Number(response.headers['content-length']) !== release.archiveBytes) {
    response.destroy(); throw new Error(t("下载响应大小与固定清单不匹配"));
  }
  response.setTimeout(30000, () => response.destroy(new Error(t("下载连续 30 秒无数据"))));
  let received = 0;
  const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    received += chunk.length;
    if (received > release.archiveBytes) { callback(new Error(t("下载超过清单限定大小"))); return; }
    progress(received);
    callback(null, chunk);
  } });
  await pipeline(response, limiter, fs.createWriteStream(file, { flags: 'wx' }), { signal });
}

export async function downloadRelease(release: ToolRelease, file: string, signal: AbortSignal,
  proxy?: string, progress: (received: number) => void = () => {}): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await downloadOnce(release, file, signal, proxy, progress);
      await verifyArchive(file, release, signal);
      return;
    } catch (error) {
      await fsp.rm(file, { force: true });
      if (signal.aborted || attempt === 2) throw error;
      await delay(500 * (attempt + 1), undefined, { signal });
    }
  }
}
