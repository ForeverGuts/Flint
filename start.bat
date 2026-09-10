@echo off
cd /d "%~dp0"

rem Check if running inside Windows Terminal
if "%WT_SESSION%"=="" (
    rem Not in Windows Terminal: launch a new WT window running the agent script.
    rem .bat is not an executable: must wrap with cmd /k (CreateProcess cannot run .bat directly).
    rem /k keeps the window open on failure so errors stay visible; -- separates wt args from the command.
    start "" wt.exe -- cmd.exe /k "\"%~dp0flint-run.bat\""
    exit /b 0
)

rem Already in Windows Terminal: run directly
call "%~dp0flint-run.bat"
