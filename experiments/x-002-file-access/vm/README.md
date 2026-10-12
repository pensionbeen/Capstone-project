# X-002 별도 Windows VM 호스트 준비

이 도구는 Oracle VirtualBox 기본판과 Windows Hypervisor Platform(WHP)을 준비한다. 기존 `FileAccessProbe.exe`를 호스트에서 다시 실행하지 않는다. 사용자 등록·계정 생성·Microsoft 양식 제출·Windows ISO 다운로드·VM 생성·VM 부팅·재부팅은 자동화하지 않는다. **사전 조회·공식 설치 파일 검증·압축 해제·읽기 전용 MSI 조사까지 완료했다. 설치·WHP 활성화·VM 실행은 미완료이며, 재부팅 외에도 아래 MSI 설치 동작 검토가 남았다.**

담당은 Codex 파일 접근 보호 담당, 요청 모델은 `gpt-6-astra / max`다. 실제 원격 모델 신원은 독립 미확인이다. 기존 X-002 실패 기록은 보존하고 T-014 착수 차단과 X-003 전송 보류를 유지한다. VM에서의 결과도 현재 호스트 보호 성공을 대신하지 않는다.

2026-10-12 19:44 KST 실제 확인: PowerShell 구문과 경로·디스크 하한·보안 상태 비교 등 순수 검사 19개 통과. `Inspect`에서 WHP 비활성, 기존 `PendingFileRenameOperations` 재부팅 대기 표식, 일반 사용자 권한에서 Secure Boot 조회 미확인 1건을 관측했다. 보안 상태를 변경하지 않았다. 공식 설치 파일 178,192,488바이트의 SHA256 일치와 `Oracle America, Inc.`의 유효한 서명을 확인했다. 설치기 도움말/압축 해제·MSI 조사·관리자 설치·WHP 활성화는 아직 미실행이다. 원시 조회/검사/다운로드 보고서는 이 worktree의 `.runtime/vm/`에 보존한다. 보안 조회의 미확인과 기존 재부팅 대기를 먼저 검토하며, 이를 해소하려고 표식을 삭제하거나 보안 설정을 바꾸지 않는다.

19:53 KST 총괄의 관리자 `Inspect`에서는 보안 조회 오류 0건, Secure Boot 활성, VBS·메모리 무결성·Defender·Smart App Control 활성, 기계 신뢰 저장소 Root 48개·TrustedPublisher 0개를 확인했다. 일반 사용자 조회의 권한 미확인은 이 관리자 관측으로 보완했다. 기존 재부팅 대기 표식의 Windows 대상 2개는 실제 존재하며 원문 경로는 ignored 보고서에만 보존한다. 표식이나 보안 설정은 변경하지 않았다. 관리자 설치와 WHP 활성화는 기존 재부팅 대기를 해결할 사용자 결정 전까지 대기한다. 설치기 압축 해제와 읽기 전용 MSI 조사는 코드 검토 종료 후 별도 순서로 진행할 준비 상태이며, 아직 수행 결과가 아니다.

20:25 KST 첫 관리자 `ExtractInstaller`는 실제 도움말에 timestamp CA 옵션이 표시되지 않아 **압축 해제 전에 실패**했다. 당시 수집기의 `ExitCode=null`도 발견했으며 0으로 판정하면 안 된다. 원본 실패 보고서는 보존했다. 그 실행의 보안 `after`가 빠진 부분은 20:30 관리자 읽기 조회로 보완했고 전후 보안 지문이 일치했다. 이후 종료 코드 누락을 거부하고 실패 경로에서도 보안 상태를 수집하도록 수정했다. 실제 자식 종료 0·7과 누락 거부 검사 3개, 기존 순수 검사 19개가 통과했다.

20:35~20:36 KST 수정본에서 도움말과 압축 해제 모두 실제 종료 0, 보안 조회 오류 0건·전후 지문 동일, 자체 프로세스 종료를 확인했다. 이후 일반 사용자 MSI 읽기 조사도 성공했다. 추출물은 `common.cab`과 amd64/arm64 MSI이며 amd64만 설치 후보로 선택했다. 후보는 Oracle의 유효한 서명을 가진 x64 `7.2.20`, SHA256 `ae40bb2b2770fcd264cb9d03de2d278a621997b33956e88a2de5edc900873d2a`다. 실제 표 12개의 행 배열 폭을 확인했으며 Feature 6개·CustomAction 55개·File 185개를 회수했다. 이 결과는 설치 성공이나 모든 설치 작업의 안전성 승인이 아니다.

최종 자동 설치 차단을 추가한 뒤 실제 진입점 거부를 포함한 회귀 검사 4개와 순수 검사 19개를 통과했다. 차단된 자식은 종료 1과 `AUTO_INSTALL_BLOCKED`를 남겼으며 준비 실행 폴더나 호스트 작업 표식은 생성하지 않았다. 이번에 설치·WHP 활성화·재부팅·기존 helper 호스트 재실행은 수행하지 않았다.

## 실행 범위

- 새 worktree의 `experiments/x-002-file-access/vm/`만 준비 코드이며, 다운로드·압축 해제·로그·보고서는 같은 worktree의 `.runtime/vm/`에 둔다. 경로의 재분석 지점(다른 위치로 연결되는 junction 등)을 거부하고 기존 산출물을 덮어쓰거나 재귀 삭제하지 않는다.
- VirtualBox 본체는 Windows의 기본 Program Files 위치에 설치한다. 관리자 설치는 본체·기본 드라이버·Windows Installer 기록/캐시 등을 변경한다. 모든 설치 파일이 `.runtime/vm/` 안에만 생기는 무설치 방식은 아니다. 기존 VirtualBox가 발견되면 자동 업그레이드·제거하지 않는다.
- 기존 VBS·메모리 무결성·Defender·Smart App Control·Secure Boot·인증서 신뢰를 변경하는 명령은 없다. 설치 전후 보안 상태와 기계 인증서 저장소의 목록 해시를 비교한다. 조회 실패·차이가 있으면 후속 변경을 중단한다. 이 비교는 모든 보안 설정의 완전한 감사를 뜻하지 않는다.
- 예정 설치 구성은 Extension Pack·USB·브리지/호스트 전용 네트워크·Python을 제외한 `VBoxApplication`이다. 실제 MSI상 기본 `VBoxSup` 드라이버와 `VBoxSDS` 서비스(LocalSystem, 수동 시작)가 포함된다. 선택 기능을 제외해도 조건 없는 기존 장치 정리 작업이 남으므로 기능 목록만으로 설치를 승인하지 않는다.
- 동작마다 C: 여유 25GiB를 유지하도록 사전 검사한다. 다운로드는 Content-Length와 각 쓰기 전 여유를 검사한다. 설치·WHP에는 추가 2GiB 여유를 요구한다. 다른 앱의 동시 디스크 사용이나 외부 설치 프로그램의 전체 쓰기를 이 도구가 강제로 제한하는 것은 아니다.
- 실패·정책 차단·신뢰 추가 요구를 다른 실행 방식, 재명명, 예외 추가로 해결하지 않는다. 미확인 MSI 기능·추가 의존성 필요 시 먼저 보고한다. 자동 재부팅·서비스 강제 종료·자동 복구/제거·보안 기능 해제는 없다.

## 순서별 독립 명령

모든 명령의 현재 폴더는 **배정된 `file-access-vm` worktree**다. 총괄은 다른 실제 AI/CLI 관측과 실행 순서를 배정한다. 각 명령은 그 단계만 수행한다. 일반 사용자 단계와 관리자 단계는 아래처럼 구분한다. PowerShell 실행 정책이 차단하면 우회 옵션을 추가하지 않고 보고한다.

일반 사용자 사전 확인·다운로드:

```powershell
powershell.exe -NoProfile -File experiments/x-002-file-access/vm/prepare-host.ps1 -Step Inspect
powershell.exe -NoProfile -File experiments/x-002-file-access/vm/prepare-host.ps1 -Step DownloadInstaller
```

`Inspect`는 읽기 권한이 없는 보안 항목을 미확인으로 기록할 수 있다. `DownloadInstaller`는 Oracle의 정확한 HTTPS 버전 경로만 사용하고, 공식 SHA256SUMS와 코드에 고정한 해시가 모두 일치해야 한다. `Get-AuthenticodeSignature`의 `Valid`와 정확한 Oracle 발행자 이름을 확인한다. 인증서를 추가하거나 개인키를 읽지 않는다. 파일 다운로드만으로 설치 성공을 표시하지 않는다.

압축 해제·배포 MSI 조사:

```powershell
powershell.exe -NoProfile -File experiments/x-002-file-access/vm/prepare-host.ps1 -Step ExtractInstaller
powershell.exe -NoProfile -File experiments/x-002-file-access/vm/prepare-host.ps1 -Step InspectMsi -ExtractionReport '.runtime/vm/runs/<실제 ExtractInstaller 실행 폴더>/report.json'
```

압축 해제는 먼저 서명·해시를 다시 검사하고 실제 배포 EXE의 도움말에서 필수 옵션과 버전을 확인한다. `--extract --path ... --no-silent-cert --no-install-timestamp-ca` 경로만 사용한다. 기본 silent 설치의 인증서 자동 등록 경로를 사용하지 않는다. 보안 비교에 필요한 읽기 권한이 부족하면 이 단계도 실행 전에 중단한다. 총괄은 필요 시 관리자 **읽기/압축 해제만** 실행하도록 별도로 순서를 정한다.

정확한 `v7.2.20` 소스에서 `--no-install-timestamp-ca`의 인식 조건과 도움말 출력 조건이 다름을 확인했다. 따라서 도움말에 이 옵션이 보일 것을 강제하지 않되 **실행 인자에는 유지**하며, 옵션 파싱이 실패하면 실제 비정상 종료로 중단한다. 해당 버전의 `fExtractOnly` 분기는 인증서 추가 함수와 MSI 실행 분기를 건너뛴다. 소스 대조와 실제 서명/옵션/보안 전후 관측을 함께 사용하며 재현 빌드로 배포 바이너리 전체를 증명했다는 뜻은 아니다.

`InspectMsi`는 Windows Installer COM API로 MSI 데이터베이스를 **읽기 전용**으로 연다. 설치 작업을 실행하지 않는다. x64 패키지의 서명·제품/버전·Feature·CustomAction·실행 순서·Registry·ServiceInstall·Media·File 등을 보고서에 남긴다. 설치 작업의 숨은 부작용이 없다는 자동 증명은 아니다. 총괄이 실제 보고서와 관련 작업을 검토한 뒤 **MSI SHA256 및 완성된 조사 보고서 SHA256**을 설치 명령에 명시해야 한다. 공개 소스 `main`의 동작만으로 배포 7.2.20을 검증했다고 처리하지 않는다.

다음 설치 명령은 현재 **코드에서 실행 차단**한다. 고정 7.2.20의 확인된 MSI 해시를 차단 사유에 명시하고, `InstallVirtualBox` 진입 즉시 관리자 확인·보고서 생성·호스트 변경 전에 `AUTO_INSTALL_BLOCKED`로 거부한다. 보고서/해시 인자 변경이나 재부팅으로 이 차단을 건너뛸 수 없다. 실제 MSI의 조건 없는 기존 장치 정리 작업과 아래 재부팅/고정 임시 경로 문제를 총괄이 검토한 뒤 별도 실행 방법을 확정해야 한다.

실제 MSI에서 `ca_UninstallTAPInstances`·`ca_UninstallVBoxDrv`는 조건 `1`, 일부 네트워크/USB 제거 작업은 빈 조건이다. 정확한 [v7.2.20 설치 도우미 소스](https://github.com/VirtualBox/virtualbox/blob/v7.2.20/src/VBox/Installer/win/InstallHelper/VBoxInstallHelper.cpp)를 대조했다. TAP 제거는 `VirtualBox TAP Adapter` 제품명과 innotek/Sun/현재 공급자, `vboxtap` 하드웨어 식별자·동일 장치 인스턴스를 확인한다. 구형 드라이버 제거는 정확히 `VBoxDrv` 서비스, 호스트 전용 장치 중지/제거 호출은 `sun_VBoxNetAdp` 식별자를 사용한다. USB 제거는 실제 MSI가 지정한 `VBoxUSB.*`/`VBoxUSBMon*` 모델과 일부 PnP ID를 전달한다. NetLwf는 `VBoxNetCfgWinNetLwfUninstall`로 위임하며 하위 함수의 대상 전체는 이 조사에서 미확인이다. 현재 PC에서 이 설치 작업들은 실행하지 않았다.

같은 소스는 네트워크 처리의 `NETCFG_S_REBOOT` 때 `REBOOT=Force`를 다시 설정하며, 대상 경로 검사 중 고정 `c:\temp\targetdir.ctx`를 생성/삭제하는 코드도 포함한다. [Microsoft 설명](https://learn.microsoft.com/en-us/windows/win32/msi/reboot)에 따르면 UI 없는 단일 MSI의 `Force`는 자동 재부팅으로 이어질 수 있어 명령의 `ReallySuppress`만으로 재부팅 금지를 보장하지 않는다. 공개 소스와 실제 DLL 전체의 동일성, 이 PC에서 해당 분기가 실행될지는 미확인이다. 고정 경로의 기존 파일이나 보안 정책을 변경하여 회피하지 않는다. 다음은 검토를 위한 원래 명령 형태이며 자동 설치 경로는 사용하지 않는다.

```powershell
powershell.exe -NoProfile -File experiments/x-002-file-access/vm/prepare-host.ps1 -Step InstallVirtualBox -MsiReviewReport '.runtime/vm/runs/<실제 InspectMsi 실행 폴더>/report.json' -ReviewedMsiSha256 '<검토한 MSI의 64자리 해시>' -ReviewedInspectionSha256 '<검토한 보고서의 64자리 해시>'
```

설치 직전에 검토한 보고서·MSI·모든 압축 해제 파일의 해시와 파일 목록을 다시 대조하고, 설치 중 해당 파일의 변경/삭제를 막는 읽기 핸들을 유지한다. 공식 MSI에 `ADDLOCAL=VBoxApplication`, `REBOOT=ReallySuppress`, `/norestart`, `VBOX_START=0`을 전달한다. 바탕화면·빠른 실행 바로가기와 파일 연결은 끈다. 설치 후 `VBoxApplication`이 로컬 설치되고 선택 기능이 부재인지 Windows Installer 기능 상태로 확인한다.

관리자 WHP 활성화와 후속 상태 확인:

```powershell
powershell.exe -NoProfile -File experiments/x-002-file-access/vm/prepare-host.ps1 -Step EnableWhp
powershell.exe -NoProfile -File experiments/x-002-file-access/vm/prepare-host.ps1 -Step VerifyHost
```

WHP는 정확히 `HypervisorPlatform`만 `-NoRestart -LimitAccess`로 활성화한다. Windows Update에서 기능 파일을 자동으로 가져오거나 부모 기능을 일괄 활성화하지 않는다. 파일/의존성이 없으면 오류를 보존해 보고한다. MSI 종료 3010과 WHP의 `RestartNeeded`는 재부팅 필요 근거로 남긴다. **`--ignore-reboot`는 필요 신호를 숨기는 옵션이므로 사용하지 않는다. 재부팅 시점은 사용자가 별도로 결정한다.** 이미 재부팅 대기이면 새 관리자 변경을 시작하지 않는다.

`VerifyHost`의 단계 실행 성공과 `readyForVmConfiguration`은 다르다. 재부팅 대기·미완료 설치·WHP 비활성 상태이면 VM 준비 가능으로 표시하지 않는다. 조건이 맞는 경우에만 설치된 서명을 확인한 `VBoxManage --version`을 실행한다. 이 결과도 VM 부팅·게스트 호환성 성공은 아니다.

## 실패와 인계

각 단계는 고유 실행 폴더의 `report.json`에 성공/실패, 실행한 자체 프로세스, 오류와 실제 출력을 보존한다. 관리자 변경 시작 시 `host-operation.pending.json`을 만든다. 모든 관련 확인을 마치면 해당 실행 폴더로 옮긴다. 실패·시간 초과 시에는 원본을 남기며 다음 관리자 변경을 차단한다. 단순히 실패 잠금을 삭제해 재실행하지 않는다. 총괄이 관련 PID/시각·MSI 상태·보안 비교·실제 설치 상태를 먼저 대조한다.

종료 코드·설치 차단 회귀 검사는 일반 사용자 권한으로 다시 실행할 수 있다. 준비 스크립트의 실제 수집 함수로 PowerShell 자식 종료 0·7과 누락 거부를 확인한다. 실제 `InstallVirtualBox` 진입점도 별도 자식으로 호출하여 고정 MSI의 명시적 거부, 준비 실행 폴더 미생성, 호스트 작업 표식 불변을 확인한다. 설치기·관리자 작업·보안 설정 변경은 없다.

```powershell
powershell.exe -NoProfile -File experiments/x-002-file-access/vm/check-process-exit.ps1
```

실행 중 설치 프로그램의 시간이 초과되어도 이 도구는 전역 종료나 자동 강제 종료를 하지 않는다. 살아 있을 수 있는 자체 PID와 보고서를 반환하고 추가 실행을 중단한다. 설치 부분 성공·정리 미확인을 성공에 합치지 않는다. 원시 로그·서명 메타데이터는 `.runtime`에만 두고 인증 정보·계정 원문·인증서 파일·개인키를 공통 기록이나 Git에 넣지 않는다.

사용자에게 남는 단계는 [Microsoft 평가판 등록](https://info.microsoft.com/ww-landing-windows-11-enterprise.html), 사용조건 확인, 실제 ISO 선택/확보다. 개인/조직 정보나 계정 값을 대신 만들지 않는다. 90일 평가·계정 로그인·활성화 조건을 확인하고, 받은 ISO 버전·공식 해시를 기록한 뒤 별도 검토된 VM 생성 단계로 간다. 예정 VM은 2 vCPU·6GiB RAM·80GiB 가상 디스크·UEFI/Secure Boot/TPM 2.0이며 공유 폴더·클립보드·드래그앤드롭·USB·브리지 연결은 제외한다. 게스트 기본 보안 정책이 helper를 차단해도 해제하지 않는다.

## 공식 근거

- [Oracle 7.2.20 배포 파일과 SHA256SUMS](https://download.virtualbox.org/virtualbox/7.2.20/): Windows 설치본 `VirtualBox-7.2.20-175154-Win.exe`, 고정 SHA256 `a81777d2b36380ce042a29e9c554cf032eb46a793f62e3cc82e7411e535c2c26`.
- [Oracle Windows 설치·MSI 기능](https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/installation.html), [보안 안내](https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/Security.html).
- [정확한 v7.2.20 설치 EXE 소스](https://github.com/VirtualBox/virtualbox/blob/v7.2.20/src/VBox/Installer/win/Stub/VBoxStub.cpp): L1335~1340 옵션 인식, L1494~1502 조건부 도움말, L1702~1724 추출/인증서/설치 분기. [main의 기본 드라이버 설치 작업](https://github.com/VirtualBox/virtualbox/blob/main/src/VBox/Installer/win/VBoxMergeAppSeq.wxi)은 실제 MSI와 별도 대조할 설계 근거다.
- [MSI REBOOT=ReallySuppress](https://learn.microsoft.com/en-us/windows/win32/msi/reboot), [Enable-WindowsOptionalFeature](https://learn.microsoft.com/en-us/powershell/module/dism/enable-windowsoptionalfeature).
- [Microsoft Windows 11 Enterprise 평가 안내](https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise), [Windows 11 VM 요건](https://learn.microsoft.com/en-us/windows/whats-new/windows-11-requirements).
