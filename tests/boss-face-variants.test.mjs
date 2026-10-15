import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { prebuildBalloonVariants, setBalloonVariant, dropBalloonVariants, buildModelClone } from '../src/game/balloonModels.js';
import { FACE_BOSS } from '../src/core/constants.js';

// 第 6 关脸谱 Boss 的三张脸（与 FACE_BOSS.MODELS 同源）
const BLUE = 'Model/蓝面脸谱.glb';
const RED = 'Model/红面脸谱.glb';
const BLACK = 'Model/黑面脸谱.glb';

function fakeMesh() {
  const geo = new THREE.BufferGeometry();
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
}

// 造一个「构造函数已挂上蓝脸本体」的气球
function fakeBoss({ withVariants = true } = {}) {
  const mesh = new THREE.Object3D();
  const base = fakeMesh();
  base.userData.sharedGeo = true;
  mesh.add(base);
  const balloon = { alive: true, mesh, bodyModel: base, _modelMats: [base.material] };
  if (withVariants) {
    balloon._variantBaseUrl = BLUE;
    balloon._variants = {};
    for (const url of [RED, BLACK]) {
      const clone = fakeMesh();
      clone.userData.sharedGeo = true;
      clone.visible = false;
      mesh.add(clone);
      balloon._variants[url] = { clone, mats: [clone.material] };
    }
  }
  return { balloon, mesh, base };
}

test('第四十九修 · 变脸只切 visible：切到红脸后本体隐藏、bodyModel 指向红脸', () => {
  const { balloon, mesh, base } = fakeBoss();
  assert.equal(setBalloonVariant(balloon, RED), true);
  assert.equal(base.visible, false);
  assert.equal(balloon._variants[RED].clone.visible, true);
  assert.equal(balloon._variants[BLACK].clone.visible, false);
  // bodyModel / _modelMats 必须指向「当前显示的那张」——黑阶段隐身与受击闪烁都读它们
  assert.equal(balloon.bodyModel, balloon._variants[RED].clone);
  assert.equal(balloon._modelMats, balloon._variants[RED].mats);
  assert.equal(mesh.children.length, 3);
});

test('第四十九修 · 切回本体：本体亮、两张变体都灭（且不重建任何模型）', () => {
  const { balloon, mesh, base } = fakeBoss();
  setBalloonVariant(balloon, BLACK);
  assert.equal(setBalloonVariant(balloon, BLUE), true);
  assert.equal(base.visible, true);
  assert.equal(balloon.bodyModel, base);
  assert.deepEqual(balloon._modelMats, [base.material], '受击闪烁要作用在本体材质上');
  for (const url of [RED, BLACK]) assert.equal(balloon._variants[url].clone.visible, false);
  assert.equal(mesh.children.length, 3, '全程没有增删节点（零创建/零 dispose）');
});

test('第四十九修 · 变脸不再 dispose 材质（否则会释放 GL program → 下一帧同步重编译）', () => {
  const { balloon } = fakeBoss();
  const redMat = balloon._variants[RED].clone.material;
  let disposed = false;
  redMat.addEventListener('dispose', () => { disposed = true; });
  setBalloonVariant(balloon, RED);
  setBalloonVariant(balloon, BLACK);
  setBalloonVariant(balloon, BLUE);
  assert.equal(disposed, false, '材质三张脸同生共死，全程不得释放');
});

test('第四十九修 · 预建没到位 → 返回 false（调用方回退 swapBalloonModel）', () => {
  const { balloon } = fakeBoss({ withVariants: false });
  assert.equal(setBalloonVariant(balloon, RED), false);
  assert.equal(setBalloonVariant(balloon, BLUE), false, '连 _variants 都没有 ⇒ 一律回退');
});

test('第四十九修 · 变体被摘掉（走过兜底重建）→ 返回 false，不会把藏着的克隆点亮', () => {
  const { balloon, mesh } = fakeBoss();
  mesh.remove(balloon._variants[RED].clone);
  assert.equal(setBalloonVariant(balloon, RED), false);
});

test('第四十九修 · 黑阶段语义保持：切到黑脸后 b.bodyModel.visible=false 隐藏的正是当前这张', () => {
  const { balloon } = fakeBoss();
  setBalloonVariant(balloon, BLACK);
  // waves._faceUpdateBlack 原样执行
  if (balloon.bodyModel) balloon.bodyModel.visible = false;
  assert.equal(balloon._variants[BLACK].clone.visible, false);
  assert.equal(balloon._variants[RED].clone.visible, false);
  assert.equal(balloon.bodyModel, balloon._variants[BLACK].clone);
});

test('第四十九修 · dropBalloonVariants：摘掉并释放变体、清空标记、之后不再切脸', () => {
  const { balloon, mesh, base } = fakeBoss();
  const redMat = balloon._variants[RED].clone.material;
  let disposed = 0;
  redMat.addEventListener('dispose', () => { disposed++; });
  dropBalloonVariants(balloon);
  assert.equal(disposed, 1, '变体材质应被释放');
  assert.equal(balloon._variants, null);
  assert.equal(balloon._variantBaseUrl, null);
  assert.equal(mesh.children.length, 1, '只留下本体（调用方随后自行释放/重建）');
  assert.equal(mesh.children[0], base);
  assert.equal(setBalloonVariant(balloon, RED), false);
});

test('第四十九修 · buildModelClone：材质独立克隆 + 几何共享标记 + 手动微调生效', () => {
  const scene = new THREE.Object3D();
  const m1 = fakeMesh();
  m1.geometry = new THREE.BoxGeometry(1, 2, 1);
  scene.add(m1);
  const { clone, mats, tune } = buildModelClone(scene, RED, 1.5);
  assert.equal(mats.length, 1);
  assert.notEqual(mats[0], m1.material, '材质必须是独立克隆（受击闪烁不能串到别的怪）');
  assert.equal(mats[0].isMaterial, true);
  let shared = 0;
  clone.traverse((o) => { if (o.isMesh && o.userData.sharedGeo) shared++; });
  assert.equal(shared, 1, '几何体与 glbCache 共享：销毁时不能 dispose');
  assert.ok(tune && typeof tune.scale === 'number');
  // 红脸 MODEL_TUNING 是 rot[1]=90 → 弧度 π/2
  assert.ok(Math.abs(clone.rotation.y - Math.PI / 2) < 1e-6, 'MODEL_TUNING 的朝向要生效');
});

// ============================================================
// 第五十修（现场文件）：「每个分身原地上下跳跃，但起跳位置不一，进而形成波浪形」
// ============================================================
test('黑脸分身波浪跳：26 个分身各有不同起跳相位，相邻差 < 半周期（才是波纹不是乱跳）', () => {
  const step = FACE_BOSS.BLACK_CLONE_BOB_PHASE_STEP;
  assert.equal(FACE_BOSS.BLACK_CLONE_COUNT, 26, "文件：26 个分身");
  assert.ok(FACE_BOSS.BLACK_CLONE_BOB_AMP > 0, "要有跳跃幅度");
  assert.ok(FACE_BOSS.BLACK_CLONE_BOB_FREQ > 0, "要有跳跃频率");
  assert.ok(step > 0, "相位必须错开 —— 齐跳是「一起蹦」，不是波浪");
  const n = FACE_BOSS.BLACK_CLONE_COUNT;
  const phases = Array.from({ length: n }, (_, i) => (i * step) % (Math.PI * 2));
  assert.equal(new Set(phases.map((p) => p.toFixed(6))).size, n, "每个分身的相位都不同");
  assert.ok(step < Math.PI, "相邻相位差必须小于半周期：否则圆环上看不出连续的波峰推进");
  assert.ok(step > 0.2, "相位差太小（< 0.2 rad）就看不出波峰在移动");
  // 跳跃幅度要明显大于蓝阶段的悬浮幅度（「跳」而不是「浮」）
  assert.ok(FACE_BOSS.BLACK_CLONE_BOB_AMP > FACE_BOSS.BLUE_MINION_BOB_AMP);
  // 停在冲锋之前：冲锋阶段还在上下弹会让轨迹看不清
  assert.ok(FACE_BOSS.BLACK_CLONE_CHARGE_START > FACE_BOSS.BLACK_CLONE_SPAWN_END);
});
