# build-apk.ps1 —— 一键构建 cast-apk（debug APK）
#
# 用法（任选其一）：
#   1) 在 tools/cast-apk 目录，右键本文件 →「使用 PowerShell 运行」
#   2) 命令行： powershell -ExecutionPolicy Bypass -File build-apk.ps1
#
# 前置条件（脚本会自动探测，缺失会明确报错）：
#   - JDK 17（默认探测 C:/Program Files/Java/jdk-17*）
#   - Gradle：优先用本目录 gradlew.bat；否则用 ~/.gradle 里已缓存的 Gradle 发行版；
#             再不行就用 PATH 上的 gradle。
#   - Android SDK：读取本目录 local.properties 的 sdk.dir（已指向 C:/Users/x/AppData/Local/Android/Sdk）
#   - 首次构建需联网下载 AGP / GeckoView 等依赖（依赖已缓存时较快）
#
# 产物： app/build/outputs/apk/debug/app-debug.apk

$ErrorActionPreference = 'Stop'

# 脚本所在目录即项目根
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $root
Write-Host "== 项目目录: $root"

# ── 1) JDK 17 ───────────────────────────────────────────────
if (-not $env:JAVA_HOME -or -not (Test-Path "$env:JAVA_HOME/bin/javac.exe")) {
    $found = Get-ChildItem 'C:/Program Files/Java' -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'jdk-17*' } | Sort-Object Name | Select-Object -Last 1
    if ($found) {
        $env:JAVA_HOME = $found.FullName
        Write-Host "== 自动设定 JAVA_HOME = $env:JAVA_HOME"
    }
}
if (-not $env:JAVA_HOME -or -not (Test-Path "$env:JAVA_HOME/bin/javac.exe")) {
    Write-Error "未找到 JDK 17，请安装 JDK 17 并设好 `$env:JAVA_HOME，例如：C:/Program Files/Java/jdk-17"
    exit 1
}
$env:PATH = "$env:JAVA_HOME/bin;" + $env:PATH
Write-Host "== JAVA_HOME = $env:JAVA_HOME"
# 注意：用绝对路径调用 javac。直接写 `& javac -version` 在部分 PowerShell 会话里
# 解析不到刚追加进 PATH 的可执行文件（报 "not recognized"），故走完整路径。
$javacExe = Join-Path $env:JAVA_HOME 'bin/javac.exe'
Write-Host "== javac: $(& $javacExe -version 2>&1)"

# 把 sdk.dir 暴露给 Gradle（保险，Gradle 本身也会读 local.properties）
if (Test-Path "$root/local.properties") {
    $sd = (Get-Content "$root/local.properties" | Where-Object { $_ -match '^sdk.dir=' } | Select-Object -First 1) -replace '^sdk.dir=',''
    if ($sd) { $env:ANDROID_HOME = $sd.Trim(); Write-Host "== ANDROID_HOME = $env:ANDROID_HOME" }
}

# ── 2) 选择 Gradle 可执行文件 ──────────────────────────────
function Pick-Gradle {
    # 优先：~/.gradle/wrapper/dists 下已缓存的 Gradle 发行版（取版本号最高者）。
    # 注意：必须用缓存里的 gradle.bat 直接跑，避免 gradlew 再去下载 -bin 发行版（离线/内网会失败）。
    $distsRoot = Join-Path $env:USERPROFILE '.gradle/wrapper/dists'
    if (Test-Path $distsRoot) {
        $bins = Get-ChildItem $distsRoot -Recurse -Filter gradle.bat -ErrorAction SilentlyContinue
        $scored = $bins | ForEach-Object {
            if ($_.FullName -match 'gradle-(\d+)\.(\d+)\.(\d+)') {
                [PSCustomObject]@{ Path = $_.FullName; Ver = [version]::new($matches[1], $matches[2], $matches[3]) }
            }
        } | Sort-Object Ver -Descending
        if ($scored.Count -gt 0) { return $scored[0].Path }
    }

    # 其次：项目自带 gradlew.bat（无缓存时回退，首次会下载对应发行版，需要联网）
    if (Test-Path "$root/gradlew.bat") { return "$root/gradlew.bat" }

    # 最后：PATH 上的 gradle
    $p = Get-Command gradle -ErrorAction SilentlyContinue
    if ($p) { return $p.Source }

    return $null
}

$gradle = Pick-Gradle
if (-not $gradle) {
    Write-Error "未找到 Gradle：请安装 Gradle，或用 Android Studio 同步一次本项目（会生成 gradlew）。"
    exit 1
}
Write-Host "== GRADLE = $gradle"

# ── 2.5) 同步游戏源码 src → assets/game/src ───────────────
# 为什么必须有这步：APK 里打进包的是 assets/game/src 这份**副本**，不是项目根的 src。
# 改了 JS 忘了同步 → 打出来的包跑的还是旧逻辑，且表面上「构建成功」，极难发现。
$srcDir    = Join-Path $root '..\..\src'                      # = E:\AI_Work\WebXR_Begain\src
$assetsDir = Join-Path $root 'app\src\main\assets\game\src'
$srcOk = $false
if (Test-Path $srcDir) {
    $srcDir = (Resolve-Path $srcDir).Path
    # 空目录保护：源目录里至少要有一个 .js，才允许覆盖 assets 副本
    if ((Get-ChildItem $srcDir -Recurse -File -Filter *.js -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0) { $srcOk = $true }
}
if ($srcOk) {
    # ⚠ 非破坏式同步：**只覆盖、不删除**。
    #   旧实现是「先 Remove-Item 整目录再整拷」，但本机的安全删除钩子会拦截 Remove-Item 并中止构建
    #   （[safe-delete][SAFE_DELETE_FAIL_CLOSED] trash-failed）。改为一律覆盖写入：
    #     · 源里有的文件 → 逐个覆盖进 assets（自动建子目录）；
    #     · assets 里多出来（源里已删）→ **只警告、不删**，绝不做破坏性操作。
    #     残留文件不影响运行（index.html 不会 import 已删除的模块），只会打一条明确警告。
    if (-not (Test-Path $assetsDir)) { New-Item -ItemType Directory -Path $assetsDir -Force | Out-Null }
    $srcFiles = Get-ChildItem $srcDir -Recurse -File
    foreach ($f in $srcFiles) {
        $rel  = $f.FullName.Substring($srcDir.Length).TrimStart('\')
        $dest = Join-Path $assetsDir $rel
        $destParent = Split-Path -Parent $dest
        if ($destParent -and -not (Test-Path $destParent)) {
            New-Item -ItemType Directory -Path $destParent -Force | Out-Null
        }
        Copy-Item $f.FullName $dest -Force
    }
    $n = (Get-ChildItem $assetsDir -Recurse -File | Measure-Object).Count
    Write-Host "== 已同步 src -> assets/game/src（覆盖 $($srcFiles.Count) 个文件，目录内共 $n 个，源: $srcDir）"

    # 残留检查（只报告，不删）
    $srcRel = @{}
    foreach ($f in $srcFiles) {
        $srcRel[$f.FullName.Substring($srcDir.Length).TrimStart('\').ToLower()] = $true
    }
    $stale = @()
    foreach ($f in (Get-ChildItem $assetsDir -Recurse -File)) {
        $rel = $f.FullName.Substring($assetsDir.Length).TrimStart('\')
        if (-not $srcRel.ContainsKey($rel.ToLower())) { $stale += $rel }
    }
    if ($stale.Count -gt 0) {
        Write-Host "== ⚠ assets 里有 $($stale.Count) 个文件在 src 中已不存在（**未自动删除**，需要时请手动清理）："
        $stale | Select-Object -First 20 | ForEach-Object { Write-Host "     - $_" }
    }
} else {
    Write-Host "== ⚠ 跳过源码同步（源目录缺失或无 .js：$srcDir）—— 包内 JS 可能是旧版！"
}

# ── 2.6) 授权公钥必须已注入（占位符绝不能进包）────────────────────
# 为什么必须拦：LICENSE_PUBKEY_B64 若还是占位符，头显侧**所有** license 校验都会失败，
# 现象是「直播端明明是正版却永远验不过」—— 与「两端签名算法没对齐」完全一样，极难定位。
# 注入方式（自带双口径哈希自证，防手抄错字符）：
#     python tools/cast-apk/patch-license-pubkey.py
$maPath = Join-Path $root 'app\src\main\java\com\local\webxrcast\MainActivity.java'
if (Test-Path $maPath) {
    $maText = Get-Content -Raw -Encoding UTF8 -Path $maPath
    $pubMatch = [regex]::Match($maText, 'LICENSE_PUBKEY_B64\s*=\s*"([^"]*)"')
    if (-not $pubMatch.Success) {
        Write-Error "MainActivity.java 里找不到 LICENSE_PUBKEY_B64 常量 —— 源码结构变了？"
        exit 1
    }
    $pubVal = $pubMatch.Groups[1].Value
    if ($pubVal -eq '__LICENSE_PUBKEY_B64__' -or $pubVal.Trim().Length -eq 0) {
        Write-Error "LICENSE_PUBKEY_B64 仍是占位符 —— 先执行：python tools/cast-apk/patch-license-pubkey.py"
        exit 1
    }
    Write-Host "== 授权公钥已注入（长度 $($pubVal.Length)）"
} else {
    Write-Host "== ⚠ 找不到 MainActivity.java，跳过授权公钥检查：$maPath"
}

# ── 3) 构建 debug APK ─────────────────────────────────────
# 注意：gradle 通常是 gradle.bat。PowerShell 里 `& xxx.bat` 处于管道中时会报
# "Cannot run a document in the middle of a pipeline"，故批处理一律经 cmd /c 调用。
#
# ★ 两个「调用方会假死」的坑，都实测踩过：
#   1) 输出一律重定向到 build.log，**不要**用 `| Select-Object -Last 40` 之类包住它 ——
#      日志会被缓冲到进程结束才吐，中途什么都看不到。
#   2) 必须加 `--no-daemon`：Gradle daemon 是**常驻进程**，会继承调用方的 stdout/stderr 句柄
#      → 调用方等不到流 EOF，明明 APK 早已落盘（实测 11s 就 BUILD SUCCESSFUL + 打印了
#      「构建成功」），外层却一直显示「运行中」，白等 26 分钟。
#      加 --no-daemon 后构建在 launcher JVM 内跑完即退出，句柄立刻释放，调用方正常返回
#      （代价：每次多花约 10s 冷启动；需要热 daemon 时手动去掉该参数即可）。
$logFile = Join-Path $root 'build.log'
if ($gradle -match '\.(bat|cmd)$') {
    & cmd /c "`"$gradle`" assembleDebug --no-daemon --stacktrace > `"$logFile`" 2>&1"
} else {
    & $gradle assembleDebug --no-daemon --stacktrace *> $logFile
}
$code = $LASTEXITCODE
Get-Content $logFile -Tail 30
if ($code -ne 0) {
    Write-Error "构建失败（exit code $code），完整日志：$logFile"
    exit $code
}

# ── 4) 校验产物 ───────────────────────────────────────────
$apk = "$root/app/build/outputs/apk/debug/app-debug.apk"
if (-not (Test-Path $apk)) {
    Write-Error "构建声称成功但未找到产物：$apk"
    exit 1
}
$mb = [math]::Round((Get-Item $apk).Length / 1MB, 2)
Write-Host ""
Write-Host "✅ 构建成功"
Write-Host "   APK: $apk"
Write-Host "   大小: $mb MB"
