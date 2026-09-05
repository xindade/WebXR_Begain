import * as THREE from 'three';
import { BUDDHA } from '../core/constants.js';

const _endPos = new THREE.Vector3();
const _startPos = new THREE.Vector3();
const _midScale = new THREE.Vector3();

// 对 JPG 白底做颜色键：把接近纯白的像素 alpha 置 0，让掌图在场景里像透明图层。
function _processAlpha(img, threshold) {
  const w = img.width || img.videoWidth || 512;
  const h = img.height || img.videoHeight || 512;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const thr = threshold * 255;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    // 只剔除高亮背景（R/G/B 均超过阈值），保留金色掌本体与高光
    if (r > thr && g > thr && b > thr) d[i + 3] = 0;
  }
  ctx.putImageData(imgData, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 模块级预加载：game.js import 本模块即开始加载贴图，首次释放时无需等待。
let _tex = null;
let _ready = false;
const _callbacks = [];
const loader = new THREE.TextureLoader();
loader.load(
  BUDDHA.TEXTURE_URL,
  (tex) => {
    try {
      _tex = _processAlpha(tex.image, BUDDHA.COLOR_KEY_THRESHOLD);
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
  }

  // 仅在「变化(grow)/运动(move)」阶段造成伤害；停顿(pause)/淡出(fade)不造成伤害
  get isDamaging() { return this.phase === 'grow' || this.phase === 'move'; }

  // 当前缩放倍数（供 game 计算命中盒大小）
  get scale() { return this._mesh ? this._mesh.scale.x : BUDDHA.START_SCALE; }

  start(camera) {
    if (this._started || this._disposed) return this;
    this._camera = camera || null;
    if (_ready) {
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
    const mat = new THREE.MeshBasicMaterial({
      map: _tex,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this._mesh = new THREE.Mesh(geo, mat);

    _startPos.set(BUDDHA.START_POS.x, BUDDHA.START_POS.y, BUDDHA.START_POS.z);
    this._mesh.position.copy(_startPos);
    this._mesh.scale.setScalar(BUDDHA.START_SCALE);

    if (this._camera) this._mesh.lookAt(this._camera.position);
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
      this._mesh.material.opacity = THREE.MathUtils.lerp(1, 0, k);
    }
    else {
      this.phase = 'done';
      this.dispose();
      return true;
    }

    this.position.copy(this._mesh.position);
    // 始终面朝相机
    if (this._camera) this._mesh.lookAt(this._camera.position);
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
    this._camera = null;
  }
}
