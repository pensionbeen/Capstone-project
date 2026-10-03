# X-001 AI 연결·자동 검토 실험

앱이 아닌 분리된 실험이다. [실험 보고](../../docs/experiments/X-001.md)와 [AI_WORKFLOW](../../docs/AI_WORKFLOW.md)를 따른다. Codex가 단독 수정하고 검토 AI에는 필요한 자료만 전달한다.

## 패키지 설치 없이 실행

현재 Node 24에서 존재하는 명령이다. 로컬 검사 24개와 사용자 환경의 Codex 실제 응답 1회는 확인했다. 수정된 모델 헤더 관측·Gemini 검토는 대기이며 현재 도구 세션은 설치 폴더 접근이 거부된다.

~~~powershell
Set-Location -LiteralPath 'C:\Users\jbiho\dev\Capstone-project\experiments\x-001-ai-terminal'
node --test lib.test.mjs review.test.mjs
node ai-capabilities.mjs
node ai-review.mjs --probe --provider codex
node agy-capabilities.mjs
~~~

- ai-capabilities.mjs: 기존 codex.cmd·gemini.cmd의 버전/help, Codex 로그인 방식과 모델 목록을 조사한다. 목록과 서비스 응답 성공은 다르다. 인증 파일·토큰은 읽지 않는다.
- ai-review.mjs --probe --provider codex: 고정 가짜 코드의 18세 경계값을 Codex만 검토한다. 모델·추론은 주담당의 작업 분류와 지원 목록에서 자동 선택한다. 로그인·API 전환·전역 설정 변경은 하지 않는다. --provider gemini는 기존 Gemini CLI 0.62.0용이며 Antigravity 호출이 아니다. 옵션 생략/both는 기존 두 어댑터를 순서대로 시도한다.
- agy-capabilities.mjs: 별도 Antigravity CLI의 버전/help만 조사하고 .runtime/latest-agy-capabilities.json에 저장한다. 기본 후보는 LocalAppData/agy/bin/agy.exe, 사용자 설치 위치가 다르면 AGY_EXE에 확인된 절대 exe 경로를 지정한다. 접근 거부를 미설치로 판단하지 않는다. 모델 호출·로그인·설정 변경은 없다.
- 결과: Git 제외 폴더 .runtime의 latest-ai-capabilities.json / latest-ai-review.json. 실패 이유·모델 정보·최대 6,000자의 검토 응답만 회수한다. 터미널 원문 전체는 저장하지 않는다.
- RESPONSE_AND_MODEL_OBSERVED: 응답과 CLI가 표시한 모델 설정을 관찰했다. Codex의 CLI_RESOLVED_CONFIG는 원격 엔진 신원 증명이 아니다. 내용 정확성·앱 동작·OS 보호는 별도 판단이다.
- RESPONSE_OBSERVED_MODEL_UNCONFIRMED: **실제 응답은 있으나 모델 근거 없음**. MODEL_MISMATCH 접미사는 다른 모델/수준·변경 알림, READONLY_CONFIG_UNCONFIRMED는 권한 표시 미확인이다. CALL_FAILED/BLOCKED와 구분한다. Flash/다른 GPT로 자동 재시도하지 않는다.
- 검토 대상 CLI 버전은 Codex 0.160.0·Gemini 0.62.0이다. 다른 버전이면 호출 방식 재검토로 멈추며 재설치하지 않는다.

## 실제 검토에 재사용

주담당이 비밀을 제거한 작은 JSON 전달문을 .runtime에 준비한다. 전체 저장소·인증정보를 자동 수집하지 않는다.

~~~powershell
node ai-review.mjs --packet .runtime/review-packet.json --provider codex
~~~

필수 문자열: taskId, 40자리 baseCommit, scope, verification, remaining, reviewFocus, content. kind는 implementation/test/fix/review/architecture/os-security/hard-debug/final-review 중 하나다. risks에는 os-security/data-loss/auth-boundary/repeated-failure를 넣는다. 독립 병렬 검토의 이점이 있으면 parallelReviewUseful: true를 지정한다. 위험 분류는 주담당의 판단이며 자동 위험 추측기는 아니다.

일반 작업은 Sol/High, 중요한 작업은 Astra의 확인된 최고 적합 수준을 요청한다. Ultra는 독립 병렬 검토가 유용하고 목록에 있을 때 선택한다. 지정 모델/수준이 없으면 중단한다. Codex 0.160.0의 JSON 출력은 모델/추론 정보가 없어 텍스트 모드·색상 없음으로 변경했다. 첫 CLI 헤더만 읽고 뒤의 프롬프트/자기 소개는 모델 근거로 쓰지 않는다. 모델 변경·권한 불일치면 사용 보류다.

Gemini 후보는 gemini-3.1-pro-preview이며 계정 이용 가능성은 미확인이다. init.model은 설정값이고 최종 result.stats.models를 실행 관찰에 쓴다. 통계 부재·다른 모델은 사용 보류다. 새로운 Pro 후보 채택에는 이유와 실제 호출 근거를 남긴다.

사용자의 실제 Google 로그인은 **Antigravity 1.1.10 / Google AI Pro / Gemini 3.1 Pro (High)** 배너로 확인했다. 위 Gemini CLI 설정·옵션과 혼용하지 않는다. Antigravity의 설치 버전 도움말과 읽기 전용 강제 방법을 확인한 뒤 별도 호출을 연결한다. 기본 headless는 폴더 쓰기를 허용하므로 아직 자동 검토 실행기로 사용하지 않는다. 계정 재로그인·API 전환은 필요하다고 판단하지 않았다.

첫 어댑터는 24KB 이하 전달문만 받으며 @ 파일 참조 구문은 거부한다. 이 문자가 필요한 코드는 임의 변형하지 말고 어댑터 개선/다른 읽기 전용 검토로 남긴다. 비밀 패턴 검사는 완전하지 않으므로 주담당의 전송 전 검토도 필요하다.

## 읽기 전용 경계와 복구

Codex는 read-only·승인 never·임시 세션을 요청한다. Gemini는 Plan 모드 대신 기본 모드·전체 도구 거부 정책, 스킬/후크 중지, 확장 없음, 임의의 빈 MCP 허용 대상, 가짜 폴더를 사용한다. 알려진 최소 개인 설정만 검사하며 기존 정책·관리 설정·알 수 없는 설정/환경변수·API 키 사용 경로가 있으면 덮어쓰지 않고 중단한다. 인증 내용·설정 원문은 출력하지 않으며 관리자 설정을 무시하는 경로는 쓰지 않는다.

각 호출 전후 가짜 폴더 전체 목록·파일 해시를 비교한다. 정책과 사후 검사는 **OS 수준 접근 차단 증거가 아니며**, 모든 개인 설정을 지원한다는 뜻도 아니다. Gemini 자체 세션 기록은 남을 수 있어 민감 자료를 넣지 않는다.

Codex login status와 exec의 인증 환경변수 처리 차이 때문에 CODEX_API_KEY 등 인증/엔드포인트 override 존재 시 값 출력 없이 중단한다. 파일 목록/해시 검사 자체가 실패해도 전체 호출을 멈추고 잠금을 유지한다. 출력에서 도구 활동이 보이지 않아도 모든 도구/훅 미사용을 증명한 것으로 쓰지 않는다.

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

## 현재 작업 브랜치 원격 반영

현재 세션은 원격 조회·일반 push 모두 GitHub 443 연결 실패다. 일반 사용자 PowerShell에서 아래처럼 **이 작업 브랜치만** 보낸다. main 병합/강제 push는 없다. 조회 성공과 push 성공·해시 일치를 구분한다.

~~~powershell
Set-Location -LiteralPath 'C:\Users\jbiho\dev\Capstone-project'
if ((git remote get-url origin) -ne 'https://github.com/pensionbeen/Capstone-project.git') {
    throw '대상 원격 주소가 다릅니다.'
}
if ((git branch --show-current) -ne 'spike/x-001-ai-terminal') {
    throw '현재 작업 브랜치가 다릅니다.'
}
git status --short --branch
$x001Changes = git status --porcelain
if ($LASTEXITCODE -ne 0 -or $x001Changes) {
    throw '상태 조회 실패 또는 미커밋 변경: 먼저 내용을 확인하세요.'
}
git ls-remote --heads origin refs/heads/spike/x-001-ai-terminal
if ($LASTEXITCODE -ne 0) { throw '원격 조회 실패' }
git push -u origin spike/x-001-ai-terminal:refs/heads/spike/x-001-ai-terminal
if ($LASTEXITCODE -ne 0) { throw '일반 push 실패. 강제 push하지 마세요.' }
$x001Local = git rev-parse spike/x-001-ai-terminal
if ($LASTEXITCODE -ne 0) { throw '로컬 해시 조회 실패' }
$x001Remote = git ls-remote --heads origin refs/heads/spike/x-001-ai-terminal
if ($LASTEXITCODE -ne 0 -or -not $x001Remote) { throw 'push 후 원격 확인 실패' }
if (($x001Remote -split '\s+')[0] -ne $x001Local) { throw '원격/로컬 해시 불일치' }
Write-Output "X-001 push 및 원격 해시 일치: $x001Local"
~~~
