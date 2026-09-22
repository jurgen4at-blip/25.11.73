@echo off
cd /d "%~dp0"
echo ========================================
echo       RESET DO ADM - KX ICE CRASH
echo ========================================
node reset-admin.js
if errorlevel 1 (
  echo.
  echo ERRO ao atualizar o ADM.
)
echo.
pause
