import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ToolId, ToolInstallation } from '../core/types';
import { executableNames, exists, findCandidates } from './detect';

export interface ExistingToolCandidate {
  root: string;
  source: 'managed' | 'external';
  version?: string;
  installationRoot?: string;
  current: boolean;
}

/** Read only: a discovery record never substitutes for checks before activation. */
export async function existingToolCandidates(id: ToolId, directories: string[], active?: ToolInstallation,
  warn: (message: string) => void = () => {}, external: () => Promise<string[]> = () => findCandidates(id, warn)): Promise<ExistingToolCandidate[]> {
  const result: ExistingToolCandidate[] = [], seen = new Set<string>();
  const name = Object.values(executableNames[id])[0];
  const key = async (file: string) => (await fs.realpath(file)).toLowerCase();
  const currentKey = active?.executables[Object.keys(executableNames[id])[0]];
  const activeKey = currentKey ? await key(currentKey).catch(() => undefined) : undefined;
  const add = async (candidate: Omit<ExistingToolCandidate, 'current'>) => {
    try {
      const executable = path.join(candidate.root, name);
      if (!await exists(executable)) return;
      const identity = await key(executable);
      if (seen.has(identity)) return;
      seen.add(identity);
      result.push({ ...candidate, current: identity === activeKey });
    } catch (error) { warn(String(error)); }
  };
  const children = async (directory: string): Promise<string[]> => {
    try {
      return (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => path.join(directory, entry.name)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(String(error));
      return [];
    }
  };
  // Installer layout: <tools>/<id>/<version>/<installation UUID>/<package>/bin.
  for (const directory of [...new Set(directories.filter(path.isAbsolute).map(file => path.resolve(file)))]) {
    for (const version of await children(path.join(directory, id))) {
      for (const installation of await children(version)) {
        try {
          const marker = path.join(installation, 'stm32-easy-installation.json');
          if ((await fs.stat(marker)).size > 16384) continue;
          const metadata = JSON.parse(await fs.readFile(marker, 'utf8'));
          if (!metadata || metadata.id !== id || metadata.version !== path.basename(version)
            || metadata.installationId !== path.basename(installation) || !/^[a-f0-9]{64}$/.test(metadata.sha256)) continue;
          const packages = [installation, ...await children(installation)];
          for (const folder of packages) for (const bin of [folder, path.join(folder, 'bin')]) {
            if (!(await Promise.all(Object.values(executableNames[id]).map(file => exists(path.join(bin, file))))).every(Boolean)) continue;
            await add({ root: bin, source: 'managed', version: metadata.version, installationRoot: installation });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(String(error));
        }
      }
    }
  }
  if (active && currentKey) await add({ root: path.dirname(currentKey), source: active.source,
    version: active.version, installationRoot: active.source === 'managed' ? active.root : undefined });
  for (const root of await external()) await add({ root, source: 'external' });
  return result.sort((a, b) => Number(b.current) - Number(a.current) || Number(b.source === 'managed') - Number(a.source === 'managed'));
}
