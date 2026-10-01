@echo off
rem Starts the Satisfactory Factory Planner and opens it in the browser. Close this window to stop it.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install || (pause & exit /b 1)
)
call npm run dev -- --open
pause
