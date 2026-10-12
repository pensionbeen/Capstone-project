import { randomUUID } from 'node:crypto';
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
import type { ProjectFeaturePlan } from '../shared/feature-plan.js';
import { validFeatureSessionInput } from '../shared/feature-session.js';
import { validRequirementsInput } from '../shared/requirements.js';
import type { ProjectCatalog, ProjectResult, StorageResult } from '../shared/storage.js';
import { promptIsValid, rejected, sizeIsValid, UUID } from './ai/contracts.js';
import { SessionManager } from './ai/session-manager.js';
import { LocalApiClient } from './local-api/client.js';
import { startLocalApi } from './local-api/server.js';
import { APP_URL, DEV_URL, inspectDirectory, isTrustedPage, staticAssetPath } from './policy.js';
import { ProjectFiles } from './project-files.js';
import { ProjectStore, storageMessage, validProjectName } from './storage/project-store.js';

const currentDirectory = fileURLToPath(new URL('.', import.meta.url));
const development = !app.isPackaged && process.argv.includes('--dev');
const trustedUrl = development ? DEV_URL : APP_URL;
let mainWindow: BrowserWindow | null = null;
let selecting = false;
let allowExit = false;
let closing: Promise<void> | undefined;
export const aiSession = new SessionManager({
  loadFeature: (projectId, featureId) =>
    projectStore?.featurePlan(projectId).features.find((feature) => feature.id === featureId),
});
export const projectFiles = new ProjectFiles();
let localApi: Awaited<ReturnType<typeof startLocalApi>> | undefined;
let apiClient: LocalApiClient | undefined;
let projectStore: ProjectStore | undefined;
let storageFailure = '';
const pendingFolders = new Map<string, string>();
let pendingAIChanges = 0;
function changingAI<T>(operation: () => Promise<T> | undefined) {
  pendingAIChanges++;
  return Promise.resolve()
    .then(operation)
    .finally(() => {
      pendingAIChanges--;
    });
}
function projectCatalog(): ProjectCatalog {
  return (
    projectStore?.catalog() ?? {
      projects: [],
      activeProjectId: null,
      storage: 'unavailable',
      message: storageFailure,
    }
  );
}
function syncProjects(resetSession = false) {
  aiSession.replaceProjects(projectCatalog().projects, resetSession);
}
function mayChangeProjects() {
  return (
    projectStore &&
    !selecting &&
    !closing &&
    !allowExit &&
    pendingAIChanges === 0 &&
    aiSession.canChangeProjects
  );
}

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
    projectStore?.close();
    allowExit = true;
    app.quit();
  })().finally(() => {
    closing = undefined;
  });
  return closing;
}

app.setName('ORBIT');
if (!app.requestSingleInstanceLock()) {
  allowExit = true;
  app.quit();
}
app.on('second-instance', () => {
  mainWindow?.restore();
  mainWindow?.focus();
});
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
  if (allowExit) return;
  try {
    projectStore = new ProjectStore(join(app.getPath('userData'), 'orbit-data'));
    syncProjects();
  } catch (error) {
    storageFailure = `프로젝트 저장을 열지 못했어요. ${storageMessage(error)}`;
  }
  try {
    localApi = await startLocalApi(
      aiSession,
      development ? 'http://127.0.0.1:5173' : 'orbit://app',
      projectCatalog,
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
      if (!projectStore) return { status: 'error', message: storageFailure };
      if (!mayChangeProjects())
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
        if (closing || allowExit || !aiSession.canChangeProjects)
          return { status: 'error', message: 'AI 실행을 정리한 뒤 폴더를 다시 선택해 주세요.' };
        const projectId = randomUUID();
        if (pendingFolders.size >= 16)
          pendingFolders.delete(pendingFolders.keys().next().value as string);
        pendingFolders.set(projectId, selected.path);
        return {
          status: 'selected',
          projectId,
          name: selected.name,
          path: selected.path,
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
  ipcMain.handle('features:load', (event, ...args: unknown[]) => {
    const [id] = args;
    if (!trusted(event) || args.length !== 1 || !projectArgument(id) || !projectStore)
      return { ok: false, message: '저장된 기능 계획을 조회할 수 없어요.' };
    try {
      return { ok: true, plan: projectStore.featurePlan(id) };
    } catch (error) {
      return { ok: false, message: storageMessage(error) };
    }
  });
  ipcMain.handle('features:save', (event, ...args: unknown[]) => {
    const [id, plan] = args;
    if (!trusted(event) || args.length !== 2 || !projectArgument(id) || !projectStore)
      return { ok: false, message: '저장할 기능 계획을 확인해 주세요.' };
    if (!mayChangeProjects())
      return { ok: false, message: 'AI 실행을 중단하고 정리가 끝난 뒤 기능을 변경해 주세요.' };
    try {
      return { ok: true, plan: projectStore.saveFeaturePlan(id, plan as ProjectFeaturePlan) };
    } catch (error) {
      return { ok: false, message: storageMessage(error) };
    }
  });
  for (const action of ['list', 'open'] as const) {
    ipcMain.handle(`files:${action}`, async (event, ...args: unknown[]) => {
      const [id, path] = args;
      if (
        !trusted(event) ||
        args.length !== 2 ||
        !projectArgument(id) ||
        typeof path !== 'string' ||
        !projectStore ||
        closing
      )
        return { ok: false, message: '프로젝트와 파일 경로를 확인해 주세요.' };
      try {
        const project = projectStore.project(id);
        return action === 'list'
          ? await projectFiles.list(project.path, path)
          : await projectFiles.open(project.path, path);
      } catch {
        return { ok: false, message: '프로젝트 폴더를 다시 선택해 주세요.' };
      }
    });
  }
  for (const action of ['activate', 'save-name'] as const) {
    ipcMain.handle(`project:${action}`, (event, ...args: unknown[]): ProjectResult => {
      const [id, name] = args;
      if (
        !trusted(event) ||
        args.length !== (action === 'activate' ? 1 : 2) ||
        !projectArgument(id) ||
        (action === 'save-name' && !validProjectName(name))
      )
        return { ok: false, message: '프로젝트 선택과 이름을 확인해 주세요.' };
      if (!mayChangeProjects() || !projectStore)
        return {
          ok: false,
          message: storageFailure || 'AI 실행을 중단하고 정리가 끝난 뒤 프로젝트를 변경해 주세요.',
        };
      try {
        const candidate = action === 'activate' ? pendingFolders.get(id) : undefined;
        const project = candidate
          ? projectStore.register(candidate, true)
          : projectStore.activate(id, action === 'save-name' ? (name as string) : undefined);
        pendingFolders.delete(id);
        syncProjects();
        return { ok: true, project, plan: projectStore.featurePlan(project.id) };
      } catch (error) {
        return { ok: false, message: storageMessage(error) };
      }
    });
  }
  ipcMain.handle('storage:list-backups', (event, ...args: unknown[]) => {
    if (!trusted(event) || args.length !== 0 || !projectStore)
      throw new Error('백업 목록을 열 수 없어요.');
    return { backups: projectStore.backups(), directory: join(projectStore.directory, 'backups') };
  });
  ipcMain.handle('storage:backup', (event, ...args: unknown[]): StorageResult => {
    if (!trusted(event) || args.length !== 0 || !mayChangeProjects() || !projectStore)
      return { ok: false, message: 'AI 실행을 정리하고 저장 상태를 확인한 뒤 백업해 주세요.' };
    try {
      projectStore.backup();
      return { ok: true, message: '프로젝트 목록과 마지막 선택을 백업했어요.' };
    } catch (error) {
      return { ok: false, message: storageMessage(error) };
    }
  });
  ipcMain.handle('storage:restore', async (event, ...args: unknown[]): Promise<StorageResult> => {
    const [id] = args;
    if (
      !trusted(event) ||
      args.length !== 1 ||
      !projectArgument(id) ||
      !mayChangeProjects() ||
      !projectStore ||
      !mainWindow
    )
      return { ok: false, message: 'AI 실행을 정리하고 백업을 다시 선택해 주세요.' };
    selecting = true;
    try {
      if (!projectStore.backups().some((b) => b.id === id))
        return { ok: false, message: '백업을 찾지 못했어요.' };
      const answer = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '프로젝트 목록 복원',
        message: '백업 시점의 프로젝트 목록과 마지막 선택으로 돌아갈까요?',
        detail:
          '현재 프로젝트·기능·검증 데이터도 먼저 백업해요. 복원 후 선택된 프로젝트와 저장된 기능·검증 정보를 다시 불러옵니다. 저장하지 않은 요구분석·대화 입력은 포함되지 않아요.',
        buttons: ['취소', '백업으로 복원'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1)
        return { ok: false, message: '복원을 취소했어요. 현재 목록을 유지해요.' };
      if (closing || allowExit || !aiSession.canChangeProjects)
        return { ok: false, message: '앱 실행을 정리한 뒤 다시 시도해 주세요.' };
      projectStore.restore(id);
      syncProjects(true);
      pendingFolders.clear();
      return {
        ok: true,
        message: '프로젝트 목록을 복원했어요. AI는 자동으로 실행하지 않아요.',
        catalog: projectStore.catalog(),
      };
    } catch (error) {
      return { ok: false, message: storageMessage(error) };
    } finally {
      selecting = false;
    }
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
    return changingAI(() =>
      apiClient?.command(id, 'submit', { prompt, expectedOutputId, expectedRunId }),
    );
  });
  ipcMain.handle('ai:generate', (event, ...args: unknown[]) => {
    const [id, expectedOutputId, expectedRunId] = args;
    if (
      !trusted(event) ||
      selecting ||
      args.length !== 3 ||
      !projectArgument(id) ||
      !(expectedOutputId === null || projectArgument(expectedOutputId)) ||
      !(expectedRunId === null || projectArgument(expectedRunId))
    )
      return rejected('프로젝트와 대화 상태를 확인해 주세요.');
    return changingAI(() =>
      apiClient?.command(id, 'generate', { expectedOutputId, expectedRunId }),
    );
  });
  ipcMain.handle('ai:requirements', (event, ...args: unknown[]) => {
    const [id, action, input, expectedOutputId, expectedRunId] = args;
    if (
      !trusted(event) ||
      selecting ||
      args.length !== 5 ||
      !projectArgument(id) ||
      !validRequirementsInput(action, input) ||
      !(expectedOutputId === null || projectArgument(expectedOutputId)) ||
      !(expectedRunId === null || projectArgument(expectedRunId))
    )
      return rejected('프로젝트와 요구분석 입력을 확인해 주세요.');
    return changingAI(() =>
      apiClient?.command(id, 'requirements', { action, input, expectedOutputId, expectedRunId }),
    );
  });
  ipcMain.handle('ai:feature', (event, ...args: unknown[]) => {
    const [id, action, featureId, expectedRevision, input, expectedOutputId, expectedRunId] = args;
    if (
      !trusted(event) ||
      selecting ||
      args.length !== 7 ||
      !projectArgument(id) ||
      !projectArgument(featureId) ||
      !Number.isSafeInteger(expectedRevision) ||
      Number(expectedRevision) < 1 ||
      Number(expectedRevision) > 2147483647 ||
      (action !== 'start' && action !== 'answer') ||
      !validFeatureSessionInput(action, input) ||
      !(expectedOutputId === null || projectArgument(expectedOutputId)) ||
      !(expectedRunId === null || projectArgument(expectedRunId))
    )
      return rejected('프로젝트·저장된 기능·대화 요청을 확인해 주세요.');
    return changingAI(() =>
      apiClient?.command(id, 'feature', {
        action,
        featureId,
        expectedRevision,
        input,
        expectedOutputId,
        expectedRunId,
      }),
    );
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
      return changingAI(() =>
        apiClient?.command(
          id,
          action,
          action === 'stop'
            ? { expectedRunId: expectedId }
            : { expectedOutputId: expectedId, expectedRunId },
        ),
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
