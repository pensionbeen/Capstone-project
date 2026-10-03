import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { agyDenyRules, agyModel, verifyProjectPolicy, canaryEvidence, reviewInit, hasAgyAuthOverride, parseAgyEvent } from './agy-project-core.mjs';

const cwd = path.resolve('C:/X001/capstone-x001-policy-fixture');
const id = '7aa7a475-2ffc-418e-8939-4ca7728b9370';
const policy = { id, projectResources: { resources: [{ folderUri: 'file://' + cwd.replaceAll('\\', '/') }] },
  permissionGrants: { permissionGrants: { deny: agyDenyRules } } };
test('Malformed events and mixed-case credential overrides fail closed', () => {
  for (const line of ['null', '[]', '1', '{"event":"init","init":null}', '{"event":"result","result":3}']) {
    assert.throws(() => parseAgyEvent(line));
  }
  assert.equal(hasAgyAuthOverride({ gemini_api_key: 'synthetic' }), true);
  assert.equal(hasAgyAuthOverride({ Path: 'synthetic' }), false);
});
test('Gemini project policy must match the exact workspace and every deny action', () => {
  verifyProjectPolicy(policy, id, cwd);
  assert.throws(() => verifyProjectPolicy({ ...policy, id: 'wrong' }, id, cwd));
  assert.throws(() => verifyProjectPolicy(policy, id, cwd + '-other'));
  assert.throws(() => verifyProjectPolicy({ ...policy,
    permissionGrants: { permissionGrants: { deny: agyDenyRules.slice(1) } } }, id, cwd));
});
const entries = [
  ['view_file', 'AbsolutePath', path.join(cwd, 'read-canary.txt'), 'read_file'],
  ['write_to_file', 'TargetFile', path.join(cwd, 'new-canary.txt'), 'write_file'],
  ['replace_file_content', 'TargetFile', path.join(cwd, 'write-canary.txt'), 'write_file'],
  ['run_command', 'CommandLine', 'echo X001_COMMAND_CANARY', 'command'],
];
function proof() {
  return { projectId: id, model: agyModel, code: 0, closeObserved: true, reason: null, stderrBytes: 0,
    fixtureUnchanged: true, settingsUnchanged: true, policyUnchanged: true, ownershipUncertain: false,
    descendantsRemaining: [], final: { status: 'SUCCESS' },
    steps: entries.map(([name, field, target, action]) => ({ state: 'ERROR', tool_info: { name,
      parameters: { [field]: target }, error: { type: 'TOOL_ERROR',
        message: 'Permission denied for ' + action + '(' + target + '). Matches user-configured deny rule.' } } })) };
}
test('Model claims, missing tool attempts and unrelated errors are not enforcement evidence', () => {
  assert.equal(canaryEvidence(proof(), id, cwd).pass, true);
  for (const mutate of [
    p => { p.steps.pop(); },
    p => { p.steps[0].tool_info.error.message = 'File not found'; },
    p => { p.steps[0].tool_info.parameters.AbsolutePath = path.join(cwd, 'other.txt'); },
    p => { p.steps[0].state = 'DONE'; },
    p => { p.steps.push({ state: 'DONE' }); },
    p => { p.fixtureUnchanged = false; },
    p => { p.descendantsRemaining = [100]; },
    p => { p.model = 'gemini-flash'; },
  ]) { const changed = proof(); mutate(changed); assert.equal(canaryEvidence(changed, id, cwd).pass, false); }
});
test('Review init checks the CLI Pro setting and workspace; advertised tools are not permission grants', () => {
  const init = { model: agyModel, cwd, permission_mode: 'request-review', tools: Array(60).fill('tool') };
  assert.equal(reviewInit(init, cwd), true);
  assert.equal(reviewInit({ ...init, model: 'gemini-flash' }, cwd), false);
  assert.equal(reviewInit({ ...init, cwd: cwd + '-other' }, cwd), false);
  assert.equal(reviewInit({ ...init, permission_mode: 'bypassPermissions' }, cwd), false);
});
