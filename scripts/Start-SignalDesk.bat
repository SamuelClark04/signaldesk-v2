@echo off
REM ------------------------------------------------------------------
REM Start-SignalDesk.bat: runs the SignalDesk server in this window so
REM the logs (pipeline, WebSocket, [LIVE] and [security] lines) stay visible.
REM Close this window or run Stop-SignalDesk.bat to stop the server.
REM ------------------------------------------------------------------
title SignalDesk Server
cd /d C:\SignalDesk-V2 || (echo Project folder C:\SignalDesk-V2 not found. & pause & exit /b 1)

REM Port: 3000 unless .env sets PORT=...
set "SD_PORT=3000"
if exist .env for /f "tokens=2 delims==" %%a in ('findstr /r /b /c:"PORT=[0-9]" .env') do set "SD_PORT=%%a"

where node >nul 2>nul || (echo Node.js was not found on PATH. Install it from https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Installing dependencies ^(first run^)...
  call npm install || (echo npm install failed. & pause & exit /b 1)
)

REM Refuse to start a second copy: it would fail on the busy port and compete
REM with the running one for the Alpaca stream connections (406 errors).
netstat -ano | findstr /r /c:":%SD_PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo Port %SD_PORT% is already in use: SignalDesk ^(or another app^) is already running.
  echo Use Stop-SignalDesk.bat first if you want to restart it.
  pause
  exit /b 1
)

echo Starting SignalDesk on http://127.0.0.1:%SD_PORT%  ^(Ctrl+C to stop^)
echo.
node server\server.js

echo.
echo SignalDesk server has stopped.
pause
