@echo off
cd /d "%~dp0"
call npm.cmd install --ignore-scripts
if errorlevel 1 (
  echo.
  echo A instalacao falhou.
  pause
  exit /b 1
)
call npm.cmd start
pause
