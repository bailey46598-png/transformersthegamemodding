@echo off
rem Builds DamageProbe.asi (32-bit) with Visual Studio's C++ tools.
setlocal
set VSWHERE="%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq delims=" %%i in (`%VSWHERE% -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set VSDIR=%%i
if not defined VSDIR (
  echo Visual Studio C++ tools not found.
  exit /b 1
)
call "%VSDIR%\VC\Auxiliary\Build\vcvars32.bat" >nul || exit /b 1
cd /d "%~dp0"
if not exist build mkdir build
cl /nologo /O2 /MT /W3 /EHs-c- /GS- /LD src\DamageProbe.cpp /Fobuild\ /Febuild\DamageProbe.asi /link user32.lib kernel32.lib
if errorlevel 1 exit /b 1
echo Built build\DamageProbe.asi
