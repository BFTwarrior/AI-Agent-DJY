# Register the daemon supervisor to start at user logon.
# Run once from an elevated or normal PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\register-daemon-task.ps1
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$launcher = Join-Path $PSScriptRoot 'daemon-supervisor-hidden.vbs'
# Launch via the VBS wrapper (wscript is a GUI host) so the logon task never
# opens a visible console window for the console-subsystem node.exe.
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$launcher`"" -WorkingDirectory $project
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'AI Agent Teams Daemon' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
$task = Get-ScheduledTask -TaskName 'AI Agent Teams Daemon'
Write-Host "registered $($task.TaskName) state=$($task.State) launcher=$launcher"
