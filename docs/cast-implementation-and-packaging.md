# 双端直播：实现方式与打包复现指南

> **本文定位**：一份**可直接照做**的复现手册 —— 讲清「直播是怎么实现的」+「两个安装包怎么打出来」。
> **姊妹文档**：`docs/cast-architecture.md` 讲**为什么是这样**（根因分析、踩坑史、被证伪的尝试）。**动手改之前先读那份的「硬约束」与「踩坑史」**，能省下几天无效调参。
> **快照时间**：2026-09-11（已在 PICO 4 实机验证「预览不闪 / 影片同步 / 进关卡自动切游戏画面」全链路）。
> 行号会随代码变动漂移，**以函数名为准**，行号仅供快速定位。
>
> **🚀 想「从零复现」或「移植到别的项目」**：本项目已把整套实现抽成**独立 skill 包**——
> `~/.workbuddy/skills/webxr-cast-dual-package/`（`SKILL.md` 流程 + `templates/` 全量可运行源码 + `references/` 协议/参数/排错/打包）。
> 它**不依赖本项目**，整个目录拷走即可在新项目落地。本文则是**本项目的落地记录**，两者互补。

---

## 一、一句话概览

头显（PICO 4）跑 WebXR 游戏并用**硬件 H.264** 把画面推出去，PC（Electron EXE）接收后投到大屏；头显侧另有一个 APK 提供 `localhost:8080` 的本地服务与 PC 自动发现。

```
┌─────────────────── PICO 4 头显 ───────────────────┐         ┌──────── PC（直播大屏） ────────┐
│  PICO 浏览器                                       │         │  Electron EXE :8443            │
│   http://localhost:8080/?cast=1&pc=<PC>:8443       │         │  ├ 静态托管 GAME_ROOT          │
│   &mode=webrtc                                     │         │  ├ /api/* 信令（SSE + POST）   │
│      │                                             │         │  ├ /api/frame JPEG 兜底        │
│      │  静态资源 ──► APK GameServer(NanoHTTPD:8080)│         │  └ /__cast/ 接收端界面         │
│      │                  └── 有 PC 时 proxyStatic ──┼────────►│                                │
│      │  信令 ─────────────────────────────────────┼────────►│                                │
│      └  媒体 ══ WebRTC P2P（DTLS + H.264 硬件编码）═════════►│                                │
│                                                    │         │  UDP 224.0.0.100:8444 信标     │
│  APK：GameServer + Discovery（监听信标）            │◄────────┤  （每 2s 广播 WEBXR-CAST:端口） │
└────────────────────────────────────────────────────┘         └────────────────────────────────┘
```

**三个缺一不可的要素**（详见 §9）：

| 要素 | 值 | 少了会怎样 |
|---|---|---|
| **origin = localhost** | `http://localhost:8080` | 非安全上下文 → PICO 不暴露 `navigator.xr` → 没有「进入 VR」按钮 |
| **信令直连 PC** | `?pc=<PC>:<port>` | 走 APK 代理 → NanoHTTPD 对 SSE 长连接支持差，易缓冲/易断 |
| **硬件编码** | `&mode=webrtc` | 落到 JPEG → `canvas.toBlob` **CPU 软编码** → PICO 单帧 5~6 秒 |

---

## 二、三个端与源码位置

| 端 | 目录 | 职责 | 改动后是否需重打包 |
|---|---|---|---|
| **头显游戏（推流端）** | `src/net/` | `cast.js` 门面/离屏采集/预热/影片同步 · `signaling.js` SSE 信令 · `push-webrtc.js` WebRTC 推流 · `push-jpeg.js` JPEG 兜底 | ❌ 不需要（PC 实时托管） |
| **APK（本地服务 + 拉起）** | `tools/cast-apk/` | `MainActivity.java` UI/拉起浏览器 · `GameServer.java` NanoHTTPD 托管+代理 · `Discovery.java` UDP 组播发现 | ✅ 需重打 APK |
| **PC 接收端（Electron）** | `tools/cast-pc/` | `main.js` HTTP 服务/信令/信标/IPC · `renderer/renderer.js` 接收与显示 · `renderer/index.html` 界面 · `preload.js` 桥 | ✅ 需重打 EXE |

### 三条独立数据流

| 流 | 路径 | 说明 |
|---|---|---|
| **静态资源** | PICO 浏览器 → `localhost:8080` → APK `GameServer` → （有 PC 时）`proxyStatic` → PC `:8443` | 页面 origin 仍是 localhost（保安全上下文），资源取自 PC → **改 JS 免重打包，PICO 刷新即生效** |
| **信令** | PICO 浏览器 → `http://<PC>:8443/api`（`?pc=` 直连，不经 APK） | 下行 `GET /api/events?role=publisher`（SSE）；上行 `POST /api/signal`（JSON） |
| **媒体** | PICO 浏览器 ══ WebRTC P2P ══› PC | 不经过 APK、不经过 HTTP 服务；`iceServers: []` → 只收集 host candidate，同网段直连 |

---

## 三、运行时序：三个阶段与两次无缝切换

理解这套实现的关键，是把「进游戏」拆成三个阶段 —— **闪烁的根因全部集中在阶段 1 / 2**。

```
阶段 1：预览菜单 (game.state = 'menu')
  cast: _shouldPause() === true
        └ 不建离屏 WebGL renderer（零 GL 上下文 → 头显不闪）
        └ _startWarmup()：建一张 2D canvas，captureStream(1fps) → WebRtcPush 建立链路
  PC  : 立刻出画 —— 黑底 +「PICO 直播 · 已连接 / 等待头显开始游戏…」

阶段 2：等待房间 · 开场影片 (state = 'waiting'，scene.userData.castIntro = true)
  头显: waitingRoom.start() → window.__cast.notifyIntro('play')
        └ 信令 { type:'intro', stage:'play', src:'assets/intro/intro.mp4' }  ──►  PC
        └ 头显不渲染游戏场景，仍推 1fps 占位画面（被影片层遮住；不编码影片）
  PC  : startIntro(src) → 播**本地同源** /assets/intro/intro.mp4（无网络、无编码）
        └ 影片层 z-index 盖住推流画面 → 观感上是同一段影片

阶段 3：影片结束 → 第 1 关 (state = 'playing')
  头显: waitingRoom.dispose()
        └ 先 notifyIntro('end')（必须在删除 castIntro **之前**发）
        └ 删 scene.userData.castIntro → _shouldPause() 变 false
        └ _swapToOffscreen()：_ensureOffscreen() 建离屏 renderer
           → RTCRtpSender.replaceTrack() 原地换轨道（尺寸同为 W×H，编码器不重协商）
        └ 从此 24fps 推真实游戏画面
  PC  : 收到 'end' → 400ms 后收起影片层 → 露出已切好的游戏画面
```

**为什么影片期间不推流**：视频**硬件解码**与 H.264 **硬件编码**争用 PICO 同一个媒体硬件块（VPU），同开会闪。所以两头各播各的影片，用信令对齐开始与结束（详见姊妹文档「第二层根因」）。

---

## 四、头显端实现（`src/net/cast.js`）

### 4.1 启用与门面

```js
// createCast({ world, game }) —— main.js 调用（game 用于判断是否真的开始游玩）
// 未带 ?cast=1 → 返回 NOOP_CAST：不建 GL 上下文、不连信令、不渲染，零开销
export function createCast({ world, game }) {
  if (!world) return NOOP_CAST;
  if (new URLSearchParams(location.search).get('cast') !== '1') return NOOP_CAST;
  return new Cast({ world, game, q });
}
```

### 4.2 采集方式：观众相机 + 独立离屏 canvas

| 做法 | 原因 |
|---|---|
| **不能抓主 canvas** | WebXR 下 three.js 把画面渲进 XR framebuffer，canvas 默认帧缓冲是空的，抓出来全黑 |
| **不能用 captureStream 抓主 renderer** | 它依赖 `preserveDrawingBuffer:true`，主 renderer 没开，而改开会拖累 VR 每帧带宽 |
| **另建离屏 renderer** | 自己开 `preserveDrawingBuffer`（仅 JPEG 模式需要）；`xr.enabled` 保持默认 false → 完全不碰 XR 渲染状态 |
| **另建观众相机** | XR 下 `world.camera` 的 fov/projectionMatrix 会被写成交叉非对称投影，不能直接拿来渲 2D 画面 |

每帧从主相机 `matrixWorld` 取位姿（主相机是 `game.rig` 的子节点，`position` 是局部坐标，必须读世界矩阵）。

### 4.3 核心机制清单

| 机制 | 方法（`src/net/cast.js`） | 要点 |
|---|---|---|
| **延迟创建 GL 上下文** | `_ensureOffscreen()` | 预览/影片阶段第二个 WebGL 上下文**存在本身**就干扰头显 → 延迟到进关卡才建 |
| **游玩前暂停判定** | `_shouldPause()` | `scene.userData.castIntro === true` 或 `game.state ∈ CAST.PAUSE_STATES`（`['menu','waiting']`） |
| **2D 占位预热链路** | `_startWarmup()` / `_drawPlaceholder()` / `_clearWarmup()` | 用普通 2D canvas（黑底 + 提示文字，`WARMUP_FPS=1`）建链路：零 GL 上下文但 ICE/编码器提前就绪 |
| **无缝切换到游戏画面** | `_swapToOffscreen()` | `RTCRtpSender.replaceTrack()` 原地换轨；失败则发 `peer-left` 让 PC `resetPc()`，600ms 后重建 |
| **推流启动** | `_startPush()` | 判定暂停 → 走预热；否则建离屏 → `captureStream(0)` + 手动 `requestFrame()` 节流 |
| **JPEG 兜底** | `_fallbackToJpeg()` / `_rebuildForPdb()` | 6 秒连不上自动降级；暂停阶段降级时**不重建 renderer**（会引入 GL 上下文），改推占位 2D canvas |
| **帧节流 + 自适应降档** | `update()` / `_autoScale()` | 按 `1000/fps` 跳帧；离屏均耗时连续两轮 > `SLOW_MS(7ms)` → 分辨率×0.75（最多 2 档） |
| **天空球临时救场** | `update()` | 等待房间整体隐藏了 `world.ambient`，而 `sky` 挂其下 → 临时 reparent 到 scene 根，`finally` 挂回 |
| **影片画法钩子** | `scene.userData.castVideoSwap` | 由 `waitingRoom` 注册；`VIDEO_MODE='hide'` 时离屏渲染期间把视频屏换纯黑材质 |
| **影片阶段通知** | `notifyIntro(stage, src)` | 信令 `{type:'intro', stage:'play'|'end', src}`；`window.__cast` 供 waitingRoom 调用 |

### 4.4 两处必须成对/顺序正确的地方

1. `castVideoSwap(mode)` 与 `castVideoSwap(false)` 必须**成对**且用 `finally` 还原，否则主视角会留着直播用的替代材质。
2. `waitingRoom.dispose()` 里 **先发 `notifyIntro('end')`、再删 `castIntro`**。顺序反了，cast 会先看到 `castIntro` 消失而开始建离屏 renderer，PC 端影片层却还没收起。

### 4.5 日志判据（头显侧）

| 日志 | 含义 |
|---|---|
| `已启用 mode=webrtc 960x540@24 → http://<PC>:8443/api` | 推流初始化成功 |
| `预热链路已启动（2D 占位画面 1fps，未创建 GL 上下文 → 头显不闪）` | 阶段 1 正常 |
| `预览/影片阶段 → 暂停推流（不渲染、不编码）` | 阶段 1/2 判定生效 |
| `已开始游玩 → 启动推流` + `离屏渲染器已创建 960x540（延迟到开始游玩…）` | 阶段 3 进入 |
| `已切换到游戏画面（replaceTrack，链路未中断）` | 换轨成功（**关键判据**） |
| `占位画面切换失败 → 重建链路` | 内核不支持 `replaceTrack`，已自动兜底 |
| `RTC: connected` | P2P 连通 |
| `离屏渲染均耗时 xx ms/帧` | 每 60 帧一条；持续 >7ms 会触发自动降档 |

---

## 五、PC 接收端实现

### 5.1 主进程（`tools/cast-pc/main.js`）

一个端口干五件事（全部同源，明文信令，免自签证书信任问题；媒体流仍由 WebRTC DTLS 加密）：

| 路由 | 作用 |
|---|---|
| `GET /*` | 静态托管游戏（`GAME_ROOT`；打包运行时默认 `NO_SERVE`，需在 UI 配置目录） |
| `GET /api/events` | SSE 下行（`welcome` / `peer-ready` / `offer` / `answer` / `ice` / `peer-left` / `intro`） |
| `POST /api/signal` | 上行信令（JSON，按 `role` 转发给对端） |
| `POST` / `GET /api/frame` | JPEG 兜底：推帧 / 取帧 |
| `GET /api/info` | 端口 / 本机 IP / 对端在线状态 / 游戏根 |
| `GET /__cast/*` | 接收端自己的界面（避免 `file://` 相对路径失效） |

**启动顺序**：托管 `GAME_ROOT` → 起 HTTP（8443，被占自动 +1，最多 10 次）→ UDP 组播发信标（广播**实际监听端口**）→ 开窗口。

**关键配置项**：

| 项 | 位置 | 作用 |
|---|---|---|
| `disable-features=WebRtcHideLocalIpsWithMdns`<br>`force-webrtc-ip-handling-policy=default` | `main.js:25-26` | 关掉 mDNS 候选混淆，否则 ICE 候选变 `xxx.local` → 对端不可达 |
| `applyCors()` | `main.js` 请求处理段 | 必须同时返回 `Access-Control-Allow-Origin:*` 与 `Access-Control-Allow-Private-Network:true`；`handleEvents` 与 `OPTIONS` preflight 也要带，否则 Chrome PNA 在连接建立前就拦掉 |
| `GAME_ROOT` 解析 | `resolveGameRoot()` | 优先级：CLI `--game-root` > `userData/cast-pc-config.json` > 自动探测（`cwd` / 项目根 / `E:/AI_Work/WebXR_Begain` …） |
| `handleFramePost` | `main.js` | JPEG 帧用 IPC `cast:frame` **直推**渲染进程，取代轮询（消除空帧抖动） |
| `startBeacon()` | `main.js` | UDP 组播 `224.0.0.100:8444`，每 2s 广播 `WEBXR-CAST:<端口>` |

### 5.2 渲染进程（`tools/cast-pc/renderer/renderer.js`）

| 机制 | 位置 | 说明 |
|---|---|---|
| **纯净模式** | `setPure()` / `body.pure` 规则 | **H** 切换（隐藏地址栏/配置/日志，只留画面）；**F** 全屏；**M** 影片静音开关；状态存 `localStorage` |
| **画面区状态提示** | `updateHint(info)` | 没帧时按阶段显示「等待推流端连接 / 正在建立 P2P 连接 / 已连接，等待头显开始游戏」，不再是静态文案 |
| **WebRTC 接收** | `ensurePc()` / `onOffer()` / `showVideo()` | `iceServers: []`；收到 track → `<video>` 接管，置 `usingVideo=true` |
| **收帧诊断与自愈** | `startVideoWatchdog()` | 每 3s 打 `收帧诊断 W×H 已解码=N 丢帧=M`；连上后 8s 仍 0 帧 → 放开 `usingVideo` 让 JPEG 接管 |
| **JPEG 兜底** | `initJpeg()` / `manageJpeg()` / `startJpegPolling()` | 优先 IPC 直推，退回 33ms 轮询 |
| **影片本地同步播放** | `startIntro()` / `stopIntro()` / `scheduleStopIntro()` | 收到 `intro:play` 播 `/assets/...`（同源）；`intro:end` → 400ms 后收起 |
| **三重防遮挡兜底** | `ended` + `loadedmetadata` | ① 收到 `end` 信令；② 本地 `ended` 后 1.2s；③ `duration + 5s` 硬收起。信令丢失也不会一直挡着游戏画面 |

### 5.3 页面元素（`renderer/index.html`）

```html
<video id="video" autoplay muted playsinline></video>   <!-- WebRTC 画面 -->
<img   id="img"   alt="JPEG 兜底画面" />                 <!-- JPEG 兜底画面 -->
<video id="intro" preload="auto" playsinline></video>    <!-- 本地开场影片层 z-index:5 -->
<div   id="hint">…</div>                                 <!-- 无帧时的状态提示 -->
<div   id="logbox"></div>                                <!-- 诊断日志 -->
<div   id="toast"></div>
```

`#video, #img` 用 `object-fit: cover` 铺满（保留比例、裁掉溢出、无黑边）；`body.pure` 下隐藏 `#bar` / `#cfgbox` / `#logbox`。

---

## 六、APK 端实现（`tools/cast-apk`）

### 6.1 三个类

| 类 | 作用 |
|---|---|
| `MainActivity` | 起 `GameServer` → 起 `Discovery` → （默认 `USE_INNER_WEBVIEW=false`）不显示内嵌页面，发现 PC 后**拉起 PICO 浏览器**打开 `getCastUrl()` 并 `moveTaskToBack` 退后台（进程必须存活，GameServer 要持续服务） |
| `GameServer`（NanoHTTPD） | `localhost:8080`：托管 `assets/game/**`；发现 PC 后 `proxyStatic` 把静态资源同源代理到 PC（保证最新代码），`/api/*` 用 **Piped 流边读边 flush** 转发（消除 SSE 缓冲） |
| `Discovery` | 加入组播 `224.0.0.100:8444`，收到 `WEBXR-CAST:<端口>` → 回调 `(ip, port)` |

### 6.2 拉起地址

```java
GAME_URL = "http://localhost:8080/?cast=1";
getCastUrl():
   已发现 PC → GAME_URL + "&pc=" + currentPc + "&mode=webrtc"
   未发现 PC → GAME_URL（仅本地游玩）
```

### 6.3 三个易错点（均已修复，改动时勿回退）

1. **WebView 不能跑游戏**：PICO 内嵌 WebView 无 GPU，`new World()` 会抛 `WebGL context could not be created`。`USE_INNER_WEBVIEW=false` 时根本不显示它，玩家全程只看到**一个**网页。
2. **`readBody()` 不能走 `session.parseBody()`**：NanoHTTPD 只解析 `multipart/form-data` 与 `x-www-form-urlencoded`，遇到 `application/json` 会把整段 JSON 当成一个空值键 → offer/answer 的 body 被丢弃、PC 永远收不到 offer。必须按 `Content-Length` 从原始输入流读。
3. **跳到外部浏览器后要 `stopInnerWebView()`**：否则后台 WebView 里的第二个游戏实例会被冻结/节流却仍占着信令槽位，导致前台真正在跑的实例推不出画面。

---

## 七、信令协议（完整消息表）

**传输**：下行 `GET /api/events?role=<publisher|viewer>`（SSE，每 15s 一条 `:ping` 心跳）；上行 `POST /api/signal`（JSON，体里带 `role`）。

| 方向 | `type` | 字段 | 语义 |
|---|---|---|---|
| 服务端→客户端 | `welcome` | `role` | 角色注册成功 |
| 服务端→对端 | `peer-ready` | — | 对端上线（publisher 收到 → 可以 `createOffer`） |
| 服务端→对端 | `peer-left` | — | 对端离开 |
| publisher→viewer | `offer` | `sdp` | WebRTC offer |
| viewer→publisher | `answer` | `sdp` | WebRTC answer |
| 双向 | `ice` | `candidate` | ICE candidate（`null` = 收集结束） |
| publisher→viewer | `intro` | `stage`（`play`/`end`）、`src` | 开场影片开始 / 结束（PC 据此同步播本地影片） |
| 服务端→客户端 | `log` | `msg` | 服务端日志转发 |

**兜底轮询**：publisher 侧每 1.5s `GET /api/info`，若 `info.viewer === true` 则补触发 `_startPush()` —— 防止 SSE 下行被中间设备吞掉 `peer-ready`（`/api/info` 是普通短 GET，最稳）。一旦开始推流即停掉轮询。

**ICE 策略**：`iceServers: []`（两端一致）+ `bundlePolicy: 'max-bundle'`。不配 STUN —— 会引入 srflx 候选，家用路由通常不支持 NAT 回环，反而连不上。PC 侧关掉 mDNS 混淆后直接提供真实 IP 候选。

---

## 八、参数表

### 8.1 URL 参数（刷新即生效，无需重打包）

| 参数 | 作用 | 默认 |
|---|---|---|
| `cast=1` | **必需**，不写则推流完全不初始化 | — |
| `pc=IP:PORT` | 信令直连 PC 地址 | 不写 → 同源 `/api` |
| `mode=` | `webrtc` \| `jpeg` | `webrtc` |
| `w=` / `h=` | 观众画面分辨率 | 960 / 540 |
| `q=` | JPEG 质量（仅兜底模式有效） | 0.6 |
| `fps=` | 推流帧率 | 24 |
| `bitrate=` | WebRTC 最大码率 bps（**嫌糊先加这个**） | 3000000 |
| `degrade=` | `balanced`（默认，实测稳定出帧）\| `maintain-framerate` \| `maintain-resolution`（⚠ PICO 上一帧都不出，勿用） | balanced |
| `vmode=` | 影片画法：`hide`（默认）\| `raw`（对照用，会闪）\| `mirror`（PICO 取不到帧） | hide |
| `mw=` | mirror 中转 canvas 宽度（仅 mirror 有效） | 640 |
| `pdb=` | `1` 强制开 `preserveDrawingBuffer`（排查闪烁对照用） | 0 |
| `thumb=` | `1` 显示右下角 240×135 缩略图 | 0 |
| `amb=` | `0` 直播画面不画天空球（纯色背景，最省） | 1 |
| `noscale=` | `1` 关闭「离屏过慢自动降分辨率」 | 0 |
| `earlycast=` | `1` 关闭「游玩前不推流」（对照：会复现闪烁） | 0 |
| `warmup=` | `0` 关闭「2D 占位画面预热链路」（退回 PC 端纯黑等待） | 1 |

### 8.2 `CAST` 常量块（`src/core/constants.js`，可被 `src/core/userConfig.js` 的 `USER_CONFIG.CAST` 覆盖）

| 键 | 当前值 | 说明 |
|---|---|---|
| `W` / `H` | 960 / 540 | 离屏 canvas 尺寸。卡就 `?w=854&h=480`（已验证流畅） |
| `FPS` | 24 | 节流用：按 `1000/fps` 跳过 XR 帧 |
| `FOV` | 70 | 观众相机 fov（与主相机一致） |
| `TRANSPORT` | `'webrtc'` | **不要改回 `jpeg`** |
| `JPEG_QUALITY` | 0.6 | 仅兜底链路 |
| `MAX_BITRATE` | 3000000 | 仍糊可 `?bitrate=5000000` |
| `DEGRADE` | `'balanced'` | ⚠ 禁止 `maintain-resolution`（PICO 一帧都不出） |
| `VIDEO_MODE` | `'hide'` | ⚠ 勿改 `raw`（会闪） |
| `MIRROR_W` | 640 | 仅 mirror 模式 |
| `PAUSE_BEFORE_PLAY` | `true` | 游玩前不推流 |
| `PAUSE_STATES` | `['menu','waiting']` | 抽卡 / 结束画面仍要直播，故不列入 |
| `WARMUP` | `true` | 2D 占位预热链路 |
| `WARMUP_FPS` | 1 | ⚠ 别调高（影片期解码×编码争 VPU） |
| `SHOW_AMBIENT` | `true` | 只把 `world.sky` 临时挂 scene 根，**不是** `ambient.visible=true` |
| `HIDE_PANO` | `true` | 不画全景穹顶（6K/8K 纹理进第二个上下文要上百 MB 显存） |
| `SIGNAL` | `'/api'` | 同源前缀；APK 场景由 `?pc=` 覆盖 |
| `SLOW_MS` | 7 | 离屏单帧均耗时上限，超过连续两轮 → 自动降档 |
| `THUMB` | `false` | 可见 canvas 每帧多一次页面合成，默认关 |

---

## 九、不可违反的硬约束（改动前必读）

| # | 约束 | 违反后果 |
|---|---|---|
| 1 | 页面 origin 必须是 `localhost` | 非安全上下文 → 无 `navigator.xr` → 无 VR 按钮 |
| 2 | 默认传输必须是 `webrtc` | 改回 `jpeg` = CPU 软编码 → 5~6 秒一帧（**已验证，禁止回退**） |
| 3 | 信令必须带 `?pc=` 直连 PC | 走 APK 代理 → SSE 长连接易缓冲/易断 |
| 4 | PC 必须返回 PNA 响应头（含 OPTIONS preflight） | Chrome 私有网络访问在连接建立前拦掉 → 服务端收不到任何请求 |
| 5 | APK 内嵌 WebView 不能跑游戏 | 无 GPU → `WebGL context could not be created` |
| 6 | PC 端必须关 mDNS 混淆 | ICE 候选变 `xxx.local` → 卡在 `connecting` |
| 7 | WebRTC 不配 STUN | 引入 srflx 候选，家用路由不支持 NAT 回环 → 反而连不上 |

**PICO 两条平台硬限制**（无法绕过，只能绕开）：① 不信任自签证书且无「继续访问」入口 → 不能 `https://<PC>` 直连；② 非 localhost 一律不是安全上下文。两条叠加，决定了「页面必须在 localhost、信令/媒体必须跨域直连 PC」这个唯一形态。

---

## 十、双端打包

### 10.1 环境依赖

| 用途 | 依赖 | 本机路径 / 版本 |
|---|---|---|
| PC 端 | Node.js + npm | 任意 LTS |
| PC 端 | `electron ^33.0.0`、`electron-builder ^25.1.8`、`selfsigned ^2.4.1` | `tools/cast-pc/package.json`（`npm install` 装） |
| APK | JDK 17 | `C:/Program Files/Java/jdk-17` |
| APK | Android SDK | `tools/cast-apk/local.properties` → `sdk.dir=C:/Users/x/AppData/Local/Android/Sdk` |
| APK | Gradle | 优先用 `~/.gradle/wrapper/dists/` 已缓存发行版（8.14.3），避免 `gradlew` 联网下载 |
| APK | AGP 8.4.2（兼容 Gradle 8.6+） | `tools/cast-apk/build.gradle` |
| 网络 | 同一局域网，头显↔PC 之间 **UDP 8444**（组播发现）与 **TCP 8443**（信令）可达 | — |

> **沙盒提示**：Gradle 要写 `~/.gradle` 缓存，命令需在关闭沙盒的前提下执行，否则会被拒绝。

### 10.2 构建 PC 端 EXE

```bash
cd tools/cast-pc
npm install                    # 首次
npm run dist                   # = electron-builder --win --x64

# 产物：tools/cast-pc/dist/WebXR直播接收端 Setup 1.0.0.exe
# 复制到 release/PC端-直播接收端-Setup.exe
```

`package.json` 打包配置要点：

```json
"build": {
  "appId": "com.local.webxrcast",
  "productName": "WebXR直播接收端",
  "win": { "target": ["nsis"], "signAndEditExecutable": false },
  "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true },
  "asar": true
}
```

- `asar: true` → `main.js` / `preload.js` / `renderer/**` 全打进 `app.asar`，**改了就必须重打**。
- 打包运行时 `app.isPackaged === true` → `NO_SERVE` 为真，**默认不托管静态页**；但**必须在界面里配置游戏目录**（`GAME_ROOT`），否则 PC 端取不到 `/assets/intro/intro.mp4`（影片层会 404 并自动收起）。

### 10.3 构建 APK

```bash
# ① 同步游戏源码进 APK 内置资源（改了 src/ 或 index.html 就要同步）
powershell -ExecutionPolicy Bypass -File tools/cast-apk/sync-assets.ps1
#   → 源 = 项目根，目标 = tools/cast-apk/app/src/main/assets/game
#   → 排除 .workbuddy / .git / node_modules / tools 与 *.md package.json 等

# ② 构建（关闭沙盒）
cd tools/cast-apk
JAVA_HOME="C:/Program Files/Java/jdk-17" \
ANDROID_SDK_ROOT="C:/Users/x/AppData/Local/Android/Sdk" \
ANDROID_HOME="C:/Users/x/AppData/Local/Android/Sdk" \
  "C:/Users/x/.gradle/wrapper/dists/gradle-8.14.3-all/<hash>/gradle-8.14.3/bin/gradle" assembleDebug

# ③ 产物：app/build/outputs/apk/debug/app-debug.apk
#    → 复制到 release/头显端-WebXR打气球.apk
```

> 仓库内 `tools/cast-apk/build-apk.ps1` 可一键构建（自动探测 JDK / SDK / Gradle，失败信息明确）。但本环境 PowerShell 工具禁用 `cmd.exe`，推荐 Bash 直调 Gradle。

APK 工程要点：

| 项 | 值 / 位置 |
|---|---|
| 权限 | `INTERNET`、`ACCESS_NETWORK_STATE`、`CHANGE_WIFI_MULTICAST_STATE`（组播锁） |
| `application` | `android:usesCleartextTraffic="true"`（明文 HTTP 信令必需） |
| SDK | `compileSdk 34` / `buildToolsVersion '35.0.0'` / `minSdk 24` / `targetSdk 34` |
| 签名 | release 复用 `signingConfigs.debug`（本地验证用；**正式分发请换自己的 release 签名**） |
| 依赖 | `appcompat 1.6.1`、`material 1.11.0`、`browser 1.8.0`（Custom Tabs 兜底）、`nanohttpd 2.3.1` |
| 仓库 | 阿里云镜像 + 官方源（`dl.google.com` 不通时走镜像） |

### 10.4 打包边界（什么改动需要重打包）

| 改动位置 | 是否需重打包 | 说明 |
|---|---|---|
| 游戏 `src/**`、`index.html` | ❌ 不需要 | PC 的 `GAME_ROOT` 实时托管 + APK `proxyStatic` 实时取；PICO 刷新（必要时清缓存）即生效 |
| APK 内置资源 `assets/game/**` | ✅ 需重打 APK | 仅在「PC 未托管 / 未发现 PC」的本地游玩场景才用到，但为一致性建议同步 |
| `tools/cast-apk/**/*.java` | ✅ 需重打 APK | 例如改 `getCastUrl()` |
| `tools/cast-pc/**` | ✅ 需重打 EXE | 主进程/预加载/渲染进程代码都在 `app.asar` 内 |

---

## 十一、部署与验收

### 11.1 部署

1. 安装并启动 **PC 端 EXE** → 记下界面显示的**实际端口**（默认 8443，被占会自动 +1）。
2. 在 EXE 界面「游戏目录」处配置 `E:\AI_Work\WebXR_Begain`（含 `index.html` 才有效），保存并重启 EXE。
3. 安装并启动 **头显端 APK**。
4. APK 收到 UDP 信标 → 自动用 **PICO 浏览器**打开
   `http://localhost:8080/?cast=1&pc=<PC>:8443&mode=webrtc`，并把自身退到后台。
   （手动模式也可：**先开 APK**，再在 PICO 浏览器输入该地址 —— 不开 APK 会「拒绝连接」，这是预期行为。）
5. 点「进入 VR」。

### 11.2 验收判据

| 端 | 正常表现 |
|---|---|
| 头显日志 | `RTC: connected`；`预热链路已启动…`；`已开始游玩 → 启动推流`；`已切换到游戏画面（replaceTrack，链路未中断）` |
| 头显画面 | 预览/影片阶段**完全不闪**；影片能正常播放；进第 1 关后正常 |
| PC 日志 | `收到 WebRTC offer（推流端已发起协商）` → `已发出 answer` |
| PC 日志 | `收帧诊断 960×540 已解码=N 丢帧=M`，**N 持续增长** |
| PC 画面 | 预览阶段显示占位提示；影片阶段播本地影片；进关卡后是头显游戏画面（~20fps+），**连续流畅、非 5 秒一帧** |

**异常**：6 秒后头显日志出现 `WebRTC 未能连通（…），自动切换为 JPEG 兜底链路` → ICE 没通，见 §12。

---

## 十二、故障排查决策树

| 现象 | 最可能原因 | 动作 |
|---|---|---|
| 页面提示「桌面模式 需 https/头显」、无 VR 按钮 | origin 不是 localhost | 确认地址是 `http://localhost:8080/...` |
| `localhost 拒绝了我们的连接请求` | APK 没启动 | **先开 APK**，再打开页面（预期行为） |
| 游戏报 WebGL / `three.module.js` 错误 | 游戏跑进了 APK WebView | WebView 只应加载 `PROBE_HTML`，检查 `USE_INNER_WEBVIEW` 与 `setupGameWebView()` |
| 信令一直重连、PC 端无任何请求日志 | PNA 被拦截 / 防火墙 | 确认 `applyCors()`、`handleEvents`、`OPTIONS` 三处都带 `Access-Control-Allow-Private-Network: true`；检查 PC 防火墙放行 8443 |
| PC 看到「推流端在线」但不出画 | ICE 卡 `connecting` | 检查 mDNS 开关；两端是否同网段；看候选是否被混淆成 `.local` |
| 6 秒后提示「自动切换为 JPEG 兜底」 | WebRTC 未连通 | 兜底只能保底出画（~0.2fps）。修 ICE，别指望 JPEG |
| 出画但 5~6 秒一帧 | 还在 JPEG 软编码 | 确认 URL 带 `&mode=webrtc` 且 `CAST.TRANSPORT === 'webrtc'`；PICO 清缓存后重试 |
| 已 `connected` 但全程黑屏 | 编码器一帧都没产出（多为 `degradationPreference`） | 改 `?degrade=balanced`（已是默认）。看 PC 每 3s 的收帧诊断：N 恒 0 → 推流侧没出帧 |
| **预览/影片阶段头显闪、游玩正常** | ① 解码 × 编码争 VPU；② 第二个 GL 上下文存在本身干扰 | 默认 `PAUSE_BEFORE_PLAY=true` + `WARMUP=true` 已规避；对照 `?earlycast=1` 会复现 |
| 影片期间 PC 端黑屏 | 未配置游戏目录 → 取不到 `/assets/intro/intro.mp4` | 在 EXE 界面配置游戏目录并重启 |
| 画面糊 | 分辨率偏低或码率不足 | 先 `?bitrate=5000000`，再考虑 `?w=1280&h=720`（注意离屏渲染的 GPU 开销） |
| 改了 JS 没生效 | PICO 缓存 | 清 PICO 浏览器缓存后重开 |

---

## 十三、从零复现 Checklist

- [ ] PC 端：`cd tools/cast-pc && npm install && npm run dist` → 装 EXE
- [ ] 启动 EXE → 在界面配置游戏目录（项目根，含 `index.html`）→ 重启
- [ ] APK：`sync-assets.ps1` → `gradle assembleDebug` → 装 APK
- [ ] 确认头显与 PC 同网段；PC 防火墙放行 TCP 8443 与 UDP 8444
- [ ] 头显启动 APK → 确认自动跳转 PICO 浏览器，URL 形如
      `http://localhost:8080/?cast=1&pc=<PC>:8443&mode=webrtc`
- [ ] 点「进入 VR」→ 查头显日志 `RTC: connected`
- [ ] PC 端：预览阶段出占位画面 → 影片阶段播本地影片 → 进关卡切游戏画面
- [ ] 两端全程**不闪**、PC 画面连续流畅

---

## 附：关键文件速查（函数名优先，行号截至 2026-09-11）

| 文件 | 关键位置 |
|---|---|
| `src/core/constants.js` | `CAST` 块；`WAITING_ROOM` 块（`VIDEO_URL` / `WATCHDOG_MS`） |
| `src/net/cast.js` | `createCast()`、`_shouldPause()`、`_startWarmup()`、`_drawPlaceholder()`、`_swapToOffscreen()`、`_ensureOffscreen()`、`_startPush()`、`_fallbackToJpeg()`、`_autoScale()`、`notifyIntro()`、`update()` |
| `src/net/signaling.js` | `defaultSignalBase()`（读 `?pc=`）、`send()`、`sendBlob()`、退避重连 |
| `src/net/push-webrtc.js` | `iceServers: []`、`start()` 发 offer、`replaceTrack()`、`_tuneBitrate()`（`degradationPreference`） |
| `src/game/waitingRoom.js` | 构造时置 `scene.userData.castIntro`；`start()` 发 `notifyIntro('play')`；`dispose()` 先发 `'end'` 再删 `castIntro`；注册 `castVideoSwap` |
| `src/main.js` | `createCast({ world, game })`；主循环里在 `world.render()` 之后调 `cast.update()` |
| `tools/cast-pc/main.js` | mDNS 开关、`applyCors()`、`handleEvents()`、`handleSignal()`、`handleFramePost()`、`handleStatic()`、`resolveGameRoot()`、`startBeacon()`、`tryListen()` |
| `tools/cast-pc/preload.js` | `castCfg.get/set`、`onFrame`（IPC 帧通道） |
| `tools/cast-pc/renderer/renderer.js` | `setPure()`、`updateHint()`、`startIntro()/stopIntro()`、`ensurePc()`、`showVideo()`、`startVideoWatchdog()`、`onOffer()`、`resetPc()` |
| `tools/cast-pc/renderer/index.html` | `#video` / `#img` / `#intro` / `#hint` / `#logbox`；`body.pure` 规则 |
| `tools/cast-apk/.../MainActivity.java` | `USE_INNER_WEBVIEW`、`GAME_URL`、`maybeLaunch()`、`getCastUrl()`、`openInPicoBrowser()`、`stopInnerWebView()`、`readBody` 相关注释 |
| `tools/cast-apk/.../GameServer.java` | `serve()`、`proxyApi()`（Piped 泵）、`forwardFrameAsync()`、`proxyStatic()`、`readBody()` |
| `tools/cast-apk/.../Discovery.java` | `DISCOVERY_PORT = 8444`、`GROUP = 224.0.0.100`、`WEBXR-CAST:` 前缀 |
| `tools/cast-apk/build-apk.ps1` / `sync-assets.ps1` | 一键构建 / 资源同步 |


---

# 附录 A · 2026-09-23 平台对接实现记录

> 本轮把《打包和平台对接》的 3/4/5/6/7 条落地，并补上**音频推流**。
> 代码位置与判据逐条如下（**不要各写一套判据**——本项目历史上「两处判据漂移」
> 造成过「APK 放行了、页面却拒绝」的现场事故）。

## A.1 主控门禁「允许运行」（文档第 3 条）

**唯一判据出口**：`tools/cast-pc/main.js` 的 `masterAllow(ip, body)`。

| 环节 | 位置 | 说明 |
|---|---|---|
| 端点 | PC `POST /api/master/allow` | 入参 `{device|dev, ts, sig}`（APK）或 `{device|dev, exp, voucher}`（页面）；可选 `room` |
| 返回 | `{allow, reason, voucher, ttl, session, room, license}` | `license` 为摘要，为后续「授权即门禁」预留 |
| APK 侧 | `MainActivity.probeExeAuthority` → 解析 `voucher/exp` 存静态字段 | 随网址交给游戏页 |
| APK 提示页 | `MainActivity.guardDenyMasterGate` | 「需要主控端启动」+ 已探测到的 PC 地址 + **重试**按钮（`recreate()`） |
| 页面侧 | `src/main.js` `gateQueryMaster()` | 同源 `POST /api/master/allow`（APK GameServer 的 `proxyApi` 转发到 PC） |

**判据顺序**（`masterAllow` 内，即优先级）：
① `licenseGate()`（EXE 自己授权不合法 → 一律拒，连凭据都不看）；
② 凭据：`dev+ts+sig`（HMAC，APK 用）**或** `dev+exp+voucher`（放行条，页面用）；
③ 白名单命中 / 配对窗口自动登记。

**页面侧为什么要分两步**（`masterGateAllowed()`）：
- 本页拿到放行条 → **独立**问 PC 要 allow（最强证据，防「绕过 APK 直接开页面」）；
- 本页没有放行条（APK 尚未拼这组参数）→ 退回 **APK 的结论** `/api/guard`。
  这**不是漏洞**：`maybeLaunch` 里 `sGuardPassed` 是硬前置，APK 只有在 PC 回 allow 之后才拉得起浏览器
  ⇒ 这正是同一条判据的传递。绕过 APK 时 `/api/guard` 拿不到结论（fail-closed）⇒ 仍然进不去。

**开关**：编译时常量 `MASTER_GATE`（`src/core/constants.js`，正式包 `true` / 调试包 `false`）；
网址 `?gate=0` 旁路（**优先级最高**，现场应急不必重打包）、`?gate=1` 强制打开做对照。
**超时 5 秒**（`GATE_TIMEOUT_MS`，与 APK 的发现超时对齐）。
**不软锁**：传输失败**只记状态**——已放行的场次不因一次抖动被踢回来；界面常驻「重试」按钮。
**桌面豁免**：`vrMaster.exempt`（无 `immersive-vr` / 无 `navigator.xr`）—— 桌面预览不会「开出一局平台不知道的游戏」。

## A.2 EXE 被平台拉起（文档第 4 条）

- **修了一个真 bug**：原实现写死 `process.argv.slice(2)`。打包后 `process.argv = [<exe>, ...平台参数]`，
  这会把 `argv[1]`（**平台唯一用来传「平台本机 IP」的那个位置参数**）**吃掉**。
  现按 `app.isPackaged` 区分：打包 `slice(1)` / 开发 `slice(2)`。
- 解析平台实测格式 `"<exe 相对路径>$<进程名>$<平台本机 IP>"`（按 `$` 切分，少于 3 段当普通参数忽略）。
- 预留具名参数 `--room` / `--platform` / `--game`，**全部可选**；缺省行为与改造前完全一致。
- 参数落日志（`logPlatformArgs()`）+ 界面顶部显示（`#platargs`，走 IPC `platform:get`）+ `/api/info.platform`。
- `autoDetectGameRoot()` 候选目录已指向新主工程（`E:/AI_Work/WebXR_Begain_Platform` 等），
  历史路径保留为兜底。

## A.3 音频推流

- 头显 `src/vr/audio.js`：把 `unlock()` 拆成幂等的 `_ensureContext()` + `unlock()`，
  新增 `ensureCastAudioTrack()` —— 用 `ctx.createMediaStreamDestination()` 把 `this.master` 总线
  接成一条音轨（**干路**，不影响头显自己的扬声器）。
  先创建 AudioContext（允许在用户手势前创建，状态 `suspended`），
  等 `unlock()` 跑起来后声音自动流上**同一条**音轨 ⇒ **不需要 WebRTC 重协商**。
- `src/net/cast.js`：`createCast({world, game, audio})`；新增 `_attachAudio(stream)`（幂等），
  在 `new WebRtcPush` **之前**把音轨加进 stream；`update()` 里随视频一起开关 `audioTrack.enabled`。
- `src/net/push-webrtc.js`：构造时 `addTrack` 也加 `stream.getAudioTracks()`
  —— **必须在 `createOffer` 之前**，否则 offer 里没有 audio m-line。
- PC 端 `tools/cast-pc`：`app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')`
  对本进程放开自动播放；`renderer/#video` 去掉 `muted`，`showVideo()` 里检测到音轨即 `muted=false`。
  开场影片的 `introMuted` 默认由 `true` 改为 `false`（观众要听到影片声音；M 键仍可静音）。
- **沿用既有约束**：开场影片播放期间**既不推视频也不推音频**
  （`CAST.PAUSE_STATES = ['menu','waiting','intro']`，避开解码×编码争用 VPU）。

## A.4 开局信号与结束/上报（文档第 5/6/7 条）

- 第 5 条**维持现状**：`?plat=1`（APK/平台拉起本页）为开局信号，保留 30 秒无条件兜底。
  平台日后补发真「开始游戏」指令时，两条判据**并肩**自动生效。
- 第 6 条**我方兜底已具备**：`src/game/game.js` 的「平台关闭看门狗」`_onPlatformGone`
  （连败 4 次 ≈6s → 判死复核 2.5s → 收尾），菜单态也生效（比 `start()` 更早启动）。
- 第 7 条**本地留痕已具备**：`_endRound()` = `VRPlusGame.terminate()`（cmd 5）+ `_reportGameEnd()`；
  `_reportGameEnd` 写 `game-end` 事件（`reportEvent` → `/api/page/event` → APK `PageForensics`），
  带 5 秒去抖。**上行 CMD 6 `GameEnd` 的报文待平台方定义**（见《平台对接需求（对平台方）》）。
