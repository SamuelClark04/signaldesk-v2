@echo off
REM ------------------------------------------------------------------
REM Start-SignalDesk.bat: runs the SignalDesk server in this window so
REM the logs (pipeline, WebSocket, [LIVE] and [security] lines) stay visible.
REM Close this window or run Stop-SignalDesk.bat to stop the server.
REM Opens the default browser on the terminal once the server is up (the
REM desktop shortcut is a 1-click launcher); if already running, just opens it.
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
REM If it is already running, the shortcut just opens the browser to it.
netstat -ano | findstr /r /c:":%SD_PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo Port %SD_PORT% is already in use: SignalDesk ^(or another app^) is already running.
  echo Opening http://127.0.0.1:%SD_PORT%/ in your browser. Use Stop-SignalDesk.bat to restart it.
  start "" "http://127.0.0.1:%SD_PORT%/"
  timeout /t 5 >nul
  exit /b 0
)

REM 1-click launcher: a hidden helper waits (up to 60 s) until the server answers
REM its sign-in page (the only page served without signing in), then opens the
REM default browser on the terminal. The first visit on a browser asks for the
REM access token once; the sign-in lasts 30 days. The server keeps running in
REM this window so its logs stay visible.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "$u='http://127.0.0.1:%SD_PORT%/'; for ($i = 0; $i -lt 120; $i++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 ($u + 'login') | Out-Null; Start-Process $u; break } catch { Start-Sleep -Milliseconds 500 } }"

echo Starting SignalDesk on http://127.0.0.1:%SD_PORT%  ^(Ctrl+C to stop^)
echo The browser opens automatically once the server is up.
echo.
node server\server.js

echo.
echo SignalDesk server has stopped.
pause
