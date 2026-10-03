import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { SessionProcesses } from './managed-processes.mjs';
import { superviseManaged } from './managed-supervisor.mjs';
import { TerminalText } from './terminal-text.mjs';
import { waitUntil } from './lib.mjs';
import { execArgs, probePrompt, parseHumanPty, responseEvidence, interruptEvidence,
  inspectCodexPrepared, runCodexPtyPhases } from './codex-exec-pty-core.mjs';

const nonce = 'abcdef012345';
const sessionId = '01234567-89ab-cdef-0123-456789abcdef';
const cwd = 'C:\\X001 한글 경로';
const transcript = (mode, suffix = '', overrides = {}) => {
  const fields = { workdir: cwd, model: 'gpt-6.1-sol', provider: 'openai', approval: 'never',
    sandbox: 'read-only', 'reasoning effort': 'high', 'reasoning summaries': 'auto',
    'session id': sessionId, ...overrides };
  return 'OpenAI Codex v0.160.0\n--------\n' + Object.entries(fields)
    .map(([key, value]) => key + ': ' + value).join('\n') + '\n--------\nuser\n' +
    probePrompt(mode, nonce) + '\n' + suffix;
};
const parse = (mode, text) => parseHumanPty(text,
  { cwd, prompt: probePrompt(mode, nonce), ...(mode !== 'normal' ? { sessionId } : {}) });

test('PTY human parser extracts CLI header and exact Korean response, not echoed prompt', () => {
  const text = transcript('normal', 'codex\nX001_NORMAL 한글별빛_' + nonce + '\ntokens used\n500\n');
  const parsed = parse('normal', '\u001b[0m' + text.replaceAll('\n', '\r\n'));
  assert.equal(parsed.sessionId, sessionId);
  assert.equal(responseEvidence(parsed, 'normal', nonce, 0).pass, true);
  assert.equal(responseEvidence(parse('normal', transcript('normal')), 'normal', nonce, 0).pass, false);
  for (const overrides of [{ model: 'gpt-6-astra' }, { sandbox: 'workspace-write' },
    { approval: 'on-request' }, { 'session id': 'not-a-uuid' }]) {
    assert.equal(parse('normal', transcript('normal', '', overrides)).headerConfirmed, false);
  }
  assert.equal(parse('normal', text.replace('model: gpt-6.1-sol', 'model: gpt-6.1-sol\nmodel: gpt-6.1-sol'))
    .headerConfirmed, false);
});

test('Prompt marker text, alternate session, rerouting and tool activity cannot become success', () => {
  const exact = 'codex\nX001_NORMAL 한글별빛_' + nonce + '\n';
  for (const extra of ['model rerouted: gpt-6.1-sol -> gpt-6-astra\n', 'exec\n', 'hook: SessionStart\n',
    'ERROR: failed\n', 'turn interrupted\n']) {
    assert.equal(responseEvidence(parse('normal', transcript('normal', extra + exact)), 'normal', nonce, 0).pass, false);
  }
  assert.equal(parse('resume', transcript('resume', '', { 'session id': '11111111-1111-1111-1111-111111111111' }))
    .headerConfirmed, false);
  const echoed = transcript('interrupt').replace(probePrompt('interrupt', nonce), 'turn interrupted');
  assert.equal(parse('interrupt', echoed).interruptMarker, false);
});

test('Interrupt requires Ctrl+C before completed reply and the independent interrupted line with exit 1', () => {
  const before = { headerConfirmed: true, agentSection: false, interruptMarker: false, ctrlCSent: true };
  const actual = parse('interrupt', transcript('interrupt', 'turn interrupted\ntokens used\n500\n'));
  assert.equal(interruptEvidence(actual, before, 1).pass, true);
  for (const failedBefore of [{ ...before, ctrlCSent: false }, { ...before, agentSection: true },
    { ...before, interruptMarker: true }, { ...before, headerConfirmed: false }]) {
    assert.equal(interruptEvidence(actual, failedBefore, 1).reason, 'INTERRUPT_NOT_OBSERVED');
  }
  assert.equal(interruptEvidence(actual, before, 0).pass, false);
  for (const suffix of ['codex\ncompleted naturally\nturn interrupted\n', 'still running\n',
    'codex\nturn interrupted\n', 'turn interrupted']) {
    assert.equal(interruptEvidence(parse('interrupt', transcript('interrupt', suffix)), before, 1).pass, false);
  }
});

test('An error erased in the same terminal chunk cannot become a successful reply', async () => {
  for (const event of ['model rerouted: other-model', 'ERROR: failure', 'exec', 'hook: running']) {
    const screen = new TerminalText();
    try {
      const rawStream = transcript('normal', event + '\n').replaceAll('\n', '\r\n') +
        '\u001b[1A\u001b[2Kcodex\r\nX001_NORMAL 한글별빛_' + nonce + '\r\n';
      screen.write(rawStream);
      await waitUntil(() => screen.pending, count => count === 0);
      assert.equal(responseEvidence(parse('normal', screen.read()), 'normal', nonce, 0).pass, true);
      const audited = parseHumanPty(screen.read(), { cwd, prompt: probePrompt('normal', nonce), rawStream });
      assert.equal(responseEvidence(audited, 'normal', nonce, 0).pass, false);
    } finally { screen.dispose(); }
  }
});

test('Fixed argument routes preserve isolation flags and exact UUID; recall never sends original token', () => {
  const args = execArgs('resume', { cwd, nonce, sessionId });
  assert.ok(args.includes('--ignore-user-config') && args.includes('--ignore-rules'));
  assert.ok(args.includes('project_root_markers=[]') && args.includes('hide_agent_reasoning=true'));
  assert.equal(args[args.indexOf('resume') + 1], sessionId);
  assert.ok(!args.at(-1).includes(nonce) && !args.at(-1).includes('한글별빛_'));
  assert.ok(!args.includes('--last') && !args.includes('--json') && !args.includes('--ephemeral'));
  assert.throws(() => execArgs('resume', { cwd, nonce, sessionId: '--last' }));
});

const row = (pid, parent, age, name) => ({ pid, parent, created: new Date(age).toISOString(), name });
test('CIM preparation needs the actual uniquely live codex.exe under the PTY PowerShell identity', () => {
  const supervisor = row(90, 4, 500, 'node.exe');
  const tracker = new SessionProcesses([supervisor], 100, 90);
  const base = [supervisor, row(100, 90, 1000, 'node.exe'), row(101, 100, 2000, 'powershell.exe'),
    row(102, 101, 3000, 'cmd.exe'), row(103, 102, 4000, 'codex.exe')];
  tracker.observe(base);
  assert.equal(inspectCodexPrepared({ fixturePid: 101 }, tracker).childPid, 103);
  assert.equal(inspectCodexPrepared({ fixturePid: 101 }, tracker).cliIdentity.created, row(103, 102, 4000).created);
  tracker.observe(base.filter((item) => item.pid !== 103));
  assert.equal(inspectCodexPrepared({ fixturePid: 101 }, tracker), null);
  tracker.observe([...base, row(104, 101, 5000, 'codex.exe')]);
  assert.throws(() => inspectCodexPrepared({ fixturePid: 101 }, tracker), /CLI_IDENTITY_AMBIGUOUS/u);
});

test('Cleaning failure, interruption race or wrong recall session prevents subsequent phases', async () => {
  const pass = { status: 'PASS_CODEX_EXEC_PTY', nextExecutionBlocked: false,
    hostDisposedByOwner: true, descendantCleanupConfirmed: true, cliEvidence: { passed: true, sessionId } };
  for (const failure of [{ ...pass, descendantCleanupConfirmed: false },
    { ...pass, cliEvidence: { passed: false, reason: 'INTERRUPT_NOT_OBSERVED', sessionId } },
    { ...pass, cliEvidence: { passed: true, sessionId: '11111111-1111-1111-1111-111111111111' } }]) {
    const calls = [];
    const results = await runCodexPtyPhases(async (mode, id) => {
      calls.push(mode);
      if (mode === 'normal') { assert.equal(id, undefined); return pass; }
      assert.equal(id, sessionId); return failure;
    });
    assert.deepEqual(calls, ['normal', 'interrupt']);
    assert.equal(results[2].status, 'NOT_RUN');
  }
});
test('Native CLI comparison requires the exact live codex.exe as PTY root', () => {
  const supervisor = row(90, 4, 500, 'node.exe');
  const tracker = new SessionProcesses([supervisor], 100, 90);
  tracker.observe([supervisor, row(100, 90, 1000, 'node.exe'), row(101, 100, 2000, 'codex.exe')]);
  assert.equal(inspectCodexPrepared({ fixturePid: 101 }, tracker, 'native').childPid, 101);
  assert.throws(() => inspectCodexPrepared({ fixturePid: 101 }, tracker, 'cmd'));
  assert.throws(() => inspectCodexPrepared({ fixturePid: 100 }, tracker, 'native'));
});

test('Real fake Node hosts exercise CLI identity hook, owner close, late stderr and next-phase blocking', async () => {
  async function fake(lateStderr = false) {
    let child, stage = 'before', closed = false;
    const supervisor = row(process.pid, 4, 500, 'node.exe');
    const data = { type: 'result', status: 'READY_FOR_OWNER_DISPOSE', fixturePid: 19001, childPid: 19002,
      ptyExitObserved: true, finalOutputCollected: true, checks: [{ id: 'fake-cli-only', status: 'PASS' }],
      cliEvidence: { passed: true, cliResolvedConfigConfirmed: true, sessionId } };
    const script = `process.send({type:'host-ready'});process.on('message',m=>{
      if(m.type==='go')process.send({type:'prepared',fixturePid:19001});
      if(m.type==='finish'){
        if(m.childPid!==19002)throw Error('wrong captured CLI');
        process.send(${JSON.stringify(data)});
        ${lateStderr ? "setTimeout(()=>process.stderr.write('late helper failure'),30);" : ''}
      }
      if(m.type==='abort')process.send({type:'result',status:'FAIL',cleanupSettled:true});
    });`;
    return superviseManaged(process.execPath, ['-e', script], {
      sessionKind: 'codex-exec-pty', inspectPrepared: inspectCodexPrepared,
      timeoutMs: 2000, cleanupTimeoutMs: 200, helperSettleMs: 70, pollMs: 10,
      spawnHost(file, args, options) {
        child = spawn(file, args, options);
        child.on('message', (message) => { stage = message.type; });
        child.once('close', () => { closed = true; });
        return child;
      },
      snapshot: async () => {
        const rows = [supervisor];
        if (child && !closed) rows.push(row(child.pid, process.pid, 1000, 'node.exe'));
        if (stage === 'prepared') rows.push(row(19001, child.pid, 2000, 'powershell.exe'),
          row(19002, 19001, 3000, 'codex.exe'), row(19003, child.pid, 2000, 'conhost.exe'));
        return rows;
      },
    });
  }
  const passed = await fake();
  assert.equal(passed.status, 'PASS_CODEX_EXEC_PTY');
  assert.equal(passed.hostCloseObserved, true);
  assert.equal(passed.descendantCleanupConfirmed, true);
  let count = 0;
  const results = await runCodexPtyPhases(async () => { count++; return fake(true); });
  assert.equal(count, 1);
  assert.equal(results[0].reason, 'HOST_STDERR');
  assert.equal(results[1].status, 'NOT_RUN');
});
