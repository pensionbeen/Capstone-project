import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { smokeResultPrefix, superviseSmoke, runSmokeModes } from './smoke-supervisor.mjs';

const pass = { status: 'PASS_FIXTURE_ONLY', cleanupConfirmed: true,
  checks: [{ id: 'fake-only', status: 'PASS' }] };
const emit = (payload = pass) => 'console.log(' + JSON.stringify(smokeResultPrefix + JSON.stringify(payload)) + ');';
const supervise = (script, options = {}) => superviseSmoke(process.execPath, ['-e', script],
  { timeoutMs: 2000, cleanupTimeoutMs: 500, ...options });

test('Smoke supervisor waits for real host close after PASS; normal fake host passes', async () => {
  const started = Date.now();
  const result = await supervise(emit() + 'setTimeout(() => {}, 150);');
  assert.equal(result.status, 'PASS_FIXTURE_ONLY');
  assert.equal(result.workerCloseObserved, true);
  assert.equal(result.workerExitObserved, true);
  assert.equal(result.nextExecutionBlocked, false);
  assert.ok(Date.now() - started >= 150);
});

test('First worker PASS followed by late helper stderr prevents the second worker spawn', async () => {
  const attempted = [];
  const modes = await runSmokeModes((mode) => supervise(
    emit() + "setTimeout(() => process.stderr.write('AttachConsole failed'), 40);", {
      spawnWorker(file, args, options) {
        attempted.push(mode);
        return spawn(file, args, options);
      },
    }));
  const result = modes[0];
  assert.deepEqual(attempted, ['normal']);
  assert.equal(modes.length, 1);
  assert.equal(result.workerExitCode, 0);
  assert.equal(result.reason, 'WORKER_STDERR');
  assert.equal(result.status, 'FAIL');
  assert.equal(result.nextExecutionBlocked, true);
  assert.equal(result.descendantCleanup, 'UNCONFIRMED');
});

test('PASS followed by host hang times out, closes owned host, and blocks next execution', async () => {
  const attempted = [];
  const started = Date.now();
  const modes = await runSmokeModes((mode) => supervise(emit() + 'setInterval(() => {}, 1000);', {
    timeoutMs: 300,
    spawnWorker(file, args, options) {
      attempted.push(mode);
      return spawn(file, args, options);
    },
  }));
  assert.deepEqual(attempted, ['normal']);
  assert.equal(modes[0].reason, 'WORKER_TIMEOUT');
  assert.equal(modes[0].workerCloseObserved, true);
  assert.equal(modes[0].nextExecutionBlocked, true);
  assert.ok(Date.now() - started < 2000);
});

test('Separate fake workers advance all modes only after each host closes successfully', async () => {
  const attempted = [];
  const closed = [];
  const modes = await runSmokeModes((mode) => supervise(emit() + 'setTimeout(() => {}, 40);', {
    spawnWorker(file, args, options) {
      assert.equal(closed.length, attempted.length);
      attempted.push(mode);
      const child = spawn(file, args, options);
      child.once('close', () => closed.push(mode));
      return child;
    },
  }));
  assert.deepEqual(attempted, ['normal', 'forced', 'restart']);
  assert.deepEqual(closed, attempted);
  assert.equal(modes.length, 3);
  assert.ok(modes.every((mode) => mode.cleanupConfirmed && mode.workerCloseObserved && !mode.nextExecutionBlocked));
});

test('Worker cleanup uncertainty stops subsequent smoke modes even with PASS records', async () => {
  const attempted = [];
  const result = await runSmokeModes(async (mode) => {
    attempted.push(mode);
    return { cleanupConfirmed: false };
  });
  assert.deepEqual(attempted, ['normal']);
  assert.equal(result.length, 1);
  const worker = await supervise(emit({ ...pass, cleanupConfirmed: false,
    checks: [{ id: 'remaining-child', status: 'UNCONFIRMED' }] }));
  assert.equal(worker.reason, 'DESCENDANT_CLEANUP_UNCONFIRMED');
  assert.equal(worker.nextExecutionBlocked, true);
});

test('Failed owned host termination has a separate bounded cleanup deadline', async () => {
  const started = Date.now();
  const script = emit() + 'setTimeout(() => {}, 1200);';
  let ownedChild;
  const result = await supervise(script, { timeoutMs: 300, cleanupTimeoutMs: 100,
    spawnWorker(file, args, options) {
      ownedChild = spawn(file, args, options);
      // Emulate a rejected termination request; the real fake host has a safety timer.
      ownedChild.kill = () => false;
      return ownedChild;
    } });
  assert.equal(result.workerExitObserved, false);
  assert.equal(result.workerCloseObserved, false);
  assert.equal(result.ownedWorkerCleanup, 'UNCONFIRMED');
  assert.equal(result.descendantCleanup, 'UNCONFIRMED');
  assert.equal(result.nextExecutionBlocked, true);
  assert.ok(Date.now() - started < 1000);
  // Restore cleanup through the owned handle only after testing the failure branch.
  ownedChild.kill = Object.getPrototypeOf(ownedChild).kill;
  ownedChild.kill();
});

test('Nonzero host exit, invalid checks, and missing or duplicate worker results cannot pass', async () => {
  for (const script of [emit() + 'process.exitCode=1;', emit({ ...pass, checks: [null] }),
    'console.log("unrelated PASS");', emit() + emit()]) {
    const result = await supervise(script);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.nextExecutionBlocked, true);
  }
});

test('Worker output overflow terminates only owned host and cannot count as success', async () => {
  const result = await supervise(emit() + "process.stdout.write('x'.repeat(10000));setInterval(() => {}, 1000);",
    { maxBytes: 512 });
  assert.equal(result.reason, 'WORKER_OUTPUT_LIMIT');
  assert.equal(result.status, 'FAIL');
  assert.equal(result.nextExecutionBlocked, true);
});
