# Windows PowerShell 5.1. This file intentionally uses ASCII source text.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Inspect', 'DownloadInstaller', 'ExtractInstaller', 'InspectMsi', 'InstallVirtualBox', 'EnableWhp', 'VerifyHost')]
    [string]$Step,
    [string]$ExtractionReport,
    [string]$MsiReviewReport,
    [string]$ReviewedMsiSha256,
    [string]$ReviewedInspectionSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Version = '7.2.20'
$script:Revision = '175154'
$script:InstallerName = 'VirtualBox-7.2.20-175154-Win.exe'
$script:ExpectedInstallerHash = 'a81777d2b36380ce042a29e9c554cf032eb46a793f62e3cc82e7411e535c2c26'
$script:BlockedMsiHash = 'ae40bb2b2770fcd264cb9d03de2d278a621997b33956e88a2de5edc900873d2a'
$script:DownloadBase = 'https://download.virtualbox.org/virtualbox/7.2.20/'
$script:DiskFloor = 25GB
$script:RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$script:Area = [IO.Path]::GetFullPath((Join-Path $script:RepoRoot '.runtime\vm'))
$script:Downloads = Join-Path $script:Area 'downloads'
$script:Installer = Join-Path $script:Downloads $script:InstallerName
$script:InstallDirectory = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Oracle\VirtualBox'
$script:PendingPath = Join-Path $script:Area 'host-operation.pending.json'
$script:Utf8 = New-Object Text.UTF8Encoding($false, $true)
$script:Report = $null
$script:RunDirectory = $null
$script:ReportPath = $null
$script:PendingOwned = $false

function Assert-NoReparsePoint([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Reparse point is not allowed: $cursor"
            }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}

function Assert-AreaPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'An explicit artifact path is required.' }
    if (-not [IO.Path]::IsPathRooted($Path)) { $Path = Join-Path $script:RepoRoot $Path }
    $Path = $Path.Replace('/', '\')
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Path.Substring(2).Contains(':')) {
        throw 'Only a local drive path without an alternate data stream is allowed.'
    }
    $full = [IO.Path]::GetFullPath($Path)
    $prefix = $script:Area.TrimEnd('\') + '\'
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Artifact path must be below this worktree .runtime/vm directory.'
    }
    Assert-NoReparsePoint $full
    return $full
}

function New-AreaDirectory([string]$Path) {
    $full = Assert-AreaPath $Path
    [void][IO.Directory]::CreateDirectory($full)
    Assert-NoReparsePoint $full
    return $full
}

function Get-FreeBytes {
    $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($script:Area))
    return [long]$drive.AvailableFreeSpace
}

function Assert-DiskSpace([long]$AdditionalBytes = 0) {
    $free = Get-FreeBytes
    if ($free -lt ($script:DiskFloor + $AdditionalBytes)) {
        throw "Disk reserve check failed: free=$free, floor=$($script:DiskFloor), additional=$AdditionalBytes."
    }
    return $free
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TextHash([string]$Value) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($script:Utf8.GetBytes($Value)))).Replace('-', '').ToLowerInvariant()
    } finally { $algorithm.Dispose() }
}

function Save-Report {
    $script:Report.updatedUtc = [DateTime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText($script:ReportPath, ($script:Report | ConvertTo-Json -Depth 24), $script:Utf8)
}

function Read-Report([string]$Path, [string]$RequiredStep) {
    $full = Assert-AreaPath $Path
    if ((Get-Item -LiteralPath $full).Length -gt 16MB) { throw 'Report is too large.' }
    $value = [IO.File]::ReadAllText($full, $script:Utf8) | ConvertFrom-Json
    if ($value.schemaVersion -ne 1 -or $value.step -ne $RequiredStep -or $value.status -ne 'succeeded') {
        throw 'Required successful preparation report is missing or has the wrong schema/step.'
    }
    if ($value.workspaceRoot -ne $script:RepoRoot) { throw 'Report belongs to a different worktree.' }
    return $value
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } finally { $identity.Dispose() }
}

function Assert-Administrator {
    if (-not (Test-IsAdministrator)) {
        throw 'This step requires an administrator PowerShell. The script does not elevate itself.'
    }
}

function Get-RebootMarkers {
    $markers = @()
    foreach ($entry in @(
        @{ Name = 'ComponentBasedServicing'; Path = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending' },
        @{ Name = 'WindowsUpdate'; Path = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired' }
    )) {
        if (Test-Path -LiteralPath $entry.Path) { $markers += $entry.Name }
    }
    $sessionManager = Get-ItemProperty -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager'
    if ($sessionManager.PSObject.Properties.Name -contains 'PendingFileRenameOperations') {
        if (@($sessionManager.PendingFileRenameOperations).Count -gt 0) { $markers += 'PendingFileRenameOperations' }
    }
    return $markers
}

function Get-SecuritySnapshot {
    $values = [ordered]@{}
    $errors = @()
    try {
        $guard = Get-CimInstance -Namespace 'root\Microsoft\Windows\DeviceGuard' -ClassName Win32_DeviceGuard
        if ($null -eq $guard) { throw 'No DeviceGuard instance.' }
        $values.deviceGuard = [ordered]@{
            configured = @($guard.SecurityServicesConfigured | Sort-Object)
            running = @($guard.SecurityServicesRunning | Sort-Object)
            vbsStatus = $guard.VirtualizationBasedSecurityStatus
            codeIntegrity = $guard.CodeIntegrityPolicyEnforcementStatus
            userCodeIntegrity = $guard.UsermodeCodeIntegrityPolicyEnforcementStatus
        }
    } catch { $errors += 'DeviceGuard state unavailable.' }
    try {
        $preference = Get-MpPreference
        $status = Get-MpComputerStatus
        $values.defender = [ordered]@{
            disableRealtime = $preference.DisableRealtimeMonitoring
            disableBehavior = $preference.DisableBehaviorMonitoring
            disableIoav = $preference.DisableIOAVProtection
            disableScript = $preference.DisableScriptScanning
            disableBlockAtFirstSeen = $preference.DisableBlockAtFirstSeen
            antivirusEnabled = $status.AntivirusEnabled
            realtimeEnabled = $status.RealTimeProtectionEnabled
            tamperProtected = $status.IsTamperProtected
        }
    } catch { $errors += 'Defender state unavailable.' }
    try {
        $policy = Get-ItemProperty -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\CI\Policy'
        $values.smartAppControl = $policy.VerifiedAndReputablePolicyState
    } catch { $errors += 'Smart App Control state unavailable.' }
    try { $values.secureBoot = Confirm-SecureBootUEFI } catch { $errors += 'Secure Boot state unavailable; administrator read may be required.' }
    try {
        $stores = [ordered]@{}
        foreach ($name in @('Root', 'TrustedPublisher')) {
            $thumbprints = @(Get-ChildItem -LiteralPath "Cert:\LocalMachine\$name" | ForEach-Object { $_.Thumbprint } | Sort-Object)
            $stores[$name] = [ordered]@{ count = $thumbprints.Count; setHash = Get-TextHash ($thumbprints -join "`n") }
        }
        $values.machineTrustStores = $stores
    } catch { $errors += 'Machine trust store metadata unavailable.' }
    $json = $values | ConvertTo-Json -Depth 12 -Compress
    return [pscustomobject]@{ values = $values; fingerprint = Get-TextHash $json; errors = $errors }
}

function Assert-SecurityUnchanged($Before, $After) {
    if (@($Before.errors).Count -ne 0 -or @($After.errors).Count -ne 0) {
        throw 'Security comparison is incomplete. No further host action is allowed.'
    }
    if ($Before.fingerprint -ne $After.fingerprint) {
        throw 'Observed security/trust-store state changed. Preserve reports; do not undo security changes automatically.'
    }
}

function Get-HostState {
    $system = Get-CimInstance -ClassName Win32_ComputerSystem
    $cpu = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1
    $os = Get-CimInstance -ClassName Win32_OperatingSystem
    $feature = Get-CimInstance -ClassName Win32_OptionalFeature -Filter "Name='HypervisorPlatform'"
    return [pscustomobject]@{
        osCaption = $os.Caption; osVersion = $os.Version; build = $os.BuildNumber
        lastBootUtc = $os.LastBootUpTime.ToUniversalTime().ToString('o')
        cpu = $cpu.Name; firmwareVirtualization = $cpu.VirtualizationFirmwareEnabled
        vmMonitorMode = $cpu.VMMonitorModeExtensions; slatReported = $cpu.SecondLevelAddressTranslationExtensions
        hypervisorPresent = $system.HypervisorPresent; ramBytes = [long]$system.TotalPhysicalMemory
        freeRamKiB = [long]$os.FreePhysicalMemory; diskFreeBytes = Get-FreeBytes
        hypervisorPlatformState = if ($null -eq $feature) { $null } else { $feature.InstallState }
        rebootMarkers = @(Get-RebootMarkers); administrator = Test-IsAdministrator
        security = Get-SecuritySnapshot
    }
}

function Assert-NoExistingVirtualBox {
    if (Test-Path -LiteralPath $script:InstallDirectory) { throw 'An existing VirtualBox installation directory must be reviewed; automatic upgrade is not allowed.' }
    $processes = @(Get-Process -Name VirtualBox, VirtualBoxVM, VBoxSVC, VBoxHeadless, VBoxManage -ErrorAction SilentlyContinue)
    $services = @(Get-CimInstance -ClassName Win32_Service -Filter "Name LIKE 'VBox%' OR Name LIKE 'VirtualBox%'")
    $drivers = @(Get-CimInstance -ClassName Win32_SystemDriver -Filter "Name LIKE 'VBox%'")
    $adapters = @(Get-CimInstance -ClassName Win32_NetworkAdapter -Filter "ServiceName LIKE 'VBox%' OR Name LIKE '%VirtualBox%'")
    if ($processes.Count + $services.Count + $drivers.Count + $adapters.Count -ne 0) {
        throw 'Existing VirtualBox processes/services/drivers/adapters require review; no automatic removal or upgrade.'
    }
    foreach ($key in @(
        'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
        'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )) {
        if (Test-Path -LiteralPath $key) {
            foreach ($child in @(Get-ChildItem -LiteralPath $key)) {
                $product = Get-ItemProperty -LiteralPath $child.PSPath
                if ($product.PSObject.Properties.Name -contains 'DisplayName' -and $product.DisplayName -match 'VirtualBox') {
                    throw 'A registered VirtualBox product exists. No automatic upgrade is allowed.'
                }
            }
        }
    }
}

function Assert-OracleSignature([string]$Path) {
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
        throw "Authenticode is not Valid: $Path ($($signature.Status))."
    }
    $publisher = $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($publisher -notin @('Oracle Corporation', 'Oracle America, Inc.')) {
        throw "Unexpected installer publisher: $publisher. No automatic trust addition is allowed."
    }
    return [pscustomobject]@{
        status = [string]$signature.Status; publisher = $publisher
        subject = $signature.SignerCertificate.Subject; issuer = $signature.SignerCertificate.Issuer
        thumbprint = $signature.SignerCertificate.Thumbprint
    }
}

function Get-VerifiedInstaller {
    $path = Assert-AreaPath $script:Installer
    if ((Get-Sha256 $path) -ne $script:ExpectedInstallerHash) { throw 'Installer does not match the pinned official SHA256.' }
    return [pscustomobject]@{ path = $path; sha256 = $script:ExpectedInstallerHash; signature = Assert-OracleSignature $path }
}

function Receive-OfficialFile([string]$Url, [string]$Destination, [long]$MaximumBytes) {
    $uri = [Uri]$Url
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'download.virtualbox.org' -or -not $Url.StartsWith($script:DownloadBase, [StringComparison]::Ordinal)) {
        throw 'Download URL is outside the pinned Oracle HTTPS directory.'
    }
    $target = Assert-AreaPath $Destination
    if (Test-Path -LiteralPath $target) { throw 'Download destination already exists; it will not be overwritten.' }
    $request = [Net.HttpWebRequest]::Create($uri)
    $request.AllowAutoRedirect = $false
    $request.Timeout = 30000
    $request.ReadWriteTimeout = 30000
    $response = $null; $inputStream = $null; $outputStream = $null
    try {
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -ne 200) { throw 'The pinned download did not return HTTP 200.' }
        if ($response.ContentLength -le 0 -or $response.ContentLength -gt $MaximumBytes) { throw 'Unexpected or missing Content-Length.' }
        [void](Assert-DiskSpace $response.ContentLength)
        $inputStream = $response.GetResponseStream()
        $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $buffer = New-Object byte[] (1MB)
        $received = [long]0
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            if ($received + $count -gt $MaximumBytes -or $timer.Elapsed.TotalMinutes -gt 20) { throw 'Download size/time limit exceeded.' }
            [void](Assert-DiskSpace $count)
            $outputStream.Write($buffer, 0, $count)
            $received += $count
        }
        if ($received -ne $response.ContentLength) { throw 'Incomplete download.' }
        return [pscustomobject]@{ url = $Url; bytes = $received; sha256Pending = $true }
    } finally {
        if ($null -ne $outputStream) { $outputStream.Dispose() }
        if ($null -ne $inputStream) { $inputStream.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
    }
}

function Get-ObservedExitCode($Process) {
    if ($Process.HasExited -ne $true) { throw 'Child exit is not confirmed.' }
    $observed = $Process.ExitCode
    if ($null -eq $observed -or $observed -isnot [int]) {
        throw 'Child exit code is missing or invalid; it must not be converted to success.'
    }
    return $observed
}

function Invoke-ControlledProcess([string]$FilePath, [string[]]$Arguments, [string]$Label, [int]$TimeoutSeconds = 600) {
    $stdout = Assert-AreaPath (Join-Path $script:RunDirectory ($Label + '.stdout.txt'))
    $stderr = Assert-AreaPath (Join-Path $script:RunDirectory ($Label + '.stderr.txt'))
    $quoted = foreach ($argument in $Arguments) {
        if ($argument -match '["\r\n\x00]') { throw 'Unsupported character in a process argument.' }
        '"' + [regex]::Replace($argument, '(\\+)$', '$1$1') + '"'
    }
    $process = Start-Process -FilePath $FilePath -ArgumentList ($quoted -join ' ') -WorkingDirectory $script:RepoRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $child = [ordered]@{ label = $Label; pid = $process.Id; startedUtc = [DateTime]::UtcNow.ToString('o'); exited = $false; exitCode = $null; stdout = $stdout; stderr = $stderr }
    $script:Report.details.children += $child
    Save-Report
    try {
        # Keep the process handle available before waiting. Windows PowerShell
        # Start-Process can otherwise expose a null ExitCode after a fast exit.
        [void]$process.Handle
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while (-not $process.WaitForExit(1000)) {
            if ($timer.Elapsed.TotalSeconds -gt $TimeoutSeconds) {
                throw "Owned process still running: PID $($process.Id). No automatic kill/retry; coordinator must reconcile it."
            }
        }
        $process.WaitForExit()
        $child.exited = $true
        $child.exitCode = Get-ObservedExitCode $process
        Save-Report
        return $child.exitCode
    } finally { $process.Dispose() }
}

function Invoke-Com($Object, [string]$Name, [object[]]$Arguments) {
    return $Object.GetType().InvokeMember($Name, [Reflection.BindingFlags]::InvokeMethod, $null, $Object, $Arguments)
}

function Read-MsiRows($Database, [string]$Sql) {
    $view = $null; $record = $null
    $rows = New-Object Collections.Generic.List[object]
    try {
        $view = Invoke-Com $Database 'OpenView' @($Sql)
        [void](Invoke-Com $view 'Execute' @())
        while ($null -ne ($record = Invoke-Com $view 'Fetch' @())) {
            try {
                $fieldCount = $record.GetType().InvokeMember('FieldCount', [Reflection.BindingFlags]::GetProperty, $null, $record, $null)
                $fields = @()
                for ($index = 1; $index -le $fieldCount; $index++) {
                    $fields += $record.GetType().InvokeMember('StringData', [Reflection.BindingFlags]::GetProperty, $null, $record, @($index))
                }
                $rows.Add([object]$fields)
            } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record); $record = $null }
        }
    } finally {
        if ($null -ne $view) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) }
    }
    return ,$rows.ToArray()
}

function Get-MsiInspection([string]$Path) {
    $installer = $null; $database = $null; $summary = $null
    try {
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $database = Invoke-Com $installer 'OpenDatabase' @($Path, 0)
        $summary = $database.GetType().InvokeMember('SummaryInformation', [Reflection.BindingFlags]::GetProperty, $null, $database, @(0))
        $template = $summary.GetType().InvokeMember('Property', [Reflection.BindingFlags]::GetProperty, $null, $summary, @(7))
        $nameRows = Read-MsiRows $database 'SELECT `Name` FROM `_Tables`'
        $names = @(foreach ($row in $nameRows) { [string]$row[0] })
        $tables = [ordered]@{}
        $queries = [ordered]@{
            Property = 'SELECT `Property`,`Value` FROM `Property`'
            Feature = 'SELECT `Feature`,`Feature_Parent`,`Title`,`Level`,`Attributes` FROM `Feature`'
            FeatureComponents = 'SELECT `Feature_`,`Component_` FROM `FeatureComponents`'
            CustomAction = 'SELECT `Action`,`Type`,`Source`,`Target` FROM `CustomAction`'
            InstallExecuteSequence = 'SELECT `Action`,`Condition`,`Sequence` FROM `InstallExecuteSequence`'
            InstallUISequence = 'SELECT `Action`,`Condition`,`Sequence` FROM `InstallUISequence`'
            Registry = 'SELECT `Registry`,`Root`,`Key`,`Name`,`Value`,`Component_` FROM `Registry`'
            ServiceInstall = 'SELECT `ServiceInstall`,`Name`,`ServiceType`,`StartType`,`StartName`,`Component_` FROM `ServiceInstall`'
            ServiceControl = 'SELECT `ServiceControl`,`Name`,`Event`,`Arguments`,`Component_` FROM `ServiceControl`'
            LaunchCondition = 'SELECT `Condition`,`Description` FROM `LaunchCondition`'
            Media = 'SELECT `DiskId`,`LastSequence`,`Cabinet` FROM `Media`'
            File = 'SELECT `File`,`Component_`,`FileName`,`FileSize`,`Version`,`Sequence` FROM `File`'
        }
        foreach ($name in $queries.Keys) {
            if ($names -contains $name) { $tables[$name] = Read-MsiRows $database $queries[$name] }
        }
        $properties = @{}
        foreach ($row in $tables.Property) { $properties[$row[0]] = $row[1] }
        return [pscustomobject]@{ path = $Path; sha256 = Get-Sha256 $Path; signature = Assert-OracleSignature $Path; template = $template; properties = $properties; tableNames = $names; tables = $tables }
    } finally {
        foreach ($object in @($summary, $database, $installer)) {
            if ($null -ne $object) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($object) }
        }
    }
}

function Assert-MsiCandidate($Msi) {
    if ($Msi.template -notmatch '^x64(;|$)') { throw 'MSI is not an x64 package.' }
    if ($Msi.properties.ProductName -notmatch '^Oracle (VM )?VirtualBox(\s|$)' -or $Msi.properties.ProductVersion -notmatch '^7\.2\.20(\.|$)') {
        throw 'MSI product identity/version does not match the pinned VirtualBox release.'
    }
    if ($Msi.properties.ProductCode -notmatch '^\{[0-9A-Fa-f-]{36}\}$') { throw 'Invalid MSI ProductCode.' }
    $features = @($Msi.tables.Feature | ForEach-Object { $_[0] })
    if ($features -notcontains 'VBoxApplication') { throw 'Required application feature is absent.' }
    foreach ($feature in $features) {
        if ($feature -notin @('VBoxApplication', 'VBoxUSB', 'VBoxNetwork', 'VBoxNetworkFlt', 'VBoxNetworkAdp', 'VBoxPython')) {
            throw "Unreviewed MSI feature: $feature"
        }
    }
    $search = $Msi.tables | ConvertTo-Json -Depth 16
    if ($search -match '(?i)InstallCertificates|CertAdd|AddCertToStore|TrustedPublisher|certutil|certmgr|Set-MpPreference|DisableRealtimeMonitoring|hypervisorlaunchtype|nointegritychecks|testsigning') {
        throw 'MSI metadata contains a trust/security action requiring coordinator review; automatic installation is disabled.'
    }
}

function New-PendingOperation {
    Assert-Administrator
    Assert-NoReparsePoint $script:PendingPath
    if (Test-Path -LiteralPath $script:PendingPath) { throw 'An unresolved host operation exists. Preserve it and ask the coordinator to reconcile the state.' }
    if (@(Get-RebootMarkers).Count -ne 0) { throw 'A restart is already pending. Reconcile it before another host mutation.' }
    $stream = [IO.File]::Open($script:PendingPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        $bytes = $script:Utf8.GetBytes((@{ step = $Step; report = $script:ReportPath; startedUtc = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json))
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
    $script:PendingOwned = $true
}

function Complete-PendingOperation {
    if ($script:PendingOwned) {
        $destination = Assert-AreaPath (Join-Path $script:RunDirectory 'host-operation.completed.json')
        Assert-NoReparsePoint $script:PendingPath
        Move-Item -LiteralPath $script:PendingPath -Destination $destination
        $script:PendingOwned = $false
    }
}

function Get-InstalledFeatureStates([string]$ProductCode, [string[]]$Names) {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    try {
        $states = [ordered]@{}
        foreach ($name in $Names) {
            $states[$name] = $installer.GetType().InvokeMember('FeatureState', [Reflection.BindingFlags]::GetProperty, $null, $installer, @($ProductCode, $name))
        }
        return $states
    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) }
}

try {
    # This script is pinned to the reviewed 7.2.20 release. Do not let a caller
    # change report/hash arguments to opt out of the unresolved vendor boundary.
    # Reject before administrator checks, report creation, or any host operation.
    if ($Step -eq 'InstallVirtualBox') {
        throw ('AUTO_INSTALL_BLOCKED: VirtualBox 7.2.20 x64 MSI ' + $script:BlockedMsiHash + ' requires further review of vendor REBOOT=Force and fixed c:\temp\targetdir.ctx create/delete behavior. Restarting the host or changing review arguments does not authorize automatic installation.')
    }
    if (-not [Environment]::Is64BitProcess) { throw 'Use 64-bit Windows PowerShell.' }
    if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot '.git'))) { throw 'Script is not inside the assigned Git worktree.' }
    Assert-NoReparsePoint $script:RepoRoot
    Assert-NoReparsePoint $script:Area
    [void](Assert-DiskSpace)
    [void][IO.Directory]::CreateDirectory($script:Area)
    $script:RunDirectory = New-AreaDirectory (Join-Path $script:Area ('runs\' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + $Step + '-' + [Guid]::NewGuid().ToString('N')))
    $script:ReportPath = Join-Path $script:RunDirectory 'report.json'
    $script:Report = [ordered]@{
        schemaVersion = 1; step = $Step; status = 'running'; startedUtc = [DateTime]::UtcNow.ToString('o'); updatedUtc = $null
        workspaceRoot = $script:RepoRoot; requestedModel = 'gpt-6-astra / max'; actualModelIdentity = 'not-independently-verified'
        details = [ordered]@{ children = @(); installerVersion = $script:Version; diskFloorBytes = $script:DiskFloor }
    }
    Save-Report
    switch ($Step) {
        'Inspect' {
            $script:Report.details.host = Get-HostState
            $script:Report.details.pendingHostOperation = Test-Path -LiteralPath $script:PendingPath
            $script:Report.details.microsoftRegistration = 'User-owned; no registration, account creation, form submission, ISO selection or ISO download is performed.'
        }
        'DownloadInstaller' {
            [void](New-AreaDirectory $script:Downloads)
            $manifest = Join-Path $script:RunDirectory 'SHA256SUMS'
            $script:Report.details.manifestDownload = Receive-OfficialFile ($script:DownloadBase + 'SHA256SUMS') $manifest 1MB
            $matches = [regex]::Matches([IO.File]::ReadAllText($manifest), ('(?m)^([a-fA-F0-9]{64})\s+\*?' + [regex]::Escape($script:InstallerName) + '\r?$'))
            if ($matches.Count -ne 1 -or $matches[0].Groups[1].Value.ToLowerInvariant() -ne $script:ExpectedInstallerHash) { throw 'Official SHA256SUMS does not match the reviewed pinned release.' }
            if (-not (Test-Path -LiteralPath $script:Installer)) {
                $partial = Join-Path $script:RunDirectory $script:InstallerName
                $script:Report.details.installerDownload = Receive-OfficialFile ($script:DownloadBase + $script:InstallerName) $partial 300MB
                if ((Get-Sha256 $partial) -ne $script:ExpectedInstallerHash) { throw 'Downloaded installer hash mismatch; partial artifact is preserved.' }
                $script:Report.details.downloadSignature = Assert-OracleSignature $partial
                Move-Item -LiteralPath $partial -Destination $script:Installer
            }
            $script:Report.details.installer = Get-VerifiedInstaller
        }
        'ExtractInstaller' {
            [void](Assert-DiskSpace 2GB)
            $before = Get-SecuritySnapshot
            $script:Report.details.securityBefore = $before
            if (@($before.errors).Count -ne 0) { throw 'Security baseline is incomplete; extraction is not started.' }
            $installerPath = Assert-AreaPath $script:Installer
            $installerLock = [IO.File]::Open($installerPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            try {
                $script:Report.details.installer = Get-VerifiedInstaller
                $exitCode = Invoke-ControlledProcess $installerPath @('--silent', '--help') 'installer-help' 60
                if ($exitCode -ne 0) { throw "Installer help failed with exit code $exitCode." }
                $helpText = [IO.File]::ReadAllText((Join-Path $script:RunDirectory 'installer-help.stdout.txt'))
                foreach ($option in @('--extract', '--path', '--no-silent-cert')) {
                    if (-not $helpText.Contains($option)) { throw "The pinned binary did not confirm the required option: $option" }
                }
                if ($helpText -notmatch '7\.2\.20') { throw 'Installer help version mismatch.' }
                # v7.2.20 parses --no-install-timestamp-ca under CODE_SIGNING,
                # but only displays it under LEGACY_TS_CA. Keep the argument;
                # reject an unrecognized option through the real nonzero exit.
                # The same release's fExtractOnly branch skips both certificate
                # installation functions and ProcessPackage entirely.
                $script:Report.details.extractionSourceReference = 'https://github.com/VirtualBox/virtualbox/blob/v7.2.20/src/VBox/Installer/win/Stub/VBoxStub.cpp'
                $script:Report.details.timestampOptionShownInHelp = $helpText.Contains('--no-install-timestamp-ca')
                $extractRoot = New-AreaDirectory (Join-Path $script:RunDirectory 'extracted')
                $script:Report.details.extractionDirectory = $extractRoot
                $exitCode = Invoke-ControlledProcess $installerPath @('--silent', '--extract', '--path', $extractRoot, '--no-silent-cert', '--no-install-timestamp-ca') 'installer-extract' 120
                if ($exitCode -ne 0) { throw "Installer extraction failed with exit code $exitCode." }
            } catch {
                $script:Report.details.extractionError = $_.Exception.Message
                throw
            } finally {
                $installerLock.Dispose()
                # Capture security state even if help/options/process collection
                # failed. Keep any earlier error as extractionError above.
                $after = Get-SecuritySnapshot
                $script:Report.details.securityAfter = $after
                try {
                    Assert-SecurityUnchanged $before $after
                    $script:Report.details.securityComparison = 'unchanged'
                } catch {
                    $script:Report.details.securityComparison = 'failed'
                    $script:Report.details.securityComparisonError = $_.Exception.Message
                    throw
                } finally { Save-Report }
            }
        }
        'InspectMsi' {
            $extraction = Read-Report $ExtractionReport 'ExtractInstaller'
            $root = Assert-AreaPath $extraction.details.extractionDirectory
            $items = @(Get-ChildItem -LiteralPath $root -Force)
            if ($items.Count -eq 0 -or $items.Count -gt 32) { throw 'Unexpected extraction payload count.' }
            $payloads = @(); $candidates = @()
            foreach ($item in $items) {
                $path = Assert-AreaPath $item.FullName
                if ($item.PSIsContainer) { throw 'Nested extraction content requires separate review.' }
                $payloads += [pscustomobject]@{ path = $path; bytes = $item.Length; sha256 = Get-Sha256 $path }
                if ($item.Extension -eq '.msi') {
                    $inspection = Get-MsiInspection $path
                    if ($inspection.template -match '^x64(;|$)') { $candidates += $inspection }
                }
            }
            $script:Report.details.extractionDirectory = $root
            $script:Report.details.payloads = $payloads
            $script:Report.details.candidates = $candidates
            Save-Report
            if ($candidates.Count -ne 1) { throw 'Expected exactly one x64 MSI; coordinator must review the package layout.' }
            Assert-MsiCandidate $candidates[0]
            foreach ($row in $candidates[0].tables.Media) {
                $cabinet = [string]$row[2]
                if ($cabinet -and -not $cabinet.StartsWith('#')) {
                    if ($cabinet -notmatch '^[^\\/:]+\.cab$' -or -not (Test-Path -LiteralPath (Join-Path $root $cabinet))) { throw 'MSI references an unexpected external cabinet.' }
                }
            }
            $script:Report.details.selectedMsi = $candidates[0]
            $script:Report.details.reviewRequired = 'Coordinator must review the actual signed MSI tables and custom actions. Source-main findings alone do not approve this release.'
        }
        'InstallVirtualBox' {
            Assert-Administrator
            if ($ReviewedMsiSha256 -notmatch '^[a-fA-F0-9]{64}$' -or $ReviewedInspectionSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Explicit reviewed MSI and inspection-report hashes are required.' }
            $reviewPath = Assert-AreaPath $MsiReviewReport
            if ((Get-Sha256 $reviewPath) -ne $ReviewedInspectionSha256.ToLowerInvariant()) { throw 'MSI inspection report changed after review.' }
            $review = Read-Report $reviewPath 'InspectMsi'
            $msi = $review.details.selectedMsi
            Assert-MsiCandidate $msi
            $msiPath = Assert-AreaPath $msi.path
            if ((Get-Sha256 $msiPath) -ne $ReviewedMsiSha256.ToLowerInvariant() -or $msi.sha256 -ne $ReviewedMsiSha256.ToLowerInvariant()) { throw 'Reviewed MSI hash mismatch.' }
            $script:Report.details.msiSignature = Assert-OracleSignature $msiPath
            Assert-NoExistingVirtualBox
            [void](Assert-DiskSpace 2GB)
            $before = Get-SecuritySnapshot
            $script:Report.details.securityBefore = $before
            if (@($before.errors).Count -ne 0) { throw 'Security baseline is incomplete; installation is not started.' }
            $extractRoot = Assert-AreaPath $review.details.extractionDirectory
            $currentPaths = @(Get-ChildItem -LiteralPath $extractRoot -Force | ForEach-Object { Assert-AreaPath $_.FullName } | Sort-Object)
            $reviewedPaths = @($review.details.payloads | ForEach-Object { Assert-AreaPath $_.path } | Sort-Object)
            if (($currentPaths -join '|') -ne ($reviewedPaths -join '|')) { throw 'Extraction payload set changed after review.' }
            $locks = New-Object Collections.Generic.List[object]
            try {
                foreach ($payload in $review.details.payloads) {
                    $path = Assert-AreaPath $payload.path
                    $locks.Add([IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
                    if ((Get-Sha256 $path) -ne $payload.sha256) { throw 'An extraction payload changed after review.' }
                }
                New-PendingOperation
                $arguments = @('/i', $msiPath, '/qn', '/norestart', '/L*v', (Join-Path $script:RunDirectory 'msi-install.log'), 'ADDLOCAL=VBoxApplication', 'REBOOT=ReallySuppress', 'VBOX_START=0', 'VBOX_INSTALLDESKTOPSHORTCUT=0', 'VBOX_INSTALLQUICKLAUNCHSHORTCUT=0', 'VBOX_REGISTERFILEEXTENSIONS=0', ('INSTALLDIR=' + $script:InstallDirectory))
                $script:Report.details.installArguments = $arguments
                Save-Report
                $msiexec = Join-Path ([Environment]::GetFolderPath('System')) 'msiexec.exe'
                $exitCode = Invoke-ControlledProcess $msiexec $arguments 'msiexec' 900
                $script:Report.details.installExitCode = $exitCode
                $script:Report.details.restartNeeded = ($exitCode -eq 3010)
                $after = Get-SecuritySnapshot
                $script:Report.details.securityAfter = $after
                Save-Report
                Assert-SecurityUnchanged $before $after
                if ($exitCode -notin @(0, 3010)) { throw "MSI did not complete successfully: $exitCode. No automatic retry/repair/uninstall." }
                $featureNames = @($msi.tables.Feature | ForEach-Object { $_[0] })
                $states = Get-InstalledFeatureStates $msi.properties.ProductCode $featureNames
                $script:Report.details.installedFeatureStates = $states
                if ($states['VBoxApplication'] -ne 3) { throw 'Application feature is not installed locally.' }
                foreach ($name in $featureNames) {
                    if ($name -ne 'VBoxApplication' -and $states[$name] -ne 2) { throw "Optional feature was not confirmed absent: $name" }
                }
                [void](Assert-DiskSpace)
                Complete-PendingOperation
            } finally { foreach ($handle in $locks) { $handle.Dispose() } }
        }
        'EnableWhp' {
            Assert-Administrator
            [void](Assert-DiskSpace 2GB)
            $before = Get-SecuritySnapshot
            $script:Report.details.securityBefore = $before
            if (@($before.errors).Count -ne 0) { throw 'Security baseline is incomplete; WHP is not changed.' }
            $feature = Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform
            $script:Report.details.featureBefore = [string]$feature.State
            if ([string]$feature.State -eq 'Enabled') {
                $script:Report.details.alreadyEnabled = $true
            } else {
                if ([string]$feature.State -ne 'Disabled') { throw 'WHP is neither Enabled nor Disabled; pending/removed states require review.' }
                New-PendingOperation
                $scratch = New-AreaDirectory (Join-Path $script:RunDirectory 'dism-scratch')
                $result = Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -NoRestart -LimitAccess -LogPath (Join-Path $script:RunDirectory 'dism.log') -ScratchDirectory $scratch
                $script:Report.details.restartNeeded = $result.RestartNeeded
                $script:Report.details.featureAfter = [string](Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform).State
                $after = Get-SecuritySnapshot
                $script:Report.details.securityAfter = $after
                Save-Report
                Assert-SecurityUnchanged $before $after
                if ($script:Report.details.featureAfter -notin @('Enabled', 'EnablePending')) { throw 'WHP activation did not reach Enabled or EnablePending.' }
                [void](Assert-DiskSpace)
                Complete-PendingOperation
            }
        }
        'VerifyHost' {
            $script:Report.details.host = Get-HostState
            $script:Report.details.pendingHostOperation = Test-Path -LiteralPath $script:PendingPath
            $vboxManage = Join-Path $script:InstallDirectory 'VBoxManage.exe'
            $script:Report.details.virtualBoxPresent = Test-Path -LiteralPath $vboxManage
            $script:Report.details.virtualBoxVersionExecuted = $false
            if ($script:Report.details.virtualBoxPresent) { $script:Report.details.virtualBoxSignature = Assert-OracleSignature $vboxManage }
            $script:Report.details.readyForVmConfiguration = $false
            if (-not $script:Report.details.pendingHostOperation -and $script:Report.details.virtualBoxPresent -and $script:Report.details.host.hypervisorPlatformState -eq 1 -and @($script:Report.details.host.rebootMarkers).Count -eq 0) {
                $exitCode = Invoke-ControlledProcess $vboxManage @('--version') 'vboxmanage-version' 30
                $version = [IO.File]::ReadAllText((Join-Path $script:RunDirectory 'vboxmanage-version.stdout.txt')).Trim()
                $script:Report.details.virtualBoxVersionExecuted = $true
                $script:Report.details.virtualBoxVersion = $version
                if ($exitCode -ne 0 -or $version -notmatch '^7\.2\.20r175154') { throw 'Installed VirtualBox version check failed.' }
                $script:Report.details.readyForVmConfiguration = $true
            }
            $script:Report.details.remaining = @('User completes Microsoft evaluation registration and terms review.', 'Use an officially obtained x64 ISO with recorded version and official hash.', 'Coordinator schedules any required host restart with the user.', 'Create the separately reviewed 6 GiB / 80 GiB VM; this script does not create or boot a VM.')
        }
    }
    $script:Report.status = 'succeeded'
    Save-Report
    [pscustomobject]@{ step = $Step; status = $script:Report.status; report = $script:ReportPath; reportSha256 = Get-Sha256 $script:ReportPath; pendingHostOperation = Test-Path -LiteralPath $script:PendingPath } | ConvertTo-Json
} catch {
    if ($null -ne $script:Report) {
        $script:Report.status = 'failed'
        $script:Report.details.error = $_.Exception.Message
        $script:Report.details.pendingHostOperation = Test-Path -LiteralPath $script:PendingPath
        try { Save-Report } catch { Write-Warning 'Could not finish the preparation report.' }
        Write-Output ("Failed step report: " + $script:ReportPath)
    }
    throw
}
