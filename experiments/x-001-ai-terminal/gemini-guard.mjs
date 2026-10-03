import os from 'node:os';
import path from 'node:path';
import { readFile, readdir, access } from 'node:fs/promises';

const SAFE_USER_LEAVES = new Set([
  'security.auth.selectedType', 'general.previewFeatures', 'model.name',
  'ui.theme', 'ui.hideTips', 'ui.hideBanner', 'ui.showMemoryUsage',
  'ui.useFullWidth', 'privacy.usageStatisticsEnabled',
]);
export function checkUserSettings(settings, prefix = '') {
  if (!settings || Array.isArray(settings) || typeof settings !== 'object') return false;
  return Object.entries(settings).every(([key, value]) => {
    const leaf = prefix ? prefix + '.' + key : key;
    if (value && !Array.isArray(value) && typeof value === 'object') {
      if (![...SAFE_USER_LEAVES].some((allowed) => allowed.startsWith(leaf + '.'))) return false;
      return checkUserSettings(value, leaf);
    }
    return SAFE_USER_LEAVES.has(leaf) &&
      (leaf !== 'security.auth.selectedType' || value === 'oauth-personal');
  });
}
async function optionalJson(file) {
  try { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, '')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    // JSONC/unknown settings are not guessed; no raw settings in diagnostics.
    throw new Error('SETTINGS_UNREADABLE_OR_REQUIRE_REVIEW');
  }
}
async function mustHaveNoPolicies(folder) {
  try {
    const entries = await readdir(folder);
    if (entries.some((name) => name.toLowerCase().endsWith('.toml'))) throw new Error('EXISTING_POLICIES_REQUIRE_REVIEW');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export async function guardGemini(cwd) {
  // No auth files, OAuth credentials, or token values are opened.
  if (!checkGeminiEnv(process.env)) throw new Error('NONDEFAULT_GEMINI_ENV_REQUIRES_REVIEW');
  const geminiHome = path.join(os.homedir(), '.gemini');
  // Matches the reviewed 0.62.0 Windows loader, not a mutable ProgramData override.
  const system = 'C:\\ProgramData\\gemini-cli';
  const user = await optionalJson(path.join(geminiHome, 'settings.json'));
  if (!checkUserSettings(user)) throw new Error('USER_SETTINGS_REQUIRE_REVIEW');
  if (user.security?.auth?.selectedType !== 'oauth-personal')
    throw new Error('GEMINI_LOGIN_METHOD_UNCONFIRMED_NO_API_FALLBACK');
  for (const name of ['settings.json', 'system-defaults.json']) {
    if (Object.keys(await optionalJson(path.join(system, name))).length)
      throw new Error('SYSTEM_SETTINGS_REQUIRE_REVIEW');
  }
  await mustHaveNoPolicies(path.join(system, 'policies'));
  await mustHaveNoPolicies(path.join(geminiHome, 'policies'));
  // .env can change CLI behavior. Detect existence only, never read its secrets.
  let directory = cwd;
  const inspected = new Set();
  while (!inspected.has(directory)) {
    inspected.add(directory);
    for (const name of ['.env', path.join('.gemini', '.env')]) {
      try { await access(path.join(directory, name)); throw new Error('ENV_FILE_REQUIRES_REVIEW'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { settingsGate: 'PASSED_KNOWN_MINIMAL_SETTINGS',
    authFileRead: false, globalSettingsChanged: false,
    isolation: 'CLI restrictions; not OS file protection' };
}
export function checkGeminiEnv(env) {
  return !Object.keys(env).some((name) => {
    const key = name.toUpperCase();
    return env[name] && ((key.startsWith('GEMINI_') && key !== 'GEMINI_CMD') ||
      ['GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS'].includes(key));
  });
}
export const geminiProjectSettings = {
  general: { enableAutoUpdate: false, defaultApprovalMode: 'default',
    plan: { enabled: false, modelRouting: false } },
  tools: { core: [], discoveryCommand: '', callCommand: '' },
  hooksConfig: { enabled: false },
  skills: { enabled: false },
  ide: { enabled: false },
  context: { fileName: 'X001_CONTEXT.md', includeDirectoryTree: false, includeDirectories: [] },
  telemetry: { enabled: false },
  model: { maxSessionTurns: 2 },
};
