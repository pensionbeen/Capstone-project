# T-001 개발 환경 확인

기준일: **2026-10-03 KST**. 기록 ID: **WL-20261003-03**. 작업: T-001, 관련 요구: R-05·R-14·R-16. 현재 결과는 환경 조사와 개발 준비이며 앱 실행·AI 대화·PTY 호환성 검증이 아니다.

## 결과와 확인 수준

- 직접 확인: Windows/CPU/메모리, Git·Node·npm 실행, 저장소·선행 커밋·작업 브랜치, 제외 규칙.
- 사용자 터미널 결과: npm 설치 폴더의 codex.ps1·gemini.ps1, Codex **0.160.0**·Gemini **0.62.0**. 설치·로그인 완료는 사용자 보고이며 현재 세션의 인증 검증과 구분한다.
- 선정: Electron **44.5.1** + node-pty **1.1.0**, Windows x64를 첫 실험 후보로 사용.
- 미검증: 후보 설치·모듈 로딩·현재 세션 CLI 실행·계정별 인증/모델/한도·PTY/패키징. 사용자 터미널의 버전 결과를 이 세션에서 실행한 것처럼 기록하지 않는다.
- 이번에 하지 않은 일: 패키지/CLI 설치·업데이트, 앱 코드 구현, 인증 파일 열람, 모델 변경, OS 권한·방화벽 변경, main 병합.

## 직접 조사한 환경표

| 항목 | 결과 | 방법·한계 |
|---|---|---|
| 작업 저장소 | `C:/Users/jbiho/dev/Capstone-project` | Git 루트와 현재 경로 일치 |
| Windows | **Windows 11 Home 25H2, 26200.9457, x64** | Node `os.version()`·`os.release()`와 레지스트리 DisplayVersion/CurrentBuild/UBR 대조 |
| CPU | **AMD Ryzen 5 5600X 6-Core Processor**, 논리 CPU 12개 | CPU 레지스트리와 Node `os.cpus()` |
| 메모리 | 약 **15.9 GiB** 사용 가능 총 물리 메모리 | Node `os.totalmem()`; 순간 여유 메모리·성능 시험 아님 |
| 셸 | Windows PowerShell **5.1.26100.9444**, Desktop | `$PSVersionTable`. Markdown 조회는 `Get-Content -Encoding UTF8` |
| Git | **2.45.1.windows.1** | `git --version` 실행 성공, `C:/Program Files/Git/cmd/git.exe` |
| 개발용 Node | **24.15.0**, win32/x64, modules 137 | `node --version`·`process.versions` 실행 성공, `C:/Program Files/nodejs/node.exe` |
| npm | **11.12.1** | `npm.cmd --version` 실행 성공. PowerShell 스크립트 정책을 바꾸지 않고 기존 cmd 진입점 사용 |
| npm 전역 경로 | `C:/Users/jbiho/AppData/Roaming/npm` | `npm.cmd prefix -g`; root는 하위 `node_modules`. 설정값이며 CLI 파일 존재 증거 아님 |
| VS Code | **1.140.0** | `C:/Users/jbiho/AppData/Local/Programs/Microsoft VS Code/Code.exe` 파일 버전. 앱 실행 시험 아님 |
| Python·MSVC | 현재 PATH에서 Python/py/MSBuild/cl 미발견 | VS Installer의 vswhere는 존재하지만 C++ 도구 요구 조건 조회 결과 없음. 미설치 단정 금지 |
| Windows SDK | 표준 `Program Files (x86)/Windows Kits/10` 경로 미발견 | 다른 설치 경로·컴포넌트는 미확인 |
| 프로젝트 패키지 | package.json·잠금 파일·앱 코드 없음 | 시작 당시 추적 파일은 Markdown 11개. npm dev/build/test 명령 미정 |
| 실행 계정·네트워크 | CodexSandboxOffline, GitHub 443 연결 실패 | 일반 사용자 터미널과 권한·PATH·인증 접근이 다름. 외부 실행 승인은 현재 세션 정책상 요청 불가 |

레지스트리 ProductName은 `Windows 10 Home`으로 남아 있었다. Node의 제품명은 Windows 11 Home이며, 직접 읽은 빌드 26200.9457·25H2도 Microsoft의 Windows 11 자료와 일치한다. WMI(`Get-CimInstance`)는 접근 거부였으므로 그 응답을 환경 증거로 사용하지 않았다. 권한 변경 없이 읽을 수 있는 레지스트리·Node API로 확인했다. [Microsoft 빌드 목록](https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information)

## 설치된 AI CLI 확인

| 항목 | Codex CLI | Gemini CLI |
|---|---|---|
| 역할 | **앱의 첫 연결 대상** | **독립적인 설계·코드 검토** |
| 설치·로그인 | 사용자 보고로 완료 | 사용자 보고로 완료 |
| 현재 PATH 검색 | 미발견 | 미발견 |
| 사용자 터미널의 실행 경로 | `C:/Users/jbiho/AppData/Roaming/npm/codex.ps1` | `C:/Users/jbiho/AppData/Roaming/npm/gemini.ps1` |
| 전역 npm 후보 | `.../Roaming/npm/codex.cmd`, `node_modules/@openai/codex/package.json` 조회 접근 거부 | `.../Roaming/npm/gemini.cmd`, `node_modules/@google/gemini-cli/package.json` 조회 접근 거부 |
| CLI 버전 | **0.160.0** · 사용자 터미널 결과 | **0.62.0** · 사용자 터미널 결과 |
| 현재 세션의 cmd 버전 실행 | 같은 폴더 `codex.cmd --version`: CommandNotFoundException·종료 1 | 같은 폴더 `gemini.cmd --version`: CommandNotFoundException·종료 1 |
| 현재 세션에서의 인증 확인 | 미실행; 사용자 로그인과 별개 | 미실행; 사용자 로그인과 별개 |
| 계정의 사용 가능 모델·현재 선택 모델 | 미확인 | 미확인 |
| 사용량·남은 한도·초기화 시각 | 미확인 | 미확인 |

설치 위치 조사는 PATH·npm prefix/root, 알려진 사용자 설치 경로, WinGet Links·VS Code 확장·시스템 Node 모듈의 관련 실행 파일명으로 한정했다. 다른 개인 자료나 인증 파일은 열지 않았다. `Test-Path`가 접근 거부와 함께 False를 반환한 항목은 **없음이 아니라 접근 불가**로 정정해 해석했다. 재설치하지 않았다.

### 일반 사용자 PowerShell에서 보완할 확인

사용자가 설치 경로와 위 버전을 제공했다. 이어 Windows에서는 **codex.cmd·gemini.cmd**를 사용하도록 지정했다. 전체 cmd 경로를 사용해 현재 세션에서도 시도했지만 실행 파일을 인식하지 못했다. 해당 설치 폴더 조회의 접근 거부와 함께 기록하며, cmd 파일이 실제로 없다고 단정하지 않는다.

아래는 사용자 권한에서만 가능한 추가 **확인 방법**이다. 버전은 이미 사용자 보고가 있으므로 cmd 진입점 확인이 필요한 경우에만 다시 실행한다. 인증·계정별 모델/한도는 아직 미확인이다.

```powershell
Set-Location -LiteralPath 'C:\Users\jbiho\dev\Capstone-project'
Get-Command codex.cmd,gemini.cmd -All | Select-Object Name,Source
& 'C:\Users\jbiho\AppData\Roaming\npm\codex.cmd' --version
& 'C:\Users\jbiho\AppData\Roaming\npm\gemini.cmd' --version
& 'C:\Users\jbiho\AppData\Roaming\npm\codex.cmd' login status
```

사용자 환경에서도 cmd 진입점이 인식되지 않으면 `Get-Command` 결과와 설치 폴더의 해당 파일 존재 여부부터 확인한다. 실행 정책·PATH·권한을 전역 변경하거나 재설치하지 않는다. 이후 Windows 예제는 명시적으로 cmd 진입점을 사용한다.

- Codex: `codex.cmd`로 대화형 실행한다. `login status`는 저장된 인증 방식/상태 확인이다. 성공해도 서버 연결·대화·잔여 한도까지 검증한 것은 아니다. 대화형 화면의 `/status`로 모델·추론·사용량 표시를 확인하고 `/model`에서 실제 선택 가능 목록을 본 뒤 변경 없이 닫는다. 한도 표시가 없으면 미확인으로 남긴다. [공식 명령 안내](https://learn.chatgpt.com/docs/developer-commands)
- Gemini: `gemini.cmd`로 기존 로그인 상태에서 실행한 뒤 `/about`의 버전, `/model`의 사용 가능 모델, `/stats model`의 사용량·한도 표시를 확인한다. `/auth`는 인증 방식을 바꾸는 대화상자이므로 단순 상태 확인 목적으로 재로그인하지 않는다. [명령](https://geminicli.com/docs/reference/commands/), [모델 선택](https://geminicli.com/docs/cli/model/), [사용량](https://geminicli.com/docs/resources/quota-and-pricing/)
- 공유할 값: 실행 경로·버전·로그인 성공 여부·모델명·추론 수준·한도/초기화 시각처럼 확인에 필요한 항목만. 토큰·API 키·인증 파일·이메일·로그인 링크·화면 전체는 보내지 않는다.
- CLI 시작 시 프로젝트 신뢰 선택이 나오면 이 저장소인지 확인한다. 실제 개발 프롬프트는 입력하지 않고 상태만 확인한 뒤 종료한다. 계정의 실제 지원 여부를 이번 Codex 도구 세션 모델과 혼동하지 않는다.

## Electron·node-pty 후보 조합

| 구성 | 선정안 | 근거·현재 검증 |
|---|---|---|
| 개발 명령 실행 | 기존 Node **24.15.0** + npm **11.12.1** | 현재 실행 성공. 다른 패키지의 호환성까지 검증한 것은 아님 |
| 앱 런타임 | Electron **44.5.1** / Windows x64 | 공식 목록의 최신 안정판, 2026-09-29 릴리스. 설치·창 실행 미실행 |
| Electron 내부 Node | **24.21.0** | Electron 릴리스 메타데이터. PC의 Node 24.15.0과 별개 |
| PTY 라이브러리 | node-pty **1.1.0** | 공식 latest 안정판과 고정 태그의 package.json 확인. 실기 실행 미실행 |
| 조건부 비교 후보 | Electron **43.7.7** + node-pty **1.1.0** | 44 계열 문제를 재현·분리한 경우에만 비교. 자동 다운그레이드하지 않음 |

Electron 44 계열은 확인한 지원 일정상 2027-03-02까지 유지되는 대상으로, 최종 프로젝트까지의 후속 검증에 적합한 출발점이다. 45의 시험판이나 node-pty 1.2 시험판을 기본에 넣지 않는다. 설치 시점에 안정판 변경·보안 수정 여부를 재확인하고 변경 이유를 남긴다. [안정판 목록](https://releases.electronjs.org/?channel=stable), [44.5.1 릴리스](https://releases.electronjs.org/release/v44.5.1), [지원 일정](https://releases.electronjs.org/schedule), [node-pty 안정판](https://github.com/microsoft/node-pty/releases/tag/v1.1.0)

node-pty 1.1.0의 설치 스크립트는 준비된 바이너리를 시도하고 실패하면 node-gyp 빌드로 이어진다. 해당 Windows x64 패키지의 실제 포함물·로딩 여부는 아직 확인하지 않았다. 별도 C++ 빌드가 필요하면 Python·MSVC·Windows SDK를 확인한 뒤 필요한 것만 후속 범위에서 준비한다. 이번에는 설치하지 않았다. [고정 태그 package.json](https://raw.githubusercontent.com/microsoft/node-pty/v1.1.0/package.json)

**공식적으로 검증된 버전 쌍이라는 뜻은 아니다.** 로컬 Node에서 로딩된 파일이 Electron에서도 동작한다고 가정하지 않는다. 네이티브 모듈은 OS/CPU·런타임과 맞아야 하며, 필요하면 Electron 대상 재빌드와 동봉 DLL/실행 파일을 검증한다. ABI는 실행 파일과 네이티브 모듈 사이의 호출 규약을 뜻한다. 최종 PTY 실행부가 일반 Node 프로세스인지 Electron 계열 프로세스인지도 기록해야 한다. [Electron 네이티브 모듈](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)

### 다음 실험에서 확인할 항목 — 모두 미실행

1. **X-001:** 실제 Codex 경로·버전·인증 상태·네트워크·선택 모델을 확인한 일반 사용자 터미널에서 샘플 대화와 종료를 먼저 재현한다.
2. **X-001:** Node와 node-pty 후보 설치/로딩, PowerShell·Codex 입출력, 한글·공백 경로, 크기 변경, 정상/강제 중단, 자식 프로세스·핸들 정리를 시험한다.
3. **T-002/T-003:** Electron 44.5.1의 첫 창·폴더 선택, 실제 PTY 실행 프로세스의 네이티브 모듈 로딩, UI 연결/재실행, 배포물의 DLL/실행 파일 포함·종료를 검증한다.
4. 모듈 로딩 오류면 아키텍처·런타임·설치 산출물·재빌드 필요를 먼저 분리한다. 보안 프로그램 해제나 관리자 상시 실행으로 해결하지 않는다.
5. X-001의 기존 4~8h·8h 판단 한도를 유지한다. 실패하면 근거·대안·추가 공수를 기록하고 다음 통합을 성공으로 처리하지 않는다.
6. OS 접근 차단은 **X-002**, 두 실제 기기 전송은 **X-003**이다. 이번 환경 조사·PTY 성공으로 대체하지 않는다.

## 브랜치·제외 규칙

- 기준 커밋: `f8730ac0470bc62b59c8aa67864240eb676cb121`, docs/project-plan의 문서·검증 기록.
- 원격 추적 docs/project-plan도 같은 해시이고 **15:24:48 KST update by push** 이력이 있다. 이는 이전 작업 뒤 다른 실행에서 push된 로컬 증거다. 이 세션의 실시간 원격 조회는 여전히 실패했다.
- 로컬 main 커밋·원격 추적 main 없음. 원격 main의 실제 존재는 조회하지 못했다. 선행 병합을 기다리지 않을 때 명시한 커밋에서 분기하는 기존 규칙에 따라 **chore/t-001-environment** 생성, main에는 반영하지 않았다.
- 시작 시 변경 없음. 로컬에 같은 T-001 브랜치 없음 확인 후 생성. 원격의 같은 이름은 미확인이고 일반 push가 충돌하면 멈춰 비교한다.
- [.gitignore](../.gitignore): 의존성·인증/개인 설정·실행 DB/WAL/SHM·로그·빌드·캐시/백업 제외. 실제 소스·SQL 마이그레이션·package.json·잠금 파일·AGENTS/GEMINI·문서 보존.
- `.env.example`·`.env.*.example`·`.env.template`은 공유 가능하지만 가짜 값만 넣는다. 프로젝트에서 공유할 인증 없는 npm/AI 설정이 필요하면 해당 파일만 검토 후 제외 예외를 추가한다. 디렉터리 전체를 무심코 다시 포함하지 않는다.
- `git check-ignore --no-index --stdin`으로 **제외 27개·보존 22개 가상 경로** 검사 통과. 테스트용 비밀 파일이나 DB는 만들지 않았다. 제외 규칙은 이미 추적된 비밀을 지우거나 OS 접근을 차단하는 기능이 아니다.

<a id="next"></a>
## 다음 작업 선정과 시작 조건

**X-001 AI 터미널 실험을 우선 추천한다.** AI 실행과 인증·터미널 호환성은 T-003 및 이후 보호 실험의 선행 위험이다. 첫 창을 꾸미기 전에 단독 Codex가 정상 실행되는 근거를 확보하는 편이 현재 계획에 맞는다.

| 작업 | 시작 조건 | 종료/완료 판정 |
|---|---|---|
| X-001 우선 | 실제 CLI 경로·버전, 사용자 권한의 로그인 상태와 서비스 연결, 가짜 프로젝트, 설치가 필요한 실험 범위 확정 | TASKS의 입출력·한글·중단·재개/응답 형식·자원 정리 결과 및 한계. 버전 조회만으로 완료 금지 |
| T-002 다음 또는 독립 진행 | Electron/React 틀 작업 범위, 패키지 다운로드 가능한 환경, 저장소 상태·별도 기능 브랜치 | 실제 창·폴더 선택/취소/오류·제한 IPC·실행/빌드 확인 |
| T-003 통합 | X-001과 T-002 결과 | UI+PTY 실제 연결·중단·재시작·잔존 자원 검증 |

현재 CLI 접근/네트워크 제한이 남으면 X-001은 시작 조건 미충족이다. 이때 T-002는 별도 허용된 개발 환경에서 독립 진행할 수 있지만, 현재 오프라인 세션만으로 설치까지 가능하다고 약속하지 않는다. 어느 경우에도 이번 T-001에서 앱 코드·실험 코드를 만들지 않는다.

## 확인 기록과 남은 조건

| 검사 | 실제 결과 |
|---|---|
| ENV-01 OS/CPU/메모리 | 레지스트리·Node 확인 통과; WMI 접근 거부는 별도 기록 |
| ENV-02 Git/Node/npm | 버전 명령 실행 통과 |
| ENV-03 CLI 발견·인증·모델 | 사용자 경로/버전 결과 수령: Codex 0.160.0·Gemini 0.62.0. 현재 세션 cmd 실행 실패; 직접 인증·모델·한도 미확인 |
| ENV-04 후보 선정 | 공식 자료 조회 완료; 설치/실행·호환성 시험 미실행 |
| ENV-05 Git 제외 규칙 | 제외 27·보존 22 경로 검사 통과 |
| ENV-06 문서·커밋·push | Markdown 12개·요구 18·작업 35·참조 60개 등 문서 검사 통과. 커밋/push 진행 중; 실시간 원격 조회 실패 |
| ENV-07 Notion | 16:03 KST T-001 요약 반영·재조회 완료. WL-03 중복 없음; Git 최종 결과는 후속 반영 |

학교 일정·평가 기준과 친구 PC의 OS/네트워크/복구 환경은 여전히 미정이다. T-001의 **조사·준비 결과**와 **환경의 실제 실행 준비 완료**는 구분한다. 후자의 미확인 항목은 X-001 시작 전에 보완한다.

## 일반 PowerShell에서 작업 브랜치 push 확인

현재 세션의 외부 실행 승인 요청은 정책상 불가능하다. 연결 가능한 VS Code 일반 PowerShell에서 아래를 실행한다. 기존 origin과 작업 브랜치를 사용하며 main을 변경하지 않는다. 이는 실행 방법이고, 이 문서의 명령을 적은 것만으로 push 성공을 뜻하지 않는다.

```powershell
Set-Location -LiteralPath 'C:\Users\jbiho\dev\Capstone-project'
git status --short --branch
git remote -v
git ls-remote --heads origin refs/heads/chore/t-001-environment
if ($LASTEXITCODE -ne 0) { throw '원격 조회 실패: 오류를 확인하고 중단하세요.' }
git push -u origin chore/t-001-environment:refs/heads/chore/t-001-environment
if ($LASTEXITCODE -ne 0) { throw '일반 push 실패: 강제 push 없이 오류와 이력을 확인하세요.' }
$prepLocal = git rev-parse chore/t-001-environment
if ($LASTEXITCODE -ne 0) { throw '로컬 브랜치 해시 확인 실패' }
$prepRemote = git ls-remote --heads origin refs/heads/chore/t-001-environment
if ($LASTEXITCODE -ne 0) { throw 'push 후 원격 조회 실패: 반영 확인 미완료' }
if (($prepRemote -split '\s+')[0] -ne $prepLocal) { throw '로컬/원격 해시 불일치: 반영 확인 필요' }
Write-Output "작업 브랜치 push 및 원격 해시 일치: $prepLocal"
```

조회 성공과 push 성공·원격 해시 일치를 각각 확인한다. 다른 원격 이력이 있어 거절되면 강제로 덮어쓰지 않고 비교한다.

## 참고 자료

조회일은 모두 **2026-10-03 KST**. 설치 환경의 성공을 보증하는 자료는 아니며 위 선정의 근거다.

| 자료 | 확인 가능한 날짜·용도 |
|---|---|
| [Windows 11 release information](https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information) | 문서 수정일 미확인; 26200.9457 항목의 배포일 2026-09-14. OS 관측값 대조 |
| [Electron stable releases](https://releases.electronjs.org/?channel=stable) | 수정일 미표시; 직접 연 페이지의 44.5.1·43.7.7 사용. 검색 요약의 오래된 44.4.3을 최신으로 채택하지 않음 |
| [Electron 44.5.1](https://releases.electronjs.org/release/v44.5.1) · [지원 일정](https://releases.electronjs.org/schedule) | 릴리스 2026-09-29; 런타임과 지원 기간. 일정은 향후 변경 가능 |
| [node-pty 1.1.0 release](https://github.com/microsoft/node-pty/releases/tag/v1.1.0) · [package.json](https://raw.githubusercontent.com/microsoft/node-pty/v1.1.0/package.json) · [README](https://raw.githubusercontent.com/microsoft/node-pty/v1.1.0/README.md) | 고정 태그 확인; 이번 응답에서 릴리스 연도/최종 수정일 미확인. 설치 방식·Windows/권한·빌드 위험 |
| [Electron Native Node Modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules) | 수정일 미표시; 런타임별 네이티브 모듈 검증 |
| [Codex Developer commands](https://learn.chatgpt.com/docs/developer-commands) · [Authentication](https://learn.chatgpt.com/docs/auth) | 수정일 미표시; login status·상태/모델 표시. 계정 실제 한도는 별도 |
| [Gemini commands](https://geminicli.com/docs/reference/commands/) · [모델](https://geminicli.com/docs/cli/model/) · [사용량](https://geminicli.com/docs/resources/quota-and-pricing/) | 명령 문서 수정일 미확인, 모델 페이지 2026-03-19, 사용량 페이지 2026-06-18 |
