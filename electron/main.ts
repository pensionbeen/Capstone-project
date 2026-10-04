import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  net,
  protocol,
  session,
} from 'electron';
import { emptyAISnapshot } from '../shared/ai.js';
import type { FolderResult } from '../shared/desktop.js';
import { promptIsValid, rejected, sizeIsValid, UUID } from './ai/contracts.js';
import { SessionManager } from './ai/session-manager.js';
import { LocalApiClient } from './local-api/client.js';
import { startLocalApi } from './local-api/server.js';
import { APP_URL, DEV_URL, inspectDirectory, isTrustedPage, staticAssetPath } from './policy.js';

const currentDirectory = fileURLToPath(new URL('.', import.meta.url));
const development = !app.isPackaged && process.argv.includes('--dev');
const trustedUrl = development ? DEV_URL : APP_URL;
let mainWindow: BrowserWindow | null = null;
let selecting = false;
let allowExit = false;
let closing: Promise<void> | undefined;
export const aiSession = new SessionManager();
let localApi: Awaited<ReturnType<typeof startLocalApi>> | undefined;
let apiClient: LocalApiClient | undefined;

function trusted(event: IpcMainInvokeEvent) {
  return (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    isTrustedPage(event.senderFrame.url, trustedUrl)
  );
}
function projectArgument(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

async function closeApplication() {
  if (closing) return closing;
  closing = (async () => {
    localApi?.beginClose();
    const cleaned = await aiSession.shutdown();
    if (!cleaned && mainWindow && !mainWindow.isDestroyed()) {
      const answer = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'AI 실행 정리 확인 필요',
        message: 'AI 실행의 자식 프로세스 정리를 확인하지 못했어요.',
        detail:
          '다른 프로그램을 임의로 종료하지 않았어요. 창을 유지하고 실행 상태를 확인하거나 앱을 종료할 수 있어요.',
        buttons: ['창 유지', '앱 종료'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response === 0) return;
    }
    apiClient?.close();
    await localApi?.close();
    allowExit = true;
    app.quit();
  })().finally(() => {
    closing = undefined;
  });
  return closing;
}

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
  window.on('close', (event) => {
    if (!allowExit) {
      event.preventDefault();
      void closeApplication();
    }
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  void window.loadURL(trustedUrl);
}

void app.whenReady().then(async () => {
  try {
    localApi = await startLocalApi(
      aiSession,
      development ? 'http://127.0.0.1:5173' : 'orbit://app',
    );
    apiClient = new LocalApiClient(localApi.endpoint);
  } catch {
    dialog.showErrorBox(
      '앱 연결 시작 실패',
      '앱 내부 연결을 시작하지 못했어요. ORBIT을 다시 실행해 주세요.',
    );
    allowExit = true;
    app.quit();
    return;
  }
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
      if (aiSession.busy)
        return {
          status: 'error',
          message: 'AI 실행을 중단하고 정리가 끝난 뒤 프로젝트를 변경해 주세요.',
        };
      selecting = true;
      try {
        const result = await dialog.showOpenDialog(window, {
          title: '프로젝트 폴더 선택',
          buttonLabel: '이 폴더 선택',
          properties: ['openDirectory', 'dontAddToRecent'],
        });
        if (result.canceled) return { status: 'cancelled' };
        const selected = await inspectDirectory(result.filePaths[0]);
        if (selected.status !== 'selected') return selected;
        const projectId = aiSession.registerProject(selected.path);
        if (!projectId || !apiClient)
          return { status: 'error', message: 'AI 실행을 정리한 뒤 폴더를 다시 선택해 주세요.' };
        const project = await apiClient.project(projectId);
        return {
          status: 'selected',
          projectId: project.id,
          name: project.name,
          path: project.path,
        };
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

  ipcMain.handle('project:list', (event, ...args: unknown[]) => {
    if (!trusted(event) || args.length !== 0 || !apiClient)
      throw new Error('프로젝트를 조회할 수 없어요.');
    return apiClient.listProjects();
  });
  ipcMain.handle('ai:status', (event, ...args: unknown[]) => {
    const [id] = args;
    if (!trusted(event) || args.length !== 1 || !projectArgument(id) || !apiClient)
      throw new Error('대화 상태를 조회할 수 없어요.');
    return apiClient.status(id);
  });

  ipcMain.handle('ai:inspect', (event, ...args: unknown[]) =>
    trusted(event) && args.length === 0
      ? apiClient
          ?.availability()
          .catch(() => ({ status: 'error', message: '앱 내부 연결을 확인해 주세요.' }))
      : { status: 'error', message: '이 화면에서는 AI 상태를 확인할 수 없어요.' },
  );
  ipcMain.handle('ai:submit', (event, ...args: unknown[]) => {
    const [id, prompt, expectedOutputId, expectedRunId] = args;
    if (
      !trusted(event) ||
      selecting ||
      args.length !== 4 ||
      !(expectedOutputId === null || projectArgument(expectedOutputId)) ||
      !(expectedRunId === null || projectArgument(expectedRunId)) ||
      !projectArgument(id) ||
      !promptIsValid(prompt)
    )
      return rejected('프로젝트와 메시지를 확인해 주세요.');
    return apiClient?.command(id, 'submit', { prompt, expectedOutputId, expectedRunId });
  });
  ipcMain.handle('ai:reconnect', (event, ...args: unknown[]) => {
    if (!trusted(event) || args.length !== 0) return rejected('연결을 확인할 수 없어요.');
    return apiClient?.reconnect();
  });
  ipcMain.handle('ai:read', async (event, ...args: unknown[]) => {
    const [id, after, outputId] = args;
    if (
      !trusted(event) ||
      args.length !== 3 ||
      !(outputId === null || projectArgument(outputId)) ||
      !projectArgument(id) ||
      !Number.isSafeInteger(after) ||
      Number(after) < 0
    )
      return { ...emptyAISnapshot, state: 'error', message: '대화 상태를 조회할 수 없어요.' };
    try {
      return await apiClient?.readSession(id, Number(after), outputId);
    } catch {
      return apiClient?.readFailure();
    }
  });
  ipcMain.handle('ai:resize', (event, ...args: unknown[]) => {
    const [id, cols, rows] = args;
    if (!trusted(event) || args.length !== 3 || !projectArgument(id) || !sizeIsValid(cols, rows))
      return rejected('화면 크기를 확인할 수 없어요.');
    return apiClient?.command(id, 'resize', { cols, rows });
  });
  for (const action of ['stop', 'reset'] as const) {
    ipcMain.handle(`ai:${action}`, (event, ...args: unknown[]) => {
      const [id, expectedId, expectedRunId] = args;
      if (
        !trusted(event) ||
        args.length !== (action === 'stop' ? 2 : 3) ||
        !projectArgument(id) ||
        (action === 'reset' && !(expectedRunId === null || projectArgument(expectedRunId))) ||
        !(projectArgument(expectedId) || (action === 'reset' && expectedId === null))
      )
        return rejected('대화를 확인할 수 없어요.');
      return apiClient?.command(
        id,
        action,
        action === 'stop'
          ? { expectedRunId: expectedId }
          : { expectedOutputId: expectedId, expectedRunId },
      );
    });
  }

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', (event) => {
  if (!allowExit) {
    event.preventDefault();
    void closeApplication();
  }
});
