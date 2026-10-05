import type { StoredFeature } from '../shared/feature-plan';

export type Step = 0 | 1 | 2 | 3;
export type View = 'overview' | 'features' | 'verification' | 'protection' | 'transfer' | 'history';
export type Provider = 'Codex' | 'Gemini';
export type EventKind = 'feature' | 'settings' | 'verification';

export interface Project {
  desktopId?: string;
  name: string;
  path: string;
  sample: boolean;
}

export type Feature = StoredFeature;

export interface Verification {
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

export interface Activity {
  id: string;
  kind: EventKind;
  title: string;
  detail: string;
  createdAt: string;
}

export interface ProtectionDraft {
  paths: string[];
  read: boolean;
  write: boolean;
  remove: boolean;
}

export const steps = ['프로젝트 선택', 'AI 연결·보호 설정', '요구분석', '기능 확정'] as const;
export const sampleProject: Project = {
  name: '나의 할 일 관리 앱',
  path: '예시 프로젝트 / todo-app',
  sample: true,
};
export const initialProtection: ProtectionDraft = {
  paths: ['.env', 'secrets/'],
  read: true,
  write: true,
  remove: true,
};

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

export function validFeature(feature: Feature): boolean {
  return (
    feature.title.trim().length > 0 &&
    feature.title.length <= 80 &&
    (feature.kind === 'group'
      ? !feature.criteria.trim()
      : criteriaLines(feature.criteria).length > 0) &&
    feature.criteria.length <= 2000
  );
}

export function editFeature(
  feature: Feature,
  update: Pick<Feature, 'title' | 'description' | 'criteria'>,
): Feature {
  const changed =
    feature.title !== update.title ||
    feature.description !== update.description ||
    feature.criteria !== update.criteria;
  return { ...feature, ...update, revision: feature.revision + (changed ? 1 : 0) };
}

export function featureState(
  feature: Feature,
  records: Verification[],
): 'ready' | 'passed' | 'failed' | 'stale' {
  const history = records.filter((record) => record.featureId === feature.id);
  const current = history.filter((record) => record.revision === feature.revision).at(-1);
  if (current) return current.result;
  return history.length ? 'stale' : 'ready';
}

export function progress(features: Feature[], records: Verification[]) {
  const included = features.filter((feature) => feature.included && feature.kind === 'leaf');
  const done = included.filter((feature) => featureState(feature, records) === 'passed').length;
  return {
    total: included.length,
    done,
    percent: included.length ? Math.round((done / included.length) * 100) : null,
  };
}

export function canRecordVerification(
  feature: Feature,
  record: Pick<Verification, 'result' | 'observation' | 'evidence' | 'checkedCriteria'>,
): boolean {
  if (
    feature.kind !== 'leaf' ||
    !validFeature(feature) ||
    !record.observation.trim() ||
    !record.evidence.trim()
  )
    return false;
  return (
    record.result === 'failed' ||
    criteriaLines(feature.criteria).every((criterion) => record.checkedCriteria.includes(criterion))
  );
}

export function validProtectionPath(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 200 &&
    !/[:*?<>"|]/.test(trimmed) &&
    ![...trimmed].some((character) => character.charCodeAt(0) < 32) &&
    !/^[\\/]/.test(trimmed) &&
    !trimmed.split(/[\\/]/).some((part) => part === '..' || part === '.')
  );
}

export function makeDrafts(topic: string, scope: string[]): Feature[] {
  const noun = /할\s?일|todo/i.test(topic)
    ? '할 일'
    : /학습|공부/.test(topic)
      ? '학습 기록'
      : /팀|과제/.test(topic)
        ? '과제'
        : '항목';
  const drafts = [
    {
      id: 'create',
      title: `${noun} 추가·수정`,
      description: `필요한 ${noun}을 만들고 내용을 수정할 수 있어요.`,
      criteria: `제목을 입력하면 새 ${noun}이 목록에 표시된다.\n내용을 수정하면 변경한 값이 반영된다.\n제목이 비어 있으면 저장하지 않고 안내한다.`,
    },
    {
      id: 'search',
      title: `${noun} 목록·검색`,
      description: '목록을 한눈에 보고 필요한 내용을 빠르게 찾아요.',
      criteria:
        '추가한 항목을 목록에서 확인할 수 있다.\n검색어에 맞는 항목만 표시된다.\n검색 결과가 없으면 빈 상태를 안내한다.',
    },
    {
      id: 'progress',
      title: '상태와 진행률 확인',
      description: '진행 중인 일과 완료한 일을 구분해요.',
      criteria:
        '사용자가 항목의 상태를 변경할 수 있다.\n전체 항목 중 완료한 비율이 정확하게 표시된다.\n항목이 없으면 진행률을 100%로 표시하지 않는다.',
    },
    {
      id: 'storage',
      title: '데이터 저장·복원',
      description: '다시 실행해도 작성한 내용을 이어서 볼 수 있어요.',
      criteria:
        '앱을 종료하고 다시 실행하면 저장한 내용이 복원된다.\n저장에 실패하면 기존 내용을 보존하고 오류를 안내한다.',
    },
  ];
  return drafts
    .filter((item) => item.id === 'create' || scope.includes(item.id))
    .map((item, order) => ({
      ...item,
      included: true,
      revision: 1,
      kind: 'leaf',
      parentId: null,
      order,
    }));
}

export const stateLabels = {
  ready: '시작 전',
  passed: '검증 완료',
  failed: '수정 필요',
  stale: '재검증 필요',
} as const;

export function formatTime(value: string) {
  return new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
