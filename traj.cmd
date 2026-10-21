@echo off
setlocal
rem opencode-trajectory launcher
set "ROOT=%~dp0"
where node >nul 2>nul
if not errorlevel 1 goto run
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE goto nonode
goto run

:run
if defined NODE ( "%NODE%" "%ROOT%bin\traj.mjs" %* ) else ( node "%ROOT%bin\traj.mjs" %* )
exit /b %errorlevel%

:nonode
echo Node.js not found. Install Node 18 or newer first.
exit /b 1
