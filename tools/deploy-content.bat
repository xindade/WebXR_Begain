@echo off
rem ============================================================================
rem  deploy-content.bat -- launcher for tools\deploy-content.ps1
rem  Double-click = dry run report + pause;  or pass args, e.g.:
rem     deploy-content.bat -DryRun
rem     deploy-content.bat -InstallKey
rem ============================================================================
setlocal
set "PS1=%~dp0deploy-content.ps1"
if not exist "%PS1%" (
  echo [FAILED] not found: %PS1%
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [FAILED] exit code = %CODE%
)
if "%~1"=="" pause
endlocal & exit /b %CODE%