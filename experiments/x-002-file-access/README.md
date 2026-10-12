# X-002 파일 접근 보호 실험

이 도구는 현재 Windows의 **일반 사용자 토큰과 그 제한 사본**으로 새 가짜 파일에 접근하여 Win32 결과를 수집한다. 앱 보호 기능·실제 Codex 실행기·완성된 보안 격리가 아니다. 조사 결과는 [RESULTS.md](RESULTS.md)에 기록한다. X-002 전체 성공 및 T-014 착수 조건은 충족했다고 표시하지 않는다.

**2026-10-12 실제 결과:** 사용자 읽기·쓰기·삭제 및 정책 실패 시 실행 차단·복구는 확인했다. 제한 프로세스는 초기화 오류 `0xC0000142`로 본문을 실행하지 못했고, 별도 desktop을 준비한 마지막 버전은 Windows 응용 프로그램 제어 정책이 controller 실행 자체를 차단했다. 이 PC에서 정상 행렬의 실행 가능성은 확인되지 않았다. 차단 뒤 다른 경로·이름·컴파일 옵션으로 재실행하거나 정책을 완화하지 않았다. 아래 명령은 재현 인터페이스이며 지금 전체 통과할 것이라는 안내가 아니다.

개발 담당은 별도 worktree의 Codex, 요청 모델은 `gpt-6-astra / max`다. 실제 원격 모델 신원은 독립 확인하지 못했다. 독립 Gemini 의견의 회수·타당성 대조, 공통 문서·Notion·push는 총괄이 맡는다.

실행 전에 알아둘 파일명은 **`FileAccessProbe.exe`**다. [FileAccessProbe.cs](FileAccessProbe.cs)를 이 PC에 이미 설치된 Microsoft C# 컴파일러로 직접 컴파일한 테스트 프로그램이며, 설치 프로그램이나 외부에서 받은 실행 파일이 아니다. 가짜 파일의 접근 결과만 측정하기 위해 만든 미서명 도구다. 마지막 파일을 읽기 전용 `Get-AuthenticodeSignature`로 확인한 결과 `NotSigned`, 서명 인증서 없음이었다. Windows가 이 파일을 차단하면 즉시 중단하며, 예외 추가·`Unblock-File`·보안 설정 변경·이름/위치 변경 재실행을 하지 않는다.

## 실행

일반 사용자 PowerShell에서 저장소 루트를 작업 경로로 사용한다. 관리자 실행·전역 권한 변경·추가 설치는 필요하지 않으며, 관리자 또는 이미 제한된 토큰에서는 본 실험을 거절한다. 설치된 .NET Framework C# 컴파일러가 없으면 중단한다.

```powershell
powershell.exe -NoProfile -File experiments\x-002-file-access\run.ps1
```

실행마다 `.runtime/x-002-file-access/run-시각-UUID/`를 새로 만든다. 하위 `fixtures`만 권한을 바꾸고 정리한다. 출력한 경로의 `report.json`에는 실제 API 결과·오류 번호, 토큰 SID·PID·시작 시각, 보호 파일 해시, Job 종료와 복원·정리 결과가 남는다. `environment.json`은 실제 Windows 버전을 저장한다. .NET의 `Environment.OSVersion` 값은 호환성 표시일 수 있어 별도 필드로 구분한다.

```powershell
node experiments/x-002-file-access/verify-report.mjs '.runtime/x-002-file-access/run-실제이름/report.json'
powershell.exe -NoProfile -File experiments\x-002-file-access\run.ps1 -InjectPolicyFailure
node experiments/x-002-file-access/verify-report.mjs --policy-failure '.runtime/x-002-file-access/run-실제이름/report.json'
node experiments/x-002-file-access/verify-report.mjs --initialization-failure '.runtime/x-002-file-access/run-실제이름/report.json'
```

정책 실패 주입은 새 시험 폴더의 **없는 가짜 파일**에 DACL 설정을 시도한다. 실제 파일 없음 오류 뒤 제한 토큰·프로세스를 만들지 않는지 검사한다. 실패 실험의 helper 종료 코드는 2이고, 관측 결과 검증기의 정상 종료 코드는 0이다. 정상 행렬의 helper 종료 코드 0도 제품 보호 승인을 뜻하지 않는다. 전체 행렬 검증기는 앞으로 본문 실행이 가능해졌을 때의 기대 결과를 검사하는 코드이며 이번에는 전체 통과하지 않았다.

controller 자체 실행 실패는 `launcher-error.json`에 별도로 남기도록 마지막에 보완했다. 이 로깅 보완은 구문만 검사했고, 차단된 실행 파일을 다시 실행해 검증하지 않았다. 이미 관측한 차단은 `RESULTS.md`와 해당 run의 원본 CodeIntegrity 이벤트로 보존한다.

`-KeepFixtures`는 권한을 원본으로 복원한 가짜 파일만 남긴다. 중간 실패로 파일이 남으면 기존 보고서를 보존한 채 해당 실행 파일의 `recover` 모드로 복원·정리한다.

```powershell
& '.runtime\x-002-file-access\run-실제이름\FileAccessProbe.exe' recover 'C:\정확한\저장소\.runtime\x-002-file-access\run-실제이름'
```

복구는 소유 표식과 저장된 ACL 목록, 모든 대상이 정확한 fixture 경계 내부이고 재분석 지점이 아닌지 확인한다. 부모부터 ACL을 복원한 뒤 전체를 다시 비교하고, 개별 파일·빈 폴더만 삭제한다. 새 실험을 시작하기 전 이전 실행의 복구를 확인해야 한다. 원시 결과·실행 파일은 Git 제외 `.runtime`에 보존한다.

## 시험 범위와 판정

| 항목 | 실제 동작 |
|---|---|
| 사용자 정상 | 보호/허용 파일의 읽기·쓰기·삭제를 제한 실행 전후 확인 |
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
