@echo off
rem Score Studio launcher: builds the web UI if needed, then serves everything on http://127.0.0.1:8000
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Python environment missing. See README.md "Setup".
  pause
  exit /b 1
)
if not exist "web\dist\index.html" (
  echo Building the web UI...
  pushd web
  call npm install || goto :fail
  call npm run build || goto :fail
  popd
)
set HF_HUB_DISABLE_SYMLINKS_WARNING=1
set PYTHONIOENCODING=utf-8
start "" http://127.0.0.1:8000
".venv\Scripts\python.exe" -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
exit /b 0
:fail
echo Web build failed.
pause
exit /b 1
