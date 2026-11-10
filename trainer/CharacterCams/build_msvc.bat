@echo off
rem Builds CharacterCams.asi (32-bit) with Visual Studio's C++ tools.
rem Needs the "Desktop development with C++" workload. Run from any prompt.
setlocal
set VSWHERE="%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq delims=" %%i in (`%VSWHERE% -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set VSDIR=%%i
if not defined VSDIR (
  echo Visual Studio C++ tools not found. Install the "Desktop development with C++" workload.
  exit /b 1
)
call "%VSDIR%\VC\Auxiliary\Build\vcvars32.bat" >nul || exit /b 1
cd /d "%~dp0"
if not exist build mkdir build
cl /nologo /O2 /MT /W4 /EHs-c- /GS- /LD src\CharacterCams.cpp /Fobuild\ /Febuild\CharacterCams.asi /link user32.lib kernel32.lib
if errorlevel 1 exit /b 1
echo Built build\CharacterCams.asi
