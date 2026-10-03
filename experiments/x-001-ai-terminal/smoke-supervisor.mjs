import { spawn } from 'node:child_process';

export const smokeResultPrefix = 'X001_SMOKE_RESULT ';

// A PASS payload alone cannot pass: wait for the host and both pipes to close.
export function superviseSmoke(file, args, {
  timeoutMs = 30000, cleanupTimeoutMs = 4000, maxBytes = 128000, spawnWorker = spawn,
} = {}) {
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let reason;
    let exitObserved = false;
    let timer;
    let cleanupTimer;
    let settled = false;
    const finish = (code, closeObserved) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
      let payload;
      const records = stdout.split(/\r?\n/u).filter((line) => line.startsWith(smokeResultPrefix));
      if (records.length === 1) {
        try { payload = JSON.parse(records[0].slice(smokeResultPrefix.length)); }
        catch { reason ??= 'WORKER_RESULT_INVALID'; }
      } else reason ??= 'WORKER_RESULT_MISSING_OR_DUPLICATE';
      if (stderr.trim()) reason ??= 'WORKER_STDERR';
      if (!closeObserved) reason ??= 'WORKER_CLEANUP_UNCONFIRMED';
      if (code !== 0) reason ??= 'WORKER_EXIT_FAILED';
      if (payload?.cleanupConfirmed !== true) reason ??= 'DESCENDANT_CLEANUP_UNCONFIRMED';
      if (payload?.status !== 'PASS_FIXTURE_ONLY' || !Array.isArray(payload?.checks) ||
          !payload.checks.length || !payload.checks.every((check) => check && check.status === 'PASS'))
        reason ??= 'WORKER_CHECKS_FAILED';
      if (payload?.nextExecutionBlocked === true) reason ??= 'WORKER_NEXT_EXECUTION_BLOCKED';
      const ok = !reason;
      resolve({ status: ok ? 'PASS_FIXTURE_ONLY' : 'FAIL', reason: reason ?? null,
        workerExitCode: code, workerCloseObserved: closeObserved, workerExitObserved: exitObserved,
        ownedWorkerCleanup: closeObserved ? 'CLOSED' : 'UNCONFIRMED',
        descendantCleanup: !reason && payload.cleanupConfirmed ? 'FIXTURE_ONLY_CONFIRMED' : 'UNCONFIRMED',
        cleanupConfirmed: ok,
        nextExecutionBlocked: !ok, stderrObserved: Boolean(stderr.trim()),
        checks: payload?.checks ?? [], modesAttempted: payload?.modesAttempted ?? [],
        workerStatus: payload?.status ?? 'UNCONFIRMED',
        workerReason: payload?.reason ?? null });
    };
    const stop = (failure) => {
      if (settled || cleanupTimer) return;
      reason = failure;
      clearTimeout(timer);
      // Kill only the owned ChildProcess handle. Descendants are not assumed gone.
      try { child.kill(); } catch { /* bounded close observation below */ }
      cleanupTimer = setTimeout(() => finish(null, false), cleanupTimeoutMs);
    };
    try {
      child = spawnWorker(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      reason = 'WORKER_SPAWN_FAILED';
      finish(null, false);
      return;
    }
    const collect = (stream, data) => {
      if (settled) return;
      bytes += Buffer.byteLength(data);
      if (bytes > maxBytes) { stop('WORKER_OUTPUT_LIMIT'); return; }
      if (stream === 'stdout') stdout += data;
      else stderr += data;
    };
    child.stdout.setEncoding('utf8').on('data', (data) => collect('stdout', data));
    child.stderr.setEncoding('utf8').on('data', (data) => collect('stderr', data));
    child.once('error', () => { reason ??= 'WORKER_SPAWN_FAILED'; });
    child.once('exit', () => { exitObserved = true; });
    child.once('close', (code) => finish(code, true));
    timer = setTimeout(() => stop('WORKER_TIMEOUT'), timeoutMs);
  });
}

// Do not enter the next mode after missing/uncertain cleanup evidence.
export async function runSmokeModes(runMode, modes = ['normal', 'forced', 'restart']) {
  const results = [];
  for (const mode of modes) {
    const result = await runMode(mode);
    results.push({ mode, ...result });
    if (result.cleanupConfirmed !== true || result.nextExecutionBlocked === true) break;
  }
  return results;
}
