import type { AISnapshot } from './ai.js';

export const API_VERSION = 1;
export interface ConnectionFailure {
  connectionError: { code: 'reconnecting' | 'retry-required'; message: string };
}
export interface LocalProject {
  id: string;
  name: string;
  path: string;
}
export interface ApiFailure {
  code: string;
  message: string;
  retryable: boolean;
  requestId: string;
}
export type ApiResult<T> =
  | { schemaVersion: 1; requestId: string; data: T }
  | { schemaVersion: 1; requestId: string; error: ApiFailure };

export interface SessionRead {
  type: 'session.read';
  requestId: string;
  projectId: string;
  outputId: string | null;
  after: number;
}
export interface SessionEvent {
  schemaVersion: 1;
  type: 'session.snapshot';
  requestId: string;
  eventId: string;
  occurredAt: string;
  projectId: string;
  reset: boolean;
  gap: boolean;
  snapshot: AISnapshot;
}
