import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

export const requested = { model: 'gpt-6.1-sol', effort: 'high' };
export const phases = ['normal', 'interrupt', 'resume'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
export const isSessionId = (value) => typeof value === 'string' && uuid.test(value);

export function probePrompt(mode, nonce) {
  if (!/^[a-f0-9]{12}$/u.test(nonce || '') || !phases.includes(mode)) throw new Error('INVALID_PROBE');
  if (mode === 'normal') return '도구를 사용하지 마세요. 기억할 합성 표식은 한글별빛_' + nonce +
    ' 입니다. 다음 한 줄만 정확히 답하세요. X001_NORMAL 한글별빛_' + nonce;
  if (mode === 'interrupt') return '도구를 사용하지 마세요. 합성 한글 출력 시험 ' + nonce +
    ' 입니다. 번호가 붙은 서로 다른 한글 문장 이천 줄을 생략 없이 지금 생성하세요. 설명은 붙이지 마세요.';
  // No original nonce/token appears in the recall prompt sent to Codex.
  return '도구를 사용하지 마세요. 첫 요청에서 기억하라고 한 합성 표식을 회상하세요. ' +
    'X001_RESUME 다음에 그 표식만 붙여서 한 줄로 답하세요.';
}

export function execArgs(mode, { cwd, nonce, sessionId } = {}) {
  if (typeof cwd !== 'string' || !cwd || (mode !== 'normal' && !isSessionId(sessionId))) {
    throw new Error('EXACT_SESSION_AND_WORKDIR_REQUIRED');
  }
  const args = ['--ask-for-approval', 'never', 'exec', '--ignore-user-config', '--ignore-rules',
    '--sandbox', 'read-only', '--model', requested.model, '-c', 'model_reasoning_effort=high',
    '-c', 'project_root_markers=[]', '-c', 'hide_agent_reasoning=true',
    '--disable', 'hooks', '--disable', 'plugins', '--color', 'never',
    '--skip-git-repo-check', '--cd', cwd];
  if (mode !== 'normal') args.push('resume', sessionId);
  args.push(probePrompt(mode, nonce));
  return args;
}

export function parseHumanPty(output, { cwd, prompt, sessionId, rawStream } = {}) {
  const clean = stripVTControlCharacters(output).replace(/\r\n/gu, '\n');
  // These fixed probes never put the forbidden event labels in their prompts.
  // Scan the bounded original stream too: terminal erasure is not event erasure.
  const history = typeof rawStream === 'string' ? stripVTControlCharacters(rawStream) : '';
  const header = clean.match(/^OpenAI Codex v0\.160\.0\n--------\n([^]*?)\n--------\nuser\n/mu);
  const fields = new Map();
  let duplicate = false;
  if (header && header.index < 4096 && header[1].length < 4096 &&
      !/^user$/mu.test(clean.slice(0, header.index))) {
    for (const line of header[1].split('\n')) {
      const match = line.match(/^([a-z ]+): (.*)$/u);
      if (!match) { duplicate = true; continue; }
      if (fields.has(match[1])) duplicate = true;
      fields.set(match[1], match[2]);
    }
  }
  if (duplicate) fields.clear();
  const bodyStart = header ? header.index + header[0].length : -1;
  const promptObserved = bodyStart >= 0 && typeof prompt === 'string' &&
    clean.slice(bodyStart, bodyStart + prompt.length + 1) === prompt + '\n';
  const body = promptObserved ? clean.slice(bodyStart + prompt.length + 1) : '';
  const actualSession = fields.get('session id') ?? null;
  const headerConfirmed = fields.get('model') === requested.model &&
    fields.get('reasoning effort') === requested.effort && fields.get('provider') === 'openai' &&
    fields.get('approval') === 'never' && fields.get('sandbox') === 'read-only' &&
    fields.get('workdir') === cwd && isSessionId(actualSession) &&
    (!sessionId || actualSession === sessionId) && promptObserved;
  const agentMarkers = [...body.matchAll(/^codex\n/gmu)];
  const agentSection = agentMarkers.length > 0;
  const agent = agentMarkers.length === 1 ? body.slice(agentMarkers[0].index + 6)
    .split(/^tokens used\n/mu)[0].trim() : '';
  return { headerConfirmed, sessionId: actualSession, body, agent, agentSection,
    interruptMarker: /^turn interrupted\n/mu.test(body),
    rerouted: /^model rerouted:/mu.test(body) || history.includes('model rerouted:'),
    usedTools: /^(?:exec$|mcp:|web search:|apply patch$|patch:|collab:|hook:)/mu.test(clean) ||
      /(?:\bexec\b|mcp:|web search:|apply patch|patch:|collab:|hook:)/u.test(history),
    failed: /^ERROR:/mu.test(clean) || history.includes('ERROR:') };
}

export function responseEvidence(parsed, mode, nonce, exitCode) {
  const expected = (mode === 'normal' ? 'X001_NORMAL ' : 'X001_RESUME ') + '한글별빛_' + nonce;
  const responseExact = parsed.agent === expected;
  return { pass: parsed.headerConfirmed && responseExact && exitCode === 0 && !parsed.interruptMarker &&
    !parsed.rerouted && !parsed.usedTools && !parsed.failed,
  responseExact, responseBytes: Buffer.byteLength(parsed.agent),
  responseSha256: createHash('sha256').update(parsed.agent).digest('hex') };
}

export function interruptEvidence(parsed, before, exitCode) {
  const observed = before?.ctrlCSent === true && before.headerConfirmed === true &&
    before.agentSection === false && before.interruptMarker === false &&
    parsed.headerConfirmed && parsed.interruptMarker && !parsed.agentSection &&
    !parsed.rerouted && !parsed.usedTools && !parsed.failed && exitCode === 1;
  return { pass: observed, reason: observed ? null : 'INTERRUPT_NOT_OBSERVED',
    ctrlCByteWriteSucceeded: before?.ctrlCSent === true,
    cliTurnInterrupted: parsed.interruptMarker && !parsed.agentSection,
    wrapperExitCode: exitCode, remoteComputationStopped: 'UNCONFIRMED',
    responseStreamingObserved: false };
}

// Select only a live, uniquely identified CLI beneath this session's actual PTY shell.
export function inspectCodexPrepared(prepared, tracker, route = 'cmd') {
  const rows = [...tracker.owned.entries()].filter(([key]) => tracker.current.has(key)).map(([, row]) => row);
  const terminal = rows.find((row) => row.pid === prepared.fixturePid);
  if (!terminal) return null;
  if (route === 'native') {
    if (terminal.name.toLowerCase() !== 'codex.exe') throw new Error('PTY_NATIVE_IDENTITY_MISMATCH');
    return { childPid: terminal.pid, cliIdentity: { ...terminal }, rootIdentity: { ...terminal } };
  }
  if (route !== 'cmd') throw new Error('INVALID_LAUNCH_ROUTE');
  if (terminal.name.toLowerCase() !== 'powershell.exe') throw new Error('PTY_SHELL_IDENTITY_MISMATCH');
  const subtree = new Set([terminal.pid]);
  let grew;
  do {
    grew = false;
    for (const row of rows) if (!subtree.has(row.pid) && subtree.has(row.parent)) {
      subtree.add(row.pid); grew = true;
    }
  } while (grew);
  const cli = rows.filter((row) => subtree.has(row.pid) && row.name.toLowerCase() === 'codex.exe');
  if (cli.length > 1) throw new Error('CLI_IDENTITY_AMBIGUOUS');
  return cli.length === 1 ? { childPid: cli[0].pid, cliIdentity: { ...cli[0] },
    shellIdentity: { ...terminal } } : null;
}

export async function runCodexPtyPhases(run) {
  const results = [];
  let sessionId;
  for (const mode of phases) {
    const result = await run(mode, sessionId);
    results.push({ mode, ...result });
    if (result.status !== 'PASS_CODEX_EXEC_PTY' || result.nextExecutionBlocked !== false ||
        !result.hostDisposedByOwner || !result.descendantCleanupConfirmed ||
        !result.cliEvidence?.passed || !isSessionId(result.cliEvidence.sessionId) ||
        (sessionId && result.cliEvidence.sessionId !== sessionId)) break;
    sessionId = result.cliEvidence.sessionId;
  }
  return phases.map((mode, index) => results[index] ||
    { mode, status: 'NOT_RUN', reason: 'PREVIOUS_PHASE_FAILED' });
}
