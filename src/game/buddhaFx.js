import * as THREE from 'three';
import { BUDDHA } from '../core/constants.js';
import { makePalmCanvas } from './palmCanvas.js';

const _endPos = new THREE.Vector3();
const _startPos = new THREE.Vector3();
const _midScale = new THREE.Vector3();
const _faceZ = new THREE.Vector3(0, 0, 1);
const _faceTmp = new THREE.Vector3();
const _faceQ = new THREE.Quaternion();
// 让 plane 的 +Z（normal）始终指向相机——PlaneGeometry + lookAt 的经典坑：
// lookAt 让 -Z 指向目标，导致 plane 正面背对相机；远处看到的是侧边（"斜光柱"）。
// 这里改用 setFromUnitVectors 把 +Z 旋转到「指向相机」的方向，plane 正面始终朝玩家。
function _faceCamera(mesh, camera) {
  if (!camera) return;
  _faceTmp.subVectors(camera.position, mesh.position);
  if (_faceTmp.lengthSq() < 1e-6) return;   // 玩家与 plane 重合时跳过
  _faceTmp.normalize();
  _faceQ.setFromUnitVectors(_faceZ, _faceTmp);
  mesh.quaternion.copy(_faceQ);
}


// 对 JPG 白底做**软阈值抠图 + 边缘去白边**（VFX_MODE='texture'）
// 相对原「硬二值颜色键」方案的 4 项修复（原方案 10~15 倍放大后锯齿/白边/破洞的根源）：
//   1) 白度改用**最小通道**判定：金色高光的 min 通道很低 → 不会被误杀成破洞
//      （原方案要求 R/G/B 同时超阈值，金色过曝区会中招被打出麻点）
//   2) smoothstep **软阈值** → 边缘半透明过渡，消除硬边锯齿
//   3) alpha **羽化**（盒式模糊）→ 消 JPG 8×8 分块压缩产生的边缘振铃伪影
//   4) **去白边 / de-contamination**：半透明像素的 RGB 用邻域内不透明像素的颜色替换
//      → 彻底去掉原方案那圈"白描边"
// 另加轻度饱和/亮度增强与 mipmap + 各向异性过滤，缓解放大后的模糊与噪闪。
function _processAlpha(img, o) {
  const sw = img.width || img.videoWidth || 512;
  const sh = img.height || img.videoHeight || 512;
  const up = Math.max(1, Math.floor(o.UPSCALE || 1));            // 扣图前上采样倍数
  const w = Math.round(sw * up), h = Math.round(sh * up);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const N = w * h;

  // —— 1) 软阈值 alpha：白度 = 最小通道（白底 min≈255，金色 min 低）——
  const thr = (o.COLOR_KEY_THRESHOLD != null ? o.COLOR_KEY_THRESHOLD : 0.95) * 255;
  const soft = Math.max(1, (o.EDGE_SOFTNESS != null ? o.EDGE_SOFTNESS : 0.06) * 255);
  const satSafe = (o.SAT_SAFE != null ? o.SAT_SAFE : 0.25);
  const a = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const maxc = Math.max(r, g, b), minc = Math.min(r, g, b);
    const sat = maxc > 0 ? (maxc - minc) / maxc : 0;
    if (sat > satSafe) { a[p] = 1; continue; }     // 高饱和=明确是金色，强制不透明（防过曝高光被抠成洞）
    const t = (thr - minc) / soft;                 // ≤0 全透，≥1 全不透
    a[p] = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); // smoothstep 过渡
  }

  // —— 2) 边缘羽化：两趟盒式模糊，抹平 JPG 分块伪影 ——
  const fr = Math.max(0, Math.round((o.EDGE_FEATHER != null ? o.EDGE_FEATHER : 1.5) * up));
  if (fr > 0) {
    const tmp = new Float32Array(N);
    const win = fr * 2 + 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -fr; k <= fr; k++) s += a[y * w + Math.min(w - 1, Math.max(0, x + k))];
        tmp[y * w + x] = s / win;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -fr; k <= fr; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
        a[y * w + x] = s / win;
      }
    }
  }

  // —— 2.5) 补洞：低 alpha 但被不透明像素包围的像素（掌内过曝高光）恢复不透明 ——
  // 只处理"邻域绝大多数不透明"的像素，因此不会影响与画布相连的白底区域。
  const holeFill = (o.HOLE_FILL != null ? o.HOLE_FILL : 0.8);
  if (holeFill > 0) {
    const hr = Math.max(1, Math.round((o.HOLE_RADIUS != null ? o.HOLE_RADIUS : 4) * up));
    const snap = new Float32Array(a);
    const win2 = (hr * 2 + 1) * (hr * 2 + 1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (snap[p] >= 0.5) continue;              // 只需修"疑似洞"
        let s2 = 0;
        for (let dy = -hr; dy <= hr; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) { s2 += 0; continue; }
          for (let dx = -hr; dx <= hr; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) { s2 += 0; continue; }
            s2 += snap[yy * w + xx];
          }
        }
        const mean = s2 / win2;
        if (mean >= holeFill) a[p] = mean;         // 邻域多数不透明 → 这是洞，填回
      }
    }
  }

  // —— 3) 去白边：半透明像素用邻域内不透明像素的颜色替换，消掉"白描边" ——
  const dec = (o.DECONTAM != null ? o.DECONTAM : 1);
  if (dec > 0) {
    const dr = Math.max(1, Math.round((o.DECONTAM_RADIUS != null ? o.DECONTAM_RADIUS : 3) * up));
    const srcRgb = new Uint8ClampedArray(d);       // 原始 RGB 快照（避免边算边改）
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const av = a[p];
        if (av >= 0.98 || av <= 0.02) continue;    // 只处理边缘过渡带
        let sr = 0, sg = 0, sb = 0, sw2 = 0;
        for (let dy = -dr; dy <= dr; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -dr; dx <= dr; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (a[q] < 0.9) continue;              // 只取"确实不透明"的邻域
            sr += srcRgb[q * 4] * a[q];
            sg += srcRgb[q * 4 + 1] * a[q];
            sb += srcRgb[q * 4 + 2] * a[q];
            sw2 += a[q];
          }
        }
        if (sw2 > 0) {
          const i = p * 4;
          d[i]     += (sr / sw2 - d[i])     * dec;
          d[i + 1] += (sg / sw2 - d[i + 1]) * dec;
          d[i + 2] += (sb / sw2 - d[i + 2]) * dec;
        }
      }
    }
  }

  // —— 4) 饱和/亮度增强 + 写回 alpha ——
  const sat = (o.SATURATION != null ? o.SATURATION : 1);
  const bri = (o.BRIGHTNESS != null ? o.BRIGHTNESS : 1);
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    let r = d[i] * bri, g = d[i + 1] * bri, b = d[i + 2] * bri;
    if (sat !== 1) {
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      r = lum + (r - lum) * sat;
      g = lum + (g - lum) * sat;
      b = lum + (b - lum) * sat;
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
    d[i + 3] = Math.round(Math.min(1, Math.max(0, a[p])) * 255);
  }
  ctx.putImageData(imgData, 0, 0);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;   // mipmap：10 倍放大时不噪闪
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = Math.max(1, o.ANISOTROPY != null ? o.ANISOTROPY : 4); // 斜视/放大更清晰
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// 模块级预加载：game.js import 本模块即开始加载贴图，首次释放时无需等待。
// 注：shader 方案下 _tex 不参与渲染，但仍保留预加载，保证 VFX_MODE 可随时热切回 'texture' 而不必重启。
let _tex = null;
let _ready = false;
const _callbacks = [];
const loader = new THREE.TextureLoader();
loader.load(
  BUDDHA.TEXTURE_URL,
  (tex) => {
    try {
      _tex = _processAlpha(tex.image, BUDDHA);
    } catch (e) {
      console.warn('[BuddhaFx] 颜色键处理失败，回退原贴图', e);
      _tex = tex;
    }
    _ready = true;
    while (_callbacks.length) _callbacks.shift()();
  },
  undefined,
  (err) => {
    console.error('[BuddhaFx] 贴图加载失败', BUDDHA.TEXTURE_URL, err);
    _ready = true;
    while (_callbacks.length) _callbacks.shift()();
  }
);

// ============================================================================
// 程序化 Canvas 金掌贴图（VFX_MODE='canvas'，默认）
// 由 palmCanvas.js 用 Canvas2D 矢量绘制：真实比例手掌轮廓 + 金色渐变 + 外发光 +
// 掌纹 + 掌心法阵 + 能量火花，输出**自带软 alpha**的贴图，无需任何外部素材。
// 一次性生成（~100ms），此后每帧渲染成本与贴图方案完全相同。
// ============================================================================
let _canvasTex = null;
function _getCanvasTex() {
  if (_canvasTex) return _canvasTex;
  try {
    const cv = makePalmCanvas(BUDDHA, BUDDHA.CANVAS_W, BUDDHA.CANVAS_H);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter; // 带 mipmap：10 倍放大时不噪闪
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    _canvasTex = tex;
  } catch (e) {
    console.warn('[BuddhaFx] 程序化掌图生成失败，回退 JPG 贴图', e);
    _canvasTex = null;
  }
  return _canvasTex;
}

// ============================================================================
// 程序化 SDF 金掌（VFX_MODE='shader'）
// 动机：原 JPG 白底抠图在 10 倍放大下锯齿/白边/高光破洞严重；SDF 用解析距离场
//       绘制掌形，天然抗锯齿（无需 MSAA，本项目已关 antialias），且放大不失真。
// 性能：与贴图方案填充率完全相同（同为 1 个平面、1 次绘制），仅把「1 次贴图采样」
//       换成「约 80 条 ALU」；能量流动用 1 次小噪声采样代替 3 层 fbm，省一个数量级。
//       掌外像素直接 discard，省去无谓的混合带宽。
// 回退：把 BUDDHA.VFX_MODE 改成 'texture' 即恢复原贴图方案（命中/缩放/时序完全一致）。
// ============================================================================

// 生成可平铺值噪声贴图（一次性，128² 耗时可忽略），供片元着色器单次采样做能量流动。
function _makeNoiseTexture(size) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const smooth = (t) => t * t * (3 - 2 * t);
  // 三个八度的随机网格（8/16/32），加权叠加成平滑噪声
  const octaves = [8, 16, 32];
  const weights = [0.5, 0.3, 0.2];
  const grids = octaves.map((n) => {
    const a = new Float32Array(n * n);
    for (let i = 0; i < a.length; i++) a[i] = Math.random();
    return { n, a };
  });
  const samp = (g, u, v) => {
    const n = g.n;
    const x = u * n, y = v * n;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const i0 = ((x0 % n) + n) % n, j0 = ((y0 % n) + n) % n;
    const i1 = (i0 + 1) % n, j1 = (j0 + 1) % n;
    const v00 = g.a[j0 * n + i0], v10 = g.a[j0 * n + i1];
    const v01 = g.a[j1 * n + i0], v11 = g.a[j1 * n + i1];
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let n = 0;
      for (let i = 0; i < grids.length; i++) n += samp(grids[i], u, v) * weights[i];
      const c = Math.max(0, Math.min(255, (n * 255) | 0));
      const k = (y * size + x) * 4;
      data[k] = c; data[k + 1] = c; data[k + 2] = c; data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

let _noiseTex = null;
function _getNoiseTex() {
  if (!_noiseTex) _noiseTex = _makeNoiseTexture(BUDDHA.NOISE_SIZE || 128);
  return _noiseTex;
}

const PALM_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PALM_FRAG = `
  uniform float uTime;          // 累计时间（秒）：驱动能量流动
  uniform float uCharge;        // 蓄能进度 0→1（grow 阶段）
  uniform float uOpacity;       // 淡出不透明度 0→1
  uniform float uShapeScale;    // 掌形整体放大系数
  uniform float uAA;            // 边缘抗锯齿倍率（fwidth 系数）
  uniform float uRimWidth;      // 边缘金光厚度
  uniform float uNoiseScale;    // 噪声密度
  uniform float uNoiseSpeed;    // 能量流动速度
  uniform float uNoiseStrength; // 能量流动强度 0~1
  uniform float uGlow;          // 整体辉光倍率
  uniform float uChargeGlow;    // 蓄能增亮幅度
  uniform vec3  uColDeep;       // 掌根暗金
  uniform vec3  uColBright;     // 掌尖明金
  uniform vec3  uColRim;        // 边缘金光
  uniform sampler2D uNoise;     // 能量噪声图（128²，可平铺）
  varying vec2 vUv;

  // 圆角矩形（掌）
  float sdBox(vec2 p, vec2 b, float r) {
    vec2 d = abs(p) - b + r;
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - r;
  }
  // 线段/胶囊（手指、拇指）
  float sdSeg(vec2 p, vec2 a, vec2 b, float r) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h) - r;
  }
  // 多项式平滑最小值：让掌与手指圆滑过渡，不出现硬接缝
  float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
  }

  // 手掌 SDF：掌 + 四指 + 拇指
  float palmSDF(vec2 p) {
    float d = sdBox(p - vec2(0.0, -0.36), vec2(0.46, 0.56), 0.20);              // 掌
    d = smin(d, sdSeg(p, vec2(-0.33, 0.06), vec2(-0.40, 0.90), 0.105), 0.10);   // 食指
    d = smin(d, sdSeg(p, vec2(-0.11, 0.14), vec2(-0.13, 1.05), 0.110), 0.10);   // 中指
    d = smin(d, sdSeg(p, vec2( 0.11, 0.12), vec2( 0.16, 0.95), 0.105), 0.10);   // 无名指
    d = smin(d, sdSeg(p, vec2( 0.33, 0.00), vec2( 0.40, 0.74), 0.090), 0.10);   // 小指
    d = smin(d, sdSeg(p, vec2(-0.44, -0.32), vec2(-0.80, -0.68), 0.120), 0.12); // 拇指
    return d;
  }

  void main() {
    // 长宽比校正：平面 4m(W) × 6m(H) → y 放大到 ±1.5，保证圆形不变形
    vec2 p = vec2((vUv.x - 0.5) * 2.0, (vUv.y - 0.5) * 3.0);
    // 整体缩放 + 右移（抵消拇指左伸，让掌居中）
    float d = palmSDF((p - vec2(0.20, 0.0)) / uShapeScale) * uShapeScale;
    // 解析抗锯齿：已关闭 MSAA 的情况下依然得到平滑边缘（放大 10 倍也不失真）
    float aa = fwidth(d) * uAA;
    float mask = 1.0 - smoothstep(-aa, aa, d);
    if (mask <= 0.002) discard;   // 掌外像素直接丢弃，省混合带宽

    float inside = -d;            // 内部为正距离
    // 主体渐变：下深上亮
    vec3 col = mix(uColDeep, uColBright, clamp((p.y + 1.2) / 2.3, 0.0, 1.0));
    // 边缘金光
    float rim = 1.0 - smoothstep(0.0, uRimWidth, inside);
    col = mix(col, uColRim, rim * 0.85);
    // 能量流动（1 次噪声采样，比片元内跑 fbm 便宜一个数量级）
    float n = texture2D(uNoise, vUv * uNoiseScale + vec2(0.0, -uTime * uNoiseSpeed)).r;
    col *= (1.0 - uNoiseStrength) + uNoiseStrength * (0.5 + n);
    // 蓄能增亮（grow 阶段由暗到亮）
    col *= (1.0 - uChargeGlow) + uChargeGlow * uCharge;
    // 加法混合：src.rgb × src.a 叠加到背景，得到真实的发光感
    gl_FragColor = vec4(col * uGlow, mask * uOpacity);
  }
`;

// 创建程序化金掌材质（ShaderMaterial）。失败时由调用方回退到贴图方案。
function _makeShaderMaterial() {
  const uniforms = {
    uTime:          { value: 0 },
    uCharge:        { value: 0 },
    uOpacity:       { value: 1 },
    uShapeScale:    { value: BUDDHA.SHAPE_SCALE },
    uAA:            { value: BUDDHA.AA },
    uRimWidth:      { value: BUDDHA.RIM_WIDTH },
    uNoiseScale:    { value: BUDDHA.NOISE_SCALE },
    uNoiseSpeed:    { value: BUDDHA.NOISE_SPEED },
    uNoiseStrength: { value: BUDDHA.NOISE_STRENGTH },
    uGlow:          { value: BUDDHA.GLOW },
    uChargeGlow:    { value: BUDDHA.CHARGE_GLOW },
    uColDeep:       { value: new THREE.Color(BUDDHA.COL_DEEP) },
    uColBright:     { value: new THREE.Color(BUDDHA.COL_BRIGHT) },
    uColRim:        { value: new THREE.Color(BUDDHA.COL_RIM) },
    uNoise:         { value: _getNoiseTex() },
  };
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: PALM_VERT,
    fragmentShader: PALM_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // ADDITIVE=true 加法混合（发光更炫）；false 则用普通混合（掌更"实"）
    blending: BUDDHA.ADDITIVE ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

// 如来神掌视觉特效
// 阶段1（GROW_TIME）：在 START_POS 由 START_SCALE 放大到 END_SCALE（分两段：0.0→0.5、0.5→1.0）
// 阶段2（MOVE_TIME）：沿 +Z 从 START_POS 移动到 END_POS
// 阶段3（PAUSE_TIME）：停在 END_POS
// 阶段4（FADE_TIME）：淡出并销毁
export class BuddhaFx {
  constructor(scene) {
    this.scene = scene;
    this._camera = null;
    this._mesh = null;
    this._started = false;
    this._disposed = false;
    this._t = 0;
    this.phase = 'idle';            // idle/build → grow(变化) → move(运动) → pause(静止) → fade → done
    this.position = new THREE.Vector3(); // 当前世界坐标（供 game 做命中判定）
    // shader 方案的 uniform 引用（贴图方案下保持 null）
    this._uTime = null;
    this._uCharge = null;
    this._uOpacity = null;
  }

  // 仅在「变化(grow)/运动(move)」阶段造成伤害；停顿(pause)/淡出(fade)不造成伤害
  get isDamaging() { return this.phase === 'grow' || this.phase === 'move'; }

  // 当前缩放倍数（供 game 计算命中盒大小）
  get scale() { return this._mesh ? this._mesh.scale.x : BUDDHA.START_SCALE; }

  start(camera) {
    if (this._started || this._disposed) return this;
    this._camera = camera || null;
    // canvas 方案不依赖外部贴图，立即可建；其余方案等 JPG 加载完成
    if (_ready || BUDDHA.VFX_MODE === 'canvas') {
      this._build();
    } else {
      _callbacks.push(() => { if (!this._disposed) this._build(); });
    }
    return this;
  }

  _build() {
    if (this._started || this._disposed) return;
    this._started = true;

    const geo = new THREE.PlaneGeometry(BUDDHA.PLANE_WIDTH, BUDDHA.PLANE_HEIGHT);
    let mat = null;
    // 视觉方案：'canvas'=程序化 Canvas 矢量金掌（默认，推荐）；
    //           'shader'=程序化 SDF 金掌；'texture'=原 JPG 白底抠图（终极回退）
    if (BUDDHA.VFX_MODE === 'canvas') {
      try {
        const cvTex = _getCanvasTex();
        if (cvTex) {
          mat = new THREE.MeshBasicMaterial({
            map: cvTex,
            transparent: true,
            opacity: 1,
            side: THREE.DoubleSide,
            depthWrite: false,
            // ADDITIVE=true 加法混合（发光更炫，掌半透）；false 普通混合（掌更实）
            blending: BUDDHA.ADDITIVE ? THREE.AdditiveBlending : THREE.NormalBlending,
          });
        }
      } catch (e) {
        console.warn('[BuddhaFx] canvas 掌图创建失败，自动回退贴图方案', e);
        mat = null;
      }
    }
    if (!mat && BUDDHA.VFX_MODE === 'shader') {
      try {
        mat = _makeShaderMaterial();
        this._uTime = mat.uniforms.uTime;
        this._uCharge = mat.uniforms.uCharge;
        this._uOpacity = mat.uniforms.uOpacity;
      } catch (e) {
        // 任何异常都自动回退到贴图方案，保证技能永远有视觉表现
        console.warn('[BuddhaFx] shader 方案创建失败，自动回退贴图方案', e);
        mat = null;
      }
    }
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({
        map: _tex,
        transparent: true,
        opacity: 1,
        side: THREE.DoubleSide,
        depthWrite: false,
        // ADDITIVE=false 普通混合（与原版一致，掌更实）；true 则加法混合更炫
        blending: BUDDHA.ADDITIVE ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
    }
    this._mesh = new THREE.Mesh(geo, mat);

    _startPos.set(BUDDHA.START_POS.x, BUDDHA.START_POS.y, BUDDHA.START_POS.z);
    this._mesh.position.copy(_startPos);
    this._mesh.scale.setScalar(BUDDHA.START_SCALE);

    if (this._camera) _faceCamera(this._mesh, this._camera);
    this.scene.add(this._mesh);
  }

  update(dt) {
    if (this._disposed) { this.phase = 'done'; return true; } // 已结束
    if (!this._started) { this.phase = 'idle'; return false; } // 还没建好（等贴图）

    this._t += dt;
    const t = this._t;
    const {
      GROW_TIME, START_SCALE, END_SCALE,
      MOVE_TIME, PAUSE_TIME, FADE_TIME,
    } = BUDDHA;

    // shader 方案：驱动时间与蓄能进度（贴图方案下引用为 null，直接跳过）
    if (this._uTime) this._uTime.value = t;
    if (this._uCharge) this._uCharge.value = t < GROW_TIME ? t / GROW_TIME : 1;

    _startPos.set(BUDDHA.START_POS.x, BUDDHA.START_POS.y, BUDDHA.START_POS.z);
    _endPos.set(BUDDHA.END_POS.x, BUDDHA.END_POS.y, BUDDHA.END_POS.z);

    // 阶段1：原地放大（变化 grow）——此阶段造成伤害
    if (t < GROW_TIME) {
      this.phase = 'grow';
      const k = t / GROW_TIME; // 0→1
      const half = k < 0.5 ? k * 2 : (k - 0.5) * 2; // 每段内部 0→1
      const from = k < 0.5 ? START_SCALE : (START_SCALE + END_SCALE) * 0.5;
      const to = k < 0.5 ? (START_SCALE + END_SCALE) * 0.5 : END_SCALE;
      const s = THREE.MathUtils.lerp(from, to, half);
      this._mesh.position.copy(_startPos);
      this._mesh.scale.setScalar(s);
    }
    // 阶段2：沿 +Z 移动（运动 move）——此阶段造成伤害
    else if (t < GROW_TIME + MOVE_TIME) {
      this.phase = 'move';
      const k = (t - GROW_TIME) / MOVE_TIME;
      this._mesh.position.lerpVectors(_startPos, _endPos, k);
      this._mesh.scale.setScalar(END_SCALE);
    }
    // 阶段3：停顿（pause，静止，不造成伤害）
    else if (t < GROW_TIME + MOVE_TIME + PAUSE_TIME) {
      this.phase = 'pause';
      this._mesh.position.copy(_endPos);
      this._mesh.scale.setScalar(END_SCALE);
    }
    // 阶段4：淡出（fade，不造成伤害）
    else if (t < GROW_TIME + MOVE_TIME + PAUSE_TIME + FADE_TIME) {
      this.phase = 'fade';
      this._mesh.position.copy(_endPos);
      const k = (t - GROW_TIME - MOVE_TIME - PAUSE_TIME) / FADE_TIME;
      const op = THREE.MathUtils.lerp(1, 0, k);
      this._mesh.material.opacity = op;              // 贴图方案用
      if (this._uOpacity) this._uOpacity.value = op; // shader 方案用
    }
    else {
      this.phase = 'done';
      this.dispose();
      return true;
    }

    this.position.copy(this._mesh.position);
    // 始终面朝相机
    if (this._camera) _faceCamera(this._mesh, this._camera);
    return false;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._mesh) {
      this._mesh.geometry.dispose();
      this._mesh.material.dispose();
      this.scene.remove(this._mesh);
      this._mesh = null;
    }
    this._uTime = null;
    this._uCharge = null;
    this._uOpacity = null;
    this._camera = null;
  }
}
