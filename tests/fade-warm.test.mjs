// 第六十八修 · 切关/末尾精英卡顿的两条底层规则
//
//   ① 淡入材质不再在雾散那一帧一次性 transparent=false（会触发整批 shader 重编译）；
//      改成 restoreFadeStep 每帧恢复 1 份并立刻编译，全程藏在云雾里。
//   ② 融合吸收/切关清场不再同帧 dispose 十几只怪；先摘下来，再在下一关云雾里
//      flushRetired 每帧释放 2 只 —— 同时避免共用 shader program 被释放后立刻重编译。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BalloonManager } from '../src/game/balloons.js';
import { World } from '../src/core/world.js';

test('延迟释放：remove(b, true) 只摘不 dispose，flushRetired 才真正释放', () => {
  let disposed = 0;
  const b = { mesh: new THREE.Object3D(), alive: true, dispose() { disposed++; } };
  const dsMesh = new THREE.Object3D();
  const orb = new THREE.Object3D();
  b.depthSprite = { mesh: dsMesh };   // 2D 立绘：在独立场景里
  b._chargeOrb = orb;                 // 忍者蓄力球：单独挂在 manager.scene
  const mgr = Object.create(BalloonManager.prototype);
  mgr.scene = new THREE.Scene();
  mgr.list = [b];
  mgr._retired = [];
  mgr.scene.add(b.mesh);

  mgr.remove(b, true);
  assert.equal(mgr.list.length, 0);
  assert.equal(b.mesh.parent, null, '立刻从场景摘掉（视觉上已经消失）');
  assert.equal(disposed, 0, 'GPU 资源还没释放');
  assert.equal(mgr._retired.length, 1);
  // 第六十九修（现场）：末尾精英吸收小怪时，若玩家正在放黑洞，会看到「静止、打不到、没伤害数字」的小怪。
  //   它们其实已经从 list/scene 摘掉，但 DepthSprite 残影要等下一关才 dispose ⇒ 必须立刻隐藏。
  assert.equal(dsMesh.visible, false, '2D 立绘残影必须立刻隐藏');
  assert.equal(orb.visible, false, '忍者蓄力球必须立刻隐藏');

  mgr.flushRetired(1);
  assert.equal(disposed, 1, '云雾窗里再释放');
  assert.equal(mgr._retired.length, 0);
});

test('切关 clear() 同样先摘后放，不会在同一帧 dispose 全部怪', () => {
  let disposed = 0;
  const list = [];
  const mgr = Object.create(BalloonManager.prototype);
  mgr.scene = new THREE.Scene();
  mgr.list = list;
  mgr._retired = [];
  for (let i = 0; i < 6; i++) {
    const b = { mesh: new THREE.Object3D(), alive: true, dispose() { disposed++; } };
    mgr.scene.add(b.mesh);
    list.push(b);
  }
  mgr.clear();
  assert.equal(mgr.list.length, 0);
  assert.equal(disposed, 0, '切关帧零 dispose');
  assert.equal(mgr._retired.length, 6);
  mgr.flushRetired(2);
  assert.equal(disposed, 2, '每帧只释放 2 只');
  mgr.flushRetired(Infinity);
  assert.equal(disposed, 6);
});

test('淡入恢复分帧：restoreFadeStep 每帧恢复 1 份，最后一份才关掉 fadeOn', () => {
  const world = Object.create(World.prototype);
  world.scene = new THREE.Scene();
  world.camera = new THREE.PerspectiveCamera();
  world.renderer = null;
  const mk = (opacity) => {
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4 });
    return { mat, geo: new THREE.BoxGeometry(1, 1, 1), kind: 'mesh', baseOpacity: opacity, baseTransparent: false };
  };
  const a = mk(1), b = mk(0.8), c = mk(0.6);
  world._fadeMats = [a, b, c];
  world._fadeSeen = new Set([a.mat, b.mat, c.mat]);
  world._fadeOn = true;

  assert.equal(world.restoreFadeStep(world.camera, 1, 0), 1);
  assert.equal(world._fadeMats.length, 2);
  assert.equal(c.mat.transparent, false, '恢复成最终状态（从队尾取，顺序无所谓）');
  assert.equal(c.mat.opacity, 0.6);

  world.restoreFadeStep(world.camera, 1, 0);
  world.restoreFadeStep(world.camera, 1, 0);
  assert.equal(world._fadeMats, null);
  assert.equal(world._fadeOn, false, '全部恢复后关闭淡入开关');
});

test('全场景预热：没上过屏的材质会 initTexture + compile，且同一材质只做一次', () => {
  const world = Object.create(World.prototype);
  world.scene = new THREE.Scene();
  world.camera = new THREE.PerspectiveCamera();
  world.resetWarm();
  let inits = 0, compiles = 0;
  world.renderer = {
    initTexture() { inits++; },
    compile() { compiles++; },
  };
  const tex = new THREE.Texture();
  const mat = new THREE.MeshBasicMaterial({ map: tex });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  world.scene.add(mesh);

  const n1 = world.warmSceneGpu(world.camera, 0);
  assert.ok(n1 >= 1, '至少预热一份材质');
  assert.ok(inits >= 1, '贴图已上传');
  assert.ok(compiles >= 1, 'shader 已编译');

  const before = compiles;
  world.warmSceneGpu(world.camera, 0);
  assert.equal(compiles, before, '同一材质不重复编译');
});