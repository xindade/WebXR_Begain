// 第五十修（现场口径三条）· 第12关「龙族宝箱」+ 治疗术士回血表现
//
// 现场原话：
//   ①「第五关是恢复飞毯血量20（文字：船血换成飞毯血量）」
//   ②「第12关宝箱用现成的，只是在游戏里的名字变成龙族宝箱，名字在宝箱下方，上方是加成数值显示」
//   ③（更早一轮）「第九关的15是地面玻璃上的标号」
// 这份文件锁的是②的**口径与顺序**（①的可见反馈也一并锁住）：
//   · 数值口径：窗口内打出的子弹数 → 攻击力加成（线性、封顶），纯函数可测；
//   · 顺序口径：龙 Boss 清完先开宝箱，窗口期**不得**去开抽卡（_chestRunning 挡住），
//     本关开过一次就不开第二次（_chestDone）；
//   · 文案口径：名字在宝箱**下方**、加成数值在**上方**（NAME_DY < 0 < VALUE_DY）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { chestBonus, chestValueText, DragonChest } from '../src/game/dragonChest.js';
import { DRAGON_CHEST, HEAL_BANNER, HEAL_ON_DEATH, CARD } from '../src/core/constants.js';
import { ENEMY_TYPES } from '../src/content/enemies.js';
import { styleConfig } from '../src/game/warningBanner.js';

const CFG = { BULLETS_FULL: 30, MAX_BONUS: 150 };

// ---------- ① 宝箱数值：打出的子弹 → 攻击力加成 ----------

test('第五十修 · 宝箱加成：线性，>= 满额子弹数封顶', () => {
  assert.equal(chestBonus(0, CFG), 0);
  assert.equal(chestBonus(15, CFG), 75, '一半发数 → 一半加成');
  assert.equal(chestBonus(30, CFG), 150);
  assert.equal(chestBonus(60, CFG), 150, '超过满额封顶，不无限涨');
});

test('第五十修 · 宝箱加成：脏值不炸（负数 / NaN / 小数 / 缺配置）', () => {
  assert.equal(chestBonus(-5, CFG), 0);
  assert.equal(chestBonus(NaN, CFG), 0);
  assert.equal(chestBonus(undefined, CFG), 0);
  assert.equal(chestBonus(3.7, CFG), 15, '小数按发数向下取整');
  assert.equal(chestBonus(1, { BULLETS_FULL: 30, MAX_BONUS: 0 }), 0, '满额加成 0 → 不加');
  assert.equal(chestBonus(1, { BULLETS_FULL: 0, MAX_BONUS: 150 }), 150, '满额门槛 0 → 直接满额');
});

test('第五十修 · 宝箱数值文案形如「+N 攻击力」', () => {
  assert.equal(chestValueText(0), '+0 攻击力');
  assert.equal(chestValueText(150), '+150 攻击力');
  assert.equal(chestValueText(-3), '+0 攻击力', '负值钳到 0');
  assert.equal(chestValueText(NaN), '+0 攻击力');
});

test('第五十修 · 宝箱参数表：名字在下方、数值在上方、用现成模型', () => {
  assert.equal(DRAGON_CHEST.ENABLED, true);
  assert.equal(DRAGON_CHEST.LEVEL, 12, '只在第12关（龙 Boss 关）触发');
  assert.ok(DRAGON_CHEST.WINDOW > 0, '计数窗口要有长度');
  assert.ok(DRAGON_CHEST.BULLETS_FULL > 0 && DRAGON_CHEST.MAX_BONUS > 0);
  assert.equal(typeof DRAGON_CHEST.NAME, 'string');
  assert.ok(DRAGON_CHEST.NAME.length > 0, '名字不能空（现场指定「龙族宝箱」）');
  assert.ok(DRAGON_CHEST.NAME_DY < 0, '名字在宝箱**下方**');
  assert.ok(DRAGON_CHEST.VALUE_DY > 0, '加成数值在宝箱**上方**');
  assert.equal(DRAGON_CHEST.POS.length, 3, 'POS 是 [x, y, z]');
  assert.ok(DRAGON_CHEST.MODEL.length > 0, '用现成的宝箱模型，不另做素材');
  assert.ok(DRAGON_CHEST.ORB_COUNT > 0 && DRAGON_CHEST.ORB_DUR_MIN > 0);
  assert.ok(DRAGON_CHEST.ORB_DUR_MIN <= DRAGON_CHEST.ORB_DUR_MAX, '光点时长区间要合法');
});

test('第五十修 · 宝箱摆在**选项卡原本的位置**，不另起一套坐标', () => {
  // 现场口径「宝箱出现在原来选项卡的位置」→ 直接引用 CARD 的行坐标，避免两处坐标漂移
  assert.equal(DRAGON_CHEST.POS[1], CARD.ROW_Y);
  assert.equal(DRAGON_CHEST.POS[2], CARD.ROW_Z);
  assert.equal(typeof CARD.ROW_Y, 'number');
  assert.equal(typeof CARD.ROW_Z, 'number');
  assert.ok(Number.isFinite(DRAGON_CHEST.POS[1]) && Number.isFinite(DRAGON_CHEST.POS[2]),
    '坐标必须是数字（CARD 常量写错时 POS 会变成 undefined，宝箱就摆不出来）');
});

// ---------- ② 顺序：宝箱窗口必须挡住通关抽卡 ----------

test('第五十修 · 开箱判据：只认「第12关 + 龙 Boss 清完 + 本关没开过」', async () => {
  const { Game } = await import('../src/game/game.js');
  const g = Object.create(Game.prototype);
  g.dragon = {}; g._chestDone = false; g.levelIndex = 11;    // LEVELS[11] = 第12关
  assert.equal(g._chestDue(), true);
  g.levelIndex = 0;
  assert.equal(g._chestDue(), false, '第1关不能开宝箱');
  g.levelIndex = 11; g.dragon = null;
  assert.equal(g._chestDue(), false, '没有龙 Boss 就不开（第18关魔术师关不能顺带开）');
  g.dragon = {}; g._chestDone = true;
  assert.equal(g._chestDue(), false, '本关已开过 → 不再开第二次');
});

test('第五十修 · 窗口期内 _chestRunning 为真（调用方据此 return，不去开抽卡）', async () => {
  const { Game } = await import('../src/game/game.js');
  const g = Object.create(Game.prototype);
  assert.equal(g._chestRunning(), false, '还没有实例 → 不挡');
  g._chest = { running: false };
  assert.equal(g._chestRunning(), false);
  g._chest = { running: true };
  assert.equal(g._chestRunning(), true, '计数/飞行期必须挡住通关抽卡');
});

// ---------- ③ 治疗术士：回的是「飞毯血量」20 + 绿色加号 / 横幅 ----------

test('第五十修 · 治疗术士击败后回的是飞毯血量 20（原为 30）', () => {
  assert.equal(ENEMY_TYPES.heart.shipHealOnDeath, 20);
});

test('第五十修 · 回血表现：绿色加号（不是粉色），在场且参数合法', () => {
  assert.equal(HEAL_ON_DEATH.ENABLED, true);
  assert.ok(HEAL_ON_DEATH.PLUS_COUNT >= 1, '至少要冒一个加号');
  assert.ok(HEAL_ON_DEATH.DIST > 0, '在准星前方多远出现');
  assert.ok(HEAL_ON_DEATH.TO_DIST > 0 && HEAL_ON_DEATH.SPREAD >= 0);
  assert.ok(HEAL_ON_DEATH.BANNER, '现场还要一行文字提示');
  const c = new THREE.Color(HEAL_ON_DEATH.PLUS_COLOR);
  assert.ok(c.g > c.r && c.g > c.b, '加号是绿色：' + c.getHexString());
});

test('第五十修 · 回血横幅走「同一块 Sprite」的 heal 样式（绿色系，时长自洽）', () => {
  assert.equal(styleConfig('heal'), HEAL_BANNER, 'heal 样式必须复用同一条横幅通道');
  assert.equal(HEAL_BANNER.ENABLED, true);
  assert.ok(HEAL_BANNER.TEXT.includes('飞毯血量'), '文案里是「飞毯血量」，不是「船血」');
  assert.ok(HEAL_BANNER.SECONDS > 0 && HEAL_BANNER.DIST > 0 && HEAL_BANNER.WIDTH > 0);
  assert.ok(HEAL_BANNER.FADE_IN + HEAL_BANNER.FADE_OUT <= HEAL_BANNER.SECONDS,
    '淡入+淡出不能超过总时长，否则永远到不了满亮');
  assert.ok(String(HEAL_BANNER.COLOR).startsWith('#') && String(HEAL_BANNER.BG).startsWith('rgba'));
});

test('第五十修 · 面板文案里不再出现「船血」（一律改称「飞毯血量」）', () => {
  // 只看**代码行**（去掉注释尾巴）：注释里留「船血」当旧称说明没问题，
  // 但玩家看得见的字符串里不能再有「船血」。（「飞船血量」是另一个词，用后行断言排除）
  const BAD = /(?<!飞)船血/;
  for (const rel of ['../src/vr/wrist-ui.js', '../src/ui/hud.js']) {
    const s = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.ok(s.includes('飞毯血量'), rel + ' 里没有「飞毯血量」');
    const hits = s.split('\n')
      .map((line, idx) => [idx + 1, line.split('//')[0]])
      .filter(([, code]) => BAD.test(code));
    assert.deepEqual(hits, [], rel + ' 的可见文案里还留着「船血」');
  }
});

// ---------- ④ 宝箱受击反馈（第五十一修 · 现场「宝箱被打没反馈」）----------
//
// 宝箱不是气球、不进 _collide 的气球循环 ⇒ 不打这条补丁的话，打箱子既没火花也没命中音、
// 箱体也不动，玩家会以为「打不中」。判定收在 game._chestHitTest，且**只认计数窗口期**
// （窗口一过箱子就化光点飞走，不该再吸子弹）。

async function _chestGame(chest) {
  const { Game } = await import('../src/game/game.js');
  const g = Object.create(Game.prototype);
  g._chest = chest;
  g.bullets = {
    active: [],
    released: [],
    release(b) { const i = this.active.indexOf(b); if (i >= 0) this.active.splice(i, 1); this.released.push(b); },
  };
  g.fx = { sparks: [], spark(p, c) { this.sparks.push({ p: p.clone(), c }); } };
  g.audio = { hits: 0, playHit() { this.hits++; } };
  g.haptic = [];
  g._pulseHaptic = function (k) { this.haptic.push(k); };
  return g;
}

function _chestStub() {
  return {
    counting: true,
    punches: 0,
    group: { position: new THREE.Vector3(0, CARD.ROW_Y, CARD.ROW_Z) },
    punch() { this.punches++; },
  };
}

function _bulletAt(x, y, z) {
  const p = new THREE.Vector3(x, y, z);
  return { prevPos: p.clone(), pos: p };
}

test('第五十一修 · 宝箱受击：命中 → 消费子弹 + 箱体压一下 + 火花 + 命中音', async () => {
  const g = await _chestGame(_chestStub());
  const hit = _bulletAt(0.1, CARD.ROW_Y, CARD.ROW_Z);
  const far = _bulletAt(0.1, CARD.ROW_Y + DRAGON_CHEST.HIT_R + 3, CARD.ROW_Z);
  g.bullets.active.push(hit, far);
  g._chestHitTest();
  assert.deepEqual(g.bullets.released, [hit], '只吃掉真命中的那一发');
  assert.deepEqual(g.bullets.active, [far], '打偏的那发留在空中');
  assert.equal(g._chest.punches, 1, '箱体要压一下');
  assert.equal(g.fx.sparks.length, 1, '要有命中火花');
  assert.equal(g.fx.sparks[0].c, DRAGON_CHEST.HIT_SPARK, '火花用宝箱指定色');
  assert.equal(g.audio.hits, 1, '要有命中音');
  assert.deepEqual(g.haptic, ['HIT'], '手柄也要震一下');
});

test('第五十一修 · 宝箱受击：非计数窗口一处都不碰（子弹照飞、箱子不动）', async () => {
  const chest = _chestStub();
  chest.counting = false;
  const g = await _chestGame(chest);
  g.bullets.active.push(_bulletAt(0, CARD.ROW_Y, CARD.ROW_Z));
  g._chestHitTest();
  assert.equal(g.bullets.released.length, 0, '窗口过了就不能再吸子弹');
  assert.equal(chest.punches, 0);
  assert.equal(g.fx.sparks.length, 0);
  assert.equal(g.audio.hits, 0);
});

test('第五十一修 · 宝箱受击：第12关之外（_chest 为 null）每帧都会走到，不能炸', async () => {
  const g = await _chestGame(null);
  g._chestHitTest();
  assert.equal(g.bullets.released.length, 0);
});

test('第五十一修 · 宝箱受击：参数与 getter 齐备（counting 只认 counting 相位）', async () => {
  assert.ok(DRAGON_CHEST.HIT_R > 0, 'HIT_R 要有值，否则永远打不中');
  assert.ok(DRAGON_CHEST.PUNCH_SCALE > 0 && DRAGON_CHEST.PUNCH_DECAY > 0, '压一下要能压、也要能回弹');
  const d = Object.getOwnPropertyDescriptor(DragonChest.prototype, 'counting');
  assert.ok(d && typeof d.get === 'function', 'counting 是只读 getter（外部改不动相位）');
  assert.equal(typeof DragonChest.prototype.punch, 'function');
  const chest = new DragonChest(new THREE.Scene());
  assert.equal(chest.counting, false, 'idle 时不受击');
  chest.start();
  assert.equal(chest.counting, true);
  chest.punch();
  assert.equal(chest._punch, 1, 'punch() 把受击强度拉满，交给 update 回弹');
  chest.hide();
  chest.dispose();
});