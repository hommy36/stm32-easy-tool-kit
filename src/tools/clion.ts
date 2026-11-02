import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

function attributes(tag: string): Map<string, string> {
  return new Map([...tag.matchAll(/\b(name|value)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map(match => [match[1], match[2] ?? match[3]]));
}

function decodeAttribute(value: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  return value.replace(/&([^;]+);/g, (_entity: string, name: string) => {
    if (Object.hasOwn(named, name)) return named[name];
    const code = /^#x[\da-f]+$/i.test(name) ? Number.parseInt(name.slice(2), 16)
      : /^#\d+$/.test(name) ? Number.parseInt(name.slice(1), 10) : Number.NaN;
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      throw new Error(t("CLion 路径中有不支持的 XML 实体"));
    }
    return String.fromCodePoint(code);
  });
}

export function parseClionOpenOcdPath(xml: string): string | undefined {
  if (xml.length > 262144 || /<!DOCTYPE|<!ENTITY/i.test(xml)) return undefined;
  const content = xml.replace(/<!--[\s\S]*?-->/g, '');
  for (const component of content.matchAll(/<component\b(?![^>]*\/\s*>)([^>]*)>([\s\S]*?)<\/component\s*>/g)) {
    if (attributes(component[1]).get('name') !== 'EmbeddedDevelopment') continue;
    for (const option of component[2].matchAll(/<option\b[^>]*>/g)) {
      const fields = attributes(option[0]);
      if (fields.get('name') !== 'openOcdLocation') continue;
      const executable = decodeAttribute(fields.get('value') ?? '').trim();
      if (/[\x00-\x1f]/.test(executable) || !path.win32.isAbsolute(executable)
        || path.win32.parse(executable).root.length <= 1
        || path.win32.basename(executable).toLowerCase() !== 'openocd.exe') return undefined;
      return path.win32.normalize(executable);
    }
  }
  return undefined;
}

export async function findClionOpenOcdDirectories(
  directory = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'JetBrains'),
  warn: (message: string) => void = () => {}
): Promise<string[]> {
  let versions;
  try { versions = await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) warn(t("无法读取 CLion 配置目录 {0}: {1}", directory, String(error)));
    return [];
  }
  const candidates: string[] = [];
  for (const version of versions.filter(entry => entry.isDirectory() && /^CLion[\w.-]*$/.test(entry.name))
    .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))) {
    for (const relative of ['options/windows/embedded-support.xml', 'options/embedded-support.xml']) {
      const file = path.join(directory, version.name, relative);
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > 262144) { warn(t("跳过过大或非普通文件的 CLion 配置: {0}", file)); continue; }
        const executable = parseClionOpenOcdPath(await fs.readFile(file, 'utf8'));
        if (executable && (await fs.stat(executable)).isFile()) candidates.push(path.dirname(executable));
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) warn(t("跳过无法读取的 CLion OpenOCD 路径配置 {0}: {1}", file, String(error)));
      }
    }
  }
  return candidates;
}
