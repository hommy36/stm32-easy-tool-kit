import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface Lease { release(): Promise<void>; }

export async function acquireOperationLock(directory: string, key: string): Promise<Lease> {
  if (!path.isAbsolute(directory) || !key) throw new Error(t("操作锁目录或键无效"));
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${createHash('sha256').update(key.toLowerCase()).digest('hex')}.lock`);
  const identity = { pid: process.pid, instanceId: randomUUID(), createdAt: new Date().toISOString() };
  let handle;
  try { handle = await fs.open(file, 'wx'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(t("另一个窗口/作业正在占用此操作。若异常退出，请先核实锁中 PID 与作业已结束，再处理: {0}", file));
  }
  try { await handle.writeFile(JSON.stringify(identity)); } catch (error) {
    await handle.close();
    await fs.rm(file, { force: true });
    throw error;
  }
  await handle.close();
  let releasing: Promise<void> | undefined;
  return {
    release: () => {
      releasing ??= (async () => {
        const stat = await fs.stat(file);
        if (stat.size > 4096) throw new Error(t("操作锁内容异常，拒绝释放"));
        const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!raw || typeof raw !== 'object' || !('instanceId' in raw) || raw.instanceId !== identity.instanceId) throw new Error(t("操作锁归属变化，拒绝释放"));
        await fs.unlink(file);
      })();
      return releasing;
    }
  };
}
