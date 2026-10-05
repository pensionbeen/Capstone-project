import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron, type ElectronApplication, expect, type Page, test } from '@playwright/test';

let app: ElectronApplication, page: Page, profile: string, folder: string, projectId: string;
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
async function plan() {
  const result = await page.evaluate((id) => window.desktop?.loadFeaturePlan(id), projectId);
  if (!result?.ok) throw new Error('No saved plan');
  return result.plan;
}
async function workspace() {
  await page.getByRole('button', { name: '이 프로젝트로 시작' }).click();
  await page.getByRole('button', { name: /기능 직접 정리하기|저장한 기능 이어서 열기/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('기능과 파일을 연결해요');
}
async function add(name: string, kind = 'leaf', parent?: string) {
  await page
    .getByRole('button', { name: kind === 'group' ? '묶음 추가' : '기능 추가', exact: true })
    .click();
  await page.getByLabel('기능 이름', { exact: true }).fill(name);
  if (kind === 'leaf')
    await page.getByLabel('완료 조건', { exact: true }).fill('직접 동작을 확인한다.');
  if (parent) await page.getByLabel('상위 묶음').selectOption({ label: parent });
  await page.getByRole('button', { name: '기능 저장', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function select(name: string) {
  await page
    .getByRole('list', { name: '기능 트리', exact: true })
    .getByRole('button', {
      name: new RegExp(`^${name} (묶음|시작 전|재검증 필요|검증 완료|제외)$`),
    })
    .click();
}

test.beforeEach(async () => {
  const root = resolve('.runtime', `feature-ui-${randomUUID()}`);
  profile = join(root, 'profile');
  folder = join(root, '한글 공백 프로젝트');
  errors.length = 0;
  await mkdir(join(folder, 'src'), { recursive: true });
  await writeFile(join(folder, 'src', '한글 파일.ts'), 'export const value = 1;');
  await launch();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, folder);
  await page.getByRole('button', { name: '프로젝트 폴더 선택', exact: true }).click();
  await expect(page.getByLabel('프로젝트 이름', { exact: true })).toBeEnabled();
  const catalog = await page.evaluate(() => window.desktop?.listProjects());
  projectId = catalog?.activeProjectId ?? '';
  expect(projectId).not.toBe('');
  await workspace();
});
test.afterEach(async () => {
  await app?.close();
  expect(errors).toEqual([]);
});

test('묶음·말단 CRUD, 선행 관계·파일 연결, 취소와 재시작 복원', async () => {
  await add('준비 묶음', 'group');
  await add('폴더 선택', 'leaf', '준비 묶음');
  await add('프로젝트 저장', 'leaf', '준비 묶음');
  await select('프로젝트 저장');
  await page.getByRole('button', { name: '선택한 기능 수정' }).click();
  await page.getByRole('checkbox', { name: '폴더 선택', exact: true }).check();
  await page.getByRole('button', { name: '기능 저장' }).click();
  await page
    .getByRole('list', { name: '실제 파일 트리', exact: true })
    .getByRole('button', { name: 'src', exact: true })
    .click();
  await page.getByRole('button', { name: '한글 파일.ts', exact: true }).click();
  await page.getByRole('button', { name: '선택한 기능에 연결' }).click();
  await expect(
    page
      .getByRole('region', { name: '선택한 기능' })
      .getByText('src/한글 파일.ts', { exact: true }),
  ).toBeVisible();
  const before = await plan();
  expect(before.features).toHaveLength(3);
  expect(before.dependencies).toHaveLength(1);
  expect(before.features.find((item) => item.title === '프로젝트 저장')?.relatedPaths).toEqual([
    'src/한글 파일.ts',
  ]);
  await page.getByRole('button', { name: '선택한 기능 수정' }).click();
  await page.getByLabel('기능 이름', { exact: true }).fill('취소할 변경');
  await page.getByRole('button', { name: '수정 취소' }).click();
  expect(await plan()).toEqual(before);
  await mkdir('.runtime/screens', { recursive: true });
  await page.screenshot({ path: '.runtime/screens/15-feature-files.png', fullPage: true });
  await app.close();
  await launch();
  await workspace();
  expect(await plan()).toEqual(before);
  await select('준비 묶음');
  await page.getByRole('button', { name: '선택한 기능 삭제' }).click();
  await expect(page.getByRole('dialog')).toContainText('3개 항목');
  await page.getByRole('button', { name: '삭제 취소' }).click();
  expect(await plan()).toEqual(before);
  await page.getByRole('button', { name: '선택한 기능 삭제' }).click();
  await page.getByRole('button', { name: '삭제 확정' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await plan()).features).toHaveLength(0);
  expect(await readFile(join(folder, 'src', '한글 파일.ts'), 'utf8')).toContain('export const');
});

test('순환 관계와 저장 잠금 실패는 기존 계획과 편집 입력을 보존한다', async () => {
  await add('첫 기능');
  await add('다음 기능');
  await select('다음 기능');
  await page.getByRole('button', { name: '선택한 기능 수정' }).click();
  await page.getByRole('checkbox', { name: '첫 기능', exact: true }).check();
  await page.getByRole('button', { name: '기능 저장' }).click();
  const before = await plan();
  await select('첫 기능');
  await page.getByRole('button', { name: '선택한 기능 수정' }).click();
  await page.getByRole('checkbox', { name: '다음 기능', exact: true }).check();
  await page.getByRole('button', { name: '기능 저장' }).click();
  await expect(page.getByRole('status')).toContainText('순환');
  expect(await plan()).toEqual(before);
  await page.getByRole('checkbox', { name: '다음 기능', exact: true }).uncheck();
  const blocker = new DatabaseSync(join(profile, 'orbit-data/projects.sqlite'));
  blocker.exec('BEGIN IMMEDIATE');
  try {
    await page.getByLabel('기능 이름', { exact: true }).fill('재시도할 이름');
    await page.getByRole('button', { name: '기능 저장' }).click();
    await expect(page.getByRole('status')).toContainText('저장 작업을 마치지 못했어요');
    await expect(page.getByLabel('기능 이름', { exact: true })).toHaveValue('재시도할 이름');
    expect(await plan()).toEqual(before);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
  }
  await page.getByRole('button', { name: '기능 저장' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await plan()).features[0].title).toBe('재시도할 이름');
});

test('100개 기능을 표시하고 추가를 제한한다', async () => {
  const features = Array.from({ length: 100 }, (_, order) => ({
    id: randomUUID(),
    parentId: null,
    kind: 'leaf' as const,
    title: `기능 ${String(order + 1).padStart(3, '0')}`,
    description: '',
    criteria: '조건 확인',
    included: true,
    revision: 1,
    order,
  }));
  expect(
    await page.evaluate(
      ({ id, features }) =>
        window.desktop?.saveFeaturePlan(id, { features, dependencies: [], verifications: [] }),
      { id: projectId, features },
    ),
  ).toMatchObject({ ok: true });
  await app.close();
  await launch();
  await workspace();
  await expect(
    page.getByRole('list', { name: '기능 트리', exact: true }).locator('li'),
  ).toHaveCount(100);
  await expect(page.getByRole('button', { name: '기능 추가', exact: true })).toBeDisabled();
  await select('기능 100');
  await expect(
    page.getByRole('region', { name: '선택한 기능' }).getByRole('heading', { name: '기능 100' }),
  ).toBeVisible();
  await page.screenshot({ path: '.runtime/screens/16-feature-100.png', fullPage: true });
});

test('없는 파일 안내, 편집기 경로 전달과 파일 IPC 입력·발신자 검증', async () => {
  await add('경로 검사');
  await select('경로 검사');
  await page.getByRole('button', { name: '선택한 기능 수정' }).click();
  await page.getByLabel('관련 경로', { exact: true }).fill('missing.ts');
  await page.getByRole('button', { name: '기능 저장' }).click();
  await page.getByRole('button', { name: '메모장으로 열기', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '프로젝트 파일' }).getByRole('status'),
  ).toContainText('파일이 없거나');
  await app.evaluate((_electron, path) => {
    const require = process.getBuiltinModule('module').createRequire(path);
    const { projectFiles } = require(path);
    projectFiles.launch = async (file: string) => {
      Reflect.set(globalThis, 'openedTestFile', file);
    };
  }, resolve('dist/desktop/electron/main.js'));
  expect(
    await page.evaluate((id) => window.desktop?.openProjectFile(id, 'src/한글 파일.ts'), projectId),
  ).toEqual({ ok: true });
  expect(await app.evaluate(() => Reflect.get(globalThis, 'openedTestFile'))).toBe(
    join(folder, 'src', '한글 파일.ts'),
  );
  const invalid = await page.evaluate(
    async (id) =>
      Promise.all(
        ['../outside.txt', 'C:/Windows/win.ini', 'src/한글 파일.ts:stream', '\\server\\share'].map(
          (path) => window.desktop?.openProjectFile(id, path),
        ),
      ),
    projectId,
  );
  for (const result of invalid) expect(result?.ok).toBe(false);
  const responses = await app.evaluate(async ({ ipcMain, BrowserWindow }, id) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers;
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const event = { sender: contents, senderFrame: contents.mainFrame };
    const responses = [];
    for (const action of ['files:list', 'files:open']) {
      responses.push(await handlers.get(action)?.({ ...event, senderFrame: null }, id, ''));
      responses.push(await handlers.get(action)?.(event, id, '', 'extra'));
      responses.push(await handlers.get(action)?.(event, 'bad-id', ''));
    }
    return responses;
  }, projectId);
  for (const result of responses) expect(result).toMatchObject({ ok: false });
});

test('AI 요청 전달 중 삭제를 서버가 거부하고 종료 뒤 재시도할 수 있다', async () => {
  await add('실행 중 기능');
  await select('실행 중 기능');
  const before = await plan();
  await app.evaluate((_electron, path) => {
    const require = process.getBuiltinModule('module').createRequire(path);
    const { LocalApiClient } = require(path);
    LocalApiClient.prototype.command = async () => {
      await new Promise<void>((resolve) => {
        Reflect.set(globalThis, 'releaseFeatureAITest', resolve);
      });
      return { ok: false, message: 'synthetic delayed rejection' };
    };
  }, resolve('dist/desktop/electron/local-api/client.js'));
  await page.evaluate((id) => {
    void window.desktop?.sendAIPrompt(id, '합성 요청', null, null);
  }, projectId);
  await expect
    .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'releaseFeatureAITest')))
    .toBe('function');
  await page.getByRole('button', { name: '선택한 기능 삭제' }).click();
  await page.getByRole('button', { name: '삭제 확정' }).click();
  await expect(page.getByRole('status')).toContainText('AI 실행을 중단');
  expect(await plan()).toEqual(before);
  await app.evaluate(() => {
    Reflect.get(globalThis, 'releaseFeatureAITest')();
  });
  await page.getByRole('button', { name: '삭제 확정' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await plan()).features).toHaveLength(0);
});

test('저장 응답 대기 중 닫기·Escape·프로젝트 전환을 차단한다', async () => {
  await add('지연 기능');
  await select('지연 기능');
  await app.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get('features:save');
    handlers.set('features:save', async (...args: unknown[]) => {
      await new Promise<void>((resolve) => {
        Reflect.set(globalThis, 'releaseFeatureSave', resolve);
      });
      return original?.(...args);
    });
  });
  await page.getByRole('button', { name: '선택한 기능 수정' }).click();
  await page.getByLabel('기능 이름', { exact: true }).fill('저장할 이름');
  await page.getByRole('button', { name: '기능 저장' }).click();
  await expect(page.getByRole('button', { name: '닫기', exact: true })).toBeDisabled();
  await expect(page.locator('.project-switcher')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  await app.evaluate(() => {
    Reflect.get(globalThis, 'releaseFeatureSave')();
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await plan()).features[0].title).toBe('저장할 이름');
});

test('기능 확정 화면에서 포함 변경 저장 중 이전 값으로 편집할 수 없다', async () => {
  await page.locator('.project-switcher').click();
  await page.getByRole('button', { name: '프로젝트 선택으로', exact: true }).click();
  await page.getByRole('button', { name: '이 프로젝트로 시작' }).click();
  await page.getByRole('button', { name: '예시로 요구분석 시작' }).click();
  await page.getByLabel('만들고 싶은 서비스').fill('할 일 앱');
  await page.getByRole('button', { name: '요구분석 시작', exact: true }).click();
  await page.getByRole('radio', { name: '나 혼자', exact: true }).check();
  await page.getByRole('button', { name: '기능 초안 보기' }).click();
  await app.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get('features:save');
    handlers.set('features:save', async (...args: unknown[]) => {
      handlers.set('features:save', original as (...args: unknown[]) => unknown);
      await new Promise<void>((resolve) => {
        Reflect.set(globalThis, 'releaseToggleSave', resolve);
      });
      return original?.(...args);
    });
  });
  // The controlled checkbox changes only after the deliberately delayed commit.
  await page.getByRole('checkbox', { name: '할 일 추가·수정 포함' }).click();
  await expect(page.getByRole('button', { name: '할 일 추가·수정 수정' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '기능 직접 추가' })).toBeDisabled();
  await app.evaluate(() => {
    Reflect.get(globalThis, 'releaseToggleSave')();
  });
  await expect(page.getByRole('checkbox', { name: '할 일 추가·수정 포함' })).not.toBeChecked();
  await page.getByRole('button', { name: '할 일 추가·수정 수정' }).click();
  await page.getByLabel('기능 이름', { exact: true }).fill('제외한 기능 수정');
  await page.getByRole('button', { name: '기능 저장' }).click();
  await expect(page.getByRole('checkbox', { name: '제외한 기능 수정 포함' })).not.toBeChecked();
  expect((await plan()).features.find((item) => item.title === '제외한 기능 수정')?.included).toBe(
    false,
  );
});
