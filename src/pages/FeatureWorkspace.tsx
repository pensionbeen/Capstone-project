import { useEffect, useState } from 'react';
import { featureRows } from '../../shared/feature-editing';
import type { ProjectFeaturePlan } from '../../shared/feature-plan';
import type { FileListResult } from '../../shared/workspace-files';
import { Badge, Button, Icon, Notice, PageHeading } from '../components/ui';
import { type Feature, featureState, type Project, stateLabels } from '../model';

function DirectoryBranch({
  projectId,
  path = '',
  depth = 0,
  onSelect,
}: {
  projectId: string;
  path?: string;
  depth?: number;
  onSelect: (path: string) => void;
}) {
  const [result, setResult] = useState<FileListResult | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [request, setRequest] = useState({ path });
  useEffect(() => {
    let cancelled = false;
    setResult(null);
    void window.desktop
      ?.listProjectFiles(projectId, request.path)
      .then((value) => {
        if (!cancelled) setResult(value);
      })
      .catch(() => {
        if (!cancelled) setResult({ ok: false, message: '파일 목록을 불러오지 못했어요.' });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, request]);
  if (!result)
    return (
      <p role="status" className="field-hint">
        파일 목록을 읽는 중이에요.
      </p>
    );
  if (!result.ok)
    return (
      <div>
        <p role="alert">{result.message}</p>
        <Button variant="ghost" onClick={() => setRequest({ path })}>
          다시 조회
        </Button>
      </div>
    );
  return (
    <>
      <ul className="file-tree" aria-label={path ? `${path} 파일 목록` : '실제 파일 트리'}>
        {result.entries.map((entry) => (
          <li key={entry.path}>
            {entry.kind === 'directory' ? (
              <>
                <button
                  type="button"
                  className="tree-button"
                  aria-expanded={expanded.includes(entry.path)}
                  disabled={depth >= 15}
                  onClick={() =>
                    setExpanded((items) =>
                      items.includes(entry.path)
                        ? items.filter((item) => item !== entry.path)
                        : [...items, entry.path],
                    )
                  }
                >
                  <Icon name={expanded.includes(entry.path) ? 'down' : 'chevron'} size={14} />
                  <Icon name="folder" size={16} />
                  {entry.name}
                </button>
                {expanded.includes(entry.path) && (
                  <DirectoryBranch
                    projectId={projectId}
                    path={entry.path}
                    depth={depth + 1}
                    onSelect={onSelect}
                  />
                )}
              </>
            ) : (
              <button
                type="button"
                className="tree-button"
                disabled={entry.kind === 'unavailable'}
                onClick={() => onSelect(entry.path)}
              >
                <Icon name="file" size={16} />
                {entry.name}
                {entry.kind === 'unavailable' && <small>열 수 없음</small>}
              </button>
            )}
          </li>
        ))}
      </ul>
      {!result.entries.length && <p className="field-hint">빈 폴더예요.</p>}
      {result.truncated && (
        <p role="status" className="field-hint">
          항목이 많아 이 폴더의 첫 200개만 표시해요. 관련 경로는 직접 입력할 수 있어요.
        </p>
      )}
      {depth >= 15 && <p className="field-hint">파일 트리는 16단계까지 펼칠 수 있어요.</p>}
    </>
  );
}

export function FeatureWorkspace({
  project,
  plan,
  busy,
  onEdit,
  onDelete,
  onAdd,
  onLink,
  onConversation,
  conversationBlock,
}: {
  project: Project;
  plan: ProjectFeaturePlan;
  busy: boolean;
  onEdit: (feature: Feature) => void;
  onDelete: (feature: Feature) => void;
  onAdd: (kind: 'leaf' | 'group', parentId?: string | null) => void;
  onLink: (feature: Feature, path: string) => void;
  onConversation: (feature: Feature) => void;
  conversationBlock: (feature: Feature) => string;
}) {
  const [selectedId, setSelectedId] = useState(plan.features[0]?.id ?? '');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [fileMessage, setFileMessage] = useState('');
  const [opening, setOpening] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const selected = plan.features.find((item) => item.id === selectedId);
  const rows = featureRows(plan);
  const byId = new Map(plan.features.map((item) => [item.id, item]));
  const visible = rows.filter(({ feature }) => {
    let parent = feature.parentId;
    while (parent) {
      if (collapsed.includes(parent)) return false;
      parent = byId.get(parent)?.parentId ?? null;
    }
    return true;
  });
  async function openFile(path: string) {
    if (!project.desktopId || !window.desktop || opening) return;
    setOpening(true);
    try {
      const result = await window.desktop.openProjectFile(project.desktopId, path);
      setFileMessage(result.ok ? '메모장에 파일 열기를 요청했어요.' : result.message);
    } catch {
      setFileMessage('파일 열기 결과를 확인하지 못했어요.');
    } finally {
      setOpening(false);
    }
  }
  return (
    <section className="workspace-page">
      <PageHeading
        eyebrow="FEATURES & FILES"
        title="기능과 파일을 연결해요"
        description="묶음으로 기능을 정리하고, 먼저 할 일과 관련 파일을 연결하세요."
      />
      {busy && (
        <Notice>
          저장 중이거나 AI가 실행 중이에요. AI 실행을 정리한 뒤 기능을 변경할 수 있어요.
        </Notice>
      )}
      <div className="feature-manager">
        <section className="manager-panel" aria-label="기능 구조">
          <div className="section-heading">
            <h2>
              기능 트리 <small>{plan.features.length} / 100</small>
            </h2>
          </div>
          <div className="manager-actions">
            <Button
              variant="secondary"
              disabled={busy || plan.features.length >= 100}
              onClick={() => onAdd('leaf')}
            >
              기능 추가
            </Button>
            <Button
              variant="ghost"
              disabled={busy || plan.features.length >= 100}
              onClick={() => onAdd('group')}
            >
              묶음 추가
            </Button>
          </div>
          <ul className="feature-tree" aria-label="기능 트리">
            {visible.map(({ feature, depth }) => (
              <li key={feature.id} style={{ paddingLeft: `${Math.min(depth, 5) * 16}px` }}>
                {feature.kind === 'group' && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`${feature.title} ${collapsed.includes(feature.id) ? '펼치기' : '접기'}`}
                    aria-expanded={!collapsed.includes(feature.id)}
                    onClick={() =>
                      setCollapsed((items) =>
                        items.includes(feature.id)
                          ? items.filter((id) => id !== feature.id)
                          : [...items, feature.id],
                      )
                    }
                  >
                    <Icon name={collapsed.includes(feature.id) ? 'chevron' : 'down'} size={14} />
                  </button>
                )}
                <button
                  type="button"
                  className="tree-button"
                  aria-pressed={selectedId === feature.id}
                  onClick={() => setSelectedId(feature.id)}
                >
                  <Icon name={feature.kind === 'group' ? 'folder' : 'code'} size={16} />
                  <span>{feature.title}</span>
                  <small>
                    {feature.kind === 'group'
                      ? '묶음'
                      : !feature.included
                        ? '제외'
                        : stateLabels[featureState(feature, plan.verifications)]}
                  </small>
                </button>
              </li>
            ))}
          </ul>
          {!plan.features.length && <p className="field-hint">첫 기능이나 묶음을 추가해 보세요.</p>}
        </section>
        <section className="manager-panel feature-selection" aria-label="선택한 기능">
          {selected ? (
            <>
              <Badge>
                {selected.kind === 'group' ? '기능 묶음' : `기능 · 버전 ${selected.revision}`}
              </Badge>
              <h2>{selected.title}</h2>
              <p>{selected.description}</p>
              <Button
                variant="secondary"
                disabled={Boolean(conversationBlock(selected))}
                onClick={() => onConversation(selected)}
              >
                기능 AI 대화 열기
              </Button>
              {conversationBlock(selected) && (
                <p className="field-hint">{conversationBlock(selected)}</p>
              )}
              <div className="manager-actions">
                <Button variant="secondary" disabled={busy} onClick={() => onEdit(selected)}>
                  선택한 기능 수정
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => onDelete(selected)}>
                  선택한 기능 삭제
                </Button>
                {selected.kind === 'group' && (
                  <Button
                    variant="ghost"
                    disabled={busy || plan.features.length >= 100}
                    onClick={() => onAdd('leaf', selected.id)}
                  >
                    묶음 안에 기능 추가
                  </Button>
                )}
              </div>
              {selected.kind === 'leaf' && (
                <>
                  <h3>완료 조건</h3>
                  <p className="preserve-lines">{selected.criteria}</p>
                  <h3>먼저 완료할 기능</h3>
                  <ul>
                    {plan.dependencies
                      .filter((edge) => edge.featureId === selected.id)
                      .map((edge) => (
                        <li key={edge.prerequisiteId}>{byId.get(edge.prerequisiteId)?.title}</li>
                      ))}
                  </ul>
                  {!plan.dependencies.some((edge) => edge.featureId === selected.id) && (
                    <p className="field-hint">연결한 선행 기능이 없어요.</p>
                  )}
                </>
              )}
              <h3>관련 경로</h3>
              <ul className="related-paths">
                {selected.relatedPaths?.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                    <Button
                      variant="ghost"
                      disabled={!project.desktopId || opening}
                      onClick={() => void openFile(path)}
                    >
                      메모장으로 열기
                    </Button>
                  </li>
                ))}
              </ul>
              {!selected.relatedPaths?.length && (
                <p className="field-hint">
                  오른쪽 파일 트리에서 연결하거나 수정 화면에서 경로를 적어 주세요.
                </p>
              )}
            </>
          ) : (
            <p className="field-hint">왼쪽에서 기능을 선택해 주세요.</p>
          )}
        </section>
        <section className="manager-panel" aria-label="프로젝트 파일">
          <div className="section-heading">
            <h2>실제 파일 트리</h2>
            <Button
              variant="ghost"
              disabled={!project.desktopId}
              onClick={() => {
                setRefresh(refresh + 1);
                setSelectedFile('');
                setFileMessage('');
              }}
            >
              새로고침
            </Button>
          </div>
          <p className="field-hint">
            폴더를 펼치면 파일 이름을 읽어요. 파일 내용은 앱에 가져오지 않아요.
          </p>
          {project.desktopId ? (
            <DirectoryBranch
              key={refresh}
              projectId={project.desktopId}
              onSelect={(path) => {
                setSelectedFile(path);
                setFileMessage('');
              }}
            />
          ) : (
            <Notice>실제 폴더를 선택하면 파일 트리를 사용할 수 있어요.</Notice>
          )}
          {selectedFile && (
            <div className="selected-file">
              <code>{selectedFile}</code>
              <div className="manager-actions">
                <Button
                  variant="secondary"
                  disabled={opening}
                  onClick={() => void openFile(selectedFile)}
                >
                  메모장으로 열기
                </Button>
                <Button
                  variant="ghost"
                  disabled={
                    !selected ||
                    busy ||
                    (selected.relatedPaths?.length ?? 0) >= 20 ||
                    selected.relatedPaths?.some(
                      (path) => path.toLowerCase() === selectedFile.toLowerCase(),
                    )
                  }
                  onClick={() => {
                    if (selected) onLink(selected, selectedFile);
                  }}
                >
                  선택한 기능에 연결
                </Button>
              </div>
            </div>
          )}
          {fileMessage && (
            <p role="status" className="field-hint">
              {fileMessage}
            </p>
          )}
        </section>
      </div>
    </section>
  );
}
