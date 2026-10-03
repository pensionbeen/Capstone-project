import { spawn } from 'node:child_process';

// Intentionally fake child process; never launches an AI or reads user data.
const nonce = process.argv[2];
if (!/^[a-f0-9]{12}$/u.test(nonce || '')) throw new Error('INVALID_NONCE');
const children = new Set();
const emit = (data) => process.stdout.write('X001_' + nonce + ' ' + JSON.stringify(data) + '\r\n');
const ttl = setTimeout(() => shutdown(3), 30000);
let ending = false;
async function shutdown(code) {
  if (ending) return;
  ending = true;
  clearTimeout(ttl);
  for (const child of children) child.kill(); // Own ChildProcess handles.
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  emit({ t: 'exit', code });
  process.stdout.write('', () => process.exit(code));
}
process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let pending = '';
process.stdin.on('data', (chunk) => {
  for (const char of chunk) {
    if (char === '\u0003') {
      emit({ t: 'interrupt-byte' });
      pending = '';
    } else if (char === '\r' || char === '\n') {
      const input = pending; pending = '';
      if (input.startsWith('ECHO ')) emit({ t: 'echo', v: input.slice(5) });
      else if (input === 'SIZE') emit({ t: 'size', cols: process.stdout.columns || 0, rows: process.stdout.rows || 0 });
      else if (input === 'SPAWN') {
        // The descendant expires after 15 s even if the PTY doesn't clean it up.
        // Smoke checks orphaning BEFORE expiry; expiry is not treated as a pass.
        const child = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),15000)'], {
          stdio: 'ignore', windowsHide: true,
        });
        children.add(child);
        child.once('error', () => emit({ t: 'child-error' }));
        child.once('exit', () => children.delete(child));
        child.once('spawn', () => emit({ t: 'child', pid: child.pid }));
      } else if (input === 'EXIT') void shutdown(0);
    } else pending += char;
    if (pending.length > 1024) void shutdown(4);
  }
});
process.stdin.on('end', () => void shutdown(0));
emit({ t: 'ready', pid: process.pid, tty: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
