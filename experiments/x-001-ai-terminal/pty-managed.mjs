import path from 'node:path';
import { report, root, workspace } from './lib.mjs';
import { runManagedPlan, superviseManaged } from './managed-supervisor.mjs';

const args = process.argv.slice(2);
const useConptyDll = args.length === 1 && args[0] === '--conpty-dll';
if ((args.length && !useConptyDll) || process.platform !== 'win32' || process.arch !== 'x64') {
  console.log(JSON.stringify({ status: 'BLOCKED', reason: 'WINDOWS_X64_NO_OPTIONS_REQUIRED',
    actualCodex: 'NOT_RUN', nextExecutionBlocked: true }));
  process.exitCode = 2;
} else {
  const cwd = await workspace();
  const modes = await runManagedPlan((mode) => superviseManaged(process.execPath,
    [path.join(root, 'managed-pty-worker.mjs'), mode, ...args], { cwd }));
  const ok = modes.every((mode) => mode.status === 'PASS_MANAGED_FIXTURE_ONLY');
  await report('pty-managed', { status: ok ? 'PASS_MANAGED_FIXTURE_ONLY' : 'FAIL',
    nodePty: '1.1.0', ptyMode: useConptyDll ? 'EXPERIMENTAL_CONPTY_DLL' : 'DEFAULT_CONPTY', modes,
    nativeNaturalExit: false, nativeNaturalExitTest: 'NOT_ATTEMPTED_MANAGED_HOST',
    hostDisposedByOwner: modes.filter((mode) => mode.status !== 'NOT_RUN')
      .every((mode) => mode.hostDisposedByOwner), nextExecutionBlocked: !ok,
    actualCodex: 'NOT_RUN', electron: 'NOT_RUN' });
  process.exitCode = ok ? 0 : 1;
}
