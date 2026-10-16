// 第五十五修 · 商店关（第 3/9/15 关，替代原激光机制关）
//
// 锁三件事：
//   ① 关卡表与参数口径（kind=shop / 60s / 1000 / 1500 / 200）；
//   ② 纯函数（抽签不重复、补位、价格按等级、道具数值换算）；
//   ③ ShopDraft 购买状态机（买不起不消费、买走补位、刷新翻倍、限购、倒计时自动结束）。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LEVELS, isShop, isLaser } from '../src/content/levels.js';
import { SHOP, CARD, MOVE } from '../src/core/constants.js';
import {
  SHOP_ITEMS, SKILL_UPGRADES, shopItemPrice, warFeedMul, lifestealChance,
  strongHunterMul, mibCooldown, pickShopItems, pickShopItemExcluding,
} from '../src/content/shopItems.js';
import { ShopDraft, columnZ } from '../src/game/shop.js';
import { makeBadge } from '../src/game/cardDraft.js';

const originalLoad = THREE.TextureLoader.prototype.load;
let Game;
try {
  THREE.TextureLoader.prototype.load = () => new THREE.Texture();
  ({ Game } = await import('../src/game/game.js'));
} finally { THREE.TextureLoader.prototype.load = originalLoad; }

const ORIGIN = () => new THREE.Vector3(0, 1.6, 0);

// ---------- ① 关卡表 / 参数 ----------

test('第 3/9/15 关是商店关：kind=shop、名字仍是「魔术空间」、不再有 laserMode', () => {
  for (const n of [3, 9, 15]) {
    const lv = LEVELS.find((l) => l.n === n);
    assert.ok(isShop(lv), `第 ${n} 关应为商店关`);
    assert.ok(!isLaser(lv), `第 ${n} 关不该再是激光机制关`);
    assert.equal(lv.name, '魔术空间');
    assert.equal(lv.laserMode, undefined, '商店关不再有 laserMode（第9关飞毯恢复可见）');
  }
  assert.equal(LEVELS.filter((l) => isShop(l)).length, 3);
});

test('商店关参数：60 秒倒计时 / 技能 1000 / 强化 1500 / 道具 1000×等级 / 刷新 200 起', () => {
  assert.equal(SHOP.ENABLED, true);
  assert.equal(SHOP.COUNTDOWN, 100, '第六十三修：现场「60 秒不够选择和看信息」→ 100 秒');
  assert.equal(SHOP.SKILL_PRICE, 1000);
  assert.equal(SHOP.UPGRADE_PRICE, 1500);
  assert.equal(SHOP.ITEM_BASE_PRICE, 1000);
  assert.equal(SHOP.REFRESH_BASE, 200);
  assert.equal(SHOP.LEVEL3_PRICE_MUL, 0.5, '第五十六修：第 3 关价格减半');
  assert.ok(SHOP.MIB_DURATION > 0 && SHOP.MIB_COOLDOWN >= SHOP.MIB_DURATION);
});

test('技能强化表：威力+ / 消耗- / 冷却- 三项，文案与 SHOP 参数同源', () => {
  assert.deepEqual(SKILL_UPGRADES.map((u) => u.id), ['skillDamageUp', 'skillCostDown', 'skillCdDown']);
  for (const u of SKILL_UPGRADES) {
    assert.ok(u.label && u.desc && u.icon && u.color, `${u.id} 缺卡面字段`);
    assert.ok(u.label.length <= 6, '卡面标题别太长（画布只有 256px 宽）');
  }
  assert.ok(SKILL_UPGRADES.find((u) => u.id === 'skillCdDown').desc.includes(String(SHOP.CD_DOWN)));
});

test('道具表：六种、id 唯一、卡面字段齐全、desc 够短（三行内画得下）', () => {
  assert.equal(SHOP_ITEMS.length, 6);
  assert.equal(new Set(SHOP_ITEMS.map((i) => i.id)).size, 6);
  for (const it of SHOP_ITEMS) {
    assert.ok(it.label && it.desc && it.icon && it.color, `${it.id} 缺卡面字段`);
    assert.ok([...it.desc].length <= 10, `${it.id} 的 desc 太长（卡面最多 3 行）`);
  }
  assert.deepEqual(SHOP_ITEMS.map((i) => i.id),
    ['dogOwner', 'warFeed', 'candyString', 'moreIsBetter', 'lifesteal', 'strongHunter']);
});

// ---------- ② 纯函数 ----------

test('道具抽签：6 选 3 不重复；补位不落在已展示的三个里', () => {
  const seen = new Set();
  for (let i = 0; i < 80; i++) {
    const picks = pickShopItems(3);
    assert.equal(picks.length, 3);
    assert.equal(new Set(picks).size, 3, '不能重复');
    picks.forEach((id) => { seen.add(id); assert.ok(SHOP_ITEMS.some((x) => x.id === id)); });
    const next = pickShopItemExcluding(picks);
    assert.ok(next, '还有三个没上架 ⇒ 必须补得出');
    assert.ok(!picks.includes(next), '补位不能与当前展示重复');
  }
  assert.equal(seen.size, 6, '抽多了应把六种都抽到过');
  assert.deepEqual(pickShopItems(3, () => 0).length, 3);
});

test('道具费用 = ITEM_BASE_PRICE × 目标等级（0 级 → 1000，1 级 → 2000）', () => {
  assert.equal(shopItemPrice('lifesteal', {}), 1000);
  assert.equal(shopItemPrice('lifesteal', { lifesteal: 1 }), 2000);
  assert.equal(shopItemPrice('lifesteal', { lifesteal: 4 }), 5000);
  assert.equal(shopItemPrice('lifesteal', null), 1000);
});

test('道具数值换算：以战养战 +10%/级、吸血 10%/级、专打强者 +0.2/级、多才是王道冷却有下限', () => {
  assert.equal(warFeedMul(0), 1);
  assert.ok(Math.abs(warFeedMul(3) - 1.3) < 1e-9);
  assert.ok(Math.abs(lifestealChance(2) - 0.2) < 1e-9);
  assert.ok(Math.abs(strongHunterMul(1) - 1.2) < 1e-9);
  assert.ok(Math.abs(strongHunterMul(3) - 1.6) < 1e-9);
  assert.equal(mibCooldown(1), SHOP.MIB_COOLDOWN);
  assert.equal(mibCooldown(3), SHOP.MIB_COOLDOWN - 2);
  assert.equal(mibCooldown(99), SHOP.MIB_DURATION, '冷却下限 = 持续时间（可不间断）');
});

// ---------- ③ ShopDraft 状态机 ----------

function makeShop(coin = 0, hasSkill = false, itemLv = {}, priceMul = 1) {
  const calls = { skill: [], upgrade: [], item: [], denied: [] };
  // 生产同口径：game._applySkillCard 会把 selectedSkill 写成刚买的技能，于是 hasSkill() 变 true
  const flags = { skill: hasSkill };
  const state = {
    coin,
    getShopCoin() { return this.coin; },
    spendShopCoin(c) { this.coin -= c; },
    hasSkill: () => flags.skill,
    getItemLevels: () => itemLv,
    priceMul: () => priceMul,   // 第五十六修：第 3 关传 SHOP.LEVEL3_PRICE_MUL
    onBuySkill: (id) => { calls.skill.push(id); flags.skill = true; },
    onBuyUpgrade: (id) => calls.upgrade.push(id),
    onBuyItem: (id) => { calls.item.push(id); itemLv[id] = (itemLv[id] || 0) + 1; },
    onDenied: (m) => calls.denied.push(m),
    shopLevel: 3,   // 第五十八修：预告卡要看「本店是第几关」（第 3 关 = 4-8 关的预告）
  };
  const shop = new ShopDraft(new THREE.Scene());
  shop.open(ORIGIN(), state);
  return { shop, state, calls, itemLv, flags };
}

/** 朝某个气球打一发（用气球世界坐标造子弹），返回被命中的 entry */
function hitEntry(shop, pred) {
  const e = shop.entries.find(pred);
  assert.ok(e, '要打的气球不在架上');
  const p = e.holder.position.clone();
  p.y += e.balloonY;   // 第五十八修：气球高度已含整组缩放（道具列 2 倍）
  const bullets = {
    active: [{ pos: p, prevPos: p.clone(), dmg: 10 }],
    release() { this.active.length = 0; },
    sync() {},
  };
  shop.update(0.016, bullets, ORIGIN());
  return e;
}

/** 把购买结算动画走完 */
function resolve(shop, steps = 60) {
  for (let i = 0; i < steps && shop._resolve; i++) shop.update(0.1, null, ORIGIN());
  assert.equal(shop._resolve, null, '结算动画应已走完');
}

test('商店关 · 无技能时正前方是三个技能本体 + 购物完成；打中技能 → 装备并扣 1000，随后换成强化', () => {
  const { shop, state, calls } = makeShop(3000);
  assert.equal(shop.entries.filter((e) => e.kind === 'skill').length, 3);
  assert.equal(shop.entries.filter((e) => e.kind === 'done').length, 1);
  const e = hitEntry(shop, (x) => x.kind === 'skill');
  assert.equal(state.coin, 2000, '技能本体 1000');
  assert.deepEqual(calls.skill, [e.def.id]);
  resolve(shop);
  assert.equal(shop.entries.filter((x) => x.kind === 'upgrade').length, 3, '有技能后正前方换成强化');
  assert.equal(shop.entries.filter((x) => x.kind === 'skill').length, 0);
});

test('商店关 · 技能强化：每项 1500、每次进店每项限购 1 个，重进店可再买', () => {
  const { shop, state, calls } = makeShop(5000, true);
  assert.equal(shop.entries.filter((e) => e.kind === 'upgrade').length, 3);
  const first = hitEntry(shop, (e) => e.kind === 'upgrade');
  assert.equal(state.coin, 3500, '强化 1500');
  assert.deepEqual(calls.upgrade, [first.def.id]);
  resolve(shop);
  assert.equal(shop.entries.filter((e) => e.kind === 'upgrade').length, 2, '买过的不再上架');
  assert.ok(!shop.entries.some((e) => e.def && e.def.id === first.def.id));
  const st = shop._state;
  shop.open(ORIGIN(), st);
  assert.equal(shop.entries.filter((e) => e.kind === 'upgrade').length, 3, '重进店重置限购');
});

test('第五十六修 · 第 3 关价格减半：技能 500 / 强化 750 / 道具 500×等级（刷新价不变）', () => {
  const { shop, state } = makeShop(3000, false, {}, SHOP.LEVEL3_PRICE_MUL);
  assert.equal(shop.entries.find((e) => e.kind === 'skill').price, 500, '技能本体 1000 → 500');
  hitEntry(shop, (x) => x.kind === 'skill');
  assert.equal(state.coin, 2500, '只扣减半后的 500');
  resolve(shop);
  assert.equal(shop.entries.find((e) => e.kind === 'upgrade').price, 750, '技能强化 1500 → 750');
  // 第五十七修：本店第一个道具免费 —— 三个道具都先显示「首次免费」
  for (const it of shop.entries.filter((e) => e.kind === 'item')) {
    assert.equal(it.free, true, '免费名额还在时三个道具都应标免费');
    assert.equal(it.price, 0);
  }
  hitEntry(shop, (x) => x.kind === 'item');
  assert.equal(state.coin, 2500, '免费的那个道具不扣钱');
  resolve(shop);
  const after = shop.entries.find((e) => e.kind === 'item');
  assert.equal(after.free, false, '名额用掉后不再免费');
  assert.equal(after.price, 500, '之后按 500×等级 收费（第 3 关减半）');
  assert.equal(shop.entries.find((e) => e.kind === 'refresh').price, SHOP.REFRESH_BASE, '刷新价不参与折扣');
  // 未打折时价格必须回到原值（9/15 关）
  const full = makeShop(3000, false, {});
  assert.equal(full.shop.entries.find((e) => e.kind === 'skill').price, SHOP.SKILL_PRICE);
  const fullItem = full.shop.entries.find((e) => e.kind === 'item');
  assert.equal(fullItem.free, true, '9/15 关首个道具同样免费');
  assert.equal(fullItem.price, 0);
});

test('商店关 · 商店币不足：不扣钱、气球留在架上、给一次提示', () => {
  const { shop, state, calls } = makeShop(900);
  const e = hitEntry(shop, (x) => x.kind === 'skill');
  assert.equal(state.coin, 900, '买不起就不该扣');
  assert.equal(calls.skill.length, 0);
  assert.equal(calls.denied.length, 1);
  assert.equal(e.exploded, false);
  assert.ok(shop.entries.includes(e), '气球还留在架上');
});

test('商店关 · 道具：买走补一个（其余位置不重抽）、等级 +1、价格按目标等级', () => {
  const levels = {};
  const { shop, state, calls } = makeShop(10000, false, levels);
  const before = shop._itemDisplay.slice();
  const e = hitEntry(shop, (x) => x.kind === 'item');
  const slot = e.slot;
  const bought = e.def.id;
  assert.equal(state.coin, 10000, '第五十七修：本店第一个道具免费（不扣钱）');
  assert.deepEqual(calls.item, [bought]);
  assert.equal(levels[bought], 1);
  resolve(shop);
  const after = shop._itemDisplay.slice();
  assert.ok(!after.includes(bought), '同一时间不重复展示');
  for (let i = 0; i < 3; i++) if (i !== slot) assert.equal(after[i], before[i], '补位 ≠ 重抽全排');
  for (const x of shop.entries) {
    if (x.kind !== 'item') continue;
    assert.equal(x.price, shopItemPrice(x.def.id, levels), '价格必须按目标等级算');
  }
});

test('商店关 · 刷新：扣 200 重抽三个、价格逐次翻倍、重进店重置', () => {
  const { shop, state } = makeShop(10000);
  assert.equal(shop.refreshCost, SHOP.REFRESH_BASE);
  hitEntry(shop, (x) => x.kind === 'refresh');
  assert.equal(state.coin, 9800);
  assert.equal(shop.refreshCost, SHOP.REFRESH_BASE * 2);
  resolve(shop);
  assert.equal(shop.entries.find((x) => x.kind === 'refresh').price, SHOP.REFRESH_BASE * 2);
  const st = shop._state;
  shop.open(ORIGIN(), st);
  assert.equal(shop.refreshCost, SHOP.REFRESH_BASE, '进店重置');
});

test('商店关 · 60 秒到点自动结束；「购物完成」免费立即结束', () => {
  const a = makeShop(0);
  a.shop.update(SHOP.COUNTDOWN - 1, null, ORIGIN());
  assert.equal(a.shop.finished, false, '还差 1 秒不该结束');
  a.shop.update(1.2, null, ORIGIN());
  for (let i = 0; i < 60 && !a.shop.finished; i++) a.shop.update(0.1, null, ORIGIN());
  assert.equal(a.shop.finished, true, '倒计时到点 → 自动进下一关');

  const b = makeShop(0);
  hitEntry(b.shop, (x) => x.kind === 'done');
  for (let i = 0; i < 60 && !b.shop.finished; i++) b.shop.update(0.1, null, ORIGIN());
  assert.equal(b.shop.finished, true);
  assert.equal(b.state.coin, 0, '购物完成免费');
});

test('商店关 · 结束/清场后入口不可再打（finished 幂等、group 隐藏）', () => {
  const { shop } = makeShop(0);
  shop._finish();
  shop._finish();
  assert.equal(shop.finished, true);
  assert.equal(shop.group.visible, false);
  assert.equal(shop.entries.length, 0);
  const before = shop.timer;
  shop.update(1, null, ORIGIN());
  assert.equal(shop.timer, before, '结束后不再推进倒计时');
  shop.dispose();
});

// ---------- ④ Game 侧（第五十五修）道具数值/钩子 ----------

test('商店币入账：击杀能量等额；「以战养战」按等级加成', () => {
  const g = Object.create(Game.prototype);
  g.shopCoin = 0; g._itemLv = {}; g.hud = { last: -1, setShopCoin(v) { this.last = v; } };
  Game.prototype._addShopCoin.call(g, 30);
  assert.equal(g.shopCoin, 30);
  assert.equal(g.hud.last, 30, 'HUD 同步');
  g._itemLv.warFeed = 2;                     // +20%
  Game.prototype._addShopCoin.call(g, 50);
  assert.equal(g.shopCoin, 30 + 60);
  Game.prototype._addShopCoin.call(g, 0);
  assert.equal(g.shopCoin, 90, '0 分不进账也不报错');
});

test('专打强者：只对精英 / Boss 生效，倍率 = 1 + 0.2×等级', () => {
  const g = Object.create(Game.prototype);
  const basic = { isElite: false, isBoss: false };
  const elite = { isElite: true, isBoss: false };
  const boss = { isElite: false, isBoss: true };
  g._itemLv = {};
  assert.equal(Game.prototype._applyShopDamage.call(g, elite, 100), 100, '没买就是原伤害');
  g._itemLv = { strongHunter: 2 };
  assert.equal(Game.prototype._applyShopDamage.call(g, basic, 100), 100);
  assert.ok(Math.abs(Game.prototype._applyShopDamage.call(g, elite, 100) - 140) < 1e-9);
  assert.ok(Math.abs(Game.prototype._applyShopDamage.call(g, boss, 100) - 140) < 1e-9);
  assert.equal(Game.prototype._applyShopDamage.call(g, null, 100), 100);
});

test('技能冷却-：总冷却随 player.skillCdDown 下降，但不低于 SHOP.CD_FLOOR', () => {
  const g = Object.create(Game.prototype);
  g.selectedSkill = 'lightsaber';
  g.player = { skillCdDown: 0 };
  const base = Game.prototype._skillCdTotal.call(g);
  g.player.skillCdDown = SHOP.CD_DOWN;
  assert.equal(Game.prototype._skillCdTotal.call(g), base - SHOP.CD_DOWN);
  g.player.skillCdDown = 999;
  assert.equal(Game.prototype._skillCdTotal.call(g), SHOP.CD_FLOOR);
  g.selectedSkill = null;
  assert.equal(Game.prototype._skillCdTotal.call(g), 0, '没装备技能时仍是 0');
});

test('串糖葫芦：全局累计每 10 发追加 1 发穿甲弹（每级 +1 发）', () => {
  const g = Object.create(Game.prototype);
  g._itemLv = { candyString: 2 };
  g._candyCount = 0;
  g.player = { atk: 100, fire: () => 6 };
  g.input = { shots: [{ position: new THREE.Vector3(), direction: new THREE.Vector3(0, 0, -1) }] };
  g._chest = { addShots() {} };
  const spawned = [];
  g.bullets = { spawn(p, d, dmg, boost, opts) { spawned.push({ dmg, opts }); } };
  Game.prototype._firePlayerShots.call(g, false);
  assert.equal(spawned.length, 0, '6 发还不到 10');
  assert.equal(g._candyCount, 6, '计数要跨帧累计（不是每次射击清零）');
  Game.prototype._firePlayerShots.call(g, false);     // 累计 12 → 越过 10
  assert.equal(spawned.length, 2, 'Lv.2 ⇒ 越过一次补 2 发');
  assert.equal(spawned[0].opts.pierce, SHOP.CANDY_PIERCE);
  assert.equal(spawned[0].dmg, 100, '穿甲弹伤害 = 玩家攻击力');
  assert.equal(spawned[0].opts.tint, SHOP.CANDY_COLOR, '第五十六修：穿甲弹改亮红');
  assert.equal(spawned[0].opts.scale, SHOP.CANDY_SCALE, '第五十六修：弹体放大');
  assert.equal(spawned[0].opts.trailMul, SHOP.CANDY_TRAIL_MUL, '第五十六修：曳光加长');
  assert.equal(g._candyCount, 2);
});

test('打狗还要看主人：只找半径内最近的精英/Boss；场上没有就不生成（第五十六修：从枪口射出 + 夸张化）', () => {
  const g = Object.create(Game.prototype);
  g._itemLv = { dogOwner: 2 };
  g.player = { atk: 100 };
  g._tmp = new THREE.Vector3();
  const muzzle = new THREE.Vector3(1, 2, 3);
  // 第五十七修：枪口改问 input.getMuzzle()（不再是 input.shots —— 那个数组只有开火帧才有值）
  let gmCalled = 0;
  g.input = { getMuzzle(pos, dir) { gmCalled++; pos.copy(muzzle); dir.set(0, 0, -1); } };
  assert.ok(!('shots' in g.input), '桩里故意不放 shots：证明实现不再依赖它');
  const spawned = [];
  g.bullets = { spawn(p, d, dmg, boost, opts) { spawned.push({ p: p.clone(), dmg, opts }); } };
  const killed = { alive: true, mesh: { position: new THREE.Vector3(0, 0, 0) } };
  const near = { alive: true, isElite: true, mesh: { position: new THREE.Vector3(0, 0, -4) } };
  const farther = { alive: true, isElite: true, mesh: { position: new THREE.Vector3(0, 0, -4.5) } };
  const far = { alive: true, isElite: true, mesh: { position: new THREE.Vector3(0, 0, -30) } };
  const basic = { alive: true, isElite: false, mesh: { position: new THREE.Vector3(0, 0, -1) } };
  const dead = { alive: false, isElite: true, mesh: { position: new THREE.Vector3(0, 0, -1) } };
  g.balloons = { list: [basic, dead, killed, farther, near, far] };
  Game.prototype._spawnHomingBullets.call(g, killed, 2);
  assert.equal(spawned.length, 2, '每级 1 颗');
  assert.equal(spawned[0].dmg, 200, '伤害 = 攻击力 ×2');
  assert.equal(spawned[0].opts.homing, near, '选半径内最近的那只');
  assert.ok(spawned[0].p.equals(muzzle), '第五十七修：从枪口射出（getMuzzle，不是击杀点）');
  assert.equal(gmCalled, 1, '每批问一次枪口位姿');
  assert.equal(spawned[0].opts.tint, SHOP.DOG_COLOR);
  assert.equal(spawned[0].opts.scale, SHOP.DOG_SCALE, '第五十六修：弹体放大');
  assert.equal(spawned[0].opts.trailMul, SHOP.DOG_TRAIL_MUL, '第五十六修：曳光加长');
  spawned.length = 0;
  g.balloons.list = [basic, dead, far];
  Game.prototype._spawnHomingBullets.call(g, killed, 2);
  assert.equal(spawned.length, 0, '半径内没有精英 → 不生成');
  g.input = null;                       // 无输入源（单测 / 非 VR）→ 回退击杀点，不能崩
  g.balloons.list = [killed, near];
  Game.prototype._spawnHomingBullets.call(g, killed, 1);
  assert.equal(spawned.length, 1, '没有枪口信息也要照常生成');
  assert.equal(spawned[0].p.x, 0, '回退到击杀点');
  assert.equal(spawned[0].p.z, 0, '回退到击杀点');
});

test('吸血子弹：概率 = 10%×等级，回 1 点血（超过上限不加）', () => {
  const g = Object.create(Game.prototype);
  g._itemLv = { lifesteal: 1 };
  g.player = { hp: 50, maxHp: 100, atk: 100 };
  g.hud = { setHp() {} };
  g.balloons = { list: [] };
  g.bullets = { spawn() {} };
  g._tmp = new THREE.Vector3();
  const b = { alive: false, mesh: { position: new THREE.Vector3() } };
  const rnd = Math.random;
  try {
    Math.random = () => 0.05;         // < 10% ⇒ 回血
    Game.prototype._shopBulletKill.call(g, b);
    assert.equal(g.player.hp, 51);
    Math.random = () => 0.5;          // > 10% ⇒ 不回血
    Game.prototype._shopBulletKill.call(g, b);
    assert.equal(g.player.hp, 51);
    Math.random = () => 0;            // 满血时不该溢出
    g.player.hp = 100;
    Game.prototype._shopBulletKill.call(g, b);
    assert.equal(g.player.hp, 100);
  } finally { Math.random = rnd; }
});

test('多才是王道：买完立刻生效、冷却从买完开始算、到期收回临时弹道', () => {
  const g = Object.create(Game.prototype);
  g._itemLv = {};
  g._gameTime = 100;
  g._mibUntil = 0; g._mibNextAt = 0;
  g.player = { bonusShotCount: 0 };
  Game.prototype._tickShopItems.call(g);
  assert.equal(g.player.bonusShotCount, 0, '没买就没弹道');
  g._itemLv.moreIsBetter = 1;
  Game.prototype._buyShopItem.call(g, 'moreIsBetter');
  assert.equal(g._gameTime < g._mibUntil, true, '买完立刻生效');
  Game.prototype._tickShopItems.call(g);
  assert.equal(g.player.bonusShotCount, SHOP.MIB_SHOTS);
  g._gameTime += SHOP.MIB_DURATION + 0.01;
  Game.prototype._tickShopItems.call(g);
  assert.equal(g.player.bonusShotCount, 0, '到期收回');
  g._gameTime = g._mibNextAt + 0.01;      // 冷却到点 → 自动再触发
  Game.prototype._tickShopItems.call(g);
  assert.equal(g.player.bonusShotCount, SHOP.MIB_SHOTS, '自动触发');
});

test('第五十七修 · 本店第一个道具免费：只免一次、重进店重置、技能/强化/刷新不免费', () => {
  const levels = {};
  const { shop, state } = makeShop(10000, false, levels);
  assert.equal(shop.entries.find((e) => e.kind === 'skill').price, SHOP.SKILL_PRICE, '技能不免费');
  assert.equal(shop.entries.find((e) => e.kind === 'refresh').price, SHOP.REFRESH_BASE, '刷新不免费');
  const e1 = hitEntry(shop, (x) => x.kind === 'item');
  assert.equal(e1.free, true, '第一个道具标免费');
  assert.equal(state.coin, 10000, '免费 = 不扣钱');
  resolve(shop);
  const due2 = shopItemPrice(shop.entries.find((x) => x.kind === 'item').def.id, levels);   // 买前取价：买完 levels 已 +1
  assert.equal(due2, SHOP.ITEM_BASE_PRICE, '0 级 → 目标等级 1 价 = 1000');
  const e2 = hitEntry(shop, (x) => x.kind === 'item');
  assert.equal(e2.free, false, '第二个不再免费');
  assert.equal(state.coin, 10000 - due2, '第二个按目标等级收费');
  resolve(shop);
  const st = shop._state;
  shop.open(ORIGIN(), st);
  assert.equal(shop._freeItem, true, '重进店 → 免费名额重置');
  assert.ok(shop.entries.filter((e) => e.kind === 'item').every((e) => e.free === true));
});

// ================= 第五十八修（现场一轮反馈）=================
//  ① 两列卡（道具 / 精英预告）放大 2 倍 + 平行于地面的 Z 线；选项卡 1.5 倍；
//  ② 价位「换个容易区分的颜色 + 放大一倍」⇒ 从说明文字里搬出来，画成卡面底部大字；
//  ③ 技能区 / 道具区气球上方各挂一块「商店币」牌子；「购物完成」气球上挂倒计时。

test('第五十八修 · 两列卡放大且平行于地面的 Z 线：道具列 +90°、预告列 -90°、正前方保持朝原点', () => {
  const { shop } = makeShop(0);
  const item = shop.entries.find((e) => e.kind === 'item');
  assert.equal(item.holder.scale.x, SHOP.CARD_SCALE_ITEM, '道具列整组放大');
  assert.equal(item.card.rotation.y, Math.PI / 2, '法线指向 +X（平行于地面的 Z 线）');
  const front = shop.entries.find((e) => e.kind === 'skill');
  assert.equal(front.holder.scale.x, SHOP.CARD_SCALE_FRONT, '正前方保持原样');
  assert.notEqual(Math.abs(front.card.rotation.y), Math.PI / 2, '正前方仍是「朝场地原点」定向');
  assert.ok(shop.preview.length > 0);
  assert.equal(shop.preview[0].holder.scale.x, SHOP.CARD_SCALE_PREVIEW, '预告列整组放大');
  assert.equal(shop.preview[0].mesh.rotation.y, -Math.PI / 2, '法线指向 -X');
  shop.dispose();
});

test('第五十八修 · 气球高度 / 浮动 / 命中半径随整组缩放 —— 放大后的列照样打得中', () => {
  const { shop, state } = makeShop(10000);
  const item = shop.entries.find((e) => e.kind === 'item');
  assert.equal(item.balloonY, CARD.BALLOON_HEIGHT * SHOP.CARD_SCALE_ITEM);
  assert.equal(item.balloonHit, (CARD.BALLOON_R + 0.12) * SHOP.CARD_SCALE_ITEM);
  assert.equal(item.bob, CARD.BALLOON_BOB * SHOP.CARD_SCALE_ITEM);
  const e = hitEntry(shop, (x) => x.kind === 'item');   // hitEntry 按 balloonY 造子弹
  assert.equal(e.exploded, true, '放大后的气球仍能被命中');
  assert.equal(state.coin, 10000, '第一个道具免费');
});

test('第五十八修 · 价位搬出说明文字：卡面底部大字（金色 / 免费绿），sub 不再夹价格', () => {
  const { shop } = makeShop(5000, true);
  const up = shop._frontEntries().find((e) => e.kind === 'upgrade');
  assert.equal(up.priceText, String(SHOP.UPGRADE_PRICE));
  assert.equal(up.priceColor, SHOP.PRICE_COLOR);
  assert.ok(!up.sub.includes(String(SHOP.UPGRADE_PRICE)), `说明文字里不该再夹价格：${up.sub}`);
  const skill = makeShop(5000).shop._frontEntries().find((e) => e.kind === 'skill');
  assert.equal(skill.priceText, String(SHOP.SKILL_PRICE));
  assert.ok(!skill.sub.includes(String(SHOP.SKILL_PRICE)), `说明文字里不该再夹价格：${skill.sub}`);
  const items = shop._itemEntries();
  const free = items.find((e) => e.kind === 'item');
  assert.equal(free.priceText, '免费');
  assert.equal(free.priceColor, SHOP.PRICE_FREE_COLOR);
  assert.ok(!free.sub.includes('免费'), `说明文字里不该再夹「免费」：${free.sub}`);
  const rf = items.find((e) => e.kind === 'refresh');
  assert.equal(rf.priceText, String(SHOP.REFRESH_BASE));
  assert.ok(!rf.sub.includes(String(SHOP.REFRESH_BASE)));
  // 上架后的 entry 也带着这份价位（卡面绘制读的就是它）
  const upEntry = shop.entries.find((e) => e.kind === 'upgrade');
  assert.equal(upEntry.priceText, String(SHOP.UPGRADE_PRICE));
  assert.equal(upEntry.priceColor, SHOP.PRICE_COLOR);
  const done = shop.entries.find((e) => e.kind === 'done');
  assert.equal(done.priceText, null, '购物完成免费：不画价位');
});

test('第五十八修 · 区域牌子：技能区 / 道具区各一块商店币 + 「购物完成」气球上的倒计时', () => {
  const { shop, state } = makeShop(1375);
  assert.ok(shop.coinFront && shop.coinFront.mesh.parent === shop.badgeGroup, '技能区牌子挂 badgeGroup');
  assert.ok(shop.coinItem && shop.coinItem.mesh.parent === shop.badgeGroup, '道具区牌子挂 badgeGroup');
  assert.equal(shop.coinFront.text, '商店币 1375');
  assert.equal(shop.coinItem.text, '商店币 1375');
  assert.ok(shop.coinFront.mesh.position.y > SHOP.FRONT_Y + CARD.BALLOON_HEIGHT, '挂在气球上方');
  assert.ok(shop.coinItem.mesh.position.y > SHOP.ITEM_Y + CARD.BALLOON_HEIGHT * SHOP.CARD_SCALE_ITEM,
    '道具列挂在（放大后的）气球上方');
  const done = shop.entries.find((e) => e.kind === 'done');
  assert.ok(done.badge && done.badge.mesh.parent === done.holder, '倒计时牌子挂在「购物完成」上（随气球浮动）');
  assert.equal(done.badge.text, `剩余 ${SHOP.COUNTDOWN}s`);
  state.coin = 250;
  shop.update(0.1, null, ORIGIN());
  assert.equal(shop.coinFront.text, '商店币 250', '花掉商店币后牌子跟着变');
  assert.equal(done.badge.text, `剩余 ${Math.ceil(shop.timer)}s`, '倒计时每帧刷');
  shop._finish();
  assert.equal(shop.coinFront, null, '离店把牌子拆干净');
  assert.equal(shop.coinItem, null);
});

test('第五十八修 · 牌子只在文字/颜色真变了才重绘（每帧调 set 不重复上传贴图）', () => {
  const b = makeBadge('A', SHOP.PRICE_COLOR);
  assert.equal(b.text, 'A');
  assert.equal(b.set('A'), false, '同文不重绘');
  assert.equal(b.set('B'), true);
  assert.equal(b.set('B', SHOP.PRICE_COLOR), false, '同文同色不重绘');
  assert.equal(b.set('B', SHOP.PRICE_FREE_COLOR), true, '换色要重绘');
  b.dispose();
});

// ================= 第五十九修（现场二轮反馈）=================
//  ① 正前方「技能 / 强化」放大 1.5 倍（「购物完成」保持原样）；
//  ② 左右两列**收进飞毯**并**绕场地中心 Z=0 对称铺开**（旧版从 -1.0 单向往后排 → 甩到毯外）；
//  ③ 区域牌子放大（尺寸按画布 512×160 同比例）；④ 商店币不足只提示「商店币不足」。

test('第五十九修 · columnZ：n 张卡绕 zc 均匀对称（和恒为 0 / 间距恒定 / i=0 最靠前）', () => {
  const n = 6, dz = 1.15;
  const zs = Array.from({ length: n }, (_, i) => columnZ(0, dz, i, n));
  assert.ok(Math.abs(zs.reduce((a, b) => a + b, 0)) < 1e-12, '整列之和 = 0（绕场地中心对称）');
  for (let i = 1; i < n; i++) assert.ok(Math.abs((zs[i] - zs[i - 1]) - dz) < 1e-12, '等距');
  assert.ok(zs[0] < 0 && Math.abs(zs[n - 1] + zs[0]) < 1e-12, 'i=0 最靠前（最负 Z），整列以 0 为中心');
  assert.ok(Math.abs(columnZ(0, dz, 0, 1)) < 1e-12, '单张 = 落在中心');
  assert.ok(Math.abs(columnZ(-0.5, dz, 0, 3) - (-0.5 - dz)) < 1e-12, '带偏移的 zc 照常生效');
});

test('第五十九修 · 两列卡全部收进飞毯（旧版 |X| = 3.0 / 6 张排到 Z = -6.75，都在毯外）', () => {
  const { shop } = makeShop(0);
  // 正前方那一排本来就贴着前缘（FRONT_Z 一直略在毯外，现场口径不变）→ 只查左右两列
  const sideEntries = shop.entries.filter((e) => e.kind === 'item' || e.kind === 'refresh');
  const pts = [...sideEntries.map((e) => e.holder.position), ...shop.preview.map((p) => p.holder.position)];
  assert.equal(pts.length, 9, '道具 4（3 道具 + 刷新）+ 预告 5');
  for (const p of pts) {
    assert.ok(Math.abs(p.x) < MOVE.BOUND_X, `|X| 必须在飞毯半宽(${MOVE.BOUND_X}m)内：${p.x}`);
    assert.ok(Math.abs(p.z) < MOVE.BOUND_Z, `|Z| 必须在飞毯半深(${MOVE.BOUND_Z}m)内：${p.z}`);
  }
  // 道具列：绕 Z=0 对称、等距
  const col = (arr) => arr.map((e) => e.holder.position.z);
  const items = col(sideEntries);
  assert.equal(items.length, 4);
  assert.ok(Math.abs(items.reduce((a, b) => a + b, 0)) < 1e-9, '道具列对称');
  for (let i = 1; i < items.length; i++) assert.ok(Math.abs((items[i] - items[i - 1]) - SHOP.ITEM_DZ) < 1e-9);
  const pv = col(shop.preview);
  assert.equal(pv.length, 5, '第 3 关 5 张预告卡');
  assert.ok(Math.abs(pv.reduce((a, b) => a + b, 0)) < 1e-9, '预告列对称');
  for (let i = 1; i < pv.length; i++) assert.ok(Math.abs((pv[i] - pv[i - 1]) - SHOP.PREVIEW_DZ) < 1e-9);
  assert.ok(Math.abs(shop.preview[0].holder.position.x - -SHOP.ITEM_X) < 1e-9, '与道具列镜像（左右对称）');
  shop.dispose();
});

test('第五十九修 · 预告列张数变化时仍对称（3/5/6 张都不越界、不偏心）', () => {
  for (const n of [3, 5, 6]) {
    const zs = Array.from({ length: n }, (_, i) => columnZ(SHOP.PREVIEW_ZC, SHOP.PREVIEW_DZ, i, n));
    assert.ok(Math.abs(zs.reduce((a, b) => a + b, 0)) < 1e-12, `${n} 张也要对称`);
    for (const z of zs) assert.ok(Math.abs(z) < MOVE.BOUND_Z, `${n} 张都不许出毯：${z}`);
  }
});

test('第五十九修 · 正前方「技能 / 强化」放大 CARD_SCALE_FRONT，「购物完成」保持原样', () => {
  assert.ok(SHOP.CARD_SCALE_FRONT > 1, '现场：选项卡没变大 → 必须 > 1');
  assert.equal(SHOP.CARD_SCALE_DONE, 1, '「购物完成」保持原样');
  const { shop } = makeShop(0);
  const sk = shop.entries.find((e) => e.kind === 'skill');
  assert.equal(sk.holder.scale.x, SHOP.CARD_SCALE_FRONT);
  assert.equal(sk.balloonY, CARD.BALLOON_HEIGHT * SHOP.CARD_SCALE_FRONT, '气球高度随缩放');
  assert.equal(sk.balloonHit, (CARD.BALLOON_R + 0.12) * SHOP.CARD_SCALE_FRONT, '看着多大就能打中多大');
  assert.equal(sk.bob, CARD.BALLOON_BOB * SHOP.CARD_SCALE_FRONT);
  const done = shop.entries.find((e) => e.kind === 'done');
  assert.equal(done.holder.scale.x, SHOP.CARD_SCALE_DONE);
  // 放大后照样打得中（命中判定用的是同一个 scale 推导出来的半径）
  const hit = hitEntry(shop, (x) => x.kind === 'done');
  assert.equal(hit.exploded, true);
});

test('第五十九修 · 区域牌子做大：尺寸必须按画布 512×160 同比例（否则文字被拉伸）', () => {
  assert.ok(SHOP.BADGE_W > 0.96 && SHOP.BADGE_H > 0.30, '比第五十八修更大');
  assert.ok(Math.abs(SHOP.BADGE_W / SHOP.BADGE_H - 512 / 160) < 1e-6, 'aspect 与画布一致');
  const b = makeBadge('商店币 1375', SHOP.PRICE_COLOR);
  assert.ok(Math.abs(b.mesh.geometry.parameters.width - SHOP.BADGE_W) < 1e-9);
  assert.ok(Math.abs(b.mesh.geometry.parameters.height - SHOP.BADGE_H) < 1e-9);
  b.dispose();
});

test('第五十九修 · 商店币不足只提示「商店币不足」（长文案会被中场横幅裁掉）', () => {
  const { shop, state, calls } = makeShop(900);
  hitEntry(shop, (x) => x.kind === 'skill');
  assert.deepEqual(calls.denied, ['商店币不足']);
  assert.equal(state.coin, 900, '买不起就不该扣');
  assert.ok(calls.denied[0].length <= 8, '够短才不会被遮');
});