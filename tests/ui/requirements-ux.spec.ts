import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron, type ElectronApplication, expect, type Page, test } from '@playwright/test';

let app: ElectronApplication;
let page: Page;
const errors: string[] = [];
const folder = resolve('.runtime', 'requirements-ux-project');
const managerUrl = pathToFileURL(resolve('dist/desktop/electron/main.js')).href;

test.beforeEach(async () => {
  await mkdir(folder, { recursive: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
    ),
  ) as Record<string, string>;
  app = await _electron.launch({
    args: ['.', `--user-data-dir=${resolve('.runtime', `requirements-ux-${randomUUID()}`)}`],
    env,
  });
  page = await app.firstWindow();
  errors.length = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, folder);
  await page.getByRole('button', { name: '프로젝트 폴더 선택', exact: true }).click();
  await page.getByRole('button', { name: '이 프로젝트로 시작' }).click();
  await app.evaluate(
    async (_electron, config) => {
      const require = process.getBuiltinModule('module').createRequire(config.managerUrl);
      const { aiSession } = require(config.managerUrl.replace('file:///', ''));
      aiSession.dependencies = {
        prepare: async (_cwd: string, prompt: string, conversation?: string) => ({
          file: config.node,
          args: [
            config.fixture,
            Buffer.from(JSON.stringify({ prompt, conversation })).toString('base64'),
          ],
          inspectHeader: true,
        }),
      };
      aiSession.availabilityStatus = async () => ({
        status: 'ready',
        message: '합성 CLI 검증: 실제 AI 호출 없음',
      });
    },
    { managerUrl, node: process.execPath, fixture: resolve('tests/fixtures/ai-cli.cjs') },
  );
  await openRequirements();
});

test.afterEach(async () => {
  await app?.close();
  expect(errors).toEqual([]);
});

async function openRequirements() {
  await page.getByRole('button', { name: 'AI로 요구분석 시작', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'AI와 요구사항을 정리해요' })).toBeVisible();
  await page.getByRole('button', { name: '연결 준비 확인', exact: true }).click();
  await expect(page.getByRole('button', { name: '연결 준비 다시 확인' })).toBeEnabled();
}

async function state() {
  return app.evaluate(async (_electron, url) => {
    const require = process.getBuiltinModule('module').createRequire(url);
    return require(url.replace('file:///', '')).aiSession.state.state;
  }, managerUrl);
}

test('초안을 먼저 작성하고 작은 창에서 키보드로 목표를 보내도 입력이 보존된다', async () => {
  test.setTimeout(60000);
  const goal = page.getByRole('textbox', { name: '만들고 싶은 서비스' });
  const answer = page.getByRole('textbox', { name: '질문에 대한 답변·정정 내용' });
  await goal.fill('학생 일정 알림');
  await answer.fill('학생만 사용해요.');
  await expect(page.getByRole('button', { name: '답변·정정 보내기' })).toBeDisabled();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(0, 0);
    window.setSize(560, 840);
  });
  await goal.focus();
  await goal.press('Enter');
  await expect(goal).toHaveValue('학생 일정 알림\n');
  expect(await state()).toBe('idle');
  await goal.dispatchEvent('keydown', {
    key: 'Enter',
    ctrlKey: true,
    isComposing: true,
    bubbles: true,
  });
  expect(await state()).toBe('idle');
  await goal.press('Control+Enter');
  await expect.poll(state, { timeout: 25000 }).toBe('exited');
  await expect(answer).toHaveValue('학생만 사용해요.');
  await expect(page.getByRole('button', { name: '답변·정정 보내기' })).toBeEnabled();
  expect(
    await page.locator('.analysis-page').evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= window.innerWidth;
    }),
  ).toBe(true);
  expect(
    await page
      .locator('.main-content')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await mkdir(resolve('.runtime', 'screens'), { recursive: true });
  await page.screenshot({ path: resolve('.runtime', 'screens', 'requirements-ux-narrow.png') });
});

test('실행 중 이전 단계로 이동하고 복귀해도 새 답변 초안과 중단 상태를 유지한다', async () => {
  test.setTimeout(90000);
  const goal = page.getByRole('textbox', { name: '만들고 싶은 서비스' });
  const answer = page.getByRole('textbox', { name: '질문에 대한 답변·정정 내용' });
  await goal.fill('과제 마감 알림');
  await goal.press('Control+Enter');
  await expect.poll(state, { timeout: 25000 }).toBe('exited');
  await answer.fill('WAIT 학생에게 알려 주세요.');
  await expect(page.getByRole('button', { name: '답변·정정 보내기' })).toBeEnabled();
  await answer.press('Control+Enter');
  await expect.poll(state).toBe('running');
  await answer.fill('다음에 보낼 새로운 답변');
  await expect(page.getByRole('button', { name: '기능 직접 정리하기' })).toBeDisabled();
  await page.getByRole('button', { name: '이전 단계', exact: true }).click();
  await expect(page.getByRole('button', { name: 'AI로 요구분석 시작', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'AI로 요구분석 시작', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'AI와 요구사항을 정리해요' })).toBeVisible();
  await expect(goal).toHaveValue('과제 마감 알림');
  await expect(answer).toHaveValue('다음에 보낼 새로운 답변');
  await expect(page.getByRole('button', { name: '실행 중단', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '실행 중단', exact: true }).click();
  await expect.poll(state, { timeout: 25000 }).toBe('interrupted');
  await expect(answer).toHaveValue('다음에 보낼 새로운 답변');
  await expect(page.getByRole('button', { name: '기능 직접 정리하기' })).toBeEnabled();
});

test('화면을 떠난 뒤 도착한 전송 응답도 성공한 답변 초안을 정리한다', async () => {
  test.setTimeout(90000);
  const answer = page.getByRole('textbox', { name: '질문에 대한 답변·정정 내용' });
  await page.getByRole('textbox', { name: '만들고 싶은 서비스' }).fill('학교 알림 앱');
  await page.getByRole('button', { name: '목표 보내고 질문받기' }).click();
  await expect.poll(state, { timeout: 25000 }).toBe('exited');
  await app.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get('ai:requirements');
    if (!original) throw new Error('Requirements handler missing');
    handlers.set('ai:requirements', async (...args: unknown[]) => {
      const result = await original(...args);
      return new Promise((resolve) => {
        Reflect.set(globalThis, 'releaseRequirementsReply', () => resolve(result));
      });
    });
  });
  await answer.fill('학생이 사용하고 일정부터 정리해요.');
  await page.getByRole('button', { name: '답변·정정 보내기' }).click();
  await expect.poll(state).toBe('running');
  await expect
    .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'releaseRequirementsReply')))
    .toBe('function');
  await page.getByRole('button', { name: '이전 단계', exact: true }).click();
  await expect(page.getByRole('button', { name: 'AI로 요구분석 시작', exact: true })).toBeVisible();
  await app.evaluate(() => Reflect.get(globalThis, 'releaseRequirementsReply')());
  await expect.poll(state, { timeout: 25000 }).toBe('exited');
  await openRequirements();
  await expect(answer).toHaveValue('');
});

test('늦은 전송 응답은 복귀 후 새로 작성한 답변을 덮지 않는다', async () => {
  test.setTimeout(90000);
  const answer = page.getByRole('textbox', { name: '질문에 대한 답변·정정 내용' });
  await page.getByRole('textbox', { name: '만들고 싶은 서비스' }).fill('학교 알림 앱');
  await page.getByRole('button', { name: '목표 보내고 질문받기' }).click();
  await expect.poll(state, { timeout: 25000 }).toBe('exited');
  await app.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get('ai:requirements');
    if (!original) throw new Error('Requirements handler missing');
    handlers.set('ai:requirements', async (...args: unknown[]) => {
      const result = await original(...args);
      return new Promise((resolve) => {
        Reflect.set(globalThis, 'releaseRequirementsReply', () => resolve(result));
      });
    });
  });
  await answer.fill('WAIT 전송한 답변');
  await page.getByRole('button', { name: '답변·정정 보내기' }).click();
  await expect.poll(state).toBe('running');
  await expect
    .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'releaseRequirementsReply')))
    .toBe('function');
  await page.getByRole('button', { name: '이전 단계', exact: true }).click();
  await expect(page.getByRole('button', { name: 'AI로 요구분석 시작', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'AI로 요구분석 시작', exact: true }).click();
  await expect(answer).toBeEnabled();
  await answer.fill('복귀 후 새 초안');
  await app.evaluate(() => Reflect.get(globalThis, 'releaseRequirementsReply')());
  await expect(answer).toHaveValue('복귀 후 새 초안');
  await page.getByRole('button', { name: '실행 중단', exact: true }).click();
  await expect.poll(state, { timeout: 25000 }).toBe('interrupted');
  await expect(answer).toHaveValue('복귀 후 새 초안');
});
