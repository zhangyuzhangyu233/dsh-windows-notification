# dsh-windows-notification : toast.ps1
#
# Windows PowerShell 5.1 toast transport for the DeepSeek Harness plugin.
# Shows a pre-built toast XML under the DSH AppUserModelID (com.deepseek.dsh) and
# answers foreground queries. The XML is owned by the host (index.js); this script
# never rewrites it.
#
# Usage:
#   toast.ps1 -CheckOnly
#     stdout: {"ok":true,"foreground":false,"dshPid":30340}
#   toast.ps1 -XmlBase64 <utf8-xml-base64> [-Aumid com.deepseek.dsh] [-Tag <string>]
#             [-SkipWhenForeground] [-Priority default|high]
#     stdout: {"ok":true,"shown":true,"reason":"shown","foreground":false}
#   Every path prints exactly one JSON line on stdout and exits 0.
#   Diagnostics are written to stderr only (never stdout).
#
# Notes:
#   * -Priority high sets ToastNotification.Priority = High (Win11 priority
#     notifications can break through Do Not Disturb when the user allows DSH);
#     it is applied in try/catch and never prevents the toast from showing.
#   * -SkipWhenForeground re-uses the same foreground check as -CheckOnly.
#   * stdout is written as raw UTF-8 bytes so Chinese text in JSON survives even
#     though the console codepage of this machine is GB2312.

[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [string]$XmlBase64 = '',
    [string]$Aumid = 'com.deepseek.dsh',
    [string]$Tag = '',
    [switch]$SkipWhenForeground,
    [string]$Priority = 'default'
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
    try { [Console]::Error.WriteLine('[toast.ps1] ' + $Message) } catch { }
}

$script:NativeReady = $false
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshToastNative {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@
    $script:NativeReady = $true
}
catch { Write-Diag ('Add-Type failed: ' + $_.Exception.Message) }

function Get-DshForegroundInfo {
    $dshProcesses = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'DeepSeek Harness' })
    $dshPidSet = @{}
    foreach ($p in $dshProcesses) { $dshPidSet[[int]$p.Id] = $true }

    $foreground = $false
    $foregroundPid = 0
    if ($script:NativeReady) {
        try {
            $hwnd = [DshToastNative]::GetForegroundWindow()
            if ($hwnd -ne [IntPtr]::Zero) {
                $pidValue = [uint32]0
                [void][DshToastNative]::GetWindowThreadProcessId($hwnd, [ref]$pidValue)
                $foregroundPid = [int]$pidValue
                if ($foregroundPid -gt 0 -and $dshPidSet.ContainsKey($foregroundPid)) { $foreground = $true }
            }
        }
        catch { Write-Diag ('foreground check failed: ' + $_.Exception.Message) }
    }

    $dshPid = $null
    if ($foreground) { $dshPid = $foregroundPid }
    else {
        $withWindow = $dshProcesses | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($null -ne $withWindow) { $dshPid = [int]$withWindow.Id }
        elseif ($dshProcesses.Count -gt 0) { $dshPid = [int]$dshProcesses[0].Id }
    }

    [pscustomobject]@{
        Foreground = [bool]$foreground
        DshPid     = $dshPid
    }
}

$script:Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

try {
    if ($CheckOnly) {
        $info = Get-DshForegroundInfo
        Write-JsonLine ([ordered]@{
                ok         = $true
                foreground = [bool]$info.Foreground
                dshPid     = $info.DshPid
            })
        exit 0
    }

    # ---- validate arguments ----
    $priorityValue = ([string]$Priority).Trim().ToLowerInvariant()
    if ($priorityValue -notin @('default', 'high')) {
        throw ('invalid -Priority (expected default|high): ' + [string]$Priority)
    }

    $b64 = ([string]$XmlBase64) -replace '\s', ''
    if ([string]::IsNullOrEmpty($b64)) { throw 'missing -XmlBase64' }
    $xmlText = ''
    try { $xmlText = $script:Utf8.GetString([Convert]::FromBase64String($b64)) }
    catch { throw ('invalid -XmlBase64: ' + $_.Exception.Message) }
    if ([string]::IsNullOrWhiteSpace($xmlText)) { throw 'decoded toast XML is empty' }

    $aumidValue = ([string]$Aumid).Trim()
    if ([string]::IsNullOrEmpty($aumidValue)) { $aumidValue = 'com.deepseek.dsh' }
    $tagValue = ([string]$Tag).Trim()

    # ---- foreground check (also used by -SkipWhenForeground) ----
    $fg = Get-DshForegroundInfo
    if ($SkipWhenForeground -and $fg.Foreground) {
        Write-Diag 'skipped: DeepSeek Harness is foreground'
        Write-JsonLine ([ordered]@{
                ok         = $true
                shown      = $false
                reason     = 'foreground'
                foreground = $true
            })
        exit 0
    }

    # ---- show the toast ----
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

    $xmlDoc = New-Object -TypeName Windows.Data.Xml.Dom.XmlDocument
    $xmlDoc.LoadXml($xmlText)

    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumidValue)
    $toast = New-Object -TypeName Windows.UI.Notifications.ToastNotification -ArgumentList $xmlDoc

    $tagApplied = $false
    if ($tagValue) {
        try {
            $tagClipped = $tagValue
            if ($tagClipped.Length -gt 64) { $tagClipped = $tagClipped.Substring(0, 64) }
            $toast.Tag = $tagClipped
            $tagApplied = $true
        }
        catch { Write-Diag ('tag not applied: ' + $_.Exception.Message) }
    }

    $priorityApplied = $false
    if ($priorityValue -eq 'high') {
        try {
            $toast.Priority = [Windows.UI.Notifications.ToastNotificationPriority]::High
            $priorityApplied = $true
        }
        catch { Write-Diag ('priority high not applied: ' + $_.Exception.Message) }
    }

    $notifier.Show($toast)

    Write-Diag ('shown aumid=' + $aumidValue + ' tag=' + $tagValue + ' tagApplied=' + $tagApplied +
        ' priority=' + $priorityValue + ' priorityApplied=' + $priorityApplied +
        ' foreground=' + $fg.Foreground + ' elapsedMs=' + $script:Stopwatch.ElapsedMilliseconds)
    Write-JsonLine ([ordered]@{
            ok         = $true
            shown      = $true
            reason     = 'shown'
            foreground = [bool]$fg.Foreground
        })
}
catch {
    Write-Diag ('failed: ' + $_.Exception.Message)
    Write-JsonLine ([ordered]@{
            ok    = $false
            error = [string]$_.Exception.Message
        })
}

exit 0
