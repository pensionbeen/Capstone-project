import type { StoredFeature, StoredVerification } from './feature-plan.js';

export function criteriaLines(value: string): string[] {
  return [
    ...new Set(
      value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

const requiredText = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length <= max &&
  value.trim().length > 0 &&
  [...value].every(
    (character) => character.charCodeAt(0) >= 32 || character === '\n' || character === '\t',
  );

export function canRecordVerification(
  feature: StoredFeature,
  record: Pick<StoredVerification, 'result' | 'observation' | 'evidence' | 'checkedCriteria'>,
): boolean {
  const criteria = criteriaLines(feature.criteria);
  if (
    feature.kind !== 'leaf' ||
    !requiredText(feature.title, 80) ||
    !requiredText(feature.criteria, 2000) ||
    !['passed', 'failed'].includes(record.result) ||
    !requiredText(record.observation, 4000) ||
    !requiredText(record.evidence, 4000) ||
    !Array.isArray(record.checkedCriteria) ||
    record.checkedCriteria.length > 100 ||
    new Set(record.checkedCriteria).size !== record.checkedCriteria.length ||
    record.checkedCriteria.some((entry) => !criteria.includes(entry))
  )
    return false;
  return (
    record.result === 'failed' || criteria.every((entry) => record.checkedCriteria.includes(entry))
  );
}

/** Stable in the UI and after SQLite reload. Conflicting simultaneous results fail closed. */
export function compareVerifications(a: StoredVerification, b: StoredVerification): number {
  return (
    Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
    Number(a.result === 'failed') - Number(b.result === 'failed') ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function latestVerification(feature: StoredFeature, records: StoredVerification[]) {
  return records
    .filter((record) => record.featureId === feature.id && record.revision === feature.revision)
    .sort(compareVerifications)
    .at(-1);
}

export function featureState(
  feature: StoredFeature,
  records: StoredVerification[],
): 'ready' | 'passed' | 'failed' | 'stale' {
  if (feature.kind !== 'leaf') return 'ready';
  const current = latestVerification(feature, records);
  if (
    current &&
    Number.isFinite(Date.parse(current.createdAt)) &&
    canRecordVerification(feature, current)
  )
    return current.result;
  return records.some((record) => record.featureId === feature.id) ? 'stale' : 'ready';
}

export function progress(features: StoredFeature[], records: StoredVerification[]) {
  const included = features.filter((feature) => feature.included && feature.kind === 'leaf');
  const done = included.filter((feature) => featureState(feature, records) === 'passed').length;
  return {
    total: included.length,
    done,
    percent: included.length ? Math.round((done / included.length) * 100) : null,
  };
}

/** Keep newly recorded manual results ordered even within one millisecond or after clock rollback. */
export function nextVerificationTime(records: StoredVerification[], now = Date.now()): string {
  const previous = Math.max(-1, ...records.map((record) => Date.parse(record.createdAt)));
  return new Date(Math.max(now, previous + 1)).toISOString();
}
