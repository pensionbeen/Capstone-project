import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { SessionManager } from '../dist/desktop/electron/ai/session-manager.js';

const require = createRequire(import.meta.url);
const electron = require('electron') as string;
const cwd = resolve('.runtime', 'ai-fixture-project');
test('호스트 실행 파일이 없으면 앱을 죽이지 않고 실패·정리를 반환한다', {
  timeout: 20000,
}, async () => {
  await mkdir(cwd, { recursive: true });
  const manager = new SessionManager({
    hostExecutable: resolve('.runtime', 'missing-orbit-host.exe'),
    prepare: async () => ({ file: process.execPath, args: [], inspectHeader: false }),
    snapshot: async () => [
      { pid: process.pid, parent: 1, name: 'node.exe', created: new Date(1).toISOString() },
    ],
  });
  const id = manager.registerProject(cwd);
  assert.ok(id);
  assert.equal(manager.submit(id, 'hello').ok, true);
  await waitFor(() => !manager.busy, 15000);
  const state = manager.read(id, 0);
  assert.equal(state.state, 'error');
  assert.equal(state.cleanupConfirmed, true);
  assert.equal(await manager.shutdown(), true);
});
async function waitFor(check: () => boolean, ms = 45000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  assert.ok(check(), 'state deadline exceeded');
}
test('Electron Node 호스트의 실제 PTY: 한글·재개·중단·부하·종료 정리', {
  timeout: 150000,
  skip: process.platform !== 'win32',
}, async () => {
  await mkdir(cwd, { recursive: true });
  const manager = new SessionManager({
    hostExecutable: electron,
    prepare: async (_cwd, prompt, conversation) => ({
      file: process.execPath,
      args: [
        resolve('tests/fixtures/ai-cli.cjs'),
        Buffer.from(JSON.stringify({ prompt, conversation })).toString('base64'),
      ],
      inspectHeader: true,
    }),
  });
  const id = manager.registerProject(cwd);
  assert.ok(id);
  assert.equal(manager.submit('12345678-1234-4234-8234-123456789012', 'bad project').ok, false);
  try {
    assert.equal(manager.submit(id, '--help\n한글 "인자" $(literal)').ok, true);
    assert.equal(manager.submit(id, 'duplicate').ok, false);
    assert.equal(manager.registerProject(resolve('.runtime', 'other')), null);
    await waitFor(() => manager.read(id, 0).state === 'running');
    await waitFor(() =>
      manager
        .read(id, 0)
        .chunks.map((chunk) => chunk.data)
        .join('')
        .includes('user'),
    );
    assert.equal(manager.resize(id, 110, 30).ok, true);
    await waitFor(() => !manager.busy);
    let state = manager.read(id, 0);
    assert.equal(state.state, 'exited', state.message);
    assert.equal(state.cleanupConfirmed, true);
    assert.equal(state.conversationReady, true);
    assert.match(state.chunks.map((chunk) => chunk.data).join(''), /FIXTURE_REPLY/);
    assert.match(state.chunks.map((chunk) => chunk.data).join(''), /FIXTURE_SIZE:110x30/);
    assert.equal(manager.submit(id, '다음 메시지').ok, true);
    await waitFor(() => !manager.busy);
    state = manager.read(id, 0);
    assert.equal(state.state, 'exited', state.message);
    assert.match(state.chunks.map((chunk) => chunk.data).join(''), /RESUMED/);
    assert.equal(manager.submit(id, 'WAIT').ok, true);
    await waitFor(() => manager.read(id, 0).state === 'running');
    assert.equal(manager.stop(id).ok, true);
    await waitFor(() => !manager.busy);
    state = manager.read(id, 0);
    assert.equal(state.state, 'interrupted', state.message);
    assert.equal(state.cleanupConfirmed, true);
    assert.equal(manager.reset(id).ok, true);
    assert.equal(manager.submit(id, 'BURST').ok, true);
    await waitFor(() => !manager.busy);
    state = manager.read(id, 0);
    assert.equal(state.state, 'exited', state.message);
    assert.equal(state.truncated, true);
    assert.ok(state.retainedBytes <= 512 * 1024);
    assert.equal(manager.submit(id, 'WAIT shutdown').ok, true);
    await waitFor(() => manager.read(id, 0).state === 'running');
    assert.equal(await manager.shutdown(), true);
    assert.equal(manager.busy, false);
    assert.equal(manager.submit(id, 'after shutdown').ok, false);
  } finally {
    await manager.shutdown();
  }
});
