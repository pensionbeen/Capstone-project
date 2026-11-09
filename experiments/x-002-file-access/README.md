# X-002 파일 접근 보호 실험

이 도구는 현재 Windows의 **일반 사용자 토큰과 그 제한 사본**으로 새 가짜 파일에 접근하여 Win32 결과를 수집한다. 앱 보호 기능·실제 Codex 실행기·완성된 보안 격리가 아니다. 조사 결과는 [RESULTS.md](RESULTS.md)에 기록한다. X-002 전체 성공 및 T-014 착수 조건은 충족했다고 표시하지 않는다.

**2026-10-12 실제 결과:** 사용자 읽기·쓰기·삭제 및 정책 실패 시 실행 차단·복구는 확인했다. 제한 프로세스는 초기화 오류 `0xC0000142`로 본문을 실행하지 못했고, 별도 desktop을 준비한 마지막 버전은 Windows 응용 프로그램 제어 정책이 controller 실행 자체를 차단했다. 이 PC에서 정상 행렬의 실행 가능성은 확인되지 않았다. 차단 뒤 다른 경로·이름·컴파일 옵션으로 재실행하거나 정책을 완화하지 않았다. 아래 명령은 재현 인터페이스이며 지금 전체 통과할 것이라는 안내가 아니다.

개발 담당은 별도 worktree의 Codex, 요청 모델은 `gpt-6-astra / max`다. 실제 원격 모델 신원은 독립 확인하지 못했다. 독립 Gemini 의견의 회수·타당성 대조, 공통 문서·Notion·push는 총괄이 맡는다.

실행 전에 알아둘 파일명은 **`FileAccessProbe.exe`**다. [FileAccessProbe.cs](FileAccessProbe.cs)를 이 PC에 이미 설치된 Microsoft C# 컴파일러로 직접 컴파일한 테스트 프로그램이며, 설치 프로그램이나 외부에서 받은 실행 파일이 아니다. 가짜 파일의 접근 결과만 측정하기 위해 만든 미서명 도구다. 마지막 파일을 읽기 전용 `Get-AuthenticodeSignature`로 확인한 결과 `NotSigned`, 서명 인증서 없음이었다. Windows가 이 파일을 차단하면 즉시 중단하며, 예외 추가·`Unblock-File`·보안 설정 변경·이름/위치 변경 재실행을 하지 않는다.

## 현재 실행 방법 · 2026-11-09

개발 사본의 루트에서 **로그인한 Windows 사용자의 비관리자 PowerShell**로 실행한다. 실행할 때마다 `%TEMP%\ORBIT-X002\run-시각-UUID`를 만들고, 보고서 경로를 터미널에 출력한다.

```powershell
powershell.exe -NoProfile -File experiments\x-002-file-access\run.ps1
node --test experiments/x-002-file-access/verify-report.test.mjs
```

현재 PC에서는 Smart App Control이 On이다. 서명본이 없는 기본 실행은 별도 사용자 대조군의 `allowed.txt`와 `protected.txt`를 읽고 지운다. `preflight.json`의 `allowedMatches`, `protectedMatches`, `distinct`, `cleaned`를 확인한다. 종료 코드 3은 컨트롤러를 시작하기 전에 보류했다는 뜻이다. 정책 상태를 조회할 수 없을 때에도 보류한다. 순수 Node 테스트는 합성 보고서 판정만 검사한다.

현재 소스로 만든, Windows가 신뢰하는 서명본과 그 **서명된 최종 산출물의 독립 검토 SHA-256**이 준비된 경우 다음 인터페이스를 쓴다. 이 PC에서는 서명본 실행까지 검증하지 못했다. 별도 Windows 게스트를 사용한다면 기존 보안 설정을 유지하고 해당 환경의 결과로 기록한다.

```powershell
powershell.exe -NoProfile -File experiments\x-002-file-access\run.ps1 -SignedControllerPath 'C:\검토한경로\FileAccessProbe.exe' -ReviewedControllerSha256 '<서명본 해시 64자리>'
node experiments/x-002-file-access/verify-report.mjs '<출력된 report.json 절대경로>'
powershell.exe -NoProfile -File experiments\x-002-file-access\test-preflight.ps1
```

실행 가능한 환경에서는 helper가 새 `fixtures`의 형제 파일 두 개에 서로 다른 256비트 난수의 64자리 텍스트를 넣는다. 정책 적용 뒤 사용자·제한 프로세스·그 자식이 모두 같은 경로와 같은 Win32 읽기 함수를 사용한다. 일반 사용자의 두 해시와 제한 주체들의 허용 해시·보호 오류 5를 확인한 뒤 수정·삭제 대조군으로 넘어간다. 검증기는 보호 파일 해시, 성공한 실제 쓰기 바이트·삭제 효과, PID·토큰, Job·desktop 정리와 ACL 복원을 대조한다. 식별값 원문은 프롬프트나 보고서에 싣지 않는다.

실행 가능한 같은 조건에서 `-InjectPolicyFailure`로 없는 가짜 파일의 정책 적용 실패를 시험하고, `verify-report.mjs --policy-failure <보고서>`로 자식 미시작·복원을 확인한다. `--initialization-failure`는 본문 실행 전 종료된 보고서를 검사하며 10월 12일의 v1 실패 기록도 읽는다. 전체 판정은 v2의 실제 측정값을 요구한다.

controller 자체 실행 실패는 `launcher-error.json`에 별도로 남기도록 마지막에 보완했다. 이 로깅 보완은 구문만 검사했고, 차단된 실행 파일을 다시 실행해 검증하지 않았다. 이미 관측한 차단은 `RESULTS.md`와 해당 run의 원본 CodeIntegrity 이벤트로 보존한다.

`-KeepFixtures`는 권한을 원본으로 복원한 가짜 파일만 남긴다. 중간 실패로 파일이 남으면 기존 보고서를 보존한 채 해당 실행 파일의 `recover` 모드로 복원·정리한다.

```powershell
$run = Join-Path $env:TEMP 'ORBIT-X002\run-실제이름'
& (Join-Path $run 'FileAccessProbe.exe') recover $run
```

복구 전에 해당 실행이 끝났고 그 Job의 프로세스가 정리됐는지 확인한다. 실행 중인 v2 컨트롤러는 같은 실행 폴더의 복구를 잠근다. 복구는 소유 표식·ACL 목록·대상 경계·재분석 지점을 검사한다. 부모부터 복원하고 다시 읽어 비교한 뒤 개별 파일과 빈 폴더를 제거한다. 증거 파일은 실행 폴더에 남는다. 서명 차단 사전 검사의 `preflight.json`에는 복구할 ACL이 없다.

## 시험 범위와 판정

| 항목 | 실제 동작 |
|---|---|
| 사용자 정상 | 보호 정책 적용 후 동일한 두 파일의 전체 식별값을 읽고, 제한 실행 후 다시 읽기·별도 파일 수정·삭제 확인 |
| 제한 직접·자식 | 실제 `CreateFileW`/`ReadFile`/`WriteFile`/`DeleteFileW` 결과, 실제 토큰 제한 SID와 PID |
| 정상 작업 | 허용 파일 읽기·쓰기·삭제와 자식 결과 파일 생성 |
| 소유자 권한 | `OWNER RIGHTS` 설정 유무를 별도 파일로 비교하고 `WRITE_DAC` 획득·실제 DACL 변경·재읽기 관측 |
| 상위 폴더 | `FILE_DELETE_CHILD` 요청, 빈 보호 폴더 삭제, 보호 파일 이름 변경 |
| 다른 이름 | 가짜 원본의 하드링크, `\\?\` 경로, `..` 경로 읽기 |
| 미리 열린 핸들 | 가짜 보호 파일을 일반 사용자가 미리 열고 그 핸들 1개만 제한 자식에 전달하여 읽기 관측. 새 열기와 분리 |
| 실패·복구 | 정책 적용 실패 시 실행 차단, 보존한 ACL 복원 재대조, fixture 개별 정리 |
| 다른 앱 | Explorer/Edge/Blender/Electron의 PID·시작 시각·응답·CPU·메모리 전후 관측. 실제 조작/통신 검사는 아님 |

제한 토큰의 두 번째 권한 검사에는 Everyone·Authenticated Users·Users와 현재 로그온 SID를 사용한다. 시스템 실행 자원에 접근하면서, 그 SID가 없는 시험 보호 ACL에는 접근이 거부되는지 보는 후보 방식이다. 이 공통 SID에 허용된 **다른 시스템 파일이나 세션 자원까지 격리하지 않는다**. 기존 사용자 파일, 설치 경로, 데스크톱의 ACL은 변경하지 않는다. `WRITE_RESTRICTED`와 `SANDBOX_INERT` 플래그는 사용하지 않는다.

일반 사용자는 명시적 FullControl을 유지한다. 보호 파일은 상속을 끊고 사용자·SYSTEM만 허용하며, `OWNER RIGHTS`에는 ReadControl만 준다. 별도 취약 대조 파일은 소유자의 묵시적 DACL 변경 권한을 그대로 둔다. 제한 프로세스의 자식은 `CreateProcessW`로 만들어 실제 토큰 상속을 측정하도록 구현했다(이번 본문 미실행). 모든 직접 실행은 일시 정지 상태에서 자체 Job에 먼저 넣고 최대 20초만 기다리며, 일반 권한 재실행으로 우회하지 않는다.

최종 C# 버전에는 GUID 이름의 새 비표시 desktop 1개를 만드는 비교 코드가 있다. 이름 부재를 먼저 확인하고 새 객체에만 사용자 및 로그온 SID의 제한 권한 `0x00020083`을 부여한다. 화면 전환·기존 desktop/window-station ACL 변경은 하지 않으며, Job 종료 후 desktop 핸들 종료와 이름 재열기 실패를 확인하도록 구현했다. **이 버전은 controller 시작 전 정책 차단되어 desktop 생성·정리 코드 모두 실행 미검증이다.** 이름 사전 확인을 적대적 경쟁 상황에서도 원자적인 생성 보장으로 주장하지 않는다.

하드링크의 원본·다른 이름 모두 새 fixture 내부다. 같은 파일의 ACL이 공유되므로 허용 경로에 있다는 이유로 별도 허용 ACL을 쓰지 않는다. 링크·경로 교체 공격의 전체 방어는 미검증이다. 정리 코드는 재귀 삭제를 사용하지 않지만 검사와 사용 사이의 악성 교체를 원천 봉쇄한 일반 목적 삭제기로도 보지 않는다. 이 실험에서는 신뢰한 고정 helper만 실행한다.

사전 열린 핸들 전달과 소유자 권한 변경은 의도적인 취약 대조다. 해당 읽기가 성공하면 위험을 실제 관측한 것이며 보호 성공에 합산하지 않는다. 기본 실행은 핸들 상속을 끄고, 핸들 실험에만 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`로 가짜 파일 핸들 1개를 지정한다.

미검증: 제한 프로세스 직접·자식의 파일 거부 전체 행렬, 실제 Codex/PTY·로그인/개발 명령, 서비스·프록시를 통한 대리 읽기, 별도 데스크톱 격리, 심볼릭 링크·junction·짧은 이름·경로 교체 경쟁, 파일 접근 OS 감사 수집, 앱 재시작/통합, 다른 앱 실제 조작과 장시간 안정성. helper가 기록한 오류나 실행 차단 CodeIntegrity 이벤트는 파일 접근 감사 수집 증거가 아니다. 계정·드라이버·방화벽·전역 보안 정책은 변경하지 않는다.

## 공식 근거

- [CreateRestrictedToken](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken): 제한 SID의 이중 접근 검사, 특권 제한, 별도 데스크톱 주의 사항.
- [Restricted Tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)와 [CreateProcessAsUserW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw): 자기 토큰의 제한 사본 실행과 특권 예외. API 성공과 새 프로세스 초기화 성공은 별도다.
- [TOKEN_INFORMATION_CLASS](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class): `TokenRestrictedSids`, `TokenElevation`, `TokenLogonSid` 관측.
- [OWNER RIGHTS SID](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-security-identifiers)와 [새 객체 소유자](https://learn.microsoft.com/en-us/windows/win32/secauthz/owner-of-a-new-object): 묵시적 `WRITE_DAC`와 소유자 권한 ACE.
- [파일 접근 권한](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights)과 [파일 권한 상수](https://learn.microsoft.com/en-us/windows/win32/fileio/file-access-rights-constants): 읽기/쓰기/삭제·부모 삭제 권한.
- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects): 자체 프로세스 묶음의 자식 포함과 핸들 종료 정리.
- [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute): 명시한 핸들만 상속하는 목록.
- [CreateDesktopW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createdesktopw): 새 객체의 권한·핸들 수명. 기존 데스크톱이나 레지스트리 값을 변경하는 문서 절차는 사용하지 않는다.

## 2026-10-12 추가 조사와 재실행 조건

추가 조사는 기존 보고서와 Windows 이벤트를 읽는 방식으로만 수행했다. 최초 세 번의 제한 자식은 `CreateProcessAsUser` 생성 성공 후 `0xC0000142`로 종료됐고, 마지막 실행은 controller가 시작되기 전에 Smart App Control에 차단됐다. 최초 세 번의 정확한 실행 경로와 PID에 일치하는 차단 이벤트는 발견하지 못했다. 따라서 두 실패를 같은 원인으로 확정하지 않는다. 이벤트 부재만으로 정책 개입이 없었다고 증명할 수도 없다. 상세 시각, 조회 범위와 증거는 [RESULTS.md](RESULTS.md)의 추가 조사에 있다.

현재 helper 실행 차단은 유지한다. 실패 원인을 해결해 달라는 요청을 보안 기능 해제, 신뢰 인증서 추가, 예외 등록, 설치 또는 계정 변경의 허가로 해석하지 않는다. 파일명·경로·컴파일 옵션을 바꾼 재시도나 같은 코드를 Script/Add-Type 등으로 메모리에서 실행하는 방식도 사용하지 않는다.

다음 경로는 아직 실행하거나 성공을 확인한 해결책이 아니라 선택 가능한 조사·해결 계획이다.

| 경로 | 필요한 조건과 범위 | 판정 한계 |
| --- | --- | --- |
| 현재 PC에서 읽기 전용 사전 확인 | 기존 코드 서명 인증서의 메타데이터, 서명 도구, 기존 Windows VM 실행기와 시험 환경의 유무를 확인한다. 개인키 내용을 읽거나 내보내지 않는다. 총괄의 다른 CLI 검증과 순서를 나눈다. | 실행 가능성을 확인하는 단계이며 제한된 프로세스의 파일 보호 성공을 뜻하지 않는다. |
| 공개적으로 신뢰받는 인증서로 helper 서명 | 검토한 코드에 대해 신뢰받는 CA 또는 Artifact Signing의 공개 신뢰 서명을 사용하고 현재 Smart App Control 정책을 유지한다. 기존 서명 수단의 이용 권한과 비용·외부 서비스·도구 설치 필요성을 먼저 확인한다. 기존 실패 산출물은 보존한다. | Microsoft가 안내하는 정책 호환 경로지만 실제 서명·실행은 미검증이다. 서명이 최초 세 번의 DLL 초기화 실패까지 해결한다는 보장은 없다. |
| 별도 Windows 시험 환경에서 원인 분리 | 이미 사용 가능한 VM 또는 시험 PC가 있는지 먼저 확인한다. 새 설치·기능 활성화·재부팅 등이 필요하면 구체 범위를 정한 뒤 사용자 결정으로 진행한다. 시험 환경에도 가짜 자료만 사용한다. | 현재 PC에서 확인된 Windows 11 Home은 Windows Sandbox 공식 지원 대상이 아니다. 다른 환경의 성공은 현재 PC 보호 성공을 대체하지 못한다. |

공식 문서는 [Smart App Control 서명 안내](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control), [Artifact Signing 가입 조건](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart), [Windows Sandbox 지원 환경](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/)을 참고한다. 서비스 자격은 사용자에게 해당하는지 별도로 확인해야 한다. 예를 들어 2026-10-12 확인한 Artifact Signing 문서는 공개 신뢰 서명에서 한국의 조직을 지원하지만 개인 개발자는 미국·캐나다로 제한한다. 사용자의 거주지·국적·계정의 조직 형태는 확인하거나 추정하지 않았다.

정책에 맞는 실행 경로가 확보된 뒤에도 일반 사용자 작업 성공, 제한된 부모·자식의 보호 파일 read/write/delete에 대한 실제 OS 거부, 허용 파일 정상 작업, 보호 파일 해시 보존과 ACL·자체 프로세스·desktop 정리를 다시 관측해야 한다. owner 권한, 부모의 자식 삭제 권한, 링크, 미리 열린 핸들 등의 결과를 각각 남기며 실제 Codex/PTY와 서비스·프록시 경유는 별도 검증 대상이다. **X-002는 해결 완료가 아니며 T-014 착수 차단을 유지한다. 별도 시험 환경 후보 조사는 X-003 두 기기 파일 전송의 재개를 뜻하지 않는다.**

후속 환경 확인에서 사용자는 별도 VM·코드 서명 수단을 마련한 기억이 없다고 답했다. 총괄의 제한된 읽기 전용 조회에서도 PATH·일반 설치 경로, Windows Kits의 x64 `signtool`, 현재 사용자 개인 인증서 저장소의 코드 서명 EKU 메타데이터, 실행 중 VM 제품 프로세스에서 해당 항목이 발견되지 않았다. 이는 PC 전체·다른 인증서 저장소·꺼진 VM까지 존재하지 않는다는 증명이 아니다. 따라서 즉시 이용 가능한 서명·시험 환경은 아직 확인되지 않았으며 설치·가입·결제·실험 재실행은 진행하지 않았다. 조회 증거는 총괄 작업 폴더의 `.runtime/x002-environment-inventory.json`에 있다.
