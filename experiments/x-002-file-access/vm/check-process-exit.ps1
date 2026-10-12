# Regressions for the real process collector. No administrator or installer work.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$script:Area = Join-Path $script:RepoRoot '.runtime\vm'
$script:DiskFloor = 25GB
$script:Utf8 = New-Object Text.UTF8Encoding($false, $true)
$sourcePath = Join-Path $PSScriptRoot 'prepare-host.ps1'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw ($parseErrors | Out-String) }
# Import selected definitions, never the preparation step dispatcher. The tests
# call the production collector instead of duplicating its process logic.
$required = @('Assert-NoReparsePoint', 'Assert-AreaPath', 'New-AreaDirectory', 'Get-FreeBytes', 'Assert-DiskSpace', 'Get-Sha256', 'Save-Report', 'Get-ObservedExitCode', 'Invoke-ControlledProcess')
$definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false) | Where-Object { $_.Name -in $required })
if ($definitions.Count -ne $required.Count) { throw 'Expected preparation functions are missing.' }
foreach ($definition in $definitions) { . ([scriptblock]::Create($definition.Extent.Text)) }
[void](Assert-DiskSpace)
$script:RunDirectory = New-AreaDirectory (Join-Path $script:Area ('checks\process-exit-' + [Guid]::NewGuid().ToString('N')))
$script:ReportPath = Join-Path $script:RunDirectory 'report.json'
$script:Report = [ordered]@{ schemaVersion = 1; step = 'CheckProcessExit'; status = 'running'; updatedUtc = $null; details = [ordered]@{ sourceSha256 = Get-Sha256 $sourcePath; children = @(); cases = @() } }
try {
    Save-Report
    foreach ($expected in @(0, 7)) {
        $actual = Invoke-ControlledProcess (Join-Path $PSHOME 'powershell.exe') @('-NoProfile', '-NonInteractive', '-Command', ('exit ' + $expected)) ('exit-' + $expected) 20
        if ($actual -ne $expected) { throw "Child exit mismatch: expected=$expected actual=$actual" }
        $script:Report.details.cases += [pscustomobject]@{ name = ('real-exit-' + $expected); expected = $expected; actual = $actual; passed = $true }
    }
    $rejection = $null
    try { [void](Get-ObservedExitCode ([pscustomobject]@{ HasExited = $true; ExitCode = $null })) } catch { $rejection = $_.Exception.Message }
    if ($null -eq $rejection -or $rejection -notmatch 'exit code is missing') { throw 'A missing child exit code was not rejected.' }
    $script:Report.details.cases += [pscustomobject]@{ name = 'missing-exit-code'; rejection = $rejection; passed = $true }
    # Exercise the real top-level installation entry point. Its unconditional
    # release guard must run before administrator/MSI/report creation logic.
    $runsRoot = Join-Path $script:Area 'runs'
    $runsBefore = if (Test-Path -LiteralPath $runsRoot) { @(Get-ChildItem -LiteralPath $runsRoot -Directory | Select-Object -ExpandProperty Name | Sort-Object) } else { @() }
    $pendingPath = Join-Path $script:Area 'host-operation.pending.json'
    $pendingBefore = Test-Path -LiteralPath $pendingPath
    $blockedHash = 'ae40bb2b2770fcd264cb9d03de2d278a621997b33956e88a2de5edc900873d2a'
    $guardExit = Invoke-ControlledProcess (Join-Path $PSHOME 'powershell.exe') @('-NoProfile', '-NonInteractive', '-File', $sourcePath, '-Step', 'InstallVirtualBox', '-ReviewedMsiSha256', $blockedHash) 'blocked-install' 20
    $guardError = [IO.File]::ReadAllText((Join-Path $script:RunDirectory 'blocked-install.stderr.txt'))
    if ($guardExit -eq 0 -or -not $guardError.Contains('AUTO_INSTALL_BLOCKED') -or -not $guardError.Contains($blockedHash)) { throw 'The real installation entry point did not report its explicit release block.' }
    $runsAfter = if (Test-Path -LiteralPath $runsRoot) { @(Get-ChildItem -LiteralPath $runsRoot -Directory | Select-Object -ExpandProperty Name | Sort-Object) } else { @() }
    if (($runsBefore -join '|') -ne ($runsAfter -join '|') -or (Test-Path -LiteralPath $pendingPath) -ne $pendingBefore) { throw 'The blocked installation advanced to preparation or pending host state.' }
    $script:Report.details.cases += [pscustomobject]@{ name = 'automatic-install-blocked-before-host-work'; exitCode = $guardExit; blockedMsiSha256 = $blockedHash; noPreparationRunCreated = $true; pendingMarkerUnchanged = $true; passed = $true }
    $script:Report.status = 'succeeded'
    Save-Report
    [pscustomobject]@{ status = $script:Report.status; cases = $script:Report.details.cases.Count; report = $script:ReportPath; sha256 = Get-Sha256 $script:ReportPath } | ConvertTo-Json
} catch {
    $script:Report.status = 'failed'
    $script:Report.details.error = $_.Exception.Message
    Save-Report
    throw
}
