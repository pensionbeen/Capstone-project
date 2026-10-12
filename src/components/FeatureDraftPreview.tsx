import { useId, useState } from 'react';
import {
  descendantIds,
  featureRows,
  removePlanFeature,
  updatePlanFeature,
} from '../../shared/feature-editing';
import type { FeatureDraftPreviewProps } from '../../shared/feature-generation-contract';
import {
  type ProjectFeaturePlan,
  type StoredFeature,
  validateFeaturePlan,
} from '../../shared/feature-plan';
import { criteriaLines } from '../../shared/verification';
import { validRelativePath } from '../../shared/workspace-files';
import { Badge, Button, EmptyState, Icon, Modal, Notice } from './ui';
import './feature-draft-preview.css';

function DraftEditor({
  feature,
  plan,
  busy,
  onChange,
  onClose,
}: {
  feature: StoredFeature;
  plan: ProjectFeaturePlan;
  busy: boolean;
  onChange: (plan: ProjectFeaturePlan) => void;
  onClose: () => void;
}) {
  const fieldId = useId();
  const [draft, setDraft] = useState(feature);
  const [paths, setPaths] = useState((feature.relatedPaths ?? []).join('\n'));
  const [prerequisites, setPrerequisites] = useState(
    plan.dependencies
      .filter((edge) => edge.featureId === feature.id)
      .map((edge) => edge.prerequisiteId),
  );
  const [error, setError] = useState('');
  const excludedParents = descendantIds(plan, feature.id);
  const relatedPaths = paths
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const valid =
    draft.title.trim().length > 0 &&
    (draft.kind === 'group' || criteriaLines(draft.criteria).length > 0) &&
    relatedPaths.length <= 20 &&
    relatedPaths.every((path) => validRelativePath(path)) &&
    new Set(relatedPaths.map((path) => path.toLowerCase())).size === relatedPaths.length;
  const updateDraft = (value: Partial<StoredFeature>) => {
    setDraft({ ...draft, ...value });
    setError('');
  };
  return (
    <Modal title={feature.title ? '초안 수정' : '초안에 직접 추가'} busy={busy} onClose={onClose}>
      <form
        className="stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !valid) return;
          try {
            const candidate = updatePlanFeature(plan, { ...draft, relatedPaths }, prerequisites);
            onChange(candidate);
            onClose();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : '초안 내용을 확인해 주세요.');
          }
        }}
      >
        <Notice>여기서 바꾼 내용은 초안에만 반영돼요. 전체 초안을 적용해야 저장돼요.</Notice>
        {error && (
          <p className="feature-draft-error" role="alert">
            {error}
          </p>
        )}
        <fieldset className="editor-fields stack-form" disabled={busy}>
          <div>
            <label className="field-label" htmlFor={`${fieldId}-title`}>
              기능 이름
            </label>
            <input
              id={`${fieldId}-title`}
              value={draft.title}
              maxLength={80}
              required
              onChange={(event) => updateDraft({ title: event.target.value })}
              placeholder={draft.kind === 'group' ? '예: 계정 관리' : '예: 로그인'}
            />
          </div>
          <div>
            <label className="field-label" htmlFor={`${fieldId}-description`}>
              기능 설명
            </label>
            <textarea
              id={`${fieldId}-description`}
              value={draft.description}
              rows={3}
              maxLength={2000}
              onChange={(event) => updateDraft({ description: event.target.value })}
            />
          </div>
          <div>
            <label className="field-label" htmlFor={`${fieldId}-parent`}>
              상위 묶음
            </label>
            <select
              id={`${fieldId}-parent`}
              value={draft.parentId ?? ''}
              onChange={(event) => updateDraft({ parentId: event.target.value || null })}
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
            <>
              <div>
                <label className="field-label" htmlFor={`${fieldId}-criteria`}>
                  완료 조건
                </label>
                <textarea
                  id={`${fieldId}-criteria`}
                  value={draft.criteria}
                  rows={5}
                  maxLength={2000}
                  required
                  onChange={(event) => updateDraft({ criteria: event.target.value })}
                  placeholder="직접 확인할 수 있는 조건을 한 줄에 하나씩 적어 주세요."
                />
                <p className="field-hint">AI의 완료 주장과 실제 동작 확인은 별개예요.</p>
              </div>
              <fieldset className="verification-checks dependency-options">
                <legend>먼저 완료할 기능</legend>
                {plan.features
                  .filter((item) => item.kind === 'leaf' && item.id !== draft.id)
                  .map((item) => (
                    <label key={item.id}>
                      <input
                        type="checkbox"
                        checked={prerequisites.includes(item.id)}
                        onChange={(event) => {
                          setPrerequisites(
                            event.target.checked
                              ? [...prerequisites, item.id]
                              : prerequisites.filter((id) => id !== item.id),
                          );
                          setError('');
                        }}
                      />
                      <span>
                        {item.title}
                        {!item.included && ' (제외됨)'}
                      </span>
                    </label>
                  ))}
                {!plan.features.some((item) => item.kind === 'leaf' && item.id !== draft.id) && (
                  <p className="field-hint">다른 기능을 추가한 뒤 연결할 수 있어요.</p>
                )}
              </fieldset>
            </>
          )}
          <div>
            <label className="field-label" htmlFor={`${fieldId}-paths`}>
              관련 경로
            </label>
            <textarea
              id={`${fieldId}-paths`}
              value={paths}
              rows={2}
              maxLength={20020}
              onChange={(event) => {
                setPaths(event.target.value);
                setError('');
              }}
              placeholder={'src/App.tsx\ndocs/설명.md'}
            />
            <p className="field-hint">
              프로젝트 안의 상대 경로를 한 줄에 하나씩, 최대 20개 적어 주세요. 중복·상위 이동·절대
              경로는 사용할 수 없어요.
            </p>
          </div>
          <div className="modal-actions">
            <Button variant="ghost" onClick={onClose}>
              수정 취소
            </Button>
            <Button type="submit" disabled={!valid}>
              초안에 반영
            </Button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}

export function FeatureDraftPreview({
  plan,
  busy,
  error,
  onChange,
  onApply,
  onCancel,
}: FeatureDraftPreviewProps) {
  const headingId = useId();
  const [editing, setEditing] = useState<StoredFeature | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [localError, setLocalError] = useState('');
  const valid = validateFeaturePlan(plan) && plan.verifications.length === 0;
  const includedCount = plan.features.filter(
    (item) => item.kind === 'leaf' && item.included,
  ).length;
  const excludedCount = plan.features.filter(
    (item) => item.kind === 'leaf' && !item.included,
  ).length;
  const rows = valid ? featureRows(plan) : [];
  const removing = plan.features.find((item) => item.id === removingId);
  const removeCount = removing ? descendantIds(plan, removing.id).size : 0;
  const change = (candidate: ProjectFeaturePlan) => {
    if (busy) return;
    if (!validateFeaturePlan(candidate) || candidate.verifications.length !== 0) {
      setLocalError('기능 내용과 관계를 확인해 주세요. 검증 기록은 초안에 담을 수 없어요.');
      return;
    }
    setLocalError('');
    onChange(candidate);
  };
  const add = (kind: 'leaf' | 'group') => {
    if (busy || !valid || plan.features.length >= 100) return;
    setEditing({
      id: crypto.randomUUID(),
      parentId: null,
      kind,
      title: '',
      description: '',
      criteria: '',
      included: true,
      revision: 1,
      order: 0,
      relatedPaths: [],
    });
  };
  return (
    <section className="feature-draft-preview" aria-labelledby={headingId} aria-busy={busy}>
      <header className="feature-draft-heading">
        <div>
          <p className="eyebrow">AI가 제안한 기능</p>
          <h2 id={headingId}>기능 초안 미리보기</h2>
        </div>
        <Badge>아직 저장되지 않음</Badge>
      </header>
      <p className="feature-draft-intro">
        이름과 완료 조건을 확인하고 수정해 주세요. 적용하면 기존 기능 목록에 새 기능을 추가해요.
      </p>
      <Notice>
        AI가 완료했다고 말해도 실제 검증은 아니에요. 이 초안에는 검증 결과나 진행률이 없어요.
      </Notice>
      <p className="field-hint">
        제외한 기능도 목록에 저장되며 진행률 계산에서만 빠져요. 초안에서 빼려면 삭제해 주세요.
      </p>
      {busy && (
        <p className="feature-draft-status" role="status">
          처리 중이에요. 잠시 기다려 주세요.
        </p>
      )}
      {error && (
        <p className="feature-draft-error" role="alert">
          {error}
        </p>
      )}
      {localError && (
        <p className="feature-draft-error" role="alert">
          {localError}
        </p>
      )}
      {!valid && (
        <p className="feature-draft-error" role="alert">
          초안의 기능 내용이나 관계가 올바르지 않아요. 초안을 취소하고 다시 생성해 주세요. 기존 기능
          목록은 유지돼요.
        </p>
      )}
      <div className="feature-draft-toolbar">
        <p aria-live="polite">
          포함 기능 {includedCount}개 · 제외 기능 {excludedCount}개 · 묶음{' '}
          {plan.features.filter((item) => item.kind === 'group').length}개
        </p>
        <div className="feature-draft-actions">
          <Button
            variant="secondary"
            icon="plus"
            disabled={busy || !valid || plan.features.length >= 100}
            onClick={() => add('leaf')}
          >
            기능 직접 추가
          </Button>
          <Button
            variant="ghost"
            disabled={busy || !valid || plan.features.length >= 100}
            onClick={() => add('group')}
          >
            묶음 추가
          </Button>
        </div>
      </div>
      {valid && plan.features.length === 0 && (
        <EmptyState
          icon="list"
          title="초안에 기능이 없어요"
          description="기능을 직접 추가하거나 초안을 취소한 뒤 다시 생성해 주세요."
        />
      )}
      {valid && plan.features.length > 0 && includedCount === 0 && (
        <p className="feature-draft-status" role="status">
          적용하려면 포함된 기능이 최소 1개 필요해요. 기능을 추가하거나 제외한 기능을 다시 포함해
          주세요.
        </p>
      )}
      {plan.features.length >= 100 && (
        <p className="field-hint">
          초안은 기능과 묶음을 합쳐 최대 100개예요. 항목을 삭제한 뒤 추가할 수 있어요.
        </p>
      )}
      <div className="feature-draft-list">
        {rows.map(({ feature, depth }) => {
          const prerequisites = plan.dependencies
            .filter((edge) => edge.featureId === feature.id)
            .map((edge) => plan.features.find((item) => item.id === edge.prerequisiteId));
          return (
            <article
              className={`feature-draft-row ${!feature.included && feature.kind === 'leaf' ? 'feature-draft-excluded' : ''}`}
              key={feature.id}
            >
              <div className="feature-draft-row-heading">
                <div className="feature-draft-title">
                  <Icon name={feature.kind === 'group' ? 'folder' : 'list'} size={18} />
                  <h3>{feature.title}</h3>
                  <Badge>
                    {feature.kind === 'group' ? '묶음' : feature.included ? '포함' : '제외'}
                  </Badge>
                </div>
                <div className="feature-draft-row-actions">
                  {feature.kind === 'leaf' && (
                    <label className="feature-draft-include">
                      <input
                        type="checkbox"
                        aria-label={`${feature.title} 포함`}
                        checked={feature.included}
                        disabled={busy}
                        onChange={(event) =>
                          change({
                            ...plan,
                            features: plan.features.map((item) =>
                              item.id === feature.id
                                ? { ...item, included: event.target.checked }
                                : item,
                            ),
                          })
                        }
                      />
                      <span>포함</span>
                    </label>
                  )}
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    aria-label={`${feature.title} 초안 수정`}
                    onClick={() => setEditing(feature)}
                  >
                    <Icon name="edit" size={15} />
                    수정
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    aria-label={`${feature.title} 초안 삭제`}
                    onClick={() => setRemovingId(feature.id)}
                  >
                    <Icon name="trash" size={15} />
                    삭제
                  </button>
                </div>
              </div>
              {feature.parentId && (
                <p className="feature-draft-parent">
                  {depth}단계 하위 · 상위 묶음:{' '}
                  {plan.features.find((item) => item.id === feature.parentId)?.title}
                </p>
              )}
              {feature.description && (
                <p className="feature-draft-description">{feature.description}</p>
              )}
              {feature.kind === 'leaf' && (
                <details className="feature-draft-details" open>
                  <summary>완료 조건 {criteriaLines(feature.criteria).length}개</summary>
                  <ul>
                    {criteriaLines(feature.criteria).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </details>
              )}
              {prerequisites.length > 0 && (
                <p className="feature-draft-parent">
                  먼저 완료할 기능:{' '}
                  {prerequisites
                    .map(
                      (item) =>
                        `${item?.title ?? '알 수 없는 기능'}${item && !item.included ? ' (제외됨)' : ''}`,
                    )
                    .join(', ')}
                </p>
              )}
              {(feature.relatedPaths?.length ?? 0) > 0 && (
                <details className="feature-draft-details">
                  <summary>관련 경로 {feature.relatedPaths?.length}개</summary>
                  <ul>
                    {feature.relatedPaths?.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                </details>
              )}
            </article>
          );
        })}
      </div>
      <footer className="feature-draft-footer">
        <p className="field-hint">적용 전에는 저장되지 않아요. 취소하면 현재 초안을 버려요.</p>
        <div className="feature-draft-actions">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (!busy) onCancel();
            }}
          >
            초안 취소
          </Button>
          <Button
            disabled={busy || !valid || includedCount === 0}
            onClick={() => {
              if (!busy && valid && includedCount > 0) onApply();
            }}
          >
            {busy ? '처리 중…' : '초안 적용'}
          </Button>
        </div>
      </footer>
      {editing && (
        <DraftEditor
          key={editing.id}
          feature={editing}
          plan={plan}
          busy={busy}
          onChange={change}
          onClose={() => setEditing(null)}
        />
      )}
      {removing && (
        <Modal title="초안 항목 삭제" busy={busy} onClose={() => setRemovingId(null)}>
          <p className="feature-draft-description">
            {removing.kind === 'group'
              ? `“${removing.title}” 묶음과 하위 항목까지 총 ${removeCount}개를 초안에서 삭제해요.`
              : `“${removing.title}” 기능을 초안에서 삭제해요.`}{' '}
            연결된 선행 관계도 정리돼요.
          </p>
          <Notice>기존 저장된 기능 목록은 유지돼요.</Notice>
          <div className="modal-actions">
            <Button variant="ghost" disabled={busy} onClick={() => setRemovingId(null)}>
              삭제 취소
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                if (busy) return;
                change(removePlanFeature(plan, removing.id));
                setRemovingId(null);
              }}
            >
              초안에서 삭제
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
