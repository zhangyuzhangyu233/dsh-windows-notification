# dsh-windows-notification : setup-protocol.ps1
#
# Idempotently registers the dsh-notify:// URL protocol for the current user so
# toast action buttons (activationType="protocol") can call back into DSH.
# Per-user HKCU registration only - no admin rights required.
#
# Registered layout (HKCU\Software\Classes\dsh-notify):
#   (default)            = "URL:DeepSeek Harness Notification"
#   "URL Protocol"       = ""
#   dshLaunchTarget      = absolute path of the DSH executable (used by
#                          notify-handler.ps1 when DSH is not running)
#   shell\open\command   = "<powershell.exe>" -NoLogo -NoProfile -NonInteractive
#                          -ExecutionPolicy Bypass -WindowStyle Hidden
#                          -File "<notify-handler.ps1>" "%1"
#
# Usage:
#   setup-protocol.ps1 [-HandlerPath <absolute notify-handler.ps1>]
#                      [-LaunchTarget <absolute DSH exe>]
#   stdout: {"ok":true,"registered":true,"changed":true,"handler":"...",
#            "launchTarget":"...","command":"..."}
#   Always prints exactly one JSON line on stdout and exits 0.

[CmdletBinding()]
param(
    [string]$HandlerPath = '',
    [string]$LaunchTarget = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ConfirmPreference = 'None'

$script:Utf8 = [System.Text.UTF8Encoding]::new($false)
try { [Console]::OutputEncoding = $script:Utf8 } catch { }

function Write-JsonLine {
    param([object]$Value)
    $json = $null
    try { $json = ($Value | ConvertTo-Json -Compress -Depth 6) }
    catch { $json = '{"ok":false,"error":"json-serialize-failed"}' }
    if ([string]::IsNullOrEmpty($json)) { $json = '{"ok":false,"error":"json-empty"}' }
    $text = $json + "`n"
    $bytes = $script:Utf8.GetBytes($text)
    $written = $false
    try {
        $stdout = [Console]::OpenStandardOutput()
        $stdout.Write($bytes, 0, $bytes.Length)
        $stdout.Flush()
        $written = $true
    } catch { $written = $false }
    if (-not $written) {
        try {
            [Console]::Out.Write($text)
            [Console]::Out.Flush()
        } catch { }
    }
}

function Write-Diag {
    param([string]$Message)
    try { [Console]::Error.WriteLine('[setup-protocol.ps1] ' + $Message) } catch { }
}

function Get-RegValue {
    param([string]$Path, [string]$Name)
    try {
        $item = Get-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction Stop
        if ($null -eq $item) { return $null }
        return $item.$Name
    }
    catch { return $null }
}

try {
    # ---- resolve handler path ----
    $pluginRoot = [string]$PSScriptRoot
    if ([string]::IsNullOrEmpty($pluginRoot)) {
        try { $pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path } catch { $pluginRoot = '' }
    }
    if ([string]::IsNullOrEmpty($HandlerPath)) {
        if ([string]::IsNullOrEmpty($pluginRoot)) { throw 'cannot resolve plugin directory; pass -HandlerPath' }
        $HandlerPath = Join-Path $pluginRoot 'notify-handler.ps1'
    }
    $handler = [System.IO.Path]::GetFullPath([string]$HandlerPath)
    if (-not (Test-Path -LiteralPath $handler -PathType Leaf)) {
        throw ('notify-handler.ps1 not found: ' + $handler)
    }

    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $psExe -PathType Leaf)) {
        throw ('Windows PowerShell 5.1 not found: ' + $psExe)
    }

    # ---- resolve DSH launch target ----
    $candidates = New-Object System.Collections.ArrayList
    if ($LaunchTarget) { [void]$candidates.Add([string]$LaunchTarget) }
    if ($env:LOCALAPPDATA) {
        [void]$candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'))
    }
    if ($env:ProgramFiles) {
        [void]$candidates.Add((Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe'))
    }
    $dshProcesses = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'DeepSeek Harness' })
    foreach ($p in $dshProcesses) {
        try { if ($p.Path) { [void]$candidates.Add([string]$p.Path) } } catch { }
    }
    $resolvedLaunch = $null
    foreach ($candidate in $candidates) {
        if (-not $candidate) { continue }
        try {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $resolvedLaunch = [System.IO.Path]::GetFullPath([string]$candidate)
                break
            }
        } catch { }
    }

    # ---- desired registry values ----
    $keyPath = 'HKCU:\Software\Classes\dsh-notify'
    $commandKeyPath = Join-Path $keyPath 'shell\open\command'
    $desiredDefault = 'URL:DeepSeek Harness Notification'
    $desiredCommand = '"' + $psExe + '" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $handler + '" "%1"'

    $currentDefault = Get-RegValue -Path $keyPath -Name '(default)'
    $currentUrlProtocol = Get-RegValue -Path $keyPath -Name 'URL Protocol'
    $currentCommand = Get-RegValue -Path $commandKeyPath -Name '(default)'
    $currentLaunch = Get-RegValue -Path $keyPath -Name 'dshLaunchTarget'

    $launchValue = $null
    if ($resolvedLaunch) { $launchValue = $resolvedLaunch }
    elseif ($currentLaunch -and (Test-Path -LiteralPath ([string]$currentLaunch) -PathType Leaf)) {
        $launchValue = [string]$currentLaunch
    }

    $changed = $false
    if ([string]$currentDefault -ne $desiredDefault) { $changed = $true }
    if ([string]$currentUrlProtocol -ne '') { $changed = $true }
    if ([string]$currentCommand -ne $desiredCommand) { $changed = $true }
    if ($launchValue -and ([string]$currentLaunch -ne $launchValue)) { $changed = $true }

    if ($changed) {
        New-Item -Path $keyPath -Force | Out-Null
        Set-Item -LiteralPath $keyPath -Value $desiredDefault
        New-ItemProperty -LiteralPath $keyPath -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
        if ($launchValue) {
            New-ItemProperty -LiteralPath $keyPath -Name 'dshLaunchTarget' -Value $launchValue -PropertyType String -Force | Out-Null
        }
        New-Item -Path $commandKeyPath -Force | Out-Null
        Set-Item -LiteralPath $commandKeyPath -Value $desiredCommand
    }

    # ---- verify by reading everything back ----
    $registeredDefault = [string](Get-RegValue -Path $keyPath -Name '(default)')
    $registeredUrlProtocol = [string](Get-RegValue -Path $keyPath -Name 'URL Protocol')
    $registeredCommand = [string](Get-RegValue -Path $commandKeyPath -Name '(default)')
    $registered = ($registeredDefault -eq $desiredDefault) -and
        ($registeredUrlProtocol -eq '') -and
        ($registeredCommand -eq $desiredCommand)

    $launchReport = $null
    if ($launchValue) { $launchReport = $launchValue }

    Write-Diag ('registered=' + $registered + ' changed=' + $changed + ' key=' + $keyPath)
    Write-JsonLine ([ordered]@{
            ok           = $true
            registered   = [bool]$registered
            changed      = [bool]$changed
            handler      = $handler
            launchTarget = $launchReport
            command      = $desiredCommand
        })
}
catch {
    Write-Diag ('failed: ' + $_.Exception.Message)
    Write-JsonLine ([ordered]@{
            ok         = $false
            registered = $false
            error      = [string]$_.Exception.Message
        })
}

exit 0
