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
  await page.getByRole('button', { name: '예시로 요구분석 시작' }).click();
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
