export type ToolId = 'armGnu' | 'cmake' | 'ninja' | 'openocd';
export type DapBackend = 'auto' | 'hid' | 'usb_bulk';
export type CheckStatus = 'ok' | 'warning' | 'error' | 'unverified';
export const toolIds: ToolId[] = ['armGnu', 'cmake', 'ninja', 'openocd'];
export const toolNames: Record<ToolId, string> = {
  armGnu: 'Arm GNU Toolchain', cmake: 'CMake', ninja: 'Ninja', openocd: 'OpenOCD'
};

export interface ToolInstallation {
  id: ToolId;
  version: string;
  root: string;
  source: 'managed' | 'external';
  executables: Record<string, string>;
  scriptsDirectory?: string;
}

export interface ToolRelease {
  id: ToolId;
  version: string;
  platform: 'win32-x64';
  url: string;
  allowedDownloadHosts: string[];
  sha256: string;
  archiveBytes: number;
  maxExtractedBytes: number;
  maxEntries: number;
  maxFileBytes: number;
  executables: Record<string, string>;
  scriptsDirectory?: string;
  licenseUrl: string;
}

export interface CheckResult {
  code: string;
  status: CheckStatus;
  summary: string;
  evidence: string[];
  nextAction?: string;
}

export interface RunRequest {
  executable: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

export interface SettingPatch {
  section: string;
  key: string;
  property?: string;
  before: unknown;
  after: unknown;
  parentBefore?: unknown;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
