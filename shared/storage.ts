import type { LocalProject } from './local-api.js';

export interface SavedProject extends LocalProject {
  createdAt: number;
  updatedAt: number;
}
export interface ProjectCatalog {
  projects: LocalProject[];
  activeProjectId: string | null;
  storage: 'memory' | 'sqlite' | 'unavailable';
  message?: string;
}
export interface ProjectBackup {
  id: string;
  createdAt: number;
}
export type ProjectResult = { ok: true; project: LocalProject } | { ok: false; message: string };
export type StorageResult =
  | { ok: true; message: string; catalog?: ProjectCatalog }
  | { ok: false; message: string };
