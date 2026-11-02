import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SettingPatch } from '../core/types';

export interface IntegrationJournal {
  read(): Promise<SettingPatch[]>;
  write(patches: SettingPatch[]): Promise<void>;
  runExclusive<T>(action: () => Promise<T>): Promise<T>;
}

export class FileSettingsJournal implements IntegrationJournal {
  constructor(private readonly directory: string) {
    if (!path.isAbsolute(directory)) throw new Error(t("设置备份目录必须为绝对路径"));
  }

  async read(): Promise<SettingPatch[]> {
    try {
      const content = await fs.readFile(path.join(this.directory, 'backup.json'), 'utf8');
      if (content.length > 1048576) throw new Error(t("设置恢复记录超过限制"));
      const raw: unknown = JSON.parse(content);
      if (!Array.isArray(raw) || raw.length > 100 || !raw.every(item => item && typeof item === 'object'
        && typeof item.section === 'string' && typeof item.key === 'string' && typeof item.after === 'string'
        && (item.property === undefined || typeof item.property === 'string'))) throw new Error(t("设置恢复记录损坏，拒绝覆盖"));
      return raw as SettingPatch[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async write(patches: SettingPatch[]): Promise<void> {
    const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(patches, null, 2), { flag: 'wx' });
      await fs.rename(temporary, path.join(this.directory, 'backup.json'));
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.directory, { recursive: true });
    const lockPath = path.join(this.directory, 'settings.lock');
    let lock;
    try { lock = await fs.open(lockPath, 'wx'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new Error(t("另一窗口正在更改工具路径设置，请稍后重试。异常退出时先核对锁中 PID 已退出，再手动清理: {0}", lockPath));
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return await action();
    } finally {
      await lock.close();
      await fs.rm(lockPath, { force: true });
    }
  }
}
