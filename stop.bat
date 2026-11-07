@echo off
rem Score Studio: stop the server started by start.bat (whatever is listening on 127.0.0.1:8000).
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$c = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue;" ^
  "if (-not $c) { Write-Host 'Score Studio is not running.'; exit 0 };" ^
  "$c | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {" ^
  "  $p = Get-Process -Id $_ -ErrorAction SilentlyContinue;" ^
  "  if ($p -and $p.ProcessName -like 'python*') { Stop-Process -Id $_ -Force; Write-Host ('Stopped Score Studio (PID ' + $_ + ').') }" ^
  "  else { Write-Host ('Port 8000 is used by ' + $p.ProcessName + ', not Score Studio - left running.') } }"
timeout /t 3 >nul 2>&1
