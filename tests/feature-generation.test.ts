import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendGeneratedPlan,
  generationPrompt,
  parseGeneratedPlan,
} from '../dist/desktop/shared/feature-generation.js';
import { emptyFeaturePlan, validateFeaturePlan } from '../dist/desktop/shared/feature-plan.js';
import type {
  GeneratedPlanInput,
  GeneratedPlanResult,
} from '../shared/feature-generation-contract.ts';
import type { ProjectFeaturePlan } from '../shared/feature-plan.ts';

function present<T>(value: T | undefined): T {
  assert.notEqual(value, undefined, '검사 데이터가 존재해야 한다');
  if (value === undefined) throw new Error('검사 데이터 누락');
  return value;
}

function at<T>(values: T[], index: number): T {
  return present(values[index]);
}

function input(count = 1): GeneratedPlanInput {
  return {
    features: Array.from({ length: count }, (_, index) => ({
      key: `feature-${index}`,
      parentKey: null,
      kind: 'leaf' as const,
      title: `기능 ${index}`,
      description: '필요한 동작',
      criteria: ['직접 동작 확인'],
      relatedPaths: ['src/한글 파일.ts'],
    })),
    dependencies: [],
  };
}

function ids(start = 1): () => string {
  let index = start;
  return () => `00000000-0000-4000-8000-${(index++).toString(16).padStart(12, '0')}`;
}

function success(result: GeneratedPlanResult): ProjectFeaturePlan {
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
  if (!result.ok) throw new Error(result.message);
  return result.plan;
}

function reject(value: unknown, expected: RegExp): void {
  let calls = 0;
  const result = parseGeneratedPlan(JSON.stringify(value), () => {
    calls++;
    return ids()();
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, expected);
  assert.equal(calls, 0, '잘못된 응답에서는 UUID 생성도 시작하지 않는다');
}

function generated(count = 1, start = 1): ProjectFeaturePlan {
  return success(parseGeneratedPlan(JSON.stringify(input(count)), ids(start)));
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test('검사한 key를 새 UUID로 바꾸고 기능 상태와 빈 검증 기록을 앱이 만든다', () => {
  const source = input(3);
  source.features[0] = { ...at(source.features, 0), kind: 'group', criteria: [] };
  at(source.features, 1).parentKey = 'feature-0';
  at(source.features, 2).parentKey = 'feature-0';
  source.dependencies = [{ featureKey: 'feature-2', prerequisiteKey: 'feature-1' }];
  const before = structuredClone(source);
  const plan = success(parseGeneratedPlan(JSON.stringify(source), ids()));
  assert.equal(validateFeaturePlan(plan), true);
  assert.deepEqual(source, before);
  assert.deepEqual(
    plan.features.map((feature) => feature.order),
    [0, 0, 1],
  );
  assert.equal(at(plan.features, 1).parentId, at(plan.features, 0).id);
  assert.deepEqual(plan.dependencies, [
    { featureId: at(plan.features, 2).id, prerequisiteId: at(plan.features, 1).id },
  ]);
  assert.deepEqual(plan.verifications, []);
  assert.ok(plan.features.every((feature) => feature.included && feature.revision === 1));
  assert.match(generationPrompt, /UUID, 검증 기록, 완료 상태/);
});

test('순수 JSON 또는 한 겹의 JSON 코드 블록만 허용한다', () => {
  const text = JSON.stringify(input());
  for (const accepted of [
    text,
    ` \n${text}\n `,
    `\`\`\`json\n${text}\n\`\`\``,
    `\`\`\`\n${text}\n\`\`\``,
  ])
    assert.equal(parseGeneratedPlan(accepted, ids()).ok, true);
  for (const rejected of [
    '',
    'null',
    '[]',
    `${text}\n설명`,
    `설명\n${text}`,
    `${text}${text}`,
    `\`\`\`json\n${text}\n\`\`\`\n추가`,
    '{"features":[],}',
    '```json\n```json\n{}\n```\n```',
  ])
    assert.equal(parseGeneratedPlan(rejected, ids()).ok, false, rejected);
});

test('누락과 알 수 없는 필드를 거부하여 AI의 완료·검증·UUID 입력을 차단한다', () => {
  for (const key of Object.keys(at(input().features, 0))) {
    const value = input();
    delete (value.features[0] as unknown as Record<string, unknown>)[key];
    reject(value, /필수 필드/);
  }
  reject({ features: input().features }, /필수 필드/);
  for (const extra of ['id', 'revision', 'included', 'state', 'verifications'])
    reject(
      { ...input(), features: [{ ...input().features[0], [extra]: 'passed' }] },
      /허용하지 않는 필드/,
    );
  reject({ ...input(), verifications: [] }, /허용하지 않는 필드/);
  reject({ ...input(), dependencies: [{ featureKey: 'feature-0' }] }, /필수 필드/);
});

test('특수 필드·특수 식별자 및 반복 JSON 필드 이름을 거부한다', () => {
  const text = JSON.stringify(input());
  for (const field of ['__proto__', 'prototype', 'constructor']) {
    const result = parseGeneratedPlan(text.replace('{', `{"${field}":{},`), ids());
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /특수 필드/);
    const value = input();
    at(value.features, 0).key = field;
    reject(value, /식별자/);
  }
  for (const textWithDuplicates of [
    '{"features":[],"features":[],"dependencies":[]}',
    '{"features":[],"fea\\u0074ures":[],"dependencies":[]}',
    text.replace('"title":', '"title":"숨긴 제목","title":'),
  ]) {
    const result = parseGeneratedPlan(textWithDuplicates, ids());
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /필드 이름이 중복/);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('문자열과 배열의 잘못된 자료형 및 제어 문자는 한국어 오류로 거부한다', () => {
  for (const [field, bad, expected] of [
    ['key', 1, /식별자/],
    ['parentKey', 1, /parentKey/],
    ['kind', 'feature', /종류/],
    ['title', null, /제목/],
    ['description', [], /설명/],
    ['criteria', '동작', /문자열 배열/],
    ['criteria', [1], /문자열 배열/],
    ['relatedPaths', 'src', /경로 배열/],
    ['relatedPaths', [1], /경로 배열/],
    ['title', 'a\u0000b', /제목/],
    ['description', 'a\rb', /설명/],
  ] as const) {
    const value = input();
    (value.features[0] as unknown as Record<string, unknown>)[field] = bad;
    reject(value, expected);
  }
  reject({ features: null, dependencies: [] }, /기능 목록/);
  reject({ ...input(), dependencies: null }, /선행 관계 목록/);
  reject({ ...input(), dependencies: [null] }, /JSON 객체/);
});

test('기능100개·제목80자·설명2000자·조건합계2000자는 허용하고 초과는 거부한다', () => {
  assert.equal(parseGeneratedPlan(JSON.stringify(input(100)), ids()).ok, true);
  reject(input(101), /최대|1~100/);
  reject(input(0), /1~100/);
  const boundary = input();
  at(boundary.features, 0).title = 'a'.repeat(80);
  at(boundary.features, 0).description = 'b'.repeat(2000);
  at(boundary.features, 0).criteria = ['c'.repeat(999), 'd'.repeat(1000)];
  assert.equal(parseGeneratedPlan(JSON.stringify(boundary), ids()).ok, true);
  for (const [field, bad, expected] of [
    ['title', 'a'.repeat(81), /제목/],
    ['description', 'a'.repeat(2001), /설명/],
    ['criteria', ['c'.repeat(1000), 'd'.repeat(1000)], /합계/],
  ] as const) {
    reject({ ...boundary, features: [{ ...boundary.features[0], [field]: bad }] }, expected);
  }
  reject(
    {
      ...input(),
      features: [
        { ...input().features[0], criteria: Array.from({ length: 101 }, (_, i) => String(i)) },
      ],
    },
    /최대100/,
  );
});

test('128KiB 응답 상한은 UTF-8 바이트 기준이며 과대 입력에서 변환을 시작하지 않는다', () => {
  for (const text of [' '.repeat(128 * 1024 + 1), '가'.repeat(44 * 1024)]) {
    let calls = 0;
    const result = parseGeneratedPlan(text, () => {
      calls++;
      return ids()();
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /128KiB/);
    assert.equal(calls, 0);
  }
  const json = JSON.stringify(input());
  assert.equal(
    parseGeneratedPlan(
      json.padEnd(128 * 1024 - new TextEncoder().encode(json).length + json.length, ' '),
      ids(),
    ).ok,
    true,
  );
});

test('중복 key와 공백·대소문자·표기 정규화 뒤 중복 제목을 거부한다', () => {
  const value = input(2);
  at(value.features, 1).key = at(value.features, 0).key;
  reject(value, /key가 중복/);
  for (const titles of [
    ['가', ' 가 '],
    ['Feature', 'feature'],
    ['Ａ', 'A'],
  ]) {
    const value = input(2);
    at(value.features, 0).title = at(titles, 0);
    at(value.features, 1).title = at(titles, 1);
    reject(value, /제목이 중복/);
  }
});

test('말단의 빈·중복·여러 줄 조건과 묶음의 완료 조건을 거부한다', () => {
  for (const criteria of [[], [''], [' '], ['확인', ' 확인 '], ['하나\n둘']])
    reject({ ...input(), features: [{ ...input().features[0], criteria }] }, /완료 조건|말단/);
  reject({ ...input(), features: [{ ...input().features[0], kind: 'group' }] }, /묶음/);
});

test('상위 경로 이동·절대 경로·예약 이름·중복·21개 경로를 거부한다', () => {
  for (const paths of [
    ['../outside'],
    ['/etc/passwd'],
    ['C:\\secret'],
    ['nul.txt'],
    ['a.ts', 'A.ts'],
    Array.from({ length: 21 }, (_, i) => `${i}.ts`),
  ])
    reject({ ...input(), features: [{ ...input().features[0], relatedPaths: paths }] }, /경로/);
});

test('상위 참조는 목록의 묶음이어야 하며 자기·순환·깊이17은 변환 전에 거부한다', () => {
  const missing = input();
  at(missing.features, 0).parentKey = 'missing';
  reject(missing, /목록에 없습니다/);
  const leaf = input(2);
  at(leaf.features, 1).parentKey = 'feature-0';
  reject(leaf, /묶음/);
  for (const count of [1, 2]) {
    const cyclic = input(count);
    for (let i = 0; i < count; i++) {
      at(cyclic.features, i).kind = 'group';
      at(cyclic.features, i).criteria = [];
      at(cyclic.features, i).parentKey = `feature-${(i + 1) % count}`;
    }
    reject(cyclic, /자기 참조|순환/);
  }
  const deep = input(17);
  deep.features.forEach((feature, i) => {
    feature.kind = 'group';
    feature.criteria = [];
    feature.parentKey = i ? `feature-${i - 1}` : null;
  });
  reject(deep, /16단계/);
  deep.features.pop();
  for (const features of [deep.features, [...deep.features].reverse()])
    assert.equal(parseGeneratedPlan(JSON.stringify({ ...deep, features }), ids()).ok, true);
});

test('선행 관계의 누락·묶음·자기·중복·순환 및 501개를 거부한다', () => {
  const value = input(3);
  const edge = { featureKey: 'feature-0', prerequisiteKey: 'feature-1' };
  reject({ ...value, dependencies: [{ ...edge, prerequisiteKey: 'missing' }] }, /목록에 없습니다/);
  reject({ ...value, dependencies: [{ ...edge, prerequisiteKey: 'feature-0' }] }, /자기 참조/);
  reject({ ...value, dependencies: [edge, edge] }, /중복/);
  reject(
    {
      ...value,
      dependencies: [
        edge,
        { featureKey: 'feature-1', prerequisiteKey: 'feature-2' },
        { featureKey: 'feature-2', prerequisiteKey: 'feature-0' },
      ],
    },
    /순환/,
  );
  const group = structuredClone(value);
  at(group.features, 1).kind = 'group';
  at(group.features, 1).criteria = [];
  reject({ ...group, dependencies: [edge] }, /말단/);
  const many = input(34);
  for (let i = 0; i < 34; i++)
    for (let j = i + 1; j < 34; j++)
      many.dependencies.push({ featureKey: `feature-${i}`, prerequisiteKey: `feature-${j}` });
  many.dependencies = many.dependencies.slice(0, 500);
  assert.equal(parseGeneratedPlan(JSON.stringify(many), ids()).ok, true);
  reject({ ...many, dependencies: [...many.dependencies, edge] }, /최대500/);
});

test('UUID 생성 실패·유효하지 않은 ID·중복 ID를 성공으로 반환하지 않는다', () => {
  for (const create of [
    () => 'invalid',
    () => ids()(),
    () => {
      throw new Error('실패');
    },
  ]) {
    const result = parseGeneratedPlan(JSON.stringify(input(2)), create);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /식별자/);
  }
  let index = 0;
  const sameDifferentCase = () => {
    index++;
    return index === 1
      ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      : 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  };
  assert.equal(parseGeneratedPlan(JSON.stringify(input(2)), sameDifferentCase).ok, false);
});

test('추가 시 기존 기능·revision·과거 검증·관계를 보존하고 초안 최상위 순서만 맞춘다', () => {
  const current = generated(2);
  at(current.features, 0).revision = 3;
  at(current.features, 0).order = 4;
  at(current.features, 1).order = 7;
  current.dependencies = [
    { featureId: at(current.features, 1).id, prerequisiteId: at(current.features, 0).id },
  ];
  current.verifications = [
    {
      id: ids(999)(),
      featureId: at(current.features, 0).id,
      featureTitle: '과거 제목',
      revision: 1,
      result: 'passed',
      observation: '예전 확인',
      evidence: '합성 검사',
      checkedCriteria: ['이전 조건'],
      createdAt: '2026-10-01T00:00:00Z',
    },
  ];
  const candidate = generated(3, 100);
  candidate.features.forEach((feature, i) => {
    feature.title = `새 기능 ${i}`;
  });
  at(candidate.features, 0).kind = 'group';
  at(candidate.features, 0).criteria = '';
  at(candidate.features, 1).parentId = at(candidate.features, 0).id;
  at(candidate.features, 1).order = 0;
  at(candidate.features, 2).included = false;
  const beforeCurrent = structuredClone(current),
    beforeCandidate = structuredClone(candidate);
  const plan = success(appendGeneratedPlan(freeze(current), freeze(candidate)));
  assert.equal(validateFeaturePlan(plan), true);
  assert.deepEqual(plan.features.slice(0, 2), beforeCurrent.features);
  assert.deepEqual(plan.verifications, beforeCurrent.verifications);
  assert.deepEqual(plan.dependencies, beforeCurrent.dependencies);
  assert.deepEqual(
    plan.features.slice(2).map((feature) => feature.order),
    [8, 0, 9],
  );
  assert.equal(at(plan.features, 4).included, false);
  present(at(plan.features, 0).relatedPaths).push('new.ts');
  at(plan.verifications, 0).checkedCriteria.push('변경');
  assert.deepEqual(current, beforeCurrent);
  assert.deepEqual(candidate, beforeCandidate);
});

test('초안 편집의 잘못된 조건·식별자 충돌·검증 기록과 총수 초과는 기존 목록을 보존한다', () => {
  const current = freeze(generated());
  const before = structuredClone(current);
  const candidate = generated(1, 100);
  at(candidate.features, 0).title = '새 기능';
  const variants = [
    { ...candidate, features: [{ ...at(candidate.features, 0), id: at(current.features, 0).id }] },
    { ...candidate, features: [{ ...at(candidate.features, 0), criteria: '' }] },
    { ...candidate, features: [{ ...at(candidate.features, 0), criteria: '확인\n확인' }] },
    { ...candidate, features: [{ ...at(candidate.features, 0), relatedPaths: ['../secret'] }] },
    {
      ...candidate,
      features: [{ ...at(candidate.features, 0), parentId: at(current.features, 0).id }],
    },
    {
      ...candidate,
      verifications: [
        {
          id: ids(999)(),
          featureId: at(candidate.features, 0).id,
          featureTitle: '새 기능',
          revision: 1,
          result: 'passed' as const,
          observation: 'AI 주장',
          evidence: 'AI 문장',
          checkedCriteria: ['직접 동작 확인'],
          createdAt: '2026-10-01T00:00:00Z',
        },
      ],
    },
  ];
  for (const value of variants) {
    const beforeCandidate = structuredClone(value);
    assert.equal(appendGeneratedPlan(current, freeze(value)).ok, false);
    assert.deepEqual(value, beforeCandidate);
    assert.deepEqual(current, before);
  }
  const many = generated(100, 100);
  many.features.forEach((feature, i) => {
    feature.title = `새 기능 ${i}`;
  });
  const result = appendGeneratedPlan(current, many);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /최대100/);
});

test('중복 제목·빈 초안·포함된 말단0개 및 순서 한계는 적용할 수 없다', () => {
  const current = generated();
  assert.equal(appendGeneratedPlan(current, generated(1, 100)).ok, false);
  assert.equal(appendGeneratedPlan(current, emptyFeaturePlan()).ok, false);
  const candidate = generated(1, 100);
  at(candidate.features, 0).title = '새 기능';
  at(candidate.features, 0).included = false;
  assert.equal(appendGeneratedPlan(current, candidate).ok, false);
  at(candidate.features, 0).included = true;
  at(current.features, 0).order = 10000;
  assert.equal(appendGeneratedPlan(current, candidate).ok, false);
  assert.equal(
    appendGeneratedPlan(
      { ...current, features: [{ ...at(current.features, 0), criteria: '' }] },
      candidate,
    ).ok,
    false,
  );
});

test('기존 계획과 초안의 관계 합계501개는 기존 관계를 바꾸지 않고 거부한다', () => {
  const source = input(34);
  for (let i = 0; i < 34; i++)
    for (let j = i + 1; j < 34; j++)
      source.dependencies.push({ featureKey: `feature-${i}`, prerequisiteKey: `feature-${j}` });
  source.dependencies = source.dependencies.slice(0, 500);
  const current = success(parseGeneratedPlan(JSON.stringify(source), ids()));
  const candidate = generated(2, 100);
  candidate.features.forEach((feature, index) => {
    feature.title = `새 기능 ${index}`;
  });
  candidate.dependencies = [
    { featureId: at(candidate.features, 1).id, prerequisiteId: at(candidate.features, 0).id },
  ];
  const before = structuredClone(current);
  const result = appendGeneratedPlan(freeze(current), freeze(candidate));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /최대500/);
  assert.deepEqual(current, before);
});
