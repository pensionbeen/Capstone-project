import { useState } from 'react';
import { descendantIds } from '../../shared/feature-editing';
import type { ProjectFeaturePlan } from '../../shared/feature-plan';
import { validRelativePath } from '../../shared/workspace-files';
import {
  canRecordVerification,
  criteriaLines,
  type Feature,
  type Verification,
  validFeature,
} from '../model';
import { Badge, Button, Icon, Modal, Notice } from './ui';

export function FeatureEditor({
  feature,
  onSave,
  onClose,
  plan,
  busy,
}: {
  feature: Feature;
  plan: ProjectFeaturePlan;
  busy: boolean;
  onSave: (value: Feature, prerequisites: string[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(feature);
  const [paths, setPaths] = useState((feature.relatedPaths ?? []).join('\n'));
  const [prerequisites, setPrerequisites] = useState(
    plan.dependencies
      .filter((edge) => edge.featureId === feature.id)
      .map((edge) => edge.prerequisiteId),
  );
  const excludedParents = descendantIds(plan, feature.id);
  const relatedPaths = paths
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const pathError =
    relatedPaths.length > 20
      ? '관련 경로는 최대 20개까지 연결할 수 있어요.'
      : relatedPaths.some((path) => !validRelativePath(path))
        ? '프로젝트 안의 상대 경로를 확인해 주세요. 상위 이동·절대 경로·특수 경로는 사용할 수 없어요.'
        : new Set(relatedPaths.map((path) => path.toLowerCase())).size !== relatedPaths.length
          ? '같은 경로가 중복됐어요. 대소문자가 달라도 하나만 적어 주세요.'
          : '';
  const valid = validFeature(draft) && !pathError;
  return (
    <Modal
      title={
        feature.title
          ? '기능과 완료 조건 수정'
          : feature.kind === 'group'
            ? '새 묶음 추가'
            : '새 기능 추가'
      }
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !busy) onSave({ ...draft, relatedPaths }, prerequisites);
        }}
        className="stack-form"
      >
        <fieldset disabled={busy} className="editor-fields stack-form">
          <div>
            <label htmlFor="feature-title" className="field-label">
              기능 이름
            </label>
            <input
              id="feature-title"
              value={draft.title}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              maxLength={80}
              required
              placeholder="예: 할 일 삭제"
            />
          </div>
          <div>
            <label htmlFor="feature-description" className="field-label">
              기능 설명
            </label>
            <textarea
              id="feature-description"
              rows={2}
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              maxLength={2000}
              placeholder="이 기능으로 무엇을 할 수 있나요?"
            />
          </div>
          <div>
            <label htmlFor="feature-parent" className="field-label">
              상위 묶음
            </label>
            <select
              id="feature-parent"
              value={draft.parentId ?? ''}
              onChange={(event) => setDraft({ ...draft, parentId: event.target.value || null })}
            >
              <option value="">최상위</option>
              {plan.features
                .filter((item) => item.kind === 'group' && !excludedParents.has(item.id))
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
            </select>
          </div>
          {draft.kind === 'leaf' && (
            <div>
              <label htmlFor="feature-criteria" className="field-label">
                완료 조건
              </label>
              <textarea
                id="feature-criteria"
                rows={5}
                value={draft.criteria}
                onChange={(event) => setDraft({ ...draft, criteria: event.target.value })}
                maxLength={2000}
                required
                placeholder={
                  '삭제한 항목이 목록에서 사라진다.\n삭제를 취소하면 기존 항목이 유지된다.'
                }
              />
              <p className="field-hint">직접 확인할 수 있는 조건을 한 줄에 하나씩 적어 주세요.</p>
            </div>
          )}
          {draft.kind === 'leaf' && (
            <fieldset className="verification-checks dependency-options">
              <legend>먼저 완료할 기능</legend>
              {plan.features
                .filter((item) => item.kind === 'leaf' && item.id !== draft.id)
                .map((item) => (
                  <label key={item.id}>
                    <input
                      type="checkbox"
                      checked={prerequisites.includes(item.id)}
                      onChange={(event) =>
                        setPrerequisites(
                          event.target.checked
                            ? [...prerequisites, item.id]
                            : prerequisites.filter((id) => id !== item.id),
                        )
                      }
                    />
                    <span>{item.title}</span>
                  </label>
                ))}
              {!plan.features.some((item) => item.kind === 'leaf' && item.id !== draft.id) && (
                <p className="field-hint">다른 기능을 추가한 뒤 연결할 수 있어요.</p>
              )}
            </fieldset>
          )}
          <div>
            <label htmlFor="feature-paths" className="field-label">
              관련 경로
            </label>
            <textarea
              id="feature-paths"
              rows={3}
              value={paths}
              onChange={(event) => setPaths(event.target.value)}
              maxLength={20020}
              placeholder={'src/App.tsx\ndocs/설명.md'}
            />
            <p className="field-hint">
              프로젝트 안의 경로를 /로 구분해 한 줄에 하나씩, 최대 20개 적어 주세요. 만들 예정인
              파일도 연결할 수 있어요.
            </p>
            {pathError && <p role="alert">{pathError}</p>}
          </div>
          <Notice>
            기능 내용·완료 조건·선행 관계·관련 경로를 바꾸면 이전 검증 결과는 이력으로 남고, 현재
            기능은 다시 검증해야 해요.
          </Notice>
          <div className="modal-actions">
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              수정 취소
            </Button>
            <Button type="submit" disabled={!valid || busy}>
              {busy ? '저장 중…' : '기능 저장'}
            </Button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}

export function WorkDetails({
  feature,
  onEdit,
  onVerify,
  onClose,
}: {
  feature: Feature;
  onEdit: () => void;
  onVerify: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title="기능 작업" onClose={onClose} drawer>
      <Badge>AI 연결 전</Badge>
      <h3 className="detail-title">{feature.title}</h3>
      <p className="detail-description">{feature.description}</p>
      <div className="section-block">
        <div className="section-heading">
          <h3>완료 조건</h3>
          <button type="button" className="text-button" onClick={onEdit}>
            <Icon name="edit" size={15} />
            수정
          </button>
        </div>
        <ul className="criteria-list">
          {criteriaLines(feature.criteria).map((criterion) => (
            <li key={criterion}>
              <span className="empty-checkbox" />
              {criterion}
            </li>
          ))}
        </ul>
      </div>
      <details className="advanced" open>
        <summary>
          AI에 전달할 작업 내용
          <Icon name="down" size={16} />
        </summary>
        <div className="prompt-preview">
          <p>{feature.title} 기능을 구현해 주세요.</p>
          <p>{feature.description}</p>
          <p>완료 조건</p>
          <ul>
            {criteriaLines(feature.criteria).map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
        </div>
      </details>
      <Notice>
        기능별 AI 실행은 아직 연결되지 않았어요. 지금은 작업 내용과 검증 흐름을 확인할 수 있어요.
      </Notice>
      <div className="drawer-actions">
        <Button disabled icon="play">
          AI 실행 준비 중
        </Button>
        <Button variant="secondary" onClick={onVerify}>
          직접 확인한 결과 기록
        </Button>
      </div>
    </Modal>
  );
}

export function VerificationEditor({
  features,
  initialId,
  onSave,
  onClose,
  busy = false,
}: {
  features: Feature[];
  initialId?: string;
  onSave: (record: Omit<Verification, 'id' | 'createdAt' | 'featureTitle'>) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const [featureId, setFeatureId] = useState(initialId ?? features[0]?.id ?? '');
  const [result, setResult] = useState<'passed' | 'failed'>('passed');
  const [checks, setChecks] = useState<string[]>([]);
  const [observation, setObservation] = useState('');
  const [evidence, setEvidence] = useState('');
  const feature = features.find((item) => item.id === featureId);
  const record = { result, checkedCriteria: checks, observation, evidence };
  return (
    <Modal title="검증 결과 기록" onClose={onClose} busy={busy}>
      <form
        className="stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && feature && canRecordVerification(feature, record))
            onSave({ ...record, featureId, revision: feature.revision });
        }}
      >
        <fieldset disabled={busy} className="editor-fields stack-form">
          <div>
            <label htmlFor="verify-feature" className="field-label">
              확인한 기능
            </label>
            <select
              id="verify-feature"
              value={featureId}
              onChange={(event) => {
                setFeatureId(event.target.value);
                setResult('passed');
                setChecks([]);
                setObservation('');
                setEvidence('');
              }}
              required
            >
              {features.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="verification-checks">
            <legend>직접 확인한 완료 조건</legend>
            {feature &&
              criteriaLines(feature.criteria).map((criterion) => (
                <label key={criterion}>
                  <input
                    type="checkbox"
                    checked={checks.includes(criterion)}
                    onChange={(event) =>
                      setChecks(
                        event.target.checked
                          ? [...checks, criterion]
                          : checks.filter((value) => value !== criterion),
                      )
                    }
                  />
                  <span>{criterion}</span>
                </label>
              ))}
          </fieldset>
          <fieldset className="inline-checks">
            <legend>검증 결과</legend>
            <label>
              <input
                type="radio"
                name="result"
                checked={result === 'passed'}
                onChange={() => setResult('passed')}
              />
              모든 조건 통과
            </label>
            <label>
              <input
                type="radio"
                name="result"
                checked={result === 'failed'}
                onChange={() => setResult('failed')}
              />
              수정 필요
            </label>
          </fieldset>
          <div>
            <label htmlFor="verify-observation" className="field-label">
              실제 확인한 결과
            </label>
            <textarea
              id="verify-observation"
              rows={3}
              value={observation}
              onChange={(event) => setObservation(event.target.value)}
              maxLength={1500}
              required
              placeholder="어떤 동작을 했고, 어떤 결과가 나왔나요?"
            />
          </div>
          <div>
            <label htmlFor="verify-evidence" className="field-label">
              검증 근거
            </label>
            <input
              id="verify-evidence"
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
              maxLength={500}
              required
              placeholder="예: 테스트 결과 또는 캡처를 보관한 위치"
            />
            <p className="field-hint">
              근거의 설명을 기록해요. 파일을 업로드하거나 자동 확인하지 않아요.
            </p>
          </div>
          <div className="modal-actions">
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              기록 취소
            </Button>
            <Button
              type="submit"
              disabled={busy || !feature || !canRecordVerification(feature, record)}
            >
              검증 결과 저장
            </Button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
