# 双端直播架构 · 复现指南（WebXR 打气球 → PC 直播大屏）

> 面向后续接手的 AI / 开发者。
> 本文只记录 **2026-09-09 实测验证流畅** 的那一套形态，以及为什么其它路都走不通。
> **动手改之前，先读完「三、不可违反的硬约束」和「六、踩坑史」** —— 这两节能省下几天的无效调参。

---

## 一、TL;DR：唯一可用组合

头显端最终打开的 URL（由 APK 自动拼装，**不需要手输**）：

```
http://localhost:8080/?cast=1&pc=<PC局域网IP>:<PC端口>&mode=webrtc
```

三个要素缺一不可：

| 要素 | 值 | 少了会怎样 |
|---|---|---|
| **origin = localhost** | `http://localhost:8080` | 非安全上下文 → PICO 不暴露 `navigator.xr` → 没有「进入 VR」按钮，掉桌面模式 |
| **`?pc=<PC>:<port>`** | 信令直连 PC（默认 `192.168.x.x:8443`） | 信令改走 APK 的 NanoHTTPD 代理，长连接（SSE）易缓冲/易断 |
| **`&mode=webrtc`** | WebRTC **硬件 H.264** 编码 | 落到 JPEG → `canvas.toBlob` **CPU 软编码** → PICO 单帧 5~6 秒（这就是长期卡顿的真因） |

**核心认知：帧率瓶颈在「编码方式」，不在「传输路径」。**
WebRTC 走硬件编码器 → 实时；JPEG 走软编码 → 无论分辨率降到多低、链路怎么异步化，都是 ~0.2fps。

---

## 二、三个端与源码位置

| 端 | 目录 | 职责 |
|---|---|---|
| **头显游戏（推流端）** | `src/net/` | `cast.js`（门面/离屏采集）、`signaling.js`（SSE 信令）、`push-webrtc.js`（WebRTC 推流）、`push-jpeg.js`（JPEG 兜底） |
| **APK（头显本地服务 + 拉起）** | `tools/cast-apk/` | `MainActivity.java`（UI/拉起 PICO 浏览器）、`GameServer.java`（NanoHTTPD：托管+代理静态资源）、`Discovery.java`（UDP 组播发现 PC） |
| **PC 接收端（Electron）** | `tools/cast-pc/` | `main.js`（HTTP 服务 + 信令 + 组播信标 + IPC 推帧）、`renderer/renderer.js`（WebRTC 接收 / JPEG 显示）、`preload.js`（`window.castCfg`） |

### 三条独立的数据流

```
【静态资源】  PICO浏览器 ──► APK localhost:8080 ──┬─► APK 内置 assets/game
                                                 └─► 代理到 PC（proxyStatic，取 PC 上的最新代码）

【信令】      PICO浏览器 ──► http://<PC>:8443/api   （?pc= 直连，不经过 APK）
             · GET  /api/events?role=publisher   SSE 下行（peer-ready / answer / ice）
             · POST /api/signal                  上行（join / offer / ice）

【媒体流】    PICO浏览器 ══ WebRTC P2P（DTLS 加密，硬件 H.264）══► PC
             · 完全不经过 APK、不经过 HTTP 服务
             · ICE：iceServers 为空 → 只收集 host candidate，同网段直连
```

**静态资源为什么要代理到 PC**：PC 端托管的是 `E:\AI_Work\WebXR_Begain`（`main.js` 的 `GAME_ROOT`），改 JS 后 PICO 刷新即可生效，**免重打包**。这与推流帧率是两条线，互不影响。

---

## 三、不可违反的硬约束（改动前必读）

| # | 约束 | 代码位置 | 违反后果 |
|---|---|---|---|
| 1 | **页面 origin 必须是 `localhost`** | `MainActivity.java:45`（`GAME_URL`）、`:36` 注释 | `http://<PC IP>:8443` 不是安全上下文 → 无 `navigator.xr` → 无 VR 按钮 |
| 2 | **默认传输必须是 `webrtc`** | `constants.js:603` `CAST.TRANSPORT` | 改回 `jpeg` = CPU 软编码 → 5~6 秒一帧（**已验证，禁止回退**） |
| 3 | **信令必须带 `?pc=` 直连 PC** | `signaling.js:119-129` `defaultSignalBase()`；`MainActivity.java:286` | 走 APK 代理 → NanoHTTPD 对 SSE 长连接支持差，易缓冲/易断 |
| 4 | **PC 必须返回 PNA 响应头** | `main.js:232-238` `applyCors()`、`:248` `handleEvents`、`:391` OPTIONS | Chrome 私有网络访问(PNA) 在连接建立前就拦掉 → 服务端根本收不到请求（表现为「信令一直退避重连、无任何 REQ 日志」） |
| 5 | **APK 内嵌 WebView 不能跑游戏** | `MainActivity.java:183` 只 `loadDataWithBaseURL(PROBE_HTML)` | PICO 的 WebView 无 GPU → `new World()` 抛 `WebGL context could not be created` |
| 6 | **PC 端必须关掉 mDNS 混淆** | `main.js:25-26` `disable-features=WebRtcHideLocalIpsWithMdns` + `force-webrtc-ip-handling-policy=default` | ICE 候选变成 `xxx.local` → 对端不可达 → 卡在 `connecting` |
| 7 | **WebRTC 不配 STUN** | `push-webrtc.js:25` `iceServers: []` | 引入 srflx 候选，家用路由通常不支持 NAT 回环 → 反而连不上 |

**PICO 两条平台硬限制**（无法绕过，只能绕开）：
- 不信任自签证书，且**没有「继续访问」入口** → 不能 `https://<PC>` 直连。
- 非 `localhost` 一律不是安全上下文 → 不能把游戏页放到局域网 IP 上。
- 这两条叠加，决定了「页面必须在 localhost、信令/媒体必须跨域直连 PC」这个唯一形态。

---

## 四、参数与实时调参

### URL 参数（无需重打包，刷新即生效）

| 参数 | 作用 | 默认 |
|---|---|---|
| `cast=1` | **必需**，不写则整个推流不初始化（`createCast` 返回空实现） | — |
| `pc=IP:PORT` | 信令直连 PC 地址 | 不写 → 同源 `/api` |
| `mode=` | `webrtc` \| `jpeg` | `CAST.TRANSPORT` = `webrtc` |
| `w=` / `h=` | 观众画面分辨率 | 960 / 540 |
| `q=` | JPEG 质量（仅兜底模式有效） | 0.6 |
| `fps=` | 推流帧率 | 24 |
| `bitrate=` | WebRTC 最大码率 bps（嫌糊就加大） | 3000000 |
| `degrade=` | 编码器压力策略：`balanced`（**默认，实测稳定出帧**）\| `maintain-framerate`（保帧率，会降分辨率变糊）\| `maintain-resolution`（⚠ PICO 上一帧都不出 → PC 端黑屏，勿用） | balanced |
| `vmode=` | 开场影片取帧方式：`hide`（**默认**）\| `raw`（会闪，对照用）\| `mirror`（PICO 取不到帧，暂不可用） | hide |
| `mw=` | mirror 中转 canvas 宽度（仅 mirror 模式有效） | 640 |
| `pdb=` | `1` 强制开启 `preserveDrawingBuffer`（**排查头显闪烁时对照用**，默认关） | 0 |
| `thumb=` | `1` 显示右下角 240×135 缩略图（默认关：省一次页面合成） | 0 |
| `amb=` | `0` 直播画面不画天空球（纯色背景，最省 GPU） | 1 |
| `noscale=` | `1` 关闭「离屏渲染过慢自动降分辨率」 | 0 |
| `earlycast=` | `1` 关闭「游玩前不推流」（**对照用**：预览/影片阶段就开推，会复现闪烁） | 0 |
| `warmup=` | `0` 关闭「2D 占位画面预热链路」（**对照用**：PC 端会黑屏等待到进关卡） | 1 |

### `CAST` 常量块（`src/core/constants.js:597` 起）

| 键 | 值 | 说明 |
|---|---|---|
| `W` / `H` | 960 / 540 | 离屏 canvas 尺寸。硬件编码下「编码」不吃分辨率，但**离屏重渲染吃 PICO GPU**；卡就 `?w=854&h=480` 退回（该分辨率已实测流畅出画） |
| `FPS` | 24 | 节流用：`update()` 按 `1000/fps` 间隔跳过 XR 帧 |
| `MAX_BITRATE` | 3000000 | WebRTC 最大码率 bps。**1.2Mbps 是 480p 时期的配置，720p 下会糊/马赛克**；仍糊可 `?bitrate=5000000` |
| `DEGRADE` | `balanced` | 编码器压力策略（`degradationPreference`）。<br>⚠ **禁止改 `maintain-resolution`**：PICO 硬件编码器在该策略下**一帧都不产出** → PC 端「已 connected 但全程黑屏」（2026-09-09 实测）。`maintain-framerate` 会自动降分辨率 → 变糊 |
| `VIDEO_MODE` | mirror | 开场影片取帧方式，**勿改 raw**（会闪），见上节 |
| `MIRROR_W` | 640 | mirror 中转 canvas 宽度（高度按视频宽高比）。主视角也用它 |
| `SHOW_AMBIENT` | true | 直播画面把 `world.sky` **临时挂到 scene 根**渲染一帧（渲染后挂回），避免等待房间期间 PC 端黑屏。注意**不是** `ambient.visible=true`，原因见下节 |
| `TRANSPORT` | `'webrtc'` | **不要改回 `jpeg`** |
| `JPEG_QUALITY` | 0.6 | 仅兜底链路使用 |
| `HIDE_PANO` | true | 观众渲染不画全景穹顶：6K/8K 纹理进第二个 GL 上下文要上百 MB 显存 |
| `THUMB` | `false` | 页面右下角 240×135 缩略图（调试用 `?thumb=1` 开）。默认关：可见 canvas 每帧多一次页面合成，白给 PICO 加负担 |
| `PAUSE_BEFORE_PLAY` | `true` | 游玩前（`menu`/`waiting`）不推流，见第四节第三层根因 |
| `PAUSE_STATES` | `['menu','waiting']` | 需暂停的 `game.state`；抽卡/结束画面仍要直播，故不列入 |
| `WARMUP` / `WARMUP_FPS` | `true` / `1` | 2D 占位预热链路，见第四节第四层根因 |
| `SLOW_MS` | 7 | 离屏单帧均耗时上限，连续两轮超标自动降档（`_autoScale`） |

> 这些键可被 `src/core/userConfig.js` 的 `USER_CONFIG.CAST` 覆盖（当前未覆盖）。

### 开场影片（等待房间）与「画面一闪一闪 / PC 端黑屏」

**现象**：等待房间（= 开始游戏前那个「黑底 + 视频屏」的阶段）播放开场影片时，头显和/或 PC 端画面一闪一闪；**影片放完进入正式游玩后立刻不闪**。

> 阶段界定：`game.start(0)` → `_enterWaitingRoom()`（`state='waiting'`，`world.setAmbientVisible(false)` 让背景纯黑、仅留视频屏）→ 影片结束 → `_exitWaitingRoom()` → 第 1 关。**预览界面 / 影片闪烁 / 黑屏其实是同一个阶段**，不要当成三个问题分别修。

**根因（分两层，别混为一谈）**

**第一层 — `<video>` 有两个消费者抢帧（导致 PC 端闪/黑屏）**：直播用的是**第二个 WebGL 上下文**（离屏 renderer）。只要同时存在两个取帧方，就会争用同一份解码输出缓冲：

| 取帧组合 | 后果 |
|---|---|
| 两个 GL 上下文各传一次 `VideoTexture` | 离屏侧交替拿到已释放缓冲 → **PC 端**一闪一闪（头显正常） |
| `drawImage`（离屏镜像）+ `VideoTexture`（主视角） | 互抢当前帧 → **头显里也闪**，且离屏常被抢空 → **PC 端黑屏** |
| `drawImage` 唯一消费者、主视角也用同一张 `CanvasTexture` | 理论最优，但 **PICO 实测取不到帧 → 头显里影片全黑、只剩声音**（2026-09-09） |

→ 解法：`VIDEO_MODE='hide'`（默认）—— 主视角用 `VideoTexture`（唯一消费者），离屏渲染前把视频屏换成纯黑材质、`finally` 还原。**这层只解释 PC 端闪**。

**第二层 — 视频解码 × H.264 编码争用媒体引擎（导致头显里闪）**：改成 `hide` 后 PC 端不闪了，但**头显里影片仍然一直闪，影片放完立刻不闪**。三个条件的交叉实测：

| 条件 | 视频解码 | H.264 编码 | 头显闪？ |
|---|---|---|---|
| 开直播 + 影片阶段 | ✅ | ✅ | **闪** |
| 开直播 + 游玩阶段 | ❌ | ✅ | 不闪 |
| 不开直播（`?cast=1` 去掉）+ 影片阶段 | ✅ | ❌ | 不闪 |

→ 只有「解码 × 编码」同时存在才闪：二者争用 PICO 上同一个媒体硬件块（VPU），解码输出被编码抢占。**降分辨率 / 降帧率 / 关 `preserveDrawingBuffer` 全部无效**——那些动的是 GPU 侧开销，而瓶颈在媒体引擎。

→ 解法：影片期间**不编码、也不做离屏渲染**。

**第三层 — 第二个 WebGL 上下文存在本身也在干扰（导致预览界面闪）**

实测（2026-09-09 22:15，暂停推流已生效的前提下）：

| 阶段 | 头显 | PC 端 |
|---|---|---|
| 预览菜单 / 等待房间（未播影片） | **1 秒闪 2 次** | 画面静止 |
| 影片播放中 | 约 5 秒黑屏一次 | 黑屏、约 1fps |
| 第 1 关游玩 | 正常 | 正常（~20fps） |

PC 端画面静止证明「确实没在编码」，可头显**照闪** → 干扰不止来自编码。**只要第二个 WebGL 上下文存在**（哪怕不渲染、不抓帧），PICO 的画面就会被干扰。

→ 解法：`CAST.PAUSE_BEFORE_PLAY = true`（默认）—— 在 `game.state` 属于 `CAST.PAUSE_STATES`（`['menu','waiting']`）时：

1. **根本不创建**离屏 canvas / renderer / captureStream（`_ensureOffscreen()` 延迟到进关卡才调）；
2. 已建过的（如中途退回菜单）用 `track.enabled = false` 停帧 —— Chrome 会发黑帧维持 RTP，连接不断、几乎不占编码器；
3. 进入游玩（`playing`/`card`/`over`）时自动创建并启动，打日志「已开始游玩 → 启动推流」。
4. 代价：预览与影片阶段 PC 大屏无画面（本来 `hide` 也是黑的，无额外损失）。

**第四层 — 不推流 ≠ PC 端要黑着：「2D 占位画面」预热链路（2026-09-09 晚）**

第三层方案生效后头显**完全不闪了**，但暴露出新问题：PC 端在预览与影片期间**一直黑屏、且没有任何提示**，直到影片放完进第 1 关才突然出画（用户反馈：不知道是没连上还是在等待）。

难点在于两难：建真实链路 → 必然要建离屏 renderer（第二个 GL 上下文）→ 头显又闪；不建 → PC 端黑着。

→ 解法：**用一张普通 2D canvas 建链路**（`CAST.WARMUP=true`，默认开）：

| | 占位阶段（预览/影片） | 游玩阶段 |
|---|---|---|
| 画面来源 | 2D canvas（黑底 +「已连接 / 等待头显开始游戏…」文字） | 离屏 WebGL renderer |
| WebGL 上下文 | **无**（零干扰 → 头显不闪） | 1 个（离屏） |
| 帧率 | `CAST.WARMUP_FPS = 1`（只为维持出画与编码器存活，几乎不占 VPU） | `CAST.FPS = 24` |
| 切换方式 | — | `RTCRtpSender.replaceTrack()` **原地换轨道，不重连** |

关键点：

1. 占位 canvas 尺寸与离屏 canvas **同为 `W×H`** → 编码器无需重新初始化，PC 端切换几乎无感；
2. 占位帧率刻意压到 1fps：第二层根因（影片解码 × 编码争 VPU）仍在，帧率越高争用风险越大；
3. `replaceTrack` 失败或内核不支持时，先给 PC 端发 `peer-left` 让其 `resetPc()`，600ms 后重建链路（旧 pc 已 connected，直接发新 offer 会被拒）；
4. JPEG 兜底模式下不做预热（软编码太贵），且**暂停阶段降级 JPEG 时不重建离屏 renderer**（那会立刻引入 GL 上下文 → 头显又闪），改为继续推占位 2D canvas（2D 画布 `toBlob` 不需要 `preserveDrawingBuffer`）。

### 开场影片：PC 端本地同步播放（不推流也能看片）

头显播影片时**不能编码**（第二层根因：解码 × 编码争 VPU），所以 PC 大屏注定收不到那几十秒画面。
既然推不了，就让 PC 端**自己播同一段影片**——本地文件、无网络、无编码，观感上是连续的一条视频。

**时序**：

```
头显 waitingRoom.start()  ──signaling {type:'intro',stage:'play',src}──▶  PC 端 startIntro() 播本地影片
      （头显不推流、不编码；只推 1fps 2D 占位画面，被影片层遮住）
头显 影片结束 → dispose() ──signaling {type:'intro',stage:'end'}──────▶  PC 端 400ms 后 stopIntro()
      └─ 删除 castIntro → cast 建离屏 renderer → replaceTrack 出游戏画面        └─ 露出推流画面（游戏画面）
```

**要点**

1. **影片从哪来**：EXE 托管游戏目录时，`serveRoot = GAME_ROOT`（`main.js:374`），接收端页面与之同源
   → 直接 `GET /assets/intro/intro.mp4` 即可（路径由头显在信令里带过来，不写死）。
   未托管游戏目录时会 404 → 自动收起影片层并打告警，退回占位画面，**不会卡住**。
2. **对齐**：以**头显为准**。头显影片一结束立即恢复推流；PC 端若本地影片还没播完就被切（正常情况），
   若本地先播完则停在末帧并显示「等待头显影片结束」，1.2s 后仍未收到结束通知则自动切回。
3. **三重兜底**（防止影片层永久遮挡游戏画面）：① 收到 `end` 信令；② 本地 `ended` 后 1.2s；
   ③ `loadedmetadata` 后按 `duration + 5s` 硬收起。信令丢失也不会一直挡着。
4. **声音默认静音**（`M` 键切换）：两端声音必然不同步，会互相干扰。
5. 头显侧在 `onReady` 时会补发一次 `play`（PC 端晚开也不会错过整段影片）。

`?warmup=0` 可关闭（退回纯黑等待，用于对照排查）。

**最终形态**：`VIDEO_MODE='hide'` + `PAUSE_BEFORE_PLAY=true` + `WARMUP=true` + 影片本地同步播放
—— 预览阶段 PC 显示「已连接，等待开始游戏」；影片阶段 PC 播本地影片；进入第 1 关自动换成头显游戏画面。

> 判定用的是 `game.state`（`game.js`：`'menu'` / `'waiting'` / `'playing'` / `'card'` / `'over'`），由 `main.js` 把 `game` 传给 `createCast({ world, game })`。抽卡与结束画面仍要直播给大屏看，故不列入暂停状态。

**关键判据**：「影片结束后正式游玩**不闪**」→ 闪烁只发生在影片阶段 → 不要再去调分辨率/帧率/PDB。

**失败的尝试（别再走一遍）**
- mirror 共用 CanvasTexture：PICO 上取不到帧（黑屏）；加过「2.5 秒取不到帧自动回退 VideoTexture」的自愈也救不回。
- 降 `CAST.W/H`（1280→960→854）、降 `fps`、`preserveDrawingBuffer` 开关：三条对「解码×编码」争用完全无效果（用户实测闪烁频率无变化）。

**另一个独立成因（PC 端黑屏）**：等待房间期间 `world.ambient` 被整体隐藏，而 `world.sky` 挂在该组下（`world.js:92`）。three.js 中**父组不可见 → 子节点一律不渲染**，所以只设 `grad.visible = true` 无效。`CAST.SHOW_AMBIENT = true`（默认）时，`cast.js` 会把 `sky` **临时 reparent 到 scene 根**，渲染后 `finally` 挂回。
⚠ **不要改成 `ambient.visible = true`**：组内还有 3 层星空 + 边界盒 + 几百个坐标标注 Sprite（各自独立 CanvasTexture），全进第二个 GL 上下文会吃光 GPU → 头显闪。

| `?vmode=` | 主视角取帧 | 直播画面 | 何时用 |
|---|---|---|---|
| `hide`（**默认**） | `VideoTexture` | 影片期间纯黑 | 正常用：头显内影片正常，两端都不闪 |
| `raw` | `VideoTexture` | 也画视频屏 | **仅作对照**：会复现闪烁 |
| `mirror` | 共用中转 canvas | 共用 CanvasTexture | 换设备时可再试（PICO 上会黑屏） |

### PC 端界面：纯净模式（只保留游戏画面）

| 操作 | 效果 |
|---|---|
| 按 **H** | 切换「纯净模式」：隐藏地址栏 / 游戏目录配置 / 日志区，**只剩游戏画面铺满窗口**。状态存 `localStorage`（键 `castPure`），下次启动保持 |
| 按 **F** | 切换全屏（HTML5 Fullscreen） |
| 启动参数 `--pure` | 启动即进入纯净模式（可写进 EXE 快捷方式） |
| 启动参数 `--fullscreen` | 启动即全屏；与 `--pure` 组合 = 开机即大屏 |

实现位置：`renderer/index.html` 的 `body.pure` 规则；`renderer/renderer.js:25-58`（`setPure` / `toast` / 快捷键监听；纯净模式下 `log()` 跳过 DOM 写入）；`main.js:489-491`（`?pure=1` 透传 + `setFullScreen`）。

### APK 端：只打开一个网页

`MainActivity.java` 的 `USE_INNER_WEBVIEW = false`（默认）：

- **不显示**应用内 WebView 的探测页 → 玩家全程只看到 **PICO 浏览器里的那一个游戏页**（旧行为会「先跳一个空白探测页，识别 PC 后再跳游戏页」）。
- 拉起时机：发现 PC → 立刻拉起（URL 带 `&pc=`）；未发现 → 8s 超时后拉起（仅本地游玩）。`maybeLaunch()` 有 `autoLaunched` 守卫，**只会拉起一次**。
- 拉起成功后 `moveTaskToBack(true)` 把 APK 退到后台；**APK 进程必须继续存活**（`GameServer` 要持续提供 `localhost:8080` 的游戏资源与代理）。
- 置为 `true` 可恢复旧行为（内嵌 WebView 先跑探测页，仅在它确实支持 WebXR 时才在应用内跑游戏，此时 `inAppPlaying=true`，不再拉外部浏览器）。

---

## 五、从零复现步骤

### 5.1 环境

- JDK 17（`C:/Program Files/Java/jdk-17`）
- Android SDK：`tools/cast-apk/local.properties` → `sdk.dir=C:/Users/x/AppData/Local/Android/Sdk`
- Gradle：优先用 `C:/Users/x/.gradle/wrapper/dists/` 里已缓存的发行版（8.14.3），避免 `gradlew` 联网下载
- Node.js + npm（PC 端打包用）
- 同一局域网；头显与 PC 之间 UDP 8444（组播发现）与 TCP 8443（信令）可达

### 5.2 构建 PC 端 EXE

```bash
cd tools/cast-pc
npm install
npx electron-builder --win --x64
# 产物在 tools/cast-pc/dist/，手动复制到 release/PC端-直播接收端-Setup.exe
```

`main.js` 启动时：托管 `GAME_ROOT`（自动解析为项目根）→ 起 HTTP 服务（端口 8443，被占自动 +1，最多试 10 次）→ UDP 组播发信标广播**实际监听端口**。

### 5.3 构建 APK

```bash
D="E:/AI_Work/WebXR_Begain"

# 1) 同步最新游戏源码到 APK 内置资源（改了 src/ 就必须同步）
cp -r "$D/src/." "$D/tools/cast-apk/app/src/main/assets/game/src/"
cp "$D/index.html" "$D/tools/cast-apk/app/src/main/assets/game/index.html"

# 2) 构建（注意：必须关闭沙盒，否则 ~/.gradle 写缓存会被拒绝）
cd "$D/tools/cast-apk"
JAVA_HOME="C:/Program Files/Java/jdk-17" \
ANDROID_SDK_ROOT="C:/Users/x/AppData/Local/Android/Sdk" \
ANDROID_HOME="C:/Users/x/AppData/Local/Android/Sdk" \
  "C:/Users/x/.gradle/wrapper/dists/gradle-8.14.3-all/<hash>/gradle-8.14.3/bin/gradle" assembleDebug

# 3) 产物
#    app/build/outputs/apk/debug/app-debug.apk → release/头显端-WebXR打气球.apk
```

> 仓库内 `tools/cast-apk/build-apk.ps1` 也能构建（自动探测 JDK/SDK/Gradle），但本环境 PowerShell 工具禁用 `cmd.exe`，推荐用上面的 Bash 直调 Gradle。

### 5.4 运行与验收

1. 启动 PC 接收端 EXE → 记下界面显示的**实际端口**（默认 8443）。
2. 启动 APK（它会起 `localhost:8080` 并监听 UDP 8444 信标）。
3. APK 发现 PC 后自动拉起 PICO 浏览器打开 `getCastUrl()` 拼好的地址
   （或在 PICO 浏览器手动输入该地址 —— **必须先开 APK**，否则 `localhost:8080` 拒绝连接，这是预期行为）。
4. 点「进入 VR」。

**验收判据（正常）**：

- PC 控制台：`收到 WebRTC offer` → `已发送 answer`
- 头显日志：`RTC: connected`
- PC 画面**连续流畅**（不是 5 秒一帧）
- PC 端 JPEG 计数不增长（`renderer.js:179` 的 `if (usingVideo) return` 让 JPEG 帧让位给视频）

**异常**：6 秒后头显日志出现 `WebRTC 未能连通，自动切换为 JPEG 兜底链路` → ICE 没通，见第七节。

---

## 六、踩坑史（**别再走一遍**）

| 时间 | 尝试 | 结果 | 结论 |
|---|---|---|---|
| 8/31 | WebRTC + `?pc=` 直连 | ✅ 流畅 | 这就是最初可用的形态 |
| 之后 | 把游戏塞进 APK 内嵌 WebView | ❌ `WebGL context could not be created` | WebView 无 GPU → 改成只跑探测页 |
| 之后 | PICO 直接开 `http://<PC>:8443` | ❌ 无「进入 VR」按钮 | 非安全上下文 → 必须 localhost |
| 之后 | 上 HTTPS 自签证书直连 | ❌「无法提供安全连接」 | PICO 不信任自签且无跳过入口 |
| 之后 | 引入 APK 同源代理，`/api` 一并代理 | ❌ 5 秒一帧 | 当时误判为「转发慢」 |
| 之后 | WebRTC 连不上 → 默认改 `TRANSPORT:'jpeg'` | ⚠️ **致命转折点** | 从此走上软编码死路，之后所有优化全无效 |
| 之后 | SSE 被 NanoHTTPD 缓冲 → PipedStream 边读边 flush | 无效 | 信令通了，帧率没救 |
| 之后 | `sendBlob` fire-and-forget + APK 后台线程转发 | 无效 | 去掉 RTT 阻塞不是瓶颈 |
| 之后 | PC 端删轮询，改 IPC 推帧 | 无效 | 同上，PC 侧不是瓶颈 |
| 之后 | 降分辨率 1280×720 → 854×480 | 无效 | 软编码下分辨率不是主因 |
| 之后 | 2D 中转画布（先 `drawImage` 再 `toBlob`）避 GL 停顿 | 无效 | 仍是 CPU 软编码 |
| **9/09** | 加 `&mode=webrtc` | ✅ **流畅** | **真因 = 编码方式** |

**教训**：优化前先确认走的是硬件编码路径。给一条天生跑不快的路做参数调优，做 6 次也是 0。

---

## 七、故障排查决策树

| 现象 | 最可能原因 | 动作 |
|---|---|---|
| 页面提示「桌面模式 需 https/头显」、无 VR 按钮 | origin 不是 localhost | 确认地址是 `http://localhost:8080/...` |
| `localhost 拒绝了我们的连接请求` | APK 没启动 | **先开 APK**，再打开页面（预期行为） |
| 游戏报 WebGL / `three.module.js` 错误 | 游戏跑进了 APK WebView | WebView 只应加载 `PROBE_HTML`，检查 `MainActivity.java:183` |
| 信令一直重连、PC 端无任何请求日志 | PNA 被拦截 / 防火墙 | 确认 `main.js:232/248/391` 的 `Access-Control-Allow-Private-Network: true` 都在；检查 PC 防火墙放行 8443 |
| PC 看到「推流端在线」但不出画 | ICE 卡 `connecting` | 检查 `main.js:25-26` mDNS 开关；两端是否同网段；看候选是否被混淆成 `.local` |
| 6 秒后提示「自动切换为 JPEG 兜底」 | WebRTC 未连通 | 兜底只会保底出画（~0.2fps）。修 ICE，别指望 JPEG |
| 出画但 5~6 秒一帧 | **还在 JPEG 软编码** | 确认 URL 带 `&mode=webrtc`、且 `CAST.TRANSPORT==='webrtc'`；PICO 清缓存后重试 |
| **已 `connected` 但全程黑屏（连等待房间也没画面）** | 编码器一帧都没产出：多为 `degradationPreference` 设了 `maintain-resolution` | 改 `?degrade=balanced`（已设为默认）。看 PC 端每 3 秒的「收帧诊断 WxH 已解码=N」：N 一直 0 → 推流侧没出帧；8 秒后会自动放开 `usingVideo` 让 JPEG 兜底接管并打红色告警 |
| 画面糊 | 分辨率偏低或码率不足 | 默认 960×540 + 3Mbps；先 `?bitrate=5000000`，再考虑 `?w=1280&h=720`（注意离屏渲染的 GPU 开销） |
| **预览/影片阶段头显闪、游玩正常** | ① 解码 × 编码争用 VPU；② 第二个 GL 上下文存在本身干扰 | 默认 `PAUSE_BEFORE_PLAY=true` 已规避（这两个阶段根本不建离屏上下文/不编码）；对照 `?earlycast=1` 会复现 |
| 头显预览/游戏中闪（去掉 `?cast=1` 不闪） | 离屏渲染开销挤占 PICO GPU | 按序下调（每档都无需重打包）：`?pdb=1` 做对照 → `?w=854&h=480` → `?fps=15`；看头显日志「离屏渲染均耗时 xx ms/帧」 |
| 影片/等待房间闪或黑屏 | `<video>` 有多个消费者抢帧，或 `ambient` 父组不可见 | 默认 `VIDEO_MODE='hide'`（主视角 VideoTexture 单消费者 + 直播画面纯黑）+ `SHOW_AMBIENT=true` 已规避；排查用 `?vmode=raw` 复现 |
| 改了 JS 没生效 | PICO 缓存 | 清 PICO 浏览器缓存后重开 |

---

## 八、打包边界（什么改动需要重打包）

| 改动位置 | 是否需要重打包 | 说明 |
|---|---|---|
| 游戏 `src/**`、`index.html` | ❌ 不需要 | 由 PC 的 `GAME_ROOT` 实时托管、APK `proxyStatic` 实时取；PICO 刷新（必要时清缓存）即生效 |
| APK 内置资源 `assets/game/**` | ✅ 需重打 APK | 仅在 PC 未托管/未发现 PC 时才会用到，但为一致性建议同步 |
| `tools/cast-apk/**/*.java` | ✅ 需重打 APK | 例如改 `getCastUrl()` |
| `tools/cast-pc/**` | ✅ 需重打 EXE | Electron 主进程/渲染进程代码在 `app.asar` 内 |

---

## 九、已知限制与后续方向

- **JPEG 兜底实际不可用**：软编码 ~0.2fps，只能证明链路通、保底出画；不要把它当可玩链路。
- **APK 只拉起一次**（`autoLaunched` 守卫），避免双实例抢信令；需要重开请退出 APK 再进。
- **`?pc=` 依赖手工/自动发现的端口**：PC 端口被占会自动 +1，信标广播的是**实际端口**，头显侧以 PC 界面显示为准。
- 后续若要做多路观众 / 录制，优先沿 WebRTC 路径扩展（SFU 或 PC 端转发 RTP），不要回头走 JPEG。

---

## 附：关键文件速查

| 文件 | 关键位置 |
|---|---|
| `src/core/constants.js` | `:597` `CAST` 块；`:603` `TRANSPORT: 'webrtc'` |
| `src/net/cast.js` | `:61` mode 解析；`:137` `_startPush`；`:174` 6s 降级定时器；`:182` `_fallbackToJpeg`；`:207` `update()` 采集 |
| `src/net/signaling.js` | `:105` `sendBlob`（fire-and-forget）；`:119` `defaultSignalBase()` 读 `?pc=` |
| `src/net/push-webrtc.js` | `:25` `iceServers: []`；`:45` `start()` 发 offer；`:74` `_tuneBitrate()` |
| `tools/cast-pc/main.js` | `:25-26` mDNS 开关；`:232` `applyCors`；`:301` `handleFramePost`；`:386` HTTP 服务 |
| `tools/cast-pc/renderer/renderer.js` | `:25-58` 纯净模式与快捷键；`:81` `RTCPeerConnection`；`:115` `usingVideo=true`；`:132` `createAnswer`；`:179` JPEG 让位 |
| `tools/cast-pc/renderer/index.html` | `body.pure` 隐藏面板规则；`#video,#img` `object-fit:cover` 铺满 |
| `tools/cast-apk/.../MainActivity.java` | `:47-63` `USE_INNER_WEBVIEW`（默认 false，只开一个网页）；`:45` `GAME_URL`；`:183` 只跑 `PROBE_HTML`；`:256` `maybeLaunch()`；`:281-287` `getCastUrl()` |
| `tools/cast-apk/.../Discovery.java` | `:19` `DISCOVERY_PORT = 8444` |


---

# 附录 · 2026-09-23 平台对接新增部分

## 新增 HTTP 端点：`POST /api/master/allow`（PC 接收端）

门禁「允许运行」的**唯一查询入口**，APK 与游戏页面共用（与 `/api/launch/request` 同一套判定）。

```
请求（二选一）：
  APK ：{"device":"<ANDROID_ID>","ts":<毫秒>,"sig":"<hex>","room":"<房间号，可选>"}
  页面：{"device":"<ANDROID_ID>","exp":<毫秒>,"voucher":"<hex>","room":"…"}

响应：
  { "allow": true|false,
    "reason": "<拒绝/放行的原因，直接可读>",
    "voucher": "<hex>|null", "ttl": 60,
    "session": "<本局局号>", "room": "<房间号>|null",
    "license": { "ok":.., "mode":.., "why":.., "daysLeft":.. } }
```

判定顺序（`masterAllow()`）：**① 本机授权 `licenseGate()` → ② 凭据（HMAC 或放行条）→ ③ 白名单 / 配对窗口**。

- **放行条** `voucher = HMAC-SHA256(secret, dev + "|" + exp)`，TTL 60s。
  它存在的理由：游戏页面跑在**头显浏览器**里，没有 secret、算不出 HMAC，
  但它在启动时能从 APK 拿到这张条子 ⇒ 用同一套白名单判定复验，页面不必知道 secret。
  （原先 `voucher` 只签发、不强制；**2026-09-23 起已强制**。）
- **`/api/launch/request` 也改走 `masterAllow()`** —— 判据只有一处，避免漂移。
- `/api/info` 新增 `masterAllow: true`（能力标识，供 APK 区分旧版接收端）与 `platform: {...}`；`ver` → `1.4.0`。

## 媒体：视频 + **音频**

推流由「仅视频」变为「**视频 + 音频**」：

```
头显 AudioContext.master ──createMediaStreamDestination()──▶ audioTrack
                                    │
                          cast.js _attachAudio(stream)  ← 必须在 new WebRtcPush 之前
                                    │
                          push-webrtc.js addTrack(音轨)   ← 必须在 createOffer 之前
                                    ▼
                          PC <video id="video">（autoplay-policy 已放开 → 大屏出声）
```

- 音轨走**干路**（MediaStreamAudioDestinationNode），头显自己的扬声器不受影响。
- 音轨在段落切换时只切 `enabled`，**不重新协商**（避免 `replaceTrack` 抖动）。
- 开场影片期间**不推视频也不推音频**（`CAST.PAUSE_STATES` 含 `'intro'`）。

## 门禁与推流/平台的关系（一张图）

```
平台点「启动」──▶ PC EXE 起来（读启动参数）┐
                 APK 起来（UDP 224.0.0.100:8444 发现 PC）
                     │
                     ├─ POST /api/launch/request  ──┐
                     │                              ├─ masterAllow() ─┬─ 拒 → 「需要主控端启动」页（+重试）
                     │                              │                 └─ 行 → 建游戏界面 + 拿配置下发
                     └─ 拉起浏览器 ?plat=1&gate=1&dev&exp&voucher
                                    │
                       页面 gateQueryMaster() ── POST /api/master/allow （经 APK proxyApi → PC）
                                    │
                              ┌─ 行 → 显示「进入 VR」┐
                              └─ 拒 → 遮住按钮 + 重试  ├─▶ 进 VR → 推流（视频+音频）→ PC 大屏
平台点「结束」──▶ kill 进程 + CMD16 → PC 关；头显页面看门狗 ≈6s 自查收尾并关浏览器
```
