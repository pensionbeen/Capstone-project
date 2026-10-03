import { spawn } from 'node:child_process';
import { readFile, lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { runtime, report, capture } from './lib.mjs';
import { snapshot } from './snapshot.mjs';
import { validatePacket, promptFor } from './review-core.mjs';
import { processSnapshot, SessionProcesses, validateSnapshot } from './managed-processes.mjs';
import { agyModel, verifyProjectPolicy, canaryEvidence, reviewInit, hasAgyAuthOverride, parseAgyEvent } from './agy-project-core.mjs';

// Existing dedicated test project only. Setup is performed through the CLI's
// Project permissions UI; this runner never edits global/project permissions.
const [packetFile, projectId, cwd, proofFile] = process.argv.slice(2);
const hash = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const lockPath = path.join(runtime, 'ai-review.lock');
let lock, retainLock = false, reason, result, observations = {};
try {
  if (process.argv.length !== 6 || !path.isAbsolute(cwd || '') || !/^[a-f0-9-]{36}$/u.test(projectId || '')) {
    throw new Error('USAGE_PACKET_PROJECT_UUID_TEMP_WORKSPACE_CANARY_PROOF');
  }
  const relative = path.relative(os.tmpdir(), cwd);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
      !path.basename(cwd).startsWith('capstone-x001-policy-')) throw new Error('DEDICATED_TEMP_PROJECT_REQUIRED');
  const packet = validatePacket(JSON.parse(await readFile(packetFile, 'utf8')));
  const proof = JSON.parse(await readFile(proofFile, 'utf8'));
  if (!canaryEvidence(proof, projectId, cwd).pass) throw new Error('FOUR_EXPLICIT_CANARY_DENIALS_REQUIRED');
  if (hasAgyAuthOverride(process.env)) {
    throw new Error('AUTH_OR_PROVIDER_ENV_OVERRIDE_PRESENT');
  }
  const profile = path.join(os.homedir(), '.gemini');
  const policyPath = path.join(profile, 'config', 'projects', projectId + '.json');
  const settingsPath = path.join(profile, 'antigravity-cli', 'settings.json');
  const policyRaw = await readFile(policyPath), settingsRaw = await readFile(settingsPath);
  verifyProjectPolicy(JSON.parse(policyRaw), projectId, cwd);
  const allowed = new Set(['allowNonWorkspaceAccess', 'colorScheme', 'model', 'permissions', 'trustedWorkspaces']);
  if (Object.keys(JSON.parse(settingsRaw)).some(key => !allowed.has(key))) throw new Error('UNKNOWN_GLOBAL_SETTINGS');
  const autoload = [path.join(profile, 'config', 'hooks.json'), path.join(profile, 'config', 'mcp_config.json'),
    path.join(profile, 'config', 'plugins'), path.join(profile, 'antigravity-cli', 'plugins')];
  for (let folder = cwd; ; folder = path.dirname(folder)) {
    autoload.push(...['hooks.json', 'mcp_config.json', 'plugins'].map(name => path.join(folder, '.agents', name)));
    if (folder === path.dirname(folder)) break;
  }
  for (const file of autoload) {
    try {
      await lstat(file);
      if (file.endsWith('mcp_config.json')) {
        const raw = await readFile(file, 'utf8');
        if (!raw.trim()) continue;
        const config = JSON.parse(raw);
        if (config && !Array.isArray(config) && Object.keys(config).every(key => key === 'mcpServers') &&
            (!config.mcpServers || (typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers) &&
            !Object.keys(config.mcpServers).length))) continue;
      }
      throw new Error('AUTOLOAD_COMPONENT_PRESENT');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  lock = await open(lockPath, 'wx');
  await lock.writeFile(JSON.stringify({ pid: process.pid, kind: 'agy-project-review', createdAt: new Date().toISOString() }));
  const file = path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
  const version = await capture(file, ['--version'], { cwd, timeoutMs: 10000 });
  if (version.error) retainLock = true;
  if (version.error || version.code !== 0 || !/\b1\.2\.16\b/u.test(version.stdout + version.stderr)) {
    throw new Error('AGY_VERSION_REQUIRES_REVIEW');
  }
  const before = await snapshot(cwd), baseline = await processSnapshot();
  validateSnapshot(baseline);
  if (!baseline.some(row => row.pid === process.pid)) throw new Error('SUPERVISOR_IDENTITY_UNCONFIRMED');
  const child = spawn(file, ['--project', projectId, '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--model', agyModel, '--effort', 'high', '--sandbox', '--disable-slash-commands',
    '--print-timeout', '150s'], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const tracker = new SessionProcesses(baseline, child.pid, process.pid);
  // Plan is a slash-command expansion and is ineffective with slash commands
  // disabled. The verified project deny rules supply the permission boundary.
  let buffer = '', bytes = 0, stderrBytes = 0, stderrDiagnostic = '', init, sent = false, closed = false, code, final;
  let stopAt, killAt, toolObserved = false;
  const fail = why => { reason ||= why; };
  child.stdout.setEncoding('utf8').on('data', text => {
    bytes += Buffer.byteLength(text);
    if (bytes > 256000) { fail('OUTPUT_LIMIT'); return; }
    buffer += text;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      let event;
      try { event = parseAgyEvent(line); } catch { fail('INVALID_JSON_EVENT'); continue; }
      if (event.event === 'init') {
        if (init) fail('DUPLICATE_INIT');
        else { init = event.init; if (!reviewInit(init, cwd)) fail('INIT_CONFIG_MISMATCH'); }
      } else if (event.event === 'step_update' &&
          (event.step_update?.step_type === 'tool' || event.step_update?.subagent_info)) {
        toolObserved = true; fail('UNEXPECTED_TOOL_ACTIVITY');
      } else if (event.event === 'result') {
        if (!sent || !reviewInit(init, cwd)) fail('RESULT_BEFORE_VERIFIED_REQUEST');
        else if (final) fail('DUPLICATE_RESULT');
        else { final = event.result; child.stdin.end(); stopAt ||= Date.now(); }
      } else if (event.event === 'error') fail('PROVIDER_ERROR');
    }
  });
  child.stderr.on('data', data => {
    stderrBytes += data.length;
    stderrDiagnostic = (stderrDiagnostic + data.toString('utf8')).slice(0, 512);
    fail('AGY_STDERR');
  });
  child.stdin.on('error', () => fail('AGY_STDIN_ERROR'));
  child.on('error', () => fail('AGY_SPAWN_ERROR'));
  child.on('close', value => { closed = true; code = value; });
  const deadline = Date.now() + 180000;
  try {
    while (!closed) {
      if (Date.now() >= deadline) fail('REVIEW_TIMEOUT');
      try { tracker.observe(await processSnapshot()); if (tracker.uncertain) fail('OWNERSHIP_UNCONFIRMED'); }
      catch { fail('PROCESS_AUDIT_FAILED'); }
      if (reason && !stopAt) { stopAt = Date.now(); child.stdin.end(); }
      if (stopAt && Date.now() - stopAt >= 4000 && !killAt) {
        fail(final ? 'RESULT_CLOSE_TIMEOUT' : 'REVIEW_STOP_TIMEOUT');
        killAt = Date.now(); child.kill();
      }
      if (killAt && Date.now() - killAt >= 4000) break;
      if (init && tracker.ownerKey && !sent && !reason) {
        sent = true; child.stdin.write(JSON.stringify({ event: 'user', message: { content: promptFor(packet) } }) + '\n');
      }
      await sleep(200);
    }
  } finally {
    if (!closed) {
      fail('AGY_CLOSE_UNCONFIRMED'); retainLock = true;
      try { child.kill(); } catch { /* preserve failure */ }
    }
    try { tracker.observe(await processSnapshot()); }
    catch { fail('FINAL_PROCESS_AUDIT_FAILED'); retainLock = true; }
    if (tracker.alive().length || tracker.uncertain) { fail('DESCENDANT_CLEANUP_UNCONFIRMED'); retainLock = true; }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    if (!closed) child.unref();
  }
  if (buffer.trim()) fail('INCOMPLETE_FINAL_EVENT');
  observations = { code, closeObserved: closed, userMessageSent: sent, toolObserved, stderrBytes, stderrDiagnostic,
    resultStatus: final?.status,
    requestedModel: agyModel, requestedEffort: 'high', cliConfiguredModel: init?.model,
    modelEvidence: 'CLI_INIT_CONFIG', remoteModelAttestation: 'UNCONFIRMED', toolCount: init?.tools?.length,
    projectPolicyHash: hash(policyRaw), canaryOperationsDenied: 4,
    fixtureUnchanged: before === await snapshot(cwd),
    settingsUnchanged: hash(settingsRaw) === hash(await readFile(settingsPath)),
    policyUnchanged: hash(policyRaw) === hash(await readFile(policyPath)),
    descendantsRemaining: tracker.alive(), ownershipUncertain: tracker.uncertain,
    packetSha256: hash(JSON.stringify(packet)) };
  if (!observations.fixtureUnchanged || !observations.settingsUnchanged || !observations.policyUnchanged) {
    fail('WORKSPACE_OR_SETTINGS_CHANGED'); retainLock = true;
  }
  if (!sent || !reviewInit(init, cwd) || code !== 0 || final?.status !== 'SUCCESS' ||
      typeof final.response !== 'string' || !final.response.trimStart().startsWith('X001_REVIEW')) {
    fail('REVIEW_RESPONSE_UNCONFIRMED');
  }
  result = final?.response?.slice(0, 6000);
} catch (error) {
  reason ||= error.code === 'EEXIST' ? 'EXISTING_REVIEW_LOCK_INSPECT_BEFORE_RETRY' : error.message;
  if (lock) retainLock = true;
} finally {
  if (lock) { await lock.close(); if (!retainLock) await unlink(lockPath); }
}
await report('agy-project-review', { status: reason ? 'BLOCKED_OR_FAILED' : 'REVIEW_OBSERVED_PROJECT_DENY_ENFORCED',
  reason: reason || null, observations, response: result, lockRetained: retainLock,
  rawTranscriptSavedByRunner: false, enforcementScope: 'PROJECT_PERMISSION_ENGINE_NOT_OS_CONTAINMENT' });
process.exitCode = reason ? 2 : 0;
