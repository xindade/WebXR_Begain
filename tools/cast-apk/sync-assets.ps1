# sync-assets.ps1 —— 把游戏运行所需资源同步进 APK 的 assets/game
#
# 用法（在 tools/cast-apk 目录执行）：
#   powershell -ExecutionPolicy Bypass -File sync-assets.ps1
#
# 说明：
#   - 源 = 项目根（脚本上溯两级：tools/cast-apk -> 项目根）
#   - 目标 = app/src/main/assets/game
#   - 排除开发/工具类目录与文档，并删除已知无用大文件以减小 APK 体积
#   - 每次游戏更新后重新运行本脚本并重新打包 APK 即可

$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")      # 项目根 E:\AI_Work\WebXR_Begain
$src  = $root.Path
$dst  = Join-Path $PSScriptRoot "app\src\main\assets\game"

Write-Host "源  : $src"
Write-Host "目标: $dst"

# 清空旧副本，保证与游戏当前状态完全一致
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $dst -Force | Out-Null

# 复制游戏运行所需文件；排除开发/工具目录与文档
# 注意：robocopy 退出码 0/1/2/3 均为“成功/已复制”类，仅 >=8 才是真实失败
$excludeDirs = @('.workbuddy', '.git', 'node_modules', 'tools')
robocopy $src $dst /E /XD $excludeDirs /XF *.md package.json package-lock.json README* LICENSE* 2>$null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE" }

# 删除已知的无用大文件（省 APK 体积；不影响运行）
# 如后续发现其它无用大文件，往此列表追加文件名即可
$bigFiles = @('早晨天空.png')
foreach ($name in $bigFiles) {
    Get-ChildItem -Path $dst -Recurse -Filter $name -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item $_.FullName -Force
        Write-Host "已排除无用大文件: $($_.FullName)"
    }
}

# 开场影片说明：开场视频改为游戏内「等待房间」播放（src/game/waitingRoom.js 读取
# assets/intro/intro.mp4），由 GameServer 从 assets/game 统一托管，无需再单独拷贝到原生 res/raw。
# 因此下方不再同步 res/raw/intro.mp4（APK 也不再包含原生 VideoView 开场）。

Write-Host "DONE -> $dst"
