import type { AIAvailability, AIReply, AISnapshot } from './ai.js';

export type FolderResult =
  | { status: 'selected'; name: string; path: string; projectId?: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export interface DesktopBridge {
  selectProjectFolder: () => Promise<FolderResult>;
  inspectAI: () => Promise<AIAvailability>;
  sendAIPrompt: (projectId: string, prompt: string) => Promise<AIReply>;
  readAISession: (projectId: string, after: number) => Promise<AISnapshot>;
  resizeAISession: (projectId: string, cols: number, rows: number) => Promise<AIReply>;
  stopAISession: (projectId: string) => Promise<AIReply>;
  resetAISession: (projectId: string) => Promise<AIReply>;
}
