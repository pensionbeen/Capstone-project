import type { AIAvailability, AIReply, AISnapshot } from './ai.js';
import type { ProjectFeaturePlan } from './feature-plan.js';
import type { ConnectionFailure } from './local-api.js';
import type { RequirementsAction } from './requirements.js';
import type {
  FeaturePlanResult,
  ProjectBackup,
  ProjectCatalog,
  ProjectResult,
  StorageResult,
} from './storage.js';
import type { FileListResult, OpenFileResult } from './workspace-files.js';

export type FolderResult =
  | { status: 'selected'; name: string; path: string; projectId?: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export interface DesktopBridge {
  selectProjectFolder: () => Promise<FolderResult>;
  inspectAI: () => Promise<AIAvailability>;
  readAIStatus: (projectId: string) => Promise<AISnapshot>;
  listProjects: () => Promise<ProjectCatalog>;
  activateProject: (id: string) => Promise<ProjectResult>;
  saveProjectName: (id: string, name: string) => Promise<ProjectResult>;
  loadFeaturePlan: (id: string) => Promise<FeaturePlanResult>;
  saveFeaturePlan: (id: string, plan: ProjectFeaturePlan) => Promise<FeaturePlanResult>;
  listProjectFiles: (id: string, path: string) => Promise<FileListResult>;
  openProjectFile: (id: string, path: string) => Promise<OpenFileResult>;
  listProjectBackups: () => Promise<{ backups: ProjectBackup[]; directory: string }>;
  backupProjects: () => Promise<StorageResult>;
  restoreProjects: (id: string) => Promise<StorageResult>;
  sendAIPrompt: (
    projectId: string,
    prompt: string,
    expectedOutputId: string | null,
    expectedRunId: string | null,
  ) => Promise<AIReply>;
  sendRequirementsPrompt: (
    projectId: string,
    action: RequirementsAction,
    input: string,
    expectedOutputId: string | null,
    expectedRunId: string | null,
  ) => Promise<AIReply>;
  readAISession: (
    projectId: string,
    after: number,
    outputId: string | null,
  ) => Promise<AISnapshot | ConnectionFailure>;
  reconnectAI: () => Promise<AIReply>;
  resizeAISession: (projectId: string, cols: number, rows: number) => Promise<AIReply>;
  stopAISession: (projectId: string, expectedRunId: string | null) => Promise<AIReply>;
  resetAISession: (
    projectId: string,
    expectedOutputId: string | null,
    expectedRunId: string | null,
  ) => Promise<AIReply>;
}
