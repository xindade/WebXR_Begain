# 在 VR 头显里播放视频：WebXR + Three.js 知识点与避坑手册

> **读者对象**：没有本项目上下文的 AI / 开发者。本文自包含，可直接据此在新项目落地。
> **实测环境**：PICO 4（高通 XR2 / Adreno，tile-based GPU）+ 系统浏览器 Chrome 105 内核，WebXR `immersive-vr`。
> **结论来源**：全部为实机验证，非推测。标「实测」的条目都做过对照实验；标「理论」的条目是通用规范推导。
> **范围**：只讲「头显里怎么把一段视频放出来」。直播推流相关的内容见文末「边界说明」。

---

## 0. 结论速览（先看这张表）

| # | 知识点 | 一句话结论 |
|---|---|---|
| 1 | 渲染方式 | immersive 模式下 DOM 不可见，**必须把视频当纹理贴到 3D 物体上** |
| 2 | 取帧方案 | 默认用 `THREE.VideoTexture`；`drawImage` 中转方案在 PICO 上**取不到帧**（黑屏有声音） |
| 3 | **单消费者原则** | 同一个 `<video>` 被两个消费者同时取帧 → 争用解码缓冲 → **闪 / 黑**。任何时刻只允许一个消费者 |
| 4 | 自动播放 | 带音轨的 `play()` 必被拦 → `catch` 里静音重试 + 首次手势解锁 |
| 5 | 防软锁 | `ended` / `error` / 看门狗超时 **三者都要**能推进流程，缺一个就可能卡死 |
| 6 | 宽高比 | 在 `loadedmetadata` 后按 `videoWidth / videoHeight` 重算平面尺寸，**否则拉伸变形** |
| 7 | 色彩 | `texture.colorSpace = THREE.SRGBColorSpace`，否则画面发灰 |
| 8 | 释放 | `pause()` + `removeAttribute('src')` + `load()` 才真正回收解码器 |
| 9 | 背景处理 | 隐藏背景用「整体隐藏组」，但 three.js **父组不可见则子节点一律不渲染**（会影响同时渲染的第二视角） |

---

## 1. 第一原则：immersive 模式下 DOM 不可见

进入 `immersive-vr` session 后，**页面 DOM 不参与头显合成** —— `<video>` 标签再怎么 `position: fixed`、`z-index` 拉满，在头显里都看不见。

所以只有两条路：

| 路线 | 做法 | 适用 |
|---|---|---|
| **纹理路线** ✅ | 把视频帧作为 `THREE.Texture` 贴到 `PlaneGeometry` / 球面 / 任意 mesh 上 | VR 内唯一可行方案 |
| DOM 覆盖层 ❌ | 绝对定位一个 `<video>` | 仅桌面 2D 预览模式可用；进 VR 即消失 |

**结论**：VR 里播视频 = 解决「如何把 `<video>` 的帧喂给一个 Three.js 材质」。

---

## 2. 三种取帧方案对比（关键选型）

| 方案 | 做法 | 优点 | 缺点 / 实测结果 |
|---|---|---|---|
| **A. `VideoTexture`** | `new THREE.VideoTexture(video)` 直接当 `map` | 零拷贝、最省、渲染器自动逐帧刷新，**无需手动 `needsUpdate`** | 与其它消费者争用（见第 3 节） |
| **B. 2D 中转 canvas** | `ctx.drawImage(video,…)` → `new THREE.CanvasTexture(canvas)` | 一张 canvas 可被**多个 GL 上下文共享**，理论上是多视角场景的正解 | ❌ **PICO 实测取不到帧**：`requestVideoFrameCallback` 回调不触发或 `drawImage` 拿到黑帧 → 头显里**全黑、只有声音**。加 2.5s 自愈回退只能补救、不能根治 |
| **C. HTML 覆盖层** | 直接放一个 `<video>` 在 DOM | 实现最简单 | ❌ immersive 下不可见（见第 1 节） |

**默认选 A。**
只有在「确实需要多个消费者」时才考虑 B，且必须先做第 3 节的单消费者改造 + 自愈回退，并**在目标设备上实测能否取到帧**。

> 方案 B 的正确取帧 API 是 `video.requestVideoFrameCallback(cb)`（Chrome 83+）：它在**视频新帧呈现时**回调，天然按视频实际帧率（24/25/30fps）节流，不做无用功。老内核无此 API 时退回 `setInterval(draw, 33)`（约 30fps）。

---

## 3. ★ 单消费者原则（最核心的坑）

### 现象

- 头显里视频**一闪一闪**（每秒数次）
- 或第二个视角（离屏渲染 / 缩略图 / 副屏）**直接黑屏**
- 更诡异的是：同一段代码**降分辨率、降帧率、关 `preserveDrawingBuffer` 全部无效**

### 真因

> **同一个 `<video>` 元素，被两个消费者同时取帧，就会争用同一份解码输出缓冲。**

两种典型组合（均已实测确认）：

| 组合 | 表现 |
|---|---|
| 两个 WebGL 上下文**各建一个 `VideoTexture`**（如主视角 + 离屏 renderer） | 双方交替拿到**已被释放的缓冲** → 闪烁 |
| `drawImage`（离屏中转）+ `VideoTexture`（主视角）**混用** | 互抢当前帧 → 头显闪 **且** 离屏常被抢空 → 另一侧黑屏 |

### 判定方法（实测用的对照实验）

做三次对照，一次只改一个变量：

| 条件 | 结果 |
|---|---|
| ① 有第二个 GL 上下文 + 视频播放 | **闪** |
| ② 有第二个 GL 上下文 + 不播视频（无解码） | 不闪 |
| ③ 无第二个 GL 上下文 + 视频播放 | 不闪 |

→ 只有「**视频解码**」与「**第二个消费者**」同时存在才闪。定位到这一点，剩下的问题就只剩「怎么让消费者只有一个」。

### 处置

**任何时刻，只让一个消费者读这个 `<video>`。** 具体做法取决于你的场景：

- **只有主视角一个消费者** → 什么都不用做，直接用方案 A。
- **还需要第二个视角渲染同一场景**（离屏推流 / 观众机位 / 缩略图）→ 让第二个视角**不画视频屏**：渲染前把视频屏换成纯黑材质，渲染后换回。

```js
// 视频屏 mesh 与主材质
let savedMat = null;
const hideMat = new THREE.MeshBasicMaterial({ color: 0x000000 });

// 第二个视角渲染前/后成对调用
function swapVideoScreen(mode) {
  if (!videoMesh) return;
  if (mode === 'hide') {
    if (!savedMat) savedMat = videoMesh.material;
    videoMesh.material = hideMat;        // 第二个视角看不到影片（纯黑）
    return;
  }
  if (savedMat) { videoMesh.material = savedMat; savedMat = null; }  // 还原
}

// 用法（以离屏渲染为例）：
// swapVideoScreen('hide');
// offscreenRenderer.render(scene, offscreenCamera);
// swapVideoScreen(false);
```

代价：影片那几十秒里，第二个视角/观众端画面里**看不到影片**（是一块黑板）。这是「稳定性 > 完整功能」的取舍，实测两端都不再闪。

> ⚠️ **反例存档**：曾尝试「`drawImage` 作唯一消费者、两个视角共用同一张 `CanvasTexture`」这一理论最优解，
> 在 PICO 上**取不到帧**（见第 2 节方案 B）→ 已放弃。若换设备（Quest / 桌面浏览器）值得重试。

---

## 4. `<video>` 元素的准备

```js
const v = document.createElement('video');
v.playsInline = true;      // 关键：防止某些内核对视频做「全屏劫持」
v.preload = 'auto';        // 预加载，缩短首帧时间
v.src = 'assets/intro/intro.mp4';
// ⚠️ 不 append 到 DOM —— 实测 PICO/Chrome 下不入 DOM 也能正常解码
```

要点：

- **不必插入 DOM**（实测可行）。若遇到某些内核不解码，可 `appendChild` 到 `document.body` 后用 `width:1px;height:1px;opacity:0;position:fixed;pointer-events:none` 藏起来 —— **不要用 `display:none`**：不参与合成的内容在某些实现下会被节流。
- `playsInline` 在头显浏览器上一般是必须的（否则可能被当成"需要全屏"场景处理）。
- `src` 用**相对路径**更稳（跟随页面 origin，避免 CORS / 混合内容问题）。

---

## 5. 自动播放策略（必踩）

浏览器的 autoplay policy：**带音轨的视频在没有用户手势前不允许自动播放**。

`video.play()` 返回一个 Promise，会被 **reject**。处理模板：

```js
v.play().catch(() => {
  // 第一步：静音重试（静音视频允许自动播放）
  v.muted = true;
  v.play().catch(() => {
    // 第二步：连静音都失败 → 别硬等，走兜底推进流程
    finish();
  });
  // 第三步：挂一次性手势监听，用户一交互就恢复声音
  const unmute = () => {
    v.muted = false;
    window.removeEventListener('pointerdown', unmute);
    window.removeEventListener('keydown', unmute);
  };
  window.addEventListener('pointerdown', unmute);
  window.addEventListener('keydown', unmute);
});
```

三点容易漏：

1. **`catch` 必须写**，否则 Promise rejection 只是被忽略，用户看到的是「一片黑 + 没声音」且毫无提示。
2. **静音重试后要记得摘监听器**（`dispose` 时），否则会泄漏。
3. **不要用 `await` 阻塞主流程** —— 播放失败也必须能继续。

---

## 6. 绝不能软锁：三重兜底

任何一处失败都要能推进流程，否则玩家会卡在等待房间里出不来。

```js
const finish = () => {
  if (done || disposed) return;   // 一次性守卫：三个来源可能同时触发
  done = true;
  clearWatchdog();
  removeUnmuteHandler();
  onDone?.();                     // 推进到下一步
};

v.addEventListener('ended', finish);   // ① 正常播完
v.addEventListener('error', finish);   // ② 文件缺失 / 解码失败
watchdog = setTimeout(finish, WATCHDOG_MS);   // ③ 看门狗（本项目取 120000ms）
```

- `_done` / `_disposed` **双守卫**：`ended` 与看门狗可能几乎同时到，且 `dispose` 后迟到的回调必须被忽略（否则会操作已销毁对象）。
- 看门狗时长取「影片时长 + 余量」，本项目是 2 分钟。

---

## 7. 几何：宽高比、朝向、位置

### 7.1 宽高比适配（防拉伸）

初建时按 16:9 估算，拿到元数据后按真实比例重算：

```js
v.addEventListener('loadedmetadata', () => {
  if (disposed) return;
  const vw = v.videoWidth || 16;
  const vh = v.videoHeight || 9;
  applySize(vw, vh);                                  // 计算 _vw / _vh
  mesh.geometry.dispose();                            // 旧几何必须释放
  mesh.geometry = new THREE.PlaneGeometry(_vw, _vh);
});

// contain 方式：在 maxW × maxH 内等比缩放，不裁剪、不拉伸
function applySize(vw, vh) {
  const ar = (vw && vh) ? vw / vh : 16 / 9;
  let w = VIDEO_MAX_W;          // 例：7.2 m
  let h = w / ar;
  if (h > VIDEO_MAX_H) { h = VIDEO_MAX_H; w = h * ar; }   // 例：2.7 m
  _vw = w; _vh = h;
}
```

> 若用方案 B 的中转 canvas，改 `canvas.width/height` **会清空画布内容** → 必须立刻重铺黑底并 `needsUpdate = true`，否则会闪一下透明/黑。

### 7.2 朝向与位置

- `PlaneGeometry` 默认面朝 **+Z**；要面朝 **+X**（正对房间内的玩家）就 `mesh.rotation.y = Math.PI / 2`。
- 贴墙摆放时，**离墙面内收约 10cm**，防止玩家贴脸时被相机近裁剪面（本项目 `near = 0.05`）切穿。
- 垂直位置取 **≈ 视线高度**（本项目 1.5 m）。

---

## 8. 色彩空间（画面发灰的元凶）

```js
const tex = new THREE.VideoTexture(v);
tex.colorSpace = THREE.SRGBColorSpace;   // ← 漏了这行画面会发灰、对比度不对
```

Three.js r152+ 默认 `outputColorSpace = SRGBColorSpace`，但**贴图自身的 `colorSpace` 得手动指定**为 sRGB（视频内容本身就是 sRGB）。新建设材质的场景尤其容易漏。

---

## 9. 背景处理与「父组不可见」陷阱

为突出视频，常把整个背景组隐藏（本项目 `world.setAmbientVisible(false)`，背景纯黑）。
**但这会连带影响任何同时渲染的场景视角**：

> **three.js 中，父组 `visible = false` 时，其所有子节点一律不渲染。**

如果同时还有一个第二视角在渲染同一 `scene`（离屏、观众机位），它看到的背景也会是空的。
处置方式（本项目实测）：

- 把需要保留的节点（如天空球）**临时 reparent 到 `scene` 根**，渲染完再挂回原父组。
- ⚠️ **不要**图省事直接 `ambientGroup.visible = true` —— 若那个组里挂着几百个标注 Sprite（本项目的情况），会让第二个视角的渲染开销暴涨、反而拖垮帧率。

---

## 10. 释放：真正回收解码器

只把对象置 `null` **不会**释放视频解码器（媒体硬件资源占着，换下一个视频可能失败）：

```js
try {
  v.pause();
  v.removeAttribute('src');   // 断开数据源
  v.load();                   // 触发解码器与缓冲回收（关键一步）
} catch (e) { /* 忽略 */ }
```

同时按顺序释放 Three.js 侧资源：

```js
group.traverse((o) => {
  if (o.isMesh) {
    o.geometry?.dispose();
    if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
    else o.material?.dispose();
  }
});
texture?.dispose();
```

---

## 11. 诊断日志（排「黑屏 / 闪」时先看这个）

建议每 2 秒打一行，这几个字段能直接定位问题：

```js
console.log(`[video] readyState=${v.readyState} `
  + `size=${v.videoWidth}x${v.videoHeight} `
  + `frames=${framesTaken} err=${lastErr}`);
```

| 字段 | 含义 | 异常判读 |
|---|---|---|
| `readyState` | `0` 无信息 / `1` 有元数据 / `2` 有当前帧 / `3` 可播后续 / `4` 足够 | `< 2` 说明**还没解出帧** |
| `videoWidth` | 真实像素宽 | `0` = 元数据没加载 |
| `framesTaken` | 中转方案下累计取到的帧数 | 长时间恒为 0 → 取不到帧（方案 B 的典型症状） |
| `err` | 最近一次 `drawImage` 异常 | 非空即取帧出错（如跨域污染） |

**判据**：视频已 `readyState >= 2` 但 2.5 秒内一帧都没取到 → 立刻**回退到 `VideoTexture`**。黑屏比闪烁更糟，宁可退到"会闪但有画面"。

---

## 12. 视频文件本身的规格建议

| 项 | 建议 | 理由 |
|---|---|---|
| 容器 / 编码 | MP4（H.264 / AVC）+ AAC | 头显浏览器兼容性最好；HEVC / AV1 支持不确定 |
| Profile | Baseline / Main 优先 | 硬解支持面最广，High 一般也行 |
| 分辨率 | ≤ 1080p（本项目影片 1.52 MB / 短片段） | 头显 VPU 解码能力有限，高码率 4K 会掉帧 |
| 体积 | 尽量小（进 APK 会直接增大安装包） | 本项目直接 `assets/intro/intro.mp4` 相对路径引用 |
| 音轨 | 保留 AAC，但代码里必须有静音兜底 | 自动播放策略（见第 5 节） |
| 时长 | 与看门狗时长留足余量 | 本项目看门狗 120s |

---

## 13. 完整参考实现（可直接复制）

```js
import * as THREE from 'three';

/** 头显内的视频墙：黑底空间 + 一块悬浮视频屏 */
export class SimpleVideoWall {
  constructor(scene, { url, maxW = 7.2, maxH = 2.7, centerY = 1.5, watchdogMs = 120000 }) {
    this.scene = scene;
    this._maxW = maxW; this._maxH = maxH; this._watchdogMs = watchdogMs;
    this._disposed = false; this._done = false; this._unmute = null;

    this.group = new THREE.Group();
    scene.add(this.group);

    // ① 视频元素（不入 DOM）
    const v = document.createElement('video');
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    this._video = v;

    // ② 贴图：默认方案 A
    const tex = new THREE.VideoTexture(v);
    tex.colorSpace = THREE.SRGBColorSpace;      // ← 防发灰
    this._texture = tex;

    // ③ 网格（初建 16:9，元数据到后重算）
    this._applySize(16, 9);
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    this._mesh = new THREE.Mesh(new THREE.PlaneGeometry(this._vw, this._vh), mat);
    this._mesh.rotation.y = Math.PI / 2;        // 面朝 +X
    this._mesh.position.set(-1.9, centerY, 0);  // 按你的房间调整
    this.group.add(this._mesh);

    v.addEventListener('loadedmetadata', () => {
      if (this._disposed) return;
      this._applySize(v.videoWidth || 16, v.videoHeight || 9);
      this._mesh.geometry.dispose();
      this._mesh.geometry = new THREE.PlaneGeometry(this._vw, this._vh);
    });
  }

  _applySize(vw, vh) {
    const ar = (vw && vh) ? vw / vh : 16 / 9;
    let w = this._maxW, h = w / ar;
    if (h > this._maxH) { h = this._maxH; w = h * ar; }
    this._vw = w; this._vh = h;
  }

  start(onDone) {
    const v = this._video;
    const finish = () => {
      if (this._done || this._disposed) return;
      this._done = true;
      clearTimeout(this._watchdog);
      this._removeUnmute();
      onDone?.();
    };
    v.addEventListener('ended', finish);   // ① 播完
    v.addEventListener('error', finish);   // ② 出错
    this._watchdog = setTimeout(finish, this._watchdogMs);  // ③ 看门狗

    v.play().catch(() => {
      v.muted = true;
      v.play().catch(() => finish());
      this._unmute = () => { v.muted = false; this._removeUnmute(); };
      window.addEventListener('pointerdown', this._unmute);
      window.addEventListener('keydown', this._unmute);
    });
  }

  _removeUnmute() {
    if (!this._unmute) return;
    window.removeEventListener('pointerdown', this._unmute);
    window.removeEventListener('keydown', this._unmute);
    this._unmute = null;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    clearTimeout(this._watchdog);
    this._removeUnmute();
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material?.dispose();
      }
    });
    this._texture?.dispose();
    const v = this._video;
    if (v) {
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* 忽略 */ }
      this._video = null;
    }
    this._mesh = null;
  }
}
```

---

## 14. 上线前检查清单

- [ ] 进 VR 后能看到视频画面（不是黑）
- [ ] 有声音（若被 autoplay 拦，点一下手柄后应恢复；一直静音也算可接受）
- [ ] 画面**不闪**（连续看 30 秒以上）
- [ ] 宽高比正确（圆不变椭圆、人不被拉长）
- [ ] 颜色不发灰（对比度正常）
- [ ] 视频**播完**能自动进入下一步
- [ ] **删掉视频文件**做一次测试：应走到 `error` 兜底并继续，而不是卡死
- [ ] 视频中途退出 VR / 切场景：无报错、无残留画面
- [ ] 退出后再次进入：能重新正常播放（验证解码器已回收）

---

## 15. 边界说明

本文只讲**头显内播放视频**本身。以下内容属于「同一段视频同时被第二个消费者读取」的场景，本文仅在第 3 节给出处置原则（换黑材质），细节不在此展开：

- 把它作为**离屏推流的画面源**（第二个 WebGL 上下文）→ 见第 3 节单消费者改造。
- 影片期间头显同时做 **H.264 硬件编码**（推流）→ 会与视频**解码**争用同一媒体硬件块（VPU），这是另一类闪烁的根因，处置方式是「影片期间不编码」。
- 由于上述原因，常见做法是**让接收端播放本地同一段影片**，用信令对齐开始/结束，而不是推流。

若本项目体系内有 `docs/cast-*.md` 与 `webxr-cast-dual-package` skill，那两份文档覆盖上述直播细节；本文是其中「视频播放」这一层的独立抽取。
