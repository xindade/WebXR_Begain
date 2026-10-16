// 基础怪群体语音「冲冲冲」的门槛与门禁（第六十四修 / 第六十六修）—— 纯函数 + 接线单测
//
// 现场口径（第六十六修 · 原话，**覆盖**第六十四/六十五修那两轮的理解）：
//   「冲冲冲的语音，只有第三关的脸谱Boss的第一阶段才会有，其它关卡中不要放，因为太吵了。」
//   ⇒ 这是一条**位置**要求，不是「门槛调高低」：除脸谱 Boss 第一阶段外，其它关卡/阶段要**完全静音**。
//
// 于是这里有两条**独立**的判据，各自守一个失败模式：
//   ① 门槛 basicVoiceNeed(本关配额) = clamp(round(配额 × RATIO), MIN, THRESHOLD)（第六十四修，纯函数）
//      —— 管「要凑够多少只才喊」。一旦被改回写死一个数，在画面上完全看不出来。
//   ② 门禁 _basicVoiceAllowed()（第六十六修）—— 管「哪些地方允许响」：
//      只有在场脸谱 Boss（waves.faceBoss.alive === true）且是相位 0（蓝 · 召唤阵冲锋）才放行。
//      ⚠ 必须排在**数怪之前**：否则普通关还是会白数一遍，留痕里还会留下「基础怪 N 只」的假象
//        （现场核对「到底响没响」时最容易被这一行骗）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as THREE from 'three';
import { basicVoiceNeed } from '../src/game/basicVoice.js';
import { BASIC_VOICE } from '../src/core/constants.js';

// game.js 顶部会 preload 视觉纹理；这里只需要一个最小桩（同 boost-bullets.test.mjs）
const originalLoad = THREE.TextureLoader.prototype.load;
let Game;
try {
  THREE.TextureLoader.prototype.load = () => new THREE.Texture();
  ({ Game } = await import('../src/game/game.js'));
} finally { THREE.TextureLoader.prototype.load = originalLoad; }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = fs.readFileSync(path.join(HERE, '..', 'src', 'game', 'game.js'), 'utf8');

// ---------- ① 门槛 = clamp(配额 × RATIO, MIN, THRESHOLD) ----------

test('门槛跟着本关配额走：配额小的时候门槛也低（不是写死 10 只）', () => {
  const q10 = basicVoiceNeed(10, BASIC_VOICE);
  assert.ok(q10 < BASIC_VOICE.THRESHOLD, `配额 10 时门槛应低于封顶 ${BASIC_VOICE.THRESHOLD}（实际 ${q10}）`);
  assert.ok(q10 >= BASIC_VOICE.MIN, '但不能低于下限 MIN');
  assert.equal(q10, Math.round(10 * BASIC_VOICE.RATIO));
});

test('配额很小 / 没有配额（Boss 关）—— 落到下限 MIN', () => {
  // 非有限值（NaN / Infinity / undefined / null）一律按「没有配额」处理
  for (const q of [0, 1, 2, -5, NaN, undefined, null, Infinity]) {
    assert.equal(basicVoiceNeed(q, BASIC_VOICE), BASIC_VOICE.MIN, `配额 ${q} → MIN`);
  }
});

test('配额很大 → 封顶 THRESHOLD（后期怪多也不会一直循环喊）', () => {
  for (const q of [20, 40, 85, 1000]) {
    assert.equal(basicVoiceNeed(q, BASIC_VOICE), BASIC_VOICE.THRESHOLD, `配额 ${q} → 封顶`);
  }
});

test('门槛单调不降：配额越大门槛越高（不会出现「配额涨了门槛反而降」）', () => {
  let prev = 0;
  for (const q of [0, 3, 6, 8, 10, 12, 16, 20, 30, 60]) {
    const v = basicVoiceNeed(q, BASIC_VOICE);
    assert.ok(v >= prev, `配额 ${q} 的门槛 ${v} 不该小于前一个 ${prev}`);
    prev = v;
  }
});

test('脏配置兜底：MIN 比 THRESHOLD 还大也不会吐出更离谱的数', () => {
  const v = basicVoiceNeed(50, { MIN: 99, THRESHOLD: 5, RATIO: 1 });
  assert.equal(v, 5, 'MIN > THRESHOLD 时以 THRESHOLD 为准（不许超过封顶）');
  assert.equal(basicVoiceNeed(10, {}), 6, 'cfg 缺省时回落 10 / 0.6 / MIN 1');
});

// ---------- ② 门禁：只有脸谱 Boss 第一阶段（相位 0）允许响 ----------
//
// 用 Object.create(Game.prototype) 直接叫这个方法 —— 不跑构造器（那要渲染器/场景一整套），
// 只验这一个判据的真值表（同 tutorial.test.mjs 的写法）。
const gate = (waves) => {
  const g = Object.create(Game.prototype);
  g.waves = waves;
  return g._basicVoiceAllowed();
};

test('★ 门禁真值表：只有「在场 + 活着 + 相位 0（蓝 · 召唤阵冲锋）」的脸谱 Boss 才放行', () => {
  const cases = [
    [undefined, false, '没有 waves（菜单 / 还没开局）'],
    [null, false, 'waves 为 null'],
    [{}, false, 'waves 里还没有 faceBoss 字段（普通关）'],
    [{ faceBoss: null, facePhase: 0 }, false, '脸谱 Boss 不在场（普通关 / 其它 Boss 关）'],
    [{ faceBoss: {}, facePhase: 0 }, false, 'Boss 对象在、但没标 alive'],
    [{ faceBoss: { alive: false }, facePhase: 0 }, false, '★ Boss 已死：那帧 faceBoss 引用还在，必须靠 alive 挡住'],
    [{ faceBoss: { alive: true }, facePhase: 1 }, false, '相位 1（红 · 帅字旗）'],
    [{ faceBoss: { alive: true }, facePhase: 2 }, false, '相位 2（黑 · 身化万千）'],
    [{ faceBoss: { alive: true } }, false, '相位字段缺失（不许当成 0 放行）'],
    [{ faceBoss: { alive: true }, facePhase: 0 }, true, '✅ 相位 0 = 蓝 = 召唤阵一次涌出 18 只 —— 唯一该响的地方'],
  ];
  for (const [waves, want, why] of cases) {
    assert.equal(gate(waves), want, `${why} ⇒ ${want}`);
  }
});

test('门禁必须排在**数怪之前**：普通的关连怪都不数（留一行假日志最容易被骗）', () => {
  const start = GAME.indexOf('_updateBasicVoice(dt) {');
  const end = GAME.indexOf('_basicVoiceQuota() {');
  assert.ok(start > -1 && end > start, '要能在源码里定位 _updateBasicVoice 的方法体');
  const body = GAME.slice(start, end);
  const gateAt = body.indexOf('this._basicVoiceAllowed()');
  const countAt = body.indexOf('for (const b of this.balloons.list)');
  assert.ok(gateAt > -1, '方法体里必须调用门禁');
  assert.ok(countAt > -1, '方法体里要有基础怪计数');
  assert.ok(gateAt < countAt, '★ 门禁必须排在数怪之前（现场口径：其它关卡别参与）');
  assert.ok(body.slice(gateAt, countAt).includes('return;'), '门禁要走提前 return（不是只设个空转开关）');
});

// ---------- ③ 接线：门槛仍由「本关配额」算出，且留一行可核对的日志 ----------

test('接线：game 用 basicVoiceNeed(waves 内圈+外圈配额) 当门槛，并留一行可核对的日志', () => {
  assert.ok(GAME.includes("import { basicVoiceNeed } from './basicVoice.js'"), 'game 必须用这个纯函数');
  assert.ok(GAME.includes('const need = basicVoiceNeed(quota, BASIC_VOICE)'), '门槛由配额算出');
  assert.ok(GAME.includes('_basicVoiceQuota()') && GAME.includes('w.innerQuota || 0') && GAME.includes('w.outerQuota || 0'),
    '配额 = waves 的内圈 + 外圈目标');
  assert.ok(GAME.includes('[冲冲冲] 基础怪'), '触发要往留痕写一行（现场核对「到底响没响」）');
  assert.ok(!GAME.includes('if (n >= BASIC_VOICE.THRESHOLD)'),
    '★ 不许退回「直接拿写死的 THRESHOLD 比大小」——那就是第六十四修修的现场问题');
});
