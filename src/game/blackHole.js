// 第六十七修 · 黑洞（第 3 关第三张技能卡）
//
// 现场口径（6 条已确认）：
//   ① 伤害 20/秒（靠近洞心才受伤）；② Boss 免疫；③ 方向取「释放瞬间的头部朝向」；
//   ④ 被吸期间暂停攻击；⑤ 6 秒结束后原地放回；⑥ 默认技能「能量散射」保留。
//
// 本文件只放两件事：
//   · 纯规则函数（免疫名单 / 吸附时长 / 精英振荡 / 飞毯弧线判定）—— 便于单测；
//   · BlackHoleFx 视觉（程序化 Canvas 漩涡，不引入任何新素材）。
// 逐怪位置接管 / 伤害结算在 game.js 的 _updateBlackHole 里（要复用 _onKilled / 伤害数字）。
import * as THREE from 'three';
import { BLACK_HOLE, MOVE } from '../core/constants.js';

/** 黑洞免疫名单：Boss / 龙部件 / 无敌怪 / 被 Boss 控制器接管的实体（治疗术士除外，它可以被吸）。 */
export function isBlackHoleImmune(b) {
  if (!b || b.alive === false) return true;
  if (b.isBoss || b.isDragonPart) return true;
  if (b.type && b.type.invincible) return true;
  if (b.behavior === 'treasure') return true;
  if (b.controlled && b.behavior !== 'heal') return true;
  return false;
}

/** 吸附到位时长：小怪 1s / 精英 2s（精英含末尾精英 isClimax）。 */
export function blackHolePullDuration(b) {
  return (b && (b.isElite || b.isClimax)) ? BLACK_HOLE.PULL_ELITE : BLACK_HOLE.PULL_BASIC;
}

/**
 * 精英吸附到位后的径向振荡半径（米）。
 *   holdT = 到位后经过的时间；t=0 时 = RIM，t=PERIOD/2 时 = RIM+AMP，循环往复。
 *   即现场要的「向前移动一点又被拉回去一点」。
 */
export function blackHoleEliteRadius(holdT) {
  const period = Math.max(0.05, BLACK_HOLE.OSC_PERIOD);
  const k = 0.5 * (1 - Math.cos((Math.PI * 2 * Math.max(0, holdT)) / period));
  return BLACK_HOLE.ABSORB_RIM + BLACK_HOLE.OSC_AMP * k;
}

/**
 * 第六十八修 · 吸附落点的方位角：按黄金角依次错开，围成一个小圈。
 *   base 取「第一只被吸的怪」的来向角，之后的怪依次 +137.5°。
 *   旧实现每只怪都停在自己原来的来向上：怪从正面来时方位角几乎一样，远看就挤成一条线。
 */
export function blackHoleSlotAngle(index, base = 0) {
  return base + Math.max(0, index | 0) * BLACK_HOLE.SLOT_GOLDEN;
}

/**
 * 第七十四修 · 小怪在竖直黑洞正面铺成「圆饼」，不再只停在外圈。
 *
 * 用向日葵排布（黄金角 + 半径按 sqrt 递增）填满整个圆面：
 *   · index=0 落洞心，越晚吸进来的怪越靠外；
 *   · 半径按 sqrt(i/(n-1)) 分布，让每个环带面积近似相等，视觉上不会全挤在中心；
 *   · 总捕获数变化时（新怪加入 / 旧怪死亡）会重新紧凑编号，圆饼始终填满。
 *
 * @returns {{x:number,y:number,r:number,angle:number}} 相对吸附中心的平面偏移（x=右轴，y=世界上方向）
 */
export function blackHoleDiscSlot(index, count, radius = BLACK_HOLE.ABSORB_RIM * (BLACK_HOLE.DISC_FILL ?? 1)) {
  const n = Math.max(1, count | 0);
  const i = Math.min(n - 1, Math.max(0, index | 0));
  const rMax = Math.max(0, Number(radius) || 0);
  const r = n <= 1 ? 0 : Math.sqrt(i / (n - 1)) * rMax;
  const angle = blackHoleSlotAngle(i, 0);
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r, r, angle };
}

/**
 * 第六十八修 · 黑洞尺寸曲线：开局 1 秒内从小猛然长大，之后保持轻微呼吸。
 *   t = 从释放起经过的秒数；t=0 → START_SCALE，t≥GROW_TIME → ≈1。
 */
export function blackHoleScaleAt(t) {
  const g = Math.max(0.01, BLACK_HOLE.GROW_TIME);
  const u = Math.min(1, Math.max(0, t) / g);
  const ease = 1 - Math.pow(1 - u, 4);   // easeOutQuart：前段快、末段稳
  const grow = BLACK_HOLE.START_SCALE + (1 - BLACK_HOLE.START_SCALE) * ease;
  const breath = u >= 1 ? 0.025 * Math.sin(t * 4.2) : 0;
  return Math.max(0.001, grow + breath);
}

/**
 * 第六十八修 · 结束闪烁：只在最后 BLINK_TIME 秒内生效，返回 0~1 的闪光强度。
 *   BLINK_COUNT=2 时，|sin(2πp)| 在这一秒内有两个峰值 —— 正好闪两下。
 */
export function blackHoleBlinkAt(t) {
  const left = BLACK_HOLE.DURATION - t;
  if (left > BLACK_HOLE.BLINK_TIME || left < 0) return 0;
  const p = 1 - Math.max(0, left) / Math.max(0.01, BLACK_HOLE.BLINK_TIME);
  return Math.abs(Math.sin(Math.PI * BLACK_HOLE.BLINK_COUNT * p));
}

/**
 * 线段 from→to 是否穿过飞毯带（|x| ≤ BOUND_X+r 且 |z| ≤ BOUND_Z+r）。
 * 用 Liang-Barsky 裁剪，纯 2D（XZ）判定 —— 穿过的怪走「过顶弧线」，避免视觉上从飞毯里穿过去。
 */
export function segmentCrossesCarpet(from, to, radius = 0, boundX = MOVE.BOUND_X, boundZ = MOVE.BOUND_Z) {
  if (!from || !to) return false;
  const minX = -boundX - radius, maxX = boundX + radius;
  const minZ = -boundZ - radius, maxZ = boundZ + radius;
  const dx = to.x - from.x, dz = to.z - from.z;
  let t0 = 0, t1 = 1;
  const clip = (p, q) => {
    if (Math.abs(p) < 1e-9) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, from.x - minX) && clip(dx, maxX - from.x)
      && clip(-dz, from.z - minZ) && clip(dz, maxZ - from.z);
}

/** 程序化漩涡贴图（Node 测试环境没有 document → 返回 null，视觉层退化为纯色圆盘）。 */
let _vortexTexCache = null;   // 第六十八修：全生命周期只生成/上传一次（反复放技能不再重画 512 画布）
export function makeVortexTexture(size = 512) {
  if (_vortexTexCache) return _vortexTexCache;
  if (typeof document === 'undefined' || !document.createElement) return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return null;
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);

  // 底色：中心纯黑 → 外圈紫光 → 边缘透明
  const bg = ctx.createRadialGradient(c, c, size * 0.02, c, c, size * 0.5);
  bg.addColorStop(0.00, 'rgba(0,0,0,0.98)');
  bg.addColorStop(0.30, 'rgba(8,0,18,0.94)');
  bg.addColorStop(0.56, 'rgba(58,14,120,0.62)');
  bg.addColorStop(0.78, 'rgba(140,60,255,0.30)');
  bg.addColorStop(1.00, 'rgba(0,0,0,0)');
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.arc(c, c, size * 0.5, 0, Math.PI * 2); ctx.fill();

  // 五条螺旋臂：由中心向外逐渐变细、变暗
  ctx.globalCompositeOperation = 'lighter';
  const arms = 5, steps = 90;
  for (let a = 0; a < arms; a++) {
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const ang = a * ((Math.PI * 2) / arms) + t * Math.PI * 3.1;
      const r = size * (0.055 + 0.43 * t);
      const x = c + Math.cos(ang) * r;
      const y = c + Math.sin(ang) * r;
      const alpha = 0.55 * (1 - t) + 0.05;
      const rad = size * (0.011 * (1 - t) + 0.0022);
      const red = (170 - 70 * t) | 0;
      const green = (86 - 40 * t) | 0;
      ctx.fillStyle = `rgba(${red},${green},255,${alpha.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(x, y, Math.max(0.8, rad), 0, Math.PI * 2); ctx.fill();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  _vortexTexCache = tex;
  return tex;
}

/**
 * 黑洞视觉：竖立在洞心、正对释放瞬间的玩家。
 *   · 纯黑核心（普通混合，保证「黑」得下去）+ 加色螺旋贴图 + 紫色吸积盘圆环；
 *   · 3 个 mesh / 3 次 draw call，无粒子、无每帧新建对象。
 */
export class BlackHoleFx {
  constructor(scene, center, viewer) {
    this.scene = scene;
    this.t = 0;
    this._disposed = false;
    this.group = new THREE.Group();
    this.group.position.copy(center);
    // 竖立圆盘正对玩家；用 center.y 作为 lookAt 高度，保证圆盘严格垂直地面（不会仰/俯）
    this.group.lookAt(viewer.x, center.y, viewer.z);

    const coreMat = new THREE.MeshBasicMaterial({
      color: BLACK_HOLE.COLOR, transparent: true, opacity: 0.94,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.core = new THREE.Mesh(new THREE.CircleGeometry(BLACK_HOLE.RIM * 0.62, 48), coreMat);
    this.core.renderOrder = 5;
    this._baseOpacity = { core: coreMat.opacity, swirl: 0.95, ring: 0.55 };
    this.group.add(this.core);

    const tex = makeVortexTexture();
    if (tex) {
      const swirlMat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.95,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      this.swirl = new THREE.Mesh(
        new THREE.PlaneGeometry(BLACK_HOLE.RIM * 2.35, BLACK_HOLE.RIM * 2.35),
        swirlMat,
      );
      this.swirl.position.z = 0.01;
      this.swirl.renderOrder = 6;
      this.group.add(this.swirl);

      const ringMat = new THREE.MeshBasicMaterial({
        color: BLACK_HOLE.RIM_COLOR, transparent: true, opacity: 0.55,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      this.ring = new THREE.Mesh(
        new THREE.RingGeometry(BLACK_HOLE.RIM * 0.94, BLACK_HOLE.RIM * 1.08, 64),
        ringMat,
      );
      this.ring.renderOrder = 7;
      this.group.add(this.ring);
    }

    scene.add(this.group);
  }

  update(dt) {
    if (this._disposed) return;
    this.t += dt;
    if (this.swirl) this.swirl.rotation.z += dt * 2.4;

    // 第六十八修：开局从小猛然长大 + 最后 1 秒快速闪两下。
    //   闪烁同时压暗材质并轻微放大 —— 纯压暗在加色混合下不够显眼。
    const flash = blackHoleBlinkAt(this.t);
    const dim = 1 - 0.9 * flash;
    const scale = blackHoleScaleAt(this.t) * (1 + 0.16 * flash);
    this.group.scale.setScalar(scale);
    this.core.material.opacity = this._baseOpacity.core * dim;
    if (this.swirl) this.swirl.material.opacity = this._baseOpacity.swirl * dim;
    if (this.ring) {
      const p = 0.5 + 0.5 * Math.sin(this.t * 5.5);
      this.ring.material.opacity = (0.32 + 0.3 * p) * dim;
      this.ring.scale.setScalar(1 + 0.035 * Math.sin(this.t * 7.0) + 0.22 * flash);
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map && o.material.map !== _vortexTexCache) o.material.map.dispose();
        o.material.dispose();
      }
    });
  }
}
