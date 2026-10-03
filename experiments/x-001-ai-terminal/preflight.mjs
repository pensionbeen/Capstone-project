import os from 'node:os';
import { authSummary, capture, cmdInvocation, codexPath, fileState, loadPty, report, requiredFlags } from './lib.mjs';

const checks = [];
let blocked = false;
checks.push({ id: 'XP-01', os: os.version(), arch: process.arch, node: process.version });
if (process.platform !== 'win32' || process.arch !== 'x64') {
  blocked = true;
  checks.push({ id: 'XP-02', status: 'BLOCKED', reason: 'WINDOWS_X64_REQUIRED' });
}
const file = codexPath();
const available = await fileState(file);
checks.push({ id: 'XP-03', codexCmd: file, accessibility: available });
if (available !== 'accessible') {
  blocked = true;
} else {
  for (const [name, args] of [
    ['version', ['--version']], ['auth', ['login', 'status']],
    ['help', ['--help']], ['execHelp', ['exec', '--help']],
  ]) {
    const command = cmdInvocation(file, args);
    const result = await capture(command.file, command.args);
    if (result.error || result.code !== 0) blocked = true;
    const row = { id: 'XP-04-' + name, exitCode: result.code, error: result.error };
    if (name === 'version') {
      row.version = result.stdout.match(/codex-cli\s+([\w.+-]+)/u)?.[1] || 'unconfirmed';
      if (row.version === 'unconfirmed') blocked = true;
    }
    if (name === 'auth') {
      Object.assign(row, authSummary(result));
      if (!row.statusCommandSucceeded || row.method !== 'ChatGPT') blocked = true;
    }
    if (name === 'help' || name === 'execHelp') {
      const text = result.stdout + result.stderr;
      const flags = name === 'help'
        ? ['--sandbox', '--ask-for-approval', '--no-alt-screen', '--cd']
        : ['--json', '--output-schema', '--skip-git-repo-check'];
      row.missingFlags = requiredFlags(text, flags);
      if (row.missingFlags.length) blocked = true;
    }
    checks.push(row);
    if (result.error) break; // Don't repeat commands after a timeout or spawn failure.
  }
}
try { loadPty(); checks.push({ id: 'XP-05', status: 'LOADED', version: '1.1.0' }); }
catch (error) {
  blocked = true;
  checks.push({ id: 'XP-05', status: 'BLOCKED', reason: error.code || error.message });
}
await report('preflight', {
  status: blocked ? 'BLOCKED' : 'READY_FOR_EXPERIMENT',
  checks, model: 'unconfirmed', reasoning: 'unconfirmed', limits: 'unconfirmed',
  note: 'Preflight success is not a service response or PTY compatibility result.',
});
process.exitCode = blocked ? 2 : 0;
