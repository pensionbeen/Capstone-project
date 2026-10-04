import type { DesktopBridge } from '../shared/desktop.js';

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
const desktop: DesktopBridge = {
  selectProjectFolder: () => ipcRenderer.invoke('project:select-folder'),
  inspectAI: () => ipcRenderer.invoke('ai:inspect'),
  readAIStatus: (projectId) => ipcRenderer.invoke('ai:status', projectId),
  reconnectAI: () => ipcRenderer.invoke('ai:reconnect'),
  listProjects: () => ipcRenderer.invoke('project:list'),
  activateProject: (id) => ipcRenderer.invoke('project:activate', id),
  saveProjectName: (id, name) => ipcRenderer.invoke('project:save-name', id, name),
  loadFeaturePlan: (id) => ipcRenderer.invoke('features:load', id),
  saveFeaturePlan: (id, plan) => ipcRenderer.invoke('features:save', id, plan),
  listProjectBackups: () => ipcRenderer.invoke('storage:list-backups'),
  backupProjects: () => ipcRenderer.invoke('storage:backup'),
  restoreProjects: (id) => ipcRenderer.invoke('storage:restore', id),
  sendAIPrompt: (projectId, prompt, expectedOutputId, expectedRunId) =>
    ipcRenderer.invoke('ai:submit', projectId, prompt, expectedOutputId, expectedRunId),
  readAISession: (projectId, after, outputId) =>
    ipcRenderer.invoke('ai:read', projectId, after, outputId),
  resizeAISession: (projectId: string, cols: number, rows: number) =>
    ipcRenderer.invoke('ai:resize', projectId, cols, rows),
  stopAISession: (projectId, expectedRunId) =>
    ipcRenderer.invoke('ai:stop', projectId, expectedRunId),
  resetAISession: (projectId, expectedOutputId, expectedRunId) =>
    ipcRenderer.invoke('ai:reset', projectId, expectedOutputId, expectedRunId),
};
contextBridge.exposeInMainWorld('desktop', Object.freeze(desktop));
