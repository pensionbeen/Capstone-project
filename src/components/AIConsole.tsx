import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { type Dispatch, type SetStateAction, useEffect, useId, useRef, useState } from 'react';
import {
  type AIAvailability,
  type AISnapshot,
  activeAIStates,
  emptyAISnapshot,
} from '../../shared/ai';
import {
  REQUIREMENTS_ANSWER_LIMIT,
  REQUIREMENTS_GOAL_LIMIT,
  type RequirementsAction,
  type RequirementsDraft,
  validRequirementsInput,
} from '../../shared/requirements';
import type { Project } from '../model';
import { Badge, Button, Modal, Notice } from './ui';

export function AIConsole({ project, onClose }: { project: Project; onClose: () => void }) {
  return (
    <Modal title="Codex와 대화" onClose={onClose} drawer>
      <AIConversation project={project} />
    </Modal>
  );
}

export function AIConversation({
  project,
  requirements,
}: {
  project: Project;
  requirements?: {
    draft: RequirementsDraft;
    onChange: Dispatch<SetStateAction<RequirementsDraft>>;
    enabled: boolean;
  };
}) {
  const outputRef = useRef<HTMLElement>(null);
  const submissionVersion = useRef(0);
  const commandPending = useRef(false);
  const lifecycle = useRef(0);
  const inputId = useId();
  const [availability, setAvailability] = useState<AIAvailability | null>(null);
  const [checking, setChecking] = useState(false);
  const [snapshot, setSnapshot] = useState<AISnapshot>(emptyAISnapshot);
  const [chatInput, setChatInput] = useState('');
  const input = requirements?.draft.answer ?? chatInput;
  const goal = requirements?.draft.goal ?? '';
  function setInput(value: string) {
    if (requirements) requirements.onChange((draft) => ({ ...draft, answer: value }));
    else setChatInput(value);
  }
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState('앱 내부 연결을 확인하고 있어요.');
  const [retryRequired, setRetryRequired] = useState(false);
  const busy = activeAIStates.includes(snapshot.state) || sending;
  const projectId = project.desktopId;
  const purpose = requirements ? 'requirements' : 'chat';
  const onRequirementsChange = requirements?.onChange;
  const matching = snapshot.purpose === purpose;
  const canSend =
    !busy &&
    connected &&
    availability?.status === 'ready' &&
    Boolean(projectId) &&
    snapshot.cleanupConfirmed &&
    (!requirements || requirements.enabled);

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
    let resizePending = false;
    let polling: ReturnType<typeof setTimeout> | undefined;
    let resizing: ReturnType<typeof setTimeout> | undefined;
    const resize = () => {
      clearTimeout(resizing);
      resizing = setTimeout(() => {
        if (disposed || element.clientWidth === 0) return;
        fit.fit();
        const size = `${terminal.cols}:${terminal.rows}`;
        if (lastSize === size || resizePending) return;
        resizePending = true;
        void bridge
          .resizeAISession(
            projectId,
            Math.max(20, Math.min(512, terminal.cols)),
            Math.max(5, Math.min(120, terminal.rows)),
          )
          .then((result) => {
            if (!disposed) lastSize = result.ok ? size : '';
          })
          .catch(() => {
            lastSize = '';
          })
          .finally(() => {
            resizePending = false;
          });
      }, 150);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    const read = async (after: number) => {
      const result = await bridge.readAISession(projectId, after, outputId);
      if ('connectionError' in result) {
        if (!disposed) {
          setConnectionMessage(result.connectionError.message);
          setRetryRequired(result.connectionError.code === 'retry-required');
        }
        throw new Error('Connection unavailable');
      }
      return result;
    };
    const poll = async () => {
      const version = submissionVersion.current;
      try {
        let next = await read(cursor);
        if (disposed || version !== submissionVersion.current) return;
        if (next.outputId !== outputId || next.nextSequence < cursor) {
          terminal.reset();
          cursor = 0;
          outputId = next.outputId;
          next = await read(0);
          if (disposed || version !== submissionVersion.current) return;
          outputId = next.outputId;
        }
        if (next.purpose !== purpose) {
          terminal.reset();
          cursor = next.nextSequence;
        } else if (next.firstSequence > cursor) {
          terminal.reset();
          terminal.writeln('[이전 출력 일부는 보관 한도를 넘어 생략했어요.]');
          cursor = next.firstSequence;
        }
        for (const chunk of next.chunks) {
          if (disposed || version !== submissionVersion.current) return;
          if (next.purpose !== purpose) break;
          if (chunk.sequence < cursor) continue;
          terminal.resize(chunk.cols, chunk.rows);
          await new Promise<void>((resolve) => terminal.write(chunk.data, resolve));
          cursor = chunk.sequence + 1;
        }
        if (!disposed && version === submissionVersion.current) {
          if (onRequirementsChange && !activeAIStates.includes(next.state))
            onRequirementsChange((draft) => {
              const pending = draft.pendingAnswer;
              if (!pending || next.id !== pending.runId) return draft;
              const completed =
                next.state === 'exited' && next.exitCode === 0 && next.cleanupConfirmed;
              return {
                ...draft,
                answer: completed && draft.answer === pending.text ? '' : draft.answer,
                pendingAnswer: undefined,
              };
            });
          // A read started before an accepted submission must not restore the old run state.
          if (version === submissionVersion.current) setSnapshot(next);
          setConnected(true);
          setRetryRequired(false);
          resize();
        }
      } catch {
        if (!disposed) setConnected(false);
      } finally {
        if (!disposed) polling = setTimeout(poll, 250);
      }
    };
    void poll();
    return () => {
      disposed = true;
      lifecycle.current++;
      clearTimeout(polling);
      clearTimeout(resizing);
      observer.disconnect();
      blockClipboard.dispose();
      terminal.dispose();
    };
  }, [projectId, purpose, onRequirementsChange]);

  async function send(action?: RequirementsAction) {
    const bridge = window.desktop;
    const text = action && action !== 'answer' ? goal : input;
    if (!bridge || !projectId || commandPending.current || !canSend || !text.trim()) return;
    if (requirements && (!action || !validRequirementsInput(action, text))) return;
    if ((!action || action !== 'start') && !matching) return;
    if (action && action !== 'start' && !snapshot.conversationReady) return;
    if (action === 'answer' && !snapshot.requirementsGoalConfirmed) return;
    commandPending.current = true;
    const generation = lifecycle.current;
    submissionVersion.current++;
    setSending(true);
    setMessage('');
    try {
      const result = action
        ? await bridge.sendRequirementsPrompt(
            projectId,
            action,
            text,
            snapshot.outputId,
            snapshot.id,
          )
        : await bridge.sendAIPrompt(projectId, text, snapshot.outputId, snapshot.id);
      if (generation !== lifecycle.current) return;
      if (result.ok) {
        submissionVersion.current++;
        const runId = result.runId;
        if (action === 'answer' && requirements && runId)
          requirements.onChange((draft) => ({ ...draft, pendingAnswer: { runId, text } }));
        else if (!action) setChatInput('');
        setSnapshot((old) => ({
          ...old,
          id: result.runId ?? old.id,
          outputId: result.outputId ?? old.outputId,
          purpose,
          requirementsGoal: action && action !== 'answer' ? text : old.requirementsGoal,
          requirementsGoalConfirmed:
            action && action !== 'answer' ? false : old.requirementsGoalConfirmed,
          state: 'starting',
          cleanupConfirmed: false,
          message: 'Codex 실행을 준비하고 있어요.',
        }));
      } else setMessage(result.message ?? '메시지를 보내지 못했어요.');
    } catch {
      if (generation === lifecycle.current)
        setMessage('요청 결과를 확인하지 못했어요. 현재 실행 상태를 확인한 뒤 다시 시도해 주세요.');
    } finally {
      commandPending.current = false;
      if (generation === lifecycle.current) setSending(false);
    }
  }

  return (
    <div className="ai-console">
      <div className="ai-console-heading">
        <div>
          <strong>{project.name}</strong>
          <p>
            {requirements
              ? '목표를 보내면 Codex가 필요한 내용을 질문해요.'
              : '화면을 닫아도 현재 실행은 이어져요.'}
          </p>
        </div>
        <Badge>읽기 전용 연결</Badge>
      </div>
      <Notice>
        파일 수정 없이 대화하는 첫 연결이에요. 보호 설정안의 경로 읽기 차단은 아직 적용되지 않아요.
      </Notice>
      {requirements && (
        <p className="field-hint">
          목표와 답변은 로그인한 Codex 서비스로 전송돼요. 계정 사용 한도가 적용되며 남은
          사용량·비용은 이 앱에서 확인하지 못해요. 실패한 요청은 자동으로 다시 보내지 않아요.
        </p>
      )}
      <div className="ai-availability">
        <span>
          {availability?.message ?? '먼저 이 컴퓨터의 Codex 설치·로그인 상태를 확인해 주세요.'}
        </span>
        <Button variant="secondary" onClick={check} disabled={checking || busy || !projectId}>
          {checking ? '연결 준비 확인 중' : availability ? '연결 준비 다시 확인' : '연결 준비 확인'}
        </Button>
      </div>
      {!projectId && (
        <p className="form-message">
          예시 프로젝트에서는 실행하지 않아요. 실제 폴더를 선택해 주세요.
        </p>
      )}
      {requirements && (
        <form
          className="goal-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send(matching && snapshot.conversationReady ? 'revise-goal' : 'start');
          }}
        >
          <label htmlFor="requirements-goal" className="field-label">
            만들고 싶은 서비스
          </label>
          <textarea
            id="requirements-goal"
            value={goal}
            maxLength={REQUIREMENTS_GOAL_LIMIT}
            rows={4}
            disabled={sending}
            onChange={(event) =>
              requirements.onChange((draft) => ({ ...draft, goal: event.target.value }))
            }
            placeholder="누가 어떤 일을 할 수 있는 앱을 만들고 싶은지 적어 주세요."
          />
          <div className="composer-bottom">
            <span>{goal.length.toLocaleString()} / 2,000</span>
            <Button
              type="submit"
              disabled={!canSend || !validRequirementsInput('start', goal)}
              icon="arrow"
            >
              {matching && snapshot.conversationReady ? '목표 수정 보내기' : '목표 보내고 질문받기'}
            </Button>
          </div>
          {matching && snapshot.requirementsGoal && (
            <p className="field-hint">마지막으로 요청한 목표: {snapshot.requirementsGoal}</p>
          )}
          {matching &&
            snapshot.requirementsGoal &&
            !snapshot.requirementsGoalConfirmed &&
            !busy && (
              <p className="form-message">
                목표 요청이 끝나지 않았어요. 목표를 다시 보내 질문을 받은 뒤 답변해 주세요.
              </p>
            )}
          {!matching && snapshot.id && (
            <p className="field-hint">
              새 요구분석을 시작하면 이 앱의 현재 일반 대화 출력이 초기화돼요.
            </p>
          )}
        </form>
      )}
      {!matching && snapshot.id && (
        <Notice>
          {requirements
            ? '일반 대화가 열려 있어요. 실행을 마친 뒤 목표를 보내면 새 요구분석으로 시작해요.'
            : '요구분석 대화가 열려 있어요. 요구분석 화면에서 이어가거나 아래에서 새 일반 대화를 시작하세요.'}
        </Notice>
      )}
      <div className="ai-run-status" role="status">
        <span className={`status-dot ${busy ? 'running' : ''}`} />
        {snapshot.message}
      </div>
      {projectId && !connected && (
        <div className="form-message" role="status">
          {connectionMessage}
          {retryRequired && (
            <Button
              variant="secondary"
              onClick={async () => {
                const reply = await window.desktop?.reconnectAI();
                if (reply?.ok) {
                  setRetryRequired(false);
                  setConnectionMessage('앱 내부 연결을 확인하고 있어요.');
                }
              }}
            >
              다시 연결
            </Button>
          )}
        </div>
      )}
      <section
        ref={outputRef}
        className="ai-terminal"
        hidden={!matching}
        aria-label={requirements ? '요구분석 AI 출력' : 'Codex 실행 출력'}
      />
      <form
        className="ai-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send(requirements ? 'answer' : undefined);
        }}
      >
        <label htmlFor={inputId} className="field-label">
          {requirements ? '질문에 대한 답변·정정 내용' : 'Codex에게 보낼 메시지'}
        </label>
        <textarea
          id={inputId}
          value={input}
          maxLength={requirements ? REQUIREMENTS_ANSWER_LIMIT : 8000}
          disabled={sending || !matching}
          rows={3}
          placeholder={
            requirements
              ? 'AI가 물어본 내용을 적어 주세요. 이전 답변을 바꾸려면 정정할 내용을 보내세요.'
              : '예: 이 프로젝트에서 먼저 확인할 내용을 알려 줘.'
          }
          onChange={(event) => setInput(event.target.value)}
        />
        <div className="ai-composer-actions">
          <span className="field-hint">
            {input.length.toLocaleString()} / {requirements ? '6,000' : '8,000'} · Enter로 줄바꿈
          </span>
          {busy ? (
            <Button
              variant="secondary"
              disabled={sending || snapshot.state === 'stopping' || !snapshot.id}
              onClick={async () => {
                if (!projectId) return;
                const result = await window.desktop?.stopAISession(projectId, snapshot.id);
                if (result && !result.ok)
                  setMessage(result.message ?? '중단 요청을 확인해 주세요.');
              }}
            >
              {sending
                ? '전송 상태 확인 중'
                : snapshot.state === 'stopping'
                  ? '실행 정리 중'
                  : '실행 중단'}
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={
                !input.trim() ||
                !canSend ||
                !matching ||
                (Boolean(requirements) &&
                  (!snapshot.conversationReady || !snapshot.requirementsGoalConfirmed))
              }
              icon="arrow"
            >
              {requirements ? '답변·정정 보내기' : '메시지 보내기'}
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
        {requirements && (
          <p>
            앱을 닫으면 이 화면의 목표·입력·대화 출력은 복원되지 않아요. 정정은 새 메시지로 보내며
            이전 전송 내용을 지우지 않아요. 사용 한도나 로그인 오류는 출력과 연결 준비 확인을 보고
            직접 다시 시도해 주세요.
          </p>
        )}
        <p>
          ORBIT은 최근 출력만 이 실행 동안 보관해요. Codex 자체 대화 기록은 사용자 환경에 남을 수
          있어요. 중단은 로컬 프로세스 정리까지 확인하며 원격 연산 중단은 확인하지 못해요.
        </p>
        {snapshot.truncated && <p>이전 출력 일부는 보관 한도를 넘어 생략했어요.</p>}
        <Button
          variant="ghost"
          disabled={busy || !connected || !snapshot.cleanupConfirmed || !projectId}
          onClick={async () => {
            if (!projectId) return;
            if (commandPending.current) return;
            commandPending.current = true;
            submissionVersion.current++;
            setSending(true);
            try {
              const result = await window.desktop?.resetAISession(
                projectId,
                snapshot.outputId,
                snapshot.id,
              );
              if (result && !result.ok)
                setMessage(result.message ?? '새 대화를 시작하지 못했어요.');
              else submissionVersion.current++;
            } catch {
              setMessage('초기화 결과를 확인하지 못했어요. 현재 대화 상태를 확인해 주세요.');
            } finally {
              commandPending.current = false;
              setSending(false);
            }
          }}
        >
          {requirements ? '요구분석 대화 초기화' : matching ? '새 대화 시작' : '새 일반 대화 시작'}
        </Button>
      </details>
    </div>
  );
}
