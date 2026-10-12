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
import { writeFeaturePlan } from '../dist/desktop/electron/storage/feature-plan-store.js';
import { ProjectStore } from '../dist/desktop/electron/storage/project-store.js';
import {
  emptyFeaturePlan,
  type ProjectFeaturePlan,
  validateFeaturePlan,
} from '../dist/desktop/shared/feature-plan.js';
import {
  compareVerifications,
  featureState,
  nextVerificationTime,
  progress,
} from '../dist/desktop/shared/verification.js';

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

test('direct helper writes without a transaction preserve existing feature data', () => {
  const f = fixture();
  try {
    const project = f.store.register(f.folder, true);
    const before = f.store.saveFeaturePlan(project.id, samplePlan());
    const childFirst = { ...before, features: [...before.features].reverse() };
    assert.throws(() => writeFeaturePlan(dbOf(f.store), project.id, childFirst));
    assert.deepEqual(f.store.featurePlan(project.id), before);
    // The normal transaction also supports a child appearing before its parent.
    assert.deepEqual(f.store.saveFeaturePlan(project.id, childFirst), before);
  } finally {
    f.store.close();
  }
});

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

function samplePlan(): ProjectFeaturePlan {
  const group = randomUUID(),
    first = randomUUID(),
    second = randomUUID();
  return {
    features: [
      {
        id: group,
        parentId: null,
        kind: 'group',
        title: '프로젝트 준비',
        description: '',
        criteria: '',
        included: true,
        revision: 1,
        order: 0,
      },
      {
        id: first,
        parentId: group,
        kind: 'leaf',
        title: '프로젝트 생성',
        description: '첫 기능',
        criteria: '폴더를 선택하면 프로젝트가 열린다.\n취소하면 현재 선택을 유지한다.',
        included: true,
        revision: 2,
        order: 0,
      },
      {
        id: second,
        parentId: group,
        kind: 'leaf',
        title: '저장',
        description: '내용을 저장한다.',
        criteria: '저장 후 다시 열 수 있다.',
        included: true,
        revision: 1,
        order: 1,
      },
    ],
    dependencies: [{ featureId: second, prerequisiteId: first }],
    verifications: [
      {
        id: randomUUID(),
        featureId: first,
        featureTitle: '프로젝트 생성',
        revision: 2,
        result: 'passed',
        observation: '취소와 폴더 선택을 확인했다.',
        evidence: 'test run',
        checkedCriteria: ['폴더를 선택하면 프로젝트가 열린다.', '취소하면 현재 선택을 유지한다.'],
        createdAt: new Date().toISOString(),
      },
    ],
  };
}
function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (!item) throw new Error(`Missing fixture entry ${index}`);
  return item;
}

test('same revision edits, rollback and rewriting surviving verification history are rejected atomically', () => {
  const f = fixture();
  try {
    const project = f.store.register(f.folder, true);
    const before = f.store.saveFeaturePlan(project.id, samplePlan());
    const altered = structuredClone(before);
    at(altered.features, 1).description = '검증 후 바뀐 내용';
    assert.throws(() => f.store.saveFeaturePlan(project.id, altered));
    const rewritten = structuredClone(before);
    at(rewritten.features, 1).criteria = '다른 조건';
    at(rewritten.verifications, 0).checkedCriteria = ['다른 조건'];
    assert.throws(() => f.store.saveFeaturePlan(project.id, rewritten));
    const dropped = { ...before, verifications: [] };
    assert.throws(() => f.store.saveFeaturePlan(project.id, dropped));
    const newer = structuredClone(before);
    at(newer.features, 1).revision++;
    at(newer.features, 1).criteria += '\n추가 조건';
    f.store.saveFeaturePlan(project.id, newer);
    assert.throws(() => f.store.saveFeaturePlan(project.id, before));
    assert.deepEqual(f.store.featurePlan(project.id), newer);
  } finally {
    f.store.close();
  }
});

test('simultaneous contradictory records remain failed after save, restart and backup restore', () => {
  const f = fixture();
  let reopened: ProjectStore | undefined;
  try {
    const project = f.store.register(f.folder, true);
    const plan = samplePlan();
    const passed = at(plan.verifications, 0);
    passed.id = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    const failed = {
      ...passed,
      id: '00000000-0000-4000-8000-000000000000',
      result: 'failed' as const,
      checkedCriteria: [],
    };
    plan.verifications.push(failed);
    const saved = f.store.saveFeaturePlan(project.id, plan);
    const feature = at(saved.features, 1);
    assert.equal(featureState(feature, saved.verifications), 'failed');
    assert.equal(progress(saved.features, saved.verifications).done, 0);
    assert.deepEqual(saved.verifications, [...plan.verifications].sort(compareVerifications));
    const backup = f.store.backup();
    f.store.close();
    reopened = new ProjectStore(f.directory);
    assert.equal(featureState(feature, reopened.featurePlan(project.id).verifications), 'failed');
    const later = {
      ...passed,
      id: randomUUID(),
      createdAt: nextVerificationTime(saved.verifications, 0),
    };
    reopened.saveFeaturePlan(project.id, {
      ...saved,
      verifications: [...saved.verifications, later],
    });
    assert.equal(progress(saved.features, reopened.featurePlan(project.id).verifications).done, 1);
    reopened.restore(backup.id);
    assert.equal(featureState(feature, reopened.featurePlan(project.id).verifications), 'failed');
  } finally {
    reopened?.close();
    f.store.close();
  }
});

test('current versions accept new results, preserve old evidence and reject moving old record IDs', () => {
  const f = fixture();
  try {
    const project = f.store.register(f.folder, true);
    const before = f.store.saveFeaturePlan(project.id, samplePlan());
    const changed = structuredClone(before);
    const feature = at(changed.features, 1);
    feature.revision++;
    feature.criteria += '\n새 조건';
    const saved = f.store.saveFeaturePlan(project.id, changed);
    assert.equal(featureState(feature, saved.verifications), 'stale');
    for (const mutate of [
      (plan: ProjectFeaturePlan) => {
        at(plan.verifications, 0).evidence = '바꾼 근거';
      },
      (plan: ProjectFeaturePlan) => {
        at(plan.verifications, 0).revision++;
        at(plan.verifications, 0).checkedCriteria.push('새 조건');
      },
      (plan: ProjectFeaturePlan) => {
        plan.verifications.push({ ...at(plan.verifications, 0), id: randomUUID() });
      },
    ]) {
      const candidate = structuredClone(saved);
      mutate(candidate);
      assert.throws(() => f.store.saveFeaturePlan(project.id, candidate));
      assert.deepEqual(f.store.featurePlan(project.id), saved);
    }
    const record = {
      ...at(saved.verifications, 0),
      id: randomUUID(),
      revision: feature.revision,
      checkedCriteria: feature.criteria.split('\n'),
      createdAt: nextVerificationTime(saved.verifications),
    };
    const verified = f.store.saveFeaturePlan(project.id, {
      ...saved,
      verifications: [...saved.verifications, record],
    });
    assert.equal(featureState(feature, verified.verifications), 'passed');
    const moved = structuredClone(verified);
    const other = at(moved.features, 2);
    moved.features = moved.features.filter((item) => item.id !== feature.id);
    moved.dependencies = [];
    moved.verifications = [
      {
        ...record,
        featureId: other.id,
        featureTitle: other.title,
        revision: other.revision,
        checkedCriteria: other.criteria.split('\n'),
      },
    ];
    assert.throws(() => f.store.saveFeaturePlan(project.id, moved));
    assert.deepEqual(f.store.featurePlan(project.id), verified);
  } finally {
    f.store.close();
  }
});

test('feature hierarchy, dependency and revisioned verification persist per project and survive a verified backup restore', () => {
  const f = fixture();
  try {
    const project = f.store.register(f.folder, true),
      otherFolder = join(f.root, 'other');
    mkdirSync(otherFolder);
    const other = f.store.register(otherFolder);
    const plan = samplePlan();
    assert.deepEqual(f.store.saveFeaturePlan(project.id, plan), plan);
    assert.deepEqual(f.store.featurePlan(project.id), plan);
    assert.deepEqual(f.store.featurePlan(other.id), emptyFeaturePlan());
    const backup = f.store.backup();
    f.store.saveFeaturePlan(project.id, emptyFeaturePlan());
    f.store.restore(backup.id);
    assert.deepEqual(f.store.featurePlan(project.id), plan);
    f.store.close();
    const reopened = new ProjectStore(f.directory);
    assert.deepEqual(reopened.featurePlan(project.id), plan);
    reopened.close();
  } finally {
    f.store.close();
  }
});

test('feature graph validation rejects hierarchy/dependency cycles, invalid groups and cross-project links', () => {
  const f = fixture();
  try {
    const project = f.store.register(f.folder, true),
      otherFolder = join(f.root, 'other');
    mkdirSync(otherFolder);
    const other = f.store.register(otherFolder);
    const good = samplePlan();
    assert.equal(validateFeaturePlan(good), true);
    const parentCycle = structuredClone(good);
    at(parentCycle.features, 0).parentId = at(parentCycle.features, 1).id;
    assert.equal(validateFeaturePlan(parentCycle), false);
    const dependencyCycle = structuredClone(good);
    const dependency = at(dependencyCycle.dependencies, 0);
    dependencyCycle.dependencies.push({
      featureId: dependency.prerequisiteId,
      prerequisiteId: dependency.featureId,
    });
    assert.equal(validateFeaturePlan(dependencyCycle), false);
    const invalidGroup = structuredClone(good);
    at(invalidGroup.features, 0).kind = 'leaf';
    assert.equal(validateFeaturePlan(invalidGroup), false);
    const crossProject = structuredClone(good);
    at(crossProject.dependencies, 0).prerequisiteId = randomUUID();
    assert.equal(validateFeaturePlan(crossProject), false);
    f.store.saveFeaturePlan(project.id, good);
    assert.throws(() => f.store.saveFeaturePlan(other.id, crossProject));
    assert.deepEqual(f.store.featurePlan(project.id), good);
  } finally {
    f.store.close();
  }
});

test('feature plan writes roll back atomically when a relationship insert fails', () => {
  const f = fixture();
  try {
    const project = f.store.register(f.folder, true),
      plan = samplePlan();
    f.store.saveFeaturePlan(project.id, plan);
    const db = dbOf(f.store),
      original = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.startsWith('INSERT INTO feature_dependencies'))
        throw new Error('injected relation failure');
      return original(sql);
    }) as typeof db.prepare;
    assert.throws(() => f.store.saveFeaturePlan(project.id, plan), /relation failure/);
    db.prepare = original;
    assert.deepEqual(f.store.featurePlan(project.id), plan);
  } finally {
    f.store.close();
  }
});

test('v1 project database upgrades only after a v1 safety copy and v1 backup restore remains supported', () => {
  const f = fixture();
  try {
    const project = f.store.register(f.folder, true);
    f.store.close();
    const db = new DatabaseSync(f.path);
    db.exec(
      'DROP TABLE feature_paths; DROP TABLE verification_criteria; DROP TABLE verifications; DROP TABLE feature_dependencies; DROP TABLE features; PRAGMA user_version=1',
    );
    db.close();
    const v1 = new ProjectStore(f.directory);
    assert.equal(dbOf(v1).prepare('PRAGMA user_version').get()?.user_version, 3);
    assert.deepEqual(
      v1.catalog().projects.map(({ id, name }) => ({ id, name })),
      [{ id: project.id, name: project.name }],
    );
    const safety = v1.backups()[0];
    assert.ok(safety);
    const backupDb = new DatabaseSync(
      join(f.directory, 'backups', `${safety.createdAt}-${safety.id}.sqlite`),
      { readOnly: true },
    );
    assert.equal(backupDb.prepare('PRAGMA user_version').get()?.user_version, 1);
    backupDb.close();
    const plan = samplePlan();
    v1.saveFeaturePlan(project.id, plan);
    v1.restore(safety.id);
    assert.deepEqual(v1.featurePlan(project.id), emptyFeaturePlan());
  } finally {
    f.store.close();
  }
});

test('v1 migration failure leaves the live database unchanged and can retry', () => {
  const f = fixture();
  try {
    f.store.register(f.folder, true);
    f.store.close();
    const db = new DatabaseSync(f.path);
    db.exec(
      'DROP TABLE feature_paths; DROP TABLE verification_criteria; DROP TABLE verifications; DROP TABLE feature_dependencies; DROP TABLE features; PRAGMA user_version=1',
    );
    db.close();
    const before = hash(f.path),
      original = DatabaseSync.prototype.exec;
    try {
      DatabaseSync.prototype.exec = function (sql: string) {
        if (sql.startsWith('CREATE TABLE features')) throw new Error('injected migration failure');
        return original.call(this, sql);
      };
      assert.throws(() => new ProjectStore(f.directory), /migration failure/);
    } finally {
      DatabaseSync.prototype.exec = original;
    }
    assert.equal(hash(f.path), before);
    const recovered = new ProjectStore(f.directory);
    assert.equal(dbOf(recovered).prepare('PRAGMA user_version').get()?.user_version, 3);
    assert.equal(recovered.backups().length, 2);
    recovered.close();
  } finally {
    f.store.close();
  }
});

test('v2 migration preserves relations and verification, snapshots v2, persists paths and restores either backup version', () => {
  const f = fixture();
  const project = f.store.register(f.folder, true);
  const original = samplePlan();
  f.store.saveFeaturePlan(project.id, original);
  f.store.close();
  const db = new DatabaseSync(f.path);
  db.exec('DROP TABLE feature_paths; PRAGMA user_version=2');
  db.close();
  const upgraded = new ProjectStore(f.directory);
  try {
    assert.equal(dbOf(upgraded).prepare('PRAGMA user_version').get()?.user_version, 3);
    assert.deepEqual(upgraded.featurePlan(project.id), original);
    const v2 = upgraded.backups()[0];
    assert.ok(v2);
    const pathPlan = structuredClone(original);
    at(pathPlan.features, 1).relatedPaths = ['src/한글 파일.ts', '계획/없는 파일.md'];
    at(pathPlan.features, 1).revision++;
    assert.deepEqual(upgraded.saveFeaturePlan(project.id, pathPlan), pathPlan);
    const v3 = upgraded.backup();
    upgraded.restore(v2.id);
    assert.deepEqual(upgraded.featurePlan(project.id), original);
    upgraded.restore(v3.id);
    assert.deepEqual(upgraded.featurePlan(project.id), pathPlan);
  } finally {
    upgraded.close();
  }
});

test('v2 migration failure preserves original bytes and a later retry succeeds', () => {
  const f = fixture();
  const project = f.store.register(f.folder, true);
  const plan = samplePlan();
  f.store.saveFeaturePlan(project.id, plan);
  f.store.close();
  const db = new DatabaseSync(f.path);
  db.exec('DROP TABLE feature_paths; PRAGMA user_version=2');
  db.close();
  const before = hash(f.path),
    original = DatabaseSync.prototype.exec;
  try {
    DatabaseSync.prototype.exec = function (sql: string) {
      if (sql.includes('PRAGMA user_version=3')) throw new Error('injected path migration failure');
      return original.call(this, sql);
    };
    assert.throws(() => new ProjectStore(f.directory), /migration failure/);
  } finally {
    DatabaseSync.prototype.exec = original;
  }
  assert.equal(hash(f.path), before);
  const recovered = new ProjectStore(f.directory);
  assert.deepEqual(recovered.featurePlan(project.id), plan);
  recovered.close();
});
