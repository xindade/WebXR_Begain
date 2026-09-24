<#
  rebrand.ps1 —— 一键改头显端 APK 的「安装身份」：包名 / 应用显示名 / 版本名 / 版本号
  （可选）一起改 PC 端 exe 的 appId / productName，并重新打包、拷到交付目录。

  为什么需要它：本项目现在的 applicationId（com.GoodNet.DeepmindHacker）、
  显示名（DeepmindHacker）、版本号（2.0.5/205）都是**临时顶替**来的，正式发行要换成自己的。

  用法（仓库根目录）：
    powershell -ExecutionPolicy Bypass -File tools\rebrand.ps1 -PackageId com.mygame.balloon -AppName 打气球 -VersionName 1.0.0
    powershell -ExecutionPolicy Bypass -File tools\rebrand.ps1 -Interactive      # 问答式
    双击 tools\rename-game.bat                                                   # 等价于 -Interactive -Build -Sync

  开关：
    -VersionCode 101      版本号；不给则自动 +1
    -NoBuild              只改文件不打包
    -Sync <目录>          打包后拷过去（默认 E:\AI_Work\WebXR_Begain-release\release）
    -SyncName <文件名>    交付包文件名（默认沿用交付目录里已有的「头显端-*.apk」）
    -DryRun               只看会改什么，不写盘
    -Restore              只看当前身份，什么都不改
    -PcAppId / -PcProductName   顺带改 PC 端 exe 的 build.appId / build.productName

  ⚠ 包名是**平台注册键**：改完必须让平台方把新包名登记进「游戏列表」，
    否则平台看不到、也拉不起来（它是按包名枚举并 `am start -n <包名>/.MainActivity` 的）。
#>
[CmdletBinding()]
param(
    [string]$PackageId,
    [string]$AppName,
    [string]$VersionName,
    [string]$VersionCode,
    [string]$PcAppId,
    [string]$PcProductName,
    [string]$Sync = 'E:\AI_Work\WebXR_Begain-release\release',
    [string]$Aapt2 = 'C:\Users\x\AppData\Local\Android\Sdk\build-tools\35.0.0\aapt2.exe',
    [string]$SyncName,
    [switch]$Interactive,
    [switch]$NoBuild,
    [switch]$DryRun,
    [switch]$Restore
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root        = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$gradlePath  = Join-Path $root 'tools\cast-apk\app\build.gradle'
$stringsPath = Join-Path $root 'tools\cast-apk\app\src\main\res\values\strings.xml'
$javaDir     = Join-Path $root 'tools\cast-apk\app\src\main\java\com\local\webxrcast'
$pcPkgPath   = Join-Path $root 'tools\cast-pc\package.json'
function Get-Kit([string]$p) {
    if (-not (Test-Path $p)) { throw "找不到文件：$p" }
    $t = [System.IO.File]::ReadAllText($p)
    # ★ 判 BOM 必须用「序数」比较。写成 $t.StartsWith([string][char]0xFEFF) 是**文化敏感**
    #   比较，而 U+FEFF 在文化敏感比较里是「可忽略字符」—— 对**任何**字符串都返回 True。
    #   （2026-09-24 实测踩到：于是每个文件都被剥掉首字符、再被补上一个 BOM，
    #     build.gradle 变成 "lugins {"，Groovy 直接 "Unexpected character: '?'"。）
    $bom = ($t.Length -gt 0 -and [int][char]$t[0] -eq 0xFEFF)
    if ($bom) { $t = $t.Substring(1) }
    $eol = if ($t.Contains("`r`n")) { "`r`n" } else { "`n" }
    return @{ text = $t; bom = $bom; eol = $eol }
}
# ★ 一律**不写 BOM**：本工程所有源码都是无 BOM 的 UTF-8，
#   而 build.gradle 带 BOM 会让 Groovy 解析失败、.java 带 BOM 会让 javac 报 illegal character（均实测）。
function Set-Kit([string]$p, [string]$t) {
    [System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))
}
function One([string]$t, [string]$re) {
    $m = [regex]::Matches($t, $re)
    if ($m.Count -ne 1) { throw "期望恰好命中 1 处，实际 $($m.Count) 处：$re" }
    return $m[0]
}

# ── 1) 读当前身份 ─────────────────────────────────────────
$g  = Get-Kit $gradlePath
$s  = Get-Kit $stringsPath
$mPkg  = One $g.text "applicationId\s+'([^']*)'"
$mCode = One $g.text "versionCode\s+(\d+)"
$mName = One $g.text "versionName\s+'([^']*)'"
$mApp  = One $s.text '<string name="app_name">([^<]*)</string>'
$oldPkg  = $mPkg.Groups[1].Value
$oldCode = [int]$mCode.Groups[1].Value
$oldName = $mName.Groups[1].Value
$oldApp  = $mApp.Groups[1].Value

Write-Host ''
Write-Host '== 当前身份'
Write-Host "   包名 applicationId : $oldPkg"
Write-Host "   显示名 app_name    : $oldApp"
Write-Host "   版本 versionName   : $oldName"
Write-Host "   版本号 versionCode : $oldCode"
if ($Restore) { Write-Host '== 只读模式（-Restore）：未做任何修改'; return }

# ── 2) 取新值（参数优先，其次问答，最后默认）───────────────
if ($Interactive) {
    Write-Host ''
    Write-Host '== 问答式改名（直接回车 = 保持原值；版本号回车 = 自动 +1）'
    $v = Read-Host "新包名（例 com.mygame.balloon）[$oldPkg]";      if ($v -and $v.Trim()) { $PackageId   = $v.Trim() }
    $v = Read-Host "新显示名（头显应用列表里那个名字）[$oldApp]";   if ($v -and $v.Trim()) { $AppName     = $v.Trim() }
    $v = Read-Host "新版本名 versionName [$oldName]";              if ($v -and $v.Trim()) { $VersionName = $v.Trim() }
    $v = Read-Host "新版本号 versionCode [$($oldCode + 1)]";      if ($v -and $v.Trim()) { $VersionCode = $v.Trim() }
}
if (-not $PackageId)   { $PackageId   = $oldPkg }
if (-not $AppName)     { $AppName     = $oldApp }
if (-not $VersionName) { $VersionName = $oldName }
if (-not $VersionCode) { $VersionCode = [string]($oldCode + 1) }

# ── 3) 校验（错就当场停，绝不留下半成品）──────────────────
if ($PackageId -notmatch '^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$') {
    throw "包名格式不合法：$PackageId（至少两段、每段字母开头，例：com.mygame.balloon）"
}
if ($PackageId -eq 'com.GoodNet.LauncherClient') { throw '这是**平台客户端**的包名，不能占用' }
if ($PackageId -eq 'com.android' -or $PackageId -like 'com.android.*') { throw 'com.android.* 是系统保留前缀' }
# 只在**真的换名**时提示：原样回车（包名没变）不该被这条吵到
if ($PackageId -ne $oldPkg -and $PackageId -like 'com.GoodNet.*') {
    Write-Host '⚠ 新包名落在 com.GoodNet.* 里：平台的枚举/前缀扫描可能把它当成自家组件，建议换成你自己的前缀（com.你的域名.*）'
}
if ($VersionCode -notmatch '^\d+$') { throw "versionCode 必须是整数：$VersionCode" }
if ($VersionName -notmatch '^[0-9A-Za-z._-]{1,32}$') { throw "versionName 只允许 数字/字母/._-（≤32）：$VersionName" }
if ($AppName.Trim().Length -eq 0 -or $AppName -match '["<>$]') { throw "显示名不能为空、也不能含引号、尖括号或美元符：$AppName" }
if ($PcAppId -and $PcAppId -notmatch '^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$') { throw "PC 端 appId 格式不合法：$PcAppId" }
if ($PcProductName -and $PcProductName -match '["<>$]') { throw "PC 端 productName 不能含引号、尖括号或美元符：$PcProductName" }
$AppName = $AppName.Trim()

# ── 4) 生成新文本 ─────────────────────────────────────────
$gNew = $g.text
if ($PackageId -ne $oldPkg) { $gNew = [regex]::Replace($gNew, "applicationId\s+'[^']*'", "applicationId '$PackageId'") }
$gNew = [regex]::Replace($gNew, 'versionCode\s+\d+', "versionCode $VersionCode")
$gNew = [regex]::Replace($gNew, "versionName\s+'[^']*'", "versionName '$VersionName'")
$sNew = [regex]::Replace($s.text, '<string name="app_name">[^<]*</string>', '<string name="app_name">' + $AppName + '</string>')

# build.gradle 里的说明性注释若还写着旧包名，一并换掉（只动 // 开头的行，绝不碰代码）
if ($PackageId -ne $oldPkg) {
    $lg = $gNew -split "(?<=\n)"
    for ($i = 0; $i -lt $lg.Count; $i++) {
        $trim = $lg[$i].TrimStart()
        if ($trim.StartsWith('//') -and $lg[$i].Contains($oldPkg)) { $lg[$i] = $lg[$i].Replace($oldPkg, $PackageId) }
    }
    $gNew = $lg -join ''
}

# ── 5) 源码里的旧身份：注释里的旧包名 + 通知栏标题里的旧显示名 ──
$javaTouched = 0; $javaLines = 0
$javaTitle = @()
if (Test-Path $javaDir) {
    # 通知栏标题里的旧显示名（CastService 的常驻通知）：只动这一个字符串字面量
    $titleRe = 'setContentTitle\("([^"]*?) 运行中"\)'
    foreach ($f in (Get-ChildItem $javaDir -Filter *.java)) {
        $t = [System.IO.File]::ReadAllText($f.FullName)
        $bom = $t.StartsWith($BOM); if ($bom) { $t = $t.Substring(1) }
        $hit = 0
        if ($PackageId -ne $oldPkg -and $t.Contains($oldPkg)) {
            $lines = $t -split "(?<=\n)"
            for ($i = 0; $i -lt $lines.Count; $i++) {
                $trim = $lines[$i].TrimStart()
                if (($trim.StartsWith('*') -or $trim.StartsWith('//')) -and $lines[$i].Contains($oldPkg)) {
                    $lines[$i] = $lines[$i].Replace($oldPkg, $PackageId); $hit++
                }
            }
            $t = $lines -join ''
        }
        if ($AppName -ne $oldApp) {
            $tm = [regex]::Matches($t, $titleRe)
            if ($tm.Count -gt 1) { throw "通知栏标题匹配到 $($tm.Count) 处，不敢改：$($f.Name)" }
            if ($tm.Count -eq 1) {
                $t = $t.Replace($tm[0].Value, 'setContentTitle("' + $AppName + ' 运行中")')
                $javaTitle += $f.Name; $hit++
            }
        }
        if ($hit -gt 0) {
            $javaTouched++; $javaLines += $hit
            if (-not $DryRun) { Set-Kit $f.FullName $t }
        }
    }
}

# ── 6) PC 端 exe 身份（可选，只改 package.json 的两个字段）──
$pcChanged = @()
if (($PcAppId -or $PcProductName) -and (Test-Path $pcPkgPath)) {
    $pc = Get-Kit $pcPkgPath
    $t = $pc.text
    if ($PcAppId)       { $t = [regex]::Replace($t, '"appId"\s*:\s*"[^"]*"', ('"appId": "' + $PcAppId + '"')); $pcChanged += "appId → $PcAppId" }
    if ($PcProductName) { $t = [regex]::Replace($t, '"productName"\s*:\s*"[^"]*"', ('"productName": "' + $PcProductName + '"')); $pcChanged += "productName → $PcProductName" }
    if (-not $DryRun) { Set-Kit $pcPkgPath $t }
}

# ── 7) 报告（DryRun 到此为止）─────────────────────────────
Write-Host ''
Write-Host '== 将要改成'
Write-Host "   包名  : $oldPkg → $PackageId"
Write-Host "   显示名: $oldApp → $AppName"
Write-Host "   版本  : $oldName ($oldCode) → $VersionName ($VersionCode)"
if ($javaTouched -gt 0) { Write-Host "   Java 源码：$javaTouched 个文件 / $javaLines 处（只动注释行与通知栏标题）" }
if ($javaTitle.Count -gt 0) { Write-Host ('   通知栏标题 → ' + $AppName + ' 运行中（' + ($javaTitle -join '，') + '）') }
if ($pcChanged.Count -gt 0) { Write-Host ('   PC 端 exe 身份：' + ($pcChanged -join '，')) }
if ($DryRun) { Write-Host '== -DryRun：以上是全部改动，**没有写盘**'; return }

Set-Kit $gradlePath $gNew
Set-Kit $stringsPath $sNew
Write-Host '== 已写入 tools\cast-apk\app\build.gradle 与 res\values\strings.xml'

# ── 8) 打包（-NoBuild 只改源码，不打包）───────────────────
Write-Host ''
if ($NoBuild) {
    Write-Host '== -NoBuild：跳过打包'
    Write-Host '   ⚠ 源码已改但**没打新包**：头显上装着的仍是旧身份，要生效请去掉 -NoBuild 再跑一次'
    return
}
$apkSrc   = Join-Path $root 'tools\cast-apk\app\build\outputs\apk\debug\app-debug.apk'
$buildPs1 = Join-Path $root 'tools\cast-apk\build-apk.ps1'
$buildLog = Join-Path $root 'tools\cast-apk\build.log'
if (-not (Test-Path $buildPs1)) { throw "找不到打包脚本：$buildPs1" }
Write-Host '== 开始打包 APK（约 25~30 秒；gradle 全量日志落在 tools\cast-apk\build.log）…'
# 经 cmd 起独立进程，输出**不重定向**（直接打到本窗口，边跑边看）。两个坑：
#   ① 子进程（powershell / gradle）的 stderr 会进 PowerShell 的错误流，而本脚本是
#      $ErrorActionPreference='Stop' —— 不临时降级就会把 stderr 当终止性错误，
#      连「构建失败」都等不到就抛了。真正的判据只有 $LASTEXITCODE。
#   ② 一旦用管道接住输出（| Select-Object …），日志会被缓冲到进程结束才吐，看着像假死。
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& cmd /c "powershell -ExecutionPolicy Bypass -File `"$buildPs1`""
$buildCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($buildCode -ne 0) { throw "打包失败（exit code $buildCode），完整日志：$buildLog" }
if (-not (Test-Path $apkSrc)) { throw "打包自称成功但没有产物：$apkSrc" }

# ── 9) 用 aapt2 读产物的**真实身份**自证 ──────────────────
#   为什么必须自证：applicationId / versionName 写进的是 manifest，
#   构建缓存、产物路径写错、甚至「改了别的文件」都可能让构建照样 SUCCESS 而身份没变 ——
#   装到设备上才发现，现场白跑一轮。
if (-not (Test-Path $Aapt2)) { throw "找不到 aapt2：$Aapt2（可用 -Aapt2 <路径> 指定）" }
$badgeFile = Join-Path $env:TEMP 'rebrand-badging.txt'
& cmd /c "`"$Aapt2`" dump badging `"$apkSrc`" > `"$badgeFile`" 2>&1"
$badge = [System.IO.File]::ReadAllText($badgeFile)
if (-not $badge) { throw "aapt2 dump badging 没有输出，读不到产物身份" }
$mP      = [regex]::Match($badge, "package:\s+name='([^']*)'\s+versionCode='([^']*)'")
$mL      = [regex]::Match($badge, "application-label:'?([^'\r\n]*)'?")
$apkPkg  = $mP.Groups[1].Value
$apkCode = $mP.Groups[2].Value
$apkLab  = $mL.Groups[1].Value.Trim()
Write-Host ''
Write-Host '== 产物的真实身份（aapt2 dump badging）'
Write-Host "   包名  : $apkPkg"
Write-Host "   版本号: $apkCode"
Write-Host "   显示名: $apkLab"
$bad = @()
if ($apkPkg  -ne $PackageId)   { $bad += "包名不符：产物 $apkPkg ≠ 期望 $PackageId" }
if ($apkCode -ne $VersionCode) { $bad += "versionCode 不符：产物 $apkCode ≠ 期望 $VersionCode" }
if ($apkLab  -ne $AppName)     { $bad += "显示名不符：产物 $apkLab ≠ 期望 $AppName" }
if ($bad.Count -gt 0) {
    Write-Host '== ❌ 身份自证失败（源码改了，产物却不是新身份）：'
    $bad | ForEach-Object { Write-Host "     - $_" }
    throw 'APK 身份自证失败 —— 检查 tools\cast-apk\app\build.gradle；必要时删掉 app\build 重新构建'
}
Write-Host '== ✅ 身份自证通过'

# ── 10) 同步到交付目录 + 重算 SHA256 ──────────────────────
$apkMB = [math]::Round((Get-Item $apkSrc).Length / 1MB, 2)
$syncApk = $null; $sha = $null
if (-not $Sync -or -not (Test-Path $Sync)) {
    if ($Sync) { Write-Host "== ⚠ 交付目录不存在，跳过同步：$Sync" }
} else {
    # 交付文件名：默认沿用目录里已有的「头显端-*.apk」（不凭空多出一个孤儿包），
    # 目录里没有才用「头显端-<显示名>.apk」；也可用 -SyncName 直接指定。
    if ($SyncName) { $apkName = $SyncName }
    else {
        $exist = @(Get-ChildItem $Sync -Filter '头显端-*.apk' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
        if ($exist.Count -gt 0) { $apkName = $exist[0].Name } else { $apkName = '头显端-' + $AppName + '.apk' }
    }
    $syncApk = Join-Path $Sync $apkName
    # 改了包名 ⇒ 先把旧交付包归档（沿用 _旧包-<日期> 约定），否则同名覆盖会把旧包丢掉
    if ($PackageId -ne $oldPkg -and (Test-Path $syncApk)) {
        $bakDir = Join-Path $Sync ('_旧包-' + (Get-Date -Format 'yyyyMMdd'))
        if (-not (Test-Path $bakDir)) { New-Item -ItemType Directory -Path $bakDir -Force | Out-Null }
        $bak = Join-Path $bakDir ((Get-Date -Format 'HHmmss') + '-改名前-' + $oldPkg + '.apk')
        Copy-Item $syncApk $bak -Force
        Write-Host "== 旧交付包已归档：$bak"
    }
    Copy-Item $apkSrc $syncApk -Force
    $sha = (Get-FileHash $syncApk -Algorithm SHA256).Hash
    Write-Host ''
    Write-Host "== 交付包已更新：$syncApk"
    Write-Host "   大小  : $apkMB MB"
    Write-Host "   SHA256: $sha"
    $readme = Join-Path $Sync '使用说明.md'
    if (Test-Path $readme) {
        $r  = Get-Kit $readme
        $rt = [regex]::Replace($r.text, 'APK `[0-9A-Fa-f]{64}`', ('APK `' + $sha + '`'))
        $rt = [regex]::Replace($rt, '头显端 APK \*\*[0-9.]+ MB\*\*', ('头显端 APK **' + $apkMB + ' MB**'))
        if ($rt -eq $r.text) { Write-Host '   ⚠ 使用说明.md 里没找到那两行校验值，未改动 —— 请手动核对' }
        else { Set-Kit $readme $rt; Write-Host '   已更新 使用说明.md 里的 SHA256 与体积' }
    }
}

# ── 11) 汇总 + 交付前必读 ─────────────────────────────────
Write-Host ''
Write-Host '========================= 改完了 ========================='
Write-Host "  安装身份 : $PackageId"
Write-Host "  显示名   : $AppName"
Write-Host "  版本     : $VersionName ($VersionCode)"
if ($syncApk) {
    Write-Host "  交付包   : $syncApk"
    if ([System.IO.Path]::GetFileName($syncApk) -ne ('头显端-' + $AppName + '.apk')) {
        Write-Host '             （文件名沿用交付目录里已有的「头显端-*.apk」；想换名用 -SyncName 指定）'
    }
}
Write-Host ''
Write-Host '  ⚠ 1) 平台侧要重新登记：新包名必须出现在平台「游戏列表」里，否则平台'
Write-Host '        枚举不到、也拉不起来（它按包名枚举并 am start -n <包名>/.MainActivity）。'
Write-Host '        平台登记里的版本号也要一起改（平台是拿版本号认版本的）。'
Write-Host "  ⚠ 2) 头显上这是**全新应用**：旧包（$oldPkg）不会自动消失，两者可共存；"
Write-Host '        悬浮窗/后台弹出等权限要**重新授予一次**（偏好设置全丢），否则关局后顶不回平台客户端。'
Write-Host '  ⚠ 3) 若一并改了 PC 端 exe 的 appId/productName：安装目录与快捷方式名会变，'
Write-Host '        平台登记的 exe 路径要跟着改；改名不影响签名，但将来换 release keystore'
Write-Host '        会导致同包名也装不上，必须先卸载旧包。'
Write-Host '=========================================================='
