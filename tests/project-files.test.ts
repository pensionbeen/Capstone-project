import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { ProjectFiles } from '../dist/desktop/electron/project-files.js';
import { validRelativePath } from '../dist/desktop/shared/workspace-files.js';

async function fixture() {
  await mkdir('.runtime/file-tests', { recursive: true });
  const root = await mkdtemp(resolve('.runtime/file-tests/case-'));
  const folder = join(root, '한글 공백 프로젝트');
  await mkdir(folder);
  const calls: string[] = [];
  const files = new ProjectFiles(async (path: string) => {
    calls.push(path);
  });
  return { root, folder, calls, files };
}

test('path syntax rejects absolute, UNC, ADS, device names and aliases', () => {
  for (const path of [
    '',
    '..',
    '../a',
    'a/../b',
    'a//b',
    '/a',
    'C:/x',
    '\\server\\share',
    'a:b',
    'CON',
    'aux.txt',
    'com1.ts',
    'lpt¹.txt',
    'a./b',
    'b ',
    'a\u0000b',
  ])
    assert.equal(validRelativePath(path), false, path);
  assert.equal(validRelativePath('', true), true);
  assert.equal(validRelativePath('src/한글 공백.ts'), true);
});

test('lists one level and hands text/script names to a fixed launcher without executing their contents', async () => {
  const f = await fixture();
  await mkdir(join(f.folder, 'src'));
  const name = '한글 & 공백.cmd';
  await writeFile(join(f.folder, 'src', name), 'not an actual command');
  const list = await f.files.list(f.folder, '');
  assert.deepEqual(list, {
    ok: true,
    entries: [{ name: 'src', path: 'src', kind: 'directory' }],
    truncated: false,
  });
  assert.equal((await f.files.open(f.folder, `src/${name}`)).ok, true);
  assert.deepEqual(f.calls, [await realpath(join(f.folder, 'src', name))]);
  assert.equal(await readFile(f.calls[0], 'utf8'), 'not an actual command');
});

test('missing files, directory opens, oversized files, traversal and junction escapes never launch', async () => {
  const f = await fixture();
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'fixture only');
  await symlink(outside, join(f.folder, 'linked'), 'junction');
  await writeFile(join(f.folder, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1));
  for (const path of [
    'missing.txt',
    '../outside/secret.txt',
    outside,
    'linked/secret.txt',
    'large.txt',
    '',
  ])
    assert.equal((await f.files.open(f.folder, path)).ok, false, path);
  assert.equal((await f.files.list(f.folder, 'linked')).ok, false);
  const list = await f.files.list(f.folder, '');
  assert.equal(
    list.ok && list.entries.find((entry) => entry.name === 'linked')?.kind,
    'unavailable',
  );
  assert.deepEqual(f.calls, []);
});

test('directory list has a visible 200 entry cap and launcher failure is reported', async () => {
  const f = await fixture();
  await Promise.all(
    Array.from({ length: 201 }, (_, i) => writeFile(join(f.folder, `${i}.txt`), '')),
  );
  const list = await f.files.list(f.folder, '');
  assert.equal(list.ok && list.entries.length, 200);
  assert.equal(list.ok && list.truncated, true);
  const broken = new ProjectFiles(async () => {
    throw new Error('unavailable editor');
  });
  assert.equal((await broken.open(f.folder, '0.txt')).ok, false);
});
