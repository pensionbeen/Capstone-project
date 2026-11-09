import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const policyFailure = process.argv[2] === '--policy-failure';
const initializationFailure = process.argv[2] === '--initialization-failure';
const reportPath = process.argv[policyFailure || initializationFailure ? 3 : 2];
if (!reportPath) throw new Error('Usage: node verify-report.mjs [--policy-failure|--initialization-failure] REPORT_JSON');
const report = JSON.parse(await readFile(reportPath, 'utf8'));
assert.ok([1, 2].includes(report.schemaVersion));
assert.equal(report.productProtectionApproved, false, 'This experiment must not approve T-014.');
assert.equal(report.controller.elevated, false);
assert.equal(report.controller.restricted, false);
function row(rows, name) {
  const matches = rows.filter((item) => item.Operation === name);
  assert.equal(matches.length, 1, `Exactly one ${name} observation is required.`);
  return matches[0];
}
function markerRead(item, hash) {
  assert.equal(item.Success, true, item.Operation);
  assert.equal(item.Win32Error, 0, item.Operation);
  assert.equal(item.Bytes, 64, item.Operation);
  assert.equal(item.Sha256, hash, item.Operation);
}
function userReads(rows) {
  const expected = report.expectedReadHashes;
  assert.match(expected.allowed, /^[0-9a-f]{64}$/);
  assert.match(expected.protected, /^[0-9a-f]{64}$/);
  assert.notEqual(expected.allowed, expected.protected);
  for (const kind of ['allowed', 'protected']) markerRead(row(rows, `${kind}/read`), expected[kind]);
}
if (initializationFailure && !report.aclRestored) {
  const recovery = JSON.parse(await readFile(join(dirname(reportPath), 'recovery.json'), 'utf8'));
  assert.equal(recovery.aclRestored, true);
  assert.equal(recovery.fixtureRemoved, true);
} else {
  assert.equal(report.aclRestored, true);
  assert.equal(report.fixtureRemoved, true);
}

if (initializationFailure) {
  assert.equal(report.observationsComplete, false);
  assert.equal(report.restrictedLaunch.Success, false);
  assert.equal(report.restrictedLaunch.Error, 0, 'CreateProcessAsUser itself succeeded.');
  assert.equal(report.restrictedLaunch.ExitCode, 0xc0000142);
  assert.equal(report.restrictedLaunch.JobEmpty, true);
  assert.equal(report.restrictedLaunch.TimedOut, false);
  assert.equal(report.restrictedDirect, undefined, 'Unexecuted worker observations must remain absent.');
  assert.equal(report.restrictedChild, undefined);
  assert.equal(report.ordinaryUser.length, report.schemaVersion === 1 ? 6 : 2);
  if (report.schemaVersion === 2) {
    userReads(report.ordinaryUser);
    assert.equal(report.restrictedLaunch.CleanupConfirmed, true);
    assert.equal(report.privateDesktopHandleClosed, true);
    assert.equal(report.privateDesktopAbsentAfterClose, true);
    assert.equal(report.privateDesktopReopenError, 2);
  }
  for (const item of report.ordinaryUser) {
    assert.equal(item.Success, true);
    assert.equal(item.Win32Error, 0);
  }
  console.log('PASS: process creation succeeded; initialization failed with 0xC0000142; file denial/child observations are absent; restoration and cleanup are accounted for.');
  process.exit(0);
}

if (policyFailure) {
  assert.equal(report.observationsComplete, false);
  assert.match(report.injectedPolicyFailure, /missing dummy target/);
  assert.match(report.error, /FileNotFoundException|Win32Exception/);
  assert.equal(report.restrictedLaunch, undefined, 'Policy failure must precede process launch.');
  console.log('PASS: actual missing-target policy failure prevented the restricted launch; rollback and cleanup verified.');
  process.exit(0);
}

assert.equal(report.schemaVersion, 2, 'Full acceptance requires the randomized sibling read controls.');
assert.equal(report.observationsComplete, true, report.error ?? undefined);
assert.equal(report.error, null);
assert.equal(report.hardenedFilesUnchanged, true);
assert.deepEqual(report.protectedAfterRestricted, report.protectedBeforeRestricted);
assert.equal(report.protectedBeforeRestricted['protected.txt'], report.expectedReadHashes.protected);
assert.equal(report.workerAllowedMutationsVerified, true);
assert.equal(report.childAllowedMutationsVerified, true);
assert.equal(report.launchedProcessesGone, true);
assert.equal(report.privateDesktopHandleClosed, true);
assert.equal(report.privateDesktopAbsentAfterClose, true);
assert.equal(report.privateDesktopReopenError, 2);
userReads(report.ordinaryUser);
userReads(report.ordinaryUserAfter);
assert.equal(report.ordinaryUser.length, 2);
assert.equal(report.ordinaryUserAfter.length, 6);
for (const kind of ['allowed', 'protected']) {
  for (const op of ['write', 'delete']) {
    const result = row(report.ordinaryUserAfter, `${kind}/${op}`);
    assert.equal(result.Success, true);
    assert.equal(result.Win32Error, 0);
    if (op === 'write') assert.equal(result.Bytes, 4);
  }
}
for (const launch of [report.restrictedLaunch, report.restrictedDirect.childLaunch, report.preopenedLaunch]) {
  assert.equal(launch.Success, true);
  assert.equal(launch.Error, 0);
  assert.equal(launch.ExitCode, 0);
  assert.equal(launch.JobEmpty, true);
  assert.equal(launch.CleanupConfirmed, true);
  assert.equal(launch.TimedOut, false);
}
assert.ok(report.requestedRestriction.restrictingSids.length > 0);
for (const actor of [report.restrictedDirect, report.restrictedChild, report.preopenedHandle]) {
  assert.equal(actor.identity.restricted, true);
  assert.equal(actor.identity.elevated, false);
  assert.equal(actor.identity.userSid, report.controller.userSid);
  assert.deepEqual([...actor.identity.restrictingSids].sort(), [...report.requestedRestriction.restrictingSids].sort());
}
assert.notEqual(report.restrictedDirect.identity.pid, report.restrictedChild.identity.pid);
assert.equal(report.restrictedLaunch.Pid, report.restrictedDirect.identity.pid);
assert.equal(report.restrictedDirect.childLaunch.Pid, report.restrictedChild.identity.pid);

const denied = (item) => {
  assert.equal(item.Success, false, item.Operation);
  assert.equal(item.Win32Error, 5, item.Operation);
};
for (const actor of [report.restrictedDirect, report.restrictedChild]) {
  assert.equal(actor.readPassed, true);
  markerRead(row(actor.rows, 'allowed/read'), report.expectedReadHashes.allowed);
  assert.equal(row(actor.rows, 'protected/read').Bytes, 0);
  assert.equal(row(actor.rows, 'protected/read').Sha256, null);
  assert.equal(row(actor.rows, 'allowed/write').Bytes, 4);
  for (const operation of ['read', 'write', 'delete']) {
    denied(row(actor.rows, `protected/${operation}`));
    const allowed = row(actor.rows, `allowed/${operation}`);
    assert.equal(allowed.Success, true, allowed.Operation);
    assert.equal(allowed.Win32Error, 0, allowed.Operation);
  }
}
for (const name of [
  'owner-hardened/WRITE_DAC', 'owner-hardened/change-DACL', 'owner-hardened/WRITE_OWNER',
  'protected-parent/DELETE_CHILD', 'fixture-parent/DELETE_CHILD',
  'empty-protected/remove-directory', 'protected/rename-to-allowed',
  'alias/hardlink-read', 'alias/extended-path-read', 'alias/dotdot-read',
]) denied(row(report.restrictedDirect.rows, name));

// These are intentionally vulnerable controls, not successful protection.
for (const name of ['owner-unsafe/WRITE_DAC', 'owner-unsafe/change-DACL', 'owner-unsafe/read-after-DACL']) {
  const item = row(report.restrictedDirect.rows, name);
  assert.equal(item.Success, true, `Expected controlled owner-rights bypass: ${name}`);
  assert.equal(item.Win32Error, 0);
}
assert.equal(report.preopenedHandle.inheritedRead.Success, true, 'Expected controlled inherited-handle bypass.');
assert.ok(report.preopenedHandle.inheritedRead.Bytes > 0);
denied(report.preopenedHandle.freshOpen);
console.log('PASS: ordinary user, direct/child OS denials, allowed operations, ACL/parent/alias checks, controlled bypasses, restoration, and cleanup match the recorded matrix.');
console.log('T-014 remains blocked: actual AI/PTY, service/proxy isolation, desktop separation, and other unverified boundaries are outside this result.');
