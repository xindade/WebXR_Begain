// 第九十一修 · 瘟疫医生：初始属性 / 攻击卡减半 / 毒素叠层 / 感染 / 商店道具
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CHARACTERS, CHARACTER_ORDER } from '../src/core/constants.js';
import { Player } from '../src/game/player.js';
import { ATTR_TYPES, attributePreview } from '../src/content/cards.js';
import { plagueMaxStacks, poisonTickDamage, infectionStacks, plagueBurstLayers, plagueBurstTargets } from '../src/game/characters/rules.js';
import { tutorialCardFor, tutorialSeedBanner, TUTORIAL } from '../src/content/tutorial.js';
import { SHOP_ITEMS, pickShopItems } from '../src/content/shopItems.js';

const originalLoad = THREE.TextureLoader.prototype.load;
let Game;
try {
  THREE.TextureLoader.prototype.load = () => new THREE.Texture();
  ({ Game } = await import('../src/game/game.js'));
} finally {
  THREE.TextureLoader.prototype.load = originalLoad;
}

const pos = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const poisonTarget = (x = 0, stacks = 0, hp = 10000) => ({
  alive: true,
  type: {},
  behavior: 'basic',
  mesh: { position: pos(x) },
  _poisonStacks: stacks,
  hp,
  takeDamage(dmg) {
    this.hp -= dmg;
    this._lastDamage = dmg;
    if (this.hp <= 0) { this.alive = false; return true; }
    return false;
  },
});

test('瘟疫医生：初始攻击 50、射速 2、攻速加成减半且排在选择页第四位', () => {
  const p = new Player(new THREE.Scene(), new THREE.Group());
  p.reset('preview', 'plague');
  assert.equal(p.atk, 50);
  assert.equal(p.fireRate, 2);
  assert.equal(p.fireMode, 'fan');
  assert.equal(p.characterKey, 'plague');
  assert.equal(p.atkGainMul, 0.5);
  assert.equal(CHARACTERS.plague.name, '瘟疫医生');
  assert.deepEqual(CHARACTER_ORDER, ['rapid', 'swarm', 'bombard', 'plague']);
});

test('攻击力选项卡：瘟疫医生 +100 卡面实际只加 50，其它角色仍加 100', () => {
  const atkCard = ATTR_TYPES.find((c) => c.id === 'atk');
  const p = new Player(new THREE.Scene(), new THREE.Group());

  p.reset('preview', 'plague');
  assert.equal(attributePreview(atkCard, p), '50 → 100');
  atkCard.apply(p);
  assert.equal(p.atk, 100);

  p.reset('preview', 'swarm');
  assert.equal(attributePreview(atkCard, p), '100 → 200');
  atkCard.apply(p);
  assert.equal(p.atk, 200);
});

test('毒素数值：每层 = 攻击力 ×25%，默认 5 层，加大剂量 Lv.1=8 / Lv.2=10 / Lv.3=12', () => {
  assert.equal(poisonTickDamage(50, 1), 12.5);
  assert.equal(poisonTickDamage(50, 5), 62.5);
  assert.equal(plagueMaxStacks(0), 5);
  assert.equal(plagueMaxStacks(1), 8);
  assert.equal(plagueMaxStacks(2), 10);
  assert.equal(plagueMaxStacks(3), 12, '之后每级继续 +2，不再封在 8 层');
});

test('感染层数：3 层起按 70% 向下取整；2 层弱传 1 层；1 层不传', () => {
  assert.equal(plagueBurstLayers(1), 0);
  assert.equal(plagueBurstLayers(2), 1);
  assert.equal(plagueBurstLayers(5), 3);
  assert.equal(plagueBurstLayers(8), 5);
  assert.equal(plagueBurstLayers(10), 7);
  assert.equal(infectionStacks(5, 0, 5), 3);
  assert.equal(infectionStacks(8, 0, 10), 5);
  assert.equal(infectionStacks(4, 4, 5), 1, '目标只剩 1 层空间就只传 1 层');
  assert.equal(infectionStacks(4, 5, 5), 0, '目标满层不转移');
  assert.equal(infectionStacks(2, 0, 5), 1, '2 层弱传 1 层');
  assert.equal(infectionStacks(1, 0, 5), 0, '单层不传播');
});

test('疫爆范围：只取 5 米内最近的 6 只，半径外不参与', () => {
  const from = pos(0);
  const cands = [];
  for (let i = 0; i < 8; i++) cands.push(poisonTarget(1 + i * 0.5));
  const outside = poisonTarget(6.1);
  const picked = plagueBurstTargets([...cands, outside], from, 5, 6);
  assert.equal(picked.length, 6);
  assert.ok(!picked.includes(outside));
  assert.deepEqual(picked, cands.slice(0, 6));

  const raised = poisonTarget(4.9);
  raised.mesh.position.y = 20;
  assert.deepEqual(plagueBurstTargets([raised], from, 5, 6), [raised],
    '判定与地面圆环一致：水平 5 米内，忽略高度差');
});

test('子弹命中叠毒：瘟疫医生 5 层封顶；加大剂量 Lv.2 可到 10 层；其它角色 / 龙部件不叠', () => {
  const g = Object.create(Game.prototype);
  g.player = { characterKey: 'plague', atk: 50 };
  g._itemLv = {};
  const b = poisonTarget();
  for (let i = 0; i < 9; i++) g._applyPoisonStack(b);
  assert.equal(b._poisonStacks, 5);

  g._itemLv.dosage = 2;
  for (let i = 0; i < 9; i++) g._applyPoisonStack(b);
  assert.equal(b._poisonStacks, 10);

  g.player.characterKey = 'rapid';
  const other = poisonTarget();
  assert.equal(g._applyPoisonStack(other), false);
  assert.equal(other._poisonStacks, 0);

  g.player.characterKey = 'plague';
  const dragonPart = { ...poisonTarget(), isDragonPart: true };
  assert.equal(g._applyPoisonStack(dragonPart), false);
  assert.equal(dragonPart._poisonStacks, 0);
});

test('致命枪不叠毒：只剩 1 层的小怪被最后一枪打死时，层数仍为 1，感染不转移', () => {
  const oneShot = (stacks, hp, dmg) => {
    const g = Object.create(Game.prototype);
    g.player = { characterKey: 'plague', atk: 50, hp: 100, maxHp: 100 };
    g._itemLv = {};
    const target = poisonTarget(0, stacks, hp);
    target.hitRadius = 1;
    target.uid = 1;
    const bullet = {
      pos: pos(0, 0, -0.05), prevPos: pos(0, 0, 0.05), dmg,
      blastRadius: 0, pierce: 0, uid: 'bullet',
    };
    g.bullets = {
      active: [bullet],
      release() { this.active.length = 0; },
      sync() {},
    };
    g.world = { camera: { getWorldPosition(v) { return v.set(0, 1.4, 0); } } };
    g.waves = { magicianGlassWall: null };
    g.balloons = { list: [target], remove() {} };
    g._camPos = pos();
    g._tmp2 = pos();
    g._fxPos = pos();
    g._playerPos = () => pos(0, 1.4, 0);
    g._damageFeedback = () => {};
    g._onKilled = () => {};
    g._bulletKill = () => {};
    g._shopBulletKill = () => {};
    g._collide();
    return target;
  };

  const killed = oneShot(1, 10, 100);
  assert.equal(killed.alive, false);
  assert.equal(killed._poisonStacks, 1, '致命枪不能再补 1 层变成 2 层');
  assert.equal(infectionStacks(killed._poisonStacks, 0, 5), 0, '1 层死亡不传染');

  const survived = oneShot(1, 100, 10);
  assert.equal(survived.alive, true);
  assert.equal(survived._poisonStacks, 2, '未击杀的命中照常叠 1 层');

  const twoStacksKilled = oneShot(2, 10, 100);
  assert.equal(twoStacksKilled._poisonStacks, 2, '致命枪不改变死亡时的既有多层毒');
});

test('毒素每秒结算一次：2 层 / 攻击 100 → 每跳 50；毒死也走 _onKilled', () => {
  const g = Object.create(Game.prototype);
  g.player = { characterKey: 'plague', atk: 100 };
  g._itemLv = {};
  const b = poisonTarget(0, 2, 100);
  g.balloons = { list: [b] };

  const kills = [];
  let feedback = 0;
  g._damageFeedback = (_b, killed, _p, opts) => {
    assert.equal(opts?.poison, true);
    assert.equal(opts?.silent, true);
    feedback++;
  };
  g._onKilled = (t) => kills.push(t);

  g._tickPoison(0.5);
  assert.equal(b.hp, 100, '不足 1 秒不结算');
  g._tickPoison(0.5);
  assert.equal(b.hp, 50, '2 层 × 100 × 25% = 50');
  assert.equal(feedback, 1);
  assert.equal(kills.length, 0);

  g._tickPoison(1);
  assert.equal(b.alive, false);
  assert.equal(kills[0], b);
});

test('感染：5 层死亡向 5 米内 6 只各传 3 层；精英吃满并可继续向外传播', () => {
  const g = Object.create(Game.prototype);
  g.player = { characterKey: 'plague', atk: 50 };
  g._itemLv = {};
  g._plagueInfect = true;
  const dead = poisonTarget(0, 5, 0);
  const targets = Array.from({ length: 6 }, (_, i) => poisonTarget(1 + i * 0.6, 0));
  targets[5].isElite = true;
  const far = poisonTarget(9, 0);
  g.balloons = { list: [dead, ...targets, far] };

  assert.equal(g._spreadPlague(dead), 18);
  assert.equal(dead._poisonStacks, 5, '尸体自身层数不被清空（随后会被移除）');
  for (const t of targets) assert.equal(t._poisonStacks, 3, '精英与普通怪同样吃满 3 层');
  assert.equal(far._poisonStacks, 0);

  // 精英死亡后继续传播：3 层 ×70% → 2 层
  const next = poisonTarget(2, 0);
  const eliteDead = targets[5];
  eliteDead.alive = false;
  g._gameTime = 0.5;
  g._plagueBurstTimes.length = 0;
  g.balloons = { list: [eliteDead, next] };
  assert.equal(g._spreadPlague(eliteDead), 2);
  assert.equal(next._poisonStacks, 2, '精英不截断连锁');

  const g2 = Object.create(Game.prototype);
  Object.assign(g2, g, { _plagueInfect: false });
  const dead2 = poisonTarget(0, 5, 0);
  const target2 = poisonTarget(2, 0);
  g2.balloons = { list: [dead2, target2] };
  assert.equal(g2._spreadPlague(dead2), 0);
  assert.equal(target2._poisonStacks, 0);
});

test('感染：2 层只弱传最近 1 只 1 层；1 层不传播；Boss 不接收', () => {
  const g = Object.create(Game.prototype);
  g.player = { characterKey: 'plague', atk: 50 };
  g._itemLv = {};
  g._plagueInfect = true;
  g._gameTime = 1;
  g._plagueBurstTimes = [];
  const dead = poisonTarget(0, 2, 0);
  const near = poisonTarget(1, 0);
  const second = poisonTarget(2, 0);
  g.balloons = { list: [dead, near, second] };
  assert.equal(g._spreadPlague(dead), 1);
  assert.equal(near._poisonStacks, 1);
  assert.equal(second._poisonStacks, 0, '2 层不扩散到第二只');

  const dead1 = poisonTarget(0, 1, 0);
  const target1 = poisonTarget(1, 0);
  g.balloons = { list: [dead1, target1] };
  assert.equal(g._spreadPlague(dead1), 0);
  assert.equal(target1._poisonStacks, 0);

  const dead5 = poisonTarget(0, 5, 0);
  const boss = poisonTarget(1, 0);
  boss.isBoss = true;
  g.balloons = { list: [dead5, boss] };
  assert.equal(g._spreadPlague(dead5), 0);
  assert.equal(boss._poisonStacks, 0, 'Boss 只吃单体毒伤，不参与疫爆');
});

test('感染连锁预算：1.5 秒窗口最多影响 18 只，超出后本窗口不再扩散', () => {
  const g = Object.create(Game.prototype);
  g.player = { characterKey: 'plague', atk: 50 };
  g._itemLv = {};
  g._plagueInfect = true;
  g._gameTime = 2;
  g._plagueBurstTimes = [];

  let total = 0;
  for (let round = 0; round < 4; round++) {
    const dead = poisonTarget(0, 5, 0);
    dead.alive = false;
    const targets = Array.from({ length: 6 }, (_, i) => poisonTarget(1 + i * 0.5, 0));
    g.balloons = { list: [dead, ...targets] };
    total += g._spreadPlague(dead);
  }
  assert.equal(total, 54, '前 3 组各感染 6 只 ×3 层');
  assert.equal(g._plagueBurstTimes.length, 18, '窗口内只记账 18 只');
  assert.ok(g.balloons.list.slice(1).every((t) => t._poisonStacks === 0), '第 4 组完全被预算拦下');
});

test('教学关：瘟疫医生首张卡为「感染」，完成后只解锁自己的传染被动', () => {
  const card = tutorialCardFor('plague');
  assert.equal(card.ID, 'plagueInfect');
  assert.equal(card.LABEL, '感染');
  assert.match(card.DESC, /扩散/);
  assert.equal(tutorialSeedBanner('plague'), TUTORIAL.BANNER.TEST);

  const g = Object.create(Game.prototype);
  g.player = { characterKey: 'plague', forceSingleShot: true };
  g._roleUnlocks = { satelliteTrack: false, bombardAirburst: false, plagueInfect: false };
  g._plagueInfect = false;
  g._satelliteAutoTrack = false;
  g._bombardAirburst = false;
  g.state = 'card';
  g.hud = { clearMessage() {} };
  g.tutorial = { onCardDone() { g._tutorialDone = true; } };
  g.log = () => {};
  g._onTutorialCardDone();
  assert.equal(g._plagueInfect, true);
  assert.equal(g._roleUnlocks.plagueInfect, true);
  assert.equal(g._roleUnlocks.satelliteTrack, false);
  assert.equal(g._roleUnlocks.bombardAirburst, false);
  assert.equal(g._satelliteAutoTrack, false);
  assert.equal(g._bombardAirburst, false);
  assert.equal(g._tutorialDone, true);
});

test('商店：加大剂量只给瘟疫医生，最高 2 级，满级后不再抽到', () => {
  const item = SHOP_ITEMS.find((i) => i.id === 'dosage');
  assert.ok(item);
  assert.deepEqual(item.roles, ['plague']);
  assert.equal(item.maxLevel, 2);
  assert.match(item.desc, /\+3/);

  const rapidPicks = pickShopItems(3, () => 0, 'rapid');
  assert.ok(!rapidPicks.includes('dosage'));
  const plaguePicks = pickShopItems(3, () => 0, 'plague', { dosage: 2 });
  assert.ok(!plaguePicks.includes('dosage'));
});
