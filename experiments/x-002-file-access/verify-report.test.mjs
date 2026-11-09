import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Synthetic reports exercise only the verifier. No process or access evidence is produced.
const verifier = fileURLToPath(new URL('./verify-report.mjs', import.meta.url));
const expected = { allowed: 'a'.repeat(64), protected: 'b'.repeat(64) };
const ok = (Operation, Bytes = 0, Sha256 = null) => ({ Operation, Success: true, Win32Error: 0, Bytes, Sha256 });
const denied = (Operation) => ({ Operation, Success: false, Win32Error: 5, Bytes: 0, Sha256: null });
const launch = (Pid) => ({ Pid, Success: true, Error: 0, ExitCode: 0, JobEmpty: true, TimedOut: false, CleanupConfirmed: true });
const identity = (pid) => ({ pid, restricted: true, elevated: false, userSid: 'user', restrictingSids: ['restricted'] });

function example() {
  const userReads = Object.entries(expected).map(([kind, hash]) => ok(`${kind}/read`, 64, hash));
  const actor = (pid) => ({
    identity: identity(pid),
    readPassed: true,
    rows: [ok('allowed/read', 64, expected.allowed), denied('protected/read'),
      ok('allowed/write', 4), denied('protected/write'), ok('allowed/delete'), denied('protected/delete')],
  });
  const direct = actor(11);
  direct.childLaunch = launch(12);
  direct.rows.push(...['owner-hardened/WRITE_DAC', 'owner-hardened/change-DACL', 'owner-hardened/WRITE_OWNER',
    'protected-parent/DELETE_CHILD', 'fixture-parent/DELETE_CHILD', 'empty-protected/remove-directory',
    'protected/rename-to-allowed', 'alias/hardlink-read', 'alias/extended-path-read', 'alias/dotdot-read'].map(denied));
  for (const name of ['WRITE_DAC', 'change-DACL', 'read-after-DACL']) direct.rows.push(ok(`owner-unsafe/${name}`));
  return {
    schemaVersion: 2, productProtectionApproved: false, controller: { ...identity(10), restricted: false },
    ordinaryUser: userReads, ordinaryUserAfter: [...userReads, ok('allowed/write', 4), ok('protected/write', 4),
      ok('allowed/delete'), ok('protected/delete')],
    expectedReadHashes: expected, protectedBeforeRestricted: { 'protected.txt': expected.protected },
    protectedAfterRestricted: { 'protected.txt': expected.protected },
    requestedRestriction: { restrictingSids: ['restricted'] }, restrictedDirect: direct, restrictedChild: actor(12),
    restrictedLaunch: launch(11), preopenedLaunch: launch(13), preopenedHandle: {
      identity: identity(13), inheritedRead: ok('preopened/read-inherited-handle', 1), freshOpen: denied('preopened/fresh-open'),
    },
    workerAllowedMutationsVerified: true, childAllowedMutationsVerified: true, hardenedFilesUnchanged: true,
    observationsComplete: true, error: null, launchedProcessesGone: true, aclRestored: true, fixtureRemoved: true,
    privateDesktopHandleClosed: true, privateDesktopAbsentAfterClose: true, privateDesktopReopenError: 2,
  };
}

function verify(report) {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-report-test-'));
  const file = join(dir, 'report.json');
  try {
    writeFileSync(file, JSON.stringify(report), { flag: 'wx' });
    const result = spawnSync(process.execPath, [verifier, file], { encoding: 'utf8', windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  } finally {
    unlinkSync(file);
    rmdirSync(dir);
  }
}

test('complete synthetic measurements pass only the experiment verifier', () => {
  const result = verify(example());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /T-014 remains blocked/);
});

for (const [name, invalidate] of Object.entries({
  'legacy full report': r => { r.schemaVersion = 1; },
  'empty successful read': r => { r.restrictedDirect.rows[0].Bytes = 0; },
  'wrong allowed nonce': r => { r.restrictedChild.rows[0].Sha256 = expected.protected; },
  'wrong user nonce': r => { r.ordinaryUser[1].Sha256 = expected.allowed; },
  'file missing': r => { r.restrictedDirect.rows[1].Win32Error = 2; },
  'protected content returned': r => { r.restrictedChild.rows[1] = ok('protected/read', 64, expected.protected); },
  'missing child': r => { delete r.restrictedChild; },
  'failed initialization': r => { r.restrictedLaunch.ExitCode = 0xc0000142; },
  'same PID for both actors': r => { r.restrictedChild.identity.pid = r.restrictedDirect.identity.pid; },
  'write denied everywhere': r => { r.restrictedChild.rows[2] = denied('allowed/write'); },
  'write changed no bytes': r => { r.restrictedDirect.rows[2].Bytes = 0; },
  'delete had no effect': r => { r.workerAllowedMutationsVerified = false; },
  'protected file changed': r => { r.protectedAfterRestricted['protected.txt'] = expected.allowed; },
  'unconfirmed process cleanup': r => { r.restrictedLaunch.CleanupConfirmed = false; },
  'desktop still exists': r => { r.privateDesktopAbsentAfterClose = false; },
  'unrestored ACL': r => { r.aclRestored = false; },
})) {
  test(`rejects ${name}`, () => {
    const report = example();
    invalidate(report);
    const result = verify(report);
    assert.equal(result.status, 1, result.stdout);
  });
}
