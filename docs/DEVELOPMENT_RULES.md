# Git·개발·검증·복구 규칙

1인 개발에 필요한 최소 규칙이다. 협업·기록·모델의 원문은 [AI_WORKFLOW](AI_WORKFLOW.md), 기능 완료 조건은 [TASKS](TASKS.md)를 따른다.

## Git 작업 흐름

1. 작업 시작 시 경로·저장소 루트·원격·브랜치·미커밋 변경을 확인한다. 홈·자료 동기화 폴더를 개발 저장소로 취급하지 않는다.
2. 검증된 기준에서 기능마다 브랜치를 만든다. 예: `feat/m1-project-picker`, `feat/m3-feature-editor`, `spike/os-protection`, 문서는 `docs/project-plan`.
3. main은 검증된 상태로 유지한다. 실제 main이 있는지 먼저 확인한다. 원격이 비었다는 확인이 없으면 초기 상태를 추측하지 않는다.
4. 하나의 목적을 작은 커밋으로 남기고 작업 브랜치를 원격에 푸시한다. 커밋 메시지는 변경 목적을 설명한다.
5. 관련 검증과 필요한 검토 후 main에 병합한다. 이번 요청은 **main 병합을 허용하지 않는다**. 후속 요청에서 병합 권한을 확인한다.
6. 다른 AI/사용자의 변경을 초기화·덮어쓰기·자동 stash·일괄 스테이징하지 않는다. 기존 변경은 관측 목록을 남기고 분리한다.
7. 강제 푸시·공유 기록 재작성·`reset --hard`·`clean -fd`로 문제를 해결하지 않는다. 이미 배포한 변경은 되돌림 커밋과 데이터 복구 절차를 검토한다.

### 선행 기능이 있는 브랜치

기본은 선행 기능을 검증·검토하여 기준 브랜치에 반영한 뒤 후속 브랜치를 만드는 순서다. 예: 프로젝트/저장 → 기능 구조 → 편집/진행률 → 세션 연결. 보호는 X-002 성공 후 통합한다.

선행 병합을 기다릴 수 없으면 선행 작업 브랜치의 **명시한 커밋**에서 후속 브랜치를 만들고 의존 관계를 기록한다. 후속 PR은 우선 선행 브랜치를 기준으로 하여 차이를 작게 유지할 수 있다. 병합 순서는 선행 → 후속이다. 선행을 main에 반영한 뒤 후속 브랜치로 최신 main을 merge하고 다시 검증한다. 이미 공유한 후속 이력을 강제 rebase/push하지 않는다. PR 생성 자체는 필수 조직 절차가 아니라 검토·차이 보관 수단이다.

### 기존 저장소와 현재 세션의 네트워크 제한

실제 작업 위치는 사용자가 지정한 `C:/Users/jbiho/dev/Capstone-project`다. origin은 `https://github.com/pensionbeen/Capstone-project.git`이다. 점검 당시 이 저장소에는 main이라는 초기 브랜치 이름과 원격 설정만 있었고 커밋·작업 파일·미커밋 변경은 없었다. 문서 초안을 만들었던 별도 로컬 폴더에서 검증한 커밋만 가져와 `docs/project-plan`을 만들었다. 기존 저장소를 다시 초기화하지 않았다.

현재 실행 계정은 저장소 소유자와 다른 CodexSandboxOffline이다. Git의 소유자 확인 오류는 정확한 대상에만 적용되는 `git -c safe.directory=C:/Users/jbiho/dev/Capstone-project …`로 처리했다. 전역 safe.directory·소유권·ACL·방화벽은 바꾸지 않았다. 일반 사용자 PowerShell에는 이 임시 옵션이 필요하지 않을 수 있다.

사용자는 별도 승인 실행에서 원격 조회 성공을 확인했다고 알려주었다. **이 세션에서는** GitHub 443 연결이 실패했고 TCP 소켓 접근 권한 오류를 확인했다. 세션 정책상 샌드박스 밖 실행 승인 요청(sandbox_approval)이 허용되지 않는다. 원격 조회 실패·일반 push 미실행·사용자 보고를 각각 기록한다. GitHub 플러그인은 HTTPS Git push의 필수 조건이 아니다.

연결 가능한 일반 PowerShell에서의 순서:

1. 아래 명령으로 같은 경로·원격·브랜치·변경 상태·커밋을 확인한다.
2. 원격 조회 성공 후 문서 브랜치만 일반 push한다. 원격에 같은 이름의 다른 이력이 있으면 Git이 거절할 수 있으므로 중단하고 비교한다. 강제 push·초기화·main 병합으로 해결하지 않는다.
3. push 성공 후 원격 문서 브랜치 해시와 로컬 해시가 같은지 확인한다. 원격 조회만 성공한 것을 push 성공으로 보고하지 않는다.
4. 원격에 기존 코드/규칙이 있으면 후속 개발 전에 읽고 현재 계획과 차이를 기록한다. 독립 문서 초기 커밋을 기존 main에 강제로 합치거나 `--allow-unrelated-histories`로 섞지 않는다.

다음은 **사용자가 VS Code의 일반 PowerShell에서 실행할 복구 명령**이며 이 세션에서 성공했다고 확인한 명령이 아니다.

```powershell
Set-Location -LiteralPath 'C:\Users\jbiho\dev\Capstone-project'
git remote -v
git status --short --branch
git log -1 --oneline
if ((git remote get-url origin) -ne 'https://github.com/pensionbeen/Capstone-project.git') {
    throw '대상 원격 주소가 다릅니다.'
}
if ((git branch --show-current) -ne 'docs/project-plan') {
    throw '문서 브랜치가 아닙니다.'
}
$planChanges = git status --porcelain
if ($LASTEXITCODE -ne 0 -or $planChanges) {
    throw 'Git 상태 조회 실패 또는 미커밋 변경이 있습니다. 먼저 확인하세요.'
}
git ls-remote --symref origin HEAD refs/heads/docs/project-plan
if ($LASTEXITCODE -ne 0) { throw '원격 조회 실패. push를 중단합니다.' }
git push -u origin docs/project-plan:refs/heads/docs/project-plan
if ($LASTEXITCODE -ne 0) { throw 'push 실패. 강제 push하지 말고 오류를 확인하세요.' }
$planLocal = git rev-parse docs/project-plan
$planRemote = git ls-remote origin refs/heads/docs/project-plan
if ($LASTEXITCODE -ne 0 -or -not $planRemote) {
    throw 'push 후 원격 해시 확인 실패.'
}
if (($planRemote -split '\s+')[0] -ne $planLocal) {
    throw '로컬과 원격 문서 브랜치 해시가 다릅니다.'
}
Write-Output "문서 브랜치 push 및 원격 해시 일치 확인: $planLocal"
```

이전 `C:/Users/jbiho/source/repos/Capstone-project`는 보존한 초안 위치다. 이후 실제 작업은 dev 경로에서만 이어간다. 현재 커밋·동기화 결과는 STATUS와 날짜별 기록이 기준이다.

### 커밋할 파일

정확한 파일 목록을 검토하고 `git add -- 경로1 경로2`처럼 이번 작업만 스테이징한다. `git diff --cached --name-only`, `git diff --cached --check`, 전체 staged diff를 확인한다.

제외 대상: API 키·비밀번호·인증 파일/링크·실행 DB와 WAL/SHM·사용자 프로젝트 원문 로그·빌드 결과·의존성 폴더·개인 환경 설정. 이후 구현 시 해당 경로의 ignore 규칙을 추가하고 포함 여부를 실제 검사한다. 단순히 .gitignore가 있다는 것으로 비밀 검사를 대신하지 않는다.

## 한국어 문서와 PowerShell 인코딩

Markdown은 UTF-8로 저장한다. Windows PowerShell에서 읽을 때는 `Get-Content -Raw -Encoding UTF8 파일경로`처럼 인코딩을 명시한다. 기본 인코딩으로 잘못 읽은 깨진 문자열을 원본에 다시 저장하지 않는다. 표시가 깨지면 먼저 UTF-8 바이트 검사와 명시적 UTF-8 재조회를 하고, 파일 손상과 출력 해석 문제를 구분한다. 이번 11개 문서는 엄격한 UTF-8 해석·대체 문자 검사·한글 재조회가 정상이며 인코딩 변환은 필요하지 않았다.

## 코드·API·데이터 변경

- TypeScript의 엄격한 타입 검사를 기준안으로 한다. 명시하지 않은 `any`, 오류 무시, 성공처럼 보이는 빈 catch를 피한다.
- 코드 형식·lint 도구는 저장소에 기존 설정이 있으면 따른다. 새 선택은 최소 하나씩 두고 formatter와 lint의 역할을 중복시키지 않는다.
- UI는 표시·입력을, 서버는 검증·상태·저장을 담당한다. 보안 판단을 UI에만 두지 않는다.
- 실행 파일·인자를 분리하고 경로·크기·상태 전이를 검사한다. 실패를 오류 코드·재시도 가능 여부·실제 상태로 표현한다.
- API/이벤트 필드를 바꾸면 공통 타입·서버 검사·화면 소비자·저장 구조·테스트를 함께 검토한다. 버전 충돌과 이전 데이터 영향을 기록한다.
- DB 변경은 버전 있는 변환과 백업·실패 복구가 함께 있어야 한다. 실제 데이터 파일을 개발 편의를 위해 삭제하여 문제를 숨기지 않는다.
- 핵심 구조 결정은 ARCHITECTURE의 결정 ID에 이유·대안·검증 한계·일정 영향을 기록한다. 사소한 이름 변경마다 별도 결정 문서를 만들지 않는다.

## 실행 환경·의존성

현재 읽기 전용 확인 결과는 Git 2.45.1.windows.1, Node v24.15.0이다. PATH에서 `codex`·`gemini` 명령을 찾지 못했다. 이는 다른 경로나 앱에 설치되지 않았다는 증거가 아니다. Electron·React·TypeScript·Fastify·SQLite 드라이버·node-pty·xterm.js 설치·버전·호환성은 미확인이다.

패키지를 실제 설치할 후속 작업에서 package manifest와 lockfile을 함께 관리하고 Node·패키지 관리자·Electron·네이티브 모듈·Windows/CPU의 검증 조합을 기록한다. 버전 고정과 정기 보안 업데이트를 균형 있게 적용한다. 네이티브 모듈은 개발 실행뿐 아니라 패키지된 앱에서 다시 검증한다. 추가 라이선스·서명·API 비용은 예산 결정 후 선택한다.

| 명령 종류 | 현재 확인 상태 |
|---|---|
| `git rev-parse --show-toplevel`, `git remote -v`, `git status --short`, `git branch --show-current`, `git --version`, `node --version` | 이번에 실행. 결과는 작업 기록 |
| `git ls-remote`, `git clone` | 이번에 시도, GitHub HTTPS 연결 실패 |
| 애플리케이션 개발·빌드·lint·typecheck·test 명령 | **미정**. 원격 코드 미조회, 이번 로컬에는 package.json/실행 코드 없음 |
| `npm run dev`, `npm run build`, `npm run lint`, `npm run typecheck`, `npm test` | 앞으로 설정할 수 있는 **명령 이름 제안**. 현재 존재·성공한다고 안내하지 않음 |
| 문서 링크·ID·공수·비밀 검사 | 이번 문서 작성 시 별도 검사. 애플리케이션 테스트와 구분 |

이번에는 개발 패키지나 CLI를 설치하지 않는다.

## 필요한 검증

테스트의 수보다 완료 조건과 실패 위험을 확인한다. 단순 문구 변경에 구현을 그대로 따라 쓰는 테스트를 추가하지 않는다.

- 계산/규칙: 말단 진행률·0개·관계 순환·상태 전이·완료 근거 버전의 단위 테스트.
- 저장/API: DB 제약·변환·복원·형식 오류·무인증/타출처·중복 요청·권한 경계 통합 시험.
- 터미널: 실제 CLI·한글·resize·중단·앱 종료·자식 정리·이력 복원. 모의 프로세스만으로 호환 완료 판정 금지.
- 보호: 실제 OS 거부·사용자 정상·AI 자식·허용 파일·정책 실패·우회 경로. VM/테스트 계정·가짜 파일로만 시작한다.
- 전송: 두 실제 기기·승인/거절·해시·경로/동명이름·끊김·용량 부족·취소.
- 최종: 배포물의 설치/업데이트/제거·재시작/복구·연속 시연과 요구별 증거.

관련 검사가 통과하면 근거를 남기고 다음 작업으로 간다. 변경·실패·미해결 위험이 없는데 동일 검사를 무한 반복하지 않는다. 미실행·실패·일부 확인을 ‘통과’에 섞지 않는다.

## 로그·비밀정보·OS 실험 복구

일반 활동 기록과 터미널 출력을 구분하고 보관 크기·기간·삭제 정책을 정한다. 실제 기록 전에 비밀을 수집하지 않는 경로를 우선 설계한다. 필터만으로 모든 비밀 제거가 보장된다고 주장하지 않는다. 사용자 이름·절대 경로 등도 공유 기록에서 필요한 만큼만 남긴다.

사용자가 블루스크린 위험을 우려했다. 실험은 사용자 데이터와 분리된 복구 가능한 VM 또는 전용 테스트 계정·가짜 파일에서 시작하고, 사전 백업·복원 절차·중단 조건을 확인한다. 커널 드라이버 직접 개발을 프로토타입 필수에 넣지 않고, 검증된 OS 권한 기능을 비교한다. VM·계정이 있다고 무조건 안전하다고 보장하지 않는다. 호스트·친구 PC의 기존 권한을 광범위하게 바꾸지 않는다.

OS 실험 중 시스템 불안정·복구 실패·사용자 정상 접근 장애·예상 밖 권한 변화가 있으면 중단하고 관측 결과·마지막 변경·복구 결과를 기록한다. 변경 전 권한을 복원하지 못하면 다음 보호 실험을 시작하지 않는다. 현재 요청은 실험 설계이며 보안 설정 변경 허가는 아니다.

## 중단·복구·인수인계

1. 문제를 숨기지 않고 작업 ID·발생 조건·영향·이미 바뀐 파일/데이터를 기록한다.
2. 추가 손상을 만드는 변경을 멈추고 기존 파일·미커밋 변경을 보존한다.
3. 가능한 가장 작은 되돌림·백업 복구를 선택하며 기존 작업을 초기화하지 않는다.
4. 재현과 결과를 확인하고 실패 검증·관련 정상 흐름을 다시 확인한다.
5. STATUS·작업 기록·Notion 요약을 갱신한다. 다음 담당이 읽을 기준 커밋·검증 결과·남은 조건을 전달한다.

인증·권한·네트워크로 원격 작업이 안 되면 실제 오류를 그대로 분류하고 로컬 결과와 남은 조치를 보고한다. 보안 설정을 약화하거나 다른 출처의 인증정보를 찾는 것으로 해결하지 않는다.
