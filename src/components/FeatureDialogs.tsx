import { useState } from 'react';
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
}: {
  feature: Feature;
  onSave: (value: Feature) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(feature);
  return (
    <Modal title={feature.title ? '기능과 완료 조건 수정' : '새 기능 추가'} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (validFeature(draft)) onSave(draft);
        }}
        className="stack-form"
      >
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
            maxLength={500}
            placeholder="이 기능으로 무엇을 할 수 있나요?"
          />
        </div>
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
            placeholder={'삭제한 항목이 목록에서 사라진다.\n삭제를 취소하면 기존 항목이 유지된다.'}
          />
          <p className="field-hint">직접 확인할 수 있는 조건을 한 줄에 하나씩 적어 주세요.</p>
        </div>
        <Notice>
          기능이나 완료 조건을 바꾸면 이전 검증 결과는 이력으로 남고, 현재 기능은 다시 검증해야
          해요.
        </Notice>
        <div className="modal-actions">
          <Button variant="ghost" onClick={onClose}>
            수정 취소
          </Button>
          <Button type="submit" disabled={!validFeature(draft)}>
            기능 저장
          </Button>
        </div>
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
        실제 AI 실행은 아직 연결되지 않았어요. 지금은 작업 내용과 검증 흐름을 확인할 수 있어요.
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
}: {
  features: Feature[];
  initialId?: string;
  onSave: (record: Omit<Verification, 'id' | 'createdAt' | 'featureTitle'>) => void;
  onClose: () => void;
}) {
  const [featureId, setFeatureId] = useState(initialId ?? features[0]?.id ?? '');
  const [result, setResult] = useState<'passed' | 'failed'>('passed');
  const [checks, setChecks] = useState<string[]>([]);
  const [observation, setObservation] = useState('');
  const [evidence, setEvidence] = useState('');
  const feature = features.find((item) => item.id === featureId);
  const record = { result, checkedCriteria: checks, observation, evidence };
  return (
    <Modal title="검증 결과 기록" onClose={onClose}>
      <form
        className="stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (feature && canRecordVerification(feature, record))
            onSave({ ...record, featureId, revision: feature.revision });
        }}
      >
        <div>
          <label htmlFor="verify-feature" className="field-label">
            확인한 기능
          </label>
          <select
            id="verify-feature"
            value={featureId}
            onChange={(event) => {
              setFeatureId(event.target.value);
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
          <Button variant="ghost" onClick={onClose}>
            기록 취소
          </Button>
          <Button type="submit" disabled={!feature || !canRecordVerification(feature, record)}>
            검증 결과 저장
          </Button>
        </div>
      </form>
    </Modal>
  );
}
