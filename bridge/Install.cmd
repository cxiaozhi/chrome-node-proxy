@echo off
where pwsh.exe >nul 2>nul
if errorlevel 1 goto legacy
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1" %*
goto done
:legacy
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1" %*
:done
if errorlevel 1 echo Installation failed.
pause
