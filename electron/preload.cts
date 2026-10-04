import type { DesktopBridge } from '../shared/desktop.js';

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
const desktop: DesktopBridge = {
  selectProjectFolder: () => ipcRenderer.invoke('project:select-folder'),
};
contextBridge.exposeInMainWorld('desktop', Object.freeze(desktop));
