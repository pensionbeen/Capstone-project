import { useRef, useState } from 'react';
import { ProtectionEditor } from '../components/ProtectionEditor';
import { Badge, Button, EmptyState, Icon, Modal, Notice, PageHeading } from '../components/ui';
import type { Activity, Feature, Project, ProtectionDraft, Provider, Verification } from '../model';
import {
  criteriaLines,
  featureState,
  formatSize,
  formatTime,
  progress,
  stateLabels,
} from '../model';

export function OverviewPage({
  project,
  features,
  records,
  onOpen,
  onVerification,
  onAdd,
}: {
  project: Project;
  features: Feature[];
  records: Verification[];
  onOpen: (feature: Feature) => void;
  onVerification: () => void;
  onAdd: () => void;
}) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const summary = progress(features, records);
  const next = features.find((feature) => featureState(feature, records) !== 'passed');
  const visible = features.filter(
    (feature) =>
      (filter === 'all' ||
        (featureState(feature, records) === 'passed') === (filter === 'passed')) &&
      feature.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <section className="workspace-page">
      <PageHeading
        eyebrow="OVERVIEW"
        title="작은 기능부터, 하나씩 완성해요"
        description={`${project.name}의 다음 작업과 검증 상태를 한눈에 확인하세요.`}
      />
      <div className="overview-stats">
        <div>
          <span>검증한 기능</span>
          <strong>
            {summary.done}
            <small> / {summary.total}</small>
          </strong>
        </div>
        <div>
          <span>아직 남은 기능</span>
          <strong>
            {summary.total - summary.done}
            <small>개</small>
          </strong>
        </div>
        <div className="progress-stat">
          <span>완료 조건 기준 진행률</span>
          <strong>{summary.percent === null ? '정의 전' : `${summary.percent}%`}</strong>
          <progress value={summary.percent ?? 0} max={100} aria-label="검증 완료율" />
        </div>
      </div>
      {next ? (
        <div className="next-action">
          <div className="next-action-copy">
            <span className="eyebrow">다음으로 할 일</span>
            <h2>{next.title}</h2>
            <p>{next.description}</p>
          </div>
          <Button onClick={() => onOpen(next)} icon="arrow">
            작업 내용 열기
          </Button>
        </div>
      ) : summary.total > 0 ? (
        <div className="next-action">
          <div>
            <span className="eyebrow">모든 조건을 확인했어요</span>
            <h2>남긴 검증 결과를 살펴보세요</h2>
            <p>현재 화면에 기록한 결과예요. 제출 전 실제 동작을 다시 확인해 주세요.</p>
          </div>
          <Button onClick={onVerification} icon="arrow">
            검증 결과 살펴보기
          </Button>
        </div>
      ) : null}
      <div className="feature-list-header">
        <h2>
          프로젝트 기능 <span>{summary.total}</span>
        </h2>
        <button
          type="button"
          className="text-button"
          onClick={onAdd}
          disabled={features.length >= 30}
        >
          <Icon name="plus" size={16} />
          기능 추가
        </button>
      </div>
      <div className="list-tools">
        <fieldset className="filter-tabs" aria-label="기능 상태 필터">
          {[
            { id: 'all', label: '전체' },
            { id: 'pending', label: '진행할 기능' },
            { id: 'passed', label: '검증 완료' },
          ].map((item) => (
            <button
              type="button"
              key={item.id}
              aria-pressed={filter === item.id}
              className={filter === item.id ? 'active' : ''}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </fieldset>
        <label className="search-field">
          <Icon name="search" size={17} />
          <input
            type="search"
            aria-label="기능 검색"
            placeholder="기능 검색"
            value={query}
            maxLength={80}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      {visible.length ? (
        <table className="feature-table" aria-label="프로젝트 기능 목록">
          <thead>
            <tr className="table-heading">
              <th scope="col">기능</th>
              <th scope="col">완료 조건</th>
              <th scope="col">상태</th>
              <th scope="col">
                <span className="sr-only">작업</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((feature, index) => {
              const state = featureState(feature, records);
              return (
                <tr className="feature-table-row" key={feature.id}>
                  <td className="feature-name">
                    <span className={`feature-state-icon ${state === 'passed' ? 'complete' : ''}`}>
                      <Icon name={state === 'passed' ? 'check' : 'code'} size={16} />
                    </span>
                    <div>
                      <button type="button" onClick={() => onOpen(feature)}>
                        {feature.title}
                      </button>
                      <p>{feature.description}</p>
                    </div>
                    {index === 0 && feature.id === next?.id && (
                      <span className="first-tag">다음</span>
                    )}
                  </td>
                  <td className="criteria-count">{criteriaLines(feature.criteria).length}개</td>
                  <td>
                    <Badge accent={state === 'passed'}>{stateLabels[state]}</Badge>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`${feature.title} 열기`}
                      onClick={() => onOpen(feature)}
                    >
                      <Icon name="chevron" size={17} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <EmptyState
          icon="search"
          title="표시할 기능이 없어요"
          description={
            query
              ? '검색어를 바꾸거나 다른 상태를 선택해 주세요.'
              : '기능을 추가하거나 다른 상태를 선택해 주세요.'
          }
        />
      )}
      <p className="table-footnote">
        <Icon name="info" size={15} />
        AI의 작업 종료와 기능 완료는 달라요. 완료 조건을 검증한 기능만 진행률에 반영해요.
      </p>
    </section>
  );
}

export function VerificationPage({
  features,
  records,
  onRecord,
}: {
  features: Feature[];
  records: Verification[];
  onRecord: () => void;
}) {
  const summary = progress(features, records);
  return (
    <section className="workspace-page">
      <PageHeading
        eyebrow="VERIFICATION"
        title="완료는 확인한 만큼"
        description="기능이 의도대로 동작하는지 직접 확인하고, 결과와 근거를 함께 남겨 주세요."
      >
        <Button onClick={onRecord} disabled={!features.length} icon="plus">
          검증 결과 기록
        </Button>
      </PageHeading>
      <div className="verification-summary">
        <Icon name="list" size={26} />
        <div>
          <strong>
            {summary.total}개 기능 중 {summary.done}개 검증 완료
          </strong>
          <p>조건이 바뀌면 이전 결과를 보존하고 다시 검증해요.</p>
        </div>
        <Badge>이 창의 기록</Badge>
      </div>
      {records.length ? (
        <div className="verification-records">
          {[...records].reverse().map((record) => {
            const feature = features.find((item) => item.id === record.featureId);
            return (
              <article key={record.id} className="verification-record">
                <div className="record-header">
                  <h2>{record.featureTitle}</h2>
                  <Badge
                    accent={record.result === 'passed' && record.revision === feature?.revision}
                  >
                    {record.revision !== feature?.revision
                      ? '이전 조건의 결과'
                      : record.result === 'passed'
                        ? '검증 통과'
                        : '수정 필요'}
                  </Badge>
                  <time dateTime={record.createdAt}>{formatTime(record.createdAt)}</time>
                </div>
                <p>{record.observation}</p>
                <div className="evidence-line">
                  <Icon name="file" size={16} />
                  <span>{record.evidence}</span>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon="list"
          title="아직 남긴 검증 결과가 없어요"
          description="기능을 직접 사용해 본 뒤, 완료 조건별 결과를 기록해 보세요."
        />
      )}
      <Notice>
        현재 기록은 화면을 확인하기 위한 임시 데이터예요. 창을 닫거나 새로고침하면 사라져요.
      </Notice>
    </section>
  );
}

export function ProtectionPage({
  draft,
  onSave,
  provider,
}: {
  draft: ProtectionDraft;
  onSave: (value: ProtectionDraft) => void;
  provider: Provider;
}) {
  return (
    <section className="workspace-page narrow-page">
      <PageHeading
        eyebrow="PROTECTION"
        title="소중한 파일은 따로 지켜요"
        description="AI가 접근하지 않도록 할 파일과 폴더를 미리 정리해 주세요."
      />
      <div className="policy-status">
        <span className="empty-icon">
          <Icon name="shield" size={27} />
        </span>
        <div>
          <h2>보호 정책 적용 전</h2>
          <p>지금 저장하는 내용은 설정안이에요. 실제 파일 접근 차단은 준비 중이에요.</p>
        </div>
      </div>
      <div className="section-block">
        <div className="section-heading">
          <h2>보호할 경로</h2>
          <Badge>{draft.paths.length}개 지정</Badge>
        </div>
        <ProtectionEditor draft={draft} onSave={onSave} />
      </div>
      <details className="advanced">
        <summary>
          적용 대상과 상태 보기
          <Icon name="down" size={16} />
        </summary>
        <dl className="definition-list">
          <div>
            <dt>선택한 AI</dt>
            <dd>{provider} · 연결 전</dd>
          </div>
          <div>
            <dt>보호 실행</dt>
            <dd>연결 전</dd>
          </div>
          <div>
            <dt>실제 접근 거부</dt>
            <dd>아직 확인하지 않았어요</dd>
          </div>
        </dl>
      </details>
    </section>
  );
}

export function TransferPage() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [peer, setPeer] = useState('');
  const [showSummary, setShowSummary] = useState(false);
  return (
    <section className="workspace-page narrow-page">
      <PageHeading
        eyebrow="FILE TRANSFER"
        title="필요한 파일만, 원하는 기기로"
        description="파일을 고르고 받는 기기를 확인한 뒤, 상대방의 승인을 받아 전송해요."
      />
      <Notice>
        전송 화면 미리보기예요. 기기에 연결하거나 파일을 보내지 않으며, 파일 이름과 크기만 표시해요.
      </Notice>
      <div className="section-block">
        <h2 className="numbered-heading">
          <span>1</span>보낼 파일 선택
        </h2>
        <input
          ref={fileInput}
          type="file"
          className="sr-only"
          aria-label="보낼 파일"
          onChange={(event) => {
            const selected = event.target.files?.[0];
            if (selected) setFile({ name: selected.name, size: selected.size });
          }}
        />
        <button
          type="button"
          className={`file-drop ${file ? 'has-file' : ''}`}
          onClick={() => fileInput.current?.click()}
        >
          <span className="empty-icon">
            <Icon name={file ? 'file' : 'upload'} size={25} />
          </span>
          <strong>{file?.name ?? '파일을 선택해 주세요'}</strong>
          <span>
            {file
              ? `${formatSize(file.size)} · 눌러서 다른 파일 선택`
              : '한 번에 파일 하나를 선택할 수 있어요'}
          </span>
        </button>
      </div>
      <div className="section-block">
        <h2 className="numbered-heading">
          <span>2</span>받는 기기 확인
        </h2>
        <label className="field-label" htmlFor="peer-name">
          받는 기기 이름
        </label>
        <input
          id="peer-name"
          value={peer}
          onChange={(event) => setPeer(event.target.value)}
          maxLength={80}
          placeholder="예: 친구의 노트북"
        />
        <p className="field-hint">예시 이름을 입력해 전송 정보 화면을 확인해 보세요.</p>
      </div>
      <div className="step-footer">
        <span className="subtle-label">
          <Icon name="lock" size={15} />
          기기 연결 전
        </span>
        <Button onClick={() => setShowSummary(true)} disabled={!file || !peer.trim()} icon="arrow">
          전송 정보 확인
        </Button>
      </div>
      {showSummary && file && (
        <Modal title="전송 정보 미리보기" onClose={() => setShowSummary(false)}>
          <dl className="definition-list">
            <div>
              <dt>파일</dt>
              <dd>{file.name}</dd>
            </div>
            <div>
              <dt>크기</dt>
              <dd>{formatSize(file.size)}</dd>
            </div>
            <div>
              <dt>받는 기기</dt>
              <dd>{peer}</dd>
            </div>
            <div>
              <dt>현재 상태</dt>
              <dd>연결 전 · 전송되지 않았어요</dd>
            </div>
          </dl>
          <Notice>
            실제 전송에서는 받는 사람이 파일과 저장 위치를 확인하고 승인한 뒤 전송이 시작돼요.
          </Notice>
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setShowSummary(false)}>
              전송 정보 닫기
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function HistoryPage({ activities }: { activities: Activity[] }) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const visible = activities.filter(
    (item) =>
      (filter === 'all' || item.kind === filter) && `${item.title} ${item.detail}`.includes(query),
  );
  const labels = { feature: '기능', settings: '설정', verification: '검증' };
  return (
    <section className="workspace-page">
      <PageHeading
        eyebrow="ACTIVITY"
        title="작업의 흐름을 놓치지 않도록"
        description="이 창에서 변경한 설정과 기능, 직접 남긴 검증 결과를 시간순으로 확인하세요."
      />
      <div className="list-tools">
        <fieldset className="filter-tabs" aria-label="이력 종류 필터">
          {[
            { id: 'all', label: '전체' },
            { id: 'feature', label: '기능' },
            { id: 'settings', label: '설정' },
            { id: 'verification', label: '검증' },
          ].map((item) => (
            <button
              type="button"
              key={item.id}
              aria-pressed={filter === item.id}
              className={filter === item.id ? 'active' : ''}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </fieldset>
        <label className="search-field">
          <Icon name="search" size={17} />
          <input
            type="search"
            aria-label="이력 검색"
            placeholder="이력 검색"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={80}
          />
        </label>
      </div>
      {visible.length ? (
        <div className="activity-list">
          {[...visible].reverse().map((item) => (
            <article className="activity-row" key={item.id}>
              <span className="activity-icon">
                <Icon
                  name={
                    item.kind === 'settings'
                      ? 'shield'
                      : item.kind === 'verification'
                        ? 'list'
                        : 'code'
                  }
                  size={18}
                />
              </span>
              <div>
                <h2>{item.title}</h2>
                <p>{item.detail}</p>
              </div>
              <Badge>{labels[item.kind]}</Badge>
              <time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon="history"
          title="해당하는 기록이 없어요"
          description="다른 필터를 선택하거나 새 작업을 진행해 보세요."
        />
      )}
      <p className="table-footnote">
        <Icon name="info" size={15} />
        최근 100개 화면 조작만 표시해요. 실제 AI 실행·파일 접근 기록은 연결 후 제공돼요.
      </p>
    </section>
  );
}
