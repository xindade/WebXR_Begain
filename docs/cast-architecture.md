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

**静态资源从哪来（第二十二修 · 档1 改口径）**：页面 / JS / GLB / 影片**一律取 APK 包内** `assets/game/**`
（`GameServer.serve()` 本地优先 —— 发现 PC 也照样读包内），PC 代理降级为「包内缺文件」时的兜底。
历史口径「PC 用 `GAME_ROOT` 实时托管整站、改 JS 免重打包」已于 2026-09-23 撤销（路径②停用）：
头显浏览器不再能直连 PC 整站，页面上拿掉了这条误用面。因此**改前端必须重打 APK** ——
`tools/cast-apk/build-apk.ps1` 的 2.5 / 2.55 两步会把 `src/**` 与根级 `index.html` / `mirror.html`
一起同步进 `assets/game/`（只覆盖不删除）。

唯一仍由 PC 下发的静态内容是**受管配置**：头显启动时按 `CONFIG_MANIFEST` 取 `src/content/` 与
`src/core/userConfig.js`（需授权，落地到私有覆盖层 `filesDir/game-overlay`，优先级高于包内且缺失即 404）。

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

1. **影片从哪来**：PC 端只托管 EXE 内置目录 `resources/game-cfg`（`main.js` 的 `currentServeRoot()`），
   接收端页面与之同源 → 直接 `GET /assets/intro/intro.mp4` 即可（路径由头显在信令里带过来，不写死）。
   头显侧 `assets/game/assets/intro/intro.mp4` 是同一份（打 APK 时打进去了）。
   取不到时会 404 → 自动收起影片层并打告警，退回占位画面，**不会卡住**。
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

### PC 端界面：纯净模式（只保留游戏画面）—— **默认开启**

| 操作 | 效果 |
|---|---|
| 按 **H** | 切换「纯净模式」：隐藏地址栏 / 游戏目录 / 授权面板 / 启动授权面板 / 日志区，**只剩游戏画面铺满窗口**。状态存 `localStorage`（键 `castPure`），下次启动保持 |
| 按 **F** | 切换全屏（HTML5 Fullscreen） |
| **★ 默认状态** | **纯净模式默认开启**（2026-09-23 起）：打包后启动即只留画面，无需任何参数 |
| 启动参数 `--panels` | 强制**显示完整面板**（透传 `?pure=0`）供现场排查，优先级高于 `localStorage` |
| 启动参数 `--pure` | 显式进入纯净模式（透传 `?pure=1`） |
| 启动参数 `--fullscreen` | 启动即全屏；与 `--pure` 组合 = 开机即大屏 |

优先级：URL `?pure=1/0`（`--pure` / `--panels`）> `localStorage`（上次手动切换）> **默认开**。

实现位置：`renderer/index.html` 的 `body.pure` 规则；`renderer/renderer.js:34-49`（默认值判定 + `setPure` / `toast` / 快捷键；纯净模式下 `log()` 跳过 DOM 写入）；`main.js:558-562`（`pureQ` 透传 + `setFullScreen`）。

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
| 游戏 `src/**`、`index.html`、`mirror.html` | ✅ **需重打 APK** | 头显只认包内（`GameServer` 本地优先）；`build-apk.ps1` 2.5/2.55 会自动同步 —— 忘了打就是「跑了旧页面」 |
| APK 内置重资源 `assets/game/{Model,Sky,music,vendor,assets}/**` | ✅ 需重打 APK | 同上（必须进包；包内缺文件才会回退 PC 代理兜底） |
| 受管配置 `src/content/**`、`src/core/userConfig.js` | ❌ 不需要 | 头显每局从 PC `/api/config/dump` 取（需授权），走覆盖层 |
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
平台点「启动游戏」（第一步）──▶ PC EXE 起来（读启动参数）   ← 本局**尚未**放行
                 APK 起来（UDP 224.0.0.100:8444 发现 PC）
                     │
                     ├─ POST /api/launch/request  ──┐
                     │                              ├─ masterAllow({requireRound:false})
                     │                              │    （只证明「头显连上了」，不看本局）
                     │                              └─ 行 → 建游戏界面 + 拿配置下发
                     └─ 拉起浏览器 ?plat=1&gate=1&dev
                                    │
                       页面 gateQueryMaster() 每 2s ── POST /api/master/allow {device}
                                    │                （经 APK proxyApi → PC）
                              ┌─ 拒（ROUND 未 armed）→ 「⏳ 等待平台开始游戏…」（不给重试按钮）
                              └─ 拒（PC 没开/网络不通）→ 「⛔ 需要主控端启动」+ 重试
平台点「开始游戏」（第二步）──▶ 游戏通道 CMD 5 GameStart（UDP 51124 → PC EXE / 头显 APK）
                              ├─ PC EXE：roundSet(true) + 回 118 字节确认帧（照抄真实游戏）
                              └─ 头显 APK：0x05 → 转 cmd 21 → 页面 vrPlatStart=true → 「进入 VR」
                                 → 进 VR → 推流（视频+音频）→ PC 大屏
                                 （**无需人工点按钮**；手动排练时才用 PC 的「▶ 开始本局」）
平台点「结束游戏」（PC 排练时点「■ 结束本局」）──▶ ROUND.armed=false
                              ├─ 页面轮询到 armed 1→0 → 退 VR → 停推流 → replace(about:blank)
                              │  → APK 把平台客户端（com.GoodNet.LauncherClient）顶回前台（第二十修：连顶 3 次）
自然通关 ──▶ _reportGameEnd → POST /api/round/end → PC 端回到「未开始」
平台点「结束」──▶ kill 进程 + CMD16 → PC 关（看门狗 ≈6s 兜底同上）
```

---

# 附录 B · 2026-09-23 晚 · 第十八修（正式版裁剪 + 主控端开局/结束）

> 起因（现场实测三问）：
> ① 正式版里还留着**暂停 / 继续 / 设置 / 导出**、桌面「进入 VR」上方那颗「开始游戏」、右侧**选关**面板；
> ② 第一次头显连上 PC 就能直接点进 VR（应等「开始游戏」信号），第二次却提示**「重试连接主控端」**；
> ③ 游戏结束只在浏览器里提示、**浏览器没关** ⇒ 头显再次调起游戏后连不上 PC 直播。

## B.1 正式版界面裁剪 —— 编译时常量 `RELEASE_UI`

| 项 | 位置 | 说明 |
|---|---|---|
| `RELEASE_UI` | `src/core/constants.js:1111`（紧邻 `MASTER_GATE`） | 正式包 `true`；打包脚本要区分正式/调试包，改的就是这一个值 |
| `RELEASE` | `src/main.js:30` | `RELEASE_UI && !params.has('devui')`；随后 `document.body.classList.add('release')` |
| 调试面板不创建 | `src/ui/settings.js` | `GameControls` 构造新增 `devUI` 参数，正式包**直接 return**：暂停/继续/设置/日志/导出整块不建；`showPaused` / `updateStats` 退化成空实现（靠 `this.xrPanel` / `this.stats` 存在性守卫） |
| 桌面「开始游戏」不创建 | `src/ui/hud.js` | `HUD({ devUI })`；`startBtn` 包进 `if (devUI)`；`hideStart` / `showStart` 加空值守卫 |
| 选关面板 | `src/main.js` | `buildLevelPanel()` 开头 `if (RELEASE) return;`；`applyVRGate` 处 `if (levelPanelEl && !RELEASE)` —— 左侧列表不再有关卡选择 |
| CSS 兜底 | `index.html`（`</style>` 前） | `body.release #gun-mode-btn, body.release #hint, body.release #level-panel { display: none !important; }` |
| 相关接线 | `src/main.js` | `hud.onStart(...)` 与 `input.onUnlock = () => focusPause('manual', true)` 都加 `if (!RELEASE)`；`reportError` 里的 `pause.add('error')` 同理（正式包没有「继续」界面，报错暂停 = 假死） |

### B.1b 不止藏界面：**功能本身**也删掉（同日补充需求）

用户原话：「我想要的不仅是标签去掉，还要把功能去掉（暂停，继续，设置，性能，PC模式），隐藏日志和选关功能」。
⇒ 正式包里这些**能力**不允许存在（不只是 DOM 不创建）：

| 功能 | 正式包的处置 | 位置 |
|---|---|---|
| **暂停 / 继续** | `focusPause()` 第一行 `if (RELEASE) return;`（最后一道保险）；`blur` / `focus` / `document.visibilitychange` / XR `sessionstart→visibilitychange` 四条监听**只在 `!RELEASE` 时注册**；主循环的 A/B 菜单键分支加 `!RELEASE` ⇒ **`pause.paused` 恒为 false**（`PauseState` 对象仍在，但没有任何路径能 `add()` 原因） | `src/main.js`（focusPause / 监听注册 / setAnimationLoop） |
| **性能** | `const monitor = RELEASE ? null : new PerformanceMonitor();` —— 正式包**不构造监视器**，每帧 `monitor.record()` 整段不执行（顺带省下 `performance.now()` 采样） | `src/main.js` |
| **日志** | `window.__pageLog.disable()`（由 main.js 按 RELEASE 调）：`disabled=true` ⇒ `append()` 直接 return（**不建 DOM、不逐条追加**）并移除已有面板；index.html 另有 `body.release .pagelog { display:none !important }` 兜底 | `src/ui/pagelog.js`（新增 `disable()`）、`src/main.js`、`index.html` |
| **设置** | 设置对话框只在 `devUI` 下创建（`src/ui/settings.js` 构造早退）—— 正式包无入口；`applySettings(settings)` 启动时仍应用（那是游戏默认值，不是「设置功能」） | `src/ui/settings.js` |
| **PC 模式** | 桌面「开始游戏」按钮不创建、`hud.onStart` 不接线（`!RELEASE` 判定） | `src/ui/hud.js`、`src/main.js` |
| **选关** | `buildLevelPanel()` 开头 `if (RELEASE) return;` + `body.release #level-panel` 隐藏 | `src/main.js`、`index.html` |

**副作用（刻意接受）**：正式包里玩家按 P/Esc/A/B 都不再有反应，`exitGame()` 只剩平台/主控端那条路（`结束本局` → `_onPlatformCloseRequest`）。
玩家无法自行暂停或退出 —— 现场由操作员控制，符合平台对接的流程设计。

⚠ 与「待机态」区分：`game._renderPaused`（本局结束后的冻结，平台驱动）**不属**暂停功能，未动。

**应急出口**：`?devui=1` 恢复全部调试界面**与暂停/性能/日志功能**（现场自测用，正式使用不要加）。

## B.2 开局判据重做 —— 从「?plat=1 即开局」改成「PC 主控端本局放行（ROUND）」

**旧机制的两个根因**

- `?plat=1`（APK 拉起页面）被当成「平台已开始本局」⇒ 头显一连上就能进 VR。
- 放行条 TTL 仅 60 秒（`GUARD_VOUCHER_TTL_MS`）⇒ 第二局的页面复验必然「已过期」，即第二次日志 19:41:20 的症状。

**新机制（判据 = PC 端 `ROUND.armed`，页面轮询）**

| 端 | 改动 |
|---|---|
| PC `tools/cast-pc/main.js` | 新增 `ROUND = { armed, at, seq }` + `roundSnapshot()` + `roundSet(on, why)`（唯一入口，状态变化才广播 `round:changed`）；新增路由 `POST /api/round/end` → `handleRoundEnd`；`masterAllow(ip, body, { requireRound=true })` 重写为三段：① `licenseGate()` ② 凭据三选一（签名 `dev+ts+sig` / 放行条 `dev+exp+voucher` / **仅 `device`**，最后一种给页面轮询用）③ `ROUND.armed`；`ROUND_IDLE_WHY = '尚未开始本局（请在 PC 主控端点「开始本局」）'`；`handleLaunchRequest` 改 `requireRound:false`（否则头显永远拉不起页面）；`/api/master/allow` 与 `/api/info` 响应加 `round:`；新增 IPC `round:get` / `round:set` |
| PC 界面 | `preload.js` 加 `roundGet/roundSet/onRoundChanged`；`renderer/index.html` 加 `#roundbar`（`▶ 开始本局` / `■ 结束本局` / `#roundState`），**CSS 不列入 `body.pure` 隐藏名单**（纯净模式下也必须可见可点）；`renderer/renderer.js` 加 `renderRound` / `setRound` + 快捷键 `S` / `E` |
| 游戏页面 `src/main.js` | `vrMaster` 改为 `{ known, ok, why, round, armedPrev, exempt, err, dev, pc }`（去掉 `hasCred` / `exp` / `voucher`）；`gateQueryMaster()` 只带 `{device}`，失败**不改 `ok`** 只记 `err`；`gateReactToMaster()` 用 `armedPrev` 的 1→0 跳变判「主控端点结束」⇒ `setVRGate(false)` + `_onPlatformCloseRequest`；`scheduleMasterPoll()` 门禁关着 2s（`GATE_POLL_MS`）、已放行 5s（`GATE_POLL_IDLE_MS`）；`scheduleGateFallback()` 开头 `if (MASTER_GATE_ON && !vrMaster.exempt) return;`（主控端负责时**不做** 30 秒无条件兜底） |
| 启动默认 | `setVRGate(VR_GATE_FORCE === '1', …)` —— `?plat=1` **不再**开门禁，只作留痕 |
| 提示分流 | `hardFail = (vrMaster.err && !vrMaster.known) || (vrMaster.known && vrMaster.round)`：非 hardFail 显示「⏳ 等待平台开始游戏…」，hardFail 才显示「⛔ 需要主控端启动」；`updateGateRetryBtn()` 的 `need` 同式 ⇒ **正常等待时不给「重试连接主控端」按钮** |

## B.3 结束收尾 —— 直播模式必须把浏览器收干净

| 项 | 位置 | 说明 |
|---|---|---|
| 一次性「本轮结束」标志 | `src/game/game.js` | `this._roundOver`：`_onPlatformGone` 置 `true`；两处通关 `_endRound` 前置 `true`；`_endRound` 里 `_reportGameEnd(why, { roundOver })` 后复位 —— 用来区分「本轮真的结束」与「玩家自己退 VR」 |
| 上报 PC | `_tellMasterRoundEnd(why)` | `fetch('/api/round/end', { method:'POST', keepalive:true, … }).catch(()=>{})`；**keepalive 必须加**：直播模式收尾时本页马上 `replace('about:blank')`，普通 fetch 会被取消 |
| 直播模式收尾 | `_onPlatformGone` | `cast=1` 时：`cast.dispose()`（停推流 + 关信令）→ `VRPlus.reportDead('cast-round-over', …)` → 500ms 后 `location.replace('about:blank')` → `return`；非直播保持四修「待机态、零重载」 |
| 依赖注入 | `setSystems(audio, input, wristUI, pageLog, cast = null)` | 存入 `this.cast`；`src/main.js` 调用处已补第 5 个实参 |
| APK 侧 | `GameServer.java` / `MainActivity.java` | `notifyGameEndIfAny` 区分 `cast` 与 `roundOver`（`cast && !roundOver` 才跳过退出策略；`cast && roundOver` 置 `sCastRoundOver = true`）；`restoreClientAndCloseBrowser` 新增 `castRoundOver` 分支：直播 + 本轮结束时**不依赖**「顶客户端」流程，直接 1.5s 后 `killBrowser(app)` |

## B.4 本轮验收要点

- 三态门禁：正式包 + 无 PC → 拦并提示「⛔ 需要主控端启动」；正式包 + PC 未开始 → 「⏳ 等待平台开始游戏…」（**无**重试按钮）；PC 点「开始本局」→ 2s 内出现「进入 VR」。
- 正式包无暂停/继续/设置/日志/导出、无桌面「开始游戏」、无选关面板；`?devui=1` 可恢复。
- PC 点「结束本局」→ 头显退 VR、停流、页面卸载为 `about:blank`、APK 关浏览器；第二局不再出现「重试连接主控端 / 放行条已过期」。
- 直连 `http://<PC>:8443/?cast=1&vrbtn=1`（或 `&gate=0`）不受门禁影响，仍可独立诊断。
- PC 端快捷键 `S` / `E` **在输入框里打字时不生效**（否则在「游戏目录」里输 `E:\AI_Work\...` 会当场「结束本局」），带 Ctrl/Cmd/Alt 的组合键同理 —— 守卫在 `tools/cast-pc/renderer/renderer.js` 的 keydown 开头。
- 产物：APK `6DCC3EE25D951C8AAA8935ACE9E9C51BB754C7B28D8E8755D05EB52C2B99E2F5`；PC Setup `EF5D7AD0ABF3C37752F749D1069871EF3E50E529BDDA392976CDDBA3E90CB296`（2026-09-23 20:05 / 20:06 构建）。

---

# 附录 C · 2026-09-23 晚 · 第十九修（开局交给平台 + 关闭把平台客户端顶回来）

> ⚠ **本节 C.1 的结论已被第二十修推翻**（把「平台拉起 EXE」当成开局 ⇒ 头显在操作员还没点
> 「开始游戏」时就冒出「进入 VR」）。现行实现见 **附录 D · 第二十修**；
> C.2 的修法方向保留，但已加强为「连顶 3 次 + 固定 1.2s 后关浏览器」（见 D.3）。

> 用户实测反馈两条：
> ① 「我想要的是对接的平台点开始游戏，不是 PC 端游戏点开始游戏」；
> ② 「关闭游戏浏览器界面是 blank，但是应该把 launcherclient 这个头显客户端从后台调出来，
>    不然第二次就无法启动头显里的游戏」。

## C.1 开局信号：平台拉起 EXE = 平台点了「开始游戏」

**依据**（`平台指令/VRPlatform-流量取证/指令速查.md`）：平台点「开始游戏」走的是
字符串指令 `{"cmd":"start","msgData":"<相对路径>$<进程名>$<平台IP>"}` → 启动器 `DoStartGame`
→ **CreateProcess 拉起我们登记的 EXE**。这就是平台的开局动作在 **PC 侧唯一的可见形态**。

| 项 | 实现 |
|---|---|
| 判据 | `tools/cast-pc/main.js` 新增 `PLATFORM_LAUNCHED`（位置参数三段解析成功，或 `--room` / `--platform` / `--game` 任一有值） |
| 效果 | `const ROUND = { armed: PLATFORM_LAUNCHED, … }` —— **EXE 一启动本局就已放行**，头显页面 2s 内轮询到即出现「进入 VR」，**操作员一次按钮都不用点** |
| 排练 / 手动 | 双击 EXE（不带平台参数）⇒ `armed=false` ⇒ 头显先显示「⏳ 等待平台开始游戏…」，用 PC 的 `▶ 开始本局` 手动放行（按钮保留为兜底） |
| 第二局 | 平台「结束游戏」会 kill PC 端进程；下一局平台再点「开始游戏」⇒ 新的 EXE 进程 ⇒ 重新 armed |
| 拒绝文案 | `ROUND_IDLE_WHY` 改为「尚未开始本局（等平台点「开始游戏」；或在 PC 主控端点「开始本局」）」 |

> `?plat=1`（APK 拉起页面）**仍然不是**开局判据 —— 第十八修的结论未回退。
> 本次只是把「谁来点这一下」从人换成平台自己：**平台拉起 EXE 才 armed**。

## C.2 关闭：必须把平台客户端顶回前台

第十八修在直播模式结束分支里「只关浏览器」，实测留下两个后果：头显停在 `about:blank` 白页、
平台客户端 `com.GoodNet.LauncherClient` 仍在后台 ⇒ **平台下一次「开始游戏」拉不起游戏**。

修法（`MainActivity.restoreClientAndCloseBrowser` 的 `castMode && castRoundOver` 分支）：

```
页面已 about:blank 收工 → bringClientToFront(app, why)    // 先把平台客户端顶回前台
                        → sPendingKillBrowser = wantKill  // 关浏览器交给实测复核
                        → verifyClientFront 1.4s 后确认「浏览器确实退后台」才关（第十一修）
```

- 平台客户端包名：`DEFAULT_CLIENT_PKG = com.GoodNet.LauncherClient`（平台拉起一次后会自动确认真实包名）。
- 关浏览器仍受 `killBrowser` 开关控制（默认**关**），且只有实测到浏览器退后台才会执行。
- 判据依据：页面已卸载 ⇒ 不再向 APK 打点 ⇒ `pageHitAgeMs()` 变大 ⇒ `verifyClientFront` 判「已生效」。

## C.3 本轮验收

- 平台点「开始游戏」→ 头显**无需任何人工操作**出现「进入 VR」。
- 平台点「结束游戏」→ 头显退 VR、页面卸载、**回到平台客户端界面**；再点「开始游戏」能正常拉起。
- 手动双击 EXE（不带平台参数）→ 仍可用 PC 的 `▶ 开始本局 / ■ 结束本局` 完整演练。
- 实测记录（本机）：带平台位置参数启动 ⇒ `/api/info` 的 `round.armed=true`、`/api/master/allow` 返回 `allow:true`；
  不带参数启动 ⇒ `armed=false`、`allow:false`（原因见 `ROUND_IDLE_WHY`）。
---

# 附录 D · 2026-09-23 晚 · 第二十修（开局 = 平台「开始游戏」CMD 5；关闭后必须把平台客户端顶回来）

> 用户第五次现场实测反馈两条：
> ① 「平台首先点的是**启动游戏**，这一步会拉起 exe 文件和头显里的游戏，第二步是平台点**开始游戏**，
>    这个时候头显里才会显示进入VR」；
> ② 「关闭游戏后 exe 直接关闭（正常），头显里浏览器是 blank，且客户端还在后台没有调起（异常）」。

## D.0 判据来源：抓包逐帧（`平台指令/VRPlatform-流量取证/pcap-game_channel/`）

115 秒、两轮完整生命周期的抓包，把平台操作拆成**三步**：

| 平台动作 | 通道 | 报文 |
|---|---|---|
| ① 启动游戏 | 启动器 UDP 62135 | `{"cmd":"start","msgData":"DeepmindHacker-2.0.4\DeepmindHacker.exe$DeepmindHacker$192.168.31.237"}` → `DoStartGame` → CreateProcess |
| **② 开始游戏** | **游戏通道 UDP 51124** | `20:49:56 .237:58734 -> .237:51124  \x05{"difficulty":0,...,"gameId":128,...,"recordTime":0}` |
| ③ 关闭游戏 | 四路并发 | `{"cmd":"kill",...}` + `0x10 "closeGame  "` + `0x02` + `logcat` |

关键细节（决定了实现口径）：

- 平台 GameStart（CMD 5）**只发给「跑游戏的那台机器」**（`.237:58734 -> .237:51124`）；头显 `.228`
  **没收到**，它靠 UNet 14568 同步。而 closeGame 是**两路同发**（→ `.237:51124` **和** → `.228:51124`）。
- ⇒ PC 端 EXE **就是**平台登记的那个游戏进程，所以第二步的 GameStart 会打到 **PC 的 UDP 51124**；
  头显侧能不能拿到这一帧**不能假定**，必须靠 PC 侧回报兜底。
- 真实游戏收到 CMD 5 会**回 118 字节确认帧**（`0x05` + `{"difficulty":0,...,"posSum":0,"gameId":0,"flag":1,"levelInfo":null,"recordTime":0}`）。
- `指令速查.md:20` 把 GameStart 方向写成「客户端→平台」是**错的**，以抓包为准。

## D.1 PC 端：新增「平台游戏通道」（`tools/cast-pc/main.js`）

```js
// app.whenReady() 里 startBeacon() 之后：
startPlatformGameChannel();        // UDP 51124，--no-game-channel 可关
```

| 收到 | 动作 |
|---|---|
| `0x05` + JSON | `roundSet(true, '平台「开始游戏」（CMD 5 GameStart gameId=…）')` + **回 118 字节确认帧**（照抄真实游戏，平台在等） |
| `0x10 closeGame` | `roundSet(false, …)` + 回 `0x02`（平台在等这个确认，抓包 7ms） |
| `0x01` + Machines JSON | 记 `machines` 条数 = 平台已认到本机（**注册生效的现场证据**） |

- 源端口就是 **51124**（与真实游戏一致），bind 后 0 / 1.5 / 3 / 4.5s 各向 `<平台IP>:51234` 发一次 `0x01` 注册（抗丢包）。
- `PLATFORM_LAUNCHED`（①被平台拉起）**保留但只用于日志与显示**，**不再**参与放行 —— 这是第十九修的错误所在。
- 新增 `POST /api/round/start`：头显页面收到 cmd 21 后回报，覆盖「平台只把 GameStart 发给 PC」的分支。
- `/api/info` 新增 `gameChannel: { enabled, bound, frames, machines, lastStartAt, lastStartFrom, lastCloseAt, why }`
  —— **现场排障第一眼看这里**。

## D.2 头显侧：0x05 → cmd 21 → 页面放行

```
VRPlusLink.recvLoop  : b0 == 0x05 → handleGameStart() → 入队 cmd=21 (plat=true) + 回 118 字节确认帧
                       ⚠ 必须放在 closeGame 判断**之前**
src/game/game.js     : cmd === 21 → _platformSignal('onStart', …)   ← 平台「开始游戏」
cliToPage            : cmd 3/4 只有带 payload.plat 才开门禁（旧平台路径），否则只回菜单
src/main.js          : platformHooks.onStart → vrPlatStart = true → setVRGate(true) → 回报 POST /api/round/start
                       masterGateAllowed() = !MASTER_GATE_ON || vrMaster.exempt || vrPlatStart || (vrMaster.known && vrMaster.ok)
提示文案              : 「⏳ 等待平台点「开始游戏」…（平台第二步点了之后，这里会出现「进入 VR」）」
```

- 页面残留门禁清理扩到 `n === 21 || (n === 3 && msg.plat)`（`_pageT0`），避免新一局被上一局的帧顶开。
- `clearStaleClose()` 同步丢弃 `cmd==21` 与 `cmd==3 && plat`。

## D.3 关闭：把平台客户端顶回前台（本轮真正修好）

第十九修的修法**实测没生效**，两个原因：

1. `scheduleClientRestore()` 默认等 2.5s —— 平台关闭是**并发 force-stop** 本 APK，等 2.5s 就来不及了；
   且 `verifyClientFront` 的回调路径在 `castMode && castRoundOver` 分支里**跑不到**，导致「永远不关浏览器」。
2. `bringClientToFront` 只顶一次，launchIntent 为 null 时没有兜底 Intent。

改动（`MainActivity.java`）：

```java
static boolean castConfigured()                      // 供 VRPlusLink 判断「本轮是直播模式」
RESTORE_FAST_MS = 0L                                 // why 含 closeGame → delay 0ms
reviveClosedPage()  → enqueueLocal(3, …, false)       // 不再开「进入 VR」门禁
bringClientToFront() → 连顶 3 次（0 / 600 / 1200ms）+ 1200ms 后 verifyClientFront
attemptClientFront() → flags 逐次加强：round2 追加 CLEAR_TOP|SINGLE_TOP；
                        launchIntent 为 null 时兜底 MAIN+LAUNCHER+setPackage
restoreClientAndCloseBrowser() castMode && castRoundOver 分支：
        顶客户端（开关控制）→ **固定 1.2s 后 killBrowser**（不再等实测回调）
```

- `VRPlusLink.handleCloseGame()`：若 `MainActivity.castConfigured()` → `GameServer.sCastRoundOver = true`
  （让**直播模式**也走退出策略，而不只是游戏模式）。
- 期望终态：**头显停在平台客户端界面**，浏览器退掉；再点「启动游戏」能正常拉起。

## D.4 本轮验收

1. 平台点「启动游戏」→ EXE 起来 + 头显起来，**头显不出现「进入 VR」**
   （应显示「⏳ 等待平台点「开始游戏」…」）。
2. 平台点「开始游戏」→ 头显出现「进入 VR」→ 点进去 → PC 大屏出画面**和声音**。
   - PC 侧 `/api/info` 应看到 `round.armed=true`、`gameChannel.lastStartFrom` 有值、`machines` ≥ 1。
3. 平台点「结束游戏」→ PC EXE 关闭 + 头显浏览器退掉 + **平台客户端回到前台**；
   再点「启动游戏」能正常拉起（第二次启动不再失败）。
4. 若第 3 条的「顶客户端」仍不生效：读 `http://<头显IP>:8080/api/page/forensics?download=1`，
   看「悬浮窗权限=已授予/未授予」与「已发出顶客户端请求 #1/#2/#3」。
5. 手动双击 EXE（不带平台参数）→ 仍可用 PC 的 `▶ 开始本局 / ■ 结束本局` 完整演练。

## D.5 第二十二修（2026-09-23 深夜）· 档1 + PC 占位文案 + 进入 VR 二选一

> 平台对接全流程（含 ②「开始游戏」与 ③ 调起客户端）的**成功方案结论版**见
> `docs/平台对接成功方案.md` —— 本附录 C/D 是它的推演过程与抓包依据。

### D.5.1 档1：撤掉路径②（头显浏览器直连整站）

- **PC 端**（`tools/cast-pc/main.js`）：`SERVE_GAME` → `EXT_CFG`；`currentServeRoot()` 打包版**只**返回
  `resources/game-cfg`（配置 + 开场影片），不再 serve 外部游戏目录；`isValidGameRoot()` 删除，
  外部目录只当**可选配置覆盖来源**（判据 `hasConfigTree()`）；新增 `PANELS`（`--panels` 或开发模式才显示
  「外部配置目录」面板，正式界面连按 `H` 也看不到）；`/api/info` 去掉 `root`/`serveGame`，新增
  `extCfg`/`configRoot`/`bundledCfg`/`serveRoot`/`panels`；`GET /index.html` 由 404 改为**带排查指引的 404**
  （状态码不变，方便脚本判定）。
- **APK 端**（`GameServer.java`，本轮最关键的联动修复）：删掉「发现 PC 后一律 `proxyStatic` 静态代理」。
  页面 origin 固定是 `http://localhost:8080`（WebXR 安全上下文），若仍把 `/index.html` 代理给 PC，
  而 PC 已不托管整站，头显会**直接白屏**。现在改为**包内优先**，PC 代理只在包内缺该文件时兜底。
- **打包脚本**（`build-apk.ps1` 新增 2.55）：把根级 `index.html` / `mirror.html` 也同步进 `assets/game/`。
  起因：2.5 只覆盖 `src/**`，根 HTML 一直靠手抄 —— 本轮实测抓到这个坑（改了按钮但包内仍是旧页面）。

### D.5.2 PC 大屏「PICO 连接」字样发糊

- **根因**：菜单/等待房间阶段头显推的是 960×540 的 2D 占位画（`CAST.WARMUP_FPS=1`），PC 大屏按
  `object-fit: cover` 铺满 1920 宽 → 位图文字被放大 2 倍以上。
- **改法**：新增信令 `{type:'warmup', on}`；PC 端收到后**不显示**占位帧，改由本窗口渲染矢量文案
  （`#hint.big`，`clamp(22px,3vw,64px)`，任意分辨率都清晰）。头显侧占位帧**照旧推**（预热链路、
  编码器保活都不变），每 5 帧重报一次防信令丢失；`intro end` 与断流时都会复位。

### D.5.3 「进入 VR」二选一开局加成

| 按钮 | 键 | 初始属性变化（基线 攻击力 100 / 射速 2 发/秒） |
|---|---|---|
| 蓝 `⚡ 射速加倍 · 攻击力减半` | `rapid` | 攻击力 100→**50**、射速 2→**4 发/秒** |
| 红 `💥 攻击力加倍 · 射速减半` | `power` | 攻击力 100→**200**、射速 2→**1 发/秒** |

- 倍率表在 `src/core/constants.js` 的 `LOADOUTS`（键名同时用于日志与调试）；
  `src/game/player.js` 的 `reset(gunMode, loadout)` 在**初始值算完后**乘倍率 —— 后续抽卡
  （攻击力 +100 / 射速 +2）与死亡重开（攻击力 +50）照旧叠加，不受影响。
- `src/main.js`：`pendingLoadout` 由点击决定，`sessionstart` 时传给 `game.start()`；
  进 VR 期间两个按钮都禁用、只有被点那个显示「⏳ 启动中...」，退出 VR / 失败后文案复位。
- `src/vr/availability.js` 的 `watchXRAvailability` 支持多按钮（只切 `disabled`，不覆盖各自文案，
  提示文案改走 `onLabel` → `#status-msg`）。

### D.5.4 本轮验证（2026-09-23 深夜，本机实跑）

- 语法：8 个改过的 JS 全部 `node --check` 通过。
- 打包版 EXE 实跑（`dist/win-unpacked`，端口 18443）：`/api/info` 无 `serveGame`、`panels:false`、
  `bundledCfg:true`、`serveRoot=…resources/game-cfg`；`HEAD /assets/intro/intro.mp4`→200；
  `GET /index.html`→404（路径②确已停用）；平台通道 `gameChannel.bound=true`；`/api/config/dump` 未授权时
  正确拒绝。
- APK 解包核对：`assets/game/index.html` 含 `#enter-vr-rapid`/`#enter-vr-power`，
  `src/core/constants.js` 含 `LOADOUTS`，与项目根哈希一致（证明 2.55 同步生效）。

---

---

# 附录 E · 2026-09-24 第二十三 / 二十四修（界面裁剪 + 授权关闭 + 服务器清单）

## E.1 三件事，一句话各一件

| 修 | 需求 | 落地 |
|---|---|---|
| 二十三 | 「apk 上还有镜像的标签和选关上面的一个绿色长条，需要隐藏或清理一下」 | `index.html` 的 `body.release` 选择器组 + `src/main.js`；绿色长条经确认 = 右上角 2D **船血条** `#hud-hp`（`src/ui/hud.js`） |
| 二十三 | 「服务器验证不想做加密狗授权验证了，需要把这个功能隐藏起来」 | `LICENSE_ENABLED = hasFlag('license')`（默认关）；`/api/info` 报 `mode:'off'`，头显据此跳过校验 |
| 二十四 | 「换成每次启动从服务器上拉清单，关闭游戏和下次启动前会将旧时间的配置清理」 | 新增 `GET /api/manifest` + `sync-content.js` + EXE 的 `userData/manifest` 缓存 + 三处清理 + 头显 `clearOverlayCache()` |

## E.2 清单链路（第二十四修）

```
项目源 src/content/** + src/core/userConfig.js
   └─ node tools/cast-server/sync-content.js --ver 1.0.0
        └─ tools/cast-server/content/<ver>/（.gitignore 的发布产物）
             └─ GET /api/manifest?key=&ver=  （共享密钥，不做 Ke / proof）
                  └─ PC EXE：userData/manifest/（不进 GAME_ROOT）
                       ├─ /src/content/**         只从这份缓存出
                       ├─ /api/config/dump        只从这份缓存打包
                       └─ 拿不到 ⇒ 404 / allow:false（**绝不回落本地**）
                            └─ 头显 overlay（既有通道，协议未改）
```

**清理的四个时机**：① EXE 启动**无条件先清**（主防线，平台 `kill` 时不走 `before-quit`）
② 本局结束 `roundSet(false)` 清 + 立刻重拉 ③ `before-quit` ④ 头显启动 / 本局结束 `clearOverlayCache()`。

## E.3 为什么「启动先清」是主防线（与第二十修的闭合）

第二十修定案：**平台关局 = `kill` + `closeGame` 并发**。`kill` 意味着 `before-quit` 不会执行 ——
如果旧配置只能靠退出时清，那「两次启动之间」这一段就是裸露的。
所以本轮的清理被放到**启动路径的最前面**（`loadGuard()` 之后、拉取之前），它不依赖任何优雅退出。

## E.4 本轮验证（2026-09-24，本机实跑）

- 正例（真服务器 + 本地发布 `1.0.0`）：`/api/info.manifest` → `ok=true count=7 bytes=68939 fp=ae06e1354398aeb2 tries=1`；
  `/src/content/levels.js` → 200；`/api/config/dump` → `allow=true count=7`，7 个文件与项目源**逐字一致**；
  `userData/manifest/src/content/` 6 个文件 + `meta.json`。
- 反例（服务器不可达 + **预置上一局残留旧配置**）：启动 3 秒后残留**已被清空**；
  `/src/content/levels.js` → **404**（不回落）；25 秒后 `manifest.ok=false, why="拉取失败：connect ECONNREFUSED …", tries=4`。
- 本局结束：`POST /api/round/end` → 缓存清 + 4 秒内重拉；`clearedWhy="本局结束（画面侧上报：…）"`。
- **打包版**（`dist/win-unpacked`）实跑：`manifest.on=true`（正式包默认开）、`ok=true`、静态取配置 200。
- `node --check` 覆盖 `tools/cast-pc/main.js` 与 `renderer/renderer.js`；APK `BUILD SUCCESSFUL`（126.97 MB）。

## E.5 重打包边界

- 改 `src/ui/hud.js`、`index.html`、`src/main.js`、`MainActivity.java` ⇒ **APK 重打**。
- 改 `tools/cast-pc/**` ⇒ **EXE 重打**（`asar:true`，渲染层也在包内）。
- 只改 `src/content/**` / `userConfig.js` ⇒ **都不用重打**，但要 `sync-content.js` + 部署。
- 详细实现记录见 `docs/cast-implementation-and-packaging.md` 附录 G；完整口径见
  `docs/tech/09-服务器清单与旧配置清理.md`。

---

# 附录 F · 2026-09-24 第二十六修（头显「平台二次拉起」不再打断 VR）

## F.1 现场现象与定性

用户原话：

> 头显客户端那里会启动两次游戏中间间隔 20 秒左右，也就是启动成功后客户端那边还是会再启动一次，
> 这个时候如果已经点了开始游戏，头显页在 VR 里面了，就会出现一个退出浏览器的弹窗。

- **「启动两次、间隔 20s」不是我们或多点了一次**：平台客户端每 **20.004s** 重发一次整套启动
  （`kill`（`am force-stop` 本包名）→ `copyfile(setup.xml)` →
  `am start -n com.GoodNet.DeepmindHacker/.MainActivity -d <PC_IP>`），周期见 castlog6 实测与
  `docs/tech/VR+平台版本号实现.md`。
- **那个弹窗不是我们弹的**：它是 PICO XRShell 的**系统弹窗**（标题「退出PICO浏览器」、
  正文「你需要退出当前应用才能继续操作」、按钮「取消 / 退出并继续」），出现条件是
  **除浏览器之外还有 2D 应用想占前台**（immersive 会话期间）。定性见
  `docs/tech/VR+平台版本号实现.md` §22.3。
- ⇒ 我们能控制的只有一件事：**在那一刻绝不让本 APK 产生窗口、绝不发任何前台动作**。

## F.2 为什么「免打扰」路径在二次拉起时会失效（本修要修的就是这个）

第九 / 十五修做的 `computePassThrough`（`平台驱动 + 已拉起过 + 页面仍活` → 换 `NoDisplay` 主题、
不建界面、立刻 finish）方向是对的，但它有两个**只在进程存活时**成立的前提：

| 判据 | 存在哪 | 进程被平台 `kill` 之后 |
|---|---|---|
| `sLaunched` / `sLaunchedAt` | `MainActivity` 静态字段 | **空** |
| `GameServer.lastPageHitMs`（页面心跳） | `GameServer` 实例字段（8080 服务随进程一起死） | **空** |

于是「平台 kill 掉我们 → 紧接着 `am start` 拉起新进程」这一条链路里：新进程判据全空 →
`computePassThrough` 返回 false → 走完整 `guardPass()` 门禁 → 建「正在等待直播端启动…」提示页
（**一个 2D 窗口**）⇒ 玩家正在 VR 里，**弹窗当场出现 + XR 沉浸式会话被挤掉**。
玩家还没进 VR 时同一个动作是无害的（本来就在 2D），这正是「只在 VR 里才看到弹窗」的原因。

## F.3 本轮改动

| # | 改动 | 文件 | 为什么 |
|---|---|---|---|
| 1 | 新增 `PagePresence`：把「页面最后一条请求的时刻 / 状态 / 是否在 XR / 是否待机」写进 **SharedPreferences**（跨进程） | `PagePresence.java`（新） | 新进程唯一能证明「游戏页还在跑」的证据 |
| 2 | 页面每次轮询（`/api/vrplus/inbox?…&xr=&cs=`）与 `/api/page/*` 都刷新这份记录；`GameServer` 新增 `lastPageXr` | `GameServer.java` | 记录要新鲜才有用（写盘节流 0.7s；用 `commit()` 防 `force-stop` 丢证据） |
| 3 | `onCreate` 最前面（`super.onCreate` 之前）读回该记录：`!sLaunched && PagePresence.aliveNow()` ⇒ 置 `sLaunched/sLaunchedAt` | `MainActivity.java` | 让免打扰判据在**新进程**里也成立，走不到 `guardPass()` 那条建窗口的路 |
| 4 | `isGamePageAlive()` / `pageAliveForLaunch()` 末尾补跨进程判据；`computeRelaunchFallback()` 在「平台通道还没握手」时用「上一进程留下 XR 证据」兜底 | 同上 | 判据三处收口，避免任何一处把活着的页面判成失联 |
| 5 | 免打扰分支：**页面在 XR 会话里 → 一个 `startActivity`/顶前台动作都不发**，只 `finish()` | 同上 | 玩家在 VR 里时浏览器就是前台应用，没有「谁被压在下面」的问题；多余的前台动作正是弹窗的触发条件 |
| 6 | 新增 `schedulePassThroughVerify()`：5s 后看「本进程到底有没有收到过页面请求」 | 同上 | 第 3 条放宽了判据，必须有兜底：页面真没了时只在此刻才允许重开浏览器（重开=整页重载，不能提前做） |
| 7 | `onNewIntent`：平台重拉 + 本局仍在跑 ⇒ 立刻收起本页 | 同上 | `singleTask` 下本 Activity 还活着（配置页/提示页）时重拉不会走 `onCreate`，那块 2D 面板同样会顶到前面 |
| 8 | 页面的「判死复核」由 1 轮改成 **2 轮**（各 2.5s） | `src/game/game.js` `_confirmThenGone` | 单轮复核可能恰好落在「APK 正在重启、8080 还没绑上」的窗口里 → 误判「APK 真死」→ 直播模式下 `dispose` 推流 + `about:blank` + 结束 XR 会话 |
| 9 | `initGameUi()` 里补一条诊断：**即将建可见界面**而跨进程记录称游戏页仍在跑时明确留痕 | `MainActivity.java` | 下一轮读留痕即可判定「弹窗是我们的窗口造成的」还是「平台客户端造成」 |

## F.4 判据与边界（别把它改坏）

- `PagePresence.aliveNow()`：**6s 内打过点** → 活着；**90s 内打过点且当时 `xr=1`** → 也活着
  （XR 会话只可能由一个活着的页面持有）；其余一律 false。
- 误判代价不对称：把「已死」当成「活着」→ 什么都不显示（有 5s 兜底复核）；
  把「活着」当成「已死」→ 建 2D 窗口 → 玩家被弹出 VR + 系统弹窗。**故判据一律偏保守**。
- 直播模式（`?cast=1`）同样是跨进程状态，`onCreate` 里从 `cast.pc` 恢复 `sPcConfigured`
  （否则收尾策略会去动推流源）。
- 平台侧的根本解仍是「不要每 20s 重发整套启动」，已写进 `docs/平台对接需求（对平台方）.md` 第 8 条。

## F.5 重打包边界与验收

- 改 `PagePresence.java` / `GameServer.java` / `MainActivity.java` / `src/game/game.js` ⇒ **APK 重打**；EXE 不受影响。
- 验收：平台「启动游戏 → 开始游戏 → 进 VR」之后**什么都不做等 60s**，应看到
  ① 不出现「退出PICO浏览器」弹窗；② 玩家仍在 VR 里；③ 留痕出现
  `跨进程页面在场判据(第二十六修-跨进程页面在场)` 与 `免打扰路径：页面正在 XR 会话中（xr=1）…`。
- 若仍然弹窗，而留痕里**没有**任何 APK 事件 —— 说明那一刻想占前台的是**平台客户端自己**，
  这条只能由平台方改（`docs/tech/VR+平台版本号实现.md` §22.3 的结论）。

---

# 附录 G · 2026-09-24 第二十七修（本局在 VR 中「临时停用平台入口」）

## G.1 第二十六修为什么不够（现场留痕的判决）

第二十六修（附录 F）把「免打扰」做到了极限：`Theme.NoDisplay`、不 `setContentView`、不建任何窗口、
不发任何 `startActivity` / 顶前台动作，只 `finish()` 自己。2026-09-24 14:02 那一局
（build=`…-p26-xr-safe-relaunch`）的留痕显示**还是被弹窗打断了**：

| 时刻 | 留痕 | 判读 |
|---|---|---|
| 14:02:11.621 | `{"ev":"xr-start", … ,"xr":true}` | 玩家已进 VR（开场影片播放中） |
| 14:02:18.241 | `免打扰路径：页面正在 XR 会话中（xr=1）→ 不做任何 startActivity/顶前台动作，只 finish 本页` | 平台第 2 次 `am start` 到达，我们**按设计什么都没做** |
| 14:02:18.330 | `{"ev":"xr-end","st":"intro","byPlayer":false,"idle":false,"vis":"visible"}` | **89ms 后 XR 会话仍然结束**（页面自己还是 `visible`） |
| 14:02:18.644 | `{"ev":"visibility:hidden"}` | 浏览器被挤到后台，此后**再没回到前台** |

⇒ 与 `computePassThrough()` 注释里 18:24:04 那次的结论一致，并被本轮再次证实：
**只要我们的 Activity 被创建（哪怕 NoDisplay + 立刻 finish），PICO 的系统仍会为它建一个
2D 面板/起始窗口并顶到最前** ⇒ 浏览器失去焦点 ⇒ XR 会话结束 ⇒ 玩家被弹出 VR + 系统弹窗
「退出PICO浏览器」。

**我们可控的部分至此已用尽**（不建窗口 + 不发前台动作都做到了）。
剩下的唯一客户端解法是：**不让这一次 `am start` 落到我们身上**。

## G.2 做法：把「平台入口」临时停用

新增 `EntryLock.java`（配 `RecoverActivity` / `EntryFuseReceiver` / `BootReceiver`）：

- 页面每次轮询 `/api/vrplus/inbox?…&xr=1`（≈1s 一次）⇒ `EntryLock.onPageXr(true)` →
  `holdForXr()`：把**平台入口组件** `com.local.webxrcast.MainActivity` 置为
  `COMPONENT_ENABLED_STATE_DISABLED`（`DONT_KILL_APP`，不杀进程、不影响 8080 与平台通道）。
  此后平台那一次 `am start -n …/.MainActivity` 在**包管理器层**就解析失败 ——
  不产生 ActivityRecord、不产生面板/闪屏/弹窗。
- `?xr=0`（退出 VR）⇒ `release()`：立刻恢复。
  不变量：**「入口停用」当且仅当「页面正在 XR 会话里」**。

| # | 改动 | 文件 |
|---|---|---|
| 1 | 新增「停用/恢复平台入口组件」+ 死人开关 + 进程启动自愈 + 心跳复核 | `EntryLock.java`（新） |
| 2 | 页面轮询里的 `xr` 直接驱动停用/恢复 | `GameServer.java`（`vrplusApi` 收口处调用 `EntryLock.onPageXr`） |
| 3 | 进程启动即自愈（没有「页面仍在 XR」的新鲜证据就恢复） | `CastApp.java` |
| 4 | 本局结束（`scheduleClientRestore` 收口）立刻恢复；心跳线程每 5s 复核一次 | `MainActivity.java` |
| 5 | 现场接口：`/api/entry`（状态）/ `/api/entry/unlock` / `/api/entry/lock` / `?on=0|1` | `GameServer.java`（`entryApi`） |
| 6 | 配置页开关 `cbEntryLock`（默认开）+ 状态行 `tvEntryLock` | `activity_main.xml` / `MainActivity.initGameUi` |
| 7 | 人工恢复入口（停用期间才启用，应用列表里那个图标就是它） | `RecoverActivity.java`（新）+ Manifest |
| 8 | 死人开关接收端 / 开机与覆盖安装恢复 | `EntryFuseReceiver.java`、`BootReceiver.java`（新）+ Manifest |
| 9 | 留痕版本标记 | `PageForensics.BUILD_TAG = 2026-09-24-p27-entry-lock` |

## G.3 七道恢复安全网（任何一条命中都会恢复）

| # | 触发 | 实现 |
|---|---|---|
| 1 | 页面退出 VR（`?xr=0`） | `GameServer` 轮询 → `EntryLock.release` |
| 2 | 本局结束（平台 `0x10 closeGame` / 页面 `game-end`） | `MainActivity.scheduleClientRestore` 开头 |
| 3 | 页面打点停止 20s（浏览器没了 / 页面被卸载） | 心跳线程每 5s → `EntryLock.tickRound` |
| 4 | **进程一起动就自愈**（没有新鲜 XR 证据） | `CastApp.onCreate` → `EntryLock.onProcessStart` |
| 5 | **死人开关**：停用期间每收到一条新鲜 XR 打点就续期 60s；60s 内没有新打点 → 无条件恢复 | `EntryLock.rearmFuse` / `EntryFuseReceiver` |
| 6 | 开机 / 覆盖安装（`MY_PACKAGE_REPLACED` 是必须的：组件使能状态会被覆盖安装保留） | `BootReceiver` |
| 7 | **人工恢复入口**：停用期间应用列表里的图标变成 `RecoverActivity`，点一下恢复并打开配置页 | `RecoverActivity` |
| ★ | 现场接口 | `http://<头显IP>:8080/api/entry/unlock`（恢复）/ `/api/entry`（查状态） |

- 第 5 条专门覆盖「进程被系统回收（LMK）」：闹钟属于系统，进程被杀不会丢；
  只有 `am force-stop` 会连闹钟一起取消 —— 那种情形由第 6、7 条兜住。
- 任何时刻应用列表里**恰好有一个可点的入口**：
  正常态 → `MainActivity`（配置页）；停用态 → `RecoverActivity`（恢复入口，点完自动打开配置页）。

## G.4 边界与误判代价

- 本机制**只拦平台那一次 `am start`**，不拦任何别的启动方式；也不影响 8080、VR+ 桥、推流。
- 若换了本版**仍然弹窗**：说明那一刻想占前台的是**平台客户端自己**
  （`com.GoodNet.LauncherClient`），游戏侧无法修复 —— 交平台方
  （`docs/平台对接需求（对平台方）.md` 第 8 条）。
- 若平台用的其实是**不带 `-n` 的隐式 intent**（`-a MAIN -c LAUNCHER`）：**第二十八修起这条已被堵死** ——
  停用期间 `RecoverActivity` 也一起停用，包内 MAIN/LAUNCHER 入口数为 0，平台那一次解析必然失败。
  （第二十七修曾用它当「人工恢复入口」，p27 现场留痕 14:59:17 证明那恰好是**新的靶子** —— 见附录 H。）
- 配置页 `cbEntryLock`（默认勾选）可一键回到第二十六修行为，不用重打包。

## G.5 重打包边界与验收

- 改 `EntryLock` / `RecoverActivity` / `EntryFuseReceiver` / `BootReceiver` / `MainActivity` /
  `GameServer` / `CastApp` / `AndroidManifest` / `activity_main.xml` ⇒ **APK 重打**；EXE 与服务器都不动。
- 验收：
  1. 平台「启动游戏 → 开始游戏 → 进 VR」，**什么都不做等 60s**：① 不弹窗；② 仍在 VR 里；
     ③ 留痕出现 `★ 平台入口已临时停用（页面在 XR 沉浸式会话里（?xr=1））`，
     且**没有**新的 `MainActivity.onCreate 进入`（= 平台那次 `am start` 真的落空了）。
  2. 退出 VR / 平台「结束游戏」后：留痕出现 `平台入口已恢复（…）`，然后再点一次平台「启动游戏」
     必须能正常把游戏拉起来（**不能停用不放**）。
  3. 现场自救（第二十八修口径）：电脑浏览器打开 `http://<头显IP>:8080/api/entry/unlock` → 恢复；
     ⚠ 停用期间应用列表里**没有**本游戏图标（刻意为之，见附录 H）。

# 附录 H · 2026-09-24 第二十八修（本局在 VR 中「包内零入口」）

## H.1 第二十七修为什么还不够（p27 现场留痕的判决）

第二十七修把 `MainActivity` 停用了，但为了让现场能自救，**顺手启用了 `RecoverActivity`**
（应用列表里那个图标）。p27 实测（build=…-p27-entry-lock）留痕：

```
14:59:08.737 [APK] ★ 平台入口已临时停用（页面在 XR 沉浸式会话里（?xr=1））…
14:59:17.418 [APK] ⚠ 平台的 am start 落到了「恢复入口」上 → 说明平台用的是不带 -n 的隐式 intent
14:59:17.618 [PAGE] xr-end st=intro byPlayer=false idle=false vis=visible      ← 200ms 后 XR 又掉了
```

平台那一次启动在 `-n …/.MainActivity` 被拒之后会**退化成隐式 MAIN/LAUNCHER**（或客户端直接调
`getLaunchIntentForPackage`），于是解析到当时**唯一启用**的 `RecoverActivity`；哪怕它按 referrer 判出
「这次是平台拉的」并立刻 finish、不建窗口，**「Activity 被创建」这一件事本身**仍然挤掉了 XR 会话
（与附录 F / G.1 的结论同源）。

⇒ **「包内还剩一个可被隐式意图解析的入口」= 弹窗还在。** 换靶子不解决问题。

## H.2 做法：把「入口数」打到 0

`EntryLock.holdForXr()` 的落地动作：

- 第二十七修：`apply(a, false, true)`（`MainActivity` 停用 + `RecoverActivity` 启用）；
- **第二十八修：`apply(a, false, false)`（两者都停用）。**

不变式收紧为：**「页面在 XR 会话里」⇔「包内 MAIN/LAUNCHER 入口数 = 0」**。平台此后无论用显式组件、
隐式 intent 还是 `getLaunchIntentForPackage`，都只会**解析失败** —— 不产生 ActivityRecord / 窗口 / 面板 / 弹窗。

留痕标记 `第二十八修-包内零入口`；build 标记 `2026-09-24-p28-zero-entry`。

## H.3 恢复路径（六道自动 + 一条人工）

| # | 触发 | 实现 |
|---|---|---|
| 1 | 页面退出 VR（`?xr=0`） | 秒级恢复（正常路径） |
| 2 | 本局结束（平台 `0x10 closeGame` / 页面 `game-end`） | `MainActivity.scheduleClientRestore` 开头恢复 |
| 3 | 页面打点停止 20s | 心跳线程 → `EntryLock.tickRound` |
| 4 | 进程启动（无新鲜 XR 证据） | `CastApp.onCreate` → `EntryLock.onProcessStart` |
| 5 | 死人开关：60s 无新 XR 打点 | `AlarmManager` + `EntryFuseReceiver` |
| 6 | 开机 / 覆盖安装 | `BootReceiver` |
| ★ | **人工（非 Activity 通道）** | 电脑浏览器 `http://<头显IP>:8080/api/entry/unlock`；或重启头显 |

**已知代价**：本局在 VR 里的这几分钟，头显应用列表里**没有本游戏图标**（刻意为之 —— 平台同样点不到）。
出 VR 立刻恢复，故正常操作（进 VR 前选游戏、出 VR 后重启一局）不受影响。

## H.4 平台侧影响与验收

- VR 期间平台那次 `am start` 现在会**失败**：shell 版打印
  `Error: Activity not started, unable to resolve Intent`；应用内 `startActivity` 抛
  `ActivityNotFoundException` ⇒ 已并入 `docs/平台对接需求（对平台方）.md`（第 4 条 + 第 8 条）。
- 验收：
  1. 平台「启动游戏 → 开始游戏 → 进 VR」后**什么都不做等 90s**：① 不弹窗；② 仍在 VR 里；
     ③ 留痕有 `★ 平台入口已临时停用（…）`，且**没有任何** `MainActivity.onCreate 进入`、
     也没有 `⚠ 平台的 am start 落到了「恢复入口」上`。
  2. 平台「结束游戏」或玩家退出 VR 后：留痕有 `平台入口已恢复（…）`；再点一次平台「启动游戏」必须能正常拉起。
  3. 人工恢复演练：电脑浏览器 `http://<头显IP>:8080/api/entry/unlock` → 头显应用列表里图标立刻回来。

# 附录 I · 2026-09-24 第二十九修（本局结束即作废「页面在场记录」）

## I.1 现象与留痕判决（第二场起不来）

第二十八修之后进 VR 不再弹窗 ✔，但现场变成**「第二场起不来，只有第一场正常」**。
p28 留痕（15:45–15:50 连试三次，三次同样）：

```
15:46:20.840 [APK] 收到平台关闭指令 0x10 closeGame                          ← 第一场正常结束
15:46:22.067 [PAGE] {"ev":"DEAD:pagehide"…}                                 ← 浏览器页被卸掉
15:47:02.583 [APK] 跨进程页面在场判据：上一进程最后打点 18s 前 state=playing xr=true → alive=true
15:47:02.599 [APK] 平台重复拉起：判定游戏页仍在 → 免打扰路径：不重开浏览器    ← ❌ 第二场被吞
15:47:07.606 [APK] 免打扰路径复核：页面在打点（age=23173ms）→ 本次重拉零打扰结束 ← ❌ 复核也没拦住
```

平台那次 `am start` 确实到了、我们也进了 `onCreate`，但被**「以为页面还活着」**这条判据直接跳过：
不建界面、不重开浏览器 ⇒ 头显上什么都没发生。三次尝试全部如此（15:47:02 / 15:47:22 / 15:49:13）。

## I.2 根因：为「平台 kill 后重启」设计的规则，在本局结束后变成毒药

- `PagePresence`（附录 F / 第二十六修）的判据是：6s 内有打点 → 活着；**90s 内有打点且当时 `xr=1`** → 也活着。
  后一条是为「平台 kill 掉我们、新进程判据全空」的场景设计的 —— 前提是**这一局还在跑**。
- 但第一场结束时页面是**在 XR 里被杀**的（平台 `closeGame` → 退出策略关浏览器），
  记录里最后一条打点就永远带着 `xr=true` / `state=playing`；而第二场的启动落在 20~40s 后，
  仍在 90s 窗口内 ⇒ `aliveNow()` 判真。
- 免打扰的 5s 复核同样失效：它的判据是 `sServer.lastPageHitMs() != 0`（**有记录**），
  而不是「**刚才**有请求」⇒ 上一局的死页也能过。

## I.3 做法（第二十九修）

| 位置 | 改动 |
|---|---|
| `PagePresence`（新） | 作废标记 `K_DEAD` + `markRoundOver(why)` / `isRoundOver()`；`aliveNow()` 见标记即 `false`；**页面任何一次打点都会撤掉标记**（只影响死页，不影响活页）；`ALIVE_XR_MS` 90s → 45s |
| `MainActivity.restoreClientAndCloseBrowser()` | 退出策略开头 `markRoundOver`（本局结束的**两条路由**——平台 `0x10 closeGame` 与页面 `game-end`——都经过它） |
| `MainActivity.schedulePassThroughVerify()` | 判据「有记录」→「**8s 内真的收到过页面请求**」（`PAGE_FRESH_MS`）；两轮都用同一判据 |
| `GameServer` | `/api/page/dead`（sendBeacon）与 `/api/page/event` 中带 `DEAD:` 的事件 → `markRoundOver` |

**语义边界**：作废标记只影响「下一局要不要按全新一局重开浏览器」，**不动** `K_HIT` / `K_XR`
（`EntryLock.tickRound` 还要用真实打点时刻判断「页面是不是真没了」），也不影响 `EntryLock` 的
「本局在 VR 中＝包内零入口」不变式（附录 H）。

## I.4 验收

1. 连打**两场以上**：第一场结束后（平台「结束游戏」或玩家退出 VR），平台再点「启动游戏」
   → 头显浏览器**重新打开**游戏页（预加载约 10s）→ 能正常进 VR、不再弹窗。
2. 留痕对账：出现 `页面在场记录已作废（本局结束（…））`；
   第二场的 `跨进程页面在场判据` 应显示 `已作废=true → alive=false`，且**不再**出现
   `不重开浏览器` 这类早退。
3. 反向检查（不能过度作废）：页面活着且本局没结束时，平台重拉仍走免打扰路径
   （留痕 `免打扰路径复核：页面在打点（age=…ms）→ 本次重拉零打扰结束`）。

---

# 附录 J · 2026-09-24 第三十修（本局结束上报：实测平台认 **CMD 7**）

## J.1 一分钟结论

平台的「游戏结束」信号是 **CMD 7 `GameStatistics`**（`0x07` + UTF-8 JSON，无长度前缀、无结尾符），
**不是** CMD 6 `GameEnd` —— 后者在整场采集里**从未出现**。平台收到 CMD 7 就**弹结算、且不关游戏**。
⇒ 这正是「告知平台本局结束、但别关游戏」的正解；本轮把它接进 PC 端。

## J.2 现场证据（一局采集，原版 Unity 游戏跑出权威样本）

`E:\AI_Work\WebXR_Capture\20260924-175353\`（`round.pcap` 78868B，17:53:53~18:10:34，
游戏通道 12 帧 / 控制通道 647 帧）：

| 时间 | 方向 | 内容 |
|---|---|---|
| 17:55:05.429 | 平台 → 本机 | `0x05` + 109B StartInfo（`gameId:128`）＝「开始游戏」 |
| 17:55:05.444 | 本机 → 平台 | `0x05` + 118B 确认帧（`flag:1`） |
| **18:10:20.386** | **本机 → 平台** | **`0x07` + 398B（首字节 1 + JSON 397）＝ 本局结束上报** |

平台 `DebugLog\2026-09-24-17-38-22.log` 同一秒：`cmd = 7` → `OnReceiveResultMsg` →
`==PostGameResult=={"gameid":128,"instid":15,"shopid":1,…}` → `游戏计时已暂停: 15:15.24` →
**`游戏结束 场次ID:15 结算类型:正常结算,`**；而 `关闭游戏=128` 出现在 **82 秒之后**，
且是**人点「结束游戏」**触发的（`====ClientSendMsg==…{"cmd":"kill","msgData":"DeepmindHacker"}`）。

另两条实测细节：① `gameid`/`instid`/`shopid` 原版也全发 `0`，平台自己补成 `128/15/1`；
② `gameData` 是**字符串化的 JSON**，平台**原样透传**（别改成嵌套对象发）。

## J.3 实现位置与判据（`tools/cast-pc/main.js` §平台游戏通道）

- `PC_FRAME_GAME_RESULT = 0x07`；`buildGameResultPayload(opts)` 逐字照抄原版样本
  （`curProgress = level+1`、`maxProgress = 关卡总数`）；
- `sendPlatformGameResult(opts, why)` 复用**注册时的同一个 socket**（源端口必须 51124）；
- 触发点：`POST /api/round/end` → `handleRoundEnd`，**仅当本局真被平台开过**（`wasArmed`）才发；
- 开关 `--no-game-result`；自测端点 `POST /api/platform/game-result`（不必打满一整局）；
- 排障：`GET /api/info` → `gameChannel.results` / `lastResultAt` / `lastResultWhy`。

## J.4 现场自测与验收

1. 平台「启动游戏 → 开始游戏」，PC 端 `gameChannel.enabled=true`；
2. 轻量验证：`curl -X POST http://localhost:8443/api/platform/game-result -d {}`
   → 平台界面立刻弹结算，日志出现 `cmd = 7` / `==PostGameResult==` / `游戏结束 场次ID:N`；
3. 完整验证：自然打完一局 → 页面 `POST /api/round/end` → PC 端自动发 CMD 7；
4. ⚠ EXE 必须是**被平台拉起**的，否则游戏通道不启用、上报被跳过（`lastResultWhy` 会写明）。

## J.5 重打包边界

只动 `tools/cast-pc/main.js`（PC 端 EXE）与 `src/game/game.js`（页面多带三个字段）
⇒ **EXE + 页面**重打；APK 与服务端不用动。

## J.6 ★ 修正：上行帧必须带**非回环源 IP**（2026-09-24 现场定案）

第一次现场轻量验证的结论是「发得出去、平台毫无反应」。根因是**目标地址选错**：

- 老 `sendFrame()` 在没有平台 IP 时兜底 `[platIp, '127.0.0.1']` ⇒ 目标成了回环；
- 而内核会把**源地址**也选成 `127.0.0.1`；平台对上行帧做**来源 IP 白名单**校验，直接丢弃，
  只在 `DebugLog` 留一句 `127.0.0.1这个外来IP想连接`；
- 于是同一份日志里 `cmd = 5`（用 `rinfo.address` 回发、源 IP 正常）有 3 次，`cmd = 7` **一次都没有**。

修正：新增 `usableTarget()`（回环 / `0.0.0.0` / `::1` / 空 → 一律视为不可用）与 `platformTargets()`，
按证据强度取**一个**目标，**绝不回退回环**：

| 优先级 | 来源 |
|---|---|
| ① | `PLATFORM_CH.lastFromIp` —— 平台发帧过来的源 IP（收到就记） |
| ② | 启动参数 `--platform` / `argv[1]` 第 3 段 |
| ③ | `primaryLanIp()` —— 本机默认路由网卡地址（UDP `connect` 探出，比 `lanIPs()[0]` 可靠） |

★ ② 也必须过滤：平台给被拉起游戏传的启动参数本身就是 `plstformIP = 127.0.0.1`
（`=StartGame==gamePath==...`），照抄即踩坑。

连带：`0x01` 注册帧同样走 `platformTargets()`，一起修好；`PLATFORM_CH` 增 `platformIp` / `lastFromIp`
供 `/api/info` 排障；`POST /api/platform/game-result` 的响应增 `dest`（实际发往的地址）。

**★ 2026-09-24 现场复测：通过 ✔** —— 修好后重打 EXE，平台界面**立刻出现结算按钮**、且**不关游戏**。
（旁证口径：`127.0.0.1这个外来IP想连接` 平台自身回环流量也会触发，故决定性证据是 `cmd = 7` 0 次 / `cmd = 5` 3 次。）
重打包边界：仅 `tools/cast-pc/main.js` ⇒ **EXE 重打**（页面 / APK / 服务端不动）。
