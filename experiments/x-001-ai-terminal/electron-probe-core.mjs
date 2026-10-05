import { spawn } from 'node:child_process';

export function probeElectronVersion(file, { spawnChild = spawn, timeoutMs = 10000, cleanupMs = 4000 } = {}) {
  return new Promise(resolve => {
    let child, stdout = '', stderrBytes = 0, reason, settled = false, closed = false;
    let timer, closeTimer, killRequested = false;
    const finish = (code = null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(closeTimer);
      child?.stdout?.destroy(); child?.stderr?.destroy();
      if (!closed) child?.unref();
      resolve({ code, stdout, stderrBytes, reason: reason || null, closeObserved: closed, killRequested });
    };
    const stop = why => {
      reason ||= why;
      if (killRequested || settled) return;
      killRequested = true;
      try { child?.kill(); } catch { /* close remains required */ }
      closeTimer = setTimeout(() => { reason ||= 'ELECTRON_CLOSE_UNCONFIRMED'; finish(); }, cleanupMs);
    };
    try {
      child = spawnChild(file, ['-e', 'console.log(JSON.stringify(process.versions))'], {
        windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf8').on('data', data => {
        stdout += data;
        if (Buffer.byteLength(stdout) > 4096) stop('ELECTRON_OUTPUT_LIMIT');
      });
      child.stderr.on('data', data => { stderrBytes += data.length; stop('ELECTRON_VERSION_STDERR'); });
      child.on('error', () => stop('ELECTRON_VERSION_SPAWN_ERROR'));
      child.on('close', code => { closed = true; finish(code); });
      timer = setTimeout(() => stop('ELECTRON_VERSION_TIMEOUT'), timeoutMs);
    } catch { reason = 'ELECTRON_VERSION_SPAWN_ERROR'; finish(); }
  });
}
