export type FeatureKind = 'group' | 'leaf';
export interface StoredFeature {
  id: string;
  parentId: string | null;
  kind: FeatureKind;
  title: string;
  description: string;
  criteria: string;
  included: boolean;
  revision: number;
  order: number;
}
export interface FeatureDependency {
  featureId: string;
  prerequisiteId: string;
}
export interface StoredVerification {
  id: string;
  featureId: string;
  featureTitle: string;
  revision: number;
  result: 'passed' | 'failed';
  observation: string;
  evidence: string;
  checkedCriteria: string[];
  createdAt: string;
}
export interface ProjectFeaturePlan {
  features: StoredFeature[];
  dependencies: FeatureDependency[];
  verifications: StoredVerification[];
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (value: unknown, max: number, required = false): value is string =>
  typeof value === 'string' &&
  value.length <= max &&
  (!required || value.trim().length > 0) &&
  [...value].every(
    (character) => character.charCodeAt(0) >= 32 || character === '\n' || character === '\t',
  );
const criteriaLines = (value: string) => [
  ...new Set(
    value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  ),
];

export function emptyFeaturePlan(): ProjectFeaturePlan {
  return { features: [], dependencies: [], verifications: [] };
}

/** Validate one complete project graph before opening a database transaction. */
export function validateFeaturePlan(value: unknown): value is ProjectFeaturePlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Partial<ProjectFeaturePlan>;
  if (
    !Array.isArray(plan.features) ||
    plan.features.length > 100 ||
    !Array.isArray(plan.dependencies) ||
    plan.dependencies.length > 500 ||
    !Array.isArray(plan.verifications) ||
    plan.verifications.length > 1000
  )
    return false;
  const byId = new Map<string, StoredFeature>();
  const siblingOrders = new Set<string>();
  for (const item of plan.features) {
    if (
      !item ||
      typeof item !== 'object' ||
      !ID.test(item.id) ||
      byId.has(item.id) ||
      !(item.parentId === null || (typeof item.parentId === 'string' && ID.test(item.parentId))) ||
      !(item.kind === 'group' || item.kind === 'leaf') ||
      !text(item.title, 80, true) ||
      !text(item.description, 2000) ||
      !text(item.criteria, 2000) ||
      typeof item.included !== 'boolean' ||
      !Number.isSafeInteger(item.revision) ||
      item.revision < 1 ||
      !Number.isSafeInteger(item.order) ||
      item.order < 0 ||
      item.order > 10000
    )
      return false;
    const siblingOrder = `${item.parentId ?? 'root'}:${item.order}`;
    if (siblingOrders.has(siblingOrder)) return false;
    siblingOrders.add(siblingOrder);
    const criteria = criteriaLines(item.criteria);
    if (item.kind === 'group' ? criteria.length !== 0 : criteria.length === 0) return false;
    byId.set(item.id, item);
  }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const walkParent = (id: string, depth: number): boolean => {
    if (depth > 16 || visiting.has(id)) return false;
    if (visited.has(id)) return true;
    const item = byId.get(id);
    if (!item) return false;
    visiting.add(id);
    if (item.parentId !== null) {
      const parent = byId.get(item.parentId);
      if (parent?.kind !== 'group' || !walkParent(parent.id, depth + 1)) return false;
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  for (const item of plan.features) if (!walkParent(item.id, 1)) return false;

  const edges = new Map<string, string[]>();
  const edgeKeys = new Set<string>();
  for (const edge of plan.dependencies) {
    if (
      !edge ||
      typeof edge !== 'object' ||
      !ID.test(edge.featureId) ||
      !ID.test(edge.prerequisiteId) ||
      edge.featureId === edge.prerequisiteId ||
      edgeKeys.has(`${edge.featureId}:${edge.prerequisiteId}`) ||
      byId.get(edge.featureId)?.kind !== 'leaf' ||
      byId.get(edge.prerequisiteId)?.kind !== 'leaf'
    )
      return false;
    edgeKeys.add(`${edge.featureId}:${edge.prerequisiteId}`);
    edges.set(edge.featureId, [...(edges.get(edge.featureId) ?? []), edge.prerequisiteId]);
  }
  const active = new Set<string>(),
    done = new Set<string>();
  const walkDependency = (id: string, depth: number): boolean => {
    if (depth > 100 || active.has(id)) return false;
    if (done.has(id)) return true;
    active.add(id);
    for (const prerequisite of edges.get(id) ?? [])
      if (!walkDependency(prerequisite, depth + 1)) return false;
    active.delete(id);
    done.add(id);
    return true;
  };
  for (const id of edges.keys()) if (!walkDependency(id, 1)) return false;

  const verifications = new Set<string>();
  for (const item of plan.verifications) {
    const feature = item && byId.get(item.featureId);
    if (
      !item ||
      typeof item !== 'object' ||
      !ID.test(item.id) ||
      verifications.has(item.id) ||
      !feature ||
      !text(item.featureTitle, 80, true) ||
      !Number.isSafeInteger(item.revision) ||
      item.revision < 1 ||
      item.revision > feature.revision ||
      !(item.result === 'passed' || item.result === 'failed') ||
      !text(item.observation, 4000, true) ||
      !text(item.evidence, 4000, true) ||
      !Array.isArray(item.checkedCriteria) ||
      item.checkedCriteria.length > 100 ||
      item.checkedCriteria.some((entry) => !text(entry, 2000, true)) ||
      new Set(item.checkedCriteria).size !== item.checkedCriteria.length ||
      typeof item.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(item.createdAt))
    )
      return false;
    if (
      item.revision === feature.revision &&
      item.checkedCriteria.some((criterion) => !criteriaLines(feature.criteria).includes(criterion))
    )
      return false;
    if (
      item.revision === feature.revision &&
      item.result === 'passed' &&
      !criteriaLines(feature.criteria).every((criterion) =>
        item.checkedCriteria.includes(criterion),
      )
    )
      return false;
    verifications.add(item.id);
  }
  return true;
}
