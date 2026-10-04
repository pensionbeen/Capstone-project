import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import {
  type AIAvailability,
  type AISnapshot,
  activeAIStates,
  emptyAISnapshot,
} from '../../shared/ai';
import type { Project } from '../model';
import { Badge, Button, Modal, Notice } from './ui';

export function AIConsole({ project, onClose }: { project: Project; onClose: () => void }) {
  const outputRef = useRef<HTMLElement>(null);
  const [availability, setAvailability] = useState<AIAvailability | null>(null);
  const [checking, setChecking] = useState(false);
  const [snapshot, setSnapshot] = useState<AISnapshot>(emptyAISnapshot);
  const [input, setInput] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const busy = activeAIStates.includes(snapshot.state) || sending;
  const projectId = project.desktopId;

  async function check() {
    if (!window.desktop) return;
    setChecking(true);
    try {
      setAvailability(await window.desktop.inspectAI());
    } catch {
      setAvailability({ status: 'error', message: '앱과 연결되지 않았어요. 다시 확인해 주세요.' });
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    const element = outputRef.current;
    const bridge = window.desktop;
    if (!element || !bridge || !projectId) return;
    const terminal = new Terminal({
      disableStdin: true,
      convertEol: false,
      cursorBlink: false,
      scrollback: 1500,
      fontSize: 13,
      lineHeight: 1.45,
      fontFamily: 'Consolas, "Malgun Gothic", monospace',
      theme: {
        background: '#f7f8fa',
        foreground: '#303b4b',
        cursor: '#2864ef',
        selectionBackground: '#dce6fa',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    const blockClipboard = terminal.parser.registerOscHandler(52, () => true);
    let disposed = false;
    let cursor = 0;
    let outputId: string | null = null;
    let lastSize = '';
    let polling: ReturnType<typeof setTimeout> | undefined;
    let resizing: ReturnType<typeof setTimeout> | undefined;
    const resize = () => {
      clearTimeout(resizing);
      resizing = setTimeout(() => {
        if (disposed || element.clientWidth === 0) return;
        fit.fit();
        const size = `${terminal.cols}:${terminal.rows}`;
        if (lastSize === size) return;
        lastSize = size;
        void bridge
          .resizeAISession(
            projectId,
            Math.max(20, Math.min(512, terminal.cols)),
            Math.max(5, Math.min(120, terminal.rows)),
          )
          .catch(() => {});
      }, 150);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    const poll = async () => {
      try {
        let next = await bridge.readAISession(projectId, cursor);
        if (disposed) return;
        if (next.outputId !== outputId) {
          terminal.reset();
          cursor = 0;
          outputId = next.outputId;
          next = await bridge.readAISession(projectId, 0);
          if (disposed) return;
          outputId = next.outputId;
        }
        if (next.firstSequence > cursor) {
          terminal.reset();
          terminal.writeln('[이전 출력 일부는 보관 한도를 넘어 생략했어요.]');
          cursor = next.firstSequence;
        }
        for (const chunk of next.chunks) {
          if (disposed) return;
          if (chunk.sequence < cursor) continue;
          terminal.resize(chunk.cols, chunk.rows);
          await new Promise<void>((resolve) => terminal.write(chunk.data, resolve));
          cursor = chunk.sequence + 1;
        }
        if (!disposed) {
          setSnapshot(next);
          if (next.chunks.length) resize();
        }
      } catch {
        if (!disposed) setMessage('대화 출력을 읽지 못했어요. 앱 연결을 확인해 주세요.');
      } finally {
        if (!disposed) polling = setTimeout(poll, 250);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(polling);
      clearTimeout(resizing);
      observer.disconnect();
      blockClipboard.dispose();
      terminal.dispose();
    };
  }, [projectId]);

  async function send() {
    const bridge = window.desktop;
    if (!bridge || !projectId || busy || !input.trim()) return;
    setSending(true);
    setMessage('');
    try {
      const result = await bridge.sendAIPrompt(projectId, input);
      if (result.ok) {
        setInput('');
        setSnapshot((old) => ({
          ...old,
          state: 'starting',
          message: 'Codex 실행을 준비하고 있어요.',
        }));
      } else setMessage(result.message ?? '메시지를 보내지 못했어요.');
    } catch {
      setMessage('메시지를 보내지 못했어요. 앱 연결을 확인해 주세요.');
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal title="Codex와 대화" onClose={onClose} drawer>
      <div className="ai-console">
        <div className="ai-console-heading">
          <div>
            <strong>{project.name}</strong>
            <p>화면을 닫아도 현재 실행은 이어져요.</p>
          </div>
          <Badge>읽기 전용 연결</Badge>
        </div>
        <Notice>
          파일 수정 없이 대화하는 첫 연결이에요. 보호 설정안의 경로 읽기 차단은 아직 적용되지
          않아요.
        </Notice>
        <div className="ai-availability">
          <span>
            {availability?.message ?? '먼저 이 컴퓨터의 Codex 설치·로그인 상태를 확인해 주세요.'}
          </span>
          <Button variant="secondary" onClick={check} disabled={checking || busy || !projectId}>
            {checking
              ? '연결 준비 확인 중'
              : availability
                ? '연결 준비 다시 확인'
                : '연결 준비 확인'}
          </Button>
        </div>
        {!projectId && (
          <p className="form-message">
            예시 프로젝트에서는 실행하지 않아요. 실제 폴더를 선택해 주세요.
          </p>
        )}
        <div className="ai-run-status" role="status">
          <span className={`status-dot ${busy ? 'running' : ''}`} />
          {snapshot.message}
        </div>
        <section ref={outputRef} className="ai-terminal" aria-label="Codex 실행 출력" />
        <form
          className="ai-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label htmlFor="ai-prompt" className="field-label">
            Codex에게 보낼 메시지
          </label>
          <textarea
            id="ai-prompt"
            value={input}
            maxLength={8000}
            rows={3}
            placeholder="예: 이 프로젝트에서 먼저 확인할 내용을 알려 줘."
            onChange={(event) => setInput(event.target.value)}
          />
          <div className="ai-composer-actions">
            <span className="field-hint">
              {input.length.toLocaleString()} / 8,000 · Enter로 줄바꿈
            </span>
            {busy ? (
              <Button
                variant="secondary"
                disabled={snapshot.state === 'stopping'}
                onClick={async () => {
                  if (!projectId) return;
                  const result = await window.desktop?.stopAISession(projectId);
                  if (result && !result.ok)
                    setMessage(result.message ?? '중단 요청을 확인해 주세요.');
                }}
              >
                {snapshot.state === 'stopping' ? '실행 정리 중' : '실행 중단'}
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={
                  !input.trim() ||
                  availability?.status !== 'ready' ||
                  !projectId ||
                  !snapshot.cleanupConfirmed
                }
                icon="arrow"
              >
                메시지 보내기
              </Button>
            )}
          </div>
        </form>
        {message && (
          <p className="form-message" role="alert">
            {message}
          </p>
        )}
        <details className="advanced">
          <summary>대화 보관·실행 정보</summary>
          <p>
            요청 모델: gpt-6.1-sol · 추론 수준: high. 실행 종료가 프로젝트 기능 완료를 뜻하지는
            않아요.
          </p>
          <p>
            ORBIT은 최근 출력만 이 실행 동안 보관해요. Codex 자체 대화 기록은 사용자 환경에 남을 수
            있어요. 중단은 로컬 프로세스 정리까지 확인하며 원격 연산 중단은 확인하지 못해요.
          </p>
          {snapshot.truncated && <p>이전 출력 일부는 보관 한도를 넘어 생략했어요.</p>}
          <Button
            variant="ghost"
            disabled={busy || !snapshot.cleanupConfirmed || !projectId}
            onClick={async () => {
              if (!projectId) return;
              const result = await window.desktop?.resetAISession(projectId);
              if (result && !result.ok)
                setMessage(result.message ?? '새 대화를 시작하지 못했어요.');
            }}
          >
            새 대화 시작
          </Button>
        </details>
      </div>
    </Modal>
  );
}
