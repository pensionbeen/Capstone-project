import assert from 'node:assert/strict';
import test from 'node:test';
import { nextVerificationTime } from '../shared/verification.ts';
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
test('검증 배열이 뒤섞여도 실제 최신 실패를 완료로 집계하지 않는다', () => {
  const failed: Verification = {
    ...record,
    id: 'later',
    result: 'failed',
    createdAt: '2026-10-04T04:00:01Z',
  };
  assert.equal(featureState(feature, [failed, record]), 'failed');
});
test('같은 시각의 상충하는 결과는 실패를 우선하며 배열 순서와 무관하다', () => {
  const failed: Verification = { ...record, id: 'a', result: 'failed' };
  for (const records of [
    [record, failed],
    [failed, record],
  ])
    assert.deepEqual(progress([feature], records), { done: 0, total: 1, percent: 0 });
});
test('시계가 뒤로 가거나 같은 밀리초에 기록해도 새 검증 시각은 뒤에 온다', () => {
  const first = Date.parse(record.createdAt);
  for (const now of [first - 10000, first, first + 1])
    assert.equal(Date.parse(nextVerificationTime([record], now)), first + 1);
  assert.equal(Date.parse(nextVerificationTime([record], first + 100)), first + 100);
});
test('검증 입력은 알 수 없는 조건·중복 조건·잘못된 결과·과대 근거를 거부한다', () => {
  for (const bad of [
    { ...record, checkedCriteria: [...record.checkedCriteria, '다른 조건'] },
    { ...record, checkedCriteria: [...record.checkedCriteria, record.checkedCriteria[0]] },
    { ...record, result: 'completed' as Verification['result'] },
    { ...record, observation: 'a'.repeat(4001) },
    { ...record, evidence: 'a\0b' },
  ])
    assert.equal(canRecordVerification(feature, bad), false);
});
test('근거 없는 통과 기록과 AI 완료 문장만으로 완료를 만들지 않는다', () => {
  const claim = {
    ...record,
    observation: 'AI가 완료했다고 말했다.',
    evidence: 'AI의 완료 문장',
    checkedCriteria: [],
  };
  assert.equal(canRecordVerification(feature, claim), false);
  assert.equal(progress([feature], [claim]).done, 0);
  assert.equal(progress([feature], [{ ...record, evidence: '' }]).done, 0);
});
test('묶음과 제외 항목은 분모에서 빼고 추가·삭제·재포함을 다시 계산한다', () => {
  const group = { ...feature, id: 'group', kind: 'group' as const, criteria: '' };
  const second = { ...feature, id: 'second', parentId: group.id };
  assert.deepEqual(progress([group], []), { done: 0, total: 0, percent: null });
  assert.deepEqual(progress([group, feature, second], [record]), {
    done: 1,
    total: 2,
    percent: 50,
  });
  assert.equal(progress([group, feature, { ...second, included: false }], [record]).percent, 100);
  assert.equal(progress([group, second], [record]).percent, 0);
  assert.equal(progress([group, feature, second], [record]).percent, 50);
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
