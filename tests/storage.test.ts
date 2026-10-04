import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ProjectStore } from '../dist/desktop/electron/storage/project-store.js';

function fixture() {
  mkdirSync('.runtime/storage-tests', { recursive: true });
  const root = mkdtempSync(resolve('.runtime/storage-tests', 'case-'));
  const directory = join(root, 'data');
  const folder = join(root, '한글 프로젝트');
  mkdirSync(folder);
  const store = new ProjectStore(directory);
  return { root, directory, folder, store, path: join(directory, 'projects.sqlite') };
}
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const dbOf = (store: ProjectStore) => (store as unknown as { db: DatabaseSync }).db;

test('first schema/commit failure preserves an incomplete copy and a later launch can initialize', () => {
  mkdirSync('.runtime/storage-tests', { recursive: true });
  for (const failure of ['CREATE TABLE', 'COMMIT']) {
    const directory = mkdtempSync(resolve('.runtime/storage-tests', 'initialize-'));
    const original = DatabaseSync.prototype.exec;
    try {
      DatabaseSync.prototype.exec = function (sql: string) {
        if (sql.startsWith(failure)) throw new Error('injected initial failure');
        return original.call(this, sql);
      };
      assert.throws(() => new ProjectStore(directory), /initial failure/);
    } finally {
      DatabaseSync.prototype.exec = original;
    }
    assert.ok(readdirSync(directory).some((name) => name.endsWith('.initializing')));
    assert.ok(!readdirSync(directory).includes('projects.sqlite'));
    const retry = new ProjectStore(directory);
    assert.equal(retry.catalog().storage, 'sqlite');
    assert.equal(retry.catalog().projects.length, 0);
    retry.close();
  }
});

test('SQLite schema, stable path/ID/name and selection survive reopening; 17+ projects are retained', () => {
  const f = fixture();
  try {
    assert.equal(dbOf(f.store).prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
    assert.equal(dbOf(f.store).prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
    assert.equal(dbOf(f.store).prepare('PRAGMA synchronous').get()?.synchronous, 2);
    const first = f.store.register(f.folder, true);
    assert.equal(f.store.register(join(f.folder, '..', '한글 프로젝트')).id, first.id);
    f.store.activate(first.id, "내 프로젝트 ' SQL도 이름");
    for (let i = 0; i < 18; i++) {
      const path = join(f.root, `folder-${i}`);
      mkdirSync(path);
      f.store.register(path);
    }
    const before = f.store.catalog();
    f.store.close();
    const reopened = new ProjectStore(f.directory);
    assert.deepEqual(reopened.catalog(), before);
    assert.equal(before.projects.length, 19);
    assert.equal(before.activeProjectId, first.id);
    reopened.close();
  } finally {
    f.store.close();
  }
});

test('selection and name rollback together on commit error; register selection rollback removes inserted row', () => {
  const f = fixture();
  try {
    const first = f.store.register(f.folder, true);
    const before = f.store.catalog();
    const db = dbOf(f.store),
      original = db.exec.bind(db);
    db.exec = (sql: string) => {
      if (sql === 'COMMIT') throw new Error('injected commit failure');
      return original(sql);
    };
    assert.throws(() => f.store.activate(first.id, '새 이름'), /injected/);
    const other = join(f.root, 'second');
    mkdirSync(other);
    assert.throws(() => f.store.register(other, true), /injected/);
    assert.deepEqual(f.store.catalog(), before);
    db.exec = original;
    f.store.close();
    const reopened = new ProjectStore(f.directory);
    assert.deepEqual(reopened.catalog(), before);
    reopened.close();
  } finally {
    f.store.close();
  }
});

test('actual competing writer lock fails within a bounded time and normal retry succeeds', () => {
  const f = fixture();
  const other = new DatabaseSync(f.path);
  try {
    const first = f.store.register(f.folder, true),
      before = f.store.catalog();
    other.exec('BEGIN IMMEDIATE');
    const started = Date.now();
    assert.throws(() => f.store.activate(first.id, '잠긴 이름'), /locked/);
    assert.ok(Date.now() - started < 1500);
    assert.deepEqual(f.store.catalog(), before);
    other.exec('ROLLBACK');
    assert.equal(f.store.activate(first.id, '정상 재시도').name, '정상 재시도');
  } finally {
    other.close();
    f.store.close();
  }
});

test('consistent backup restores all project IDs, names and selected relationship with pre-restore copy', () => {
  const f = fixture();
  try {
    f.store.register(f.folder, true);
    const before = f.store.catalog(),
      backup = f.store.backup();
    const second = join(f.root, 'second');
    mkdirSync(second);
    f.store.register(second, true);
    const changed = f.store.catalog();
    assert.deepEqual(f.store.restore(backup.id), before);
    assert.deepEqual(f.store.catalog(), before);
    assert.equal(f.store.backups().length, 2);
    const safety = f.store.backups().find((b) => b.id !== backup.id);
    assert.ok(safety);
    assert.deepEqual(f.store.restore(safety.id), changed);
    f.store.close();
    const reopened = new ProjectStore(f.directory);
    assert.deepEqual(reopened.catalog(), changed);
    reopened.close();
  } finally {
    f.store.close();
  }
});

test('unknown/newer/corrupt existing databases stay byte-identical and are never silently reset', () => {
  for (const type of ['future', 'foreign', 'corrupt', 'empty', 'schema']) {
    const f = fixture();
    f.store.register(f.folder, true);
    f.store.close();
    if (type === 'corrupt') writeFileSync(f.path, Buffer.from('broken sqlite'));
    else if (type === 'empty') writeFileSync(f.path, Buffer.alloc(0));
    else {
      const db = new DatabaseSync(f.path);
      db.exec(
        type === 'future'
          ? 'PRAGMA user_version=99'
          : type === 'foreign'
            ? 'PRAGMA application_id=123'
            : 'CREATE TABLE extra (value TEXT)',
      );
      db.close();
    }
    const before = hash(f.path);
    assert.throws(() => new ProjectStore(f.directory));
    assert.equal(hash(f.path), before);
  }
});

test('invalid backups: bad bytes, version, foreign selection, 101 rows, trigger and oversized file are rejected', () => {
  for (const type of [
    'corrupt',
    'future',
    'relation',
    'count',
    'trigger',
    'oversized',
    'catalog-size',
  ]) {
    const f = fixture();
    try {
      f.store.register(f.folder, true);
      const before = f.store.catalog(),
        backup = f.store.backup();
      const path = join(f.directory, 'backups', `${backup.createdAt}-${backup.id}.sqlite`);
      if (type === 'corrupt') writeFileSync(path, 'invalid');
      else if (type === 'oversized') writeFileSync(path, Buffer.alloc(16 * 1024 * 1024 + 1));
      else {
        const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
        if (type === 'future') db.exec('PRAGMA user_version=99');
        if (type === 'relation')
          db.prepare('UPDATE app_state SET active_project_id = ?').run(randomUUID());
        if (type === 'trigger')
          db.exec(
            "CREATE TRIGGER unexpected AFTER INSERT ON projects BEGIN UPDATE projects SET name = 'changed'; END",
          );
        if (type === 'catalog-size')
          for (let i = 0; i < 90; i++)
            db.prepare('INSERT INTO projects VALUES (?, ?, ?, 0, 0)').run(
              randomUUID(),
              'fake',
              join(f.root, `${i}-${'가'.repeat(3900)}`),
            );
        if (type === 'count')
          for (let i = 0; i < 100; i++)
            db.prepare('INSERT INTO projects VALUES (?, ?, ?, 0, 0)').run(
              randomUUID(),
              'fake',
              join(f.root, `extra-${i}`),
            );
        db.close();
      }
      const currentHash = hash(f.path);
      assert.throws(() => f.store.restore(backup.id));
      assert.deepEqual(f.store.catalog(), before);
      assert.equal(hash(f.path), currentHash);
    } finally {
      f.store.close();
    }
  }
});

test('backup limit or failed safety backup prevents restoration; failed partial is not published', () => {
  const f = fixture();
  try {
    const first = f.store.register(f.folder, true),
      backup = f.store.backup();
    f.store.activate(first.id, '현재 이름');
    const before = f.store.catalog();
    const db = dbOf(f.store),
      original = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql === 'VACUUM INTO ?') throw new Error('injected disk full');
      return original(sql);
    }) as typeof db.prepare;
    assert.throws(() => f.store.restore(backup.id), /disk full/);
    assert.deepEqual(f.store.catalog(), before);
    assert.equal(f.store.backups().length, 1);
    db.prepare = original;
    writeFileSync(
      join(f.directory, 'backups', `${Date.now()}-${randomUUID()}.sqlite.partial`),
      'partial',
    );
    for (let i = 1; i < 20; i++) f.store.backup();
    assert.equal(f.store.backups().length, 20);
    assert.throws(() => f.store.restore(backup.id), /20개/);
    assert.deepEqual(f.store.catalog(), before);
  } finally {
    f.store.close();
  }
});

test('restore import failure rolls back rows and active selection, preserving safety backup', () => {
  const f = fixture();
  try {
    const first = f.store.register(f.folder, true),
      backup = f.store.backup();
    f.store.activate(first.id, '복원 전');
    const before = f.store.catalog(),
      db = dbOf(f.store),
      original = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.startsWith('INSERT INTO projects')) throw new Error('injected import failure');
      return original(sql);
    }) as typeof db.prepare;
    assert.throws(() => f.store.restore(backup.id), /import failure/);
    db.prepare = original;
    assert.deepEqual(f.store.catalog(), before);
    assert.equal(f.store.backups().length, 2);
    f.store.close();
    const reopened = new ProjectStore(f.directory);
    assert.deepEqual(reopened.catalog(), before);
    reopened.close();
  } finally {
    f.store.close();
  }
});

test('missing project directory remains listed but cannot replace the active selection', () => {
  const f = fixture();
  try {
    const first = f.store.register(f.folder, true),
      before = f.store.catalog();
    renameSync(f.folder, join(f.root, 'moved'));
    assert.throws(() => f.store.activate(first.id));
    f.store.close();
    const reopened = new ProjectStore(f.directory);
    assert.deepEqual(reopened.catalog(), before);
    assert.equal(readdirSync(f.directory).includes('projects.sqlite-wal'), false);
    reopened.close();
  } finally {
    f.store.close();
  }
});
