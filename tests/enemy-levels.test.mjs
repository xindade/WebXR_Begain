// 第八十一~八十二修 · 等级血量表（src/content/enemyLevels.js）
//
// 锁住现场确认的口径：
//   · 基础怪 LV = 关卡数；精英 LV = 关卡数 + 首次出场偏移；
//   · 本体 = 基础 + 成长 × LV；
//   · 普通精英只有忍者/幽灵/章鱼额外吃进关 DPS×1，再整体 ×1.3；
//   · 末尾批 = 本体×1.5 + DPS×6 ÷ 本批只数；
//   · Boss / Boss 召唤物不在表内（不套等级血量）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVEL_HP, levelFor, bodyHp, normalEliteHp,
  stageSpawnOpts, hasLevelHp, RANGED_NORMAL_HP_MUL,
} from '../src/content/enemyLevels.js';
import { climaxEliteHp } from '../src/content/spawnDirector.js';
import { ELITE_TUNING, FACE_BOSS, DRAGON, MAGICIAN_BOSS } from '../src/core/constants.js';

test('等级表：基础怪 = 关卡数，精英 = 关卡数 + 首次出场偏移', () => {
  assert.equal(levelFor('basic', 1), 1);
  assert.equal(levelFor('basic', 18), 18);
  assert.equal(levelFor('eliteKnight', 1), 2);
  assert.equal(levelFor('shield', 2), 4);
  assert.equal(levelFor('heart', 5), 8);
  assert.equal(levelFor('ninja', 8), 12);
  assert.equal(levelFor('ghost', 11), 16);
  assert.equal(levelFor('octopus', 14), 20);
  for (const [type, cfg] of Object.entries(LEVEL_HP)) {
    assert.equal(cfg.offset, levelFor(type, 1) - 1, type + ' 的偏移口径');
  }
});

test('本体血量：基础 + 成长 × LV（首次出场关键值）', () => {
  assert.equal(bodyHp('basic', 1), 150);
  assert.equal(bodyHp('eliteKnight', 1), 1200);
  assert.equal(bodyHp('shield', 2), 1600);
  assert.equal(bodyHp('heart', 5), 4600);
  assert.equal(bodyHp('ninja', 8), 4400);
  assert.equal(bodyHp('ghost', 11), 7000);
  assert.equal(bodyHp('octopus', 14), 12000);
});

test('本体血量：第 18 关关键值', () => {
  assert.equal(bodyHp('basic', 18), 1000);
  assert.equal(bodyHp('eliteKnight', 18), 2900);
  assert.equal(bodyHp('shield', 18), 4000);
  assert.equal(bodyHp('heart', 18), 7200);
  assert.equal(bodyHp('ninja', 18), 6400);
  assert.equal(bodyHp('ghost', 18), 8750);
  assert.equal(bodyHp('octopus', 18), 13200);
});

test('普通精英：远程三兄弟 (本体 + 进关 DPS×1) 再 ×1.3，其余只吃本体', () => {
  assert.equal(RANGED_NORMAL_HP_MUL, 1.3);
  assert.equal(normalEliteHp('ninja', 8, 1000), Math.round((4400 + 1000) * 1.3));
  assert.equal(normalEliteHp('ghost', 11, 1000), Math.round((7000 + 1000) * 1.3));
  assert.equal(normalEliteHp('octopus', 14, 1000), Math.round((12000 + 1000) * 1.3));
  assert.equal(normalEliteHp('eliteKnight', 8, 1000), bodyHp('eliteKnight', 8));
  assert.equal(normalEliteHp('shield', 8, 1000), bodyHp('shield', 8));
  assert.equal(normalEliteHp('heart', 8, 1000), bodyHp('heart', 8));
});

test('末尾批：本体 ×1.5 + (进关 DPS×6 ÷ 本批只数)', () => {
  const dps = 1000;
  const combos = [{ type: 'eliteKnight', count: 2 }, { type: 'shield', count: 1 }];
  const stage = 10;
  const count = combos.reduce((s, c) => s + c.count, 0);
  const knight = climaxEliteHp(bodyHp('eliteKnight', stage), count, dps, ELITE_TUNING);
  const shield = climaxEliteHp(bodyHp('shield', stage), count, dps, ELITE_TUNING);
  const share = dps * ELITE_TUNING.DPS_SECONDS / count;
  assert.equal(knight, Math.round(bodyHp('eliteKnight', stage) * ELITE_TUNING.BODY_MUL + share));
  assert.equal(shield, Math.round(bodyHp('shield', stage) * ELITE_TUNING.BODY_MUL + share));
  assert.equal(
    Math.round((knight - share) / bodyHp('eliteKnight', stage) * 100),
    Math.round(ELITE_TUNING.BODY_MUL * 100),
    '本体部分严格 ×1.5，DPS 部分按只数均分',
  );
});

test('Boss 血量倍率：脸谱 ×3 / 龙 ×2 / 魔术师 ×5', () => {
  assert.equal(FACE_BOSS.HP, 9000);
  assert.equal(DRAGON.HP_MULT, 2);
  assert.equal(MAGICIAN_BOSS.HP_MULT, 5);
});

test('基础怪构造参数：普通关补等级血量，Boss 关原样不补', () => {
  const normal = stageSpawnOpts('basic', 7, { ring: 'inner' }, false);
  assert.equal(normal.hp, bodyHp('basic', 7));
  assert.equal(normal.level, 7);
  assert.equal(normal.ring, 'inner', '原有参数不能丢');
  const boss = stageSpawnOpts('basic', 18, { ring: 'inner' }, true);
  assert.equal(boss.hp, undefined, 'Boss 召唤物不套等级血量');
  assert.equal(boss.level, undefined);
  assert.equal(stageSpawnOpts('eliteKnight', 7, null, false), null, '精英血量由 _eliteOpts 单独给');
});

test('Boss / 机制实体不在等级表内', () => {
  for (const id of ['faceMask', 'bossProxy', 'dragonBody', 'flagMask', 'blackMaskClone', 'orb', 'treasure']) {
    assert.equal(hasLevelHp(id), false, id + ' 不该套等级血量');
    assert.equal(bodyHp(id, 18), null);
  }
});
