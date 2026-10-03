import path from 'node:path';
import { capture, fileState, report } from './lib.mjs';
import { parseAgyHelp } from './agy-help.mjs';

// Antigravity is a separate executable from the npm Gemini CLI.
// Inspect version/help only: no prompt, login, credentials, or global edits.
const file = process.env.AGY_EXE || path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
const checks = [];
let blocked = process.platform !== 'win32' || !path.win32.isAbsolute(file) ||
  path.extname(file).toLowerCase() !== '.exe';
if (!blocked) {
  const accessibility = await fileState(file);
  checks.push({ command: file, accessibility });
  blocked = accessibility !== 'accessible';
}
if (!blocked) {
  for (const flag of ['--version', '--help']) {
    const result = await capture(file, [flag], { timeoutMs: 10000, maxBytes: 128000 });
    const text = result.stdout + '\n' + result.stderr;
    const row = { check: flag, exitCode: result.code, error: result.error };
    if (flag === '--version') {
      row.version = text.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1] ?? 'UNCONFIRMED';
      if (row.version === 'UNCONFIRMED') row.error = 'VERSION_FORMAT_UNCONFIRMED';
    }
    else {
      const help = parseAgyHelp(text);
      row.flags = help.flags;
      row.commands = help.commands;
      if (!help.formatConfirmed) row.error ??= 'HELP_FORMAT_UNCONFIRMED';
    }
    checks.push(row);
    if (row.error || result.code !== 0) { blocked = true; break; }
  }
}
await report('agy-capabilities', {
  status: blocked ? 'BLOCKED_OR_PARTIAL' : 'VERSION_HELP_OBSERVED', provider: 'Antigravity CLI', checks,
  actualServiceCall: 'NOT_RUN', auth: 'NOT_INSPECTED', readOnlyEnforcement: 'UNCONFIRMED',
  credentialsRead: false, globalSettingsChanged: false,
});
process.exitCode = blocked ? 2 : 0;
