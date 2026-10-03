# X-001 AI 연결·자동 검토 실험

앱이 아닌 Node.js/JavaScript(`.mjs`) 분리 실험이다. [실험 보고](../../docs/experiments/X-001.md)와 [AI_WORKFLOW](../../docs/AI_WORKFLOW.md)를 따른다. 한 번에 한 명만 수정하며 검토 AI에는 필요한 자료만 전달한다.

## 패키지 설치 없이 실행

Node 24.15.0에서 로컬 검사 **52개**와 Codex의 **Sol/High·Astra/Max 실제 응답 및 CLI 설정**을 확인했다. 완료한 Codex 명령형 대화의 한글·JSON·재개도 실측했다. 관리 호스트 + 포함된 실험용 ConPTY DLL은 최종 보완 뒤에도 13회 실제 fixture 검증을 통과했다(2026-10-04 00:32:26 KST). Gemini는 한글 접속 응답을 관측했지만 읽기 전용 독립 검토는 계속 미확인이다. 다음 로컬 검사는 node-pty 설치 없이 실행할 수 있다.

~~~powershell
Set-Location -LiteralPath 'C:\Users\jbiho\dev\Capstone-project\experiments\x-001-ai-terminal'
node --test lib.test.mjs review.test.mjs smoke.test.mjs managed.test.mjs
node ai-capabilities.mjs
node ai-review.mjs --probe --provider codex
node agy-capabilities.mjs
~~~

- ai-capabilities.mjs: 기존 codex.cmd·gemini.cmd의 버전/help, Codex 로그인 방식과 모델 목록을 조사한다. 목록과 서비스 응답 성공은 다르다. 인증 파일·토큰은 읽지 않는다.
- ai-review.mjs --probe --provider codex: 고정 가짜 코드의 18세 경계값을 Codex만 검토한다. 모델·추론은 주담당의 작업 분류와 지원 목록에서 자동 선택한다. 로그인·API 전환·전역 설정 변경은 하지 않는다. --provider gemini는 기존 Gemini CLI 0.62.0용이며 Antigravity 호출이 아니다. 옵션 생략/both는 기존 두 어댑터를 순서대로 시도한다.
- agy-capabilities.mjs: 별도 Antigravity CLI의 버전/help만 조사하고 .runtime/latest-agy-capabilities.json에 저장한다. 실제 1.2.16 도움말의 옵션 선언·models/agents 명령을 확인한다. 도움말에 --help 자신이 없어도 정상 형식을 인식하되 옵션이 설명에만 있거나 일부만 있으면 거절한다. 기본 후보는 LocalAppData/agy/bin/agy.exe다. 모델 호출·로그인·설정 변경은 없다.
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

사용자가 제공했던 Google 로그인 배너는 Antigravity 1.1.10 / Google AI Pro / Gemini 3.1 Pro (High)였고, 이번 실제 설치 조회는 **1.2.16**, Pro 목록은 **gemini-3.1-pro-high**다. Gemini CLI의 설정·옵션과 혼용하지 않는다. 맞춤 에이전트에 도구 없음 또는 view_file만 지정한 질문 전 init 조사에서도 쓰기·명령 실행 도구가 표시돼 실제 검토를 보내지 않았다. 기본 headless는 폴더 쓰기를 허용하므로 자동 검토 연결은 보류한다. 기존 로그인·전역 설정은 보존하며 사용자의 Pro 적극 활용 지시는 제한 적용을 해결한 뒤 실행한다.

첫 어댑터는 24KB 이하 전달문만 받으며 @ 파일 참조 구문은 거부한다. 이 문자가 필요한 코드는 임의 변형하지 말고 어댑터 개선/다른 읽기 전용 검토로 남긴다. 비밀 패턴 검사는 완전하지 않으므로 주담당의 전송 전 검토도 필요하다.

## 읽기 전용 경계와 복구

Codex는 read-only·승인 never·임시 세션을 요청한다. Gemini는 Plan 모드 대신 기본 모드·전체 도구 거부 정책, 스킬/후크 중지, 확장 없음, 임의의 빈 MCP 허용 대상, 가짜 폴더를 사용한다. 알려진 최소 개인 설정만 검사하며 기존 정책·관리 설정·알 수 없는 설정/환경변수·API 키 사용 경로가 있으면 덮어쓰지 않고 중단한다. 인증 내용·설정 원문은 출력하지 않으며 관리자 설정을 무시하는 경로는 쓰지 않는다.

각 호출 전후 가짜 폴더 전체 목록·파일 해시를 비교한다. 정책과 사후 검사는 **OS 수준 접근 차단 증거가 아니며**, 모든 개인 설정을 지원한다는 뜻도 아니다. Gemini 자체 세션 기록은 남을 수 있어 민감 자료를 넣지 않는다.

Codex login status와 exec의 인증 환경변수 처리 차이 때문에 CODEX_API_KEY 등 인증/엔드포인트 override 존재 시 값 출력 없이 중단한다. 파일 목록/해시 검사 자체가 실패해도 전체 호출을 멈추고 잠금을 유지한다. 출력에서 도구 활동이 보이지 않아도 모든 도구/훅 미사용을 증명한 것으로 쓰지 않는다.

ai-review.lock은 실행기끼리만 겹치지 않게 한다. 외부 AI 전체의 편집을 막는 OS 기능이 아니다. CLI 한 호출 최대 3분·출력 256KB, 무한 재시도 없음. 시간 초과 시 소유한 바깥 프로세스와 스트림을 정리하지만 후손 전체 종료는 미확인이다. 다음 호출을 중단하고 잠금을 남긴다. 사용자 터미널/작업 관리자에서 해당 실행의 잔존 프로세스를 확인하고 재개한다. 프로세스 이름 일괄 종료·PID만 믿은 강제 종료·기존 잠금 자동 삭제는 하지 않는다.

## PTY 검사와 현재 실패 판정

PTY는 대화형 터미널처럼 입출력·창 크기·중단 신호를 전달한다. node-pty **1.1.0** 설치·잠금 파일 생성·모듈 로딩은 확인했다. 새 환경에서는 이 폴더의 잠금 파일로 설치한다. CLI 재설치는 필요 없다.

~~~powershell
npm.cmd ci
npm.cmd run preflight
npm.cmd run smoke
npm.cmd run terminal
~~~

preflight는 준비 검사다. smoke는 정상·강제 종료·재시작을 **각각 별도 worker**로 시험하며, 이전 worker의 종료·stderr·가짜 자식 정리까지 통과한 뒤에만 다음을 시작한다. 한 모드의 판정 대기는 30초, 종료 요청 후 관찰은 4초다. 이는 프로세스 소멸 보장이 아니다. 소유한 worker만 종료 요청하고 불확실하면 FAIL·후속 실행 차단으로 남긴다.

실제 Windows에서는 정상 모드의 한글·resize·Ctrl+C 바이트·가짜 부모/자식 종료가 통과해도 호스트가 남아 **전체 FAIL**이다. 단순 내부 PASS나 stdout 문자열만으로 합격하지 않는다. node-pty 내부 작업 정리 누락은 원인 후보로 조사 중이다. `node pty-smoke.mjs --conpty-dll`은 명시적 가짜 데이터 비교용이며, 이 실험용 DLL도 호스트 종료에 실패했다. 기본 모드를 자동 변경하지 않는다. 실패 후 다시 실행하려면 해당 실행의 잔존 프로세스부터 확인한다.

terminal은 현재 실제 CLI/PTY를 시작하기 전에 **TUI_CONFIG_ISOLATION_UNCONFIRMED**로 차단한다. 설치된 top-level TUI가 exec의 ignore-user-config 옵션을 제공하지 않기 때문이다. exec 응답 성공을 대화형 TUI·재개 성공으로 확대하지 않는다. 실제 Codex·Electron 통합은 미검증이다. response.schema.json도 CLI 적용 전 샘플이다.

## 관리되는 PTY 비교 — WL-20261004-01

~~~powershell
node pty-managed.mjs
node pty-managed.mjs --conpty-dll
~~~

각 명령은 별도 비교다. 앞선 명령이 실패했다면 해당 실행의 정리를 먼저 확인하고 다음 명령을 실행한다. 실패 뒤 자동으로 DLL로 전환하지 않는다. 기본 ConPTY는 정상 정리 성공·강제 종료 stderr로 실패했다. 명시적인 **실험용 포함 DLL**은 정상·강제·대량 출력·10회 재시작 **13회/79개 확인**을 모두 통과했다(2026-10-04 00:15:35 KST).

`managed-supervisor`는 직접 생성한 호스트만 종료 요청하고 실제 close·최종 stderr·관측 후손 소멸을 확인한다. fixture가 보낸 PASS만으로 다음 실행을 시작하지 않는다. 호스트 신원은 Windows CIM의 PID+생성 시각으로 확인하고, fixture/자식/콘솔이 살아 있을 때 부모 관계를 확보한다. 조회용 콘솔은 실제 query 자식 객체의 identity로만 제외하며 편집기 등 외부 콘솔도 검증한 별도 부모 계통으로 구분한다. 조회 실패/관측 누락/알 수 없는 콘솔은 실패다.

정상적인 관리 호스트도 소유자가 명시적으로 종료한다. `nativeNaturalExit:false`, `hostDisposedByOwner:true`가 정상적인 결과이며 **node-pty 자연 종료 결함을 고쳤다는 뜻이 아니다**. 기존 smoke는 그 결함을 드러내도록 보존했다. 결과는 `.runtime/latest-pty-managed.json` 및 시각별 파일에 저장하며 Git에서 제외한다. 창 내부 AI, Electron, 미관측 순간 후손, 장시간 자원 증가/소켓·포트 전부를 검증한 결과로 확대하지 않는다.

Codex `exec` 재개는 `--ignore-user-config --ignore-rules --sandbox read-only`, 승인 never, Sol/High와 hooks/plugins 비활성 설정으로 시험했다. `exec resume`에는 첫 실행의 정확한 ID를 전달했으며 `--last`는 사용하지 않았다. 이 시험은 저장 대화가 필요하므로 `--ephemeral`을 사용하지 않았다. CLI 자체 이력에는 테스트 문장만 남고 인증 파일은 복사/수정하지 않았다. PowerShell 파이프에 한글을 보내려면 `$OutputEncoding`과 `[Console]::OutputEncoding` 모두 UTF-8로 지정한다. `terminal`의 TUI 차단은 유지한다.

Antigravity 1.2.16의 `excludeDefaultComponents: true`와 명시적 작업 폴더/새 프로젝트 비교에서도 도구 제한은 입증하지 못했다. 코드 없는 한글 한 줄의 실제 접속 응답은 확인했지만 stderr 78바이트로 엄격한 전체 판정은 실패했다. 파일/설정 불변·관측 도구 활동 없음은 사후 관측이며 읽기 전용 강제의 증거가 아니다. 자동 독립 검토는 계속 보류한다. [최신 실험 기록](../../docs/work-log/2026-10-04.md)을 따른다.

## 현재 작업 브랜치 원격 반영

Git push는 WL-08에서 복구했고 d02ae02까지 원격 해시 일치를 확인했다. 현재 묶음은 검증·기록 후 주담당이 **이 작업 브랜치만 일반 push**하고 원격 해시를 대조한다. 아래는 수동 복구가 필요할 때의 명령이다. main 병합/강제 push는 없다.

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
