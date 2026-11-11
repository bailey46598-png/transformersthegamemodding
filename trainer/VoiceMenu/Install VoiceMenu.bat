@echo off
rem Installs VoiceMenu. Run it from inside your game folder, or pick the folder when asked.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" %*
pause
