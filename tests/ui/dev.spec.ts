import { resolve } from 'node:path';
import { _electron, expect, test } from '@playwright/test';
import { createServer } from 'vite';

test('개발 모드에서도 스타일과 StrictMode 모달이 유지된다', async () => {
  const server = await createServer();
  await server.listen();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
    ),
  ) as Record<string, string>;
  const app = await _electron.launch({
    args: ['.', '--dev', `--user-data-dir=${resolve('.runtime', 'electron-dev-test-profile')}`],
    env,
  });
  try {
    const page = await app.firstWindow();
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('.app-shell')).toHaveCSS('display', 'grid');
    await expect(page.getByRole('button', { name: '프로젝트 폴더 선택', exact: true })).toHaveCSS(
      'background-color',
      'rgb(40, 100, 239)',
    );
    await page.getByRole('button', { name: '프로토타입 안내' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '프로젝트로 돌아가기' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, resolve('.runtime'));
    await page.getByRole('button', { name: '프로젝트 폴더 선택', exact: true }).click();
    await page.getByRole('button', { name: '이 프로젝트로 시작' }).click();
    await page.getByRole('button', { name: 'Codex 대화 열기', exact: true }).click();
    await expect(page.locator('.xterm-screen')).toBeVisible();
    await expect(page.locator('.xterm-rows')).toHaveCSS('white-space', 'pre');
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    expect(consoleErrors).toEqual([]);
  } finally {
    await app.close();
    await server.close();
  }
});
