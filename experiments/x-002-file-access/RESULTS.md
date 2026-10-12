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
