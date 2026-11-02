import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BuildEvidence, isWithin } from '../build/artifacts';

interface Document { uri: { scheme: string; fsPath: string }; isDirty: boolean; }
export class DocumentTracker {
  private generation = 0;
  private baseline = 0;
  private overflow = 0;
  private readonly changes = new Map<string, number>();
  constructor(private readonly documents: () => readonly Document[]) { }
  changed(document: Document): void {
    if (document.uri.scheme !== 'file') return;
    this.generation++;
    if (this.changes.size >= 20000) { this.changes.clear(); this.overflow = this.generation; }
    this.changes.set(path.resolve(document.uri.fsPath), this.generation);
  }
  capture(sourceDirectory: string): void {
    if (this.documents().some(document => document.uri.scheme === 'file' && document.isDirty && isWithin(sourceDirectory, document.uri.fsPath))) throw new Error(t("工程文档在保存期间又有未保存修改，请保存后重新构建"));
    this.baseline = this.generation;
  }
  async assertCurrent(evidence: Pick<BuildEvidence, 'inputScope' | 'inputFiles'>): Promise<void> {
    if (this.overflow > this.baseline) throw new Error(t("编辑器变更记录已过期，请重新构建"));
    const generation = this.generation;
    const canonical = async (file: string) => {
      try { return await fs.realpath(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(file); throw error; }
    };
    const roots = await Promise.all([evidence.inputScope.sourceDirectory, ...(evidence.inputScope.includeDirectories ?? [])].map(canonical));
    const files = new Set((await Promise.all(evidence.inputFiles.map(canonical))).map(file => file.toLowerCase()));
    const relevant = async (file: string) => {
      const real = await canonical(file);
      return files.has(real.toLowerCase()) || roots.some(root => isWithin(root, real) || isWithin(root, file));
    };
    for (const document of this.documents()) {
      if (document.uri.scheme === 'file' && document.isDirty && await relevant(document.uri.fsPath)) throw new Error(t("相关源码/头文件存在未保存编辑，请保存后重新构建；未执行下载"));
    }
    for (const [file, changed] of this.changes) {
      if (changed > this.baseline && await relevant(file)) throw new Error(t("相关文档在本次构建开始后发生编辑，请重新构建"));
    }
    if (generation !== this.generation) throw new Error(t("编辑器在有效性检查期间发生变化，请重新构建"));
  }
}
