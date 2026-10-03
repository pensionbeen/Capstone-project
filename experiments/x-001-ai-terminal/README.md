# X-001 AI 연결·자동 검토 실험

앱이 아닌 분리된 실험이다. [실험 보고](../../docs/experiments/X-001.md)와 [AI_WORKFLOW](../../docs/AI_WORKFLOW.md)를 따른다. Codex가 단독 수정하고 검토 AI에는 필요한 자료만 전달한다.

## 패키지 설치 없이 실행

현재 Node 24에서 존재하는 명령이다. 로컬 검사는 통과했으며 실제 AI 서비스 호출은 이 세션의 설치 폴더 접근 거부로 막혔다.

~~~powershell
Set-Location -LiteralPath 'C:\Users\jbiho\dev\Capstone-project\experiments\x-001-ai-terminal'
node --test lib.test.mjs review.test.mjs
node ai-capabilities.mjs
node ai-review.mjs --probe
~~~

- ai-capabilities.mjs: 기존 codex.cmd·gemini.cmd의 버전/help, Codex 로그인 방식과 모델 목록을 조사한다. 목록과 서비스 응답 성공은 다르다. 인증 파일·토큰은 읽지 않는다.
- ai-review.mjs --probe: 고정 가짜 코드의 18세 경계값 오류를 Codex와 Gemini에 순서대로 검토 요청한다. 작업 ID·기준 커밋·검증 상태를 전달한다. 로그인·API 키 전환·설치·전역 설정 변경은 하지 않는다.
- 결과: Git 제외 폴더 .runtime의 latest-ai-capabilities.json / latest-ai-review.json. 실패 이유·모델 정보·최대 6,000자의 검토 응답만 회수한다. 터미널 원문 전체는 저장하지 않는다.
- RESPONSE_AND_MODEL_OBSERVED: 응답과 CLI 모델 표시를 관찰했다는 뜻이다. 내용의 정확성·앱 동작·OS 보호 성공은 별도 판단이다.
- BLOCKED 또는 MODEL_UNCONFIRMED_OR_CHANGED: 결과를 채택하지 않고 원인을 확인한다. Flash/다른 GPT 모델로 자동 재시도하지 않는다. CLI 내부 대체가 관측되면 알리고 결과를 거부한다. 내부 대체 시도 자체를 사전에 막았다는 보장은 아직 없다.
- 검토 대상 CLI 버전은 Codex 0.160.0·Gemini 0.62.0이다. 다른 버전이면 호출 방식 재검토로 멈추며 재설치하지 않는다.

## 실제 검토에 재사용

주담당이 비밀을 제거한 작은 JSON 전달문을 .runtime에 준비한다. 전체 저장소·인증정보를 자동 수집하지 않는다.

~~~powershell
node ai-review.mjs --packet .runtime/review-packet.json
~~~

필수 문자열: taskId, 40자리 baseCommit, scope, verification, remaining, reviewFocus, content. kind는 implementation/test/fix/review/architecture/os-security/hard-debug/final-review 중 하나다. risks에는 os-security/data-loss/auth-boundary/repeated-failure를 넣는다. 독립 병렬 검토의 이점이 있으면 parallelReviewUseful: true를 지정한다. 위험 분류는 주담당의 판단이며 자동 위험 추측기는 아니다.

일반 작업은 Sol/High, 중요한 작업은 Astra의 확인된 최고 적합 수준을 요청한다. Ultra는 병렬 검토가 유용하고 지원 목록에 있을 때 선택한다. 지정 모델/수준이 없으면 중단한다. Codex CLI 헤더가 없는 JSON 실행에서는 실제 모델을 **미확인**으로 남긴다. 모델의 자기 소개는 증거가 아니다.

Gemini 후보는 gemini-3.1-pro-preview이며 계정 이용 가능성은 미확인이다. init.model은 설정값이고 최종 result.stats.models를 실행 관찰에 쓴다. 통계 부재·다른 모델은 사용 보류다. 새로운 Pro 후보 채택에는 이유와 실제 호출 근거를 남긴다.

첫 어댑터는 24KB 이하 전달문만 받으며 @ 파일 참조 구문은 거부한다. 이 문자가 필요한 코드는 임의 변형하지 말고 어댑터 개선/다른 읽기 전용 검토로 남긴다. 비밀 패턴 검사는 완전하지 않으므로 주담당의 전송 전 검토도 필요하다.

## 읽기 전용 경계와 복구

Codex는 read-only·승인 never·임시 세션을 요청한다. Gemini는 Plan 모드 대신 기본 모드·전체 도구 거부 정책, 스킬/후크 중지, 확장 없음, 임의의 빈 MCP 허용 대상, 가짜 폴더를 사용한다. 알려진 최소 개인 설정만 검사하며 기존 정책·관리 설정·알 수 없는 설정/환경변수·API 키 사용 경로가 있으면 덮어쓰지 않고 중단한다. 인증 내용·설정 원문은 출력하지 않으며 관리자 설정을 무시하는 경로는 쓰지 않는다.

각 호출 전후 가짜 폴더 전체 목록·파일 해시를 비교한다. 정책과 사후 검사는 **OS 수준 접근 차단 증거가 아니며**, 모든 개인 설정을 지원한다는 뜻도 아니다. Gemini 자체 세션 기록은 남을 수 있어 민감 자료를 넣지 않는다.

ai-review.lock은 실행기끼리만 겹치지 않게 한다. 외부 AI 전체의 편집을 막는 OS 기능이 아니다. CLI 한 호출 최대 3분·출력 256KB, 무한 재시도 없음. 시간 초과 시 소유한 바깥 프로세스와 스트림을 정리하지만 후손 전체 종료는 미확인이다. 다음 호출을 중단하고 잠금을 남긴다. 사용자 터미널/작업 관리자에서 해당 실행의 잔존 프로세스를 확인하고 재개한다. 프로세스 이름 일괄 종료·PID만 믿은 강제 종료·기존 잠금 자동 삭제는 하지 않는다.

## 이후 PTY 실험

PTY는 대화형 터미널처럼 입출력·창 크기·중단 신호를 전달한다. node-pty 1.1.0 후보만 manifest에 고정했으며 설치·lockfile 생성은 못 했다. 다운로드 가능한 환경에서 이 폴더만 설치하고 잠금 파일을 검토한다. CLI 재설치는 필요 없다.

~~~powershell
npm.cmd install
npm.cmd run preflight
npm.cmd run smoke
npm.cmd run terminal
~~~

설치/PTY 성공은 미확인이다. preflight는 준비 검사, smoke는 가짜 Node 자식 ConPTY 검사, terminal은 실제 Codex 대화 관찰이다. 가짜 자식 성공으로 Codex/Electron 호환성을 판정하지 않는다. /quit 정상 종료, Ctrl+Q 실험 중단, Ctrl+C 입력 중단. 10분 한도·한글·resize·중단·후손 정리·재개를 실제 확인해야 X-001을 판정한다. response.schema.json은 후속 응답 형식 샘플이며 CLI 적용 검증 전이다.
