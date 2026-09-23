# WebXR 双包直播方案 · 详细文档

> 把 PICO / 头显微端上的 WebXR 打气球游戏画面，实时投到 PC 端大屏（直播接收端）。
> 打包成两份产物：**PC 接收端 EXE** + **头显微端 APK（离线完整包）**。
> 头显微端打开 App 后**自动发现 PC、自动进游戏**，无需手动输入 IP。

---

## 1. 方案概述

| 产物 | 形态 | 职责 |
|---|---|---|
| **PC 接收端** | Electron EXE（`tools/cast-pc`） | 单端口 HTTP：承载「接收窗口 `<video>` + SSE 信令 + JPEG 兜底 + 局域网发现信标」。接收头显微端推来的 VR 画面并显示。 |
| **头显微端 APK** | Android 离线包（`tools/cast-apk`） | NanoHTTPD 在 `http://localhost:8080` 托管**内置的全部游戏资源**（离线可跑）；自动发现 PC 后用系统 Chrome 打开游戏并推流。 |

**已验证**：头显微端进 VR → PC 端 EXE 实时出画；APK 自动发现 PC 并自动跳转游戏界面。

---

## 2. 整体架构

```
┌─────────────────────────────────┐         ┌──────────────────────────────────┐
│        头显微端 (PICO)           │         │           PC 端                  │
│                                  │         │                                  │
│  [APK]                           │   UDP   │  [EXE 接收端]  http://0.0.0.0    │
│   ├─ GameServer :8080            │ 组播信标│     :8443                        │
│   │   (托管 assets/game 游戏本体)│ ──────▶ │     ├─ /__cast/index.html 接收窗 │
│   ├─ Discovery (监听 224.0.0.100:8444)    │     ├─ /api/events  SSE 信令      │
│   └─ Chrome Custom Tabs          │         │     ├─ /api/frame   JPEG 兜底    │
│         │                        │  WebRTC │     └─ UDP 信标 224.0.0.100:8444 │
│         │  http://localhost:8080 │ /JPEG   │            │                     │
│         │   ?cast=1&pc=<IP:8443> │ 推流    │            ▼                     │
│         ▼                        │ ──────▶ │      <video> 实时显示 VR 画面     │
│  [游戏 cast.js]                  │         │                                  │
│   观众相机 → 离屏渲染 → 推流      │         │                                  │
└─────────────────────────────────┘         └──────────────────────────────────┘
```

**数据流**：头显微端游戏（cast.js 用独立观众相机渲染）→ 经 WebRTC（或 JPEG 兜底）把帧推到 PC 信令服务器 → PC EXE 的 `<video>` 显示。

---

## 3. 目录结构与关键文件

```
WebXR_Begain/
├─ src/net/
│   ├─ cast.js             # 推流门面：观众相机 + 离屏渲染 + 帧节流
│   ├─ signaling.js        # 信令客户端（SSE 下行 + POST 上行，HTTP 明文，?pc= 跨源）
│   ├─ push-webrtc.js      # WebRTC 推流实现
│   └─ push-jpeg.js        # JPEG 兜底推流实现
├─ src/main.js             # 接入 createCast({world}) + cast.update(dt)
├─ src/core/constants.js   # CAST 参数块（分辨率/帧率/PC_URL）
├─ tools/cast-pc/          # ← PC 接收端 EXE
│   ├─ main.js             # 单端口 HTTP 服务 + SSE 信令 + UDP 信标
│   ├─ renderer/           # 接收窗口（index.html + renderer.js）
│   ├─ .npmrc              # Electron 国内镜像（已固化）
│   └─ package.json
└─ tools/cast-apk/         # ← 头显微端 APK（完整离线包）
    ├─ app/src/main/java/com/local/webxrcast/
    │   ├─ MainActivity.java   # 启动即起本地服务 + 自动发现 + 自动进游戏
    │   ├─ GameServer.java     # NanoHTTPD 从 assets/game 托管游戏
    │   └─ Discovery.java      # UDP 组播监听，自动发现 PC
    ├─ app/src/main/assets/game/  # 同步进来的游戏运行资源（构建时打包进 APK）
    ├─ app/src/main/res/layout/activity_main.xml  # 自动模式 + 手动兜底输入框
    ├─ sync-assets.ps1     # 资源同步脚本（tar 管道）
    ├─ build.gradle / app/build.gradle / settings.gradle
    └─ app/build/outputs/apk/debug/app-debug.apk   # 构建产物
```

> **游戏侧零改动即兼容离线包**：`signaling.js` 的 `defaultSignalBase()` 预留了 `?pc=<IP:port>` 参数，APK 只需打开 `http://localhost:8080/?cast=1&pc=<PC>` 即可把信令指向 PC。

---

## 4. 工作原理（关键机制）

### 4.1 观众相机（为什么不能用 world.camera）
VR 渲染时 `renderer.xr` 每帧 `updateUserCamera` 会覆写 `camera.matrixWorld / fov / projectionMatrix`，直接用 `world.camera` 取位姿会被 VR 姿态覆盖。`cast.js` 新建独立 `audienceCamera`，从 `world.camera.matrixWorld` 取位置朝向，保证推流画面是玩家视角的 VR 画面。

### 4.2 信令为什么用 SSE + POST
- `ws://` 在 HTTPS 页会被判为混合内容拦截；`wss://` 证书不可信时只静默抛 1006，极难排查。
- 同源 HTTP 下用 `EventSource` 下行 + `fetch POST` 上行最稳，且无需在头显微端装根证书。

### 4.3 为什么全程明文 HTTP（不是 HTTPS）
自签证书会触发 `-202 ERR_CERT_AUTHORITY_INVALID`：
- 头显微端 Custom Tabs **无法静默忽略**证书；
- PC 端 EXE 的 `certificate-error` 事件对 renderer 内 `EventSource`/`fetch` 子资源**不触发**，导致 viewer 反复重连、收不到画面。
- **解法**：信令全改 HTTP。WebRTC 媒体本身仍走 DTLS 加密；`http://localhost` 属安全上下文，WebXR 照常可用。

### 4.4 Chrome PNA（私有网络访问）拦截
`localhost` 页面跨域访问私有 IP（`192.168.x.x`）时，Chrome 先发 preflight 并要求返回 `Access-Control-Allow-Private-Network: true`。缺这个头 → GET 永不发出 → 客户端退避重连（日志看到 500/1000/2000…ms）。EXE 必须在 `/api/events` 与 `OPTIONS` preflight 都返回该头。

### 4.5 自动发现（UDP 组播信标）
- PC 端 EXE 启动即每 2 秒向 `224.0.0.100:8444` 组播 `WEBXR-CAST:<port>`。
- APK 的 `Discovery` 监听该组，解析出 PC 的 IP:端口。
- Android 组播需要 `CHANGE_NETWORK_STATE` + `ACCESS_NETWORK_STATE` 权限，且持有 `WifiManager.MulticastLock`，否则 ROM 会丢包。

### 4.6 自动进游戏
APK 启动 → 起 GameServer(8080) → 自动发现 PC → 用 `CustomTabsIntent` 打开 `http://localhost:8080/?cast=1&pc=<IP:port>`。
- **注意**：Android WebView 不支持 WebXR，进不去 VR，所以跳转目标必须是系统 Chrome（Custom Tabs），不是内嵌 WebView。
- 8 秒内没发现 PC → 回退显示手动输入界面（兜底，不会卡死）。

---

## 5. 环境准备

| 组件 | 版本 / 说明 |
|---|---|
| Node | 22（管理版）；Electron 33.x |
| Android SDK | platform `android-34`，build-tools **35.0.0**（注意不是 34），Java 17 |
| Gradle | 8.6（与 AGP 8.4.2 搭配；AGP 8.5.2 需 ≥8.7） |
| 头显微端 | 系统带 Chrome（PICO 4 满足） |
| PC | 防火墙放行 **8443 入站（TCP）** + **8444 出站（UDP 组播）** |

国内镜像（环境已固化，通常无需再设）：
- npm / Electron：`npmmirror.com`
- Gradle 分发：`mirrors.cloud.tencent.com/gradle`
- Android 依赖：`maven.aliyun.com/repository/google` + `/public`

---

## 6. 构建步骤

### 6.1 PC 接收端（已装好依赖）
```powershell
cd tools/cast-pc
npm start
```
首次启动会打印：
```
[cast-pc] HTTP 已启动 http://0.0.0.0:8443
[cast-pc] 局域网发现信标已开启（组 224.0.0.100:8444 …）
[cast-pc] 头显请打开：http://192.168.31.228:8443/?cast=1
```

### 6.2 头显微端 APK
```powershell
# 1. 填 SDK 路径
cd tools/cast-apk
copy local.properties.example local.properties
#   编辑 local.properties：sdk.dir=C\:\\Users\\x\\AppData\\Local\\Android\\Sdk

# 2. 同步游戏资源进 assets/game（排除开发目录与无用大图）
powershell -ExecutionPolicy Bypass -File sync-assets.ps1

# 3. 构建
.\gradlew assembleDebug        # 或 Android Studio 打开 tools/cast-apk

# 4. 装到头显微端（USB 连接）
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

> 资源更新（改了游戏代码后）需重跑 `sync-assets.ps1` 并重新构建 APK。

---

## 7. 端到端验证流程

1. **PC 端**先 `npm start`（保持运行）。
2. **头显微端**打开已装 APK → 应**秒级自动发现 PC 并自动进游戏**（无需输入任何东西）。
3. 头显微端**进入 VR** → PC 端 EXE 窗口实时出画。
4. **EXE 控制台预期日志**：
   ```
   [cast-pc] REQ GET /api/events origin=http://localhost:8080 from=<头显微端IP>
   [cast-pc] publisher 上线 (来自 <头显微端IP>)
   [cast-pc] 收到 WebRTC offer …
   ```
5. 若 PC 没开 EXE，APK 等 8 秒会显示手动输入框（兜底）。

---

## 8. 故障排查表

| 现象 | 根因 | 处理 |
|---|---|---|
| EXE 日志持续 `-202` | 旧 HTTPS 自签证书 | 确认 `main.js` 无 `https.createServer`，信令已 HTTP 化 |
| 头显微端反复重连 500/1000/2000…ms | PNA 头缺失 / 网络不通 | EXE 加 `Access-Control-Allow-Private-Network: true`；头显微端开 `http://<IP>:8443/api/info` 测通 |
| EXE 完全没有头显微端 `/api/events` REQ | 防火墙 / 头显微端没带 `?cast=1` 加载 | 防火墙放行 8443 入站；确认 APK 是 v2+；"只填地址别改 URL" |
| APK 搜不到 PC | 组播被拦 / PC 没开 EXE / 防火墙拦 UDP 8444 | 放行 UDP 8444 出站；先开 EXE；或用手动输入兜底 |
| 游戏能跑但进不去 VR | 用了 WebView 而非 Custom Tabs | 跳转必须用系统 Chrome Custom Tabs |
| 画面黑但控制台有 publisher | WebRTC 协商未成 | 看 `收到 WebRTC offer` 后是否 `rtc connected`；可 `?mode=jpeg` 强制 JPEG 兜底 |
| npm start 报 NODE_OPTIONS 相关 | 沙盒污染（本地通常无） | 先 `set NODE_OPTIONS=` 再启动 |

**一锤定音测试**：在头显微端浏览器直接打开 `http://192.168.31.228:8443/api/info`
- 能返回 JSON → 网络通，问题在信令/代码侧；
- 打不开/超时 → 防火墙或子网问题。

---

## 9. 踩坑全记录（从零到通）

1. **`npm config set electron_mirror` 报错 "not a valid npm option"**：`electron_mirror` 不是 npm 核心配置项，不能用 `npm config set`。写进 `tools/cast-pc/.npmrc` 或 export 环境变量 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`。
2. **`npm i` ETIMEDOUT 连 GitHub**：Electron 二进制从 GitHub 下载超时（GitHub 被墙）。改用国内镜像（`npmmirror.com/mirrors/electron/`）。
3. **`dl.google.com` 不通**：`settings.gradle` 改用阿里云镜像替代 `google()`/`mavenCentral()`；根 `build.gradle` 的 `buildscript.repositories` 也要加阿里云（`pluginManagement` 不覆盖 classpath）。
4. **AGP 8.5.2 需 Gradle ≥8.7**：本地 Gradle 8.6，降到 **AGP 8.4.2**；SDK 是 35 不是 34，显式 `buildToolsVersion "35.0.0"`。
5. **gradle-wrapper.jar 缺失**：直接下载 Gradle 分发解压，用 `gradle-8.6/bin/gradle` 跑。
6. **`cp -r` 资源同步自递归失败**：目标 `assets/game` 在源目录树内，`cp` 报 "copying a directory into itself" 中止。改用 `tar cf - --exclude=… . | (cd dst && tar xf -)`。
7. **WebXR 只能系统 Chrome**：内嵌 WebView 进不去 VR → 跳转必须 Custom Tabs。
8. **Chrome PNA 拦截**（详见 4.4）。
9. **自签 HTTPS 两头炸**（详见 4.3）→ 全改 HTTP。
10. **cast 信令「加载即连」**：`Signaling` 构造里立即 `new EventSource`，不需进 VR。PC 没 `publisher` 上线 = 头显微端游戏页没带 `?cast=1` 加载（或 APK 旧版）。
11. **用户手动加 `?cast=1` 后缀破坏解析**：APK 已自动拼好完整 URL，用户再手动追加 → 参数错位 → 信令不发。**务必告知：只填 PC 地址，别改 URL。** （本轮测试失败的根因就是它。）
12. **Android 组播需权限 + MulticastLock**：否则信标包被 ROM 丢弃、APK 搜不到 PC。

---

## 10. 参数调优（画质 / 延迟）

`src/core/constants.js` 的 `CAST` 块：
- `WIDTH` / `HEIGHT`：推流分辨率（默认 1280×720 级，按需调）
- `FPS`：推流帧率
- `PC_URL` / `SIGNAL`：信令路径

改完需**重跑 `sync-assets.ps1` + 重新构建 APK** 才生效。PC 看画时一起测延迟，若头显微端觉得游戏变卡或 PC 画面滞后，降分辨率/帧率。强制 JPEG 兜底排查：URL 加 `&mode=jpeg`。

---

## 11. 已知边界与后续扩展

- **多 PC 同开 EXE**：APK 取第一个发现的，无选择列表；需要时可加列表 UI。
- **release 签名版 APK**：用自有 keystore 替换 debug 签名即可正式分发。
- **离线包体积**：含全部游戏资源（约 45MB 游戏 + APK 壳 ≈ 48MB），资源更新需重同步 + 重打包（离线包成本）。
- **未推送 GitHub**：按约定所有改动留在本地，待明确要求再提交。

---

## 12. 快速命令速查

```powershell
# PC 接收端
cd tools/cast-pc && npm start

# 头显微端资源同步 + 构建
cd tools/cast-apk
powershell -ExecutionPolicy Bypass -File sync-assets.ps1
.\gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

> 文档配套 skill：`webxr-cast-dual-package`（AI 可据此复现整套方案）。
