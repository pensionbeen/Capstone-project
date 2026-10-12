param([switch]$KeepFixtures, [switch]$InjectPolicyFailure)

$ErrorActionPreference = 'Stop'
$experimentRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $experimentRoot '.runtime/x-002-file-access'))

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

Assert-PlainPath $runtimeRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw 'The installed .NET Framework C# compiler is required; nothing is installed automatically.'
}
$runName = 'run-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N')
$runRoot = Join-Path $runtimeRoot $runName
New-Item -ItemType Directory -Path $runRoot | Out-Null
Assert-PlainPath $runRoot
$binary = Join-Path $runRoot 'FileAccessProbe.exe'
$source = Join-Path $PSScriptRoot 'FileAccessProbe.cs'
$os = Get-CimInstance -ClassName Win32_OperatingSystem
[ordered]@{
    capturedUtc = [DateTime]::UtcNow.ToString('o')
    windowsCaption = $os.Caption
    windowsVersion = $os.Version
    windowsBuild = $os.BuildNumber
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    compilerVersion = (Get-Item -LiteralPath $compiler).VersionInfo.FileVersion
    sourceSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot 'environment.json') -Encoding UTF8
Copy-Item -LiteralPath $source -Destination (Join-Path $runRoot 'source.cs')
& $compiler /nologo /target:exe /platform:anycpu /reference:System.Web.Extensions.dll "/out:$binary" $source
if ($LASTEXITCODE -ne 0) { throw "Compilation failed: $LASTEXITCODE. Run directory preserved: $runRoot" }
$mode = 'run'
if ($KeepFixtures) { $mode = 'run-keep' }
if ($InjectPolicyFailure) {
    if ($KeepFixtures) { throw 'KeepFixtures and InjectPolicyFailure cannot be combined.' }
    $mode = 'run-fail-policy'
}
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
exit $probeExit
