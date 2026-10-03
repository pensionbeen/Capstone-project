import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { loadPty, readFrames, root, waitUntil } from './lib.mjs';
import { bulkEvidence } from './managed-output.mjs';

const mode = process.argv[2];
const useConptyDll = process.argv.length === 4 && process.argv[3] === '--conpty-dll';
const electronFixture = process.versions.electron && process.argv.length === 6 &&
  process.argv[3] === '--conpty-dll' && process.argv[4] === '--fixture-node' &&
  path.isAbsolute(process.argv[5]) && path.basename(process.argv[5]).toLowerCase() === 'node.exe';
const fixtureExecutable = electronFixture ? process.argv[5] : process.execPath;
const nonce = randomBytes(6).toString('hex');
let terminal, output = '', receivedBytes = 0, exitEvent, lastDataAt = 0;
let fixturePid, childPid, aborted = false, started = false, finishing = false, resultSent = false;
let failureStarted = false, faultSent = false;
const checks = [];
const send = (message) => process.send?.(message);
const add = (id, pass, evidence = {}) => checks.push({ id, status: pass ? 'PASS' : 'FAIL', ...evidence });
const frame = (type) => waitUntil(() => readFrames(output, nonce).find((item) => item.t === type), Boolean, 5000);
const emitResult = (data) => {
  if (resultSent) return;
  resultSent = true;
  send({ type: 'result', fixturePid, childPid, checks, ...data });
};
const killPty = () => { if (terminal && !exitEvent) terminal.kill(); };
const fault = () => { if (!faultSent) { faultSent = true; send({ type: 'fault' }); } };

async function prepare() {
  try {
    if (!['normal', 'forced', 'burst', 'restart'].includes(mode) ||
        (process.argv.length !== 3 && !useConptyDll && !electronFixture)) throw new Error('INVALID_MANAGED_MODE');
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('WINDOWS_X64_REQUIRED');
    const pty = loadPty();
    terminal = pty.spawn(fixtureExecutable, [path.join(root, 'managed-fixture.mjs'), nonce], {
      cwd: process.cwd(), cols: 96, rows: 30, name: 'xterm-256color',
      env: process.env, useConpty: true, ...((useConptyDll || electronFixture) ? { useConptyDll: true } : {}),
    });
    terminal.onData((text) => {
      if (resultSent && text.length) fault();
      receivedBytes += Buffer.byteLength(text);
      lastDataAt = Date.now();
      if (receivedBytes <= 1024 * 1024) output += text;
      else { aborted = true; void failure(new Error('PTY_OUTPUT_LIMIT')); }
    });
    terminal.onExit((event) => { exitEvent = event; });
    const ready = await frame('ready');
    fixturePid = terminal.pid;
    add('tty', ready.tty === true && ready.pid === fixturePid);
    terminal.write('ECHO 한글 공백 123\r');
    add('unicode', (await frame('echo')).v === '한글 공백 123');
    terminal.resize(100, 32);
    await new Promise((resolve) => setTimeout(resolve, 150));
    terminal.write('SIZE\r');
    const size = await frame('size');
    add('resize', size.cols === 100 && size.rows === 32);
    terminal.write('\u0003');
    await frame('interrupt-byte');
    add('interrupt-byte', true);
    terminal.write('SPAWN\r');
    childPid = (await frame('child')).pid;
    if (aborted) throw new Error('PTY_OUTPUT_LIMIT_OR_ABORT');
    // Both fixture processes remain alive until the supervisor captures identities.
    send({ type: 'prepared', fixturePid, childPid });
  } catch (error) { await failure(error); }
}

async function failure(error) {
  if (resultSent) { fault(); return; }
  if (failureStarted) return;
  failureStarted = true;
  aborted = true;
  let cleanupSettled = !terminal;
  try { killPty(); } catch { /* supervisor still audits actual descendants */ }
  try {
    await waitUntil(() => !terminal || Boolean(exitEvent), Boolean, 3500);
    cleanupSettled = true;
  } catch { /* report failure; supervisor audits and uses its separate bound */ }
  emitResult({ status: 'FAIL', reason: error.message || 'PTY_ERROR',
    ptyExitObserved: Boolean(exitEvent), cleanupSettled, finalOutputCollected: false });
}

async function finish() {
  try {
    if (!fixturePid || !childPid || resultSent) throw new Error('PREPARATION_REQUIRED');
    if (mode === 'burst') {
      terminal.write('BURST\r');
      await frame('burst-hash-b');
    }
    if (mode === 'forced') {
      add('live-pty-before-public-kill', !exitEvent);
      if (exitEvent) throw new Error('PTY_NOT_LIVE_AT_KILL');
      terminal.kill();
    } else terminal.write('EXIT\r');
    await waitUntil(() => exitEvent, Boolean, 5000);
    if (mode !== 'forced') await frame('final');
    // Keep collecting after PTY exit; host disposal never stands in for PTY exit.
    await waitUntil(() => Date.now() - lastDataAt, (age) => age >= 300, 1500);
    add('pty-exit', mode === 'forced' || exitEvent.exitCode === 0, { exitCode: exitEvent.exitCode });
    if (mode !== 'forced') {
      const final = JSON.stringify(await frame('final'));
      add('final-output-length-and-hash', final === '{"t":"final","code":0}',
        { bytes: Buffer.byteLength(final), hash: createHash('sha256').update(final).digest('hex') });
    }
    if (mode === 'burst') {
      const length = await frame('burst-length');
      const expectedHash = (await frame('burst-hash-a')).v + (await frame('burst-hash-b')).v;
      const evidence = bulkEvidence(output, nonce, { ...length, hash: expectedHash });
      add('bulk-complete-length-and-hash', evidence.pass,
        { lines: evidence.lines, bytes: evidence.bytes, hash: evidence.hash });
    }
    if (aborted) throw new Error('PTY_OUTPUT_LIMIT_OR_ABORT');
    emitResult({ status: 'READY_FOR_OWNER_DISPOSE', ptyExitObserved: true,
      finalOutputCollected: true, receivedBytes });
  } catch (error) { await failure(error); }
}

process.on('message', (message) => {
  if (message?.type === 'go' && !started) { started = true; void prepare(); }
  else if (message?.type === 'finish' && started && !finishing) { finishing = true; void finish(); }
  else if (message?.type === 'abort') { aborted = true; void failure(new Error('OWNER_ABORT')); }
  else void failure(new Error('OWNER_PROTOCOL_INVALID'));
});
// Intentional managed host: IPC remains open until the owner disposes this child.
// This is not a test or workaround claiming node-pty natural Node exit succeeds.
send({ type: 'host-ready' });
