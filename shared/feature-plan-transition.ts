import { needsReverification } from './feature-editing.js';
import type { ProjectFeaturePlan, StoredVerification } from './feature-plan.js';

const recordValue = (record: StoredVerification) =>
  JSON.stringify([
    record.featureId,
    record.featureTitle,
    record.revision,
    record.result,
    record.observation,
    record.evidence,
    record.checkedCriteria,
    record.createdAt,
  ]);

/** Both graphs must already pass validateFeaturePlan. Backup restore has a separate contract. */
export function validFeaturePlanTransition(
  previous: ProjectFeaturePlan,
  next: ProjectFeaturePlan,
): boolean {
  const oldFeatures = new Map(previous.features.map((item) => [item.id, item]));
  const features = new Map(next.features.map((item) => [item.id, item]));
  const prerequisites = (plan: ProjectFeaturePlan, id: string) =>
    plan.dependencies.filter((edge) => edge.featureId === id).map((edge) => edge.prerequisiteId);
  for (const item of next.features) {
    const old = oldFeatures.get(item.id);
    if (!old) continue;
    const changed = needsReverification(
      old,
      item,
      prerequisites(previous, item.id),
      prerequisites(next, item.id),
    );
    if (item.kind !== old.kind || item.revision !== old.revision + Number(changed)) return false;
  }
  const oldRecords = new Map(previous.verifications.map((record) => [record.id, record]));
  const records = new Map(next.verifications.map((record) => [record.id, record]));
  for (const old of previous.verifications) {
    const current = records.get(old.id);
    if (current ? recordValue(old) !== recordValue(current) : features.has(old.featureId))
      return false;
  }
  for (const record of next.verifications) {
    if (oldRecords.has(record.id)) continue;
    const feature = features.get(record.featureId);
    if (!feature || record.revision !== feature.revision || record.featureTitle !== feature.title)
      return false;
  }
  return true;
}
