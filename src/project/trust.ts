import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { replaceFile } from '../core/atomicFile';
import { createHash, randomUUID } from 'node:crypto';
import { HardwareAuthorization, projectKeyUri, validateAuthorization, validateTrustedPaths } from './types';

export interface TrustRecord { trustedPaths: string[]; authorization?: HardwareAuthorization; }

export class TrustStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly directory: string) {
    if (!path.isAbsolute(directory)) throw new Error(t("信任记录目录必须为绝对路径"));
  }
  private file(uri: string): string {
    return path.join(this.directory, `${createHash('sha256').update(projectKeyUri(uri)).digest('hex')}.json`);
  }
  async read(uri: string): Promise<TrustRecord> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.file(uri), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(t("信任记录损坏"));
      const value = raw as Record<string, unknown>;
      if (Object.keys(value).some(key => !['version', 'trustedPaths', 'authorization'].includes(key))) throw new Error(t("信任记录含未知字段"));
      if (value.version !== 1) throw new Error(t("信任记录版本无效"));
      return { trustedPaths: validateTrustedPaths(value.trustedPaths ?? []),
        authorization: value.authorization === undefined ? undefined : validateAuthorization(value.authorization) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { trustedPaths: [] };
      throw error;
    }
  }
  async update(uri: string, mutate: (record: TrustRecord) => void): Promise<TrustRecord> {
    const key = projectKeyUri(uri);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(async () => {
      const record = await this.read(uri);
      mutate(record);
      const value = { version: 1, trustedPaths: validateTrustedPaths(record.trustedPaths),
        authorization: record.authorization === undefined ? undefined : validateAuthorization(record.authorization) };
      await fs.mkdir(this.directory, { recursive: true });
      const file = this.file(uri), temporary = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
      await replaceFile(temporary, file);
      return record;
    });
    this.queues.set(key, next.catch(() => undefined));
    return next;
  }
}
