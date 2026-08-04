@echo off
cd /d "%~dp0"

rem Check if running inside Windows Terminal
if "%WT_SESSION%"=="" (
    rem Not in Windows Terminal: launch a new WT window running the agent script
    rem wt.exe can run a .bat directly; use start so the original window closes
    start "" wt.exe "%~dp0ts-agent-run.bat"
    exit /b 0
)

rem Already in Windows Terminal: run directly
call "%~dp0ts-agent-run.bat"
