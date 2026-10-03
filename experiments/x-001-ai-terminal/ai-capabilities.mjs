import path from 'node:path';
import { capture, cmdInvocation, codexPath, fileState, authSummary, report, requiredFlags } from './lib.mjs';
import { parseCatalog } from './review-core.mjs';

const checks = [];
const candidates = [
  ['codex', codexPath(), [['version', ['--version']], ['help', ['--help']],
    ['execHelp', ['exec', '--help']], ['auth', ['login', 'status']],
    ['modelsHelp', ['debug', 'models', '--help']]]],
  ['gemini', process.env.GEMINI_CMD || path.join(process.env.APPDATA || '', 'npm', 'gemini.cmd'),
    [['version', ['--version']], ['help', ['--help']]]],
];
let blocked = process.platform !== 'win32';
for (const [provider, file, calls] of candidates) {
  const accessibility = await fileState(file);
  checks.push({ provider, command: file, accessibility });
  if (accessibility !== 'accessible') { blocked = true; continue; }
  let modelsSupported = false;
  for (const [name, args] of calls) {
    const invocation = cmdInvocation(file, args);
    const result = await capture(invocation.file, invocation.args, { timeoutMs: 15000 });
    const row = { provider, check: name, exitCode: result.code, error: result.error };
    const text = result.stdout + '\n' + result.stderr;
    if (name === 'version') row.version = text.match(provider === 'codex'
      ? /codex-cli\s+([\d.]+)/u : /\b(\d+\.\d+\.\d+)\b/u)?.[1] ?? 'UNCONFIRMED';
    if (name === 'auth') Object.assign(row, authSummary(result));
    if (/help$/iu.test(name)) {
      const flags = provider === 'codex'
        ? ['--model', '--config', '--sandbox', '--ask-for-approval', '--json', '--ephemeral', '--ignore-user-config', '--cd']
        : ['--model', '--prompt', '--output-format', '--approval-mode', '--extensions', '--policy', '--allowed-mcp-server-names'];
      row.flags = Object.fromEntries(flags.map((flag) => [flag, requiredFlags(text, [flag]).length === 0]));
    }
    if (name === 'modelsHelp') modelsSupported = result.code === 0 && !result.error && text.includes('--bundled');
    checks.push(row);
    if (result.error || result.code !== 0) {
      blocked = true;
      // A timed out wrapper may leave descendants. Do not launch more work for this provider.
      if (result.error) break;
    }
  }
  if (provider === 'codex' && modelsSupported) {
    const invocation = cmdInvocation(file, ['debug', 'models']);
    const result = await capture(invocation.file, invocation.args, { timeoutMs: 20000, maxBytes: 1024 * 1024 });
    try {
      if (result.error || result.code !== 0) throw new Error(result.error ?? 'CATALOG_FAILED');
      checks.push({ provider, check: 'catalog', status: 'CLI_CATALOG_OBSERVED',
        catalog: parseCatalog(result.stdout),
        availability: 'Catalog listing is not proof of successful service access.' });
    } catch (error) {
      checks.push({ provider, check: 'catalog', status: 'BLOCKED', reason: error.message });
      blocked = true;
    }
  }
}
await report('ai-capabilities', {
  status: blocked ? 'BLOCKED_OR_PARTIAL' : 'CAPABILITIES_OBSERVED',
  checks, actualServiceCall: 'NOT_RUN', currentConversationModel: 'UNCONFIRMED',
  note: '버전/help/인증 상태/모델 목록만 조사. 인증 파일과 토큰은 읽거나 저장하지 않음. Gemini 실제 검토와 모델 확인은 별도.',
});
process.exitCode = blocked ? 2 : 0;
