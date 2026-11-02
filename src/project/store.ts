import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { replaceFile } from '../core/atomicFile';
import { createHash, randomUUID } from 'node:crypto';
import { ProjectSettings, SavedProject, defaultProjectSettings, projectKeyUri, validateProjectSettings } from './types';
import { digest, parseShared, portableConfiguration, sharedPath, legacySharedPath, sharedDirectory, readSharedFile, sharedText, writeShared, writeSharedFile } from './shared';

interface LocalRecord extends SavedProject { sharedFingerprint?: string; }

export class ProjectStore {
  constructor(private readonly directory: string, private readonly openocdScripts: () => Promise<string | undefined> = async () => undefined) {
    if (!path.isAbsolute(directory)) throw new Error(t("工程设置存储目录必须为绝对路径"));
  }
  private file(uri: string): string {
    return path.join(this.directory, `${createHash('sha256').update(projectKeyUri(uri)).digest('hex')}.json`);
  }
  private async readLocal(projectUri: string): Promise<LocalRecord | undefined> {
    const file = this.file(projectUri);
    try {
      if ((await fs.stat(file)).size > 1048576) throw new Error(t("工程设置超过大小限制"));
      const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(t("工程设置记录损坏"));
      const record = raw as Record<string, unknown>;
      if (Object.keys(record).some(key => !['revision','settings','sharedFingerprint'].includes(key))
        || record.sharedFingerprint !== undefined && (typeof record.sharedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.sharedFingerprint))
        || typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 1) {
        throw new Error(t("工程设置版本无效"));
      }
      const settings = validateProjectSettings(record.settings);
      if (projectKeyUri(settings.projectUri) !== projectKeyUri(projectUri)) throw new Error(t("工程设置身份不匹配"));
      return { revision: record.revision, settings, sharedFingerprint: record.sharedFingerprint as string | undefined };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async read(projectUri: string): Promise<SavedProject | undefined> {
    const local = await this.readLocal(projectUri);
    if (local?.settings.shareInProject === false) return { revision: local.revision, settings: local.settings };
    const text = await sharedText(projectUri);
    if (text === undefined && !local?.settings.shareInProject) return local ? { revision: local.revision, settings: local.settings } : undefined;
    const shared = text === undefined ? undefined : parseShared(text, projectUri);
    const unchanged = text !== undefined && local?.sharedFingerprint === digest(text);
    const settings = shared ? { ...local?.settings, ...shared,
      serial: local?.settings.serial,
      chipConfirmed: unchanged ? local!.settings.chipConfirmed : false,
      targetId: unchanged ? local!.settings.targetId : undefined,
      artifactPath: unchanged ? local!.settings.artifactPath : undefined
    } : local!.settings;
    // Include file contents, not just an embedded counter: manual edits and Git checkouts invalidate stale drafts too.
    const revision = parseInt(digest(JSON.stringify([local?.revision ?? 0, local?.settings, text ?? '<missing>'])).slice(0,12),16);
    return { revision, settings: validateProjectSettings(settings) };
  }
  async save(value: ProjectSettings, expectedRevision: number): Promise<SavedProject> {
    return this.commit(value, expectedRevision);
  }
  async remove(projectUri: string, sourceDirectory: string, expectedRevision: number): Promise<SavedProject> {
    // Keep a revision-only reset record so an old page cannot recreate deleted settings.
    return this.commit({ ...defaultProjectSettings(projectUri, sourceDirectory), shareInProject: false }, expectedRevision, true);
  }
  private async commit(value: ProjectSettings, expectedRevision: number, removing = false): Promise<SavedProject> {
    let settings = validateProjectSettings(value);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error(t("工程设置版本无效"));
    await fs.mkdir(this.directory, { recursive: true });
    const file = this.file(settings.projectUri);
    const lockFile = `${file}.lock`;
    let lock;
    try { lock = await fs.open(lockFile, 'wx'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new Error(t("另一窗口正在保存此工程；若异常退出，请先确认锁中 PID 已结束: {0}", lockFile));
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    let sharedLock: fs.FileHandle | undefined, sharedBefore: string | undefined, sharedAfter: string | undefined;
    let canonicalBefore: string | undefined, wroteShared = false;
    const removed = new Map<string, string>();
    let created: string | undefined, committed = false;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, instanceId: randomUUID(), createdAt: new Date().toISOString() }));
      const previous = await this.read(settings.projectUri);
      if ((previous?.revision ?? 0) !== expectedRevision) throw new Error(t("工程设置已被另一窗口更新，请重新加载后保存"));
      if (settings.shareInProject === undefined && previous?.settings.shareInProject !== undefined) settings = { ...settings, shareInProject: previous.settings.shareInProject };
      const local = await this.readLocal(settings.projectUri);
      if ((local?.revision ?? 0) >= Number.MAX_SAFE_INTEGER) throw new Error(t("工程设置版本达到上限"));
      if (settings.shareInProject || removing) {
        await sharedDirectory(settings.projectUri);
        try { sharedLock = await fs.open(`${sharedPath(settings.projectUri)}.lock`, 'wx'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; throw new Error(t('另一窗口正在保存工程共享配置，请稍后重新加载'));
        }
        await sharedLock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        sharedBefore = await sharedText(settings.projectUri);
        canonicalBefore = await readSharedFile(sharedPath(settings.projectUri));
        if (((await this.read(settings.projectUri))?.revision ?? 0) !== expectedRevision) throw new Error(t('工程设置已被另一窗口更新，请重新加载后保存'));
        if (removing) {
          for (const target of [sharedPath(settings.projectUri), legacySharedPath(settings.projectUri)]) {
            const text = await readSharedFile(target);
            if (text !== undefined) { await fs.rm(target); removed.set(target, text); }
          }
        } else {
          const portable = await portableConfiguration(settings, await this.openocdScripts());
          settings = portable.settings; created = portable.created;
          if (await sharedText(settings.projectUri) !== sharedBefore) throw new Error(t('工程设置已被另一窗口更新，请重新加载后保存'));
          if (portable.text !== canonicalBefore) { await writeShared(settings.projectUri, portable.text); sharedAfter = portable.text; wroteShared = true; }
          else sharedAfter = sharedBefore;
        }
      }
      const saved: LocalRecord = { revision: (local?.revision ?? 0) + 1, settings,
        ...(settings.shareInProject && sharedAfter !== undefined ? { sharedFingerprint: digest(sharedAfter) } : {}) };
      await fs.writeFile(temporary, JSON.stringify(saved, null, 2), { flag: 'wx' });
      await replaceFile(temporary, file);
      committed = true;
      // Return the committed version. A later external edit must not turn a successful commit into a failed transaction.
      if (settings.shareInProject && sharedAfter !== undefined) {
        return { revision: parseInt(digest(JSON.stringify([saved.revision, saved.settings, sharedAfter])).slice(0,12),16),
          settings: { ...settings, ...parseShared(sharedAfter, settings.projectUri), serial: settings.serial,
            chipConfirmed: settings.chipConfirmed, targetId: settings.targetId, artifactPath: settings.artifactPath } };
      }
      return { revision: saved.revision, settings };
    } catch (error) {
      if (!committed && wroteShared && await readSharedFile(sharedPath(settings.projectUri)) === sharedAfter) {
        if (canonicalBefore === undefined) await fs.rm(sharedPath(settings.projectUri)); else await writeShared(settings.projectUri, canonicalBefore);
      }
      if (!committed) for (const [target, text] of removed) {
        if (await readSharedFile(target) === undefined) await writeSharedFile(target, text);
      }
      if (!committed && created) await fs.rm(created, { force: true });
      throw error;
    } finally {
      await fs.rm(temporary, { force: true });
      await lock.close();
      await fs.rm(lockFile, { force: true });
      if (sharedLock) { await sharedLock.close(); await fs.rm(`${sharedPath(settings.projectUri)}.lock`, { force: true }); }
    }
  }
}
