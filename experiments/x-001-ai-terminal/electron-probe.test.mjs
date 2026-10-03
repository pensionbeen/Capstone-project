import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { probeElectronVersion } from './electron-probe-core.mjs';

function fake(onKill) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.unref = () => {};
  child.kill = () => onKill(child);
  return child;
}
test('Electron version timeout remains failure even if close arrives later', async () => {
  const child = fake(c => { setTimeout(() => c.emit('close', 0), 5); return true; });
  const result = await probeElectronVersion('fixture', { spawnChild: () => child, timeoutMs: 5, cleanupMs: 30 });
  assert.equal(result.reason, 'ELECTRON_VERSION_TIMEOUT');
  assert.equal(result.closeObserved, true);
});
test('Failed kill and missing close resolve within the cleanup bound', async () => {
  for (const killResult of [false, true]) {
    const result = await probeElectronVersion('fixture', {
      spawnChild: () => fake(() => killResult), timeoutMs: 5, cleanupMs: 10,
    });
    assert.equal(result.closeObserved, false);
    assert.equal(result.reason, 'ELECTRON_VERSION_TIMEOUT');
  }
});
test('Late stderr after a timeout is retained before real close', async () => {
  const child = fake(c => {
    setTimeout(() => c.stderr.write('late failure'), 2);
    setTimeout(() => c.emit('close', 0), 5);
    return true;
  });
  const result = await probeElectronVersion('fixture', { spawnChild: () => child, timeoutMs: 5, cleanupMs: 30 });
  assert.ok(result.stderrBytes > 0);
  assert.equal(result.reason, 'ELECTRON_VERSION_TIMEOUT');
  assert.equal(result.closeObserved, true);
});
