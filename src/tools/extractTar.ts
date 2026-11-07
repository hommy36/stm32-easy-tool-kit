import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createGunzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extract } from 'tar-stream';
import { ToolRelease } from '../core/types';
import { resolveArchiveEntry } from '../core/paths';

/** Only regular files/directories in a fresh staging directory; no shell/tar executable. */
export async function extractTarArchive(file: string, destination: string, release: ToolRelease, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const archive = extract();
  let entries = 0, declared = 0, written = 0, inflated = 0;
  let active: Promise<void> = Promise.resolve();
  const seen = new Set<string>();
  archive.on('entry', (header, stream, next) => {
    active = (async () => {
      signal.throwIfAborted();
      if (++entries > release.maxEntries) throw new Error('TAR entry limit exceeded.');
      if (header.type !== 'file' && header.type !== 'directory') throw new Error('TAR links and special files are not supported.');
      if (!Number.isSafeInteger(header.size) || header.size! < 0 || header.size! > release.maxFileBytes
        || (declared += header.size!) > release.maxExtractedBytes) throw new Error('TAR size limit exceeded.');
      const name = header.name.replace(/^(?:\.\/)+/, '');
      if ((name === '.' || !name) && header.type === 'directory' && header.size === 0) { stream.resume(); next(); return; }
      const target = resolveArchiveEntry(destination, name);
      const identity = target.toLowerCase();
      if (seen.has(identity)) throw new Error('Duplicate TAR path.');
      seen.add(identity);
      if (header.type === 'directory') {
        if (header.size !== 0) throw new Error('Invalid TAR directory.');
        await fsp.mkdir(target, { recursive: true }); stream.resume();
      } else {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        let bytes = 0;
        const limiter = new Transform({ transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length; written += chunk.length;
          if (bytes > header.size! || written > release.maxExtractedBytes) done(new Error('TAR payload limit exceeded.'));
          else done(null, chunk);
        } });
        await pipeline(stream, limiter, fs.createWriteStream(target, { flags: 'wx' }), { signal });
        if (bytes !== header.size) throw new Error('Truncated TAR file.');
      }
      signal.throwIfAborted(); next();
    })();
    void active.catch(error => archive.destroy(error));
  });
  const expandedLimit = release.maxExtractedBytes + release.maxEntries * 2048;
  const limiter = new Transform({ transform(chunk: Buffer, _encoding, done) {
    inflated += chunk.length;
    if (inflated > expandedLimit) done(new Error('Inflated TAR limit exceeded.'));
    else done(null, chunk);
  } });
  try { await pipeline(fs.createReadStream(file), createGunzip(), limiter, archive, { signal }); }
  finally { await active; }
}
