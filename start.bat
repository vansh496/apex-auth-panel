@echo off
title APEX AUTH Panel
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [X] Node.js nahi mila.
  echo      Node 22+ install karein: https://nodejs.org  (LTS)
  echo      Install ke baad ye window band karke dobara start.bat chalayein.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo  [*] Installing dependencies... (pehli baar)
  echo.
  call npm install --no-audit --no-fund
)

echo.
echo  ==================================================
echo    APEX AUTH Panel
echo    Panel  : http://localhost:3000/
echo    Console: http://localhost:3000/app.html
echo    Login  : admin / admin123   (badal lena!)
echo  ==================================================
echo.
call npm start
pause
