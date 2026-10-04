import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session } from 'electron';
import type { FolderResult } from '../shared/desktop.js';
import { APP_URL, DEV_URL, inspectDirectory, isTrustedPage, staticAssetPath } from './policy.js';

const currentDirectory = fileURLToPath(new URL('.', import.meta.url));
const development = !app.isPackaged && process.argv.includes('--dev');
const trustedUrl = development ? DEV_URL : APP_URL;
let mainWindow: BrowserWindow | null = null;
let selecting = false;

app.setName('ORBIT');
protocol.registerSchemesAsPrivileged([
  { scheme: 'orbit', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: '#ffffff',
    title: 'ORBIT — 프로젝트 워크스페이스',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(currentDirectory, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  mainWindow = window;
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  void window.loadURL(trustedUrl);
}

void app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle('orbit', (request) => {
    const asset = staticAssetPath(request.url);
    if (request.method !== 'GET' || !asset) return new Response('Not found', { status: 404 });
    const rendererRoot = resolve(currentDirectory, '../../renderer');
    return net.fetch(pathToFileURL(join(rendererRoot, asset)).href);
  });

  ipcMain.handle(
    'project:select-folder',
    async (event, ...args: unknown[]): Promise<FolderResult> => {
      const window = mainWindow;
      if (
        !window ||
        window.isDestroyed() ||
        args.length !== 0 ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        !isTrustedPage(event.senderFrame.url, trustedUrl)
      ) {
        return { status: 'error', message: '이 화면에서는 폴더 선택을 요청할 수 없어요.' };
      }
      if (selecting)
        return { status: 'error', message: '이미 열린 폴더 선택 창을 먼저 닫아 주세요.' };
      selecting = true;
      try {
        const result = await dialog.showOpenDialog(window, {
          title: '프로젝트 폴더 선택',
          buttonLabel: '이 폴더 선택',
          properties: ['openDirectory', 'dontAddToRecent'],
        });
        if (result.canceled) return { status: 'cancelled' };
        return await inspectDirectory(result.filePaths[0]);
      } catch {
        return {
          status: 'error',
          message: '폴더 선택 창을 열지 못했어요. 잠시 후 다시 시도해 주세요.',
        };
      } finally {
        selecting = false;
      }
    },
  );

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
