import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { loadPty, pidState, readFrames, report, root, waitUntil, workspace } from './lib.mjs';

const checks = [];
let pty;
try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('WINDOWS_X64_REQUIRED');
  pty = loadPty();
} catch (error) {
  await report('smoke', { status: 'BLOCKED', reason: error.code || 'PTY_LOAD_FAILED',
    checks, actualCodex: 'NOT_RUN', electron: 'NOT_RUN' });
  process.exitCode = 2;
}
if (pty) {
  const cwd = await workspace();
  for (const mode of ['normal', 'forced', 'restart']) {
    const nonce = randomBytes(6).toString('hex');
    let terminal;
    let output = '';
    let exitEvent;
    let childPid;
    const listeners = [];
    const add = (id, pass, evidence = {}) => checks.push({ id, status: pass ? 'PASS' : 'FAIL', ...evidence });
    const frame = (type, match = () => true) => waitUntil(
      () => readFrames(output, nonce).find((item) => item.t === type && match(item)),
      Boolean, 5000);
    try {
      terminal = pty.spawn(process.execPath, [path.join(root, 'fixture.mjs'), nonce], {
        cwd, cols: 80, rows: 24, name: 'xterm-256color',
        env: process.env, encoding: 'utf8', useConpty: true,
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
        try { await waitUntil(() => exitEvent, Boolean, 3500); }
        catch { checks.push({ id: mode + '-cleanup', status: 'UNCONFIRMED' }); }
      }
      for (const listener of listeners) listener.dispose();
      if (childPid && pidState(childPid) !== 'gone') {
        try { await waitUntil(() => pidState(childPid), (state) => state === 'gone', 16000); }
        catch { checks.push({ id: mode + '-safety-expiry', status: 'UNCONFIRMED', pid: childPid }); }
      }
    }
  }
  const ok = checks.length > 0 && checks.every((check) => check.status === 'PASS');
  await report('smoke', {
    status: ok ? 'PASS_FIXTURE_ONLY' : 'FAIL',
    node: process.version, nodePty: '1.1.0', checks,
    actualCodex: 'NOT_RUN', electron: 'NOT_RUN',
    limitation: 'Tests the explicit fixture parent/child only; no blanket claim about all ConPTY helpers or AI descendants.',
  });
  process.exitCode = ok ? 0 : 1;
}
