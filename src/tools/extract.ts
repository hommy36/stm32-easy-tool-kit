import { t } from '../i18n';
import * as yauzl from 'yauzl';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { ToolRelease } from '../core/types';
import { resolveArchiveEntry } from '../core/paths';

export function extractArchive(file: string, destination: string, release: ToolRelease, signal: AbortSignal,
  progress: (entries: number) => void = () => {}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error(t("解压已取消"))); return; }
    yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) { reject(error ?? new Error(t("无法打开 ZIP"))); return; }
      let settled = false;
      let active: Promise<void> | undefined;
      let entries = 0;
      let total = 0;
      let actualTotal = 0;
      const finish = (failure?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        void Promise.resolve(active).catch(() => undefined).then(() => {
          zip.close();
          if (failure) reject(failure); else resolve();
        });
      };
      const abort = () => finish(new Error(t("解压已取消")));
      signal.addEventListener('abort', abort, { once: true });
      zip.on('error', finish);
      zip.on('end', () => finish());
      zip.on('entry', (entry: yauzl.Entry) => {
        active = (async () => {
          signal.throwIfAborted();
          if (++entries > release.maxEntries) throw new Error(t("压缩包条目数超过限制"));
          total += entry.uncompressedSize;
          if (total > release.maxExtractedBytes || entry.uncompressedSize > release.maxFileBytes) throw new Error(t("压缩包解压大小超过限制"));
          const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (kind && kind !== 0x8000 && kind !== 0x4000) throw new Error(t("拒绝压缩包中的链接或特殊文件"));
          if (entry.generalPurposeBitFlag & 1) throw new Error(t("不支持加密工具包"));
          const target = resolveArchiveEntry(destination, entry.fileName);
          if (entry.fileName.endsWith('/')) {
            await fsp.mkdir(target, { recursive: true });
          } else {
            await fsp.mkdir(path.dirname(target), { recursive: true });
            signal.throwIfAborted();
            const stream = await new Promise<import('node:stream').Readable>((accept, fail) => zip.openReadStream(entry, (err, value) => {
              if (err || !value) fail(err ?? new Error(t("无法读取 ZIP 条目"))); else accept(value);
            }));
            let actualFile = 0;
            const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
              actualFile += chunk.length;
              actualTotal += chunk.length;
              if (actualFile > release.maxFileBytes || actualTotal > release.maxExtractedBytes) callback(new Error(t("实际解压大小超过限制")));
              else callback(null, chunk);
            } });
            await pipeline(stream, limiter, fs.createWriteStream(target, { flags: 'wx' }), { signal });
          }
          signal.throwIfAborted();
          progress(entries);
          if (!settled) zip.readEntry();
        })();
        void active.catch(finish);
      });
      if (signal.aborted) abort(); else zip.readEntry();
    });
  });
}
