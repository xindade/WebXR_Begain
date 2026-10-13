import * as THREE from 'three';
import { FX } from '../core/constants.js';

// ============================================================
// 打击感视觉层（档2 · 第四十一修）：曳光 / 命中火花 / 击杀碎片 / 枪口焰
//
// 为什么单开一个模块：这四项都是「每帧量大、寿命极短」的东西，必须
//   ① 预分配池（零 per-frame new —— GC 抖动会直接砸在 72fps 预算上）
//   ② InstancedMesh（一次 draw call 承载全部实例）
//   ③ 淡出**不改材质透明度**（材质是共享的，改透明度会触发着色器重编译）
//      → 统一用「加色混合 + 逐实例调暗 instanceColor」等效实现淡出。
//
// 三条踩过的坑（照抄代码前先看这里）：
//   · three r168 的逐实例色**不需要** material.vertexColors：片元前缀在
//     parameters.instancingColor 时会自动 #define USE_COLOR
//     （vendor/three.module.js:20050），否则 color_fragment 里的
//     diffuseColor *= vColor 不生效 → 所有实例会是同一个颜色。
//   · 弹道尾迹不能用「上一帧→这一帧」的线段：72fps 下只有 0.2m，看起来就是
//     一颗孤零零的球在飞。这里按 cfg.LENGTH 固定从弹头向后拖，长度与帧率无关。
//   · 火花/碎片不用 Sprite：Sprite 无法实例化，每粒一个 Sprite 就是一次 draw call。
//     改用低面数球/方块（不需要 billboard），加色混合下天然就是「发光颗粒」。
// ============================================================

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _col = new THREE.Color();

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (range) => range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1));

// 模块级共享几何（整页生命周期不变，不参与 dispose —— 多个系统共用同一份）
let _boxGeo = null;
let _dotGeo = null;
function boxGeo() { if (!_boxGeo) _boxGeo = new THREE.BoxGeometry(1, 1, 1); return _boxGeo; }
function dotGeo() { if (!_dotGeo) _dotGeo = new THREE.IcosahedronGeometry(1, 0); return _dotGeo; }

// ---------------------------------------------------------------- 曳光
// 每帧由 game 统一喂一次（玩家子弹 + 敌方投射物共用同一条实例网格）。
export class TracerTail {
  constructor(scene, cfg = FX.TRACER) {
    this.cfg = cfg;
    this.capacity = Math.max(1, cfg.CAPACITY | 0);
    this._n = 0;
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: cfg.OPACITY,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(boxGeo(), mat, this.capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;   // 逐实例包围盒不准，关裁剪免得整条消失
    mesh.count = 0;
    mesh.renderOrder = 4;
    mesh.name = 'fx-tracer';
    scene.add(mesh);
    this.mesh = mesh;
  }

  begin() { this._n = 0; }

  /**
   * pos = 弹头位置；dir = 单位飞行方向（调用方负责归一化）；尾迹沿 -dir 拖出。
   * back（第四十二修）= 允许往后拖的最大长度，一般传「弹头到出生点的距离」：
   *   子弹出生点在枪管内部（SHOOT.SPAWN_OFFSET），若照常拖满 LENGTH，
   *   弹头刚出膛那几帧尾迹会整条穿到枪管后方（玩家看到的「曳光延伸到枪管背后」）。
   *   不足 MIN_BACK 干脆不画（那几帧交给枪口焰）。
   * @returns {boolean} 是否真的写入了一条
   */
  add(pos, dir, colorHex, back) {
    if (this._n >= this.capacity) return false;
    const maxBack = back == null ? this.cfg.LENGTH : back;
    const len = Math.min(maxBack, this.cfg.LENGTH);
    if (!(len > (this.cfg.MIN_BACK || 0))) return false;
    const w = this.cfg.WIDTH;
    _q.setFromUnitVectors(_up, dir);                 // 立方体长轴取 Y → 旋到飞行方向
    _v.copy(dir).multiplyScalar(-len * 0.5).add(pos); // 中点 = 弹头后方半个长度
    _sc.set(w, len, w);
    _m.compose(_v, _q, _sc);
    const i = this._n++;
    this.mesh.setMatrixAt(i, _m);
    this.mesh.setColorAt(i, _col.setHex(colorHex == null ? this.cfg.COLOR : colorHex));
    return true;
  }

  end() {
    this.mesh.count = this._n;
    if (this._n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  clear() { this._n = 0; this.mesh.count = 0; }

  dispose() {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.mesh.material.dispose();   // 几何是共享的，不 dispose
    this.cfg = null;
  }
}

// ---------------------------------------------------------------- 颗粒池（火花 / 碎片共用）
// 两者只差数值：火花轻、不受重力、寿命 0.14s；碎片受重力、寿命 0.55s。
export class ParticlePool {
  constructor(scene, cfg, geo) {
    this.cfg = cfg;
    this.capacity = Math.max(1, cfg.POOL | 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, this.capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.renderOrder = 4;
    scene.add(mesh);
    this.mesh = mesh;
    this.items = [];   // 活跃颗粒（结构复用 → 回池，不销毁）
    this._pool = [];
  }

  get activeCount() { return this.items.length; }

  _obtain() {
    let it = this._pool.pop();
    if (!it) {
      it = {
        p: new THREE.Vector3(), v: new THREE.Vector3(),
        t: 0, life: 1, size: 0.1, spin: 0, angle: 0, color: new THREE.Color(),
      };
    }
    it.t = 0;
    this.items.push(it);
    return it;
  }

  _releaseAt(i) {
    const last = this.items.length - 1;
    const it = this.items[i];
    if (i !== last) this.items[i] = this.items[last];
    this.items.pop();
    this._pool.push(it);
  }

  /** 在 pos 爆开一次（colorHex 主色；mul = 数量倍率，精英/Boss 多爆几片） */
  burst(pos, colorHex, mul = 1) {
    if (this.cfg.ENABLED === false) return;
    const C = this.cfg;
    const n = Math.max(1, Math.round(randInt(C.COUNT) * mul));
    // 池满先腾位置：丢掉最旧的（视觉上是「远处的先淡掉」，不会整体卡住不出）
    while (this.items.length + n > this.capacity && this.items.length > 0) this._releaseAt(0);
    for (let i = 0; i < n; i++) {
      const it = this._obtain();
      it.p.copy(pos);
      it.v.set(rand(-1, 1), rand(-1, 1), rand(-1, 1));
      if (it.v.lengthSq() < 1e-6) it.v.set(0, 1, 0);
      it.v.normalize().multiplyScalar(C.SPEED * rand(0.5, 1.15));
      it.life = C.LIFE * rand(0.75, 1.1);
      it.size = C.SIZE * rand(0.7, 1.3);
      it.spin = C.SPIN || 0;
      it.angle = Math.random() * Math.PI * 2;
      it.color.setHex(colorHex == null ? C.COLOR : colorHex);
    }
  }

  update(dt) {
    const C = this.cfg;
    let n = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      if (it.t >= it.life) { this._releaseAt(i); continue; }
      if (C.GRAVITY) it.v.y -= C.GRAVITY * dt;
      it.p.addScaledVector(it.v, dt);
      const k = it.t / it.life;
      const s = it.size * (1 - k * 0.85);   // 收缩 + 变暗 = 消散
      if (it.spin) { it.angle += it.spin * dt; _q.setFromAxisAngle(_up, it.angle); }
      else _q.identity();
      _sc.set(s, s, s);
      _m.compose(it.p, _q, _sc);
      this.mesh.setMatrixAt(n, _m);
      this.mesh.setColorAt(n, _col.copy(it.color).multiplyScalar(1 - k));
      n++;
    }
    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  clear() { while (this.items.length > 0) this._releaseAt(this.items.length - 1); this.mesh.count = 0; }

  dispose() {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.mesh.material.dispose();
    this.items.length = 0;
    this._pool.length = 0;
    this.cfg = null;
  }
}

// ---------------------------------------------------------------- 枪口焰
function _buildFlashTexture() {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 128;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0.00, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 一枚枪口焰 = 一个加色 Sprite，出现在**真实枪口世界坐标**（与红射线/子弹同源）。
//   刻意不加 PointLight：动态光源会让整场 PBR 材质重编译/重算，代价远大于收益。
export class MuzzleFlash {
  constructor(scene, cfg = FX.MUZZLE) {
    this.cfg = cfg;
    this._tex = _buildFlashTexture();
    this._slots = [];
    for (let i = 0; i < Math.max(1, cfg.POOL | 0); i++) {
      const mat = new THREE.SpriteMaterial({
        map: this._tex, color: cfg.COLOR, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, opacity: 0,
      });
      const sp = new THREE.Sprite(mat);
      sp.visible = false;
      sp.renderOrder = 4;
      scene.add(sp);
      this._slots.push({ sp, t: Infinity });
    }
    this._next = 0;
  }

  flash(pos, dir) {
    if (this.cfg.ENABLED === false) return;
    const slot = this._slots[this._next++ % this._slots.length];   // 轮转：并发也各占一格
    slot.sp.position.copy(pos);
    // 第四十二修：出生点在枪管**内部** → 沿枪口方向再前移 FORWARD，
    //   否则一多半焰光被枪管自身挡掉（depthTest 生效），看着像光从枪管背后漏出来。
    const fwd = this.cfg.FORWARD || 0;
    if (dir && fwd) {
      _v.copy(dir);
      const L = _v.length();
      if (L > 1e-6) slot.sp.position.addScaledVector(_v, fwd / L);
    }
    slot.sp.visible = true;
    slot.t = 0;
  }

  update(dt) {
    for (const s of this._slots) {
      if (s.t === Infinity) continue;
      s.t += dt;
      const k = s.t / this.cfg.LIFE;
      if (k >= 1) { s.t = Infinity; s.sp.visible = false; s.sp.material.opacity = 0; continue; }
      const sc = this.cfg.SIZE * (1 - k * 0.5);
      s.sp.scale.set(sc, sc, 1);
      s.sp.material.opacity = 1 - k;
    }
  }

  clear() {
    for (const s of this._slots) { s.t = Infinity; s.sp.visible = false; s.sp.material.opacity = 0; }
  }

  dispose() {
    for (const s of this._slots) {
      if (s.sp.parent) s.sp.parent.remove(s.sp);
      s.sp.material.dispose();
    }
    this._slots.length = 0;
    if (this._tex) this._tex.dispose();
    this.cfg = null;
  }
}

// ---------------------------------------------------------------- 汇总门面
export class FxEffects {
  constructor(scene) {
    this.scene = scene;
    this.tracer = new TracerTail(scene, FX.TRACER);
    this.sparks = new ParticlePool(scene, FX.SPARK, dotGeo());
    this.debris = new ParticlePool(scene, FX.DEBRIS, boxGeo());
    this.muzzleFx = new MuzzleFlash(scene, FX.MUZZLE);
  }

  /** 命中火花：colorHex 省略用配置里的默认暖金 */
  spark(pos, colorHex) { this.sparks.burst(pos, colorHex == null ? FX.SPARK.COLOR : colorHex, 1); }

  /** 击杀碎片：colorHex 建议取该敌种 tint；mul 给精英/Boss 放大数量 */
  debrisBurst(pos, colorHex, mul = 1) {
    this.debris.burst(pos, colorHex == null ? FX.DEBRIS.COLOR : colorHex, mul);
  }

  muzzle(pos, dir) { this.muzzleFx.flash(pos, dir); }

  update(dt) {
    this.sparks.update(dt);
    this.debris.update(dt);
    this.muzzleFx.update(dt);
  }

  clear() {
    this.tracer.clear();
    this.sparks.clear();
    this.debris.clear();
    this.muzzleFx.clear();
  }

  dispose() {
    this.tracer.dispose();
    this.sparks.dispose();
    this.debris.dispose();
    this.muzzleFx.dispose();
  }
}