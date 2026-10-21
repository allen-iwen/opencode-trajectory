@echo off
setlocal
rem opencode-trajectory installer
title opencode-trajectory
where node >nul 2>nul
if errorlevel 1 goto nonode
node "%~dp0scripts\install.mjs" %*
echo.
echo Done. Restart opencode (plugins load once at startup).
pause
exit /b 0

:nonode
echo Node.js 18 or newer is required: https://nodejs.org
pause
exit /b 1
