import { execFile } from 'node:child_process';
import path from 'node:path';

const observedQueryProcesses = new Set();
const queryHistoryLimit = 128;
const queryResults = new Set(['SUCCESS', 'CIM_SNAPSHOT_FAILED', 'CIM_SNAPSHOT_INVALID']);

// Diagnostic data only. Neither exclusions nor ownership checks read this history.
export class SnapshotQueryHistory {
  #total = 0;
  #queries = [];

  begin() {
    const sequence = ++this.#total;
    this.#queries.push({ sequence, queryPid: null, query: null,
      startedAt: new Date().toISOString(), completedAt: null, result: 'PENDING' });
    if (this.#queries.length > queryHistoryLimit) this.#queries.shift();
    return sequence;
  }

  complete(sequence, pid, supervisorPid, rows, result) {
    const entry = this.#queries.find(query => query.sequence === sequence);
    if (!entry || entry.result !== 'PENDING') return;
    entry.completedAt = new Date().toISOString();
    entry.queryPid = Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    entry.result = queryResults.has(result) ? result : 'DIAGNOSTIC_INVALID';
    if (entry.result !== 'SUCCESS' || entry.queryPid === null) return;
    try {
      validateSnapshot(rows);
      const query = rows.find(row => row.pid === pid && row.parent === supervisorPid);
      if (query && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,7}Z$/u.test(query.created) &&
          query.name.toLowerCase() === 'powershell.exe') {
        const { parent, created, name } = query;
        entry.query = { pid, parent, created, name };
      }
    } catch { /* A missing diagnostic identity never changes the snapshot result. */ }
  }

  report() {
    return { available: true, limit: queryHistoryLimit, total: this.#total,
      truncated: this.#total > this.#queries.length,
      queries: this.#queries.map(entry => ({ ...entry, query: entry.query ? { ...entry.query } : null })) };
  }
}

const queryHistory = new SnapshotQueryHistory();

export function snapshotQueryEvidence() {
  try { return queryHistory.report(); }
  catch { return { available: false, limit: queryHistoryLimit, total: null, truncated: true, queries: [] }; }
}

// No command lines, paths, credentials, or process-name termination are collected.
export function processSnapshot({ timeoutMs = 2000 } = {}) {
  if (process.platform !== 'win32') return Promise.reject(new Error('WINDOWS_REQUIRED'));
  const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " +
    '$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ' +
    '@(Get-CimInstance Win32_Process -Filter "ProcessId > 4" | ForEach-Object { ' +
    '[pscustomobject]@{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; ' +
    'created=$_.CreationDate.ToUniversalTime().ToString("o"); name=$_.Name} }) | ConvertTo-Json -Compress';
  let sequence;
  try { sequence = queryHistory.begin(); } catch { /* Diagnostics cannot block a query. */ }
  return new Promise((resolve, reject) => {
    let query;
    const record = (result, rows) => {
      try { queryHistory.complete(sequence, query?.pid, process.pid, rows, result); }
      catch { /* Diagnostics cannot change exclusion, ownership, or cleanup decisions. */ }
    };
    try {
      query = execFile(path.join(process.env.SystemRoot || 'C:\\Windows',
        'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error || stderr.trim()) {
          record('CIM_SNAPSHOT_FAILED'); reject(new Error('CIM_SNAPSHOT_FAILED')); return;
        }
        let rows, filtered;
        try {
          rows = JSON.parse(stdout);
          filtered = excludeSnapshotObserver(rows, query.pid, process.pid, observedQueryProcesses);
        } catch {
          record('CIM_SNAPSHOT_INVALID'); reject(new Error('CIM_SNAPSHOT_INVALID')); return;
        }
        record('SUCCESS', rows);
        resolve(filtered);
      });
    } catch (error) { record('CIM_SNAPSHOT_FAILED'); reject(error); }
  });
}

// Each CIM query creates its own hidden console. Exclude only identities tied
// to our exact execFile child, never all PowerShell or console processes.
export function excludeSnapshotObserver(rows, queryPid, supervisorPid, known = new Set()) {
  validateSnapshot(rows);
  const observer = rows.find((row) => row.pid === queryPid && row.parent === supervisorPid);
  if (!observer) throw new Error('CIM_QUERY_IDENTITY_UNCONFIRMED');
  const currentKeys = new Set(rows.map(identity));
  for (const key of known) if (!currentKeys.has(key)) known.delete(key);
  known.add(identity(observer));
  let changed;
  do {
    changed = false;
    for (const row of rows) {
      if (known.has(identity(row))) continue;
      const parent = rows.find((candidate) => candidate.pid === row.parent && known.has(identity(candidate)));
      if (parent && Date.parse(row.created) >= Date.parse(parent.created)) {
        known.add(identity(row)); changed = true;
      }
    }
  } while (changed);
  return rows.filter((row) => !known.has(identity(row)));
}

export function validateSnapshot(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('CIM_SNAPSHOT_INVALID');
  const pids = new Set();
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.pid) || row.pid < 0 ||
        !Number.isSafeInteger(row.parent) || row.parent < 0 ||
        typeof row.created !== 'string' || !Number.isFinite(Date.parse(row.created)) ||
        typeof row.name !== 'string' || pids.has(row.pid)) throw new Error('CIM_SNAPSHOT_INVALID');
    pids.add(row.pid);
  }
  return rows;
}

const identity = (row) => row.pid + ':' + row.created;

// Snapshot evidence is finite observation, not an OS-level containment guarantee.
export class SessionProcesses {
  constructor(baseline, ownerPid, supervisorPid) {
    validateSnapshot(baseline);
    this.baseline = new Set(baseline.map(identity));
    this.ownerPid = ownerPid;
    this.supervisorPid = supervisorPid;
    const supervisor = baseline.find((row) => row.pid === supervisorPid);
    if (!supervisor) throw new Error('CIM_SUPERVISOR_IDENTITY_UNCONFIRMED');
    this.supervisorKey = identity(supervisor);
    this.supervisorBaselineTree = new Set([this.supervisorKey]);
    let grew;
    do {
      grew = false;
      for (const row of baseline) {
        if (this.supervisorBaselineTree.has(identity(row))) continue;
        if (baseline.some((parent) => parent.pid === row.parent && this.supervisorBaselineTree.has(identity(parent)))) {
          this.supervisorBaselineTree.add(identity(row)); grew = true;
        }
      }
    } while (grew);
    this.owned = new Map();
    this.uncertain = false;
    this.uncertainProcesses = new Map();
    this.externalConsoles = new Set();
    this.ownerKey = undefined;
  }

  observe(rows) {
    validateSnapshot(rows);
    const current = new Map(rows.map((row) => [identity(row), row]));
    if (!current.has(this.supervisorKey)) throw new Error('CIM_SUPERVISOR_IDENTITY_UNCONFIRMED');
    if (!this.ownerKey) {
      const owner = rows.find((row) => row.pid === this.ownerPid);
      if (!owner || owner.parent !== this.supervisorPid || this.baseline.has(identity(owner))) {
        throw new Error('OWNER_IDENTITY_UNCONFIRMED');
      }
      this.ownerKey = identity(owner);
      this.owned.set(this.ownerKey, owner);
    }
    let changed;
    do {
      changed = false;
      for (const row of rows) {
        if (this.owned.has(identity(row)) || this.baseline.has(identity(row))) continue;
        const parent = rows.find((candidate) => candidate.pid === row.parent &&
          this.owned.has(identity(candidate)));
        if (parent && Date.parse(row.created) >= Date.parse(parent.created)) {
          this.owned.set(identity(row), row);
          changed = true;
        }
      }
    } while (changed);
    for (const row of rows) {
      if (this.baseline.has(identity(row)) || this.owned.has(identity(row))) continue;
      // A new console host cannot be silently assigned to this session by timing alone.
      const consoleHost = ['conhost.exe', 'openconsole.exe'].includes(row.name.toLowerCase());
      // Retain proven external identities after their parents exit. Owned
      // propagation above still takes priority, and uncertainty stays sticky.
      if (consoleHost && (this.externalConsoles.has(identity(row)) || this.hasExternalAncestor(row, rows))) {
        this.externalConsoles.add(identity(row));
        continue;
      }
      if (this.hasReusedExternalParent(row, rows)) continue;
      if (consoleHost ||
          [...this.owned.values()].some((parent) => parent.pid === row.parent)) {
        this.uncertain = true;
        if (this.uncertainProcesses.size < 16) this.uncertainProcesses.set(identity(row), {
          ...row, observedParent: rows.find((parent) => parent.pid === row.parent) ?? null,
        });
      }
    }
    this.current = current;
    return this;
  }

  hasReusedExternalParent(row, rows) {
    const previous = [...this.owned.values()].filter((parent) => parent.pid === row.parent);
    if (!previous.length) return false;
    const parent = rows.find((candidate) => candidate.pid === row.parent);
    // Exclude only proven PID reuse under an exact external baseline ancestor.
    // Missing parents or contradictory creation times still block cleanup.
    return Boolean(parent && !this.owned.has(identity(parent)) &&
      previous.every((old) => Date.parse(parent.created) > Date.parse(old.created)) &&
      this.hasExternalAncestor(row, rows));
  }

  // Concurrent IDE/git consoles are unrelated only when their live ancestry
  // reaches an exact baseline identity outside our supervisor/session tree.
  hasExternalAncestor(row, rows) {
    const visited = new Set();
    let current = row;
    while (!visited.has(identity(current))) {
      visited.add(identity(current));
      const parent = rows.find((candidate) => candidate.pid === current.parent);
      if (!parent || Date.parse(parent.created) > Date.parse(current.created) ||
          parent.pid === this.supervisorPid || this.owned.has(identity(parent))) return false;
      if (this.baseline.has(identity(parent))) return !this.supervisorBaselineTree.has(identity(parent));
      current = parent;
    }
    return false;
  }

  hasFixture(pid) {
    return [...this.owned.entries()].some(([key, row]) => key !== this.ownerKey &&
      this.current?.has(key) && row.pid === pid);
  }

  alive({ includeOwner = true } = {}) {
    return [...this.owned.entries()].filter(([key]) => (includeOwner || key !== this.ownerKey) &&
      this.current?.has(key)).map(([, row]) => row.pid);
  }

  relatedPids() { return [...new Set([...this.owned.values()].map((row) => row.pid))]; }
  conhostPids() { return [...this.owned.values()].filter((row) =>
    ['conhost.exe', 'openconsole.exe'].includes(row.name.toLowerCase())).map((row) => row.pid); }
}
