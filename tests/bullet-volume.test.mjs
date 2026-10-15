// 第五十四修 · 子弹量级放开（弹道 12 · 射速 20/秒 · 池 1000 · 曳光池 1024）
//
// 现场口径：「要更多子弹」。第五十三修已经把命中判定的地基垫平（_collide 剪枝 ×1.86~×3.5），
//   本修把**数值闸门**一起放开，并把「扇形半角」从恒定值改成随弹道数增长 —— 否则 12 条弹道
//   只会挤在原来那 9° 里变成一根更亮的棍子，谈不上「铺开」。
//
// 锁三件事：
//   ① 上限只有一处口径（cards.ATTRIBUTE_STATS），卡面 desc 与代码封顶必须一致；
//   ② 扇形几何：正中永远有一条精确对准准星的弹道，最外侧 = 半角，半角随弹道数增长到 12 条用满；
//   ③ 池子不变量：最坏并发弹数（含连杀加速与瞬时散射）不得越过子弹池 / 曳光池。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ATTRIBUTE_STATS, ATTR_TYPES } from '../src/content/cards.js';
import { Player } from '../src/game/player.js';
import { BulletManager } from '../src/game/bullets.js';
import { SHOOT, FX, RAPID_FIRE, SCATTER, SCATTER_BURST } from '../src/core/constants.js';
import { parseGunDebug } from '../src/core/gunDebug.js';

const AIM = new THREE.Vector3(0, 0, -1);
const card = (id) => ATTR_TYPES.find((c) => c.id === id);

/** 半角公式（与 player.fire 同一口径）：弹道数 n 时的扇形半角（弧度） */
function halfAngle(n) {
  return SHOOT.SPREAD_ANGLE * Math.min(1, (n - 1) / ((SHOOT.SPREAD_FULL_N || 2) - 1));
}

/** 打一发 n 弹道，返回每条弹道的方向向量（未归一化，与 fire 内一致） */
function fan(n, aim = AIM) {
  const dirs = [];
  Player.prototype.fire.call(
    { forceSingleShot: false, shotCount: n, atk: 9 },
    { position: new THREE.Vector3(), direction: aim.clone() },
    { spawn: (_p, d) => dirs.push(d.clone()) },
    { playShoot() {} },
  );
  return dirs;
}

/** 方向与瞄准线的夹角（弧度） */
function angleFrom(d, aim) {
  const par = d.dot(aim);
  const perp = d.clone().addScaledVector(aim, -par).length();
  return Math.atan2(perp, par);
}

// ---------- ① 上限口径 ----------

test('第五十四修 · 上限放开到 射速 20 / 弹道 12，且只有 ATTRIBUTE_STATS 一处口径', () => {
  assert.deepEqual(ATTRIBUTE_STATS.fireRate, ['fireRate', 2, 20, 2]);
  assert.deepEqual(ATTRIBUTE_STATS.multiShot, ['shotCount', 1, 12, 1]);
  assert.equal(ATTRIBUTE_STATS.atk[2], 700, '攻击力上限不变（没在动它）');
});

test('第五十四修 · 卡面 desc 里写的上限必须与 ATTRIBUTE_STATS 一致（防止只改代码不改文案）', () => {
  for (const c of ATTR_TYPES) {
    const stats = ATTRIBUTE_STATS[c.id];
    if (!stats) continue;
    assert.ok(c.desc.includes(String(stats[2])), `${c.id} 卡面「${c.desc}」里必须出现上限 ${stats[2]}`);
  }
});

test('第五十四修 · 卡牌 apply 真的封顶（连点 30 次不越界），且射速卡落到真实节流源', () => {
  const calls = [];
  const p = { fireRate: 2, shotCount: 1, atk: 100, input: { setFireRate: (r) => calls.push(r) } };
  for (let i = 0; i < 30; i++) { card('fireRate').apply(p); card('multiShot').apply(p); }
  assert.equal(p.fireRate, 20, '射速封顶 20 发/秒');
  assert.equal(p.shotCount, 12, '弹道封顶 12 条');
  assert.equal(calls[calls.length - 1], 20, '射速卡每次都要写回 input（真实节流源）');
  assert.equal(calls.length, 30, '每点一次射速卡都要下发一次');
});

// ---------- ② 扇形几何 ----------

test('第五十四修 · 单发=1 条弹道，且方向就是瞄准方向（不走扇形分支）', () => {
  const dirs = fan(1);
  assert.equal(dirs.length, 1);
  assert.ok(dirs[0].distanceTo(AIM) < 1e-12);
});

test('第五十四修 · 12 条弹道：正中那条精确对准准星，无左右漂移', () => {
  for (const n of [2, 3, 7, 12]) {
    const dirs = fan(n);
    assert.equal(dirs.length, n);
    assert.ok(dirs[0].distanceTo(AIM) < 1e-12, `n=${n} 的第一条必须是正中弹道 t=0`);
  }
});

test('第五十四修 · 最外侧弹道正好落在半角上，且半角随弹道数增长、12 条时用满 SPREAD_ANGLE', () => {
  const spreadDeg = (r) => (r * 180) / Math.PI;
  let prev = -1;
  for (const n of [2, 3, 5, 7, 8, 12]) {
    const dirs = fan(n);
    const outer = Math.max(...dirs.map((d) => Math.abs(angleFrom(d, AIM))));
    assert.ok(Math.abs(outer - Math.atan(halfAngle(n))) < 1e-9, `n=${n} 最外侧应等于半角`);
    assert.ok(spreadDeg(outer) > prev, `n=${n} 扇形应比上一次更宽`);
    prev = spreadDeg(outer);
  }
  // 12 条 = SPREAD_FULL_N，用满 SPREAD_ANGLE（≈8.53°，总张角 ≈17.06°）
  assert.equal(halfAngle(12), SHOOT.SPREAD_ANGLE);
  assert.ok(Math.abs(spreadDeg(Math.atan(halfAngle(12))) - 8.53) < 0.02, '12 条半角 ≈ 8.53°');
  // 相邻间隔恒定 ≈ 1.56°（总张角 ÷ (n-1)）——「加一条弹道 = 外沿再展开一个步进」
  const gap = (2 * spreadDeg(Math.atan(halfAngle(12)))) / 11;
  assert.ok(Math.abs(gap - 1.55) < 0.02, '相邻弹道间隔 ≈ 1.55°');
  // 7 条时与第五十四修之前（恒定半角 0.08 ⇒ ≈9.15°）基本一致 —— 中局手感不要被这一修掀翻
  const total7 = 2 * spreadDeg(Math.atan(halfAngle(7)));
  assert.ok(Math.abs(total7 - 9.15) < 0.5, `7 条总张角 ${total7.toFixed(2)}° 应贴近改前的 9.15°`);
});

test('第五十四修 · SPREAD_FULL_N=2 退回「恒定半角」（第五十四修之前的行为）', () => {
  const old = SHOOT.SPREAD_FULL_N;
  try {
    SHOOT.SPREAD_FULL_N = 2;
    const a2 = Math.max(...fan(2).map((d) => Math.abs(angleFrom(d, AIM))));
    const a12 = Math.max(...fan(12).map((d) => Math.abs(angleFrom(d, AIM))));
    assert.ok(Math.abs(a2 - Math.atan(SHOOT.SPREAD_ANGLE)) < 1e-9);
    assert.ok(Math.abs(a12 - Math.atan(SHOOT.SPREAD_ANGLE)) < 1e-9, '恒定半角：弹道再多也不变宽');
  } finally {
    SHOOT.SPREAD_FULL_N = old;
  }
});

// ---------- ③ 池子不变量 ----------

test('第五十四修 · 最坏并发弹数（连杀加速 × 弹道上限 + 瞬时散射）不越子弹池', () => {
  const rateMax = ATTRIBUTE_STATS.fireRate[2];      // 20 发/秒
  const shotMax = ATTRIBUTE_STATS.multiShot[2];     // 12 条
  const burst = Math.max(SCATTER.COUNT, SCATTER_BURST.COUNT);
  const worst = Math.ceil(rateMax * RAPID_FIRE.MULT * shotMax * SHOOT.BULLET_LIFE) + burst;
  assert.equal(worst, Math.ceil(20 * 1.5 * 12 * 2) + 100, `口径变了：最坏 ${worst} 发`);
  assert.ok(worst <= SHOOT.BULLET_POOL_SIZE, `最坏 ${worst} 发必须 ≤ 池 ${SHOOT.BULLET_POOL_SIZE}`);
});

test('第五十四修 · 曳光池 ≥ 子弹池（两处是联动的，不能只改一个）', () => {
  assert.ok(FX.TRACER.CAPACITY >= SHOOT.BULLET_POOL_SIZE,
    `曳光池 ${FX.TRACER.CAPACITY} 必须 ≥ 子弹池 ${SHOOT.BULLET_POOL_SIZE}`);
});

test('第五十四修 · 子弹池 1000 真的落成 1000 个实例（单 Draw Call 承载）', () => {
  const mgr = new BulletManager(new THREE.Scene());
  assert.equal(mgr.capacity, SHOOT.BULLET_POOL_SIZE);
  assert.equal(mgr._instanced.instanceMatrix.count, SHOOT.BULLET_POOL_SIZE);
  assert.ok(mgr._instanced.instanceColor, '实例色缓冲要在构造时就建好（避免首次加速现建卡一下）');
});

test('第五十四修 · 池子满了复用最旧的，active 不超过 capacity（实例矩阵不越界）', () => {
  const mgr = new BulletManager(new THREE.Scene());
  const cap = SHOOT.BULLET_POOL_SIZE;
  for (let i = 0; i < cap + 50; i++) mgr.spawn(new THREE.Vector3(), new THREE.Vector3(0, 0, -1), 10);
  assert.equal(mgr.active.length, cap, 'active 恰好顶在上限（多出来的复用最旧那颗）');
  assert.ok(mgr.active.length <= mgr.capacity);
});
// ---------- ④ 调试开关 ?gun=（现场验收 12 弹道用） ----------

test('第五十四修 · ?gun= 解析：夹到卡池上限，非法输入一律不生效', () => {
  assert.deepEqual(parseGunDebug('12x20'), { shot: 12, rate: 20 });
  assert.deepEqual(parseGunDebug('12*20'), { shot: 12, rate: 20 }, 'x 与 * 等价');
  assert.deepEqual(parseGunDebug('8'), { shot: 8, rate: null }, '只写一个数 = 只改弹道');
  assert.deepEqual(parseGunDebug('x20'), { shot: null, rate: 20 }, '只改射速');
  assert.deepEqual(parseGunDebug('99x99'), { shot: ATTRIBUTE_STATS.multiShot[2], rate: ATTRIBUTE_STATS.fireRate[2] },
    '超过卡池上限一律夹回来（调试也不该给出合法构筑到不了的数字）');
  assert.deepEqual(parseGunDebug(' 5X3 '), { shot: 5, rate: 3 }, '大小写/空格容错');
  assert.deepEqual(parseGunDebug('12x'), { shot: 12, rate: null }, '尾部多一个 x 宽容掉（当没写射速）');
  for (const bad of [null, '', '   ', 'abc', '0', '0x0', 'x']) {
    assert.equal(parseGunDebug(bad), null, `\`${bad}\` 不该生效`);
  }
});
