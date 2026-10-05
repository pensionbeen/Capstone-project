import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, unlink } from 'node:fs/promises';
import { capture, cmdInvocation, requiredFlags, terminalExitCode, runtime } from './lib.mjs';
import { chooseModel, checkCodexEnv, parseCatalog, parsePacket, validatePacket, promptFor, encodeReviewSource, codexEvidence, codexTextEvidence, geminiEvidence, verdict } from './review-core.mjs';
import { checkUserSettings, checkGeminiEnv } from './gemini-guard.mjs';
import { snapshot } from './snapshot.mjs';
import { parseAgyHelp } from './agy-help.mjs';

// Sanitized option/command rows observed in agy 1.2.16, not a service response.
const agyHelp = `Usage of agy.exe:
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  --disable-slash-commands        Disable slash command and skill expansion in print mode
  --effort                        Reasoning effort for the current CLI session (low|medium|high|xhigh|max)
  --input-format                  Input format for print mode; requires --output-format stream-json
  --mode                          Set the agent execution mode for this session (accept-edits, plan)
  --model                         Model for the current CLI session
  --output-format                 Output format for print mode (text, json, stream-json) (default text)
  --print                         Run a single prompt non-interactively and print the response
  --print-timeout                 Optional time limit for print mode (default 0s)
  --sandbox                       Run in a sandbox with terminal restrictions enabled

Available subcommands:
  agent           List available agents
  agents          List available agents
  changelog       Show changelog and release notes
  help            Show help for subcommands
  models          List available models
`;

test('Agy 1.2.16 help is recognized without a --help option, with LF or CRLF', () => {
  for (const text of [agyHelp, agyHelp.replaceAll('\n', '\r\n')]) {
    const result = parseAgyHelp(text);
    assert.equal(result.formatConfirmed, true);
    assert.equal(result.flags.includes('--help'), false);
    assert.deepEqual(result.commands, ['models', 'agents']);
    assert.equal(result.flags.length, 10);
  }
});

test('Agy help rejects unrelated usage, missing headers, and option mentions in prose', () => {
  for (const text of ['', agyHelp.replace('Usage of agy.exe:', 'Usage of other.exe:'),
    agyHelp.replace('Usage of agy.exe:', 'Antigravity options:'),
    agyHelp.replace('Available subcommands:', 'Other information:'),
    'Antigravity agy --help --print --model --effort --mode --sandbox --output-format ' +
      '--print-timeout --disable-slash-commands\n  models\n  agents']) {
    assert.equal(parseAgyHelp(text).formatConfirmed, false);
  }
});

test('Agy help requires every observed essential option declaration', () => {
  for (const flag of ['--print', '--model', '--effort', '--mode', '--sandbox',
    '--output-format', '--print-timeout', '--disable-slash-commands']) {
    const incomplete = agyHelp.split('\n').filter((line) => !line.startsWith('  ' + flag + ' ')).join('\n');
    assert.equal(parseAgyHelp(incomplete).formatConfirmed, false, flag);
  }
  assert.equal(parseAgyHelp(agyHelp.replace('  --print ', '  --print-more ')).formatConfirmed, false);
  assert.equal(parseAgyHelp(agyHelp.replace(/  --sandbox[^\n]+/u,
    '  --sandbox\nAgy supports --sandbox')).formatConfirmed, false);
});

test('Agy help requires models and agents declarations in the subcommand section', () => {
  for (const command of ['models', 'agents']) {
    const incomplete = agyHelp.split('\n').filter((line) => !line.startsWith('  ' + command + ' ')).join('\n');
    assert.equal(parseAgyHelp(incomplete).formatConfirmed, false, command);
    const misplaced = incomplete.replace('Available subcommands:',
      '  ' + command + '          Mentioned before the section\nAvailable subcommands:');
    assert.equal(parseAgyHelp(misplaced).formatConfirmed, false, command);
  }
});

const models = [
  { id: 'gpt-6.1-sol', efforts: ['high', 'max'] },
  { id: 'gpt-6-astra', efforts: ['high', 'xhigh', 'max', 'ultra'] },
];
test('ChatGPT-only runner blocks API/endpoint overrides even when login status could say ChatGPT', () => {
  assert.equal(checkCodexEnv({ PATH: 'normal', CODEX_CMD: 'C:\\safe\\codex.cmd' }), true);
  for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_CHATGPT_BASE_URL', 'codex_api_key'])
    assert.equal(checkCodexEnv({ [name]: 'dummy-presence-not-a-secret' }), false);
});
test('Normal work chooses Sol High; important work selects Astra Max or useful Ultra', () => {
  assert.equal(chooseModel({ kind: 'test' }, models).effort, 'high');
  assert.equal(chooseModel({ kind: 'os-security' }, models).effort, 'max');
  assert.equal(chooseModel({ kind: 'architecture', parallelReviewUseful: true }, models).effort, 'ultra');
  assert.equal(chooseModel({ kind: 'fix', risks: ['data-loss'] }, models).model, 'gpt-6-astra');
});
test('Unavailable Astra or High fails; does not quietly select the other model', () => {
  assert.throws(() => chooseModel({ kind: 'final-review' }, models.slice(0, 1)), /UNAVAILABLE/u);
  assert.throws(() => chooseModel({ kind: 'test' }, [{ id: 'gpt-6.1-sol', efforts: ['low'] }]), /UNAVAILABLE/u);
});
test('Catalog parser keeps only model/effort metadata and rejects unknown shape', () => {
  assert.deepEqual(parseCatalog(JSON.stringify({ models: [{ slug: 'gpt-6-astra',
    supported_reasoning_levels: [{ effort: 'max' }, { effort: 'ultra' }], privateField: 'not exported' }] })),
  [{ id: 'gpt-6-astra', efforts: ['max', 'ultra'] }]);
  assert.throws(() => parseCatalog('{}'), /FORMAT/u);
  assert.throws(() => parseCatalog('private account diagnostic'), /^Error: MODEL_CATALOG_JSON_UNCONFIRMED$/u);
  assert.throws(() => parsePacket('private packet diagnostic'), /^Error: PACKET_JSON_INVALID$/u);
});
test('Review packet requires provenance, rejects @file and likely secrets', () => {
  const packet = { taskId: 'X-001', baseCommit: 'a'.repeat(40), scope: 'fake',
    verification: 'not-run', remaining: 'test', reviewFocus: 'boundary', content: 'safe' };
  assert.equal(validatePacket(packet), packet);
  assert.throws(() => validatePacket({ ...packet, verification: '' }), /FIELD/u);
  assert.throws(() => validatePacket({ ...packet, content: '@private.md' }), /AT_FILE/u);
  assert.throws(() => validatePacket({ ...packet, content: 'Bearer fake-sensitive-test' }), /SECRET/u);
});
test('Gemini init is configuration only; missing stats cannot verify model', () => {
  const result = { code: 0, stdout: [
    { type: 'init', model: 'gemini-3.1-pro-preview' },
    { type: 'message', role: 'assistant', content: 'X001_REVIEW I am Pro' },
    { type: 'result', status: 'success', stats: {} },
  ].map(JSON.stringify).join('\n') };
  const evidence = geminiEvidence(result, 'gemini-3.1-pro-preview');
  assert.equal(evidence.exactModelConfirmed, false);
  assert.equal(verdict(result, evidence), 'RESPONSE_OBSERVED_MODEL_UNCONFIRMED');
});

test('Explicit encoded source round-trips imports, escapes and Korean without CLI file expansion', () => {
  const source = "import x from '@scope/module';\n" + String.raw`const path = 'C:\\한글\\x';`;
  const encoded = encodeReviewSource(source);
  assert.equal(JSON.parse(encoded.content), source);
  const packet = { taskId: 'X-001', baseCommit: 'a'.repeat(40), scope: 'encoded source',
    verification: 'roundtrip', remaining: 'service semantics', reviewFocus: 'original code', ...encoded };
  assert.equal(promptFor(packet).includes('@'), false);
  assert.ok(promptFor(packet).includes('JSON 문자열 인코딩'));
  assert.throws(() => validatePacket({ ...packet, contentEncoding: 'unknown' }), /ENCODING/u);
  assert.throws(() => validatePacket({ ...packet, content: 'null' }), /ENCODING/u);
  assert.throws(() => validatePacket({ ...packet, content: '"Bea\\u0072er fake-sensitive-test"' }), /SECRET/u);
});

test('Review source preserves literal backslashes and newlines without a second JSON escape layer', () => {
  const content = String.raw`cwd.replaceAll('\\', '/');` + '\nconst text = "한글";';
  const packet = { taskId: 'X-001', baseCommit: 'a'.repeat(40), scope: 'source transfer',
    verification: 'source fidelity', remaining: 'runtime', reviewFocus: 'literal code', content };
  assert.ok(promptFor(packet).includes('\n' + content + '\n'));
  assert.throws(() => promptFor({ ...packet, content: '@private.md' }), /AT_FILE/u);
});
test('Gemini lower-model usage and tool calls cannot count as successful review', () => {
  const output = (models, tools = []) => ({ code: 0, stdout: [
    { type: 'message', role: 'assistant', content: 'X001_REVIEW age 18 boundary' },
    ...tools, { type: 'result', status: 'success', stats: { models } },
  ].map(JSON.stringify).join('\n') });
  let result = output({ 'gemini-3.1-pro-preview': {}, 'gemini-3-flash-preview': {} });
  assert.equal(verdict(result, geminiEvidence(result, 'gemini-3.1-pro-preview')), 'RESPONSE_OBSERVED_MODEL_MISMATCH');
  result = output({ 'gemini-3.1-pro-preview': {} }, [{ type: 'tool_use', name: 'write_file' }]);
  assert.equal(verdict(result, geminiEvidence(result, 'gemini-3.1-pro-preview')), 'UNEXPECTED_TOOL_ACTIVITY');
});
test('Codex assistant self-report is not model evidence; nonzero exit cannot pass', () => {
  const result = { code: 0, stderr: '', stdout: [
    { type: 'item.completed', item: { type: 'agent_message', text: 'X001_REVIEW model: gpt-6-astra' } },
    { type: 'turn.completed' },
  ].map(JSON.stringify).join('\n') };
  const request = { model: 'gpt-6-astra', effort: 'max' };
  assert.equal(codexEvidence(result, request).exactModelConfirmed, false);
  assert.equal(verdict(result, codexEvidence(result, request)), 'RESPONSE_OBSERVED_MODEL_UNCONFIRMED');
  result.stderr = 'model: gpt-6-astra\nreasoning effort: max\n';
  assert.equal(verdict(result, codexEvidence(result, request)), 'RESPONSE_AND_MODEL_OBSERVED');
  result.code = 1;
  assert.equal(verdict(result, codexEvidence(result, request)), 'CALL_FAILED');
});
test('Existing hooks/MCP/policies/unknown auth settings block instead of being replaced', () => {
  assert.equal(checkUserSettings({ security: { auth: { selectedType: 'oauth-personal' } } }), true);
  assert.equal(checkUserSettings({ ide: { hasSeenNudge: true } }), true);
  assert.equal(checkUserSettings({ ide: { hasSeenNudge: 'true' } }), false);
  assert.equal(checkUserSettings({ ide: { enabled: true } }), false);
  for (const settings of [{ hooks: { SessionStart: [] } }, { mcpServers: { test: {} } },
    { policyPaths: ['private'] }, { security: { auth: { selectedType: 'gemini-api-key' } } }]) {
    assert.equal(checkUserSettings(settings), false);
  }
});

const textRequest = { model: 'gpt-6.1-sol', effort: 'high' };
const textCwd = 'C:\\fake project';
const textHeader = 'OpenAI Codex v0.160.0\n--------\nworkdir: ' + textCwd +
  '\nmodel: gpt-6.1-sol\nprovider: openai\napproval: never\nsandbox: read-only\nreasoning effort: high\n--------\nuser\n';
test('Codex text mode separates response, CLI configuration, and remote attestation', () => {
  const result = { code: 0, error: null, stdout: 'X001_REVIEW age boundary', stderr: textHeader + 'fake packet\n' };
  const evidence = codexTextEvidence(result, textRequest, textCwd);
  assert.equal(verdict(result, evidence), 'RESPONSE_AND_MODEL_OBSERVED');
  assert.equal(evidence.modelEvidence, 'CLI_RESOLVED_CONFIG');
  assert.equal(evidence.remoteModelAttestation, 'UNCONFIRMED');
  assert.equal(evidence.toolObservation, 'RENDERED_EVENTS_ONLY_NOT_PROOF_OF_NO_TOOLS');
  assert.equal(verdict({ ...result, code: 1 }, evidence), 'CALL_FAILED');
  assert.equal(verdict(result, codexTextEvidence({ ...result, stdout: '' }, textRequest, textCwd)), 'CALL_FAILED');
});
test('Codex uses first header only and rejects rerouting, permission mismatch, or tool markers', () => {
  const result = { code: 0, stdout: 'X001_REVIEW safe', stderr: textHeader.replace('model: gpt-6.1-sol', 'model: gpt-6-astra') + textHeader };
  assert.equal(verdict(result, codexTextEvidence(result, textRequest, textCwd)), 'RESPONSE_OBSERVED_MODEL_MISMATCH');
  result.stderr = textHeader + '\nmodel rerouted: gpt-6.1-sol -> gpt-6-astra\n';
  assert.equal(verdict(result, codexTextEvidence(result, textRequest, textCwd)), 'RESPONSE_OBSERVED_MODEL_MISMATCH');
  result.stderr = textHeader.replace('sandbox: read-only', 'sandbox: workspace-write');
  assert.equal(verdict(result, codexTextEvidence(result, textRequest, textCwd)), 'RESPONSE_OBSERVED_READONLY_CONFIG_UNCONFIRMED');
  result.stderr = textHeader + '\nexec\ncommand\n';
  assert.equal(verdict(result, codexTextEvidence(result, textRequest, textCwd)), 'UNEXPECTED_TOOL_ACTIVITY');
  result.stderr = 'user\n' + textHeader;
  assert.equal(codexTextEvidence(result, textRequest, textCwd).exactModelConfirmed, false);
});
test('Required flags and abnormal terminal exits fail closed', () => {
  assert.deepEqual(requiredFlags('--sandbox --json', ['--json', '--cd']), ['--cd']);
  assert.equal(terminalExitCode({ exitCode: 1 }, 'cli-exit'), 1);
  assert.equal(terminalExitCode({ exitCode: 0 }, 'ctrl-q'), 1);
  assert.equal(terminalExitCode({ exitCode: 0 }, 'cli-exit'), 0);
});
test('Gemini logging/system-prompt/environment overrides are blocked without exposing values', () => {
  for (const key of ['GEMINI_WRITE_SYSTEM_MD', 'GEMINI_CLI_ACTIVITY_LOG_TARGET',
    'GEMINI_TELEMETRY_LOG_PROMPTS', 'GEMINI_CLI_HOME', 'GOOGLE_APPLICATION_CREDENTIALS']) {
    assert.equal(checkGeminiEnv({ [key]: 'dummy-value' }), false);
  }
  assert.equal(checkGeminiEnv({ GEMINI_CMD: 'C:\\safe\\gemini.cmd', PATH: 'normal' }), true);
});
test('Fixture snapshots detect new files, non-README changes, and deletions', async () => {
  await mkdir(runtime, { recursive: true });
  const folder = await mkdtemp(path.join(runtime, 'snapshot '));
  await writeFile(path.join(folder, 'sample.txt'), 'before');
  const before = await snapshot(folder);
  await writeFile(path.join(folder, 'new.txt'), 'new');
  assert.notEqual(await snapshot(folder), before);
  await unlink(path.join(folder, 'new.txt'));
  await writeFile(path.join(folder, 'sample.txt'), 'after');
  assert.notEqual(await snapshot(folder), before);
  await unlink(path.join(folder, 'sample.txt'));
  assert.notEqual(await snapshot(folder), before);
});
test('CMD metacharacters cannot enter invocation arguments', () => {
  for (const arg of ['test & whoami', '%USERNAME%', 'x|echo', 'x^y', 'x"y', 'x!y'])
    assert.throws(() => cmdInvocation('C:\\safe\\codex.cmd', [arg]), /UNSAFE_CMD/u);
});
test('Capture timeout closes streams and returns failure for its owned direct child', async () => {
  const start = Date.now();
  const result = await capture(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 });
  assert.equal(result.error, 'TIMEOUT');
  assert.equal(result.cleanup, 'not-verified');
  assert.ok(Date.now() - start < 2000);
});
test('Real Windows CMD wrapper receives Korean stdin and spaced path; no AI call', { skip: process.platform !== 'win32' }, async () => {
  await mkdir(runtime, { recursive: true });
  const folder = await mkdtemp(path.join(runtime, 'cmd 한글 '));
  const script = path.join(folder, 'stdin.mjs');
  const wrapper = path.join(folder, 'fixture.cmd');
  await writeFile(script, 'process.stderr.write(' + JSON.stringify(textHeader) + ');' +
    "let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', s => input+=s); process.stdin.on('end', () => console.log(JSON.stringify({input,args:process.argv.slice(2)})));", 'utf8');
  await writeFile(wrapper, '@"' + process.execPath + '" "' + script + '" %*\r\n', 'utf8');
  const invocation = cmdInvocation(wrapper, ['한글 공백']);
  const result = await capture(invocation.file, invocation.args, { input: '한글 검토\n', timeoutMs: 8000 });
  assert.equal(result.code, 0, result.error ?? result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { input: '한글 검토\n', args: ['한글 공백'] });
  assert.equal(codexTextEvidence(result, textRequest, textCwd).exactModelConfirmed, true);
});
