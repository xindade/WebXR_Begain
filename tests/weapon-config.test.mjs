// 爆炮手火箭筒调参读写（第八十七修）—— tools/cast-pc/lib/weapon-config.cjs
//
// 与瞄准角同样的硬约束：只能改 BOMBARD_WEAPON 里的数字，不能破坏 userConfig.js；
// 脏输入必须在落盘前挡掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const W = require('../tools/cast-pc/lib/weapon-config.cjs');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL = path.join(HERE, '..', 'src', 'core', 'userConfig.js');

const FIXTURE = [
  'const X = {',
  '  GUN: { POSITION: { x: 1, y: 2, z: 3 }, SCALE: 1 },',
  '  BOMBARD_WEAPON: {',
  "    MODEL_URL: 'Model/火箭筒.glb',",
  '    POSITION: { x: 0.1, y: -0.25, z: 0 }, // 位置',
  '    ROTATION: { x: -60, y: 90, z: 0 },',
  '    SCALE: 0.5,',
  '  },',
  '};',
].join('\n');

test('武器参数：读出位置 / 旋转 / 缩放', () => {
  assert.deepEqual(W.readWeapon(FIXTURE), {
    MODEL_URL: 'Model/火箭筒.glb',
    POSITION: { x: 0.1, y: -0.25, z: 0 },
    ROTATION: { x: -60, y: 90, z: 0 },
    SCALE: 0.5,
  });
});

test('武器参数：原位改数字，不碰 GUN 与注释', () => {
  const r = W.applyPatch(FIXTURE, { POSITION: { x: 0.3 }, ROTATION: { y: 45 }, SCALE: 0.7 });
  assert.ok(r.ok);
  assert.deepEqual(W.readWeapon(r.text).POSITION, { x: 0.3, y: -0.25, z: 0 });
  assert.deepEqual(W.readWeapon(r.text).ROTATION, { x: -60, y: 45, z: 0 });
  assert.equal(W.readWeapon(r.text).SCALE, 0.7);
  assert.ok(r.text.includes('GUN: { POSITION: { x: 1, y: 2, z: 3 }, SCALE: 1 }'), 'AK 配置不动');
  assert.ok(r.text.includes('// 位置'), '注释保留');
  assert.equal(W.applyPatch(r.text, { POSITION: { x: 0.3 }, ROTATION: { y: 45 }, SCALE: 0.7 }).text, r.text);
});

test('武器参数：脏输入在落盘前被挡掉', () => {
  assert.deepEqual(W.sanitize({ POSITION: { x: 'abc', y: 1 }, ROTATION: { z: '' }, SCALE: -1 }), { POSITION: { y: 1 } });
  assert.deepEqual(W.sanitize(null), {});
  assert.equal(W.applyPatch(FIXTURE, { SCALE: -1 }).text, FIXTURE);
});

test('武器参数：真实 userConfig.js 可解析且改后仍可再解析', () => {
  const src = fs.readFileSync(REAL, 'utf8');
  const w = W.readWeapon(src);
  assert.ok(w && Number.isFinite(w.POSITION.x) && Number.isFinite(w.ROTATION.x) && w.SCALE > 0);
  const out = W.applyPatch(src, { POSITION: { x: w.POSITION.x + 0.01 } }).text;
  assert.notEqual(out, src);
  assert.equal(W.readWeapon(out).POSITION.x, w.POSITION.x + 0.01);
});
