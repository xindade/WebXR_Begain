# 05 · 游戏打包方式（PC EXE + 头显 APK）

> 源码：`tools/cast-pc/`（Electron）、`tools/cast-apk/`（Android/Gradle）
> 相关文档：`docs/cast-implementation-and-packaging.md`（完整链路复现）、`docs/cast-architecture.md`（根因史）
> 复现难度：★★★（脚本本身很短，难点全在「环境版本」与「改哪层要重打包」）

---

## 1. 双端形态总览

```
┌───────────────────────────┐            ┌──────────────────────────────┐
│  PC 端：WebXR直播接收端.exe │            │  头显端：cast.apk             │
│  Electron 33 + electron-   │            │  Android + NanoHTTPD 本地服务 │
│  builder（NSIS 安装包）     │            │  assets/game = 游戏全量静态资源│
│                            │            │                              │
│  · HTTPS:8443 静态托管      │◄───────────│  · http://localhost:8080     │
│  · /api SSE 信令            │   局域网    │  · 内嵌 WebView 探测页        │
│  · 接收 WebRTC 视频并上屏    │            │  · 代理静态资源 → PC 取最新代码 │
└───────────────────────────┘            └──────────────────────────────┘
                                                        │
                                             实际游戏跑在 PICO 浏览器
                                        http://localhost:8080/?cast=1&pc=<PC>:8443&mode=webrtc
```

**两条硬约束决定了这个形态**（PICO 侧）：

1. PICO 浏览器**不信任自签证书、也没有「继续访问」入口** → 不能直接 `https://<PC>` 打开页面；
2. **非 localhost 不是安全上下文** → 没有 `navigator.xr`，WebXR 起不来。

所以必须：APK 起一个 **localhost 的本地 HTTP 服务**承载游戏，PC 只负责信令与收画面。

> ⚠ APK 内嵌 WebView **没有 GPU/WebGL**，只能在里面跑最小探测页；
> 真游戏必须交给 PICO 浏览器（在 WebView 里跑全游戏会在 `new World()` 抛 WebGL context 错误）。

---

## 2. PC 端 EXE（`tools/cast-pc`）

### 2.1 依赖与构建配置

```json
{
  "name": "webxr-cast-pc",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "dist": "electron-builder --win --x64"
  },
  "dependencies": {},
  "devDependencies": { "electron": "^33.0.0", "electron-builder": "^25.1.8" },
  "build": {
    "appId": "com.local.webxrcast",
    "productName": "WebXR直播接收端",
    "win": { "target": ["nsis"], "signAndEditExecutable": false },
    "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true },
    "asar": true
  }
}
```

| 字段 | 说明 |
|---|---|
| `"main": "main.js"` | 主进程入口，同时承载 **纯 HTTP** 服务、信令、窗口 |
| `"dependencies": {}` | 2026-09-23 起无运行时依赖（原 `selfsigned` 只服务于**从未被调用的**自签 HTTPS 分支，已随 `ensureCerts()` / `certs/` 一并删除） |
| `target: ["nsis"]` | 产出 Windows 安装包（非 one-click，可选安装目录） |
| `signAndEditExecutable: false` | 本地自用，跳过代码签名与 exe 资源改写 |
| **`asar: true`** | 代码打进 `app.asar` → **决定了重打包边界**（见 §4） |

### 2.2 启动流程（`main.js`）

```js
// 打包后（asar 内）__dirname 指向 resources/app.asar，'../..' 会算到错误的目录 → 需特殊处理
let EXT_CFG = false;                    // 外部「配置覆盖目录」（可选）：有 src/content 或 src/core/userConfig.js 即为 true
...
mainWindow.loadURL(`http://localhost:${usedPort}/__cast/index.html${hasFlag('pure') ? '?pure=1' : ''}`);
```

- 渲染层页面从 **`/__cast/index.html`** 加载（Electron 窗口内的播放界面）。
- 静态托管根：`currentServeRoot()` —— 打包版**只**返回 EXE 内置目录 `resources/game-cfg`（配置 + `assets/intro/intro.mp4`），
  开发版（`npm start`）才是项目根。**外部游戏目录不再是静态服务根**（第二十二修 · 档1 撤掉「直连整站」）。
  这也是**开场影片能同源播放**的前提（PC 端播本地 `/assets/intro/intro.mp4` 必须与页面同源）。
- 头显侧的**配置**走 `/api/config/dump` 下发（外部覆盖目录 > EXE 内置），所以**首次使用不再需要**在 EXE 里配置任何路径。
  `main.js:374` 那个 `SERVE_GAME ? GAME_ROOT : ROOT` 的写法已不存在，别再按它排查。

### 2.3 构建命令

```bash
cd tools/cast-pc
npm install          # 首次
npm run dist         # 产出 dist/ 下的 NSIS 安装包（WebXR直播接收端 Setup x.x.x.exe）
```

---

## 3. 头显端 APK（`tools/cast-apk`）

### 3.1 工程与版本（版本敏感，全部按实测锁定）

| 组件 | 版本 | 位置 |
|---|---|---|
| Gradle | **8.14.3** | `gradle/wrapper/gradle-wrapper.properties` |
| Android Gradle Plugin | **8.4.2** | `settings.gradle` |
| JDK | **17** | 由 `build-apk.ps1` 自动探测 |
| compileSdk / buildTools | 34 / 35.0.0 | `app/build.gradle` |
| minSdk | 24 | 同上 |
| 明文 HTTP | `usesCleartextTraffic` | `AndroidManifest.xml`（本地 HTTP 必需） |
| 屏幕 | landscape | 同上 |
| 权限 | INTERNET / ACCESS_NETWORK_STATE / CHANGE_WIFI_MULTICAST_STATE | 同上 |
| 依赖 | NanoHTTPD 2.3.1、browser 1.8.0 | `app/build.gradle` |
| 依赖源 | 阿里云镜像 | `build.gradle` / `settings.gradle` |

### 3.2 关键开关（`MainActivity.java`）

```java
USE_INNER_WEBVIEW = false;                  // 不用 WebView 跑游戏（无 GPU/WebGL）
GAME_URL = "http://localhost:8080/?cast=1"; // 本地服务地址；getCastUrl() 自动追加 &pc= / &mode=webrtc
```

### 3.3 资源同步：`sync-assets.ps1`

把项目根的资源拷进 APK 的 `assets/game`（**是拷贝，不是链接**——这是重打包边界的关键）：

```powershell
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")      # 项目根
$dst  = Join-Path $PSScriptRoot "app\src\main\assets\game"

# 清空旧副本，保证与游戏当前状态完全一致
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
New-Item -ItemType Directory -Path $dst -Force | Out-Null

# 排除开发/工具目录与文档
$excludeDirs = @('.workbuddy', '.git', 'node_modules', 'tools')
robocopy $src $dst /E /XD $excludeDirs /XF *.md package.json package-lock.json README* LICENSE* 2>$null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE" }   # 0/1/2/3 都算成功

# 删除已知的无用大文件（省 APK 体积；不影响运行）
$bigFiles = @('早晨天空.png')
```

> `robocopy` 退出码 **0/1/2/3 都是成功/已复制**，只有 ≥8 才是真失败——判错会把正常构建当失败。

### 3.4 构建：`build-apk.ps1`

```powershell
# 用法：powershell -ExecutionPolicy Bypass -File build-apk.ps1
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

脚本做四件事：

1. **探测 JDK 17**：若 `JAVA_HOME` 缺失/无效，自动取 `C:/Program Files/Java/jdk-17*`；并把 `local.properties` 的 `sdk.dir` 暴露为 `ANDROID_HOME`。
   - 注意：**必须用 `Join-Path $env:JAVA_HOME 'bin/javac.exe'` 的绝对路径调用**，直接 `& javac` 在部分会话里解析不到刚追加进 PATH 的可执行文件。
2. **选 Gradle**：优先级 = `~/.gradle/wrapper/dists` 里已缓存的 `gradle.bat`（取版本最高）→ 项目 `gradlew.bat` → PATH 上的 `gradle`。
   - 用缓存里的 `gradle.bat` 是为了**避免 gradlew 再去下载发行版**（离线/内网会失败）。
3. **构建**：`assembleDebug --stacktrace`；`.bat` 必须经 `cmd /c` 调用（PowerShell 管道里直接跑 `.bat` 会报 "Cannot run a document in the middle of a pipeline"）。
4. **校验产物**：检查 `app/build/outputs/apk/debug/app-debug.apk` 是否存在并打印体积。

### 3.5 完整打包顺序

```powershell
cd tools/cast-apk
powershell -ExecutionPolicy Bypass -File sync-assets.ps1   # 同步游戏静态资源进 assets/game
powershell -ExecutionPolicy Bypass -File build-apk.ps1     # 出 app-debug.apk
```

---

## 4. ⭐ 重打包边界表（最容易踩的坑）

| 改了什么 | 需要重出 EXE？ | 需要重出 APK？ | 说明 |
|---|---|---|---|
| 游戏 `src/**`（JS/着色器） | ❌ | ⚠ 通常**不需要** | APK 的 `GameServer` 发现 PC 后会 **`proxyStatic` 代理实时取最新代码**；改 JS 后 PICO 刷新页面即可 |
| 游戏资源（GLB/图片/影片） | ❌ | ⚠ 同上 | 同上，走代理 |
| **PC 端 `tools/cast-pc/` 的渲染层/主进程** | ✅ **必须** | ❌ | `asar: true` → 代码在 `app.asar` 内，不重打包不生效 |
| PC 端 EXE 配置（游戏目录等） | ❌（重开改配置即可） | ❌ | 配置持久化，不走打包 |
| **APK 的 Java 代码 / Manifest / 依赖** | ❌ | ✅ **必须** | 属原生层 |
| **离线使用（不连 PC）** | — | ✅ 必须 | 代理取不到时只能靠 APK 内自带副本，故资源变了要 `sync-assets.ps1` + 重打包 |

**一句话**：`src/**` 交给 EXE 实时托管，改 JS 一般不用重打包；
**改 APK 的 Java / 改 EXE 的渲染层**才必须重打包。

> 若改了 `sync-assets.ps1` 的排除规则或删了资源，记得重跑同步脚本并重出 APK，否则 APK 里还是旧副本。

---

## 5. 踩坑清单

| 现象 | 真因 | 结论 |
|---|---|---|
| PC 端 EXE 起来后 PC 大屏黑屏 | `world.sky` 挂在 `ambient` 组下，组被隐藏 → 子节点不渲染 | 临时把 sky **reparent 到 scene 根**渲染后再挂回；**绝不能** `ambient.visible=true`（几百个标注 Sprite 吃光 GPU） |
| 改 JS 后头显没变化 | 以为要重打包，其实应走代理 | 先确认 PC 已发现 + `proxyStatic` 生效，PICO 刷新即可 |
| 改了 EXE 渲染层却没生效 | `asar:true`，改动没进包 | 重跑 `npm run dist` |
| `robocopy` 被当失败 | 退出码 1/2/3 是「已复制」 | 只在 `>= 8` 时判失败 |
| `gradlew` 卡在下载发行版 | 离线/内网无法拉 `-bin` | 让脚本优先用 `~/.gradle/wrapper/dists` 里缓存的 `gradle.bat` |
| PowerShell 里 `& gradlew.bat` 报 pipeline 错误 | `.bat` 在管道中不可直接执行 | 一律 `cmd /c "…"` |
| `javac -version` 报 not recognized | 刚追加进 PATH，会话未刷新 | 用 `Join-Path $env:JAVA_HOME 'bin/javac.exe'` 绝对路径 |
| 构建报 JDK 版本不符 | AGP 8.4.2 需 JDK 17 | 按脚本探测，或手动设 `JAVA_HOME` |
| APK 体积异常大 | 把开发目录/大图打进去了 | 检查 `sync-assets.ps1` 的 `-XD` 排除项与 `$bigFiles` 列表 |
| 头显里 `navigator.xr` 为 undefined | 页面不是 localhost/非安全上下文 | 必须走 APK 的 localhost 服务，不能直接开 `https://<PC>` |
| 影片那几秒 PC 大屏没内容 | 影片期间不能编码（解码×编码争 VPU） | 设计上如此：PC 端**本地播同一段影片**顶上（见文档 06） |

---

## 6. 验证方法

**EXE**
- [ ] `npm run dist` 成功，`dist/` 下生成 NSIS 安装包；安装后能启动
- [ ] 启动后 `http://localhost:8443` 可访问（端口被占则自动 +1）；**默认进入纯净模式**（按 H 唤回面板，或加 `--panels` 启动即完整面板）
- [ ] 在界面里配置游戏目录（含 `index.html`）后，PC 端能显示「已连接 / 等待头显开始游戏」占位画面
- [ ] 改一处 `renderer` 层代码后重跑 `dist`，行为变化生效（证明 asar 边界理解正确）

**APK**
- [ ] `sync-assets.ps1` 输出 `DONE -> …assets\game`，且目标目录内**没有** `.git` / `node_modules` / `tools` / `*.md`
- [ ] `build-apk.ps1` 输出 `✅ 构建成功` 并打印 APK 路径与体积
- [ ] 安装到头显后能启动，localhost 服务起来（浏览器访问 `http://localhost:8080` 有响应）
- [ ] 不连 PC 时走 APK 内自带资源也能进游戏；连上 PC 后能取到 PC 上的最新代码
- [ ] 权限/横屏/cleartext 均生效（无崩溃、无白屏）


---

# 附录 · 2026-09-23 平台对接相关补充

## PC 端 EXE 的启动参数

平台登记并拉起 EXE 时，实测会传一个**位置参数**（见 `平台指令/VRPlatform-流量取证/指令速查.md`）：

```
argv[1] = "<exe 相对路径>$<进程名不含 .exe>$<平台本机 IP>"
例：    DeadHospital2-8.0.5\DeadHospital2.exe$DeadHospital2$192.168.31.228
```

我方 EXE **已能解析**它，并额外接受三个**可选**具名参数：

| 参数 | 含义 | 缺省 |
|---|---|---|
| `--room=<房间号>` | 平台侧房间号（仅留痕对账用） | 无 |
| `--platform=<IP:端口>` | 平台本机地址 | 取位置参数第 3 段 |
| `--game=<游戏名>` | 游戏名 | 取位置参数第 2 段（进程名） |

- 与既有参数并存：`--port` / `--root` / `--game-root` / `--no-serve` / `--pure` / `--panels` / `--fullscreen`（`--cert` / `--key` 已随自签 HTTPS 死代码删除）。
- **一个都不给时的行为与改造前完全一致**（自动发现 + 手动配置游戏目录 + 端口 fallback）。
- 参数会打进日志，并在接收端界面**顶部**显示（打包后没有控制台，只能靠界面核对）。
- ⚠ **踩过的坑**：原实现写死 `process.argv.slice(2)`。打包后 `process.argv = [<exe>, ...平台参数]`，
  会把 `argv[1]`（平台传 IP 用的那一段）**吃掉**。现按 `app.isPackaged` 区分（打包 `slice(1)` / 开发 `slice(2)`）。

## 打包标识与签名（升级相关）

- EXE：`appId = com.local.webxrcast`、`productName = WebXR直播接收端`（`tools/cast-pc/package.json` 的 `build`）。
- APK：`applicationId` 见 `tools/cast-apk/app/build.gradle`。
- **约束**：`applicationId` **必须与平台登记一致**；**签名变更会影响升级**
  （安装时校验不过会拒绝覆盖，现场表现为「装了但版本没变」）。
- 本轮**不做**代码签名与版本号流程改造，仅在此记录。

## 端口占用提示（现场最常被踩）

PC 接收端 HTTP 默认 **8443**，被占用时**自动 +1 重试至 8453**；
头显通过 UDP 信标（组播 `224.0.0.100:8444`，每 2s）自动拿到**实际**端口，无需人工改。
APK 本地游戏服务固定 **8080**。若现场 AP 开了**组播隔离**，信标到不了头显 → 需在 APK 配置页手工填 PC 地址。

---

## 附 · 2026-09-23 晚 第十八修（正式版裁剪与重打包边界）

- 源码新增编译时常量 **`RELEASE_UI`**（`src/core/constants.js`，与 `MASTER_GATE` 并列）：
  `true` = 正式包，游戏内**不创建**暂停/继续/设置/日志/导出面板、无桌面「开始游戏」、无右侧选关面板。
  **改这一个值就能出「调试包」（全界面）。**
- 运行时旁路：`?devui=1` 恢复全部调试界面（现场自测用）。
- **重打包边界（本轮新增）**：动了 `RELEASE_UI`、`src/ui/settings.js`、`src/ui/hud.js`、`index.html` 的 `body.release` 规则 ⇒
  **APK 必须重打**（`sync-assets.ps1` + `build-apk.ps1`）；PC 端 EXE 只有在动了 `tools/cast-pc/**` 时才需要重打。
- 本轮改动同时涉及 `GameServer.java` / `MainActivity.java`（直播模式结束收浏览器的 `sCastRoundOver` 分支）⇒
  **APK 非重打不可**，否则「结束本局后浏览器不关、下一局连不上直播」会复现。
- PC 端新增 `/api/round/end` 与 `round:get` / `round:set` IPC、界面 `#roundbar`（`▶ 开始本局` / `■ 结束本局`，快捷键 `S` / `E`）⇒
  **EXE 也需重打**（`npm run dist`）。
---

## 附 · 2026-09-23 晚 第二十一修（配置随 EXE 安装）

- `tools/cast-pc/package.json` 新增 **`extraResources`**：把 `src/content`、`src/core/userConfig.js`
  与 `assets/intro/intro.mp4` 复制到安装目录的 `resources/game-cfg/`（约 19.2 MB）。
- `main.js` 把「配置下发根」(`CONFIG_ROOT`) 与「静态托管根」(`currentServeRoot()`) 拆开诊断：
  两者都是「完整游戏目录 > 内置目录」。**内置目录没有 index.html**，故用 `hasConfigTree()` 判存在性。
- ⚠ **改了 `extraResources` 的 `from` 路径 ⇒ EXE 必须重打**（`npm run dist`），否则安装目录里没有 game-cfg。
- ~~路径②（头显浏览器直连整站）仍要填完整游戏目录~~ —— **2026-09-23 深夜 第二十二修已撤掉路径②**，
  外部目录降级为可选的「配置覆盖来源」；`isValidGameRoot()` 删除，统一 `hasConfigTree()`。
- 详见 `docs/cast-implementation-and-packaging.md` 附录 E、附录 F。

---

- 本轮产物（2026-09-23 20:05 / 20:06）：
  - APK `app-debug.apk` → `release/头显端-WebXR打气球.apk`（126.89 MB，SHA256 `6DCC3EE2…E2F5`）
  - EXE `dist/WebXR直播接收端 Setup 1.0.0.exe` → `release/PC端-直播接收端-Setup.exe`（77.94 MB，SHA256 `EF5D7AD0…B296`）

## 附 · 2026-09-23 深夜 第二十二修（档1 + 二选一 + 根级页面同步）

- **档1（撤路径②）**：`tools/cast-pc/main.js` 不再 serve 外部游戏目录（`currentServeRoot()` 打包版只返回
  `resources/game-cfg`）；`isValidGameRoot()` 删除；新增 `--panels` 才显示的运维面板；
  `/api/info` 去掉 `root`/`serveGame`，新增 `extCfg`/`configRoot`/`bundledCfg`/`serveRoot`/`panels`。
- ⚠ **`GameServer.java` 同步改了静态资源口径（包内优先）** —— 不跟着改，头显会白屏（`/index.html` 被代理给已停管的 PC）。
  ⇒ **APK 必须重打**。
- ⚠ **`build-apk.ps1` 新增 2.55 步：根级 `index.html` / `mirror.html` 也同步进 `assets/game/`**。
  以前只同步 `src/**`，根 HTML 靠手抄 —— 漏了就出现「构建成功但头显跑的是旧页面」。
- ⚠ **改了 `main.js` 的静态托管口径与 404 文案 ⇒ EXE 必须重打**（`npm run dist`）。
- 「进入 VR」二选一（蓝 ⚡射速加倍/攻击减半、红 💥攻击加倍/射速减半）改的是 `constants.js`/`player.js`/
  `main.js`/`availability.js`/`index.html` ⇒ 同为 APK 重打范围。
- 详见 `docs/cast-implementation-and-packaging.md` 附录 F。

---

---

## 附 · 2026-09-24 第二十三 / 二十四修（界面裁剪 + 授权关闭 + 服务器清单）

### 本轮改了什么（决定重打包范围）

| 改动 | 涉及文件 | 重打 APK | 重打 EXE |
|---|---|---|---|
| 隐藏右上角 2D 船血条 | `src/ui/hud.js`（`this.hpWrap.id = 'hud-hp'`）、`index.html`（`body.release` 选择器组） | ✔ | ✖ |
| 隐藏镜像标签 / 选关上方绿色长条 | `index.html`、`src/main.js` | ✔ | ✖ |
| 授权校验默认关闭 | `tools/cast-pc/main.js`（`LICENSE_ENABLED`）、`MainActivity.java`、`renderer/` | ✔ | ✔ |
| 服务器清单 + 旧配置清理 | `tools/cast-server/server.js`、`sync-content.js`、`tools/cast-pc/main.js`、`renderer/`、`MainActivity.java` | ✔ | ✔ |

⇒ **本轮 APK 与 EXE 都要重打**。

### 打包命令（照抄）

```powershell
# APK（→ app\build\outputs\apk\debug\app-debug.apk，126.97 MB）
cd tools\cast-apk
powershell -ExecutionPolicy Bypass -File .\build-apk.ps1

# EXE（→ dist\WebXR直播接收端 Setup 1.0.0.exe，97.09 MB）
cd tools\cast-pc
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run dist
```

### ⚠ 本轮新增的一条部署前置（**最容易漏**）

配置**不再随 EXE 安装包走**（第二十一修「把配置内置进 EXE」的做法在清单模式下不生效）：

```powershell
# 每次改了 src/content/** 或 src/core/userConfig.js，必须发布一次：
node tools\cast-server\sync-content.js --ver 1.0.0
# 再部署到服务器 —— content/ 在 .gitignore 里，git pull 不会把它带过去！
```

现场应急（服务器不可用）：EXE 加 `--local-content`，配置改从「游戏目录」出。
完整口径见 `docs/tech/09-服务器清单与旧配置清理.md`。

---

## 附 · 2026-09-24 第二十五修（接收端窗口：诊断行默认不显示）

现场反馈：PC 接收端窗口里那几行把**服务器地址、共享密钥、设备号**都摆在屏幕上（大屏投出去更明显）。
按「还在用的 → 隐藏显示；已不用的 → 不出现」处理：

| 那一行 | 还在用吗 | 处理 |
|---|---|---|
| 平台参数（`#platline`） | 在（平台对接诊断） | **默认不显示**，`--panels` 才显示 |
| 服务器清单的「来源 https://webvr123.site …」 | 在 | **默认不显示**（清单状态本身仍常显），`--panels` 才显示 |
| 授权（本机直播端）（`#licbox`） | **已不用**（第二十三修起授权校验默认关闭） | **整行不出现**；加 `--license` 恢复旧行为时自动回来 |
| 启动授权（`#guardbox`：密钥 `webxr-cast` / 局号 / 设备白名单） | 在（主控门禁） | **默认不显示**，`--panels` 才显示 |

- 实现：`body:not(.diag) #platline, #mftDiag, #guardbox { display:none }`，`body.diag` 由 `--panels` 驱动
  （与第二十二修的「游戏目录」面板同一套开关）；授权行由 `body.no-lic` 控制。
- **不只是隐藏**：诊断关着时这些内容**根本不写进 DOM**（`renderManifest` / `renderGuard` 提前返回）
  —— `display:none` 看不见但 DOM 里仍在，检修时用 DevTools 一样能读到。
- 常显的只剩：本机地址 / 推流端状态 / 头显请打开地址 / **服务器清单「已就绪 ver=x（n 个文件 / xKB）」**。
- ⚠ 顺带修掉一个真 bug：`license:get` 原来回的是 `licenseState()`，它没有 `off` 字段 ⇒
  第二十三修做的「关掉授权就不显示整行」实际没生效（现场看到「未激活（未加载）剩余 - 天」）。
  新增 `licenseUiState()` 收口（关闭时回含 `off:true` 的摘要）。

**重打包边界**：只改 `tools/cast-pc/**`（`main.js` + `renderer/`）⇒ **只需重打 EXE**，APK 不受影响。

---

## 附 · 2026-09-24 第二十六修（平台「二次拉起」不再打断 VR）

现场反馈：平台客户端「启动两次游戏，中间隔 20 秒左右」，第二次时玩家已在 VR 里 →
头显弹 PICO 系统弹窗「退出PICO浏览器 / 你需要退出当前应用才能继续操作」，本局被挤出 VR。

根因：平台的 `am start` 会带来**新进程**（那套启动里带 `kill`），而「免打扰」判据原先只存在于
**进程内**（`sLaunched`、`GameServer.lastPageHitMs`）⇒ 新进程判据全空 ⇒ 走完整门禁 +
建「正在等待直播端启动…」提示页（一个 2D 窗口）⇒ 弹窗 + 挤掉 XR 会话。

本修落地（**只影响 APK**）：

| 文件 | 改动 |
|---|---|
| `PagePresence.java`（新） | 页面在场证据写进 SharedPreferences（跨 `force-stop` 存活）：最后打点时刻 / `st` / `xr` / `cs`；`aliveNow()` = 6s 内打过点，或 90s 内打过点且当时 `xr=1` |
| `GameServer.java` | 新增 `lastPageXr`；每次页面轮询/事件都刷新跨进程记录 |
| `MainActivity.java` | `onCreate` 最前面读回记录（免打扰判据在新进程里也成立）；页面在 XR 里时**不发任何前台动作**、只 `finish()`；5s 兜底复核；`onNewIntent` 收页 |
| `src/game/game.js` | 判死复核 1 轮 → 2 轮（各 2.5s），避免撞上 APK 重启窗口被误判「游戏已死」 |

**重打包边界**：只改 APK 侧（含 `src/game/game.js`）⇒ **只需重打 APK**；EXE、服务器都不用动。
平台侧的根本解（停止每 20s 重发整套启动）见 `docs/平台对接需求（对平台方）.md` 第 8 条。

### 第二十七修（2026-09-24，「平台重拉弹窗」的客户端解法 · APK 侧）

| 文件 | 改动 |
|---|---|
| `EntryLock.java`（新） | 组件级**停用/恢复平台入口** + 死人开关（闹钟 60s）+ 进程启动自愈 + 心跳复核；留痕标记 `第二十七修-本局停用平台入口` |
| `RecoverActivity.java`（新，`enabled=false`） | **人工恢复入口**：只在停用期间启用；点它=恢复 + 打开配置页。平台隐式拉起时用 referrer 判出并**只 finish**（不建窗口） |
| `EntryFuseReceiver.java` / `BootReceiver.java`（新） | 死人开关接收端；开机 / 覆盖安装（`MY_PACKAGE_REPLACED`）恢复 |
| `AndroidManifest.xml` | `RECEIVE_BOOT_COMPLETED`；`RecoverActivity`（MAIN/LAUNCHER + `enabled=false`）；两个 receiver |
| `GameServer.java` | 页面轮询里的 `xr` 驱动 `EntryLock.onPageXr`；新增 `/api/entry`（状态）/ `/api/entry/unlock` / `/api/entry/lock` / `?on=0|1` |
| `MainActivity.java` | `scheduleClientRestore` 开头恢复；心跳线程每 5s 复核；配置页 `cbEntryLock` + `tvEntryLock`；被拉起且处于停用态时明确留痕 |
| `CastApp.java` | `onCreate` 里 `EntryLock.onProcessStart`（进程启动自愈） |
| `activity_main.xml` | 新增勾选框 `cbEntryLock`（默认勾选）+ 状态行 `tvEntryLock` |

**为什么第二十六修不够**：留痕实测 14:02:18.241 我们「只 finish 本页、没发任何前台动作」，
89ms 后 `xr-end` 仍然发生 ⇒ **只要我们的 Activity 被创建，PICO 就会建 2D 面板并顶掉 XR 会话**
（与本文件第九修注释里 18:24:04 那次的结论一致）。故第二十七修改为**让平台那次 `am start` 落不到我们身上**。

**现场自救（⚠ 口径已被第二十八修改写，见下节）**：电脑浏览器打开
`http://<头显IP>:8080/api/entry/unlock`；或重启头显。

**重打包边界**：只改 APK 侧 ⇒ **只需重打 APK**；EXE、服务器都不用动。

### 第二十九修（2026-09-24，「本局结束即作废页面在场记录」· APK 侧）

**现象**：进 VR 不再弹窗 ✔，但**每次的第二场都起不来**，只有第一场正常。

**留痕判读**（build=…-p28-zero-entry，15:45–15:50 连试三次，三次都起不来）：

| 时刻 | 留痕 | 判读 |
|---|---|---|
| 15:46:20.840 | `收到平台关闭指令 0x10 closeGame` | 第一场正常结束 |
| 15:46:22.067 | `[PAGE] {"ev":"DEAD:pagehide"…}` | 浏览器页被卸掉（退出策略关的浏览器） |
| 15:47:02.583 | `跨进程页面在场判据：上一进程最后打点 18s 前 state=playing xr=true → alive=true` | ❌ 死页被当成活页 |
| 15:47:02.599 | `平台重复拉起：判定游戏页仍在 → 免打扰路径：不重开浏览器` | ❌ **第二场就这么被吞掉** |
| 15:47:07.606 | `免打扰路径复核：页面在打点（age=23173ms）→ 本次重拉零打扰结束` | ❌ 复核也把「有记录」当成「还在打点」 |

**根因**：第一场结束时页面是**在 XR 里**被杀的，跨进程记录（`PagePresence`，第二十六修）最后一条打点
带着 `xr=true`、`state=playing`；第二场的平台 `am start` 落在 20~40s 后，仍在
`ALIVE_XR_MS = 90s` 窗口内 ⇒ 被判成「页面还在跑」⇒ 免打扰路径「不重开浏览器」⇒ 头显上什么都没发生。
**第二十六修那条为「平台 kill 我们之后重启」设计的规则，在「本局已经结束」的场景下变成了毒药。**

**本修改动（3 处，只动 APK 侧）**：

| 文件 | 改动 |
|---|---|
| `PagePresence.java` | 新增作废标记 `K_DEAD` + `markRoundOver(why)` / `isRoundOver()`；`aliveNow()` 见标记即 false；页面任何一次打点都会把标记撤掉；`ALIVE_XR_MS` 90s → **45s**；`BUILD_NOTE` → `第二十九修-本局结束即作废（原第二十六修-跨进程页面在场）` |
| `MainActivity.java` | ① `restoreClientAndCloseBrowser()`（= 退出策略，**本局结束的两种路由都经过它**）开头调 `markRoundOver`；② 免打扰 5s 复核的判据由「有记录」收紧为「**8s 内真的收到过页面请求**」（新常量 `PAGE_FRESH_MS`） |
| `GameServer.java` | `/api/page/dead`（sendBeacon 死因）与 `/api/page/event` 里带 `DEAD:` 的生命周期事件 → 一并 `markRoundOver` |

**预期行为**：第一场结束 → 第二场平台「启动游戏」→ 浏览器**重新打开**游戏页（预加载约 10s）→ 正常进 VR。
留痕应出现 `页面在场记录已作废（本局结束（平台关闭指令 0x10 closeGame））`。

**重打包边界**：只改 APK 侧 ⇒ **只需重打 APK**；EXE、服务器都不用动。
平台侧的根本解仍是「停止每 20s 重发整套启动」（`docs/平台对接需求（对平台方）.md` 第 8 条）。

### 第二十八修（2026-09-24，「包内零入口」· APK 侧）

第二十七修上线后现场**仍然弹窗**。p27 留痕（build=…-p27-entry-lock，14:57–15:00）三行定案：

| 时刻 | 留痕 | 判读 |
|---|---|---|
| 14:59:08.737 | `★ 平台入口已临时停用（页面在 XR 沉浸式会话里（?xr=1））` | 停用已生效，`MainActivity` 确为 DISABLED |
| 14:59:17.418 | `⚠ 平台的 am start 落到了「恢复入口」上 → 说明平台用的是不带 -n 的隐式 intent` | 平台被 `-n …/.MainActivity` 拒掉后**退化成隐式 MAIN/LAUNCHER**（或客户端直接 `getLaunchIntentForPackage`），解析到了当时唯一启用的 `RecoverActivity` |
| 14:59:17.618 | `xr-end st=intro byPlayer=false idle=false vis=visible` | **200ms** 后 XR 又掉了 —— 弹窗照旧 |

⇒ **只要包内还剩任何一个可被隐式意图解析的 Activity，平台就总能拉到它。**
第二十七修为了让现场能从应用列表自救而启用 `RecoverActivity`，恰好把靶子从 `MainActivity` 换成了它。

本修改动（**只动 APK 侧**）：

| 文件 | 改动 |
|---|---|
| `EntryLock.java` | `holdForXr` 由 `apply(a, false, true)` → `apply(a, false, false)`：**入口与恢复入口同时停用**；留痕标记改 `第二十八修-包内零入口` |
| `AndroidManifest.xml` | `RecoverActivity` 注释改口径（实现与清单项保留、`enabled=false`，停用期间**不再启用**） |
| `PageForensics.java` | 留痕 build 标记 → `2026-09-24-p28-zero-entry` |

**不变式（本修起）**：「页面在 XR 会话里」⇔「包内 MAIN/LAUNCHER 入口数 = 0」。

**代价（现场须知）**：本局在 VR 里的那几分钟，头显应用列表里**点不到本游戏**
（这正是要的效果 —— 平台也点不到）。出 VR（`?xr=0`）秒级恢复；其余六道安全网不变
（本局结束 / 页面打点停 20s / 进程启动自愈 / 死人开关 60s / 开机与覆盖安装 / 重装）。
人工恢复走**非 Activity 通道**：电脑浏览器 `http://<头显IP>:8080/api/entry/unlock`
（`/api/entry` 查状态），或重启头显。

**平台侧影响**：VR 期间平台那次 `am start` 现在会**解析失败**（shell 版 `Error: Activity not started,
unable to resolve Intent`；应用内 `startActivity` 抛 `ActivityNotFoundException`）⇒ 已并入
`docs/平台对接需求（对平台方）.md` 第 4 条（请改用显式组件并对失败容错）。

**重打包边界**：只改 APK 侧 ⇒ **只需重打 APK**；EXE、服务器都不用动。
## 附 · 2026-09-24 发行身份：包名 / 显示名 / 版本号 一键改（`tools/rebrand.ps1`）

**为什么要有它**：目前 APK 的安装身份是**临时顶替**另一个游戏来的 ——
`applicationId = com.GoodNet.DeepmindHacker`、显示名 `DeepmindHacker`、版本 `2.0.5 (205)`。
正式发行要换成自己的名字，而「换包名」在这套工程里零碎踩点很多（见下），所以做成一条命令。

```powershell
# 问答式（最省事）：双击 tools\rename-game.bat，或
powershell -ExecutionPolicy Bypass -File tools\rebrand.ps1 -Interactive

# 也可一次给全（不写盘只预览：加 -DryRun；只看当前身份：-Restore）
powershell -ExecutionPolicy Bypass -File tools\rebrand.ps1 -PackageId com.yourdomain.balloon -AppName 打气球 -VersionName 1.0.0 -VersionCode 101

# 常用开关：-NoBuild（只改文件不打包）/ -Sync ""（不往交付目录拷）/ -SyncName 文件名
#           -PcAppId / -PcProductName（顺带改 PC 端 exe 的 build.appId / productName）
```

不给 `-VersionCode` 时**自动 +1**（平台与 Android 都是按 versionCode 判新旧，同号覆盖安装会被拒）。

### 它到底改哪几处（2 个文件 + 2 类字符串）

| | 位置 | 说明 |
|---|---|---|
| ✅ 安装包名 | `tools/cast-apk/app/build.gradle` → `applicationId` | 唯一的安装身份来源 |
| ✅ 版本 | 同文件 → `versionCode` / `versionName` | 平台按它认版本 |
| ✅ 显示名 | `tools/cast-apk/app/src/main/res/values/strings.xml` → `app_name` | 清单里是 `android:label="@string/app_name"` |
| ✅ 注释 | `MainActivity.java` / `CastApp.java` 中**注释行**内的旧包名 | 只动 `*`、`//` 开头的行 |
| ✅ 通知标题 | `CastService.java` → `setContentTitle("… 运行中")` | 全工程唯一一处用户可见的硬编码名字 |
| ❌ 不动 | Java 包名 `com.local.webxrcast`、`AndroidManifest.xml`、`assets/`、PC 端 exe、服务器、授权 | 与「安装身份」无关；动 Java 包名只会白造一堆 diff 与风险 |

改完自动做三件事：**打包 → `aapt2 dump badging` 读产物的真实身份自证 → 拷到交付目录并重算 SHA256**
（顺带更新交付目录 `使用说明.md` 里的校验值）。防的是「构建 SUCCESS 但身份没吃到改动」这种要装到
设备上才发现的事故；改包名时旧交付包会先归档到 `_旧包-<日期>\`，不会被同名覆盖掉。

### 改名前必须知道的 4 件事

1. **平台要重新登记新包名**，否则平台枚举不到、也拉不起来（它按包名枚举并
   `am start -n <包名>/.MainActivity`）；平台登记里的**版本号**也要一起改。
2. 头显上它变成**全新应用**：旧包不会自动消失（可共存），`prefs` 全丢 ⇒ 现场要
   **重新授予一次悬浮窗权限**，否则关局后顶不回平台客户端（见第二十 / 二十八修）。
3. 别落在平台自己的前缀里（`com.GoodNet.*` 工具会告警），更不能占用平台客户端包名
   `com.GoodNet.LauncherClient`（工具直接拒绝）。
4. **签名与升级**：改名不影响签名；但**换签名**（debug → 自己的 release keystore）会让
   **同包名也装不上**（`INSTALL_FAILED_UPDATE_INCOMPATIBLE`），必须先卸载旧包。

### ★ 编码规矩（两条方向相反的坑，都实测过）

| 文件 | BOM | 为什么 |
|---|---|---|
| `.ps1`（本工具、`build-apk.ps1`） | **必须带** | PowerShell 5.1 把无 BOM 的脚本按 GBK 读 —— 中文注释的字节会吞掉引号，直接语法报错（`Missing closing '}'`） |
| `build.gradle` / `.java` / `.xml` / `src/*.js` | **绝不能带** | `build.gradle` 带 BOM → Groovy `Unexpected character: '?'`；`.java` 带 BOM → javac `illegal character: '\ufeff'` |


---

## 附 · 2026-09-24 现场「一局采集」脚本（`tools\collect-round.bat` + `tools\cap-round.py`）

**它回答一个问题**：游戏自然结束后，我方发不发 / 平台看不看得见「本局结束」，
以及平台收到之后会不会**顺手把游戏关掉**。答案一半在原始帧里、一半在平台日志里，所以脚本一次做完两件事：

| 维度 | 手段 | 能看到什么 |
|---|---|---|
| 原始帧 | raw socket 抓 UDP **51124 / 51234 / 62135 / 62136** | 结束帧的**真实字节**、方向、时间线 —— 平台日志里**没有**帧内容 |
| 平台行为 | 抓平台 `DebugLog\*.log` 命中行 | 平台**收到**了什么、之后有没有 `SendCloseGameToGame` / `kill` |

> **2026-09-24 首次跑通即结案**：答案是 **CMD 7 `GameStatistics`**，**不是** CMD 6 `GameEnd`
> —— 完整证据与字节样本见本文末〈结论：平台的「游戏结束」是 CMD 7〉。

### 一条命令

```bat
tools\collect-round.bat              :: 双击也行 —— 自己弹 UAC 提权，跑完按回车出报告
tools\collect-round.bat -s 180       :: 抓 180 秒自动停
tools\collect-round.bat --selftest   :: 自检（不需管理员，不抓包）
tools\collect-round.bat --analyze <某个.pcap>   :: 只分析已有抓包（不需管理员）
```

产物：`E:\AI_Work\WebXR_Capture\<时间戳>\` —— `round.pcap`（原始帧）+ `report.txt`
（一页报告：逐帧时间线 + CMD 命中表 + 结论 + 下一步）。

### 现场铁律（否则白跑）

1. 必须在**平台认为在跑游戏的那台机器**上抓（开局帧只发给它，抓错机器一帧都收不到）。
2. **必须让这一局自然结束**（打完 / 打输 / 通关）。用平台的「结束游戏」收场只会看到
   `kill` + `CloseGame`，**永远看不到结束帧（CMD 7）** —— 之前几份抓包就是这么错过的。
3. **上报之后别急着停**：结束帧发出去后平台还要走 `PostGameResult` → 暂停计时 → 落库一串动作。
   报告里若出现「⚠ 最后一次结算上报之后只观察到 N 秒」就是在提醒你 —— 再等 **30~60 秒**才收工。

### 实现注记（五条，全是现场实测踩出来的）

- **必须提权**：raw socket 收混杂包要管理员。`.bat` 用 `net session` + `fltmc` 双重判定并自动弹
  UAC 自提权；`%TEMP%\collect-round.elevated.tmp` 是哨兵文件，防的是「提权后仍判不成管理员
  ⇒ UAC 死循环」。`--analyze` / `--selftest` 是只读模式，走快速通道不弹 UAC。
- **`SIO_RCVALL` 要过三道坎**（2026-09-24 现场连撞两次；`--selftest` 测不到，只有**提权跑真抓包**才会碰到）：
  1. **常量名**：Python 的 socket 里叫 **`socket.SIO_RCVALL`**，**没有** `IOCTL_RCVALL` ⇒ `AttributeError`；
  2. **数值越界**：`0x98000001 > INT_MAX`，而 `setsockopt` 的 `optname` 是 C `int`
     ⇒ `OverflowError: Python int too large to convert to C long`（补码负值 `-1744830463` 才塞得进）；
  3. **`socket.ioctl()` 在 Windows 上对 `> 0x7fffffff` 的控制码会被拒**。
  现在的做法：`ws2_ioctl()` 用 **ctypes 直呼 `ws2_32.WSAIoctl`**（绕开 ②③），失败再退
  `setsockopt` 补码、再退无符号；实际生效的写法会打进日志（`…，抓包模式 ctypes.WSAIoctl →`）。
  该 helper 之所以单独抽出来，是为了能用**不需要管理员**的控制码 `SIO_UDP_CONNRESET (0x9800000C)`
  在普通 UDP socket 上先自测一遍管道 —— 已验证返回 `(0, 0)`。
- **绑哪个 IP 有讲究**：`SIO_RCVALL` 绑**具体接口地址**最稳（绑 `0.0.0.0` 在部分 Windows 上收不到包）。
  默认自动取本机主用 IPv4，日志里会打印**实际绑定的地址**；可用 `--bind-ip` 指定。
- **`.bat` 只能写 ASCII（这条最反直觉）**：cmd.exe 是**按当前代码页逐字节**读批处理文件的，
  `.bat` 里放中文会在多字节字符**中间**被切断，cmd 接着把切碎的字节当命令执行，现场报错就是
  `'xxx游戏」，否则永远看不到' is not recognized as an internal or external command`。
  所以 `collect-round.bat` 整文件 ASCII，中文提示交给 Python 打印。
- **控制台编码**：Python 侧 `fix_console()` 把代码页切 UTF-8 并 `reconfigure` stdout，
  否则报告里的 ✅ / ❌ 会抛 `UnicodeEncodeError` 把脚本直接打断（Windows 控制台默认 GBK 代码页）。

---

### 结论：平台的「游戏结束」是 **CMD 7**，不是 CMD 6（2026-09-24 实测）

现场一局采集（`E:\AI_Work\WebXR_Capture\20260924-175353\`，`round.pcap` 78868 字节，
17:53:53 ~ 18:10:34，游戏通道 12 帧 / 控制通道 647 帧），跑的是**原版 Unity 游戏**
（`DeepmindHacker-2.0.4`）⇒ 拿到的是**权威样本**。

| 时间 | 方向 | 内容 |
|---|---|---|
| 17:54:24.103 | 游戏(本机) → 平台 | `0x01` 注册（源端口 **51124** → `51234`） |
| 17:54:24.137 | 平台 → 游戏 | `0x01` + 240 字节 Machines JSON（机位表回执） |
| 17:54:45.197 | 平台 → 游戏 | `0x10` + `closeGame`（＝平台的「结束游戏」） |
| 17:55:05.429 | 平台 → 游戏 | `0x05` + 109 字节 StartInfo（`gameId:128`）＝「开始游戏」 |
| 17:55:05.444 | 游戏 → 平台 | `0x05` + 118 字节确认帧（`flag:1`） |
| **18:10:20.386** | **游戏(本机) → 平台** | **`0x07` + 398 字节 = 本局结束上报（首字节 1 + JSON 397）** |

平台 `DebugLog\2026-09-24-17-38-22.log` 同一秒：

```
6:10:20 PM  ===ReceiveCall==IP==192.168.31.228,,cmd = 7
6:10:20 PM  收到客户端发来的消息啦7,
6:10:20 PM  OnReceiveResultMsg, str = {…与抓包逐字一致…}
6:10:20 PM  ==PostGameResult=={"gameid":128,"instid":15,"shopid":1,…}
6:10:20 PM  游戏计时已暂停: 15:15.24
6:10:20 PM  游戏结束 场次ID:15 结算类型:正常结算,
6:10:23 PM  收到结算消息，游戏已暂停:
6:11:42 PM  关闭游戏=128                       ← 82 秒之后，且是**人点「结束游戏」**触发的
```

**四条可直接落地的结论**：

1. **CMD 6 从头到尾不存在**（我方没发、平台也没用）—— 「游戏结束」对平台而言就是 **CMD 7**。
2. **平台收到 CMD 7 就弹结算、且不关游戏**：那次 `kill` + `SendCloseGameToGame` 出现在 **82 秒之后**，
   由人点「结束游戏」触发。⇒ 这正是「通知平台本局结束、但别关游戏」的正解。
3. **`gameid` / `instid` / `shopid` 原版也全发 `0`**，平台按本局会话自行补成 `128 / 15 / 1`
   ⇒ 我方照发 `0` 即可，不用猜。
4. **`gameData` 是字符串化的 JSON、平台原样透传**（`PostGameResult` 里仍是转义字符串），
   不是嵌套对象 —— 别改成对象发。

**帧格式**：`0x07` + UTF-8 JSON，**无长度前缀、无结尾符**（全 0 的样本 JSON 397 字节）。

那 397 字节的权威样本（`JSON.stringify` 逐字节一致）：

```json
{"gameid":0,"instid":0,"shopid":0,"pos_playerid":null,"result":0,"scoreMul":0,"score":0,"mode":0,"time":0,"kill":0,"dead":0,"headshot":0,"meminfos":null,"gameData":"{\"gameIntensity\":0,\"result\":0,\"gameTime\":900,\"curProgress\":1,\"maxProgress\":6,\"playerData\":[{\"pos\":1,\"score\":0,\"total_kill\":0,\"total_die\":0,\"total_killhead\":0,\"hitRate\":0,\"killHeadRate\":0,\"estimate\":0}]}"}
```

**我方实现**：`tools/cast-pc/main.js` §平台游戏通道

- `PC_FRAME_GAME_RESULT = 0x07`；`buildGameResultPayload(opts)` **逐字照抄**上面这份样本
  （`curProgress = level + 1`、`maxProgress = 关卡总数`）；
- `sendPlatformGameResult(opts, why)` 复用**注册时的同一个 socket**（源端口必须 **51124**，否则平台不认）；
- 触发点：页面本局自然结束 → `POST /api/round/end` → `handleRoundEnd`
  （**仅当本局真被平台开过**才发，免得空局乱报）；开关 `--no-game-result`（默认开）；
- 现场**不必打满一整局**的自测端点：`POST /api/platform/game-result`
  （在平台已点「开始游戏」的那一局里打一下，平台界面应立刻弹结算）；
- 载荷**已与抓包字节逐字节比对通过**：`buildGameResultPayload({level:0,maxLevel:6,gameTime:900})`
  与 `round.pcap` 里那 397 字节**完全相等**。

> ⚠ 前提：EXE 必须是**被平台拉起**的。否则游戏通道不启用（`PLATFORM_CH.enabled === false`），
> 上报会被跳过 —— `GET /api/info` 的 `gameChannel.lastResultWhy` 会写明原因。

---

### 现场轻量验证（一键）—— `tools\trigger-game-result.bat`

**不用打满一整局**就能验「平台收到 CMD 7 会不会弹结算、会不会顺手关游戏」：

```bat
tools\trigger-game-result.bat              :: 双击也行
tools\trigger-game-result.bat -DryRun      :: 只看状态，不发
tools\trigger-game-result.bat -Port 8444   :: 已知端口时跳过探测
```

它等价于下面这条 curl，但把三个**现场坑**挡掉了：

```powershell
curl.exe -s -X POST http://127.0.0.1:8443/api/platform/game-result -H "Content-Type: application/json" -d "{}"
```

1. **端口**：PC 端 HTTP 从 8443 起、被占用会 +1 一路退到 **8453**；而打包后的 EXE
   **不写日志文件**、纯净模式下界面又把「头显请打开 http://…:<端口>」那行藏了
   ⇒ 现场**看不到**端口，硬猜 8443 会白试。脚本自己扫 8443~8453。
   （另：PowerShell 里 `curl` 可能是 `Invoke-WebRequest` 的别名，必须写 **`curl.exe`**。）
2. **前提**：`gameChannel.enabled = false`（EXE 不是被平台「启动游戏」拉起的）或本局还没
   「开始游戏」时，上报会被跳过。脚本先把这几项状态摆出来，免得把「没发出去」误判成
   「功能坏了」。
3. **源 IP**：**最容易踩、也最不容易发现**的一个，详见本节后面〈⚠ 第一次跑这个脚本没反应？先看源 IP〉。
   （2026-09-24 现场第一次跑就栽在这里。）

命中后平台侧应当**立刻**（不用等）出现 `cmd = 7` → `==PostGameResult==` →
`游戏结束 场次ID:N 结算类型:正常结算`，且**不关游戏** —— 这就是「只告知、不关掉」。
想连抓包与平台日志一起留证，再用 `tools\collect-round.bat`。

#### ⚠ 第一次跑这个脚本没反应？先看**源 IP**（2026-09-24 现场定案）

现场第一次跑完，脚本报 `ok: true / results: 1`、PC 端也**确实发了 397 字节**，
但平台界面什么都没有、**计时照常跑**。原因不是功能没做，而是**发去的地址是 `127.0.0.1`**：

- 平台对上行帧做**来源 IP 白名单**校验。只要*目标*是回环，内核会把**源地址**也选成 `127.0.0.1`，
  平台收到后直接丢弃，只在 `DebugLog` 留一句 `127.0.0.1这个外来IP想连接` —— `cmd = 7`
  **一个字节都进不去**。
- 对照证据：同一份日志里 `cmd = 5`（GameStart 应答）来了 3 次，因为那条回发用的是
  「平台发帧过来的地址」；而 `cmd = 7` **一次都没有**。

现在 PC 端按**证据强度**选、且只选一个目标，**绝不回退回环**：

| 优先级 | 来源 | 备注 |
| --- | --- | --- |
| ① | `gameChannel.lastFromIp` | 平台自己发帧过来的源 IP，最可靠 |
| ② | 启动参数 `--platform` / `argv[1]` 第 3 段 | 平台给的那个 |
| ③ | 本机默认路由网卡地址 | 上面都拿不到时兜底（本机实测 `192.168.31.228`，正好在平台 Machines 表里） |

> ★ ② **也要过滤回环**：平台**自己**给被拉起的游戏传的启动参数就是 `plstformIP = 127.0.0.1`
> （见平台日志 `=StartGame==gamePath==...plstformIP = 127.0.0.1`），照抄它就等于自己踩同一个坑。
> 故 ①②③ 三个来源一律过一遍「回环 / `0.0.0.0` / 空 → 丢掉」。

排障一眼看：`tools\trigger-game-result.bat -DryRun` 会打印**上报目标地址**（读 `/api/info` 的
`gameChannel.lastFromIp` / `platformIp`）；真发完还会回显 `实际发往:` —— 要是 `127.x`，
说明平台从没下发过帧、启动参数也没给可用地址。

**★ 2026-09-24 现场复测：通过 ✔** —— 重打 EXE 后跑一次 `tools\trigger-game-result.bat`，
平台界面**立刻出现结算按钮**、且**不关游戏**；同一次平台日志里 `cmd = 7` → `==PostGameResult==`
→ `游戏结束 场次ID:N 结算类型:正常结算`，与预期完全一致。

> 小注：`127.0.0.1这个外来IP想连接` 这句**平台自身回环流量也会触发**（没跑本脚本时也出现过），
> 所以它只是旁证；**决定性证据是 `cmd = 7` 有 0 次、而 `cmd = 5` 有 3 次**。
