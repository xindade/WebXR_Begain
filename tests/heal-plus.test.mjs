// 第四十九修（返工·三轮）· 治疗术士：每 3 秒给「血量百分比最低的精英怪」回 1000 血（超出上限不算）+ 粉色加号
//
// 三轮的现场口径：绿环看不到 → 换粉色加号 → 「还是没作用」。真根因是**回调挂错了对象**：
//   game 把 onHealCast 挂在 waves（WaveManager）上，而读取方是 BalloonManager（waves.balloons）
//   ⇒ 回调从没触发、heal 恒为 0、加号当然不飞（上一轮「绿环看不到」也是同一个原因）。
//   所以这个文件除了数值，还专门锁一条**接线回归**。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BalloonManager, Balloon, pickHealTarget } from '../src/game/balloons.js';
import { HealPlusFx } from '../src/game/fx.js';
import { WaveManager } from '../src/game/waves.js';
import { HEAL_LINK } from '../src/core/constants.js';

const vec = (x, y, z) => new THREE.Vector3(x, y, z);

function fake(behavior, pos, hp = 0, maxHp = 1000, isElite = false) {
  const f = {
    behavior, alive: true, hp, maxHp, type: {}, _frozen: false, isElite,
    mesh: { position: vec(pos[0], pos[1], pos[2]) },
    healFlashes: 0,
  };
  f.flashHeal = () => { f.healFlashes++; };
  return f;
}

function run(mgr, dt) { BalloonManager.prototype._applyHealAura.call(mgr, dt); }

// cast(h, t) 的返回值就是本次治疗量；缺省 = PULSE_HEAL（1000，模拟 game 侧接线）
function manager(list, playerPos = vec(0, 1.6, 0), cast = null) {
  const casts = [];
  return {
    list, casts, _playerPos: playerPos,
    onHealCast: (h, t) => { casts.push([h, t]); return cast ? cast(h, t) : HEAL_LINK.PULSE_HEAL; },
  };
}

test('第四十九修 · 治疗术士站桩：controlled=true（不朝玩家移动、不被别的怪拱走）', () => {
  const heart = new Balloon('heart', {});
  assert.equal(heart.controlled, true);
  assert.equal(new Balloon('basic', {}).controlled, false, '普通怪不受影响');
});

test('第四十九修 · 新口径参数：每 3 秒一次、每次 1000 血、只奶精英', () => {
  assert.equal(HEAL_LINK.PULSE_PERIOD, 3, '现场口径「每 3 秒恢复一次」');
  assert.equal(HEAL_LINK.PULSE_HEAL, 1000, '一次 1000 血');
  assert.equal(HEAL_LINK.ELITE_ONLY, true, '只恢复精英怪');
  assert.equal(HEAL_LINK.RING_ENABLED, false, '绿环仍是关的（现在是粉色加号）');
  assert.equal(HEAL_LINK.PLUS_ENABLED, true);
});

test('第四十九修 · 只挑精英：血最少的杂鱼不算数（Boss 也不抢奶）', () => {
  const healer = fake('heal', [0, 1.3, -24], 1000, 1000, true);
  const trash = fake('basic', [0, 0, -3], 10, 1000, false);       // 1%，但只是杂鱼
  const boss = fake('boss', [0, 0, -8], 40000, 60000, false);     // 66%：isElite=false
  const elite = fake('shield', [0, 0, -12], 600, 1000, true);     // 60%
  const pick = pickHealTarget([healer, trash, boss, elite], healer, vec(0, 1.6, 0), { elitesOnly: true });
  assert.equal(pick, elite, 'ELITE_ONLY=true 时只考虑精英');
});

test('第四十九修 · 精英之间：选血量百分比最低的；并列取离玩家最近的', () => {
  const healer = fake('heal', [0, 1.3, -24], 1000, 1000, true);
  const a = fake('eliteKnight', [0, 0, -20], 900, 1000, true);    // 90%
  const b = fake('shield', [0, 0, -12], 300, 1000, true);         // 30% ← 血最少
  assert.equal(pickHealTarget([healer, a, b], healer, vec(0, 1.6, 0), { elitesOnly: true }), b);
  const c = fake('shield', [0, 0, -4], 300, 1000, true);          // 并列 30%，离玩家 4m
  assert.equal(pickHealTarget([healer, a, b, c], healer, vec(0, 1.6, 0), { elitesOnly: true }), c);
});

test('第四十九修 · 排除自己 / 已死 / 空表', () => {
  const healer = fake('heal', [0, 1.3, -24], 10, 1000, true);     // 术士自己血最少也不给自己奶
  const dead = fake('eliteKnight', [0, 0, -5], 0, 1000, true);
  dead.alive = false;
  const alive = fake('shield', [0, 0, -9], 300, 1000, true);
  assert.equal(pickHealTarget([healer, dead, alive], healer, vec(0, 1.6, 0), { elitesOnly: true }), alive);
  assert.equal(pickHealTarget([healer], healer, vec(0, 1.6, 0), { elitesOnly: true }), null);
});

test('第四十九修 · 每 3 秒一发 1000 血：周期没到不回血，跨过周期再来一发', () => {
  const healer = fake('heal', [0, 0, -24], 1000, 1000, true);
  const target = fake('eliteKnight', [0, 0, -6], 100, 5000, true);
  const mgr = manager([healer, target]);
  run(mgr, 0.016);                                  // 落地即来一发（让玩家马上看懂这只在奶人）
  assert.equal(target.hp, 1100, '一次 +1000');
  assert.equal(mgr.casts.length, 1);
  assert.equal(mgr.casts[0][1], target, '回调必须带上被治的那只怪');
  let acc = 0;
  while (acc < HEAL_LINK.PULSE_PERIOD - 0.1) { run(mgr, 0.1); acc += 0.1; }
  assert.equal(target.hp, 1100, '3 秒没到就不该回血');
  run(mgr, 0.2);
  assert.equal(target.hp, 2100, '跨过 3 秒再来一发');
  assert.equal(mgr.casts.length, 2);
});

test('第四十九修 · 超出上限的回复量不算（不是 +1000 也不是溢出）', () => {
  const healer = fake('heal', [0, 0, -24], 1000, 1000, true);
  const target = fake('eliteKnight', [0, 0, -6], 9500, 10000, true);
  const mgr = manager([healer, target]);
  run(mgr, 0.016);
  assert.equal(target.hp, 10000, '一次 1000 → 9500+1000=10500 被 maxHp 夹到 10000');
});

test('第四十九修 · 目标满血也照常发射加号 + 闪粉（只回血被上限吃掉）', () => {
  const healer = fake('heal', [0, 0, -24], 1000, 1000, true);
  const target = fake('eliteKnight', [0, 0, -6], 10000, 10000, true);
  const mgr = manager([healer, target]);
  run(mgr, 0.016);
  assert.equal(target.hp, 10000, '满血不再涨');
  assert.equal(mgr.casts.length, 1, '但回调照发 → 加号照飞（玩家必须看得见）');
  assert.equal(target.healFlashes, 1, '命中闪一下粉');
});

test('第四十九修 · 场上没有精英 → 什么都不做（不发射、不回血）', () => {
  const healer = fake('heal', [0, 0, -24], 1000, 1000, true);
  const trash = fake('basic', [0, 0, -3], 10, 1000, false);
  const mgr = manager([healer, trash]);
  run(mgr, 0.016);
  assert.equal(trash.hp, 10, '杂鱼不会被奶');
  assert.equal(mgr.casts.length, 0, '没有目标 → 不回调（也就没有加号）');
});

test('第四十九修 · 冻结中的术士暂停治疗（定身咒期间不奶）', () => {
  const healer = fake('heal', [0, 0, -24], 1000, 1000, true);
  healer._frozen = true;
  const target = fake('eliteKnight', [0, 0, -6], 100, 5000, true);
  const mgr = manager([healer, target]);
  run(mgr, 1.0);
  assert.equal(target.hp, 100);
  assert.equal(mgr.casts.length, 0);
});

test('第四十九修 · PULSE=false 退回旧的「每帧按半径连续回血」（保留回退口径）', () => {
  const healer = fake('heal', [0, 0, -10], 1000, 1000, true);
  healer.type = { healRadius: 6, healAura: 10 };
  const near = fake('basic', [0, 0, -8], 0, 1000, false);         // 旧口径连杂鱼也回
  const far = fake('basic', [0, 0, 60], 0, 1000, false);
  const mgr = manager([healer, near, far]);
  const saved = HEAL_LINK.PULSE;
  HEAL_LINK.PULSE = false;
  try {
    run(mgr, 0.5);
    assert.equal(near.hp, 5, 'healAura × dt');
    assert.equal(far.hp, 0, '旧口径仍按半径判定');
    assert.equal(mgr.casts.length, 0, '旧口径不走目标选择');
  } finally { HEAL_LINK.PULSE = saved; }
});

test('★接线回归：挂在 waves 上的 onHealCast 必须落到 BalloonManager（三轮的坑）', () => {
  // game 侧写法是 waves.onHealCast = fn；读取方却是 balloons._applyHealAura。
  // 没有转发访问器时它只是个没人读的普通属性 ⇒ 治疗术士「完全没作用」。
  const waves = Object.create(WaveManager.prototype);
  waves.balloons = new BalloonManager(new THREE.Scene());
  const cast = [];
  const fn = (h, t) => { cast.push(t); return 1000; };
  waves.onHealCast = fn;
  assert.equal(waves.balloons.onHealCast, fn, '★ 必须落到 balloons（读取方）上');
  assert.equal(waves.onHealCast, fn, '读回来也要是同一个');
  // 真跑一遍：挂着回调时精英该被奶
  const healer = fake('heal', [0, 0, -24], 1000, 1000, true);
  const target = fake('eliteKnight', [0, 0, -6], 100, 5000, true);
  waves.balloons.list = [healer, target];
  waves.balloons._playerPos = vec(0, 1.6, 0);
  BalloonManager.prototype._applyHealAura.call(waves.balloons, 0.016);
  assert.equal(target.hp, 1100, '★ 通过 waves 挂的回调必须真的生效');
  assert.equal(cast.length, 1);
});

test('第四十九修 · flashHeal 用粉色（不是受击白），且比受击时长更长才看得出是「治疗」', () => {
  const b = new Balloon('basic', {});
  b.flashHeal();
  assert.equal(b._flashColor, HEAL_LINK.PLUS_COLOR);
  assert.ok(b._flash > 0.1, '要比受击闪烁(0.1s)长');
  b.takeDamage(1);
  assert.equal(b._flashColor, 0xffffff, '挨打要把粉闪复位成白闪');
});

test('第四十九修 · 粉色加号：从术士飞到目标、飞完自动隐藏、池不增长', () => {
  const fx = new HealPlusFx(new THREE.Scene(), HEAL_LINK);
  const from = vec(0, 1.5, -24);
  const to = vec(0, 1.2, -5);
  fx.cast(from, to);
  assert.equal(fx.slots.length, 1, '按需增长一个槽');
  const sp = fx.slots[0].sp;
  assert.equal(sp.visible, true);
  assert.ok(sp.position.distanceTo(from) < 1e-6, '起点 = 术士位置');
  fx.update(HEAL_LINK.PLUS_DUR * 0.5);
  assert.ok(sp.position.z > from.z && sp.position.z < to.z, '中途在 from→to 之间');
  assert.ok(sp.position.y > from.y, '走抛物线（中段抬高）');
  fx.update(HEAL_LINK.PLUS_DUR);
  assert.equal(sp.visible, false, '飞完自动隐藏');
  for (let i = 0; i < HEAL_LINK.PLUS_POOL * 3; i++) fx.cast(from, to);
  assert.ok(fx.slots.length <= HEAL_LINK.PLUS_POOL, '槽数不超过 PLUS_POOL');
  fx.clear();
  assert.ok(fx.slots.every((s) => s.sp.visible === false));
});

test('第四十九修 · 粉色加号：PLUS_COLOR 是粉色、开关可关', () => {
  const c = new THREE.Color(HEAL_LINK.PLUS_COLOR);
  assert.ok(c.r > 0.6 && c.b > 0.4 && c.g < c.r, '偏粉（红高、蓝中、绿最低）：' + c.getHexString());
  const fx = new HealPlusFx(new THREE.Scene(), { ...HEAL_LINK, PLUS_ENABLED: false });
  fx.cast(vec(0, 1, 0), vec(0, 1, -5));
  assert.equal(fx.slots.length, 0, '关掉开关就不该建槽');
});
