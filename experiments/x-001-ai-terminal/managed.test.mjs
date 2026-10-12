import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { bulkEvidence } from './managed-output.mjs';
import { SessionProcesses, validateSnapshot, excludeSnapshotObserver,
  SnapshotQueryHistory, snapshotQueryEvidence, processSnapshot } from './managed-processes.mjs';
import { managedPlan, runManagedPlan, superviseManaged } from './managed-supervisor.mjs';

const row = (pid, parent, age, name = 'node.exe') =>
  ({ pid, parent, created: new Date(age).toISOString(), name });
const prepared = { type: 'prepared', fixturePid: 19001, childPid: 19002 };
const result = { type: 'result', fixturePid: 19001, childPid: 19002,
  status: 'READY_FOR_OWNER_DISPOSE', ptyExitObserved: true, finalOutputCollected: true,
  checks: [{ id: 'fake-pty-only', status: 'PASS' }] };

function mockSnapshotQuery(context, reply) {
  const calls = [];
  context.mock.method(childProcess, 'execFile', (_file, _args, options, callback) => {
    calls.push(options);
    const value = reply();
    if (value.synchronous) throw value.error;
    queueMicrotask(() => callback(value.error, value.stdout, value.stderr));
    return { pid: process.pid + 1 };
  });
  syncBuiltinESMExports();
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

test('Snapshot query callbacks use the selected finite deadline without changing the shared default',
  { skip: process.platform !== 'win32' }, async context => {
    const supervisor = row(process.pid, 4, 500);
    const query = row(process.pid + 1, process.pid, 1000, 'powershell.exe');
    const calls = mockSnapshotQuery(context, () => ({ error: null,
      stdout: JSON.stringify([supervisor, query]), stderr: '' }));
    for (const [options, deadline] of [[undefined, 2000], [{ timeoutMs: 4000 }, 4000]]) {
      assert.deepEqual(await processSnapshot(options), [supervisor]);
      assert.equal(calls.at(-1).timeout, deadline);
      const evidence = snapshotQueryEvidence().queries.at(-1);
      assert.equal(evidence.timeoutMs, deadline);
      assert.equal(evidence.result, 'SUCCESS');
      assert.equal(evidence.failureKind, null);
    }
    assert.equal(calls.length, 2);
  });

test('Snapshot query callbacks reject every failure without retry and retain only fixed failure kinds',
  { skip: process.platform !== 'win32' }, async context => {
    let reply;
    const calls = mockSnapshotQuery(context, () => reply);
    const failure = fields => Object.assign(new Error('PRIVATE_ERROR'), { cmd: 'PRIVATE_PATH', ...fields });
    const rows = [row(process.pid, 4, 500), row(process.pid + 1, process.pid, 1000, 'powershell.exe')];
    const cases = [
      [failure({ killed: true, signal: 'SIGTERM', code: null }), '', '', 'TERMINATED', 'CIM_SNAPSHOT_FAILED'],
      [failure({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }), '', '', 'OUTPUT_LIMIT', 'CIM_SNAPSHOT_FAILED'],
      [failure({ code: 'ENOENT' }), '', '', 'SPAWN_FAILED', 'CIM_SNAPSHOT_FAILED'],
      [failure({ code: 'ENOENT' }), '', '', 'SPAWN_FAILED', 'CIM_SNAPSHOT_FAILED', true],
      [failure({ code: 1 }), '', '', 'NONZERO_EXIT', 'CIM_SNAPSHOT_FAILED'],
      [failure({ code: 'PRIVATE_CODE' }), '', '', 'QUERY_ERROR', 'CIM_SNAPSHOT_FAILED'],
      [null, JSON.stringify(rows), 'PRIVATE_STDERR', 'STDERR', 'CIM_SNAPSHOT_FAILED'],
      [null, 'PRIVATE_INVALID_JSON', '', 'INVALID_JSON', 'CIM_SNAPSHOT_INVALID'],
      [null, '[]', '', 'INVALID_SNAPSHOT', 'CIM_SNAPSHOT_INVALID'],
      [null, JSON.stringify([rows[0]]), '', 'OBSERVER_UNCONFIRMED', 'CIM_SNAPSHOT_INVALID'],
    ];
    for (const [error, stdout, stderr, kind, reason, synchronous] of cases) {
      reply = { error, stdout, stderr, synchronous };
      const before = calls.length;
      await assert.rejects(processSnapshot({ timeoutMs: 4000 }), { message: reason });
      assert.equal(calls.length, before + 1, 'a failed query is never retried as success');
      const evidence = snapshotQueryEvidence().queries.at(-1);
      assert.equal(evidence.result, reason);
      assert.equal(evidence.failureKind, kind);
      assert.equal(evidence.timeoutMs, 4000);
      assert.equal(evidence.query, null);
      assert.equal(JSON.stringify(evidence).includes('PRIVATE_'), false);
    }
  });

test('Snapshot query callbacks preserve their result when diagnostic recording throws',
  { skip: process.platform !== 'win32' }, async context => {
    const supervisor = row(process.pid, 4, 500);
    const query = row(process.pid + 1, process.pid, 1000, 'powershell.exe');
    let reply = { error: null, stdout: JSON.stringify([supervisor, query]), stderr: '' };
    const calls = mockSnapshotQuery(context, () => reply);
    context.mock.method(SnapshotQueryHistory.prototype, 'complete', () => { throw new Error('PRIVATE_ERROR'); });
    assert.deepEqual(await processSnapshot({ timeoutMs: 4000 }), [supervisor]);
    reply = { error: null, stdout: JSON.stringify([supervisor, query]), stderr: 'PRIVATE_STDERR' };
    await assert.rejects(processSnapshot({ timeoutMs: 4000 }), { message: 'CIM_SNAPSHOT_FAILED' });
    assert.equal(calls.length, 2);
  });

test('Snapshot query diagnostics record only the exact query identity with a fixed schema', () => {
  const history = new SnapshotQueryHistory();
  const query = { ...row(100, 90, 1000, 'powershell.exe'), commandLine: 'PRIVATE_COMMAND',
    path: 'PRIVATE_PATH', credential: 'PRIVATE_CREDENTIAL', env: 'PRIVATE_ENV' };
  const rows = [row(90, 4, 500), query, row(777, 4, 1000, 'PRIVATE_OTHER_PROCESS')];
  const original = structuredClone(rows);
  const sequence = history.begin(4000);
  assert.equal(history.report().queries[0].result, 'PENDING');
  history.complete(sequence, 100, 90, rows, 'SUCCESS');
  const evidence = history.report();
  assert.deepEqual(Object.keys(evidence).sort(), ['available', 'limit', 'queries', 'total', 'truncated']);
  assert.equal(evidence.available, true);
  assert.equal(evidence.total, 1);
  assert.equal(evidence.truncated, false);
  assert.deepEqual(Object.keys(evidence.queries[0]).sort(),
    ['completedAt', 'failureKind', 'query', 'queryPid', 'result', 'sequence', 'startedAt', 'timeoutMs']);
  assert.deepEqual(evidence.queries[0].query, row(100, 90, 1000, 'powershell.exe'));
  assert.equal(evidence.queries[0].queryPid, 100);
  assert.equal(evidence.queries[0].result, 'SUCCESS');
  assert.equal(evidence.queries[0].timeoutMs, 4000);
  assert.equal(evidence.queries[0].failureKind, null);
  assert.ok(Number.isFinite(Date.parse(evidence.queries[0].startedAt)));
  assert.ok(Number.isFinite(Date.parse(evidence.queries[0].completedAt)));
  assert.equal(JSON.stringify(evidence).includes('PRIVATE_'), false);
  assert.deepEqual(rows, original, 'diagnostics do not mutate the process snapshot');
  evidence.queries[0].query.pid = 999;
  evidence.queries[0].result = 'ALTERED';
  assert.equal(history.report().queries[0].query.pid, 100);
  assert.equal(history.report().queries[0].result, 'SUCCESS');
});

test('Snapshot query diagnostics keep failures and unconfirmed identities separate from success', () => {
  const history = new SnapshotQueryHistory();
  const query = row(100, 90, 1000, 'powershell.exe');
  for (const result of ['CIM_SNAPSHOT_FAILED', 'CIM_SNAPSHOT_INVALID']) {
    history.complete(history.begin(), 100, 90, [query], result);
  }
  history.complete(history.begin(), undefined, 90, undefined, 'PRIVATE_ERROR_DETAIL');
  for (const rows of [undefined, [], [row(100, 999, 1000, 'powershell.exe')],
    [query, query], [{ ...query, created: 'PRIVATE_TIME' }],
    [{ ...query, name: 'PRIVATE_PATH/powershell.exe' }],
    [{ ...query, name: 'powershell.exe\nPRIVATE_DETAIL' }]]) {
    history.complete(history.begin(), 100, 90, rows, 'SUCCESS');
  }
  history.complete(history.begin('PRIVATE_TIMEOUT'), 100, 90, undefined,
    'CIM_SNAPSHOT_FAILED', 'PRIVATE_FAILURE_KIND');
  const evidence = history.report();
  assert.deepEqual(evidence.queries.slice(0, 3).map(entry => entry.result),
    ['CIM_SNAPSHOT_FAILED', 'CIM_SNAPSHOT_INVALID', 'DIAGNOSTIC_INVALID']);
  assert.equal(evidence.queries[2].queryPid, null);
  assert.equal(evidence.queries.at(-1).timeoutMs, null);
  assert.equal(evidence.queries.at(-1).failureKind, 'UNCLASSIFIED');
  assert.ok(evidence.queries.every(entry => entry.query === null && entry.completedAt));
  assert.equal(JSON.stringify(evidence).includes('PRIVATE_'), false);
});

test('Snapshot query diagnostics retain only the latest 128 starts and never replace completed results', () => {
  const history = new SnapshotQueryHistory();
  const sequences = Array.from({ length: 140 }, () => history.begin());
  for (const sequence of [...sequences].reverse()) {
    history.complete(sequence, 100 + sequence, 90, undefined, 'CIM_SNAPSHOT_FAILED');
  }
  const evidence = history.report();
  assert.equal(evidence.limit, 128);
  assert.equal(evidence.total, 140);
  assert.equal(evidence.truncated, true);
  assert.equal(evidence.queries.length, 128);
  assert.deepEqual(evidence.queries.map(entry => entry.sequence), sequences.slice(12));
  assert.ok(evidence.queries.every(entry => entry.result === 'CIM_SNAPSHOT_FAILED'));
  history.complete(140, 9999, 90, [], 'SUCCESS');
  history.complete(1, 9999, 90, [], 'SUCCESS');
  assert.deepEqual(history.report(), evidence);
});

test('Snapshot query diagnostics never authorize an unobserved orphan or change query exclusions', () => {
  const history = new SnapshotQueryHistory();
  const supervisor = row(90, 4, 500);
  const query = row(100, 90, 1000, 'powershell.exe');
  const rows = [supervisor, query, row(101, 100, 2000, 'conhost.exe')];
  history.complete(history.begin(), 100, 90, rows, 'SUCCESS');
  assert.deepEqual(excludeSnapshotObserver(rows, 100, 90), [supervisor]);
  const tracking = new SessionProcesses([supervisor], 200, 90);
  tracking.observe([supervisor, row(200, 90, 2000), row(777, 100, 3000, 'conhost.exe')]);
  assert.equal(tracking.uncertain, true, 'recorded parent PID alone is not ownership proof');
  assert.deepEqual(tracking.relatedPids(), [200]);
});

test('Snapshot query diagnostics report failures without throwing or exposing error text', context => {
  context.mock.method(SnapshotQueryHistory.prototype, 'report', () => { throw new Error('PRIVATE_ERROR'); });
  assert.deepEqual(snapshotQueryEvidence(), {
    available: false, limit: 128, total: null, truncated: true, queries: [],
  });
});

test('CIM excludes only its exact query child and observed descendants, never names alone', () => {
  const supervisor = row(90, 4, 500);
  const unrelated = row(333, 4, 1000, 'conhost.exe');
  const fixture = row(444, 90, 1000);
  const fixtureConsole = row(445, 444, 2000, 'conhost.exe');
  const rows = [supervisor, row(100, 90, 1000, 'powershell.exe'),
    row(101, 100, 2000, 'conhost.exe'), unrelated, fixture, fixtureConsole];
  assert.deepEqual(excludeSnapshotObserver(rows, 100, 90), [supervisor, unrelated, fixture, fixtureConsole]);
  assert.throws(() => excludeSnapshotObserver(rows, 100, 777));
  assert.throws(() => excludeSnapshotObserver(rows, 999, 90));
});

test('CIM query exclusions retain captured helpers and never suppress reused PIDs', () => {
  const supervisor = row(90, 4, 500);
  const known = new Set();
  const oldHelper = row(101, 100, 2000, 'conhost.exe');
  excludeSnapshotObserver([supervisor, row(100, 90, 1000), oldHelper], 100, 90, known);
  assert.deepEqual(excludeSnapshotObserver([supervisor, row(200, 90, 3000), oldHelper], 200, 90, known), [supervisor]);
  const reused = row(101, 999, 4000, 'conhost.exe');
  assert.deepEqual(excludeSnapshotObserver([supervisor, row(300, 90, 5000), reused], 300, 90, known), [supervisor, reused]);
  const older = row(301, 300, 4000, 'conhost.exe');
  assert.deepEqual(excludeSnapshotObserver([supervisor, row(300, 90, 5000), older], 300, 90), [supervisor, older]);
});

test('External consoles need a live ancestry chain to an exact unrelated baseline identity', () => {
  const supervisor = row(90, 4, 500);
  const editor = row(500, 4, 500, 'editor.exe');
  const host = row(100, 90, 1000);
  const git = row(501, 500, 2000, 'git.exe');
  const consoleHost = row(502, 501, 3000, 'conhost.exe');
  const tracking = new SessionProcesses([supervisor, editor], 100, 90);
  tracking.observe([supervisor, editor, host, git, consoleHost]);
  assert.equal(tracking.uncertain, false);
  assert.deepEqual(tracking.relatedPids(), [100]);
  assert.equal(tracking.externalConsoles.size, 1);
  const previousChild = row(600, 90, 700);
  const underSupervisor = new SessionProcesses([supervisor, previousChild], 100, 90);
  underSupervisor.observe([supervisor, previousChild, host, row(601, 600, 2000, 'conhost.exe')]);
  assert.equal(underSupervisor.uncertain, true, 'baseline supervisor descendants are not external ancestors');
  for (const rows of [[supervisor, editor, host, consoleHost],
    [supervisor, row(500, 4, 4000), host, git, consoleHost],
    [supervisor, host, row(501, 90, 2000), consoleHost]]) {
    const uncertain = new SessionProcesses([supervisor, editor], 100, 90);
    uncertain.observe(rows);
    assert.equal(uncertain.uncertain, true);
  }
});

async function fakeSession({ afterResult = '', omitResult = false, remaining = false,
  rejectKill = false, snapshotFailure = false, helperUntilClose = false,
  noConsole = false, emptyAfterClose = false, hangSnapshot = false, ...options } = {}) {
  let child, stage = 'before', closed = false, scans = 0;
  const supervisorRow = row(process.pid, 4, 500);
  const commands = [];
  const script = `process.send({type:'host-ready'});
    process.on('message', m => {
      if(m.type==='go') process.send(${JSON.stringify(prepared)});
      if(m.type==='finish') {
        ${omitResult ? '' : 'process.send(' + JSON.stringify(result) + ');'}
        ${afterResult}
      }
      if(m.type==='abort') process.send({type:'result',status:'FAIL'});
    });`;
  try {
    const observed = await superviseManaged(process.execPath, ['-e', script], {
      timeoutMs: 2000, cleanupTimeoutMs: 150, helperSettleMs: 100, pollMs: 10,
      spawnHost(file, args, spawnOptions) {
        assert.equal(scans, 1, 'first successful CIM precedes host spawn');
        child = spawn(file, args, spawnOptions);
        const send = child.send.bind(child);
        child.send = (message, callback) => {
          commands.push(message.type);
          if (message.type === 'go') assert.ok(scans >= 2, 'owner identity precedes PTY go');
          return send(message, callback);
        };
        child.on('message', (message) => {
          if (message.type === 'prepared') stage = 'prepared';
          if (message.type === 'result') stage = 'result';
        });
        child.once('close', () => { closed = true; });
        if (rejectKill) child.kill = () => false;
        return child;
      },
      snapshot: async () => {
        scans++;
        if (!child) return [supervisorRow];
        if (hangSnapshot && scans > 2) return new Promise(() => {});
        if (emptyAfterClose && closed) return [];
        if (snapshotFailure && scans > 2) throw new Error('CIM_SNAPSHOT_FAILED');
        const rows = closed ? [supervisorRow] : [supervisorRow, row(child.pid, process.pid, 1000)];
        if (stage === 'prepared' || (remaining && stage === 'result')) {
          rows.push(row(19001, child.pid, 2000), row(19002, 19001, 3000));
          if (!noConsole) rows.push(row(19003, child.pid, 2000, 'conhost.exe'));
        }
        if (helperUntilClose && stage === 'result' && !closed) {
          rows.push(row(19003, child.pid, 2000, 'conhost.exe'));
        }
        return rows;
      }, ...options,
    });
    return { observed, commands, child, closed };
  } finally {
    if (child && !closed) {
      child.kill = Object.getPrototypeOf(child).kill;
      child.kill(); // Test cleanup uses only its actual owned handle.
      await new Promise((resolve) => child.once('close', resolve));
    }
  }
}

test('Managed host passes only after owner disposal, real close, and captured identities disappear', async () => {
  const { observed, commands, closed } = await fakeSession({ helperUntilClose: true });
  assert.equal(observed.status, 'PASS_MANAGED_FIXTURE_ONLY');
  assert.equal(observed.nativeNaturalExit, false);
  assert.equal(observed.nativeNaturalExitTest, 'NOT_ATTEMPTED_MANAGED_HOST');
  assert.equal(observed.hostDisposedByOwner, true);
  assert.equal(observed.hostCloseObserved, true);
  assert.equal(observed.descendantCleanupConfirmed, true);
  assert.deepEqual(observed.conhostPids, [19003]);
  assert.deepEqual(commands, ['go', 'finish']);
  assert.equal(closed, true);
});

test('Late helper stderr after PTY result is collected before pass and prevents second session', async () => {
  let calls = 0;
  const modes = await runManagedPlan(async () => {
    calls++;
    return (await fakeSession({ afterResult: "setTimeout(() => process.stderr.write('AttachConsole failed'), 50);" })).observed;
  });
  assert.equal(calls, 1);
  assert.equal(modes[0].reason, 'HOST_STDERR');
  assert.equal(modes[0].hostCloseObserved, true);
  assert.ok(modes.slice(1).every((mode) => mode.status === 'NOT_RUN'));
});

test('Missing PTY result times out and owner host disposal never substitutes for PTY exit', async () => {
  let calls = 0;
  const modes = await runManagedPlan(async () => {
    calls++;
    return (await fakeSession({ omitResult: true, timeoutMs: 200 })).observed;
  });
  assert.equal(calls, 1);
  assert.equal(modes[0].status, 'FAIL');
  assert.equal(modes[0].ptyExitObserved, false);
  assert.equal(modes[0].hostDisposedByOwner, true);
  assert.equal(modes[0].hostCloseObserved, true);
});

test('Captured remaining descendants and CIM failure block later sessions', async () => {
  for (const config of [{ remaining: true, timeoutMs: 250 }, { snapshotFailure: true }]) {
    const { observed } = await fakeSession(config);
    assert.equal(observed.status, 'FAIL');
    assert.equal(observed.descendantCleanupConfirmed, false);
    assert.equal(observed.nextExecutionBlocked, true);
  }
});

test('Rejected owner termination cannot claim host close and uses a bounded deadline', async () => {
  const started = Date.now();
  const { observed } = await fakeSession({ rejectKill: true });
  assert.equal(observed.hostDisposedByOwner, false);
  assert.equal(observed.hostCloseObserved, false);
  assert.equal(observed.status, 'FAIL');
  assert.ok(Date.now() - started < 1800);
});

test('Invalid/incomplete CIM snapshot blocks spawn rather than becoming an empty process list', async () => {
  let spawned = false;
  const observed = await superviseManaged('unused', [], {
    snapshot: async () => [{ pid: 8, parent: 4, name: 'node.exe' }],
    spawnHost: () => { spawned = true; },
  });
  assert.equal(spawned, false);
  assert.equal(observed.status, 'FAIL');
  assert.throws(() => validateSnapshot(null));
  assert.throws(() => validateSnapshot([row(8, 4, 1000), row(8, 4, 2000)]));
});

test('Creation identities retain reparented helpers, avoid PID reuse, and reject unrelated new console hosts', () => {
  const supervisor = row(90, 4, 500);
  const tracking = new SessionProcesses([supervisor], 100, 90);
  tracking.observe([supervisor, row(100, 90, 1000), row(101, 100, 2000), row(102, 101, 3000, 'conhost.exe')]);
  tracking.observe([supervisor, row(100, 90, 1000), row(102, 4, 3000, 'conhost.exe'), row(101, 4, 4000)]);
  assert.deepEqual(tracking.alive({ includeOwner: false }), [102]);
  assert.equal(tracking.hasFixture(101), false, 'reused PID is not captured fixture identity');
  tracking.observe([supervisor, row(100, 90, 1000), row(777, 4, 5000, 'OpenConsole.exe')]);
  assert.equal(tracking.uncertain, true);
  assert.ok(!tracking.relatedPids().includes(777), 'unrelated PID is not exposed as owned');
});

test('Empty, missing, or reused supervisor identity never proves descendant cleanup', async () => {
  const supervisor = row(90, 4, 500);
  const tracking = new SessionProcesses([supervisor], 100, 90);
  tracking.observe([supervisor, row(100, 90, 1000)]);
  assert.throws(() => tracking.observe([]));
  assert.throws(() => tracking.observe([row(777, 4, 2000)]));
  assert.throws(() => tracking.observe([row(90, 4, 3000)]));
  const { observed } = await fakeSession({ snapshot: async () => [] });
  assert.equal(observed.status, 'FAIL');
  assert.equal(observed.descendantCleanupConfirmed, false);
  const afterClose = (await fakeSession({ emptyAfterClose: true })).observed;
  assert.equal(afterClose.hostCloseObserved, true);
  assert.equal(afterClose.descendantCleanupConfirmed, false);
  assert.equal(afterClose.status, 'FAIL');
});

test('Live fixture identities without a captured console host cannot pass or start the next session', async () => {
  let attempted = 0;
  const modes = await runManagedPlan(async () => {
    attempted++;
    return (await fakeSession({ noConsole: true })).observed;
  });
  assert.equal(attempted, 1);
  assert.equal(modes[0].reason, 'CONSOLE_HOST_IDENTITY_UNCONFIRMED');
  assert.equal(modes[0].status, 'FAIL');
  assert.ok(modes.slice(1).every((mode) => mode.status === 'NOT_RUN'));
});

test('Managed plan runs ten sequential restarts only after each prior audit passes', async () => {
  const indices = [];
  const modes = await runManagedPlan(async (mode, index) => {
    indices.push(index);
    return { status: 'PASS_MANAGED_FIXTURE_ONLY', nextExecutionBlocked: false,
      hostDisposedByOwner: true, descendantCleanupConfirmed: true };
  });
  assert.equal(managedPlan.length, 13);
  assert.equal(modes.filter((mode) => mode.mode === 'restart').length, 10);
  assert.deepEqual(indices, Array.from({ length: 13 }, (_, index) => index));
});

test('Bulk evidence requires actual line boundaries, sequence, byte count and hash', () => {
  const nonce = 'abcdef012345';
  const payload = [0, 1].map(n => 'X001_BURST_' + nonce + ' ' + String(n).padStart(4, '0') + ' abcdef0123456789\n').join('');
  const expected = { lines: 2, bytes: Buffer.byteLength(payload), hash: createHash('sha256').update(payload).digest('hex') };
  assert.equal(bulkEvidence(payload, nonce, expected).pass, true);
  assert.equal(bulkEvidence(payload.replaceAll('\n', '\r\n'), nonce, expected).pass, true);
  assert.equal(bulkEvidence(payload.replaceAll('\n', ''), nonce, expected).pass, false);
  assert.equal(bulkEvidence(payload.trimEnd(), nonce, expected).pass, false);
  assert.equal(bulkEvidence(payload.replace('0001', '0000'), nonce, expected).pass, false);
});

test('A late worker fault after a valid result prevents managed PASS', async () => {
  const { observed } = await fakeSession({ afterResult: "setTimeout(() => process.send({type:'fault'}), 25);" });
  assert.equal(observed.status, 'FAIL');
  assert.equal(observed.reason, 'HOST_REPORTED_LATE_FAULT');
  assert.equal(observed.nextExecutionBlocked, true);
});

test('A snapshot promise that never resolves is bounded before and after host creation', async () => {
  let spawned = false;
  const before = await superviseManaged('unused', [], { snapshot: () => new Promise(() => {}),
    snapshotTimeoutMs: 20, spawnHost: () => { spawned = true; throw Error('MUST_NOT_SPAWN'); } });
  assert.equal(spawned, false);
  assert.equal(before.reason, 'CIM_SNAPSHOT_TIMEOUT');
  const { observed } = await fakeSession({ hangSnapshot: true, snapshotTimeoutMs: 20 });
  assert.equal(observed.status, 'FAIL');
  assert.equal(observed.reason, 'CIM_SNAPSHOT_TIMEOUT');
  assert.equal(observed.hostCloseObserved, true);
  assert.equal(observed.descendantCleanupConfirmed, false);
});
