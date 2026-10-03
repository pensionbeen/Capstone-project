import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

export const root = path.dirname(fileURLToPath(import.meta.url));
export const runtime = path.join(root, '.runtime');
export const codexPath = () => process.env.CODEX_CMD ||
  path.join(process.env.APPDATA || '', 'npm', 'codex.cmd');

export function psLiteral(value) {
  if (typeof value !== 'string' || /[\0\r\n]/u.test(value)) {
    throw new Error('INVALID_ARGUMENT');
  }
  return "'" + value.replaceAll("'", "''") + "'";
}

export function cmdInvocation(file, args) {
  if (!path.win32.isAbsolute(file) || path.extname(file).toLowerCase() !== '.cmd') {
    throw new Error('ABSOLUTE_CMD_PATH_REQUIRED');
  }
  // .cmd passes through cmd.exe after PowerShell. Reject its metacharacters too.
  // Prompts belong on stdin; arbitrary shell commands are never accepted here.
  for (const value of [file, ...args]) {
    if (/[\x00\r\n%！!&|<>^"`]/u.test(value)) throw new Error('UNSAFE_CMD_ARGUMENT');
  }
  // Fixed local command, quoted PowerShell literals; no execution-policy override.
  // This experiment accepts no user-supplied shell text.
  const script = "$ErrorActionPreference='Stop'; " +
    '$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ' +
    '& ' + [file, ...args].map(psLiteral).join(' ') + '; exit $LASTEXITCODE';
  return {
    file: path.join(process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')],
  };
}

export async function fileState(file) {
  try { await access(file, constants.R_OK); return 'accessible'; }
  catch (error) { return error.code === 'ENOENT' ? 'not-found-or-hidden' : error.code; }
}

// Used only for finite --version, --help, and login status commands.
// Never persist the raw output: login output may contain personal information.
export function capture(file, args, {
  timeoutMs = 8000, maxBytes = 65536, cwd, env, input,
} = {}) {
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
      resolve({ ...result, stdout, stderr });
    };
    try { child = spawn(file, args, { cwd, env, windowsHide: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); }
    catch (error) { finish({ code: null, error: error.code || 'SPAWN_ERROR' }); return; }
    const collect = (which, data) => {
      bytes += Buffer.byteLength(data);
      if (bytes > maxBytes) {
        child.kill(); // Owned process handle only, never kill a process name.
        finish({ code: null, error: 'OUTPUT_LIMIT', cleanup: 'not-verified' });
        return;
      }
      if (which === 'stdout') stdout += data;
      else stderr += data;
    };
    child.stdout.setEncoding('utf8').on('data', (data) => collect('stdout', data));
    child.stderr.setEncoding('utf8').on('data', (data) => collect('stderr', data));
    child.once('error', (error) => finish({ code: null, error: error.code || 'SPAWN_ERROR' }));
    child.once('close', (code) => finish({ code, error: null }));
    if (child.stdin) {
      child.stdin.on('error', () => { /* CLI exit/error is reported by close. */ });
      child.stdin.end(input, 'utf8');
    }
    timer = setTimeout(() => {
      child.kill();
      finish({ code: null, error: 'TIMEOUT', cleanup: 'not-verified' });
    }, timeoutMs);
  });
}

export function requiredFlags(text, flags) {
  return flags.filter((flag) => !text.includes(flag));
}

export function terminalExitCode(event, stopReason) {
  return event?.exitCode === 0 && stopReason === 'cli-exit' ? 0 : 1;
}

export function authSummary(result) {
  // Whitelist the method; don't echo an API key, email, URL, or diagnostic text.
  const text = result.stdout + '\n' + result.stderr;
  return {
    statusCommandSucceeded: result.code === 0 && !result.error,
    method: result.code !== 0 ? 'unconfirmed'
      : /logged in using chatgpt/iu.test(text) ? 'ChatGPT'
      : /api\s*key/iu.test(text) ? 'API key' : 'unconfirmed',
    serviceResponse: 'not-tested',
  };
}

export function readFrames(text, nonce) {
  if (!/^[a-f0-9]{12}$/u.test(nonce)) throw new Error('INVALID_NONCE');
  const clean = stripVTControlCharacters(text);
  const pattern = new RegExp('X001_' + nonce + ' (\\{[^\\r\\n]*\\})', 'gu');
  const frames = [];
  for (const match of clean.matchAll(pattern)) {
    try { frames.push(JSON.parse(match[1])); } catch { /* incomplete terminal frame */ }
  }
  return frames;
}

export function pidState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return error.code === 'ESRCH' ? 'gone' : 'unknown'; }
}

export async function waitUntil(read, accept, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  do {
    const value = read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < end);
  throw new Error('OBSERVATION_TIMEOUT');
}

export async function workspace() {
  await mkdir(runtime, { recursive: true });
  const cwd = await mkdtemp(path.join(runtime, '한글 경로 '));
  await writeFile(path.join(cwd, 'README.md'),
    '# X-001 가짜 프로젝트\n터미널 연결 확인용 데이터만 있습니다.\n', 'utf8');
  await writeFile(path.join(cwd, 'AGENTS.md'),
    '# 실험 범위\n사용자가 요청한 가짜 연결 확인만 수행합니다. 도구 실행·파일 변경·외부 연락은 하지 않습니다.\n', 'utf8');
  return cwd;
}

export async function report(kind, data) {
  await mkdir(runtime, { recursive: true });
  const result = { task: 'X-001', kind, recordedAt: new Date().toISOString(), ...data };
  const content = JSON.stringify(result, null, 2) + '\n';
  const stamp = result.recordedAt.replaceAll(/[:.]/gu, '-');
  await writeFile(path.join(runtime, kind + '-' + stamp + '.json'), content, 'utf8');
  await writeFile(path.join(runtime, 'latest-' + kind + '.json'), content, 'utf8');
  console.log(content);
  return result;
}

export function loadPty() {
  const require = createRequire(import.meta.url);
  const version = require('node-pty/package.json').version;
  if (version !== '1.1.0') throw new Error('UNEXPECTED_NODE_PTY_VERSION');
  return require('node-pty');
}
