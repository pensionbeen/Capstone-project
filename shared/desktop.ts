import type { AIAvailability, AIReply, AISnapshot } from './ai.js';
import type { ConnectionFailure, LocalProject } from './local-api.js';

export type FolderResult =
  | { status: 'selected'; name: string; path: string; projectId?: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export interface DesktopBridge {
  selectProjectFolder: () => Promise<FolderResult>;
  inspectAI: () => Promise<AIAvailability>;
  readAIStatus: (projectId: string) => Promise<AISnapshot>;
  listProjects: () => Promise<{ projects: LocalProject[]; storage: 'memory' }>;
  sendAIPrompt: (
    projectId: string,
    prompt: string,
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
