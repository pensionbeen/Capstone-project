import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { emptyAISnapshot } from '../../shared/ai';
import type { ProjectFeaturePlan } from '../../shared/feature-plan';

// Browser + mock bridge: these tests never run a CLI or change the real project database.
test.use({ channel: 'chrome' });
let server: ChildProcess;
const origin = 'http://127.0.0.1:5191';
const projectId = '00000000-0000-4000-8000-000000000001';
const firstId = '00000000-0000-4000-8000-000000000002';
const secondId = '00000000-0000-4000-8000-000000000003';
const plan: ProjectFeaturePlan = {
  features: [
    {
      id: firstId,
      title: '알림 보내기',
      description: '학생에게 알림을 보여요.',
      criteria: '알림이 표시된다.',
      revision: 1,
      included: true,
      kind: 'leaf',
      parentId: null,
      order: 0,
      relatedPaths: ['src/notify.ts'],
    },
    {
      id: secondId,
      title: '일정 찾기',
      description: '등록한 일정을 찾아요.',
      criteria: '검색한 일정이 표시된다.',
      revision: 1,
      included: true,
      kind: 'leaf',
      parentId: null,
      order: 1,
      relatedPaths: [`src/${'긴관련경로'.repeat(30)}.ts`],
    },
    {
      id: '00000000-0000-4000-8000-000000000004',
      title: '준비 묶음',
      description: '',
      criteria: '',
      revision: 1,
      included: true,
      kind: 'group',
      parentId: null,
      order: 2,
    },
    {
      id: '00000000-0000-4000-8000-000000000005',
      title: '보류 기능',
      description: '',
      criteria: '나중에 확인한다.',
      revision: 1,
      included: false,
      kind: 'leaf',
      parentId: null,
      order: 3,
    },
  ],
  dependencies: [],
  verifications: [],
};

test.beforeAll(async () => {
  await mkdir(resolve('.runtime/screens'), { recursive: true });
  server = spawn(
    process.execPath,
    [
      resolve('node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      '5191',
      '--strictPort',
    ],
    { cwd: process.cwd(), windowsHide: true, stdio: 'ignore' },
  );
  await expect
    .poll(async () => {
      try {
        return (await fetch(origin)).ok;
      } catch {
        return false;
      }
    })
    .toBe(true);
});
test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const closed = new Promise<void>((done) => server.once('exit', () => done()));
    server.kill();
    await closed;
  }
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ initial, initialPlan, id }) => {
      let session = initial;
      let stored = structuredClone(initialPlan);
      let serial = 0;
      let failure = '';
      let disconnected = false;
      let saving = false;
      let statusFailure = false;
      let holdPrompt = false;
      let releasePrompt: (() => void) | undefined;
      let releaseSave: (() => void) | undefined;
      const calls: unknown[][] = [];
      const project = {
        id,
        name: '기능 대화 검사',
        path: 'C:/mock/project',
        createdAt: '',
        updatedAt: '',
        lastOpenedAt: '',
      };
      Reflect.set(window, 'sessionTest', {
        calls,
        finish: (state: 'exited' | 'error' = 'exited') => {
          session = {
            ...session,
            state,
            exitCode: state === 'exited' ? 0 : 1,
            cleanupConfirmed: true,
            conversationReady: true,
            message:
              state === 'exited' ? '프로세스 실행이 종료됐어요.' : '로그인 상태를 확인해 주세요.',
          };
        },
        reject: (text: string) => {
          failure = text;
        },
        disconnect: () => {
          disconnected = true;
        },
        holdSave: () => {
          saving = true;
        },
        releaseSave: () => releaseSave?.(),
        failStatus: () => {
          statusFailure = true;
        },
        holdPrompt: () => {
          holdPrompt = true;
        },
        releasePrompt: () => releasePrompt?.(),
      });
      window.desktop = {
        selectProjectFolder: async () => ({ status: 'cancelled' }),
        inspectAI: async () => ({ status: 'ready', message: '모의 연결 준비 완료' }),
        readAIStatus: async () => {
          if (statusFailure) throw new Error('Status connection unavailable');
          return structuredClone(session);
        },
        listProjects: async () => ({ projects: [project], activeProjectId: id, storage: 'sqlite' }),
        activateProject: async () => ({ ok: true, project, plan: structuredClone(stored) }),
        saveProjectName: async () => ({ ok: true, project, plan: structuredClone(stored) }),
        loadFeaturePlan: async () => ({ ok: true, plan: structuredClone(stored) }),
        saveFeaturePlan: async (_id, candidate) => {
          if (saving)
            await new Promise<void>((done) => {
              releaseSave = done;
            });
          stored = structuredClone(candidate);
          return { ok: true, plan: structuredClone(stored) };
        },
        listProjectFiles: async () => ({ ok: true, path: '', entries: [], truncated: false }),
        openProjectFile: async () => ({ ok: true }),
        listProjectBackups: async () => ({ backups: [], directory: '' }),
        backupProjects: async () => ({ ok: true, message: '' }),
        restoreProjects: async () => ({ ok: true, message: '' }),
        sendAIPrompt: async () => ({ ok: false, message: '검사에서 일반 대화는 실행하지 않아요.' }),
        sendRequirementsPrompt: async () => ({ ok: false }),
        generateFeatureDraft: async () => ({ ok: false }),
        sendFeaturePrompt: async (...args) => {
          calls.push(args);
          if (failure) return { ok: false, message: failure };
          const [, action, featureId] = args;
          const feature = stored.features.find((item) => item.id === featureId);
          if (!feature) return { ok: false, message: '기능이 없어요.' };
          serial++;
          const outputId = action === 'start' ? `output-${serial}` : session.outputId;
          const data = action === 'start' ? `계획: ${feature.title}\r\n` : '답변 수신\r\n';
          session = {
            ...session,
            id: `run-${serial}`,
            outputId,
            purpose: 'feature',
            state: 'running',
            cleanupConfirmed: false,
            conversationReady: false,
            featureContext: {
              featureId: feature.id,
              revision: feature.revision,
              title: feature.title,
              description: feature.description,
              criteria: feature.criteria,
              relatedPaths: [...(feature.relatedPaths ?? [])],
            },
            message: '실행 중이에요.',
            chunks: [{ sequence: 0, data, cols: 80, rows: 24 }],
            firstSequence: 0,
            nextSequence: 1,
          };
          if (holdPrompt)
            await new Promise<void>((done) => {
              releasePrompt = done;
            });
          return { ok: true, runId: session.id ?? undefined, outputId: outputId ?? undefined };
        },
        readAISession: async (_id, after, outputId) =>
          disconnected
            ? { connectionError: { code: 'retry-required', message: '앱 내부 연결이 끊겼어요.' } }
            : {
                ...structuredClone(session),
                chunks: session.chunks.filter(
                  (chunk) => outputId !== session.outputId || chunk.sequence >= after,
                ),
              },
        reconnectAI: async () => {
          disconnected = false;
          return { ok: true };
        },
        resizeAISession: async () => ({ ok: true }),
        stopAISession: async () => {
          session = {
            ...session,
            state: 'interrupted',
            cleanupConfirmed: true,
            conversationReady: true,
            message: '실행을 중단했어요.',
          };
          return { ok: true };
        },
        resetAISession: async () => {
          session = structuredClone(initial);
          return { ok: true };
        },
      };
    },
    { initial: emptyAISnapshot, initialPlan: plan, id: projectId },
  );
  await page.goto(origin);
  await page.getByRole('button', { name: '이 프로젝트로 시작' }).click();
  await page.getByRole('button', { name: '저장한 기능 이어서 열기' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('기능과 파일을 연결해요');
});

async function open(page: Page, title?: string, check = true) {
  if (title)
    await page
      .getByRole('list', { name: '기능 트리', exact: true })
      .getByRole('button', { name: new RegExp(`^${title} `) })
      .click();
  await page.getByRole('button', { name: '기능 AI 대화 열기' }).click();
  if (check)
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '연결 준비 확인', exact: true })
      .click();
}
async function control(page: Page, method: string, argument?: string) {
  await page.evaluate(
    ({ method, argument }) => {
      Reflect.get(Reflect.get(window, 'sessionTest'), method)(argument);
    },
    { method, argument },
  );
}
async function callCount(page: Page) {
  return page.evaluate(() => Reflect.get(window, 'sessionTest').calls.length);
}

test('다른 화면·기능 선택에도 실제 대화의 기능·버전·출력을 유지하고 종료 후 명시적으로 시작한다', async ({
  page,
}) => {
  await open(page, '알림 보내기');
  await page.getByRole('button', { name: '이 기능으로 대화 시작' }).click();
  const actual = page.getByRole('region', { name: '실제 실행에 연결된 기능' });
  await expect(actual).toContainText('현재 대화: 알림 보내기');
  await expect(page.getByRole('region', { name: '기능 대화 AI 출력' })).toContainText(
    '계획: 알림 보내기',
  );
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '작업 대시보드', exact: true }).click();
  const dashboard = page.getByRole('region', { name: '현재 AI 실행' });
  await expect(dashboard).toContainText('알림 보내기');
  await expect(dashboard).toContainText('실행 중');
  await expect(dashboard).toContainText('기능 검증: 시작 전');
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '0');
  await page.getByRole('button', { name: '현재 대화 열기' }).click();
  await expect(actual).toContainText('현재 대화: 알림 보내기');
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '기능·파일 관리', exact: true }).click();
  await open(page, '일정 찾기', false);
  await expect(page.getByRole('region', { name: '선택한 대화 기능' })).toContainText('일정 찾기');
  await expect(actual).toContainText('현재 대화: 알림 보내기');
  await expect(page.getByRole('region', { name: '기능 대화 AI 출력' })).toContainText(
    '계획: 알림 보내기',
  );
  await expect(page.getByRole('button', { name: '이 기능으로 새 세션 시작' })).toBeDisabled();
  await control(page, 'finish');
  await page.getByRole('button', { name: '연결 준비 확인', exact: true }).click();
  await page.getByRole('textbox', { name: '기능 대화에 보낼 답변' }).fill('다른 기능의 답변');
  await expect(page.getByRole('button', { name: '기능 답변 보내기' })).toBeDisabled();
  expect(await callCount(page)).toBe(1);
  await page.getByRole('button', { name: '이 기능으로 새 세션 시작' }).click();
  await expect(actual).toContainText('현재 대화: 일정 찾기');
  await expect(page.getByRole('region', { name: '기능 대화 AI 출력' })).toContainText(
    '계획: 일정 찾기',
  );
  await expect(page.getByRole('region', { name: '기능 대화 AI 출력' })).not.toContainText(
    '계획: 알림 보내기',
  );
  await page.getByRole('dialog').evaluate((dialog) => dialog.scrollTo({ top: 0 }));
  await page.screenshot({ path: resolve('.runtime/screens/t011-feature-session-normal.png') });
  await page.setViewportSize({ width: 560, height: 840 });
  expect(
    await page.getByRole('dialog').evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
  ).toBe(true);
  await page.getByRole('dialog').evaluate((dialog) => dialog.scrollTo({ top: 0 }));
  await page.screenshot({ path: resolve('.runtime/screens/t011-feature-session-narrow.png') });
});

test('조건 변경 후 기존 출력은 이전 버전으로 남고 답변은 새 세션 전까지 차단된다', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: '이 기능으로 대화 시작' }).click();
  await control(page, 'finish');
  await expect(page.getByRole('button', { name: '이 기능으로 새 세션 시작' })).toBeEnabled();
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '선택한 기능 수정' }).click();
  await page.getByLabel('완료 조건', { exact: true }).fill('새 알림 조건을 확인한다.');
  await page.getByRole('button', { name: '기능 저장' }).click();
  await open(page);
  await expect(page.getByRole('region', { name: '선택한 대화 기능' })).toContainText('조건 버전 2');
  await expect(page.getByRole('region', { name: '실제 실행에 연결된 기능' })).toContainText(
    '고정된 조건 버전 1',
  );
  await page.getByRole('textbox', { name: '기능 대화에 보낼 답변' }).fill('현재 조건의 답변');
  await expect(page.getByRole('button', { name: '기능 답변 보내기' })).toBeDisabled();
  await expect(
    page.getByText(/기능 내용·조건·관련 경로 또는 포함 여부가 바뀌었어요/),
  ).toBeVisible();
  expect(await callCount(page)).toBe(1);
  await page.getByRole('button', { name: '이 기능으로 새 세션 시작' }).click();
  await expect(page.getByRole('region', { name: '실제 실행에 연결된 기능' })).toContainText(
    '고정된 조건 버전 2',
  );
  await control(page, 'finish');
  await page.getByRole('button', { name: '기능 답변 보내기' }).click();
  expect(await callCount(page)).toBe(3);
});

test('중단·오류·연결 실패를 표시하고 재연결과 누락 경로 오류를 다룬다', async ({ page }) => {
  await open(page);
  await control(page, 'reject', '연결된 관련 경로를 찾을 수 없어요: src/notify.ts');
  await page.getByRole('button', { name: '이 기능으로 대화 시작' }).click();
  await expect(page.getByRole('alert')).toContainText('src/notify.ts');
  await control(page, 'reject', '');
  await page.getByRole('button', { name: '이 기능으로 대화 시작' }).click();
  await expect(page.getByRole('button', { name: '실행 중단', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '실행 중단', exact: true }).click();
  await expect(page.getByRole('dialog').locator('.ai-run-status')).toContainText('중단했어요');
  await control(page, 'disconnect');
  await expect(page.getByText('앱 내부 연결이 끊겼어요.')).toBeVisible();
  await expect(page.getByRole('button', { name: '이 기능으로 새 세션 시작' })).toBeDisabled();
  await page.getByRole('button', { name: '다시 연결', exact: true }).click();
  await expect(page.getByRole('button', { name: '이 기능으로 새 세션 시작' })).toBeEnabled();
  await page.getByRole('button', { name: '이 기능으로 새 세션 시작' }).click();
  await control(page, 'finish', 'error');
  await expect(page.getByRole('dialog').locator('.ai-run-status')).toContainText('로그인 상태');
});

test('기능 저장 중에는 전역 대화에서도 새 세션과 답변을 차단한다', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '이 기능으로 대화 시작' }).click();
  await control(page, 'finish');
  await expect(page.getByRole('button', { name: '이 기능으로 새 세션 시작' })).toBeEnabled();
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await control(page, 'holdSave');
  await page.getByRole('button', { name: '선택한 기능 수정' }).click();
  await page.getByLabel('완료 조건', { exact: true }).fill('저장 대기 조건');
  await page.getByRole('button', { name: '기능 저장' }).click();
  // The editor keeps focus while its save is pending. Escape cannot dismiss it.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: '저장 중…' })).toBeDisabled();
  // Exercise a queued global-open action as well as the ordinary modal focus guard.
  await page
    .getByRole('button', { name: 'AI 대화', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  const conversation = page.getByRole('dialog', { name: 'Codex와 대화' });
  await conversation.getByRole('button', { name: '연결 준비 확인', exact: true }).click();
  await expect(conversation).toContainText('기능 저장을 마친 뒤 대화를 시작해 주세요.');
  await expect(
    conversation.getByRole('button', { name: '이 기능으로 새 세션 시작' }),
  ).toBeDisabled();
  await conversation.getByRole('textbox', { name: '기능 대화에 보낼 답변' }).fill('저장 중 답변');
  await expect(conversation.getByRole('button', { name: '기능 답변 보내기' })).toBeDisabled();
  expect(await callCount(page)).toBe(1);
  await control(page, 'releaseSave');
  await expect(page.getByRole('dialog', { name: '기능과 완료 조건 수정' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '실제 실행에 연결된 기능' })).toContainText(
    '조건 버전 1',
  );
  await expect(page.getByRole('button', { name: '기능 답변 보내기' })).toBeDisabled();
});

test('늦은 시작 응답은 이동한 다른 기능에 문맥이나 출력을 재지정하지 않는다', async ({ page }) => {
  await open(page);
  await control(page, 'holdPrompt');
  await page.getByRole('button', { name: '이 기능으로 대화 시작' }).click();
  await expect.poll(() => callCount(page)).toBe(1);
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await open(page, '일정 찾기', false);
  await control(page, 'releasePrompt');
  const actual = page.getByRole('region', { name: '실제 실행에 연결된 기능' });
  await expect(actual).toContainText('현재 대화: 알림 보내기');
  await expect(page.getByRole('region', { name: '선택한 대화 기능' })).toContainText('일정 찾기');
  await expect(page.getByRole('region', { name: '기능 대화 AI 출력' })).toContainText(
    '계획: 알림 보내기',
  );
  await control(page, 'finish');
  await page.getByRole('button', { name: '연결 준비 확인', exact: true }).click();
  await page.getByRole('textbox', { name: '기능 대화에 보낼 답변' }).fill('다른 기능 답변');
  await expect(page.getByRole('button', { name: '기능 답변 보내기' })).toBeDisabled();
  expect(await callCount(page)).toBe(1);
});

test('일반 대화 전환은 종료 후 명시적으로 초기화하고 대시보드는 관측 실패를 알린다', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: '이 기능으로 대화 시작' }).click();
  await page.getByText('대화 보관·실행 정보', { exact: true }).click();
  await expect(page.getByRole('button', { name: '새 일반 대화 시작' })).toBeDisabled();
  await control(page, 'finish');
  await page.getByRole('button', { name: '새 일반 대화 시작' }).click();
  await expect(page.getByRole('textbox', { name: 'Codex에게 보낼 메시지' })).toBeVisible();
  await expect(page.getByRole('region', { name: '실제 실행에 연결된 기능' })).toHaveCount(0);
  expect(await callCount(page)).toBe(1);
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await control(page, 'failStatus');
  await page.getByRole('button', { name: '작업 대시보드', exact: true }).click();
  const dashboard = page.getByRole('region', { name: '현재 AI 실행' });
  await expect(dashboard).toContainText('현재 상태 확인 필요');
  await expect(dashboard).toContainText('현재 실행 상태를 확인하지 못했어요. 마지막 관측:');
});

test('묶음과 제외한 기능은 안내와 함께 실행을 차단한다', async ({ page }) => {
  await page
    .getByRole('list', { name: '기능 트리', exact: true })
    .getByRole('button', { name: '준비 묶음 묶음', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '기능 AI 대화 열기' })).toBeDisabled();
  await expect(page.getByText('묶음 안의 기능을 선택해 주세요.')).toBeVisible();
  await page
    .getByRole('list', { name: '기능 트리', exact: true })
    .getByRole('button', { name: '보류 기능 제외', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '기능 AI 대화 열기' })).toBeDisabled();
  await expect(
    page.getByText('제외한 기능은 대화를 시작할 수 없어요. 기능을 포함한 뒤 시작해 주세요.'),
  ).toBeVisible();
  expect(await callCount(page)).toBe(0);
});
