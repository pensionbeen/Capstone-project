import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron, type ElectronApplication, expect, type Page, test } from '@playwright/test';

let app: ElectronApplication;
let page: Page;
const errors: string[] = [];

test.beforeEach(async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
    ),
  ) as Record<string, string>;
  app = await _electron.launch({
    args: ['.', `--user-data-dir=${resolve('.runtime', `electron-test-${randomUUID()}`)}`],
    env,
  });
  page = await app.firstWindow();
  errors.length = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    '어떤 프로젝트를 만들어 볼까요?',
  );
});
test.afterEach(async () => {
  await app?.close();
  expect(errors).toEqual([]);
});

async function snapshot(name: string) {
  await mkdir(resolve('.runtime', 'screens'), { recursive: true });
  await page.screenshot({
    path: resolve('.runtime', 'screens', `${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
}
async function toAnalysis() {
  await page.getByRole('button', { name: '예시 열기', exact: true }).click();
  await page.getByRole('button', { name: '이 프로젝트로 시작' }).click();
  await page.getByRole('button', { name: '예시로 요구분석 시작' }).click();
}
async function toConfirm() {
  await toAnalysis();
  await page.getByRole('textbox', { name: '만들고 싶은 서비스' }).fill('나만의 할 일 관리 앱');
  await page.getByRole('button', { name: '요구분석 시작', exact: true }).click();
  await page.getByRole('radio', { name: '나 혼자', exact: true }).check();
  await page.getByRole('button', { name: '기능 초안 보기' }).click();
}
async function toDashboard() {
  await toConfirm();
  await page.getByRole('button', { name: '기능 4개 확정하고 시작' }).click();
}

test('5단계 흐름과 보조 메뉴를 실제 Electron에서 사용할 수 있다', async () => {
  await snapshot('01-project');
  await expect(page.getByRole('button', { name: '02 AI 연결·보호 설정' })).toBeDisabled();
  await page.getByRole('button', { name: '예시 열기', exact: true }).click();
  await page.getByRole('button', { name: '이 프로젝트로 시작' }).click();
  await expect(page.getByText('Codex 연결 전', { exact: true })).toBeVisible();
  const codex = page.getByRole('checkbox', { name: 'Codex', exact: true });
  const gemini = page.getByRole('checkbox', { name: 'Gemini', exact: true });
  await expect(codex).toBeChecked();
  await gemini.check();
  await expect(codex).toBeChecked();
  await expect(gemini).toBeChecked();
  await codex.uncheck();
  await expect(gemini).toBeChecked();
  await gemini.uncheck();
  await expect(page.getByText('AI를 1개 이상 선택해 주세요')).toBeVisible();
  await expect(page.getByRole('button', { name: '예시로 요구분석 시작' })).toBeDisabled();
  await codex.focus();
  await codex.press('Space');
  await gemini.check();
  await expect(page.getByText('Codex · Gemini 연결 전', { exact: true })).toBeVisible();
  await snapshot('02-connect');
  await page.getByRole('button', { name: '예시로 요구분석 시작' }).click();
  await page.getByRole('button', { name: 'AI 연결·보호 설정', exact: true }).click();
  await expect(codex).toBeChecked();
  await expect(gemini).toBeChecked();
  await page.getByRole('button', { name: '예시로 요구분석 시작' }).click();
  await expect(page.getByRole('button', { name: '요구분석 시작', exact: true })).toBeDisabled();
  await snapshot('03-analysis');
  await page.getByRole('textbox', { name: '만들고 싶은 서비스' }).fill('나만의 할 일 관리 앱');
  await page.getByRole('button', { name: '요구분석 시작', exact: true }).click();
  await page.getByRole('radio', { name: '나 혼자', exact: true }).check();
  await snapshot('03-analysis-questions');
  await page.getByRole('button', { name: '기능 초안 보기' }).click();
  await snapshot('04-confirm');
  await page.getByRole('button', { name: '기능 4개 확정하고 시작' }).click();
  await expect(page.locator('.sidebar-connection')).toHaveText('Codex · Gemini 연결 전');
  await expect(
    page.getByRole('table', { name: '프로젝트 기능 목록' }).getByRole('row'),
  ).toHaveCount(5);
  await expect(page.getByRole('progressbar', { name: '검증 완료율' })).toHaveAttribute(
    'value',
    '0',
  );
  await snapshot('05-dashboard');
  for (const [menu, title, screenshot] of [
    ['기능 검증', '완료는 확인한 만큼', '06-verification'],
    ['보호 정책', '소중한 파일은 따로 지켜요', '07-protection'],
    ['파일 전송', '필요한 파일만, 원하는 기기로', '08-transfer'],
    ['실행 이력', '작업의 흐름을 놓치지 않도록', '09-history'],
  ]) {
    await page.getByRole('button', { name: menu, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    if (menu === '보호 정책') {
      await page.getByText('적용 대상과 상태 보기', { exact: true }).click();
      await expect(page.getByText('Codex · Gemini · 연결 전', { exact: true })).toBeVisible();
    }
    if (menu === '실행 이력') {
      await page.getByRole('searchbox', { name: '이력 검색' }).fill('cOdEx');
      await expect(
        page.getByText('선택한 AI: Codex, Gemini. 실제 연결은 아직 하지 않았어요.').first(),
      ).toBeVisible();
    }
    await snapshot(screenshot);
  }
});

test('폴더 선택 IPC 정상·취소·오류에서 기존 선택을 보존한다', async () => {
  await page.evaluate(() => {
    location.hash = 'main';
  });
  const folder = resolve('.runtime', 'test-fixtures', '선택할 프로젝트');
  await mkdir(folder, { recursive: true });
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, folder);
  await page.getByRole('button', { name: '프로젝트 폴더 선택', exact: true }).click();
  await expect(page.getByLabel('프로젝트 이름', { exact: true })).toHaveValue('선택할 프로젝트');
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole('button', { name: '폴더 변경' }).click();
  await expect(page.getByRole('status')).toContainText('취소');
  await expect(page.getByLabel('프로젝트 이름', { exact: true })).toHaveValue('선택할 프로젝트');
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, `${folder}-missing`);
  await page.getByRole('button', { name: '폴더 변경' }).click();
  await expect(page.getByRole('status')).toContainText('폴더가 없거나');
  await expect(page.getByLabel('프로젝트 이름', { exact: true })).toHaveValue('선택할 프로젝트');
});

test('renderer는 Node 권한 없이 제한된 폴더 선택 API만 가진다', async () => {
  const result = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    bridge: Object.keys(window.desktop ?? {}),
  }));
  expect(result).toEqual({
    require: 'undefined',
    process: 'undefined',
    bridge: [
      'selectProjectFolder',
      'inspectAI',
      'readAIStatus',
      'reconnectAI',
      'listProjects',
      'activateProject',
      'saveProjectName',
      'loadFeaturePlan',
      'saveFeaturePlan',
      'listProjectFiles',
      'openProjectFile',
      'listProjectBackups',
      'backupProjects',
      'restoreProjects',
      'sendAIPrompt',
      'readAISession',
      'resizeAISession',
      'stopAISession',
      'resetAISession',
    ],
  });
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      node: preferences.nodeIntegration,
      isolation: preferences.contextIsolation,
      sandbox: preferences.sandbox,
      security: preferences.webSecurity,
    };
  });
  expect(preferences).toEqual({ node: false, isolation: true, sandbox: true, security: true });
  const reply = await app.evaluate(async ({ BrowserWindow, ipcMain }) => {
    const window = BrowserWindow.getAllWindows()[0];
    // Call the registered handler with an invalid frame and with unexpected arguments.
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>;
      }
    )._invokeHandlers;
    const handler = handlers.get('project:select-folder');
    if (!handler) throw new Error('IPC handler missing');
    const invalidFrame = await handler({ sender: window.webContents, senderFrame: null });
    const invalidArgs = await handler(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      'C:/',
    );
    return { invalidFrame, invalidArgs };
  });
  expect(reply.invalidFrame).toMatchObject({ status: 'error' });
  expect(reply.invalidArgs).toMatchObject({ status: 'error' });
  await page.evaluate(() => window.open('https://example.com'));
  expect(app.windows()).toHaveLength(1);
});

test('검증 근거를 요구하고 조건 변경 뒤 과거 결과를 무효화한다', async () => {
  await toDashboard();
  await page.getByRole('button', { name: '작업 내용 열기' }).click();
  await expect(page.getByRole('button', { name: 'AI 실행 준비 중' })).toBeDisabled();
  await page.getByRole('button', { name: '직접 확인한 결과 기록' }).click();
  await expect(page.getByRole('button', { name: '검증 결과 저장' })).toBeDisabled();
  for (const checkbox of await page.getByRole('dialog').getByRole('checkbox').all())
    await checkbox.check();
  await page
    .getByLabel('실제 확인한 결과')
    .fill('합성 테스트: 추가·수정·빈 제목 안내를 확인했습니다.');
  await page.getByLabel('검증 근거', { exact: true }).fill('합성 UI 검사 결과');
  await page.getByRole('button', { name: '검증 결과 저장' }).click();
  await expect(page.getByRole('progressbar', { name: '검증 완료율' })).toHaveAttribute(
    'value',
    '25',
  );
  await expect(
    page
      .getByRole('table', { name: '프로젝트 기능 목록' })
      .getByRole('row')
      .nth(2)
      .getByText('다음', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '할 일 추가·수정', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '수정', exact: true }).click();
  await page.getByLabel('완료 조건', { exact: true }).fill('새 완료 조건');
  await page.getByRole('button', { name: '기능 저장' }).click();
  await expect(page.getByRole('progressbar', { name: '검증 완료율' })).toHaveAttribute(
    'value',
    '0',
  );
  await expect(page.getByText('재검증 필요', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /기능 검증/ }).click();
  await expect(page.getByText('이전 조건의 결과')).toBeVisible();
});

test('새 초안 생성 시 이전 기능의 검증을 재사용하지 않는다', async () => {
  await toDashboard();
  await page.getByRole('button', { name: '작업 내용 열기' }).click();
  await page.getByRole('button', { name: '직접 확인한 결과 기록' }).click();
  for (const checkbox of await page.getByRole('dialog').getByRole('checkbox').all())
    await checkbox.check();
  await page.getByLabel('실제 확인한 결과').fill('이전 초안의 합성 검사');
  await page.getByLabel('검증 근거', { exact: true }).fill('이전 초안의 테스트 근거');
  await page.getByRole('button', { name: '검증 결과 저장' }).click();
  await expect(page.getByRole('progressbar', { name: '검증 완료율' })).toHaveAttribute(
    'value',
    '25',
  );
  await page.locator('.project-switcher').click();
  await page.getByRole('button', { name: '프로젝트 선택으로', exact: true }).click();
  await page.getByRole('button', { name: '이 프로젝트로 시작' }).click();
  await page.getByRole('button', { name: '예시로 요구분석 시작' }).click();
  await page.getByRole('button', { name: '내용 수정', exact: true }).click();
  await page.getByRole('textbox', { name: '만들고 싶은 서비스' }).fill('학습 기록 앱');
  await page.getByRole('button', { name: '요구분석 시작', exact: true }).click();
  await page.getByRole('button', { name: '기능 초안 보기' }).click();
  await page.getByRole('button', { name: '새 초안으로 바꾸기' }).click();
  await page.getByRole('button', { name: '기능 4개 확정하고 시작' }).click();
  await expect(page.getByRole('progressbar', { name: '검증 완료율' })).toHaveAttribute(
    'value',
    '0',
  );
  await expect(
    page.getByRole('button', { name: '학습 기록 추가·수정', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: /기능 검증/ }).click();
  await expect(page.getByRole('heading', { name: '아직 남긴 검증 결과가 없어요' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '할 일 추가·수정', exact: true })).toHaveCount(0);
});

test('프로젝트를 찾지 못한 알림은 성공 체크 대신 주의 표시를 쓴다', async () => {
  const folder = resolve('.runtime', `toast-project-${randomUUID()}`);
  await mkdir(folder, { recursive: true });
  await app.evaluate(({ dialog, ipcMain }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers;
    handlers.set('project:activate', () => ({
      ok: false,
      message: '저장된 프로젝트를 찾지 못했어요.',
    }));
  }, folder);
  await page.getByRole('button', { name: '프로젝트 폴더 선택', exact: true }).click();
  const toast = page.getByRole('status');
  await expect(toast).toHaveAttribute('data-tone', 'warning');
  await expect(toast).toContainText('주의: 저장된 프로젝트를 찾지 못했어요.');
  await expect(toast.locator('svg path').first()).toHaveAttribute('d', 'M12 3 2 21h20L12 3Z');
  await page.screenshot({ path: '.runtime/screens/17-warning-toast.png', fullPage: true });
});

test('편집한 초안을 요구분석 왕복으로 덮어쓰지 않고 빈 기능 확정을 막는다', async () => {
  await toConfirm();
  await page.getByRole('button', { name: '할 일 추가·수정 수정' }).click();
  await page.getByLabel('기능 이름').fill('내가 고친 기능');
  await page.getByRole('button', { name: '기능 저장' }).click();
  await page.getByRole('button', { name: '요구분석으로 돌아가기' }).click();
  await page.getByRole('button', { name: '기능 초안 보기' }).click();
  await page.getByRole('button', { name: '기존 초안 유지' }).click();
  await expect(page.getByRole('heading', { name: '내가 고친 기능' })).toBeVisible();
  for (const checkbox of await page.locator('.draft-list').getByRole('checkbox').all())
    await checkbox.uncheck();
  await expect(page.getByRole('button', { name: '기능 0개 확정하고 시작' })).toBeDisabled();
});

test('보호·전송은 설정안과 미연결 상태를 유지하며 검색·필터가 동작한다', async () => {
  await toDashboard();
  await page.getByRole('searchbox', { name: '기능 검색' }).fill('없는기능');
  await expect(page.getByText('표시할 기능이 없어요')).toBeVisible();
  await page.getByRole('button', { name: '보호 정책', exact: true }).click();
  await page.getByLabel('보호할 파일·폴더').fill('../private');
  await page.getByRole('button', { name: '설정안 저장' }).click();
  await expect(page.getByRole('status')).toContainText('상대 경로');
  await page.getByLabel('보호할 파일·폴더').fill('.env\n설정/개인.json');
  await page.getByRole('button', { name: '설정안 저장' }).click();
  await expect(page.getByRole('status')).toContainText('아직 적용되지');
  await page.getByRole('checkbox', { name: '읽기', exact: true }).uncheck();
  await expect(page.locator('.protection-editor').getByRole('status')).toHaveCount(0);
  await page.getByRole('button', { name: '파일 전송', exact: true }).click();
  await expect(page.getByRole('button', { name: '전송 정보 확인' })).toBeDisabled();
  const file = resolve('.runtime', 'test-fixtures', '전송 예시.txt');
  await mkdir(resolve('.runtime', 'test-fixtures'), { recursive: true });
  await writeFile(file, 'synthetic transfer metadata only');
  await page.getByLabel('보낼 파일', { exact: true }).setInputFiles(file);
  await page.getByLabel('받는 기기 이름').fill('친구 PC');
  await page.getByRole('button', { name: '전송 정보 확인' }).click();
  await expect(page.getByRole('dialog')).toContainText('연결 전 · 전송되지 않았어요');
});

test('작은 화면의 메뉴와 핵심 흐름에 가로 잘림이 없다', async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(320, 500);
    window.setContentSize(390, 844);
  });
  await expect(page.getByRole('button', { name: '메뉴 열기' })).toBeVisible();
  await snapshot('mobile-project');
  await toDashboard();
  await expect(page.getByRole('button', { name: '작업 내용 열기' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await snapshot('mobile-dashboard');
  await page.getByRole('button', { name: '메뉴 열기' }).click();
  await page.getByRole('button', { name: '파일 전송', exact: true }).click();
  await expect(page.getByRole('heading', { name: '필요한 파일만, 원하는 기기로' })).toBeVisible();
  await snapshot('mobile-transfer');
});
