import type { Event } from 'vscode';
import { ToolInstallation } from '../core/types';
import { BuildEvidence } from '../build/artifacts';
import { BuildModel, FirmwareTarget } from '../build/fileApi';
import { PresetChoice, PresetMetadata, ResolvedSelection } from '../build/presets';
import { PresetAccess } from '../build/presetGraph';
import { ProjectSettings, SavedProject } from '../project/types';

export type WorkflowAction = 'configure' | 'build' | 'flash' | 'debug';
export type Phase = 'idle' | 'saving' | 'configuring' | 'building' | 'confirming'
  | 'flashing' | 'debug-starting' | 'debugging' | 'failed' | 'cancelled' | 'uncertain';
export interface WorkflowSnapshot {
  operationId?: string; projectUri?: string; phase: Phase;
  message: string; revision: number; evidence?: BuildEvidence;
  lastFlash?: { projectUri: string; artifact: string; at: string };
}
export interface ProjectEntry { uri: string; directory: string; label: string; }
export interface WorkflowHost {
  guard(): void;
  projects(): readonly ProjectEntry[];
  saveDocuments(sourceDirectory: string): Promise<void>;
  assertDocumentsCurrent(evidence: Pick<BuildEvidence, 'inputScope' | 'inputFiles'>): Promise<void>;
  chooseProject(projects: readonly ProjectEntry[]): Promise<string | undefined>;
  chooseConfigure(choices: PresetChoice[]): Promise<string | undefined>;
  chooseBuild(choices: PresetChoice[]): Promise<string | undefined>;
  chooseTarget(targets: FirmwareTarget[]): Promise<FirmwareTarget | undefined>;
  chooseArtifact(files: string[]): Promise<string | undefined>;
  confirmExternal(file: string, kind: string, projectUri?: string): Promise<boolean>;
  confirmHardware(action: 'flash' | 'debug', settings: ProjectSettings, evidence: BuildEvidence): Promise<boolean>;
  rememberExternalRoots?(projectUri: string, roots: string[]): Promise<void>;
  rememberProject(uri: string): Promise<void>;
  log(stream: 'stdout' | 'stderr', text: string, diagnosticDirectory?: string): void;
}
export interface BuildBackend {
  presets(sourceDirectory: string, signal: AbortSignal, access?: PresetAccess): Promise<PresetMetadata>;
  configure(selection: ResolvedSelection, signal: AbortSignal): Promise<BuildModel>;
  build(selection: ResolvedSelection, target: FirmwareTarget, signal: AbortSignal): Promise<BuildModel>;
  inputs(selection: ResolvedSelection, target: FirmwareTarget, signal: AbortSignal, allowMissing: boolean,
    approve: (file: string) => Promise<boolean>): Promise<import('../build/dependencies').DependencyInputs>;
}
export interface OwnedDebugSession { finished: Promise<void>; stop(): Promise<void>; }
export interface HardwareWorkflow {
  flash(evidence: BuildEvidence, settings: ProjectSettings, tools: ToolInstallation[], signal: AbortSignal): Promise<void>;
  debug(evidence: BuildEvidence, settings: ProjectSettings, tools: ToolInstallation[], operationId: string, signal: AbortSignal): Promise<OwnedDebugSession>;
}
export interface WorkbenchView {
  project?: SavedProject;
  metadata?: PresetMetadata;
  model?: BuildModel;
  snapshot: WorkflowSnapshot;
}
export interface WorkflowEvents { onDidChange: Event<WorkflowSnapshot>; }
