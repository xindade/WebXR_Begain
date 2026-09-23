# 03 · 模型优化（glTF/GLB + Draco 压缩，与 2.5D 立绘方案）

> 源码：`src/game/glbCache.js`、`src/game/balloonModels.js`、`src/game/glbCapture.js`、`src/game/depthSprite.js`
> 参数：`constants.js` 的 `DEPTH_SPRITE_*` ｜ 解码器：`vendor/draco/`
> 复现难度：★★★★（离屏捕获 + 自定义着色器 + 坐标系细节，几乎每步都要实测）

---

## 1. 需求与两条路线

VR 一体机（PICO 4 / Adreno XR2）的 GPU 是移动端规模，同屏几十个高模一定会掉帧。项目用**两条路线**分流：

| 路线 | 适用 | 手段 | 效果 |
|---|---|---|---|
| **A. 真 3D（GLB + Draco）** | 数量少、需要真立体/动画的主角（龙 Boss、传送门、魔术师、玩家枪械、部分怪） | Draco 压缩几何 + 加载缓存 + 跨关复用 + 统一贴合 | 保真，但顶点/材质成本高 |
| **B. 2.5D 深度视差立绘（DepthSprite）** | 数量多的杂兵（气球怪） | 把 GLB **离屏渲染**成 (albedo + depth) 多帧图集，运行时用一个带视差的平面代替模型 | 顶点数降到 2 个三角形，仍有**真实双目立体感** |

两条路线共用同一个「加载 → 缓存 → 克隆 → 贴合」范式，切换只靠一个开关
（`DEPTH_SPRITE_MODE` + `DEPTH_SPRITE_TYPES` 白名单）。

---

## 2. 路线 A：GLB 加载与 Draco 压缩

### 2.1 离线 Draco 解码器（必须本地）

```js
// src/game/glbCache.js
import { GLTFLoader } from '../../vendor/GLTFLoader.js';
import { DRACOLoader } from '../../vendor/DRACOLoader.js';

function _load(url, onProgress) {
  const draco = new DRACOLoader();
  draco.setDecoderPath('vendor/draco/');     // ⚠ 离线解码器，相对 index.html
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  return new Promise((resolve, reject) => {
    loader.load(url, resolve,           // resolve 完整 gltf（含 animations）
      (e) => { if (onProgress) onProgress(e.loaded || 0, e.total || 1); },
      (err) => { console.error('[GLBCache] 加载失败:', url, err); reject(err); });
  });
}
```

> **为什么必须本地**：PICO 浏览器在局域网离线环境运行，不能依赖 CDN 拉 `draco_decoder.wasm`。
> `vendor/draco/` 里放 `draco_decoder.js/.wasm` 等文件，路径相对 `index.html`。
> 全站**没有 node_modules**，`vendor/` 就是本地化的依赖目录。

### 2.2 共享缓存：`Map<url, Promise<gltf>>`

```js
const _cache = new Map();          // url -> Promise<gltf>

export function loadGLB(url, onProgress) {
  if (_cache.has(url)) { onProgress?.(1, 1); return _cache.get(url); }
  const p = _load(url, onProgress).catch((err) => {
    _cache.delete(url);            // 失败不缓存 → 下次（重进关）会重试
    throw err;
  });
  _cache.set(url, p);
  return p;
}

export async function preloadGLB(url, onProgress) {
  try { await loadGLB(url, onProgress); return true; } catch (e) { return false; }  // 失败静默，不阻塞进度条
}
```

设计要点：

| 设计 | 原因 |
|---|---|
| 缓存 **Promise** 而非 gltf 对象 | 并发调用天然去重：两个敌人同时要同一模型，只下载/解析一次 |
| 启动预览阶段 `preloadGLB` | 进关后 `loadGLB` 直接命中同一 Promise → **零下载、零解码、零 parse**，进关不掉帧 |
| 失败时 `delete` 缓存项 | 网络抖动导致的失败可以重试，不会永久失败 |
| 缓存 `gltf`（含 `animations`） | 传送门/魔术师都要 `animations` 建 `AnimationMixer`，不能只缓存 `gltf.scene` |
| 资源跨关持有 | geometry/material/texture 由缓存持有；实例 `dispose` 只**摘除**，不释放纹理（下次进关直接复用） |
| 只做 preload 的 `_panoCache` 同类思路 | 死亡重开同一关不重复加载 |

### 2.3 克隆与蒙皮重绑

```js
export function cloneGLBScene(gltf) {
  const root = gltf.scene.clone(true);
  let hasSkinned = false;
  root.traverse((o) => { if (o.isSkinnedMesh) hasSkinned = true; });
  if (hasSkinned) {
    const boneByName = new Map();
    root.traverse((o) => { if (o.isBone && o.name) boneByName.set(o.name, o); });
    root.traverse((o) => {
      if (o.isSkinnedMesh && o.skeleton) {
        const bones = o.skeleton.bones.map((b) => boneByName.get(b.name) || b);
        o.skeleton = new THREE.Skeleton(bones, o.skeleton.boneInverses); // inverse 只读可共享
        o.bind(o.skeleton, o.bindMatrix);
      }
    });
  }
  return root;
}
```

> `Object3D.clone(true)` 是深拷贝，但 `SkinnedMesh.skeleton` 仍指向**原始骨骼**。
> 多个实例共享同一骨架 → 动画互相串扰。所以有蒙皮时必须按**名字**在克隆树里重新找骨骼并重绑。
> （本项目两个 GLB 大概率是节点动画，此分支通常不触发，但必须留着。）

### 2.4 统一贴合尺寸 `fitToRadius`

```js
// 把加载好的模型居中并缩放到与碰撞半径匹配：免去手猜 GLB 原生尺寸
export function fitToRadius(obj, radius) {
  obj.updateMatrixWorld(true);                       // 克隆体未入场景，先刷新世界矩阵再量包围盒
  let box = new THREE.Box3().setFromObject(obj);
  const center = new THREE.Vector3(); box.getCenter(center);
  obj.position.sub(center);                          // 几何中心移到原点
  obj.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(obj);         // 居中后重新求尺寸
  const size = new THREE.Vector3(); box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  obj.scale.setScalar((radius * 2) / maxDim);        // 最长边 = 直径 → 视觉尺寸 == 碰撞球
}
```

> **价值**：美术给什么尺寸的 GLB 都不用管——运行时统一拉到「直径 = 2×radius」，与距离碰撞判定一致。
> 不这么做就要为每个模型手猜缩放系数，且改碰撞半径就要同步改缩放。

### 2.5 挂载时机与手动微调

气球构造是**同步**的，但 GLB 加载是**异步**的，于是采用「先建程序化球体 → 模型就绪后挂为子节点并隐藏球体」：

```js
loadBalloonModel(url).then((gltfScene) => {
  if (!balloon.alive) { /* 加载期间已被打死：释放克隆体，不挂场景 */ return; }
  const clone = gltfScene.clone(true);
  fitToRadius(clone, radius);

  const tune = { ...(MODEL_TUNING[url] || { pos:[0,0,0], rot:[0,0,0], scale:1.0 }), ...(tuningOverride || {}) };
  clone.position.add(new THREE.Vector3(tune.pos[0], tune.pos[1], tune.pos[2]));   // 米
  clone.rotation.set(degToRad(tune.rot[0]), degToRad(tune.rot[1]), degToRad(tune.rot[2])); // 度→弧度
  clone.scale.multiplyScalar((tune.scale ?? 1.0) * extraScale);                   // 贴合之上再缩放

  // 每个气球独立克隆材质，互不影响闪烁/染色
  clone.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); if (tint != null) o.material.color.setHex(tint); } });

  balloon.mesh.add(clone);
  balloon.mesh.material.visible = false;   // 隐藏程序化球体（碰撞仍靠 position）
});
```

- **`MODEL_TUNING` 表**（`balloonModels.js` 顶部）：每个模型的 `{pos, rot, scale}` 手动微调入口，
  模型朝向偏了/想抬高放大只改这张表，不碰逻辑代码。
- **`tuningOverride`**：同一模型用于不同体型时（盾兵骑士 vs Boss 骑士）覆盖微调。
- **每实例克隆材质**：否则给一个怪打受击闪白，同类型所有怪一起闪。

---

## 3. 路线 B：2.5D 深度视差立绘（DepthSprite）

### 3.1 原理

把 GLB 渲染成两张图：**albedo**（颜色，含 alpha）+ **depth**（深度，0=平面，1=最凸）。
运行时用一个平面显示 albedo，并按「视线方向 × 深度」偏移采样点：

```glsl
// gl_FragColor 阶段的核心
vec3 viewDir = normalize(cameraPosition - vWorldPos);
vec2 parallax = vec2(dot(viewDir, uPlaneRight), dot(viewDir, uPlaneUp)) * depth * uDepthScale;
vec2 suv = uv + parallax;
```

**为什么在 VR 里是「真立体」**：XR 下 three 会把 `cameraPosition` 设为**当前眼**的世界坐标（左右眼不同），
于是左右眼各自算出不同的 `viewDir` → 采样偏移不同 → **天然产生双眼视差**，不需要任何额外立体代码。

### 3.2 着色器要点（`depthSprite.js`）

```js
const mat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  transparent: false,     // ✅ 不透明 + discard：能与真实几何互遮，零排序问题
  depthTest: true,
  depthWrite: true,
  side: THREE.DoubleSide,
  uniforms: { uAlbedo, uDepth, uFrame, uFrameCount, uCols, uRows, uDepthScale,
              uDebugDepth: { value: 0 }, uFlash: { value: 0 },
              uPlaneRight: { value: new THREE.Vector3(1,0,0) },
              uPlaneUp:    { value: new THREE.Vector3(0,1,0) } },
  ...
});
```

片段着色器三段关键逻辑：

```glsl
// ① 帧动画：把单帧 uv 映射到图集里第 f 帧的格子
vec2 frameUV(vec2 uv, float f) {
  float col = mod(f, uCols);
  float row = floor(f / uCols);
  row = (uRows - 1.0) - row;         // 图集顶部为第 0 行，纹理原点在左下 → 翻转
  vec2 cell = vec2(1.0 / uCols, 1.0 / uRows);
  return (vec2(col, row) + uv) * cell;
}

// ② 跨格保护：视差采样越界就丢弃，否则会采到相邻帧
vec2 cellMin = vec2(floor(uv.x * uCols), floor(uv.y * uRows)) / vec2(uCols, uRows);
vec2 cellMax = cellMin + vec2(1.0 / uCols, 1.0 / uRows);
if (suv.x < cellMin.x || suv.x > cellMax.x || suv.y < cellMin.y || suv.y > cellMax.y) discard;

// ③ 手动 sRGB 编码：自定义 ShaderMaterial 不会被 three 自动编码，必须对齐内置材质
vec3 col = sRGBTransferOETF(texture(uAlbedo, suv).rgb);
col = mix(col, vec3(1.0), uFlash);   // 受击白闪
```

**yaw billboard**：只绕 Y 转向玩家，同时把平面的世界 `right/up` 写进 uniform，保证转向后视差方向仍正确：

```js
faceYaw(targetPos) {
  const dx = targetPos.x - m.position.x, dz = targetPos.z - m.position.z;
  m.rotation.y = Math.atan2(dx, dz);
  m.updateMatrixWorld();
  _dsRight.set(1, 0, 0).applyQuaternion(m.quaternion);
  _dsUp.set(0, 1, 0).applyQuaternion(m.quaternion);
  this.material.uniforms.uPlaneRight.value.copy(_dsRight);
  this.material.uniforms.uPlaneUp.value.copy(_dsUp);
}
```

（`_dsRight/_dsUp` 是**模块级临时变量**，避免每帧每立绘 `new Vector3()` 造成 GC 压力。）

**调试开关**：`uDebugDepth > 0.5` 时直接输出灰度深度图，用来确认深度图是否正确（0=平面 1=最凸）。

### 3.3 捕获管线（`glbCapture.js`）

把 GLB 离屏渲染成多帧 (albedo + depth) 图集。核心步骤：

```js
export function captureGLB(renderer, gltfScene, { radius, frames = 1, swing = 0.0 }) {
  frames = Math.max(1, frames | 0);

  // ① 栅格布局：排成接近正方形的网格，避免单行超宽（8 帧→4096 宽）
  //    超宽纹理在移动端会因纹理尺寸上限或 mipmap 处理而上传失败
  const cols = Math.ceil(Math.sqrt(frames));
  const rows = Math.ceil(frames / cols);

  // ② 按设备 maxTextureSize 收敛每帧分辨率，杜绝纹理超限失效
  const maxTex = renderer.capabilities?.maxTextureSize || 4096;
  let cap = 512;
  if (cols * cap > maxTex || rows * cap > maxTex) {
    cap = Math.max(16, Math.floor(maxTex / Math.max(cols, rows)));
    console.warn(`[glbCapture] sheet 超过纹理上限(${maxTex})，每帧分辨率降至 ${cap}`);
  }
  ...
}
```

**居中/缩放的顺序（曾经的 bug 源）**：

```js
// —— 正确居中：先按半径缩放，再据「缩放后」包围盒把几何中心移到世界原点 ——
// 以往先居中再缩放会绕物体本地原点缩放，而 GLB 本地原点往往不在几何中心，
// 导致缩放后模型整体偏移出相机正前方的画面中心 → 第 0 帧中心采样到背景(alpha=0) → 立绘不可见。
let box = new THREE.Box3().setFromObject(obj);
const maxDim = Math.max(size.x, size.y, size.z) || 1;
obj.scale.multiplyScalar((radius * 2) / maxDim);
obj.updateMatrixWorld(true);
box = new THREE.Box3().setFromObject(obj);       // 缩放后重新求包围盒
obj.position.sub(box.getCenter(new THREE.Vector3()));
obj.updateMatrixWorld(true);
```

> ⚠ 注意：`balloonModels.fitToRadius()`（路线 A）用的是「先居中再缩放」，那是对的，因为居中后几何中心已在原点、绕原点缩放不会跑偏。
> 但**捕获路径**必须用上面这个「先缩放再居中」的顺序，两条路径不要互抄。

**两遍渲染 + 深度归一化**：

```js
// 深度归一化范围（基于居中+缩放后的包围盒；摆动幅度小，跨帧映射一致，避免闪烁）
let zmin = Infinity, zmax = -Infinity;
const vm = cam.matrixWorldInverse;
for (const x of [b2.min.x, b2.max.x])
  for (const y of [b2.min.y, b2.max.y])
    for (const z of [b2.min.z, b2.max.z]) {
      const v = new THREE.Vector3(x, y, z).applyMatrix4(vm);
      zmin = Math.min(zmin, v.z); zmax = Math.max(zmax, v.z);
    }
_depthMat.uniforms.uZMin.value = zmin;
_depthMat.uniforms.uZMax.value = zmax;
```

深度材质（把视空间 z 归一化到 0..1）：

```glsl
// 约定：最近=1(最凸/最大位移)，最远=0(平面/无位移)。
// 视空间中最近点 vz 最小(最负)=uZMin，故 1-(vz-uZMin)/(uZMax-uZMin) 把最近映射到 1。
// 若实测立体感「凹陷」而非「凸起」，把这里的 1.0 - 去掉即可翻转。
float d = clamp(1.0 - (vz - uZMin) / (uZMax - uZMin), 0.0, 1.0);
```

循环：每帧绕 Y 做 `swing * sin(2πi/frames)` 摆动（首尾角度自然衔接，循环播放不跳变），
先渲一遍**颜色 pass**（透明背景、sRGB RT），再换材质渲一遍**深度 pass**，各自 `drawImage` 进对应图集 canvas。

```js
renderer.xr.enabled = false;   // 防御：捕获期间禁用 XR，避免 render 被 XR 相机/帧缓冲接管导致 RT 为空
```

**空图校验 + 回退（很关键）**：

```js
// 仅第 0 帧直接读 RT 像素校验（模型中心应在 RT 中心；绕开 canvas/栅格误差）
const buf = new Uint8Array(cap * cap * 4);
renderer.readRenderTargetPixels(albedoRT, 0, 0, cap, cap, buf);
let cnt = 0;
for (let p = 3; p < buf.length; p += 4) if (buf[p] > 10) cnt++;
capturedOpaque = cnt > (cap * cap * 0.01);   // 中心区域 >1% 不透明像素即视为成功

if (!capturedOpaque) {
  console.error('[glbCapture] 捕获疑似全透明（第0帧几乎无可渲染像素）：立绘会不可见，已回退为可见球体。');
  return Promise.reject(new Error('glbCapture empty'));
}
```

捕获结果按 `url:frames:swing` 缓存，同类气球共享纹理：

```js
const _capCache = new Map();
export function captureModelByUrl(renderer, url, radius, opts = {}) {
  const key = `${url}:${opts.frames}:${opts.swing}`;
  if (_capCache.has(key)) return _capCache.get(key);
  const p = loadBalloonModel(url)
    .then((gltfScene) => captureGLB(renderer, gltfScene, { radius, ...opts }))
    .catch((e) => { _capCache.delete(key); throw e; });   // 失败不缓存，便于重试
  _capCache.set(key, p);
  return p;
}
```

### 3.4 色彩空间（两张图的规则不同）

| 图 | colorSpace | 原因 |
|---|---|---|
| albedo（颜色 pass 输出） | `THREE.SRGBColorSpace` | 与真实 GLB 的屏幕像素同源 |
| depth（深度） | `THREE.NoColorSpace` | **数据**，绝不能被 sRGB 解码 |

```js
const albedoRT = new THREE.WebGLRenderTarget(cap, cap, { format: THREE.RGBAFormat });
albedoRT.texture.colorSpace = THREE.SRGBColorSpace;
const depthRT  = new THREE.WebGLRenderTarget(cap, cap, { format: THREE.RGBAFormat }); // 深度是数据，保持 linear
...
const albedo = new THREE.CanvasTexture(albedoSheet); albedo.colorSpace = THREE.SRGBColorSpace;
const depth  = new THREE.CanvasTexture(depthSheet);  depth.colorSpace  = THREE.NoColorSpace;
```

### 3.5 将来换手绘资源：同接口切换

```js
// 手绘/离线素材到位后，在 constants.DEPTH_SPRITE_HANDPAINTED 按模型 url 填映射即可切换数据源
export function loadDepthSpriteSheet(albedoUrl, depthUrl, { frameCount = 1, cols = frameCount, rows = 1 } = {}) { … }
```

`attachBalloonModel` 里已写好分流：命中 `DEPTH_SPRITE_HANDPAINTED[url]` 就加载离线图集，
否则运行时捕获。**接口完全一致**，替换数据源不用改下游。

---

## 4. 参数表

### `constants.js` → `DEPTH_SPRITE_*`

| 常量 | 值 | 含义 |
|---|---|---|
| `DEPTH_SPRITE_MODE` | `true` | 总开关：是否用 2.5D 立绘替换 3D GLB |
| `DEPTH_SPRITE_TYPES` | 9 类敌人 id | 白名单：只有这些类型走立绘 |
| `DEPTH_SPRITE_FRAMES` | 12 | 捕获的帧数（`cols=ceil(sqrt(12))=4`，4×3 图集） |
| `DEPTH_SPRITE_SWING` | 0.18 | 摆动幅度（弧度），左右各约 ±10° |
| `DEPTH_SPRITE_SCALE` | 0.08 | 视差强度（`depthScale`），越大越"凸"越易穿帮 |
| `DEPTH_SPRITE_STRESS` | 150 | 压测数量（同屏立绘数，验证性能上限） |
| `DEPTH_SPRITE_HANDPAINTED` | `{}` | 手绘资源映射表（空 = 全部走运行时捕获） |

### `glbCapture.js` 内常量

| 常量 | 值 | 含义 |
|---|---|---|
| `CAP` | 512 | 每帧离屏捕获分辨率（会按 `maxTextureSize` 自动收敛） |
| 成功判据 | >1% | 第 0 帧中心区域不透明像素占比阈值 |
| 捕获相机 | FOV 45, 1:1 | 正视固定相机，`dist` 由 FOV 反推 |
| 光照 | Hemisphere(1.0) + Directional(1.2) | 只影响 albedo 图 |

---

## 5. 踩坑清单

| 现象 | 真因 | 结论 |
|---|---|---|
| 头显离线环境模型全部加载失败 | Draco 解码器指向 CDN | `draco.setDecoderPath('vendor/draco/')`，本地化 |
| 进关那一刻卡顿/黑帧 | GLB 在关卡开始时才下载解析 | 预览阶段 `preloadGLB`，缓存 Promise |
| 同类怪只出现一次动画 / 动画错乱 | `skeleton` 被多实例共享 | `cloneGLBScene` 按名字重绑骨骼 |
| 给一个怪打白闪，同类怪一起闪 | 共享材质 | 每实例 `material.clone()` |
| 模型尺寸和碰撞球对不上 | 手猜 GLB 缩放 | `fitToRadius` 统一拉到 `2*radius` |
| **立绘完全看不见（但仍能被打中）** | 捕获第 0 帧是空图（模型缩放到画面外） | 居中/缩放顺序必须是「先缩放再居中」；且必须做空图校验 + 回退可见球体 |
| 8 帧图集上传失败 / 花屏 | 单行 4096 宽超纹理上限 | 栅格布局 `cols=ceil(sqrt(frames))` + 按 `maxTextureSize` 收敛每帧分辨率 |
| 立绘闪一下变透明 | 视差采样越界采到相邻帧 | 跨格 `discard` 保护 |
| 立绘颜色发灰/过曝 | 深度图被 sRGB 解码 / albedo 没做 sRGB 编码 | 深度 `NoColorSpace`，albedo 手动 `sRGBTransferOETF` |
| 立绘看起来是「凹进去」的 | 深度方向约定相反 | 去掉 `1.0 - (vz-uZMin)/…` 里的 `1.0 -` |
| 立绘与真实几何穿插/遮挡错乱 | 材质 `transparent:true` 参与排序 | 用**不透明 + alpha `discard`** |
| 立绘转向后视差方向不对 | 只转了 `rotation.y` 没更新平面 right/up | `faceYaw` 同步写 `uPlaneRight/uPlaneUp` |
| 立绘数量一多就掉帧（GC） | 每帧 `new Vector3()` | 模块级临时量复用 |
| 立绘能动但动画卡顿/闪烁 | 每帧深度映射不一致 | 深度归一化用**固定**包围盒跨帧共用 |

---

## 6. 验证方法

**路线 A**
- [ ] 断网（仅局域网）下模型能正常加载（证明 Draco 离线解码器生效）
- [ ] 预览阶段预加载后进关，进关瞬间无卡顿（缓存命中）
- [ ] 模型视觉直径 ≈ 游戏内命中球直径（贴着模型边缘打，能打中即正确）
- [ ] 打中某个怪闪白时，同屏同类怪不跟着闪

**路线 B**
- [ ] 控制台无 `[glbCapture] 捕获疑似全透明` 与「sheet 超过纹理上限」告警
- [ ] 头显内左右眼分别闭眼观察：立绘有**明显的凸起立体感**（不是贴在平面上的贴纸）
- [ ] 立绘边缘无「切到相邻帧」的杂色块
- [ ] 立绘与真实几何（如传送门、地面）互相遮挡正确
- [ ] 临时把 `uDebugDepth` 设为 1：能看到灰度深度图，前景亮、背景暗
- [ ] `DEPTH_SPRITE_STRESS` 压测同屏 150 个：帧率仍可接受
- [ ] 把某模型 url 填进 `DEPTH_SPRITE_HANDPAINTED`，能切到离线图集且表现一致
