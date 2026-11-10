@echo off
setlocal
rem Open the team panel as a standalone Edge/Chrome app window.
rem Without --workspace the CLI uses this project, or the newest live daemon
rem when launched from a folder without team state.
node "%~dp0src\cli.mjs" panel --window %*
if errorlevel 1 pause
