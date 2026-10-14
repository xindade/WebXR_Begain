// 三层出怪编排（第四十六修）—— src/content/spawnDirector.js
//
// 为什么值得单独锁：这张表直接决定「玩家第几秒遇到什么怪」，写错一个字段（事件名拼错、
// 用了不存在的敌种、给机制关/ Boss 关配了脚本）在头显里都是**现场才炸**的错误；
// 这些检查全是纯函数/纯数据，跑在本地几毫秒就能挡掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYER, TYPE_LAYER, ELITE_DISPLAY_NAME, DIR_TEXT, FUSE, SPAWN_SCRIPT,
  scriptFor, layerOfType, comboTotal, scriptEventTimes, eliteEvents,
  isClimaxEvent, climaxEliteHp, eliteTravelSpeed,
} from '../src/content/spawnDirector.js';
import { ELITE_TUNING } from '../src/core/constants.js';
import { ENEMY_TYPES } from '../src/content/enemies.js';
import { LEVELS, isBoss, isLaser } from '../src/content/levels.js';

test('三层定义齐全，光点颜色互不相同（白 / 蓝 / 紫红）', () => {
  for (const id of ['trash', 'mini', 'skill', 'support']) {
    assert.ok(LAYER[id], '缺层：' + id);
    assert.equal(typeof LAYER[id].color, 'number');
    assert.equal(LAYER[id].id, id);
  }
  const colors = [LAYER.trash.color, LAYER.mini.color, LAYER.skill.color];
  assert.equal(new Set(colors).size, 3, '三层的层色必须互不相同');
});

test('每个敌种都能归到某一层；未知敌种兜底 trash', () => {
  for (const id of Object.keys(ENEMY_TYPES)) {
    if (TYPE_LAYER[id] == null) continue;   // Boss / 龙身等不参与分层
    assert.ok(LAYER[TYPE_LAYER[id]], id + ' 的层不存在');
  }
  assert.equal(layerOfType('shield'), 'mini');
  assert.equal(layerOfType('octopus'), 'skill');
  assert.equal(layerOfType('heart'), 'support');
  assert.equal(layerOfType('不存在的怪'), 'trash');
});

test('名牌名字覆盖脚本会用到的全部精英敌种', () => {
  for (const [n, s] of Object.entries(SPAWN_SCRIPT)) {
    for (const ev of s.events) {
      if (ev.do !== 'elite') continue;
      for (const c of ev.combos) {
        assert.ok(ELITE_DISPLAY_NAME[c.type], `第${n}关 ${c.type} 没有名牌文字`);
      }
    }
  }
});

test('scriptEventTimes：单次事件只在自己那帧触发，循环事件按 every 铺开', () => {
  const once = { t: 30.0, do: 'banner', text: 'x' };
  assert.deepEqual(scriptEventTimes(once, 29.9, 30.1), [30.0]);
  assert.deepEqual(scriptEventTimes(once, 30.0, 30.2), []);       // 同一秒不重复
  assert.deepEqual(scriptEventTimes(once, 30.1, 31.0), []);       // 过去了就不再触发

  const loop = { t: 5, every: 10, until: 30, do: 'elite', combos: [] };
  assert.deepEqual(scriptEventTimes(loop, 0, 6), [5]);
  assert.deepEqual(scriptEventTimes(loop, 6, 16), [15]);
  assert.deepEqual(scriptEventTimes(loop, 16, 31), [25]);         // until=30 → 35 不出
  assert.deepEqual(scriptEventTimes(loop, 30, 60), []);
  // 一帧跨过多个触发点（掉帧/卡顿）不能漏
  assert.deepEqual(scriptEventTimes(loop, 0, 30), [5, 15, 25]);
});

test('comboTotal 累加各 combo 的 count', () => {
  assert.equal(comboTotal([{ type: 'a', count: 2 }, { type: 'b', count: 3 }]), 5);
  assert.equal(comboTotal(null), 0);
});

test('脚本只写给普通关：机制关(3/9/15)与 Boss 关(6/12/18)必须为 null', () => {
  assert.deepEqual(Object.keys(SPAWN_SCRIPT).map(Number).sort((a, b) => a - b), [1, 2, 4, 5]);
  for (const lv of LEVELS) {
    const s = scriptFor(lv.n);
    if (isBoss(lv) || isLaser(lv)) assert.equal(s, null, `第${lv.n}关是 Boss/机制关，不该写脚本`);
  }
  assert.ok(scriptFor(1) && scriptFor(2) && scriptFor(4) && scriptFor(5));
  assert.equal(scriptFor(7), null);   // 未编排的普通关 → 走旧的三期脉冲
});

test('事件字段合法：do / via 取值、横幅有文案、方位可翻译、精英有 combos', () => {
  const DO = new Set(['banner', 'elite', 'trashBurst', 'clearTrash']);
  const VIA = new Set(['portal', 'merge', 'direct']);
  for (const [n, s] of Object.entries(SPAWN_SCRIPT)) {
    assert.ok(s.events.length > 0, `第${n}关没有事件`);
    for (const ev of s.events) {
      assert.ok(DO.has(ev.do), `第${n}关未知事件 do=${ev.do}`);
      assert.equal(typeof ev.t, 'number');
      if (ev.dir) assert.ok(DIR_TEXT[ev.dir], `第${n}关方位 ${ev.dir} 没有文案`);
      if (ev.via) assert.ok(VIA.has(ev.via), `第${n}关未知 via=${ev.via}`);
      if (ev.do === 'banner') assert.ok(ev.text, `第${n}关横幅没文案`);
      if (ev.do === 'elite') {
        assert.ok(comboTotal(ev.combos) > 0, `第${n}关精英批次为空`);
        for (const c of ev.combos) assert.ok(ENEMY_TYPES[c.type], `第${n}关用了不存在的敌种 ${c.type}`);
        if (ev.goldReturn) assert.ok(ev.via === 'merge' || ev.via === 'portal');
      }
    }
  }
});

test('第一关：前 30s 提密度 + 30s 出「前方」精英（清场融合 + 金点抽卡）', () => {
  const s = scriptFor(1);
  assert.equal(s.trashMul, 1.5);
  assert.equal(s.trashMulUntil, 30);
  const elite = eliteEvents(1);
  assert.equal(elite.length, 1);
  assert.equal(elite[0].dir, 'front');
  assert.equal(elite[0].via, 'merge');
  assert.equal(elite[0].goldReturn, true);
  assert.ok(elite[0].t >= 30 && elite[0].t <= 31);   // 横幅之后 0.7s
});

test('第二关：30s 前每 10s 一只前向铁甲兵（传送门、场上最多 1），30s 左边融合盾甲兵', () => {
  const s = scriptFor(2);
  const portal = s.events.find((e) => e.every === 10);
  assert.ok(portal);
  assert.equal(portal.capOnField, 1);
  assert.equal(portal.via, 'portal');
  assert.equal(portal.dir, 'front');
  const last = eliteEvents(2).pop();
  assert.equal(last.dir, 'frontLeft');
  assert.equal(last.via, 'merge');
  assert.equal(last.combos[0].type, 'shield');
});

test('第四关：开局批量杂鱼 + 锁技能；20s 两铁甲兵；30s 右边融合 2 铁甲兵 + 1 盾甲兵', () => {
  const s = scriptFor(4);
  assert.ok(s.skillLockUntil > 0, '第4关必须锁技能');
  const burst = s.events.find((e) => e.do === 'trashBurst');
  assert.ok(burst && burst.count > 0);
  const eliteEvs = eliteEvents(4);
  assert.equal(eliteEvs.length, 2);
  assert.equal(comboTotal(eliteEvs[0].combos), 2);
  assert.equal(eliteEvs[0].via, 'portal');
  const last = eliteEvs[1];
  assert.equal(last.dir, 'frontRight');
  assert.equal(last.via, 'merge');
  assert.equal(comboTotal(last.combos), 3);
  assert.equal(last.combos[last.combos.length - 1].type, 'shield');   // 盾兵在后
});

test('第五关：左边融合 治疗术士 + 2 铁甲兵（带治疗线）', () => {
  const last = eliteEvents(5).pop();
  assert.equal(last.dir, 'frontLeft');
  assert.equal(last.via, 'merge');
  assert.equal(last.link, 'heal');
  assert.equal(last.combos[0].type, 'heart');
  assert.equal(comboTotal(last.combos), 3);
});

test('融合参数合理：至少 1 个光点、时长与尺寸为正', () => {
  assert.ok(FUSE.COUNT >= 1);
  assert.ok(FUSE.IN_DUR > 0 && FUSE.OUT_DUR > 0);
  assert.ok(FUSE.OUT_MUL > 1, '融合后的大光点应当比普通光点更大');
  assert.ok(FUSE.ORB_SIZE > 0);
});

test('方位文案齐全（前方 / 左边 / 右边）', () => {
  for (const d of ['front', 'frontLeft', 'frontRight']) assert.ok(DIR_TEXT[d]);
  assert.equal(DIR_TEXT.front, '前方');
  assert.equal(DIR_TEXT.frontLeft, '左边');
  assert.equal(DIR_TEXT.frontRight, '右边');
});

// ============================================================
// 第四十八修：精英分两档 —— 末尾精英强化 / 普通精英原生
//   末尾批 = 脚本里带 goldReturn 的那一批（横幅 → 清场融合 → 金点抽卡）。
//   只有它吃 ELITE_TUNING（体型 ×SIZE_MUL / 远距 / DPS 血量）；普通零星精英保持原生。
// ============================================================

test('末尾批判定：只有带 goldReturn 的事件算本关收尾（唯一定义）', () => {
  assert.equal(isClimaxEvent({ goldReturn: true }), true);
  assert.equal(isClimaxEvent({ t: 5, do: 'elite' }), false);
  assert.equal(isClimaxEvent({ goldReturn: false }), false);
  assert.equal(isClimaxEvent(null), false);
  assert.equal(isClimaxEvent(undefined), false);
  // 脚本里每一关的末尾批都必须是 goldReturn（否则拿不到强化 → 收尾没压迫感）
  for (const s of Object.values(SPAWN_SCRIPT)) {
    const last = s.events.filter((e) => e.do === 'elite').pop();
    if (last) assert.equal(isClimaxEvent(last), true);
  }
});

test('末尾批血量：单只 = 本批基础血量 × HP_MUL，被 DPS 上限夹住（可击杀保证）', () => {
  // raw = 1000×2 = 2000；DPS=300 → 上限 1800（纯输出 6 秒）⇒ 夹到 1800
  assert.equal(climaxEliteHp(1000, 1000, 300, ELITE_TUNING), 1800);
  // 上限就是「纯输出 HP_MAX_SECONDS 秒」：整批总量不会超过 DPS × HP_MAX_SECONDS
  const dps = 1000;
  const batch = [{ type: 'eliteKnight', count: 4 }];   // 基础 1000 每只 → 批 4000
  const per = climaxEliteHp(1000, 4000, dps, ELITE_TUNING);
  assert.ok(per * 4 <= dps * ELITE_TUNING.HP_MAX_SECONDS + 4, '整批不得超过 6 秒纯输出');
  assert.equal(per, 1500);   // 2000 × (6000/8000)
});

test('末尾批血量：下限是仪式感（DPS 再高也不会一秒蒸发）', () => {
  // raw 很小但 DPS 很高 → 抬到 DPS × HP_MIN_SECONDS
  const hp = climaxEliteHp(100, 100, 1000, ELITE_TUNING);
  assert.equal(hp, 1000 * ELITE_TUNING.HP_MIN_SECONDS);   // 2500
});

test('末尾批血量：同批按各型基础血量成比例分摊', () => {
  const a = climaxEliteHp(1300, 2000, 300, ELITE_TUNING);
  const b = climaxEliteHp(1000, 2000, 300, ELITE_TUNING);
  assert.equal(a, 1170);          // 2600 × (1800/4000)
  assert.equal(b, 900);           // 2000 × (1800/4000)
  assert.equal(a / b, 1.3);       // = 1300/1000
});

test('末尾批血量：拿不到 DPS 时退回基础血量（不会 0 血 / NaN）', () => {
  assert.equal(climaxEliteHp(1000, 1000, NaN, ELITE_TUNING), 2000);
  assert.equal(climaxEliteHp(1000, 1000, 0, ELITE_TUNING), 2000);
  assert.equal(climaxEliteHp(undefined, 0, 0, ELITE_TUNING), 1);
});

test('强化参数表：末尾精英体型放大 / 出生更远 / 血量上限为正且下限更小', () => {
  assert.ok(ELITE_TUNING.SIZE_MUL > 1, '末尾精英要真的放大');
  assert.ok(ELITE_TUNING.SPAWN_DIST > 15, '要比普通精英的 15m 更远');
  assert.ok(ELITE_TUNING.SPAWN_SPREAD > 6);
  assert.ok(ELITE_TUNING.HP_MUL > 1, '血量基准要比原生更厚');
  assert.ok(ELITE_TUNING.HP_MAX_SECONDS > 0, '必须有可击杀上限');
  assert.ok(ELITE_TUNING.HP_MIN_SECONDS > 0 && ELITE_TUNING.HP_MIN_SECONDS < ELITE_TUNING.HP_MAX_SECONDS);
});

test('末尾精英速度：10 秒正好走出生距离的 2/3（剩下的 1/3 再走 5 秒）', () => {
  const v = eliteTravelSpeed(ELITE_TUNING);
  assert.equal(v * ELITE_TUNING.TRAVEL_SECONDS, ELITE_TUNING.SPAWN_DIST * ELITE_TUNING.TRAVEL_FRACTION);
  assert.ok(Math.abs(ELITE_TUNING.TRAVEL_FRACTION - 2 / 3) < 1e-9);
});
