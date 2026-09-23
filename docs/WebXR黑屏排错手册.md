# WebXR「黑屏但有声音」排错手册

> **读者对象**：手上有一个 WebXR / Three.js 项目，能在某些环境跑通，但换台电脑后「**网页打得开、声音正常、就是黑屏**」。
> 本文自包含，不需要你有本项目的任何上下文，可直接据此在新项目里对照排查。
>
> **结论来源（请务必区分）**：
> - 标 **[实测]** 的条目全部来自本项目（WebXR 打气球 · PICO 4 / 高通 XR2 / Chrome 105 内核 / 桌面 Electron 接收端）的实机对照验证，是可直接采信的结论。
> - 标 **[规范]** 的条目来自平台规范或通用工程推导，**需要你在自己的设备上复验**。
>
> 配套文档：`docs/headset-video-playback.md`（沉浸态播视频）、`docs/cast-architecture.md`（双端链路根因）、`docs/tech/02-调试日志（布局与实现）.md`（取证手段）。

---

## 0. 速查表（先看这张，能省几天）

| 症状 | 真因 | 处置 | 依据 |
|---|---|---|---|
| 进 VR 后**头显全黑**，桌面 2D 预览正常，控制台无报错 | 帧循环用了 `window.requestAnimationFrame` —— immersive 模式下页面 rAF **不触发** | 改用 `renderer.setAnimationLoop(cb)`，且必须**早于** `xr.setSession()` 设置 | [规范] |
| 进了 VR 就黑，且 `renderer.xr.enabled` 没设 | three.js 不会接管 XR 投影/帧提交 | `renderer.xr.enabled = true`（本项目 `world.js:36`） | [实测] |
| 头显全黑但有声音，且代码里有「抓 canvas」逻辑（`captureStream` / `toDataURL` / `readPixels`） | **WebXR 下 three.js 渲染进 XR framebuffer，canvas 默认帧缓冲根本没有内容** | 别抓主 canvas；另建独立离屏 renderer 作为画面源 | [实测] |
| **电脑屏幕上没画面**（镜像/直播黑屏），头显里正常 | 同上：抓主 canvas 抓到的就是空帧 | 同上 | [实测] |
| 电脑端黑屏，且渲染器是 `preserveDrawingBuffer: false` | `captureStream()` / `canvas.toBlob()` 依赖 PDB 才有内容 | 给**离屏**渲染器单独开 PDB（主渲染器不要开） | [实测] |
| 头显里某段画面「**全黑只剩声音**」（如影片阶段） | 视频取帧方案选错：`drawImage` 中转到 canvas 在 XR2 上**取不到帧/取到黑帧** | 改用 `THREE.VideoTexture` 直贴 | [实测] |
| 头显画面**一闪一闪**（每秒数次），进游戏后又好了 | 同一个 `<video>` 被**两个消费者**同时取帧 → 争用解码缓冲 | 保证任何时刻**只有一个**消费者 | [实测] |
| 降分辨率 / 降帧率 / 关 PDB **全都没用**，还是闪 | 瓶颈不在 GPU 侧，在**媒体引擎（VPU）**或**第二个 GL 上下文的存在性** | 停止调参，转向「去掉第二个消费者 / 去掉第二个 GL 上下文」 | [实测] |
| 两端都黑，但**页面文字/UI 在 2D 预览里是好的** | XR 会话或帧循环没跑起来（不是内容问题） | 见 §2.1 / §2.2 | [实测] |
| 头显里能看到准星/腕表/文字面板，**但看不见 3D 场景** | 渲染管线是通的 → 问题在**场景内容**（资源 404 / 相机 / 光照 / 父组隐藏） | 见 §2.4 | [实测] |
| 背景一片纯黑，物体正常 | 天空/背景贴图 404 被**静默兜底**吞掉了 | 查网络面板；别信 `.catch()` 写的「不卡死」 | [实测] |
| 桌面浏览器打开 `http://<内网IP>:端口`，按钮点了没反应 | **非安全上下文** → `navigator.xr` 根本不存在 | 必须 `https://` 或 `http://localhost` | [实测] |
| 内嵌 WebView（App 里的浏览器）里黑屏 | WebView **无 GPU/WebGL** | 游戏必须交给系统浏览器 | [实测] |
| 自签证书 / 头显连 PC 的 https 打不开 | 头显浏览器不信任自签证书，且可能**没有「继续访问」入口** | 头显侧走明文 http + 本地代理；媒体走 WebRTC 的 DTLS | [实测] |
| 编码链路已 `connected`，但**一帧都不出** | 编码器压力策略选错（`maintain-resolution` 在移动芯片上可能一帧不产） | 改回 `balanced` | [实测] |
| 「昨天还好，今天黑」且**没改过代码** | 启动参数/URL 丢了一个开关（例：推流总开关 `?cast=1` 没带上） | 先核对 URL 与配置，再怀疑代码 | [实测] |
| 头显背景黑、但同一个场景在**第二个视角**渲染时背景也黑 | three.js **父组 `visible=false` → 子节点一律不渲染** | 只保留需要的节点（临时 reparent），别整体放开 | [实测] |

---

## 1. 先把「有声音」这条线索榨干

### 1.1 音频链路和渲染链路是独立的

「有声音」不是小事，它一次性帮你**排除掉一大半可能性**。页面能出声，说明：

| 已被证明成立的 | 因此可以排除的怀疑方向 |
|---|---|
| HTML / JS / 模块加载链路是通的 | 服务器 404、资源断流、模块解析失败（`import` 路径写错、ESM 后缀缺失） |
| 主线程 JS **执行到了初始化之后** | 崩在构造函数里、`new World()` 抛异常、白屏级别的早期错误 |
| 音频资源加载 + 解码成功 | 静态资源根路径配错、跨域被拦（音频和图片走同一套 CORS 规则） |
| autoplay 策略被满足（或已静音兜底） | 用户手势解锁问题 |
| 通常 secure context 也成立 | —— 但这个**不能反推**：音视频不需要安全上下文，WebXR 需要。见 §5.1 |

### 1.2 于是故障面被夹到 6 个环节

```
  ① 渲染器初始化  →  ② XR 会话建立  →  ③ 帧循环  →  ④ 渲染目标  →  ⑤ 场景内容  →  ⑥ 合成器/显示
  ────────────────────────────────────┬─────────────────────────   ─────────────┬──────────────
              头显内黑屏优先查这 5 环 │                              镜像侧黑屏优先查这一环
```

**反过来说**：如果**连声音都没有**，不要碰渲染参数——先去查加载与 JS 异常。这是最高频的走错方向。

### 1.3 ★ 第一问：黑的是哪一侧？

这一步**必须先做**，因为两侧的根因树几乎不重叠。不要笼统地说「黑屏」。

| 黑的是 | 记作 | 含义 | 去哪查 |
|---|---|---|---|
| **戴着头显看不见**（头显内一片黑，但电脑上一看其实有画面） | **树 A** | 沉浸侧渲染/合成问题 | §2 |
| **电脑屏幕上没画面**（头显里玩得好好的，PC 大屏/镜像窗黑着） | **树 B** | 取画面/编码/推流问题 | §3 |
| **两端都黑** | **树 C** | 通常是共因（初始化或环境层全挂） | §2 + §5 |

> **术语说明**：本文用「**沉浸侧**」指头显里看到的画面，「**镜像侧**」指电脑屏幕上看到的同一场景（直播接收端、SteamVR 镜像窗、观众机位、缩略图……都是镜像侧）。这样无论你的架构是「PC 接 PCVR 头显」还是「一体机 + PC 大屏」，框架都成立。

**一个 30 秒就能做完的判定动作**：让头显里显示一个必然存在的东西（准星、腕表面板、HUD 文字、测试方块）。

- 连它都看不见 → **渲染管线断了**（§2.1 / §2.2）
- 看得见它、但场景是黑的 → **场景内容问题**（§2.4）
- 头显里正常、电脑上没有 → **树 B**（§3）

---

## 2. 树 A：沉浸侧黑屏（进了 VR，看不见画面）

### 2.1 帧循环：头号嫌疑

**[规范]** Three.js 在 WebXR 下**必须**用 `renderer.setAnimationLoop()` 驱动渲染循环，不能用自己的 `requestAnimationFrame` 递归。

原因：进入 `immersive-vr` 后，浏览器把**页面级 rAF 与合成器交给 XR 运行时接管**，帧的提交由 XR 会话决定。自己写的 `requestAnimationFrame(loop)` 在沉浸态下**不会按预期触发**——表现就是「进 VR 变黑、有声音、控制台干干净净」。

**正确姿势**（顺序也有讲究）：

```js
// ① 渲染器打开 XR 开关
renderer.xr.enabled = true;

// ② 先设好帧循环（本项目 main.js:511 —— 它在模块顶层就注册好了，
//    比用户点击「进入 VR」更早；用 setAnimationLoop 注册的循环在 2D 与 VR 两种状态下都生效）
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  update(dt);
  renderer.render(scene, camera);
});

// ③ 用户手势里再申请会话
const session = await navigator.xr.requestSession('immersive-vr');
await renderer.xr.setSession(session);     // ← 必须 await
```

本项目 `src/main.js:397-425` 的完整进 VR 流程（含设备兼容降级）：

```js
async function enterVR() {
  if (enterVRBtn.disabled) return;
  enterVRBtn.disabled = true;
  try {
    if (!navigator.xr) throw new Error('浏览器不支持 WebXR（需 https 或 localhost + 支持 WebXR 的头显浏览器）');

    let session;
    try {
      if (navigator.xr.isSessionSupported) {
        const ok = await navigator.xr.isSessionSupported('immersive-vr');
        if (!ok) throw new Error('设备不支持 immersive-vr');
      }
      session = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'] });
    } catch (e) {
      // PICO 兼容：带 requiredFeatures 失败则无参回退
      console.log('使用 PICO 兼容模式:', e.message);
      session = await navigator.xr.requestSession('immersive-vr');
    }

    await world.renderer.xr.setSession(session);
  } catch (err) {
    showStatus('❌ ' + err.message, true);
  }
}
```

**两个容易漏的点**：

1. `requestSession` 的 `requiredFeatures` **会导致整次申请失败**（而不是降级）。`local-floor` 在部分设备上不支持 → 抛 `NotSupportedError` → 按钮卡住。所以必须写「带参失败 → 无参重试」的兜底。
2. `renderer.xr.setSession()` 是**异步**的，不 await 会导致头几帧用错误的投影矩阵渲染。

### 2.2 会话是「建立了」还是「建立了但没渲染」

**[规范] 判据**：`session` 上的事件能告诉你它到底走到了哪一步。

```js
session.addEventListener('end', () => console.log('[xr] session ended'));
renderer.xr.addEventListener('sessionstart', () => console.log('[xr] started'));
```

| 出现 | 说明 | 下一步 |
|---|---|---|
| `sessionstart` 都没出现 | 会话没真正建立 | 查 §5（环境层：secure context / runtime） |
| 有 `sessionstart`，但画面黑 | 会话在，渲染没进眼睛 | 查 §2.3 渲染目标 |
| 有 `sessionstart` + 头显短暂亮一下就黑 | 首帧渲染了，后续帧没跟上 | 查 §2.1 帧循环 |

**[实测]** 本项目还在 `sessionend` 上挂了「回到菜单」的逻辑——因为**会话被别的应用抢走**时，玩家看到的就是「忽然黑屏/被弹出」。如果你在 PCVR 上遇到「玩着玩着突然黑」，先确认是不是 SteamVR / 其他应用抢了会话，而不是自己的渲染坏了。

### 2.3 ★ 渲染目标：本项目最硬的一条实证

> **WebXR 沉浸式下，three.js 渲染进的是 XR framebuffer，canvas 的默认帧缓冲根本没有内容。**
> 所以任何「从 canvas 取画面」的做法，在沉浸态下**必然拿到黑帧或空帧**。

这条在本项目里是**写在源码注释里的血泪教训**（`src/core/constants.js:586-596` 原文）：

```
// 直播推流（?cast=1 才启用；不带该参数时完全零开销）
//   做法：另建「观众相机」+ 独立离屏 canvas 渲染一路画面，再推给 PC 端接收程序。
//   为什么不直接抓主 canvas：
//     1) WebXR 沉浸式下 three.js 渲染进 XR framebuffer（vendor/three.module.js:29740），
//        canvas 默认帧缓冲根本没内容，captureStream 抓出来是黑的；
//     2) captureStream() 依赖 WebGL 的 preserveDrawingBuffer:true，而主 renderer
//        （world.js:33）未开启，改开会拖累 VR 每帧带宽。
//   离屏 renderer 自己开 preserveDrawingBuffer（640×360，代价可忽略），
//   且其 xr.enabled 保持默认 false → 完全不触碰 XR 渲染状态，直播崩了游戏照跑。
```

**这条同时解释了树 A 和树 B 的黑屏**。凡是命中下面任一特征的项目，几乎必然中招：

- 用了 `canvas.captureStream()` 做推流 / 录屏 / 副屏
- 用了 `canvas.toDataURL()` / `toBlob()` 截图
- 用了 `gl.readPixels()` 读回像素
- 用了 `drawImage(mainCanvas, ...)` 拷贝主画面

**正确解法：另建一个独立离屏渲染器作为画面源。**

```js
// 离屏（镜像侧）渲染器：与主渲染器完全解耦
const offCanvas = document.createElement('canvas');
offCanvas.width = 960; offCanvas.height = 540;

const offRenderer = new THREE.WebGLRenderer({
  canvas: offCanvas,
  antialias: false,
  preserveDrawingBuffer: true,     // ← 只在这里开（异步读回像素需要）
});
offRenderer.xr.enabled = false;    // ★ 关键：绝不接管 XR 渲染状态
// 用观众相机渲染同一个 scene
offRenderer.render(scene, spectatorCamera);
```

**三条必须遵守的边界**（本项目实测）：

1. `offRenderer.xr.enabled` **保持 false** —— 完全不触碰 XR 渲染状态，镜像链路崩了游戏照跑。
2. `preserveDrawingBuffer` **只给离屏渲染器**开。主渲染器开它会拖累 VR 每帧带宽（本项目 `world.js:33` 主渲染器就是故意不开的）。
3. 离屏渲染器的分辨率**不要超过主视角**（本项目从 1280×720 退到 960×540，因为「离屏重渲染吃 GPU」）。

### 2.4 场景内容自身不可见（渲染通了，但什么都没有）

如果头显里**能看到 HUD/准星/文字面板**，说明渲染管线是好的——那问题不在 WebXR，在你的场景。按下面顺序查：

**(1) 资源 404 被静默兜底吞掉** ⚠ 本项目真实案例

本项目有一段看起来「很稳健」的代码（`src/main.js:85-88`）：

```js
const skyTasks = skyUrls.map((u) => world.loadSky(u, /* 进度回调 */)
  .then(() => { skyFrac[u] = 1; })
  .catch(() => { skyFrac[u] = 1; }));   // ← 单张失败不卡死
```

后果：某两关的全景图文件被删了，代码**一声不吭**地把它们退化成渐变天空。现场表现只是「感觉这两关天空不太对」，**没有任何报错、没有 404 弹窗**。

> **教训**：`.catch(() => 1)` 这类「不卡死」兜底是必要的，但**必须留痕**（`console.warn` + 一个可见的兜底标记）。否则它会把「资源丢失」变成一条查不出来的幽灵 bug。

**排查动作**：打开网络面板，筛 `404`；或把资源加载的失败分支改成显式告警。

**(2) 父组 `visible = false` → 子节点一律不渲染** ⚠ 本项目真实案例

```js
// world.js:92 —— 天空球挂在一个组里
this.ambient.add(this.sky);
```

three.js 的规则：**父组不可见，其所有子节点一律不渲染**。所以：

```js
ambientGroup.visible = false;   // 想让背景变黑
sky.visible = true;             // ← 完全无效！父组都不可见了
```

本项目踩这个坑的表现是「**镜像侧**等待房间阶段纯黑、没有任何背景」。处置是**把需要的节点临时 reparent 到 `scene` 根**，渲染完再挂回：

```js
scene.add(sky);                     // 临时搬出来
renderer.render(scene, cam);
ambientGroup.add(sky);              // 立刻挂回
```

⚠ 但**不要图省事把整个组打开**（`ambientGroup.visible = true`）——本项目那个组里挂着**几百个标注 Sprite，各自持有独立 CanvasTexture**，全进第二个 GL 上下文会吃光 GPU，反而让头显开始闪。

**(3) 相机问题** —— 相机在几何体内部 / `near` `far` 设错 / 位置在原点之外。判据：2D 预览能看见、进 VR 看不见 → 多半是**相机 rig 挂错了**（头显姿态更新的是 XR 相机，不是你自己 new 的那个）。

**(4) 光照缺失** —— 全黑但 UI 正常，且用了 `MeshStandardMaterial` 之类需要光照的材质，却没有加任何 Light。判据：临时换成 `MeshBasicMaterial` 是否能看见。

### 2.5 多消费者 / 第二个 GL 上下文 / VPU 争用

这是本项目花掉最多调试时间的一类问题，**而且它的特征极其反直觉：调分辨率、调帧率、关 `preserveDrawingBuffer` 全部无效**。

**(1) 单消费者原则** [实测]

> **同一个 `<video>`（或同一份解码输出），任何时刻只允许一个消费者取帧。**

| 取帧组合 | 后果 |
|---|---|
| 两个 WebGL 上下文**各建一个 `VideoTexture`** | 双方交替拿到已释放的缓冲 → **闪烁** |
| `drawImage`（离屏中转）+ `VideoTexture`（主视角）混用 | 互抢当前帧 → 头显闪 **且** 镜像侧常被抢空 → **黑屏** |
| `drawImage` 作唯一消费者、两侧共用同一张 `CanvasTexture` | 理论最优，但 **XR2 上直接取不到帧** → 头显里**全黑、只剩声音** |

**(2) 第二个 WebGL 上下文「存在本身」就是干扰源** [实测]

本项目做过一组决定性对照：**已暂停推流**（镜像侧画面静止 = 确实没在编码）的前提下，头显**照闪不误**。

| 阶段 | 头显 | 镜像侧 |
|---|---|---|
| 预览菜单 / 等待房间（未播影片） | **1 秒闪 2 次** | 画面静止 |
| 影片播放中 | 约 5 秒黑屏一次 | 黑屏、约 1fps |
| 进关卡游玩 | 正常 | 正常 |

镜像侧画面静止证明「没在编码」，可头显照闪 ⇒ **干扰不止来自编码**。只要第二个 GL 上下文存在（哪怕不渲染、不抓帧），移动芯片的合成调度就被扰动。

→ **解法**：**延迟创建**。预览/影片阶段**根本不创建**离屏 canvas/renderer，等到真正开始游玩时才 `_ensureOffscreen()`（本项目 `cast.js:172`）。

**(3) 「解码 × 编码」争用同一媒体硬件块（VPU）** [实测]

移动 SoC 上，视频解码与 H.264 编码可能**共用同一个硬件块**。三者交叉实测：

| 条件 | 视频解码 | H.264 编码 | 头显闪？ |
|---|---|---|---|
| 开推流 + 影片阶段 | ✅ | ✅ | **闪** |
| 开推流 + 游玩阶段 | ❌ | ✅ | 不闪 |
| 关推流（去掉 `?cast=1`）+ 影片阶段 | ✅ | ❌ | 不闪 |

→ 只有「解码 × 编码」同时存在才闪。解法是**影片期间不编码**：推流暂停，镜像侧改播**本地同一段影片**，用信令对齐开始/结束。

> **这三条独立证据链缺一条都可能误判**：
> ① 去掉推流开关 → 不闪 ⇒ 与推流有关；
> ② 开推流 + 进游戏（无解码）→ 不闪 ⇒ 与「解码×编码」有关；
> ③ 推流已暂停 + 预览阶段 → 仍闪 ⇒ 与「第二个 GL 上下文存在」有关。

**(4) 已证伪的方向（别再试）** [实测]

降分辨率、降帧率、关 `preserveDrawingBuffer`、加异步、换代理、调 `degradationPreference` 之外的花样——
**这些动的都是 GPU 侧开销，而根因是 VPU 争用 + GL 上下文存在性**。本项目用户实测「闪烁频率毫无变化」。

### 2.6 设备与运行时层（PCVR 特有）

以下是 **[规范]** 层面的，在你的设备上要自己复验：

| 检查项 | 怎么查 | 不通过的表现 |
|---|---|---|
| VR 运行时是否在跑 | SteamVR / OpenXR runtime 是否已启动 | 申请会话失败，或会话建立但**合成器拿不到帧** → 黑屏 |
| 浏览器是否真的在用独显 | `chrome://gpu` 看「WebGL」「WebGL2」是否 Hardware accelerated | 落到 **SwiftShader 软件渲染** → 极慢，甚至直接黑 |
| 混合显卡笔记本 | Windows 图形设置里把浏览器指定为独显；或 BIOS 关核显 | WebGL 上下文创建失败 / 头显画面黑而桌面正常 |
| GPU 驱动黑名单 | `chrome://gpu` 是否有 "disabled" / "blocklisted" | 同上 |
| 硬件加速是否被关 | 浏览器设置 → 系统 → 硬件加速 | 同上 |
| WebXR 是否被 flag 关掉 | `chrome://flags` 搜 webxr / openxr | `navigator.xr` 存在但 `isSessionSupported` 恒 false |

> **最短的自检路径**：先把下面这段贴进控制台，一眼看出环境到底支不支持。
> ```js
> console.log({
>   secure: window.isSecureContext,                       // 必须 true
>   hasXR: !!navigator.xr,                                // 必须 true
>   immersiveVR: await navigator.xr?.isSessionSupported('immersive-vr'),
>   webgl2: !!document.createElement('canvas').getContext('webgl2'),
> });
> ```

---

## 3. 树 B：镜像侧黑屏（头显正常，电脑上没画面）

镜像侧（直播接收端 / SteamVR 镜像窗 / 观众机位）看不到画面，按这个顺序查。

### 3.1 先确认画面源对不对（回到 §2.3）

**如果镜像侧的画面源是「抓主 canvas」，那它 100% 是黑的**——这是本项目最核心的一条结论，见 §2.3。先排除这一条，再往下查。

### 3.2 编码器是否真的在出帧

**[实测]** 判据是**帧计数**，不是「连接状态」。

```
连接状态 connected  ≠  有画面
```

| 现象 | 真因 | 处置 |
|---|---|---|
| 已 `connected`，收帧诊断 `已解码=0` 且长时间不涨 | 编码器**一帧都不产** | `degradationPreference: 'maintain-resolution'` **会导致移动芯片编码器一帧不出** → 改回 `balanced`（浏览器默认策略） |
| 帧数在涨但画面是纯色/黑 | 渲染源本身是黑的（回 §3.1） | —— |
| 帧率极低（5~6 秒一帧） | 走了 **CPU 软编码**（如 `canvas.toBlob` 出 JPEG） | 换硬件编码（WebRTC H.264）；本项目实测「降分辨率/加异步/换代理全无效，瓶颈是编码方式本身」 |

### 3.3 推流/推画面链路自己没开

**[实测]** 「昨天还好、今天黑」，且**代码一行没改** —— 优先怀疑**参数/开关丢了**。

本项目刚发生过一次典型故障：游戏能玩、授权正常、配置下发正常，**只有镜像侧全黑**。真因是：

```
第 1 次拉起浏览器 URL=http://localhost:8080/?plat=1     ← 少了 cast=1 和 pc=
```

页面地址里丢了一个**推流总开关**，`createCast()` 直接返回 `NOOP_CAST`（零开销、完全不推流）。而门禁、授权、配置全部正常，所以**从 PC 端看一切健康**，只有画面没有。

> **教训**：把「画面源开关」做成 URL 参数时，它就成了一个**静默失败点**。要么给它加一个显式日志（「推流已启用/已跳过」），要么别让它能悄悄丢。
> 另外——**判据不要挂在「发现机制」上**。本项目那次故障的深层原因是：推流目标地址只由 UDP 信标发现来赋值，信标一旦没到就退化成「不带地址的默认 URL」。**发现手段 ≠ 判据本身**。

### 3.4 链路层（信令 / 网络 / 静态资源）

| 检查项 | 现象 | 处置 |
|---|---|---|
| 接收端**一条请求都没有** | 现代 Chrome 的 **PNA**（Private Network Access）在连接建立前就拦掉 | 所有接口 + 预检 OPTIONS 都回 `Access-Control-Allow-Private-Network: true` |
| 有连接、没有 offer | 发送端没连信令 / 应用内 WebView 没停掉（两个 publisher 抢槽） | 关掉内嵌 WebView 再跳浏览器 |
| `ICE failed` | P2P 通道不通 | 关防火墙 / 确认同网段 / 兜底链路 |
| 静态资源 404 | 接收端未配置游戏根目录，影片/贴图取不到 | 配置目录并重启；看日志里的 404 |

---

## 4. 树 C：两端都黑

两端同时黑，说明是**共因**，按这个顺序收敛：

1. **先看 2D 预览（桌面浏览器打开同一页面）是否正常。**
   - 2D 预览也黑 → 问题在**渲染器/场景**（§2.4），跟 VR 无关。
   - 2D 预览正常、只有 VR 黑 → **帧循环或 XR 会话**（§2.1 / §2.2）。
2. **再看 `window.isSecureContext` 与 `navigator.xr`**（§5.1）。
3. **最后看 GPU**（§2.6）。

> 「2D 预览」是**性价比最高的诊断手段**——它把变量从「VR 环境」缩回「纯浏览器渲染」，一次就能把问题劈成两半。

---

## 5. 环境层：违反必然黑的三条硬约束

### 5.1 安全上下文（Secure Context）—— `navigator.xr` 的生死线

**[实测]** 页面 origin **必须是 `https://` 或 `http://localhost`**（含 `127.0.0.1`）。
用 `http://192.168.x.x:端口` 打开，**`navigator.xr` 直接不存在** → 连申请会话的机会都没有。

本项目为此付出了架构级代价：头显侧**不能直连 PC 的地址**，必须由设备本地起一个 `http://localhost:8080` 代理，页面从这个 origin 加载。

**判据**：

```js
if (!window.isSecureContext) console.error('非安全上下文 → WebXR 不可用');
if (!navigator.xr) console.error('navigator.xr 不存在（非 https/localhost，或浏览器不支持）');
```

> **[实测] 反例存档**：把 `http://<PC_IP>:8443/?cast=1` 直接在 PICO 浏览器里打开，页面会退化成**桌面模式**——`navigator.xr` 不暴露。这与「服务器挂了」的表现很像，其实完全不是一回事。

### 5.2 HTTPS 不是万灵药：自签证书在头显上没有「继续访问」

**[实测]** 头显浏览器（至少 PICO 的）**不信任自签证书，且通常没有「继续访问」入口**。所以「给 PC 端配个自签证书走 https」这条路在头显侧走不通。

本项目的取舍：

| 链路 | 协议 | 理由 |
|---|---|---|
| 头显 ↔ PC 信令（HTTP `/api/*`） | **明文 HTTP** | 头显不信任自签证书，明文反而是唯一可用方案 |
| 媒体（WebRTC） | **DTLS 加密** | WebRTC 天然加密，明文信令不漏媒体内容 |
| 头显内的页面 origin | `http://localhost:8080` | 满足 WebXR 安全上下文要求 |

### 5.3 内嵌 WebView ≠ 浏览器

**[实测]** 移动头显的**内置 WebView 没有 GPU/WebGL**，跑完整 3D 游戏会在 `new World()` 阶段直接抛 `WebGL context could not be created`。

**正确架构**：WebView 只跑「最小的探测/代理页」，真正的游戏页面交给**系统浏览器**打开。

> **[实测] 相关坑**：Android 11+（`targetSdk ≥ 30`）下如果没在 `AndroidManifest.xml` 里声明 `<queries>`，`Intent.setPackage("...browser")` 会抛 `ActivityNotFoundException`，然后**静默落到系统默认浏览器（CustomTabs）**——而那个浏览器往往不支持 WebXR，结果就是「浏览器打开了、页面加载了、但建不出 WebGL」。表现同样是黑屏。

---

## 6. 取证：三个「不用猜」的手段

### 6.1 ★ 屏上诊断条 / 头显内日志面板

**[实测] 沉浸态下 DOM 不可见** —— 这是本项目的一条硬约束：进了 VR，`<div>` 再怎么 `position: fixed`、`z-index: 9999` 都不参与头显合成。

所以「看不到日志」本身就是第一个要解决的问题：

| 方案 | 做法 | 适用 |
|---|---|---|
| 头显内 3D 面板 | 把日志画成纹理贴到一块跟着手/视野的 mesh 上 | 沉浸态调试的唯一可靠手段 |
| 屏上诊断条（纹理化） | 用 `CanvasTexture` 把状态行贴到视野角落 | 轻量，够用 |
| 2D 预览页 | 退出 VR 看桌面上的页面（如果 2D 路径正常） | 只能覆盖非 VR 部分 |

**最少要打出来的字段**：`readyState` / 实际尺寸 / 累计帧数 / 最近错误 / 当前 `state`。

> **[实测] 日志版本指纹**：多轮调试时，**先验证你手上的日志来自当前构建**。看字段名是否与源码一致、看文件 mtime 与产物 mtime。拿旧日志去确认新修复 = 白跑一轮，甚至会把已修好的问题当成新 bug 继续查。

### 6.2 免 adb 的留痕端点（本项目做法，强烈推荐）

在设备侧起一个小 HTTP 服务，把日志写到文件并暴露一个下载端点：

```
http://<设备IP>:8080/api/page/forensics?download=1
```

**好处**：不需要连 adb、不需要电脑在旁边，只要同局域网就能取证。而且**游戏端自己打的日志（预览/影片阶段→暂停推流、预热链路已启动、离屏渲染均耗时 X ms/帧）全在里面**——这类日志往往能一次性定案，不用再推理。

### 6.3 帧诊断计数器

镜像侧每几秒打一行：

```
收帧诊断 960x540 已解码=N 丢帧=M
```

- `N` 恒为 0 → **编码器没出帧**（回 §3.2）
- `N` 在涨但画面黑 → **画面源是黑的**（回 §3.1）
- `M` 很大 → 网络/解码跟不上

---

## 7. 本项目已验证的正确做法（可直接抄）

### 7.1 Three.js WebXR 初始化清单

```js
// ① 渲染器
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: false,
  powerPreference: 'high-performance',   // 混合显卡笔记本上更可能选中独显
  // preserveDrawingBuffer: 不要开（只在离屏/截图渲染器上开）
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.0));  // 移动端降采样
renderer.setSize(window.innerWidth, window.innerHeight);

// ② XR 开关
renderer.xr.enabled = true;
renderer.xr.setFramebufferScaleFactor(1.25);   // 1.5 在重场景上会掉帧

// ③ 帧循环（必须 setAnimationLoop，且早于 setSession）
renderer.setAnimationLoop(() => { update(); renderer.render(scene, camera); });

// ④ 会话（先探测、再申请、失败降级）
if (!window.isSecureContext) 报错('需要 https 或 localhost');
if (!navigator.xr) 报错('浏览器不支持 WebXR');
const ok = await navigator.xr.isSessionSupported('immersive-vr');
if (!ok) 报错('设备不支持 immersive-vr');
let session;
try   { session = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'] }); }
catch { session = await navigator.xr.requestSession('immersive-vr'); }   // 降级重试
await renderer.xr.setSession(session);                                    // 必须 await

// ⑤ 会话结束要有善后（否则状态残留，下次进 VR 就是黑的）
renderer.xr.addEventListener('sessionend', () => { /* 回菜单 / 复位状态 / 恢复按钮 */ });
```

### 7.2 双视角（沉浸 + 镜像）渲染清单

- [ ] 镜像侧**不要**抓主 canvas（§2.3）
- [ ] 另建离屏 `WebGLRenderer`，`xr.enabled = false`，独立相机、独立 canvas
- [ ] `preserveDrawingBuffer` **只给离屏渲染器**开
- [ ] 离屏分辨率**不高于**主视角
- [ ] **延迟创建**：只在真正需要出画面的阶段创建离屏渲染器（§2.5）
- [ ] 离屏渲染**不破坏主场景状态**（临时改动的材质/可见性，必须在 `finally` 里还原）

### 7.3 视频相关

- [ ] 用 `THREE.VideoTexture` 直贴，**不要**用 `drawImage` 中转（§2.5）
- [ ] 同一个 `<video>` **只有一个消费者**
- [ ] `texture.colorSpace = THREE.SRGBColorSpace`（否则画面发灰）
- [ ] 自动播放：`play().catch()` 里**静音重试** + 首次手势解锁
- [ ] 三重兜底：`ended` / `error` / 看门狗超时，**三者都要能推进流程**
- [ ] 释放要用 `pause()` + `removeAttribute('src')` + `load()` 才真正回收解码器

---

## 8. 失败尝试黑名单（别再走一遍）

这些都是本项目**实测无效**或**验证过更糟**的方向，列出来是为了让你少花时间：

| 尝试 | 结果 |
|---|---|
| 降分辨率 / 降帧率 / 关 `preserveDrawingBuffer` 来治闪烁 | **[实测] 完全无效**——瓶颈是 VPU 争用与 GL 上下文存在性，不是 GPU 侧开销 |
| 用 `drawImage` 中转到 canvas 作为唯一消费者 | **[实测] XR2 上取不到帧** → 头显全黑只剩声音。加 2.5s 自愈回退也只能补救、不能根治 |
| 抓主 canvas 做推流/截图 | **[实测] 沉浸态下必然黑**（渲染进 XR framebuffer） |
| 打开 `ambientGroup.visible = true` 来保留背景 | **[实测] 组内几百个 Sprite（各自独立 CanvasTexture）全进第二个 GL 上下文 → 头显开始闪** |
| `degradationPreference: 'maintain-resolution'` | **[实测] 移动芯片编码器一帧都不产** → 镜像侧全程黑屏 |
| CPU 软编码（`canvas.toBlob` 出 JPEG）当主链路 | **[实测] 单帧长达 5~6 秒**，降分辨率/加异步/换代理全无效 |
| 给头显配自签证书走 https | **[实测] 头显不信任、无「继续访问」入口** → 走不通 |
| 在应用内 WebView 里跑完整 3D 游戏 | **[实测] WebView 无 GPU/WebGL** → 建不出上下文 |
| 靠「发现机制」（如 UDP 信标）决定画面源地址 | **[实测] 发现失败会导致地址静默退化 → 页面完全不推流，而其他一切正常** |

---

## 9. 上线前检查清单

**环境**

- [ ] 页面 origin 是 `https://` 或 `http://localhost`（`window.isSecureContext === true`）
- [ ] `navigator.xr` 存在，`isSessionSupported('immersive-vr')` 返回 true
- [ ] `chrome://gpu` 显示 WebGL 硬件加速（不是 SwiftShader）
- [ ] 混合显卡机器已指定用独显
- [ ] VR 运行时（SteamVR/OpenXR）已启动

**渲染**

- [ ] 用的是 `renderer.setAnimationLoop()`，不是自写的 rAF 递归
- [ ] `renderer.xr.enabled = true`，`setSession()` 已 await
- [ ] 会话结束后有善后逻辑，能干净地再进一次
- [ ] 头显里能看到 HUD/准星（证明渲染管线通）
- [ ] 场景资源无 404，且失败分支**有告警**（不是静默兜底）
- [ ] 没有「父组不可见但子节点想显示」的写法

**镜像/推流**

- [ ] 画面源不是主 canvas（用了独立离屏渲染器）
- [ ] 离屏渲染器 `xr.enabled = false`
- [ ] 帧诊断计数在涨（`已解码 > 0`）
- [ ] 编码策略是 `balanced` 类，不是 `maintain-resolution`
- [ ] 推流开关有显式日志，能看出「启用/跳过」

**黑屏三连测（每次改完都跑）**

- [ ] **2D 预览**：桌面浏览器打开同一页面 → 正常？
- [ ] **无推流**：去掉推流开关 → 头显还黑吗？（分离「渲染问题」与「推流干扰」）
- [ ] **无视频**：删掉视频文件/跳过视频阶段 → 还黑吗？（分离「解码×编码」与「渲染」）

---

## 附：一页纸决策树

```
黑屏（但有声音）
│
├─ 先问：黑的是哪一侧？
│   ├─ 头显里黑 ────────────────────────► 树 A
│   ├─ 电脑上黑 ────────────────────────► 树 B
│   └─ 两端都黑 ────────────────────────► 先跑「2D 预览」劈开问题
│
├─ 树 A（头显黑）
│   ├─ 桌面 2D 预览也黑 ───────────────► 场景内容问题（§2.4）
│   │    ├─ 资源 404？父组隐藏？相机？光照？
│   ├─ 2D 正常、只有 VR 黑 ────────────► XR 管线问题
│   │    ├─ 用了 requestAnimationFrame？ ────► 换 setAnimationLoop（§2.1）
│   │    ├─ xr.enabled / setSession 时序？ ──► 修（§2.2）
│   │    └─ 有第二个 GL 上下文 / 视频多消费者？ ► 去掉（§2.5）
│   └─ 头显里能看到 HUD 但场景黑 ──────► §2.4
│
├─ 树 B（电脑上黑）
│   ├─ 画面源 = 抓主 canvas？ ─────────► 必然黑，换离屏渲染器（§2.3）
│   ├─ 帧计数恒 0？ ───────────────────► 编码器策略 / 编码方式（§3.2）
│   └─ 接收端一条请求都没有？ ─────────► PNA / CORS / 网络（§3.4）
│
└─ 环境层（任一不满足都必然黑）
    ├─ isSecureContext === false ──────► 换 https 或 localhost（§5.1）
    ├─ navigator.xr 不存在 ────────────► 同上 / 浏览器不支持（§5.1）
    ├─ 在 WebView 里跑 ────────────────► 换系统浏览器（§5.3）
    └─ chrome://gpu 显示软件渲染 ──────► 修 GPU（§2.6）
```

---

## 修订记录

| 日期 | 内容 |
|---|---|
| 2026-09-22 | 首版。基于「双端直播 + 视频阶段闪烁 + 推流地址静默退化」三轮实测经验整理。 |
