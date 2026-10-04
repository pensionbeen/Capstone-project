import { spawn } from 'node:child_process';

// Explicit, opt-in test command: uses the user's existing Codex ChatGPT login.
const child = spawn(
  process.execPath,
  [
    'node_modules/@playwright/test/cli.js',
    'test',
    'tests/ui/ai.spec.ts',
    '--grep',
    process.argv[2] || '실제 Codex 연결',
  ],
  { stdio: 'inherit', windowsHide: true, env: { ...process.env, ORBIT_LIVE_AI: '1' } },
);
child.once('error', () => {
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
