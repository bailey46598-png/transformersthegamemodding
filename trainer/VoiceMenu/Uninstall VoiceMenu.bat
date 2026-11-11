@echo off
rem Removes VoiceMenu (only the files its installer added).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\uninstall.ps1" %*
pause
