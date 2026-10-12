# X-002 현재 PC 부분 조사 결과 — 2026-10-12

**제한 프로세스의 실제 파일 읽기·쓰기·삭제 거부는 확인하지 못했다.** 일반 사용자 접근과 정책 적용 실패 시 실행 차단·권한 복원은 확인했다. 제한 프로세스는 초기화 중 종료했고, 후속 버전은 Windows 응용 프로그램 제어 정책이 실행을 차단했다. X-002의 부분 조사 산출물이며 R-09/R-10 충족이나 T-014 착수 근거가 아니다.

담당은 별도 worktree의 Codex, 요청 모델 `gpt-6-astra / max`, 실제 원격 모델 신원 독립 미확인이다. 기준 커밋 `d77b4fb21d49ec2818283ab0df618b7fc992d311`, 브랜치 `spike/x-002-file-access`, 시작 미커밋 변경 없음. 변경은 `experiments/x-002-file-access/` 및 해당 worktree의 Git 제외 `.runtime/`에 한정했다. 공통 기록·Notion·원격 push는 총괄 담당이다.

## 목표·설계·구현 상태

목표는 가짜 보호/허용 파일을 새 시험 폴더에 만들고, 현재 일반 사용자와 그 토큰의 제한 사본으로 만든 프로세스·자식을 비교하는 것이었다. 계정·설치·방화벽·드라이버·기존 사용자 파일/ACL·전역 보안 정책은 바꾸지 않는다. 사용자가 현재 PC 실험을 지정했으므로 초기 문서의 VM/전용 계정 제안과 구분하여 이 범위에서 수행했다.

`CreateRestrictedToken(DISABLE_MAX_PRIVILEGE)`와 제한 SID의 두 번째 접근 검사를 사용했다. 보호 파일은 상속을 끊고 사용자·SYSTEM만 허용하며, `OWNER RIGHTS`의 묵시적 DACL 변경 권한을 줄이는 대조를 설계했다. Everyone·Authenticated Users·Users 및 후속의 현재 로그온 SID는 시스템 실행 자원 접근 후보다. 이 SID들로 접근 가능한 모든 시스템 자원까지 격리하는 방법이 아니다. [공식 제한 토큰 설명](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)

소스에는 직접·자식의 read/write/delete, 허용 파일 작업, WRITE_DAC/WRITE_OWNER, 실제 DACL 변경, FILE_DELETE_CHILD, 빈 보호 폴더 삭제, 이름 변경, 하드링크·확장/상대 경로, 사전 열린 가짜 파일 핸들 전달, 정책 실패 차단, ACL 복원·정리 행렬을 구현했다. **행렬 구현과 실제 실행 성공은 다르며, 이번 제한 프로세스 본문은 실행하지 못했다.** 소유자/사전 핸들 우회가 실제 성공했다는 주장도 하지 않는다.

복원은 변경 전에 저장한 ACL을 부모부터 적용한 뒤 전체 재조회하여 비교한다. 정리는 fixture 경계·소유 표식·재분석 지점 부재를 확인하고 개별 파일/빈 폴더를 제거한다. 강제 전역 프로세스 종료는 사용하지 않았다. 새로 만든 helper만 일시 정지 상태에서 자체 Job에 연결하며, Job 종료 시 해당 자식만 정리하도록 구성했다.

## 실제 환경과 실행별 결과

`Win32_OperatingSystem` 조회: Windows 11 Home, `10.0.26200`/build `26200`; Windows PowerShell `5.1.26100.9444`; 설치된 .NET Framework C# compiler `4.8.9221.0`. controller 토큰은 일반 사용자, `elevated=false`, `restricted=false`였다. .NET의 초기 `Environment.OSVersion=6.2.9200.0`은 호환성 표시이므로 실제 Windows 버전으로 쓰지 않았다.

원시 결과의 기준 경로는 담당 worktree의 `.runtime/x-002-file-access/`다. 결과·시험 실행 파일은 Git에 넣지 않았다. 아래 시간은 KST다.

| 실행 폴더 | 실제 관측 | 복원·정리 및 본문 실행 |
|---|---|---|
| `run-20261012-174207-9cd01abf896a4042934bfe5414d1b13a` | 제한 SID 3종. 일반 사용자 보호/허용 read/write/delete 6개 성공. `CreateProcessAsUser` 성공(error 0), PID 15908이 `3221225794 (0xC0000142)`로 종료. Job active 0 | 제한 파일 행렬/자식 미실행. 초기 보고서 복원 false는 부모 복원 전 자식 ACL 비교 순서의 오류. 종료 후 전체 원본 ACL 일치 재확인, `recovery.json`에 복원 true·fixture 삭제 true. 원래 실패 보고서는 보존 |
| `run-20261012-174421-a86ad6909572427399a85af6055e2322` | .NET `WindowsIdentity.Groups`로 로그온 SID를 얻으려 했으나 실제 목록에 없어 SID는 기존 3종. 사용자 6개 성공. 프로세스 생성 성공(error 0), PID 5104, 같은 `0xC0000142`, Job active 0 | 복원 true·fixture 삭제 true. 제한 본문/자식 미실행 |
| `run-20261012-174850-aa40dddcd2c046c385cff38c75f786a9` | `GetTokenInformation(TokenLogonSid)`로 현재 로그온 SID가 실제 추가됨. 사용자 6개 성공. 프로세스 생성 성공(error 0), PID 23976, 같은 `0xC0000142`, Job active 0 | 복원 true·fixture 삭제 true. 제한 본문/자식 미실행 |
| `run-20261012-175029-f67c9884c1be45f79f4f7ab391ae53d3` | 없는 가짜 대상에 정책 DACL 설정 시 `FileNotFoundException`. 제한 토큰/프로세스 생성 단계에 도달하지 않음 | 정책 실패 시 실행 차단 확인. 복원 true·fixture 삭제 true. 사용자/제한 파일 행렬은 이 실행에서 수행하지 않음 |
| `run-20261012-175306-9fefe052a8da45a1aec506ea87e1ce81` | 새 GUID 비표시 desktop 비교 코드 컴파일 성공. `FileAccessProbe.exe` controller 시작 자체를 응용 프로그램 제어 정책이 차단 | controller `Main`, fixture, 새 desktop, 제한 자식 모두 미실행. `report.json` 없음. 환경 파일·컴파일 결과·차단 이벤트만 보존. fixture 없음 확인 |

초기 `0xC0000142`는 DLL 초기화 실패 상태이며 **desktop 권한, .NET/Windows 자원 접근 또는 다른 정확한 원인을 확정하지 않았다**. DLL/레지스트리 개별 로드 추적을 수행하지 않았고, 뒤의 응용 프로그램 제어 차단을 앞선 실패 원인으로 소급하지 않는다. 또한 실제 API 생성은 성공했으므로 “일반 사용자 CreateProcessAsUser는 항상 1314”라는 설명은 이 실측과 맞지 않는다. 자기 primary token의 제한 사본에는 특권 예외가 있다. [CreateProcessAsUserW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw)

원시 실행은 수정 중인 버전별 바이너리를 보존한다. 마지막 소스에는 새 desktop 비교 코드가 포함되어 이전 3회의 바이너리와 다르다. 초기 3회는 해당 `report.json`의 `helperSha256`과 보존된 실행 파일로 식별한다. 후속 실행기의 소스 사본·해시 저장은 마지막에 추가했으며 이전 실행에 소급했다고 쓰지 않는다.

## 실행 차단의 확인 근거

`FileAccessProbe.exe`는 이 실험의 C# 소스를 로컬에서 컴파일한 **미서명 테스트 프로그램**이다. 마지막 파일의 `Get-AuthenticodeSignature` 결과는 `NotSigned`(값 2), `SignerCertificate=null`이었다. SHA-256은 `1D39954ACD7DD6B7206ACB1191FF8B669FC1DB9CEF98C7415A8D1BE481487C10`이다.

17:53:08~09의 읽기 전용 이벤트 조회에서 정확한 helper 경로와 해당 Flat Hash가 일치했다.

| 관측 | 결과 |
|---|---|
| Provider | `Microsoft-Windows-CodeIntegrity` |
| 이벤트 ID | `3033`, `3077`, `3118` 각각 3건. 의도한 실행 요청은 1회이며 수동 재시도하지 않음 |
| 3077 Status | `0xc0e90002` — 이벤트의 상태 코드이며 Win32 GetLastError 관측값으로 쓰지 않음 |
| 정책 이름 | `VerifiedAndReputableDesktop` |
| Signing Level | Requested `2`, Validated `1` |
| AppLocker EXE and DLL | 조회한 시각 범위에 일치 이벤트 없음 |
| 원본 증거 | 위 마지막 run의 `application-control-events.json`에 해당 경로 이벤트 XML 보존 |

Microsoft 문서에서 3077은 실제 적용 중인 App Control 정책의 실행 차단 이벤트다. 숫자만으로 악성코드 판정 또는 “미서명이 유일한 원인”이라고 확대하지 않았다. [공식 이벤트 설명](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/operations/event-id-explanations)

차단 이후 실행 파일의 다른 이름/위치/컴파일 옵션 재시도, `Unblock-File`, 예외 추가, 보안 설정 변경을 하지 않았다. 새 desktop 코드도 실행하지 못했으므로 생성·격리·정리를 검증했다고 표시하지 않는다. 기존 desktop/window-station ACL 변경·`SwitchDesktop`·화면 전환 코드는 없다.

## 검증과 한계

실행한 C# 버전들은 설치된 컴파일러에서 빌드됐다. 현재 새 desktop 소스도 컴파일만 통과했다. 초기화 실패 3개는 `verify-report.mjs --initialization-failure`로 API 성공/초기화 실패/본문 미실행/복원·정리를 확인했고, 정책 실패 1개는 `--policy-failure`로 실행 미생성/복원·정리를 확인했다. 이는 **실패 보고의 일관성 검사 4개 통과**이며 파일 보호 행렬 4개 통과가 아니다.

전체 행렬 검증기에 3차 초기화 실패 보고서를 넣었을 때 `observationsComplete=false`에서 실제 종료 코드 1로 거절했다. 실패 보고를 전체 보호 통과로 잘못 받아들이지 않았다. 마지막 PowerShell 실행기의 구문 분석 및 Node 검증기 구문 검사도 통과했다. 실행기 오류 기록·소스 사본 저장의 마지막 보완은 helper 재실행 없이 검사했다.

최종 재조회에서 run 5개의 fixture 모두 없음, 해당 자체 helper 프로세스 조회 0이었다. 초기 3회는 각 실행의 Job active 0도 별도로 기록했다. 새 desktop은 마지막 controller 자체가 시작하지 않았으므로 생성되지 않았으며, desktop 생성 성공 후 종료 코드는 미검증이다.

기존 Explorer 1개·Edge 5개의 PID/시작 시각/응답·CPU·메모리를 실행 전후 관측했다. 원시 보고가 있는 4회 모두 전후 6개가 기록됐다. 이 시점에 Blender/Electron 관측 대상은 없었다. 실제 사용자 조작·외부 통신·장시간 안정성·블루스크린 원인 배제는 검사하지 않았다. 프로세스 관측을 다른 앱의 완전 정상 동작 보증으로 확대하지 않는다.

보호 파일 해시는 제한 실행 전 저장했지만 초기화 실패로 제한 실행 후 해시 비교 단계에 도달하지 않았다. 따라서 `보호 파일 불변`이라는 전체 행렬 판정도 미검증이다. OS가 직접 파일 접근을 거부한 오류 5, 제한된 자식의 토큰 상속, 허용 작업 정상, owner/부모/하드링크/사전 핸들 대조는 모두 코드 구현만 있고 실제 결과가 없다. 실제 Codex/PTY·서비스/프록시 우회·감사 수집·앱 통합/재시작·경로 교체 공격도 미검증이다.

## 재현 명령과 다음 판단

정확한 실행·검증 인터페이스는 [README](README.md)와 소스에 있다. 당시 실행 명령은 다음과 같다.

```powershell
powershell.exe -NoProfile -File experiments\x-002-file-access\run.ps1
powershell.exe -NoProfile -File experiments\x-002-file-access\run.ps1 -InjectPolicyFailure
node experiments/x-002-file-access/verify-report.mjs --initialization-failure .runtime/x-002-file-access/run-20261012-174850-aa40dddcd2c046c385cff38c75f786a9/report.json
node experiments/x-002-file-access/verify-report.mjs --policy-failure .runtime/x-002-file-access/run-20261012-175029-f67c9884c1be45f79f4f7ab391ae53d3/report.json
```

현재 PC에서는 실행 차단 상태를 유지한다. 보호 후보 채택은 보류하며 **T-014 통합은 착수하지 않는다**. 후속 선택은 정책을 완화하지 않는 별도 실험 환경에서 초기화 원인을 조사하거나, 설계에 있던 별도 계정/AppContainer 후보를 비교하는 것이다. 이들은 이번에 설치·실행·검증하지 않았고 추가 환경·범위의 판단이 필요하다.

Gemini 코드 검토에 필요한 핵심 범위: `MakeRestrictedToken`/`NewPrivateDesktop`/`Launch`/`Worker`/`ApplyPolicies`/`RestoreAcls`/`CleanFixtures`/`Guard`, 실행기 경로 경계와 실패 기록, 결과 검증기의 성공·실패 구분. 이미 관측한 실패를 숨기기 위한 정책 우회나 제품 통합 승인을 검토 목표로 삼지 않는다. 공통 문서에 대한 최종 반영·독립 의견 채택 여부는 총괄이 기록한다.

## 2026-10-12 18:36 이후 읽기 전용 원인 대조

담당은 기존 Codex 파일 접근 보호 실험 담당이다. 요청 모델은 `gpt-6-astra / max`이며 실제 원격 모델 신원은 독립적으로 확인하지 못했다. 이 추가 조사는 앞선 실패를 보존한 상태에서 보고서·이벤트·기존 코드만 읽었다. source 변경, 재컴파일, helper 재실행, 보안 설정 변경 또는 차단 해제는 하지 않았다. 아래 내용은 당시 조사 결과이며 이후 README/RESULTS 문서 보충은 별도 작업이다.

### 초기 자식 종료와 마지막 controller 차단

시각은 KST이며 각 초기 자식의 경로는 아래 실행 폴더의 `fixtures/tools/probe.exe`다. 실행 폴더의 공통 위치는 이 worktree의 `.runtime/x-002-file-access/`다.

| 실행 폴더 | 제한 자식 시작 시각 | controller / child PID | 실제 관측 | 정확한 경로·PID에 일치하는 이벤트 |
| --- | --- | --- | --- | --- |
| `run-20261012-174207-9cd01abf896a4042934bfe5414d1b13a` | 17:42:09.2705973 | 14344 / 15908 | 생성 API error 0, 자식 종료 `3221225794` (`0xC0000142`) | 0개 |
| `run-20261012-174421-a86ad6909572427399a85af6055e2322` | 17:44:22.4297267 | 14908 / 5104 | 생성 API error 0, 자식 종료 `0xC0000142` | 0개 |
| `run-20261012-174850-aa40dddcd2c046c385cff38c75f786a9` | 17:48:52.8460099 | 14648 / 23976 | 생성 API error 0, 자식 종료 `0xC0000142` | 0개 |
| `run-20261012-175306-9fefe052a8da45a1aec506ea87e1ce81` | 자식 생성 전 차단 | 호출 PowerShell 11564, controller/child 미생성 | controller `FileAccessProbe.exe`의 실행 정책 차단 | 3033·3077·3118 각 3개와 연관 서명 이벤트 |

첫 조회는 각 자식 시작 10초 전부터 보고서 종료 30초 후까지 CodeIntegrity/Operational, AppLocker/EXE and DLL, AppLocker/MSI and Script, Application 로그를 읽었다. 전체 경로의 드라이브 뒤 부분을 대조해 NT 장치 경로 형식도 포함했고, 이름이 있는 이벤트 데이터의 PID도 비교했다. 마지막 실행은 17:52:58~17:53:40을 조회했다.

지연 기록 가능성을 확인하기 위해 17:40~18:00으로 넓혀 같은 로그와 System을 추가 조회했다. 실행 폴더 식별자에 일치하는 경로를 찾고, 각 시작 10초 전~종료 60초 후의 자체 controller·child·호출 PowerShell의 이벤트 실행 PID도 별도 후보로 확인했다. CodeIntegrity 59개와 Application 2개를 읽었으며, AppLocker 두 로그와 System은 해당 시간대 기록이 없었다. 최초 세 실행의 경로 또는 자체 PID와 일치하는 추가 기록은 없었다. 로그 접근 권한 실패는 없었고 기록이 없는 조회의 `NoMatchingEventsFound`는 별도로 보존했다.

2차 직후 17:44:24의 CI 3033/3089(기록 22660/22661, PID 13344)와 3차 직후 17:49:00의 CI 3033/3089(22670/22671, PID 19312)는 이번 controller·child PID 및 경로와 일치하지 않았다. 가까운 시각이라는 이유로 초기화 실패 원인으로 채택하지 않았으며 관련 없는 이벤트 본문은 증거 파일에 저장하지 않았다.

마지막 차단은 `FileAccessProbe.exe`의 정확한 경로와 기존 SHA256 `1D39954ACD7DD6B7206ACB1191FF8B669FC1DB9CEF98C7415A8D1BE481487C10`에 일치한다. 3077의 정책은 `VerifiedAndReputableDesktop`, 상태는 `0xc0e90002`이며 이는 이벤트의 상태값이지 이번에 관측한 Win32 `GetLastError` 값이 아니다. 3033/3077과 ActivityID가 연결된 3089는 `TotalSignatureCount=0`, 발행자 `Unknown`을 기록했다. 이 증거는 정책 차단과 서명 부재를 뒷받침하지만 악성 프로그램 판정이나 서명 부재만이 유일한 원인이라는 판정은 아니다.

### 확정한 내용과 남은 원인

Microsoft는 `0xC0000142`를 `STATUS_DLL_INIT_FAILED`로 정의하고, `CreateProcessAsUser`가 자식 초기화 완료 전에 반환하며 DLL 초기화가 실패하면 프로세스가 종료될 수 있다고 설명한다. 따라서 초기 세 번의 API 생성 성공을 worker 본문 실행 성공으로 간주할 수 없다. [NTSTATUS 정의](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55), [CreateProcessAsUserW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw)

초기 세 번과 마지막 차단이 같은 원인이라는 증거는 확보하지 못했다. 초기 이벤트 부재만으로 정책 개입을 배제할 수도 없다. 실패한 DLL·레지스트리·desktop·기타 초기화 자원은 미확정이다. 현재 소스의 `lpProcessAttributes`/`lpThreadAttributes`는 NULL이므로 기본 보안 정보가 사용되며, 제한 SID가 있는 토큰은 두 번의 접근 검사를 통과해야 한다. 새 토큰의 기본 ACL과 초기화 의존 자원, desktop 접근권한은 후속 진단 후보이지 확인된 결함이나 수정 효과가 아니다. 전체 사용자 SID 추가나 기존 시스템 자원의 ACL 확대로 추측을 해결한 것으로 처리하지 않는다. [제한 토큰의 접근 검사](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens), [액세스 토큰과 기본 ACL](https://learn.microsoft.com/en-us/windows/win32/secauthz/access-tokens)

마지막 실행의 3077은 강제 적용 정책의 차단 이벤트이며 `VerifiedAndReputableDesktop`는 Smart App Control 적용 정책 이름에 해당한다. 이 차단은 초기 실패와 구분해 확정한다. [이벤트 설명](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/operations/event-id-explanations), [Smart App Control 정책 확인](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control)

### 구체적인 다음 단계와 완료 조건

1. 현재 허용된 읽기 전용 단계에서는 기존 공개 코드 서명 인증서의 메타데이터와 `signtool` 등 기존 도구, 기존 Windows VM 실행기·시험 환경의 가용성을 확인할 수 있다. 개인키 내용·내보내기는 대상이 아니다. 다른 AI/CLI 검증과 겹치지 않도록 총괄이 조회 순서를 배정한다. 이번 조사에서는 해당 인증서·도구·VM 가용성까지 확인하지 않았다.
2. Microsoft가 안내하는 정책 호환 경로는 신뢰받는 CA 또는 Artifact Signing의 공개 신뢰 서명이다. 기존 실패 바이너리를 보존하고 검토된 helper를 정상 서명한 뒤 현재 정책에서 재검증하는 안이다. 서명 권한·서비스 자격·비용·외부 서비스 사용·도구 설치가 필요한지 먼저 확인해야 한다. 서명한 파일의 실제 정책 통과도 미검증이며, 통과하더라도 초기 DLL 실패 원인 분리를 계속해야 한다. 자체 서명 인증서를 신뢰 저장소에 추가하거나 차단 코드를 다른 호스트에서 실행하는 방식은 이 안에 포함하지 않는다. [공식 서명 경로](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control), [Artifact Signing 조건](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
3. 이미 이용 가능한 별도 Windows VM 또는 시험 PC가 있다면 가짜 자료로 초기화 원인을 분리하는 안도 있다. 현재 PC의 Windows 11 Home은 Windows Sandbox 공식 지원 대상이 아니므로 곧바로 사용할 수 있는 내장 대안으로 제시하지 않는다. 새 설치·기능 활성화·재부팅·환경 마련이 필요하면 구체 범위와 사용자 결정이 먼저다. 별도 환경 결과는 그 환경에만 적용하며 현재 PC에서 반드시 재검증해야 한다. 이 안은 보류한 **X-003 두 기기 파일 전송의 재개가 아니다.** [Windows Sandbox 지원 환경](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/)

2026-10-12 확인한 Artifact Signing 조건은 공개 신뢰 서명에서 한국 조직을 포함하지만 개인 개발자는 미국·캐나다로 제한한다. 이는 조건부 참고이며 사용자의 거주지·국적·계정 조직 형태나 가입 가능성을 추정한 것이 아니다. 실제 이용 시 최신 조건을 다시 확인해야 한다.

정책에 맞는 실행 수단을 확보한 뒤에는 같은 조건의 일반 자식과 제한 자식을 구분하고, 새 토큰의 기본 ACL·실제 제한 SID·실패 자원·종료 상태를 기록하는 진단부터 설계한다. 새 객체 범위를 벗어난 권한 변경을 자동으로 적용하지 않는다. helper 실험의 성공 조건은 일반 사용자 성공, 제한된 부모·자식의 보호 파일 read/write/delete에 대한 실제 OS `ERROR_ACCESS_DENIED(5)`, 허용 파일 정상 작업, 보호 파일 해시 보존, ACL 복원과 자체 Job·desktop 정리다. owner 권한·상위 폴더 삭제·링크·미리 열린 핸들의 관측도 분리해야 한다. 실제 Codex/PTY, 서비스·프록시 및 제품 통합은 추가 검증 대상이므로 **X-002 해결 완료와 T-014 착수 승인은 여전히 아니다.**

### 추가 증거와 정리 상태

Git에서 제외되는 `.runtime/x-002-file-access/investigation-20261012-183611-22a18ce308234eff9711d73f85834fc4/`에 다음 증거를 보존했다.

- `initialization-event-correlation.json`: 4개 대조 실행의 정확한 경로·시각·PID, 로그 상태, 첫 조회 조건과 일치 이벤트 XML.
- `expanded-event-correlation.json`: 20분 확장 조회 조건·건수, 초기 시각의 다른 CI 이벤트 메타데이터, 마지막 실행의 일치 이벤트와 관련 서명 정보. PID만 일치하는 후보를 경로 일치와 구분한다.

추가 조회 종료 시 자체 helper 프로세스는 0개이고 이번 대조 대상 4개 실행의 fixture 폴더는 모두 없었다. 정책 실패 주입 실행을 포함한 기존 5개 실행의 이전 복원·정리 근거는 위 원기록을 유지한다. 새 fixture·desktop은 만들지 않았다. 소스와 실행 산출물은 변경하지 않았고, 추가 조사 뒤 README/RESULTS만 문서 보충 대상으로 삼았다.

### 후속 환경 확인: 총괄의 제한 조회 결과

사용자는 기존 VM·코드 서명 수단이 별도로 없는 것 같다고 답했다. 총괄이 전달한 `.runtime/x002-environment-inventory.json`(총괄 작업 폴더)에 따르면 PATH·일반 설치 경로의 관련 도구, Windows Kits의 x64 `signtool`, 현재 사용자 개인 인증서 저장소에서 코드 서명 EKU를 가진 인증서의 메타데이터, 실행 중 VM 제품 프로세스의 조회 결과는 각각 0건이다. 개인키 내용은 조회하지 않았다. 이 담당자는 해당 조회를 재실행하지 않았으며 위 결과는 총괄 확인 자료에 근거한다.

조회 범위 밖의 설치 경로·인증서 저장소·원격 서명 서비스·꺼진 VM의 부재까지 확인한 것은 아니다. 즉시 이용 가능한 기존 수단이 확인되지 않았다는 환경 사실만 추가하며, 가입 자격·설치 가능성·결제·실험 성공을 확정하지 않는다. 이 후속 단계에서 설치·다운로드·컴파일·helper 실행·보안 변경은 수행하지 않았다. 초기화 실패의 미확정 원인, 호스트 정책 차단, T-014 차단 및 X-003 보류 판정은 그대로다.
