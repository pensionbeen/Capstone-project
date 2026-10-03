import { cmdInvocation, codexPath, loadPty, waitUntil } from './lib.mjs';
import { execArgs, probePrompt, parseHumanPty, responseEvidence, interruptEvidence, isSessionId,
  phases, requested } from './codex-exec-pty-core.mjs';
import { TerminalText } from './terminal-text.mjs';
import path from 'node:path';

const [mode, nonce, savedSession, dll, timeoutValue, nativeFile] = process.argv.slice(2);
const native = nativeFile !== '-';
const sessionId = savedSession === '-' ? undefined : savedSession;
const timeoutMs = Number(timeoutValue);
const cwd = process.cwd();
let terminal, childPid, bytes = 0, lastDataAt = 0, exitEvent, timer;
let rawStream = '';
const screen = new TerminalText();
let started = false, finishing = false, resultSent = false, failureStarted = false, aborted = false;
let beforeInterrupt;
const checks = [];
const send = (message) => process.send?.(message);
const add = (id, pass) => checks.push({ id, status: pass ? 'PASS' : 'FAIL' });
const parse = () => parseHumanPty(screen.read(), { cwd, prompt: probePrompt(mode, nonce), sessionId, rawStream });
const emit = (data) => {
  if (resultSent) return;
  resultSent = true;
  clearTimeout(timer);
  screen.dispose();
  send({ type: 'result', fixturePid: terminal?.pid, childPid, checks, ...data });
};
const fault = () => send({ type: 'fault' });
async function failure(error) {
  if (resultSent) { fault(); return; }
  if (failureStarted) return;
  failureStarted = true; aborted = true;
  try { if (terminal && !exitEvent) terminal.kill(); } catch { /* actual cleanup is audited by owner */ }
  let cleanupSettled = !terminal;
  try { await waitUntil(() => !terminal || exitEvent, Boolean, 3500); cleanupSettled = true; }
  catch { /* never counts as PTY exit */ }
  emit({ status: 'FAIL', ptyExitObserved: Boolean(exitEvent), cleanupSettled, finalOutputCollected: false,
    cliEvidence: { passed: false, reason: error.code || error.message || 'CLI_PTY_ERROR',
      wrapperExitCode: exitEvent?.exitCode ?? null, remoteComputationStopped: 'UNCONFIRMED' } });
}
function prepare() {
  try {
    if (!phases.includes(mode) || !/^[a-f0-9]{12}$/u.test(nonce || '') || dll !== '--conpty-dll' ||
        process.argv.length !== 8 || (native && (!path.isAbsolute(nativeFile) || path.basename(nativeFile) !== 'codex.exe')) ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000 ||
        (mode !== 'normal' && !isSessionId(sessionId))) throw new Error('INVALID_CLI_PTY_OPTIONS');
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('WINDOWS_X64_REQUIRED');
    const args = execArgs(mode, { cwd, nonce, sessionId });
    const invocation = native ? { file: nativeFile, args } : cmdInvocation(codexPath(), args);
    terminal = loadPty().spawn(invocation.file, invocation.args, {
      cwd, cols: 512, rows: 40, name: 'xterm-256color', env: process.env,
      useConpty: true, useConptyDll: true,
    });
    terminal.onData((text) => {
      if (resultSent && text.length) { fault(); return; }
      bytes += Buffer.byteLength(text); lastDataAt = Date.now();
      if (bytes <= 1024 * 1024) { rawStream += text; screen.write(text); }
      else void failure(new Error('CLI_PTY_OUTPUT_LIMIT'));
    });
    terminal.onExit((event) => { exitEvent = event; });
    timer = setTimeout(() => void failure(new Error('CLI_PTY_TIMEOUT')), timeoutMs);
    // Supervisor captures either the actual native PTY guest or its shell ancestry.
    send({ type: 'prepared', fixturePid: terminal.pid });
  } catch (error) { void failure(error); }
}
async function finish(actualChildPid) {
  try {
    if (!Number.isSafeInteger(actualChildPid) || actualChildPid <= 0) throw new Error('CLI_IDENTITY_UNCONFIRMED');
    childPid = actualChildPid;
    terminal.resize(640, 40);
    screen.resize(640, 40);
    add('pty-resize-request-succeeded-only', true);
    if (mode === 'interrupt') {
      await waitUntil(() => parse().headerConfirmed || exitEvent, Boolean, 8000);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const before = parse();
      if (!before.headerConfirmed || before.agentSection || before.interruptMarker || exitEvent) {
        throw new Error('INTERRUPT_NOT_OBSERVED');
      }
      beforeInterrupt = { headerConfirmed: before.headerConfirmed, agentSection: before.agentSection,
        interruptMarker: before.interruptMarker, ctrlCSent: false };
      terminal.write('\u0003');
      beforeInterrupt.ctrlCSent = true;
    }
    await waitUntil(() => exitEvent, Boolean, timeoutMs);
    await waitUntil(() => Date.now() - lastDataAt, (age) => age >= 300, 1500);
    await waitUntil(() => screen.pending, count => count === 0, 1500);
    if (aborted) throw new Error('CLI_PTY_ABORTED');
    const parsed = parse();
    const evidence = mode === 'interrupt' ? interruptEvidence(parsed, beforeInterrupt, exitEvent.exitCode)
      : responseEvidence(parsed, mode, nonce, exitEvent.exitCode);
    add('cli-header-model-effort-readonly-never-session', parsed.headerConfirmed && !parsed.rerouted);
    add(mode === 'interrupt' ? 'explicit-cli-turn-interrupted' : 'exact-korean-response', evidence.pass);
    emit({ status: 'READY_FOR_OWNER_DISPOSE', ptyExitObserved: true, finalOutputCollected: true,
      cliEvidence: { ...evidence, passed: evidence.pass, sessionId: parsed.sessionId,
        wrapperExitCode: exitEvent.exitCode, receivedBytes: bytes, requested,
        cliResolvedConfigConfirmed: parsed.headerConfirmed, remoteModelAttestation: 'UNCONFIRMED',
        toolObservation: 'RENDERED_EVENTS_ONLY_NOT_PROOF_OF_NO_TOOLS',
        remoteComputationStopped: 'UNCONFIRMED', inputRoute: 'FIXED_PROMPT_ARGUMENT',
        interactiveTui: 'NOT_RUN', stdinPromptRoundTrip: 'NOT_TESTED',
        ptyMode: 'EXPERIMENTAL_CONPTY_DLL' } });
  } catch (error) { await failure(error); }
}
process.on('message', (message) => {
  if (message?.type === 'go' && !started) { started = true; prepare(); }
  else if (message?.type === 'finish' && started && !finishing) {
    finishing = true; void finish(message.childPid);
  } else if (message?.type === 'abort') void failure(new Error('OWNER_ABORT'));
  else void failure(new Error('OWNER_PROTOCOL_INVALID'));
});
// Intentional owned-host IPC lifetime; never hides native natural-exit failure.
send({ type: 'host-ready' });
