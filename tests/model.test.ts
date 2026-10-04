import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canRecordVerification,
  criteriaLines,
  editFeature,
  featureState,
  makeDrafts,
  progress,
  type Verification,
  validProtectionPath,
} from '../src/model.ts';

const feature = makeDrafts('할 일 앱', [])[0];
if (!feature) throw new Error('Missing test fixture');
const record: Verification = {
  id: 'test',
  featureId: feature.id,
  featureTitle: feature.title,
  revision: 1,
  result: 'passed',
  observation: '세 조건 직접 확인',
  evidence: '합성 검사 결과',
  checkedCriteria: criteriaLines(feature.criteria),
  createdAt: '2026-10-04T04:00:00Z',
};

test('아무 기능도 정의하지 않았을 때 완료율을 만들지 않는다', () => {
  assert.deepEqual(progress([], []), { done: 0, total: 0, percent: null });
});
test('포함한 기능의 현재 검증만 완료율에 반영한다', () => {
  const ignored = { ...feature, id: 'excluded', included: false };
  assert.deepEqual(progress([feature, ignored], [record]), { done: 1, total: 1, percent: 100 });
});
test('완료 조건 변경은 기존 근거를 보존하고 재검증 상태로 바꾼다', () => {
  const changed = editFeature(feature, {
    title: feature.title,
    description: feature.description,
    criteria: `${feature.criteria}\n새 조건`,
  });
  assert.equal(changed.revision, 2);
  assert.equal(featureState(changed, [record]), 'stale');
  assert.equal(progress([changed], [record]).done, 0);
  assert.equal(record.revision, 1);
});
test('같은 내용을 저장하면 기존 검증을 무효화하지 않는다', () => {
  assert.equal(editFeature(feature, feature).revision, 1);
});
test('나중 실패 결과가 과거 성공 결과를 대체한다', () => {
  assert.equal(
    featureState(feature, [record, { ...record, id: 'later', result: 'failed' }]),
    'failed',
  );
});
test('근거와 결과 및 모든 조건 확인이 있어야 통과를 기록한다', () => {
  assert.equal(canRecordVerification(feature, record), true);
  assert.equal(canRecordVerification(feature, { ...record, evidence: ' ' }), false);
  assert.equal(canRecordVerification(feature, { ...record, observation: '' }), false);
  assert.equal(canRecordVerification(feature, { ...record, checkedCriteria: [] }), false);
  assert.equal(
    canRecordVerification(feature, { ...record, result: 'failed', checkedCriteria: [] }),
    true,
  );
});
test('예시 기능은 선택 범위만 만들고 제목은 사용자 코드로 실행하지 않는다', () => {
  assert.equal(makeDrafts('할 일 앱', ['search']).length, 2);
  assert.equal(makeDrafts('<script>alert(1)</script>', [])[0]?.title, '항목 추가·수정');
});
test('보호 경로 초안에서 상위 이동·절대 경로·제어 문자를 거부한다', () => {
  for (const path of [
    '../secret',
    'x/../secret',
    'C:\\secret',
    '/etc/passwd',
    '\\\\server\\share',
    'a\0b',
    '.',
  ])
    assert.equal(validProtectionPath(path), false, path);
  for (const path of ['.env', 'secrets/', '설정/개인 파일.json'])
    assert.equal(validProtectionPath(path), true, path);
});
