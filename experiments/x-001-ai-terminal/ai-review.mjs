import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, open, unlink } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { authSummary, capture, cmdInvocation, codexPath, fileState, report, runtime,
  workspace, requiredFlags } from './lib.mjs';
import { chooseModel, parseCatalog, parsePacket, validatePacket, promptFor, codexEvidence, geminiEvidence, verdict } from './review-core.mjs';
import { guardGemini, geminiProjectSettings } from './gemini-guard.mjs';
import { snapshot } from './snapshot.mjs';

const baseCommit = '616418edbcb9009dde2255896bd05752e454b6d3';
const probe = {
  taskId: 'X-001', baseCommit, kind: 'test', parallelReviewUseful: false, risks: [],
  scope: '가짜 나이 판정 코드의 읽기 전용 검토', verification: '앱 검증 미실행; 경계값 18 확인 필요',
  remaining: '실제 CLI 모델/응답 관찰', reviewFocus: '18세를 성인으로 판정한다는 요구와 비교',
  content: 'Requirement: age >= 18 is adult. function isAdult(age) { return age > 18; }',
};
const argv = process.argv.slice(2);
if (!(argv.length === 1 && argv[0] === '--probe') &&
    !(argv.length === 2 && argv[0] === '--packet')) {
  console.error('Usage: node ai-review.mjs --probe | --packet path-to-reviewed-packet.json');
  process.exitCode = 2;
} else {
  await mkdir(runtime, { recursive: true });
  const lockPath = path.join(runtime, 'ai-review.lock');
  let lock;
  let leaveLock = false;
  const results = [];
  const packet = validatePacket(argv[0] === '--probe' ? probe : parsePacket(await readFile(path.resolve(argv[1]), 'utf8')));
  const packetSha256 = createHash('sha256').update(JSON.stringify(packet)).digest('hex');
  try {
    lock = await open(lockPath, 'wx');
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), taskId: packet.taskId }));
    if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED');
    const cwd = await workspace();
    const prompt = promptFor(packet);
    const invoke = async (file, args, options = {}) => {
      const before = await snapshot(cwd);
      const invocation = cmdInvocation(file, args);
      const result = await capture(invocation.file, invocation.args, { cwd, timeoutMs: 15000, ...options });
      if (['TIMEOUT', 'OUTPUT_LIMIT'].includes(result.error)) {
        leaveLock = true;
        throw new Error('OWNED_DESCENDANT_CLEANUP_UNCONFIRMED_STOP_ALL_CALLS');
      }
      if (await snapshot(cwd) !== before) {
        leaveLock = true;
        throw new Error('FIXTURE_CHANGED_STOP_ALL_CALLS');
      }
      return result;
    };
    const successful = (result) => {
      if (result.error || result.code !== 0) throw new Error(result.error ?? 'CLI_EXIT_NONZERO');
      return result;
    };
    const inspect = async (provider, file, expectedVersion) => {
      if (await fileState(file) !== 'accessible') throw new Error(provider + '_CMD_INACCESSIBLE');
      const version = successful(await invoke(file, ['--version']));
      const actualVersion = (version.stdout + version.stderr).match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
      if (actualVersion !== expectedVersion) throw new Error(provider + '_VERSION_REQUIRES_REVIEW');
      return successful(await invoke(file, ['--help']));
    };
    try {
      const file = codexPath();
      const help = await inspect('CODEX', file, '0.160.0');
      const execHelp = successful(await invoke(file, ['exec', '--help']));
      if (requiredFlags(help.stdout + help.stderr + execHelp.stdout + execHelp.stderr,
        ['--model', '--config', '--sandbox', '--ask-for-approval', '--json', '--ephemeral',
          '--ignore-user-config', '--skip-git-repo-check', '--cd']).length)
        throw new Error('CODEX_REQUIRED_FLAGS_UNCONFIRMED');
      const auth = authSummary(successful(await invoke(file, ['login', 'status'])));
      if (auth.method !== 'ChatGPT') throw new Error('CHATGPT_AUTH_NOT_CONFIRMED_NO_API_FALLBACK');
      const catalogResult = successful(await invoke(file, ['debug', 'models'],
        { timeoutMs: 20000, maxBytes: 1024 * 1024 }));
      const models = parseCatalog(catalogResult.stdout);
      const requested = chooseModel(packet, models);
      const args = ['--ask-for-approval', 'never', 'exec', '--ignore-user-config',
        '--sandbox', 'read-only', '--model', requested.model,
        '--config', 'model_reasoning_effort=' + requested.effort,
        '--ephemeral', '--json', '--skip-git-repo-check', '--cd', cwd, '-'];
      const result = await invoke(file, args, { input: prompt, timeoutMs: 180000, maxBytes: 256000 });
      const evidence = codexEvidence(result, requested);
      results.push({ provider: 'Codex', requested, status: verdict(result, evidence),
        evidence: { ...evidence, response: stripVTControlCharacters(evidence.response).slice(0, 6000) },
        exitCode: result.code, error: result.error,
        catalogAstra: models.find((model) => model.id === 'gpt-6-astra') ?? null });
    } catch (error) {
      results.push({ provider: 'Codex', status: 'BLOCKED', reason: error.message });
      if (leaveLock) throw error;
    }
    try {
      const file = process.env.GEMINI_CMD || path.join(process.env.APPDATA || '', 'npm', 'gemini.cmd');
      if (await fileState(file) !== 'accessible') throw new Error('GEMINI_CMD_INACCESSIBLE');
      const guard = await guardGemini(cwd);
      await mkdir(path.join(cwd, '.gemini'));
      await writeFile(path.join(cwd, '.gemini', 'settings.json'), JSON.stringify(geminiProjectSettings), 'utf8');
      await writeFile(path.join(cwd, 'X001_CONTEXT.md'), 'Read-only review. No tools or file changes.\n', 'utf8');
      const policy = path.join(cwd, 'deny-tools.toml');
      await writeFile(policy, '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n', 'utf8');
      const help = await inspect('GEMINI', file, '0.62.0');
      if (requiredFlags(help.stdout + help.stderr, ['--model', '--prompt', '--output-format',
        '--approval-mode', '--extensions', '--policy', '--allowed-mcp-server-names']).length)
        throw new Error('GEMINI_REQUIRED_FLAGS_UNCONFIRMED');
      const requestedModel = 'gemini-3.1-pro-preview';
      const args = ['--model', requestedModel, '--approval-mode', 'default', '--extensions', 'none',
        '--allowed-mcp-server-names', 'x001-disabled-' + randomUUID(), '--policy', policy,
        '--output-format', 'stream-json', '--prompt', 'Review the supplied text only.'];
      const result = await invoke(file, args, { input: prompt, timeoutMs: 180000, maxBytes: 256000 });
      // Policy parse errors can otherwise be nonfatal in Gemini 0.62.0.
      if (/error.*polic|polic.*(?:error|invalid|fail)/iu.test(result.stderr)) throw new Error('GEMINI_POLICY_ERROR');
      const evidence = geminiEvidence(result, requestedModel);
      results.push({ provider: 'Gemini', guard, status: verdict(result, evidence),
        evidence: { ...evidence, response: stripVTControlCharacters(evidence.response).slice(0, 6000) },
        exitCode: result.code, error: result.error,
        fallbackControl: 'Different observed models are rejected and reported; no automatic retry with lower model.' });
    } catch (error) {
      results.push({ provider: 'Gemini', status: 'BLOCKED', reason: error.message });
      if (leaveLock) throw error;
    }
  } catch (error) {
    results.push({ provider: 'runner', status: 'BLOCKED', reason: error.code === 'EEXIST'
      ? 'EXISTING_REVIEW_LOCK_INSPECT_BEFORE_RETRY' : error.message });
  } finally {
    if (lock) { await lock.close(); if (!leaveLock) await unlink(lockPath); }
  }
  const passed = results.length === 2 && results.every((row) => row.status === 'RESPONSE_AND_MODEL_OBSERVED');
  await report('ai-review', {
    status: passed ? 'PROBE_OBSERVED_REQUIRES_LEAD_REVIEW' : 'BLOCKED_OR_PARTIAL',
    taskId: packet.taskId, baseCommit: packet.baseCommit, packetSha256,
    scope: packet.scope, verification: packet.verification, results,
    currentConversationModelChanged: false, packagesInstalled: false,
    rawTranscriptSavedByRunner: false,
    cliOwnHistory: 'Codex ephemeral requested; Gemini may retain its own session history outside this report.',
    lockRetained: leaveLock,
  });
  process.exitCode = passed ? 0 : 2;
}
