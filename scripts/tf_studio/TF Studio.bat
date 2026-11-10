@echo off
rem Starts the TF Studio server and opens it in the browser. Close this window to stop it.
rem The first time, it asks where YOUR copy of the game is and remembers it in game_path.txt
rem (that file stays on your PC; it is not uploaded to GitHub).
setlocal
set "HERE=%~dp0"

rem --- Find the game folder ---
set "GAME="
if exist "%HERE%game_path.txt" set /p GAME=<"%HERE%game_path.txt"
if not defined GAME (
  echo Paste the path to your Transformers game folder ^(the one with Transformers.exe^),
  echo for example  D:\Games\Transformers Lab
  set /p "GAME=Game folder: "
)
set "GAME=%GAME:"=%"
if not exist "%GAME%\Transformers.exe" (
  echo Transformers.exe was not found in: %GAME%
  if exist "%HERE%game_path.txt" del "%HERE%game_path.txt"
  pause
  exit /b 1
)
> "%HERE%game_path.txt" echo %GAME%
echo Game folder: %GAME%

rem --- Find Python (installed Python, or the one inside Blender) ---
set "PY="
for %%P in (python.exe) do if not "%%~$PATH:P"=="" (
  python -c "import sys" >nul 2>&1 && set "PY=python"
)
if not defined PY for /d %%D in ("C:\Program Files\Blender Foundation\Blender *") do (
  for /d %%V in ("%%D\*") do if exist "%%V\python\bin\python.exe" set "PY=%%V\python\bin\python.exe"
)
if not defined PY (
  echo Could not find Python. Install Python 3 or Blender, or run:  python serve.py "GAME_FOLDER"
  pause
  exit /b 1
)
echo Using %PY%
start "" "http://127.0.0.1:8765/"
"%PY%" "%HERE%serve.py" "%GAME%"
pause
