# Use a non-executable text fixture to check both independent prerequisites.
# Run from plain, unelevated Windows PowerShell with a readable SAC state.
$ErrorActionPreference = 'Stop'
$tempDir = Join-Path ([IO.Path]::GetTempPath()) ('ORBIT-X002-input-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir | Out-Null
$fake = Join-Path $tempDir 'FileAccessProbe.exe'
try {
    [IO.File]::WriteAllText($fake, 'X-002 signature test text. This is not an executable.')
    $digest = (Get-FileHash -LiteralPath $fake -Algorithm SHA256).Hash
    $cases = @(
        @{ hash = '0' * 64; reason = 'SHA-256 differs' },
        @{ hash = $digest; reason = 'no valid Authenticode signature' }
    )
    foreach ($case in $cases) {
        $lines = & (Join-Path $PSHOME 'powershell.exe') -NoProfile -File (Join-Path $PSScriptRoot 'run.ps1') -SignedControllerPath $fake -ReviewedControllerSha256 $case.hash
        if ($LASTEXITCODE -ne 3) { throw "Expected withheld exit 3, received $LASTEXITCODE." }
        $line = @($lines -like 'X-002 preflight: *')
        if ($line.Count -ne 1) { throw 'Missing preflight report location.' }
        $reportFile = $line[0].Substring('X-002 preflight: '.Length)
        $report = Get-Content -LiteralPath $reportFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($report.stage -ne 'controller-preflight' -or $report.reason -notmatch $case.reason -or
            $report.controllerStarted -ne $false -or $report.filePolicyApplied -ne $false -or
            $report.productProtectionApproved -ne $false) { throw "Unexpected decision: $($report.reason)" }
        $baseline = $report.ordinaryUserRead
        if (-not ($report.interactiveMediumUser -and $baseline.allowedMatches -and $baseline.protectedMatches -and
            $baseline.distinct -and $baseline.cleaned)) { throw 'Missing ordinary-user control or cleanup.' }
        $files = @(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($reportFile)) -Force)
        if ($files.Count -ne 1 -or $files[0].Name -ne 'preflight.json') { throw 'Unexpected run artifacts.' }
        Write-Output "PASS: $($report.reason) User reads matched and temporary fixtures were removed."
    }
} finally {
    [IO.File]::Delete($fake)
    [IO.Directory]::Delete($tempDir, $false)
}
