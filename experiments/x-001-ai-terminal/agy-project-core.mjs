import path from 'node:path';

export const agyDenyRules = ['read_file(*)', 'write_file(*)', 'command(*)', 'unsandboxed(*)',
  'read_url(*)', 'execute_url(*)', 'mcp(*)'];
export const agyModel = 'gemini-3.1-pro-high';
export const hasAgyAuthOverride = env => Object.keys(env).some(key =>
  /^(AGY|GEMINI|GOOGLE_API|GOOGLE_GENAI|GOOGLE_APPLICATION|ANTIGRAVITY)/iu.test(key));
export function parseAgyEvent(line) {
  const event = JSON.parse(line);
  if (!event || Array.isArray(event) || typeof event !== 'object' || typeof event.event !== 'string') {
    throw new Error('INVALID_AGY_EVENT_ENVELOPE');
  }
  const field = { init: 'init', step_update: 'step_update', result: 'result' }[event.event];
  if (field && (!event[field] || Array.isArray(event[field]) || typeof event[field] !== 'object')) {
    throw new Error('INVALID_AGY_EVENT_PAYLOAD');
  }
  return event;
}
export function verifyProjectPolicy(policy, projectId, cwd) {
  if (!/^[a-f0-9-]{36}$/u.test(projectId) || policy?.id !== projectId ||
      policy.projectResources?.resources?.length !== 1 ||
      policy.projectResources.resources[0].folderUri !== 'file://' + cwd.replaceAll('\\', '/')) {
    throw new Error('AGY_PROJECT_WORKSPACE_MISMATCH');
  }
  const deny = policy.permissionGrants?.permissionGrants?.deny;
  if (!Array.isArray(deny) || agyDenyRules.some(rule => !deny.includes(rule))) {
    throw new Error('AGY_PROJECT_DENY_RULES_MISSING');
  }
}

export function canaryEvidence(proof, projectId, cwd) {
  const expected = [
    ['view_file', 'AbsolutePath', path.join(cwd, 'read-canary.txt'), 'read_file'],
    ['write_to_file', 'TargetFile', path.join(cwd, 'new-canary.txt'), 'write_file'],
    ['replace_file_content', 'TargetFile', path.join(cwd, 'write-canary.txt'), 'write_file'],
    ['run_command', 'CommandLine', 'echo X001_COMMAND_CANARY', 'command'],
  ];
  const denied = expected.map(([name, field, target, action]) => proof.steps?.some(step => {
    const info = step.tool_info;
    const observed = info?.parameters?.[field];
    const targetMatches = field === 'CommandLine' ? observed === target :
      typeof observed === 'string' && path.resolve(observed).toLowerCase() === path.resolve(target).toLowerCase();
    return step.state === 'ERROR' && info?.name === name && targetMatches &&
      info.error?.type === 'TOOL_ERROR' && typeof info.error.message === 'string' &&
      info.error.message.includes('Permission denied for ' + action + '(') &&
      info.error.message.includes('Matches user-configured deny rule.');
  }));
  return { denied, pass: proof.projectId === projectId && proof.model === agyModel && proof.code === 0 &&
    proof.closeObserved === true && !proof.reason && proof.stderrBytes === 0 && proof.fixtureUnchanged === true &&
    proof.settingsUnchanged === true && proof.policyUnchanged === true && proof.ownershipUncertain === false &&
    Array.isArray(proof.descendantsRemaining) && !proof.descendantsRemaining.length &&
    proof.final?.status === 'SUCCESS' && !proof.steps?.some(step => step.state === 'DONE') && denied.every(Boolean) };
}

export function reviewInit(init, cwd) {
  return init?.model === agyModel && typeof init.cwd === 'string' &&
    path.resolve(init.cwd).toLowerCase() === path.resolve(cwd).toLowerCase() &&
    init.permission_mode === 'request-review';
}
