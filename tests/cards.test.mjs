// 抽卡选卡逻辑：必出卡（单卡 / 数组组保证）+ 满级兜底补给卡
// 运行：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCards } from '../src/game/cardDraft.js';
import { RESUPPLY_CARD, availableAttributes } from '../src/content/cards.js';

const A = (id) => ({ id, label: id, desc: id, color: '#fff', apply: () => {} });

test('无必出卡：返回 3 张不重复', () => {
  const pool = ['fireRate', 'multiShot', 'atk', 'skillCost', 'skillDamage'].map(A);
  const picks = pickCards(pool, null);
  assert.equal(picks.length, 3);
  assert.equal(new Set(picks.map(p => p.id)).size, 3);
  assert.ok(picks.every(p => pool.includes(p)));
});

test('01/02 关单卡必出：命中时固定该卡并补满 3 张', () => {
  const pool = ['fireRate', 'multiShot', 'atk', 'skillCost'].map(A);
  const picks = pickCards(pool, 'multiShot');
  assert.equal(picks.length, 3);
  assert.equal(picks[0].id, 'multiShot');
  assert.equal(new Set(picks.map(p => p.id)).size, 3);
});

test('01/02 关单卡必出：池中没有该卡时退回随机（原语义不变，不退化为补给）', () => {
  const pool = ['fireRate', 'atk', 'skillCost'].map(A);
  const picks = pickCards(pool, 'multiShot');
  assert.equal(picks.length, 3);
  assert.ok(picks.every(p => p.id !== 'resupply'));
});

test('第9关回血组：优先取数组中第一张可用卡（自我修复 > 生命上限）', () => {
  const pool = ['skillCost', 'skillDamage', 'selfRepair', 'hp'].map(A);
  const picks = pickCards(pool, ['selfRepair', 'hp']);
  assert.equal(picks.length, 3);
  assert.equal(picks[0].id, 'selfRepair');
  assert.equal(new Set(picks.map(p => p.id)).size, 3);
});

test('第9关回血组：第一张满级时取第二张（生命上限）', () => {
  const pool = ['skillCost', 'skillDamage', 'hp'].map(A);
  const picks = pickCards(pool, ['selfRepair', 'hp']);
  assert.equal(picks[0].id, 'hp');
});

test('第9关回血组：两张回血卡都满级（池中都没有）时退化为战场补给卡', () => {
  const pool = ['skillCost', 'skillDamage'].map(A);
  const picks = pickCards(pool, ['selfRepair', 'hp']);
  assert.equal(picks[0].id, 'resupply');
  assert.equal(picks[0], RESUPPLY_CARD);
  assert.equal(picks.length, 3);
  assert.equal(new Set(picks.map(p => p.id)).size, 3);
});

test('卡池不足 3 张时只返回现有张数（不重复、不补空）', () => {
  const pool = ['selfRepair', 'skillCost'].map(A);
  const picks = pickCards(pool, null);
  assert.equal(picks.length, 2);
  assert.deepEqual([...picks.map(p => p.id)].sort(), ['selfRepair', 'skillCost']);
  assert.equal(new Set(picks.map(p => p.id)).size, 2);
});

test('availableAttributes：全部满级时只给战场补给卡（RESUPPLY_CARD 导出后行为不变）', () => {
  const maxed = { fireRate: 14, shotCount: 7, atk: 700, skillCost: 100, skillDamageMul: 5, regen: 10, maxHp: 400 };
  const pool = availableAttributes(maxed, ['skillCost', 'skillDamage', 'selfRepair', 'hp']);
  assert.equal(pool.length, 1);
  assert.equal(pool[0].id, 'resupply');
  // 满级池 + 回血组保证：仍然拿到一张（补给）卡
  assert.equal(pickCards(pool, ['selfRepair', 'hp'])[0].id, 'resupply');
});

test('第9关真实卡池：回血保证确实落在"自我修复"上', () => {
  const player = { fireRate: 2, shotCount: 1, atk: 100, skillCost: 500, skillDamageMul: 1, regen: 0, maxHp: 100 };
  const pool = availableAttributes(player, ['skillCost', 'skillDamage', 'selfRepair', 'hp']);
  assert.deepEqual(pool.map(p => p.id), ['skillCost', 'skillDamage', 'selfRepair', 'hp']);
  assert.equal(pickCards(pool, ['selfRepair', 'hp'])[0].id, 'selfRepair');
});