# dsh-windows-notification : notify-handler.ps1
#
# Protocol activation handler for dsh-notify:// URIs. Windows launches this script
# (see setup-protocol.ps1 for the registered command) when the user clicks a toast
# button, a toast body, or a toast text-input submit button:
#
#   v1.0 approval / navigation
#     dsh-notify://open?session=<id>
#     dsh-notify://decision?action=approve&approval=<id>&session=<id>
#     dsh-notify://decision?action=deny&approval=<id>&session=<id>
#   v1.1 user questions
#     dsh-notify://question?action=option&question=<qtoken>&choice=<index>&session=<sid>&focus=0
#     dsh-notify://question?action=text&question=<qtoken>&session=<sid>&focus=0  (+ "&reply=<text>")
#     dsh-notify://question?action=open&question=<qtoken>&session=<sid>
#   v1.1 demo notifications
#     dsh-notify://demo?kind=question-options&choice=<index>&focus=0
#     dsh-notify://demo?kind=approval&decision=approve|deny&focus=0
#     dsh-notify://demo?kind=question-text&focus=0
#
# Steps:
#   1. parse the URI (tolerates quotes, URI-encoded values, extra query params, the
#      Windows-normalized "dsh-notify://question/?..." form and appended input values);
#   2. POST {token, action, sessionId, approvalId, questionId, choice, text, kind[, decision]}
#      to the host bridge described by %LOCALAPPDATA%\dsh-windows-notification\bridge.json
#      (2.5 s timeout, missing or stale file tolerated - the notification platform is
#      never blocked);
#   3. bring the DeepSeek Harness window forward (restore if minimized) or launch the
#      executable stored by setup-protocol.ps1 - but not when the URI says focus=0
#      (answers and demo clicks stay in the background);
#   4. append one bounded line to %LOCALAPPDATA%\dsh-windows-notification\handler.log
#      (the bridge token and the full input text are never logged) and exit 0.
#      No dialogs, no visible console (the registered command uses -WindowStyle Hidden),
#      never blocks for more than ~3 s.
#
# Action mapping: option -> answer (choice), text/submit -> answer (text),
# approve/deny -> approve/deny, open -> open, demo -> demo; anything unknown focuses
# DSH only (action "open") and never errors.
#
# Focus policy: focus=0/false/no/off never steals focus; focus=1/true/yes/on forces it.
# "open" always focuses; answers/demos only focus when forced; approve/deny keep the
# v1.0 behaviour (focus).
#
# Test-only override (never passed by Windows): -BridgeFile <path> reads a different
# bridge descriptor, so the fake-bridge harness never touches the live bridge.json.
# stdout: one JSON line with the outcome (input text is clipped to 60 chars);
# diagnostics live in handler.log.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ConfirmPreference = 'None'

$script:Utf8 = [System.Text.UTF8Encoding]::new($false)
try { [Console]::OutputEncoding = $script:Utf8 } catch { }

$script:StateDir = Join-Path $env:LOCALAPPDATA 'dsh-windows-notification'
$script:LogPath = Join-Path $script:StateDir 'handler.log'
$script:BridgeFile = Join-Path $script:StateDir 'bridge.json'
$script:MaxLogBytes = 65536
$script:KeepLogBytes = 32768
$script:MaxBridgeTextChars = 1000   # keep the bridge JSON body under the host's 4 KB cap
$script:MaxLoggedTextChars = 60     # never log the full user input
$script:Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

function Write-JsonLine {
    param([object]$Value)
    $json = $null
    try { $json = ($Value | ConvertTo-Json -Compress -Depth 8) }
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

function Write-HandlerLog {
    param([string]$Category, [string]$Message)
    try {
        if (-not (Test-Path -LiteralPath $script:StateDir)) {
            New-Item -ItemType Directory -Force -Path $script:StateDir | Out-Null
        }
        $safeMessage = ([string]$Message) -replace "`r", ' ' -replace "`n", ' '
        $line = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffzzz') + ' [' + $Category + '] ' + $safeMessage
        [System.IO.File]::AppendAllText($script:LogPath, $line + "`n", $script:Utf8)
        $fi = New-Object System.IO.FileInfo($script:LogPath)
        if ($fi.Length -gt $script:MaxLogBytes) {
            $all = [System.IO.File]::ReadAllText($script:LogPath, [System.Text.Encoding]::UTF8)
            if ($all.Length -gt $script:KeepLogBytes) {
                $all = $all.Substring($all.Length - $script:KeepLogBytes)
            }
            [System.IO.File]::WriteAllText($script:LogPath, $all, $script:Utf8)
        }
    }
    catch { }
}

function ConvertTo-LogSafe {
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    return (([string]$Text) -replace "`r", ' ' -replace "`n", ' ')
}

function ConvertTo-LogUri {
    # Redact toast text-input values (reply/text/input/answer) and clip long URIs so
    # the log never contains the full user input.
    param([string]$Uri)
    if ($null -eq $Uri) { return '' }
    $text = [string]$Uri
    $pattern = '(?i)([?&](?:reply|text|input|answer)=)([^&#]*)'
    $builder = New-Object System.Text.StringBuilder
    $lastIndex = 0
    foreach ($match in [regex]::Matches($text, $pattern)) {
        [void]$builder.Append($text.Substring($lastIndex, $match.Index - $lastIndex))
        [void]$builder.Append($match.Groups[1].Value + '<redacted:' + $match.Groups[2].Value.Length + '>')
        $lastIndex = $match.Index + $match.Length
    }
    [void]$builder.Append($text.Substring($lastIndex))
    $redacted = $builder.ToString()
    if ($redacted.Length -gt 300) { $redacted = $redacted.Substring(0, 300) + '...' }
    return $redacted
}

function Get-DshTextSummary {
    # Safe summary of user input for the log/JSON line: never the full text.
    param([string]$Text)
    $length = 0
    $snippet = ''
    if (-not [string]::IsNullOrEmpty($Text)) {
        $length = $Text.Length
        $snippet = ConvertTo-LogSafe $Text
        if ($snippet.Length -gt $script:MaxLoggedTextChars) {
            $snippet = $snippet.Substring(0, $script:MaxLoggedTextChars) + '...'
        }
    }
    return [pscustomobject]@{ Length = $length; Snippet = $snippet }
}

function Get-DshQueryValue {
    param([hashtable]$Query, [string[]]$Names)
    foreach ($name in $Names) {
        if ($Query.ContainsKey($name)) {
            $value = [string]$Query[$name]
            if (-not [string]::IsNullOrEmpty($value)) { return $value }
        }
    }
    return $null
}

# ---------------------------------------------------------------------------
# native helpers
# ---------------------------------------------------------------------------

$script:NativeReady = $false
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshHandlerNative {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fUnknown);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
}
'@
    $script:NativeReady = $true
}
catch { Write-HandlerLog 'warn' ('Add-Type failed: ' + $_.Exception.Message) }

function Get-DshProcesses {
    return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'DeepSeek Harness' })
}

function Get-ForegroundPid {
    if (-not $script:NativeReady) { return 0 }
    try {
        $hwnd = [DshHandlerNative]::GetForegroundWindow()
        if ($hwnd -eq [IntPtr]::Zero) { return 0 }
        $pidValue = [uint32]0
        [void][DshHandlerNative]::GetWindowThreadProcessId($hwnd, [ref]$pidValue)
        return [int]$pidValue
    }
    catch { return 0 }
}

function Get-DshLaunchTarget {
    $keyPath = 'HKCU:\Software\Classes\dsh-notify'
    try {
        $value = (Get-ItemProperty -LiteralPath $keyPath -Name 'dshLaunchTarget' -ErrorAction Stop).dshLaunchTarget
        if ($value -and (Test-Path -LiteralPath ([string]$value) -PathType Leaf)) { return [string]$value }
    }
    catch { }
    $candidates = @()
    if ($env:LOCALAPPDATA) {
        $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe')
    }
    if ($env:ProgramFiles) {
        $candidates += (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe')
    }
    foreach ($candidate in $candidates) {
        try {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [string]$candidate }
        } catch { }
    }
    foreach ($p in Get-DshProcesses) {
        try {
            if ($p.Path -and (Test-Path -LiteralPath $p.Path -PathType Leaf)) { return [string]$p.Path }
        } catch { }
    }
    return $null
}

function Find-DshWindow {
    param([object[]]$Processes)
    $byMainWindow = $Processes | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($null -ne $byMainWindow) { return [IntPtr]$byMainWindow.MainWindowHandle }
    if (-not $script:NativeReady) { return [IntPtr]::Zero }

    # fallback: enumerate top-level windows belonging to any DSH process
    $script:EnumDshPids = @{}
    foreach ($p in $Processes) { $script:EnumDshPids[[int]$p.Id] = $true }
    $script:EnumDshHwnd = [IntPtr]::Zero
    $callback = [DshHandlerNative+EnumWindowsProc] {
        param([IntPtr]$hWnd, [IntPtr]$lParam)
        try {
            if ([DshHandlerNative]::IsWindowVisible($hWnd)) {
                $windowPid = [uint32]0
                [void][DshHandlerNative]::GetWindowThreadProcessId($hWnd, [ref]$windowPid)
                if ($script:EnumDshPids.ContainsKey([int]$windowPid)) {
                    $script:EnumDshHwnd = $hWnd
                    return $false
                }
            }
        }
        catch { }
        return $true
    }
    [void][DshHandlerNative]::EnumWindows($callback, [IntPtr]::Zero)
    return [IntPtr]$script:EnumDshHwnd
}

function Set-DshWindowForeground {
    param([IntPtr]$Hwnd, [object[]]$Processes)
    $detail = [ordered]@{ hwnd = [int64]$Hwnd; focused = $false; reason = 'focus-attempted'; strategy = '' }
    if ($Hwnd -eq [IntPtr]::Zero) { $detail.reason = 'no-window'; return $detail }

    $pidSet = @{}
    foreach ($p in $Processes) { $pidSet[[int]$p.Id] = $true }
    if ($pidSet.ContainsKey((Get-ForegroundPid))) {
        # A minimized window can still be reported as the foreground window; restore it.
        $needsRestore = $false
        try { $needsRestore = [DshHandlerNative]::IsIconic($Hwnd) } catch { }
        if (-not $needsRestore) {
            $detail.focused = $true
            $detail.reason = 'already-foreground'
            return $detail
        }
    }

    # The DSH window may be behind another app; Windows foreground lock needs one of
    # several activation tricks. Try them in a cheap-to-expensive order and verify.
    # Keep the whole activation block inside the handler's ~3 s budget: if the bridge
    # call already used its 2.5 s timeout, fall back to a single quick attempt.
    $strategies = @('attach', 'switch', 'restore', 'alt', 'attach-retry')
    $strategyIndex = 0
    foreach ($strategy in $strategies) {
        # always run the first (cheap) attempt; bound the rest by the handler time budget
        if ($strategyIndex -gt 0 -and $script:Stopwatch.ElapsedMilliseconds -gt 2600) { break }
        $strategyIndex++
        try {
            switch ($strategy) {
                'attach' {
                    if ([DshHandlerNative]::IsIconic($Hwnd)) { [void][DshHandlerNative]::ShowWindow($Hwnd, 9) }  # SW_RESTORE
                    [void][DshHandlerNative]::ShowWindow($Hwnd, 5)                                             # SW_SHOW
                    [void][DshHandlerNative]::BringWindowToTop($Hwnd)
                    # SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW
                    [void][DshHandlerNative]::SetWindowPos($Hwnd, [IntPtr]::Zero, 0, 0, 0, 0, 0x0043)

                    # Windows foreground lock: attach to the foreground thread before SetForegroundWindow
                    $foregroundHwnd = [DshHandlerNative]::GetForegroundWindow()
                    $foregroundThread = 0
                    if ($foregroundHwnd -ne [IntPtr]::Zero) {
                        $foregroundPidValue = [uint32]0
                        $foregroundThread = [int][DshHandlerNative]::GetWindowThreadProcessId($foregroundHwnd, [ref]$foregroundPidValue)
                    }
                    $currentThread = [int][DshHandlerNative]::GetCurrentThreadId()
                    $attached = $false
                    if ($foregroundThread -gt 0 -and $foregroundThread -ne $currentThread) {
                        $attached = [DshHandlerNative]::AttachThreadInput([uint32]$currentThread, [uint32]$foregroundThread, $true)
                    }
                    try { [void][DshHandlerNative]::SetForegroundWindow($Hwnd) }
                    finally {
                        if ($attached) {
                            [void][DshHandlerNative]::AttachThreadInput([uint32]$currentThread, [uint32]$foregroundThread, $false)
                        }
                    }
                }
                'switch' {
                    if ([DshHandlerNative]::IsIconic($Hwnd)) { [void][DshHandlerNative]::ShowWindow($Hwnd, 9) }
                    [void][DshHandlerNative]::ShowWindow($Hwnd, 5)
                    [DshHandlerNative]::SwitchToThisWindow($Hwnd, $true)
                }
                'restore' {
                    [void][DshHandlerNative]::ShowWindow($Hwnd, 6)  # SW_MINIMIZE
                    Start-Sleep -Milliseconds 150
                    [void][DshHandlerNative]::ShowWindow($Hwnd, 9)  # SW_RESTORE
                    [void][DshHandlerNative]::SetForegroundWindow($Hwnd)
                }
                'alt' {
                    [void][DshHandlerNative]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)  # ALT down
                    Start-Sleep -Milliseconds 60
                    [void][DshHandlerNative]::SetForegroundWindow($Hwnd)
                    [void][DshHandlerNative]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)  # ALT up
                }
                'attach-retry' {
                    Start-Sleep -Milliseconds 150
                    [void][DshHandlerNative]::SetForegroundWindow($Hwnd)
                }
            }
        }
        catch { }
        Start-Sleep -Milliseconds 130
        if ($pidSet.ContainsKey((Get-ForegroundPid))) {
            $detail.focused = $true
            $detail.strategy = $strategy
            $detail.reason = 'focused-via-' + $strategy
            break
        }
    }
    if (-not $detail.focused) { $detail.reason = 'focus-failed' }
    return $detail
}

function Focus-DshWindow {
    $processes = Get-DshProcesses
    $result = [ordered]@{
        running  = [bool]($processes.Count -gt 0)
        launched = $false
        focused  = $false
        hwnd     = 0
        reason   = 'not-running'
    }

    if ($processes.Count -eq 0) {
        $target = Get-DshLaunchTarget
        if (-not $target) { $result.reason = 'not-running-no-launch-target'; return $result }
        try {
            Start-Process -FilePath $target | Out-Null
            $result.launched = $true
            $result.reason = 'launched'
        }
        catch { $result.reason = 'launch-failed: ' + $_.Exception.Message }
        return $result
    }

    $hwnd = Find-DshWindow -Processes $processes
    if ($hwnd -eq [IntPtr]::Zero) {
        $target = Get-DshLaunchTarget
        if ($target) {
            try {
                Start-Process -FilePath $target | Out-Null
                $result.launched = $true
                $result.reason = 'running-but-no-window-launched'
                return $result
            }
            catch { }
        }
        $result.reason = 'running-but-no-window'
        return $result
    }

    $result.hwnd = [int64]$hwnd
    $detail = Set-DshWindowForeground -Hwnd $hwnd -Processes $processes
    $result.focused = [bool]$detail.focused
    $result.strategy = [string]$detail.strategy
    $result.reason = [string]$detail.reason
    return $result
}

# ---------------------------------------------------------------------------
# URI parsing
# ---------------------------------------------------------------------------

function ConvertFrom-DshNotifyUri {
    param([string]$Raw)
    $result = [ordered]@{
        ok         = $false
        raw        = $Raw
        action     = 'open'
        sessionId  = $null
        approvalId = $null
        questionId = $null
        choice     = $null
        text       = $null
        kind       = $null
        decision   = $null
        focusMode  = 'auto'
        focus      = $true
        warning    = $null
        error      = $null
    }
    if ([string]::IsNullOrWhiteSpace($Raw)) {
        $result.error = 'empty uri'
        return $result
    }

    $text = ([string]$Raw).Trim()
    $text = $text -replace '^["'']+', '' -replace '["'']+$', ''
    $text = $text.Trim()

    $match = [regex]::Match($text, '^(?i)dsh-notify:(?://+)?(?<rest>[^#]*)(?:#.*)?$')
    if (-not $match.Success) {
        $result.error = 'invalid dsh-notify uri'
        return $result
    }

    $rest = $match.Groups['rest'].Value
    $pathPart = $rest
    $queryPart = ''
    $questionIndex = $rest.IndexOf('?')
    if ($questionIndex -ge 0) {
        $pathPart = $rest.Substring(0, $questionIndex)
        $queryPart = $rest.Substring($questionIndex + 1)
    }
    $pathPart = $pathPart.Trim('/')
    $segments = @($pathPart -split '/' | Where-Object { $_ -ne '' })
    $segment = ''
    if ($segments.Count -gt 0) { $segment = ([string]$segments[0]).Trim().ToLowerInvariant() }

    $query = @{}
    if ($queryPart) {
        foreach ($pair in ($queryPart -split '&')) {
            if ([string]::IsNullOrEmpty($pair)) { continue }
            $equalsIndex = $pair.IndexOf('=')
            if ($equalsIndex -lt 0) { $name = $pair; $value = '' }
            else { $name = $pair.Substring(0, $equalsIndex); $value = $pair.Substring($equalsIndex + 1) }
            try {
                $name = [System.Uri]::UnescapeDataString($name)
                $value = [System.Uri]::UnescapeDataString($value)
            }
            catch { }
            if (-not [string]::IsNullOrEmpty($name)) { $query[$name] = $value }
        }
    }

    # ---- shared fields (v1.1 additions included) ----
    $result.sessionId = Get-DshQueryValue -Query $query -Names @('session', 'sessionId', 'session_id')
    $result.approvalId = Get-DshQueryValue -Query $query -Names @('approval', 'approvalId', 'approval_id')
    $result.questionId = Get-DshQueryValue -Query $query -Names @('question', 'qid', 'questionId', 'question_id')
    $result.choice = Get-DshQueryValue -Query $query -Names @('choice', 'index')
    # Windows may append the toast text-input value to the URI under the input id
    # (the host uses "reply"); accept the common aliases as well.
    $result.text = Get-DshQueryValue -Query $query -Names @('reply', 'text', 'input', 'answer')
    $result.kind = Get-DshQueryValue -Query $query -Names @('kind')
    $result.decision = Get-DshQueryValue -Query $query -Names @('decision')

    # ---- focus policy: 0/false/no/off never steals focus, 1/true/yes/on forces it ----
    $focusValue = Get-DshQueryValue -Query $query -Names @('focus')
    if ($focusValue) {
        $focusKey = $focusValue.Trim().ToLowerInvariant()
        if (@('0', 'false', 'no', 'off') -contains $focusKey) { $result.focusMode = 'never' }
        elseif (@('1', 'true', 'yes', 'on') -contains $focusKey) { $result.focusMode = 'force' }
    }
    $result.focus = ($result.focusMode -ne 'never')

    # ---- action mapping ----
    $actionMap = @{
        'approve'      = 'approve'
        'allow'        = 'approve'
        'allow-once'   = 'approve'
        'allowed-once' = 'approve'
        'deny'         = 'deny'
        'reject'       = 'deny'
        'rejected'     = 'deny'
        'open'         = 'open'
        'focus'        = 'open'
        'show'         = 'open'
    }

    if ($segment -eq 'demo') {
        # every dsh-notify://demo... click is one bridge "demo" action; kind/choice/decision
        # tell the host which sample was exercised
        $result.action = 'demo'
    }
    else {
        $rawAction = $null
        if ($segment -eq 'decision') {
            $rawAction = Get-DshQueryValue -Query $query -Names @('action', 'decision')
        }
        else {
            $rawAction = Get-DshQueryValue -Query $query -Names @('action')
        }
        $actionKey = ''
        if ($rawAction) { $actionKey = $rawAction.Trim().ToLowerInvariant() }

        if (@('option', 'choice') -contains $actionKey) {
            # a question answered by picking one of its options
            if ($result.choice) {
                $result.action = 'answer'
            }
            else {
                $result.action = 'open'
                $result.warning = 'option action without a choice; focusing DSH instead'
            }
        }
        elseif (@('text', 'submit', 'input') -contains $actionKey) {
            # a question answered from the toast text input (text may be absent)
            $result.action = 'answer'
        }
        elseif ($actionMap.ContainsKey($actionKey)) {
            $result.action = $actionMap[$actionKey]
        }
        elseif ($segment -eq 'question') {
            $result.action = 'open'
            if ($actionKey) { $result.warning = 'unknown question action "' + $actionKey + '"; focusing DSH only' }
        }
        elseif ($segment -eq 'decision') {
            $result.action = 'open'
            $result.warning = 'decision uri without a valid action; focusing DSH only'
        }
        else {
            $result.action = 'open'
            if ($actionKey) { $result.warning = 'unknown action "' + $actionKey + '"; focusing DSH only' }
        }
    }

    $result.ok = $true
    return $result
}

# ---------------------------------------------------------------------------
# host bridge call
# ---------------------------------------------------------------------------

function Invoke-DshBridgeAction {
    param(
        [string]$Action,
        [string]$SessionId,
        [string]$ApprovalId,
        [string]$QuestionId,
        [string]$Choice,
        [string]$Text,
        [string]$Kind,
        [string]$Decision
    )
    $result = [ordered]@{ attempted = $false; ok = $false; status = 0; error = $null }
    $bridgeFile = $script:BridgeFile

    if (-not (Test-Path -LiteralPath $bridgeFile -PathType Leaf)) {
        $result.error = 'bridge.json missing'
        return $result
    }
    try { $rawConfig = [System.IO.File]::ReadAllText($bridgeFile, [System.Text.Encoding]::UTF8) }
    catch {
        $result.error = 'bridge.json unreadable: ' + $_.Exception.Message
        return $result
    }
    try { $config = $rawConfig | ConvertFrom-Json }
    catch {
        $result.error = 'bridge.json invalid: ' + $_.Exception.Message
        return $result
    }

    $port = 0
    try { [void][int]::TryParse([string]$config.port, [ref]$port) } catch { }
    $token = [string]$config.token
    if ($port -le 0 -or $port -gt 65535) { $result.error = 'bridge.json has no valid port'; return $result }
    if ([string]::IsNullOrEmpty($token)) { $result.error = 'bridge.json has no token'; return $result }

    # Keep the bridge JSON body under the host's 4 KB cap even for long text answers.
    $textValue = $Text
    if (-not [string]::IsNullOrEmpty($textValue) -and $textValue.Length -gt $script:MaxBridgeTextChars) {
        $textValue = $textValue.Substring(0, $script:MaxBridgeTextChars)
    }
    $payloadObject = [ordered]@{
        token      = $token
        action     = $Action
        sessionId  = $SessionId
        approvalId = $ApprovalId
        questionId = $QuestionId
        choice     = $Choice
        text       = $textValue
        kind       = $Kind
    }
    # demo URIs carry approve|deny for the approval sample; additive field, ignored elsewhere
    if (-not [string]::IsNullOrEmpty($Decision)) { $payloadObject['decision'] = $Decision }
    $payload = $payloadObject | ConvertTo-Json -Compress
    $bytes = $script:Utf8.GetBytes($payload)

    $request = $null
    $response = $null
    $result.attempted = $true
    try {
        $request = [System.Net.HttpWebRequest]::Create('http://127.0.0.1:' + $port + '/action')
        $request.Method = 'POST'
        $request.ContentType = 'application/json; charset=utf-8'
        $request.Accept = 'application/json'
        # 2.5 s request budget (contract) + no Expect:100-continue wait => handler stays ~3 s worst case
        $request.Timeout = 2500
        $request.ReadWriteTimeout = 2500
        $request.KeepAlive = $false
        $request.Proxy = $null
        try { $request.ServicePoint.Expect100Continue = $false } catch { }
        $request.ContentLength = $bytes.Length
        $stream = $request.GetRequestStream()
        try { $stream.Write($bytes, 0, $bytes.Length) }
        finally { $stream.Dispose() }

        $response = $request.GetResponse()
        $result.status = [int]$response.StatusCode
        $result.ok = ($result.status -ge 200 -and $result.status -lt 400)
        try {
            $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [System.Text.Encoding]::UTF8)
            try { [void]$reader.ReadToEnd() } finally { $reader.Dispose() }
        }
        catch { }
    }
    catch [System.Net.WebException] {
        $webException = $_.Exception
        $result.ok = $false
        if ($webException.Response) {
            try {
                $result.status = [int]$webException.Response.StatusCode
                $reader = New-Object System.IO.StreamReader($webException.Response.GetResponseStream(), [System.Text.Encoding]::UTF8)
                try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
                $result.error = 'HTTP ' + $result.status + ': ' + $body
            }
            catch { $result.error = 'HTTP error from bridge' }
        }
        else { $result.error = $webException.Message }
    }
    catch {
        $result.ok = $false
        $result.error = $_.Exception.Message
    }
    finally {
        if ($response) { try { $response.Dispose() } catch { } }
        if ($request) { try { $request.Abort() } catch { } }
    }

    if ($result.error) {
        $errorText = [string]$result.error
        if ($errorText.Length -gt 300) { $result.error = $errorText.Substring(0, 300) }
        else { $result.error = $errorText }
    }
    return $result
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

try {
    # Positional URI plus the optional test-only -BridgeFile override (never used by
    # the Windows-registered command, which only passes the URI).
    $rawUri = ''
    $bridgeOverride = ''
    $argumentList = @($args)
    $argumentIndex = 0
    while ($argumentIndex -lt $argumentList.Count) {
        $argument = [string]$argumentList[$argumentIndex]
        if ($argument -eq '-BridgeFile' -and ($argumentIndex + 1) -lt $argumentList.Count) {
            $bridgeOverride = [string]$argumentList[$argumentIndex + 1]
            $argumentIndex += 2
            continue
        }
        if ($argument -like '-BridgeFile=*') {
            $bridgeOverride = $argument.Substring($argument.IndexOf('=') + 1)
            $argumentIndex += 1
            continue
        }
        if ([string]::IsNullOrEmpty($rawUri) -and -not $argument.StartsWith('-')) { $rawUri = $argument }
        $argumentIndex += 1
    }
    if (-not [string]::IsNullOrEmpty($bridgeOverride)) {
        try { $script:BridgeFile = [System.IO.Path]::GetFullPath($bridgeOverride) } catch { }
    }

    $logUri = ConvertTo-LogUri $rawUri
    Write-HandlerLog 'start' ('uri="' + $logUri + '" argc=' + $argumentList.Count)

    $parsed = ConvertFrom-DshNotifyUri -Raw $rawUri
    if (-not $parsed.ok) {
        Write-HandlerLog 'error' ('invalid activation: ' + $parsed.error + ' uri="' + $logUri + '"')
        Write-JsonLine ([ordered]@{
                ok        = $false
                uri       = $logUri
                error     = $parsed.error
                elapsedMs = $script:Stopwatch.ElapsedMilliseconds
            })
        exit 0
    }
    if ($parsed.warning) { Write-HandlerLog 'warn' ([string]$parsed.warning) }

    $bridgeArguments = @{
        Action     = $parsed.action
        SessionId  = $parsed.sessionId
        ApprovalId = $parsed.approvalId
        QuestionId = $parsed.questionId
        Choice     = $parsed.choice
        Text       = $parsed.text
        Kind       = $parsed.kind
        Decision   = $parsed.decision
    }
    $bridge = Invoke-DshBridgeAction @bridgeArguments

    # Focus policy (v1.1): open always focuses; answers and demo clicks stay in the
    # background unless the URI forces focus=1; approve/deny keep the v1.0 behaviour.
    switch ($parsed.action) {
        'open' { $shouldFocus = $true }
        'answer' { $shouldFocus = ($parsed.focusMode -eq 'force') }
        'demo' { $shouldFocus = ($parsed.focusMode -eq 'force') }
        default { $shouldFocus = ($parsed.focusMode -ne 'never') }
    }
    $focusResult = $null
    if ($shouldFocus) {
        $focusResult = Focus-DshWindow
    }
    else {
        $focusResult = [ordered]@{
            running  = $null
            launched = $false
            focused  = $false
            hwnd     = 0
            reason   = 'skipped-by-uri'
            strategy = ''
        }
    }

    $textSummary = Get-DshTextSummary $parsed.text
    $bridgeSummary = if ($bridge.attempted) { 'ok=' + $bridge.ok + ':status=' + $bridge.status } else { 'not-attempted:' + $bridge.error }
    $focusSummary = $focusResult.reason
    if ($focusResult.focused) { $focusSummary = 'focused' }
    Write-HandlerLog 'handled' ('action=' + $parsed.action +
        ' session=' + (ConvertTo-LogSafe $parsed.sessionId) +
        ' approval=' + (ConvertTo-LogSafe $parsed.approvalId) +
        ' question=' + (ConvertTo-LogSafe $parsed.questionId) +
        ' choice=' + (ConvertTo-LogSafe $parsed.choice) +
        ' kind=' + (ConvertTo-LogSafe $parsed.kind) +
        ' decision=' + (ConvertTo-LogSafe $parsed.decision) +
        ' textLen=' + $textSummary.Length +
        ' text="' + $textSummary.Snippet + '"' +
        ' bridge=' + $bridgeSummary +
        ' focus=' + $focusSummary +
        ' hwnd=' + $focusResult.hwnd +
        ' elapsedMs=' + $script:Stopwatch.ElapsedMilliseconds)

    Write-JsonLine ([ordered]@{
            ok         = $true
            action     = $parsed.action
            sessionId  = $parsed.sessionId
            approvalId = $parsed.approvalId
            questionId = $parsed.questionId
            choice     = $parsed.choice
            kind       = $parsed.kind
            decision   = $parsed.decision
            text       = $textSummary.Snippet
            textLength = $textSummary.Length
            focusMode  = $parsed.focusMode
            bridge     = $bridge
            focus      = $focusResult
            elapsedMs  = $script:Stopwatch.ElapsedMilliseconds
        })
}
catch {
    try { Write-HandlerLog 'error' ('unhandled: ' + $_.Exception.Message) } catch { }
    Write-JsonLine ([ordered]@{
            ok        = $false
            error     = [string]$_.Exception.Message
            elapsedMs = $script:Stopwatch.ElapsedMilliseconds
        })
}

exit 0
