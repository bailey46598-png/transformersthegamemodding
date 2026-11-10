@echo off
rem Pulls the cutscene soundtracks out of the game's videos (fmv\MultiLang\*.bik) into cutscene_audio\.
rem Needs Blender (its built-in FFmpeg reads Bink audio). Drag the game's fmv\MultiLang folder onto this file,
rem or run it and paste the folder when asked.
setlocal
set "HERE=%~dp0"
set "BL="
for /d %%D in ("C:\Program Files\Blender Foundation\Blender *") do if exist "%%D\blender.exe" set "BL=%%D\blender.exe"
if not defined BL (
  echo Could not find Blender in C:\Program Files\Blender Foundation.
  pause
  exit /b 1
)
set "FMV=%~1"
if not defined FMV set /p "FMV=Path to the game's fmv\MultiLang folder: "
set "FMV=%FMV:"=%"
if not exist "%FMV%\" (
  echo Not a folder: %FMV%
  pause
  exit /b 1
)
"%BL%" -b --factory-startup --python "%HERE%tools\extract_cutscene_audio.py" -- "%FMV%"
pause
