@echo off
rem Starts the TF Studio server and opens it in the browser. Close this window to stop it.
setlocal
set "HERE=%~dp0"
set "PY="
for %%P in (python.exe) do if not "%%~$PATH:P"=="" (
  python -c "import sys" >nul 2>&1 && set "PY=python"
)
if not defined PY for /d %%D in ("C:\Program Files\Blender Foundation\Blender *") do (
  for /d %%V in ("%%D\*") do if exist "%%V\python\bin\python.exe" set "PY=%%V\python\bin\python.exe"
)
if not defined PY (
  echo Could not find Python. Install Python 3 or Blender, or run:  python serve.py
  pause
  exit /b 1
)
echo Using %PY%
start "" "http://127.0.0.1:8765/"
"%PY%" "%HERE%serve.py" "%HERE%..\.."
pause
