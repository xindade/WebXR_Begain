import * as THREE from 'three';
import { RAPID_FIRE } from '../core/constants.js';

// ============================================================
// 连杀计数 · 枪身红点环（第四十三修，替换第四十二修的「枪管大牌子」）
//   ⚠ 第四十四修：**红点环已搬到右手技能框边缘**（SKILL_HINT.STREAK / src/vr/skillHint.js）——
//     本文件现在默认只负责「加速期间向后飘的雾气」（RAPID_FIRE.MIST）；
//     红点相关代码全部保留，把 RAPID_FIRE.COUNTER.BARREL_DOTS 改回 true 即可恢复枪身环。
//   · 每用**子弹**击杀一个敌人 → 枪身中间环绕的一圈里点亮一个红点；
//   · 红点集齐（默认 10 个）→ 整圈「闪一下」放大淡出，同时枪身周围开始向后飘雾；
//   · 雾气持续 = 射速加速的 3 秒（表现「枪已经加速」）；
//   · 加速期间新攒的点改用金色（与「未集齐的红」区分，且上限只有 BOOST_CARRY_MAX 个）。
//
// 为什么从「贴图牌子」换成「实例化小球」：
//   ✗ 贴图牌子：一块 256×128 的画布贴在枪上，尺寸大、挡视线，且每换一个数字就要重绘 canvas + 上传纹理；
//   ✓ 红点环：10 个低面数小球**一个 InstancedMesh**（1 次 draw call），单个点只改实例矩阵；
//     不显示时整体 visible=false（0 draw call），常态下零纹理上传。
//   雾气同理：8 片软光斑共用一个 InstancedMesh（1 次 draw call），只在加速 3 秒内可见。
//
// 位置自动标定（place()）：量出模型在 root 空间的包围盒 → 取**最长轴**当枪管轴
//   （枪一定是长条）→ 取朝 -Z（手柄前方）的那一端 → 环心落在「枪托 → 枪口」的 ALONG 处
//   （0.5 = 枪身正中）→ 环半径 = 枪身横截面最大半宽 × RING_FRAC（>1 才在枪身外面）。
//   完全不必知道 Ak枪.glb 的内部朝向/尺寸；现场觉得位置不对只调
//   RAPID_FIRE.COUNTER.ALONG / RING_FRAC / RING_RADIUS / DOT_FRAC / DOT_SIZE 即可，不用改代码。
// ============================================================

const _m = new THREE.Matrix4();
const _rel = new THREE.Matrix4();
const _toModel = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();
const _fwd = new THREE.Vector3(0, 0, -1);
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _dir2 = new THREE.Vector3(0, 0, 1);   // 面片朝向基准（雾气用）
const _u = new THREE.Vector3();
const _w = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _col = new THREE.Color();

// 兜底挂点（模型没加载出来时用）：按「枪管 = root 的 -Z」放在握把前方一点
const FALLBACK = {
  position: new THREE.Vector3(0, 0.05, -0.16),
  axis: new THREE.Vector3(0, 0, -1),
  length: 0.5,
  radius: 0.06,
};

/**
 * 模型在**父节点（root）空间**的包围盒。
 *   ⚠ 不能用 Box3.setFromObject —— 那给的是世界坐标（枪挂在手柄上，随玩家动），
 *     而我们要的是「相对枪自己」的位置。这里逐 mesh 用相对矩阵换算，与祖先变换无关。
 * @returns {THREE.Box3} 空盒表示没算出（模型未加载 / 无网格）
 */
export function modelBoxInParentSpace(model) {
  const box = new THREE.Box3();
  if (!model) return box;
  model.updateMatrixWorld(true);
  model.updateMatrix();
  _m.copy(model.matrix);                                  // 模型 → root
  model.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const gb = o.geometry.boundingBox;
    if (!gb) return;
    _toModel.copy(model.matrixWorld).invert().multiply(o.matrixWorld);   // mesh → 模型
    _rel.multiplyMatrices(_m, _toModel);                                // mesh → root
    box.union(gb.clone().applyMatrix4(_rel));
  });
  return box;
}

/**
 * 由包围盒推「枪身挂点」。纯函数，便于单测。
 *   最长轴 = 枪管轴；朝 -Z 的那一端 = 枪口。
 * @returns {{position, axis, length, radius, ringRadius, dotSize}|null}
 *   position   环心（root 空间；ALONG = 0.5 即枪身正中，1 = 枪口端）
 *   axis       单位枪管轴（指向枪口）
 *   length     枪管轴长度（包围盒最长边）
 *   radius     枪身横截面最大半宽（垂直于枪管轴的两条半宽取大）
 *   ringRadius 红点环半径（RING_RADIUS > 0 用它，否则 radius × RING_FRAC）
 *   dotSize    单个红点直径（DOT_SIZE > 0 用它，否则 ringRadius × DOT_FRAC）
 */
export function barrelMount(box, counterCfg = {}) {
  if (!box || box.isEmpty()) return null;
  box.getSize(_size);
  box.getCenter(_center);
  const ax = [Math.abs(_size.x), Math.abs(_size.y), Math.abs(_size.z)];
  const axisIdx = (ax[0] >= ax[1] && ax[0] >= ax[2]) ? 0 : (ax[1] >= ax[2] ? 1 : 2);
  _dir.set(0, 0, 0);
  if (axisIdx === 0) _dir.x = 1; else if (axisIdx === 1) _dir.y = 1; else _dir.z = 1;
  if (_dir.dot(_fwd) < 0) _dir.negate();               // 取朝前（手柄 -Z）的那一端当枪口
  const len = ax[axisIdx];
  const perp = [ax[(axisIdx + 1) % 3], ax[(axisIdx + 2) % 3]];
  const radius = Math.max(perp[0], perp[1]) * 0.5;

  const along = Number.isFinite(counterCfg.ALONG) ? counterCfg.ALONG : 0.5;
  // ALONG：0 = 枪托端、0.5 = 正中、1 = 枪口端
  const position = _center.clone().addScaledVector(_dir, len * (along - 0.5));

  const ringFrac = counterCfg.RING_FRAC > 0 ? counterCfg.RING_FRAC : 1.45;
  const ringUse = counterCfg.RING_RADIUS > 0 ? counterCfg.RING_RADIUS : radius * ringFrac;
  const ringRadius = Math.max(0.02, ringUse);
  const dotFrac = counterCfg.DOT_FRAC > 0 ? counterCfg.DOT_FRAC : 0.28;
  const dotSize = counterCfg.DOT_SIZE > 0 ? counterCfg.DOT_SIZE : ringRadius * dotFrac;

  return { position, axis: _dir.clone(), length: len, radius, ringRadius, dotSize };
}

// 软光斑贴图（雾气用）：64×64 径向渐变，只生成一次
let _puffTex = null;
function puffTexture() {
  if (_puffTex) return _puffTex;
  const size = 64;
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  _puffTex = new THREE.CanvasTexture(cv);
  _puffTex.colorSpace = THREE.SRGBColorSpace;
  return _puffTex;
}

export class StreakCounter {
  constructor(cfg = RAPID_FIRE) {
    this.cfg = cfg;
    this._placed = false;
    this._mount = null;
    this._flashT = Infinity;      // 集齐后「闪一下」的计时（Infinity = 没在闪）
    this._lastUntil = 0;          // 上一次看到的加速结束时刻（变了 = 新一次加速 → 触发闪光）
    this._mistAcc = 0;            // 出雾节流
    this._mistSeq = 0;            // 出雾序号（用黄金角散开角度，确定性、可测）
    this._fill = 0;
    this._boost = false;

    const C = this._cfgCounter();
    const n = this._dotCount();

    // —— 红点环：n 个小球，一个 InstancedMesh ——
    this.dots = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 8, 6),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false }),
      Math.max(1, n),
    );
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 996;
    this.dots.visible = false;
    this.dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dots.count = Math.max(1, n);
    for (let i = 0; i < this.dots.count; i++) this.dots.setColorAt(i, _col.setHex(C.COLOR));

    // —— 雾气：MIST.COUNT 片软光斑，一个 InstancedMesh ——
    const M = this._cfgMist();
    this.mist = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: puffTexture(), transparent: true, depthWrite: false, toneMapped: false,
        blending: THREE.AdditiveBlending, opacity: M.OPACITY,
      }),
      Math.max(1, M.COUNT | 0),
    );
    this.mist.frustumCulled = false;
    this.mist.renderOrder = 995;
    this.mist.visible = false;
    this.mist.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (this.mist.instanceColor) this.mist.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this._puffs = [];
    for (let i = 0; i < this.mist.count; i++) this._puffs.push({ t: Infinity, a: 0, r: 1 });
    for (let i = 0; i < this.mist.count; i++) this.mist.setColorAt(i, _col.setHex(0x000000));   // 预热 instanceColor（加色混合下黑色 = 不可见）
    this._hideAll();
  }

  _cfgCounter() { return this.cfg.COUNTER || {}; }
  _cfgMist() { return this.cfg.MIST || {}; }
  _dotCount() { const C = this._cfgCounter(); const n = C.DOTS | 0; return n > 0 ? n : Math.max(1, this.cfg.KILLS | 0); }

  // 幂等挂到枪的持有层（RightGun.root）
  attach(parent) {
    if (!parent) return;
    if (this.dots.parent !== parent) parent.add(this.dots);
    if (this.mist.parent !== parent) parent.add(this.mist);
  }

  /** 自动标定一次（模型加载完成后调用；量不出来则退回固定枪管位） */
  place(model) {
    const C = this._cfgCounter();
    const m = barrelMount(modelBoxInParentSpace(model), C) || FALLBACK;
    this._mount = {
      position: m.position.clone(),
      axis: m.axis.clone().normalize(),
      ringRadius: m.ringRadius != null ? m.ringRadius : Math.max(0.02, (m.radius || 0.06) * 1.45),
      dotSize: m.dotSize != null ? m.dotSize : 0.02,
    };
    if (m === FALLBACK) {
      // 兜底：按「枪管 = root 的 -Z」放一个保守位置（GUN.ROTATION 就是按这个约定调的）
      this._mount.position.copy(FALLBACK.position);
      this._mount.axis.copy(FALLBACK.axis);
      this._mount.ringRadius = 0.09;
      this._mount.dotSize = 0.025;
    }
    // 环平面基向量：u 尽量朝上，v = axis × u
    _u.copy(_up).addScaledVector(this._mount.axis, -_up.dot(this._mount.axis));
    if (_u.lengthSq() < 1e-6) {
      _u.set(1, 0, 0).addScaledVector(this._mount.axis, -this._mount.axis.x);
    }
    _u.normalize();
    _w.crossVectors(this._mount.axis, _u).normalize();
    this._placed = true;
    return this._mount;
  }

  // 环上第 i 个点的位置（root 空间）：从 u 方向起按等分角散开
  _ringPoint(i, n, out) {
    const a = (i / n) * Math.PI * 2;
    return out.copy(this._mount.position)
      .addScaledVector(_u, Math.cos(a) * this._mount.ringRadius)
      .addScaledVector(_w, Math.sin(a) * this._mount.ringRadius);
  }

  _hideAll() {
    _q.identity(); _scl.set(0, 0, 0);
    _m.compose(this._mount ? this._mount.position : _v.set(0, 0, 0), _q, _scl);
    for (let i = 0; i < this.dots.count; i++) this.dots.setMatrixAt(i, _m);
    this.dots.instanceMatrix.needsUpdate = true;
    this.dots.visible = false;
    this.mist.visible = false;
  }

  update(dt, game) {
    const R = this.cfg;
    const C = this._cfgCounter();
    const on = R.ENABLED !== false && C.ENABLED !== false && !!game && this._placed;
    if (!on) { this._hideAll(); return; }

    const need = this.dots.count;
    const streak = Math.max(0, game._bulletStreak | 0);
    const until = game._rapidUntil || 0;
    const now = game._gameTime || 0;
    const boostLeft = Math.max(0, until - now);
    const boost = boostLeft > 0;

    // 新一次加速开始 = 红点集齐的瞬间 → 闪一下（此后计数已清零，靠这次闪光交代「满了」）
    if (until !== this._lastUntil) {
      this._lastUntil = until;
      if (boost) this._flashT = 0;
    }

    // 第四十四修：连杀计数搬到「右手技能框边缘」（SKILL_HINT.STREAK / src/vr/skillHint.js）→
    //   枪身默认**不再画红点**（只保留加速雾气，雾气才是「枪已加速」的表现）。
    //   想看回枪身环：RAPID_FIRE.COUNTER.BARREL_DOTS = true（与面板同时显示也不冲突）。
    if (C.BARREL_DOTS === false) {
      this._fill = Math.min(streak, need);
      this._boost = boost;
      this.dots.visible = false;
      this._updateMist(dt, boost);
      return;
    }

    const flashing = this._flashT < (C.FLASH_TIME > 0 ? C.FLASH_TIME : 0.28);

    // 环上点亮数 = 当前连杀数（加速期间封顶，见 constants.BOOST_CARRY_MAX）
    const fill = Math.min(streak, need);
    const showDots = flashing || fill > 0;
    this._fill = fill;
    this._boost = boost;
    this.dots.visible = showDots;
    if (showDots) {
      const color = boost ? (C.COLOR_BOOST != null ? C.COLOR_BOOST : C.COLOR) : C.COLOR;
      _col.setHex(color);
      const shown = flashing ? need : fill;      // 闪光时整圈一起亮
      let k = 0;
      if (flashing) {
        this._flashT += dt;
        k = Math.min(1, this._flashT / Math.max(1e-4, C.FLASH_TIME > 0 ? C.FLASH_TIME : 0.28));
      }
      const grow = 1 + (Math.max(1, C.FLASH_SCALE || 1) - 1) * k;
      const radius = this._mount.dotSize * 0.5 * grow;
      for (let i = 0; i < this.dots.count; i++) {
        if (i < shown) {
          this._ringPoint(i, need, _pos);
          _q.identity(); _scl.set(radius, radius, radius);
          _m.compose(_pos, _q, _scl);
          this.dots.setMatrixAt(i, _m);
          this.dots.setColorAt(i, _col);
        } else {
          _scl.set(0, 0, 0);
          _m.compose(this._mount.position, _q.identity(), _scl);
          this.dots.setMatrixAt(i, _m);
        }
      }
      this.dots.material.opacity = flashing ? Math.max(0, 1 - k) : 1;
      this.dots.instanceMatrix.needsUpdate = true;
      if (this.dots.instanceColor) this.dots.instanceColor.needsUpdate = true;
      if (flashing && this._flashT >= (C.FLASH_TIME > 0 ? C.FLASH_TIME : 0.28)) {
        this._flashT = Infinity;
        this.dots.visible = false;
      }
    } else if (this._flashT !== Infinity) {
      this._flashT = Infinity;
    }

    this._updateMist(dt, boost);
  }

  // 加速期间：从枪身环上不断「冒出」软光斑，沿**枪口反方向**向后飘并消散
  _updateMist(dt, boost) {
    const M = this._cfgMist();
    const show = boost && M.ENABLED !== false && this._placed;
    this.mist.visible = !!show;
    if (!show) {
      for (const p of this._puffs) p.t = Infinity;
      this._mistAcc = 0;
      return;
    }
    const life = M.LIFE > 0 ? M.LIFE : 0.85;
    const interval = M.INTERVAL > 0 ? M.INTERVAL : 0.1;
    const size = M.SIZE > 0 ? M.SIZE : this._mount.ringRadius * 2;
    const speed = M.SPEED != null ? M.SPEED : 1.5;
    const spread = M.SPREAD != null ? M.SPREAD : 0.35;
    const n = this._puffs.length;

    this._mistAcc += dt;
    while (this._mistAcc >= interval) {
      this._mistAcc -= interval;
      const p = this._puffs[this._mistSeq % n];
      this._mistSeq++;
      p.t = 0;
      p.a = this._mistSeq * 2.39996323;      // 黄金角：确定性「随机」散布
      p.r = 0.75 + 0.35 * ((this._mistSeq % 3) / 2);
    }

    _col.setHex(M.COLOR != null ? M.COLOR : 0xbfe9ff);
    for (let i = 0; i < n; i++) {
      const p = this._puffs[i];
      if (!(p.t < life)) {
        _scl.set(0, 0, 0);
        _m.compose(this._mount.position, _q.identity(), _scl);
        this.mist.setMatrixAt(i, _m);
        if (this.mist.instanceColor) this.mist.setColorAt(i, _col.setHex(0x000000));
        continue;
      }
      p.t += dt;
      const k = Math.min(1, p.t / life);
      const fade = Math.sin(Math.PI * k);                  // 0→1→0：出现即渐亮、末尾渐隐
      _pos.copy(this._mount.position);                     // 起点 = 枪身中段（环心）
      _pos.addScaledVector(_u, Math.cos(p.a) * this._mount.ringRadius * p.r)
          .addScaledVector(_w, Math.sin(p.a) * this._mount.ringRadius * p.r)
          .addScaledVector(this._mount.axis, -speed * p.t);  // 向后（枪口反方向）飘
      _pos.addScaledVector(_w, spread * p.t);
      const s = size * (0.6 + 0.7 * k);
      // 面片始终朝相机侧（用枪自身轴当法线即可，观感足够且零每帧朝向计算）
      _q.setFromUnitVectors(_dir2, this._mount.axis);
      _scl.set(s, s, s);
      _m.compose(_pos, _q, _scl);
      this.mist.setMatrixAt(i, _m);
      if (this.mist.instanceColor) {
        this.mist.setColorAt(i, _col.setHex(M.COLOR != null ? M.COLOR : 0xbfe9ff).multiplyScalar(fade));
      }
    }
    this.mist.instanceMatrix.needsUpdate = true;
    if (this.mist.instanceColor) this.mist.instanceColor.needsUpdate = true;
  }

  dispose() {
    if (this.dots) {
      if (this.dots.parent) this.dots.parent.remove(this.dots);
      this.dots.geometry.dispose(); this.dots.material.dispose();
    }
    if (this.mist) {
      if (this.mist.parent) this.mist.parent.remove(this.mist);
      this.mist.geometry.dispose(); this.mist.material.dispose();
    }
    this.dots = null; this.mist = null; this._puffs = null;
  }
}

