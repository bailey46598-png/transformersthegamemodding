@echo off
rem Builds DebugTrainer.asi (32-bit) with Visual Studio's C++ tools.
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
set IMGUI=third_party\imgui
cl /nologo /O2 /MT /W3 /EHs-c- /GS- /DNDEBUG /LD /I%IMGUI% /I%IMGUI%\backends ^
  src\DebugTrainer.cpp %IMGUI%\imgui.cpp %IMGUI%\imgui_draw.cpp %IMGUI%\imgui_tables.cpp %IMGUI%\imgui_widgets.cpp ^
  %IMGUI%\backends\imgui_impl_dx9.cpp %IMGUI%\backends\imgui_impl_win32.cpp ^
  /Fobuild\ /Febuild\DebugTrainer.asi /link user32.lib kernel32.lib gdi32.lib dxguid.lib
if errorlevel 1 exit /b 1
echo Built build\DebugTrainer.asi
