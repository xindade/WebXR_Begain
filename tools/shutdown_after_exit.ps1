<#
  shutdown_after_exit.ps1
  ============================================================
  用途：AI 软件（WorkBuddy）完成任务后，自己退出，再延迟一段时间把电脑关机。
  典型场景：你让我干完活，我希望它自动关掉自己，并让电脑在 X 秒后自动断电，
            这样戴着 PICO 测完直接走人，不用回电脑前手动关机。

  原理：
    1) 先用系统级 `shutdown /s /t <延迟秒>` 预约关机 —— 这是 Windows 会话管理器
       层面的定时器，不依赖谁调用，关掉 WorkBuddy 后依然生效（延迟期间可 `shutdown /a` 撤销）。
    2) 再 `taskkill /IM WorkBuddy.exe /F` 关掉 AI 软件自身。
    3) 因为“关掉自己”会杀掉本脚本的宿主，所以必须先预约关机、再杀进程
       （毫秒级差异，效果等价于：软件关闭 → 等延迟 → 电脑关机）。
    4) 延迟 > 600 秒时，客户端 Windows 可能对 /t 有上限，自动改用分离的独立进程
       Start-Sleep 后再 `shutdown /s /t 0`，同样存活于软件退出之后。

  用法（cmd / PowerShell）：
    # 默认：关掉 WorkBuddy，5 分钟后关机（会要求输入 YES 确认）
    powershell -ExecutionPolicy Bypass -File shutdown_after_exit.ps1

    # 指定延迟，例如 10 分钟 = 600 秒
    powershell -ExecutionPolicy Bypass -File shutdown_after_exit.ps1 -DelaySeconds 600

    # 跳过确认直接执行（谨慎）
    powershell -ExecutionPolicy Bypass -File shutdown_after_exit.ps1 -DelaySeconds 600 -Force

    # 演练：只打印、不关机也不杀进程
    powershell -ExecutionPolicy Bypass -File shutdown_after_exit.ps1 -WhatIf

    # 取消已预约的关机（任何时候、任何窗口都能跑）
    shutdown /a

  安全：
    - 默认需输入 YES 才真正执行；-Force 可跳过确认。
    - -WhatIf 全程不碰系统。
    - 关机预约可随时 `shutdown /a` 撤销（延迟 ≤600s 时有效；>600s 的分离进程需手动结束该 powershell）。
#>

param(
  [int]   $DelaySeconds = 300,          # 关掉软件后到真正关机的延迟（秒），默认 300 = 5 分钟
  [string]$CloseProcess = "WorkBuddy", # 要关掉的 AI 软件进程名（不含 .exe）
  [switch]$Force,                       # 跳过 YES 确认直接执行
  [switch]$WhatIf                       # 只打印流程，不关机也不杀进程
)

if ($WhatIf) {
  Write-Host "[WhatIf] 将预约关机：shutdown /s /t $DelaySeconds" -ForegroundColor Magenta
  Write-Host "[WhatIf] 将关闭自身：taskkill /IM $CloseProcess.exe /F" -ForegroundColor Magenta
  Write-Host "[WhatIf] 实际不会执行任何系统操作。" -ForegroundColor Magenta
  exit 0
}

if (-not $Force) {
  $ans = Read-Host "确认要关掉 [$CloseProcess] 并在 $DelaySeconds 秒后关机吗？输入 YES 继续"
  if ($ans -ne "YES") {
    Write-Host "已取消，未做任何操作。" -ForegroundColor Yellow
    exit 0
  }
}

# 1) 先预约关机（系统级定时器，存活于软件退出之后）
if ($DelaySeconds -gt 600) {
  Write-Host "延迟 ${DelaySeconds}s > 600，使用分离进程倒计时（避免客户端 /t 上限）..." -ForegroundColor Cyan
  $cmd = "Start-Sleep -Seconds $DelaySeconds; shutdown /s /t 0"
  Start-Process -FilePath powershell.exe -ArgumentList "-NoProfile", "-Command", $cmd -WindowStyle Hidden
} else {
  Write-Host "预约 $DelaySeconds 秒后关机..." -ForegroundColor Cyan
  shutdown /s /t $DelaySeconds
}
Write-Host "关机已预约。延迟期间可执行 'shutdown /a' 取消。" -ForegroundColor Yellow

# 2) 再关掉 AI 软件自身（此后本脚本随宿主一起结束，系统倒计时继续）
Write-Host "正在关闭 [$CloseProcess]（自身）..." -ForegroundColor Red
taskkill /IM "$CloseProcess.exe" /F
