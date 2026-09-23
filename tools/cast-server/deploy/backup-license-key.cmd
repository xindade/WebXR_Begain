@echo off
REM ===========================================================================
REM  Windows launcher for deploy/backup-license-key.sh
REM  (the .sh needs Git for Windows' bash; this wrapper finds it for you)
REM
REM  Usage -- works from BOTH PowerShell and cmd:
REM      tools\cast-server\deploy\backup-license-key.cmd E:\webvr123-backup
REM
REM  Why this exists: PowerShell's PATH usually has no "bash" (Git only adds
REM  git.exe), and "/e/..." is not a valid Windows path. This wrapper resolves
REM  bash.exe and forwards every argument unchanged to the .sh script.
REM ===========================================================================
setlocal
chcp 65001 >nul 2>&1

set "BASH="
for %%P in ("%ProgramFiles%\Git\bin\bash.exe" "%LocalAppData%\Programs\Git\bin\bash.exe" "%UserProfile%\scoop\apps\git\current\bin\bash.exe") do (
  if not defined BASH if exist "%%~P" set "BASH=%%~P"
)
if not defined BASH for /f "delims=" %%B in ('where bash.exe 2^>nul') do if not defined BASH set "BASH=%%B"
if not defined BASH (
  echo [fatal] Git for Windows' bash.exe not found.
  echo         Install Git for Windows, or run the 3 plain PowerShell commands
  echo         listed in tools/cast-server/README.md section 3.6.
  exit /b 2
)

pushd "%~dp0"
"%BASH%" ./backup-license-key.sh %*
set "RC=%ERRORLEVEL%"
popd
endlocal & exit /b %RC%
