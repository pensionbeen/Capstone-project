import { useState } from 'react';
import type { ProjectCatalog } from '../../shared/storage';
import { ProjectStorage } from '../components/ProjectStorage';
import { ProtectionEditor } from '../components/ProtectionEditor';
import { Badge, Button, Icon, Notice, PageHeading } from '../components/ui';
import type { Feature, Project, ProtectionDraft, Provider } from '../model';
import { criteriaLines, sampleProject, validFeature } from '../model';

export function ProjectPage({
  project,
  onSelect,
  onName,
  onNext,
  catalog,
  loading,
  onRestored,
}: {
  project: Project | null;
  onSelect: (project: Project) => void;
  onName: (name: string) => void;
  onNext: () => void;
  catalog: ProjectCatalog;
  loading: boolean;
  onRestored: (catalog: ProjectCatalog) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function selectFolder() {
    if (!window.desktop) {
      onSelect(sampleProject);
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const result = await window.desktop.selectProjectFolder();
      if (result.status === 'selected')
        onSelect({
          name: result.name,
          path: result.path,
          sample: false,
          desktopId: result.projectId,
        });
      else if (result.status === 'error') setMessage(result.message);
      else setMessage('폴더 선택을 취소했어요. 준비되면 다시 선택해 주세요.');
    } catch {
      setMessage('폴더를 선택하지 못했어요. 앱에서 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="setup-page project-page">
      <PageHeading
        eyebrow="YOUR NEXT PROJECT"
        title="어떤 프로젝트를 만들어 볼까요?"
        description="아이디어부터 완성까지, 흩어진 작업을 한곳에 모아요."
      />
      <div className="project-picker">
        <span className="folder-illustration">
          <Icon name="folder" size={42} />
          <span className="folder-plus">+</span>
        </span>
        <h2>{project ? '프로젝트를 선택했어요' : '작업할 폴더부터 선택해 주세요'}</h2>
        <p>
          {project
            ? '이름을 정하고, AI와 함께할 준비를 시작해요.'
            : '내 컴퓨터의 프로젝트 폴더를 연결해 시작할 수 있어요.'}
        </p>
        {!project && (
          <Button
            onClick={selectFolder}
            disabled={busy || loading || catalog.storage === 'unavailable'}
            icon="plus"
          >
            {busy
              ? '폴더 선택 창 여는 중'
              : window.desktop
                ? '프로젝트 폴더 선택'
                : '예시 프로젝트 선택'}
          </Button>
        )}
        {project && (
          <div className="selected-project">
            <div className="selected-folder">
              <Icon name="folder" />
              <div>
                <strong>{project.name || '프로젝트'}</strong>
                <span title={project.path}>{project.path}</span>
              </div>
              <button
                type="button"
                className="text-button"
                onClick={selectFolder}
                disabled={busy || loading || catalog.storage === 'unavailable'}
              >
                폴더 변경
              </button>
            </div>
            <label htmlFor="project-name" className="field-label">
              프로젝트 이름
            </label>
            <input
              id="project-name"
              value={project.name}
              maxLength={80}
              disabled={loading}
              onChange={(event) => onName(event.target.value)}
              placeholder="프로젝트 이름을 입력해 주세요"
            />
          </div>
        )}
        {!window.desktop && !project && (
          <span className="field-hint">실제 폴더 선택은 데스크톱 앱에서 사용할 수 있어요.</span>
        )}
      </div>
      {message && (
        <p className="form-message" role="status">
          {message}
        </p>
      )}
      {window.desktop && (
        <ProjectStorage
          catalog={catalog}
          loading={loading || busy}
          onSelect={onSelect}
          onRestored={onRestored}
        />
      )}
      {!project ? (
        <div className="sample-row">
          <div className="sample-icon">
            <Icon name="code" />
          </div>
          <div>
            <strong>먼저 가볍게 둘러보고 싶다면</strong>
            <p>할 일 관리 앱 예시로 전체 흐름을 살펴보세요.</p>
          </div>
          <button
            type="button"
            className="text-button"
            disabled={loading}
            onClick={() => onSelect(sampleProject)}
          >
            예시 열기
            <Icon name="arrow" size={16} />
          </button>
        </div>
      ) : (
        <div className="step-footer">
          <p>
            <Icon name="info" size={15} />
            {project.sample
              ? '예시 데이터로 화면 흐름을 살펴봐요.'
              : '폴더 안의 파일을 자동으로 읽거나 변경하지 않아요.'}
          </p>
          <Button onClick={onNext} disabled={!project.name.trim() || busy || loading} icon="arrow">
            이 프로젝트로 시작
          </Button>
        </div>
      )}
      <div className="welcome-caption">
        <span className="small-line" />
        <span>하나의 아이디어, 하나씩 완성하는 기능.</span>
      </div>
    </section>
  );
}

export function ConnectionPage({
  providers,
  onToggleProvider,
  protection,
  onProtection,
  onNext,
  onBack,
  onOpenAI,
  actualProject,
  connectionSummary,
}: {
  providers: Provider[];
  onToggleProvider: (value: Provider) => void;
  protection: ProtectionDraft;
  onProtection: (draft: ProtectionDraft) => Promise<string>;
  onNext: () => void;
  onBack: () => void;
  onOpenAI: () => void;
  actualProject: boolean;
  connectionSummary: string;
}) {
  return (
    <section className="setup-page">
      <PageHeading
        eyebrow="02 / CONNECT"
        title="함께할 AI를 선택해 주세요"
        description="함께 사용할 AI를 여러 개 선택할 수 있어요. 보호할 파일도 미리 정해 주세요."
      />
      <fieldset className="provider-fieldset">
        <legend className="section-label">AI 도구 · 여러 개 선택 가능</legend>
        <div className="provider-options">
          {(['Codex', 'Gemini'] as const).map((item) => (
            <label
              className={`provider-option ${providers.includes(item) ? 'selected' : ''}`}
              key={item}
            >
              <input
                type="checkbox"
                name="providers"
                value={item}
                aria-label={item}
                checked={providers.includes(item)}
                onChange={() => onToggleProvider(item)}
              />
              <span className="provider-symbol">
                <Icon name={item === 'Codex' ? 'code' : 'sparkle'} size={25} />
              </span>
              <span className="provider-copy">
                <strong>{item}</strong>
                <span>{item} CLI · 터미널 AI</span>
              </span>
              <span className="provider-check" aria-hidden="true">
                {providers.includes(item) && <Icon name="check" size={12} />}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="connection-status" aria-live="polite">
        <span className="status-dot" />
        <span>{providers.length ? connectionSummary : 'AI를 1개 이상 선택해 주세요'}</span>
        <span className="muted">Codex부터 실제 대화를 연결할 수 있어요</span>
      </div>
      {providers.includes('Codex') && (
        <div className="connection-action">
          <p>
            {actualProject
              ? '설치·로그인을 확인하고 읽기 전용 대화를 시작해요.'
              : '실제 Codex 대화는 프로젝트 폴더를 선택한 뒤 사용할 수 있어요.'}
          </p>
          <Button variant="secondary" onClick={onOpenAI} disabled={!actualProject}>
            Codex 대화 열기
          </Button>
        </div>
      )}
      {providers.includes('Gemini') && (
        <p className="field-hint">
          Gemini 선택은 유지되며, 실제 연결과 역할 분담은 후속 개발이에요.
        </p>
      )}
      <div className="section-block protection-summary">
        <div className="section-heading">
          <div>
            <h2>
              <Icon name="shield" />
              파일 보호 설정
            </h2>
            <p>AI가 접근하지 않도록 할 파일을 미리 정해 두세요.</p>
          </div>
          <Badge>적용 전</Badge>
        </div>
        <div className="path-chips">
          {protection.paths.map((path) => (
            <span key={path}>
              <Icon name="lock" size={14} />
              {path}
            </span>
          ))}
          {protection.paths.length === 0 && <span>아직 지정한 경로가 없어요</span>}
        </div>
        <details className="advanced">
          <summary>
            고급 보호 설정
            <Icon name="down" size={16} />
          </summary>
          <ProtectionEditor
            actualProject={actualProject}
            draft={protection}
            onSave={onProtection}
          />
        </details>
      </div>
      <Notice>
        {actualProject
          ? '요구분석은 Codex와 실제 대화로 진행해요. 아래 버튼은 입력 화면을 열며, 목표를 보낼 때 AI를 호출해요.'
          : '아래 요구분석은 예시 흐름이에요. 입력한 내용은 AI에 전송하지 않아요.'}{' '}
        파일 접근 차단은 아직 적용되지 않아요.
      </Notice>
      <div className="step-footer">
        <Button variant="ghost" onClick={onBack}>
          이전 단계
        </Button>
        <Button
          onClick={onNext}
          icon="arrow"
          disabled={providers.length === 0 || (actualProject && !providers.includes('Codex'))}
        >
          {actualProject ? 'AI로 요구분석 시작' : '예시로 요구분석 시작'}
        </Button>
      </div>
    </section>
  );
}

export interface AnalysisDraft {
  goal: string;
  started: boolean;
  audience: string;
  scope: string[];
}
export function AnalysisPage({
  value,
  onChange,
  onNext,
  onBack,
}: {
  value: AnalysisDraft;
  onChange: (value: AnalysisDraft) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const prompts = ['나만의 할 일 관리 앱', '팀 과제를 함께 관리하는 앱', '매일 학습을 기록하는 앱'];
  return (
    <section className="setup-page analysis-page">
      <PageHeading
        eyebrow="03 / DISCOVER"
        title="어떤 아이디어를 갖고 있나요?"
        description="완벽한 설명이 아니어도 괜찮아요. 만들고 싶은 것을 편하게 적어 주세요."
      />
      {!value.started ? (
        <>
          <form
            className="goal-composer"
            onSubmit={(event) => {
              event.preventDefault();
              if (value.goal.trim()) onChange({ ...value, started: true });
            }}
          >
            <label htmlFor="project-goal" className="sr-only">
              만들고 싶은 서비스
            </label>
            <textarea
              id="project-goal"
              placeholder="예를 들어, 해야 할 일을 정리하고 하루의 진행 상황을 확인하는 앱을 만들고 싶어요."
              value={value.goal}
              onChange={(event) => onChange({ ...value, goal: event.target.value })}
              maxLength={2000}
              rows={5}
            />
            <div className="composer-bottom">
              <span>{value.goal.length.toLocaleString()} / 2,000</span>
              <Button type="submit" disabled={!value.goal.trim()} icon="arrow">
                요구분석 시작
              </Button>
            </div>
          </form>
          <div className="prompt-suggestions">
            <p>이런 아이디어로 시작해 보세요</p>
            <div>
              {prompts.map((prompt) => (
                <button
                  type="button"
                  key={prompt}
                  onClick={() => {
                    onChange({ ...value, goal: prompt });
                    document.getElementById('project-goal')?.focus();
                  }}
                >
                  <Icon name="plus" size={15} />
                  {prompt}
                </button>
              ))}
            </div>
          </div>
          <p className="analysis-disclaimer">
            <Icon name="sparkle" size={16} />
            예시 질문으로 흐름을 확인해요. 입력한 내용은 AI에 전송되지 않아요.
          </p>
        </>
      ) : (
        <div className="analysis-conversation">
          <div className="user-message">
            <span className="message-label">내 아이디어</span>
            <p>{value.goal}</p>
            <button
              type="button"
              className="text-button"
              onClick={() => onChange({ ...value, started: false })}
            >
              내용 수정
            </button>
          </div>
          <div className="assistant-message">
            <span className="assistant-avatar">
              <Icon name="sparkle" size={20} />
            </span>
            <div className="assistant-content">
              <div className="assistant-label">
                ORBIT<Badge>예시 질문</Badge>
              </div>
              <h2>좋아요. 첫 버전의 범위를 정해 볼까요?</h2>
              <p>누가 사용할지, 어떤 기능이 필요한지 알려 주세요.</p>
              <fieldset className="question-block">
                <legend>누가 사용하나요?</legend>
                <div className="choice-options">
                  {['나 혼자', '작은 팀', '여러 사용자'].map((audience) => (
                    <label key={audience} className={value.audience === audience ? 'chosen' : ''}>
                      <input
                        type="radio"
                        name="audience"
                        value={audience}
                        checked={value.audience === audience}
                        onChange={() => onChange({ ...value, audience })}
                      />
                      {audience}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="question-block">
                <legend>첫 버전에 어떤 기능이 필요할까요?</legend>
                <p className="field-hint">기본 추가·수정 기능에 더할 항목을 선택해 주세요.</p>
                <div className="scope-options">
                  {[
                    { id: 'search', name: '목록·검색' },
                    { id: 'progress', name: '상태·진행률' },
                    { id: 'storage', name: '데이터 저장·복원' },
                  ].map((item) => (
                    <label key={item.id}>
                      <input
                        type="checkbox"
                        checked={value.scope.includes(item.id)}
                        onChange={(event) =>
                          onChange({
                            ...value,
                            scope: event.target.checked
                              ? [...value.scope, item.id]
                              : value.scope.filter((id) => id !== item.id),
                          })
                        }
                      />
                      {item.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          </div>
          <div className="step-footer">
            <Button variant="ghost" onClick={onBack}>
              이전 단계
            </Button>
            <Button onClick={onNext} disabled={!value.audience} icon="arrow">
              기능 초안 보기
            </Button>
          </div>
        </div>
      )}
      {!value.started && (
        <div className="step-footer compact">
          <Button variant="ghost" onClick={onBack}>
            이전 단계
          </Button>
          <span className="field-hint">아이디어를 입력하면 다음 단계로 이어져요.</span>
        </div>
      )}
    </section>
  );
}

export function ConfirmPage({
  manual,
  features,
  busy,
  onEdit,
  onToggle,
  onAdd,
  onNext,
  onBack,
}: {
  manual: boolean;
  features: Feature[];
  busy: boolean;
  onEdit: (feature: Feature) => void;
  onToggle: (id: string) => void;
  onAdd: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const count = features.filter((feature) => feature.included).length;
  return (
    <section className="setup-page confirm-page">
      <PageHeading
        eyebrow="04 / DEFINE"
        title={manual ? '만들 기능을 직접 정리해요' : '만들 기능을 함께 정리했어요'}
        description={
          manual
            ? '대화에서 정한 내용을 바탕으로 기능과 완료 조건을 직접 추가해 주세요. AI 대화는 이 목록에 자동 적용되지 않아요.'
            : '예시 초안을 살펴보고, 첫 버전에 필요한 기능과 완료 조건을 직접 다듬어 주세요.'
        }
      />
      <div className="list-intro">
        <span>
          첫 버전의 기능 <strong>{count}</strong>
        </span>
        <Badge>직접 확인 후 확정</Badge>
      </div>
      <div className="draft-list">
        {features.map((feature, index) => (
          <article className={`draft-row ${!feature.included ? 'excluded' : ''}`} key={feature.id}>
            <label className="draft-select">
              <input
                type="checkbox"
                checked={feature.included}
                disabled={busy}
                onChange={() => onToggle(feature.id)}
                aria-label={`${feature.title} 포함`}
              />
              <span>{String(index + 1).padStart(2, '0')}</span>
            </label>
            <div className="draft-content">
              <h2>{feature.title}</h2>
              <p>{feature.description}</p>
              <details>
                <summary>
                  완료 조건 {criteriaLines(feature.criteria).length}개<Icon name="down" size={14} />
                </summary>
                <ul>
                  {criteriaLines(feature.criteria).map((criterion) => (
                    <li key={criterion}>
                      <Icon name="check" size={14} />
                      {criterion}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={`${feature.title} 수정`}
              disabled={busy}
              onClick={() => onEdit(feature)}
            >
              <Icon name="edit" size={18} />
            </button>
          </article>
        ))}
      </div>
      <button
        type="button"
        className="add-feature"
        onClick={onAdd}
        disabled={busy || features.length >= 100}
      >
        <Icon name="plus" size={18} />
        기능 직접 추가
      </button>
      <div className="step-footer">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          요구분석으로 돌아가기
        </Button>
        <Button
          onClick={onNext}
          disabled={
            busy || !count || features.some((feature) => feature.included && !validFeature(feature))
          }
          icon="arrow"
        >
          기능 {count}개 확정하고 시작
        </Button>
      </div>
    </section>
  );
}
