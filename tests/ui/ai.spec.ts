import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';
import { _electron, type ElectronApplication, expect, type Page, test } from '@playwright/test';

let app: ElectronApplication;
let page: Page;
let appClosed = false;
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
  appClosed = false;
  app.on('close', () => {
    appClosed = true;
  });
  page = await app.firstWindow();
  await app.evaluate(async (_electron, url) => {
    const require = process.getBuiltinModule('module').createRequire(url);
    const { aiSession } = require(url.replace('file:///', ''));
    const auditPath = process
      .getBuiltinModule('url')
      .fileURLToPath(new URL('./ai/process-audit.js', url));
    const { processSnapshot } = require(auditPath);
    const metrics = { count: 0, elapsedMs: 0, maxMs: 0 };
    Reflect.set(globalThis, 'auditMeasurement', metrics);
    aiSession.dependencies.snapshot = async () => {
      const start = performance.now();
      try {
        const rows = await processSnapshot();
        Reflect.set(globalThis, 'latestAuditRows', rows);
        return rows;
      } finally {
        const elapsed = performance.now() - start;
        metrics.count++;
        metrics.elapsedMs += elapsed;
        metrics.maxMs = Math.max(metrics.maxMs, elapsed);
      }
    };
  }, managerUrl);
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
  const info = test.info();
  if (app && !appClosed) {
    const metrics = await app
      .evaluate(() => Reflect.get(globalThis, 'auditMeasurement'))
      .catch(() => null);
    if (metrics) {
      await mkdir(resolve('.runtime', 'ai-evidence'), { recursive: true });
      await writeFile(
        resolve('.runtime', 'ai-evidence', `audit-${Date.now()}.json`),
        JSON.stringify({ title: info.title, status: info.status, metrics }, null, 2),
      );
    }
  }
  if (app && !appClosed) await app.close();
  expect(errors).toEqual([]);
});

async function fixture(generationMode = 'valid') {
  await app.evaluate(
    async (_electron, config) => {
      const require = process.getBuiltinModule('module').createRequire(config.managerUrl);
      const { aiSession } = require(config.managerUrl.replace('file:///', ''));
      // Trusted test runner injection; no test launch option or renderer backdoor in production.
      Object.assign(aiSession, {
        dependencies: {
          snapshot: aiSession.dependencies.snapshot,
          prepare: async (
            _cwd: string,
            prompt: string,
            conversation?: string,
            resultFile?: string,
          ) => ({
            file: config.node,
            args: [
              config.fixture,
              Buffer.from(
                JSON.stringify({
                  prompt,
                  conversation,
                  resultFile,
                  generationMode: config.generationMode,
                }),
              ).toString('base64'),
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
    {
      managerUrl,
      node: process.execPath,
      fixture: resolve('tests/fixtures/ai-cli.cjs'),
      generationMode,
    },
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
      runId: aiSession.state.id,
      state: aiSession.state.state,
      message: aiSession.state.message,
      cleaned: aiSession.state.cleanupConfirmed,
      diagnostic: aiSession.diagnostic,
      purpose: aiSession.state.purpose,
      goal: aiSession.state.requirementsGoal,
      conversation: aiSession.conversation,
      outputId: aiSession.output.id,
      generationState: aiSession.state.generationState,
      generatedPlan: aiSession.state.generatedPlan,
      output: aiSession.output.chunks.map((chunk: { data: string }) => chunk.data).join(''),
    };
  }, managerUrl);
}

test('AI 화면의 한글 입력·출력·중단·왕복과 종료 정리', async () => {
  test.setTimeout(90000);
  await fixture();
  const dialog = page.getByRole('dialog', { name: 'Codex와 대화' });
  await page.getByRole('checkbox', { name: 'Gemini', exact: true }).check();
  await openConversation();
  await dialog
    .getByRole('textbox', { name: 'Codex에게 보낼 메시지' })
    .fill('--help\n한글 첫 메시지');
  await dialog.getByRole('button', { name: '메시지 보내기' }).click();
  await expect.poll(async () => (await session()).state).toBe('running');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 800));
  await expect.poll(async () => (await session()).state, { timeout: 25000 }).toBe('exited');
  await expect
    .poll(async () => dialog.locator('.xterm-rows').innerText())
    .toContain('FIXTURE_REPLY');
  await mkdir(resolve('.runtime', 'screens'), { recursive: true });
  await page.screenshot({ path: resolve('.runtime', 'screens', '10-ai-conversation.png') });
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: 'AI로 요구분석 시작' }).click();
  await page.getByRole('button', { name: 'AI 대화', exact: true }).click();
  await expect
    .poll(async () => dialog.locator('.xterm-rows').innerText())
    .toContain('FIXTURE_REPLY');
  await dialog.getByRole('button', { name: '연결 준비 확인', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Codex에게 보낼 메시지' }).fill('WAIT 화면 이동');
  await dialog.getByRole('button', { name: '메시지 보내기' }).click();
  await expect.poll(async () => (await session()).state).toBe('running');
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '프로젝트 선택', exact: true }).click();
  await page.getByRole('button', { name: '폴더 변경', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('AI 실행을 중단');
  await page.getByRole('button', { name: 'AI 대화', exact: true }).click();
  await dialog.getByRole('button', { name: '실행 중단', exact: true }).click();
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
  await expect(dialog.getByText('다른 목적의 대화가 열려 있어요.', { exact: false })).toBeVisible();
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

async function savedPlan() {
  return page.evaluate(async () => {
    const bridge = window.desktop;
    const id = (await bridge?.listProjects())?.activeProjectId;
    if (!bridge || !id) throw new Error('project missing');
    const result = await bridge.loadFeaturePlan(id);
    if (!result.ok) throw new Error(result.message);
    return result.plan;
  });
}

test('기능 생성: 잘못된 응답·편집·저장 실패·재시도와 기존 목록 보존', async () => {
  test.setTimeout(140000);
  await fixture('invalid');
  await openRequirements();
  await page.getByRole('textbox', { name: '만들고 싶은 서비스' }).fill('개인 과제 관리');
  await page.getByRole('button', { name: '목표 보내고 질문받기' }).click();
  await expect.poll(async () => (await session()).state, { timeout: 25000 }).toBe('exited');
  const original = await savedPlan();
  await page.getByRole('button', { name: '대화로 기능 초안 만들기', exact: true }).click();
  await expect
    .poll(async () => (await session()).generationState, { timeout: 25000 })
    .toBe('error');
  expect(await savedPlan()).toEqual(original);
  await expect(page.getByRole('heading', { name: '기능 초안 미리보기' })).toHaveCount(0);
  await fixture();
  await page.getByRole('button', { name: '대화로 기능 초안 만들기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '기능 초안 미리보기' })).toBeVisible({
    timeout: 25000,
  });
  const firstDraft = await session();
  await page.getByRole('button', { name: '초안 취소', exact: true }).click();
  await expect(page.getByRole('heading', { name: '기능 초안 미리보기' })).toHaveCount(0);
  await page.getByRole('button', { name: '대화로 기능 초안 만들기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '기능 초안 미리보기' })).toBeVisible({
    timeout: 25000,
  });
  const regenerated = await session();
  expect(regenerated.conversation).toBe(firstDraft.conversation);
  expect(regenerated.outputId).toBe(firstDraft.outputId);
  expect(regenerated.runId).not.toBe(firstDraft.runId);
  expect(await savedPlan()).toEqual(original);
  await page.getByRole('button', { name: '과제 등록 초안 수정' }).click();
  await page.getByRole('textbox', { name: '기능 이름', exact: true }).fill('마감일 있는 과제 등록');
  await page
    .getByRole('textbox', { name: '완료 조건', exact: true })
    .fill('이름과 마감일을 저장하고 다시 열어 확인한다.');
  await page.getByRole('button', { name: '초안에 반영', exact: true }).click();
  await app.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers;
    const key = 'features:save';
    const original = handlers.get(key);
    if (!original) throw new Error('save handler missing');
    handlers.set(key, () => {
      handlers.set(key, original);
      return { ok: false, message: '합성 저장 실패: 초안 유지' };
    });
  });
  await page.getByRole('button', { name: '초안 적용', exact: true }).click();
  await expect(
    page.getByText('초안을 저장하지 못했어요. 기존 기능과 입력은 유지했어요. 다시 시도해 주세요.'),
  ).toBeVisible();
  expect(await savedPlan()).toEqual(original);
  await expect(page.getByRole('heading', { name: '마감일 있는 과제 등록' })).toBeVisible();
  await mkdir(resolve('.runtime', 'screens'), { recursive: true });
  await page.screenshot({
    path: resolve('.runtime', 'screens', '21-t010-draft.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: '초안 적용', exact: true }).click();
  await expect.poll(async () => (await savedPlan()).features.length).toBe(1);
  const saved = await savedPlan();
  expect(saved.features[0].title).toBe('마감일 있는 과제 등록');
  expect(saved.verifications).toEqual([]);
  await page.getByRole('button', { name: '요구분석으로 돌아가기', exact: true }).click();
  await fixture('invalid');
  await page.getByRole('button', { name: '대화로 기능 초안 만들기', exact: true }).click();
  await expect
    .poll(async () => (await session()).generationState, { timeout: 25000 })
    .toBe('error');
  expect(await savedPlan()).toEqual(saved);
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  await app.close();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
    ),
  ) as Record<string, string>;
  app = await _electron.launch({ args: ['.', `--user-data-dir=${userData}`], env });
  appClosed = false;
  app.on('close', () => {
    appClosed = true;
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.desktop));
  expect(await savedPlan()).toEqual(saved);
});

test('기능 생성: 중단·오래된 초안 적용 차단·취소는 저장하지 않는다', async () => {
  test.setTimeout(120000);
  await fixture('wait');
  await openRequirements();
  await page.getByRole('textbox', { name: '만들고 싶은 서비스' }).fill('과제 관리');
  await page.getByRole('button', { name: '목표 보내고 질문받기' }).click();
  await expect.poll(async () => (await session()).state, { timeout: 25000 }).toBe('exited');
  const original = await savedPlan();
  await page.getByRole('button', { name: '대화로 기능 초안 만들기', exact: true }).click();
  await expect.poll(async () => (await session()).state).toBe('running');
  await expect(
    page.getByRole('button', { name: '기능 초안 만드는 중', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '실행 중단', exact: true }).click();
  await expect.poll(async () => (await session()).state, { timeout: 25000 }).toBe('interrupted');
  expect((await session()).generationState).toBe('error');
  expect((await session()).cleaned).toBe(true);
  await fixture();
  await page.getByRole('button', { name: '대화로 기능 초안 만들기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '기능 초안 미리보기' })).toBeVisible({
    timeout: 25000,
  });
  await page
    .getByRole('textbox', { name: '질문에 대한 답변·정정 내용' })
    .fill('다음 요청에서 과제 삭제도 포함해 주세요.');
  await page.getByRole('button', { name: '답변·정정 보내기' }).click();
  await expect.poll(async () => (await session()).state, { timeout: 25000 }).toBe('exited');
  await expect(
    page.getByText('대화가 바뀌었어요. 이 초안을 취소하고 최신 대화로 다시 만들어 주세요.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '처리 중…', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '이전 대화의 초안 취소' }).click();
  await expect(page.getByRole('heading', { name: '기능 초안 미리보기' })).toHaveCount(0);
  expect(await savedPlan()).toEqual(original);
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
      await bridge.generateFeatureDraft(fake, null, null),
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

test('실제 Codex 연결: 요구분석 질문·답변 정정·기능 초안', async () => {
  test.skip(process.env.ORBIT_LIVE_AI !== '1', '실제 계정 검사는 명시한 명령에서만 실행');
  test.setTimeout(360000);
  await openRequirements();
  await page
    .getByRole('textbox', { name: '만들고 싶은 서비스' })
    .fill(
      '개인이 과제 이름과 마감일을 저장하고 목록에서 확인하는 작은 앱. 계정과 공유 기능은 필요 없다.',
    );
  await page.getByRole('button', { name: '목표 보내고 질문받기' }).click();
  await expect.poll(async () => (await session()).state, { timeout: 120000 }).toBe('exited');
  const first = await session();
  const response =
    stripVTControlCharacters(first.output)
      .split(/\r?\ncodex\r?\n/u)
      .at(-1) ?? '';
  expect(response).not.toBe(stripVTControlCharacters(first.output));
  expect(response).toMatch(/[?？]/u);
  await page
    .getByRole('textbox', { name: '질문에 대한 답변·정정 내용' })
    .fill(
      '답변과 정정입니다. Windows에서 혼자 사용하고 로컬에 저장합니다. 마감일은 필수이고 알림과 검색은 제외합니다. 등록과 목록 표시 두 기능만 먼저 만듭니다. 이 내용으로 요구사항을 확정합니다.',
    );
  await page.getByRole('button', { name: '답변·정정 보내기' }).click();
  await expect.poll(async () => (await session()).state, { timeout: 120000 }).toBe('exited');
  expect((await session()).conversation).toBe(first.conversation);
  await expect(page.getByRole('textbox', { name: '질문에 대한 답변·정정 내용' })).toHaveValue('');
  await page.getByRole('button', { name: '대화로 기능 초안 만들기', exact: true }).click();
  await expect.poll(async () => (await session()).state, { timeout: 120000 }).toBe('exited');
  const generated = await session();
  expect(generated.cleaned).toBe(true);
  expect(generated.generationState).toBe('ready');
  expect(generated.generatedPlan?.features.length).toBeGreaterThan(0);
  expect(generated.generatedPlan?.verifications).toEqual([]);
  await expect(page.getByRole('heading', { name: '기능 초안 미리보기' })).toBeVisible();
  expect((await savedPlan()).features).toEqual([]);
  await mkdir(resolve('.runtime', 'ai-evidence'), { recursive: true });
  await writeFile(
    resolve('.runtime', 'ai-evidence', 'live-requirements-generation.json'),
    JSON.stringify(
      {
        kind: 'LIVE_REQUIREMENTS_AND_GENERATION',
        firstQuestion: response,
        conversationResumed: generated.conversation === first.conversation,
        cleanupConfirmed: generated.cleaned,
        diagnostic: generated.diagnostic,
        plan: generated.generatedPlan,
        savedBeforeApply: false,
      },
      null,
      2,
    ),
  );
  await mkdir(resolve('.runtime', 'screens'), { recursive: true });
  await page.screenshot({
    path: resolve('.runtime', 'screens', '22-t010-live.png'),
    fullPage: true,
  });
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
  await expect
    .poll(() =>
      app.evaluate(async (_electron, url) => {
        const require = process.getBuiltinModule('module').createRequire(url);
        const { aiSession } = require(url.replace('file:///', ''));
        return (Reflect.get(globalThis, 'latestAuditRows') ?? []).some(
          (row: { pid: number }) => row.pid === aiSession.host?.pid,
        );
      }, managerUrl),
    )
    .toBe(true);
  const ownedPids = await app.evaluate(async () => {
    // Reuse the application's observation: an extra concurrent CIM query would create
    // an unexpected sibling PowerShell/console inside the very tree being audited.
    const rows = Reflect.get(globalThis, 'latestAuditRows') as { pid: number; parent: number }[];
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
  const failureFile = resolve('.runtime', 'ai-evidence', `shutdown-warning-${randomUUID()}.json`);
  await mkdir(resolve('.runtime', 'ai-evidence'), { recursive: true });
  await app.evaluate(
    async ({ dialog }, config) => {
      const require = process.getBuiltinModule('module').createRequire(config.managerUrl);
      const { aiSession } = require(config.managerUrl.replace('file:///', ''));
      dialog.showMessageBox = async () => {
        await process.getBuiltinModule('fs/promises').writeFile(
          config.failureFile,
          JSON.stringify(
            {
              state: aiSession.state,
              diagnostic: aiSession.diagnostic,
            },
            null,
            2,
          ),
        );
        // Close only this test app; the assertion below still fails if cleanup was uncertain.
        return { response: 1, checkboxChecked: false };
      };
    },
    { managerUrl, failureFile },
  );
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => {
    // Return the automation reply before asking the app to close its transport.
    setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 100);
  });
  await closed;
  const shutdownWarning = await readFile(failureFile, 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  expect(shutdownWarning, '앱 정리 경고가 발생하면 종료 검사는 실패로 남긴다.').toBeNull();
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
