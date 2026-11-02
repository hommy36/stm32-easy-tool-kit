import * as fs from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

/** Windows scanners and concurrent readers can briefly prevent replacing an open file. */
export async function replaceFile(source: string, target: string,
  rename: typeof fs.rename = fs.rename): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, target); return; }
    catch (error) {
      if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      // Keep the previous record intact. Never delete it to work around a sharing violation.
      await setTimeout(25 * (attempt + 1));
    }
  }
}
