export interface EnhancementSummary { elapsedMs?: number; errors?: number; warnings?: number; memory?: { name: string; used: number; capacity?: number }[]; analysis?: string; }
const summaries = new Map<string, EnhancementSummary>();
export function enhancementSummary(uri?: string): EnhancementSummary | undefined { return uri ? summaries.get(uri) : undefined; }
export function setEnhancementSummary(uri: string, patch: Partial<EnhancementSummary>): void { summaries.set(uri,{ ...summaries.get(uri),...patch }); }
