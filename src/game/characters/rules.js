import { CHARACTERS } from '../../core/constants.js';

const _int = (v, fallback = 0) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback);
const _round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * 蜂群：把「主枪之外的弹道」换算成浮游炮。
 * start 是角色自带的初始炮数；extra 是卡牌/临时道具提供的额外弹道。
 * 超过 MAX 后不再增加炮数，而是把所有炮的伤害系数每超 1 条 +OVERFLOW_STEP。
 */
export function swarmState(shotCount = 1, bonusShotCount = 0, cfg = CHARACTERS.swarm.satellite) {
  const extra = Math.max(0, _int(shotCount, 1) - 1) + _int(bonusShotCount, 0);
  const total = _int(cfg.START, 0) + extra;
  const count = Math.min(_int(cfg.MAX, 0), total);
  const overflow = Math.max(0, total - _int(cfg.MAX, 0));
  const dmgMul = _round3(Math.min(
    Number(cfg.DMG_CAP) || 0,
    (Number(cfg.DMG_MUL) || 0) + overflow * (Number(cfg.OVERFLOW_STEP) || 0),
  ));
  return { extra, total, count, overflow, dmgMul };
}

/** 爆炮手：主炮固定 1 枚，额外弹道换算成微型火箭。 */
export function bombardState(shotCount = 1, bonusShotCount = 0, cfg = CHARACTERS.bombard.bombard) {
  const extra = Math.max(0, _int(shotCount, 1) - 1) + _int(bonusShotCount, 0);
  const count = Math.min(_int(cfg.EXTRA_MAX, 0), extra);
  const overflow = Math.max(0, extra - _int(cfg.EXTRA_MAX, 0));
  const dmgMul = _round3(Math.min(
    Number(cfg.DMG_CAP) || 0,
    (Number(cfg.EXTRA_DMG_MUL) || 0) + overflow * (Number(cfg.OVERFLOW_STEP) || 0),
  ));
  return { extra, count, overflow, dmgMul };
}

/** 爆裂伤害：中心全额，向边缘线性衰减，最低保留 1-edgeFalloff。 */
export function blastDamage(base, radius, distance, edgeFalloff = 0) {
  const b = Number(base);
  const r = Number(radius);
  const d = Number(distance);
  if (!(b > 0) || !(r > 0) || !Number.isFinite(d) || d > r) return 0;
  const k = Math.max(0, Math.min(1, d / r));
  const falloff = Math.max(0, Math.min(1, Number(edgeFalloff) || 0));
  return b * (1 - falloff * k);
}

/** 瘟疫医生：当前叠层上限（基础 5；加大剂量 Lv.1=8，之后每级 +2）。 */
export function plagueMaxStacks(dosageLevel = 0, cfg = CHARACTERS.plague.poison) {
  const base = _int(cfg.MAX_STACKS, 5);
  const lv = _int(dosageLevel, 0);
  if (lv <= 0) return base;
  const first = _int(cfg.DOSAGE_FIRST_BONUS, 3);
  const step = _int(cfg.DOSAGE_STEP, 2);
  return base + first + (lv - 1) * step;
}

/** 瘟疫医生：每秒毒素伤害 = 攻击力 × 每层倍率 × 层数。 */
export function poisonTickDamage(atk, stacks, cfg = CHARACTERS.plague.poison) {
  const a = Math.max(0, Number(atk) || 0);
  const n = Math.max(0, _int(stacks, 0));
  const mul = Math.max(0, Number(cfg.PER_STACK_DMG_MUL) || 0);
  return a * mul * n;
}

/** 「感染」本次可扩散的层数：3 层起按 ratio 向下取整；2 层弱传 1 层；1 层不传。 */
export function plagueBurstLayers(stacks, ratio = 0.7) {
  const n = Math.max(0, _int(stacks, 0));
  if (n < 2) return 0;
  if (n < 3) return 1;
  return Math.floor(n * Math.max(0, Number(ratio) || 0));
}

/** 「感染」本次实际可转移的层数：按疫爆层数传，且不得超过目标当前的剩余叠层空间。 */
export function infectionStacks(stacks, targetStacks = 0, maxStacks = 5, ratio = 0.7) {
  const n = Math.max(0, _int(stacks, 0));
  const cur = Math.max(0, _int(targetStacks, 0));
  const cap = Math.max(0, _int(maxStacks, 0));
  const want = plagueBurstLayers(n, ratio);
  return Math.max(0, Math.min(want, cap - cur));
}

/**
 * 疫爆候选：以尸体为圆心、半径 radius 米的**水平圆柱**范围（与地面圆环一致，忽略高度差），
 * 按水平距离由近到远取前 maxTargets 只。
 * 只做几何筛选；是否允许感染（Boss / 龙部件 / 不可击杀物）由调用方先过滤。
 */
export function plagueBurstTargets(candidates, from, radius = 5, maxTargets = 6) {
  if (!Array.isArray(candidates) || !from) return [];
  const r = Math.max(0, Number(radius) || 0);
  const r2 = r * r;
  const near = [];
  for (const target of candidates) {
    const p = target && target.mesh && target.mesh.position;
    if (!p) continue;
    const dx = (Number(p.x) || 0) - (Number(from.x) || 0);
    const dz = (Number(p.z) || 0) - (Number(from.z) || 0);
    const d2 = dx * dx + dz * dz;
    if (d2 > r2) continue;
    near.push({ target, d2 });
  }
  near.sort((a, b) => a.d2 - b.d2);
  return near.slice(0, Math.max(0, _int(maxTargets, 0))).map((x) => x.target);
}

// ============================================================
// 第八十九修 · 爆炮手空爆判定（纯函数，便于单测）
//   · 先沿真实弹道做一次「射线是否碰到敌人」检测；
//   · 没有敌人时才在「距场地中心 AIRBURST_RADIUS 米」处自动爆炸；
//   · 有敌人（哪怕在 10m 外）就不提前爆，让炮弹继续飞过去命中。
// ============================================================
export const BOMBARD_AIRBURST = {
  RADIUS: 8,       // 距场地中心（世界原点）的爆炸半径
  MAX_SCAN: 60,    // 射线检测距离（约等于火箭 2s 寿命 × 30m/s）
  PAD: 0.12,       // 射线命中容差（米）
};

/**
 * 射线 origin + t·dir 与球（center，radius）的最小正向交点距离。
 * 起点在球内 → 返回出球距离；起点在球外且朝球飞 → 返回入球距离；无交点 → 0。
 */
export function raySphereExitDistance(origin, dir, center = { x: 0, y: 0, z: 0 }, radius = BOMBARD_AIRBURST.RADIUS) {
  if (!origin || !dir) return 0;
  const dx = Number(dir.x) || 0, dy = Number(dir.y) || 0, dz = Number(dir.z) || 0;
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 1e-9)) return 0;
  const ux = dx / len, uy = dy / len, uz = dz / len;
  const ox = (Number(origin.x) || 0) - (Number(center.x) || 0);
  const oy = (Number(origin.y) || 0) - (Number(center.y) || 0);
  const oz = (Number(origin.z) || 0) - (Number(center.z) || 0);
  const r = Math.max(0, Number(radius) || 0);
  if (!(r > 0)) return 0;
  const b = 2 * (ox * ux + oy * uy + oz * uz);
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - 4 * c;
  if (disc < 0) return 0;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / 2;
  const t2 = (-b + sq) / 2;
  if (t1 > 1e-6) return t1;
  if (t2 > 1e-6) return t2;
  return 0;
}

/** 弹道上（0 < t <= maxDist）是否碰到任意可命中的敌人。 */
export function rayHitsBalloon(origin, dir, balloons, maxDist = BOMBARD_AIRBURST.MAX_SCAN) {
  if (!origin || !dir || !Array.isArray(balloons) || !balloons.length) return false;
  const dx = Number(dir.x) || 0, dy = Number(dir.y) || 0, dz = Number(dir.z) || 0;
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 1e-9)) return false;
  const ux = dx / len, uy = dy / len, uz = dz / len;
  const ox = Number(origin.x) || 0, oy = Number(origin.y) || 0, oz = Number(origin.z) || 0;
  const pad = BOMBARD_AIRBURST.PAD;
  for (const b of balloons) {
    if (!b || !b.alive || !b.mesh || !b.mesh.position) continue;
    if (b.behavior === 'ghost' && !b.revealed) continue;
    const vx = b.mesh.position.x - ox;
    const vy = b.mesh.position.y - oy;
    const vz = b.mesh.position.z - oz;
    const t = vx * ux + vy * uy + vz * uz;
    if (t <= 0 || t > maxDist) continue;
    const perp2 = vx * vx + vy * vy + vz * vz - t * t;
    const rr = (Number(b.hitRadius) || Number(b.effectiveRadius) || 0.5) + pad;
    if (perp2 <= rr * rr) return true;
  }
  return false;
}

/**
 * 拱门排布（第八十六修）：
 * 返回从两侧向中间填充的归一化 X 序列（-1 = 最左，+1 = 最右）。
 * 例（MAX=10）：-1, +1, -0.78, +0.78, … 最中间两枚最后出现。
 */
export function archSlotOrder(max = 10) {
  const n = Math.max(1, _int(max, 10));
  if (n === 1) return [0];
  const xs = [];
  for (let i = 0; i < n; i++) xs.push(-1 + (2 * i) / (n - 1));
  const left = xs.filter((x) => x < -1e-9).sort((a, b) => a - b);
  const right = xs.filter((x) => x > 1e-9).sort((a, b) => b - a);
  const out = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] != null) out.push(left[i]);
    if (right[i] != null) out.push(right[i]);
  }
  return out;
}
