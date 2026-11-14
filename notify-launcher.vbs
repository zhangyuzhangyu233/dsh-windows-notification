' GUI-subsystem protocol launcher: avoid creating a visible PowerShell console.
' Called by the dsh-notify protocol registration in setup-protocol.ps1.
Option Explicit

Dim shell, fso, powershellExe, handlerPath, activationUri, commandLine
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count = 0 Then WScript.Quit 0

powershellExe = shell.ExpandEnvironmentStrings("%SystemRoot%") & _
    "\System32\WindowsPowerShell\v1.0\powershell.exe"
handlerPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "notify-handler.ps1")
activationUri = WScript.Arguments(0)

commandLine = QuoteWindowsArgument(powershellExe) & _
    " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & _
    QuoteWindowsArgument(handlerPath) & " " & QuoteWindowsArgument(activationUri)

' Window style 0 is hidden; do not wait so protocol activation returns immediately.
shell.Run commandLine, 0, False

Function QuoteWindowsArgument(value)
    ' Quote one argument using Windows command-line backslash/quote rules.
    Dim result, slashCount, character, index, quote
    value = CStr(value)
    quote = Chr(34)
    result = quote
    slashCount = 0

    For index = 1 To Len(value)
        character = Mid(value, index, 1)
        If character = "\" Then
            slashCount = slashCount + 1
        ElseIf character = quote Then
            result = result & String((slashCount * 2) + 1, "\") & quote
            slashCount = 0
        Else
            If slashCount > 0 Then result = result & String(slashCount, "\")
            result = result & character
            slashCount = 0
        End If
    Next

    If slashCount > 0 Then result = result & String(slashCount * 2, "\")
    QuoteWindowsArgument = result & quote
End Function
