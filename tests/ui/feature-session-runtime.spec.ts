import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron, type ElectronApplication, expect, type Page, test } from '@playwright/test';
import type { AISnapshot } from '../../shared/ai';
import type { ProjectFeaturePlan } from '../../shared/feature-plan';

// Real preload -> IPC -> authenticated local API -> SessionManager. The synthetic case
// injects only the CLI preparation dependency from Electron's trusted test runner.
let app: ElectronApplication;
let page: Page;
let folder: string;
let projectId: string;
let savedPlan: ProjectFeaturePlan;
const errors: string[] = [];
const managerUrl = pathToFileURL(resolve('dist/desktop/electron/main.js')).href;

test.beforeEach(async () => {
  const runtime = resolve('.runtime', `feature-session-runtime-${randomUUID()}`);
  folder = resolve(runtime, 'project');
  await mkdir(resolve(folder, 'src'), { recursive: true });
  await writeFile(resolve(folder, 'src/notify.ts'), 'export const notification = "unchanged";\n');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
    ),
  ) as Record<string, string>;
  app = await _electron.launch({
    args: ['.', `--user-data-dir=${resolve(runtime, 'profile')}`],
    env,
  });
  page = await app.firstWindow();
  errors.length = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, folder);
  await page.getByRole('button', { name: '프로젝트 폴더 선택', exact: true }).click();
  const catalog = await page.evaluate(() => window.desktop?.listProjects());
  projectId = catalog?.activeProjectId ?? '';
  expect(projectId).not.toBe('');
  savedPlan = {
    features: [
      {
        id: randomUUID(),
        title: '학생 알림 분석',
        description: '학생 알림의 구현 계획을 한국어 두 문장으로 설명한다. 파일은 수정하지 않는다.',
        criteria: '알림 흐름과 확인 방법을 설명한다.',
        revision: 1,
        included: true,
        kind: 'leaf',
        parentId: null,
        order: 0,
        relatedPaths: ['src/notify.ts'],
      },
      {
        id: randomUUID(),
        title: '일정 검색 분석',
        description: '일정 검색 흐름을 설명한다.',
        criteria: '검색 흐름과 확인 방법을 설명한다.',
        revision: 1,
        included: true,
        kind: 'leaf',
        parentId: null,
        order: 1,
        relatedPaths: [],
      },
    ],
    dependencies: [],
    verifications: [],
  };
  const saved = await page.evaluate(({ id, plan }) => window.desktop?.saveFeaturePlan(id, plan), {
    id: projectId,
    plan: savedPlan,
  });
  expect(saved?.ok).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: '이 프로젝트로 시작' }).click();
  await page.getByRole('button', { name: '저장한 기능 이어서 열기' }).click();
});

test.afterEach(async () => {
  await app?.close();
  expect(errors).toEqual([]);
  if (folder)
    expect(await readFile(resolve(folder, 'src/notify.ts'), 'utf8')).toBe(
      'export const notification = "unchanged";\n',
    );
});

async function status(): Promise<AISnapshot> {
  const result = await page.evaluate((id) => window.desktop?.readAIStatus(id), projectId);
  if (!result) throw new Error('AI status missing');
  return result;
}
async function open(title?: string, check = true) {
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

async function synthetic() {
  await app.evaluate(
    (_electron, config) => {
      const require = process.getBuiltinModule('module').createRequire(config.managerUrl);
      const { aiSession } = require(config.managerUrl.replace('file:///', ''));
      const prompts: { cwd: string; prompt: string; conversation?: string }[] = [];
      Reflect.set(globalThis, 'featureSessionPrompts', prompts);
      aiSession.dependencies.prepare = async (
        cwd: string,
        prompt: string,
        conversation?: string,
      ) => {
        prompts.push({ cwd, prompt, conversation });
        return {
          file: config.node,
          args: [
            config.fixture,
            Buffer.from(JSON.stringify({ prompt, conversation })).toString('base64'),
          ],
          inspectHeader: true,
        };
      };
      aiSession.availabilityStatus = async () => ({
        status: 'ready',
        message: '합성 CLI: 실제 AI 호출 없음',
      });
    },
    { managerUrl, node: process.execPath, fixture: resolve('tests/fixtures/ai-cli.cjs') },
  );
}

test('기능 조건·버전·경로가 실제 실행에 연결되고 답변·화면 왕복·중단·새 세션을 구분한다', async () => {
  test.setTimeout(120000);
  await synthetic();
  await open('학생 알림 분석');
  await page.getByRole('button', { name: '이 기능으로 대화 시작' }).click();
  await expect.poll(async () => (await status()).state, { timeout: 25000 }).toBe('exited');
  const first = await status();
  expect(first.purpose).toBe('feature');
  expect(first.featureContext).toEqual({
    featureId: savedPlan.features[0]?.id,
    revision: 1,
    title: savedPlan.features[0]?.title,
    description: savedPlan.features[0]?.description,
    criteria: savedPlan.features[0]?.criteria,
    relatedPaths: ['src/notify.ts'],
  });
  const prompts = await app.evaluate(() => Reflect.get(globalThis, 'featureSessionPrompts'));
  expect(prompts[0].cwd).toBe(folder);
  expect(prompts[0].prompt).toContain('학생 알림 분석');
  expect(prompts[0].prompt).toContain('알림 흐름과 확인 방법을 설명한다.');
  expect(prompts[0].prompt).toContain('src/notify.ts');
  const persisted = await page.evaluate((id) => window.desktop?.loadFeaturePlan(id), projectId);
  expect(persisted?.ok && persisted.plan.verifications).toEqual([]);
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '작업 대시보드', exact: true }).click();
  await expect(page.getByRole('region', { name: '현재 AI 실행' })).toContainText('학생 알림 분석');
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '0');
  await page.getByRole('button', { name: '현재 대화 열기' }).click();
  const actual = page.getByRole('region', { name: '실제 실행에 연결된 기능' });
  await expect(actual).toContainText('학생 알림 분석');
  await expect(page.getByRole('region', { name: '기능 대화 AI 출력' })).toContainText(
    'FIXTURE_REPLY',
  );
  await page.getByRole('button', { name: '연결 준비 확인', exact: true }).click();
  await page
    .getByRole('textbox', { name: '기능 대화에 보낼 답변' })
    .fill('WAIT 다음 질문을 대기한다.');
  await page.getByRole('button', { name: '기능 답변 보내기' }).click();
  await expect.poll(async () => (await status()).state).toBe('running');
  expect((await status()).outputId).toBe(first.outputId);
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '기능·파일 관리', exact: true }).click();
  await open('일정 검색 분석', false);
  await expect(actual).toContainText('학생 알림 분석');
  await expect(page.getByRole('button', { name: '이 기능으로 새 세션 시작' })).toBeDisabled();
  await page.getByRole('button', { name: '실행 중단', exact: true }).click();
  await expect.poll(async () => (await status()).state, { timeout: 25000 }).toBe('interrupted');
  expect((await status()).cleanupConfirmed).toBe(true);
  await page.getByRole('button', { name: '연결 준비 확인', exact: true }).click();
  await page.getByRole('button', { name: '이 기능으로 새 세션 시작' }).click();
  await expect.poll(async () => (await status()).state, { timeout: 25000 }).toBe('exited');
  expect((await status()).featureContext?.featureId).toBe(savedPlan.features[1]?.id);
  expect((await status()).outputId).not.toBe(first.outputId);
  const captured = await app.evaluate(() => Reflect.get(globalThis, 'featureSessionPrompts'));
  expect(captured[1].conversation).toBeTruthy();
  expect(captured[2].conversation).toBeUndefined();
});

test('실제 Codex: 기능의 읽기 전용 분석과 같은 대화 답변', async () => {
  test.skip(process.env.ORBIT_LIVE_AI !== '1', 'ORBIT_LIVE_AI=1에서만 실제 서비스 호출');
  test.setTimeout(180000);
  await open('학생 알림 분석');
  await expect(page.getByRole('button', { name: '이 기능으로 대화 시작' })).toBeEnabled();
  await page.getByRole('button', { name: '이 기능으로 대화 시작' }).click();
  await expect.poll(async () => (await status()).state, { timeout: 90000 }).toBe('exited');
  const first = await status();
  expect(first.exitCode).toBe(0);
  expect(first.cleanupConfirmed).toBe(true);
  expect(first.featureContext?.featureId).toBe(savedPlan.features[0]?.id);
  const terminal = page.getByRole('region', { name: '기능 대화 AI 출력' });
  await expect(terminal.locator('.xterm-rows')).not.toHaveText('');
  await page
    .getByRole('textbox', { name: '기능 대화에 보낼 답변' })
    .fill(
      '앞서 전달한 알림 기능의 완료 조건을 한 문장으로 다시 적어 주세요. 파일은 수정하지 마세요.',
    );
  await page.getByRole('button', { name: '기능 답변 보내기' }).click();
  await expect.poll(async () => (await status()).id).not.toBe(first.id);
  await expect.poll(async () => (await status()).state, { timeout: 90000 }).toBe('exited');
  const answer = await status();
  expect(answer.exitCode).toBe(0);
  expect(answer.cleanupConfirmed).toBe(true);
  expect(answer.outputId).toBe(first.outputId);
  expect(answer.featureContext).toEqual(first.featureContext);
  const persisted = await page.evaluate((id) => window.desktop?.loadFeaturePlan(id), projectId);
  expect(persisted?.ok && persisted.plan.verifications).toEqual([]);
});
