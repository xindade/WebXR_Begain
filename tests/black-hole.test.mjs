// 第六十七修 · 黑洞技能（第 3 关第三张卡）
//
// 锁六条现场口径：
//   ① 伤害 20/秒、只有靠近洞心才受伤；② Boss 免疫；③ 方向 = 释放瞬间的头部朝向；
//   ④ 被吸期间暂停攻击；⑤ 6 秒结束后原地放回；⑥ 默认技能「能量散射」保留。
//
// 另锁三个实现细节：
//   · 小怪 1s 后填进竖直圆饼并完全静止；精英 2s 到位后做径向振荡（向前挪一点又被拽回去）；
//   · 路径穿过飞毯时走过顶弧线，逻辑上打 _bhCaptured 标（不触发自爆 / 「爆」字 / 内圈滴滴）；
//   · 黑洞卡替换的是 scatterburst，SKILL_CARDS 里不再有它会卖。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BLACK_HOLE, MOVE } from '../src/core/constants.js';
import { SKILL_CARDS } from '../src/content/cards.js';
import { BalloonManager, isBombMarkTarget } from '../src/game/balloons.js';
import {
  isBlackHoleImmune, blackHolePullDuration, blackHoleEliteRadius, segmentCrossesCarpet,
  blackHoleSlotAngle, blackHoleDiscSlot, blackHoleScaleAt, blackHoleBlinkAt,
} from '../src/game/blackHole.js';

const originalLoad = THREE.TextureLoader.prototype.load;
let Game;
try {
  THREE.TextureLoader.prototype.load = () => new THREE.Texture();
  ({ Game } = await import('../src/game/game.js'));
} finally { THREE.TextureLoader.prototype.load = originalLoad; }

function mkBalloon({ x = 0, z = -10, elite = false, climax = false, boss = false, hp = 1e9 } = {}) {
  const b = {
    alive: true, isElite: elite, isClimax: climax, isBoss: boss,
    behavior: boss ? 'basic' : 'basic', type: { id: 'basic' },
    moveFrozen: false, effectiveRadius: 0.6,
    mesh: new THREE.Object3D(),
    hp, maxHp: hp, _lastDamage: 0,
    takeDamage(dmg) {
      if (!this.alive) return false;
      this.hp -= dmg; this._lastDamage = dmg;
      if (this.hp <= 0) { this.alive = false; return true; }
      return false;
    },
  };
  b.mesh.position.set(x, 1.5, z);
  return b;
}

function mkGame(center = new THREE.Vector3(0, BLACK_HOLE.CENTER_Y, -15)) {
  const g = Object.create(Game.prototype);
  const killed = [];
  // 玩家在洞口正前方（z=0），吸附环贴在漩涡正面，并保持竖直
  const frontDir = new THREE.Vector3(0, 0, 1);
  const absorbCenter = center.clone().addScaledVector(
    frontDir, BLACK_HOLE.RING_FRONT);
  Object.assign(g, {
    balloons: { list: [], remove(b) { const i = g.balloons.list.indexOf(b); if (i >= 0) g.balloons.list.splice(i, 1); } },
    player: { skillDamageMul: 1 },
    damageNumbers: { n: 0, spawn() { this.n++; } },
    _bhActive: true,
    _bhFx: null,
    _bhT: 0,
    _bhDamageAcc: 0,
    _bhCenter: center.clone(),
    _bhFrontDir: frontDir,
    _bhAbsorbCenter: absorbCenter,
    _bhTargets: new Set(),
    _onKilled: (b) => killed.push(b),
  });
  g.killed = killed;
  return g;
}

function step(g, total, frames = 60) {
  const dt = total / frames;
  for (let i = 0; i < frames; i++) g._updateBlackHole(dt);
}

// ---------- ① 口径 ----------

test('黑洞参数：前方 15m / 持续 6s / 伤害 20 每秒 / 小怪 1s 精英 2s', () => {
  assert.equal(BLACK_HOLE.DIST, 15);
  assert.equal(BLACK_HOLE.DURATION, 6);
  assert.equal(BLACK_HOLE.DPS, 20);
  assert.equal(BLACK_HOLE.PULL_BASIC, 1.0);
  assert.equal(BLACK_HOLE.PULL_ELITE, 2.0);
  assert.ok(BLACK_HOLE.RIM > 0 && BLACK_HOLE.DAMAGE_RADIUS > BLACK_HOLE.RIM, '伤害圈要罩住洞缘');
});

test('免疫名单：Boss / 龙部件 / 无敌怪 / 受控 Boss 实体免疫；基础怪与治疗术士可吸', () => {
  assert.equal(isBlackHoleImmune(mkBalloon({ boss: true })), true);
  assert.equal(isBlackHoleImmune({ alive: true, isDragonPart: true, mesh: {} }), true);
  assert.equal(isBlackHoleImmune({ alive: true, type: { invincible: true }, mesh: {} }), true);
  assert.equal(isBlackHoleImmune({ alive: true, controlled: true, behavior: 'basic', mesh: {} }), true);
  assert.equal(isBlackHoleImmune(mkBalloon()), false);
  assert.equal(isBlackHoleImmune(mkBalloon({ elite: true })), false);
  assert.equal(isBlackHoleImmune({ alive: true, controlled: true, behavior: 'heal', mesh: {} }), false);
});

test('吸附时长：小怪 1s，精英 / 末尾精英 2s', () => {
  assert.equal(blackHolePullDuration(mkBalloon()), 1.0);
  assert.equal(blackHolePullDuration(mkBalloon({ elite: true })), 2.0);
  assert.equal(blackHolePullDuration(mkBalloon({ climax: true })), 2.0);
});

test('精英振荡：t=0 在洞缘，半周期到最外，整周期回到洞缘', () => {
  assert.ok(Math.abs(blackHoleEliteRadius(0) - BLACK_HOLE.ABSORB_RIM) < 1e-9);
  assert.ok(Math.abs(blackHoleEliteRadius(BLACK_HOLE.OSC_PERIOD / 2) - (BLACK_HOLE.ABSORB_RIM + BLACK_HOLE.OSC_AMP)) < 1e-9);
  assert.ok(Math.abs(blackHoleEliteRadius(BLACK_HOLE.OSC_PERIOD) - BLACK_HOLE.ABSORB_RIM) < 1e-9);
});

test('第六十八修 · 黑洞尺寸：开局 1 秒从小长大，之后接近 1', () => {
  assert.ok(blackHoleScaleAt(0) <= BLACK_HOLE.START_SCALE + 0.01, '出现瞬间很小');
  assert.ok(blackHoleScaleAt(0.5) > 0.85, '半秒已经长到八成以上（猛然变大）');
  assert.ok(Math.abs(blackHoleScaleAt(1.0) - 1) < 0.08, '1 秒基本到位');
  assert.ok(Math.abs(blackHoleScaleAt(3.0) - 1) < 0.08, '之后保持最终大小（仅轻微呼吸）');
});

test('第六十八修 · 最后 1 秒闪两下：进入前为 0，1 秒内出现两个峰值，结束时归零', () => {
  assert.equal(blackHoleBlinkAt(BLACK_HOLE.DURATION - BLACK_HOLE.BLINK_TIME - 0.01), 0);
  const p25 = BLACK_HOLE.DURATION - BLACK_HOLE.BLINK_TIME * 0.75;
  const p50 = BLACK_HOLE.DURATION - BLACK_HOLE.BLINK_TIME * 0.50;
  const p75 = BLACK_HOLE.DURATION - BLACK_HOLE.BLINK_TIME * 0.25;
  assert.ok(blackHoleBlinkAt(p25) > 0.95, '第一下');
  assert.ok(blackHoleBlinkAt(p50) < 0.05, '两下之间回到暗');
  assert.ok(blackHoleBlinkAt(p75) > 0.95, '第二下');
  assert.ok(blackHoleBlinkAt(BLACK_HOLE.DURATION) < 0.05, '结束归零');
});

test('第七十四修 · 小怪填满竖直圆饼：洞心到外缘都有，不再全部停在洞缘', () => {
  const g = mkGame();
  const list = [];
  for (let i = 0; i < 8; i++) list.push(mkBalloon({ x: (i - 4) * 0.35, z: -10 }));
  g.balloons.list = list;
  step(g, 1.01);
  const discR = BLACK_HOLE.ABSORB_RIM * BLACK_HOLE.DISC_FILL;
  const radii = list.map((b) => b.mesh.position.distanceTo(g._bhAbsorbCenter));
  for (const b of list) {
    assert.ok(b.mesh.position.distanceTo(g._bhAbsorbCenter) <= discR + 0.05, '都在圆饼内');
    assert.ok(b.mesh.position.z > g._bhCenter.z, '所有落点都在黑洞**前面**（朝玩家一侧），不会被黑盘挡住');
    assert.ok(Math.abs(b.mesh.position.z - g._bhAbsorbCenter.z) < 1e-6, '整个圆饼在同一竖直平面上');
  }
  assert.ok(Math.max(...list.map((b) => b.mesh.position.y)) > g._bhAbsorbCenter.y + 0.6,
    '圆饼向上铺开（不再是平行于地面的圈）');
  assert.ok(Math.min(...list.map((b) => b.mesh.position.y)) < g._bhAbsorbCenter.y - 0.6,
    '圆饼向下铺开（不再是平行于地面的圈）');
  assert.ok(Math.min(...radii) < 0.05, '洞心也有怪，圆饼中间不是空的');
  assert.ok(Math.max(...radii) > discR * 0.8, '外缘也有怪，圆饼不是一个小点');
  assert.ok(radii.some((r) => r > discR * 0.25 && r < discR * 0.75), '中外圈都有分布，才是填满的圆饼');
  assert.equal(BLACK_HOLE.ABSORB_RIM * 2, BLACK_HOLE.RIM,
    '第七十三修：怪物吸附环半径 = 黑洞视觉半径的一半（现场「圈再缩小一半」）');

  // 向日葵槽位本身也单测：洞心起步、外缘封顶、半径由内向外递增
  const slots = Array.from({ length: 8 }, (_, i) => blackHoleDiscSlot(i, 8));
  assert.ok(slots[0].r < 1e-9, '第一只落洞心');
  assert.ok(slots[7].r <= discR + 1e-9, '最后一只在圆饼内');
  for (let i = 1; i < slots.length; i++) assert.ok(slots[i].r > slots[i - 1].r, '半径由内向外递增');
});

test('飞毯弧线判定：穿过 4×8 区域才走弧线，绕开/停在外面都直飞', () => {
  const to = new THREE.Vector3(0, 2, -15);
  assert.equal(segmentCrossesCarpet(new THREE.Vector3(0, 1, 3), to, 0.5), true, '从场地后方出发 → 穿过');
  assert.equal(segmentCrossesCarpet(new THREE.Vector3(0, 1, -8), to, 0.5), false, '同在前方、不经过场地');
  assert.equal(segmentCrossesCarpet(new THREE.Vector3(10, 1, 0), to, 0.5), false, '从右侧斜插但没进框');
  assert.equal(MOVE.BOUND_X, 2);
  assert.equal(MOVE.BOUND_Z, 4);
});

// ---------- ② 释放：头部朝向锁定 ----------

test('释放瞬间锁方向：相机前向 -Z → 洞心在 (0, CENTER_Y, -15)', () => {
  const g = mkGame();
  g.world = { camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene() };
  g.world.camera.position.set(0, 1.6, 0);
  g.world.camera.lookAt(0, 1.6, -10);
  g._startBlackHole();
  assert.equal(g._bhActive, true);
  assert.ok(Math.abs(g._bhCenter.x) < 1e-6);
  assert.ok(Math.abs(g._bhCenter.z + BLACK_HOLE.DIST) < 1e-6);
  assert.equal(g._bhCenter.y, BLACK_HOLE.CENTER_Y);
  assert.ok(g._bhAbsorbCenter.z > g._bhCenter.z, '吸附环在洞心朝玩家一侧');
  assert.ok(Math.abs(g._bhAbsorbCenter.z - (g._bhCenter.z + BLACK_HOLE.RING_FRONT)) < 1e-6);
  // 释放后再转头，洞心不移动
  g.world.camera.lookAt(10, 1.6, 0);
  assert.ok(Math.abs(g._bhCenter.z + BLACK_HOLE.DIST) < 1e-6);
  g._endBlackHole();
});

// ---------- ③ 吸附 / 放回 ----------

test('小怪 1 秒后被吸进圆饼并完全静止；精英 2 秒后才到位', () => {
  const g = mkGame();
  const basic = mkBalloon({ x: 0, z: -10 });
  const elite = mkBalloon({ x: 6, z: -15, elite: true });
  g.balloons.list = [basic, elite];

  step(g, 1.01);
  assert.equal(basic._bhCaptured, true);
  assert.equal(basic.moveFrozen, true);
  assert.ok(basic.mesh.position.distanceTo(g._bhAbsorbCenter) < 0.05, '单只小怪停在圆饼中心');

  const eliteD1 = elite.mesh.position.distanceTo(g._bhAbsorbCenter);
  step(g, 1.01);
  const eliteD2 = elite.mesh.position.distanceTo(g._bhAbsorbCenter);
  assert.ok(eliteD2 <= BLACK_HOLE.ABSORB_RIM + BLACK_HOLE.OSC_AMP + 0.05, '精英 2 秒内到位');
  assert.ok(eliteD1 > BLACK_HOLE.ABSORB_RIM + 0.3, '1 秒时精英还在路上');
});

test('Boss 不挪位置、不受伤；治疗术士可以被吸（不误伤免疫名单）', () => {
  const g = mkGame();
  const boss = mkBalloon({ x: 0, z: -15, boss: true });
  g.balloons.list = [boss];
  step(g, 1.01);
  assert.ok(Math.abs(boss.mesh.position.z + 15) < 1e-9, 'Boss 原地不动');
  assert.equal(boss.hp, 1e9, 'Boss 不吃黑洞伤害');
});

test('6 秒到期：原地放回、恢复原 moveFrozen、清掉捕获标', () => {
  const g = mkGame();
  const b = mkBalloon({ x: 0, z: -10 });
  b.moveFrozen = true;   // 模拟被教学/其它系统冻结过
  g.balloons.list = [b];
  step(g, 6.1, 120);
  assert.equal(g._bhActive, false);
  assert.equal(b._bhCaptured, false);
  assert.equal(b.moveFrozen, true, '恢复进黑洞前的冻结状态');
  assert.ok(b.mesh.position.distanceTo(g._bhAbsorbCenter) <= BLACK_HOLE.ABSORB_RIM + 0.05,
    '停在吸附圆饼内，不弹回起点');
});

// ---------- ④ 伤害 ----------

test('伤害节拍：洞心 3.5m 内每 0.5s 扣 10（20/s），远处不掉血', () => {
  const g = mkGame();
  const near = mkBalloon({ x: 0, z: -13, hp: 100 });
  const far = mkBalloon({ x: 0, z: -5, hp: 100 });
  const boss = mkBalloon({ x: 0, z: -13, boss: true, hp: 100 });
  g.balloons.list = [near, far, boss];
  g._bhDamageTick();
  assert.equal(near.hp, 90, '20 × 0.5 = 10');
  assert.equal(far.hp, 100, '10m 外不受伤');
  assert.equal(boss.hp, 100, 'Boss 免疫');
  assert.equal(g.damageNumbers.n, 1, '只给真正受伤的怪弹数字');
});

test('伤害吃技能倍率；打死后走 _onKilled（击杀音/积分/商店币统一入口）', () => {
  const g = mkGame();
  g.player.skillDamageMul = 2;
  const b = mkBalloon({ x: 0, z: -13, hp: 20 });
  g.balloons.list = [b];
  g._bhDamageTick();
  assert.equal(b.hp, 0);
  assert.equal(g.killed.length, 1);
  assert.equal(g.killed[0], b);
});

// ---------- ⑤ 与既有系统的隔离 ----------

test('被吸的治疗术士暂停治疗（辅助行为也要停，不只是攻击）', () => {
  const healer = {
    behavior: 'heal', alive: true, _frozen: false, _bhCaptured: true,
    hp: 1000, maxHp: 1000, isElite: true,
    mesh: { position: new THREE.Vector3(0, 1.3, -15) },
  };
  const elite = {
    behavior: 'shield', alive: true, _frozen: false,
    hp: 100, maxHp: 1000, isElite: true,
    mesh: { position: new THREE.Vector3(0, 1.3, -10) },
  };
  let casts = 0;
  const mgr = {
    list: [healer, elite], _playerPos: new THREE.Vector3(0, 1.6, 0),
    onHealCast() { casts++; return 1000; },
  };
  BalloonManager.prototype._applyHealAura.call(mgr, 10);
  assert.equal(casts, 0, '被吸期间不施法');
  healer._bhCaptured = false;
  BalloonManager.prototype._applyHealAura.call(mgr, 10);
  assert.equal(casts, 1, '放开后恢复治疗');
});

test('被吸的怪不显示「爆」字（也不再触发内圈滴滴）', () => {
  const b = mkBalloon();
  assert.equal(isBombMarkTarget(b), true);
  b._bhCaptured = true;
  assert.equal(isBombMarkTarget(b), false);
});

test('被吸的怪不结算 4×8 自爆（过顶弧线会掠过飞毯，不能伤玩家）', () => {
  const g = Object.create(Game.prototype);
  const b = mkBalloon({ x: 0, z: 0 });
  b._bhCaptured = true;
  Object.assign(g, {
    balloons: { list: [b], remove() { throw new Error('不该移除'); } },
    player: { takeDamage() { throw new Error('不该伤玩家'); } },
    audio: null, fx: null,
    _spawnExplosionFx() {},
  });
  assert.equal(g._checkExplosions(), false);
  assert.equal(g.balloons.list.length, 1);
});

test('技能接线：卡池卖的是黑洞（不再卖散射强化），冷却 12s', () => {
  assert.ok(SKILL_CARDS.find((c) => c.id === 'blackhole'), '技能表里有黑洞');
  assert.ok(!SKILL_CARDS.find((c) => c.id === 'scatterburst'), '散射强化已下线');
  const g = { selectedSkill: 'blackhole', player: { skillCdDown: 0 } };
  assert.equal(Game.prototype._skillCdTotal.call(g), BLACK_HOLE.COOLDOWN);
  g.player.skillCdDown = 2;
  assert.equal(Game.prototype._skillCdTotal.call(g), BLACK_HOLE.COOLDOWN - 2);
});

test('装备黑洞：selectedSkill 切换、冷却清零、左手剑收起', () => {
  let equipped = true;
  const g = {
    selectedSkill: 'scatter', skillCooldown: 7, player: {},
    leftSword: { setEquipped(v) { equipped = v; } },
    log() {},
  };
  Game.prototype._applySkillCard.call(g, 'blackhole');
  assert.equal(g.selectedSkill, 'blackhole');
  assert.equal(g.skillCooldown, 0);
  assert.equal(equipped, false);
});
