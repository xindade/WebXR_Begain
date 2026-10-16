import * as THREE from 'three';
import { FX, HEAL_LINK, SHOP_COIN } from '../core/constants.js';

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
   * lenScale（第四十九修）= 长度倍率（连杀加速期的弹曳光加长，见 RAPID_FIRE.VISUAL.TRACER_MUL）；
   *   后拖上限 back 仍然生效，所以刚出膛那几帧依旧不会穿到枪管后面。
   * @returns {boolean} 是否真的写入了一条
   */
  add(pos, dir, colorHex, back, lenScale = 1) {
    if (this._n >= this.capacity) return false;
    const maxBack = back == null ? this.cfg.LENGTH * lenScale : back;
    const len = Math.min(maxBack, this.cfg.LENGTH * lenScale);
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

// ---------------------------------------------------------------- 治疗线（第四十六修）
// 治疗术士（heart）与它正在治疗的怪之间画一条绿线，线上有绿色加号朝目标飘。
//   · 线：每条一个 Line（2 顶点 buffer），共用一份材质；
//   · 加号：每条线 PLUS_COUNT 个 Sprite（贴图缓存、各自一份材质以便独立透明度）；
//   · 全部对象池化（按需增长到 MAX_TARGETS 条），帧内不 new。
const _plusTexCache = { tex: null };
function plusTexture() {
  if (_plusTexCache.tex) return _plusTexCache.tex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  x.clearRect(0, 0, 64, 64);
  // 画成白色：颜色由使用方用 SpriteMaterial.color 染（绿 = 治疗线/回血环，粉 = 第四十九修返工的飞行加号）
  x.strokeStyle = '#ffffff';
  x.lineWidth = 12; x.lineCap = 'round';
  x.beginPath(); x.moveTo(32, 12); x.lineTo(32, 52); x.moveTo(12, 32); x.lineTo(52, 32); x.stroke();
  _plusTexCache.tex = new THREE.CanvasTexture(c);
  _plusTexCache.tex.colorSpace = THREE.SRGBColorSpace;
  return _plusTexCache.tex;
}

export class HealLinkFx {
  constructor(scene, cfg = HEAL_LINK) {
    this.scene = scene;
    this.cfg = cfg;
    this.lines = [];
    this._t = 0;
    this._mat = new THREE.LineBasicMaterial({
      color: cfg.COLOR, transparent: true, opacity: cfg.OPACITY, depthWrite: false, depthTest: false,
    });
    this._tex = plusTexture();
  }

  _grow() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(geo, this._mat);
    line.frustumCulled = false;
    line.renderOrder = 998;
    this.scene.add(line);
    const sprites = [];
    for (let i = 0; i < this.cfg.PLUS_COUNT; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this._tex, color: this.cfg.COLOR,      // 贴图是白的：这里染色（治疗线 = 绿）
        transparent: true, depthTest: false, depthWrite: false,
      });
      const sp = new THREE.Sprite(mat);
      sp.scale.set(this.cfg.PLUS_SIZE, this.cfg.PLUS_SIZE, 1);
      sp.visible = false;
      sp.renderOrder = 999;
      this.scene.add(sp);
      sprites.push(sp);
    }
    this.lines.push({ line, geo, sprites, a: new THREE.Vector3(), b: new THREE.Vector3(), phase: Math.random() });
  }

  /** pairs = [{ a, b }] 世界坐标（立即拷贝，调用方可用复用向量） */
  set(pairs) {
    if (!this.cfg || this.cfg.ENABLED === false || !pairs) { this.hideAll(); return; }
    const n = Math.min(pairs.length, this.cfg.MAX_TARGETS);
    while (this.lines.length < n) this._grow();
    for (let i = 0; i < this.lines.length; i++) {
      const L = this.lines[i];
      if (i >= n) { L.line.visible = false; for (const sp of L.sprites) sp.visible = false; continue; }
      L.a.copy(pairs[i].a);
      L.b.copy(pairs[i].b);
      const attr = L.geo.attributes.position;
      attr.setXYZ(0, L.a.x, L.a.y, L.a.z);
      attr.setXYZ(1, L.b.x, L.b.y, L.b.z);
      attr.needsUpdate = true;
      L.geo.computeBoundingSphere();
      L.line.visible = true;
      for (const sp of L.sprites) sp.visible = true;
    }
  }

  hideAll() {
    for (const L of this.lines) {
      L.line.visible = false;
      for (const sp of L.sprites) sp.visible = false;
    }
  }

  update(dt) {
    this._t += dt;
    for (const L of this.lines) {
      if (!L.line.visible) continue;
      const step = this.cfg.PLUS_COUNT > 1 ? 1 / this.cfg.PLUS_COUNT : 1;
      for (let i = 0; i < L.sprites.length; i++) {
        const u = ((this._t * this.cfg.PLUS_SPEED + L.phase + i * step) % 1 + 1) % 1;
        const sp = L.sprites[i];
        sp.position.set(
          L.a.x + (L.b.x - L.a.x) * u,
          L.a.y + (L.b.y - L.a.y) * u,
          L.a.z + (L.b.z - L.a.z) * u);
        sp.material.opacity = Math.sin(u * Math.PI) * 0.95;   // 两端淡、中间亮
      }
    }
  }

  clear() { this.hideAll(); }

  dispose() {
    for (const L of this.lines) {
      this.scene.remove(L.line);
      L.geo.dispose();
      for (const sp of L.sprites) { this.scene.remove(sp); sp.material.dispose(); }
    }
    this.lines.length = 0;
    this._mat.dispose();
  }
}

// ---------------------------------------------------------------- 治疗脉冲环（第四十九修）
// 治疗术士的回血表现：脚下一个绿色圆环由 0 扩散到光环半径，环上随波漂几个「+」。
//
// 为什么换掉「连线 + 沿线加号」（第四十六修那套）：
//   现场反馈「回血效果表现弱」—— 连线只说明"在治疗"，讲不出"什么时候治、治了多大范围"；
//   脉冲环把节奏和范围一次说清，而且**每 2 秒才动一次**（连线那套是每帧算 O(n²) + 每帧改顶点）。
//
// 性能：
//   · 每个环 = 一个 RingGeometry(共享给本实例的所有槽) + 一份材质（要独立淡出，故不能共用）；
//     RING_POOL 默认 3 ⇒ 最多 3 个 draw call，而且只在脉冲后 RING_DUR(0.9s) 内可见。
//   · 「+」用 Sprite（复用治疗线那张 64×64 缓存贴图），PLUS_RIDE 默认 4 个。
//   · 池满时复用最老的槽（不 new、不增长）—— 与 fx.js 里其它效果同一套「预分配」纪律。
export class HealRingFx {
  constructor(scene, cfg = HEAL_LINK) {
    this.scene = scene;
    this.cfg = cfg;
    this.rings = [];
    this._t = 0;
    this._tex = plusTexture();
  }

  _grow() {
    const geo = new THREE.RingGeometry(0.9, 1, 48);   // 外径 1：靠 scale 放大到目标半径
    const mat = new THREE.MeshBasicMaterial({
      color: this.cfg.COLOR, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;   // 平铺在地面（本地 XY 平面 → 世界 XZ）
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 997;           // 场景之上、治疗线(998)/名牌(999)之下
    this.scene.add(mesh);
    const pluses = [];
    const n = Math.max(0, this.cfg.PLUS_RIDE | 0);
    for (let i = 0; i < n; i++) {
      const pm = new THREE.SpriteMaterial({
        map: this._tex, color: this.cfg.COLOR,      // 贴图是白的：这里染色（回血环 = 绿）
        transparent: true, depthTest: false, depthWrite: false, opacity: 0,
      });
      const sp = new THREE.Sprite(pm);
      sp.scale.set(this.cfg.PLUS_SIZE || 0.26, this.cfg.PLUS_SIZE || 0.26, 1);
      sp.visible = false;
      sp.renderOrder = 999;
      this.scene.add(sp);
      pluses.push(sp);
    }
    this.rings.push({ geo, mat, mesh, pluses, x: 0, z: 0, radius: 6, t: 0, dur: 1, active: false });
  }

  /** 播一次脉冲环：pos = 术士世界坐标，radius = 光环半径（米） */
  pulse(pos, radius) {
    if (!this.cfg || this.cfg.ENABLED === false || this.cfg.RING_ENABLED === false || !pos) return;
    const pool = Math.max(1, this.cfg.RING_POOL | 0);
    let slot = this.rings.find((r) => !r.active);
    if (!slot) {
      if (this.rings.length < pool) { this._grow(); slot = this.rings[this.rings.length - 1]; }
      else slot = this.rings[0];                        // 池满：复用最老的槽
    }
    slot.x = pos.x; slot.z = pos.z;
    slot.radius = Math.max(0.5, radius || 6);
    slot.dur = Math.max(0.1, this.cfg.RING_DUR || 0.9);
    slot.t = slot.dur;
    slot.active = true;
    slot.mesh.visible = true;
  }

  update(dt) {
    this._t += dt;
    const y = this.cfg.RING_Y != null ? this.cfg.RING_Y : 0.06;
    for (const r of this.rings) {
      if (!r.active) { r.mesh.visible = false; for (const sp of r.pluses) sp.visible = false; continue; }
      r.t -= dt;
      const k = THREE.MathUtils.clamp(1 - r.t / r.dur, 0, 1);
      const rad = r.radius * k;
      r.mesh.position.set(r.x, y, r.z);
      r.mesh.scale.set(rad, rad, 1);
      // 快速起亮 + 随扩散淡出（k*5 那一下是为了别在极小半径时看不见）
      r.mat.opacity = (this.cfg.RING_OPACITY || 0.75) * (1 - k) * Math.min(1, k * 5);
      const n = r.pluses.length;
      for (let i = 0; i < n; i++) {
        const sp = r.pluses[i];
        const ang = (i / n) * Math.PI * 2 + this._t * 0.6;   // 慢慢绕圈，免得像静止贴图
        sp.position.set(r.x + Math.cos(ang) * rad, y + 0.3 + 0.45 * k, r.z + Math.sin(ang) * rad);
        sp.material.opacity = Math.min(1, r.mat.opacity * 1.4);
        sp.visible = true;
      }
      if (r.t <= 0) { r.active = false; r.mesh.visible = false; for (const sp of r.pluses) sp.visible = false; }
    }
  }

  clear() {
    for (const r of this.rings) {
      r.active = false; r.mesh.visible = false;
      for (const sp of r.pluses) sp.visible = false;
    }
  }

  dispose() {
    for (const r of this.rings) {
      this.scene.remove(r.mesh); r.geo.dispose(); r.mat.dispose();
      for (const sp of r.pluses) { this.scene.remove(sp); sp.material.dispose(); }
    }
    this.rings.length = 0;
  }
}

// ---------------------------------------------------------------- 粉色飞行加号（第四十九修返工）
//
// 现场口径：治疗术士「发射粉色加号，到玩家最近且血最少（百分比）的怪物身上，每秒治疗一次」。
//   为什么不用圆环：现场反馈绿环「看不到」——环贴地、加色混合、又被怪和地面挡，在头显里几乎不可见；
//   一枚**朝目标飞的粉色加号**是"有方向的事件"，玩家顺着飞行方向就知道它在奶谁。
//   · 起点 = 术士位置，终点 = 目标**当帧**的位置（飞过去的过程里目标在动也不追 —— 追反而像制导导弹）；
//   · 走一条抛物线（PLUS_ARC），末段淡出 + 中途略微放大；
//   · 池化：PLUS_POOL 个槽，池满复用最老的（不 new、不增长，与 fx.js 其它效果同一套纪律）；
//   · depthTest:false + renderOrder 999 ⇒ 隔着怪/墙也看得见（治疗反馈必须醒目）。
export class HealPlusFx {
  constructor(scene, cfg = HEAL_LINK) {
    this.scene = scene;
    this.cfg = cfg;
    this.slots = [];
    this._tex = plusTexture();
  }

  _grow() {
    const mat = new THREE.SpriteMaterial({
      map: this._tex,
      color: this.cfg.PLUS_COLOR != null ? this.cfg.PLUS_COLOR : 0xff7fbf,
      transparent: true, depthTest: false, depthWrite: false,
    });
    const sp = new THREE.Sprite(mat);
    const size = this.cfg.PLUS_SIZE || 0.34;
    sp.scale.set(size, size, 1);
    sp.visible = false;
    sp.frustumCulled = false;
    sp.renderOrder = 999;
    this.scene.add(sp);
    this.slots.push({ sp, from: new THREE.Vector3(), to: new THREE.Vector3(), t: 0, dur: 0.45, active: false });
  }

  /**
   * 从 from 飞一枚加号到 to（世界坐标，立即拷贝；调用方可用复用向量）
   * @param {number|null} colorHex 覆盖颜色（第五十修：击败治疗术士的提示要绿色）；缺省用 HEAL_LINK.PLUS_COLOR
   */
  cast(from, to, colorHex = null) {
    if (!this.cfg || this.cfg.ENABLED === false || this.cfg.PLUS_ENABLED === false || !from || !to) return;
    const pool = Math.max(1, this.cfg.PLUS_POOL | 0);
    let slot = this.slots.find((s) => !s.active);
    if (!slot) {
      if (this.slots.length < pool) { this._grow(); slot = this.slots[this.slots.length - 1]; }
      else slot = this.slots[0];                       // 池满：复用最老的槽
    }
    const col = colorHex != null ? colorHex : (this.cfg.PLUS_COLOR != null ? this.cfg.PLUS_COLOR : 0xff7fbf);
    if (slot.sp.material.color) slot.sp.material.color.setHex(col);
    slot.from.copy(from);
    slot.to.copy(to);
    slot.dur = Math.max(0.1, this.cfg.PLUS_DUR || 0.45);
    slot.t = 0;
    slot.active = true;
    slot.sp.visible = true;
    slot.sp.position.copy(from);
    slot.sp.material.opacity = 1;
  }

  update(dt) {
    const base = this.cfg.PLUS_SIZE || 0.34;
    const arc = this.cfg.PLUS_ARC != null ? this.cfg.PLUS_ARC : 0;
    for (const s of this.slots) {
      if (!s.active) { s.sp.visible = false; continue; }
      s.t += dt;
      const k = Math.min(1, s.t / s.dur);
      s.sp.position.lerpVectors(s.from, s.to, k);
      s.sp.position.y += arc * Math.sin(Math.PI * k);          // 抛物线：中段最高
      s.sp.material.opacity = 1 - k * k * k;                   // 末段快速淡出
      const size = base * (1 + 0.25 * Math.sin(Math.PI * k));  // 中途略放大，像"喂"过去
      s.sp.scale.set(size, size, 1);
      if (k >= 1) { s.active = false; s.sp.visible = false; }
    }
  }

  clear() {
    for (const s of this.slots) { s.active = false; s.sp.visible = false; }
  }

  dispose() {
    for (const s of this.slots) { this.scene.remove(s.sp); s.sp.material.dispose(); }
    this.slots.length = 0;
  }
}

// ---------------------------------------------------------------- 击杀金点（第六十五修 · 飞向枪上的商店币小框）
//
// 现场口径：「怪打死后要有金色光点飞到这里接着数字变动」——「这里」= 枪上那个「商店币」小框。
//   · 起点 = 怪物被击杀的位置；终点 = **小框当帧的世界坐标**（枪拿在手上一直在动，所以必须追踪）；
//   · 落点用**时间归一**（t/dur 走 0→1，位置 = 起点 → 当帧目标 的平滑插值）：
//       好处 = 目标在动也**保证在 DUR 秒内精确落到目标上**，不需要「距离阈值」那种会漏判的收尾；
//   · 池化：ORB.POOL 个槽；池满 → 把金额**并进最老的槽**（不 new、不增长，与 fx.js 其它效果同一套纪律）；
//   · depthTest:false + renderOrder 998 ⇒ 不被怪/枪模型挡住（「我的钱飞过来了」必须看得见）。
//
// 为什么这里可以用 Sprite（本文件开头的纪律是「粒子别用 Sprite」）：
//   Sprite 无法实例化，但金点要 ① 永远面向玩家 ② 各自独立淡出 ③ 同屏只有个位数
//   —— 与 HEAL_LINK 的飞行加号同一类问题、同一套解法（池化 Sprite），不是「每帧几百粒」的粒子。

const _coinTexCache = { tex: null };
function coinTexture() {
  if (_coinTexCache.tex) return _coinTexCache.tex;
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.82)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);
  _coinTexCache.tex = new THREE.CanvasTexture(c);   // 画成白色：颜色由 SpriteMaterial.color 染（金）
  _coinTexCache.tex.colorSpace = THREE.SRGBColorSpace;
  return _coinTexCache.tex;
}

export class CoinOrbFx {
  constructor(scene, cfg = {}) {
    this.scene = scene;
    this.cfg = cfg;
    this.slots = [];
    this._born = 0;                     // 递增序号：池满时按它找「最老的那颗」
    this._tex = coinTexture();
    this._to = new THREE.Vector3();     // 复用向量：每帧问一次小框位置
  }

  /** 还在飞的金点数（商店币小框据此判断「显示值可不可以落后」） */
  get inflight() { let n = 0; for (const s of this.slots) if (s.active) n++; return n; }

  _grow() {
    const cfg = this.cfg || {};
    const mat = new THREE.SpriteMaterial({
      map: this._tex,
      color: cfg.COLOR != null ? cfg.COLOR : 0xffd43b,
      transparent: true, depthTest: false, depthWrite: false,
    });
    const sp = new THREE.Sprite(mat);
    const size = cfg.SIZE || 0.13;
    sp.scale.set(size, size, 1);
    sp.visible = false;
    sp.frustumCulled = false;
    sp.renderOrder = 998;
    this.scene.add(sp);
    this.slots.push({ sp, from: new THREE.Vector3(), t: 0, dur: 0.55, amount: 0, active: false, born: 0 });
  }

  /**
   * 从 from 飞一枚金点（世界坐标，立即拷贝；调用方可以放心传复用向量）。
   * @param {THREE.Vector3} from   起点 = 怪物被击杀的位置
   * @param {number} amount        这枚金点代表的金额（落地时交给调用方推数字）
   * @returns {boolean} true = 起了新光点；false = 没飞（关着 / 没起点 / 金额为 0 / 池满已并进老槽）
   */
  cast(from, amount) {
    const cfg = this.cfg || {};
    const v = Math.round(amount || 0);
    if (cfg.ENABLED === false || !from || v <= 0) return false;
    const pool = Math.max(1, cfg.POOL | 0);
    let slot = this.slots.find((s) => !s.active);
    if (!slot) {
      if (this.slots.length < pool) { this._grow(); slot = this.slots[this.slots.length - 1]; }
      else {                            // 池满：金额并进最老的槽（钱不丢，只是共用一颗光点飞过去）
        slot = this.slots.reduce((a, b) => (a.born <= b.born ? a : b));
        slot.amount += v;
        return false;
      }
    }
    slot.from.copy(from);
    slot.dur = Math.max(0.05, cfg.DUR || 0.55);
    slot.t = 0;
    slot.amount = v;
    slot.born = ++this._born;
    slot.active = true;
    slot.sp.visible = true;
    slot.sp.position.copy(from);
    slot.sp.material.opacity = 1;
    const size = cfg.SIZE || 0.13;
    slot.sp.scale.set(size, size, 1);
    return true;
  }

  /**
   * 每帧推进（一帧只问一次终点，全部金点共用 —— 它们飞向的是同一个框）。
   * @param {Function|null} targetOf 填出当帧终点；拿不到 → 该帧全部立刻落地（数字照变，不会卡账）
   * @returns {number} 本帧落地的金额合计
   */
  update(dt, targetOf) {
    const cfg = this.cfg || {};
    const arc = cfg.ARC != null ? cfg.ARC : 0;
    const base = cfg.SIZE || 0.13;
    // 没有在飞的金点时连终点都不问（省掉每帧一次 getWorldPosition 的矩阵上行）—— 绝大多数帧都是这种
    const to = (targetOf && this.inflight > 0) ? targetOf(this._to) : null;
    let landed = 0;
    for (const s of this.slots) {
      if (!s.active) { if (s.sp.visible) s.sp.visible = false; continue; }
      if (!to) { landed += s.amount; s.amount = 0; s.active = false; s.sp.visible = false; continue; }
      s.t += dt;
      const k = Math.min(1, s.t / s.dur);
      const e = k * k * (3 - 2 * k);                       // smoothstep：起飞与落地两端都软
      s.sp.position.lerpVectors(s.from, to, e);
      s.sp.position.y += arc * Math.sin(Math.PI * k);       // 抛物线：中段最高
      s.sp.material.opacity = 1 - k * k * k * k;            // 末段快速淡出（贴到牌子前先化掉）
      const size = base * (1 + 0.35 * Math.sin(Math.PI * k));   // 中途鼓一下，像被"叮"地吸进去
      s.sp.scale.set(size, size, 1);
      if (k >= 1) { landed += s.amount; s.amount = 0; s.active = false; s.sp.visible = false; }
    }
    return landed;
  }

  /** 清空（切关 / 回菜单 / 重开）：在飞的金点直接消失 —— 金额早已计入真实值，显示值由 advanceShown 兜底对齐 */
  clear() { for (const s of this.slots) { s.active = false; s.amount = 0; s.sp.visible = false; } }

  dispose() {
    for (const s of this.slots) { this.scene.remove(s.sp); s.sp.material.dispose(); }
    this.slots.length = 0;
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
    this.healLink = new HealLinkFx(scene, HEAL_LINK);   // 第四十六修：治疗线 + 绿色加号（第四十九修起默认关，看 HEAL_LINK.LINES）
    this.healRing = new HealRingFx(scene, HEAL_LINK);   // 第四十九修：回血脉冲环（现场说看不到 → RING_ENABLED 默认 false）
    this.healPlusFx = new HealPlusFx(scene, HEAL_LINK); // 第四十九修返工：粉色飞行加号（当前表现）
    this.coinOrbFx = new CoinOrbFx(scene, SHOP_COIN.ORB); // 第六十五修：击杀金点 → 枪上的商店币小框
  }

  /** 命中火花：colorHex 省略用配置里的默认暖金 */
  spark(pos, colorHex) { this.sparks.burst(pos, colorHex == null ? FX.SPARK.COLOR : colorHex, 1); }

  /** 击杀碎片：colorHex 建议取该敌种 tint；mul 给精英/Boss 放大数量 */
  debrisBurst(pos, colorHex, mul = 1) {
    this.debris.burst(pos, colorHex == null ? FX.DEBRIS.COLOR : colorHex, mul);
  }

  muzzle(pos, dir) { this.muzzleFx.flash(pos, dir); }

  /** 治疗线（第四十六修）：pairs = [{a,b}] 世界坐标；每帧调一次（空数组 = 全隐藏） */
  healLinks(pairs) { this.healLink.set(pairs); }

  /** 回血脉冲环（第四十九修首版）：术士每 PULSE_PERIOD 秒调一次（RING_ENABLED=false 时内部直接 return） */
  healPulse(pos, radius) { this.healRing.pulse(pos, radius); }

  /** 粉色飞行加号（第四十九修返工）：from = 术士位置，to = 被治疗的怪 */
  healPlus(from, to, colorHex) { this.healPlusFx.cast(from, to, colorHex); }

  /** 击杀金点（第六十五修）：from = 怪物被击杀的位置，amount = 这枚金点代表的金额 */
  coinOrb(from, amount) { this.coinOrbFx.cast(from, amount); }

  /** 还在飞的金点数（商店币小框据此决定显示值要不要落后于真实值） */
  coinFlightCount() { return this.coinOrbFx.inflight; }

  /**
   * 每帧驱动全部效果。
   * @param {Function|null} coinTarget 金点终点提供者：填一个 Vector3 = 枪上商店币小框的当帧世界坐标
   *   （不传 / 拿不到 → 在飞的金点立刻落地，数字照变，不会卡账）
   * @returns {number} 本帧落地的金点金额合计（调用方据此把商店币数字推上去）
   */
  update(dt, coinTarget = null) {
    this.sparks.update(dt);
    this.debris.update(dt);
    this.muzzleFx.update(dt);
    this.healLink.update(dt);
    this.healRing.update(dt);
    this.healPlusFx.update(dt);
    return this.coinOrbFx.update(dt, coinTarget);
  }

  clear() {
    this.tracer.clear();
    this.sparks.clear();
    this.debris.clear();
    this.muzzleFx.clear();
    this.healLink.clear();
    this.healRing.clear();
    this.healPlusFx.clear();
    this.coinOrbFx.clear();
  }

  dispose() {
    this.tracer.dispose();
    this.sparks.dispose();
    this.debris.dispose();
    this.muzzleFx.dispose();
    this.healLink.dispose();
    this.healRing.dispose();
    this.healPlusFx.dispose();
    this.coinOrbFx.dispose();
  }
}