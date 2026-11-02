import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolInstallation, ToolRelease } from '../core/types';
import { resolveArchiveEntry } from '../core/paths';
import { downloadRelease, snapshotArchive } from './download';
import { extractArchive } from './extract';
import { checkInstallation } from './check';

export interface InstallOptions {
  proxy?: string;
  progress?: (message: string) => void;
  activate?: (tool: ToolInstallation) => Promise<void>;
}

export async function installRelease(release: ToolRelease, destination: string, signal: AbortSignal,
  archivePath?: string, options: InstallOptions = {}): Promise<ToolInstallation> {
  if (!path.isAbsolute(destination)) throw new Error(t("工具目录必须为绝对路径"));
  signal.throwIfAborted();
  const base = path.join(destination, release.id, release.version);
  await fs.mkdir(base, { recursive: true });
  const lockDirectory = path.join(destination, '.locks');
  await fs.mkdir(lockDirectory, { recursive: true });
  const lockPath = path.join(lockDirectory, `${release.id}.lock`);
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(t("此工具被另一安装任务锁定。若程序曾崩溃，请先确认锁文件中 PID 对应进程已退出，再手动移除该锁后重试: {0}", lockPath));
  }
  const installationId = randomUUID();
  const staging = path.join(base, `.staging-${installationId}`);
  const finalDirectory = path.join(base, installationId);
  const archive = path.join(base, `${installationId}.part`);
  const report = options.progress ?? (() => {});
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), installationId }));
    if (archivePath) {
      report(t("复制并校验离线工具包快照"));
      await snapshotArchive(archivePath, archive, release, signal);
    } else {
      report(t("下载工具包"));
      let lastProgress = 0;
      await downloadRelease(release, archive, signal, options.proxy, bytes => {
        const now = Date.now();
        if (now - lastProgress > 500) { report(t("下载 {0}%", Math.floor(bytes / release.archiveBytes * 100))); lastProgress = now; }
      });
    }
    signal.throwIfAborted();
    await fs.mkdir(staging);
    report(t("安全解压"));
    await extractArchive(archive, staging, release, signal);
    const buildTool = (root: string): ToolInstallation => ({
      id: release.id, version: release.version, source: 'managed', root,
      executables: Object.fromEntries(Object.entries(release.executables).map(([key, relative]) => [key, resolveArchiveEntry(root, relative)])),
      scriptsDirectory: release.scriptsDirectory ? resolveArchiveEntry(root, release.scriptsDirectory) : undefined
    });
    report(t("检查可执行文件与配套资源"));
    const checks = await checkInstallation(buildTool(staging), signal);
    const failed = checks.filter(check => check.status === 'error');
    if (failed.length) throw new Error(failed.map(check => `${check.summary}\n${check.evidence.join('\n')}`).join('\n'));
    signal.throwIfAborted();
    await fs.writeFile(path.join(staging, 'stm32-easy-installation.json'), JSON.stringify({ id: release.id, version: release.version, sha256: release.sha256, installationId }, null, 2), { flag: 'wx' });
    await fs.rename(staging, finalDirectory);
    const tool = buildTool(finalDirectory);
    await options.activate?.(tool);
    report(t("安装完成"));
    return tool;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(archive, { force: true });
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
}
