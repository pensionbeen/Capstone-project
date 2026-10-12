import type {
  GeneratedFeatureInput,
  GeneratedPlanInput,
  GeneratedPlanResult,
} from './feature-generation-contract.js';
import {
  type ProjectFeaturePlan,
  type StoredFeature,
  validateFeaturePlan,
} from './feature-plan.js';
import { criteriaLines } from './verification.js';
import { validRelativePath } from './workspace-files.js';

const MAX_RESPONSE_BYTES = 128 * 1024;
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const featureKeys = [
  'key',
  'parentKey',
  'kind',
  'title',
  'description',
  'criteria',
  'relatedPaths',
];
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const generationPrompt = `정리한 요구사항을 구현 가능한 기능 초안으로 만들어 주세요.
응답은 설명이나 Markdown 없이 다음 구조의 JSON 객체 하나만 출력합니다.
{"features":[{"key":"feature-1","parentKey":null,"kind":"leaf","title":"기능 제목","description":"설명","criteria":["직접 확인할 완료 조건"],"relatedPaths":[]}],"dependencies":[]}
모든 필드는 필수이며 위에 없는 필드를 넣지 마세요. features는 1~100개, dependencies는 0~500개입니다.
key는 영문/숫자로 시작하는 영문/숫자/밑줄/하이픈 1~80자이며 서로 달라야 합니다.
parentKey는 최상위일 때 null, 나머지는 같은 응답의 group key입니다. 트리 깊이는 최대16입니다.
kind는 group 또는 leaf입니다. title은 빈 값 없이 최대80자이며 중복하지 마세요.
description은 최대2000자입니다. group의 criteria는 빈 배열, leaf의 criteria는 서로 다른 한 줄 조건 1~100개입니다. 조건을 줄바꿈으로 합친 길이는 최대2000자입니다.
relatedPaths는 최대20개의 중복 없는 프로젝트 상대 경로입니다. 절대 경로와 상위 이동(..)은 금지합니다.
dependencies는 leaf끼리만 연결하며 자기 참조, 중복, 순환을 만들지 마세요.
선행 관계의 형식은 {"featureKey":"후속 기능 key","prerequisiteKey":"먼저 할 기능 key"}입니다.
UUID, 검증 기록, 완료 상태, revision, included를 생성하지 마세요. AI의 제안은 사용자 검토 전까지 초안입니다.`;

function fail(message: string): GeneratedPlanResult {
  return { ok: false, message };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: unknown, expected: string[], label: string): string | null {
  if (!record(value)) return `${label}은 JSON 객체여야 합니다.`;
  const keys = Object.keys(value);
  if (keys.some((key) => forbiddenKeys.has(key))) return `${label}에 금지된 특수 필드가 있습니다.`;
  if (expected.some((key) => !Object.hasOwn(value, key)))
    return `${label}의 필수 필드가 누락되었습니다.`;
  if (keys.some((key) => !expected.includes(key)))
    return `${label}에 허용하지 않는 필드가 있습니다.`;
  return null;
}

function validText(value: unknown, max: number, required = false): value is string {
  return (
    typeof value === 'string' &&
    value.length <= max &&
    (!required || value.trim().length > 0) &&
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 || character === '\n' || character === '\t',
    )
  );
}

function titleKey(title: string): string {
  return title.normalize('NFKC').trim().toLowerCase();
}

function validKey(value: unknown): value is string {
  return typeof value === 'string' && identifier.test(value) && !forbiddenKeys.has(value);
}

/** JSON.parse accepts repeated object members; refuse that ambiguous input before conversion. */
function hasRepeatedJsonKeys(source: string): boolean {
  let cursor = 0;
  const whitespace = () => {
    while (/\s/u.test(source[cursor] ?? '') && cursor < source.length) cursor++;
  };
  const string = (): string => {
    const start = cursor++;
    while (source[cursor] !== '"') {
      if (source[cursor] === '\\') cursor++;
      cursor++;
    }
    cursor++;
    return JSON.parse(source.slice(start, cursor)) as string;
  };
  const value = (): boolean => {
    whitespace();
    if (source[cursor] === '{') {
      cursor++;
      whitespace();
      const keys = new Set<string>();
      while (source[cursor] !== '}') {
        const key = string();
        if (keys.has(key)) return true;
        keys.add(key);
        whitespace();
        cursor++;
        if (value()) return true;
        whitespace();
        if (source[cursor] !== ',') break;
        cursor++;
        whitespace();
      }
      cursor++;
    } else if (source[cursor] === '[') {
      cursor++;
      whitespace();
      while (source[cursor] !== ']') {
        if (value()) return true;
        whitespace();
        if (source[cursor] !== ',') break;
        cursor++;
      }
      cursor++;
    } else if (source[cursor] === '"') string();
    else while (cursor < source.length && !/[\s,}\]]/u.test(source[cursor] ?? '')) cursor++;
    return false;
  };
  return value();
}

function inspectInput(value: unknown): string | null {
  const topError = exactKeys(value, ['features', 'dependencies'], '응답');
  if (topError) return topError;
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.features) || input.features.length < 1 || input.features.length > 100)
    return '기능 목록은 1~100개의 배열이어야 합니다.';
  if (!Array.isArray(input.dependencies) || input.dependencies.length > 500)
    return '선행 관계 목록은 최대500개의 배열이어야 합니다.';
  const keys = new Set<string>();
  const titles = new Set<string>();
  for (const [index, item] of input.features.entries()) {
    const label = `${index + 1}번째 기능`;
    const error = exactKeys(item, featureKeys, label);
    if (error) return error;
    const feature = item as Record<string, unknown>;
    if (!validKey(feature.key))
      return `${label}의 key는 안전한 영문/숫자 식별자 1~80자여야 합니다.`;
    if (keys.has(feature.key)) return '기능 key가 중복되었습니다.';
    keys.add(feature.key);
    if (!(feature.parentKey === null || validKey(feature.parentKey)))
      return `${label}의 parentKey는 null 또는 안전한 기능 key여야 합니다.`;
    if (!(feature.kind === 'group' || feature.kind === 'leaf'))
      return `${label}의 종류가 잘못되었습니다.`;
    if (!validText(feature.title, 80, true))
      return `${label}의 제목은 빈 값 없이 최대80자여야 합니다.`;
    const title = titleKey(feature.title);
    if (titles.has(title)) return '기능 제목이 중복되었습니다.';
    titles.add(title);
    if (!validText(feature.description, 2000))
      return `${label}의 설명은 문자열이며 최대2000자여야 합니다.`;
    if (
      !Array.isArray(feature.criteria) ||
      feature.criteria.length > 100 ||
      feature.criteria.some((entry) => !validText(entry, 2000, true) || entry.includes('\n'))
    )
      return `${label}의 완료 조건은 최대100개의 비어 있지 않은 한 줄 문자열 배열이어야 합니다.`;
    const criteria = feature.criteria as string[];
    if (new Set(criteria.map((entry) => entry.trim())).size !== criteria.length)
      return `${label}의 완료 조건이 중복되었습니다.`;
    if (criteria.join('\n').length > 2000)
      return `${label}의 완료 조건 합계는 최대2000자여야 합니다.`;
    if (feature.kind === 'group' ? criteria.length !== 0 : criteria.length === 0)
      return `${label}은 묶음이면 조건이 없어야 하고 말단이면 완료 조건이 있어야 합니다.`;
    if (
      !Array.isArray(feature.relatedPaths) ||
      feature.relatedPaths.length > 20 ||
      feature.relatedPaths.some((path) => !validRelativePath(path))
    )
      return `${label}의 관련 경로는 최대20개의 안전한 프로젝트 상대 경로 배열이어야 합니다.`;
    if (
      new Set((feature.relatedPaths as string[]).map((path) => path.toLowerCase())).size !==
      feature.relatedPaths.length
    )
      return `${label}의 관련 경로가 중복되었습니다.`;
  }
  for (const item of input.dependencies) {
    const error = exactKeys(item, ['featureKey', 'prerequisiteKey'], '선행 관계');
    if (error) return error;
    const edge = item as Record<string, unknown>;
    if (!validKey(edge.featureKey) || !validKey(edge.prerequisiteKey))
      return '선행 관계의 기능 key가 잘못되었습니다.';
  }
  return null;
}

function inspectGraph(input: GeneratedPlanInput): string | null {
  const byKey = new Map(input.features.map((feature) => [feature.key, feature]));
  for (const feature of input.features) {
    let item: GeneratedFeatureInput | undefined = feature;
    const ancestors = new Set<string>();
    while (item) {
      if (ancestors.has(item.key)) return '기능의 상위 관계에 자기 참조 또는 순환이 있습니다.';
      ancestors.add(item.key);
      if (ancestors.size > 16) return '기능 트리의 깊이는 최대16단계여야 합니다.';
      if (item.parentKey === null) break;
      const parent = byKey.get(item.parentKey);
      if (!parent) return '기능의 상위 key가 목록에 없습니다.';
      if (parent.kind !== 'group') return '기능의 상위 항목은 묶음(group)이어야 합니다.';
      item = parent;
    }
  }
  const edges = new Map<string, string[]>();
  const pairs = new Set<string>();
  for (const edge of input.dependencies) {
    if (edge.featureKey === edge.prerequisiteKey) return '선행 관계에 자기 참조가 있습니다.';
    const feature = byKey.get(edge.featureKey);
    const prerequisite = byKey.get(edge.prerequisiteKey);
    if (!feature || !prerequisite) return '선행 관계의 key가 기능 목록에 없습니다.';
    if (feature.kind !== 'leaf' || prerequisite.kind !== 'leaf')
      return '선행 관계는 말단(leaf) 기능끼리만 연결할 수 있습니다.';
    const pair = `${edge.featureKey}:${edge.prerequisiteKey}`;
    if (pairs.has(pair)) return '선행 관계가 중복되었습니다.';
    pairs.add(pair);
    edges.set(edge.featureKey, [...(edges.get(edge.featureKey) ?? []), edge.prerequisiteKey]);
  }
  const active = new Set<string>();
  const done = new Set<string>();
  const visit = (key: string): boolean => {
    if (active.has(key)) return false;
    if (done.has(key)) return true;
    active.add(key);
    for (const next of edges.get(key) ?? []) if (!visit(next)) return false;
    active.delete(key);
    done.add(key);
    return true;
  };
  for (const key of edges.keys()) if (!visit(key)) return '선행 관계에 순환이 있습니다.';
  return null;
}

/** Convert only fully inspected AI keys into application-owned IDs and initial state. */
export function parseGeneratedPlan(text: string, createId: () => string): GeneratedPlanResult {
  if (
    typeof text !== 'string' ||
    text.length > MAX_RESPONSE_BYTES ||
    new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES
  )
    return fail('AI 응답은 최대128KiB의 문자열이어야 합니다.');
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(trimmed);
  const source = fence ? (fence[1] ?? '') : trimmed;
  let value: unknown;
  try {
    value = JSON.parse(source);
    if (hasRepeatedJsonKeys(source)) return fail('JSON 객체의 필드 이름이 중복되었습니다.');
  } catch {
    return fail('AI 응답은 설명 없이 올바른 JSON 객체 하나여야 합니다.');
  }
  const error = inspectInput(value);
  if (error) return fail(error);
  const input = value as GeneratedPlanInput;
  const graphError = inspectGraph(input);
  if (graphError) return fail(graphError);
  const ids = new Map<string, string>();
  const usedIds = new Set<string>();
  try {
    for (const feature of input.features) {
      const id = createId();
      if (typeof id !== 'string' || !uuid.test(id) || usedIds.has(id.toLowerCase()))
        return fail('새 기능 식별자는 서로 다른 UUID여야 합니다.');
      ids.set(feature.key, id);
      usedIds.add(id.toLowerCase());
    }
  } catch {
    return fail('새 기능 식별자를 만들지 못했습니다. 다시 시도해 주세요.');
  }
  const orders = new Map<string | null, number>();
  const features: StoredFeature[] = input.features.map((feature) => {
    const order = orders.get(feature.parentKey) ?? 0;
    orders.set(feature.parentKey, order + 1);
    return {
      id: ids.get(feature.key) as string,
      parentId: feature.parentKey === null ? null : (ids.get(feature.parentKey) as string),
      kind: feature.kind,
      title: feature.title.trim(),
      description: feature.description,
      criteria: feature.criteria.map((entry) => entry.trim()).join('\n'),
      relatedPaths: [...feature.relatedPaths],
      included: true,
      revision: 1,
      order,
    };
  });
  const plan: ProjectFeaturePlan = {
    features,
    dependencies: input.dependencies.map((edge) => ({
      featureId: ids.get(edge.featureKey) as string,
      prerequisiteId: ids.get(edge.prerequisiteKey) as string,
    })),
    verifications: [],
  };
  return validateFeaturePlan(plan)
    ? { ok: true, plan }
    : fail('생성한 기능 계획이 저장 규칙에 맞지 않습니다.');
}

/** Prepare an additive save without sharing mutable arrays or altering existing history. */
export function appendGeneratedPlan(
  current: ProjectFeaturePlan,
  candidate: ProjectFeaturePlan,
): GeneratedPlanResult {
  if (!validateFeaturePlan(current)) return fail('기존 기능 계획이 저장 규칙에 맞지 않습니다.');
  if (!validateFeaturePlan(candidate))
    return fail('편집한 기능 초안의 조건·경로·관계가 저장 규칙에 맞지 않습니다.');
  if (!candidate.features.length) return fail('추가할 기능이 없습니다.');
  if (!candidate.features.some((feature) => feature.kind === 'leaf' && feature.included))
    return fail('초안에 포함된 말단 기능이 하나 이상 있어야 합니다.');
  if (candidate.verifications.length) return fail('기능 초안에는 검증 기록을 넣을 수 없습니다.');
  if (current.features.length + candidate.features.length > 100)
    return fail('추가 후 기능은 최대100개여야 합니다.');
  if (current.dependencies.length + candidate.dependencies.length > 500)
    return fail('추가 후 선행 관계는 최대500개여야 합니다.');
  const currentIds = new Set(current.features.map((feature) => feature.id.toLowerCase()));
  const candidateIds = new Set<string>();
  const titles = new Set(current.features.map((feature) => titleKey(feature.title)));
  for (const feature of candidate.features) {
    if (currentIds.has(feature.id.toLowerCase()))
      return fail('새 기능 식별자가 기존 기능과 충돌합니다.');
    if (candidateIds.has(feature.id.toLowerCase())) return fail('새 기능 식별자가 중복되었습니다.');
    candidateIds.add(feature.id.toLowerCase());
    const title = titleKey(feature.title);
    if (titles.has(title)) return fail('새 기능 제목이 기존 기능 또는 다른 초안과 중복되었습니다.');
    titles.add(title);
    const lines = feature.criteria.split('\n').map((line) => line.trim());
    if (
      feature.kind === 'leaf' &&
      (lines.length > 100 ||
        lines.some((line) => !line) ||
        criteriaLines(feature.criteria).length !== lines.length)
    )
      return fail('말단 기능의 완료 조건은 중복 없는 비어 있지 않은 최대100줄이어야 합니다.');
  }
  const roots = candidate.features
    .filter((feature) => feature.parentId === null)
    .sort((a, b) => a.order - b.order);
  const firstOrder =
    Math.max(
      -1,
      ...current.features
        .filter((feature) => feature.parentId === null)
        .map((feature) => feature.order),
    ) + 1;
  if (firstOrder + roots.length - 1 > 10000)
    return fail('기존 최상위 기능 뒤에 초안을 추가할 순서 공간이 없습니다.');
  const rootOrders = new Map(roots.map((feature, index) => [feature.id, firstOrder + index]));
  const plan: ProjectFeaturePlan = {
    features: [
      ...structuredClone(current.features),
      ...structuredClone(candidate.features).map((feature) => ({
        ...feature,
        order: rootOrders.get(feature.id) ?? feature.order,
      })),
    ],
    dependencies: structuredClone([...current.dependencies, ...candidate.dependencies]),
    verifications: structuredClone(current.verifications),
  };
  return validateFeaturePlan(plan)
    ? { ok: true, plan }
    : fail('추가한 기능 계획이 저장 규칙에 맞지 않습니다.');
}
