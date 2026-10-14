// 瞄准补偿角读写（第四十五修）—— tools/cast-pc/lib/aim-config.cjs
//
// 为什么值得单独锁：这块代码既被 PC 端 EXE 界面用（下发给头显前套用覆盖），
// 也被 tools/set-aim.js 用；写坏 src/core/userConfig.js 会让头显**起不来**（配置解析失败）。
// 所以这里盯三件事：① 只动目标槽的那几个数字；② 幂等；③ 脏输入被挡在落盘之前。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AIM = require('../tools/cast-pc/lib/aim-config.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL = path.join(HERE, '..', 'src', 'core', 'userConfig.js');

const FIXTURE = [
  "const AIM = {",
  "  ENABLED: true,",
  "  BY_DEVICE: {",
  "    pico:    { x: -27, y: 0,   z: 0 },   // PICO 4 实测基准，勿随意改",
  "    quest:   { x: 14,  y: -14, z: 0 },   // Quest 3 上机实测",
  "    steamvr: { x: -27, y: -2,  z: 0 },",
  "    unknown: { x: -27, y: 0,   z: 0 },",
  "  },",
  "};",
].join('\n');

test('瞄准角：读出四个槽的 x/y/z', () => {
  const s = AIM.readSlots(FIXTURE);
  assert.deepEqual(s.pico, { x: -27, y: 0, z: 0 });
  assert.deepEqual(s.quest, { x: 14, y: -14, z: 0 });
  assert.deepEqual(s.steamvr, { x: -27, y: -2, z: 0 });
  assert.deepEqual(s.unknown, { x: -27, y: 0, z: 0 });
});

test('瞄准角：只改目标槽的目标轴，其余内容（注释/格式/别的槽）一字不动', () => {
  const r = AIM.applyPatch(FIXTURE, { quest: { x: 20 } });
  assert.equal(r.report[0].changed, true);
  assert.deepEqual(r.report[0].before, { x: 14, y: -14, z: 0 });
  assert.deepEqual(r.report[0].after, { x: 20, y: -14, z: 0 });
  assert.ok(r.text.includes('    quest:   { x: 20,  y: -14, z: 0 },   // Quest 3 上机实测'), '原位替换、保留注释与对齐');
  assert.ok(r.text.includes('    pico:    { x: -27, y: 0,   z: 0 },   // PICO 4 实测基准，勿随意改'), '别的槽不动');
  assert.deepEqual(AIM.readSlots(r.text).pico, { x: -27, y: 0, z: 0 });
  // 幂等：同样的 patch 再套一次，文本不再变化
  assert.equal(AIM.applyPatch(r.text, { quest: { x: 20 } }).text, r.text);
});

test('瞄准角：负值 / 小数 / 多槽一次写完', () => {
  const r = AIM.applyPatch(FIXTURE, { pico: { x: -12.5, z: 3 }, quest: { y: -14 } });
  assert.deepEqual(AIM.readSlots(r.text).pico, { x: -12.5, y: 0, z: 3 });
  assert.deepEqual(AIM.readSlots(r.text).quest, { x: 14, y: -14, z: 0 });
  assert.equal(AIM.applyPatch(r.text, { pico: { x: -12.5, z: 3 }, quest: { y: -14 } }).text, r.text);
});

test('瞄准角：脏输入（非数字 / 未知槽 / 空串）在落盘之前被挡掉', () => {
  assert.deepEqual(AIM.sanitize({ quest: { x: 'abc', y: 3 }, bogus: { x: 1 }, pico: { z: '' } }),
    { quest: { y: 3 } });
  assert.deepEqual(AIM.sanitize(null), {});
  assert.deepEqual(AIM.sanitize('x'), {});
  // 全是脏输入 → 文本原样返回（一个字节都不动）
  const r = AIM.applyPatch(FIXTURE, { quest: { x: 'abc' } });
  assert.equal(r.text, FIXTURE);
  assert.deepEqual(r.report, []);
});

test('瞄准角：真实 userConfig.js 能被解析、且改写结果仍可被再解析（不落盘）', () => {
  const src = fs.readFileSync(REAL, 'utf8');
  const slots = AIM.readSlots(src);
  for (const s of AIM.SLOTS) {
    assert.ok(slots[s] && Number.isFinite(slots[s].x), `${s} 槽应能读出 x`);
  }
  const out = AIM.applyPatch(src, { quest: { x: slots.quest.x + 1 } }).text;
  assert.notEqual(out, src);
  assert.equal(AIM.readSlots(out).quest.x, slots.quest.x + 1);
  // 只差一个数字：长度不变（说明没破坏任何结构）
  assert.equal(out.length, src.length);
});