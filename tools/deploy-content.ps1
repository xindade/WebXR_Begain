#Requires -Version 5.1
<#
================================================================================
 deploy-content.ps1 —— 平台内容包一键部署（只传变化的文件）
================================================================================
做什么：
  1) 读本地配置 txt（含服务器密码）—— 默认 tools\cast-server\deploy-password.txt
  2) 跑 sync-content.js 重建内容包（除非 -NoSync）
  3) 拉服务器上现有清单，逐文件比 sha256 → **只上传不一样的那几个**
  4) 重启服务 + 回读清单自动验收（逐文件 sha256 复核）

用法（在项目根执行）：
  powershell -ExecutionPolicy Bypass -File tools\deploy-content.ps1 -DryRun    # 只看差异，不传不重启
  powershell -ExecutionPolicy Bypass -File tools\deploy-content.ps1            # 一键部署
  powershell -ExecutionPolicy Bypass -File tools\deploy-content.ps1 -InstallKey   # 顺手装公钥，以后免密码
  powershell -ExecutionPolicy Bypass -File tools\deploy-content.ps1 -Force -Ver 1.0.1

参数：
  -Ver <版本号>   发布哪个版本（缺省 = content\manifest.json 的 current）
  -ConfigFile     指定配置文件（缺省按下面顺序找）
  -NoSync         不跑 sync-content.js（直接用 content\ 里现有的）
  -NoRestart      上传后不重启服务
  -Force          忽略差异，强制全量重传 + 重发 manifest.json
  -DryRun         只打印差异计划，不做任何改动（不需要密码）
  -InstallKey     部署成功后，把本机 ~\.ssh\id_rsa.pub 装到服务器（之后可免密码）

配置文件格式（txt，UTF-8；# 或 ; 开头是注释；`键=值` 或「只写一行裸密码」都能认）：
  host=webvr123.site
  user=root
  port=22
  password=你的服务器root密码
  remote_root=/opt/webvr123
  service=webvr123
  manifest_key=webxr-manifest
  url=https://webvr123.site

⚠ 密码文件已在 .gitignore 里，**绝不要**把它提交 / 发给别人。
⚠ 本机没有 sshpass / pscp，脚本用 OpenSSH 的 SSH_ASKPASS 机制喂密码（已实测可用）：
  密码写进临时文件，再由一个临时 askpass.cmd `type` 出来；脚本结束（含失败）即删除。
================================================================================
#>
[CmdletBinding()]
param(
    [string]$Ver,
    [string]$ConfigFile,
    [switch]$NoSync,
    [switch]$NoRestart,
    [switch]$Force,
    [switch]$DryRun,
    [switch]$InstallKey
)

$ErrorActionPreference = 'Stop'
$script:askpassDir = $null

function Say  { param([string]$m) Write-Host $m }
function Ok   { param([string]$m) Write-Host $m -ForegroundColor Green }
function Warn { param([string]$m) Write-Host $m -ForegroundColor Yellow }

function Cleanup {
    if ($script:askpassDir -and (Test-Path -LiteralPath $script:askpassDir)) {
        Remove-Item -LiteralPath $script:askpassDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    $script:askpassDir = $null
}

function Die {
    param([string]$m)
    Write-Host ''
    Write-Host "[失败] $m" -ForegroundColor Red
    Cleanup
    exit 1
}

# 意外终止性错误也要清掉临时密码目录
trap {
    Write-Host ''
    Write-Host ("[失败] 未预期的错误（第 " + $_.InvocationInfo.ScriptLineNumber + " 行）：" + $_.Exception.Message) -ForegroundColor Red
    Cleanup
    exit 1
}

# ⚠ $ErrorActionPreference='Stop' 下，原生命令往 stderr 写一行就会被当成终止性错误 ——
#   ssh/scp/curl 的告警与错误提示全走 stderr，故这两层包装必须把 EAP 临时降级，
#   统一用 $LASTEXITCODE 判定成败（否则「密码错」会以异常形式炸掉，还跳过清理）。
function Invoke-Live {
    param([string]$exe, [string[]]$argv)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $exe @argv 2>&1
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prev }
    if ($null -eq $code) { $code = 1 }
    # ⚠ 必须 Write-Host（不能直接输出）：否则子进程的 stdout 会混进返回值，
    #   函数就变成「返回一个数组」，调用方拿它跟 0 比较永远判成失败（第二版踩过）。
    foreach ($line in @($out)) { Write-Host "$line" }
    return $code
}

function Invoke-Native {
    param([string]$exe, [string[]]$argv)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $exe @argv 2>&1
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prev }
    return @{ code = $code; out = ([string]::Join("`n", @($out | ForEach-Object { "$_" }))).Trim() }
}

$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$projRoot    = (Resolve-Path (Join-Path $scriptDir '..')).Path
$contentRoot = Join-Path $projRoot 'tools\cast-server\content'
$syncScript  = Join-Path $projRoot 'tools\cast-server\sync-content.js'

# ---------------------------------------------------------------- 配置
function Find-Config {
    if ($ConfigFile) {
        if (-not (Test-Path -LiteralPath $ConfigFile)) { Die "指定的配置文件不存在：$ConfigFile" }
        return (Resolve-Path -LiteralPath $ConfigFile).Path
    }
    $cands = @(
        (Join-Path $projRoot 'tools\cast-server\deploy-password.txt'),
        (Join-Path $projRoot 'deploy-password.txt'),
        (Join-Path $env:USERPROFILE '.webvr123\deploy-password.txt')
    )
    foreach ($c in $cands) { if (Test-Path -LiteralPath $c) { return (Resolve-Path -LiteralPath $c).Path } }
    return $null
}

function Read-Config {
    param([string]$path)
    $cfg = @{
        host = 'webvr123.site'; user = 'root'; port = 22
        remote_root = '/opt/webvr123'; service = 'webvr123'
        manifest_key = 'webxr-manifest'; url = ''; password = ''
    }
    if (-not $path) { return $cfg }
    # ⚠ 用 .NET 读：PS 5.1 的 Get-Content -Encoding UTF8 会把无 BOM 的 UTF8 当 ANSI 读
    foreach ($raw in [System.IO.File]::ReadAllLines($path)) {
        $line = $raw.Trim()
        if (-not $line) { continue }
        if ($line.StartsWith('#') -or $line.StartsWith(';') -or $line.StartsWith('//')) { continue }
        $eq = $line.IndexOf('=')
        if ($eq -lt 0) { $cfg.password = $line; continue }   # 只写一行裸密码
        $k = $line.Substring(0, $eq).Trim().ToLower()
        $v = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
        switch ($k) {
            'password'     { $cfg.password = $v }
            'pass'         { $cfg.password = $v }
            'host'         { $cfg.host = $v }
            'user'         { $cfg.user = $v }
            'port'         { if ($v -match '^\d+$') { $cfg.port = [int]$v } }
            'remote_root'  { $cfg.remote_root = $v.TrimEnd('/') }
            'root'         { $cfg.remote_root = $v.TrimEnd('/') }
            'service'      { $cfg.service = $v }
            'manifest_key' { $cfg.manifest_key = $v }
            'url'          { $cfg.url = $v.TrimEnd('/') }
            default        { Warn ("  配置里未知的键（已忽略）：$k") }
        }
    }
    return $cfg
}

$cfgPath = Find-Config
$cfg = Read-Config $cfgPath
if ($env:WEBVR_DEPLOY_PASSWORD) { $cfg.password = $env:WEBVR_DEPLOY_PASSWORD }
if ($env:WEBVR_DEPLOY_HOST)     { $cfg.host     = $env:WEBVR_DEPLOY_HOST }
if ($env:WEBVR_DEPLOY_USER)     { $cfg.user     = $env:WEBVR_DEPLOY_USER }
if (-not $cfg.url) { $cfg.url = 'https://' + $cfg.host }
$cfg.url = $cfg.url.TrimEnd('/')

Say ''
Say '============================================================'
Say ' 平台内容包部署 —— WebXR_Begain_Platform'
Say '============================================================'
if ($cfgPath) { Say (" 配置    : " + $cfgPath) } else { Warn ' 配置    : 未找到 deploy-password.txt（走默认 host；上传前必须有密码）' }
Say (" 服务器  : {0}@{1}:{2}   {3}" -f $cfg.user, $cfg.host, $cfg.port, $cfg.remote_root)
Say (" 站点    : " + $cfg.url)
if ($DryRun) { Warn ' 模式    : DryRun —— 只列差异，不传不重启' }

# ---------------------------------------------------------------- 版本号
$localIndexPath = Join-Path $contentRoot 'manifest.json'
$ver = $Ver
if (-not $ver) {
    if (Test-Path -LiteralPath $localIndexPath) {
        try { $ver = [string]((Get-Content -LiteralPath $localIndexPath -Raw) | ConvertFrom-Json).current } catch { $ver = '' }
    }
}
if (-not $ver) { Die "拿不到版本号：先跑 node tools\cast-server\sync-content.js --ver <版本号>，或用 -Ver 指定" }
Say (" 版本    : " + $ver)

# ---------------------------------------------------------------- 重建内容包
if (-not $NoSync) {
    if (-not (Test-Path -LiteralPath $syncScript)) { Die "找不到 $syncScript" }
    Say ''
    Say ("== 1) 重建内容包：node sync-content.js --ver " + $ver)
    $rc = Invoke-Live 'node' @($syncScript, '--ver', $ver)
    if ($rc -ne 0) {
        Die ("sync-content.js 失败（exit $rc）—— 检查 node 是否在 PATH 上、脚本是否存在：`n      " + $syncScript)
    }
}

$verDir = Join-Path $contentRoot $ver
if (-not (Test-Path -LiteralPath $verDir)) { Die "本地没有这个版本目录：$verDir（先跑 sync-content.js）" }

$local = @{}
$prefix = (Resolve-Path -LiteralPath $verDir).Path.TrimEnd('\') + '\'
foreach ($f in (Get-ChildItem -LiteralPath $verDir -Recurse -File)) {
    $rel = $f.FullName.Substring($prefix.Length).Replace('\', '/')
    $local[$rel] = @{
        abs  = $f.FullName
        size = $f.Length
        sha  = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower()
    }
}

# ---------------------------------------------------------------- 拉服务器清单
$manifestUrl = "{0}/api/manifest?key={1}&ver={2}" -f $cfg.url, $cfg.manifest_key, $ver
Say ''
Say ("== 2) 拉服务器清单（比 sha256 找差异）：" + $manifestUrl)
$r = Invoke-Native 'curl.exe' @('-s', '--max-time', '25', $manifestUrl)
$raw = $r.out
if ([string]::IsNullOrWhiteSpace($raw)) { Die "拉不到服务器清单（网络不通 / 域名解析失败）：$manifestUrl" }
$srv = $null
try { $srv = $raw | ConvertFrom-Json } catch {
    Die ("服务器响应不是合法 JSON：" + $raw.Substring(0, [Math]::Min(200, $raw.Length)))
}

$serverFiles = @{}
$isNewVersion = $false
if ($srv.ok -eq $true) {
    foreach ($f in $srv.files) { $serverFiles[[string]$f.path] = $f }
    Say ("   服务器上：{0} 个文件 / {1} 字节" -f $srv.count, $srv.bytes)
} elseif ("$($srv.why)" -eq 'noContentVersion') {
    $isNewVersion = $true
    Warn ("   服务器上还没有版本 " + $ver + " → 本次全量上传")
} else {
    Die ("服务器拒绝了清单请求：" + $raw)
}

# ---------------------------------------------------------------- 差异计划
$toUpload = New-Object System.Collections.ArrayList
Say ''
Say ' 动作    文件'
Say ' ------  ------------------------------------------------------------'
foreach ($p in ($serverFiles.Keys | Sort-Object)) {
    if (-not $local.ContainsKey($p)) {
        Warn (" 本地缺失 {0}   ← 服务器有、本地没有（不删远端，仅提示）" -f $p)
        continue
    }
    if ($local[$p].sha -ne [string]$serverFiles[$p].sha256) {
        Write-Host (" 更新     {0}" -f $p) -ForegroundColor Yellow
        [void]$toUpload.Add($p)
    } else {
        Write-Host (" 一致     {0}" -f $p) -ForegroundColor DarkGray
    }
}
foreach ($p in ($local.Keys | Sort-Object)) {
    if ($p -eq 'ver.json') { continue }          # 发布元数据，单独处理
    if (-not $serverFiles.ContainsKey($p)) {
        Write-Host (" 新增     {0}   ← 本地有、服务器没有" -f $p) -ForegroundColor Yellow
        [void]$toUpload.Add($p)
    }
}

# 元数据：内容变了就重发 ver.json；current 指针对不上（或全量）就重发 manifest.json
$metaUpload = New-Object System.Collections.ArrayList
if ($toUpload.Count -gt 0 -or $Force) { [void]$metaUpload.Add('ver.json') }
$needIndex = [bool]($Force -or $isNewVersion)
if (-not $needIndex) {
    $h = Invoke-Native 'curl.exe' @('-s', '--max-time', '20', ($cfg.url + '/api/health'))
    try {
        $hj = $h.out | ConvertFrom-Json
        if ("$($hj.content.current)" -ne $ver) { $needIndex = $true }
    } catch { $needIndex = $true }
}
if ($needIndex) { [void]$metaUpload.Add('manifest.json') }

$allUpload = @(@($toUpload) + @($metaUpload) | Sort-Object -Unique)
Say ''
if ($allUpload.Count -eq 0) {
    Ok ("== 3) 服务器与本机完全一致（{0} 个文件），无需上传" -f $local.Count)
} else {
    Warn ("== 3) 需要上传：{0} 个内容文件 + {1} 个元数据 = 共 {2} 个" -f $toUpload.Count, $metaUpload.Count, $allUpload.Count)
}

if ($DryRun) { Say ''; Ok '== DryRun 结束（没有做任何改动）'; Cleanup; exit 0 }

# ---------------------------------------------------------------- 免交互 ssh / scp
$sshOpts = @(
    '-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15',
    '-o', 'LogLevel=ERROR', '-p', "$($cfg.port)"
)
$scpOpts = @(
    '-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15',
    '-o', 'LogLevel=ERROR', '-P', "$($cfg.port)"
)
$target = "{0}@{1}" -f $cfg.user, $cfg.host

function Use-Password {
    param([string]$password)
    $dir = Join-Path $env:TEMP ('webvr-deploy-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $pwFile = Join-Path $dir 'pw.txt'
    [System.IO.File]::WriteAllText($pwFile, ($password + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    $cmdFile = Join-Path $dir 'askpass.cmd'
    $body = '@echo off' + "`r`n" + 'type "' + $pwFile + '"' + "`r`n"
    [System.IO.File]::WriteAllText($cmdFile, $body, (New-Object System.Text.UTF8Encoding($false)))
    $env:SSH_ASKPASS = $cmdFile
    $env:SSH_ASKPASS_REQUIRE = 'force'
    if (-not $env:DISPLAY) { $env:DISPLAY = 'localhost:0' }   # 部分构建要求非空 DISPLAY 才走 askpass
    return $dir
}

function Invoke-Remote {
    param([string]$cmd)
    return (Invoke-Native 'ssh' (@($sshOpts) + @($target, $cmd)))
}

if ($allUpload.Count -gt 0) {
    if (-not $cfg.password) {
        Die ("需要密码：把 password=<服务器root密码> 写进 tools\cast-server\deploy-password.txt" +
             "`n      （模板：tools\cast-server\deploy-password.example.txt）")
    }
    if ($cfg.password -match "(在这里填|your.?password|你的服务器root密码)") {
        Die ("密码还是占位文字，没换成本机真实密码：`n      " + $cfgPath)
    }
    $script:askpassDir = Use-Password $cfg.password

    Say ''
    Say '== 4) 连接测试 …'
    $r = Invoke-Remote 'echo deploy-ok'
    if ($r.code -ne 0 -or $r.out -notmatch 'deploy-ok') {
        Die ("ssh 连不上 / 密码不对：`n" + $r.out +
             "`n      → 检查 deploy-password.txt 里的 password；或先人工 ssh 一次确认网络与账号。")
    }
    Ok '   连接 OK'

    $dirs = @()
    foreach ($p in $allUpload) {
        if ($p -eq 'manifest.json') { $dirs += "$($cfg.remote_root)/content"; continue }
        $slash = $p.LastIndexOf('/')
        if ($slash -lt 0) { $dirs += "$($cfg.remote_root)/content/$ver" }
        else { $dirs += ("$($cfg.remote_root)/content/$ver/" + $p.Substring(0, $slash)) }
    }
    $dirs = @($dirs | Sort-Object -Unique)
    $mk = 'mkdir -p ' + (($dirs | ForEach-Object { "'" + $_ + "'" }) -join ' ')
    $r = Invoke-Remote $mk
    if ($r.code -ne 0) { Die ("远端建目录失败：`n" + $r.out) }

    Say ''
    Say ("== 5) 上传 " + $allUpload.Count + " 个文件 …")
    $i = 0
    foreach ($p in $allUpload) {
        $i++
        if ($p -eq 'manifest.json') {
            $localAbs  = $localIndexPath
            $remoteAbs = "$($cfg.remote_root)/content/manifest.json"
        } else {
            $localAbs  = $local[$p].abs
            $remoteAbs = "$($cfg.remote_root)/content/$ver/$p"
        }
        Say ("   [{0}/{1}] {2}" -f $i, $allUpload.Count, $p)
        $r = Invoke-Native 'scp' (@($scpOpts) + @($localAbs, ("{0}:{1}" -f $target, $remoteAbs)))
        if ($r.code -ne 0) { Die ("scp 失败：$p`n" + $r.out) }
    }
    Ok '   上传完成'
} else {
    Say ''
    Say '== 4) 无内容变化 → 跳过连接与上传'
}

# ---------------------------------------------------------------- 重启
if ($allUpload.Count -gt 0 -and -not $NoRestart) {
    Say ''
    Say ("== 6) 重启服务 " + $cfg.service)
    $r = Invoke-Remote ("systemctl restart " + $cfg.service)
    if ($r.code -ne 0) { Die ("重启失败：`n" + $r.out) }
    Start-Sleep -Seconds 2
    $r = Invoke-Remote ("systemctl is-active " + $cfg.service)
    if ($r.out -notmatch 'active') { Die ("服务状态异常：" + $r.out) }
    Ok ("   服务状态：" + $r.out)
}

# ---------------------------------------------------------------- 验收
Say ''
Say '== 7) 验收（回读服务器清单，逐文件 sha256 复核）'
Start-Sleep -Seconds 2
$vr = Invoke-Native 'curl.exe' @('-s', '--max-time', '25', $manifestUrl)
try { $srv2 = $vr.out | ConvertFrom-Json } catch {
    Die ("验收拉清单失败：" + $vr.out.Substring(0, [Math]::Min(200, $vr.out.Length)))
}
if ($srv2.ok -ne $true) { Die ("验收失败，服务器返回：" + $vr.out) }

$map2 = @{}
foreach ($f in $srv2.files) { $map2[[string]$f.path] = $f }
$bad = @()
$checked = 0
foreach ($p in ($local.Keys | Sort-Object)) {
    if ($p -eq 'ver.json') { continue }
    if (-not $map2.ContainsKey($p)) { $bad += ($p + '（服务器上没有）'); continue }
    $checked++
    if ($local[$p].sha -ne [string]$map2[$p].sha256) { $bad += ($p + '（sha256 不一致）') }
}
$localVer = $null
$localVerPath = Join-Path $verDir 'ver.json'
if (Test-Path -LiteralPath $localVerPath) {
    try { $localVer = (Get-Content -LiteralPath $localVerPath -Raw) | ConvertFrom-Json } catch { $localVer = $null }
}

Say ("   服务器：ver={0}  count={1}  bytes={2}" -f $srv2.ver, $srv2.count, $srv2.bytes)
if ($localVer) { Say ("   本机  ：ver={0}  count={1}  bytes={2}" -f $localVer.ver, $localVer.count, $localVer.bytes) }
if ($bad.Count -eq 0) {
    Ok ("   ✅ 逐文件核对通过：{0} 个文件全部一致" -f $checked)
} else {
    Warn ("   ⚠ 有 {0} 处不一致：" -f $bad.Count)
    $bad | ForEach-Object { Warn ("      - " + $_) }
}

# ---------------------------------------------------------------- 免密码（可选）
if ($InstallKey) {
    Say ''
    Say '== 8) 安装本机公钥（之后可免密码）'
    $pub = Join-Path $env:USERPROFILE '.ssh\id_rsa.pub'
    if (-not (Test-Path -LiteralPath $pub)) {
        Warn ("   没有找到公钥：" + $pub + " → 跳过（先跑 ssh-keygen -t rsa）")
    } else {
        $key = ([System.IO.File]::ReadAllText($pub)).Trim()
        $cmd = "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && " +
               "chmod 600 ~/.ssh/authorized_keys && " +
               "grep -qxF '$key' ~/.ssh/authorized_keys || echo '$key' >> ~/.ssh/authorized_keys"
        $r = Invoke-Remote $cmd
        if ($r.code -ne 0) {
            Warn ("   安装失败：" + $r.out)
        } else {
            $pb = Invoke-Native 'ssh' @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                                        '-o', 'StrictHostKeyChecking=accept-new',
                                        '-p', "$($cfg.port)", $target, 'echo key-ok')
            if ($pb.out -match 'key-ok') { Ok '   公钥可用 → 以后不带密码也能部署' }
            else { Warn '   公钥已写入但免密登录仍失败（检查服务器 sshd 的 PubkeyAuthentication）' }
        }
    }
}

Cleanup
Say ''
Ok '== 全部完成'