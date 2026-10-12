export type AIState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'exited'
  | 'interrupted'
  | 'error';

export interface AIAvailability {
  cleanupUnconfirmed?: boolean;
  status: 'ready' | 'missing' | 'login-required' | 'unsupported' | 'error';
  message: string;
  version?: string;
}

export interface AIReply {
  ok: boolean;
  message?: string;
  runId?: string;
  outputId?: string;
}

export interface TerminalChunk {
  sequence: number;
  data: string;
  cols: number;
  rows: number;
}

export interface AISnapshot {
  purpose: 'chat' | 'requirements';
  requirementsGoal: string | null;
  requirementsGoalConfirmed: boolean;
  outputId: string | null;
  id: string | null;
  state: AIState;
  message: string;
  chunks: TerminalChunk[];
  firstSequence: number;
  nextSequence: number;
  retainedBytes: number;
  truncated: boolean;
  cleanupConfirmed: boolean;
  conversationReady: boolean;
  exitCode: number | null;
}

export const activeAIStates: AIState[] = ['starting', 'running', 'stopping'];

export const emptyAISnapshot: AISnapshot = {
  purpose: 'chat',
  requirementsGoal: null,
  requirementsGoalConfirmed: false,
  outputId: null,
  id: null,
  state: 'idle',
  message: '메시지를 보내 Codex와 대화를 시작하세요.',
  chunks: [],
  firstSequence: 0,
  nextSequence: 0,
  retainedBytes: 0,
  truncated: false,
  cleanupConfirmed: true,
  conversationReady: false,
  exitCode: null,
};
