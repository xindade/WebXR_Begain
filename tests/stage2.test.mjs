import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FxEffects, TracerTail, ParticlePool, MuzzleFlash } from '../src/game/fx.js';
import { FX, LEVEL_SECONDS, levelSecondsOf, levelTimeScale } from '../src/core/constants.js';
import { ELITE_WINDOW } from '../src/content/eliteMonsters.js';

// 第四十一修 · 档2 打击感视觉层 + 关卡时长。
//   只测纯逻辑与池状态机（不涉及真实渲染）：
//     ① 关卡时长表 / 精英波前移比例
//     ② 曳光的容量与几何（尾迹长度、方向）
//     ③ 火花/碎片池：爆发数量区间、上限、寿命回收、重力
//     ④ 开关关闭时零创建（性能兜底不能被配置关掉）
//     ⑤ 枪口焰闪现与自动熄灭
//     ⑥ 门面 clear() 复位

const DT = 1 / 60;
const sceneOf = () => new THREE.Scene();

// ---------- ① 关卡时长 ----------

test('关卡时长：1~6 关 40s、7~10 关 50s、11 关之后 60s，机制/Boss 关沿用基准', () => {
  for (const n of [1, 2, 4, 5]) assert.equal(levelSecondsOf(n), 40, n + ' 关应为 40s');
  for (const n of [7, 8, 10, 11]) assert.equal(levelSecondsOf(n), 50, n + ' 关应为 50s');
  for (const n of [13, 14, 16, 17]) assert.equal(levelSecondsOf(n), 60, n + ' 关保持 60s');
  for (const n of [3, 6, 9, 12, 15, 18]) assert.equal(levelSecondsOf(n), LEVEL_SECONDS.REF_SECONDS, n + ' 关无倒计时 → 基准值');
  assert.equal(levelSecondsOf(99), LEVEL_SECONDS.REF_SECONDS, '未知关卡 → 基准值');
});

test('精英波前移：比例 = 本关时长 / 基准，且三期都落在关卡结束之前', () => {
  assert.ok(Math.abs(levelTimeScale(1) - 40 / 60) < 1e-9, '1 关 40/60');
  assert.equal(levelTimeScale(13), 1, '时长没变的关卡精英波时间窗不动');

  const win = (n) => ({
    early: ELITE_WINDOW.early * levelTimeScale(n),
    mid: ELITE_WINDOW.mid * levelTimeScale(n),
    late: ELITE_WINDOW.late * levelTimeScale(n),
  });
  const w40 = win(1);
  assert.ok(w40.early < w40.mid && w40.mid < w40.late, '三期先后顺序不变');
  assert.ok(w40.late < levelSecondsOf(1), '后期精英必须在 40s 关卡结束前上场');
  const w50 = win(7);
  assert.ok(w50.late < levelSecondsOf(7), '后期精英必须在 50s 关卡结束前上场');

  // 反证：不缩放的话，后期 40s 正好顶在 40s 关卡的结束点上（永远打不到）
  assert.equal(ELITE_WINDOW.late, 40);
  assert.ok(!(ELITE_WINDOW.late < levelSecondsOf(1)), '原值在 40s 关卡里确实来不及');
  // 60s 关卡（13 关起）必须与改动前完全一致
  const w60 = win(13);
  assert.deepEqual(w60, { early: ELITE_WINDOW.early, mid: ELITE_WINDOW.mid, late: ELITE_WINDOW.late });
});

// ---------- ② 曳光 ----------

test('曳光：超出容量按容量封顶，clear() 归零', () => {
  const tail = new TracerTail(sceneOf(), { ...FX.TRACER, CAPACITY: 4 });
  const d = new THREE.Vector3(0, 0, -1);
  tail.begin();
  for (let i = 0; i < 10; i++) tail.add(new THREE.Vector3(0, 0, -i), d, 0xffe066);
  tail.end();
  assert.equal(tail.mesh.count, 4, '实例数不得超过容量（否则越界写矩阵）');
  tail.clear();
  assert.equal(tail.mesh.count, 0);
});

test('曳光几何：尾迹自弹头沿飞行反方向拖出，长轴拉伸 = LENGTH', () => {
  const tail = new TracerTail(sceneOf(), FX.TRACER);
  const pos = new THREE.Vector3(0, 0, -10);
  const dir = new THREE.Vector3(0, 0, -1);
  tail.begin();
  tail.add(pos, dir, 0xffe066);
  tail.end();
  const m = new THREE.Matrix4();
  tail.mesh.getMatrixAt(0, m);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  assert.ok(Math.abs(p.z - (-10 + FX.TRACER.LENGTH * 0.5)) < 1e-5, '中点应在弹头后方半个长度（Z 朝 +Z 拖）');
  assert.ok(Math.abs(s.y - FX.TRACER.LENGTH) < 1e-5, '长轴(Y) = LENGTH');
  assert.ok(Math.abs(s.x - FX.TRACER.WIDTH) < 1e-5, '粗细(X) = WIDTH');
});

test('曳光：敌方投射物三色齐备（手里剑/鬼火/墨汁）', () => {
  for (const kind of ['shuriken', 'ghostfire', 'ink']) {
    assert.equal(typeof FX.TRACER.ENEMY_COLORS[kind], 'number', kind + ' 需要一条曳光色');
  }
});

// ---------- ③ 颗粒池 ----------

test('火花：一次爆发落在 COUNT 区间内，池满不突破上限', () => {
  const cfg = { ...FX.SPARK, POOL: 8 };
  const pool = new ParticlePool(sceneOf(), cfg, new THREE.IcosahedronGeometry(1, 0));
  pool.burst(new THREE.Vector3(), 0xffd24a);
  assert.ok(pool.activeCount >= cfg.COUNT[0] && pool.activeCount <= cfg.COUNT[1], '单次爆发数量在区间内');
  for (let i = 0; i < 50; i++) pool.burst(new THREE.Vector3(), 0xffd24a);
  assert.ok(pool.activeCount <= cfg.POOL, '活跃数不得超过池上限');
  pool.update(DT);
  assert.equal(pool.mesh.count, pool.activeCount, 'update() 后实例数与活跃数一致');
});

test('火花：不受重力；寿命到期全部回池', () => {
  const cfg = { ...FX.SPARK };
  const pool = new ParticlePool(sceneOf(), cfg, new THREE.IcosahedronGeometry(1, 0));
  pool.burst(new THREE.Vector3(), 0xffd24a);
  const it = pool.items[0];
  const vy = it.v.y;
  pool.update(DT);
  assert.equal(it.v.y, vy, '火花不受重力 → 竖直速度不变');
  for (let t = 0; t <= cfg.LIFE + 0.1; t += DT) pool.update(DT);
  assert.equal(pool.activeCount, 0, '寿命到期必须回收（高射速下否则会漏）');
  assert.equal(pool.mesh.count, 0);
});

test('碎片：受重力、颜色取敌种 tint、精英倍率放大数量', () => {
  const cfg = { ...FX.DEBRIS };
  const pool = new ParticlePool(sceneOf(), cfg, new THREE.BoxGeometry(1, 1, 1));
  pool.burst(new THREE.Vector3(), 0xff6b81, 1);
  const it = pool.items[0];
  const vy = it.v.y;
  pool.update(DT);
  assert.ok(it.v.y < vy, '碎片受重力 → 竖直速度递减');
  assert.equal(it.color.getHex(), 0xff6b81, '碎片颜色 = 传入的敌种 tint（兜底才用默认色）');

  pool.clear();
  pool.burst(new THREE.Vector3(), 0xffffff, FX.DEBRIS.ELITE_MUL);
  assert.ok(pool.activeCount >= Math.round(cfg.COUNT[0] * FX.DEBRIS.ELITE_MUL), '精英倍率下碎片更多');
});

test('碎片：未给颜色时回落到配置兜底色', () => {
  const pool = new ParticlePool(sceneOf(), FX.DEBRIS, new THREE.BoxGeometry(1, 1, 1));
  pool.burst(new THREE.Vector3(), null, 1);
  assert.equal(pool.items[0].color.getHex(), FX.DEBRIS.COLOR);
});

// ---------- ④ 开关 ----------

test('ENABLED=false：一次爆发零创建（配置能关掉，不残留任何实例）', () => {
  const pool = new ParticlePool(sceneOf(), { ...FX.SPARK, ENABLED: false }, new THREE.IcosahedronGeometry(1, 0));
  pool.burst(new THREE.Vector3(), 0xffffff);
  assert.equal(pool.activeCount, 0);
  assert.equal(pool.mesh.count, 0);
});

// ---------- ⑤ 枪口焰 ----------

test('枪口焰：闪现后按 LIFE 自动熄灭，槽位轮转不超池', () => {
  const mf = new MuzzleFlash(sceneOf(), { ...FX.MUZZLE, POOL: 2 });
  mf.flash(new THREE.Vector3(1, 2, 3));
  assert.equal(mf._slots[0].sp.visible, true);
  assert.deepEqual(mf._slots[0].sp.position.toArray(), [1, 2, 3], '焰落在真实枪口坐标');
  mf.update(FX.MUZZLE.LIFE + 0.01);
  assert.equal(mf._slots[0].sp.visible, false, '过了 LIFE 必须熄灭（否则枪口常亮）');
  mf.flash(new THREE.Vector3());
  mf.flash(new THREE.Vector3());
  mf.flash(new THREE.Vector3());
  assert.equal(mf._slots.filter((s) => s.sp.visible).length, 2, '并发只占 POOL 个槽位');
});

// ---------- ⑥ 门面 ----------

test('门面：clear() 后曳光/火花/碎片/枪口焰全部归零', () => {
  const fx = new FxEffects(sceneOf());
  fx.tracer.begin();
  fx.tracer.add(new THREE.Vector3(), new THREE.Vector3(0, 0, -1), null);
  fx.tracer.end();
  fx.spark(new THREE.Vector3());
  fx.debrisBurst(new THREE.Vector3(), 0xff6b81, 1);
  fx.muzzle(new THREE.Vector3());
  fx.update(DT);
  assert.ok(fx.tracer.mesh.count > 0 && fx.sparks.activeCount > 0 && fx.debris.activeCount > 0);
  fx.clear();
  assert.equal(fx.tracer.mesh.count, 0);
  assert.equal(fx.sparks.activeCount, 0);
  assert.equal(fx.debris.activeCount, 0);
  assert.equal(fx.muzzleFx._slots.every((s) => !s.sp.visible), true);
});

test('门面：未给颜色时用的是配置默认色（火花暖金 / 碎片兜底灰）', () => {
  const fx = new FxEffects(sceneOf());
  fx.spark(new THREE.Vector3());
  assert.equal(fx.sparks.items[0].color.getHex(), FX.SPARK.COLOR);
  fx.debrisBurst(new THREE.Vector3(), null, 1);
  assert.equal(fx.debris.items[0].color.getHex(), FX.DEBRIS.COLOR);
});