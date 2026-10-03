import path from 'node:path';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { root, report } from './lib.mjs';
import { superviseManaged } from './managed-supervisor.mjs';
import { probeElectronVersion } from './electron-probe-core.mjs';

// Separate runtime compatibility experiment. No BrowserWindow or app integration.
const [electronPath, flag] = process.argv.slice(2);
let reason, version, outcome, versionProbe;
try {
  if (process.argv.length !== 4 || flag !== '--conpty-dll' ||
      !path.isAbsolute(electronPath) || path.basename(electronPath).toLowerCase() !== 'electron.exe') {
    throw new Error('USAGE_ELECTRON_NODE_PROBE_ABSOLUTE_ELECTRON_EXE_CONPTY_DLL');
  }
  await access(electronPath);
  const installed = JSON.parse(await readFile(path.resolve(electronPath, '..', '..', 'package.json'), 'utf8'));
  if (installed.name !== 'electron' || installed.version !== '44.5.1') throw new Error('ELECTRON_VERSION_MISMATCH');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  versionProbe = await probeElectronVersion(electronPath);
  if (versionProbe.reason || !versionProbe.closeObserved || versionProbe.code !== 0) {
    throw new Error(versionProbe.reason || 'ELECTRON_VERSION_PROBE_FAILED');
  }
  version = JSON.parse(versionProbe.stdout);
  if (version.electron !== '44.5.1' || version.node !== '24.21.0') throw new Error('ELECTRON_RUNTIME_REQUIRES_REVIEW');
  outcome = await superviseManaged(electronPath, [path.join(root, 'managed-pty-worker.mjs'), 'normal',
    '--conpty-dll', '--fixture-node', process.execPath], {
    cwd: root,
    spawnHost: (file, args, options) => spawn(file, args, { ...options, env }),
  });
} catch (error) { reason = error.code || error.message; }
const pass = !reason && outcome?.status === 'PASS_MANAGED_FIXTURE_ONLY';
await report('electron-node-probe', { status: pass ? 'PASS_ELECTRON_NODE_FIXTURE_ONLY' : 'FAIL', reason,
  versionProbe: versionProbe && { ...versionProbe, stdout: undefined },
  versions: version && { electron: version.electron, node: version.node, modules: version.modules, napi: version.napi },
  outcome, runtimeMode: 'ELECTRON_RUN_AS_NODE', ptyMode: 'EXPERIMENTAL_CONPTY_DLL',
  terminalGuest: 'SYSTEM_NODE_SYNTHETIC_FIXTURE',
  nativeNaturalExit: false, browserWindow: 'NOT_RUN', rendererIntegration: 'NOT_RUN',
  realAiInElectron: 'NOT_RUN', appIntegration: 'NOT_RUN', packagedBuild: 'NOT_RUN' });
process.exitCode = pass ? 0 : 2;
