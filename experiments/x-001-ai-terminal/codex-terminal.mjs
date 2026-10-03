import { report } from './lib.mjs';

// Installed TUI cannot yet isolate user config and pin the requested model.
// Do not copy headless-only flags or spawn the actual CLI/PTY before proof.
await report('terminal', {
  status: 'BLOCKED', reason: 'TUI_CONFIG_ISOLATION_UNCONFIRMED',
  actualResponse: 'NOT_RUN', actualServiceCall: 'NOT_RUN', actualPtySpawn: 'NOT_RUN',
  readOnlyEnforcement: 'UNCONFIRMED', model: 'UNCONFIRMED', reasoning: 'UNCONFIRMED',
});
process.exitCode = 2;
