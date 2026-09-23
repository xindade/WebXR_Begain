# VR+ 平台版本号实现

> 主题：让 VR+ 平台（及其配套 `查看游戏版本号.bat`）能正确显示我们打包的 APK 版本号
> （DeepmindHacker / 2.0.5），而不是「查无此包」或隐身。
> 本文档记录**真因**与**唯一改动点**，供后续复现 / 移植直接照抄。

---

## 1. 目标

- 平台侧能稳定读到我们头显游戏包的版本号 `2.0.5`（及内部 `versionCode 205`）。
- 平台客户端启动游戏后，PC 端日志的 `packagesinfo` 上报清单里出现 `com.GoodNet.DeepmindHacker-2.0.5`。
- 配套 `查看游戏版本号.bat`（`pkgName15=com.GoodNet.DeepmindHacker`）能 `dumpsys` 出 `versionName=2.0.5`。

---

## 2. 原理

平台枚举头显侧已安装游戏版本号，**按包名（`applicationId`）匹配**，不认游戏名 / 显示名 / APK 文件名。
存在两条并存的取版本路径：

### 2.1 启动器前缀扫描（运行时节）
头显上的 GoodNet 启动器（`com.GoodNet.LauncherClient`）会**扫描头显已安装的 `com.GoodNet.*` 包**，
当平台下发 `{"cmd":"packagesinfo",...}` 时上报清单，形如：
```
com.GoodNet.CQB-1.6.8;com.GoodNet.VR_CodeDBPVE2-1.0.9;com.GoodNet.LauncherClient-1.0.1.7;
```
**关键证据**：该清单里含有 `com.GoodNet.VR_CodeDBPVE2`，而它**不在** `查看游戏版本号.bat` 的 15 个硬编码游戏列表里
→ 证明启动器是**前缀扫描已装包**，不是读一份固定列表。所以只要我们的包名落在 `com.GoodNet.*` 前缀下、且已安装，
启动器就会自动带上它。

### 2.2 `dumpsys` 直查（手动 / 批处理）
`查看游戏版本号.bat` 第 68 行：
```bat
adb -d shell dumpsys package <pkg> | findstr versionName
```
即按包名直接问 Android 系统「这个包装了没、版本多少」。平台后台的「查看游戏版本号」功能同理。

### 2.3 平台侧游戏清单（登记项）
平台 `查看游戏版本号.bat` 用 `set pkgName15=com.GoodNet.DeepmindHacker` 登记了我们的游戏，
但**这只是「要查哪个包名」的配置**，并不等于包真的存在——包没按这个名字装，查询就是空。

### 2.4 与「TCP packagesinfo 握手」的区分（重要，避免走弯路）
早期曾误判「要在我们 App 内实现 TCP `packagesinfo`/`connect` 上报」。实测证伪：
- 平台 ↔ 启动器的 `packagesinfo` 是启动器**主动扫描已装包**后回的，不是每个游戏自己上报；
- 我们游戏是跑在 **PICO 浏览器**里的网页，没有独立的、会被扫描到的系统包上下文，版本号只由 **APK 的 `applicationId` + `versionName`** 决定。
→ **无需实现任何 TCP 握手**，纯包名 / 版本号匹配即可。

---

## 3. 关键实现

唯一改动点（APK 原生层，改后必须重打包重装）：

`tools/cast-apk/app/build.gradle`：
```gradle
android {
    namespace 'com.local.webxrcast'                       // ① Java 包名 / 源码目录，保持不动
    compileSdk 34

    defaultConfig {
        applicationId 'com.GoodNet.DeepmindHacker'        // ② 安装身份：平台/启动器/dumpsys 按此匹配（原为 com.local.webxrcast）
        minSdk 24
        targetSdk 34
        versionCode 205                                    // ③ 内部版本号（平台 tends 用 versionName 展示）
        versionName '2.0.5'                                // ④ 平台显示的版本号
        ...
    }
    ...
}
```

`strings.xml`（仅显示名，不影响按包名查询，但一并记下避免混淆）：
```xml
<string name="app_name">DeepmindHacker</string>
```

**要点**
- `<applicationId>` 才是**安装身份**——决定 `dumpsys`、启动器前缀扫描、平台查询命中的就是它。
- `<namespace>` 是 **Java 包名 / 源码目录**，与安装身份无关，**不要为改名而改 namespace**（改了要挪 `com/local/webxrcast` 目录，徒增风险）。
- 改 `applicationId` 后，`com.local.webxrcast` 与 `com.GoodNet.DeepmindHacker` 是**两个不同 App**：头显上旧包必须卸载，否则并存会让平台查到旧包或混乱。
- Manifest 无需改动：本项目 `AndroidManifest.xml` 没有硬编码 `authorities`/`provider`，`.MainActivity` 走 namespace 相对路径，改 `applicationId` 不会冲突。

---

## 4. 参数表

| 项 | 值 | 说明 |
|---|---|---|
| `applicationId`（安装身份） | `com.GoodNet.DeepmindHacker` | 平台 / 启动器 / `dumpsys` 按此匹配，**唯一必须改的字段** |
| `namespace`（Java 包名） | `com.local.webxrcast` | 源码目录，不影响安装，保持不动 |
| `versionName` | `2.0.5` | 平台显示的版本号 |
| `versionCode` | `205` | 内部版本号（整数，建议 = 主版本*100 + 次版本*10 + 修订） |
| `app_name`（显示名） | `DeepmindHacker` | 仅 UI 文本，不影响按包名查询 |
| 平台登记包名（`查看游戏版本号.bat` 的 `pkgName15`） | `com.GoodNet.DeepmindHacker` | 平台侧「要查哪个包」的配置，需与 `applicationId` 一致 |

---

## 5. 踩坑（多次调试点）

| 现象 | 真因 | 结论 |
|---|---|---|
| 平台看不到版本号 | APK 实际 `applicationId=com.local.webxrcast`，平台按 `com.GoodNet.DeepmindHacker` 查 → 查无 → 隐身 | 改 `applicationId` 即可，与协议无关 |
| 误判为「需实现 TCP `packagesinfo` 握手」 | 早期看到启动器上报 GoodNet 全家桶，以为每个游戏要自己上报；实测启动器是前缀扫描已装 `com.GoodNet.*` 包，且 bat 用 `dumpsys` 直查 | 无需 TCP 握手，纯包名匹配 |
| 头部混淆 `applicationId` 与 `namespace` | 以为改 `namespace` 或 Java `package` 才够 | `applicationId` 才是安装身份；改 `namespace` 要挪目录，无必要 |
| 改包名后平台仍显示旧版 | 旧包 `com.local.webxrcast` 未卸载，与新包并存 | 装新包前先 `adb uninstall com.local.webxrcast` |
| 平台 PC 日志 `获取steamvr版本号失败` | 平台 PC 端自检 SteamVR 版本，与头显包无关 | 干扰信息，可忽略 |

---

## 6. 验证方法

### 6.1 构建产物校验（决定性）
```bash
aapt dump badging app-debug.apk | grep "^package:"
# 期望：package: name='com.GoodNet.DeepmindHacker' versionCode='205' versionName='2.0.5'
```

### 6.2 头显本地自检
```bash
adb shell dumpsys package com.GoodNet.DeepmindHacker | findstr versionName
# 期望：versionName=2.0.5
```

### 6.3 平台侧验证
- 跑 `查看游戏版本号.bat`（其 `pkgName15=com.GoodNet.DeepmindHacker`）→ 应显示 `2.0.5`。
- 平台客户端启动游戏后，PC 端日志 `ReceiveNetworkMessage` 的 `packagesinfo` 含 `com.GoodNet.DeepmindHacker-2.0.5`
  （实测日志行示例：`{"cmd":"packagesinfo","msgSign":"1","roomCode":"L","roomIndex":"2","msgData":"...;com.GoodNet.DeepmindHacker-2.0.5;"}`）。

### 6.4 部署步骤
1. 头显先卸旧包：`adb uninstall com.local.webxrcast`。
2. 装新包：`adb install -r app-debug.apk`。
3. 按 6.2 / 6.3 验证。

---

## 7. 关联文档

- 与本文档配套的「启动 / 关闭 / 连接 PC 直播端」链路问题，见 `docs/cast-implementation-and-packaging.md` 与 `docs/cast-architecture.md`。
- 打包形态与重打包边界：见 `docs/tech/05-游戏打包方式（EXE与APK）.md`（改 `build.gradle` 属于改 APK Java 工程，必须重打包）。


---

## 8. 启动 / 关闭链路实测结论（2026-09-16，全量 logcat 钉死）

> 本节回答两个长期没查清的问题：**「客户端启动游戏后进 VR 两三秒被弹出（用户报『闪退』）」** 与
> **「平台关不掉游戏」**。两者的根都不在游戏侧，而在**客户端 ↔ 启动器**这条通道上。

### 8.1 三个端各自的通道（别再混）

| 通道 | 方向 | 载体 | 报文 |
|---|---|---|---|
| ① 启动器控制通道 | 平台客户端(PC) → 头显 | TCP → `com.GoodNet.LauncherClient`（Unity） | `{"cmd":"start"/"kill"/"copyfile", "msgData":"am start ... / am force-stop ..."}` |
| ② 启动器回报通道 | 头显 → 平台客户端 | UDP → PC | `{"cmd":"logcat","msgSign":"1","roomCode":"L","roomIndex":"N","msgData":"L-1 ..."}` |
| ③ 游戏 ↔ 平台控制通道 | 双向 | UDP `51234`(上行) / `51124`(下行) | 握手裸字节 `0x01`；业务命令 JSON `{"cmd":N}` |

**关键**：**我们发的 cmd3 走 ③，客户端「启动/关闭」走 ①**。所以「apk 已发 cmd3」并不能让客户端停止重发
`am start` —— 排查「反复拉起」时必须同时看 ① 的日志（`I/Unity: ==ReceiveNetworkMessage===`、
`I/System.out: ===ProcessRecvMessage：`）。

### 8.2 实测时序（castlog6.txt，新包，APK 侧完全健康）

APK 侧全程正常：心跳 5s 一条 `8080=true / 游戏页 age≈800ms / sLaunched=true`，无 `FATAL`、无 `Killing`、
无心跳中断（pid 不变）。但头显那侧：

```
20:54:09.897  Unity  ===ProcessRecvMessage：start am start --user 0 -n com.GoodNet.DeepmindHacker/.MainActivity -d 192.168.31.228
20:54:09.898  Unity  ==OpenGame==com.GoodNet.DeepmindHacker===192.168.31.228
20:54:09.899  ATM    START u0 {... cmp=com.GoodNet.DeepmindHacker/com.local.webxrcast.MainActivity} from uid 10055
20:54:09.918  XRShell CODE_WIN_NEW_SURFACE windowId:32 ...        ← 新建 2D 面板
20:54:09.90x  PxrAppSplashManager ActivityStartingListener packageName == com.GoodNet.DeepmindHacker
20:54:10.002  Unity  ==ReceiveNetworkMessage===...{"cmd":"kill", "msgData":"am force-stop --user 0 com.GoodNet.DeepmindHacker"}
20:54:10.004  Unity  UdpSend →PC {"cmd":"logcat",...,"msgData":"L-1 客户端收到关闭游戏消息  am force-stop ..."}
20:54:29.901  Unity  ===ProcessRecvMessage：start ...   ← **距上次 20.004 秒**，又重拉一次
20:54:29.94x  XRShell report window num event:0 app windows       ← 面板全销毁，画面回落
20:54:41.097  Unity  ===ProcessRecvMessage：kill ... / "L-1 had received cmd kill"
```

**结论**：
1. **客户端每 20.004s 重发一次 `start`**。每次 `am start` 都会把本 App 顶到前台 → 新建面板 + 弹启动闪屏 →
   浏览器里的游戏页 / XR 沉浸会话被压下去。玩家「进 VR 两三秒被弹出」= 正好撞上这一次重拉
   （第一次拉起到玩家点「进入 VR」通常 ~17s）。
2. **`kill` 到了但没执行**：客户端确实发了 `am force-stop`，启动器也回 `had received cmd kill`，
   但它的 `close game path = ` 是**空的**（`open game path = ... , close game path = , platformIP =`）→
   平台侧没配关闭路径 → APK 从未被杀（心跳不断即证据）= **「平台关不掉游戏」的真因**。
3. **配置下发失败**：同批 `copyfile` 的目标是
   `/storage/emulated/0/Android/data/com.GoodNet.DeepmindHacker/files/setup.xml`，
   报 `==CopyFile error2 : ... open failed: ENOENT`。Android **只有 App 调用过 `getExternalFilesDir()`
   之后才会创建 `.../Android/data/<pkg>/files`** → 客户端「先配置、再启动」的整套流程永远处于失败态，
   极可能就是它每 20s 重发整批（含 `am start`）的原因。

### 8.3 对应处置（都在我们可控的一侧）

| 处置 | 位置 | 说明 |
|---|---|---|
| 启动即创建外部私有目录 | `MainActivity.probePlatformDir()` | `getExternalFilesDir(null)` 一行建出目录，并把目录内容 / `setup.xml` 前 1KB 打日志 —— 既消 ENOENT，又能看到平台下发的配置 |
| 平台驱动的启动做到「零界面」 | `MainActivity.platformDriven` + `finishPlatformActivity()` | intent 带 `-d` 即平台驱动：`onCreate` 里 `platformDriven && sLaunched && isGamePageAlive()` 时不 `setContentView`、立即 `finish()`；且**每次平台驱动启动成功后也 finish 掉配置页**（否则 Activity 实例常驻，它那块面板每 20s 被重新显示一次）。手动点图标（无 `-d`）仍给完整配置页 |
| 看清平台下行 | `VRPlusLink.recvLoop` | 下行日志由 `Log.d` 提到 `Log.i`（Debug 级常被丢弃 → 日志里一条 `← 平台` 都没有，无法判断平台是否回过我们） |

### 8.4 排查清单（下次复现先看这几行）

```bash
adb logcat -c
adb logcat -v time > d:/castlog.txt        # ★ 全量，不要 -s
# 走一遍「客户端启动 → 进 VR → 关不掉」
```
- `Unity: ==ProcessRecvMessage：start` 出现两次且间隔 ≈20s → 客户端在重发（还没被其判定为「已启动」）
- `XRShell: CODE_WIN_NEW_SURFACE` 随重拉出现 → 面板确实在抢前台（本 App 的 Activity 被拉起）
- `copyfile` / `error2` / `ENOENT` → 外部目录未建（见 8.3 第一行）
- `close game path = ` 为空 → 关闭链路在平台/启动器侧就是坏的，改不了我们 App


---

## 9. 设备侧标准启动链路（2026-09-16，用「正常游戏」日志逐行对齐）

> 素材：`F:/desk/PC主控.log`（平台主控）、`G:/01_Work/DXGames3/LauncherClient-1.0.1.7/DebugLog/客户端.log`
> （启动器）、**`G:/01_Work/DXGames3/DeepmindHacker-2.0.4/Log/2026-09-16-21-08-33.log`（PC 版游戏自己的
> Unity 日志）**——最后这份是最有价值的：它把「游戏侧该做什么」写成了流水账。

### 9.1 三方各自在干什么（正常一次启动）

```
平台主控(192.168.31.237)              启动器(设备工控机 .228)            游戏(DeepmindHacker.exe)
────────────────────────────────────────────────────────────────────────────────────────────
                                       监听 TCP
收到 connect/packagesinfo ────────────►
◄──── packagesinfo: DeepmindHacker-2.0.4;LauncherClient-1.0.1.7;...
发 connectsuccess(msgData:"2",hideUI:"1") ─►
发 copyfile（下发 setup.xml）──────────► 写到游戏目录
发 start：<gameDir>\<exe>$<游戏名>$<平台IP> ─► =StartGame== 起进程 ─────►
                                                                       SettingManager:LoadSetup()
                                                                       ===GetPlatformIP======192.168.31.237
                                                                       LocalIP:192.168.31.228:51124
                                                                       Try connect to platform : <平台>:51234
◄──── 裸字节 1（cmd1 检测在线）──────────────────────────────────────────┘
                                                                       （收）{"Machines":[...]}
SendConnectMsgToGame={"Machines":[...]} ──────────────────────────────►  PlayerConnectHandle Pos=2 …
                                                                       DoInit() callback
◄──── cmd = 8（ClientSendMessage 游戏名/版本/机器名/机器码）──────────────┘
（开局…）
关闭游戏=128
发 kill 给启动器 + SendCloseGameToGame 给游戏 ─► 启动器回 logcat「客户端收到关闭游戏消息」→ 游戏退出
```

### 9.2 逐条对照我们的实现（差异 = 待补的坑）

| # | 正常游戏 | 我们（旧实现） | 结论 |
|---|---|---|---|
| 1 | 平台地址来自 **`copyfile` 下发的 `setup.xml`** 的 `<Platform platformIP receivePort sendPort/>` | 只用了 `am start` 的 `-d` IP | ⚠ `-d` 兼作推流 PC 地址，未必等于平台机地址 → **改为两者都当候选**（已改） |
| 2 | 本地绑 **51124**，向 **`<平台>:51234`** 发 | 同 | ✅ 一致（平台 `P2OthersConfig.GameConfig`：send 51124 / recv 51234 也印证） |
| 3 | 上线发 **单字节裸值 1** | 发 0x01 | ✅ 一致 |
| 4 | 平台回 **`{"Machines":[...]}`**（大写 M，**无 cmd 字段**），游戏据此 `DoInit()` | 按 `cmd` 字段解析 → 该包被当 `cmd=-1` 丢弃 | ⚠ **等于完全没理会平台的连接确认**（已改为识别 + 置 connected + 透传页面） |
| 5 | ~~收到连接配置后回 **`cmd=8`（游戏名/版本/机器名/机器码）**~~ | 从不发 | ✅ **已定论（见第 11 节）：真实玩家侧从不发 `0x08`**。平台日志那条 `收到客户端发来的消息啦8` 比玩家 `cmd=1` **早 7 秒**，属 `IsHost=1` 主机侧 ⇒ **保持「不发」**（这一条从「待补的坑」降级为「已对齐」） |
| 6 | 上线 cmd1 **只在启动时发一次**（此后 94s 静默） | 收到一次回包就停发 | ✅ 方向本就一致。**定稿**：未收到机位表前每 **3s** 重试、**收到即停**；平台每次拉起再由 `pokeHandshake()` 补发 3 轮。（曾误改为「2s 常驻心跳」，见第 11 节：那是**有害**的——平台每收一次 `cmd=1` 都会重跑「回机位表 + `SetPlayerName`」） |
| 7 | 平台 `kill` 是发给**启动器**（`{"cmd":"kill","msgData":"<游戏名>"}`），由启动器关进程 | 启动器侧 `close game path` 为空 → 从不执行 | 归平台/启动器配置，改不了我们；我们只能靠 `cmd5/6` + 页面侧 aliveWatch 兜底 |

### 9.3 平台日志怎么看（下次复现只需这一份）

平台主控日志（`PC主控.log`）会把**收到的每一条设备命令**都打出来：

```
===ReceiveCall==IP==<设备IP>,,cmd = 1        ← 设备发来的裸命令（1=检测在线）
收到客户端发来的消息啦1
===SendConnectMsgToGame = {"Machines":[...]} ← 平台回给设备的连接配置
收到客户端发来的消息啦8                      ← 设备身份上报
====ClientSendMsg==ip <设备IP>, {"cmd":"start"/"kill"/"packagesinfo"/"connectsuccess", ...}
===CopyFile error2 : ... ENOENT              ← 配置下发失败（目录不存在）
```

**判读**：
- 没有 `ReceiveCall … cmd = 1`（且 IP 是头显）→ 我们的 0x01 根本没到平台 ⇒ 地址/端口/网段问题；
- 有 cmd1 但没有 `SendConnectMsgToGame` 回来 → 平台收到了但没认（设备注册/授权/版本不匹配）；
- cmd1、Machines 都有、平台却仍每 ~20s 重发 start ⇒ 缺的是第 5 项（身份上报 cmd8）或平台侧的其它就绪条件。

---

## 10. 抓包实测校正（2026-09-17）：游戏通道是「帧化二进制」

> ⚠ **本节关于 `0x08` 的结论已被第 11 节推翻**（真实会话里玩家侧从不发 `0x08`）。
> 帧格式（`\x01` / `\x01\x02+JSON` / `\x10closeGame ` / `\x02`）仍有效，`0x08` 部分请以第 11 节为准。

> 依据：① 用户提供的抓包报告 `F:/desk/LinSHi/新平台协议-实测报告.md`；
> ② 平台侧日志 `F:/desk/PC主控.log`（**VRPlatform 2.3.4.3，最有价值**）；
> ③ 启动器侧 `G:/01_Work/DXGames3/LauncherClient-1.0.1.7/DebugLog/客户端.log`；
> ④ 真实游戏侧 `G:/01_Work/DXGames3/DeepmindHacker-2.0.4/Log/2026-09-16-21-08-33.log`。

### 10.1 两条通道的**真实归属**（修正一个常见误读）

| 通道 | 谁在用 | 证据 |
|---|---|---|
| **游戏通道** UDP `51124`(监听) / `51234`(发平台) | **游戏本体**（我们是这一侧） | 游戏日志 `VRPlatformHelper LocalIP:192.168.31.228:51124, R:192.168.31.237:51124, S:192.168.31.237:51234`；平台日志 `===SendConnectMsgToGame` / `=== SendCloseGameToGame == closeGame` 都是打给游戏 |
| **控制通道** `connect/checkconnect/packagesinfo/connectsuccess/copyfile/start/kill/logcat` | **启动器**（PC 上是 `LauncherClient.exe`；头显上是 `com.GoodNet.LauncherClient`），**不归我们** | 启动器日志 `===正在监听TCP 连接`、`======TCPManager====Dispose()`、逐条收到 `packagesinfo`/`connectsuccess`/`copyfile`/`start`/`kill` |

抓包报告把「客户端监听 51124」写成启动器，实为**游戏**在监听；启动器完全不管这个端口。这条决定了职责边界：**我们只需把 51124/51234 做对。**

### 10.2 游戏通道的**报文格式**（抓包实测）

方向 = 本机（游戏）↔ 平台。所有报文都带**帧头字节**，不是裸 JSON：

| 帧 | 方向 | 含义 |
|---|---|---|
| `\x01`（1 字节） | 游戏 → 平台 | 注册 / 在线心跳（平台日志记为 `===ReceiveCall==IP==<游戏IP>,,cmd = 1`） |
| `\x01\x02` + JSON | 平台 → 游戏 | 下发机器列表 `{"Machines":[...],"Language":0,"Setting":0,"IsPlayLogo":1,"RoomId":1954,"ShopId":1,...}`（平台日志 `===SendConnectMsgToGame`） |
| `\x08`（+ 载荷） | 游戏 → 平台 | **`SendConnectToHost` 身份上报**（平台日志 `收到客户端发来的消息啦8`） |
| `\x10closeGame  ` | 平台 → 游戏 | 关闭游戏（平台日志 `SendCloseGameToGame == closeGame`），**先于**控制通道的 `kill` 发出 |
| `\x02`（1 字节） | 游戏 → 平台 | 对 `closeGame` 的确认 |

⚠ **两个必须做的动作，我们此前都没做**：
1. **剥帧头**：收到多字节包时先去掉前导 `\x01\x02`，再解析后面的 JSON。否则 `new JSONObject("\u0001\u0002{...}")` 直接抛异常 → Machines 被整条丢弃 → 平台的连接确认永远收不到。
2. **回 `\x08`**：收到 Machines（= 平台已认到本机）后，**必须回一帧 `0x08` 身份上报**。
   平台日志证据链：`cmd = 1`（收到注册）→ `SendConnectMsgToGame`（回机器表）→ **3 秒后** `收到客户端发来的消息啦8`。
   身份内容取自游戏日志：`ClientSendMessage 游戏:DeepmindHacker,版本:2.0.4,机器名:DESKTOP-Q2HJMLF,机器码:7851e8af...` → `发送消息：SendConnectToHost!!!`。
   **这是「平台认为游戏没就绪 → 每 ~20s 重拉 am start → 玩家侧闪退」的最可能真因。**

### 10.3 平台关游戏是**双通道并发**（缺一不可）

```
平台侧日志（9:08:44，同一秒）：
  ====ClientSendMsg==ip 192.168.31.237, {"cmd":"kill",...,"msgData":"DeepmindHacker"}   ← 控制通道 → 启动器 force-stop
   === SendCloseGameToGame ==  == closeGame  192.168.31.237                            ← 游戏通道 → 游戏自杀
```
- 控制通道的 `kill` 归启动器（我们够不着）；
- **游戏通道的 `closeGame` 归我们**：收到后应自行退出并**回 `0x02`**。
- 上一轮发现的「启动器 `close game path` 为空 → force-stop 从不执行」，正好由我们这条补上。

### 10.4 顺带校正两处此前的判断

1. **上行不该再发数字 cmd JSON**。我们此前发的 `{"cmd":3,"machines":[],"msgData":""}` 是 V2.9 的东西，
   新协议游戏通道的上行只有 `\x01` / `\x08` / `\x02` 三种（外加 closeGame 的 ack）。应删除。
2. **`setup.xml` 的 `platformIP` 在运行时是真实平台 IP，不是模板残留**。
   报告说它是「模板残留 172.16.1.172」——那是**游戏包内出厂模板**；实际由平台 `copyfile` 覆盖后再被游戏读取：
   游戏日志 `SettingManager:LoadSetup()` → `===GetPlatformIP======192.168.31.237`。
   故「`start` 第三段（= 我们 `am start -d` 的 IP）」与「`setup.xml` 的 platformIP」**都指向平台**，
   继续把两者都当候选是正确策略（谁回包锁谁）。

---

## 11. 完整会话抓包（2026-09-17 07:52–07:54，cap3.pcap）：0x08 是**主机侧**才发的，玩家侧只发 `0x01` / `0x02`

> 证据：`G:/01_Work/豆包办公/平台协议/packet-sniffer/cap3.pcap`
> （27216 包 / 120.0s / 本机 = 192.168.31.228 跑游戏，平台 = 192.168.31.237，含 IP 分片重组）。
> 分析工具：同目录 `analyze_frames.py`（按首字节给游戏通道帧分类 + hex dump，可复现）。

### 11.1 游戏通道（51124/51234）**全部** 4 个帧 —— 一次健康会话的完整记录

| # | 时刻 | 方向 | 字节（hex） | 说明 |
|---|---|---|---|---|
| 1 | 07:52:48.347 | 游戏 `228:**51124**` → 平台 `237:51234` | `01` | 注册（源端口 = 监听端口 51124） |
| 2 | 07:52:48.404 | 平台 `237:65100` → 游戏 `228:51124` | `01 02` + JSON(358B) | 机器表，**57ms 后**就回 |
| 3 | 07:54:22.176 | 平台 `237:60815` → 游戏 `228:51124` | `10` + `closeGame  `（12B） | 关游戏 |
| 4 | 07:54:22.183 | 游戏 `228:51124` → 平台 `237:51234` | `02` | 确认，**7ms 后**回 |

**关键结论（全部可复现）**

1. **玩家侧上行只有 `0x01` 与 `0x02` 两种，没有 `0x08`。**
   整个 120 秒、27216 个包里，任何首字节为 `0x08` 的负载都不存在（`analyze_frames.py` 已全网搜索确认）。
2. **`0x01` 只发一次**，之后 **94 秒完全静默**，平台既不催也不重发 `start`。
   → 游戏通道**没有心跳/保活要求**（存活检查走的是启动器通道的 `checkconnect`，与游戏通道无关）。
3. **必须从监听端口 51124 发包**（源端口 = 51124），不是临时端口。
4. 平台下行固定发给 `228:51124`，但它自己每次都用**新开的临时端口**（65100 / 60815）。
5. **`start` → 注册间隔 6 秒**（07:52:42 `start`，07:52:48 `01`）。平台在等这个 `01`；参考会话里它一次都没重发。
6. `closeGame` 帧精确字节：`10 63 6c 6f 73 65 47 61 6d 65 20 20`（`\x10` + `closeGame` + **两个空格**，共 12 字节）。

#### 机器表完整原文（注意帧头 `01 02`）
```
01 02 {"Machines":[{"address":"192.168.31.237","IsHost":1,"Pos":100,"TeamID":0,"style":1,
"weapon":6,"controller":0,"IsHtc":0,"IsOculus":0},{"address":"192.168.31.228","IsHost":0,
"Pos":2,"TeamID":0,"style":2,"weapon":6,"controller":0,"IsHtc":0,"IsOculus":100}],
"Language":0,"Setting":0,"IsPlayLogo":1,"RoomId":1954,"ShopId":1,"PadVersion":null,"PadUpdateInfo":null}
```

### 11.2 第 10 节里被推翻的结论（记账，勿重犯）

| 第 10 节的说法 | 实测真相 |
|---|---|
| 「必须回 `0x08`，否则平台判设备未就绪 → 每 ~20s 重拉 `am start`」 | **错**。玩家侧从不发 `0x08`；参考会话平台只发一次 `start`，从未重拉。 |
| `0x08` = `SendConnectToHost` 身份上报 | 混淆了两个东西：游戏日志里的 `ClientSendMessage … 发送消息：SendConnectToHost!!!` 是**游戏自家 P2P 层**（`UdpClientServer`）的消息；平台侧那条 `收到客户端发来的消息啦8`（21:08:25）比 228 的 `cmd = 1`（21:08:32）**早 7 秒**，只可能来自 237（`IsHost=1` 的主机侧）—— **玩家侧不参与**。 |
| 「`0x01` 必须常驻心跳，永不停止」 | **不需要**。真实游戏只发一次。反倒是每次 `cmd = 1` 都会让平台回一次机器表 + `SetPlayerName`（平台日志 21:08:22 / 21:08:32 两次都跑完整流程），3s 一次 = 每分钟 20 次房间重设。 |

> **`0x01` 仍建议保留「重试」**：只在**收到机器表之前**按 3s 重试（覆盖丢包/平台没收到），
> 收到机器表即停 —— 既贴合真实行为，又保留鲁棒性。

### 11.3 启动器通道（**不归我们**，但它解释了很多现象）

实测是 **UDP**，不是 TCP：设备监听 `62135`、平台监听 `62136`；`connect` 用广播 `255.255.255.255:62136`。

```
07:52:31 228:62982 -> 255.255.255.255:62136  connect          (广播找平台)
07:52:31 237:65071 -> 228:62135              packagesinfo     (平台枚举已装包)
07:52:31 228:62983 -> 237:62136              packagesinfo     (启动器回：已装 com.GoodNet.* 版本表)
07:52:31 237:65072 -> 228:62135              connectsuccess
07:52:32…07:54:20  双向 checkconnect 每 ~3s 一次（整场 60+ 次，这是启动器的保活）
07:52:37 237:65081 -> 228:62135              copyfile (7144B，下发 setup.xml 等)
07:52:42 237:65090 -> 228:62135              start  msgData="DeepmindHacker-2.0.4\DeepmindHacker.exe$DeepmindHacker$192.168.31.237"
07:52:48 (游戏通道) 01 → 注册
07:54:22 237:60814 -> 228:62135              kill   msgData="DeepmindHacker"      ← 与游戏通道 closeGame 同刻
07:54:22 228:55309 -> 237:62136              logcat msgData="A-2 客户端收到关闭游戏消息"
```

- `start` 的 `msgData` 格式：`<相对路径>$<游戏名>$<平台IP>`；**第三段就是平台 IP**（启动器会把它作为 `-d` 传给游戏）。
- `kill` 的 `msgData` 是**游戏名**（不是包名）——启动器据此映射到 `com.GoodNet.<游戏名>` 去 force-stop。
  ⇒ 这也再次说明：**我们的 APK 包名必须是平台注册表里的 `com.GoodNet.<游戏名>`**，否则平台既枚举不到、也关不掉。
- 平台关游戏 = **同刻双通道**：`kill`（→启动器 force-stop）+ `closeGame`（→游戏自身退出并回 `ack`）。
  `kill` 只能杀掉 APK 进程，**杀不掉 PICO 浏览器里的游戏页** ⇒ 页面必须自己收到 `cmd=16` 后退出。

### 11.4 对我们的净影响

| 项 | 原现状 | 处置 | 落地状态 |
|---|---|---|---|
| 监听 51124、从该 socket 发包（源端口 51124） | ✅ 已是 | 保持 | ✅ 未动 |
| 机器表剥 `01 02` 帧头再解析 | ✅ 已是 | 保持 | ✅ 未动 |
| `closeGame` 识别 + 回 `02` | ✅ 已是 | 保持 | ✅ 未动 |
| 平台地址：`-d` 与 `setup.xml` 都当候选 | ✅ 已是 | 保持 | ✅ 未动 |
| **发 `0x08` 身份** | ❌ 真实玩家侧从不发，载荷靠猜 | **删掉** | ✅ **已删**（含 `setIdentity` / `md5` / `applyIdentity` / 8s 兜底） |
| **`0x01` 3s 常驻心跳** | ⚠ 偏离实测，会让平台每分钟重设房间 20 次 | 改为「**未收到机位表前重试、收到即停**」 | ✅ **已改**（`handshakeLoop()`，3s × 最多 40 次） |
| `0xFF` 当在线应答 | ⚠ 本会话平台从未发 1 字节包 | 保留识别，但**不再据此判定 online**；唯一判据 = 机位表 | ✅ **已改** |
| `/api/vrplus/status` 的 `identified` 字段 | 曾暴露 0x08 状态 | 无 0x08 即无意义 | ✅ **已删** |

### 11.5 代码落地 + 产物校验（2026-09-17 10:27）

改动文件与校验方式（**不只看「构建成功」，而是直接在 dex 字节里核对符号**）：

| 文件 | 改动 |
|---|---|
| `VRPlusLink.java` | 整体重写：删全部 `0x08` 成员；`HANDSHAKE_MS=3000` / `HANDSHAKE_MAX_TRIES=40` / `LOG_EVERY=5`；新增 `handshakeLoop()`、`sendRegisterToAllHosts()`；`pokeHandshake()` 整轮 3 次（间隔 400ms）全在 `tx` 后台线程完成；`sendNow()` 合法集只剩 `case 1` / `case 2` |
| `MainActivity.java` | 删 `applyIdentity(VRPlusLink)`、`md5(String)` 及两处调用；`notifyPlatformGameLaunched()` 只剩 `link.pokeHandshake("平台拉起/启动指令到达")` |
| `GameServer.java` | `/api/vrplus/status` 删 `identified` 字段 |
| `src/net/vrplus.js` | 头注释改为「一次健康会话只有 4 个帧」协议表；`/api/vrplus/status` 文档串去掉 `identified` |

**产物校验命令（可复现）**：

```python
import zipfile, re
z = zipfile.ZipFile(r"tools/cast-apk/app/build/outputs/apk/debug/app-debug.apk")
blob = b"".join(z.read(n) for n in z.namelist() if re.match(r"classes\d*\.dex$", n))
must_have = ["handshakeLoop","sendRegisterToAllHosts","HANDSHAKE_MAX_TRIES","pokeHandshake"]
must_not  = ["FRAME_IDENTITY","buildIdentity","sendIdentity","applyIdentity","hasIdentified"]
print([s for s in must_have if s.encode() not in blob])   # 期望 []
print([s for s in must_not  if s.encode() in blob])       # 期望 []
```

**实测结果**：`classes.dex / classes2.dex / classes3.dex`（合计 9.69 MB）中，
- 应存在：`handshakeLoop` / `sendRegisterToAllHosts` / `HANDSHAKE_MAX_TRIES` / `HANDSHAKE_MS` / `FRAME_REGISTER` / `FRAME_CLOSE_ACK` / `FRAME_CLOSE_GAME` / `pokeHandshake` / `drainInbox` —— **全部命中**；
- 应消失：`FRAME_IDENTITY` / `buildIdentity` / `sendIdentity` / `applyIdentity` / `hasIdentified` / `IDENTITY_MIN_GAP_MS` / `startIdentityFallback` —— **全部 0 次**。
- ⚠ 唯一「疑似残留」是 `setIdentity` 命中 1 次，定位后为 AndroidX 的 `setIdentityTransforms`（子串误命中），**非我们的代码**。

包内 `assets/game/src/net/vrplus.js`（6366 字节）已是新版（含「玩家侧不发 0x08」注释，无 `identified`）。APK 49.13 MB，`BUILD SUCCESSFUL in 16s`。

**实测时该盯的日志行**：

```
VRPlus  桥接启动：监听 51124，向 [<候选>]:51234 发 0x01 注册（来源端口 = 51124）
VRPlus  0x01 注册 → [<候选>]（第 1/40 次，成功 1/1）
VRPlus  ← 平台帧 len=360 首字节=0x01 原文=…\x01\x02{"Machines":[…]}
VRPlus  收到平台机位表：Machines=N 台，RoomId=…，IsPlayLogo=…
VRPlus  已收到机位表 → 停止 0x01 注册（贴合实测：注册只发一次）     ← 关键：出现这行后不再刷 0x01
CastMain  VR+ 已上线（收到机位表），停止 0x01 注册
```

平台侧 `PC主控.log` 对照：
- `===ReceiveCall==IP==<头显IP>,,cmd = 1` 应**只出现一次**（或按退出重进次数出现，不出现每分钟数十次）；
- `====ClientSendMsg==…{"cmd":"start"…}` 应**只有一条**（若仍反复出现 ⇒ 问题不在游戏通道，需另找机制）。

---

## 12. 「正常 vs 失败」对照日志（2026-09-17 14:49–15:00）：平台**在什么条件下**重发 `start`

> 证据：用户提供的 4 份现场日志 —— 正常 `主控.log` / `客户端.log`，失败 `主控失败.log` / `客户端失败.log`
> （均在 `F:\desk\LinSHi\`；同一台测试机 192.168.10.2，头显 192.168.10.9）。
> 本节**修正第 11 节**「平台全程只发一次 `start`、从不重拉」的表述 —— 那句话只在**主机侧及时上线**时成立。

### 12.1 逐项对照

| 项 | 正常（14:50） | 失败（14:59） |
|---|---|---|
| 头显侧包版本 | `com.GoodNet.DeepmindHacker-2.0.4` | `…-2.0.5`（**我们的 APK**） |
| PC 端游戏 | `H:\DXGames\DeepmindHacker-2.0.4\DeepmindHacker.exe` | `…DeepmindHacker-2.0.5\DeepmindHacker.exe` |
| `start` 次数 | **1 次**（14:50:28，只发头显 `.9`） | **2 次**（14:59:19 只发 `.9`；**14:59:39 同时发 `.2` 与 `.9`**，间隔正好 20s） |
| PC 主机 `.2` `cmd=1` | ✅ 14:50:31（start 后 **+3s**） | ❌ **全程零** |
| PC 主机 `.2` `0x08` | ✅ 14:50:32 `收到客户端发来的消息啦8` | ❌ 全程零 |
| PC 主机 `.2` `cmd=5` | ✅ 14:50:46（**+18s**） | ❌ 全程零 |
| 头显 `.9` `cmd=1` | 1 次（14:50:34） | **4 次/轮 × 2 轮** |
| 头显 closeGame → `cmd=2` | ✅ 14:52:06 | ✅ 14:59:58（**进程活着，能回**） |
| 启动器 `OnApplicationPause` | 14:50:29→14:52:06（**97s** 稳定占前台） | 14:59:20→**14:59:22（仅 2s）**；14:59:41→15:00:56 |
| 启动器 `close game path` | `= `（空） | `= `（空） |

### 12.2 结论

1. **平台会重发 `start`**。触发条件 = **`start` 后 ~20s 内没等到「游戏已开跑」的主机侧确认**。
   正常会话里这个确认是主机 `.2` 的一串：`cmd=1`(+3s) → `0x08`(+4s) → `cmd=5`(+18s)，`cmd=5` 恰好卡在 20s 之前。
2. **失败会话里 PC 主机 `.2` 自始至终没有上线**（零 `cmd=1` / 零 `0x08` / 零 `cmd=5`）—— 这是两次会话**唯一的结构性差异**。
3. 平台 +20s 重发 `start` 时**同时发给 PC 与头显**。头显那条 `am start` 会把我们的 APK 顶到前台，
   把 PICO 浏览器里的游戏页 / XR 沉浸会话压到后台 ⇒ **玩家看到的就是「进游戏两三秒被弹出 = 闪退」**。
   这正是 `MainActivity` 注释里记录的那个死循环，现在拿到了**平台侧的直接证据**。
4. **我们的头显侧协议是健康的**：`0x01` 发出（每轮 4 次 = `handshakeLoop` 首轮 + `pokeHandshake` 3 轮，单候选）、
   收到机位表、`closeGame` 后 7ms 内回 `0x02`。**问题不在游戏通道。**
5. **`0x08` 只出现在正常日志，且来自 `.2`（主机）** —— 再次印证「`0x08` 是主机侧行为，玩家侧不发」。
6. ⚠ **头显侧只发 `0x01`/`0x02` 永远补不上这个缺口**。平台要的是**主机侧**信号；
   若我们的部署里 PC 侧没有「讲平台游戏通道」的主机程序，平台就必然每 20s 重拉一次。

### 12.3 平台配置实证（`HotUpdate/P2OthersConfig.json`）

```jsonc
"GameConfig":   { "sendUDPPort":51124, "recvUDPPort":51234 }   // ★ 与我们的实现一致
"ClientConfig": { "sendUDPPort":62135, "recvUDPPort":62136, "TCPport":62137 }   // 启动器通道
"Part3Config":  { "sendUDPPort":20021, "recvUDPPort":20020,     // 旧街机协议（第三方平台用）
                  "CloseExe":0 }   // 注释原文：收到cmd：5中途停止游戏时，为0则关闭exe
```

> ⇒ **`cmd=5` 的语义是「中途停止游戏」**（`CloseExe:0` 时还会关闭 exe）。
> 这一条很重要：**别把 `cmd=5` 当成「游戏已启动」信号发出去**，否则会被平台当停止指令处理。
> 「平台已认定游戏开跑」这件事，目前只能靠**主机侧**的原生行为达成。

### 12.4 根因定论（2026-09-17 用户确认）

| 待确认项 | 答复 |
|---|---|
| 失败那次 PC 端 `H:\DXGames\DeepmindHacker-2.0.5\DeepmindHacker.exe` 是什么？ | **我们自己的 PC EXE**（`tools/cast-pc`，WebRTC 直播接收端） |
| 两次头显装的包 | 正常 = **原版 2.0.4**；失败 = **我们重打的 2.0.5** |
| 「闪退」表现 | **卡在游戏加载画面后退出** |

**⇒ 根因闭合：**

```
平台按登记把 PC 侧的 exe 当成「游戏主机」启动
   → 那个 exe 是我们的 cast-pc，它**不实现平台游戏通道**
     （源码里零处 51124/51234/VRPlus；命中的全在 node_modules/dist/LICENSES）
   → 主机侧永不上线：零 cmd=1 / 零 0x08 / 零 cmd=5
   → 平台在 start 后 +20s 重发 start（同时打 PC 与头显）
   → 头显那条 am start 把接收器 APK 顶到前台
   → 压掉 PICO 浏览器里**正在加载**的游戏页
   → 玩家看到「卡在游戏加载画面后退出」
```

这同时解释了 **「手动启动正常」**：手动点图标没有 `-d` 参数 → `platformDriven=false`
→ 不走平台驱动分支、也没有平台重拉 → 页面能安心加载完。

### 12.5 修复方向

**唯一正解：给 `tools/cast-pc` 补上「平台主机身份」**（逻辑与 `VRPlusLink.java` 同构，移植到 Node 即可）：

| 步骤 | 内容 |
|---|---|
| 1 | bind UDP `51124`，**用同一个 socket** 向 `<平台>:51234` 发**裸字节 `0x01`**（源端口必须 51124） |
| 2 | 收到 `01 02 + {"Machines":[...]}`（**无 cmd 字段**）→ 从第一个 `{` 截到最后一个 `}` 再 `JSON.parse` |
| 3 | 回 `0x08`（**载荷未知，见下**）→ 平台才会认为主机已就绪 |

⚠ **`0x08` 的真实 payload 仍未确证**。旧说法「游戏名,版本,机器名,机器码」是靠猜的（第 9.2 节已标注为待考据）。
⇒ **下一步必须先抓一次原版 PC 主机的包**：

> 在平台机（本案例 `192.168.10.2`）上用 Wireshark 抓 `udp port 51124 or udp port 51234`，
> 然后跑一次**原版**游戏（PC 原版 exe + 原版头显 APK），即可拿到主机侧 `cmd=1` → `0x08` → `cmd=5`
> 的**逐帧精确字节**。这一步能把 `0x08` 从「猜」变成「抄」。

⚠ **`cmd=5` 不要发**：`P2OthersConfig.json` 注释写明「收到cmd：5中途停止游戏时，为0则关闭exe」，
即 `cmd=5` 是**停止**语义，不是「已启动」。

⚠ **兜底/并行可做（治标，不治本）**：让重拉不再影响游戏页 —— `MainActivity` 已有
`sLaunched && isGamePageAlive()` 的「零界面」分支与 `finishPlatformActivity()`，
但它只在**首次拉起已成功**之后才生效；首次加载阶段仍会被重拉打断。
若暂时无法补主机侧通道，可先把「首次加载期间的抗打断」做厚（例如加载完成前不 finish、
或让平台重拉时只 `moveTaskToBack` 而不重建 Activity）。
但只要主机侧不上线，平台就会**一直**每 20s 重拉一次，治标方案只能是减少伤害。

---

## 13. 「换回原版 exe 仍闪退」→ 定位到**跨会话下行残留**（2026-09-17 16:0x）

### 13.1 这次测试推翻了什么

把平台游戏目录里的 `DeepmindHacker.exe` **临时换回原版**后重测，结果**头显仍然「打开预览界面 1 秒闪退」**。

⇒ 这是个**反证**：
- 若第 12 节的「PC 主机侧无人应答 → 平台 +20s 重发 `start`」是**唯一**原因，换回原版后就不该再闪；
- 而且「1 秒」这个量级**根本来不及触发 20s 重发**；
- ⇒ 要么这次换 exe 没真正生效（**需平台日志确认主机侧有没有 `cmd = 1`**），要么**还有第二条、
  与 PC 完全无关的机制**在 1 秒内把页面打死。**两者都要查，而后者已有明确证据。**

### 13.2 完整日志给出的两条新硬事实

把 `主控.log`（正常，14:49–14:52）与 `主控失败.log`（失败，14:58–15:00）**逐行**读完，得到：

**① 平台关闭游戏 = `kill` + `closeGame` 双通道并发，每一局结束都给头显发一份：**

```
2:52:04  ====ClientSendMsg==ip 192.168.10.2, {"cmd":"kill","msgData":"DeepmindHacker"}
2:52:04   === SendCloseGameToGame ==  == closeGame  192.168.10.2      ← 游戏通道
2:52:04  ====ClientSendMsg==ip 192.168.10.9, {"cmd":"kill","msgData":"am force-stop --user 0 com.GoodNet.DeepmindHacker"}
2:52:04   === SendCloseGameToGame ==  == closeGame  192.168.10.9      ← ★ 头显侧也有一份，同一毫秒
```
（失败轮 2:59:55 完全同构。）

**② 失败轮里我们的头显侧其实是健康的：**

| 时刻 | 事件 | 判读 |
|---|---|---|
| 2:59:19 | `start`（只发 `.9`） | 平台拉起 |
| 2:59:19/:21/:22/:22 | `.9` `cmd = 1` ×4，每次都回机位表 | = `handshakeLoop` 首轮 + `pokeHandshake` 3 轮，与新版代码节奏吻合 |
| 2:59:39 | `start` 重发（**同时发 `.2` 和 `.9`**） | +20s 超时重拉 |
| 2:59:58 | `.9` `cmd = 2` | closeGame 确认，7ms 级 |
| 全程 | `.2`（PC 主机）零 `cmd=1` / 零 `啦8` / 零 `cmd=5` | **PC 主机侧从未上线**（第 12 节结论不变） |

### 13.3 新根因：下行队列跨会话残留

| 环节 | 事实 |
|---|---|
| 1 | `VRPlusLink` 是**进程级单例**（`sVRPlusLink`），进程由 `CastService` 前台服务保活，平台重拉时还**复用同一个桥接** |
| 2 | 它的下行队列 `downlink` 是内存 `ConcurrentLinkedQueue`，**从不清空 → 跨会话存活** |
| 3 | 平台每局结束都会下发 `0x10 closeGame`（见 13.2 ①） |
| 4 | 若该帧到达时游戏页**没在轮询**（加载中 / 已 `about:blank` / APK 正被 force-stop），没人 `drainInbox()` → `cmd=16` 一直躺着 |
| 5 | 下一局页面一打开，`VRPlus.startInbox` 是 `setInterval(…, 1000)` 且**首轮立即执行** → **约 1 秒内**收到「上一局的关闭游戏」 |
| 6 | `_onPlatformCommand(16)` → `_onPlatformCloseRequest` → `_onPlatformGone()` → 退 VR + `location.replace('about:blank')` |

⇒ 完全吻合「**打开预览界面 1 秒闪退**」，**且与 PC 端跑什么程序无关**（换 exe 无效也就解释得通了）。

### 13.4 本轮落地（4 处，含产物校验）

| 文件 | 改动 |
|---|---|
| `VRPlusLink.java` | 新增 `stamp()`：每条下行项打 `t`(epoch ms) + 序号 `n`；新增 `clearStaleClose(why)`：**只丢 `cmd=16/5/6`**，保留 `cmd=0` 机位表（注册握手合法早于页面加载，一刀切会连它一起丢） |
| `MainActivity.java` | `maybeLaunch()` 里 `openInPicoBrowser()` 之前调 `clearStaleClose("新会话")`；页面还活着时**绝不**清（否则吞掉真实关闭指令） |
| `GameServer.java` | `/api/vrplus/inbox` 每次 drain 后打日志：`→ 页面轮询取走 N 条下行：cmd=16/n7(1200ms前)` |
| `src/game/game.js` | `_pageT0 = Date.now()`；`startInbox` 回调丢掉 `t < _pageT0` 的 16/5/6；`_onPlatformGone(why,{confirm})`：**看门狗路径先复核 2.5s**（`VRPlus.serverAlive()`）再执行；平台明说的 cmd16 不复核、立即执行 |
| `src/net/vrplus.js` | 新增 `VRPlus.serverAlive()`（真 fetch 是否成功，供上面复核用） |

校验：`src/**` 39 个 JS 全过语法检查；`BUILD SUCCESSFUL`，APK 49.13 MB；
dex 内 `clearStaleClose`/`stamp`/`seq` 均在，旧 `0x08` 相关符号（`FRAME_IDENTITY`/`buildIdentity`/`sendIdentity`/`applyIdentity`/`hasIdentified`）全为 0；
包内 `assets/game/src/{net/vrplus.js,game/game.js}` 已是新版。

> ⚠ 构建踩坑记录：Edit 加 `import java.util.concurrent.atomic.AtomicLong;` 首次**未落地**（编辑报成功但文件里没有），
> 构建报 `找不到符号: 类 AtomicLong`。**Java 改完务必读 `tools/cast-apk/build.log`（GBK 编码）**，不要只信「编辑成功」。

### 13.5 下一步：先做这个「2 分钟二分测试」（无需重打包）

装上新 APK 后，**先用头显「设置 → 应用 → 强制停止」把我方 APK 杀掉**
（或 `adb shell am force-stop com.GoodNet.DeepmindHacker`），再从平台启动游戏：

| 结果 | 结论 | 下一步 |
|---|---|---|
| **不闪退了** | 跨会话/进程残留**确认为主因**（force-stop 清空了内存队列） | 新包应已修好；继续验「关闭游戏能否 3s 内生效」 |
| **仍闪退** | 与 APK 内存无关 | 立刻取设备侧全量 logcat + 本次平台日志（见下） |

不管哪种结果，都要一并收集：
```bash
# 头显（必带 AndroidRuntime，否则崩溃栈会被 -s 滤掉）
adb logcat -v time -s CastMain:V VRPlus:V AndroidRuntime:E ActivityManager:I
```
平台侧 `主控.log` 看三行：
- `===ReceiveCall==IP==192.168.10.2,,cmd = 1` —— 本次换回原版 exe 后**主机侧有没有上线**（决定性）
- `====ClientSendMsg==…{"cmd":"start"…}` 出现**几次**（1 次 = 未重拉）
- `=== SendCloseGameToGame` 的时刻

**日志判读（一句话分辨）**：
- `→ 页面轮询取走 … cmd=16/n?(非 0ms 前)` ⇒ 残留被新页面捡走（13.3 复现）；
- `cmd=16` 是 `0ms 前` ⇒ 平台本局真下的关闭指令（正常）；
- 出现 `忽略上一会话残留的关闭指令 cmd=16` ⇒ 页面门禁生效（13.4 的修复起作用）；
- 只有 `APK:fail 4/4` 且紧跟 `判死复核：APK 确实已失联` ⇒ 真被 force-stop 了（合法关闭）。

---

## 14. 抓包之后仍然闪退（2026-09-19）：死在「页面出生后 3~6 秒」，与 PC 端完全无关

### 14.1 玩家的完整观察（一手，逐字）

1. 客户端提示**复制文件**（copyfile → `setup.xml`）
2. 显示**打开了 apk**（`am start`）
3. 网页先弹了一个**黑框** → 紧接着消失
4. 又弹出**游戏预览界面**
5. **进度条跑到一半 → 直接闪退**
6. 约 **10s 后客户端启动了第二次，没有任何网页弹出**

### 14.2 三条能立刻确定的事

| # | 结论 | 依据 |
|---|---|---|
| 1 | 页面**确实起来过**，而且**预加载已经在跑** | 「游戏预览界面 + 进度条」= `index.html` 的菜单 + `main.js` 的加载遮罩；进度条只在 `preloadAll` 的帧循环里被写入 |
| 2 | 死亡时刻 ≈ 页面出生后 **3~6 秒** | 进度条分段节奏：0~6s 封顶 80%、6~9s 封顶 95%、9~10s 才冲到 100%。「跑到一半」只可能落在**前 6 秒**内 |
| 3 | 与 PC 端（主机侧 / 原版 exe）**完全无关** | ① **时间**：平台重发 `start` 实测在 **+20s**，比 3~6s 晚得多；② **架构**：平台启动时 `getCastUrl()` 返回的是**纯本地** `http://localhost:8080/`，不带 `?cast=1&pc=`，PC 端根本不参与 |

⇒ 这同时解释了上一轮「把 exe 换回原版毫无变化」：那条链路从来就没接上，换不换都一样。

### 14.3 「黑框 → 消失 → 又出现预览界面」：同一 URL 很可能被开了两次

`MainActivity.verifyLaunch()` 的重试路径（2s 自检 → 若我们仍在前台就 `moveTaskToBack` 让位 → 再等 1.5s → 仍在前台则 `maybeLaunch()` 再来一次）。
第二次 `ACTION_VIEW` 打**同一个 URL** 时，浏览器的行为不是「复用已有标签」，而是**重新导航** —— `MainActivity.java:570-574` 的注释早就记过这条：「加载到一半忽然重来 / 闪退」。

⇒ 这恰好能把「黑框消失 → 预览界面重新出现」解释成**两次打开**，而且第二次**正好落在 3~6 秒窗口内**。
（⚠ 尚属推断，已由 14.5 的留痕给出决定性判据：看有没有 `第 2 次拉起浏览器`。）

### 14.4 「第二次启动没有任何网页弹出」= 我们 APK 的静默吞掉（但暴露一个设计缺陷）

`maybeLaunch()` 里：`sLaunched && isGamePageAlive()` 时**只退后台、绝不重开浏览器**（防重载）；
而 `isGamePageAlive()` 在**刚拉起 15 秒内无条件返回 true**。

⇒ 第二次 `am start` 时它认为「游戏页还活着」，于是什么都不弹。行为本身是设计意图，但它**误判**了（那一刻页面其实已经没了）。
**推论：平台侧「没弹网页」不能当成「平台没干活」。**

### 14.5 本轮核心落地：把「谁动的手」写成**跨进程存活的磁盘时间线**

前 4 轮排查的共同瓶颈不是推理能力，而是**没有设备侧证据**：页面日志随页面一起消失，`logcat` 又要连线。
所以这一轮先修「看得见」，而不是继续改协议。

**链路**：页面 → 同源 `POST /api/page/*` → APK `PageForensics` 落盘 → 三种读法。

| 读法 | 怎么做 |
|---|---|
| **免 adb（推荐）** | 头显上**打开本 APK 图标** → 配置页底部绿色小字 = 「上次运行留痕尾部」 |
| 头显浏览器 | **在头显里**打开 `http://localhost:8080/api/page/forensics`（纯文本，可复制） |
| PC 浏览器 | 必须换成**头显的 IP**：`http://<头显IP>:8080/api/page/forensics` |
| 文件 | `.../Android/data/com.GoodNet.DeepmindHacker/files/page-forensics.log`（`adb pull` 亦可） |

> ⚠ **`localhost:8080` 只对头显自身有效**：这个服务跑在**头显里那个 APK 进程内**（NanoHTTPD；
> `super(port)` 未指定 hostname → 实际绑 `0.0.0.0:8080`）。**在电脑浏览器开 `http://localhost:8080`
> 必然「拒绝连接」** —— 那是电脑自己的 8080，与头显无关。从电脑读必须写**头显 IP**；
> 且以前提「APK 进程活着且 8080 已绑定」为限。**拒连 ≠ 服务有问题，先确认你是在哪台设备上打开的。**
> 反过来：若**头显里**打开也拒连，那才是硬信息 —— 说明 APK 侧 8080 已不在（进程被杀 / 服务未起）。

**记了什么**

- **页面侧**：`page-open`、`visibility:visible|hidden`、`freeze`/`resume`、`pageshow`、`pagehide`/`beforeunload`、未捕获错误，以及死因 `DEAD:platform-gone`；
- **状态流**（搭在每秒的 inbox 轮询上，**零额外请求**；只在变化或每 5s 落一行）：`状态 进度=50% state=menu 预加载中 XR=off`；
- **APK 侧**：进程启动（**pid** —— pid 变了就是被 force-stop 过）、每次 `am start` 走哪个分支、**第几次**拉起浏览器、`verifyLaunch` 结果、`8080 失联`、30s 心跳、收到机位表、收到 `0x10 closeGame`、丢弃了几条跨会话残留。

**判读表（下次复现照这个对）**

| 留痕里出现 | 真凶是 |
|---|---|
| `[APK] ==== 进程启动 … pid=` 出现**多次** | 平台那轮 `kill` 真把我们 force-stop 了 → 8080 断供 → 页面资源请求全挂 |
| `[APK] 心跳：8080 失联` | 同上（哪怕随后重绑成功，期间页面请求也已经失败） |
| `[APK] 第 2 次拉起浏览器` | 同一 URL 二次 `startActivity` → 浏览器重新导航（14.3） |
| `[PAGE] visibility:hidden` | 页面**没死**，是被抢了前台（PICO 的 2D 面板一次只显示一个） |
| `[PAGE] freeze` 之后没有下文 | 被 Chromium 页面生命周期**冻结/回收**（后台页的典型结局） |
| `[APK] 收到平台关闭指令 0x10 closeGame` | 平台**真的**要求关闭（合法退出，不是 bug） |
| `[PAGE-DEAD] DEAD:platform-gone explicit=false` | 是**我们自己的看门狗**推断的（只有这条才可能是误判） |
| `[APK] 丢弃上一会话关闭类残留 N 条` | 13.3 那条根因**又发生了** |
| 什么都没有、且心跳戛然而止 | APK 进程被系统/平台杀掉（最粗暴那条） |

### 14.6 顺带三修：加载期「误判自愈」

`game.js` 新增 `_startReviveProbe()` —— 预加载**未完成**时判死 → **只盖封盖、不卸载页面**，随后每 2s 探一次 `/status`：

- APK 回来了 **且平台没有明说关闭** → 撤盖、撤销判死、继续加载（玩家几乎无感）；
- 一直探不到（真死）→ 保持封盖，等平台重新拉起；
- 平台**明说**关闭（游戏通道 `0x10 closeGame`）→ 绝不复活（`_closedByPlatformCommand`）。

这条专门治「平台每轮 `kill → copyfile → am start`」中最坏的那种时序：**kill 恰好砸在页面加载到一半时**。

### 14.7 下一步（拿到留痕后）

1. 复现一次，把「配置页底部那 10 行」（或在电脑上用**头显 IP** 读 `/api/page/forensics`）发我；
2. 按 14.5 判读表定位（**大概率**落在 `第 2 次拉起浏览器` 或 `pid 变化` 二者之一）；
3. 若确认是二次 `startActivity`，改法是**把重试做成「只让位、不重开」**，并给同一次会话加「同一 URL 只允许一次 `ACTION_VIEW`」的硬约束。

---

## 15. 顺带修掉一个隐藏很久的缺陷：APK 里的中文日志一直是乱码（2026-09-19）

### 15.1 它是怎么被发现的

给 `PageForensics.java` 加了一行纯字符串写入后，编译报：

```
PageForensics.java:154: 错误: 对于write(String), 找不到合适的方法
```

而第 154 行是 `raf.write("…".getBytes(StandardCharsets.UTF_8));` —— **`write(byte[])` 明明存在**，报错位置与真因毫无关系。

### 15.2 真因：源文件是 UTF-8，javac 却按 GBK 读

| 事实 | 值 |
|---|---|
| 本机 JDK | `javac 17.0.10`，`file.encoding = GBK`、`native.encoding = GBK` |
| 本项目所有 `.java` | **UTF-8**（`utf8=True` / `gbk=False`，逐个文件实测） |
| `app/build.gradle` 的 `compileOptions` | **没指定 encoding** → 用平台默认 GBK |

按 GBK 去解码 UTF-8 的源码，有两个后果：

1. **中文字符串字面量全部变成乱码**（日志、留痕文本编进 dex 就已经是错的）——
   也就是说，**我们 APK 里所有中文日志在设备侧一直是乱码**，此前从没被真正读出来过。
2. **更阴险**：CJK 是 3 字节。若一段 CJK 的**个数为奇数**，最后一组的第 3 个字节会与紧跟的
   `"` 或 `\` **配成一个 GBK 双字节字符**，把收尾引号吞掉 → 语法直接坏掉，且报错位置无关。
   （第 154 行那串正好 13 个 CJK 字符：`…（已轮转，仅保留最近 ` 12 个 + `）` 1 个。）

### 15.3 修复

`app/build.gradle`：

```gradle
compileOptions {
    sourceCompatibility JavaVersion.VERSION_17
    targetCompatibility JavaVersion.VERSION_17
    encoding 'UTF-8'          // ★ 必须显式指定
}
// 双保险（用全限定类名，避免 Gradle 默认 import 差异）
tasks.withType(org.gradle.api.tasks.compile.JavaCompile).configureEach {
    options.encoding = 'UTF-8'
}
```

### 15.4 产物校验（怎么确认真的修好了）

不能只看「BUILD SUCCESSFUL」，要**在 dex 里找中文的正确 UTF-8 字节**：

```python
blob = dex 字节拼接
assert b"留痕文件".decode('utf-8').encode('utf-8') in blob          # 正确编码 → 命中
assert "鐣欑棔".encode('utf-8') not in blob                        # GBK 误读的产物 → 应 0 次
```

实测结果：`留痕文件` / `状态 进度=` / `收到平台机位表` / `页面轮询取走` **全部命中**，
GBK 误读产物 `鐣欑棔` / `鏈轰綅` **各 0 次** ⇒ 修复生效。

### 15.5 通用教训（换项目也适用）

> **Java 源码里只要有中文，构建就必须显式指定 UTF-8。**
> 否则：① 所有中文日志/文案在设备上是乱码；② 某个「CJK 个数为奇数」的字符串会以
> **与真因完全无关的报错**把构建打挂 —— 极易被误判成 API 用错、类型不对而白查半天。

---

## 16. ★ 拿到留痕后的定论（2026-09-19 15:1x）：三个真根因，全在 APK 侧

### 16.0 先说结论

| # | 根因 | 留痕铁证 | 玩家看到的现象 |
|---|---|---|---|
| 1 | **`platformDriven` 判据失效** —— 平台 `am start` **不带 `-d`**，旧判据（只看 intent.data）恒为 false | `onCreate 平台驱动=false intent=null` | 每次平台重拉都重建配置页**面板**抢前台 → 「闪退」 |
| 2 | **`verifyLaunch` 用 `resumed` 判「浏览器是否接管」** —— PICO 的 XRShell 把 Activity 面板化，`moveTaskToBack()` 后 `resumed` 仍为 true → 误判「未接管」 | `verifyLaunch：2s 后浏览器尚未接管` → `让出前台后仍在配置页 → 再拉第 2 次` → `第 2 次拉起浏览器` → **紧跟又一条 `page-open` + `pageshow pct=67`** | 「游戏网页又自动弹出三四次」「进度条重来」 |
| 3 | **「页面是否活着」只看 `/api/vrplus/*`** —— 页面明明在写 `[PAGE]` 留痕，却因 inbox 轮询没打上点而被判失联 | 同一秒：`心跳 游戏页age=56s` ←→ 连续 `[PAGE] 状态 进度=80%` | 活着的页面被判失联 → 再开浏览器 → 页面反复重载 |

**外加一条好消息**：留痕里出现 `收到平台机位表 Machines=2 台 → 视为已上线（停止 0x01 注册）`
⇒ **游戏通道协议本身完全正确**：`0x01` 发出去了、平台也回了机位表。问题**不在协议**。

### 16.1 留痕原文（重建时序）

```text
15:02:12.968 [APK] ==== 进程启动 build=2026-09-19-forensics pid=12492 ====
15:02:12.987 [APK] onCreate 平台驱动=false intent=null sLaunched=false 游戏页age=-1ms   ← 根因 1
15:02:13.695 [APK] 第 1 次拉起浏览器 URL=http://localhost:8080/
15:02:15.503 [PAGE] page-open t=1789801335296 url=http://localhost:8080/ vis=visible
15:02:15.567 [APK] verifyLaunch：浏览器已接管（本页已退后台）→ 启动完成，上报 0x01
15:02:15.736 [PAGE] pageshow pct=80 st=menu pd=false xr=false
15:03:13.044 [APK] 心跳 8080=true 游戏页age=215ms ... VRPlus=未建桥 平台=null        ← 桥迟迟没建
15:03:13.568 [PAGE] DEAD:beforeunload t=... pct=100 st=menu pd=true xr=false        ← 被导航走，且无 platform-gone
15:03:13.589 [PAGE] visibility:hidden
15:03:13.705 [PAGE] pagehide
   ……（静默约 3 分钟，VRPlus 一直「未建桥」）……
15:06:31.189 [PAGE] page-open t=1789801591001                                        ← 新页面
15:06:31.347 [PAGE] pageshow pct=67
15:06:32.316 [APK] verifyLaunch：2s 后浏览器尚未接管 → 先退后台让位（不重开页面）      ← 根因 2
15:06:32.637 [PAGE] visibility:hidden                     ← 配置页面板压住了浏览器
15:06:33.827 [APK] verifyLaunch：让出前台后仍在配置页 → 再拉第 2 次
15:06:33.859 [APK] 第 2 次拉起浏览器 URL=http://localhost:8080/
15:06:34.031 [PAGE] visibility:visible t=...              ← 让位其实已生效（浏览器回来了）
15:06:34.728 [PAGE] page-open t=1789801594724             ← ★ 又一条 page-open = 浏览器【重新导航】
15:06:35.021 [PAGE] pageshow pct=67                       ← 进度条从头开始
15:06:35.861 [APK] verifyLaunch：重试 2 次浏览器仍未接管 → 保留配置页
15:06:43.254 [APK] 心跳 8080=true 游戏页age=56s sLaunched=false 拉起次数=2 VRPlus=connected=true 平台=192.168.31.228
15:06:44.196 [PAGE] 状态 进度=80%                         ← 根因 3：页面在写留痕，却被判 age=56s
15:06:48.188 [PAGE] 状态 进度=100% state=menu 预加载完毕 XR=off
   ……（进度在 80% ↔ 100% 之间反复横跳 = 多个页面实例并存）……
```

### 16.2 为什么 `resumed` 在 PICO 上不可靠

常规 Android：`startActivity` 拉起别的 app → 本 Activity `onPause` → `resumed=false`。
PICO 的 XRShell 把**每个 Activity 渲染成一个 2D panel**（多窗口式），于是
`moveTaskToBack()` 或被其他 app 覆盖时，本 Activity **未必产生标准 onPause** → `resumed` 仍是 `true`。

留痕里 `visibility:visible`（浏览器页面回到前台）出现在「判定仍在配置页」**之前**，
说明让位动作**已经生效**，只是判据读错了 → 于是二次 `startActivity` → 浏览器重新导航。

### 16.3 三处修复（2026-09-19 已落地并重打包）

**① 平台驱动判据改用「有没有 LAUNCHER category」**

```java
// 桌面 launcher 启动一定带 CATEGORY_LAUNCHER；平台/启动器 `am start -n <pkg>/.MainActivity` 不带任何 category
private static boolean computePlatformDriven(Intent it, String data) {
    if (data != null && !data.isEmpty()) return true;   // 带 -d 最硬
    return !isFromLauncher(it);                          // 否则「不是从桌面点的」即平台
}
```

配套：`onCreate` / `onNewIntent` 里，若 `platformDriven && platformPc == null`，用 **setup.xml 的 platformIP**
兜底建桥 —— 平台不带 `-d` 时也能立刻把 `0x01` 发出去，平台就不会因为「等不到上线」而每 20s 重拉整套启动。

> 需要手动看配置页时：`adb shell am start -n com.GoodNet.DeepmindHacker/.MainActivity -c android.intent.category.LAUNCHER`

**② 启动自检改判「页面有没有真的发过请求」**

```java
private boolean pageRequestedSinceLaunch() {          // 本次拉起之后页面请求过 = 真的起来了
    if (sServer == null || launchStartedAt <= 0) return false;
    long t = sServer.lastPageHitMs();
    return t > 0 && t >= launchStartedAt;
}
private boolean launchSucceeded() {
    if (!resumed) return true;                        // 已退后台
    if (pageRequestedSinceLaunch()) return true;      // 页面在跑（新增，比 resumed 可靠）
    long age = gamePageAgeMs();
    return age >= 0 && age < 8000;                    // ⚠ 不看 isGamePageAlive 的 15s 宽限期
}
```

重拉门槛同步提高：**必须「既没退后台、页面又一条请求都没发过」**才敢再 `startActivity`（等待 1500ms → 2000ms）。
宁可少拉一次（后续 `onResume` / 平台重拉会补），也绝不重载正在跑的页面。

**③ 「页面存活」口径扩大到页面发出的任何请求**

`GameServer.lastVrplusHitMs` → **`lastPageHitMs`**：`/api/vrplus/*` 与 `/api/page/*` **都打点**；
唯一例外是 `GET /api/page/forensics`（人/浏览器来读留痕的诊断入口）——
否则人一打开留痕页就等于替已死的游戏页「续命」，失联判定永远不成立。

外加：`maybeLaunch` 判定失联时一并清 `sLaunchedAt`（否则 `isGamePageAlive()` 的 15s 宽限期会残留）。

### 16.4 关于「必须手动点『进入 VR』」

**这不是 bug，是浏览器安全模型**：WebXR `requestSession('immersive-vr')` 要求
**transient user activation**（真实用户手势），网页无法自动进入沉浸模式。
原版 Unity 游戏能直进是因为它是原生 app，不受这条约束。

可行方向（都需实测，且各有代价）：
- 页面加载完把「进入 VR」做成**屏幕中央的大按钮 + 高亮**，减少寻找成本（纯前端、零风险）；
- 试**不带手势**调用 `requestSession` —— 个别浏览器版本在「本会话已授权过」时可能放行（不可依赖）；
- 用 APK 内 WebView 托管 + 原生侧请求 XR —— **已证伪**（WebView 无 WebGL，跑全游戏必崩）。

### 16.5 留痕判读表（更新版，下次照这个对）

| 留痕里出现 | 真凶 |
|---|---|
| `onCreate 平台驱动=false intent=null` | 平台 `am start` 不带 `-d`（旧判据失效）—— **已修** |
| `verifyLaunch：让出前台后仍在配置页 → 再拉第 N 次` | `resumed` 误判 → 即将二次 `startActivity`（**已修**） |
| **紧随其后的第二条 `page-open`** | 浏览器**重新导航**（页面重载）=「网页又弹一次 / 进度条重来」 |
| `心跳 … 游戏页age=<很大>` **同时**有 `[PAGE] 状态 …` | 存活口径漏了 `/api/page/*`（**已修**） |
| `收到平台机位表 Machines=N 台` | ✅ 游戏通道正常（`0x01` 已被平台接受） |
| `心跳 … VRPlus=未建桥 平台=null` 持续很久 | 桥没建（平台不带 `-d` 且未走 setup.xml 兜底）—— **已修** |
| `pid=` 变化 / `心跳：8080 失联` | 平台那轮 `kill` 真把我们 force-stop 了 |
| `[PAGE] visibility:hidden` 后紧跟可见 | 配置页**面板**压住了浏览器（抢前台） |
| `DEAD:platform-gone` | 我们自己的看门狗判死（可能是误判） |
| `DEAD:beforeunload` + `pagehide`（**没有** platform-gone） | 页面被**外部导航**掉（浏览器层重载/替换），不是游戏自杀 |
| `[APK] 收到平台关闭指令 0x10 closeGame` | 平台**真的**要求关闭（合法退出） |

### 16.6 玩家所见 ⇄ 机制 对照（本轮全部对上）

| 你的观察 | 机制 |
|---|---|
| 平台启动后**第一次拉起就闪退** | ② 二次 `startActivity` 让页面重新导航；叠加 ① 配置页面板抢前台 |
| 接着**网页又自动弹出三四次** | ② 重试 + ③ 误判失联后重开浏览器，两条路都在重复 `ACTION_VIEW` |
| 需要**手动点「进入 VR」** | 浏览器安全模型（16.4），非 bug |
| 平台关闭后留下 **about:blank 空白页** | 设计行为：页面自杀（`location.replace('about:blank')`）实现「平台关闭生效」。可改为显示一个「游戏已结束」提示页（见下） |

> 关于空白页：若希望「关闭后不留白」，可以做 —— 页面被要求关闭时**不跳 about:blank**，而是渲染
> 一个全屏「本局已结束」提示并停掉所有轮询（释放资源）。代价是浏览器里始终留着一个页面，
> 下次平台启动仍需重新导航（而重载已经不会再被我们自己的重试触发）。

---

## 17. ★ 第二次留痕定论（2026-09-19 15:3x）：关闭后白页 + 「再启动什么都不弹」

### 17.0 先说结论

| # | 现象（用户） | 机制（留痕实测） | 处置 |
|---|---|---|---|
| ① | 启动正常、网页**只弹一次** | §16 三处判据修复生效 | ✅ 无需再动 |
| ② | 平台关闭后出现**浏览器白页** | 页面自己 `location.replace('about:blank')`（设计行为）→ 浏览器只剩空白标签 | 四修：**不再卸载页面**，改「本局已结束」待机页 |
| ③ | **再次启动没有网页弹出** | 至少两条路：<br>(a) `maybeLaunch()` 开头的 `if (!resumed) return;` **静默吞掉**平台那次拉起（留痕铁证见 17.1-c）；<br>(b) 那一轮之后 APK 侧**连「进程启动」行都没有**（17.1-d）→ 不是「拉起了没弹」，而是**根本没被拉起 / 启动即死** | 三修 + 启动可见化（17.3） |

### 17.1 留痕读出的四条硬事实

**(a) 关闭链路本身完全正常**（所以②不是协议问题）：

```
[APK] 收到平台关闭指令 0x10 closeGame（已入队 cmd=16 + 回 0x02）
[PAGE] {"ev":"DEAD:platform-gone","msg":"平台关闭指令，游戏通道 0x10 closeGame", ...}
[PAGE] {"ev":"DEAD:beforeunload", ...}
[PAGE] {"ev":"DEAD:pagehide","persisted":false,"pct":100,"st":"playing", ...}
[PAGE] {"ev":"visibility:hidden","persisted":false, ...}
```

`persisted:false` = **真卸载**（不是 bfcache）。页面一走，浏览器标签就只剩 `about:blank` —— 白页由此而来。

**(b) §16 的修复确实生效**：

```
[APK] onCreate 平台驱动=true intent=192.168.31.228 action=android.intent.action.MAIN cats=null
[APK] 收到平台机位表 Machines=2 台 → 视为已上线（停止 0x01 注册）
```

即：平台驱动判对了（`cats=null` → 非桌面启动）、桥建上了、`0x01` 被平台接受（回了机位表）。
所以「平台能不能认到我们」这条链路已经通了，剩下的问题都在**页面生命周期**与**拉起动作本身**。

**(c) ★ 关键：那次平台拉起被“静默吞掉”了**

```
15:38:20.877 [APK] onCreate 平台驱动=true intent=192.168.31.228 … sLaunched=true 游戏页age=56070ms
            ←（此后 8 秒内**没有任何一行**）
15:38:28.611 [APK] onCreate 平台驱动=true …            ← 平台 +8s 重发 start
15:38:28.665 [APK] maybeLaunch：判定游戏页已失联（age=56124ms）→ 允许重新拉起浏览器
15:38:30.031 [PAGE] {"ev":"page-open","url":"http://localhost:8080/"}
15:38:30.692 [APK] verifyLaunch：启动成功（本页已退后台）
```

第一次拉起（15:38:20）**什么都没发生**：没有「第 N 次拉起浏览器」、没有「判定游戏页已失联」、
也没有 `verifyLaunch` 的任何一行。能吞掉它的只有 `maybeLaunch()` 开头那两个静默 `return`，
而那时 `sServer` 是复用的（`serverReady=true`）⇒ **吞点就是 `if (!resumed) return;`**。

为什么 PICO 上会 `!resumed`：XRShell 把每个 Activity 渲染成一个 2D 面板；平台在**后台**执行
`am start` 时，本页只是「有窗口」，浏览器/其他页面仍在前台 → 本页没进 `onResume`。
旧实现把它当成「后台态 startActivity 会被拦，等 onResume 再拉」，而 `onResume` 可能一直不来。

**(d) ★ 最后一轮之后：APK 侧零事件**

两张留痕截图相隔约 1 分钟，而尾部完全一致（最后一行都是 `15:39:40.004 心跳 … 游戏页age=24945ms`）。
也就是说从那一刻起，留痕**再没有写入任何一行** —— 包括 `PageForensics.init()` 必定会写的
`==== 进程启动 pid=… ====`。⇒ 「再次启动没网页弹出」不是「拉起了但页面没弹」，
而是**我们的进程压根没被创建，或创建即崩**。

这两种情形在旧留痕里长得完全一样（都是「日志戛然而止」）—— 这正是 §17.3 第 4 项要解决的盲区。

### 17.2 为什么不能「关闭后照样卸载页面」了

除了白页，卸载页面还有第二笔代价：**平台下一次「开始」只能整页重载** ——
重跑 6~9s 预加载，且新页面的首轮 inbox 轮询有捡到上一局残留 `closeGame` 的风险（§13 的老坑）。

### 17.3 本轮落地（4 处，均已重打包：`build=2026-09-19b-idle-revive`，50.03 MB）

**① 页面不再卸载 → 进「本局已结束」待机态**（`src/game/game.js`）

- `_onPlatformGone` 末尾的 `setTimeout(() => location.replace('about:blank'), 400)` **删除**；
  改为 `_enterClosedIdle(why)`：
  - `toMenu()`（已退 VR / 停 BGM / 清实体）+ 全屏黑底封盖「本局已结束 / 等待平台重新开始…」；
  - `game._renderPaused = true` → `main.js` 主循环直接 `return`（**不跑 game.update / world.render**，待机期不占 GPU、不发烫）；
  - **inbox 轮询照常跑**（页面与 APK 唯一的纽带，也是「页面还活着」的活体信号）。
- 「与平台断连」路径（看门狗判死）同样只封盖不卸载；`_startReviveProbe` 的职责相应从「别卸载」变成「APK 回来就撤盖」。

**② 平台再次「开始」= 唤醒待机页，而不是重开浏览器**（`MainActivity.reviveClosedPage` + `VRPlusLink.enqueueLocal`）

页面活着 ⇒ `maybeLaunch` 不会重开浏览器（这是防重载的保护，必须保留）。于是平台那句「开始」
必须由我们主动递进去：往页面下行队列放一条**本地 cmd3**。

- `VRPlusLink.enqueueLocal(cmd, why)`：`downlink.add(stamp({"cmd":3,"local":true}))`（不经过 UDP，平台不知道）；
- 页面侧 `game.js._onPlatformCommand(3)` 已有 `if (this.state !== 'menu') return;` 守卫 ⇒
  **正在玩的一局收到它是空操作**，所以平台那套「主机没上线就 +20s 重拉 `am start`」不会打断游戏；
- 收到后：撤盖 + `_renderPaused=false` + `start(0)` 开新局 —— **整页零重载**（比开浏览器快 6~9s）。

**③ `maybeLaunch` 三修：把「静默」全部消灭**（`MainActivity.java`）

| 改动 | 为什么 |
|---|---|
| 平台驱动时**不再要求 `resumed`**；非平台驱动（用户手点按钮）才等 `onResume` | 17.1-c 的吞点；平台 `am start` 在 PICO 上未必让本页进 resumed |
| 每个 `return` 都落留痕（`skipLaunch(why)`） | 静默早退是前几轮排查最大的黑洞 —— 今后留痕里能直接看到「为什么没拉」 |
| 「页面还活着」判据改为**6s 内有请求**（`pageAliveForLaunch()`），**不套** 15s 加载宽限期 | 15s 宽限会把「页面其实已经没了」误判成活着 → 于是只退后台、不重开浏览器 |
| 新进程 `lastPageHitMs==0` 时先等 1.2s 再判 | 区分「页面已死」与「页面活着、只是还没轮到下一次轮询(≤1s)」；否则每次 APK 被 kill 后重拉都白重载一次 |
| 刚拉起 6s 内不重开 | 防「对同一 URL 二次 startActivity → 重新导航」（§16 的老坑） |
| `verifyLaunch` 重试上限 2 → 3 次，间隔 2s → 2.5s | 页面加载慢时多给一次机会，同时每次重试前都要求「页面零请求」 |

**④ 启动可见化：把「戛然而止」变成可判读**（`CastApp.java` / `PageForensics.java`）

- `CastApp.onCreate`（**早于任何 Activity**）就先 `PageForensics.init()` + 落一行
  `CastApp.onCreate（Application 级：早于任何 Activity）`；
- 未捕获异常处理器**额外**把崩溃写进留痕（`[CRASH] 未捕获异常 线程=… → 类型: message` + 栈），
  于是头显上打开 `/api/page/forensics` 就能直接看到崩溃原因（**不必连 adb**）；
- `MainActivity.onCreate` 进入时补一行 `MainActivity.onCreate 进入` —— 与「进程启动」配对即可分辨：

| 留痕形态 | 含义 |
|---|---|
| 只有 `==== 进程启动 ====`，没有 `MainActivity.onCreate 进入` | 进程起来了、Activity 没被创建（`am start` 没到 / 被系统拦） |
| 有「进入」，缺后面的 `onCreate 平台驱动=…` | 崩在启动路径中（`[CRASH]` 行会给出栈） |
| 连 `==== 进程启动 ====` 都没有 | **这一轮就没人启动我们**（平台没发 / 被拦在系统层）—— 不是我们的 bug |
| `PageForensics.init` 拿不到外部目录 | 改为**回退内部私有目录**，不再静默关闭留痕 |

### 17.4 产物校验（怎么确认真进包了）

```
dex 命中：reviveClosedPage / pageAliveForLaunch / enqueueLocal / waitedFirstHit /
          lastPageClosed / lastPageState / skipLaunch / pageClosed /
          「maybeLaunch 跳过」/「MainActivity.onCreate 进入」/「CastApp.onCreate（Application 级」
旧串消失：2026-09-19-forensics → 0 次（BUILD_TAG 已换成 2026-09-19b-idle-revive）
包内 assets/game/src：game.js 含 _enterClosedIdle，且**再无** location.replace 活代码；
                     main.js 含 game._renderPaused；vrplus.js 含 &cs=
```

### 17.5 留痕判读表（§17 新增行）

| 留痕里出现 | 含义 |
|---|---|
| `maybeLaunch 跳过：……` | 每次「没拉起」都被记下来了；按原因直接定位（不再有静默黑洞） |
| `maybeLaunch：平台驱动但 Activity 未 resumed → 照常尝试拉起` | 正是 17.1-c 那个吞点，现在**不再吞** |
| `[PAGE] 状态 … 【待机：本局已结束，等平台重新开始】` | 待机态生效（页面保留、未卸载）→ 白页现象应消失 |
| `入队本地 cmd=3（平台重新启动本局…）` + `→ 页面轮询取走 … cmd=3` | 唤醒链路通了；**此时不该再出现 `page-open`**（没重载） |
| `[CRASH] 未捕获异常 …` | 有崩溃，栈就在下一行（免 adb） |
| 尾部**连 `==== 进程启动` 都没有** | 这一轮没人启动我们（排查方向在平台侧） |

### 17.6 待 PICO 实测（本次要一次性看全的四件事）

1. 关闭后：头显显示**黑底「本局已结束」**，浏览器**不再白页**；
2. 平台再次「开始」：**不做整页重载**（留痕里无 `page-open`），1s 内页面 `state` 由待机转为 `waiting/playing`；
3. 若浏览器没被顶到前台：留痕应有 `让位`/`maybeLaunch 跳过` 一类痕迹，而不是「什么都没有」；
4. 万一还是「什么都没弹」：**这一次一定能分辨**是「没被启动」（无 `==== 进程启动`）还是「启动即崩」（有 `[CRASH]` 行）。

---

## 18. ★ 第三次留痕（2026-09-19 17:05，平台连启动三次）：一个根因，三个现象

### 18.0 先说结论

**我们从来没有把浏览器顶到前台。** 三个现象是同一个根因的不同侧面：

| 玩家看到 | 机制 |
|---|---|
| 第 1 次：网页起来了，但**自动回到后台**，得点一下浏览器才在最上面（「之前也是」） | `markLaunchSucceeded()` 里 `moveTaskToBack(true)` + `finish()` → 前台让给了**别的**应用（平台启动器），浏览器 panel 留在后面 |
| 第 2 次：要平台**再启动一次**才能看到那个网页 | 命中「页面仍在 → 不重开浏览器（防重载）+ 退后台」分支：防重载对了，但**谁也没把浏览器顶上来** |
| 第 3 次：**什么都没弹出来** | 同上，或 onCreate 的「零界面」分支（`moveTaskToBack + finish`），同样没人顶前台 |

留痕里的时间差是决定性的：`finish 配置页` 之后 **8ms** 页面就 `visibility:hidden`。

> 这解释了为什么前几轮一直在「要不要重新 startActivity」上打转却修不好 —— 真正的缺失动作不是
> 「再拉一次」，而是「**把已经在跑的那个浏览器顶回最前**」。

### 18.1 玩家描述（逐字，含一处此前遗漏的细节）

> 总共启动了三次。第一次：可以正常启动（有个遗漏的点忘记说了，**游戏网页启动后自动回到后台了，
> 需要点一下浏览器才能置于最上面，之前也是**）第二次需要平台启动第二次才能在后台网页看到。
> 第三次没有弹网页了。

这条「遗漏的点」价值极高：它把第 2、3 次的症状与第 1 次**串成了同一件事**。

### 18.2 本轮留痕的证据边界（诚实记账）

给出的是**头显屏拍照片**，日志字号小 + 有透视变形，只能逐段辨认。可确认的两段：

```
17:05:50.169 [APK] 平台驱动启动完成 → finish 配置页（之后平台重拉走「零界面」分支）
17:05:50.177 [PAGE] {"ev":"visibility:hidden", … "pct":60,"st":"menu" …}   ← 8ms 后就被盖住
…
17:06:5x.xxx [APK] maybeLaunch：判定游戏页仍在（… state=menu 待机=… ）→ 不重开浏览器（防重载），唤醒待机页 + 退后台
```

**其余行不做推断**（照片不足以逐行确认）—— 因此本轮同时把「怎么把留痕变成文本」这件事一并解决了（§18.4-c）。
这条纪律是前面几轮用「凭猜改协议」换来的：证据不足时只改有把握的那一处。

### 18.3 根因（代码级）

`MainActivity` 里「收起自己」的动作一共有 **4 处**，全部是 `moveTaskToBack(true) [+ finish()]`，
**没有任何一处把浏览器顶到前台**：

| 位置（四修前） | 分支 |
|---|---|
| `markLaunchSucceeded()` | 拉起成功后的统一收尾 |
| `maybeLaunch()`「页面仍在」分支 | 平台重复拉起（防重载） |
| `onCreate()`「零界面」分支 | 平台 +20s 重拉，且判定游戏页仍在 |
| `verifyLaunch()` 第一步「退后台让位」 | 2s 自检未通过时的让位 |

`moveTaskToBack` 的假设是「我们退开，浏览器自然浮上来」。在标准 Android 上勉强成立
（浏览器是独立 task 且刚被 start），但 **PICO XRShell 把每个 Activity 渲染成 2D panel、按焦点切换**，
我们把前台让出去之后，接手的往往是**平台启动器**，而不是浏览器。

**关键佐证（本次最有力的一条）**：玩家自己的土办法就是「点一下浏览器」—— 即**启动浏览器这个应用**。
这一步在 PICO 上是有效的（点完页面就 `visibility:visible` 并继续跑）。
那么把同一个动作**程序化**即可，且它**不导航**（不是 ACTION_VIEW + URL），所以不会重载游戏页。

### 18.4 本轮落地（`build=2026-09-19c-bring-front`）

**(a) 新增 `yieldToBrowser(reason)`：把「顶前台」和「收起自己」变成一个原子动作**

```java
private void yieldToBrowser(String reason) {
    boolean ok = bringBrowserToFront();      // ① 先把浏览器顶到最前
    PageForensics.line("APK", "让位给浏览器（" + reason + "）：顶前台=" + ok + " 浏览器=" + lastBrowserPkg …);
    if (!ok) moveTaskToBack(true);           // 拿不到 launcher intent 才回退旧行为
    if (platformDriven) { …; finish(); }     // ② 再收起自己（面板窗口才不会挡）
    new Handler(getMainLooper()).postDelayed(() -> bringBrowserToFront(), 900);  // ③ 补压一次
}
```

顺序即语义：**先顶前台，再收自己**。反过来的话，收起本页的瞬间前台会落到别的应用上。

**(b) `bringBrowserToFront()`：只顶前台，不导航**

```java
Intent li = getPackageManager().getLaunchIntentForPackage(pkg);  // ← 启动器 Intent，不带 URL
li.addFlags(FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_REORDER_TO_FRONT);
getApplicationContext().startActivity(li);
```

- `pkg` = `lastBrowserPkg`（上次**成功拉起游戏页**的那个浏览器包，在 `openInPicoBrowser()` 里记下），
  没记录过就 `firstBrowserPkg()`（候选名单里第一个装了的）；
- **绝不能**用 `ACTION_VIEW + URL` 来「顶前台」—— 那就是重新导航 = 重载页面（前几轮反复踩的坑）；
- 4 个旧的 `moveTaskToBack` 调用点全部改走 `yieldToBrowser()`；`finishPlatformActivity()` 已并入其中。

**(c) 留痕读法升级：不再逼着人拿头显拍照**

| 用法 | 效果 |
|---|---|
| 头显浏览器 `/api/page/forensics` | 尾部 300 行纯文本（原样保留） |
| 电脑浏览器 `http://<头显IP>:8080/api/page/forensics?follow=1` | 深色页 + **每 2 秒自动刷新** = 实时看头显日志 |
| 电脑浏览器 `http://<头显IP>:8080/api/page/forensics?download=1` | `Content-Disposition` 附件，**一键把全文 .log 存到电脑**，可直接发文件 |
| adb（需连线） | `adb pull /storage/emulated/0/Android/data/com.GoodNet.DeepmindHacker/files/page-forensics.log` |

⚠ 电脑上必须用**头显的局域网 IP**，不是 `localhost`（那是电脑自己）。APK 进程活着时才连得上；
但留痕文件**跨 force-stop 存活**，APK 一被平台拉回来就能读到之前那一段。

**(d) `pageAliveForLaunch()` 新增判据 ②：待机页即使停止轮询也算活着**

```java
if (age >= 0 && age < 6000) return true;                     // ① 真在轮询
if (pageClosed() && sLaunchedAt > 0 && now - sLaunchedAt < IDLE_TRUST_MS) return true;  // ② 待机页
```

为什么需要：浏览器 panel 被盖住后 **Chromium 会冻结后台标签**（留痕里 `pagehide persisted=true` 就是证据）
→ 页面 `setInterval` 停摆 → `age` 无限增长 → 被判「页面已死」→ 重开浏览器 = **整页重载**。
而「本局已结束」的待机页（`cs=1`）恰恰是我们**刻意保留**、最不该重载的那一种。
`IDLE_TRUST_MS = 10 分钟` 只是保险丝。

### 18.5 留痕判读表（§18 新增行）

| 留痕里出现 | 含义 |
|---|---|
| `让位给浏览器（…）：顶前台=true 浏览器=com.oculus.browser（不带 URL，不会重载）` | 顶前台成功。**若玩家仍然看不到页面 → 说明 PICO 不认这一招**，改从下策（见下） |
| `让位给浏览器（…）：顶前台=false … （失败 → 回退 moveTaskToBack）` | 拿不到该包的 launcher intent（`<queries>` 可见性问题）→ 需要补 Manifest |
| `让位补压（收起配置页后 900ms）：顶前台=…` | 补压结果；两次都 true 却仍不可见 = 不是「没顶」而是「顶了又被抢」 |
| `pageAliveForLaunch：待机页 age=…ms 但 cs=1 → 视为「活着但被冻结」` | 页面被后台冻结，正在**避免一次整页重载**（这是好事） |
| `收起配置页（…）→ 之后平台重拉走「零界面」分支` | `finish()` 已执行（取代旧的 `finishPlatformActivity` 文案） |

### 18.6 待 PICO 实测（三件事）

1. **第 1 次启动后不要再手点浏览器** —— 网页应自己就在最上面（这是本次的核心验收点）；
2. 平台关闭再「开始」（第 2、3 次的形态）：网页应**重新出现**且**不重载**（留痕里无二次 `page-open`，
   1s 内 `state` 由待机转 `waiting/playing`）；
   > ⚠ 2026-09-19 第四次留痕后**这条已作废**：待机唤醒**不该**转 `waiting/playing`（那正是 §19.2 的
   > 「代玩家开局」）。新验收标准见 §19.7 —— **`cs` 1→0 且 `state` 停在 `menu`**。
3. 装包后**先用电脑浏览器**打开 `http://<头显IP>:8080/api/page/forensics?download=1` 存一份全文，
   复现一次再把新的一份发过来 —— 以后都走这条路，不用拍照。

### 18.7 若「顶前台」也无效，下一手是什么（先记账，不预先实现）

按「从可靠到冒险」排序：

1. `ActivityManager.getAppTasks()` / `moveTaskToFront()` —— 需要系统权限，PICO 上大概率不可用（先试才知道）；
2. 用 `startActivity(ACTION_VIEW + URL + FLAG_ACTIVITY_REORDER_TO_FRONT)` —— 可能顶上来但**有重载风险**，
   只有在确认页面已被冻结/丢失、重载代价可接受时才用；
3. 头显侧接受现实：把「点一下浏览器」做成**可预期的一次性动作**（例如平台侧改启动方式，或明确告知操作员）。

---

## 19. ★ 第四次留痕（2026-09-19 17:36–17:42，一次会话启动四轮）：「有时没反应」+「有时自动开局」

玩家原话（逐字）：

> 第一次启动正常。后面启动有时候正常，有时候没反应，且后面正常时，预览界面和第一次不一样，
> 显示影片播放中，玩家还没点开始，游戏里影片播放结束自动进入了第一关。

留痕文件：`page-forensics.log`（电脑端 `?download=1` 一键下载，**不用再拍照**），
`build=2026-09-19c-bring-front`，155 行覆盖 17:36:50 – 17:42:09，全程同一 pid（23948，**没被平台杀过**）。

### 19.0 先说结论

| # | 现象 | 根因 | 位置 |
|---|---|---|---|
| 1 | 后面启动**有时「没反应」** | 平台那次 `am start` **不带 `-d` 却带 `CATEGORY_LAUNCHER`** → `platformDriven=false` → 配置页建出来且**永不关闭**，盖住浏览器；页面随即被冻结（**21 秒零请求**），玩家只看到我们的配置页 | **APK**（判据不完备） |
| 2 | 后面启动**预览界面不一样 + 自动进第一关** | 本地唤醒（`enqueueLocal(3)`）被写成了「撤盖 + `start(0)`」→ 玩家还没进 VR（`XR=off`）就在 2D 里播完开场影片并自动开了第 1 关 | **页面**（语义错） |
| 3 | 17:40:40–17:42:00 那 80 秒「按了开始没反应」 | 留痕里**零事件**（连 `MainActivity.onCreate 进入` 都没有）→ 这一轮**平台根本没启动我们** | 平台侧（不在我们可控范围） |

### 19.1 留痕逐轮时序（关键行）

```
# L1 17:36:50  ← 玩家认定的「正常」
17:36:50.655 进程启动 build=2026-09-19c-bring-front pid=23948
17:36:50.723 onCreate 平台驱动=true intent=192.168.31.228 cats={LAUNCHER} sLaunched=false 游戏页age=-1
17:36:51.704 收到平台机位表 Machines=2 台 → 视为已上线
17:36:52.616 第 1 次拉起浏览器 URL=http://localhost:8080/        ← ★ 无 cast 参数（PC 还没发现）
17:36:54.617 verifyLaunch：启动成功（本页已退后台）→ 上报 0x01 + 收起配置页
17:36:54.628 让位给浏览器（…）：顶前台=true 浏览器=com.pico.browser
17:36:55.567 让位补压（收起配置页后 900ms）：顶前台=true
17:37:13 [PAGE] menu XR=off → 17:37:17 waiting XR=on → 17:37:29 playing XR=on   ← 玩家进 VR 才开局 ✓
17:37:40.346 收到平台关闭指令 0x10 closeGame → 17:37:42 [PAGE] menu 【待机…】

# L2 17:38:16  ← 「没反应」
17:38:16.281 onCreate 平台驱动=false intent=null action=MAIN cats={LAUNCHER} sLaunched=true 游戏页age=55ms
17:38:16.335 maybeLaunch：判定游戏页仍在（age=109ms state=menu 待机=true）→ 唤醒待机页 + 退后台
17:38:16.335 入队本地 cmd=3 → 已唤醒待机页：本地 cmd3 已入队（页面 1s 内撤盖并开局）
            ✗ 没有「收起配置页」这一行（platformDriven=false → 永不 finish）
17:38:18.160 [PAGE] state=waiting XR=off          ← ★ 玩家没进 VR 就被开局了
17:38:23.162 [PAGE] state=waiting XR=off
            ✗ 此后 21 秒页面零请求（浏览器面板被我们的配置页盖住 → 标签被冻结）
17:38:36.132 收到平台关闭指令 0x10 closeGame

# L3 17:38:44  ← 平台再发 start（这次带 -d）→ 整页重载
17:38:44.378 maybeLaunch：判定游戏页已失联（age=18214ms）→ 允许拉起浏览器
17:38:44.407 第 1 次拉起浏览器 URL=http://localhost:8080/?cast=1&pc=192.168.31.228:8443&mode=webrtc
17:39:11 [PAGE] waiting XR=on → 17:39:22 playing XR=on ✓

# L4 17:40:11  ← 「影片自动播放并自动进第 1 关」
17:40:11.441 onCreate 平台驱动=true → 零界面分支：判定游戏页仍在（待机=true）→ 不建界面
17:40:11.441 入队本地 cmd=3 → 已唤醒待机页
17:40:11.464 收起配置页（平台重复拉起：游戏页仍在（零界面分支））
17:40:13.275 [PAGE] state=waiting XR=off          ← ★ 2D 里已经开始播影片
17:40:24.279 [PAGE] state=playing XR=off          ← ★ 影片播完，自动进第 1 关
17:40:27.276 [PAGE] state=playing XR=on           ← 玩家这时才进 VR，已经晚了
17:40:36.274 [PAGE] state=menu  XR=off            ← 玩家退出 VR
17:40:40.362 收到平台关闭指令 0x10 closeGame
# 17:40:40 → 17:42:00：80 秒里留痕**零事件**（无 进程启动 / 无 onCreate / 无 PAGE 行）
17:42:00.437 收到平台关闭指令 0x10 closeGame（此时页面已是待机 → 平台的状态机可能仍认为「游戏在运行」）
```

### 19.2 根因一（页面侧）：本地唤醒**代玩家开局**

`MainActivity.reviveClosedPage()` 的本地 cmd3 本意只是「把待机页叫回来」，但页面侧写成了
「撤盖 + 恢复渲染 + `start(0)`」。而唤醒进来的那一刻玩家**还在 2D**（`XR=off`）——
`start(0)` 直接进等待房间（开场影片，不可跳过），影片结束自动 `_loadLevel(0)`：

```
state=waiting XR=off  →  state=playing XR=off  →（3 秒后）XR=on
```

⇒「第一次启动停在菜单等玩家点开始」与「后面每次启动都停在影片并自动开局」两种行为不一致。

**修（`src/game/game.js`）**：`_onPlatformCommand(3|4)` 里按 `payload.local` 分流 ——
本地唤醒**只撤盖 + 恢复渲染 + 回菜单**，`return`，不再 `start(0)`：

```js
if (payload && payload.local) {
  this.log('平台已重新开始本局 → 退出待机回到菜单，等玩家点「进入 VR」');
  VRPlus.reportEvent('idle-revived', { cmd });
  return;
}
```

语义定调：**外部平台那句「开始」= 把游戏页拉起来到菜单**（与第一次启动完全一致）。
真开局只能由玩家手势触发（`main.js: sessionstart → game.start()`）—— `immersive-vr` 会话本来
就无法程序化创建。旧的「平台下发 3/4 就直接开局」分支保留（老协议兼容），但**本地唤醒不再走它**。

### 19.3 根因二（APK 侧）：判据不完备 → 配置页永不关闭

§16 建立的判据是「带 `-d` ∨ 非 `CATEGORY_LAUNCHER` = 平台」。而 L2 那次平台的 `am start`
**既不带 `-d`，又带 `CATEGORY_LAUNCHER`** —— 与「用户点桌面图标」在上层完全同形，必然判错：

- `yieldToBrowser()` 里 `if (platformDriven) finish()` 不成立 → **配置页留在最前**；
- 面板盖住浏览器 → Chromium 冻结后台标签 → 页面 21 秒零请求（连心跳状态行都断了）。

**修（`MainActivity.java`）**：新增**会话级兜底判据** `platformRelaunchFallback()`：

```java
if (sVRPlusLink == null || !sVRPlusLink.isConnected()) return false;  // ① 平台通道已连（收到过机位表）
if (!sLaunched || !pageAliveForLaunch()) return false;                // ② 已拉起过且页面仍在
if (looksLikeManualLaunch()) return false;                            // ③ 不是人工点的
return true;                                                          // ⇒ 只可能是平台重拉
```

- ③ 用 `Activity.getReferrer()`：真 launcher 启动带 `android-app://<launcher 包名>`，`am start` 没有；
  取不到就**当平台**（误判方向的代价不对称）。
- **还有一个时间差要补**：平台不带 `-d` 的**首拉**（新页面刚出生）在 `onCreate` 那刻 `sLaunched=false`、
  兜底判据②不成立；但拉起后 2s 走到 `markLaunchSucceeded()` 时，平台通道早已握手完（机位表 57ms 就回）
  ⇒ 那里再刷一次更宽的「平台在场」判据 `platformLike()`（= 平台通道已连 + 不是人工点的）：
  ```java
  if (!platformDriven && platformLike()) { platformDriven = true; /* 记留痕：启动收尾时刷新判据 */ }
  ```
  不刷的话首拉的配置页同样会永不关闭（同一种「没反应」）。
- 同时在 onCreate/onNewIntent 的留痕行里加上 `flags=0x… ref=…`，下一轮即可验证这条兜底判得准不准。
- **唤醒 + 让位收窄到 `platformDriven` 分支内**：人工点图标时不再抢前台、不再唤醒（保留配置页）。

### 19.4 本轮落地（`build=2026-09-19e-menu-wake`，APK 50.03 MB）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/game/game.js` | 本地唤醒（`payload.local`）只回菜单，不 `start(0)`；新增 `idle-revived` 留痕事件 |
| 2 | `MainActivity.java` | `platformRelaunchFallback()` / `platformLike()` / `looksLikeManualLaunch()` / `referrerStr()`；onCreate 与 onNewIntent 都接上兜底；`markLaunchSucceeded()` 收尾前再刷一次 `platformLike()`（补「首拉时页面还没出生」的时间差）；`maybeLaunch` 的「页面仍在」分支里唤醒+让位收窄到平台驱动；留痕行加 `flags=`/`ref=` |
| 3 | `MainActivity.reviveClosedPage()` | 新增**复核重发**：2.5s 后页面仍报 `cs=1` → 说明唤醒没被取走（页面被冻结）→ 重发，最多 3 次 |
| 4 | `PageForensics.java` | `BUILD_TAG` → `2026-09-19e-menu-wake` |

### 19.5 产物校验

- `BUILD SUCCESSFUL`，APK **50.03 MB**（17:51 出包，md5 前缀 `5b75e6dce127a148`）；
- dex 命中：`platformRelaunchFallback` / `looksLikeManualLaunch` / `referrerStr` / `wakeAttempts` /
  `平台驱动兜底命中` / `唤醒复核` / `人工启动 → 保留配置页` / `不建界面、不重开浏览器，让位给浏览器`，
  新 tag `2026-09-19e-menu-wake` ×3；旧 tag `2026-09-19c-bring-front` **0 次**；
- 包内 `assets/game/src/game/game.js` 含 `payload && payload.local` 与 `idle-revived`；
- skill 模板已同步（`MainActivity.java` / `PageForensics.java`，md5 一致）。

### 19.6 留痕判读表（§19 新增行）

| 留痕里看到 | 含义 | 动作 |
|---|---|---|
| `平台驱动兜底命中：平台会话在线 + 游戏页仍在 + 无 launcher referrer` | 平台那种「带 LAUNCHER 不带 -d」的 `am start` 被兜底判据捞回来了 | 正常：随后应是 `不建界面/收起配置页 + 让位给浏览器` |
| `referrer=android-app://… → 判为「人工从桌面图标启动」` | 真人点图标 | 配置页保留；这条可用来确认 PICO 到底给不给 referrer |
| `已唤醒待机页：本地 cmd3 已入队（第 N 次）` + `唤醒复核：页面已退出待机（cs=0）` | 唤醒送达并被取走 | ✔ 正常 |
| `唤醒复核：2.5s 后页面仍报待机（cs=1）` | 页面被冻结/没在轮询 → 唤醒没人取 | 已自动重发（≤3 次）；若 3 次都失败 → 查浏览器是否被盖住 |
| 待机 → `state=waiting/playing`（XR=off） | **本地唤醒又在代玩家开局**（§19.2 老毛病复发） | 检查 `game.js` 里 `payload.local` 分流是否还在 |
| 某段时间连 `MainActivity.onCreate 进入` 都没有 | **这一轮平台没启动我们** | 查平台/启动器日志 `==OpenGame==<包名>`，确认点的是不是我们这个游戏 id |

### 19.7 待 PICO 实测（这一版要一次看全四件事）

1. 平台启动（无论带不带 `-d`）后，头显里都是**浏览器在最前**，且 2D 预览停在**菜单**（不再自动播影片）；
2. 平台关闭后是黑底「本局已结束」；再次「开始」**零重载**（无第二条 `page-open`），`cs` 1→0，
   `state` 停在 `menu`；玩家点「进入 VR」才进影片 → 第 1 关（与第一次完全一致）；
3. 留痕里 `平台驱动兜底命中` / `唤醒复核：页面已退出待机（cs=0）` 成对出现；
4. 若还是「没反应」：看那段时间有没有 `MainActivity.onCreate 进入` ——
   没有 = 平台侧没下发启动（不是 APK 能修的）；有 = 看它后面紧跟的那条（零界面/让位/`maybeLaunch 跳过：…`）。

---

## 20. ★ 第五次留痕（2026-09-19 18:20–18:24，单进程四轮）：66 秒「没反应」 + **被弹出 VR 的真身**

### 20.0 先说结论（三句话）

1. **重载问题彻底结束**：整条留痕只有 **1 条 `page-open`**（18:20:58），后三轮全是**零重载唤醒**
   （`idle-revived` + `cs` 1→0）——§17/§18/§19 的修复全部生效；
2. 「平台再启动，游戏没反应」那一段（18:21:38 → 18:22:44，**66 秒**）留痕里**零 APK 事件**：
   无 `==== 进程启动`、无 `MainActivity.onCreate 进入`、无 UDP 指令、pid 全程不变 ⇒
   **这一轮平台根本没有对我们做任何动作**（不是 APK 侧能修的，证据见 §20.2）；
3. 本轮抓到一条**新根因**：玩家正在 VR 里玩第 1 关时，平台又 `am start` 了一次 →
   253 ms 后页面 `visibility:hidden` → **PICO 当场结束 XR 沉浸式会话** → 页面 sessionend →
   旧代码 `toMenu()` 清场 → 玩家被扔回 2D 预览界面、本局作废。
   这就是「游戏里弹提示 + 点一下继续游戏直接退出到预览界面」的机制（提示文案不是我们的，见 §20.4）。

### 20.1 留痕逐轮（关键行，pid=9745 全程未变 = 平台没 kill 过我们）

```
18:20:54.796 onCreate 平台驱动=true intent=192.168.31.228 cats={LAUNCHER} flags=0x10000000
             ref=android-app://com.GoodNet.LauncherClient sLaunched=false 游戏页age=-1ms
18:20:56.701 第 1 次拉起浏览器 URL=http://localhost:8080/
18:20:58.191 [PAGE] page-open                  ← 全条留痕**唯一**一次页面加载
18:20:58.702 启动成功 → 上报 0x01 + 收起配置页；让位（顶前台=true 浏览器=com.pico.browser）
18:20:58.289 [PAGE] 状态 进度=80% …  18:21:08 进度=100%
18:21:19     [PAGE] state=waiting XR=on（玩家点「进入 VR」）→ 18:21:31 state=playing
18:21:37.848 [APK] 收到平台关闭指令 0x10 closeGame → [PAGE] DEAD:platform-gone(explicit=true)
18:21:39     [PAGE] state=menu XR=off 【待机：本局已结束，等平台重新开始】  ← cs=1
# ── 18:21:38 → 18:22:44 = 66 秒：**零 APK 事件**（这一段就是「再启动游戏没反应」）──
#    期间唯一事件：18:22:26.213 [PAGE] visibility:hidden cs=true（页面被压到后台，但仍在轮询）
18:22:44.857 onCreate … sLaunched=true 游戏页age=567ms
18:22:44.878 平台重复拉起：判定游戏页仍在（state=menu 待机=true）→ 零界面 → 入队本地 cmd3
18:22:44.903 让位给浏览器（顶前台=true）→ 收起配置页
18:22:45.005 [PAGE] visibility:visible
18:22:45.275 [PAGE] idle-revived cmd=3 cs=false          ← 唤醒被页面取走
18:22:47.381 唤醒复核：页面已退出待机（cs=0）→ 唤醒成功
18:22:56     [PAGE] state=waiting XR=on → 18:23:07 state=playing
18:23:19.119 [APK] 收到平台关闭指令 0x10 closeGame → 待机
18:23:36.880 onCreate …（同上：零重载唤醒）→ 18:23:47 waiting → 18:23:58 playing（进第 1 关）
18:24:04.661 onCreate … sLaunched=true 游戏页age=407ms
18:24:04.668 平台重复拉起：判定游戏页仍在（state=playing 待机=false）→ 让位给浏览器
18:24:04.914 [PAGE] visibility:hidden cs=false            ← 玩家正在 VR 里玩第 1 关
18:24:05.305 [PAGE] state=menu XR=off                    ← **XR 会话已结束**（sessionend → toMenu）
18:24:05.643 [PAGE] visibility:visible
18:24:09.605 [APK] 收到平台关闭指令 0x10 closeGame（此时 state=menu）
```

### 20.2 为什么可以断言「那 66 秒不是 APK 能修的」

| 判据 | 留痕事实 | 推论 |
|---|---|---|
| pid 是否变过 | 全程 `pid=9745`，只有一条 `==== 进程启动` | 平台没 `kill`（force-stop）过我们 |
| 有没有被拉起 | 该窗口内**无** `MainActivity.onCreate 进入` / `onNewIntent` | 平台没 `am start` |
| 有没有下发指令 | 该窗口内**无**「收到平台…」行 | 游戏通道也没有任何下行 |
| APK 是否健康 | 每 ~30s 一条心跳，`8080=true 游戏页age=<1s VRPlus=connected=true` | 8080 与平台桥全程在线 |
| 页面是否就绪 | 每 5s 一条 `state=menu …【待机…】`（cs=1） | 页面正处于「随时可被唤醒」状态 |

⇒ 该窗口里**我们这一侧完全就绪且被动等待**，是平台侧没有发出启动动作。
要定案需平台/启动器那份日志里的 `==OpenGame==com.GoodNet.DeepmindHacker===<IP>`。
玩家自己的经验（「先把客户端点开，再启动就好了」）指向：**平台的启动动作依赖它自己的客户端在前台**
（Android 的后台启动限制 / 平台自身实现），这是平台侧行为，我们无法从游戏里绕过。

### 20.3 新根因（代码级）：平台重拉 = 把玩家从 VR 里挤出去

```
平台 am start（或任何 2D 应用要显示面板）
  → 浏览器那一帧 visibility:hidden（页面没死，只是被压到后台）
  → PICO 的 XRShell 一次只允许一个应用占前台 ⇒ **结束浏览器的 immersive 会话**
  → Three.js renderer 触发 sessionend
  → main.js 旧代码：game.toMenu() + 复位按钮  ⇒ 玩家被扔回 2D 预览、本局作废
```

为什么「不 setContentView + 立刻 finish」也躲不掉：系统在 `handleResumeActivity` 阶段仍会把这个
Activity 的窗口加进窗口树（窗口背景来自主题，是不透明的）→ PICO 就会为它建一个 2D 面板。

### 20.4 关于「需要退出 PICO 浏览器才能继续操作」那句提示

**不是我们的文案**：`src/**`、`index.html`、APK 的 `res/**` 与全部 `.java` 都做过全量检索，零命中。
⇒ 它是 PICO 系统/浏览器自己的提示。机制上它必然对应同一件事：
**沉浸式会话在进行时，另一个 2D 应用（平台客户端 / 我们的配置页 / 系统界面）要显示面板**。
PICO 的规则是「一次只有一个应用占前台」，于是它要求先退掉浏览器；玩家一确认，
浏览器的沉浸式会话就被结束 ⇒ 页面 sessionend ⇒ 回到 2D 预览。**与 §20.3 是同一条链。**

### 20.5 本轮落地（`build=2026-09-19f-xr-keep`）

| # | 文件 | 改动 | 为什么 |
|---|---|---|---|
| 1 | `res/values/themes.xml` | 新增 `Theme.WebXRCast.Passthrough`（`@android:style/Theme.NoDisplay`：windowNoDisplay + 透明，**不产生任何窗口**） | 免打扰路径不再建 2D 面板 ⇒ 不再由我们自己把 XR 会话挤掉 |
| 2 | `MainActivity.java` | `computePassThrough()`（**在 `super.onCreate()` 之前**算好）+ `setTheme(NoDisplay)`；零界面分支条件改用 `passThrough`（保证「换主题」与「走这条分支」永远一致）；`yieldToBrowser` 的 finish 条件加 `|| passThrough` | 同上；NoDisplay 要求 onResume 前 finish，故两处联动 |
| 3 | `MainActivity.java` | `looksLikeManualLaunch()`：referrer 含 `GoodNet`（= 平台自己的启动器 `com.GoodNet.LauncherClient`）**不再算人工点击** | 留痕实测每一条平台拉起都带这个 referrer；旧判据把平台重拉当人工 → 配置页不关、抢前台 |
| 4 | `MainActivity.java` | `platformRelaunchFallback()` 结果缓存（+ `onNewIntent` 重置）；`notifyPlatformGameLaunched()` 补一条留痕「补发 0x01 注册」 | 同一判据现在会在 `super.onCreate` 之前先算一次；顺便让时间线能回答「平台重拉时我们有没有补注册」 |
| 5 | `src/vr/input.js` | A/B 退出前给 `session` 打标记 `_endedByPlayer` | 供页面区分「玩家主动退出」与「被别人抢前台」 |
| 6 | `src/main.js` | `sessionend` 分流：**玩家主动 / 平台明说关闭** → 照旧 `toMenu()` 清场；**其余且非 menu 态** → **保留本局**、冻结主循环（`_renderPaused`）、显示全屏按钮「▶ 继续游戏（返回 VR）」；点击 = 真实手势 → 重新 `requestSession` → 从原关卡继续。新增留痕事件 `xr-start` / `xr-end{st,byPlayer,idle,vis}` / `resume-vr-click` | 即使被抢前台，玩家也能一键回来继续，而不是本局作废 |

### 20.6 留痕判读表（§20 新增行）

| 留痕里看到 | 含义 | 动作 |
|---|---|---|
| `本次走「免打扰」路径（主题=无窗口 NoDisplay）` | 平台重拉已走免打扰路径、不建面板 | ✔ 正常；其后应紧跟 `平台重复拉起：判定游戏页仍在…` |
| `referrer=android-app://com.GoodNet.LauncherClient → 是**平台启动器**` | 平台自己的启动器在拉我们（不是人点的） | ✔ 正常（旧版会误判成人工） |
| `[PAGE] xr-end … byPlayer=false idle=false vis=hidden` | **非玩家意图**地掉了沉浸式会话（被抢前台） | 页面应保留本局并显示「继续游戏」按钮；配合同一秒的 `visibility:hidden` 看是谁抢的 |
| `[PAGE] xr-end … byPlayer=true` | 玩家自己按 A/B 退出 | 正常回菜单 |
| `[PAGE] visibility:hidden` 紧跟 `state=menu XR=off` | XR 会话被结束（本次实测的形态） | 若同时刻有 `MainActivity.onCreate 进入` → 是我们/平台的重拉；若没有 → 是平台客户端或系统 UI |
| 某段时长内连 `MainActivity.onCreate 进入` 都没有 | 平台没启动我们（§20.2） | 查平台/启动器日志 `==OpenGame==<包名>` |

### 20.7 待 PICO 实测

1. 玩家在 VR 里玩到第 1 关时，若平台又点了「开始/启动」：应**不再**出现「退出到预览界面」而本局作废；
   最坏情况是页面保留本局 + 一个大按钮「▶ 继续游戏（返回 VR）」，点一下即从原关卡继续；
2. 留痕里应能看到 `本次走「免打扰」路径（主题=无窗口 NoDisplay）`，且**同一秒不再有**
   `visibility:hidden`（免打扰路径不产生面板 → 不应再压掉浏览器）；
3. 若 PICO 那句「需要退出 PICO 浏览器才能继续操作」还出现：请把**提示原文 + 按钮文字**抄一行给我
   （或告诉我是平台客户端弹的还是 PICO 弹的）——它决定下一步是找平台改启动方式，还是我们继续绕；
4. 平台侧那 66 秒「没反应」，需要平台/启动器日志才能定案；若操作员能确认「那一刻点的是客户端里的哪个键」，
   价值等同。

---

## §21 第十修：删掉「继续游戏」封盖 + 本局结束的退出策略（2026-09-19）

> 留痕依据：`page-forensics (2).log`（89 行，build=`2026-09-19f-xr-keep`，pid=16985，19:37:09 → 19:40:10）
> 用户原话（三件事）：① 「第二次启动正常了，第一关没有弹出浏览器了」；
> ② 「出现大按钮『▶ 继续游戏（返回 VR）』，点它是在预览界面继续 → **现在不弹了就清理这个功能**」；
> ③ 「客户端退到后台问题，能否在游戏结束后或平台指令退出游戏时**杀掉浏览器唤醒客户端**」。

### 21.0 三句话结论

1. **§20 的免打扰路径彻底生效**：19:38:24 平台重复拉起时，留痕出现
   `本次走「免打扰」路径（主题=无窗口 NoDisplay）`，页面**没有** `visibility:hidden`，
   1 秒后 `idle-revived cmd=3` 零重载唤醒成功 —— 「第一关弹出浏览器」这一条已消失。
2. **「继续游戏」封盖成了纯负担**：19:39:00 玩家点它，落到的是 **2D 预览界面**（本局并没有真的
   在 VR 里续上）。既然源头不再弹，就把它整块删掉；`sessionend` 回到「一律干净清场回菜单」。
3. **新增「本局结束 → 退出策略」**：平台 `0x10 closeGame`（或页面自己报 `game-end`）之后，
   把**平台客户端顶回前台**（可选）**关掉浏览器**。理由：平台的「开始」依赖它自己的客户端在前台，
   而浏览器一直抢着前台，客户端就一直在后台（实测经验：先手动点开客户端再启动才灵）。

### 21.1 本轮留痕逐条（关键 9 行）

| 时刻 | 留痕行 | 判读 |
|---|---|---|
| 19:37:09.926 | `==== 进程启动 build=2026-09-19f-xr-keep pid=16985` | 新包已装（新 pid） |
| 19:37:13.080 | `[PAGE] page-open` | **整条留痕只有这 1 条 page-open** → 重载问题结束 |
| 19:37:51.013 | `收到平台关闭指令 0x10 closeGame` | 平台关游戏（第一轮） |
| 19:37:51.194 | `[PAGE] xr-end … byPlayer=false idle=true` | 待机路径，正常 |
| 19:38:07.480 | `[PAGE] visibility:hidden` | 浏览器被盖到后台（正常：客户端回到前台） |
| 19:38:24.552 | `本次走「免打扰」路径（主题=无窗口 NoDisplay）` | ★ §20 修复生效 |
| 19:38:24.658 | `[PAGE] visibility:visible` → `idle-revived cmd=3` | 零重载唤醒成功（1 秒内） |
| 19:38:52.711 | `[PAGE] xr-end st=playing byPlayer=false idle=false vis=visible` | ★ **新问题**：页面可见、无任何 APK 事件，XR 会话自己掉了 |
| 19:39:00.883 | `[PAGE] resume-vr-click` | 玩家点了「继续游戏」→ 落在 2D 预览界面 |

### 21.2 为什么删掉「继续游戏」封盖

| 维度 | 六修（保留本局 + 大按钮） | 第十修（删掉，一律清场） |
|---|---|---|
| 触发前提 | 「页面被别的应用抢前台 → 掉会话」 | 该前提已由 NoDisplay 免打扰路径消除（本轮实测） |
| 实际效果 | 点击落到 **2D 预览界面**，本局并没有在 VR 里续上 | 干净回菜单，等平台/玩家重新开始 |
| 代价 | 多一次误导性点击 + 一层全屏 DOM 盖在画面上 | 无（掉会话 = 本局结束，语义明确） |

落地：`src/main.js` 删除 `showResumeVR()` / `hideResumeVR()` / `#resume-vr` DOM 与
`sessionstart` 里的撤盖调用；`sessionend` 保留留痕事件 `xr-end{st,byPlayer,idle,vis}`，
之后无条件 `game.toMenu()` + 复位进入按钮。

### 21.3 19:38:52 那次掉会话：**还没有定案**（重要）

判据：`byPlayer=false`（不是玩家按 A/B）、`idle=false`（不是平台关闭）、`vis=visible`
（页面**全程可见**，前后 60s 内**没有** `visibility:hidden`）、前后**没有任何 APK 事件**。
⇒ 既不是我们抢的前台，也不是页面自己调的 `session.end()`（全项目只有两处：玩家 A/B 与
`_onPlatformGone`，两处都留痕）。最可能的两种：**玩家按了手柄上的系统键 / 摘下过头显**。
下一次实测请留意这一点；若在 VR 里没有做任何动作也会掉，再按「PICO 侧会话被抢」继续查。

### 21.4 「本局结束 → 退出策略」设计与顺序

```
平台 0x10 closeGame ──► VRPlusLink.handleCloseGame() ──► VRPlusLink.sOnCloseGame（CastApp 注入）
                                                              │
页面 game-end（打输/通关/退出 VR）─► POST /api/page/event ──► GameServer.sOnGameEnd（CastApp 注入）
                                                              ▼
                            MainActivity.scheduleClientRestore(ctx, why, delay)
                              · 平台关闭：2500ms（留给页面退 VR + 回菜单）
                              · 页面 game-end：8000ms（让结算画面走完）
                              · 只保留**最早**的一次（两个入口常同时到达，取快的）
                              · 执行前复核 sLaunchedAt 未变（期间没开新的一局）→ 变了就取消
                                                              ▼
                            MainActivity.restoreClientAndCloseBrowser()
                              ① bringClientToFront()：getLaunchIntentForPackage(客户端包)
                                 + NEW_TASK | REORDER_TO_FRONT（**不带 URL → 不会重载任何页面**）
                              ② 等 1s（让浏览器 panel 真的退下去）
                              ③ killBackgroundProcesses(浏览器包)  ← 只对**后台**进程有效
```

三条硬约束（改代码时不要违背）：

| # | 约束 | 理由 |
|---|---|---|
| 1 | **先顶客户端，再关浏览器** | `killBackgroundProcesses` 只杀后台进程；顺序反了杀不动，还会在 XRShell 里留一块空面板 |
| 2 | 顶客户端失败 → **不关浏览器** | 否则浏览器也没了、客户端也没上来 = 头显上什么都没了 |
| 3 | `?cast=1` 直播模式 → **一律不动浏览器** | 浏览器就是推流源，关掉 = 直播中断（APK 侧看 `sPcConfigured`，页面侧在 payload 里带 `cast:true`，双重判据） |

「客户端是谁」的确定方式（`rememberClientPkgFromReferrer`）：每次平台拉起我们时，
referrer 都是 `android-app://<客户端包>` —— **自动记住它**，比硬编码稳（不同场地包名可能不同）。
兜底默认 `com.GoodNet.LauncherClient`；配置页会把当前认定的包名显示出来（`tvClientPkg`）。
⚠ 必须在 `AndroidManifest.xml` 的 `<queries>` 里声明该包 + `QUERY_ALL_PACKAGES`，
否则 Android 11+ 包可见性会让 `getLaunchIntentForPackage` 返回 null（顶不动客户端）。

### 21.5 本轮落地（`build=2026-09-19g-client-restore`）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/main.js` | 删「继续游戏」封盖（函数 + DOM + sessionstart 撤盖）；`sessionend` 回到「一律 `toMenu()` 清场」，保留 `xr-end` 留痕 |
| 2 | `src/game/game.js` | 新增 `_reportGameEnd(why)`（去抖 5s、带 `cast` 标记）与 `_endRound(why)`（= `VRPlusGame.terminate()` + 上报）；`toMenu()` 与 4 处 `state='over'` 全部改走 `_endRound` |
| 3 | `VRPlusLink.java` | 新增 `public static volatile Runnable sOnCloseGame`；`handleCloseGame()` 里经主线程 Handler 触发 |
| 4 | `GameServer.java` | 新增 `public static volatile Runnable sOnGameEnd`；`/api/page/event` 里识别 `{"ev":"game-end"}`（`cast:true` 时跳过） |
| 5 | `MainActivity.java` | 新增第十修整块：`scheduleClientRestore` / `restoreClientAndCloseBrowser` / `bringClientToFront` / `killBrowser` / `clientPkgForRestore` / `rememberClientPkgFromReferrer` / `isOn`；`lastBrowserPkg` 改 **static**（免打扰路径会 finish，实例字段跨轮次会丢）；`setPc()` 里置 `sPcConfigured`；onCreate/onNewIntent 记客户端包名；配置页接两个 CheckBox + `tvClientPkg` |
| 6 | `CastApp.java` | 新增 `public static volatile Context APP`；注入两个回调（closeGame 2.5s / game-end 8s） |
| 7 | `res/layout/activity_main.xml` | 新增「本局结束后：」两个 CheckBox（唤醒客户端 / 关闭浏览器，默认都勾）+ 客户端包名显示 |
| 8 | `AndroidManifest.xml` | 新增 `KILL_BACKGROUND_PROCESSES`、`QUERY_ALL_PACKAGES` 权限；`<queries>` 加 `com.GoodNet.LauncherClient` |
| 9 | `PageForensics.java` | `BUILD_TAG` → `2026-09-19g-client-restore` |

配置持久化：`SharedPreferences("cast")` 的 `restoreClient` / `killBrowser`（`"1"`/`"0"`，默认 `"1"`）、
可选 `clientPkg`（留空则用自动识别）。

### 21.6 留痕判读表（§21 新增行）

| 留痕里看到 | 含义 |
|---|---|
| `本局结束（<why>）→ 2500ms/8000ms 后执行退出策略` | 退出策略已排队（why = 平台关闭指令 / 页面上报） |
| `退出策略已在排队（…ms 后执行），本次（…）不重复安排` | 两个入口都到了，取了更早的那次 ✔ 正常 |
| `退出策略取消：期间已有新的一局被拉起` | 排队期间平台又开了新局 → 自动作废 ✔ 正常 |
| `退出策略执行（…）：唤醒客户端=true 关闭浏览器=true 直播模式=false` | 正式动作开始 |
| `平台客户端 <pkg> 拿不到启动器 Intent` | 包名不对/未安装/被包可见性挡住 → 需要在 `<queries>` 或 `clientPkg` 里修 |
| `已唤醒平台客户端（顶到前台）：<pkg>` | ✔ 成功 |
| `已请求关闭浏览器 <pkg>（killBackgroundProcesses）` | ✔ 成功；下一局平台启动会重新打开游戏页（≈10s 预加载） |
| `退出策略跳过：当前带 ?cast=1 直播` | ✔ 直播模式保护生效 |
| `页面上报本局结束，但退出策略回调未注入（CastApp 未启动？）` | APK 进程被换过/注入失败 → 重启 APK |

### 21.7 待 PICO 实测（`build=2026-09-19g-client-restore`）

1. 第一关**不再**出现大按钮「▶ 继续游戏（返回 VR）」（已删除）；掉会话时页面直接回菜单；
2. 平台关闭游戏后（约 2.5s）**平台客户端应自动回到前台**；留痕里找
   `本局结束（平台关闭指令 0x10 closeGame）→ 2500ms 后执行退出策略` + `已唤醒平台客户端`；
3. 随后浏览器被关（`已请求关闭浏览器 com.pico.browser`）→ 下一次平台「开始」应能**直接起来**
   （不再需要先手动点开客户端）；代价是重新加载游戏页 ≈10s；
4. 若嫌 10s 慢：在配置页取消勾选「本局结束后：关闭浏览器」（保留待机页 → 下一局零重载），
   只留「唤醒平台客户端」即可；
5. 若「唤醒客户端」失败：把配置页上 `平台客户端：<包名>` 那一行 + 留痕里
   `拿不到启动器 Intent` 那一行发我 —— 说明包名要改成场地实际的那个。

---

## §22 第十一修：退出策略「假成功」的实测证伪（2026-09-19 晚 · 第三份留痕）

### 22.0 三句话结论

1. **重载问题与「被弹出 VR」都已结束**：整份留痕里平台重复拉起走的一律是「免打扰」路径
   （`2026-09-19f` 段 19:38:24、`2026-09-19g` 段 20:23:46），页面 `visibility:hidden → visible`
   一个来回后 1s 内 `idle-revived cmd=3` —— **零重载**。
2. **第十修的退出策略是「假成功」**：三条日志说「已顶平台客户端到前台 / 已请求关闭浏览器」，
   但**实测两者都没发生**（浏览器页仍 `visible` 且每 5s 照常上报 35 秒）—— 客户端根本没上来。
3. **「关浏览器」反而是新故障源**：关掉后浏览器被系统自己拉起、还原标签、加载到 80% 就被冻结
   （**幽灵页**）→ 玩家看到的正是「第三次启动一直没反应」。⇒ 默认**不再关浏览器**。

### 22.1 留痕逐轮（`page-forensics (3).log`，297 行，跨两个 build）

| 时刻 | 事件 | 读法 |
|---|---|---|
| 19:37:09 | `进程启动 build=2026-09-19f-xr-keep` | 上一版仍在跑 |
| 19:38:24.552 | `本次走「免打扰」路径（主题=无窗口 NoDisplay）` | ✅ 第九修生效 |
| 19:38:24.658 | `visibility:visible`（**没有** hidden） | ✅ 平台重拉没把页面盖掉 |
| 19:38:25.157 | `idle-revived cmd=3` | ✅ 零重载唤醒成功 |
| 20:22:17 | `进程启动 build=2026-09-19g-client-restore` | 换装 g 版（本修的对象） |
| 20:23:07 | `0x10 closeGame` → 20:23:10 `退出策略执行` | 第十修入口 |
| 20:23:10.196 | `已顶平台客户端到前台：com.GoodNet.LauncherClient` | ⚠ **假成功**（见 22.2） |
| 20:23:11.203 | `已请求关闭浏览器 com.pico.browser` | ⚠ **没生效**（页仍活着） |
| 20:23:46.330 | 平台第 2 次拉起 → 免打扰 → 20:24:04 xr-start | 玩家说「等到第二次指令才弹出游戏」 |
| 20:25:23 | 第 3 次 `0x10 closeGame` → 20:25:26 退出策略 → 20:25:27 关浏览器 | |
| 20:25:34.504 | `page-open url=http://localhost:8080/` | ⚠ 浏览器被**系统自己**拉起并还原标签 |
| 20:25:35.831 | `DEAD:pagehide persisted=true` → `freeze`，卡在 `pct=80 pd=false` | ⚠ **幽灵页**诞生 |
| 20:25:47 | 心跳 `游戏页age=12008ms` | 幽灵页不再打点，但"还在" |

### 22.2 三个动作的真实效果（这是本修的核心）

| 动作 | 代码怎么写 | 留痕实测 | 判据 |
|---|---|---|---|
| 顶客户端到前台 | `startActivity(启动器Intent + NEW_TASK\|REORDER_TO_FRONT)` | **没生效** | 执行后 20:23:15 → 20:23:42 页面**仍在打点 6 次**且 `visible`；真顶上来的话 Chromium 会立刻冻结后台标签 → hidden |
| 关闭浏览器 | `killBackgroundProcesses(com.pico.browser)` | **没生效** | 同上；`killBackgroundProcesses` 只对**后台**进程有效，而它当时还在前台 |
| 唤醒待机页 | 本地 cmd3 + 2.5s 复核重发 | ✅ 生效 | 20:23:46.692 `idle-revived` |

**为什么旧日志会「假成功」**：`startActivity()` 不抛异常 ≠ 前台真的换了。Android 10+ 对
**后台应用的 activity 启动**是**静默丢弃**的（不报错、不回调）。我们当时已经 `finish()` 过，
进程里没有可见窗口 → 属于后台态 → 请求被丢掉，而我们随后就写了「已顶到前台」。

**官方豁免项**：持有 `SYSTEM_ALERT_WINDOW`（"显示在其他应用上层"）的应用被明文允许从后台
启动 Activity（Android 文档 *Restrictions on starting activities from the background*）。
⇒ 本修加了该权限 + 配置页「授予悬浮窗权限」按钮（特殊权限，需手动开一次）。

### 22.3 「退出 PICO 浏览器」弹窗定性

照片里的弹窗：标题「退出PICO浏览器」、正文「你需要退出当前应用才能继续操作」、按钮「取消 / 退出并继续」。

- 全量检索 `src/**`、`index.html`：**零命中**（也没有 `window.open` / `_blank` → 页面不弹任何东西）；
- 该时段留痕里**没有任何 APK 事件**（20:22:37 xr-start → 20:22:49 playing 之间我们一行都没写）；
- ⇒ **不是我们的窗口**。它是 PICO 系统/XRS**hell** 的行为：**除浏览器之外还有 2D 应用想占前台**
  （immersive 会话期间）。这一轮唯一的候选是**平台客户端自己**（Unity 应用，它才是「想占前台」的那个）。
- 我们能做的只有「自己永远不产生窗口」——那正是第九修的免打扰路径。剩下的只能找平台方：
  让它的客户端在游戏运行期间不要尝试回前台。

### 22.4 本轮落地（build=2026-09-19h-no-kill）

| # | 改动 | 文件 | 为什么 |
|---|---|---|---|
| 1 | 「关闭浏览器」默认改为**关**（`isOn(...,"killBrowser",false)` + 勾选框/文案同步） | `MainActivity` / `activity_main.xml` | 它没生效，还制造幽灵页 |
| 2 | 「顶客户端」改为**实测复核**：1.4s 后看页面是否停止打点，写 `✅已生效 / ⚠疑似未生效` | `MainActivity` | 消灭「假成功」日志 |
| 3 | 复核未生效 → 带 `RESET_TASK_IF_NEEDED\|BROUGHT_TO_FRONT` **重试一次**，再复核 | `MainActivity` | 有些 Unity 启动器要 reset 才会把主 task 提上来 |
| 4 | 只勾「关浏览器」而不勾「唤醒客户端」→ **直接跳过** | `MainActivity` | 没人接前台就杀 = 头显上什么都不剩 |
| 5 | 唤醒待机页 **3 次无效 → 强制重开浏览器（整页重载）** | `MainActivity`（新增 `forceRelaunchBrowser` / 提取 `launchBrowserNow`） | 治「启动一直没反应」：幽灵页/冻结页唤不醒，只能重载 |
| 6 | 新增 `SYSTEM_ALERT_WINDOW` + 配置页「授予悬浮窗权限」按钮 + 状态行 | `AndroidManifest` / `activity_main.xml` / `MainActivity` | 后台启动 Activity 的官方豁免项 |
| 7 | 三条诊断留痕：解析到的**组件名**、**自身 importance**（≤100 前台 / >100 后台）、悬浮窗权限状态 | `MainActivity` | 下次一轮定位，不再猜 |

### 22.5 留痕判读表（下一轮照着看）

| 留痕行 | 含义 |
|---|---|
| `顶客户端：组件=… 自身importance=125` | 125 = 只有前台服务、没有可见窗口 → **后台态**，startActivity 会被丢 |
| `✅ 顶客户端已生效：浏览器页已停止打点（age=…ms）` | 真顶上了（这时才会去关浏览器） |
| `❌ 顶客户端两次都未生效 … 悬浮窗权限=未授予` | ⇒ 去配置页授予悬浮窗权限再试 |
| `唤醒复核：已重发 3 次仍未取走 → 兜底：强制重开浏览器` | 页面已被冻结/幽灵页，改整页重载 |
| `强制重开浏览器（…）：网页 age=…ms … 待机=false` | 幽灵页特征：`age` 很大但 `待机=false`（cs=0） |

### 22.6 待 PICO 实测

1. 平台关游戏后约 2.5s，留痕应出现 `已发出「顶平台客户端到前台」请求` +
   1.4s 后的 `✅/⚠` 结论。**先把「验证码」看明白**：是 `✅` 还是 `⚠`；
2. 若是 `⚠ … 悬浮窗权限=未授予` → 到配置页点「授予悬浮窗权限」，再跑一局对比；
3. 「关闭浏览器」默认不再勾选（保留待机页 = 下一局零重载）；要省内存再手动勾，并留意是否复现幽灵页；
4. 平台客户端始终不上来（已授予悬浮窗仍 `❌`）→ 这条得平台方改客户端行为，游戏侧无解；
5. 弹窗再次出现时，记下**弹窗前后你在头显里做了什么**（尤其：是否刚点过客户端的「开始」）。
---

## 23. 「进入 VR」按钮门禁：默认隐藏，收到平台「开始游戏」才显示（2026-09-19 第十二修）

### 23.0 三句话

1. **需求（需求方指定）**：预览界面的「🎈 进入 VR」按钮**默认隐藏**，直到**平台发送「开始游戏」**
   才显示出来 —— 不让人在非平台排期时刻从 2D 预览界面点进 VR，开出一局平台不知道的游戏。
2. **判据**：门禁只认「平台开局信号」（机位表 `cmd=0` / APK 本地唤醒 `cmd=3 local` / 旧平台 `cmd=3,4`），
   平台结束本局（`cmd=16` → 待机态）后重新关闭。
3. **兜底（需求方选定）**：门禁关闭后 **30 秒**内仍收不到任何平台开局信号 → **无条件放行**；
   调试期可用网址参数 `?vrbtn=1` 强制显示、`?vrbtn=0` 强制隐藏（两者都不用重打包）。

### 23.1 为什么 APK 侧也必须补一条信号（本轮最关键的设计点）

页面能看到的「平台开局凭证」只有一条：**机位表**（APK 发 `0x01` 注册后平台 57ms 回的
`{"Machines":[...]}`，被 APK 包成 inbox `cmd=0`）。但它是**一次性消息**：

```
时间线（第一轮实测）：
  APK 被平台 am start 拉起 → 发 0x01 → 平台回机位表 → APK 入队 cmd=0   ← 此刻页面可能还不存在
  浏览器加载游戏页（6~9s 预加载）→ 页面首轮 inbox 轮询才把它取走
```

只要中间多一次页面重载（或上一轮已经把这条取走），**新页面就再也看不到它** → 门禁会永远关着
（唯一出路是等 30 秒兜底）。所以「**平台驱动的这一次拉起**」必须由 APK 主动补一条本地指令：

| 入口 | 时机 | 入队内容 | 说明 |
|---|---|---|---|
| `MainActivity.launchBrowserNow()` | 平台驱动、**首次**拉起浏览器（页面还不存在） | `cmd=3, local:true, plat:true` | 新增（第十二修）。与平台网络无关，时序上必然到达 |
| `MainActivity.reviveClosedPage()` | 平台重新拉起、页面**还在**（待机态） | `cmd=3, local:true, plat:true` | 既有能力（五修），本轮补 `plat` 标记 |
| `VRPlusLink.handleConnectPayload()` | 平台回机位表 | `cmd=0` | 既有能力，作为第二重信号 |

`plat:true` 的语义 = **「平台已开始本局」**（区别于「有人手动打开页面」）。
人工点配置页启动时**不发**（`platformDriven == false`），因为那是人在操作、不是平台排期。

### 23.2 落地清单

| 层 | 文件 | 改动 |
|---|---|---|
| 页面 | `src/main.js` | 新增门禁模块：`applyVRGate()` / `setVRGate()` / `vrGate` 状态 + 30s 兜底计时；`game.platformHooks` 注册（`onStart→开`、`onEnd→关`）；`sessionend` 改为「交给门禁」显示；`startLevelAt()` 加守卫；桌面（无 immersive-vr）自动放行；诊断条加 `门禁开/关` |
| 页面 | `src/game/game.js` | 新增 `this.platformHooks` 字段 + `_platformSignal(kind, why)`；`cmd=0` / `cmd=3,4` → `onStart`；`cmd=5,6` / `_enterClosedIdle()` → `onEnd`；本地唤醒日志区分 `plat`；留痕事件 `idle-revived` → `platform-start{cmd,plat}` |
| APK | `VRPlusLink.java` | `enqueueLocal(cmd, why, platformStart)` 重载：多写一个 `plat:true` |
| APK | `MainActivity.java` | `launchBrowserNow()`：`platformDriven` 时入队 `cmd3 plat=true`；`reviveClosedPage()` 改调三参版本 |
| APK | `PageForensics.java` | `BUILD_TAG` → `2026-09-19i-vr-gate` |

### 23.3 门禁状态机

```
页面启动 ──► 门禁=关（按钮隐藏 + 右侧「关卡快捷」面板一起隐藏 + 「⏳ 等待平台开始游戏…」）
              │
              ├─ 收到平台开局信号（cmd0 / cmd3,4）─► 门禁=开（按钮 + 面板出现）
              │        └─ 玩家 A/B 退出 VR ──► 门禁**不变**（同一局还在平台排期里，可以再进）
              │
              ├─ 30 秒无任何信号 ──► 无条件放行（兜底；自测/平台缺席不被堵死）
              │
              └─ 平台结束本局（cmd16 / cmd5,6 → 待机态）──► 门禁=关（重新开始计时）
```

URL 参数：`?vrbtn=1` 强制显示（自测）、`?vrbtn=0` 强制隐藏（做对照）。
**桌面（无 `immersive-vr`）自动放行** —— 那里根本没得进 VR，门禁无意义。

### 23.4 留痕判读（`/api/page/forensics`）

| 留痕行 | 含义 |
|---|---|
| `[PAGE] vr-gate{"open":true,...}` | 门禁打开（按钮出现）；`why` 字段写明是谁开的门 |
| `[APK] 入队本地 cmd=3 plat=true（平台已开始本局）` | APK 确认这次拉起是平台驱动的（页面的门禁靠它） |
| `[PAGE] platform-start{"cmd":3,"plat":true}` | 页面已收到并处理（若缺 → 页面没在轮询 / 被冻结） |
| `[PAGE] vr-gate{"open":true,"why":"门禁兜底：30 秒内没有收到平台开局信号"}` | **说明平台开局信号一条都没到** —— 这是排查「按钮该出现却没出现」的第一号线索 |

### 23.5 待实测

1. 平台启动游戏 → 预览界面**先没有按钮**，1~2 秒内（机位表 / 本地 cmd3 到达）出现按钮；
2. 不点按钮 = 进不去 VR，右侧关卡面板也应一起隐藏；
3. 页面单独打开（平台不在场）→ **30 秒**后按钮自己出现（兜底按需求方选定实现）；
4. `?vrbtn=1` 立即显示（自测用）；
5. 平台关闭游戏 → 按钮重新隐藏（待机封盖之下），下一次平台「开始」再出现。

---

## §24 第十三修：「进入 VR」按钮门禁**收紧判据**（第四份留痕 `page-forensics (4).log`）

### 24.0 三句话结论

1. **第十二修的门禁等于没做**：平台一启动游戏，按钮**当场就在**（留痕 21:28:07 页面打开 → 21:28:08 门禁已开）。
2. 原因是我把两个**拉起时刻**的信号当成了「平台开始了本局」：① 机位表 `cmd=0`（它只是注册回执）；
   ② 我自己在 APK 里注入的本地 `cmd3 plat:true`（伪造开局信号）。**两个都已删除**。
3. 现在只认**平台自己下发**的指令（游戏通道 `cmd=3/4`）；同时给**每一帧**下行加留痕 ——
   下一轮实测就能确定「平台到底会不会发开局指令」这件事（以前单字节命令根本不进留痕，查不到）。

### 24.1 第四份留痕（147 行）逐条判读

| 时间 | 留痕 | 判读 |
|---|---|---|
| 21:28:03.627 | `进程启动 build=2026-09-19i-vr-gate pid=18612` | 装的是第十二修那版 ✅ |
| 21:28:03.871 | `收到平台机位表 Machines=2 台` | **平台自 0x01 注册后 10ms 就回表** ⇒ 机位表 = 注册回执 |
| 21:28:05.603 | `入队本地 cmd=3 plat=true（平台已开始本局）` | ← 第十二修我自己造的「伪开局信号」 |
| 21:28:07.588 | `[PAGE] page-open` | 页面打开（门禁默认关闭 ✅） |
| 21:28:08.725 | `vr-gate{open:true, why:"平台机位表（Machines=2）→ 平台已认到本机"}` | ← **病根 ①**：机位表开门禁 |
| 21:28:08.800 | `vr-gate{open:true, why:"平台驱动的本次拉起（APK 本地通知）"}` | ← **病根 ②**：注入信号开门禁 |
| 21:28:32.6 | `xr-start` （玩家点按钮进 VR） | 玩家是在门禁**已经开着**的情况下点进去的 |
| 21:28:49.644 | `收到平台关闭指令 0x10 closeGame` | 本轮平台唯一另一条下行 |
| 21:29:10 / 21:29:30 | `本次走「免打扰」路径` + `入队本地 cmd=3 plat=true`（待机页唤醒） | 平台重拉，**零重载**（§20/§21 的修复保持有效） |
| 21:30:26 | `page-open`（**无任何 APK 事件**）→ 21:30:29 `pagehide(persisted)/freeze` | 浏览器自己还原标签的**幽灵页**（§22 已知，非本次目标） |

**整条留痕里平台下行只有两种**：机位表（注册回执，出现 8 次）与 `0x10 closeGame`（出现 3 次）。
⇒ **「平台点开始游戏」在设备侧没有任何可观测痕迹** —— 它唯一可观测的形态是 `am start`（= 拉起整个页面）。

### 24.2 为什么不能把「机位表」当开局信号（这是本轮的核心）

`0x01` 是我们自己发的注册（`CastApp`/`MaybeLaunch` 每次拉起都补发，未收到表则每 3s 重试），
**平台每收到一次就回一张机位表**。所以：

- 它出现的时机 = 「我们的 APK 启动并注册」，**不是**「平台开始这一局」；
- 人工点配置页启动、页面被浏览器自己打开（幽灵页）等场景同样会有它；
- 把它当开局信号 ⟹ 门禁在任何一次启动时都立刻打开 ⟹ **等于没有门禁**（实测正是如此）。

### 24.3 本轮改动（`build=2026-09-19j-platform-start`）

| 层 | 文件 | 改动 |
|---|---|---|
| 页面 | `src/game/game.js` | `cmd=0` 由 `onStart` 改为 `onSeen`（只播报「平台在场」）；`platformHooks` 增 `onSeen`；**cmd3/4 不再 `start(0)`** —— 平台「开始」= 开门禁 + 回菜单，开局只认玩家手势（`sessionstart`）；删掉已无人写入的 `_pendingPlatformStart` 挂起队列 |
| 页面 | `src/main.js` | 门禁只由 `onStart`（平台 cmd3/4）打开；`onEnd`（cmd16 / 5,6 / 待机态）关闭；`onSeen` 只标记 `platformSeen`（用于区分兜底原因）；**`?vrbtn=1` 语义改为「完全旁路门禁」**（按钮常显，应急杠杆） |
| APK | `MainActivity.java` | **删掉**第十二修注入的本地 `cmd3 plat:true`；`onCreate` 留痕追加 `extras=`（判断平台有无独立的「开始」标记位）；`getCastUrl()` 支持配置页勾选加 `&vrbtn=1`；新增 `extrasPreview()` |
| APK | `VRPlusLink.java` | **逐帧留痕**：单字节命令 / 非 JSON 帧 / JSON cmd / 无 cmd 的 JSON 全部写进留痕（以前只进 Android 日志） |
| APK | `layout/activity_main.xml` | 新增勾选「直接显示「进入 VR」按钮（不等平台；勾上=旁路门禁）」（默认不勾） |

### 24.4 判读表：下一轮留痕怎么读

| 留痕 | 含义 | 下一步 |
|---|---|---|
| `[PAGE] vr-seen{why:"平台机位表…"}` | 平台在场（正常） | — |
| `[APK] ← 平台下行**单字节命令 cmd=3/4**` + `[PAGE] vr-gate{open:true}` | **平台确实会下发开局指令** | 门禁钉死在它上面，本轮即完工 |
| `[PAGE] vr-gate{open:true, why:"门禁兜底：30 秒内没有收到平台开局信号（平台**在场**…）"}` | 平台**不下发**开局指令 | 二选一：① 配置页勾「直接显示『进入 VR』按钮」；② 找平台方补一条「开始」指令 |
| `[APK] ← 平台下行非 JSON 帧 …` 紧跟操作员按「开始」 | 平台发的是另一种帧 | 把该行发回来，我们按真实格式解析 |
| `extras=…` 里在「开始」时多出标记位 | 平台的「开始」= 第二次 `am start`（带标记） | 按那个 key 开门禁 |

### 24.5 紧急出口（都不需要重打包）

1. **配置页勾选**「直接显示『进入 VR』按钮（不等平台）」→ 网址带 `&vrbtn=1` → 下次拉起即生效；
2. 手改网址 `?vrbtn=1`（旁路门禁，按钮常显）/ `?vrbtn=0`（永远隐藏）；
3. 页面侧兜底：门禁关闭 30 秒后无条件放行（需求方 2026-09-19 选定），留痕会写明是哪一种原因。

### 24.6 待实测（装 `build=2026-09-19j-platform-start`）

1. 平台启动游戏 → 预览界面**应只有一行**「⏳ 等待平台开始游戏…」，**没有**按钮、**没有**右侧关卡面板；
2. 操作员在平台上按「开始游戏」→ 观察按钮是否出现；同时把留痕发回（见 24.4 判读表）；
3. 若 30 秒后按钮自己出现，且 why 是「平台**在场**…」→ 说明平台侧没有开局指令，按 24.4 第 3 行处理；
4. 平台关闭游戏 → 按钮重新隐藏（待机页）。


---

## §25 第十四修：门禁判据定为 `?plat=1`（第五份留痕 `page-forensics (5).log`）

### 25.0 三句话结论

1. 第五份留痕（69 行，`build=2026-09-19j-platform-start`）**证实了 §24 的预判**：整局平台对我们
   **零「开始」下行** —— 逐帧留痕里只有 8 条机位表回执 + 1 条 `0x10 closeGame`，
   **没有** cmd3/4、**没有** JSON 命令、**没有**单字节命令，而且**全程没有 `onNewIntent`、没有第二次 `am start`**。
2. 所以「平台点开始游戏」在设备侧**唯一可观测**的形态就是**拉起本页**（`am start`）。
   玩家看到的「点开始游戏好像没反应，等时间到了才有进入 VR 弹窗」= 门禁在等一个**永远不会来的指令**，
   只能等 30 秒兜底（留痕 21:47:12.124 `vr-gate{open:true, why:"门禁兜底…（平台**在场**却没发 cmd3/4…）"}`）。
3. 本轮把判据换成 **`?plat=1`**：APK 打开页面时在网址上带 `?plat=1`（= 陈述事实「本页由 APK/平台拉起」），
   页面据此**直接开门禁**；并**取消待机态的兜底**（平台关掉本局后，按钮不该半分钟后又自己冒出来）。

### 25.1 第五份留痕逐条判读（平台侧「开始游戏」零痕迹）

| 时间 | 留痕 | 判读 |
|---|---|---|
| 21:46:38.980 | `进程启动 build=2026-09-19j-platform-start` | 装的是第十三修那版 ✅ |
| 21:46:39.047 | `onCreate 平台驱动=true intent=192.168.31.228 … extras=（无）` | 平台 `am start`，**不带 extras 标记**（§24 的猜测被否） |
| 21:46:39.895 → 43.857 | `收到平台机位表 Machines=2 台` ×4 | 全是我们补发 `0x01` 的**回执**（10ms 级），不是开局信号 |
| 21:46:40.994 | `第 1 次拉起浏览器 URL=http://localhost:8080/` | **本局全流程只有这一次拉起** ⇒ 操作员点的「开始游戏」= 这一次拉起 |
| 21:46:42.147 | `vr-gate{open:false, why:"页面启动：等平台发送开始游戏"}` | 门禁如期关闭（第十三修生效 ✅） |
| 21:46:43.150 | `vr-seen{why:"平台机位表（Machines=2）→ 平台在场"}` | 只做标记，不开门禁 ✅ |
| 21:46:47.269 | `maybeLaunch：平台驱动但 Activity 未 resumed → 照常尝试拉起` → `判定游戏页仍在 → 不重开浏览器` | 看门狗/重复拉起的**例行**判定；**不是** `onNewIntent`（留痕里没有该行） |
| 21:47:12.124 | `vr-gate{open:true, why:"门禁兜底：30 秒内没有收到平台开局信号（平台**在场**却没发 cmd3/4 → 该需求只能由平台侧补一条指令）"}` | ← **玩家感受的「等时间到了才弹出」**：兜底放行 |
| 21:47:15.366 | `xr-start` | 玩家在兜底开禁后才点进 VR |
| 21:47:18.754 | `xr-end byPlayer=false idle=false vis=visible` | 进 VR 仅 3.4s 就退（掉会话形态，§21.3 未定案那条） |
| 21:47:24.363 | `收到平台关闭指令 0x10 closeGame` | 平台唯一另一条下行 |
| 21:47:25.151 | `vr-gate{open:false, why:"本局结束，进入待机态（平台关闭指令…）"}` | 待机态门禁关闭 ✅ |

> 逐帧留痕在本轮**首次产生决定性结论**：`← 平台下行**单字节命令 cmd=` / `← 平台下行**JSON 命令 cmd=` /
> `← 平台下行非 JSON 帧` 三种行**一条都没有** ⇒ 可以断言「平台没有下发过任何开局指令」，而不再只是推测。
> （§24 之前单字节命令根本不进留痕，所以「平台发不发开局指令」查不到。）

### 25.2 为什么用 `?plat=1`，而不恢复「APK 注入本地 cmd3 plat:true」

| 方案 | 它表达的意思 | 评价 |
|---|---|---|
| APK 入队本地 `cmd3 plat:true`（第十二修） | 「**平台下发了开局指令**」 | **伪称**平台行为 —— 平台没发过；出错时无法分辨是谁说的 |
| 网址带 `?plat=1`（本轮） | 「**本页是 APK/平台拉起的**」 | **陈述事实**，来源可查（`getCastUrl()`）；页面侧一眼看出判据 |

两者在「时机」上等价（都发生在拉起那一刻），但后者语义诚实、排查时不会误导。
另外：`?plat=1` 只影响**新打开的页面**；待机页被唤醒走的是本地 `cmd3`（`reviveClosedPage`，零重载），
那条路径本来就会开禁（`onStart`），不受影响。

### 25.3 本轮落地（`build=2026-09-19k-plat-launch`）

| 层 | 文件 | 改动 |
|---|---|---|
| APK | `MainActivity.java` | `getCastUrl()` 两条分支都加 `&plat=1` / `?plat=1`（平台本地模式从「无参数」变成 `?plat=1`）；`launchBrowserNow()` 的留痕文案同步（说明改成 `?plat=1`，不再是 cmd3） |
| 页面 | `src/main.js` | 新增 `VR_GATE_PLAT`（`?plat=1`）→ **启动即开门禁**（why=`APK/平台拉起本页（?plat=1）→ 视为平台已开始本局`）；`scheduleGateFallback()` **待机态（`game._closedIdle`）不兜底**（装计时器时与回调里各查一次）；门禁块注释整段改为第十四修口径 |
| APK | `PageForensics.java` | `BUILD_TAG` → `2026-09-19k-plat-launch`（下一份留痕一眼确认版本） |

### 25.4 门禁状态机（第十四修定型）

```
页面出生 ?plat=1（APK 拉起） ────► 门禁开（按钮 + 右侧关卡面板显示）
页面出生 无参数（玩家自己开浏览器） ──► 门禁关 → 30 秒无信号 → 兜底放行（why 写明平台是否在场）
inbox cmd3/4（平台真下发了指令） ──► 门禁开（与 plat 并肩，互不冲突）
inbox cmd16 / 旧 cmd5,6 / 进待机态 ──► 门禁关（且**不再兜底**）
平台重拉（待机页被唤醒 reviveClosedPage → 本地 cmd3） ──► 门禁开（零重载）
页面整页重载（幽灵页兜底 forceRelaunchBrowser） ──► 带 ?plat=1 → 门禁开
?vrbtn=1 / ?vrbtn=0 ──► 强制常显 / 强制隐藏（优先级最高）
```

### 25.5 留痕判读表（§25 新增行）

| 留痕 | 含义 | 下一步 |
|---|---|---|
| `vr-gate{open:true, why:"APK/平台拉起本页（?plat=1）→ 视为平台已开始本局"}` | 新判据生效（预期：紧邻 `page-open`） | 期望值，无需动作 |
| 平台关闭后 **30 秒内**又出现 `vr-gate{open:true, why:"门禁兜底…"}` | 待机态兜底没被挡住 | 检查 `game._closedIdle` 是否在该时刻为 true |
| `← 平台下行**单字节命令 cmd=3/4**` | 平台哪天补了开局指令 | 门禁已兼容，无需改动，只更新文档 |
| 操作员点开始游戏后，留痕里出现**第二次 `onCreate`/`onNewIntent`** | 平台的「开始」确实是第二次 `am start` | 可按 extras/data 进一步细分（本轮未出现） |

### 25.6 本轮未能排除的一个盲区（诚实记账）

平台的**启动器通道**（TCP `62135/62136`，`{"cmd":"start"|"kill"|"copyfile"}`）不归我们，我们看不到它。
若操作员在 APK **已在运行**时再点一次「开始游戏」，平台可能只给启动器发了 `start`，
而启动器对「包已在运行」选择跳过 `am start` ⇒ 我们这边**零痕迹**（本轮留痕正好长这样）。
这不影响本轮的修复：那种时刻门禁早已由 `?plat=1` 打开，玩家点「进入 VR」即可。
但若日后要求「严格等平台二次确认」，就必须让平台方补一条游戏通道下行（`cmd3/4`）。

### 25.7 待实测（装 `build=2026-09-19k-plat-launch`）

1. 平台启动游戏 → 预览界面加载完（约 10s）后**按钮应直接可见**，不再需要等 30 秒；
2. 留痕里应出现 `vr-gate{open:true, why:"APK/平台拉起本页（?plat=1）…"}`，**紧随 `page-open`**；
3. 平台关闭游戏 → 按钮隐藏，且**30 秒内不应再出现** `vr-gate{open:true, …门禁兜底…}`；
4. 平台再次启动 → 按钮重新出现（待机页被本地 `cmd3` 唤醒或整页重载）。


---

## §26 第十五修：LaunchGuard —— 「手动直接无法启动，只能通过客户端启动」

### 26.0 三句话结论

1. **需求（2026-09-20 与需求方逐项确认）**：手动点图标 / 最近任务 **直接无法启动**；
   只有「**平台客户端拉起**」**且**「**直播端 EXE 在线且在白名单**」才放行。两者缺一 →
   黑底一行提示，**1.2 秒后自己退出，一秒画面都不出（连浏览器都不拉）**。
2. **判据分两层，且必须分开**：Activity 层做**同步、本地、零网络**的平台证据判定；
   对 EXE 的网络校验只在**首次拉起**（`sLaunched == false`）时做 —— 因为平台**重拉**走的是
   `Theme.NoDisplay` 零窗口路径，一旦引入异步等待就只能换成普通主题 + 建面板，
   而那正是**会把玩家踢出 VR** 的历史大坑（§21.3 留痕 18:24:04）。
3. **EXE 侧新增一条授权协议**（`POST /api/launch/request`，HMAC-SHA256 + 时间窗 ±30s + 白名单），
   以及 APK 侧的 `/api/guard`（页面第二道保险）。三者共同构成「没有直播端 → 谁都开不了」。

### 26.1 为什么在 Activity 层拦，而不是只改页面

| 方案 | 玩家实际看到 | 评价 |
|---|---|---|
| 只改页面门禁（第十四修那样） | 预览界面**整个可见**，只是「进入 VR」按钮不给 | ❌ 不算「无法启动」 |
| **Activity 层拦（本轮）** | 黑底一行字 → 1.2s 后消失，**什么都没起来** | ✅ 真·无法启动 |

代价：Activity 的后续初始化（建配置页 / 看门狗 / `maybeLaunch`）是一整段顺序代码，
门上做异步回调就要把整段搬进回调里（改动面与回归风险都过大）。
故本轮选择**主线程阻塞**做 EXE 校验：最多 `EXE_PROBE_WAIT_MS(2000) + EXE_PROBE_TIMEOUT_MS(1200)`
≈ 3.2 秒 —— 这段本来就在「等启动」的空窗期，且远低于 ANR 的 5 秒阈值。

### 26.2 门禁决策表（定型）

| 场景 | 平台证据 | EXE | 结果 |
|---|---|---|---|
| 手动点图标 / 最近任务 | 无 | 任意 | ❌ 拒绝：「请通过平台客户端启动游戏」 |
| 平台拉起，首次 | 有 | 在线 + 白名单 | ✅ 放行（黑底「正在校验启动权限…」→ 拉浏览器） |
| 平台拉起，首次 | 有 | 不在线 | ❌ 「未连接直播端，无法启动」 |
| 平台拉起，首次 | 有 | 在线但不在白名单 | ❌ 「本机未获授权」 |
| 平台重拉（游戏已在跑） | 有 | 沿用缓存 | ✅ 零窗口放行（`sGuardPassed = true`） |
| 应急开关已勾 / 维护模式 | 有 | 跳过 | ✅ 放行 |
| 页面被直接打开（手输 localhost:8080） | — | — | ❌ 页面侧 `/api/guard` fail-closed，按钮不给 |

### 26.3 状态机

```
页面出生 ?plat=1（APK 拉起）──► Activity 门禁：① 平台证据（同步）
                                 └─► ② 直播端放行（首次拉起时同步阻塞 ≤3.2s，结论缓存 10s）
                                     ├─ 通过 ─► 建配置页 / 拉浏览器（URL 带 ?plat=1）
                                     └─ 拒绝 ─► 黑底提示 1.2s ─► finish（**不拉浏览器**）
页面出生 无 ?plat=1 ─────────► 同样先过 Activity 门禁（手输网址时 platformDriven 为真可能放行，
                               但页面侧 /api/guard 会二次确认；查不到 → fail-closed）
平台重拉（passThrough）──────► sGuardPassed = true → 零窗口放行（不校验、不建窗口）
手动点图标 ─────────────────► ❌ 拒绝（2 秒内连点 3 次 → 维护模式例外）
```

### 26.4 协议

**① APK → EXE（要放行条）**

```
POST http://<直播端IP:端口>/api/launch/request
Content-Type: application/json

{"dev":"<ANDROID_ID>","ts":"<毫秒>","sig":"<hex>"}
   sig = HMAC-SHA256(secret, dev + "|" + ts)

→ 200 {"allow":true,"voucher":"<hex>","ttl":60,"why":"白名单命中","server":<毫秒>}
   voucher = HMAC-SHA256(secret, dev + "|" + exp)   （留给日后信令鉴权，本轮只签发）
```

**② 页面 → APK（第二道保险）**

```
GET /api/guard    （GameServer 本地路由，**必须排在通用 /api 代理之前**）
→ {"ok":true|false,"age":<结论距今毫秒>,"why":"..."}
```

⚠ 路由顺序是个真坑：`/api/guard` 若被通用 `/api/*` 代理吃掉，就会转发到 PC（PC 无此端点 → 404），
页面据此**永远认为未授权** → 门禁再也打不开。已在 `GameServer.serve()` 里显式前置。

### 26.5 本轮落地（`build=2026-09-20l-launch-guard`）

| 层 | 文件 | 改动 |
|---|---|---|
| APK | `MainActivity.java` | 新增 `guardPass / guardExeCheck / probeExeAuthority / guardHmac / guardDeviceId / guardExeBase / guardSkipExe / guardStore / guardDeny / showGuardNotice` 与 8 个静态状态字段；`onCreate` 里 **sp 与 Discovery 提前到门禁之前**（门禁要拿信标地址）；`setPc()` 在门禁未放行时**只记地址**（否则「发现直播端 → maybeLaunch」会绕过门禁）；`maybeLaunch()` 加 `sGuardPassed` 硬前置；`passThrough` 分支标记已放行 |
| APK | `GameServer.java` | 新增 `/api/guard`（前置路由）+ `guardApi()` |
| APK | `activity_main.xml` | 新增 `etSecret`（共享密钥）、`tvDeviceId`（本机设备号）、`cbSkipExe`（应急开关） |
| APK | `PageForensics.java` | `BUILD_TAG → 2026-09-20l-launch-guard` |
| EXE | `cast-pc/main.js` | 新增授权模块（`loadGuard/saveGuard/guardSig/guardVoucher/handleLaunchRequest`）+ 路由 + IPC `guard:get/guard:set`；配置持久化到 `userData/cast-pc-config.json`（`guardSecret / allowList / autoAllow`） |
| EXE | `cast-pc/preload.js` | 暴露 `guardGet / guardSet / onGuardLog` |
| EXE | `cast-pc/renderer/*` | 新增授权面板：secret 显示/复制/重置、新设备自动登记开关、白名单增删、授权日志实时打印 |
| 页面 | `src/main.js` | `vrGuard` 状态 + `gateQueryGuard()`（fail-closed）+ `applyVRGate()` 叠加「直播端已放行」条件与「⛔ 未连接直播端，无法开始游戏」文案 |

### 26.6 维护出口（三个，都不用重打包）

| 出口 | 怎么做 | 适用 |
|---|---|---|
| **维护模式** | **2 秒内连点图标 3 次** | 门禁把所有入口都堵了，而应急开关就在配置页里 —— 这是打开配置页的唯一入口 |
| **应急开关** | 配置页勾「应急：跳过直播端校验」 | EXE 故障 / 现场排障 |
| **总旁路** | 网址带 `?vrbtn=1`（或配置页勾「直接显示进入 VR 按钮」） | 跳过页面侧与 Activity 侧全部门禁 |

### 26.7 留痕判读表（本轮新增行）

| 留痕 | 含义 | 下一步 |
|---|---|---|
| `guard-result{ok:true, why:"直播端放行（192.168.x.x:8443）：白名单命中"}` | 正常启动 | 期望值 |
| `guard-result{ok:false, why:"非平台客户端启动（手动点图标 / 最近任务），2 秒内第 N 次"}` | 手动启动被拦 | 期望值；连点 3 次进维护模式 |
| `guard-deny{"请通过平台客户端启动游戏"} → 1200ms 后退出，不拉起浏览器` | 已建提示页并排好退出 | 期望值 |
| `LaunchGuard：POST <base>/api/launch/request dev=… sig=xxxx… → HTTP 200 {...}` | 与 EXE 的握手明细（**sig 只打前 8 位**） | 对账 HMAC / 白名单 |
| `LaunchGuard：直播端探测失败 <base> → ConnectException: …` | EXE 没开 / 端口不通 | 检查 EXE 是否在跑、是否同网段 |
| `LaunchGuard：复用 Nms 前的授权结论（…）` | 10 秒缓存命中 | 期望值（平台 20s 重拉时常见） |
| 页面侧 `[门禁] 直播端授权：未放行（…）` + `⛔ 未连接直播端` | 页面第二道保险生效 | 说明本次启动没过 Activity 门禁 |

### 26.8 待实测（装 `2026-09-20l-launch-guard`）

1. **回归第一**：平台重拉（游戏已在跑）→ 玩家**不被弹出 VR**、不出现任何面板（这条挂了就是大事故）；
2. 平台启动 + EXE **关掉** → 黑底「未连接直播端，无法启动」→ 1.2s 退出，**浏览器根本不弹**；
3. 平台启动 + EXE 开着 → 黑底「正在校验启动权限…」（≤3.2s）→ 正常拉起浏览器；
4. 点图标 → 「请通过平台客户端启动游戏」1.2s 退出；**2 秒内连点 3 次** → 进配置页；
5. EXE 界面：secret 显示正常、「新设备自动登记」勾上后第一次请求即进白名单、日志能看到 ALLOW/DENY；
6. 故意把头显 secret 改错 → EXE 回 `HMAC 校验失败` → 头显「本机未获授权」。

### 26.9 交付前自查：两处逻辑补丁 + 三个模板缺陷（都已修，别改回去）

**产物**：`app-debug.apk` **50.03 MB / md5 `422e91a1e8defd7d447fa040f5a89bc5` / sha1 `9b9bec1492801535123169623e9d9cbbc623289a`**，
`BUILD SUCCESSFUL in 16s`。dex 字符串校验：`2026-09-20l-launch-guard`、`guardPass`、`guardExeCheck`、`probeExeAuthority`、
`guardHmac`、`guardDeviceId`、`guardOk`、`guardWhy`、`showGuardNotice`、`/api/launch/request`、`/api/guard`、
`请通过平台客户端启动游戏` 全部命中；旧 tag `2026-09-19k-plat-launch` **0 次**。包内 `assets/game/src/main.js` 含
`vrGuard` / `gateQueryGuard` / `fetch('/api/guard'` / `未连接直播端，无法开始游戏` / `vr-guard`。

**两处逻辑补丁（第一版编译通过后自查出来的，会直接导致「平台启动不了」或「门禁被绕过」）**

| # | 缺口 | 后果 | 修法 |
|---|---|---|---|
| ① | `sGuardPassed` 是 `static`，上一轮成功启动后残留 `true` | 本次手动点图标虽被 `guardPass()` 拒绝，但 `onResume → maybeLaunch()` 看到残留 `true` → **照样把浏览器拉起来**，门禁形同虚设 | `guardPass()` **第一行**置 `sGuardPassed = false;`（每次 `onCreate` 从零判定） |
| ② | 平台证据只认 `platformDriven` | **误拒平台**：留痕实测（09-19 17:38）平台曾用 `am start -c android.category.LAUNCHER`（**不带 `-d`**）拉起我们，与人工点击**完全同形** → 门禁把合法启动也拒了 | 加入第二条证据「**没有人工 referrer** 也算平台」：`boolean manual = looksLikeManualLaunch(); if (!platformDriven && manual) { 拒绝 }` |

**三个模板缺陷（`templates/` 侧，项目侧是好的，本地构建全绿所以完全看不出来）**

| # | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| ① | `templates/pc/main.js` 定义了 `handleLaunchRequest` 却**没挂 `/api/launch/request` 路由** | 拿模板从零复现时，头显的授权请求 **404**（不是被拒绝，是根本没到）→「永远拿不到授权」，症状与「HMAC 校验失败」一模一样 | 补路由，并在文件顶部端点清单补一行注释（`grep` 计数应为 2：定义 + 路由） |
| ② | `templates/apk/.../MainActivity.java` 里 `guardOk/guardWhy/guardAgeMs` 被**插入了两份** | 同一个类里重复方法定义 → **直接编译不过** | 删重复块（2437 → 2428 行）；插入脚本改成可重入（插前断言目标块不存在） |
| ③ | `templates/pc/renderer/index.html` 重复了一行 `#cfgbox .gb` CSS | 无害，但说明插入脚本重复执行过 | 删重复行 |

另：模板 `MainActivity.java` 被脚本改写后变成 LF，而**本项目 Java 源与 layout XML 一律 CRLF、JS/MD 一律 LF** → 已统一转回 CRLF，
两侧 `md5` 一致。最终逐文件比 `md5`：`MainActivity.java` / `GameServer.java` / `PageForensics.java` / `activity_main.xml` /
`preload.js` / `renderer.js` **字节相同**；仅 `pc/main.js`（15 行）与 `renderer/index.html`（2 行）为**有意的通用化改写**
（去掉本机专有盘符 `E:/AI_Work/WebXR_Begain`、加 `WEBXR_GAME_ROOT` 探测），`node --check` 全过。

⚠ 这三条已作为硬约束 **57 / 58 / 59** 写进 skill `webxr-cast-dual-package`，自查清单见
`references/vrplus-platform-link.md` §19.7。

**已知副作用（待需求方确认）**：EXE 成为硬条件后，平台启动时 `currentPc` 必然非空 → `getCastUrl()` 会走
`&pc=…&mode=webrtc`，即**每次平台启动都自动开直播**。若需要「平台启动不推流」，需另加一个开关。


---

## §27 第十六修：门禁「等 EXE」从 3.2 秒改成 20 秒异步等待（现场实测：APK 总比 EXE 先起）

### 27.0 三句话结论

1. **现场反馈**：点图标拦截生效了；但「平台启动」的 6 项里 5 项测不了 —— **APK 一闪就退，EXE 还没加载进去**，且闪退前报的是「404，本机未获授权」。
2. **两个独立根因**：① **时序** —— 门禁给 EXE 的时间预算只有 `2000 + 1200 + 1200 ≈ 3.2s`，而平台是**同时**拉起 EXE 与 APK 的，Electron 冷启动要数秒到十几秒 ⇒ APK 必然先超时退出，且平台不会自动重试；② **404 被误报** —— `probeExeAuthority` 把 HTTP 404 的响应体也当成正常回复返回，于是落到 `!reply.contains("allow":true")` 分支 → 报出误导性的「本机未获授权」，**真因被彻底掩盖**。
3. **404 的真身**：跑的是 **09-11 打的 Setup.exe**，而 `/api/launch/request` 是 09-20（第十五修）才加进 `main.js` 的 ⇒ 旧包 POST 到该路径会落到静态托管 → **404**。**修法必须两端都动：APK 改异步长等待 + EXE 重打包。**

### 27.1 为什么不能靠「加大同步阻塞」解决

| 方案 | 结果 |
|---|---|
| 主线程阻塞 20s | **ANR**（>5s 弹「应用无响应」；而 ANR 弹窗在 PICO 上就是一个 2D 面板，会顶掉浏览器里的 XR 会话） |
| 主线程阻塞 4.5s（贴着阈值） | 仍等不到 Electron 冷启动，只是把失败从 3.2s 推到 4.5s |
| **异步等待 + 后台轮询（本轮采用）** | 主线程零阻塞，等多久都不会 ANR；等待页每秒刷新「已等 N 秒」 |

### 27.2 设计边界：同步层 / 异步层的分界就是 `passThrough`

- **① 平台证据判定保持同步、本地、零网络**（intent 形态 / referrer）—— 因为**平台重拉**走 `passThrough` 零窗口路径（硬约束 52），那条路一行异步代码都不能加。
- **② EXE 授权改为异步**，且**只出现在「首次拉起」**：那种场景玩家还在 2D，建一个进度页是安全且必要的。
- 实现上把 `onCreate` 里「门禁之后」的 134 行（建配置页 / 绑控件 / 看门狗 / 超时兜底）**机械抽成 `initGameUi()`**，让「放行」既可能来自 `onCreate` 内的同步返回，也可能来自后台线程回调。
  ⚠ 抽取前已核对：这段只用到 `sp` / `etPc` / `tvStatus` / `manualPanel` 四个**字段**，不依赖任何局部变量。
  ⚠ `initGameUi()` 带 `gameUiInited` 幂等守卫（缓存命中同步放行 + 回调重复触发都只初始化一次）。

### 27.3 探测结果必须分类（本轮最关键的一处）

旧实现只有「allow:true → 放行 / 其他 → 拒绝」两态，把**过渡态**也当成**判决**。现在分四态：

| 探测结果 | 判定 | 处置 |
|---|---|---|
| `HTTP 200` 且响应体含 `allow` | **确实是我们的接收端** | `allow:true` → 放行；`allow:false` 是**真拒绝**（HMAC 不符 / 不在白名单）→ **立刻**拒绝并显示原因（不让玩家白等 20 秒） |
| `HTTP 404` / 200 但非 JSON | 该地址上跑的是**别的 HTTP 服务** | **继续重试**（信标一到会自动换到权威地址） |
| 连不上 / 超时 | EXE 还没启动 | **继续重试** |
| 20 秒窗口耗尽 | 硬闸门 | 拒绝：`未连接直播端，无法启动` |

`GuardProbe{code, body}` + `isOurExe()` 就是这条分类判据；`probeExeAuthority` 改为**永不返回 null**。

### 27.4 地址定性：一次 `GET /api/info` 就能分清「旧版 EXE」和「不是直播端」

这是被现场教出来的一条：只看「404」两种情况的处置完全相反（**换 EXE** vs **换地址**）。

| `/api/info` 响应 | 定性话术 |
|---|---|
| 含 `"guard":true` | 接收端是新版（已支持授权），但仍未放行 → 查 secret / 白名单 |
| 含 `"port"` 但不含 `guard` | **接收端是旧版本**（缺 `/api/launch/request`）→ **必须更新电脑上的 EXE** |
| 都没有 | 这个地址上不是直播接收端 → 查 PC 地址 / 端口 |

每个地址**只查一次**（`guardIdentity` 缓存），避免每 700ms 一次 GET 刷屏。EXE 侧 `/api/info` 同步新增 `guard: true, ver: '1.1.0'`。

### 27.5 PC 侧顺手修掉一个「首次运行必然被拒」的陷阱

`loadGuard()` 旧逻辑：`secret = 随机 32 hex` + `allowList = []` + `autoAllow = false`。
三者叠加 ⇒ 头显**必然**被拒，而且拒因还藏在两层之后（先过了 secret 才轮到白名单）—— 现场表现就是「怎么点都启动不了」，极难反推。

修法：**首次运行**（无 `guardSecret`）把 `autoAllow` 默认置 `true`，并在控制台打印两步引导：
```
[cast-pc] ★ 首次运行：本次自动生成随机 secret（可在本窗口「授权」面板复制/重置）
[cast-pc] ★ 把上面这串 secret 抄进头显：2 秒内连点图标 3 次 → 配置页 → 「共享密钥」
```
之后由配置文件决定（用户关掉过就保持关）。这也与需求方选定的「自动放行白名单」一致。

### 27.6 本轮落地

| 层 | 文件 | 改动 |
|---|---|---|
| APK | `MainActivity.java` | `onCreate` 抽 `initGameUi()`；`guardExeCheck` → `guardExeCheckAsync` + `guardWaitLoop`（后台线程，上限 `GUARD_WAIT_TOTAL_MS=20000`，每 `GUARD_RETRY_INTERVAL_MS=700` 重试一次）；新增 `GuardProbe` / `probeExeIdentity` / `setGuardNoticeText` / `sGuardWaitSeq` / `guardIdentity`；`onDestroy` 里 `sGuardWaitSeq++` 作废旧轮 |
| APK | `PageForensics.java` | `BUILD_TAG → 2026-09-20n-guard-wait-diag` |
| EXE | `cast-pc/main.js` | `/api/info` 增加 `guard:true, ver:'1.1.0'`；`loadGuard()` 首次运行 `autoAllow=true` + 引导日志 |
| 文档/skill | — | `SKILL.md` 硬约束 **60~62**；`references/vrplus-platform-link.md` §19.8；`templates/{apk,pc}` 同步（逐文件比 md5） |

### 27.7 参数表

| 常量 | 值 | 含义 |
|---|---|---|
| `GUARD_WAIT_TOTAL_MS` | `20000` | 「等 EXE 上线」总预算（ms）；耗尽才按硬闸门拒绝 |
| `GUARD_RETRY_INTERVAL_MS` | `700` | 等待期间的重试间隔（ms） |
| `EXE_PROBE_TIMEOUT_MS` | `1200` | **单轮**连接/读取超时（ms）；现在只约束一轮，不再决定总时长 |
| `GUARD_CACHE_MS` | `10000` | 授权结论缓存；平台 20s 重拉时直接命中，不再打扰 EXE |
| `EXE_PROBE_WAIT_MS` | `2000` | 第十六修后**已不被引用**（标注 `@SuppressWarnings("unused")` 留作回退参照） |

### 27.8 留痕判读表（本轮新增行）

| 留痕 | 含义 |
|---|---|
| `LaunchGuard：进入异步等待（上限 20s，每 700ms 重试一次）` | 等待页已建，后台线程启动 |
| `LaunchGuard：等待 Nms 后放行 → 建游戏界面（…）` | **期望值**；N 就是实际等待时长，可用来核算「EXE 到底多久起来」 |
| `LaunchGuard：POST … → HTTP 404 …` | 地址上的服务没有授权端点 → 看下一行的定性 |
| `LaunchGuard：地址 <base> 定性 = 接收端是**旧版本**（缺 …）` | **换 EXE** |
| `LaunchGuard：地址 <base> 定性 = 这个地址上不是直播接收端` | **换地址 / 换端口** |
| `LaunchGuard：直播端拒绝：HMAC 校验失败（secret 不一致？）` | secret 没对齐（只在头显配置页填过才算） |
| `guard-result{ok:false, why:"等待 20s 超时：按硬闸门拒绝（…）"}` | 全套失败 |

### 27.9 待 PICO 实测（装 `2026-09-20n-guard-wait-diag` + 新 EXE）

0. **先做一次配对**：开新 EXE → 抄下 secret → 头显 **2 秒连点图标 3 次** → 配置页填 secret（EXE 侧首次运行已默认自动登记）。
1. **回归第一**：平台重拉（游戏已在跑）→ 玩家**不被弹出 VR**、不出现任何面板；
2. 平台启动 + EXE **后开** → 等待页「正在等待直播端启动… 已等 N 秒」→ **EXE 起来后自动放行并拉起浏览器**（**不再闪退**，这是本轮要验证的核心）；
3. 平台启动 + EXE 全程不开 → 约 20s 后「未连接直播端，无法启动」1.2s 退出；
4. 平台启动 + EXE 已开 → 通常 1 秒内通过（有 10s 结论缓存时几乎立刻）；
5. 故意把头显 secret 改错 → **立刻**「本机未获授权：HMAC 校验失败」（**不应**等满 20 秒）；
6. 点图标仍 1.2s 拒绝；连点 3 次进配置页（回归）。


## §28 第十七修：固定共享密钥 + 配置下发（2026-09-20）

> 承接 §27。§27 把「等 EXE 上线」改成了异步长等待；本轮解决它暴露出来的**最后一个死锁**，并把「授权」从一次判断升级成**必要条件**。

### 28.1 一句话结论

现场「7，首次未通过验证」**不是授权逻辑写错了**，而是**两端密钥从来没同步过**：EXE 生成随机 32 hex，APK 用的是自己的默认串；而 HMAC 校验排在「自动登记」之前 ⇒ 必然 DENY，且第十六修那个「首运行自动放行」补丁根本走不到。

### 28.2 留痕判读（`page-forensics (7).log`）

| 项 | 结论 | 证据 |
|---|---|---|
| 1 手动点图标 | 通过 | 两次 `guard-deny{请通过平台客户端启动}` |
| 3 EXE 不开 | 通过 | `15:07:41` 进等待 → `15:08:02`「等待 20s 超时」，**20.3s 无 ANR / 无面板** |
| 2 平台启动 + EXE 后开 | 机制通过 | `15:08:54.053` 进等待 → **3.9s 后**发出请求（等 Discovery 地址），未等满 20s |
| 四态分类 | 生效 | 请求 `…974` → 判决 `…975`，**1 毫秒内定性拒绝**（不让玩家白等剩下 16 秒） |
| 7 首次未通过 | **死锁** | `HTTP 200 {"allow":false,"why":"HMAC 校验失败（secret 不一致？）"}` |
| 5 维护模式 | **不可达** | 三次「人工点图标」全记成「2 秒内第 1 次」，永远凑不齐 3 次 |

→ 结论：**第十六修的核心机制全部按设计工作**，卡住的只是最后一环。

### 28.3 死锁的两条叠加原因

1. **密钥从未同步**：EXE 随机 `e0239790d2ac5611af23633b2d57cc18`（实测配置文件内容）vs APK 默认 `webxr-cast`。
2. **`autoAllow` 被 HMAC 挡在后面**：判定顺序 `参数 → 时间窗 → HMAC → 白名单 → 自动登记`。

### 28.4 三处定案（需求方逐项拍板）

| 问题 | 选择 | 落地 |
|---|---|---|
| 密钥同步 | **固定共享密钥** | `GUARD_SECRET_DEFAULT` / `GUARD_SECRET_FIXED` = `webxr-cast`；配置页密钥框改只读并清历史值；界面「重置密钥」→「重新配对」 |
| 维护出口 | **删掉** | APK 侧移除连点计数与维护分支；出口改由 PC 侧「重新配对」承担 |
| 下发范围 | **只下发轻量配置** | `CONFIG_MANIFEST = ['src/content/', 'src/core/userConfig.js']`，实测 **6 文件 / 28.9 KB**（响应体 24.2 KB） |
| 清理时机 | **局号失效，不真删** | `SESSION_ID` 每次 EXE 启动都换；不一致 ⇒ 清空覆盖层重下；**不在 `onDestroy` 删**（平台重拉会重建 Activity） |

### 28.5 新增链路（三条）

1. **EXE `GET /api/config/dump`** —— HMAC 与 `launch/request` 共用 `guardVerify()`，返回 `{allow, session, count, bytes, files[]}`，每个文件带 `sha256` 与 `content`。
2. **APK `fetchExeConfig()`** —— 后台线程拉取 → 校验 sha256 → 落 `filesDir/game-overlay/` → 写 `session.json` → `mountOverlayToServer()` → **最后才** `initGameUi()`；任一步失败即拒绝启动（提示 4 秒）。
3. **GameServer 覆盖层** —— 受管路径**只认覆盖层，缺失 404，不回落 assets / PC 代理**；且该判断排在 PC 代理**之前**。非受管路径（GLB / 全景图）不受影响。

### 28.6 参数表

| 参数 | 值 | 含义 / 范围 |
|---|---|---|
| `GUARD_SECRET_DEFAULT` / `GUARD_SECRET_FIXED` | `'webxr-cast'` | 两端固定共享密钥，**必须逐字一致**（硬约束 63） |
| `SESSION_ID` | 随机 4 字节 hex / 进程 | 局号：变了即让头显重下配置 |
| `CONFIG_MANIFEST` | `['src/content/', 'src/core/userConfig.js']` | 下发清单（目录以 `/` 结尾递归） |
| `CONFIG_MAX_FILE` | `512 * 1024` | 单文件上限，超过跳过（重资源不走下发） |
| `CONFIG_FETCH_TIMEOUT_MS` | `6000` | 头显侧拉取超时（ms） |
| `CONFIG_MAX_BYTES` | `4 * 1024 * 1024` | 头显侧整包上限（byte） |

### 28.7 留痕判读（新增）

| 留痕 | 含义 |
|---|---|
| `LaunchGuard：等待中 Ns / 20s —— <卡点>` | 等待期滚动（旧实现这 20 秒完全空白） |
| `LaunchGuard：配置下发完成 局号=… 文件=6 共 29617B` | 正常路径 |
| `LaunchGuard：配置下发失败 → 拒绝启动（…）` | 提示页显示原因 |
| `404 config-missing <路径>` | 覆盖层缺受管文件 = **硬门禁生效**（不是 bug） |
| EXE 控制台 `配置下发 ALLOW dev=… 局号=… 文件=6 共 29617B` | 下发成功 |
| EXE 控制台 `启动授权 ALLOW … why=配对窗口：自动登记首台设备` | 首次配对成功 |

### 28.8 产物

| 产物 | 大小 | md5 |
|---|---|---|
| `app-debug.apk`（`build=2026-09-20o-guard-pair-config`） | 50.03 MB | `351abe16cca61f99645d17ae65cd116e` |
| `WebXR直播接收端 Setup 1.0.0.exe` | 78.20 MB | `daf5ef92801fc4d9d2d4e151a57785fd` |

- dex 全 HIT：`fetchExeConfig` / `mountOverlayToServer` / `sha256Hex` / `deleteRecursively` / `setOverlay` / `config-missing` / `config-unreadable` / `/api/config/dump` / `game-overlay` / `overlaySession` / `overlayPaths` / `GUARD_SECRET_FIXED` / `webxr-cast` / `配置下发完成` / `等待中 `；`sMaintenanceOnce` / `sManualHits` / `sManualHitAt` / `维护模式` 全部 **0 次**（已彻底移除）。
- `app.asar` 全 HIT：`GUARD_SECRET_DEFAULT` / `SESSION_ID` / `CONFIG_MANIFEST` / `buildConfigDump` / `handleConfigDump` / `guardVerify` / `resetPairing` / `1.2.0`；`resetSecret` **0 次**。
- 离线验证：清单展开 = 6 文件 / 29617 B；JSON 往返 + UTF-8 编解码后 sha256 **全部自洽**。

### 28.9 待实测（7 项）

1. 平台启动 → **不再出现「本机未获授权」**，至多 3~5 秒自动放行。
2. 留痕出现 `配置下发完成 … 文件=6`，页面正常加载（不再 404 / 白屏）。
3. EXE 重开（换局号）→ 头显再启动 → 留痕出现「**换局 → 旧覆盖层已清空**」并重下成功。
4. 手动点图标（任意次数连点）→ 1.2s 退出、不拉浏览器（回归）。
5. PC 端点「重新配对」→ 白名单清空、配对窗口开启 → 头显再启动即自动登记。
6. 平台重拉（游戏已在跑）→ 玩家**不被弹出 VR**、不出现任何面板（硬约束 52）。
7. 清空 EXE 的「游戏目录」→ 头显提示「配置下发失败：…」，而不是静默进游戏。