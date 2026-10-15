// 第五十一修 · 三条「看不见的接线 bug」+ 远程三兄弟的数值口径
//
// 现场四条问题里有三条的根因都不在表现层，而在**字段/接线**，只能用单测锁住：
//   ① 激光阶段打不中 Boss —— 第18关的命中代理借用了 'basic' 类型，而 basic 有 GLB 模型且在
//      DEPTH_SPRITE_TYPES 白名单里 ⇒ 模型异步到位时 balloonModels 把 hitRadius 改写成
//      「按立绘取景留边折算」的值、game._collide 还改走 0.8m 厚的薄板判定 ⇒ 30m 外的 Boss
//      只剩一个约 1.7m 的薄片。修法 = 换一个「无模型 + 不在白名单」的专用代理类型；
//   ② 治疗术士的加号飞到了、精英血条却不涨 —— hp 是裸字段，血条**只在 takeDamage 里刷过**，
//      回血路径改完 hp 没刷血条 ⇒ 看起来就是「根本没回血」；
//   ③ 远程三兄弟（忍者/幽灵/章鱼）的血量/体型口径 —— Boss 关 DPS×10、普通关 DPS×2 且体型 2 倍。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { ENEMY_TYPES } from '../src/content/enemies.js';
import { ELITE_BASE_HP, RANGED_DPS_HP } from '../src/content/eliteMonsters.js';
import { MAGICIAN_BOSS, DEPTH_SPRITE_TYPES, SHURIKEN, ELITE_TUNING } from '../src/core/constants.js';
import { WaveManager } from '../src/game/waves.js';
import { eliteTravelSpeed } from '../src/content/spawnDirector.js';
import { Balloon, BalloonManager } from '../src/game/balloons.js';

// ---------- ① Boss 命中代理 ----------

test('第五十一修 · Boss 命中代理：必须「无模型 + 不在立绘白名单」（否则 hitRadius 会被改写）', () => {
  const t = ENEMY_TYPES.bossProxy;
  assert.ok(t, 'enemies.js 里必须有 bossProxy 类型');
  assert.equal(!!t.model, false, '不能有 GLB 模型：异步挂模型那条路径会重写 hitRadius');
  assert.equal(DEPTH_SPRITE_TYPES.includes('bossProxy'), false, '不能进立绘白名单：白名单会改走薄板判定');
  assert.equal(DEPTH_SPRITE_TYPES.includes('basic'), true, '对照组：basic 在白名单里（所以当初借它当代理才会打不中）');
  assert.equal(t.selfDamage, 0, '代理不该伤玩家');
  assert.equal(t.noHealthBar, true, 'Boss 用自己的 3D 血条');
  assert.equal(t.noPlaceholder, true, '不要占位胶囊/名牌');
});

test('第五十一修 · bossMagician 用的就是新代理类型（别再退回 basic）', () => {
  const s = fs.readFileSync(new URL('../src/game/bossMagician.js', import.meta.url), 'utf8');
  assert.ok(s.includes("this.spawn('bossProxy'"), '代理必须用 bossProxy 生成');
  assert.equal(/this\.spawn\('basic'/.test(s), false, '不能再拿 basic 当代理');
});

// ---------- ② 回血必须刷血条 ----------

test('第五十一修 · 扣血/回血走同一条刷血条路径（refreshHealthBar）', () => {
  const b = new Balloon('eliteKnight', {});
  assert.equal(typeof b.refreshHealthBar, 'function');
  assert.ok(b._hpBar, '非基础怪都有血条');
  const full = (b.refreshHealthBar(), b._hpFg.scale.x);
  assert.equal(full, 1, '满血时血条是满的');
  b.takeDamage(b.maxHp * 0.5);
  assert.ok(b._hpFg.scale.x < full, '扣血后血条变短');
  b.hp = b.maxHp;
  b.refreshHealthBar();
  assert.equal(b._hpFg.scale.x, 1, '回满后血条要能涨回去（旧实现只能跌不能涨）');
});

function fake(behavior, pos, hp, maxHp, isElite) {
  const f = {
    behavior, alive: true, hp, maxHp, type: {}, _frozen: false, isElite,
    mesh: { position: new THREE.Vector3(pos[0], pos[1], pos[2]) },
    refreshFlashes: 0,
  };
  f.flashHeal = () => { f.refreshFlashes++; };
  return f;
}

test('第五十一修 · 治疗脉冲改完 hp 必须刷血条（现场「加号飞到了、血条没涨」的根因）', () => {
  const healer = fake('heal', [0, 0, -24], 1000, 1000, true);
  const target = fake('eliteKnight', [0, 0, -6], 100, 5000, true);
  let refreshed = 0;
  target.refreshHealthBar = () => { refreshed++; };
  const mgr = {
    list: [healer, target],
    _playerPos: new THREE.Vector3(0, 1.6, 0),
    onHealCast: () => 1000,
  };
  BalloonManager.prototype._applyHealAura.call(mgr, 0.016);
  assert.equal(target.hp, 1100, '血量要涨');
  assert.equal(refreshed, 1, '★ hp 变了就必须刷血条（否则玩家看到的是「没回血」）');
});

// ---------- ③ 远程三兄弟：血量 / 体型 / 不近身 ----------

function wavesFor(bossLevel, dps) {
  const w = Object.create(WaveManager.prototype);
  w.level = bossLevel ? { n: 18, kind: 'boss', boss: 'magician' } : { n: 7, kind: 'normal' };
  w.hooks = { playerDps: () => dps };
  return w;
}

test('第五十一修 · 远程三兄弟（Boss 关）：血量 = 默认 + DPS×10，体型保持敌种自带', () => {
  const w = wavesFor(true, 1000);
  const o = w.rangedHpOpts('octopus');
  assert.equal(o.hp, ELITE_BASE_HP.octopus + 1000 * RANGED_DPS_HP.BOSS_SEC);
  assert.equal(o.sizeMul, undefined, 'Boss 关不覆盖体型 → 退回敌种自带 scale');
  assert.equal(o.isElite, true);
  assert.equal(RANGED_DPS_HP.BOSS_SEC, 10);
});

test('第五十一修 · 远程三兄弟（普通关）：血量 = 默认 + DPS×2，体型放大两倍', () => {
  const w = wavesFor(false, 1000);
  const o = w.rangedHpOpts('ninja');
  assert.equal(o.hp, ELITE_BASE_HP.ninja + 1000 * RANGED_DPS_HP.NORMAL_SEC);
  assert.equal(o.sizeMul, RANGED_DPS_HP.NORMAL_SIZE_MUL);
  assert.equal(RANGED_DPS_HP.NORMAL_SIZE_MUL, 2);
  assert.equal(RANGED_DPS_HP.NORMAL_SEC, 2);
});

test('第五十一修 · 非远程型 / 关掉开关 → 返回 null（调用方原样走老口径）', () => {
  const w = wavesFor(false, 1000);
  assert.equal(w.rangedHpOpts('eliteKnight'), null);
  assert.equal(w.rangedHpOpts('shield'), null);
  assert.equal(w.rangedHpOpts('bossProxy'), null);
  assert.equal(w.rangedHpOpts(undefined), null);
});

test('第五十一修 · _eliteOpts 普通精英：远程三兄弟吃新口径，其余仍是固定血量 + 1 倍体型', () => {
  const w = wavesFor(false, 500);
  const g = w._eliteOpts('ghost', [], false);
  assert.equal(g.hp, ELITE_BASE_HP.ghost + 500 * RANGED_DPS_HP.NORMAL_SEC);
  assert.equal(g.sizeMul, RANGED_DPS_HP.NORMAL_SIZE_MUL);
  assert.equal(g.climax, false);
  const k = w._eliteOpts('eliteKnight', [], false);
  assert.equal(k.hp, ELITE_BASE_HP.eliteKnight, '普通精英不该被 DPS 血量化（第四十七修踩过的坑）');
  assert.equal(k.sizeMul, 1);
});

test('第五十一修 · 末尾精英（climax）口径不受影响：仍是「放大 + 定速」的那一套', () => {
  const w = wavesFor(false, 500);
  const c = w._eliteOpts('octopus', [{ type: 'octopus', count: 1 }], true);
  assert.equal(c.climax, true);
  assert.equal(c.sizeMul, ELITE_TUNING.SIZE_MUL, '末尾精英的体型是 ELITE_TUNING.SIZE_MUL');
  assert.ok(c.hp > 0, '血量 > 0');
  assert.equal(c.speed, eliteTravelSpeed(ELITE_TUNING), '末尾精英是定速的（climax 专属：24m 外 10 秒走 2/3）');
});

test('第五十一修 · 章鱼不再近身：和忍者一样被夹在 10~15m 环带内', () => {
  const b = new Balloon('octopus', {});
  b.manager = { scene: new THREE.Scene() };   // 蓄力光球要往场景里挂
  const player = new THREE.Vector3(0.5, 1.6, -1.0);
  b.mesh.position.set(0.5, 1.6, -1.0);        // 贴到玩家脸上（旧行为的极端情况）
  for (let i = 0; i < 3; i++) b.update(0.016, player, null);
  const d = Math.hypot(b.mesh.position.x, b.mesh.position.z);
  assert.ok(d >= SHURIKEN.RANGE_MIN - 1e-6, '必须被推回环带内界之外，实际 ' + d.toFixed(2) + 'm');
  assert.ok(d <= SHURIKEN.RANGE_MAX + 1e-6, '也不能被推到环带外边界之外，实际 ' + d.toFixed(2) + 'm');
});
test('第五十一修 · Boss 关召唤的远程精英真的吃到 DPS×10 血量（守卫写错会静默失效）', async () => {
  const { MagicianBoss } = await import('../src/game/bossMagician.js');
  const dps = 1000;
  let rangedSeen = 0;
  for (const phase of Object.keys(MAGICIAN_BOSS.POOL.ELITE_BY_PHASE)) {
    const b = Object.create(MagicianBoss.prototype);
    b.phase = phase;
    b.waves = wavesFor(true, dps);
    b._minions = { push() {} };
    b._pendingRefill = 0;
    b._pendingElite = 0;
    const seen = [];
    b.spawn = (type, pos, opts) => { seen.push({ type, opts }); };
    b._spawnMinion(true);
    assert.equal(seen.length, 1, phase + ' 阶段要召唤出一只精英');
    const { type, opts } = seen[0];
    assert.equal(type, MAGICIAN_BOSS.POOL.ELITE_BY_PHASE[phase], phase + ' 阶段换的是这一种');
    const expect = b.waves.rangedHpOpts(type);
    if (!expect) { assert.equal(opts.balloon, null, phase + ' 非远程种不带 balloon'); continue; }
    rangedSeen++;
    assert.ok(opts.balloon,
      '★ ' + phase + ' 阶段的 ' + type + ' 要带上 balloon 构造参数'
      + '（守卫误写成 this.waves.rangedHp 时这里恒为 null，血量口径静默失效）');
    assert.equal(opts.balloon.hp, ELITE_BASE_HP[type] + dps * RANGED_DPS_HP.BOSS_SEC);
    assert.equal(opts.balloon.isElite, true);
    assert.equal(opts.balloon.sizeMul, undefined, 'Boss 关不放大体型');
  }
  assert.ok(rangedSeen >= 2, '三个阶段里至少两个是远程种，否则这条测试是空转');
});