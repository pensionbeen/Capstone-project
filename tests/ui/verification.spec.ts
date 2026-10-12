import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron, type ElectronApplication, expect, type Page, test } from '@playwright/test';
import type { ProjectFeaturePlan } from '../../shared/feature-plan';

let app: ElectronApplication, page: Page, profile: string, projectId: string;
const errors: string[] = [];
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
  ),
) as Record<string, string>;
async function launch() {
  app = await _electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    '어떤 프로젝트를 만들어 볼까요?',
  );
}
async function workspace() {
  await page.getByRole('button', { name: '이 프로젝트로 시작' }).click();
  await page.getByRole('button', { name: /기능 직접 정리하기|저장한 기능 이어서 열기/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('기능과 파일을 연결해요');
}
async function menu(name: string) {
  await page.getByRole('button', { name: new RegExp(`^${name}(?:\\s*\\d+)?$`) }).click();
}
async function plan() {
  const result = await page.evaluate((id) => window.desktop?.loadFeaturePlan(id), projectId);
  if (!result?.ok) throw new Error('저장 계획 없음');
  return result.plan;
}
async function savePlan(value: ProjectFeaturePlan) {
  expect(
    await page.evaluate(({ id, value }) => window.desktop?.saveFeaturePlan(id, value), {
      id: projectId,
      value,
    }),
  ).toMatchObject({ ok: true });
}
async function add(title: string, kind = 'leaf', parent?: string) {
  await menu('기능·파일 관리');
  await page
    .getByRole('button', { name: kind === 'group' ? '묶음 추가' : '기능 추가', exact: true })
    .click();
  await page.getByLabel('기능 이름', { exact: true }).fill(title);
  if (kind === 'leaf')
    await page
      .getByLabel('완료 조건', { exact: true })
      .fill('입력한 내용을 표시한다.\n다시 열어도 내용을 유지한다.');
  if (parent) await page.getByLabel('상위 묶음').selectOption({ label: parent });
  await page.getByRole('button', { name: '기능 저장', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function prepareRecord(title: string, passed = true) {
  await menu('기능 검증');
  await page.getByRole('button', { name: '검증 결과 기록', exact: true }).click();
  await page.getByLabel('확인한 기능').selectOption({ label: title });
  if (passed)
    for (const checkbox of await page.getByRole('dialog').getByRole('checkbox').all())
      await checkbox.check();
  else await page.getByRole('radio', { name: '수정 필요', exact: true }).check();
  await page
    .getByLabel('실제 확인한 결과')
    .fill(
      passed
        ? '합성 검사: 입력과 다시 열기 동작을 확인했다.'
        : '합성 검사: 다시 열면 내용이 사라졌다.',
    );
  await page.getByLabel('검증 근거', { exact: true }).fill('합성 UI 검증 결과');
}
async function record(title: string, passed = true) {
  await prepareRecord(title, passed);
  await page.getByRole('button', { name: '검증 결과 저장' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function percent(value: string) {
  await menu('작업 대시보드');
  const bar = page.getByRole('progressbar', { name: '검증 완료율' });
  if (value === '정의 전') await expect(bar).toHaveAttribute('aria-valuetext', value);
  else await expect(bar).toHaveAttribute('value', value);
}
test.beforeEach(async () => {
  const root = resolve('.runtime', `verification-ui-${randomUUID()}`);
  const folder = join(root, '검증 프로젝트');
  profile = join(root, 'profile');
  errors.length = 0;
  await mkdir(folder, { recursive: true });
  await launch();
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  await page.getByRole('button', { name: '프로젝트 폴더 선택', exact: true }).click();
  await expect(page.getByLabel('프로젝트 이름', { exact: true })).toBeEnabled();
  projectId = (await page.evaluate(() => window.desktop?.listProjects()))?.activeProjectId ?? '';
  expect(projectId).not.toBe('');
  await workspace();
});
test.afterEach(async () => {
  await app?.close();
  expect(errors).toEqual([]);
});

test('말단만 집계하고 AI 완료 문장·검증 실패·기능 추가 삭제를 정확히 반영한다', async () => {
  await percent('정의 전');
  await add('저장 묶음', 'group');
  await percent('정의 전');
  await menu('기능 검증');
  await expect(page.getByRole('button', { name: '검증 결과 기록' })).toBeDisabled();
  await add('내용 저장', 'leaf', '저장 묶음');
  await menu('기능 검증');
  await page.getByRole('button', { name: '검증 결과 기록' }).click();
  await expect(page.getByLabel('확인한 기능').locator('option')).toHaveCount(1);
  await page.getByLabel('실제 확인한 결과').fill('AI가 완료했다고 말했다.');
  await page.getByLabel('검증 근거', { exact: true }).fill('AI의 완료 문장');
  await expect(page.getByRole('button', { name: '검증 결과 저장' })).toBeDisabled();
  await page.getByRole('button', { name: '기록 취소' }).click();
  expect((await plan()).verifications).toHaveLength(0);
  await record('내용 저장');
  await percent('100');
  await add('내용 조회', 'leaf', '저장 묶음');
  await percent('50');
  await record('내용 저장', false);
  await expect(page.locator('.verification-record').first()).toContainText('수정 필요');
  await expect(page.locator('.verification-record').last()).toContainText('검증 통과');
  await expect(page.getByText('이전 검증 기록', { exact: true })).toBeVisible();
  await percent('0');
  await menu('기능·파일 관리');
  await page
    .getByRole('list', { name: '기능 트리', exact: true })
    .getByRole('button', { name: '저장 묶음 묶음', exact: true })
    .click();
  await page.getByRole('button', { name: '선택한 기능 삭제' }).click();
  await page.getByRole('button', { name: '삭제 확정' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await percent('정의 전');
  expect((await plan()).verifications).toHaveLength(0);
});

test('제외된 검증은 과거 조건으로 오표시하지 않고 재포함·수정·재시작에서 근거를 유지한다', async () => {
  await add('내용 저장');
  await record('내용 저장');
  const before = await plan();
  const excluded = structuredClone(before);
  excluded.features[0].included = false;
  await savePlan(excluded);
  await app.close();
  await launch();
  await workspace();
  await percent('정의 전');
  await menu('기능 검증');
  await expect(page.getByText('진행률에서 제외', { exact: true })).toBeVisible();
  await expect(page.getByText('이전 조건의 결과', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '검증 결과 기록' })).toBeDisabled();
  await savePlan(before);
  await app.close();
  await launch();
  await workspace();
  await percent('100');
  await page.getByRole('button', { name: '내용 저장', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '수정', exact: true }).click();
  await page.getByLabel('완료 조건', { exact: true }).fill('변경한 새 조건을 직접 확인한다.');
  await page.getByRole('button', { name: '기능 저장' }).click();
  await expect(page.getByText('재검증 필요', { exact: true })).toBeVisible();
  await percent('0');
  await app.close();
  await launch();
  await workspace();
  await menu('기능 검증');
  await expect(page.getByText('이전 조건의 결과', { exact: true })).toBeVisible();
  await page.getByText('확인한 완료 조건 (2개)', { exact: true }).click();
  await expect(page.getByText('입력한 내용을 표시한다.', { exact: true })).toBeVisible();
  expect((await plan()).verifications).toEqual(before.verifications);
  await record('내용 저장');
  await percent('100');
  await menu('기능 검증');
  await mkdir('.runtime/screens', { recursive: true });
  await page.screenshot({ path: '.runtime/screens/17-t008-verification.png', fullPage: true });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(360, 600);
    window.setSize(560, 840);
  });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(561);
  await expect(page.getByRole('button', { name: '메뉴 열기' })).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByRole('complementary', { name: '주 메뉴' })
        .evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(0);
  await expect(page.getByText('이전 조건의 결과', { exact: true })).toBeVisible();
  expect(
    await page
      .getByRole('heading', { level: 1 })
      .evaluate((element) => element.getBoundingClientRect().left),
  ).toBeGreaterThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: '.runtime/screens/18-t008-verification-narrow.png',
    fullPage: true,
  });
});

test('검증 저장 실패는 입력과 저장 상태를 보존하고 다시 저장할 수 있다', async () => {
  await add('내용 저장');
  await prepareRecord('내용 저장');
  const before = await plan();
  const blocker = new DatabaseSync(join(profile, 'orbit-data/projects.sqlite'));
  blocker.exec('BEGIN IMMEDIATE');
  try {
    await page.getByRole('button', { name: '검증 결과 저장' }).click();
    await expect(page.getByRole('status')).toContainText('저장 작업을 마치지 못했어요');
    await expect(page.getByLabel('검증 근거', { exact: true })).toHaveValue('합성 UI 검증 결과');
    expect(await plan()).toEqual(before);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
  }
  await page.getByRole('button', { name: '검증 결과 저장' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await plan()).verifications).toHaveLength(1);
  await percent('100');
});
