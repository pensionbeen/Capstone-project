import { execFile } from 'node:child_process';
import { join } from 'node:path';

// Adapted from the X-001 identity audit. No command lines or credentials collected.
export interface ProcessIdentity {
  pid: number;
  parent: number;
  created: string;
  name: string;
}
const identity = (row: ProcessIdentity) => `${row.pid}:${row.created}`;
const observers = new Set<string>();
const consoleHost = (row: ProcessIdentity) =>
  ['conhost.exe', 'openconsole.exe'].includes(row.name.toLowerCase());

export function validateProcesses(value: unknown): ProcessIdentity[] {
  if (!Array.isArray(value) || !value.length) throw new Error('PROCESS_SNAPSHOT_INVALID');
  const pids = new Set<number>();
  for (const row of value) {
    if (
      !row ||
      !Number.isSafeInteger(row.pid) ||
      row.pid < 0 ||
      !Number.isSafeInteger(row.parent) ||
      row.parent < 0 ||
      typeof row.created !== 'string' ||
      !Number.isFinite(Date.parse(row.created)) ||
      typeof row.name !== 'string' ||
      pids.has(row.pid)
    )
      throw new Error('PROCESS_SNAPSHOT_INVALID');
    pids.add(row.pid);
  }
  return value;
}

export function excludeObserver(
  rows: ProcessIdentity[],
  pid: number | undefined,
  parentPid: number,
) {
  const observer = rows.find((row) => row.pid === pid && row.parent === parentPid);
  if (!observer) throw new Error('PROCESS_OBSERVER_UNCONFIRMED');
  const live = new Set(rows.map(identity));
  for (const key of observers) if (!live.has(key)) observers.delete(key);
  observers.add(identity(observer));
  let changed: boolean;
  do {
    changed = false;
    for (const row of rows) {
      if (observers.has(identity(row))) continue;
      const parent = rows.find((item) => item.pid === row.parent && observers.has(identity(item)));
      if (parent && Date.parse(row.created) >= Date.parse(parent.created)) {
        observers.add(identity(row));
        changed = true;
      }
    }
  } while (changed);
  return rows.filter((row) => !observers.has(identity(row)));
}

export function processSnapshot(): Promise<ProcessIdentity[]> {
  if (process.platform !== 'win32') return Promise.reject(new Error('WINDOWS_REQUIRED'));
  const script =
    "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " +
    '$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ' +
    '@(Get-CimInstance Win32_Process -Filter "ProcessId > 4" | ForEach-Object { ' +
    '[pscustomobject]@{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; ' +
    'created=$_.CreationDate.ToUniversalTime().ToString("o"); name=$_.Name} }) | ConvertTo-Json -Compress';
  return new Promise((resolve, reject) => {
    const child = execFile(
      join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoLogo',
        '-NoProfile',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, timeout: 4000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error || stderr.trim()) {
          reject(new Error('PROCESS_SNAPSHOT_FAILED'));
          return;
        }
        try {
          resolve(excludeObserver(validateProcesses(JSON.parse(stdout)), child.pid, process.pid));
        } catch {
          reject(new Error('PROCESS_SNAPSHOT_INVALID'));
        }
      },
    );
  });
}

export class ProcessAudit {
  readonly owned = new Map<string, ProcessIdentity>();
  readonly baseline: Set<string>;
  readonly baselineTree: Set<string>;
  readonly supervisorKey: string;
  ownerKey?: string;
  current = new Map<string, ProcessIdentity>();
  uncertain = false;
  constructor(
    rows: ProcessIdentity[],
    readonly ownerPid: number,
    readonly supervisorPid: number,
  ) {
    validateProcesses(rows);
    this.baseline = new Set(rows.map(identity));
    const supervisor = rows.find((row) => row.pid === supervisorPid);
    if (!supervisor) throw new Error('SUPERVISOR_IDENTITY_UNCONFIRMED');
    this.supervisorKey = identity(supervisor);
    this.baselineTree = new Set([this.supervisorKey]);
    let changed: boolean;
    do {
      changed = false;
      for (const row of rows) {
        if (
          !this.baselineTree.has(identity(row)) &&
          rows.some(
            (parent) => parent.pid === row.parent && this.baselineTree.has(identity(parent)),
          )
        ) {
          this.baselineTree.add(identity(row));
          changed = true;
        }
      }
    } while (changed);
  }
  observe(rows: ProcessIdentity[]) {
    this.current = new Map(validateProcesses(rows).map((row) => [identity(row), row]));
    if (!this.current.has(this.supervisorKey)) throw new Error('SUPERVISOR_IDENTITY_UNCONFIRMED');
    if (!this.ownerKey) {
      const owner = rows.find((row) => row.pid === this.ownerPid);
      if (!owner || owner.parent !== this.supervisorPid || this.baseline.has(identity(owner)))
        throw new Error('HOST_IDENTITY_UNCONFIRMED');
      this.ownerKey = identity(owner);
      this.owned.set(this.ownerKey, owner);
    }
    let changed: boolean;
    do {
      changed = false;
      for (const row of rows) {
        if (this.owned.has(identity(row)) || this.baseline.has(identity(row))) continue;
        const parent = rows.find(
          (candidate) => candidate.pid === row.parent && this.owned.has(identity(candidate)),
        );
        if (parent && Date.parse(row.created) >= Date.parse(parent.created)) {
          this.owned.set(identity(row), row);
          changed = true;
        }
      }
    } while (changed);
    for (const row of rows) {
      if (this.baseline.has(identity(row)) || this.owned.has(identity(row))) continue;
      if (consoleHost(row) && this.hasExternalAncestor(row, rows)) continue;
      if (consoleHost(row) || [...this.owned.values()].some((parent) => parent.pid === row.parent))
        this.uncertain = true;
    }
  }
  private hasExternalAncestor(row: ProcessIdentity, rows: ProcessIdentity[]) {
    const visited = new Set<string>();
    let current = row;
    while (!visited.has(identity(current))) {
      visited.add(identity(current));
      const parent = rows.find((candidate) => candidate.pid === current.parent);
      if (
        !parent ||
        Date.parse(parent.created) > Date.parse(current.created) ||
        parent.pid === this.supervisorPid ||
        this.owned.has(identity(parent))
      )
        return false;
      if (this.baseline.has(identity(parent))) return !this.baselineTree.has(identity(parent));
      current = parent;
    }
    return false;
  }
  alive() {
    return [...this.owned].filter(([key]) => this.current.has(key)).map(([, row]) => row);
  }
  observed(pid: number) {
    return [...this.owned.values()].some((row) => row.pid === pid);
  }
}
