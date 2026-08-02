@echo off
cd /d "%~dp0"

rem Check if running inside Windows Terminal
if "%WT_SESSION%"=="" (
    rem Not in Windows Terminal: launch a new WT window running the agent
    powershell -NoProfile -Command "$d = '%~dp0'; Start-Process wt.exe -ArgumentList ('cmd','/c','\"' + $d + 'ts-agent-run.bat\"')"
    exit /b 0
)

rem Already in Windows Terminal: run directly
call "%~dp0ts-agent-run.bat"
