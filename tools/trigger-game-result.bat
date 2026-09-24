@echo off
chcp 65001 >nul
title WebXR Balloon - Quick CMD7 verify
pushd "%~dp0"
rem Thin launcher: ALL user-facing text lives in trigger-game-result.ps1.
rem Keep this file ASCII-only. cmd.exe reads a .bat byte-by-byte in the current
rem code page, so non-ASCII here gets split mid-character and cmd then tries to
rem execute the fragments ("... is not recognized as an internal or external
rem command"). That is a bug we already paid for once with collect-round.bat.
rem
rem Extra args are passed through, e.g.:
rem   trigger-game-result.bat -DryRun
rem   trigger-game-result.bat -Port 8444
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0trigger-game-result.ps1" %*
set RC=%ERRORLEVEL%
popd
if not "%RC%"=="0" (
    echo.
    echo [FAIL] exit code %RC% -- the message above is the reason.
)
echo.
pause