@echo off
cd /d "%~dp0"

rem Direct node invocation: skip npx resolution overhead (measured ~1.1s faster startup on Windows).
if not exist "node_modules\tsx\dist\cli.mjs" (
    echo [ERROR] tsx not found in node_modules. Run "npm install" first.
    pause
    exit /b 1
)

echo Starting Flint...
node node_modules\tsx\dist\cli.mjs src/index.ts
pause
