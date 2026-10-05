import type { DatabaseSync } from 'node:sqlite';
import { type ProjectFeaturePlan, validateFeaturePlan } from '../../shared/feature-plan.js';
import { StorageError } from './project-store.js';

export const FEATURE_TABLES = {
  features: `CREATE TABLE features (
    project_id TEXT NOT NULL,
    feature_id TEXT NOT NULL CHECK(length(feature_id) = 36),
    parent_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('group', 'leaf')),
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
    description TEXT NOT NULL CHECK(length(description) <= 2000),
    criteria TEXT NOT NULL CHECK(length(criteria) <= 2000),
    included INTEGER NOT NULL CHECK(included IN (0, 1)),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
    sort_order INTEGER NOT NULL CHECK(sort_order BETWEEN 0 AND 10000),
    PRIMARY KEY(project_id, feature_id),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(project_id, parent_id) REFERENCES features(project_id, feature_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    CHECK(parent_id IS NULL OR parent_id <> feature_id)
  ) STRICT`,
  feature_dependencies: `CREATE TABLE feature_dependencies (
    project_id TEXT NOT NULL,
    feature_id TEXT NOT NULL,
    prerequisite_id TEXT NOT NULL,
    PRIMARY KEY(project_id, feature_id, prerequisite_id),
    FOREIGN KEY(project_id, feature_id) REFERENCES features(project_id, feature_id) ON DELETE CASCADE,
    FOREIGN KEY(project_id, prerequisite_id) REFERENCES features(project_id, feature_id) ON DELETE CASCADE,
    CHECK(feature_id <> prerequisite_id)
  ) STRICT`,
  verifications: `CREATE TABLE verifications (
    project_id TEXT NOT NULL,
    verification_id TEXT NOT NULL CHECK(length(verification_id) = 36),
    feature_id TEXT NOT NULL,
    feature_title TEXT NOT NULL CHECK(length(feature_title) BETWEEN 1 AND 80),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
    result TEXT NOT NULL CHECK(result IN ('passed', 'failed')),
    observation TEXT NOT NULL CHECK(length(observation) BETWEEN 1 AND 4000),
    evidence TEXT NOT NULL CHECK(length(evidence) BETWEEN 1 AND 4000),
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, verification_id),
    FOREIGN KEY(project_id, feature_id) REFERENCES features(project_id, feature_id) ON DELETE CASCADE
  ) STRICT`,
  verification_criteria: `CREATE TABLE verification_criteria (
    project_id TEXT NOT NULL,
    verification_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 99),
    criterion TEXT NOT NULL CHECK(length(criterion) BETWEEN 1 AND 2000),
    PRIMARY KEY(project_id, verification_id, position),
    FOREIGN KEY(project_id, verification_id) REFERENCES verifications(project_id, verification_id)
      ON DELETE CASCADE
  ) STRICT`,
} as const;

export const PATH_TABLES = {
  feature_paths: `CREATE TABLE feature_paths (
    project_id TEXT NOT NULL,
    feature_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 19),
    path TEXT NOT NULL CHECK(length(path) BETWEEN 1 AND 1000),
    PRIMARY KEY(project_id, feature_id, position),
    FOREIGN KEY(project_id, feature_id) REFERENCES features(project_id, feature_id) ON DELETE CASCADE
  ) STRICT`,
} as const;

export function readFeaturePlan(
  db: DatabaseSync,
  projectId: string,
  withPaths = true,
): ProjectFeaturePlan {
  const features = db
    .prepare(`SELECT feature_id AS id, parent_id AS parentId, kind, title, description,
    criteria, included, revision, sort_order AS "order" FROM features WHERE project_id = ? ORDER BY sort_order, feature_id`)
    .all(projectId)
    .map((row) => ({
      ...row,
      included: row.included === 1,
    })) as unknown as ProjectFeaturePlan['features'];
  if (withPaths) {
    const byId = new Map(features.map((feature) => [feature.id, feature]));
    const rows = db
      .prepare('SELECT feature_id, path FROM feature_paths WHERE project_id = ? ORDER BY position')
      .all(projectId);
    for (const row of rows) {
      const feature = byId.get(String(row.feature_id));
      if (!feature) throw new StorageError('관련 경로의 기능을 찾을 수 없어요.');
      feature.relatedPaths ??= [];
      feature.relatedPaths.push(String(row.path));
    }
  }
  const dependencies = db
    .prepare(`SELECT feature_id AS featureId, prerequisite_id AS prerequisiteId
    FROM feature_dependencies WHERE project_id = ? ORDER BY feature_id, prerequisite_id`)
    .all(projectId)
    .map((row) => ({ ...row })) as unknown as ProjectFeaturePlan['dependencies'];
  const verifications = db
    .prepare(`SELECT verification_id AS id, feature_id AS featureId, feature_title AS featureTitle,
    revision, result, observation, evidence, created_at AS createdAt FROM verifications
    WHERE project_id = ? ORDER BY created_at, verification_id`)
    .all(projectId)
    .map((row) => ({
      ...row,
      checkedCriteria: [],
    })) as unknown as ProjectFeaturePlan['verifications'];
  const criteria = db
    .prepare(`SELECT verification_id AS verificationId, criterion FROM verification_criteria
    WHERE project_id = ? ORDER BY verification_id, position`)
    .all(projectId) as { verificationId: string; criterion: string }[];
  const byVerification = new Map<string, string[]>();
  for (const row of criteria)
    byVerification.set(row.verificationId, [
      ...(byVerification.get(row.verificationId) ?? []),
      row.criterion,
    ]);
  for (const row of verifications) row.checkedCriteria = byVerification.get(row.id) ?? [];
  const plan = { features, dependencies, verifications };
  if (!validateFeaturePlan(plan))
    throw new StorageError('저장된 기능 관계나 검증 기록이 올바르지 않아요. 원본은 보존했어요.');
  const children = new Map<string | null, ProjectFeaturePlan['features']>();
  for (const item of plan.features)
    children.set(item.parentId, [...(children.get(item.parentId) ?? []), item]);
  for (const nodes of children.values())
    nodes.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const ordered: ProjectFeaturePlan['features'] = [];
  const append = (parentId: string | null) => {
    for (const item of children.get(parentId) ?? []) {
      ordered.push(item);
      append(item.id);
    }
  };
  append(null);
  return { ...plan, features: ordered };
}

export function readAllFeaturePlans(db: DatabaseSync, projectIds: string[], withPaths = true) {
  return Object.fromEntries(projectIds.map((id) => [id, readFeaturePlan(db, id, withPaths)]));
}

export function writeFeaturePlan(db: DatabaseSync, projectId: string, plan: ProjectFeaturePlan) {
  if (!validateFeaturePlan(plan))
    throw new StorageError('기능·선행 관계·완료 조건·검증 기록을 확인해 주세요.');
  db.prepare('DELETE FROM features WHERE project_id = ?').run(projectId);
  const addFeature = db.prepare(`INSERT INTO features
    (project_id, feature_id, parent_id, kind, title, description, criteria, included, revision, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const item of plan.features)
    addFeature.run(
      projectId,
      item.id,
      item.parentId,
      item.kind,
      item.title,
      item.description,
      item.criteria,
      item.included ? 1 : 0,
      item.revision,
      item.order,
    );
  const addPath = db.prepare(
    'INSERT INTO feature_paths(project_id, feature_id, position, path) VALUES (?, ?, ?, ?)',
  );
  for (const item of plan.features)
    item.relatedPaths?.forEach((path, position) => {
      addPath.run(projectId, item.id, position, path);
    });
  const addDependency =
    db.prepare(`INSERT INTO feature_dependencies(project_id, feature_id, prerequisite_id)
    VALUES (?, ?, ?)`);
  for (const item of plan.dependencies)
    addDependency.run(projectId, item.featureId, item.prerequisiteId);
  const addVerification = db.prepare(`INSERT INTO verifications
    (project_id, verification_id, feature_id, feature_title, revision, result, observation, evidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const addCriterion =
    db.prepare(`INSERT INTO verification_criteria(project_id, verification_id, position, criterion)
    VALUES (?, ?, ?, ?)`);
  for (const item of plan.verifications) {
    addVerification.run(
      projectId,
      item.id,
      item.featureId,
      item.featureTitle,
      item.revision,
      item.result,
      item.observation,
      item.evidence,
      item.createdAt,
    );
    item.checkedCriteria.forEach((criterion, position) => {
      addCriterion.run(projectId, item.id, position, criterion);
    });
  }
}
