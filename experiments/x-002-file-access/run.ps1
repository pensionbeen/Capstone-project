param(
    [switch]$KeepFixtures,
    [switch]$InjectPolicyFailure,
    [string]$SignedControllerPath,
    [ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ReviewedControllerSha256
)

$ErrorActionPreference = 'Stop'
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) 'ORBIT-X002'))
if ($KeepFixtures -and $InjectPolicyFailure) { throw 'KeepFixtures and InjectPolicyFailure cannot be combined.' }
if (([bool]$SignedControllerPath) -ne ([bool]$ReviewedControllerSha256)) {
    throw 'A signed FileAccessProbe.exe and its independently reviewed SHA-256 must be supplied together.'
}

# Never use a caller-supplied fixture destination. Refuse links at every existing
# component before creating files, and let the helper repeat the same checks.
function Assert-PlainPath([string]$Path) {
    $part = [IO.Path]::GetFullPath($Path)
    while ($part) {
        if (Test-Path -LiteralPath $part) {
            $item = Get-Item -LiteralPath $part -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Reparse point is not supported: $part"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($part)
        if ($parent -eq $part) { break }
        $part = $parent
    }
}

function Test-InteractiveUser {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = [Security.Principal.WindowsPrincipal]$identity
        $login = (Get-CimInstance -ClassName Win32_ComputerSystem).UserName
        $groups = & (Join-Path ([Environment]::SystemDirectory) 'whoami.exe') /groups /fo csv /nh
        return $LASTEXITCODE -eq 0 -and $identity.Name -eq $login -and
            -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and
            [bool]($groups -match '"S-1-16-8192"')
    } finally { $identity.Dispose() }
}

# This control runs only when the native controller cannot be started. It reads
# two sibling files in the interactive user's PowerShell. Neither contents nor
# digests are emitted. The native matrix does its own same-file Win32 control.
function Test-UserRead([string]$RunDirectory) {
    $result = [ordered]@{ allowedMatches = $false; protectedMatches = $false; distinct = $false; cleaned = $false }
    $project = Join-Path $RunDirectory 'user-read'
    Assert-PlainPath $project
    New-Item -ItemType Directory -Path $project -ErrorAction Stop | Out-Null
    $created = @()
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $values = @{}
        foreach ($name in 'allowed','protected') {
            $bytes = New-Object byte[] 32
            do {
                $random.GetBytes($bytes)
                $value = [Convert]::ToBase64String($bytes)
            } while ($values.ContainsValue($value))
            $values[$name] = $value
            $path = Join-Path $project ($name + '.txt')
            $file = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $created += $path
                $data = [Text.Encoding]::ASCII.GetBytes($value)
                $file.Write($data, 0, $data.Length)
            } finally { $file.Dispose() }
        }
        $result.distinct = $values.allowed -cne $values.protected
        foreach ($name in 'allowed','protected') {
            $actual = [IO.File]::ReadAllText((Join-Path $project ($name + '.txt')), [Text.Encoding]::ASCII)
            $result[$name + 'Matches'] = $actual -ceq $values[$name]
        }
    } catch {
        $result.errorType = $_.Exception.GetType().Name
    } finally {
        $random.Dispose()
        foreach ($path in $created) {
            try {
                Assert-PlainPath $path
                [IO.File]::Delete($path)
            } catch { $result.cleanupError = $_.Exception.GetType().Name }
        }
        try {
            Assert-PlainPath $project
            [IO.Directory]::Delete($project, $false)
            $result.cleaned = -not (Test-Path -LiteralPath $project)
        } catch { $result.cleanupError = $_.Exception.GetType().Name }
    }
    return $result
}

Assert-PlainPath $runtimeRoot
$runName = 'run-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N')
$runRoot = Join-Path $runtimeRoot $runName
New-Item -ItemType Directory -Path $runRoot | Out-Null
Assert-PlainPath $runRoot
$binary = Join-Path $runRoot 'FileAccessProbe.exe'
$source = Join-Path $PSScriptRoot 'FileAccessProbe.cs'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$sac = 'Unknown'
try {
    $reported = (Get-MpComputerStatus -ErrorAction Stop).SmartAppControlState
    if ($reported -in 'On','Off','Evaluation') { $sac = [string]$reported }
} catch { }
$hold = $null
try { $interactive = Test-InteractiveUser } catch { $interactive = $false }
if (-not $interactive) {
    $hold = 'Start from the interactive Windows user account at medium integrity without elevation.'
} elseif ($sac -eq 'Unknown') {
    $hold = 'Smart App Control state is unavailable. Controller launch withheld.'
} elseif ($sac -eq 'On' -and -not $SignedControllerPath) {
    $hold = 'Smart App Control is On. No reviewed, signed X-002 controller was supplied.'
}
$pin = $null
if ($SignedControllerPath -and -not $hold) {
    try {
        if ($SignedControllerPath -notmatch '^[A-Za-z]:[\\/]' -or [IO.Path]::GetFileName($SignedControllerPath) -ne 'FileAccessProbe.exe') {
            throw 'Expected a local signed FileAccessProbe.exe.'
        }
        $reviewed = (Get-Item -LiteralPath $SignedControllerPath).FullName
        Assert-PlainPath $reviewed
        $sourcePin = [IO.File]::Open($reviewed, 'Open', 'Read', 'Read')
        try {
            if ((Get-FileHash -LiteralPath $reviewed -Algorithm SHA256).Hash -ne $ReviewedControllerSha256) {
                throw 'Controller SHA-256 differs from the independently reviewed signed build.'
            }
            if ((Get-AuthenticodeSignature -LiteralPath $reviewed).Status -ne 'Valid') {
                throw 'Controller has no valid Authenticode signature.'
            }
            [IO.File]::Copy($reviewed, $binary, $false)
        } finally { $sourcePin.Dispose() }
        # Launch only the verified copy in this run, kept read-locked through
        # execution. It also identifies the matching binary for later recovery.
        $pin = [IO.File]::Open($binary, 'Open', 'Read', 'Read')
        if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $ReviewedControllerSha256 -or
            (Get-AuthenticodeSignature -LiteralPath $binary).Status -ne 'Valid') {
            throw 'Copied controller failed hash or signature verification.'
        }
    } catch {
        if ($pin) { $pin.Dispose(); $pin = $null }
        $hold = $_.Exception.Message
    }
}
if ($hold) {
    $held = [ordered]@{
        stage = 'controller-preflight'; reason = $hold; smartAppControl = $sac
        interactiveMediumUser = $interactive; ordinaryUserRead = $null
        controllerStarted = $false; filePolicyApplied = $false; productProtectionApproved = $false
    }
    if ($interactive) {
        try { $held.ordinaryUserRead = Test-UserRead $runRoot } catch { $held.baselineError = $_.Exception.GetType().Name }
    }
    $heldPath = Join-Path $runRoot 'preflight.json'
    $held | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $heldPath -Encoding UTF8
    Write-Output "X-002 withheld before compilation or controller launch. $hold"
    Write-Output "X-002 preflight: $heldPath"
    exit 3
}
try {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem
    $compilerVersion = $null
    if (-not $SignedControllerPath) {
        if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'Installed .NET Framework compiler required.' }
        $compilerVersion = (Get-Item -LiteralPath $compiler).VersionInfo.FileVersion
    }
    [ordered]@{
        capturedUtc = [DateTime]::UtcNow.ToString('o')
        windowsCaption = $os.Caption
        windowsVersion = $os.Version
        windowsBuild = $os.BuildNumber
        powershellVersion = $PSVersionTable.PSVersion.ToString()
        compilerVersion = $compilerVersion
        smartAppControl = $sac
        reviewedControllerSha256 = $ReviewedControllerSha256
        sourceSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot 'environment.json') -Encoding UTF8
    if (-not $SignedControllerPath) {
        Copy-Item -LiteralPath $source -Destination (Join-Path $runRoot 'source.cs')
        & $compiler /nologo /target:exe /platform:anycpu /reference:System.Web.Extensions.dll "/out:$binary" $source
        if ($LASTEXITCODE -ne 0) { throw "Compilation failed: $LASTEXITCODE. Run directory preserved: $runRoot" }
    }
    $mode = 'run'
    if ($KeepFixtures) { $mode = 'run-keep' }
    if ($InjectPolicyFailure) { $mode = 'run-fail-policy' }
    try {
        & $binary $mode $runRoot
        $probeExit = $LASTEXITCODE
    } catch {
        [ordered]@{
            capturedUtc = [DateTime]::UtcNow.ToString('o')
            stage = 'controller-launch'
            errorType = $_.Exception.GetType().FullName
            hresult = $_.Exception.HResult
            message = $_.Exception.Message
            fixtureExists = Test-Path -LiteralPath (Join-Path $runRoot 'fixtures')
            reportExists = Test-Path -LiteralPath (Join-Path $runRoot 'report.json')
            helperSha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
            retryPerformed = $false
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot 'launcher-error.json') -Encoding UTF8
        Write-Output "Controller launch failed. Evidence preserved: $runRoot/launcher-error.json"
        throw
    }
    Write-Output "X-002 report: $runRoot/report.json"
    Write-Output "X-002 exit: $probeExit (0 = observations complete, not product protection approval)"
} finally { if ($pin) { $pin.Dispose() } }
exit $probeExit
