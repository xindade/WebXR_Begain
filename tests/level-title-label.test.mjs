// 第四十九修 · 关卡标题卡 + 精英名牌两套样式
//
// 为什么值得锁死：
//   ① 关卡名是「一行文案 + 三条判据」，写错（漏名字、机制关也弹）现场才看得出来；
//   ② 名牌两套样式共用一份绘制代码，靠的是**配置字段**区分 —— 少一个字段就会画成同一个样子，
//      而且 canvas 绘制在单测里没有像素可比，只能断言「画笔用对了颜色/参数」。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LEVELS, levelName, levelTitleText, shouldShowLevelTitle, isLaser } from '../src/content/levels.js';
import { LEVEL_TITLE, ELITE_LABEL, BOSS_LABEL, MID_WARNING, CLOUD } from '../src/core/constants.js';
import { WarningBanner3D, styleConfig } from '../src/game/warningBanner.js';
import { Balloon } from '../src/game/balloons.js';

// 记录型 Canvas2D 上下文：把 set / 调用都记下来。canvas 在单测里是桩，没有像素，
// 只能靠「画笔收到过什么」来断言绘制行为。
function recCtx() {
  const calls = [];
  const sets = [];
  const gradient = { addColorStop: (o, c) => calls.push(['addColorStop', o, c]) };
  const ctx = new Proxy({}, {
    get: (_t, k) => {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient;
      if (k === 'measureText') return (s) => ({ width: String(s).length * 40 });
      return (...args) => { calls.push([String(k), ...args]); };
    },
    set: (_t, k, v) => { sets.push([String(k), v]); return true; },
  });
  return { ctx, calls, sets, lastSet: (k) => { const hit = sets.filter((s) => s[0] === k); return hit.length ? hit[hit.length - 1][1] : undefined; } };
}

const cam = () => {
  const c = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
  c.position.set(0, 1.6, 0);
  c.lookAt(0, 1.6, -1);
  c.updateMatrixWorld(true);
  return c;
};

// ---------- ① 关卡名 ----------

test('18 关每关都有场景名（机制关 3/9/15 共用「魔术空间」，其余互不相同）', () => {
  assert.equal(LEVELS.length, 18);
  const names = LEVELS.map((lv) => lv.name);
  for (const lv of LEVELS) {
    assert.equal(typeof lv.name, 'string', `第 ${lv.n} 关没写 name`);
    assert.ok(lv.name.trim().length > 0, `第 ${lv.n} 关的 name 是空的`);
  }
  // 现场口径（第二轮）：三个机制关统一叫「魔术空间」（同一个主题）⇒ 唯一性判据要排掉机制关
  const mech = LEVELS.filter((lv) => isLaser(lv)).map((lv) => lv.name);
  assert.deepEqual([...new Set(mech)], ['魔术空间'], '机制关统一叫「魔术空间」');
  const others = LEVELS.filter((lv) => !isLaser(lv)).map((lv) => lv.name);
  assert.equal(new Set(others).size, others.length, '非机制关的关卡名不能重复');
  assert.ok(!others.includes('魔术空间'), '机制关的名字不该被非机制关占用');
  assert.equal(new Set(names).size, names.length - 2, '三个机制关共用一个名字 ⇒ 唯一名少 2 个');
});

test('levelName：查得到、越界给空串（调用方据此不弹卡）', () => {
  assert.equal(levelName(1), LEVELS[0].name);
  assert.equal(levelName(18), LEVELS[17].name);
  assert.equal(levelName(0), '');
  assert.equal(levelName(19), '');
  assert.equal(levelName(undefined), '');
});

test('levelTitleText：把 {n} / {name} 填好；没名字的关卡给空串', () => {
  assert.equal(levelTitleText(4, '第 {n} 关 · {name}'), '第 4 关 · ' + levelName(4));
  assert.equal(levelTitleText(18, '第 {n} 关 · {name}'), '第 18 关 · ' + levelName(18));
  assert.equal(levelTitleText(99, '第 {n} 关 · {name}'), '', '未定义的关卡不该出现「第 99 关 · 」');
  // 模板没占位符也不炸
  assert.equal(levelTitleText(1, '开始'), '开始');
});

test('标题卡判据：总开关 / 机制关跳过 / 无名不弹', () => {
  const lv1 = LEVELS[0];
  const lv3 = LEVELS.find((l) => l.n === 3);
  assert.ok(isLaser(lv3), '第 3 关是机制关');
  assert.equal(shouldShowLevelTitle(lv1, LEVEL_TITLE), true);
  // 第四十九修（返工）：现场「机制关看不到关卡名」⇒ 改成**延后弹**（等魔术师收场），不再直接跳过
  assert.equal(shouldShowLevelTitle(lv3, LEVEL_TITLE), true, '机制关也要显示关卡名（延后弹，见 MECHANIC_DELAY）');
  assert.equal(shouldShowLevelTitle(lv3, { ...LEVEL_TITLE, SKIP_MECHANIC: true }), false, '逃生开关：置 true 就不弹');
  assert.equal(shouldShowLevelTitle(lv1, { ...LEVEL_TITLE, ENABLED: false }), false);
  assert.equal(shouldShowLevelTitle(null, LEVEL_TITLE), false);
  assert.equal(shouldShowLevelTitle({ n: 99, kind: 'normal' }, LEVEL_TITLE), false, '没名字 → 不弹');
});

test('标题卡配置：文案带占位符、尺寸与时长为正、延迟不为负', () => {
  assert.ok(LEVEL_TITLE.ENABLED);
  assert.ok(LEVEL_TITLE.TEXT.includes('{n}') && LEVEL_TITLE.TEXT.includes('{name}'));
  assert.ok(LEVEL_TITLE.DELAY >= 0 && LEVEL_TITLE.SECONDS > 0);
  assert.ok(LEVEL_TITLE.FADE_IN > 0 && LEVEL_TITLE.FADE_OUT > 0);
  assert.ok(LEVEL_TITLE.FADE_IN + LEVEL_TITLE.FADE_OUT < LEVEL_TITLE.SECONDS, '淡入淡出不能吃掉整张卡');
  assert.ok(LEVEL_TITLE.WIDTH > 0 && LEVEL_TITLE.DIST > 0);
});

// ---------- ② 横幅样式 ----------

test('styleConfig：title → LEVEL_TITLE；其它（含不传）→ MID_WARNING（老调用点行为不变）', () => {
  assert.equal(styleConfig('title'), LEVEL_TITLE);
  assert.equal(styleConfig('warn'), MID_WARNING);
  assert.equal(styleConfig(undefined), MID_WARNING);
  assert.equal(styleConfig('乱写'), MID_WARNING);
});

test('横幅：换 title 样式后尺寸/时长跟着换，到点自动隐藏', () => {
  const b = new WarningBanner3D(new THREE.Scene(), cam());
  b.show('前方精英来袭');
  assert.ok(Math.abs(b.sprite.scale.x - MID_WARNING.WIDTH) < 1e-6, '默认还是警告尺寸');
  assert.equal(b._seconds, MID_WARNING.SECONDS);

  b.show('第 1 关 · 落日余晖', 'title');
  assert.ok(Math.abs(b.sprite.scale.x - LEVEL_TITLE.WIDTH) < 1e-6, '标题卡用 LEVEL_TITLE.WIDTH');
  assert.equal(b._seconds, LEVEL_TITLE.SECONDS);
  assert.equal(b.sprite.visible, true);

  b.update(LEVEL_TITLE.FADE_IN / 2);
  assert.ok(Math.abs(b.mat.opacity - 0.5) < 1e-6, '淡入到一半 = 半透明');
  b.update(LEVEL_TITLE.SECONDS);
  assert.equal(b.sprite.visible, false, '超时自动收掉');
  assert.equal(b.mat.opacity, 0);
});

test('横幅：跟准星定位 —— 前方 DIST、并上抬 RISE（标题卡不压准星）', () => {
  const c = cam();
  const b = new WarningBanner3D(new THREE.Scene(), c);
  b.show('第 2 关 · 长夜突袭', 'title');
  b.update(0.01);
  const p = b.sprite.position;
  assert.ok(Math.abs(p.z - (c.position.z - LEVEL_TITLE.DIST)) < 1e-6, '落在准星正前方');
  assert.ok(Math.abs(p.y - (c.position.y + LEVEL_TITLE.RISE)) < 1e-6, '上抬 RISE');
});

test('标题卡绘制：用配置色描边 + 居中写文案；文案过长自动缩字号', () => {
  const b = new WarningBanner3D(new THREE.Scene(), cam());
  const r1 = recCtx();
  b._drawTitle(r1.ctx, '第 1 关 · 落日余晖');
  const txt1 = r1.calls.filter((c) => c[0] === 'fillText' || c[0] === 'strokeText');
  assert.equal(txt1.length, 2, '先描边再压字');
  assert.deepEqual(txt1[0], ['strokeText', '第 1 关 · 落日余晖', 512, 132]);
  assert.deepEqual(txt1[1], ['fillText', '第 1 关 · 落日余晖', 512, 132]);
  assert.ok(r1.sets.some(([k, v]) => k === 'strokeStyle' && v === LEVEL_TITLE.COLOR), '边框用配置色');
  assert.equal(r1.lastSet('font'), 'bold 92px sans-serif', '短文案不缩字号');

  const r2 = recCtx();
  b._drawTitle(r2.ctx, '第 一百二十八 关 · 一段特别特别长的场景名字测试');
  const size = Number(/bold (\d+)px/.exec(r2.lastSet('font'))[1]);
  assert.ok(size < 92, '长文案要自动降字号（否则会顶出卡片）');
  assert.ok(size >= 40, '但别缩到看不见');
});

test('警告样式仍是老样子：左右两个警示三角 + 文案（别把中场预警画成标题卡）', () => {
  const b = new WarningBanner3D(new THREE.Scene(), cam());
  const r = recCtx();
  b._drawTitle(r.ctx, 'x');            // 先画一次 title，确认切换样式时会重绘
  const r2 = recCtx();
  b._drawWarn(r2.ctx, '前方精英来袭');
  const txt = r2.calls.filter((c) => c[0] === 'fillText');
  assert.equal(txt.length, 3, '两个「!」+ 一行文案');
  assert.deepEqual(txt[2], ['fillText', '前方精英来袭', 512, 132]);
  assert.ok(r2.sets.some(([k, v]) => k === 'strokeStyle' && v === MID_WARNING.COLOR));
});

test('同一实例两种样式交替：文本或样式变了才重绘（省纹理上传）', () => {
  const b = new WarningBanner3D(new THREE.Scene(), cam());
  const seen = [];
  const orig = b._draw.bind(b);
  b._draw = (text, style) => { seen.push(style); return orig(text, style); };
  b.show('A');
  b.show('A');
  assert.equal(seen.length, 1, '同文同样式不重绘');
  b.show('A', 'title');
  assert.equal(seen.length, 2, '换样式必须重绘');
  b.show('B', 'title');
  assert.equal(seen.length, 3, '换文案必须重绘');
  b.show('B', 'title');
  assert.equal(seen.length, 3);
});

// ---------- ③ 精英名牌两套样式 ----------

test('名牌配置分两档：Boss 更大更亮、带装饰与发光；普通精英朴素', () => {
  assert.ok(BOSS_LABEL.SCALE[0] > ELITE_LABEL.SCALE[0], 'Boss 名牌更大');
  assert.notEqual(BOSS_LABEL.EDGE, ELITE_LABEL.EDGE, '两者边框色必须不同');
  assert.equal(ELITE_LABEL.ORNAMENT, 'none');
  assert.equal(BOSS_LABEL.ORNAMENT, 'diamond');
  assert.ok(BOSS_LABEL.GLOW > 0);
  assert.equal(ELITE_LABEL.GLOW, 0);
  // 宽高比必须与画布一致，否则字会被拉扁
  for (const S of [ELITE_LABEL, BOSS_LABEL]) {
    assert.ok(Math.abs(S.SCALE[0] / S.SCALE[1] - S.CANVAS_W / S.CANVAS_H) < 0.02, 'SCALE 与画布宽高比不一致');
  }
});

test('普通精英名牌：冰蓝描边 + 四角括号，无菱形装饰、无发光', () => {
  const b = new Balloon('eliteKnight', { isElite: true, sizeMul: 1 });
  const r = recCtx();
  b._drawNameLabel(r.ctx, ELITE_LABEL.CANVAS_W, ELITE_LABEL.CANVAS_H, '铁甲兵', ELITE_LABEL);
  assert.deepEqual(r.calls.filter((c) => c[0] === 'fillText'),
    [['fillText', '铁甲兵', ELITE_LABEL.CANVAS_W / 2, ELITE_LABEL.CANVAS_H * 0.54]]);
  assert.ok(r.sets.some(([k, v]) => k === 'strokeStyle' && v === ELITE_LABEL.EDGE), '外描边用配置色');
  assert.ok(r.sets.some(([k, v]) => k === 'strokeStyle' && v === ELITE_LABEL.CORNER), '四角括号用配置色');
  assert.ok(r.sets.some(([k, v]) => k === 'font' && v === ELITE_LABEL.FONT));
  assert.equal(r.lastSet('shadowBlur'), 0, '普通精英不发光');
  assert.ok(!r.sets.some(([k, v]) => k === 'fillStyle' && v === ELITE_LABEL.EDGE), '普通精英没有菱形装饰');
  assert.ok(r.sets.some(([k, v]) => k === 'fillStyle' && v === ELITE_LABEL.COLOR), '字色用配置色');
});

test('Boss 名牌：金红描边 + 菱形装饰 + 文字发光，文案带 Boss 后缀', () => {
  const b = new Balloon('eliteKnight', { isElite: true, sizeMul: 3, climax: true });
  const r = recCtx();
  b._drawNameLabel(r.ctx, BOSS_LABEL.CANVAS_W, BOSS_LABEL.CANVAS_H, '铁甲兵 Boss', BOSS_LABEL);
  assert.deepEqual(r.calls.filter((c) => c[0] === 'fillText'),
    [['fillText', '铁甲兵 Boss', BOSS_LABEL.CANVAS_W / 2, BOSS_LABEL.CANVAS_H * 0.54]]);
  assert.ok(r.sets.some(([k, v]) => k === 'fillStyle' && v === BOSS_LABEL.EDGE), '菱形用边框金描色');
  assert.ok(r.sets.some(([k, v]) => k === 'shadowBlur' && v === BOSS_LABEL.GLOW), 'Boss 名牌带发光');
  assert.ok(r.sets.some(([k, v]) => k === 'strokeStyle' && v === BOSS_LABEL.CORNER));
});

test('气球读取 climax / batchId：名牌世界尺寸按档次走，且仍按 sizeMul 倒数缩回', () => {
  const plain = new Balloon('eliteKnight', { isElite: true, sizeMul: 1, batchId: 3 });
  const boss = new Balloon('eliteKnight', { isElite: true, sizeMul: 3, climax: true, batchId: 4 });
  assert.equal(plain.isClimax, false);
  assert.equal(boss.isClimax, true);
  assert.equal(plain.batchId, 3);
  assert.equal(boss.batchId, 4);
  // 世界高度：plain 1 倍体型 × ELITE_LABEL；boss 3 倍体型 × BOSS_LABEL/3
  const worldH = (b) => b.label.scale.y * b.mesh.scale.y;
  assert.ok(Math.abs(worldH(plain) - ELITE_LABEL.SCALE[1]) < 1e-6);
  assert.ok(Math.abs(worldH(boss) - BOSS_LABEL.SCALE[1]) < 1e-6);
  assert.ok(worldH(boss) > worldH(plain), 'Boss 名牌确实更大');
});

test('普通怪（非精英）不受影响：不挂精英名牌，也没有 climax 标记', () => {
  const b = new Balloon('basic', {});
  assert.equal(b.isClimax, false);
  assert.equal(b.batchId, 0);
});

// ===== 第四十九修（本轮追加）：标题卡改到「开场云雾窗内」弹 =====
// 现场反馈：原先等雾散（_startLevelAudio）才排期 → 卡片和出怪挤在同一瞬间，观感很赶。

const originalLoad = THREE.TextureLoader.prototype.load;
let Game;
try {
  THREE.TextureLoader.prototype.load = () => new THREE.Texture();
  ({ Game } = await import('../src/game/game.js'));
} finally { THREE.TextureLoader.prototype.load = originalLoad; }

// 直接以「假 this」调 Game 的这两个方法：它们只读写 levelIndex / _levelTitleAt / midWarning / log
function fakeGame(lvIndex = 0) {
  const shown = [];
  return {
    g: {
      levelIndex: lvIndex, _levelTitleAt: 0, _levelTitleText: null, _levelTitleDone: false,
      midWarning: { show: (text, style) => shown.push([text, style]) },
      log: () => {},
    },
    shown,
  };
}

test('标题卡 · 有云雾时的时间窗：卡片在雾窗内出来、雾散后仍在屏上', () => {
  assert.equal(typeof LEVEL_TITLE.INTRO_DELAY, 'number');
  assert.ok(LEVEL_TITLE.INTRO_DELAY > 0, '必须为正');
  assert.ok(LEVEL_TITLE.INTRO_DELAY < CLOUD.INTRO_DELAY, '必须在雾散之前就弹出来');
  assert.ok(
    LEVEL_TITLE.INTRO_DELAY + LEVEL_TITLE.SECONDS >= CLOUD.INTRO_DELAY,
    '雾散那一刻卡片应仍在屏上（否则等于没改）'
  );
});

test('标题卡 · 排期接受「距现在多少秒」：有雾 1.5s / 无雾退回 0.8s', () => {
  const a = fakeGame(0);
  Game.prototype._queueLevelTitle.call(a.g);
  assert.equal(a.g._levelTitleAt, LEVEL_TITLE.DELAY, '缺省 = 无云雾的旧口径');
  Game.prototype._queueLevelTitle.call(a.g, LEVEL_TITLE.INTRO_DELAY);
  assert.equal(a.g._levelTitleAt, LEVEL_TITLE.INTRO_DELAY);
  Game.prototype._queueLevelTitle.call(a.g, NaN);   // 容错：坏参数不得让卡片永远不弹
  assert.equal(a.g._levelTitleAt, 0);
});

test('标题卡 · 倒计时到点弹一次（文案取本关名字）、之后不再重复弹', () => {
  const { g, shown } = fakeGame(0);            // 第 1 关 = 落日余晖
  Game.prototype._queueLevelTitle.call(g, 0.5);
  Game.prototype._tickLevelTitle.call(g, 0.2);
  assert.equal(shown.length, 0, '没到点不该弹');
  Game.prototype._tickLevelTitle.call(g, 0.4);
  assert.deepEqual(shown[0], ['第 1 关 · 落日余晖', 'title']);
  Game.prototype._tickLevelTitle.call(g, 99);
  assert.equal(shown.length, 1, '弹过就清零，不会重复弹');
});

test('标题卡 · 机制关(3/9/15)：先排兜底、语音结束后改排更早，且一关只弹一次', () => {
  assert.ok(LEVEL_TITLE.MECHANIC_DELAY > CLOUD.INTRO_DELAY, '兜底要晚于云雾窗');
  assert.ok(LEVEL_TITLE.MECHANIC_AFTER_VOICE > 0, '语音结束后有个小延迟再弹');
  assert.ok(LEVEL_TITLE.MECHANIC_AFTER_VOICE < LEVEL_TITLE.MECHANIC_DELAY, '语音正常结束应早于兜底');
  for (const n of [3, 9, 15]) {
    const idx = LEVELS.findIndex((l) => l.n === n);
    const { g, shown } = fakeGame(idx);
    Game.prototype._queueLevelTitle.call(g, LEVEL_TITLE.MECHANIC_DELAY);
    assert.equal(g._levelTitleAt, LEVEL_TITLE.MECHANIC_DELAY, `第 ${n} 关（机制关）应排兜底延迟`);
    // 开场语音播完（魔术师收场）→ 改排成「0.5s 后」
    Game.prototype._queueLevelTitle.call(g, LEVEL_TITLE.MECHANIC_AFTER_VOICE);
    assert.equal(g._levelTitleAt, LEVEL_TITLE.MECHANIC_AFTER_VOICE, '语音结束后提前弹');
    Game.prototype._tickLevelTitle.call(g, LEVEL_TITLE.MECHANIC_AFTER_VOICE + 0.1);
    assert.deepEqual(shown[0], [levelTitleText(n, LEVEL_TITLE.TEXT), 'title']);
    // 弹过之后兜底那次不许再刷一遍（_levelTitleDone 守卫）
    Game.prototype._queueLevelTitle.call(g, LEVEL_TITLE.MECHANIC_DELAY);
    assert.equal(g._levelTitleAt, 0, '已经弹过 → 不再排期');
    Game.prototype._tickLevelTitle.call(g, 99);
    assert.equal(shown.length, 1, '一关只弹一次');
  }
});

test('标题卡 · 换关重置「已弹过」：下一关照常排期', () => {
  const { g, shown } = fakeGame(0);
  Game.prototype._queueLevelTitle.call(g, 0.1);
  Game.prototype._tickLevelTitle.call(g, 1);
  assert.equal(shown.length, 1);
  assert.equal(g._levelTitleDone, true);
  // _clearLevelEntities 会把这三个字段复位（新关卡由 _loadLevel 重新排一个）
  g._levelTitleDone = false; g._levelTitleText = null; g._levelTitleAt = 0;
  Game.prototype._queueLevelTitle.call(g, 0.1);
  assert.equal(g._levelTitleAt, 0.1, '新关卡应重新排期');
});
