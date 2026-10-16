// 第六十修 · 教学关（第 1 关）—— src/content/tutorial.js + src/game/tutorial.js + 前两关卡池
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  TUTORIAL, TUT_DIR_DEG, isTutorialLevel, tutorialEnemyTypes,
  tutorialSpawnPlan, tutorialTimeout, tutorialWaitsKill, eliteHoldOver,
} from '../src/content/tutorial.js';
import { TutorialRunner } from '../src/game/tutorial.js';
import { DIR_TEXT } from '../src/content/spawnDirector.js';
import { attrPoolForLevel, availableAttributes } from '../src/content/cards.js';
import { RAPID_FIRE, SCATTER, TUTORIAL_HINT } from '../src/core/constants.js';
import { TutorialHintBoard } from '../src/game/tutorialHint.js';

// game.js 顶部会 preload 视觉纹理；这里只需一个最小桩（同 preload-queue.test.mjs）
const originalLoad = THREE.TextureLoader.prototype.load;
let Game, WaveManager;
try {
  THREE.TextureLoader.prototype.load = () => new THREE.Texture();
  ({ Game } = await import('../src/game/game.js'));
  ({ WaveManager } = await import('../src/game/waves.js'));
} finally { THREE.TextureLoader.prototype.load = originalLoad; }

// ============================================================
// 1) 脚本数据：段落 / 文案 / 时长 / 出生方位
// ============================================================

test('教学关只认第 1 关；关掉开关即回到旧第 1 关（唯一回退开关）', () => {
  assert.equal(TUTORIAL.LEVEL, 1);
  assert.equal(isTutorialLevel(1), true);
  assert.equal(isTutorialLevel(2), false);
  assert.equal(isTutorialLevel(0), false);
  assert.equal(isTutorialLevel(18), false);
  assert.equal(TUTORIAL.ENABLED, true);
});

test('段落顺序就是稿子顺序：first → card → seed → elite → done', () => {
  assert.deepEqual(TUTORIAL.STAGES, ['first', 'card', 'seed', 'elite', 'done']);
});

test('横幅文案逐条对上稿子（提示 1/2/3/5/6 + 末尾精英横幅）', () => {
  assert.equal(TUTORIAL.BANNER.KILL, '敌人出现，扣动扳机击杀他们');
  assert.equal(TUTORIAL.BANNER.CARD, '很棒的枪法，打破前方气球获得奖励吧');
  assert.equal(TUTORIAL.BANNER.RAPID, '再杀两个试试加倍射速的威力吧');
  assert.equal(TUTORIAL.BANNER.ELITE, '前方精英来袭');
  assert.equal(TUTORIAL.BANNER.SKILL, '射击来不及了，快使用左手侧键的散射技能');
  assert.equal(TUTORIAL.BANNER.DONE, '敌人已清空，拿完奖励去下一个空域');
});

test('超时口径 = 稿子里的 10s / 12s / 15s（精英段只等击杀，不超时）', () => {
  assert.equal(tutorialTimeout('first'), 10);
  assert.equal(TUTORIAL.CARD.TIMEOUT, 12);
  assert.equal(tutorialTimeout('seed'), 15);
  assert.equal(tutorialTimeout('elite'), 0);
  assert.equal(tutorialWaitsKill('first'), true);
  assert.equal(tutorialWaitsKill('seed'), true);
  assert.equal(tutorialWaitsKill('elite'), true);
  assert.equal(tutorialWaitsKill('done'), false);
});

test('出生计划：开局前方 + 左边各一只；五只在前方；精英在内圈一只', () => {
  const first = tutorialSpawnPlan('first');
  assert.equal(first.length, 2);
  assert.deepEqual(first.map((p) => p.dir), ['front', 'frontLeft']);
  assert.ok(first.every((p) => p.type === 'basic'));

  const seed = tutorialSpawnPlan('seed');
  assert.equal(seed.length, 5);
  assert.ok(seed.every((p) => p.type === 'basic' && p.dir === 'front'));

  const elite = tutorialSpawnPlan('elite');
  assert.deepEqual(elite.map((p) => p.type), [TUTORIAL.ELITE.TYPE]);
  assert.equal(TUTORIAL.ELITE.DIST, 9, '精英出生在内圈（SPAWN_RING.INNER_RADIUS = 9m）');
  assert.equal(TUTORIAL.ELITE.SELF_DAMAGE, 0, '教学怪不扣血（教学关不该被打死重开）');
  assert.equal(tutorialSpawnPlan('card').length, 0);
  assert.equal(tutorialSpawnPlan('done').length, 0);
});

test('方位角与 spawnDirector 的文案口径一致（front 0 / frontLeft -45 / frontRight +45）', () => {
  assert.deepEqual(Object.keys(TUT_DIR_DEG).sort(), Object.keys(DIR_TEXT).sort());
  assert.equal(TUT_DIR_DEG.front, 0);
  assert.equal(TUT_DIR_DEG.frontLeft, -45);
  assert.equal(TUT_DIR_DEG.frontRight, 45);
});

test('连杀种到 8：再杀 2 只（= RAPID_FIRE.KILLS）就会触发一次射速加倍', () => {
  assert.equal(TUTORIAL.SEED.STREAK, 8);
  assert.equal(RAPID_FIRE.KILLS - TUTORIAL.SEED.STREAK, 2, '稿子：「再杀两个试试加倍射速」');
});

test('精英血量口径：普通射击打不完、一次能量散射能秒（教学才立得住）', () => {
  const dps = 100 * 2;                            // 基线：100 攻 × 2 发/秒
  assert.ok(TUTORIAL.ELITE.HP / dps >= 15, '普通射击至少要 15s 打不完');
  assert.ok(SCATTER.COUNT * 100 >= TUTORIAL.ELITE.HP, '一次能量散射要能直接秒掉');
  assert.ok(tutorialEnemyTypes().includes('eliteKnight'), '预载口径要含铁甲兵');
  assert.deepEqual(tutorialEnemyTypes().sort(), ['basic', 'eliteKnight']);
});

// ============================================================
// 2) 卡池：前两关不再出现技能相关的选项卡
// ============================================================

test('前两关卡池不含技能相关卡（技能消耗/技能伤害），且不许从全表补位', () => {
  for (const n of [1, 2]) {
    const { pool, strictPool } = attrPoolForLevel(n);
    assert.ok(!pool.includes('skillCost'), '第 ' + n + ' 关不该有「技能消耗-100」');
    assert.ok(!pool.includes('skillDamage'), '第 ' + n + ' 关不该有「技能伤害+1倍」');
    assert.equal(strictPool, true);
    assert.deepEqual(pool, ['fireRate', 'multiShot', 'atk']);
  }
  const late = attrPoolForLevel(3);
  assert.ok(late.pool.includes('skillCost') && late.pool.includes('skillDamage'), '第 3 关起恢复技能卡');
  assert.equal(late.strictPool, false);
});

test('strict 池：三张吃满也不把技能卡补回来，退化为战场补给', () => {
  const maxed = { fireRate: 20, shotCount: 12, atk: 700 };
  const { pool, strictPool } = attrPoolForLevel(1);
  assert.deepEqual(availableAttributes(maxed, pool, strictPool).map((c) => c.id), ['resupply']);
  // 非 strict（第 3 关起）仍会补位到别的可成长属性
  // 非 strict（第 3 关起）照旧从全表补位凑够三张：只捡「还能成长」的属性，
  // 已达上限的射速/子弹/攻击不再出现（技能卡本来就在 loose 池里，不在补位口径内）
  const loose = attrPoolForLevel(5);
  const ids = availableAttributes(maxed, loose.pool, loose.strictPool).map((c) => c.id);
  assert.equal(ids.length, 3, '补位要凑够三张');
  assert.ok(ids.includes('selfRepair'), '补位按「还能成长」判据捡起没满的属性');
  assert.ok(!ids.includes('fireRate') && !ids.includes('multiShot') && !ids.includes('atk'), '已满的属性不补位');
});

// ============================================================
// 3) 免费技能（精英段）：无消耗、无冷却
// ============================================================

test('教学免费段：散射不进冷却（_skillCdTotal → 0）', () => {
  const free = Game.prototype._skillCdTotal.call({
    _tutorialFreeSkill: true, selectedSkill: 'scatter', player: {},
  });
  assert.equal(free, 0);
  const paid = Game.prototype._skillCdTotal.call({
    _tutorialFreeSkill: false, selectedSkill: 'scatter', player: {},
  });
  assert.ok(paid > 0, '非教学段仍按 SCATTER.COOLDOWN 走冷却');
});

test('教学免费段：散射不扣能量（能量 0 也能放）', () => {
  let spawned = 0;
  const ctx = {
    _tutorialFreeSkill: true,
    score: 0,
    player: { skillCost: 500, atk: 100, skillDamageMul: 1 },
    input: { getMuzzle: (m, d) => { m.set(0, 1, 0); d.set(0, 0, -1); } },
    bullets: { spawn: () => { spawned++; } },
    log: () => {},
    hud: { setScore: () => {} },
  };
  assert.equal(Game.prototype._castScatter.call(ctx), true, '免费时应当放得出来');
  assert.equal(spawned, SCATTER.COUNT, '弹头数不变');
  assert.equal(ctx.score, 0, '教学段不扣能量');
});

test('教学免费段：非免费时能量不足照旧放不出来（不破坏既有规则）', () => {
  const ctx = {
    _tutorialFreeSkill: false,
    score: 0,
    player: { skillCost: 500, atk: 100, skillDamageMul: 1 },
    input: { getMuzzle: () => {} },
    bullets: { spawn: () => { throw new Error('不该出弹'); } },
    log: () => {},
    hud: { setScore: () => {} },
  };
  assert.equal(Game.prototype._castScatter.call(ctx), false);
});

// ============================================================
// 4) waves 让步：教学关不出脚本怪、不开滴流、没有倒计时
// ============================================================

test('教学关没有倒计时（_stopAt → Infinity），其它关照旧', () => {
  assert.equal(WaveManager.prototype._stopAt.call({ level: { n: 1 } }), Infinity);
  assert.equal(WaveManager.prototype._stopAt.call({ level: { n: 2 } }), 40);
  assert.equal(WaveManager.prototype._stopAt.call({ level: { n: 7 } }), 50);
});

// ============================================================
// 5) 运行态：整条链走一遍 + 超时分支
// ============================================================

function fakeGame() {
  const g = {
    _levelTitleDone: false,
    _gameTime: 0,
    _bulletStreak: 3, _rapidUntil: 9, _rapidMul: 0.5,
    _tutorialFreeSkill: false,
    _skillCasts: 0,
    logs: [], spawned: [], banners: [],
    cardOpens: 0, finishes: 0, hints: [], hintHidden: 0,
    _bannerBusy: false,
    balloons: { list: [], remove(b) { const i = this.list.indexOf(b); if (i >= 0) this.list.splice(i, 1); } },
  };
  g.log = (m) => g.logs.push(m);
  g._setRapidMul = (m) => { g._rapidMul = m; };
  g._showBanner = (text) => { g.banners.push(text); g._bannerBusy = true; };
  g.midWarning = { get showing() { return g._bannerBusy; } };
  g._enterTutorialCard = () => { g.cardOpens++; };
  g._finishTutorial = () => { g.finishes++; };
  g._showTutorialHint = (t) => { g.hints.push(t); };   // 第六十二修：常驻提示板
  g._hideTutorialHint = () => { g.hintHidden++; };
  g.waves = {
    _pendingSpawns: [],
    _spawnPos: (r, o) => ({ r, o }),
    _queueSpawn: (type, pos, opts) => { g.waves._pendingSpawns.push({ type, pos, opts }); },
    _removeBeam: () => {},
  };
  return g;
}
/** 光点落地 → 变成场上的气球 */
function land(g) {
  for (const it of g.waves._pendingSpawns.splice(0)) {
    const b = Object.assign({ type: it.type, alive: true }, it.opts.balloon || null);
    if (it.opts.onSpawn) it.opts.onSpawn(b);
    g.balloons.list.push(b);
  }
}
const wipe = (g) => { for (const b of [...g.balloons.list]) g.balloons.remove(b); };
const bannerOff = (g) => { g._bannerBusy = false; };

test('教学关全程：名字横幅 → 两只 → 单卡 → 种连杀+五只 → 内圈精英+免费技能 → 收尾三选一', () => {
  const g = fakeGame();
  const r = new TutorialRunner(g);

  // ① 关卡名字还没弹完 → 什么都不做（稿子第 0 条的前提）
  r.update(0.5);
  assert.equal(g.balloons.list.length, 0);
  assert.equal(g.banners.length, 0);

  // ② 名字播完 + 横幅已收掉 → 开场：前方 + 左边各一只 + 横幅1
  g._levelTitleDone = true;
  r.update(0.1);
  assert.deepEqual(g.banners, [TUTORIAL.BANNER.KILL]);
  land(g);
  assert.equal(g.balloons.list.length, 2, '开局两只小怪');
  assert.deepEqual(g.balloons.list.map((b) => b.tutorialWave), [1, 1]);

  // ③ 打完 + 横幅1 收掉 → 横幅2；横幅2 收掉后才弹单张卡（同一块 Sprite，不压卡面）
  wipe(g);
  bannerOff(g);
  r.update(0.1);
  assert.equal(g.banners[1], TUTORIAL.BANNER.CARD);
  assert.equal(g.cardOpens, 0, '横幅还在时不弹卡');
  bannerOff(g);
  r.update(0.1);
  assert.equal(g.cardOpens, 1, '横幅收掉后才弹卡');

  // ④ 卡拿走 → 连杀种到 8 + 前方五只 + 横幅3
  r.onCardDone();
  bannerOff(g);
  r.update(0.1);
  assert.equal(g._bulletStreak, TUTORIAL.SEED.STREAK, '连杀数重置为 8');
  assert.equal(g._rapidUntil, 0, '种连杀时不顺带开加速');
  assert.equal(g._rapidMul, 1);
  land(g);
  assert.equal(g.balloons.list.length, 5, '前方五只小怪');
  assert.equal(g.banners[2], TUTORIAL.BANNER.RAPID);

  // ⑤ 五只打完 + 横幅收掉 → 末尾精英横幅 + 内圈精英 + 散射免费
  wipe(g);
  bannerOff(g);
  r.update(0.1);
  land(g);
  assert.equal(g.balloons.list.length, 1, '内圈一只精英');
  const elite = g.balloons.list[0];
  assert.equal(elite.type, TUTORIAL.ELITE.TYPE);
  assert.equal(elite.hp, TUTORIAL.ELITE.HP);
  assert.equal(elite.isElite, true);
  assert.equal(elite.selfDamage, TUTORIAL.ELITE.SELF_DAMAGE);
  assert.equal(g._tutorialFreeSkill, true, '精英段散射免费');
  assert.equal(g.banners[3], TUTORIAL.BANNER.ELITE);

  // ⑤b 「前方精英来袭」播完 HINT_DELAY 秒 → 才提示用散射（同一块 Sprite，排队弹）
  bannerOff(g);
  r.update(TUTORIAL.ELITE.HINT_DELAY + 0.1);
  assert.equal(g.banners[4], TUTORIAL.BANNER.SKILL);
  assert.equal(g.balloons.list.length, 1, '精英没死 → 不推进');

  // ⑥ 精英被打死 → 横幅6 + 免费关掉 + 正常三选一
  wipe(g);
  bannerOff(g);
  r.update(0.1);
  assert.equal(g.banners[5], TUTORIAL.BANNER.DONE);
  assert.equal(g._tutorialFreeSkill, false, '精英死了就恢复收费');
  assert.equal(g.finishes, 0, '横幅还在播 → 先别开卡');
  bannerOff(g);
  r.update(TUTORIAL.DONE.CARD_DELAY + 0.1);
  assert.equal(g.finishes, 1);
  assert.equal(r.done, true);
  r.update(1);
  assert.equal(g.finishes, 1, '收尾只做一次');
});

test('超时分支：横幅1 后 10s 没打完 → 残兵消失并继续（不软锁）', () => {
  const g = fakeGame();
  const r = new TutorialRunner(g);
  g._levelTitleDone = true;
  r.update(0.1);
  land(g);
  assert.equal(g.balloons.list.length, 2);
  bannerOff(g);
  r.update(TUTORIAL.FIRST.TIMEOUT + 0.1);
  assert.equal(g.balloons.list.length, 0, '稿子：「敌人全部消失」');
  assert.equal(g.banners[1], TUTORIAL.BANNER.CARD, '超时也要往下走');
});

test('光点还在飞的那几只也算「没打完」：不能被误判成清空（横幅1 不被横幅2 顶掉）', () => {
  const g = fakeGame();
  const r = new TutorialRunner(g);
  g._levelTitleDone = true;
  r.update(0.1);                       // 两只光点起飞，还没落地
  assert.equal(g.waves._pendingSpawns.length, 2);
  bannerOff(g);
  r.update(0.1);
  assert.equal(g.banners.length, 1, '还在飞 → 判据不放行');
  assert.equal(g.banners[0], TUTORIAL.BANNER.KILL);
});

test('精英段没有超时：精英没死就一直等（靠它自己走到飞毯边自爆收场）', () => {
  const g = fakeGame();
  const r = new TutorialRunner(g);
  g._levelTitleDone = true;
  const step = (t) => { bannerOff(g); r.update(t); };
  step(0.1); land(g); wipe(g);            // first：出两只 → 打完
  step(0.1);                              // → 横幅2
  step(0.1);                              // 横幅2 收掉 → 开教学卡
  r.onCardDone(); step(0.1); land(g);     // 卡拿走 → seed 五只
  wipe(g); step(0.1); land(g);            // 打完五只 → elite 一只
  assert.equal(g.balloons.list.length, 1, '精英在场');
  r.update(999);                          // 等很久（顺带把「用散射」提示排上）
  assert.equal(g.finishes, 0, '精英没死不推进');
  assert.equal(g.balloons.list.length, 1, '精英还在场上');
  wipe(g);
  bannerOff(g);
  r.update(0.1);                          // 精英没了 → 排「敌人已清空」
  bannerOff(g);
  r.update(0.1);                          // 上一块收掉 → 横幅6 弹出来
  assert.equal(g.banners[g.banners.length - 1], TUTORIAL.BANNER.DONE);
  assert.equal(g.finishes, 0, '横幅还在播 → 先别交回 game');
  bannerOff(g);
  r.update(TUTORIAL.DONE.CARD_DELAY + 0.1);
  assert.equal(g.finishes, 1, '横幅收掉 + CARD_DELAY 后才交回 game');
});

// ============================================================
// 6) 第六十二修：常驻提示板 / 教学精英先暂停 / 通关送 500 商店币
// ============================================================

test('常驻提示板：第六十三修已停用，但位置/尺寸参数保留（想开回来只改 ENABLED）', () => {
  assert.equal(TUTORIAL_HINT.ENABLED, false, '现场改口径：不要固定板子，只留 4 秒一次性横幅');
  assert.ok(TUTORIAL_HINT.POSITION.y >= 3.5, '举到视线上方，才不挡玩家看怪');
  assert.ok(TUTORIAL_HINT.POSITION.z < 0, '在玩家前方（-Z 是场地正前）');
  assert.equal(TUTORIAL_HINT.MAX_LINES, 3, '一次性横幅 2 行；常驻板要放 3 行');
  assert.ok(TUTORIAL_HINT.TEXT_LEFT > TUTORIAL_HINT.TAG_W, '文字区要让开左边那枚「教学」标签');
  assert.ok(TUTORIAL_HINT.WIDTH >= 2, '板子太窄看不见');
  assert.ok(TUTORIAL_HINT.FADE_IN > 0, '换新提示要有淡入感');
  assert.ok(TUTORIAL_HINT.TEXT_SIZE > TUTORIAL_HINT.MIN_SIZE, '初始字号要留出降字号余量');
  // 最长的一句（稿子里的技能提示 19 字）按初始字号折 3 行必须放得下，否则现场就要降字号变小
  const perChar = 0.5;                      // 中文实测量宽口径：约 0.5em
  const maxW = TUTORIAL_HINT.CANVAS.w - TUTORIAL_HINT.TEXT_LEFT - TUTORIAL_HINT.TEXT_RIGHT;
  const longest = Object.values(TUTORIAL.BANNER).reduce((a, b) => (b.length > a.length ? b : a), '');
  const need = (longest.length * TUTORIAL_HINT.TEXT_SIZE * perChar) / TUTORIAL_HINT.MAX_LINES;
  assert.ok(need <= maxW, '最长文案 ' + longest.length + ' 字按初始字号折 3 行也要放得下');
});

test('常驻提示板：换字才重绘、每次重新淡入；同文案不重绘；hide 立刻收起', () => {
  const added = [];
  // 板子已默认停用，这里显式打开来验证「机制本身」仍完好（随时能开回来）
  const board = new TutorialHintBoard({ add: (o) => added.push(o), remove: () => {} }, { ...TUTORIAL_HINT, ENABLED: true });
  assert.equal(added.length, 1, '构造即挂到场景上（越早越好：别被「穿云」当成新物体从 0 淡入）');
  assert.equal(board.showing, false, '构造时是收起的（只在教学关显示）');
  board.show(TUTORIAL.BANNER.KILL);
  assert.equal(board.showing, true);
  assert.equal(board.text, TUTORIAL.BANNER.KILL);
  const tex = board.tex;
  assert.equal(board.mat.opacity, 0, '每次 show 都从 0 淡入');
  board.update(TUTORIAL_HINT.FADE_IN);
  assert.equal(board.mat.opacity, 1, '淡入结束就全不透明（之后不再每帧写材质）');
  board.show(TUTORIAL.BANNER.DONE);
  assert.equal(board.text, TUTORIAL.BANNER.DONE, '换到下一块横幅才换字');
  assert.equal(board.tex, tex, '复用同一块画布纹理，不重建');
  board.show('');
  assert.equal(board.text, TUTORIAL.BANNER.DONE, '空文案直接忽略（不会把板子清成空白）');
  board.hide();
  assert.equal(board.showing, false);
  board.dispose();
});

test('精英暂停解除判据：放过技能 或 等够 HOLD_SECONDS（普通射击不算解除）', () => {
  const H = TUTORIAL.ELITE.HOLD_SECONDS;
  assert.ok(H > 0, '默认必须冻一会儿（现场：玩家来不及思考，精英已经撞上场地了）');
  assert.equal(eliteHoldOver(0, false), false, '刚出现、还没放技能 → 冻着');
  assert.equal(eliteHoldOver(H - 0.01, false), false, '差一点没到点 → 继续冻');
  assert.equal(eliteHoldOver(H, false), true, '等够秒数 → 解除');
  assert.equal(eliteHoldOver(0, true), true, '放过技能 → 立刻解除（散射才是正解）');
  assert.equal(eliteHoldOver(999, true), true, '两个条件都满足也不出错');
});

test('精英暂停：落地就冻住（moveFrozen），等够秒数或放过技能才放开给 balloon.update 走', () => {
  const g = fakeGame();
  const r = new TutorialRunner(g);
  const toElite = () => {
    g._levelTitleDone = true;
    r.update(0.1); land(g); wipe(g);                        // ① 开局两只 → 打完
    bannerOff(g); r.update(0.1);                            // → 横幅2
    bannerOff(g); r.update(0.1);                            // 横幅2 收掉 → 开单卡
    r.onCardDone(); bannerOff(g); r.update(0.1); land(g); wipe(g);   // ② 卡拿走 → 前方五只 → 打完
    bannerOff(g); r.update(0.1); land(g);                   // ③ → 内圈精英一只
    return g.balloons.list[0];
  };
  const elite = toElite();
  assert.equal(elite.moveFrozen, true, '落地先冻住，等玩家读完提示');
});

test('精英暂停：秒表到点自动放开（有日志留痕）', () => {
  const g = fakeGame();
  const r = new TutorialRunner(g);
  g._levelTitleDone = true;
  const step = (t) => { bannerOff(g); r.update(t); };
  step(0.1); land(g); wipe(g);
  step(0.1); step(0.1); r.onCardDone(); step(0.1); land(g); wipe(g);
  step(0.1); land(g);
  const elite = g.balloons.list[0];
  assert.equal(elite.moveFrozen, true);
  r.update(TUTORIAL.ELITE.HOLD_SECONDS - 1);
  assert.equal(elite.moveFrozen, true, '不到 ' + TUTORIAL.ELITE.HOLD_SECONDS + 's 不放行');
  r.update(1.5);
  assert.equal(elite.moveFrozen, false, '等够秒数 → 放开');
  assert.ok(g.logs.some((m) => m.indexOf('解除暂停') >= 0), '放开要留一条日志');
});

test('精英暂停：玩家一放技能就立刻放开（不用等秒表）', () => {
  const g = fakeGame();
  const r = new TutorialRunner(g);
  g._levelTitleDone = true;
  const step = (t) => { bannerOff(g); r.update(t); };
  step(0.1); land(g); wipe(g);
  step(0.1); step(0.1); r.onCardDone(); step(0.1); land(g); wipe(g);
  step(0.1); land(g);
  const elite = g.balloons.list[0];
  assert.equal(elite.moveFrozen, true);
  g._skillCasts++;                                          // 放过一次散射
  r.update(0.1);
  assert.equal(elite.moveFrozen, false, '技能一放就解除，不看秒表');
});

test('常驻提示板：每条横幅都同时钉到板子上（横幅 2s 太短），教学关一结束就收起', () => {
  const g = fakeGame();
  const r = new TutorialRunner(g);
  g._levelTitleDone = true;
  const step = (t) => { bannerOff(g); r.update(t); };
  r.update(0.1); land(g); wipe(g);                          // ① 横幅1
  step(0.1); step(0.1);                                     // 横幅2 → 单卡
  r.onCardDone(); step(0.1); land(g); wipe(g);              // 横幅3 + 前方五只
  step(0.1); land(g);                                       // 横幅4 + 内圈精英
  step(TUTORIAL.ELITE.HINT_DELAY + 0.1);                    // 横幅5（用散射）
  wipe(g); step(0.1);                                       // 横幅6（敌人已清空）
  step(TUTORIAL.DONE.CARD_DELAY + 0.1);                     // 收尾
  assert.deepEqual(g.hints, [
    TUTORIAL.BANNER.KILL, TUTORIAL.BANNER.CARD, TUTORIAL.BANNER.RAPID,
    TUTORIAL.BANNER.ELITE, TUTORIAL.BANNER.SKILL, TUTORIAL.BANNER.DONE,
  ], '板上写的和刚闪的横幅必须是同一句（同源下发）');
  assert.equal(g.finishes, 1, '先确认流程真的走完了');
  assert.equal(g.hintHidden, 1, '出教学关就收起提示板，不跨关留着');
});

test('教学关通关送 500 商店币（教学关专属：第 2~18 关通关一律不奖励）', () => {
  assert.equal(TUTORIAL.DONE.SHOP_COIN, 500);
  assert.ok(TUTORIAL.DONE.CARD_DELAY >= 0, '送币不改「等横幅收掉再弹卡」的节奏');
  for (const n of [2, 3, 9, 15, 18]) assert.equal(isTutorialLevel(n), false, '只有第 1 关是教学关');
});

test('送币逻辑：_finishTutorial 只加那 500，且不经 _addShopCoin（不是击杀入账）', () => {
  const ctx = {
    _tutorialFreeSkill: true,
    shopCoin: 120,
    logs: [], coinSet: [],
    _hideTutorialHint: () => { ctx.hintHidden = true; },
    _enterCard: () => { ctx.cardEntered = true; },
    log(m) { ctx.logs.push(m); },
    hud: { setShopCoin(v) { ctx.coinSet.push(v); } },
    _addShopCoin() { throw new Error('教学奖励不该走击杀入账路径（那条带「以战养战」加成）'); },
  };
  Game.prototype._finishTutorial.call(ctx);
  assert.equal(ctx.shopCoin, 620, '120 + 500，原样入账');
  assert.deepEqual(ctx.coinSet, [620], 'HUD 同步一次');
  assert.ok(ctx.logs.some((m) => m.indexOf('教学关通关奖励：+500') >= 0), '日志留一句「+500」便于现场核对');
  assert.equal(ctx._tutorialFreeSkill, false, '收尾同时关掉教学免费技能');
  assert.equal(ctx.hintHidden, true, '收起常驻提示板');
  assert.equal(ctx.cardEntered, true, '照旧交回三选一');
});

test('送币：把 SHOP_COIN 调成 0 就一分不给（唯一回退开关）', () => {
  const before = TUTORIAL.DONE.SHOP_COIN;
  TUTORIAL.DONE.SHOP_COIN = 0;
  try {
    const ctx = {
      _tutorialFreeSkill: true,
      shopCoin: 120,
      coinSet: [],
      _hideTutorialHint: () => {},
      _enterCard: () => {},
      log: () => {},
      hud: { setShopCoin(v) { ctx.coinSet.push(v); } },
      _addShopCoin() { throw new Error('不该被调用'); },
    };
    Game.prototype._finishTutorial.call(ctx);
    assert.equal(ctx.shopCoin, 120, '不送就一分不动');
    assert.deepEqual(ctx.coinSet, [], '也不去动 HUD');
  } finally { TUTORIAL.DONE.SHOP_COIN = before; }
});
