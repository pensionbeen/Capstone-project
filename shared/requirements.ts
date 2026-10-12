export type RequirementsAction = 'start' | 'answer' | 'revise-goal';

export interface RequirementsDraft {
  goal: string;
  answer: string;
  pendingAnswer?: { runId: string; text: string };
}

export const REQUIREMENTS_GOAL_LIMIT = 2000;
export const REQUIREMENTS_ANSWER_LIMIT = 6000;

export function validRequirementsInput(action: unknown, input: unknown): input is string {
  return (
    (action === 'start' || action === 'answer' || action === 'revise-goal') &&
    typeof input === 'string' &&
    input.trim().length > 0 &&
    input.length <= (action === 'answer' ? REQUIREMENTS_ANSWER_LIMIT : REQUIREMENTS_GOAL_LIMIT) &&
    ![...input].some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })
  );
}

// These are conversation instructions, not a file-access security boundary.
export function requirementsPrompt(action: RequirementsAction, input: string): string {
  const instruction =
    'ORBIT의 요구분석 대화입니다. 한국어로 쉬운 말과 짧은 문단을 사용하세요. ' +
    '사용자와 목표·사용 대상·첫 버전 범위·완료 조건을 정리하세요. ' +
    '추측으로 확정하지 말고 필요한 질문을 한 번에 최대 3개 묻고 답변을 기다리세요. ' +
    '답변이나 정정이 오면 반영한 내용과 남은 질문을 구분하세요. ' +
    '코드 구현·파일 탐색·명령 실행은 하지 말고 제공된 대화만으로 요구사항을 정리하세요. ' +
    '기능 목록을 앱에 저장했다거나 구현을 완료했다고 주장하지 마세요.';
  const label =
    action === 'start'
      ? '사용자의 첫 목표'
      : action === 'revise-goal'
        ? '사용자가 정정한 목표: 이전 목표보다 이 내용을 우선하고 달라지는 조건을 확인하세요'
        : '사용자의 답변 또는 정정: 이전 답변과 달라진 부분은 최신 내용을 우선하세요';
  return `${instruction}\n\n${label}\n${input}`;
}
