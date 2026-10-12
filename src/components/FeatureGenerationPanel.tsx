import { useRef, useState } from 'react';
import { type AISnapshot, activeAIStates } from '../../shared/ai';
import type { ProjectFeaturePlan } from '../../shared/feature-plan';
import { FeatureDraftPreview } from './FeatureDraftPreview';
import { Button, Notice } from './ui';

export interface PendingFeatureDraft {
  runId: string;
  outputId: string;
  plan: ProjectFeaturePlan;
}

export function FeatureGenerationPanel({
  projectId,
  snapshot,
  draft,
  busy,
  onChange,
  onApply,
}: {
  projectId: string;
  snapshot: AISnapshot;
  draft: PendingFeatureDraft | null;
  busy: boolean;
  onChange: (draft: PendingFeatureDraft | null) => void;
  onApply: () => Promise<string | null>;
}) {
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const running = activeAIStates.includes(snapshot.state);
  const stale = Boolean(
    draft && (draft.runId !== snapshot.id || draft.outputId !== snapshot.outputId),
  );
  const canGenerate =
    !busy &&
    !running &&
    !pending &&
    snapshot.cleanupConfirmed &&
    snapshot.purpose === 'requirements' &&
    snapshot.requirementsGoalConfirmed &&
    snapshot.conversationReady;
  async function generate() {
    if (!window.desktop || lock.current || !canGenerate) return;
    lock.current = true;
    setPending(true);
    setError('');
    try {
      const result = await window.desktop.generateFeatureDraft(
        projectId,
        snapshot.outputId,
        snapshot.id,
      );
      if (!result.ok) setError(result.message ?? '초안 생성을 시작하지 못했어요.');
    } catch {
      setError('생성 요청 결과를 확인하지 못했어요. 대화 상태를 확인하고 다시 시도해 주세요.');
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  return (
    <section className="generation-panel" aria-label="대화에서 기능 초안 만들기">
      <h2>대화에서 기능 초안 만들기</h2>
      <p>
        목표와 답변에서 기능과 완료 조건을 정리해요. 내용을 고르고 수정한 뒤 적용하면 기존 기능에
        추가돼요.
      </p>
      <Button
        variant="secondary"
        disabled={!canGenerate || Boolean(draft)}
        onClick={() => void generate()}
      >
        {snapshot.generationState === 'running' ? '기능 초안 만드는 중' : '대화로 기능 초안 만들기'}
      </Button>
      {!snapshot.requirementsGoalConfirmed && (
        <p className="field-hint">먼저 목표를 보내 질문을 받고 답변해 주세요.</p>
      )}
      {snapshot.generationMessage && <p role="status">{snapshot.generationMessage}</p>}
      {stale && (
        <Notice>대화가 바뀌었어요. 이 초안을 취소하고 최신 대화로 다시 만들어 주세요.</Notice>
      )}
      {error && !draft && (
        <p role="alert" className="form-message">
          {error}
        </p>
      )}
      {draft && (
        <FeatureDraftPreview
          plan={draft.plan}
          busy={busy || running || pending || stale}
          error={error}
          onChange={(plan) => onChange({ ...draft, plan })}
          onCancel={() => {
            onChange(null);
            setError('');
          }}
          onApply={() => {
            if (lock.current || stale) return;
            lock.current = true;
            setPending(true);
            setError('');
            void onApply()
              .then((message) => {
                if (message) setError(message);
              })
              .catch(() => setError('저장 결과를 확인하지 못했어요. 초안은 유지했어요.'))
              .finally(() => {
                lock.current = false;
                setPending(false);
              });
          }}
        />
      )}
      {draft && stale && (
        <Button variant="ghost" disabled={pending} onClick={() => onChange(null)}>
          이전 대화의 초안 취소
        </Button>
      )}
    </section>
  );
}
