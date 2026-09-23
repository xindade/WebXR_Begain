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
  "dependencies": { "selfsigned": "^2.4.1" },
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
| `"main": "main.js"` | 主进程入口，同时承载 HTTPS 服务、信令、窗口 |
| `selfsigned` | 运行时生成自签证书（SAN 含 `localhost` 与局域网 IP） |
| `target: ["nsis"]` | 产出 Windows 安装包（非 one-click，可选安装目录） |
| `signAndEditExecutable: false` | 本地自用，跳过代码签名与 exe 资源改写 |
| **`asar: true`** | 代码打进 `app.asar` → **决定了重打包边界**（见 §4） |

### 2.2 启动流程（`main.js`）

```js
// 打包后（asar 内）__dirname 指向 resources/app.asar，'../..' 会算到错误的目录 → 需特殊处理
let SERVE_GAME = false;                 // 仅当 GAME_ROOT 有效且包含 index.html 时为 true
...
mainWindow.loadURL(`http://localhost:${usedPort}/__cast/index.html${hasFlag('pure') ? '?pure=1' : ''}`);
```

- 渲染层页面从 **`/__cast/index.html`** 加载（Electron 窗口内的播放界面）。
- 静态资源根：`const serveRoot = SERVE_GAME ? GAME_ROOT : ROOT;`（`main.js:374`）
  → **配置了游戏目录后，`GAME_ROOT` 就是静态服务根**。
  这也是**开场影片能同源播放**的前提（PC 端播本地 `/assets/intro/intro.mp4` 必须与页面同源）。
- 因此：**首次使用必须先在 EXE 里配置游戏目录**（指向项目根，需含 `index.html`）。

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
- [ ] 启动后自动生成自签证书，`https://localhost:8443` 可访问
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

- 与既有参数并存：`--port` / `--root` / `--game-root` / `--no-serve` / `--pure` / `--fullscreen` / `--cert` / `--key`。
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
