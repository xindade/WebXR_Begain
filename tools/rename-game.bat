@echo off
chcp 65001 >nul
title WebXR 打气球 - 一键改包名 / 改版本号
pushd "%~dp0"
rem 额外参数会透传给 rebrand.ps1，例如：rename-game.bat -VersionCode 300 -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rebrand.ps1" -Interactive %*
set RC=%ERRORLEVEL%
popd
if not "%RC%"=="0" (
    echo.
    echo [失败] 退出码 %RC% —— 上面的报错就是原因。源码可能已改但包没打出来，修完重跑即可。
)
echo.
pause