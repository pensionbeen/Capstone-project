import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  APP_URL,
  DEV_URL,
  inspectDirectory,
  isTrustedPage,
  staticAssetPath,
} from '../electron/policy.ts';

test('본문 건너뛰기 hash만 허용하고 다른 호스트·경로·query는 거부한다', () => {
  assert.equal(isTrustedPage(`${APP_URL}#main`, APP_URL), true);
  assert.equal(isTrustedPage(`${DEV_URL}#main`, DEV_URL), true);
  for (const url of [
    'orbit://other/index.html',
    'orbit://app/other.html',
    `${APP_URL}?unexpected=1`,
    'https://example.com/index.html',
  ])
    assert.equal(isTrustedPage(url, APP_URL), false);
});

test('정적 프로토콜은 앱의 고정 빌드 자원만 허용한다', () => {
  assert.equal(staticAssetPath('orbit://app/index.html'), 'index.html');
  assert.equal(staticAssetPath('orbit://app/assets/index-123.js'), 'assets/index-123.js');
  for (const url of [
    'file:///C:/private.txt',
    'https://app/index.html',
    'orbit://other/index.html',
    'orbit://user@app/index.html',
    'orbit://app/private.txt',
    'orbit://app/assets/%2e%2e/%2e%2e/private.txt',
    'orbit://app/assets/%5c..%5cprivate.css',
    'orbit://app/assets/C:/private.css',
  ])
    assert.equal(staticAssetPath(url), undefined, url);
});
test('한글과 공백이 있는 실제 폴더를 선택할 수 있다', async () => {
  const path = resolve('.runtime', 'test-fixtures', '한글 프로젝트');
  await mkdir(path, { recursive: true });
  assert.deepEqual(await inspectDirectory(path), {
    status: 'selected',
    name: '한글 프로젝트',
    path,
  });
});
test('사라진 경로·파일·잘못된 입력을 성공으로 반환하지 않는다', async () => {
  await mkdir(resolve('.runtime', 'test-fixtures'), { recursive: true });
  const file = resolve('.runtime', 'test-fixtures', 'not-a-folder.txt');
  await writeFile(file, 'synthetic fixture');
  for (const path of [undefined, '', '../relative', `${file}-missing`, file]) {
    assert.equal((await inspectDirectory(path)).status, 'error');
  }
});
