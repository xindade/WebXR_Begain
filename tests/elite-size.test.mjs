// 第四十七修回归：精英体型倍数 sizeMul —— 「总体型倍数」语义
//   起因：enemies.js 里 heart/ninja/ghost/octopus 已写 scale:3（精英整体放大 3 倍），
//   若 SIZE_MUL 再乘一次就是 9 倍（忍者 effectiveRadius 5.4m、DepthSprite 宽 10.8m，贴脸糊屏）。
//   约定：显式 sizeMul 覆盖 t.scale；没传 sizeMul 的怪仍按 t.scale 走。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Balloon } from '../src/game/balloons.js';
import { ENEMY_TYPES } from '../src/content/enemies.js';
import { ELITE_TUNING, ELITE_LABEL } from '../src/core/constants.js';

const ELITES = ['eliteKnight', 'shield', 'heart', 'ninja', 'ghost', 'octopus'];

test('精英：显式 sizeMul 覆盖 t.scale → 一律 SIZE_MUL 倍（不会叠加成 9 倍）', () => {
  assert.equal(ELITE_TUNING.SIZE_MUL, 3);
  for (const id of ELITES) {
    const b = new Balloon(id, { isElite: true, sizeMul: ELITE_TUNING.SIZE_MUL, hp: 1234 });
    const base = ENEMY_TYPES[id].radius;
    assert.equal(b.sizeMul, 3, id);
    assert.equal(b.effectiveRadius, base * 3, id);   // 碰撞 / 命中 / 分离半径
    assert.equal(b.mesh.scale.x, 3, id);             // 视觉（子节点一起放大）
    assert.equal(b.hp, 1234, id);                    // 血量仍由 waves._eliteOpts 覆盖
  }
});

test('精英名牌按倒数缩回：世界尺寸不随体型放大，仍挂在放大后的头顶', () => {
  const big = new Balloon('ninja', { isElite: true, sizeMul: 3 });        // 显式 3 倍
  const small = new Balloon('eliteKnight', { isElite: true });             // 未传 → 按 t.scale = 1
  assert.ok(big.label && small.label, '精英必须挂名牌');
  const worldH = (b) => b.label.scale.y * b.mesh.scale.y;
  const worldTop = (b) => b.label.position.y * b.mesh.scale.y;
  assert.ok(Math.abs(worldH(big) - ELITE_LABEL.SCALE[1]) < 1e-6, '名牌世界高度 = ELITE_LABEL.SCALE[1]');
  assert.ok(Math.abs(worldH(big) - worldH(small)) < 1e-6, '3 倍与 1 倍体型的名牌世界尺寸一致');
  assert.ok(Math.abs(worldTop(big) - (big.effectiveRadius * 2.6 + 0.3 + ELITE_LABEL.Y_PAD)) < 1e-6,
    '名牌挂在放大后的头顶（换算回世界坐标）');
});

test('普通怪不受影响：basic 1 倍，带 t.scale 的普通怪仍按 t.scale', () => {
  const plain = new Balloon('basic');
  assert.equal(plain.sizeMul, 1);
  assert.equal(plain.effectiveRadius, ENEMY_TYPES.basic.radius);
  const ninja = new Balloon('ninja');
  assert.equal(ninja.sizeMul, 3);
  assert.equal(ninja.effectiveRadius, ENEMY_TYPES.ninja.radius * 3);
});