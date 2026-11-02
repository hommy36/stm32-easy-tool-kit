import { t } from '../i18n';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ToolId, ToolRelease, toolIds } from '../core/types';
import { resolveArchiveEntry } from '../core/paths';

export function loadCatalog(file = path.resolve(__dirname, '../../resources/tool-catalog.json')): ToolRelease[] {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw) || raw.length !== 4) throw new Error(t("工具清单必须包含四组工具"));
  const releases: ToolRelease[] = [];
  for (const value of raw as unknown[]) {
    if (!value || typeof value !== 'object') throw new Error(t("工具清单格式无效"));
    const item = value as Record<string, unknown>;
    if (!toolIds.includes(item.id as ToolId) || typeof item.version !== 'string' || !/^[\w.+-]+$/.test(item.version)
      || item.platform !== 'win32-x64' || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
      || typeof item.url !== 'string' || typeof item.licenseUrl !== 'string') throw new Error(t("工具清单字段无效"));
    for (const key of ['archiveBytes', 'maxExtractedBytes', 'maxEntries', 'maxFileBytes']) {
      if (!Number.isSafeInteger(item[key]) || Number(item[key]) <= 0) throw new Error(t("工具清单限制无效: {0}", key));
    }
    const url = new URL(item.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error(t("工具来源必须为标准 HTTPS"));
    if (!Array.isArray(item.allowedDownloadHosts) || !item.allowedDownloadHosts.every(host => typeof host === 'string' && /^[a-z0-9.-]+$/.test(host))
      || !item.allowedDownloadHosts.includes(url.hostname)) throw new Error(t("工具下载域名未列入允许清单"));
    if (new URL(item.licenseUrl).protocol !== 'https:') throw new Error(t("工具许可链接必须为 HTTPS"));
    if (!item.executables || typeof item.executables !== 'object' || Array.isArray(item.executables)
      || Object.keys(item.executables).length === 0) throw new Error(t("工具程序列表为空"));
    for (const file of Object.values(item.executables)) {
      if (typeof file !== 'string' || !file.endsWith('.exe')) throw new Error(t("程序路径无效"));
      resolveArchiveEntry(process.cwd(), file);
    }
    if (item.scriptsDirectory !== undefined) {
      if (typeof item.scriptsDirectory !== 'string') throw new Error(t("脚本路径无效"));
      resolveArchiveEntry(process.cwd(), item.scriptsDirectory);
    }
    if (releases.some(release => release.id === item.id)) throw new Error(t("重复工具 ID"));
    releases.push(item as unknown as ToolRelease);
  }
  return releases;
}
