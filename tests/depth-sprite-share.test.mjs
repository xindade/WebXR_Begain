// 第五十二修 · 立绘几何体按 size 共享（引用计数）+ 压测阵列默认关
//
// 为什么值得单测：共享几何体的引用计数一旦写错，现场表现是「某只怪死亡/切关之后，一整类怪的
// 立绘随机消失」——非常难复现、也看不出和死亡有关。这里把要遵守的不变式钉死：
//   ① 同 size 共用同一个几何体，不同 size 不共用；
//   ② 材质**不**共享（逐实例的 uFrame/uPlaneRight/uPlaneUp/uFlash 必须独立）；
//   ③ 释放其中一个用户，其它用户不能失去几何体；
//   ④ 最后一个用户走了才真正回收（缓存里不留残项）；
//   ⑤ dispose 幂等（重复调用不能把引用数多减一次）；
//   ⑥ 压测阵列默认关闭。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DepthSprite, _sharedGeometryCount } from '../src/game/depthSprite.js';
import { DEPTH_SPRITE_STRESS } from '../src/core/constants.js';

const TEX = { albedo: { isTexture: true }, depth: { isTexture: true } };
const mk = (size) => new DepthSprite({ ...TEX, size });

test('第五十二修 · 立绘几何体：同 size 共用，不同 size 不共用', () => {
  const a = mk(1), b = mk(1), c = mk(1.8);
  assert.equal(a.geometry, b.geometry, '同尺寸必须共用同一个几何体');
  assert.notEqual(a.geometry, c.geometry, '不同尺寸不能共用');
  assert.equal(a.geometry.attributes.position.count, 4, '是一个 PlaneGeometry（单面 4 顶点）');
  assert.equal(a.mesh.geometry, a.geometry, 'mesh 指的是共享几何体');
  a.dispose(); b.dispose(); c.dispose();
});

test('第五十二修 · 浮点误差不该产生第二份几何体', () => {
  const a = mk(1.0);
  const b = mk(0.5 * 2 + 1e-16);          // 数学上是 1.0，浮点上不是
  assert.equal(a.geometry, b.geometry, 'toFixed(3) 之后应归一到同一份');
  a.dispose(); b.dispose();
});

test('第五十二修 · 材质必须逐实例（共享会让动画同帧、受击同时闪白）', () => {
  const a = mk(1), b = mk(1);
  assert.notEqual(a.material, b.material, '材质不能共享');
  assert.notEqual(a.material.uniforms.uFrame, b.material.uniforms.uFrame);
  a.setFrame(3); b.setFrame(7);
  assert.equal(a.material.uniforms.uFrame.value, 3);
  assert.equal(b.material.uniforms.uFrame.value, 7, '各自的动画帧互不影响');
  a.setFlash(1, 0xff0000); b.setFlash(0);
  assert.equal(a.material.uniforms.uFlash.value, 1);
  assert.equal(b.material.uniforms.uFlash.value, 0, '各自的受击闪光互不影响');
  a.dispose(); b.dispose();
});

test('第五十二修 · 释放其中一个用户，其它用户不能失去几何体', () => {
  const a = mk(1.25), b = mk(1.25);
  const shared = a.geometry;
  a.dispose();
  assert.equal(b.geometry, shared, 'b 仍然拿着同一个几何体（没被 a 带走）');
  const d = mk(1.25);
  assert.equal(d.geometry, shared, '后来者继续复用同一份（缓存项没被误删）');
  b.dispose(); d.dispose();
});

test('第五十二修 · 最后一个用户走了才真正回收（缓存里不留残项）', () => {
  const before = _sharedGeometryCount();
  const a = mk(2.5), b = mk(2.5);
  assert.equal(_sharedGeometryCount(), before + 1, '同尺寸只多出一份几何体');
  const geo = a.geometry;
  a.dispose();
  assert.equal(_sharedGeometryCount(), before + 1, '还有人用 ⇒ 不回收');
  b.dispose();
  assert.equal(_sharedGeometryCount(), before, '没人用了 ⇒ 回收并从缓存摘除');
  const c = mk(2.5);
  assert.notEqual(c.geometry, geo, '回收后重建的是新几何体');
  c.dispose();
  assert.equal(_sharedGeometryCount(), before, '用完仍归位（不泄漏）');
});

test('第五十二修 · dispose 幂等：重复调用不会把引用数多减一次', () => {
  const before = _sharedGeometryCount();
  const a = mk(0.9), b = mk(0.9);
  a.dispose(); a.dispose(); a.dispose();
  assert.equal(b.geometry.attributes.position.count, 4, 'b 的几何体还活着');
  const d = mk(0.9);
  assert.equal(d.geometry, b.geometry, '缓存项也还在（没被多减一次而误删）');
  b.dispose(); d.dispose();
  assert.equal(_sharedGeometryCount(), before);
});

test('第五十二修 · dispose 之后不再持有几何体引用', () => {
  const a = mk(3.3);
  a.dispose();
  assert.equal(a.geometry, null, '置空而不是留一个已释放的引用（防别人再 dispose 一次误杀同类）');
});

test('第五十二修 · 压测阵列默认关闭（DEPTH_SPRITE_STRESS = 0）', () => {
  assert.equal(DEPTH_SPRITE_STRESS, 0,
    '>0 时 game._loadLevel 会在每关额外生成 N 个立绘（+N draw call）；压测请临时改这个值，别动 NORMAL_TEST');
});