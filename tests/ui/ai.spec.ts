import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { _electron, type ElectronApplication, expect, type Page, test } from '@playwright/test';

let app: ElectronApplication;
let page: Page;
const errors: string[] = [];
const folder = resolve('.runtime', 'ui-ai-project');
const managerUrl = pathToFileURL(resolve('dist/desktop/electron/main.js')).href;

test.beforeEach(async () => {
  await mkdir(folder, { recursive: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
    ),
  ) as Record<string, string>;
  app = await _electron.launch({
    args: ['.', `--user-data-dir=${resolve('.runtime', `ai-ui-${randomUUID()}`)}`],
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
});
test.afterEach(async () => {
  await app?.close();
  expect(errors).toEqual([]);
});

async function fixture() {
  await app.evaluate(
    async (_electron, config) => {
      const require = process.getBuiltinModule('module').createRequire(config.managerUrl);
      const { aiSession } = require(config.managerUrl.replace('file:///', ''));
      // Trusted test runner injection; no test launch option or renderer backdoor in production.
      Object.assign(aiSession, {
        dependencies: {
          prepare: async (_cwd: string, prompt: string, conversation?: string) => ({
            file: config.node,
            args: [
              config.fixture,
              Buffer.from(JSON.stringify({ prompt, conversation })).toString('base64'),
            ],
            inspectHeader: true,
          }),
        },
      });
      aiSession.availabilityStatus = async () => ({
        status: 'ready',
        version: 'synthetic',
        message: '합성 CLI 검증: 실제 AI 호출 없음',
      });
    },
    { managerUrl, node: process.execPath, fixture: resolve('tests/fixtures/ai-cli.cjs') },
  );
}
async function openConversation() {
  await page.getByRole('button', { name: 'Codex 대화 열기', exact: true }).click();
  await page.getByRole('button', { name: '연결 준비 확인', exact: true }).click();
  await expect(page.getByRole('button', { name: '연결 준비 다시 확인' })).toBeEnabled();
}
async function session() {
  return app.evaluate(async (_electron, url) => {
    const require = process.getBuiltinModule('module').createRequire(url);
    const { aiSession } = require(url.replace('file:///', ''));
    return {
      state: aiSession.state.state,
      message: aiSession.state.message,
      cleaned: aiSession.state.cleanupConfirmed,
      diagnostic: aiSession.diagnostic,
      purpose: aiSession.state.purpose,
      goal: aiSession.state.requirementsGoal,
      conversation: aiSession.conversation,
      outputId: aiSession.output.id,
      output: aiSession.output.chunks.map((chunk: { data: string }) => chunk.data).join(''),
    };
  }, managerUrl);
}

test('AI 화면의 한글 입력·출력·중단·왕복과 종료 정리', async () => {
  test.setTimeout(90000);
  await fixture();
  await page.getByRole('checkbox', { name: 'Gemini', exact: true }).check();
  await openConversation();
  await page.getByRole('textbox', { name: 'Codex에게 보낼 메시지' }).fill('--help\n한글 첫 메시지');
  await page.getByRole('button', { name: '메시지 보내기' }).click();
  await expect.poll(async () => (await session()).state).toBe('running');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 800));
  await expect.poll(async () => (await session()).state, { timeout: 25000 }).toBe('exited');
  await expect.poll(async () => page.locator('.xterm-rows').innerText()).toContain('FIXTURE_REPLY');
  await mkdir(resolve('.runtime', 'screens'), { recursive: true });
  await page.screenshot({ path: resolve('.runtime', 'screens', '10-ai-conversation.png') });
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: 'AI로 요구분석 시작' }).click();
  await page.getByRole('button', { name: 'AI 대화', exact: true }).click();
  await expect.poll(async () => page.locator('.xterm-rows').innerText()).toContain('FIXTURE_REPLY');
  await page.getByRole('button', { name: '연결 준비 확인', exact: true }).click();
  await page.getByRole('textbox', { name: 'Codex에게 보낼 메시지' }).fill('WAIT 화면 이동');
  await page.getByRole('button', { name: '메시지 보내기' }).click();
  await expect.poll(async () => (await session()).state).toBe('running');
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '프로젝트 선택', exact: true }).click();
  await page.getByRole('button', { name: '폴더 변경', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('AI 실행을 중단');
  await page.getByRole('button', { name: 'AI 대화', exact: true }).click();
  await page.getByRole('button', { name: '실행 중단', exact: true }).click();
  await expect.poll(async () => (await session()).state, { timeout: 25000 }).toBe('interrupted');
  expect((await session()).cleaned).toBe(true);
});

async function openRequirements() {
  await page.getByRole('button', { name: 'AI로 요구분석 시작', exact: true }).click();
  await page.getByRole('button', { name: '연결 준비 확인', exact: true }).click();
  await expect(page.getByRole('button', { name: '연결 준비 다시 확인' })).toBeEnabled();
}

test('요구분석: 목표·답변·정정과 화면 복귀, 일반 대화 분리', async () => {
  test.setTimeout(120000);
  await fixture();
  await openRequirements();
  const goal = page.getByRole('textbox', { name: '만들고 싶은 서비스' });
  const answer = page.getByRole('textbox', { name: '질문에 대한 답변·정정 내용' });
  await goal.fill('학교 생활을 돕는 앱');
  await page.getByRole('button', { name: '목표 보내고 질문받기' }).click();
  await expect.poll(async () => (await session()).state, { timeout: 25000 }).toBe('exited');
  const initial = await session();
  expect(initial.purpose).toBe('requirements');
  expect(initial.output).toContain('학교 생활을 돕는 앱');
  await expect(page.getByRole('button', { name: '답변·정정 보내기' })).toBeDisabled();
  await answer.fill('학생만 쓰고 일정 알림부터 만들어요.');
  await page.getByRole('button', { name: '답변·정정 보내기' }).click();
  await expect.poll(async () => (await session()).state).toBe('running');
  await page.getByRole('button', { name: '이전 단계', exact: true }).click();
  await expect.poll(async () => (await session()).state, { timeout: 25000 }).toBe('exited');
  await openRequirements();
  await expect(answer).toHaveValue('');
  await expect(goal).toHaveValue('학교 생활을 돕는 앱');
  await goal.fill('학생의 과제 마감 알림 앱');
  await page.getByRole('button', { name: '목표 수정 보내기' }).click();
  await expect.poll(async () => (await session()).state, { timeout: 25000 }).toBe('exited');
  const revised = await session();
  expect(revised.conversation).toBe(initial.conversation);
  expect(revised.outputId).toBe(initial.outputId);
  expect(revised.goal).toBe('학생의 과제 마감 알림 앱');
  expect(revised.output).toContain('RESUMED');
  await page.getByRole('button', { name: 'AI 대화', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('textbox', { name: 'Codex에게 보낼 메시지' })).toBeDisabled();
  await expect(dialog.getByText('요구분석 대화가 열려 있어요.', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '기능 직접 정리하기' }).click();
  await expect(page.getByRole('heading', { name: '만들 기능을 직접 정리해요' })).toBeVisible();
  const plan = await page.evaluate(async () => {
    const catalog = await window.desktop?.listProjects();
    return catalog?.activeProjectId
      ? window.desktop?.loadFeaturePlan(catalog.activeProjectId)
      : null;
  });
  expect(plan?.ok && plan.plan.features).toEqual([]);
});

test('요구분석: 로그인 실패·사용 한도·취소는 입력을 보존하고 자동 재전송하지 않는다', async () => {
  test.setTimeout(120000);
  await fixture();
  await app.evaluate(async (_electron, url) => {
    const require = process.getBuiltinModule('module').createRequire(url);
    const { aiSession } = require(url.replace('file:///', ''));
    aiSession.availabilityStatus = async () => ({
      status: 'login-required',
      message: '합성: Codex 로그인이 필요해요.',
    });
  }, managerUrl);
  await openRequirements();
  const goal = page.getByRole('textbox', { name: '만들고 싶은 서비스' });
  const answer = page.getByRole('textbox', { name: '질문에 대한 답변·정정 내용' });
  await goal.fill('어떤 앱을 만들지 정하고 싶어요');
  await expect(page.getByRole('button', { name: '목표 보내고 질문받기' })).toBeDisabled();
  await expect(page.getByText('합성: Codex 로그인이 필요해요.')).toBeVisible();
  expect((await session()).state).toBe('idle');
  await fixture();
  await page.getByRole('button', { name: '연결 준비 다시 확인' }).click();
  await page.getByRole('button', { name: '목표 보내고 질문받기' }).click();
  await expect.poll(async () => (await session()).state, { timeout: 25000 }).toBe('exited');
  await answer.fill('RATE_LIMIT 답변 보존');
  await page.getByRole('button', { name: '답변·정정 보내기' }).click();
  await expect.poll(async () => (await session()).state, { timeout: 25000 }).toBe('error');
  await expect(answer).toHaveValue('RATE_LIMIT 답변 보존');
  expect((await session()).output).toContain('사용 한도에 도달했어요');
  expect((await session()).cleaned).toBe(true);
  await answer.fill('WAIT 취소할 답변');
  await page.getByRole('button', { name: '답변·정정 보내기' }).click();
  await expect.poll(async () => (await session()).state).toBe('running');
  await page.getByRole('button', { name: '실행 중단', exact: true }).click();
  await expect.poll(async () => (await session()).state, { timeout: 25000 }).toBe('interrupted');
  await expect(answer).toHaveValue('WAIT 취소할 답변');
  expect((await session()).cleaned).toBe(true);
  await answer.fill('고친 답변');
  await page.getByRole('button', { name: '답변·정정 보내기' }).click();
  await expect.poll(async () => (await session()).state).toBe('running');
  await answer.fill('전송 대기 중 새로 쓴 답변');
  await expect.poll(async () => (await session()).state, { timeout: 25000 }).toBe('exited');
  await expect(answer).toHaveValue('전송 대기 중 새로 쓴 답변');
  await expect(page.getByText(/남은.*사용량·비용은 이 앱에서 확인하지 못해요/)).toBeVisible();
});

test('요구분석: 목표 수정의 실행 준비 실패 후에는 목표 재전송을 먼저 요구한다', async () => {
  test.setTimeout(90000);
  await fixture();
  await openRequirements();
  const goal = page.getByRole('textbox', { name: '만들고 싶은 서비스' });
  const answer = page.getByRole('textbox', { name: '질문에 대한 답변·정정 내용' });
  await goal.fill('기존 목표');
  await page.getByRole('button', { name: '목표 보내고 질문받기' }).click();
  await expect.poll(async () => (await session()).state, { timeout: 25000 }).toBe('exited');
  await app.evaluate(async (_electron, url) => {
    const require = process.getBuiltinModule('module').createRequire(url);
    const { aiSession } = require(url.replace('file:///', ''));
    const prepare = aiSession.dependencies.prepare;
    aiSession.dependencies.prepare = async () => {
      aiSession.dependencies.prepare = prepare;
      throw new Error('LOGIN_NOT_READY');
    };
  }, managerUrl);
  await goal.fill('새로운 목표');
  await page.getByRole('button', { name: '목표 수정 보내기' }).click();
  await expect.poll(async () => (await session()).state).toBe('error');
  await answer.fill('변경한 목표의 답변');
  await expect(
    page.getByText('목표 요청이 끝나지 않았어요. 목표를 다시 보내 질문을 받은 뒤 답변해 주세요.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '답변·정정 보내기' })).toBeDisabled();
  const rejected = await page.evaluate(async () => {
    const bridge = window.desktop;
    const catalog = await bridge?.listProjects();
    if (!bridge || !catalog?.activeProjectId) throw new Error('project missing');
    const id = catalog.activeProjectId;
    const state = await bridge.readAISession(id, 0, null);
    if ('connectionError' in state) throw new Error('connection missing');
    return bridge.sendRequirementsPrompt(
      id,
      'answer',
      '직접 요청도 거부',
      state.outputId,
      state.id,
    );
  });
  expect(rejected.ok).toBe(false);
  await page.getByRole('button', { name: '목표 수정 보내기' }).click();
  await expect.poll(async () => (await session()).state, { timeout: 25000 }).toBe('exited');
  await expect(answer).toHaveValue('변경한 목표의 답변');
  await expect(page.getByRole('button', { name: '답변·정정 보내기' })).toBeEnabled();
  await mkdir(resolve('.runtime', 'screens'), { recursive: true });
  await page.screenshot({
    path: resolve('.runtime', 'screens', '19-t009-requirements.png'),
    fullPage: true,
  });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(500, 600);
    window.setSize(560, 840);
  });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.screenshot({
    path: resolve('.runtime', 'screens', '20-t009-requirements-narrow.png'),
    fullPage: true,
  });
});

test('AI IPC는 임의 프로젝트·인자·iframe을 거부한다', async () => {
  const results = await page.evaluate(async () => {
    const bridge = window.desktop;
    if (!bridge) throw new Error('bridge missing');
    const fake = '12345678-1234-4234-8234-123456789012';
    return [
      await bridge.sendAIPrompt(fake, 'hello', null, null),
      await bridge.sendAIPrompt('../../', '--help', null, null),
      await bridge.resizeAISession(fake, 1000000, 1),
      await bridge.stopAISession(fake, fake),
    ];
  });
  expect(results.every((result) => !result.ok)).toBe(true);
  const invalidFrame = await app.evaluate(async ({ BrowserWindow, ipcMain }) => {
    const handler = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
      }
    )._invokeHandlers.get('ai:submit');
    if (!handler) throw new Error('handler missing');
    return handler(
      { sender: BrowserWindow.getAllWindows()[0].webContents, senderFrame: null },
      '12345678-1234-4234-8234-123456789012',
      'hello',
    );
  });
  expect(invalidFrame).toMatchObject({ ok: false });
  expect((await session()).state).toBe('idle');
});

test('앱 내부 연결 끊김·다시 연결과 실패한 화면 크기 재적용', async () => {
  await fixture();
  await openConversation();
  await page.getByRole('textbox', { name: 'Codex에게 보낼 메시지' }).fill('보존할 한글 입력');
  await expect(page.getByRole('button', { name: '메시지 보내기' })).toBeEnabled();
  await app.evaluate(async (_electron, url) => {
    const require = process.getBuiltinModule('module').createRequire(url);
    const { LocalApiClient } = require(
      process.getBuiltinModule('url').fileURLToPath(new URL('./local-api/client.js', url)),
    );
    const originalRead = LocalApiClient.prototype.readSession;
    const originalCommand = LocalApiClient.prototype.command;
    const originalReconnect = LocalApiClient.prototype.reconnect;
    const interrupted = new Set<object>();
    let failResize = true;
    const resizeTrace = { armed: false, failed: null as unknown, applied: null as unknown };
    LocalApiClient.prototype.testResizeTrace = resizeTrace;
    LocalApiClient.prototype.readSession = async function (...args: unknown[]) {
      if (!interrupted.has(this)) {
        interrupted.add(this);
        this.socket?.terminate();
        this.fatal = true;
      }
      return originalRead.apply(this, args);
    };
    LocalApiClient.prototype.command = async function (...args: unknown[]) {
      if (args[1] === 'resize' && failResize && resizeTrace.armed) {
        failResize = false;
        resizeTrace.failed = args[2];
        return { ok: false, message: '합성: 크기 변경 응답 1회 실패' };
      }
      const result = await originalCommand.apply(this, args);
      if (args[1] === 'resize' && result.ok && resizeTrace.failed) resizeTrace.applied = args[2];
      return result;
    };
    LocalApiClient.prototype.reconnect = function () {
      LocalApiClient.prototype.readSession = originalRead;
      LocalApiClient.prototype.reconnect = originalReconnect;
      return originalReconnect.call(this);
    };
  }, managerUrl);
  await expect(page.getByRole('button', { name: '다시 연결', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '메시지 보내기' })).toBeDisabled();
  await mkdir(resolve('.runtime', 'screens'), { recursive: true });
  await page.screenshot({ path: resolve('.runtime', 'screens', '12-api-reconnect.png') });
  await page.getByRole('button', { name: '다시 연결', exact: true }).click();
  await expect(page.getByRole('button', { name: '메시지 보내기' })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Codex에게 보낼 메시지' })).toHaveValue(
    '보존할 한글 입력',
  );
  await expect(page.getByRole('button', { name: '다시 연결', exact: true })).toHaveCount(0);
  // Arm after the reconnect notice has disappeared so both attempts use the same layout.
  await app.evaluate(async ({ BrowserWindow }, url) => {
    const require = process.getBuiltinModule('module').createRequire(url);
    const { LocalApiClient } = require(
      process.getBuiltinModule('url').fileURLToPath(new URL('./local-api/client.js', url)),
    );
    LocalApiClient.prototype.testResizeTrace.armed = true;
    BrowserWindow.getAllWindows()[0].setSize(1050, 760);
  }, managerUrl);
  await expect
    .poll(async () =>
      app.evaluate(async (_electron, url) => {
        const require = process.getBuiltinModule('module').createRequire(url);
        const { aiSession } = require(url.replace('file:///', ''));
        const { LocalApiClient } = require(
          process.getBuiltinModule('url').fileURLToPath(new URL('./local-api/client.js', url)),
        );
        const trace = LocalApiClient.prototype.testResizeTrace;
        return Boolean(
          trace.failed &&
            trace.applied &&
            trace.failed.cols === trace.applied.cols &&
            trace.failed.rows === trace.applied.rows &&
            aiSession.cols === trace.applied.cols &&
            aiSession.rows === trace.applied.rows,
        );
      }, managerUrl),
    )
    .toBe(true);
  const projects = await page.evaluate(() => window.desktop?.listProjects());
  expect(projects?.storage).toBe('sqlite');
  expect(projects?.projects).toHaveLength(1);
});

test('크기 응답 대기 중 연속 변경해도 마지막 터미널 크기가 반영된다', async () => {
  await fixture();
  await openConversation();
  await expect(page.getByRole('button', { name: '연결 준비 다시 확인' })).toBeEnabled();
  await page.locator('.ai-terminal').evaluate((element) => {
    element.style.width = '600px';
  });
  await expect
    .poll(() => page.locator('.xterm-screen').evaluate((element) => element.clientWidth))
    .toBeLessThan(600);
  // Let the initial fit/IPC finish before delaying the next user resize.
  await page.waitForTimeout(400);
  await app.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get('ai:resize');
    if (!original) throw new Error('AI resize handler missing');
    const trace = { calls: [] as number[][], release: () => {} };
    Reflect.set(globalThis, 'pendingResizeTrace', trace);
    handlers.set('ai:resize', async (...args: unknown[]) => {
      trace.calls.push([Number(args[2]), Number(args[3])]);
      if (trace.calls.length === 1) await new Promise<void>((resolve) => (trace.release = resolve));
      return original(...args);
    });
  });
  await page.locator('.ai-terminal').evaluate((element) => {
    element.style.width = '560px';
  });
  await expect
    .poll(() => app.evaluate(() => Reflect.get(globalThis, 'pendingResizeTrace').calls.length))
    .toBe(1);
  const firstCols = await app.evaluate(
    () => Reflect.get(globalThis, 'pendingResizeTrace').calls[0][0],
  );
  const firstWidth = await page.locator('.xterm-screen').evaluate((element) => element.clientWidth);
  await page.locator('.ai-terminal').evaluate((element) => {
    element.style.width = '320px';
  });
  await expect
    .poll(() => page.locator('.xterm-screen').evaluate((element) => element.clientWidth))
    .toBeLessThan(firstWidth * 0.7);
  await page.locator('.ai-terminal').evaluate((element) => {
    element.style.width = '480px';
  });
  await expect
    .poll(() => page.locator('.xterm-screen').evaluate((element) => element.clientWidth))
    .toBeGreaterThan(firstWidth * 0.7);
  const finalWidth = await page.locator('.xterm-screen').evaluate((element) => element.clientWidth);
  const expectedCols = Math.round((finalWidth * firstCols) / firstWidth);
  expect(expectedCols).toBeLessThan(firstCols);
  expect(await app.evaluate(() => Reflect.get(globalThis, 'pendingResizeTrace').calls.length)).toBe(
    1,
  );
  await app.evaluate(() => Reflect.get(globalThis, 'pendingResizeTrace').release());
  await expect
    .poll(() =>
      app.evaluate(async (_electron, url) => {
        const require = process.getBuiltinModule('module').createRequire(url);
        return require(url.replace('file:///', '')).aiSession.cols;
      }, managerUrl),
    )
    .toBe(expectedCols);
});

test('전송 전의 늦은 상태 응답은 새 실행 표시를 되돌리지 않는다', async () => {
  await fixture();
  await openConversation();
  await page.getByRole('textbox', { name: 'Codex에게 보낼 메시지' }).fill('순서 검사');
  await expect(page.getByRole('button', { name: '메시지 보내기' })).toBeEnabled();
  await app.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get('ai:read');
    if (!original) throw new Error('AI read handler missing');
    let captured = false;
    handlers.set('ai:submit', () => ({ ok: true }));
    handlers.set('ai:read', async (...args: unknown[]) => {
      const value = await original(...args);
      return new Promise((resolve) => {
        const key = captured ? 'releaseFreshAIRead' : 'releaseStaleAIRead';
        captured = true;
        Reflect.set(globalThis, key, () => resolve(value));
      });
    });
    Reflect.set(globalThis, 'restoreAIRead', () => handlers.set('ai:read', original));
  });
  await expect
    .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'releaseStaleAIRead')))
    .toBe('function');
  await page.getByRole('button', { name: '메시지 보내기' }).click();
  await expect(page.locator('.ai-run-status')).toContainText('Codex 실행을 준비');
  await app.evaluate(() => Reflect.get(globalThis, 'releaseStaleAIRead')());
  await expect
    .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'releaseFreshAIRead')))
    .toBe('function');
  await expect(page.locator('.ai-run-status')).toContainText('Codex 실행을 준비');
  await expect(page.getByRole('button', { name: '실행 중단', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '메시지 보내기' })).toHaveCount(0);
  await app.evaluate(() => {
    Reflect.get(globalThis, 'restoreAIRead')();
    Reflect.get(globalThis, 'releaseFreshAIRead')();
  });
  await expect(page.getByRole('button', { name: '메시지 보내기' })).toBeVisible();
});

test('실제 Codex 연결: 중단·앱 종료', async () => {
  test.skip(
    process.env.ORBIT_LIVE_AI !== '1',
    '실제 계정·네트워크 호출은 명시한 검증 명령에서만 실행',
  );
  test.setTimeout(120000);
  await openConversation();
  const prompt =
    '파일 접근·도구·명령 실행을 하지 마세요. 1부터 1000까지 각 숫자의 제곱을 한 줄씩 직접 나열해 주세요.';
  await page.getByRole('textbox', { name: 'Codex에게 보낼 메시지' }).fill(prompt);
  await page.getByRole('button', { name: '메시지 보내기' }).click();
  await expect
    .poll(async () => (await session()).output, { timeout: 30000 })
    .toContain('session id:');
  await page.getByRole('button', { name: '실행 중단', exact: true }).click();
  await expect.poll(async () => (await session()).state, { timeout: 30000 }).toBe('interrupted');
  const stopped = await session();
  expect(stopped.cleaned).toBe(true);
  await expect(page.getByRole('button', { name: '메시지 보내기' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Codex에게 보낼 메시지' }).fill(prompt);
  await page.getByRole('button', { name: '메시지 보내기' }).click();
  await expect.poll(async () => (await session()).state, { timeout: 30000 }).toBe('running');
  const ownedPids = await app.evaluate(async (_electron, url) => {
    const require = process.getBuiltinModule('module').createRequire(url);
    const auditPath = process
      .getBuiltinModule('url')
      .fileURLToPath(new URL('./ai/process-audit.js', url));
    const rows = await require(auditPath).processSnapshot();
    const owned = new Set<number>([process.pid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of rows)
        if (owned.has(row.parent) && !owned.has(row.pid)) {
          owned.add(row.pid);
          grew = true;
        }
    }
    return [...owned];
  }, managerUrl);
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close();
  });
  await closed;
  const pidList = ownedPids
    .map((pid) => {
      if (!Number.isSafeInteger(pid)) throw new Error('invalid pid');
      return pid;
    })
    .join(',');
  const script = `$ids=@(${pidList}); $p=@(Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId }); $c=@(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess }); @{processes=$p.Count; connections=$c.Count} | ConvertTo-Json -Compress`;
  const result = await promisify(execFile)(
    `${process.env.SystemRoot}/System32/WindowsPowerShell/v1.0/powershell.exe`,
    ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15000 },
  );
  const residue = JSON.parse(result.stdout);
  expect(residue).toEqual({ processes: 0, connections: 0 });
  const evidence = {
    kind: 'LIVE_CODEX_APP_STOP_AND_CLOSE',
    stopState: stopped.state,
    cleanupConfirmed: stopped.cleaned,
    explicitInterruptObserved: /turn interrupted/u.test(stopped.output),
    diagnostic: stopped.diagnostic,
    appCloseObserved: true,
    residue,
    observedPidCount: ownedPids.length,
  };
  await mkdir(resolve('.runtime', 'ai-evidence'), { recursive: true });
  await writeFile(
    resolve('.runtime', 'ai-evidence', 'live-stop.json'),
    JSON.stringify(evidence, null, 2),
  );
});

test('실제 Codex 연결: 한글 응답·정확한 대화 재개', async () => {
  test.skip(
    process.env.ORBIT_LIVE_AI !== '1',
    '실제 계정·네트워크 호출은 명시한 검증 명령에서만 실행',
  );
  test.setTimeout(180000);
  await openConversation();
  await expect(page.getByText(/Codex 설치와 ChatGPT 로그인을 확인/)).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Codex에게 보낼 메시지' })
    .fill(
      '파일 접근·도구·명령 실행을 하지 마세요. ORBIT 연결 확인입니다. 단어 한글과 숫자 31 더하기 16의 결과를 세로줄로 이어서 한 줄만 응답하세요.',
    );
  await page.getByRole('button', { name: '메시지 보내기' }).click();
  await expect.poll(async () => (await session()).state, { timeout: 120000 }).toBe('exited');
  expect((await session()).output).toMatch(/한글\s*\|\s*47/u);
  expect((await session()).cleaned).toBe(true);
  await page
    .getByRole('textbox', { name: 'Codex에게 보낼 메시지' })
    .fill(
      '파일 접근·도구·명령 실행을 하지 마세요. 앞선 요청에서 더한 두 숫자를 작은 수부터 세로줄로 이어서 한 줄만 응답하세요.',
    );
  await page.getByRole('button', { name: '메시지 보내기' }).click();
  await expect.poll(async () => (await session()).state, { timeout: 120000 }).toBe('exited');
  expect((await session()).output).toMatch(/16\s*\|\s*31/u);
  expect((await session()).cleaned).toBe(true);
  await page.screenshot({ path: resolve('.runtime', 'screens', '11-ai-live-codex.png') });
});
