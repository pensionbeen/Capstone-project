import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { _electron, type ElectronApplication, expect, type Page, test } from '@playwright/test';

let app: ElectronApplication;
let page: Page;
let profile: string;
let folder: string;
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
  ),
) as Record<string, string>;

async function launch() {
  app = await _electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
  page = await app.firstWindow();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    '어떤 프로젝트를 만들어 볼까요?',
  );
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
}
async function select(path = folder) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, path);
  const change = page.getByRole('button', { name: '폴더 변경', exact: true });
  if (await change.count()) await change.click();
  else await page.getByRole('button', { name: '프로젝트 폴더 선택', exact: true }).click();
  await expect(page.getByLabel('프로젝트 이름', { exact: true })).toBeEnabled();
}
async function catalog() {
  return page.evaluate(() => {
    if (!window.desktop) throw new Error('Missing desktop bridge');
    return window.desktop.listProjects();
  });
}
test.beforeEach(async () => {
  const root = resolve('.runtime', `storage-ui-${randomUUID()}`);
  profile = join(root, 'profile');
  folder = join(root, '한글 공백 프로젝트');
  await mkdir(folder, { recursive: true });
  await launch();
});
test.afterEach(async () => {
  await app?.close();
});

test('실제 앱 재시작 뒤 이름·폴더·ID·선택 복원, AI 자동 실행 없음', async () => {
  await select();
  await page.getByLabel('프로젝트 이름', { exact: true }).fill('저장한 한글 이름');
  await page.getByRole('button', { name: '이 프로젝트로 시작' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('함께할 AI를 선택해 주세요');
  const before = await catalog();
  expect(before.projects).toHaveLength(1);
  expect(before.storage).toBe('sqlite');
  await app.close();
  await launch();
  await expect(page.getByLabel('프로젝트 이름', { exact: true })).toHaveValue('저장한 한글 이름');
  expect(await catalog()).toEqual(before);
  const state = await page.evaluate(
    (id) => window.desktop?.readAIStatus(id),
    before.activeProjectId ?? '',
  );
  expect(state?.state).toBe('idle');
  expect(state?.id).toBeNull();
  await mkdir('.runtime/screens', { recursive: true });
  await page.screenshot({ path: '.runtime/screens/13-project-restored.png', fullPage: true });
});

test('실제 프로젝트 수동 기능과 검증 결과가 저장되고 재시작 뒤 조회된다', async () => {
  await select();
  await page.getByLabel('프로젝트 이름', { exact: true }).fill('기능 계획 검사');
  await page.getByRole('button', { name: '이 프로젝트로 시작' }).click();
  await page.getByRole('button', { name: 'AI로 요구분석 시작' }).click();
  await page.getByRole('button', { name: '기능 직접 정리하기' }).click();
  for (const title of ['할 일 추가', '할 일 수정', '할 일 목록', '할 일 검색']) {
    await page.getByRole('button', { name: '기능 직접 추가' }).click();
    await page.getByLabel('기능 이름', { exact: true }).fill(title);
    await page.getByLabel('완료 조건', { exact: true }).fill(`${title} 동작을 확인한다.`);
    await page.getByRole('button', { name: '기능 저장' }).click();
  }
  await expect
    .poll(async () => {
      const list = await catalog();
      const id = list.activeProjectId;
      return id
        ? (await page.evaluate((key) => window.desktop?.loadFeaturePlan(key), id))?.plan?.features
            .length
        : 0;
    })
    .toBe(4);
  await page.getByRole('button', { name: '기능 4개 확정하고 시작' }).click();
  await page.getByRole('button', { name: '작업 내용 열기' }).click();
  await page.getByRole('button', { name: '직접 확인한 결과 기록' }).click();
  for (const checkbox of await page.getByRole('dialog').getByRole('checkbox').all())
    await checkbox.check();
  await page
    .getByLabel('실제 확인한 결과')
    .fill('프로젝트 계획 검증 UI에서 완료 조건을 확인했습니다.');
  await page.getByLabel('검증 근거', { exact: true }).fill('T-006 검증 화면');
  await page.getByRole('button', { name: '검증 결과 저장' }).click();
  await expect(page.getByRole('progressbar', { name: '검증 완료율' })).toHaveAttribute(
    'value',
    '25',
  );
  const before = await catalog();
  const id = before.activeProjectId;
  if (!id) throw new Error('No active project after feature creation');
  const stored = await page.evaluate((key) => window.desktop?.loadFeaturePlan(key), id);
  expect(stored?.ok).toBe(true);
  expect(stored?.plan?.verifications).toHaveLength(1);
  await app.close();
  await launch();
  const reopened = await page.evaluate((key) => window.desktop?.loadFeaturePlan(key), id);
  expect(reopened).toEqual(stored);
});

test('이름 저장 잠금 실패 시 입력·선택 보존, 재시도 성공과 취소 유지', async () => {
  await select();
  const before = await catalog();
  const blocker = new DatabaseSync(join(profile, 'orbit-data', 'projects.sqlite'));
  try {
    blocker.exec('BEGIN IMMEDIATE');
    await page.getByLabel('프로젝트 이름', { exact: true }).fill('실패 뒤 남을 이름');
    await page.getByRole('button', { name: '이 프로젝트로 시작' }).click();
    await expect(page.getByRole('status')).toContainText('저장 작업을 마치지 못했어요');
    await expect(page.getByLabel('프로젝트 이름', { exact: true })).toHaveValue(
      '실패 뒤 남을 이름',
    );
    expect(await catalog()).toEqual(before);
    blocker.exec('ROLLBACK');
  } finally {
    blocker.close();
  }
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole('button', { name: '폴더 변경', exact: true }).click();
  expect(await catalog()).toEqual(before);
  await page.getByRole('button', { name: '이 프로젝트로 시작' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('함께할 AI를 선택해 주세요');
  expect((await catalog()).projects[0].name).toBe('실패 뒤 남을 이름');
});

test('화면에서 백업 생성·복원 취소·복원 성공, 관계와 안전 사본 유지', async () => {
  await select();
  const before = await catalog();
  await page.getByRole('button', { name: '프로젝트 목록 백업·복원', exact: true }).click();
  await page.getByRole('button', { name: '현재 목록 백업', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('백업했어요');
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  const second = join(folder, '다른 폴더');
  await mkdir(second);
  await select(second);
  await expect.poll(async () => (await catalog()).projects.length).toBe(2);
  const changed = await catalog();
  await page.getByRole('button', { name: '프로젝트 목록 백업·복원', exact: true }).click();
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
  await page.getByRole('button', { name: '백업 1 복원', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('복원을 취소');
  expect(await catalog()).toEqual(changed);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await page.getByRole('button', { name: '백업 1 복원', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('목록을 복원');
  expect(await catalog()).toEqual(before);
  expect((await page.evaluate(() => window.desktop?.listProjectBackups()))?.backups).toHaveLength(
    2,
  );
  await expect(page.getByRole('button', { name: '현재 목록 백업', exact: true })).toBeEnabled();
  await page.screenshot({ path: '.runtime/screens/14-project-backup.png', fullPage: true });
});

test('손상 저장 파일은 시작 때 그대로 보존하고 실제 폴더 저장을 차단한다', async () => {
  await app.close();
  const path = join(profile, 'orbit-data', 'projects.sqlite');
  await writeFile(path, 'BROKEN_SYNTHETIC_DATABASE');
  const hash = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  await launch();
  await expect(page.getByText('프로젝트 저장을 사용할 수 없어요.', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '프로젝트 폴더 선택', exact: true }),
  ).toBeDisabled();
  expect((await catalog()).storage).toBe('unavailable');
  expect(
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  ).toBe(hash);
});

test('동일 프로필의 두 번째 앱은 저장 연결을 열지 않고 종료한다', async () => {
  await select();
  const before = await catalog();
  await promisify(execFile)(
    resolve('node_modules/electron/dist/electron.exe'),
    ['.', `--user-data-dir=${profile}`],
    { env, windowsHide: true, timeout: 10000 },
  );
  expect(await catalog()).toEqual(before);
  await expect(page.getByLabel('프로젝트 이름', { exact: true })).toBeEnabled();
});

test('복원 뒤 목록 조회가 실패해도 확정된 선택을 즉시 화면에 적용한다', async () => {
  await select();
  const before = await catalog();
  await page.evaluate(() => window.desktop?.backupProjects());
  const second = join(folder, '두 번째');
  await mkdir(second);
  await select(second);
  await expect.poll(async () => (await catalog()).projects.length).toBe(2);
  await page.getByRole('button', { name: '프로젝트 목록 백업·복원', exact: true }).click();
  await expect(page.getByRole('button', { name: '백업 1 복원' })).toBeEnabled();
  await app.evaluate(({ ipcMain, dialog }) => {
    ipcMain.removeHandler('project:list');
    ipcMain.handle('project:list', () => {
      throw new Error('injected list failure');
    });
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await page.getByRole('button', { name: '백업 1 복원' }).click();
  await expect(page.getByRole('status')).toContainText('목록을 복원');
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(page.getByLabel('프로젝트 이름', { exact: true })).toHaveValue(
    before.projects[0].name,
  );
  const db = new DatabaseSync(join(profile, 'orbit-data', 'projects.sqlite'), { readOnly: true });
  try {
    expect(db.prepare('SELECT active_project_id FROM app_state').get()?.active_project_id).toBe(
      before.activeProjectId,
    );
  } finally {
    db.close();
  }
});

test('프로젝트 변경 확정 응답 대기 동안 취소와 Escape를 막는다', async () => {
  await select();
  await page.getByRole('button', { name: '이 프로젝트로 시작' }).click();
  await page.getByRole('button', { name: '예시로 요구분석 시작' }).click();
  await page.getByRole('textbox', { name: '만들고 싶은 서비스' }).fill('유지해야 하는 요구');
  await page.getByRole('button', { name: '프로젝트 선택', exact: true }).click();
  const second = join(folder, '변경할 폴더');
  await mkdir(second);
  await select(second);
  await expect(page.getByRole('dialog')).toBeVisible();
  await app.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get('project:activate');
    ipcMain.removeHandler('project:activate');
    ipcMain.handle('project:activate', async (...args) => {
      await new Promise<void>((resolve) => {
        Reflect.set(globalThis, 'releaseProjectTest', resolve);
      });
      return original?.(...args);
    });
  });
  await page.getByRole('button', { name: '프로젝트 바꾸기', exact: true }).click();
  await expect(page.getByRole('button', { name: '현재 프로젝트 유지' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '닫기', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  await app.evaluate(() => {
    Reflect.get(globalThis, 'releaseProjectTest')();
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('프로젝트 이름', { exact: true })).toHaveValue('변경할 폴더');
});

test('HTTP 전달 중인 AI 요청도 폴더 변경·백업·복원을 막는다', async () => {
  await select();
  const before = await catalog();
  const url = resolve('dist/desktop/electron/local-api/client.js');
  await app.evaluate((_electron, path) => {
    const require = process.getBuiltinModule('module').createRequire(path);
    const { LocalApiClient } = require(path);
    LocalApiClient.prototype.command = async () => {
      await new Promise<void>((resolve) => {
        Reflect.set(globalThis, 'releaseAITest', resolve);
      });
      return { ok: false, message: 'synthetic delayed rejection' };
    };
  }, url);
  await page.evaluate((id) => {
    void window.desktop?.sendAIPrompt(id, '지연 요청', null, null);
  }, before.activeProjectId ?? '');
  await expect
    .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'releaseAITest')))
    .toBe('function');
  const result = await page.evaluate(
    async (id) => ({
      activate: await window.desktop?.activateProject(id),
      folder: await window.desktop?.selectProjectFolder(),
      backup: await window.desktop?.backupProjects(),
      restore: await window.desktop?.restoreProjects(id),
    }),
    before.activeProjectId ?? '',
  );
  expect(result.activate?.ok).toBe(false);
  expect(result.folder?.status).toBe('error');
  expect(result.backup?.ok).toBe(false);
  expect(result.restore?.ok).toBe(false);
  expect(await catalog()).toEqual(before);
  await app.evaluate(() => {
    Reflect.get(globalThis, 'releaseAITest')();
  });
  await expect
    .poll(async () =>
      page.evaluate((id) => window.desktop?.activateProject(id), before.activeProjectId ?? ''),
    )
    .toMatchObject({ ok: true });
});

test('저장 IPC는 다른 프레임·추가 경로·잘못된 ID와 이름을 거부한다', async () => {
  const result = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers;
    const window = BrowserWindow.getAllWindows()[0];
    const valid = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    const responses = [];
    for (const channel of [
      'project:activate',
      'project:save-name',
      'storage:backup',
      'storage:restore',
    ]) {
      responses.push(await handlers.get(channel)?.({ ...valid, senderFrame: null }));
      responses.push(await handlers.get(channel)?.(valid, 'C:/arbitrary', 'extra'));
    }
    return responses;
  });
  expect(result).toHaveLength(8);
  for (const response of result) expect(response).toMatchObject({ ok: false });
});
