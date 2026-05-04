@echo off
setlocal

set SCRIPT_DIR=%~dp0
set PS1_FILE=%SCRIPT_DIR%run-local.ps1

powershell -ExecutionPolicy Bypass -File "%PS1_FILE%" %*

endlocal
