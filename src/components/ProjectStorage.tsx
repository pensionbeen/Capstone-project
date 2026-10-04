import { useState } from 'react';
import type { ProjectBackup, ProjectCatalog } from '../../shared/storage';
import type { Project } from '../model';
import { Button, Modal, Notice } from './ui';

export function ProjectStorage({
  catalog,
  loading,
  onSelect,
  onRestored,
}: {
  catalog: ProjectCatalog;
  loading: boolean;
  onSelect: (project: Project) => void;
  onRestored: (catalog: ProjectCatalog) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [backups, setBackups] = useState<ProjectBackup[]>([]);
  const [directory, setDirectory] = useState('');
  async function refreshBackups() {
    const result = await window.desktop?.listProjectBackups();
    if (result) {
      setBackups(result.backups);
      setDirectory(result.directory);
    }
  }
  async function openBackups() {
    setOpened(true);
    setBusy(true);
    setMessage('');
    try {
      await refreshBackups();
    } catch {
      setMessage('백업 목록을 읽지 못했어요. 저장 위치를 확인해 주세요.');
    } finally {
      setBusy(false);
    }
  }
  async function perform(id?: string) {
    if (busy || !window.desktop) return;
    setBusy(true);
    setMessage('');
    try {
      const result = id
        ? await window.desktop.restoreProjects(id)
        : await window.desktop.backupProjects();
      setMessage(result.message);
      if (result.ok && id && result.catalog) onRestored(result.catalog);
      await refreshBackups();
    } catch {
      setMessage('백업 작업 결과를 확인하지 못했어요. 목록을 다시 열어 확인해 주세요.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="project-storage">
      {catalog.storage === 'unavailable' ? (
        <Notice>
          <strong>프로젝트 저장을 사용할 수 없어요.</strong> {catalog.message}
        </Notice>
      ) : (
        <>
          <p className="field-hint">
            {loading
              ? '저장 상태를 확인하고 있어요.'
              : '확정한 폴더 선택은 저장돼요. 이름은 ‘이 프로젝트로 시작’을 누르면 저장돼요. 요구분석·기능·대화는 아직 이 창에만 남아요.'}
          </p>
          {catalog.projects.length > 0 && (
            <details className="saved-projects">
              <summary>저장된 프로젝트 {catalog.projects.length}개</summary>
              <ul>
                {catalog.projects.map((p) => (
                  <li key={p.id}>
                    <div>
                      <strong>{p.name}</strong>
                      <span title={p.path}>{p.path}</span>
                    </div>
                    <button
                      type="button"
                      className="text-button"
                      disabled={loading || busy}
                      onClick={() =>
                        onSelect({ name: p.name, path: p.path, desktopId: p.id, sample: false })
                      }
                      aria-label={`${p.name} 선택`}
                    >
                      선택
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <button
            type="button"
            className="text-button"
            disabled={loading || busy}
            onClick={openBackups}
          >
            프로젝트 목록 백업·복원
          </button>
        </>
      )}
      {opened && (
        <Modal
          title="프로젝트 목록 백업·복원"
          busy={busy}
          onClose={() => {
            if (!busy) setOpened(false);
          }}
        >
          <p className="dialog-copy">
            프로젝트 이름·폴더 위치·마지막 선택을 보관해요. 소스 파일, AI 로그인, 대화와 기능 목록은
            이 백업에 포함되지 않아요.
          </p>
          <p className="field-hint">백업 위치: {directory || '확인 중'}</p>
          <Button disabled={busy} onClick={() => perform()}>
            현재 목록 백업
          </Button>
          <ul className="backup-list">
            {backups.map((b, index) => (
              <li key={b.id}>
                <span>
                  {new Date(b.createdAt).toLocaleString('ko-KR')} <small>#{b.id.slice(0, 6)}</small>
                </span>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => perform(b.id)}
                  aria-label={`백업 ${index + 1} 복원`}
                >
                  복원
                </button>
              </li>
            ))}
          </ul>
          {!backups.length && <p className="field-hint">아직 만든 백업이 없어요.</p>}
          {message && (
            <p className="form-message" role="status">
              {message}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
