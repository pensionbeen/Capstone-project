import {
  type ProjectFeaturePlan,
  type StoredFeature,
  validateFeaturePlan,
} from './feature-plan.js';

export function descendantIds(plan: ProjectFeaturePlan, id: string): Set<string> {
  const ids = new Set([id]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const item of plan.features)
      if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) {
        ids.add(item.id);
        changed = true;
      }
  }
  return ids;
}

export function featureRows(plan: ProjectFeaturePlan) {
  const rows: { feature: StoredFeature; depth: number }[] = [];
  const visited = new Set<string>();
  function append(parentId: string | null, depth: number) {
    for (const feature of plan.features
      .filter((item) => item.parentId === parentId)
      .sort((a, b) => a.order - b.order)) {
      if (visited.has(feature.id)) continue;
      visited.add(feature.id);
      rows.push({ feature, depth });
      append(feature.id, depth + 1);
    }
  }
  append(null, 0);
  return rows;
}

export function updatePlanFeature(
  plan: ProjectFeaturePlan,
  draft: StoredFeature,
  prerequisiteIds: string[],
): ProjectFeaturePlan {
  const previous = plan.features.find((item) => item.id === draft.id);
  if (previous && previous.kind !== draft.kind)
    throw new Error('기존 기능의 종류는 바꿀 수 없어요.');
  const oldPrerequisites = plan.dependencies
    .filter((edge) => edge.featureId === draft.id)
    .map((edge) => edge.prerequisiteId)
    .sort();
  const feature = {
    ...draft,
    title: draft.title.trim(),
    description: draft.description.trim(),
    criteria: draft.criteria.trim(),
  };
  if (previous) {
    if (previous.revision !== draft.revision)
      throw new Error('기능이 변경됐어요. 편집 창을 다시 열어 주세요.');
    // Inclusion is changed by its own action, not by this editor's snapshot.
    feature.included = previous.included;
    const changed =
      previous.title !== feature.title ||
      previous.description !== feature.description ||
      previous.criteria !== feature.criteria ||
      JSON.stringify(previous.relatedPaths ?? []) !== JSON.stringify(feature.relatedPaths ?? []) ||
      JSON.stringify(oldPrerequisites) !== JSON.stringify([...prerequisiteIds].sort());
    feature.revision = previous.revision + (changed ? 1 : 0);
  } else feature.revision = 1;
  if (!previous || previous.parentId !== feature.parentId) {
    feature.order =
      1 +
      Math.max(
        -1,
        ...plan.features
          .filter((item) => item.parentId === feature.parentId)
          .map((item) => item.order),
      );
  } else feature.order = previous.order;
  const candidate = {
    features: previous
      ? plan.features.map((item) => (item.id === feature.id ? feature : item))
      : [...plan.features, feature],
    dependencies: [
      ...plan.dependencies.filter((edge) => edge.featureId !== draft.id),
      ...prerequisiteIds.map((prerequisiteId) => ({ featureId: draft.id, prerequisiteId })),
    ],
    verifications: plan.verifications,
  };
  if (!validateFeaturePlan(candidate))
    throw new Error(
      '이름·완료 조건·관련 경로를 확인해 주세요. 관계가 서로 순환하거나 트리가 16단계를 넘을 수 없어요.',
    );
  return candidate;
}

export function removePlanFeature(plan: ProjectFeaturePlan, id: string): ProjectFeaturePlan {
  const removed = descendantIds(plan, id);
  const affected = new Set(
    plan.dependencies
      .filter((edge) => removed.has(edge.prerequisiteId) && !removed.has(edge.featureId))
      .map((edge) => edge.featureId),
  );
  return {
    features: plan.features
      .filter((item) => !removed.has(item.id))
      .map((item) => (affected.has(item.id) ? { ...item, revision: item.revision + 1 } : item)),
    dependencies: plan.dependencies.filter(
      (edge) => !removed.has(edge.featureId) && !removed.has(edge.prerequisiteId),
    ),
    verifications: plan.verifications.filter((record) => !removed.has(record.featureId)),
  };
}
