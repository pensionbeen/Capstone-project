import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  featureRows,
  removePlanFeature,
  updatePlanFeature,
} from '../dist/desktop/shared/feature-editing.js';
import { emptyFeaturePlan, validateFeaturePlan } from '../dist/desktop/shared/feature-plan.js';
import type { ProjectFeaturePlan, StoredFeature } from '../shared/feature-plan.ts';

function feature(
  kind: 'group' | 'leaf' = 'leaf',
  parentId: string | null = null,
  order = 0,
): StoredFeature {
  return {
    id: randomUUID(),
    title: '기능',
    description: '',
    criteria: kind === 'leaf' ? '동작 확인' : '',
    kind,
    parentId,
    order,
    included: true,
    revision: 1,
  };
}
function verifiedPlan(): ProjectFeaturePlan {
  const item = feature();
  return {
    features: [item],
    dependencies: [],
    verifications: [
      {
        id: randomUUID(),
        featureId: item.id,
        featureTitle: item.title,
        revision: 1,
        result: 'passed',
        observation: '직접 확인',
        evidence: '검사 결과',
        checkedCriteria: ['동작 확인'],
        createdAt: '2026-10-05T12:00:00Z',
      },
    ],
  };
}

test('tree depth 16 is accepted and 17 rejected in either row order; groups cannot receive a pass', () => {
  const plan = emptyFeaturePlan();
  let parent: string | null = null;
  for (let i = 0; i < 16; i++) {
    const item = feature('group', parent);
    plan.features.push(item);
    parent = item.id;
  }
  assert.equal(validateFeaturePlan(plan), true);
  assert.equal(validateFeaturePlan({ ...plan, features: [...plan.features].reverse() }), true);
  plan.features.push(feature('leaf', parent));
  assert.equal(validateFeaturePlan(plan), false);
  assert.equal(validateFeaturePlan({ ...plan, features: [...plan.features].reverse() }), false);
  const verified = verifiedPlan();
  verified.features[0].kind = 'group';
  verified.features[0].criteria = '';
  verified.verifications[0].checkedCriteria = [];
  assert.equal(validateFeaturePlan(verified), false);
});

test('adding, moving and deleting nodes preserves tree order, removes links and keeps unaffected verification history', () => {
  let plan = verifiedPlan();
  const original = structuredClone(plan);
  const first = plan.features[0];
  const group = feature('group');
  plan = updatePlanFeature(plan, group, []);
  plan = updatePlanFeature(plan, { ...first, parentId: group.id }, []);
  const second = feature('leaf', group.id);
  plan = updatePlanFeature(plan, second, [first.id]);
  const outside = feature();
  plan = updatePlanFeature(plan, outside, [first.id]);
  assert.equal(validateFeaturePlan(plan), true);
  assert.deepEqual(
    featureRows(plan).map((row) => row.depth),
    [0, 1, 1, 0],
  );
  assert.equal(plan.features.find((item) => item.id === first.id)?.revision, 1);
  assert.deepEqual(plan.verifications, original.verifications);
  const removed = removePlanFeature(plan, group.id);
  assert.equal(removed.features.length, 1);
  assert.equal(removed.features[0].revision, 2);
  assert.deepEqual(removed.dependencies, []);
  assert.deepEqual(removed.verifications, []);
  assert.equal(plan.features.length, 4);
});

test('content, paths and prerequisites invalidate current verification; no-op preserves revision; cyclic edit preserves source', () => {
  const plan = verifiedPlan();
  const first = plan.features[0];
  const changed = updatePlanFeature(plan, { ...first, relatedPaths: ['src/한글 파일.ts'] }, []);
  assert.equal(changed.features[0].revision, 2);
  assert.equal(changed.verifications[0].revision, 1);
  assert.equal(updatePlanFeature(changed, changed.features[0], []).features[0].revision, 2);
  const second = feature();
  const added = updatePlanFeature(changed, second, [first.id]);
  const before = structuredClone(added);
  assert.throws(() => updatePlanFeature(added, added.features[0], [second.id]), /순환/);
  assert.deepEqual(added, before);
});

test('100 nodes render in order, 101st and unsafe/duplicate related paths are rejected', () => {
  let plan = emptyFeaturePlan();
  for (let i = 0; i < 100; i++) plan = updatePlanFeature(plan, feature(), []);
  assert.equal(featureRows(plan).length, 100);
  assert.throws(() => updatePlanFeature(plan, feature(), []));
  for (const paths of [
    ['../outside'],
    ['a.ts', 'A.ts'],
    Array.from({ length: 21 }, (_, i) => `${i}.ts`),
  ])
    assert.throws(() => updatePlanFeature(plan, { ...plan.features[0], relatedPaths: paths }, []));
});
