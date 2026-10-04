import headless from '@xterm/headless';
import * as pty from 'node-pty';
import { readCodexHeader } from './codex.js';
import { MAX_TURN_OUTPUT, sizeIsValid } from './contracts.js';

// This module only runs in a dedicated Electron Node child, never in the renderer.
let terminal: pty.IPty | undefined;
let screen: headless.Terminal | undefined;
let started = false;
let exited = false;
let stopping = false;
let disconnected = false;
let pending = '';
let total = 0;
let unacknowledged = 0;
let cols = 100;
let rows = 28;
let pendingSize: { cols: number; rows: number } | undefined;
let lastOutput = Date.now();
let headerFound = false;
let headerBytes = 0;
let reason: string | undefined;
let stopTimer: ReturnType<typeof setTimeout> | undefined;
let forceTimer: ReturnType<typeof setTimeout> | undefined;

function send(message: object) {
  if (!process.connected || !process.send) return;
  process.send(message, (error) => {
    if (error) disconnect();
  });
}
function flush() {
  if (!pending) {
    applyResize();
    return;
  }
  if (unacknowledged >= 128 * 1024) return;
  const data = pending.slice(0, 4096);
  pending = pending.slice(data.length);
  unacknowledged += Buffer.byteLength(data);
  send({ type: 'output', data, cols, rows });
  if (!pending) applyResize();
}
function applyResize() {
  if (!pendingSize || !terminal || exited || pending) return;
  const next = pendingSize;
  pendingSize = undefined;
  if (cols === next.cols && rows === next.rows) return;
  cols = next.cols;
  rows = next.rows;
  try {
    screen?.resize(cols, rows);
    terminal.resize(cols, rows);
  } catch {
    abort('RESIZE_FAILED');
  }
}
const flushTimer = setInterval(flush, 16);

function abort(why?: string) {
  reason ||= why;
  if (stopping || exited) return;
  stopping = true;
  if (!terminal) {
    send({ type: 'exit', code: null, reason, cancelledBeforeStart: true });
    return;
  }
  try {
    terminal.write('\x03');
  } catch {
    reason ||= 'INTERRUPT_WRITE_FAILED';
  }
  stopTimer = setTimeout(() => {
    if (exited) return;
    try {
      terminal?.kill();
    } catch {
      reason ||= 'PTY_KILL_FAILED';
    }
  }, 3500);
  forceTimer = setTimeout(() => {
    if (!exited) send({ type: 'fault', reason: 'PTY_EXIT_UNCONFIRMED' });
    if (disconnected) process.exit(1);
  }, 8500);
}
function disconnect() {
  if (disconnected) return;
  disconnected = true;
  abort('OWNER_DISCONNECTED');
  if (!terminal || exited) process.exit(1);
}

function screenText() {
  if (!screen) return '';
  const buffer = screen.buffer.active;
  const result: string[] = [];
  for (let index = 0; index < buffer.length; index++) {
    const line = buffer.getLine(index);
    if (!line) continue;
    const text = line.translateToString(!buffer.getLine(index + 1)?.isWrapped);
    if (line.isWrapped && result.length) result[result.length - 1] += text;
    else result.push(text);
  }
  return result.join('\n');
}

process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return;
  const value = message as Record<string, unknown>;
  if (
    value.type === 'start' &&
    !started &&
    !stopping &&
    typeof value.file === 'string' &&
    Array.isArray(value.args) &&
    value.args.every((arg) => typeof arg === 'string') &&
    typeof value.cwd === 'string' &&
    sizeIsValid(value.cols, value.rows)
  ) {
    started = true;
    cols = Number(value.cols);
    rows = Number(value.rows);
    const cwd = value.cwd;
    const inspectHeader = value.inspectHeader === true;
    screen = new headless.Terminal({ cols, rows, scrollback: 1024, allowProposedApi: true });
    try {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      terminal = pty.spawn(value.file, value.args as string[], {
        cwd,
        cols,
        rows,
        name: 'xterm-256color',
        env,
        useConpty: true,
        useConptyDll: true,
      });
      send({ type: 'started', pid: terminal.pid });
      terminal.onData((data) => {
        lastOutput = Date.now();
        total += Buffer.byteLength(data);
        if (total > MAX_TURN_OUTPUT || pending.length + data.length > 256 * 1024) {
          abort('OUTPUT_LIMIT');
          return;
        }
        pending += data;
        if (!headerFound && inspectHeader) {
          headerBytes += Buffer.byteLength(data);
          if (headerBytes > 64 * 1024) {
            abort('HEADER_UNCONFIRMED');
            return;
          }
          screen?.write(data, () => {
            if (headerFound) return;
            try {
              const header = readCodexHeader(screenText(), cwd);
              if (header) {
                headerFound = true;
                send({ type: 'header', ...header });
              }
            } catch {
              abort('HEADER_CONFIG_MISMATCH');
            }
          });
        }
      });
      terminal.onExit(({ exitCode }) => {
        exited = true;
        clearTimeout(stopTimer);
        clearTimeout(forceTimer);
        const deadline = Date.now() + 4000;
        const finish = () => {
          flush();
          if (
            (pending || unacknowledged || Date.now() - lastOutput < 250) &&
            Date.now() < deadline
          ) {
            setTimeout(finish, 25);
            return;
          }
          clearInterval(flushTimer);
          if (pending || unacknowledged) reason ||= 'OUTPUT_DRAIN_UNCONFIRMED';
          if (inspectHeader && !headerFound && !stopping) reason ||= 'HEADER_UNCONFIRMED';
          screen?.dispose();
          send({
            type: 'exit',
            code: exitCode,
            reason,
            outputDrained: !pending && !unacknowledged,
          });
          if (disconnected) process.exit(1);
        };
        finish();
      });
    } catch {
      clearInterval(flushTimer);
      send({ type: 'fault', reason: 'PTY_START_FAILED' });
    }
  } else if (value.type === 'ack' && Number.isInteger(value.bytes) && Number(value.bytes) > 0) {
    unacknowledged = Math.max(0, unacknowledged - Number(value.bytes));
    flush();
  } else if (
    value.type === 'resize' &&
    terminal &&
    !exited &&
    sizeIsValid(value.cols, value.rows)
  ) {
    // Keep the latest size until old-size output has drained.
    pendingSize = { cols: Number(value.cols), rows: Number(value.rows) };
    flush();
  } else if (value.type === 'stop') abort();
});
process.on('disconnect', disconnect);
process.on('uncaughtException', () => {
  abort('HOST_EXCEPTION');
  send({ type: 'fault', reason: 'HOST_EXCEPTION' });
});
process.on('unhandledRejection', () => {
  abort('HOST_REJECTION');
  send({ type: 'fault', reason: 'HOST_REJECTION' });
});
send({ type: 'ready' });
