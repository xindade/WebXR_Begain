// 第六十九修 · 技能按钮“永久失效”回归锁
//
// 现场：商店选完黑洞后，左右手 grip 都没反应。
// 根因链：技能卡来自 content 包（服务器可覆盖），可能比 APK 新 →
//   旧客户端不认识 blackhole → switch 无匹配分支（什么都不放），
//   且冷却口径可能落成 undefined/NaN → `skillCooldown <= 0` 恒为 false ⇒ 永久失效。
// 本文件锁住四件事：未知 id 不装备、不上架、不空放、不进冷却；冷却永远是有限正数。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

const originalLoad = THREE.TextureLoader.prototype.load;
let Game, ShopDraft;
try {
  THREE.TextureLoader.prototype.load = () => new THREE.Texture();
  ({ Game } = await import('../src/game/game.js'));
  ({ ShopDraft } = await import('../src/game/shop.js'));
} finally { THREE.TextureLoader.prototype.load = originalLoad; }

test('冷却口径：未知技能 id 也返回有限正数，绝不 undefined / NaN', () => {
  for (const id of ['futureSkill', 'blackhole_v2']) {
    const g = { selectedSkill: id, player: { skillCdDown: 0 } };
    const cd = Game.prototype._skillCdTotal.call(g);
    assert.ok(Number.isFinite(cd), `id=${id} 冷却必须是有限数，实际 ${cd}`);
    assert.ok(cd > 0, `id=${id} 冷却必须 > 0，实际 ${cd}`);
  }
  // 历史口径：没装备技能（null / 空串）→ 0，不显示冷却
  for (const id of [null, undefined, '']) {
    const g = { selectedSkill: id, player: { skillCdDown: 0 } };
    assert.equal(Game.prototype._skillCdTotal.call(g), 0);
  }
});

test('冷却口径：skillCdDown 被内容包写成非法值时也不产生 NaN', () => {
  const g = { selectedSkill: 'blackhole', player: { skillCdDown: NaN } };
  assert.ok(Number.isFinite(Game.prototype._skillCdTotal.call(g)));
});

test('装备：未知 id 不落库，保留当前可用技能（不能把玩家变成无技能状态）', () => {
  const g = {
    selectedSkill: 'lightsaber', skillCooldown: 9, player: {},
    leftSword: { setEquipped() {} }, log() {},
  };
  Game.prototype._applySkillCard.call(g, 'futureSkill');
  assert.equal(g.selectedSkill, 'lightsaber', '应保留原技能');
  assert.equal(g.skillCooldown, 0, '重新装备一次仍然就绪');
});

test('装备：当前技能也未知时回落到默认能量散射', () => {
  const g = { selectedSkill: 'futureSkill', skillCooldown: 3, player: {}, log() {} };
  Game.prototype._applySkillCard.call(g, 'futureSkill');
  assert.equal(g.selectedSkill, 'scatter');
  assert.equal(g.skillCooldown, 0);
});

test('释放：未知 id 回落能量散射（而不是“什么都不放却进冷却”）', () => {
  let casts = 0;
  const g = {
    selectedSkill: 'futureSkill', player: { skillCdDown: 0 },
    skillCooldown: 0, _skillCasts: 0,
    _castScatter() { casts++; return true; }, log() {},
  };
  assert.equal(Game.prototype._triggerSelectedSkill.call(g), true);
  assert.equal(g.selectedSkill, 'scatter');
  assert.equal(casts, 1);
  assert.ok(g.skillCooldown > 0, '成功释放才进冷却');
});

test('释放：能量不足等失败路径不进入冷却、不记次数', () => {
  const g = {
    selectedSkill: 'scatter', player: { skillCdDown: 0 },
    skillCooldown: 0, _skillCasts: 0,
    _castScatter() { return false; }, log() {},
  };
  assert.equal(Game.prototype._triggerSelectedSkill.call(g), false);
  assert.equal(g.skillCooldown, 0);
  assert.equal(g._skillCasts, 0);
});

test('商店：客户端未实现的技能卡不摆上架', () => {
  const shop = Object.create(ShopDraft.prototype);
  shop._state = { hasSkill: () => false, supportsSkill: () => false };
  shop._priceMul = 1;
  shop._upgradesBought = new Set();
  const rows = ShopDraft.prototype._frontEntries.call(shop);
  assert.equal(rows.filter((r) => r.kind === 'skill').length, 0, '一张技能卡都不该出现');
  assert.ok(rows.some((r) => r.kind === 'done'), '「购物完成」仍必须在');
});

test('商店：客户端已实现的技能正常上架（回归）', () => {
  const shop = Object.create(ShopDraft.prototype);
  shop._state = { hasSkill: () => false, supportsSkill: () => true };
  shop._priceMul = 1;
  shop._upgradesBought = new Set();
  const rows = ShopDraft.prototype._frontEntries.call(shop);
  assert.equal(rows.filter((r) => r.kind === 'skill').length, 3);
});