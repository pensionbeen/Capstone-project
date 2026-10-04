import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, isAbsolute, join, normalize, parse } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  emptyFeaturePlan,
  type ProjectFeaturePlan,
  validateFeaturePlan,
} from '../../shared/feature-plan.js';
import type { ProjectBackup, ProjectCatalog, SavedProject } from '../../shared/storage.js';
import { UUID } from '../ai/contracts.js';
import {
  FEATURE_TABLES,
  readAllFeaturePlans,
  readFeaturePlan,
  writeFeaturePlan,
} from './feature-plan-store.js';

const APP_ID = 0x4f524254;
const VERSION = 2;
const PREVIOUS_VERSION = 1;
const MAX_PROJECTS = 100;
const MAX_BACKUPS = 20;
const MAX_DB_BYTES = 16 * 1024 * 1024;
const TABLES = {
  projects: `CREATE TABLE projects (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 36),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
    path TEXT NOT NULL UNIQUE CHECK(length(path) BETWEEN 1 AND 4096),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
  ) STRICT`,
  app_state: `CREATE TABLE app_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    active_project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT
  ) STRICT`,
};
const sqlShape = (sql: string) => sql.replace(/\s+/g, ' ').trim();
export class StorageError extends Error {}

export function validProjectName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 80 &&
    [...value].every((character) => character.charCodeAt(0) >= 32)
  );
}
function validPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 4096 &&
    isAbsolute(value) &&
    [...value].every((character) => character.charCodeAt(0) >= 32)
  );
}
function openDatabase(path: string, readOnly: boolean) {
  const db = new DatabaseSync(path, {
    readOnly,
    timeout: 250,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=250');
  return db;
}
function checkFile(path: string) {
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_DB_BYTES)
    throw new StorageError('저장 파일의 형식이나 크기를 확인할 수 없어요. 원본을 보존했어요.');
}
function readSnapshot(db: DatabaseSync) {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (
    db.prepare('PRAGMA application_id').get()?.application_id !== APP_ID ||
    (version !== VERSION && version !== PREVIOUS_VERSION)
  )
    throw new StorageError('지원하는 ORBIT 저장 버전이 아니에요. 원본을 보존했어요.');
  const schema = db
    .prepare(
      "SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  const expectedTables = version === VERSION ? { ...TABLES, ...FEATURE_TABLES } : TABLES;
  if (
    schema.length !== Object.keys(expectedTables).length ||
    schema.some(
      (row) =>
        row.type !== 'table' ||
        !(String(row.name) in expectedTables) ||
        sqlShape(String(row.sql)) !==
          sqlShape(expectedTables[row.name as keyof typeof expectedTables]),
    )
  )
    throw new StorageError('저장 구조가 예상과 달라 열지 않았어요. 원본을 보존했어요.');
  const check = db.prepare('PRAGMA quick_check').all();
  if (
    check.length !== 1 ||
    check[0]?.quick_check !== 'ok' ||
    db.prepare('PRAGMA foreign_key_check').all().length
  )
    throw new StorageError('저장 파일 검사를 통과하지 못했어요. 원본을 보존했어요.');
  const rows = db
    .prepare(
      'SELECT id, name, path, created_at AS createdAt, updated_at AS updatedAt FROM projects ORDER BY updated_at DESC, id LIMIT 101',
    )
    .all();
  if (
    rows.length > MAX_PROJECTS ||
    rows.some(
      (p) =>
        !UUID.test(String(p.id)) ||
        !validProjectName(p.name) ||
        !validPath(p.path) ||
        !Number.isSafeInteger(p.createdAt) ||
        !Number.isSafeInteger(p.updatedAt) ||
        Number(p.createdAt) < 0 ||
        Number(p.updatedAt) < Number(p.createdAt),
    )
  )
    throw new StorageError('저장된 프로젝트 정보가 올바르지 않아요. 원본을 보존했어요.');
  const states = db.prepare('SELECT id, active_project_id AS activeProjectId FROM app_state').all();
  const state = states[0];
  if (
    states.length !== 1 ||
    !state ||
    state.id !== 1 ||
    !(state.activeProjectId === null || rows.some((p) => p.id === state.activeProjectId))
  )
    throw new StorageError('마지막 프로젝트의 연결 정보가 올바르지 않아요. 원본을 보존했어요.');
  const projectIds = rows.map((p) => String(p.id));
  const featurePlans =
    version === VERSION
      ? readAllFeaturePlans(db, projectIds)
      : Object.fromEntries(projectIds.map((id) => [id, emptyFeaturePlan()]));
  const snapshot = {
    projects: rows.map((row) => ({ ...row })) as unknown as SavedProject[],
    activeProjectId: state.activeProjectId as string | null,
    featurePlans,
  };
  if (
    Buffer.byteLength(
      JSON.stringify({ projects: snapshot.projects, activeProjectId: snapshot.activeProjectId }),
    ) >
    512 * 1024
  )
    throw new StorageError('프로젝트 목록의 전체 크기 한도를 넘었어요. 이전 목록은 유지돼요.');
  if (Buffer.byteLength(JSON.stringify(snapshot.featurePlans)) > 2 * 1024 * 1024)
    throw new StorageError('기능과 검증 기록의 크기 한도를 넘었어요. 원본은 보존했어요.');
  return snapshot;
}

/** Only the main process owns this store. No SQL, path, or backup filename comes from IPC. */
export class ProjectStore {
  private db: DatabaseSync;
  private readonly backupDirectory: string;
  private closed = false;
  private snapshot!: ReturnType<typeof readSnapshot>;

  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    const folder = lstatSync(directory);
    if (!folder.isDirectory() || folder.isSymbolicLink())
      throw new StorageError('저장 폴더를 확인할 수 없어요.');
    this.backupDirectory = join(directory, 'backups');
    const path = join(directory, 'projects.sqlite');
    const existed = existsSync(path);
    if (existed) {
      checkFile(path);
      const existing = openDatabase(path, true);
      try {
        readSnapshot(existing);
      } finally {
        existing.close();
      }
    }
    const initialPath = existed ? path : `${path}.${randomUUID()}.initializing`;
    this.db = openDatabase(initialPath, false);
    try {
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
      if (existed || version !== 0) readSnapshot(this.db);
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL');
      if (version === 0) {
        // Only a newly created file can reach this path; existing unknown/v0 files stay untouched.
        this.transaction(() => {
          for (const sql of Object.values({ ...TABLES, ...FEATURE_TABLES })) this.db.exec(sql);
          this.db.exec(
            `INSERT INTO app_state(id, active_project_id) VALUES (1, NULL); PRAGMA application_id=${APP_ID}; PRAGMA user_version=${VERSION}`,
          );
        });
      } else if (version === PREVIOUS_VERSION) {
        // Preserve a verified v1 copy before changing the live schema. DDL and version bump roll back together.
        this.backup();
        this.transaction(() => {
          for (const sql of Object.values(FEATURE_TABLES)) this.db.exec(sql);
          this.db.exec(`PRAGMA user_version=${VERSION}`);
        });
      }
      this.snapshot = readSnapshot(this.db);
      if (!existed) {
        this.db.close();
        const file = openSync(initialPath, 'r+');
        try {
          fsyncSync(file);
        } finally {
          closeSync(file);
        }
        linkSync(initialPath, path);
        this.db = openDatabase(path, false);
        this.db.exec('PRAGMA synchronous=FULL');
        try {
          unlinkSync(initialPath);
        } catch {
          /* Retain the completed initial copy. */
        }
      }
    } catch (error) {
      if (this.db.isOpen) this.db.close();
      throw error;
    }
  }

  private transaction<T>(operation: () => T): T {
    if (this.closed) throw new StorageError('저장 연결이 닫혔어요. 앱을 다시 실행해 주세요.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      const snapshot = readSnapshot(this.db);
      this.db.exec('COMMIT');
      this.snapshot = snapshot;
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        this.close();
      }
      throw error;
    }
  }
  featurePlan(projectId: string): ProjectFeaturePlan {
    if (!UUID.test(projectId)) throw new StorageError('프로젝트를 다시 선택해 주세요.');
    this.project(projectId);
    return readFeaturePlan(this.db, projectId);
  }
  private schemaVersion() {
    return Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
  }
  saveFeaturePlan(projectId: string, plan: ProjectFeaturePlan) {
    if (!UUID.test(projectId) || !validateFeaturePlan(plan))
      throw new StorageError('기능·선행 관계·완료 조건·검증 기록을 확인해 주세요.');
    return this.transaction(() => {
      const project = this.project(projectId);
      writeFeaturePlan(this.db, projectId, plan);
      this.db
        .prepare('UPDATE projects SET updated_at = ? WHERE id = ?')
        .run(Math.max(Date.now(), project.updatedAt), projectId);
      return this.featurePlan(projectId);
    });
  }
  catalog(): ProjectCatalog {
    return {
      projects: this.snapshot.projects.map((p) => ({ ...p })),
      activeProjectId: this.snapshot.activeProjectId,
      storage: 'sqlite',
    };
  }
  register(path: string, activate = false) {
    const canonical = normalize(realpathSync.native(path));
    if (!validPath(canonical) || !statSync(canonical).isDirectory())
      throw new StorageError('프로젝트 폴더를 확인할 수 없어요.');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(canonical);
      if (existing) {
        if (activate)
          this.db
            .prepare('UPDATE app_state SET active_project_id = ? WHERE id = 1')
            .run(String(existing.id));
        return this.project(String(existing.id));
      }
      if (
        Number(this.db.prepare('SELECT count(*) AS count FROM projects').get()?.count) >=
        MAX_PROJECTS
      )
        throw new StorageError(
          '저장 가능한 프로젝트 100개를 모두 사용했어요. 기존 목록은 유지했어요.',
        );
      const id = randomUUID(),
        now = Date.now();
      const name = (basename(canonical) || parse(canonical).root).slice(0, 80);
      if (!validProjectName(name)) throw new StorageError('프로젝트 폴더 이름을 확인해 주세요.');
      this.db
        .prepare(
          'INSERT INTO projects(id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, name, canonical, now, now);
      if (activate)
        this.db.prepare('UPDATE app_state SET active_project_id = ? WHERE id = 1').run(id);
      return this.project(id);
    });
  }
  project(id: string): SavedProject {
    const row = this.db
      .prepare(
        'SELECT id, name, path, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id = ?',
      )
      .get(id);
    if (!row) throw new StorageError('저장된 프로젝트를 찾지 못했어요.');
    return row as unknown as SavedProject;
  }
  activate(id: string, name?: string) {
    if (!UUID.test(id) || (name !== undefined && !validProjectName(name)))
      throw new StorageError('프로젝트 이름과 선택을 확인해 주세요.');
    const existing = this.project(id);
    if (
      normalize(realpathSync.native(existing.path)) !== existing.path ||
      !statSync(existing.path).isDirectory()
    )
      throw new StorageError('프로젝트 폴더가 없거나 바뀌었어요. 폴더를 다시 선택해 주세요.');
    return this.transaction(() => {
      this.db
        .prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
        .run(name?.trim() ?? existing.name, Math.max(Date.now(), existing.updatedAt), id);
      this.db.prepare('UPDATE app_state SET active_project_id = ? WHERE id = 1').run(id);
      return this.project(id);
    });
  }
  backups(): ProjectBackup[] {
    if (!existsSync(this.backupDirectory)) return [];
    const folder = lstatSync(this.backupDirectory);
    if (!folder.isDirectory() || folder.isSymbolicLink())
      throw new StorageError('백업 폴더를 확인할 수 없어요.');
    return readdirSync(this.backupDirectory)
      .filter((name) => /^\d{13}-[0-9a-f-]{36}\.sqlite$/.test(name))
      .map((name) => ({ id: name.slice(14, -7), createdAt: Number(name.slice(0, 13)) }))
      .filter((b) => UUID.test(b.id))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  backup() {
    const backups = this.backups();
    if (backups.length >= MAX_BACKUPS)
      throw new StorageError(
        '백업 20개를 보관 중이에요. 백업 폴더에서 사본을 따로 보관한 뒤 다시 시도해 주세요.',
      );
    mkdirSync(this.backupDirectory, { recursive: true });
    const id = randomUUID(),
      createdAt = Date.now();
    const destination = join(this.backupDirectory, `${createdAt}-${id}.sqlite`);
    const partial = `${destination}.partial`;
    readSnapshot(this.db);
    // SQLite produces a consistent new database; no live-file copying or overwrite.
    this.db.prepare('VACUUM INTO ?').run(partial);
    checkFile(partial);
    const copy = openDatabase(partial, true);
    try {
      readSnapshot(copy);
    } finally {
      copy.close();
    }
    const file = openSync(partial, 'r+');
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    // Hard-link publication refuses an existing name; a failed partial is never listed.
    linkSync(partial, destination);
    try {
      unlinkSync(partial);
    } catch {
      /* A verified duplicate partial is safe to retain. */
    }
    return { id, createdAt };
  }
  restore(id: string) {
    if (!UUID.test(id)) throw new StorageError('백업을 다시 선택해 주세요.');
    const entry = this.backups().find((item) => item.id === id);
    if (!entry) throw new StorageError('백업을 찾지 못했어요.');
    const path = join(this.backupDirectory, `${entry.createdAt}-${id}.sqlite`);
    checkFile(path);
    const source = openDatabase(path, true);
    let snapshot: ReturnType<typeof readSnapshot>;
    try {
      source.exec('BEGIN');
      snapshot = readSnapshot(source);
      source.exec('COMMIT');
    } finally {
      source.close();
    }
    // Fully validated rows are in memory; never reopen a source after validating it.
    this.backup();
    this.transaction(() => {
      this.db.exec(
        'UPDATE app_state SET active_project_id = NULL WHERE id = 1; DELETE FROM projects',
      );
      const insert = this.db.prepare(
        'INSERT INTO projects(id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      );
      for (const p of snapshot.projects) insert.run(p.id, p.name, p.path, p.createdAt, p.updatedAt);
      for (const p of snapshot.projects) {
        const plan = snapshot.featurePlans[p.id] ?? emptyFeaturePlan();
        if (this.schemaVersion() === VERSION) writeFeaturePlan(this.db, p.id, plan);
      }
      this.db
        .prepare('UPDATE app_state SET active_project_id = ? WHERE id = 1')
        .run(snapshot.activeProjectId);
    });
    return {
      projects: snapshot.projects,
      activeProjectId: snapshot.activeProjectId,
      storage: 'sqlite' as const,
    };
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}

export function storageMessage(error: unknown) {
  return error instanceof StorageError
    ? error.message
    : '저장 작업을 마치지 못했어요. 이전 저장 내용은 유지돼요. 저장 공간과 접근 권한을 확인해 주세요.';
}
