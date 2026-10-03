import { spawn } from 'node:child_process';
import { processSnapshot, SessionProcesses, validateSnapshot } from './managed-processes.mjs';

export const managedPlan = ['normal', 'forced', 'burst', ...Array(10).fill('restart')];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runManagedPlan(run) {
  const results = [];
  for (const [index, mode] of managedPlan.entries()) {
    const result = await run(mode, index);
    results.push({ mode, index, ...result });
    if (result.status !== 'PASS_MANAGED_FIXTURE_ONLY' || result.nextExecutionBlocked !== false ||
        !result.hostDisposedByOwner || !result.descendantCleanupConfirmed) break;
  }
  return managedPlan.map((mode, index) => results[index] ||
    { mode, index, status: 'NOT_RUN', reason: 'PREVIOUS_SESSION_FAILED' });
}

export async function superviseManaged(file, args, {
  snapshot = processSnapshot, spawnHost = spawn, timeoutMs = 25000,
  cleanupTimeoutMs = 4000, helperSettleMs = 6000, pollMs = 200,
  maxBytes = 65536, snapshotTimeoutMs = 3000, cwd,
} = {}) {
  let child, tracker, reason, result, prepared, closed = false, exited = false;
  let disposeRequested = false, hostDisposedByOwner = false, descendantCleanupConfirmed = false;
  let stdoutBytes = 0, stderrBytes = 0, ipcBytes = 0, ptyExitObserved = false;
  let stderrDiagnostic = '';
  let resultAt = 0, closeCode = null, closeSignal = null, hostReady = false;
  const checks = [];
  const fail = (value) => { reason ||= value; };
  const boundedSnapshot = async () => {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(snapshot), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('CIM_SNAPSHOT_TIMEOUT')), snapshotTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  const read = async () => {
    tracker.observe(await boundedSnapshot());
    if (tracker.uncertain) throw new Error('DESCENDANT_OWNERSHIP_UNCONFIRMED');
  };
  const send = (type) => {
    if (!child?.connected) throw new Error('HOST_IPC_CLOSED');
    child.send({ type }, (error) => { if (error) fail('HOST_IPC_ERROR'); });
  };
  const dispose = () => {
    if (!child || exited || closed || disposeRequested) return;
    disposeRequested = true;
    // The live ChildProcess object is the only termination target.
    try { hostDisposedByOwner = child.kill(); }
    catch { fail('OWNER_DISPOSE_FAILED'); }
    if (!hostDisposedByOwner) fail('OWNER_DISPOSE_FAILED');
  };
  try {
    const baseline = validateSnapshot(await boundedSnapshot());
    if (!baseline.some((row) => row.pid === process.pid)) {
      throw new Error('CIM_SUPERVISOR_IDENTITY_UNCONFIRMED');
    }
    child = spawnHost(file, args, { cwd, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    tracker = new SessionProcesses(baseline, child.pid, process.pid);
    child.stdout.on('data', (data) => {
      stdoutBytes += data.length;
      if (stdoutBytes + stderrBytes > maxBytes) fail('HOST_OUTPUT_LIMIT');
    });
    child.stderr.on('data', (data) => {
      stderrBytes += data.length;
      stderrDiagnostic = (stderrDiagnostic + data.toString('utf8')).slice(0, 4096);
      if (stdoutBytes + stderrBytes > maxBytes) fail('HOST_OUTPUT_LIMIT');
      // Do not interrupt the worker's cleanup on late native-helper stderr.
    });
    child.on('message', (message) => {
      ipcBytes += Buffer.byteLength(JSON.stringify(message));
      if (ipcBytes > maxBytes) { fail('HOST_IPC_LIMIT'); return; }
      if (message?.type === 'host-ready' && !hostReady && !prepared && !result) {
        hostReady = true;
      } else if (message?.type === 'prepared' && hostReady && !prepared && !result &&
          Number.isSafeInteger(message.fixturePid) && Number.isSafeInteger(message.childPid)) {
        prepared = message;
      } else if (message?.type === 'result' && !result) {
        result = message;
        resultAt = Date.now();
      } else if (message?.type === 'fault') fail('HOST_REPORTED_LATE_FAULT');
      else fail('HOST_PROTOCOL_INVALID');
    });
    child.once('error', () => fail('HOST_ERROR'));
    child.once('exit', () => { exited = true; });
    child.once('close', (code, signal) => { closed = true; closeCode = code; closeSignal = signal; });
    const deadline = Date.now() + timeoutMs;
    let finishSent = false, goSent = false;
    while (Date.now() < deadline) {
      await read();
      if (exited || closed) throw new Error('HOST_EXITED_BEFORE_OWNER_DISPOSE');
      if (reason) throw new Error(reason);
      if (hostReady && !goSent) {
        send('go'); // No PTY may be created until the live owner's CIM identity is captured.
        goSent = true;
      }
      if (prepared && !finishSent) {
        if (!tracker.hasFixture(prepared.fixturePid) || !tracker.hasFixture(prepared.childPid)) {
          throw new Error('FIXTURE_IDENTITY_UNCONFIRMED');
        }
        if (!tracker.conhostPids().some((pid) => tracker.hasFixture(pid))) {
          throw new Error('CONSOLE_HOST_IDENTITY_UNCONFIRMED');
        }
        send('finish');
        finishSent = true;
      }
      if (result) {
        ptyExitObserved = result.ptyExitObserved === true;
        if (!finishSent || !ptyExitObserved || result.finalOutputCollected !== true ||
            result.status !== 'READY_FOR_OWNER_DISPOSE' || !Array.isArray(result.checks) ||
            !result.checks.length || result.checks.some((check) => check?.status !== 'PASS') ||
            result.fixturePid !== prepared.fixturePid || result.childPid !== prepared.childPid) {
          throw new Error('PTY_RESULT_INVALID');
        }
        // HPCON/conhost can live until this dedicated host is disposed. Require
        // fixture identities gone here; audit every observed helper after close.
        if (Date.now() - resultAt >= helperSettleMs &&
            !tracker.hasFixture(prepared.fixturePid) && !tracker.hasFixture(prepared.childPid)) {
          checks.push(...result.checks);
          break;
        }
      }
      await sleep(pollMs);
    }
    if (!checks.length) throw new Error('SESSION_TIMEOUT_OR_HELPERS_REMAIN');
  } catch (error) {
    fail(error.message || 'MANAGED_SESSION_ERROR');
    // Allow public PTY cleanup to finish before disposing a failing host.
    if (child?.connected && !exited) {
      try { send('abort'); } catch { fail('HOST_IPC_ERROR'); }
      const deadline = Date.now() + cleanupTimeoutMs;
      while (!closed && result?.ptyExitObserved !== true && result?.cleanupSettled !== true &&
          Date.now() < deadline) await sleep(pollMs);
    }
  } finally {
    dispose();
    if (child) {
      const deadline = Date.now() + cleanupTimeoutMs;
      while (!closed && Date.now() < deadline) await sleep(pollMs);
      if (!closed || !exited) fail('HOST_CLOSE_UNCONFIRMED');
    }
    if (tracker) {
      const deadline = Date.now() + cleanupTimeoutMs;
      try {
        do {
          await read();
          if (tracker.alive().length === 0) { descendantCleanupConfirmed = true; break; }
          await sleep(pollMs);
        } while (Date.now() < deadline);
      } catch (error) { fail(error.message || 'DESCENDANT_AUDIT_FAILED'); }
      if (!descendantCleanupConfirmed) fail('DESCENDANT_CLEANUP_UNCONFIRMED');
    }
    if (stderrBytes) fail('HOST_STDERR');
    if (stdoutBytes) fail('UNEXPECTED_HOST_STDOUT');
    // Release only our pipes after bounded verification; no private node-pty handles.
    child?.stdout?.destroy(); child?.stderr?.destroy();
    if (!closed) { child?.unref(); child?.channel?.unref(); }
  }
  const ok = !reason && closed && exited && hostDisposedByOwner && descendantCleanupConfirmed;
  return { status: ok ? 'PASS_MANAGED_FIXTURE_ONLY' : 'FAIL', reason: reason || null, checks,
    nativeNaturalExit: false, nativeNaturalExitTest: 'NOT_ATTEMPTED_MANAGED_HOST',
    hostDisposedByOwner, hostCloseObserved: closed, hostExitObserved: exited,
    hostExitCode: closeCode, hostExitSignal: closeSignal, ptyExitObserved,
    descendantCleanupConfirmed, relatedPids: tracker?.relatedPids() || [],
    conhostPids: tracker?.conhostPids() || [], stdoutBytes, stderrBytes,
    stderrKind: stderrBytes === 0 ? 'NONE' : /AttachConsole failed/iu.test(stderrDiagnostic)
      ? 'ATTACH_CONSOLE_FAILED' : 'OTHER_STDERR',
    uncertainProcesses: [...(tracker?.uncertainProcesses.values() || [])],
    externalConsoleIdentitiesObserved: tracker?.externalConsoles.size || 0,
    nextExecutionBlocked: !ok,
    limitation: 'CIM snapshots observe known process identities; cannot prove absence of unobserved transient descendants or OS containment.' };
}
