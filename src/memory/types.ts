export interface MemorySection {
  name: string; size: number; vma: number; lma: number; alloc: boolean; load: boolean;
  readonly: boolean; code: boolean; reserved: boolean;
}
export interface MemoryRegion {
  name: string; origin: number; capacity?: number; attributes: string; source: 'map' | 'script' | 'unknown';
  used: number; free?: number; extent: number; holes: number; reserved: number;
  spans: { start: number; end: number; section: string; kind: 'runtime' | 'load' }[];
}
export interface MemorySymbol {
  id: string; name: string; address: number; size: number; type: string; section?: string;
  region?: string; object?: string; source?: string; line?: number; alias?: boolean;
}
export interface MemoryReport {
  version: 1; id: string; key: string; createdAt: string; projectUri: string;
  target: string; configuration: string; preset: string; artifact: string; artifactSha256: string;
  map?: string; status: 'complete' | 'partial'; warnings: string[];
  regions: MemoryRegion[]; sections: MemorySection[]; symbols: MemorySymbol[];
  toolVersion: string; durationMs: number;
}
export interface MemoryComparison {
  baselineId: string; regions: { name: string; before: number; after: number; delta: number }[];
  symbols: { name: string; object?: string; before: number; after: number; delta: number; kind: 'added' | 'removed' | 'changed' }[];
}
export interface AnalysisState { phase: 'empty' | 'analyzing' | 'ready' | 'failed' | 'stale'; message?: string; report?: MemoryReport; comparison?: MemoryComparison; pinned?: boolean; }
