' Run a console program with no visible console window.
'
' wscript.exe is a GUI-subsystem host. Run(..., 0, False) starts the target
' with a hidden console, so node.exe (a console-subsystem binary) never shows
' the black window that the scheduled task used to open at logon.
'
' Usage:
'   wscript.exe run-hidden.vbs "C:\Program Files\nodejs\node.exe" script.mjs args...

Option Explicit

Dim sh, cmd, i
Set sh = CreateObject("WScript.Shell")

If WScript.Arguments.Count = 0 Then
  WScript.Quit 1
End If

cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  cmd = cmd & """" & WScript.Arguments(i) & """ "
Next

sh.Run cmd, 0, False
