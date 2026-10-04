import type { DesktopBridge } from '../shared/desktop.js';

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
const desktop: DesktopBridge = {
  selectProjectFolder: () => ipcRenderer.invoke('project:select-folder'),
  inspectAI: () => ipcRenderer.invoke('ai:inspect'),
  sendAIPrompt: (projectId: string, prompt: string) =>
    ipcRenderer.invoke('ai:submit', projectId, prompt),
  readAISession: (projectId: string, after: number) =>
    ipcRenderer.invoke('ai:read', projectId, after),
  resizeAISession: (projectId: string, cols: number, rows: number) =>
    ipcRenderer.invoke('ai:resize', projectId, cols, rows),
  stopAISession: (projectId: string) => ipcRenderer.invoke('ai:stop', projectId),
  resetAISession: (projectId: string) => ipcRenderer.invoke('ai:reset', projectId),
};
contextBridge.exposeInMainWorld('desktop', Object.freeze(desktop));
