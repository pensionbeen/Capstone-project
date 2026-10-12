import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

// Opt-in regression measurement. A separate Edge profile uses synthetic data only.
// No existing browser, process, settings, driver, or service is changed or terminated.
const args = process.argv.slice(2);
const live = args[0] === '--live';
if (live) args.shift();
if (!args.length) throw new Error('Pass Playwright test paths and filters explicitly.');
const settings = [join(homedir(), '.codex/config.toml'), join(homedir(), '.gemini/settings.json')];
async function hashes() {
  return Promise.all(
    settings.map(async (file) => {
      try {
        return createHash('sha256')
          .update(await readFile(file))
          .digest('hex');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    }),
  );
}
const report = {
  startedAt: new Date().toISOString(),
  live,
  args,
  beforeSettings: await hashes(),
  samples: [],
  errors: [],
};
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  response.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/echo') response.end(url.searchParams.get('text') || '');
  else {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(
      '<label>시험 입력<input aria-label="시험 입력"></label><button>통신 확인</button><output></output><script>document.querySelector("button").onclick=async()=>{document.querySelector("output").textContent=await(await fetch("/echo?text="+encodeURIComponent(document.querySelector("input").value))).text();};</script>',
    );
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const browserPage = await browser.newPage();
const cdp = await browser.newBrowserCDPSession();
await browserPage.goto(`http://127.0.0.1:${server.address().port}`);
const ps = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const baselineTime = report.startedAt;
async function resourceSample() {
  const script =
    "$ErrorActionPreference='Stop'; @(Get-Process | Where-Object { $_.ProcessName -in @('msedge','electron','powershell','explorer','blender') } | ForEach-Object { [pscustomobject]@{ name=$_.ProcessName; pid=$_.Id; created=$_.StartTime.ToUniversalTime().ToString('o'); cpuSeconds=$_.CPU; workingSet=$_.WorkingSet64; responding=$_.Responding } }) | ConvertTo-Json -Compress";
  const result = await promisify(execFile)(
    ps,
    ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15000 },
  );
  return JSON.parse(result.stdout);
}
async function sample(phase, resources = false) {
  const start = performance.now();
  const marker = `한글 통신 ${randomUUID()}`;
  await browserPage.getByRole('textbox').fill(marker, { timeout: 8000 });
  await browserPage.getByRole('button').click({ timeout: 8000 });
  await browserPage.waitForFunction(
    (value) => document.querySelector('output').textContent === value,
    marker,
    { timeout: 8000 },
  );
  report.samples.push({
    phase,
    at: new Date().toISOString(),
    browserActionMs: performance.now() - start,
    browserProcesses: (await cdp.send('SystemInfo.getProcessInfo')).processInfo,
    resources: resources ? await resourceSample() : undefined,
  });
}
let exitCode = 1;
try {
  await sample('before', true);
  const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...args], {
    windowsHide: true,
    stdio: 'inherit',
    env: { ...process.env, ORBIT_LIVE_AI: live ? '1' : '0' },
  });
  let done = false;
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      done = true;
      resolve(code ?? 1);
    });
  });
  let count = 0;
  while (!done) {
    try {
      await sample('during', ++count % 4 === 0);
    } catch (error) {
      report.errors.push({ at: new Date().toISOString(), message: error.message });
    }
    if (!done) await Promise.race([delay(2000), completion]);
  }
  exitCode = await completion;
  await sample('after', true);
  report.afterSettings = await hashes();
  assert.deepEqual(report.afterSettings, report.beforeSettings, 'Global settings changed');
  const eventScript = `$events=@(Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=[datetime]'${baselineTime}'; Id=41,1001,18,19} -ErrorAction SilentlyContinue); @($events | Select-Object Id,ProviderName,TimeCreated) | ConvertTo-Json -Compress`;
  const events = await promisify(execFile)(
    ps,
    ['-NoProfile', '-EncodedCommand', Buffer.from(eventScript, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15000 },
  );
  report.systemEvents = events.stdout.trim() ? JSON.parse(events.stdout) : [];
  assert.equal(report.errors.length, 0, 'Independent browser interaction failed');
} catch (error) {
  exitCode = 1;
  report.errors.push({ at: new Date().toISOString(), message: error.message });
} finally {
  report.finishedAt = new Date().toISOString();
  report.exitCode = exitCode;
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await mkdir(resolve('.runtime/impact'), { recursive: true });
  const file = resolve('.runtime/impact', `${Date.now()}-${live ? 'live' : 'synthetic'}.json`);
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      evidence: file,
      exitCode,
      browserChecks: report.samples.length,
      errors: report.errors.length,
    }),
  );
}
process.exitCode = exitCode;
