' Launch the AgentTeams daemon supervisor without any console window.
'
' Why this exists: the logon scheduled task used to run node.exe directly. node is a
' console-subsystem binary, so Task Scheduler handed it a console and Windows 11's
' default terminal (Windows Terminal) opened a visible window titled
' "C:\Program Files\nodejs\node.exe" on every logon.
'
' wscript.exe is a GUI-subsystem host, and Run(..., 0, ...) starts node with a hidden
' console, so the supervisor keeps running with no window at all.
'
' Paths are derived at runtime from this script's own location so the file stays
' pure ASCII and works regardless of where the project lives.

Option Explicit

Dim fso, sh, scriptDir, project, nodeExe, supervisor, command

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
project = fso.GetParentFolderName(scriptDir)
nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
supervisor = fso.BuildPath(scriptDir, "daemon-supervisor.mjs")

If Not fso.FileExists(nodeExe) Then
  WScript.Quit 1
End If
If Not fso.FileExists(supervisor) Then
  WScript.Quit 1
End If

command = """" & nodeExe & """ """ & supervisor & """"
sh.CurrentDirectory = project
sh.Run command, 0, False
