// 第五十六修 · 基础怪头顶「爆」标记（BOMB_LABEL / balloons._updateBombMarks）
//
// 锁三件事：
//   ① 判定口径 —— 只有**活着的**基础小怪（非精英/非 Boss/非龙部件/非受控）才挂「爆」；
//   ② 渲染成本 —— 无论多少只杂鱼都只建**一个** InstancedMesh（1 个 draw call），这是本修的性能前提；
//   ③ 位置/容量 —— 实例只写「有标记的」那些，且不超过 BOMB_LABEL.MAX。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BOMB_LABEL } from '../src/core/constants.js';
import { isBombMarkTarget, bombMarkColor, BalloonManager } from '../src/game/balloons.js';

const mk = (over = {}) => ({
  alive: true, isElite: false, isBoss: false, isDragonPart: false, controlled: false,
  radius: 0.4, effectiveRadius: 0.4,
  mesh: { visible: true, position: new THREE.Vector3(0, 1, -3) },
  ...over,
});

test('「爆」标记判定：只有活着的**基础小怪**才挂（精英/Boss/龙部件/受控/已死都不挂）', () => {
  assert.equal(isBombMarkTarget(mk()), true, '普通杂鱼应挂');
  for (const k of ['isElite', 'isBoss', 'isDragonPart', 'controlled']) {
    assert.equal(isBombMarkTarget(mk({ [k]: true })), false, k + ' 不该挂');
  }
  assert.equal(isBombMarkTarget(mk({ alive: false })), false, '已死不该挂');
  assert.equal(isBombMarkTarget(null), false);
  assert.equal(isBombMarkTarget(undefined), false);
});

test('BOMB_LABEL 参数：贴图/尺寸/容量齐全且合理', () => {
  assert.equal(BOMB_LABEL.ENABLED, true);
  assert.equal(BOMB_LABEL.TEXT, '爆');
  assert.ok(BOMB_LABEL.SIZE > 0 && BOMB_LABEL.SIZE < 2, '世界尺寸应在 0~2m');
  assert.ok((BOMB_LABEL.MAX | 0) >= 32, '容量至少 32（同屏基础怪上限）');
});

test('渲染成本：无论多少只基础怪，都只建一个 InstancedMesh；实例数 = 有标记的怪数，且不超上限', () => {
  const mgr = new BalloonManager(new THREE.Scene());
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
  camera.position.set(0, 1.6, 0);
  // 20 只基础怪 + 3 只不该挂的（精英 / Boss / 已死）
  mgr.list = [];
  for (let i = 0; i < 20; i++) mgr.list.push(mk({ mesh: { visible: true, position: new THREE.Vector3(i * 0.5 - 5, 1, -4) } }));
  mgr.list.push(mk({ isElite: true }), mk({ isBoss: true }), mk({ alive: false }));
  mgr._updateBombMarks(camera);
  assert.ok(mgr._bombMarks, '应惰性创建 InstancedMesh');
  assert.equal(mgr._bombMarks.count, 20, '只给基础怪写实例');
  assert.equal(mgr._bombMarks.instanceMatrix.count, BOMB_LABEL.MAX, '容量 = BOMB_LABEL.MAX（对象只建一次）');
  // 第五十七修（现场）：改成参与深度测试 —— 旧口径「永远画在最上层」会糊在它前方的怪身上
  assert.equal(mgr._bombMarks.material.depthTest, true, '要被前面的怪遮挡');
  assert.ok(mgr._bombMarks.renderOrder <= 1, '不再抢最上层（把 999 让给精英名牌）');
  assert.ok(mgr._bombMarks.instanceColor, '实例色缓冲要提前建好（内圈闪烁逐帧改色，不能首次现建）');
  assert.equal(mgr._bombMarks.frustumCulled, false, '位置逐帧变，关掉包围球剔除');
  // 再跑一帧：不新建对象（复用同一个），且标记跟着怪走
  mgr.list[0].mesh.position.set(9, 1, -9);
  const before = mgr._bombMarks;
  mgr._updateBombMarks(camera);
  assert.equal(mgr._bombMarks, before, '复用同一个 InstancedMesh');
  const m = new THREE.Matrix4();
  mgr._bombMarks.getMatrixAt(0, m);
  const pos = new THREE.Vector3().setFromMatrixPosition(m);
  assert.ok(Math.abs(pos.x - 9) < 1e-6 && Math.abs(pos.z + 9) < 1e-6, '实例位置跟随怪');
  // 关掉开关 → 整层隐藏（零成本）
  const old = BOMB_LABEL.ENABLED;
  try {
    BOMB_LABEL.ENABLED = false;
    mgr._updateBombMarks(camera);
    assert.equal(mgr._bombMarks.visible, false, '关掉后整层隐藏');
  } finally { BOMB_LABEL.ENABLED = old; }
});

// ---------- 第五十七修：内圈闪烁变红 ----------

test('「爆」标记颜色：圈外恒暖黄；进内圈按节拍在红/暖黄之间闪', () => {
  const normal = new THREE.Color(BOMB_LABEL.COLOR).getHex();
  const blink = new THREE.Color(BOMB_LABEL.BLINK_COLOR).getHex();
  assert.notEqual(normal, blink, '两个颜色必须真的不同（否则闪了也看不出来）');
  assert.ok(BOMB_LABEL.INNER_RADIUS > 0 && BOMB_LABEL.BLINK_ON > 0);
  const far = mk({ mesh: { visible: true, position: new THREE.Vector3(0, 1, -12) } });
  const near = mk({ mesh: { visible: true, position: new THREE.Vector3(0, 1, -6) } });
  assert.equal(bombMarkColor(far, 0), normal);
  assert.equal(bombMarkColor(far, 7.3), normal, '圈外不闪');
  assert.equal(bombMarkColor(near, 0), blink, '第 0 拍：红');
  assert.equal(bombMarkColor(near, BOMB_LABEL.BLINK_ON), normal, '半拍后：暖黄');
  assert.equal(bombMarkColor(near, BOMB_LABEL.BLINK_ON * 2), blink, '一拍后：又红（循环）');
  assert.equal(bombMarkColor(null, 0), normal, '空对象不炸');
  // 只在水平面上判内圈：抬到高处仍算内圈（用的是 x/z，不含 y）
  const high = mk({ mesh: { visible: true, position: new THREE.Vector3(0, 99, -6) } });
  assert.equal(bombMarkColor(high, 0), blink);
});

test('逐帧写色：内圈怪一帧红一帧黄，圈外怪恒定暖黄（1 个 InstancedMesh 不变）', () => {
  const mgr = new BalloonManager(new THREE.Scene());
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
  mgr.list = [
    mk({ mesh: { visible: true, position: new THREE.Vector3(0, 1, -6) } }),    // 内圈
    mk({ mesh: { visible: true, position: new THREE.Vector3(0, 1, -13) } }),   // 外圈
  ];
  const c = new THREE.Color();
  mgr._updateBombMarks(camera, 0);
  const c0 = mgr._bombMarks.instanceColor.array.slice(0, 3);
  mgr._updateBombMarks(camera, BOMB_LABEL.BLINK_ON);
  const c1 = mgr._bombMarks.instanceColor.array.slice(0, 3);
  assert.notDeepEqual(c0, c1, '内圈怪的颜色要随节拍变');
  assert.equal(mgr._bombMarks.count, 2);
});