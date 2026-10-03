import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, open, unlink } from 'node:fs/promises';
import { capture, cmdInvocation, codexPath, authSummary, fileState, requiredFlags, report,
  root, runtime } from './lib.mjs';
import { checkCodexEnv, parseCatalog, chooseModel } from './review-core.mjs';
import { snapshot } from './snapshot.mjs';
import { superviseManaged } from './managed-supervisor.mjs';
import { inspectCodexPrepared, runCodexPtyPhases, requested } from './codex-exec-pty-core.mjs';
import { installedCodexNative } from './codex-native.mjs';

const rows = [];
let lock, lockRetained = false, reason, cwd, fixtureUnchanged = 'UNCONFIRMED';
const native = process.argv[3] === '--native';
const deadline = Date.now() + 180000;
const remaining = () => Math.max(0, deadline - Date.now());
const lockPath = path.join(runtime, 'ai-review.lock');
try {
  if ((process.argv.length !== 3 && !(native && process.argv.length === 4)) || process.argv[2] !== '--conpty-dll') {
    throw new Error('EXPLICIT_EXPERIMENTAL_CONPTY_DLL_REQUIRED');
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('WINDOWS_X64_REQUIRED');
  if (!checkCodexEnv(process.env)) throw new Error('CODEX_AUTH_OR_ENDPOINT_ENV_REQUIRES_REVIEW');
  await mkdir(runtime, { recursive: true });
  lock = await open(lockPath, 'wx');
  await lock.writeFile(JSON.stringify({ pid: process.pid, kind: 'codex-exec-pty', createdAt: new Date().toISOString() }));
  cwd = await mkdtemp(path.join(os.tmpdir(), 'X001 Codex 한글 PTY '));
  await writeFile(path.join(cwd, 'README.md'), '# 합성 한글 연결 시험\n사용자 코드 없음.\n', 'utf8');
  await writeFile(path.join(cwd, 'AGENTS.md'), '고정된 합성 프롬프트만 답하고 도구를 사용하지 마세요.\n', 'utf8');
  const before = await snapshot(cwd);
  const assertUnchanged = async () => {
    let current;
    try { current = await snapshot(cwd); }
    catch { fixtureUnchanged = 'UNCONFIRMED'; lockRetained = true;
      throw new Error('FIXTURE_CHANGE_OR_AUDIT_FAILURE_STOP_ALL_CALLS'); }
    fixtureUnchanged = current === before;
    if (!fixtureUnchanged) { lockRetained = true; throw new Error('FIXTURE_CHANGE_OR_AUDIT_FAILURE_STOP_ALL_CALLS'); }
  };
  const invoke = async (args, maxBytes = 65536) => {
    if (remaining() < 1000) throw new Error('TOTAL_PROBE_DEADLINE');
    const invocation = cmdInvocation(codexPath(), args);
    const result = await capture(invocation.file, invocation.args,
      { cwd, timeoutMs: Math.min(20000, remaining()), maxBytes });
    await assertUnchanged();
    if (result.error || result.code !== 0) {
      if (result.error) lockRetained = true;
      throw new Error(result.error || 'CLI_PREFLIGHT_EXIT_NONZERO');
    }
    return result;
  };
  if (await fileState(codexPath()) !== 'accessible') throw new Error('CODEX_CMD_INACCESSIBLE');
  const version = await invoke(['--version']);
  if (!/\bcodex-cli 0\.160\.0\b/u.test(version.stdout + version.stderr)) throw new Error('CODEX_VERSION_REQUIRES_REVIEW');
  const help = await invoke(['--help']);
  const execHelp = await invoke(['exec', '--help']);
  const resumeHelp = await invoke(['exec', 'resume', '--help']);
  if (requiredFlags(help.stdout + execHelp.stdout + resumeHelp.stdout,
    ['--ask-for-approval', '--ignore-user-config', '--ignore-rules', '--sandbox', '--model',
      '--config', '--disable', '--color', '--skip-git-repo-check', '--cd']).length) {
    throw new Error('CODEX_REQUIRED_FLAGS_UNCONFIRMED');
  }
  if (authSummary(await invoke(['login', 'status'])).method !== 'ChatGPT') {
    throw new Error('CHATGPT_AUTH_NOT_CONFIRMED_NO_API_FALLBACK');
  }
  const catalog = parseCatalog((await invoke(['debug', 'models'], 1024 * 1024)).stdout);
  const chosen = chooseModel({ kind: 'test', risks: [] }, catalog);
  if (chosen.model !== requested.model || chosen.effort !== requested.effort) throw new Error('REQUESTED_MODEL_UNAVAILABLE');
  const nativeFile = native ? await installedCodexNative() : '-';
  if (native) {
    const version = await capture(nativeFile, ['--version'], { cwd, timeoutMs: 10000 });
    if (version.error) lockRetained = true;
    if (version.error || version.code !== 0 || !/\bcodex-cli 0\.160\.0\b/u.test(version.stdout)) {
      throw new Error('CODEX_NATIVE_VERSION_UNCONFIRMED');
    }
  }
  const nonce = randomBytes(6).toString('hex');
  rows.push(...await runCodexPtyPhases(async (mode, sessionId) => {
    if (remaining() < 12000) return { status: 'BLOCKED', reason: 'TOTAL_PROBE_DEADLINE', nextExecutionBlocked: true };
    const result = await superviseManaged(process.execPath,
      [path.join(root, 'codex-exec-pty-worker.mjs'), mode, nonce, sessionId || '-', '--conpty-dll', String(remaining()), nativeFile],
      { cwd, timeoutMs: remaining(), inspectPrepared: (prepared, tracker) =>
        inspectCodexPrepared(prepared, tracker, native ? 'native' : 'cmd'), sessionKind: 'codex-exec-pty' });
    try { await assertUnchanged(); }
    catch { return { ...result, status: 'FAIL', nextExecutionBlocked: true,
      reason: 'FIXTURE_CHANGE_OR_AUDIT_FAILURE_STOP_ALL_CALLS' }; }
    if (result.status !== 'PASS_CODEX_EXEC_PTY') lockRetained = true;
    return result;
  }));
} catch (error) {
  reason = error.code === 'EEXIST' ? 'EXISTING_REVIEW_LOCK_INSPECT_BEFORE_RETRY' : error.message || 'PROBE_ERROR';
} finally {
  if (lock) { await lock.close(); if (!lockRetained) await unlink(lockPath); }
}
const passed = !reason && rows.length === 3 && rows.every((row) => row.status === 'PASS_CODEX_EXEC_PTY');
await report('codex-exec-pty', { status: passed ? 'PASS_CODEX_EXEC_PTY_SEQUENCE' : 'BLOCKED_OR_PARTIAL', reason,
  requested, phases: rows, lockRetained, ptyMode: 'EXPERIMENTAL_CONPTY_DLL',
  launchRoute: native ? 'INSTALLED_NATIVE_CODEX_EXE' : 'CMD_POWERSHELL_NPM_WRAPPER',
  actualAi: rows.some((row) => row.cliEvidence?.cliResolvedConfigConfirmed) ? 'CLI_OUTPUT_OBSERVED' : 'UNCONFIRMED',
  fixtureUnchanged, nativeNaturalExit: false, nativeNaturalExitTest: 'NOT_ATTEMPTED_MANAGED_HOST',
  rawTranscriptSavedByRunner: false, cliOwnSessionHistory: 'PERSISTED_FOR_EXACT_UUID_RESUME',
  inputRoute: 'FIXED_SYNTHETIC_PROMPT_ARGUMENT', stdinPromptRoundTrip: 'NOT_TESTED',
  interactiveTui: 'NOT_RUN', resizeEvidence: 'PTY_REQUEST_SUCCEEDED_ONLY',
  remoteModelAttestation: 'UNCONFIRMED', remoteComputationStopped: 'UNCONFIRMED',
  callBudgetMs: 180000, cleanupHasSeparateBound: true, electron: 'NOT_RUN' });
process.exitCode = passed ? 0 : 2;
