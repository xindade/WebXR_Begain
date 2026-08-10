// glbCapture.js —— DepthSprite 的「数据源」。
// 当前形态：运行时把 GLB 离屏渲染成 (albedo + depth) 的「多帧 idle sheet」（模型绕 Y 小幅摆动取样）。
// 这是 2「正式资源」的过渡形态：数据已经是 sheet(帧网格) 格式；
//   将来手绘/离线素材只需把数据源换成 loadDepthSpriteSheet（接口完全一致），即可去掉运行时捕获。
// 按 url+frames+swing 缓存，同类型气球（如压测 30 个 basic）只捕获一次、共享纹理。
import * as THREE from 'three';
import { loadBalloonModel } from './balloonModels.js';

const CAP = 512; // 离屏捕获分辨率（每帧）

// 深度材质：把视空间 z 归一化到 0(最远/平面)..1(最近/最凸)
const _depthMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: { uZMin: { value: 0 }, uZMax: { value: 1 } },
  vertexShader: /* glsl */ `
    uniform float uZMin; uniform float uZMax;
    out float vz;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vz = mv.z;
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform float uZMin; uniform float uZMax;
    in float vz;
    out vec4 fragColor;
    void main() {
      // 约定：最近=1(最凸/最大位移)，最远=0(平面/无位移)。
      // 视空间中最近点 vz 最小(最负)=uZMin，故 1-(vz-uZMin)/(uZMax-uZMin) 把最近映射到 1。
      // 若实测立体感「凹陷」而非「凸起」，把这里的 1.0 - 去掉即可翻转。
      float d = clamp(1.0 - (vz - uZMin) / (uZMax - uZMin), 0.0, 1.0);
      fragColor = vec4(d, d, d, 1.0);
    }
  `,
});

// 把 RT 像素读回 2D canvas（Y 翻转，WebGL 原点在左下）
function readRT(renderer, rt) {
  const w = rt.width, h = rt.height;
  const buf = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const s = (h - 1 - y) * w * 4;
    img.data.set(buf.subarray(s, s + w * 4), y * w * 4);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// 把 SkinnedMesh 的 skeleton 重新绑定到「克隆体中的骨骼」：
// gltfScene.clone(true) 之后，SkinnedMesh.skeleton.bones 仍指向「原体骨骼」，
// 而 AnimationMixer 驱动的是克隆骨骼 → 立绘捕获不到动画。按名字把骨架重定向到克隆骨骼即可。
// 模型不含 SkinnedMesh（纯静态 / 变换动画）时本函数直接跳过，无副作用。
function rebindSkeleton(root) {
  const boneByName = {};
  root.traverse((o) => { if (o.isBone) boneByName[o.name] = o; });
  root.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton) {
      const newBones = [];
      let ok = true;
      for (const b of o.skeleton.bones) {
        const nb = boneByName[b.name];
        if (!nb) { ok = false; break; }
        newBones.push(nb);
      }
      if (ok && newBones.length === o.skeleton.bones.length) {
        o.skeleton = new THREE.Skeleton(newBones, o.skeleton.boneInverses);
        o.bind(o.skeleton, o.bindMatrix);
      }
    }
  });
}

// 把已加载 GLB 渲染为「多帧 idle sheet」。
// 若 GLB 自带动画轨道（animations 非空）：用 AnimationMixer 按时间点取样 N 帧 → 立绘播真实动作。
// 否则：模型绕 Y 做 sin 摆动（首尾角度自然衔接，循环播放不跳变）。
// 返回 { albedo, depth, frameCount, cols, rows }。失败（捕获为空）时 reject，由调用方回退为可见球体。
export function captureGLB(renderer, gltfScene, { radius, frames = 1, swing = 0.0, animations = [] }) {
  frames = Math.max(1, frames | 0);

  // —— 栅格布局：把 frames 帧排成接近正方形的网格，避免单行超宽（如 8 帧 → 4096 宽）。
  // 超宽纹理在部分 GPU / 移动端（PICO 等）会因纹理尺寸上限或 mipmap 处理而上传失败。 ——
  const cols = Math.ceil(Math.sqrt(frames));
  const rows = Math.ceil(frames / cols);

  // 按设备 maxTextureSize 收敛每帧分辨率，杜绝纹理超限失效
  const maxTex = (renderer.capabilities && renderer.capabilities.maxTextureSize) || 4096;
  let cap = CAP;
  if (cols * cap > maxTex || rows * cap > maxTex) {
    cap = Math.max(16, Math.floor(maxTex / Math.max(cols, rows)));
    console.warn(`[glbCapture] sheet 超过纹理上限(${maxTex})，每帧分辨率降至 ${cap}`);
  }

  const obj = gltfScene.clone(true);

  // —— 正确居中：先按半径缩放，再据「缩放后」包围盒把几何中心移到世界原点 ——
  // 以往先居中再缩放会绕物体本地原点缩放，而 GLB 本地原点往往不在几何中心，
  // 导致缩放后模型整体偏移出相机正前方的画面中心 → 第 0 帧中心采样到背景(alpha=0) → 立绘不可见。
  let box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  obj.scale.multiplyScalar((radius * 2) / maxDim);
  obj.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(obj);              // 缩放后重新求包围盒
  const center2 = box.getCenter(new THREE.Vector3());
  obj.position.sub(center2);                             // 把缩放后的几何中心移到原点
  obj.updateMatrixWorld(true);

  // 重建骨骼绑定：让克隆体上的 SkinnedMesh 指向克隆骨骼（动画采样的前提，无骨骼时 no-op）
  rebindSkeleton(obj);

  const capScene = new THREE.Scene();
  capScene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.0));
  const dl = new THREE.DirectionalLight(0xffffff, 1.2); dl.position.set(2, 3, 4); capScene.add(dl);
  capScene.add(obj);

  // 正视相机（固定正前方）
  const cam = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
  const dist = (0.8 / Math.tan(THREE.MathUtils.degToRad(45 / 2))) * 1.5;
  cam.position.set(0, 0, dist);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);

  // 深度归一化范围（基于居中+缩放后的包围盒；摆动幅度小，跨帧深度映射一致，避免闪烁）
  const b2 = new THREE.Box3().setFromObject(obj);
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

  // —— 动画采样：若 GLB 自带骨骼/变换动画，用 AnimationMixer 按时间点取样 N 帧（替代 yaw 摆动）——
  let mixer = null;
  let animDuration = 0;
  if (animations && animations.length) {
    mixer = new THREE.AnimationMixer(obj);
    const clip = animations.find((a) => /walk|run|attack|idle|move|atk|act/i.test(a.name)) || animations[0];
    mixer.clipAction(clip).play();
    animDuration = clip.duration || 0;
    console.log(`[glbCapture] 用动画 "${clip.name}"(${animDuration.toFixed(2)}s) 采样 ${frames} 帧`);
  }

  // 单帧 RT（循环复用），结果拼进 sheet canvas（栅格布局）
  const albedoRT = new THREE.WebGLRenderTarget(cap, cap, { format: THREE.RGBAFormat });
  albedoRT.texture.colorSpace = THREE.SRGBColorSpace; // 颜色 pass 输出 sRGB 字节，与真实 GLB 屏幕像素同源
  const depthRT = new THREE.WebGLRenderTarget(cap, cap, { format: THREE.RGBAFormat }); // 深度是数据，保持 linear

  const albedoSheet = document.createElement('canvas');
  albedoSheet.width = cap * cols; albedoSheet.height = cap * rows;
  const depthSheet = document.createElement('canvas');
  depthSheet.width = cap * cols; depthSheet.height = cap * rows;
  const aCtx = albedoSheet.getContext('2d');
  const dCtx = depthSheet.getContext('2d');

  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevXr = renderer.xr.enabled;
  renderer.xr.enabled = false; // 防御：捕获期间禁用 XR，避免 render 被 XR 相机/帧缓冲接管导致 RT 为空

  let capturedOpaque = false;
  for (let i = 0; i < frames; i++) {
    if (mixer) {
      // 在动画时长内均匀取帧：首尾经 clip 循环自然衔接，loop 回 0 帧无缝。
      const t = animDuration > 0 ? (i / frames) * animDuration : 0;
      mixer.setTime(t);
    } else {
      // idle 摆动：绕 Y 小幅 sin（i=0 与 i=frames-1 角度接近，循环平滑）
      obj.rotation.y = swing * Math.sin((2 * Math.PI * i) / frames);
    }
    obj.updateMatrixWorld(true);

    // 1) 颜色 pass（透明背景）
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(albedoRT);
    renderer.render(capScene, cam);
    const gx = (i % cols) * cap, gy = Math.floor(i / cols) * cap;
    aCtx.drawImage(readRT(renderer, albedoRT), gx, gy);

    // 仅第 0 帧直接读 RT 像素校验（模型中心应在 RT 中心；绕开 canvas/栅格误差）
    if (i === 0) {
      const buf = new Uint8Array(cap * cap * 4);
      renderer.readRenderTargetPixels(albedoRT, 0, 0, cap, cap, buf);
      let cnt = 0;
      for (let p = 3; p < buf.length; p += 4) if (buf[p] > 10) cnt++;
      capturedOpaque = cnt > (cap * cap * 0.01); // 中心区域 >1% 不透明像素即视为成功
    }

    // 2) 深度 pass（几何精确，覆盖材质）
    obj.traverse((o) => { if (o.isMesh) { o.userData._m = o.material; o.material = _depthMat; } });
    renderer.setRenderTarget(depthRT);
    renderer.render(capScene, cam);
    dCtx.drawImage(readRT(renderer, depthRT), gx, gy);
    obj.traverse((o) => { if (o.isMesh && o.userData._m) { o.material = o.userData._m; delete o.userData._m; } });
  }

  // 恢复 renderer 状态，避免污染主循环
  renderer.xr.enabled = prevXr;
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);

  // 校验失败：捕获为空，拒绝并交回退逻辑（可见球体），杜绝「看不见但可击中」的幽灵气球
  if (!capturedOpaque) {
    console.error('[glbCapture] 捕获疑似全透明（第0帧几乎无可渲染像素）：立绘会不可见，已回退为可见球体。请检查 GLB 材质/渲染或 radius。');
    albedoRT.dispose();
    depthRT.dispose();
    return Promise.reject(new Error('glbCapture empty'));
  }

  const albedo = new THREE.CanvasTexture(albedoSheet);
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.needsUpdate = true;
  const depth = new THREE.CanvasTexture(depthSheet);
  depth.colorSpace = THREE.NoColorSpace; // 数据，不解码
  depth.needsUpdate = true;

  albedoRT.dispose();
  depthRT.dispose();

  return { albedo, depth, frameCount: frames, cols, rows };
}

// 2「正式资源」入口：直接加载离线/手绘的 (albedo + depth) 序列帧 sheet 文件，不再运行时捕获。
// 手绘/离线素材到位后，在 constants.DEPTH_SPRITE_HANDPAINTED 按模型 url 填映射即可切换数据源。
// 注意：depth 图是数据，colorSpace 必须为 NoColorSpace（不可被 sRGB 解码）。
const _texLoader = new THREE.TextureLoader();
export function loadDepthSpriteSheet(albedoUrl, depthUrl, { frameCount = 1, cols = frameCount, rows = 1 } = {}) {
  return new Promise((resolve, reject) => {
    _texLoader.load(albedoUrl, (albedo) => {
      albedo.colorSpace = THREE.SRGBColorSpace;
      _texLoader.load(depthUrl, (depth) => {
        depth.colorSpace = THREE.NoColorSpace;
        resolve({ albedo, depth, frameCount, cols, rows });
      }, undefined, (e) => reject(e));
    }, undefined, (e) => reject(e));
  });
}

const _capCache = new Map(); // key -> Promise<{albedo, depth, frameCount, cols, rows}>

// 按 url+frames+swing 缓存捕获结果（同类型气球共享纹理，仅各自新建 material）
export function captureModelByUrl(renderer, url, radius, opts = {}) {
  const { frames = 1, swing = 0.0 } = opts;
  const key = `${url}:${frames}:${swing}`;
  if (_capCache.has(key)) return _capCache.get(key);
  const p = loadBalloonModel(url)
    .then(({ scene, animations }) => captureGLB(renderer, scene, { radius, frames, swing, animations }))
    .catch((e) => { _capCache.delete(key); throw e; }); // 失败不缓存，便于重试
  _capCache.set(key, p);
  return p;
}
