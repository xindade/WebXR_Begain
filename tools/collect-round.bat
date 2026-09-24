@echo off
chcp 65001 >nul
title WebXR one-round capture
setlocal

rem ==== read-only modes (--analyze / --selftest) need no admin: run straight through ====
if /i "%~1"=="--analyze"  goto admin_ok
if /i "%~1"=="--selftest" goto admin_ok
if /i "%~1"=="--help"     goto admin_ok
if /i "%~1"=="-h"         goto admin_ok

rem ==== raw-packet capture needs admin: auto-elevate through UAC ====
rem THIS FILE IS DELIBERATELY ASCII-ONLY. cmd.exe reads a .bat in byte chunks
rem using the code page in effect at that moment; non-ASCII text here gets split
rem mid-character and cmd then tries to run the garbage as a command
rem ("xxxx is not recognized as an internal or external command").
net session >nul 2>&1
if not errorlevel 1 goto admin_ok
fltmc >nul 2>&1
if not errorlevel 1 goto admin_ok

if exist "%TEMP%\collect-round.elevated.tmp" (
    echo.
    echo  [WARN] Still not admin after elevation. Continuing anyway; if the capture
    echo         fails, right-click this file and pick "Run as administrator".
    goto admin_ok
)
echo x>"%TEMP%\collect-round.elevated.tmp"
echo.
echo  [INFO] Raw packet capture needs admin. A UAC prompt will pop up - click Yes.
echo         A NEW elevated window opens and this one closes: keep working THERE.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs -WorkingDirectory '%~dp0..'"
exit /b

:admin_ok
del "%TEMP%\collect-round.elevated.tmp" >nul 2>&1

rem ==== this script lives in tools\, so switch to the project root ====
pushd "%~dp0.."

rem ==== locate python ====
set "PY="
where python >nul 2>&1
if not errorlevel 1 set "PY=python"
if not defined PY (
    where py >nul 2>&1
    if not errorlevel 1 set "PY=py -3"
)
if not defined PY (
    echo.
    echo  [ERROR] python not found. Install Python 3 and tick "Add python.exe to PATH".
    echo.
    popd
    pause
    exit /b 2
)

echo.
echo  ================================================================
echo   One-round capture            project: %CD%
echo  ----------------------------------------------------------------
echo   Capture is running. Now do these THREE steps:
echo     1) Platform: click "Start Game"  (PC EXE + headset app get started)
echo     2) Platform: click "Begin"       (headset enters VR)
echo     3) * Finish the round NATURALLY * (win / lose / clear the level)
echo        Do NOT click the platform "End Game" button - that path only shows
echo        kill + CloseGame and you will NEVER see CMD 6.
echo   When the round is over, come back to this window and press ENTER.
echo  ================================================================
echo.

%PY% "tools\cap-round.py" %*
set RC=%ERRORLEVEL%

popd
echo.
if not "%RC%"=="0" echo  [FAIL] exit code %RC% - see the error above; the report may be missing.
echo  Report dir: newest timestamp folder under E:\AI_Work\WebXR_Capture\
echo.
pause
endlocal && exit /b %RC%