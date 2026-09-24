#requires -version 5.1
<#
  trigger-game-result.ps1 —— 现场「轻量验证」：手工触发一次 CMD 7（本局结束上报）

  为什么要有它：
    验「平台收到 CMD 7 会不会弹结算」不该每次都打满一整局（原版那局跑了 15 分钟）。
    在平台**已经点了「开始游戏」**的那一局里跑一下本脚本，平台界面应**立刻弹结算**，
    平台日志里出现 cmd = 7 / ==PostGameResult== / 游戏结束 场次ID:N。

  它比手敲 curl 多做的事：
    · **自动找端口** —— PC 端 HTTP 从 8443 起、被占用会 +1 一路退到 8453；而打包后的 EXE
      既不写日志文件、纯净模式下界面又把「头显请打开 http://…:<端口>」那行藏了，
      现场其实**看不到**端口，硬猜 8443 会白试。
    · **先说清「能不能发」** —— EXE 不是被平台拉起的（gameChannel.enabled = false）时，
      上报会被跳过。脚本会把这个前提先摆出来，免得你以为是功能坏了。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\trigger-game-result.ps1
    powershell ... -File tools\trigger-game-result.ps1 -Port 8444      # 已知端口时跳过探测
    powershell ... -File tools\trigger-game-result.ps1 -DryRun         # 只看状态，不发
#>
[CmdletBinding()]
param(
  [int]$Port = 0,
  [switch]$DryRun
)

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$PORT_LO = 8443
$PORT_HI = 8453

function Write-Head([string]$t) {
  Write-Host ""
  Write-Host ("=" * 66) -ForegroundColor DarkGray
  Write-Host "  $t" -ForegroundColor Cyan
  Write-Host ("=" * 66) -ForegroundColor DarkGray
}

function Get-CastInfo([int]$p) {
  try {
    return Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/info" -f $p) -TimeoutSec 2 -ErrorAction Stop
  } catch {
    return $null
  }
}

Write-Head "轻量验证：手工触发一次 CMD 7（本局结束上报）"

# —— 1. 找 PC 端接收站的端口 ——
$found = $null
$foundPort = 0
if ($Port -gt 0) {
  $foundPort = $Port
  $found = Get-CastInfo $Port
  if (-not $found) {
    Write-Host "[x] 127.0.0.1:$Port 没有响应 —— 这个端口上不是 PC 端接收站。" -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "正在探测 PC 端接收站端口（$PORT_LO - $PORT_HI）…"
  foreach ($p in $PORT_LO..$PORT_HI) {
    $i = Get-CastInfo $p
    if ($i) { $found = $i; $foundPort = $p; break }
  }
  if (-not $found) {
    Write-Host ""
    Write-Host "[x] $PORT_LO - $PORT_HI 全都没响应 —— PC 端 EXE 没在跑。" -ForegroundColor Red
    Write-Host "    请先让平台点「启动游戏」（EXE 必须由平台拉起，本项验证才有意义）。" -ForegroundColor Yellow
    exit 1
  }
}

Write-Host ("[√] 找到 PC 端接收站：127.0.0.1:{0}  （本机 IP：{1}）" -f $foundPort, ($found.ips -join ', ')) -ForegroundColor Green

# —— 2. 先把前提摆清楚 ——
$ch = $found.gameChannel
$armed = $found.round.armed

Write-Head "当前状态（决定这次能不能发得出去）"
Write-Host ("   EXE 被平台拉起     : {0}" -f $(if ($ch.enabled) { "是" } else { "否" }))
Write-Host ("   游戏通道已监听     : {0}  (UDP {1})" -f $(if ($ch.bound) { "是" } else { "否" }), 51124)
# ★ 2026-09-24 修正：这里原先读 $found.platform.platform（那是「启动参数里带的平台 IP」），
#   跟「EXE 是否被平台拉起」根本是两回事 —— 没带启动参数时会显示成「EXE 不是平台拉起的」，误导。
#   实际上报目标由 PC 端按 lastFromIp → platformIp → 本机网卡地址 依次决定，这里照它显示。
$dstIp  = if ($ch.lastFromIp) { $ch.lastFromIp } elseif ($ch.platformIp) { $ch.platformIp } else { $null }
$dstWhy = if ($ch.lastFromIp) { "平台发帧过来的源 IP" } elseif ($ch.platformIp) { "平台启动参数" } else { "平台没发过帧、也没带启动参数" }
$dstTxt = if ($dstIp) { "{0}:51234（{1}）" -f $dstIp, $dstWhy } else { "本机网卡地址:51234（{0}）" -f $dstWhy }
Write-Host ("   上报目标地址       : {0}" -f $dstTxt)
Write-Host ("   本局放行(armed)    : {0}" -f $(if ($armed) { "是（平台已点「开始游戏」）" } else { "否（平台还没点「开始游戏」）" }))
Write-Host ("   已上报次数         : {0}" -f $ch.results)
Write-Host ("   最近一次上报       : {0}" -f $(if ($ch.lastResultWhy) { $ch.lastResultWhy } else { "（还没有）" }))

if (-not $ch.enabled) {
  Write-Host ""
  Write-Host "  [!] gameChannel.enabled = false。" -ForegroundColor Yellow
  Write-Host "      这条链路没开，上报一定会被跳过。原因：EXE 不是被平台「启动游戏」拉起的，" -ForegroundColor Yellow
  Write-Host "      或显式带了 --no-game-channel。请让平台重新点「启动游戏」把 EXE 拉起来。" -ForegroundColor Yellow
} elseif (-not $armed) {
  Write-Host ""
  Write-Host "  [!] 本局还没放行（平台还没点「开始游戏」）。" -ForegroundColor Yellow
  Write-Host "      报告仍会发得出去，但平台**不会弹结算** —— 请先点「开始游戏」再验。" -ForegroundColor Yellow
}

if ($DryRun) {
  Write-Host ""
  Write-Host "（-DryRun：只看状态，没有发送。）" -ForegroundColor DarkGray
  exit 0
}

# —— 3. 发 ——
Write-Head "POST /api/platform/game-result"
$uri = "http://127.0.0.1:{0}/api/platform/game-result" -f $foundPort
try {
  $r = Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json' -Body '{}' -TimeoutSec 5 -ErrorAction Stop
} catch {
  Write-Host "[x] 请求失败：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

Write-Host ("   ok      : {0}" -f $r.ok)
Write-Host ("   results : {0}" -f $r.results)
Write-Host ("   why     : {0}" -f $r.why)
if ($r.dest) { Write-Host ("   实际发往: {0}" -f ($r.dest -join ', ')) }

Write-Head "下一步看什么"
if ($r.ok) {
  Write-Host "  [√] 已从本机发出 CMD 7（397 字节，源端口 51124）。" -ForegroundColor Green
  Write-Host ""
  Write-Host "  现在去看平台那边（应当**立刻**出现，不用等）："
  Write-Host "    1) 平台界面 -> 弹出本局结算"
  Write-Host "    2) 平台日志 G:\01_Work\DXGames2\VRPlatform-2.3.4.3\DebugLog\最新.log 里应出现："
  Write-Host "         ===ReceiveCall==...,cmd = 7"
  Write-Host "         ==PostGameResult=={...}"
  Write-Host "         游戏结束 场次ID:N 结算类型:正常结算"
  Write-Host ""
  Write-Host "  关键点：平台弹结算之后**不应该关游戏** —— 这就是我们要的「只告知、不关掉」。"
  Write-Host "  想连日志一起留证，用 tools\collect-round.bat。"
  exit 0
} else {
  Write-Host "  [x] 没有真正发出去，原因见上面的 why。" -ForegroundColor Red
  Write-Host "      enabled = false ⇒ 按前面那段的提示，让平台重新点「启动游戏」拉起 EXE。" -ForegroundColor Yellow
  exit 1
}