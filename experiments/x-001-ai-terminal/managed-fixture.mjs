import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

const nonce = process.argv[2];
if (!/^[a-f0-9]{12}$/u.test(nonce || '')) throw new Error('INVALID_NONCE');
const emit = (data) => process.stdout.write('X001_' + nonce + ' ' + JSON.stringify(data) + '\r\n');
const children = new Set();
let ending = false, pending = '';
const ttl = setTimeout(() => void shutdown(3), 30000);
async function write(text) {
  if (!process.stdout.write(text)) await once(process.stdout, 'drain');
}
async function shutdown(code) {
  if (ending) return;
  ending = true;
  clearTimeout(ttl);
  for (const child of children) child.kill();
  process.stdin.removeListener('data', input);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.exitCode = code;
  // No process.exit: stdout and owned children must actually close.
  emit({ t: 'final', code });
}
async function command(text) {
  if (text.startsWith('ECHO ')) emit({ t: 'echo', v: text.slice(5) });
  else if (text === 'SIZE') emit({ t: 'size', cols: process.stdout.columns, rows: process.stdout.rows });
  else if (text === 'SPAWN') {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 25000)'],
      { stdio: 'ignore', windowsHide: true });
    children.add(child);
    child.once('exit', () => children.delete(child));
    child.once('error', () => emit({ t: 'child-error' }));
    child.once('spawn', () => emit({ t: 'child', pid: child.pid }));
  } else if (text === 'BURST') {
    const hash = createHash('sha256');
    let bytes = 0;
    for (let index = 0; index < 4096; index++) {
      const line = 'X001_BURST_' + nonce + ' ' + index.toString().padStart(4, '0') + ' abcdef0123456789\n';
      hash.update(line); bytes += Buffer.byteLength(line);
      await write(line.replace('\n', '\r\n'));
    }
    // Short frames avoid terminal wrapping of the evidence payload.
    emit({ t: 'burst-length', bytes, lines: 4096 });
    const digest = hash.digest('hex');
    emit({ t: 'burst-hash-a', v: digest.slice(0, 32) });
    emit({ t: 'burst-hash-b', v: digest.slice(32) });
  } else if (text === 'EXIT') await shutdown(0);
}
function input(chunk) {
  for (const char of chunk) {
    if (char === '\u0003') { emit({ t: 'interrupt-byte' }); pending = ''; }
    else if (char === '\r' || char === '\n') {
      const text = pending; pending = '';
      if (text) void command(text).catch(() => void shutdown(4));
    } else pending += char;
    if (pending.length > 1024) void shutdown(4);
  }
}
process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', input);
process.stdin.on('end', () => void shutdown(0));
emit({ t: 'ready', pid: process.pid, tty: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
