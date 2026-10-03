import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  authSummary, capture, cmdInvocation, pidState, psLiteral, readFrames, root, waitUntil,
} from './lib.mjs';

test('PowerShell literals retain Unicode/spaces and escape apostrophes; reject command separators', () => {
  assert.equal(psLiteral("한글 폴더 O'Brien"), "'한글 폴더 O''Brien'");
  assert.throws(() => psLiteral('x\nexit'), /INVALID_ARGUMENT/u);
  assert.throws(() => cmdInvocation('codex.cmd', []), /ABSOLUTE_CMD_PATH_REQUIRED/u);
  const command = cmdInvocation('C:\\한글 폴더\\codex.cmd', ['login', 'status']);
  const source = Buffer.from(command.args.at(-1), 'base64').toString('utf16le');
  assert.ok(source.includes("& 'C:\\한글 폴더\\codex.cmd' 'login' 'status'"));
  assert.ok(!command.args.includes('-ExecutionPolicy'));
});

test('Auth report whitelists method and never returns raw account data', () => {
  const output = authSummary({ code: 0, stdout: 'Logged in using ChatGPT\nperson@example.test\nprivate-value', stderr: '' });
  assert.deepEqual(output, { statusCommandSucceeded: true, method: 'ChatGPT', serviceResponse: 'not-tested' });
  assert.equal(authSummary({ code: 1, stdout: 'Logged in using ChatGPT', stderr: '' }).statusCommandSucceeded, false);
});

test('Partial terminal frames cannot pass; ANSI and Unicode survive completed frames', () => {
  const nonce = '012345abcdef';
  const frame = 'X001_' + nonce + ' {"t":"echo","v":"한글 공백"}\r\n';
  assert.equal(readFrames(frame.slice(0, -5), nonce).length, 0);
  assert.deepEqual(readFrames('\u001b[32m' + frame + '\u001b[0m', nonce), [{ t: 'echo', v: '한글 공백' }]);
  assert.equal(readFrames('X001_ffffffffffff {"t":"ready"}', nonce).length, 0);
});

test('Unavailable process identity is unknown, never confirmed gone', () => {
  assert.equal(pidState(-1), 'unknown');
  assert.equal(pidState(process.pid), 'alive');
});

test('No matching observation times out instead of becoming success', async () => {
  await assert.rejects(waitUntil(() => undefined, Boolean, 10), /OBSERVATION_TIMEOUT/u);
});

test('Child capture handles a real missing executable', async () => {
  const result = await capture(path.join(root, 'no-such-executable-x001'), []);
  assert.equal(result.error, 'ENOENT');
  assert.equal(result.code, null);
});

test('Fake child protocol echoes Korean and exits using pipes; this is NOT a PTY test', async () => {
  const nonce = '012345abcdef';
  const child = spawn(process.execPath, [path.join(root, 'fixture.mjs'), nonce], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  let ended = false;
  let exitCode;
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  child.once('close', (code) => { ended = true; exitCode = code; });
  child.stdout.setEncoding('utf8').on('data', (data) => { output += data; });
  try {
    await waitUntil(() => spawnError || readFrames(output, nonce).find((item) => item.t === 'ready'), Boolean);
    if (spawnError) throw spawnError;
    assert.equal(readFrames(output, nonce)[0].tty, false);
    child.stdin.write('ECHO 한글 공백 123\n');
    await waitUntil(() => readFrames(output, nonce).find((item) => item.t === 'echo'), Boolean);
    assert.equal(readFrames(output, nonce).find((item) => item.t === 'echo').v, '한글 공백 123');
    child.stdin.write('EXIT\n');
    await waitUntil(() => ended, Boolean);
    assert.equal(exitCode, 0);
  } finally {
    if (!ended) child.kill();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
});
