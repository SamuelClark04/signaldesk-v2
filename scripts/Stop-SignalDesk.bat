@echo off
REM ------------------------------------------------------------------
REM Stop-SignalDesk.bat: stops ONLY the SignalDesk server. It kills a
REM process only if it is listening on SignalDesk's port AND is node.exe
REM AND is running server/server.js. Other Node apps are never touched.
REM The PowerShell below the #PS# marker does the work.
REM ------------------------------------------------------------------
title Stop SignalDesk
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((Get-Content -LiteralPath '%~f0' -Raw) -split '#PS#')[-1]"
echo.
pause
exit /b

#PS#
$port = 3000
$envFile = 'C:\SignalDesk-V2\.env'
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
}

$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $listeners) {
  Write-Host "Nothing is listening on port $port. SignalDesk is not running."
  return
}

foreach ($procId in ($listeners.OwningProcess | Sort-Object -Unique)) {
  $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $procId)
  $isSignalDesk = $proc -and $proc.Name -eq 'node.exe' -and $proc.CommandLine -match 'server[\\/]server\.js'
  if ($isSignalDesk) {
    Stop-Process -Id $procId -Force
    Write-Host "Stopped SignalDesk server (PID $procId, port $port)."
  } else {
    $name = if ($proc) { $proc.Name } else { 'unknown' }
    Write-Host "Port $port is used by $name (PID $procId), which is not the SignalDesk server. Left it running."
  }
}
