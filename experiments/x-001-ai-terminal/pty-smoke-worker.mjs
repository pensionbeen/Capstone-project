import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { loadPty, pidState, readFrames, root, waitUntil, workspace } from './lib.mjs';
import { smokeResultPrefix } from './smoke-supervisor.mjs';

const checks = [];
const args = process.argv.slice(2);
const mode = args[0] === '--mode' ? args[1] : undefined;
const useConptyDll = args.slice(2).includes('--conpty-dll');
const ptyMode = useConptyDll ? 'EXPERIMENTAL_CONPTY_DLL' : 'DEFAULT_CONPTY';
const emit = (data) => console.log(smokeResultPrefix + JSON.stringify({ ...data, mode, ptyMode }));
let pty;
try {
  if (!['normal', 'forced', 'restart'].includes(mode) ||
      args.slice(2).some((arg) => arg !== '--conpty-dll')) throw new Error('INVALID_SMOKE_OPTION');
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('WINDOWS_X64_REQUIRED');
  pty = loadPty();
} catch (error) {
  emit({ status: 'BLOCKED', reason: error.code || error.message || 'PTY_LOAD_FAILED',
    checks, cleanupConfirmed: false, actualCodex: 'NOT_RUN', electron: 'NOT_RUN' });
  process.exitCode = 2;
}
if (pty) {
  const cwd = await workspace();
    const nonce = randomBytes(6).toString('hex');
    let terminal;
    let output = '';
    let exitEvent;
    let childPid;
    let childExpected = false;
    let cleanupConfirmed = false;
    const listeners = [];
    const add = (id, pass, evidence = {}) => checks.push({ id, status: pass ? 'PASS' : 'FAIL', ...evidence });
    const frame = (type, match = () => true) => waitUntil(
      () => readFrames(output, nonce).find((item) => item.t === type && match(item)),
      Boolean, 5000);
    try {
      terminal = pty.spawn(process.execPath, [path.join(root, 'fixture.mjs'), nonce], {
        cwd, cols: 80, rows: 24, name: 'xterm-256color',
        env: process.env, useConpty: true, ...(useConptyDll ? { useConptyDll: true } : {}),
      });
      listeners.push(terminal.onData((text) => { output = (output + text).slice(-65536); }));
      listeners.push(terminal.onExit((event) => { exitEvent = event; }));
      const ready = await frame('ready');
      add(mode + '-tty', ready.tty === true && ready.pid === terminal.pid);
      terminal.write('ECHO 한글 공백 123\r');
      const echoed = await frame('echo');
      add(mode + '-unicode', echoed.v === '한글 공백 123');

      if (mode === 'normal') {
        terminal.resize(96, 30);
        await new Promise((resolve) => setTimeout(resolve, 150));
        terminal.write('SIZE\r');
        const size = await frame('size', (item) => item.cols === 96 && item.rows === 30);
        add('resize', size.cols === 96 && size.rows === 30, { cols: size.cols, rows: size.rows });
        terminal.write('\u0003');
        await frame('interrupt-byte');
        add('ctrl-c-byte-to-fixture', true);
      }
      if (mode !== 'restart') {
        childExpected = true;
        terminal.write('SPAWN\r');
        const child = await frame('child');
        childPid = child.pid;
        add(mode + '-descendant-started', pidState(childPid) === 'alive');
      }
      if (mode === 'forced') terminal.kill(); // Windows: do not pass a POSIX signal.
      else terminal.write('EXIT\r');
      await waitUntil(() => exitEvent, Boolean, 5000);
      add(mode + '-exit-event', mode === 'forced' || exitEvent.exitCode === 0,
        { exitCode: exitEvent.exitCode });
      let parentGone = false;
      try { await waitUntil(() => pidState(terminal.pid), (state) => state === 'gone', 3000); parentGone = true; }
      catch { /* record failure/uncertainty, not success */ }
      add(mode + '-parent-gone', parentGone, { observed: pidState(terminal.pid) });
      if (childPid) {
        let childGone = false;
        try { await waitUntil(() => pidState(childPid), (state) => state === 'gone', 3000); childGone = true; }
        catch { /* an orphan is a failed test, even if its safety timer later expires */ }
        add(mode + '-descendant-gone-before-expiry', childGone, { observed: pidState(childPid) });
      }
    } catch (error) {
      checks.push({ id: mode, status: 'FAIL', reason: error.code || error.message });
    } finally {
      if (terminal && !exitEvent) {
        try { terminal.kill(); } catch { /* own fixture also has a 30 s lifetime cap */ }
      }
      if (terminal) {
        try {
          await waitUntil(() => Boolean(exitEvent) && pidState(terminal.pid) === 'gone' &&
            (!childExpected || (childPid && pidState(childPid) === 'gone')), Boolean, 4000);
          cleanupConfirmed = true;
        } catch {
          checks.push({ id: mode + '-cleanup', status: 'UNCONFIRMED',
            parent: pidState(terminal.pid), descendant: childPid ? pidState(childPid) :
              childExpected ? 'UNCONFIRMED' : 'NOT_STARTED',
            exitEventObserved: Boolean(exitEvent) });
        }
      }
      for (const listener of listeners) listener.dispose();
    }
  const ok = cleanupConfirmed && checks.length > 0 && checks.every((check) => check.status === 'PASS');
  emit({
    status: ok ? 'PASS_FIXTURE_ONLY' : 'FAIL',
    node: process.version, nodePty: '1.1.0', checks, cleanupConfirmed,
    modesAttempted: [mode], nextExecutionBlocked: !ok,
    actualCodex: 'NOT_RUN', electron: 'NOT_RUN',
    limitation: 'Tests the explicit fixture parent/child only; no blanket claim about all ConPTY helpers or AI descendants.',
  });
  process.exitCode = ok ? 0 : 1;
}
