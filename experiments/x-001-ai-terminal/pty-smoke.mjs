import path from 'node:path';
import { report, root } from './lib.mjs';
import { superviseSmoke, runSmokeModes } from './smoke-supervisor.mjs';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--conpty-dll')) {
  await report('smoke', { status: 'BLOCKED', reason: 'INVALID_SMOKE_OPTION',
    nextExecutionBlocked: true, actualCodex: 'NOT_RUN', electron: 'NOT_RUN' });
  process.exitCode = 2;
} else {
  const modes = await runSmokeModes((mode) => superviseSmoke(process.execPath,
    [path.join(root, 'pty-smoke-worker.mjs'), '--mode', mode, ...args]));
  const failure = modes.find((mode) => mode.status !== 'PASS_FIXTURE_ONLY');
  const ok = modes.length === 3 && !failure;
  await report('smoke', { status: ok ? 'PASS_FIXTURE_ONLY' : 'FAIL',
    reason: failure?.reason ?? (ok ? null : 'MODES_INCOMPLETE'),
    modes: ['normal', 'forced', 'restart'].map((mode) => modes.find((result) => result.mode === mode) ??
      { mode, status: 'NOT_RUN', reason: 'PREVIOUS_MODE_FAILED' }),
    modesAttempted: modes.map((mode) => mode.mode), checks: modes.flatMap((mode) => mode.checks),
    nextExecutionBlocked: !ok, descendantCleanup: ok ? 'FIXTURE_ONLY_CONFIRMED' : 'UNCONFIRMED',
    modeTimeoutMs: 30000, cleanupTimeoutMs: 4000, node: process.version, nodePty: '1.1.0',
    ptyMode: args.includes('--conpty-dll') ? 'EXPERIMENTAL_CONPTY_DLL' : 'DEFAULT_CONPTY',
    actualCodex: 'NOT_RUN', electron: 'NOT_RUN',
    limitation: 'Only fixture parent/child and owned worker close are observed; ConPTY helper cleanup is not independently proved.',
  });
  process.exitCode = ok ? 0 : 1;
}
