import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Balloon, BalloonManager } from '../src/game/balloons.js';
import { ProjectileManager } from '../src/game/projectiles.js';
import { Vignette } from '../src/vr/vignette.js';
import { PROJECTILE, SHURIKEN } from '../src/core/constants.js';
import { ENEMY_TYPES } from '../src/content/enemies.js';

// 第三十五修：幽灵「鬼火」/ 章鱼「墨汁」套用忍者的投射物发射方式，
// 命中玩家后视野周边短暂着色（紫 / 黑）。本文件只测这套机制，不涉及渲染。

const DT = 1 / 60;
const PLAYER = new THREE.Vector3(0, 1.4, 0);

/** 造一只「只跑行为状态机」的怪：不加载 GLB、不建占位外观，只测投掷节奏与门禁。 */
function makeEnemy(manager, behavior, pos) {
  const b = Object.create(Balloon.prototype);
  Object.assign(b, {
    manager, behavior, type: ENEMY_TYPES[behavior],
    alive: true, mesh: new THREE.Object3D(),
    _fireTimer: 0, _chargeOrb: null, revealed: false,
    controlled: false, isDragonPart: false,
    _ninjaPhase: 'appear', _ninjaTimer: 0,
  });
  b.mesh.position.copy(pos);
  manager.list.push(b);
  return b;
}

function makeManager() {
  const mgr = new BalloonManager(new THREE.Scene());
  const pm = new ProjectileManager(mgr.scene);
  mgr.setProjectileManager(pm);
  mgr._playerPos = PLAYER;
  return { mgr, pm };
}

test('幽灵与章鱼各自只有最靠近玩家的那一只发射，且互不干扰', () => {
  const { mgr, pm } = makeManager();
  const ghostFar  = makeEnemy(mgr, 'ghost',   new THREE.Vector3(0, 1, -20));
  const ghostNear = makeEnemy(mgr, 'ghost',   new THREE.Vector3(0, 1, -6));
  const octoFar   = makeEnemy(mgr, 'octopus', new THREE.Vector3(6, 1, -20));
  const octoNear  = makeEnemy(mgr, 'octopus', new THREE.Vector3(2, 1, -6));
  const all = [ghostFar, ghostNear, octoFar, octoNear];

  for (let i = 0; i < 60 * 3 + 6; i++) for (const b of all) b._updateBehavior(DT, PLAYER);

  assert.equal(pm.count, 2, '一个开火周期后应只有 2 发（幽灵 1 + 章鱼 1）');
  assert.deepEqual(pm.list.map((p) => p.kind).sort(), ['ghostfire', 'ink']);
  assert.ok(pm.list.every((p) => Math.abs(p.mesh.position.z + 6) < 1e-6), '两发都从最近者头顶发出');
  assert.ok(pm.list.every((p) => p.dmg === ENEMY_TYPES.ghost.ghostFireDamage), '伤害取自敌人配置');
});

test('忍者手里剑沿用原通道，且不触发视野着色', () => {
  const { mgr, pm } = makeManager();
  const ninja = makeEnemy(mgr, 'ninja', new THREE.Vector3(0, 1, -12));
  for (let i = 0; i < 60 * 6; i++) ninja._updateBehavior(DT, PLAYER);   // 出现 3s + 蓄力 2s
  assert.equal(pm.count, 1);
  assert.equal(pm.list[0].kind, 'shuriken');
  assert.equal(pm.list[0].dmg, SHURIKEN.DAMAGE, '忍者伤害沿用 SHURIKEN.DAMAGE，不因新机制被改动');
  assert.equal(pm.tintOf('shuriken'), null, '手里剑不着色（保持原有手感）');
  assert.equal(pm.tintOf('ghostfire'), PROJECTILE.GHOST_FIRE.TINT);
  assert.equal(pm.tintOf('ink'), PROJECTILE.INK.TINT);
});

test('幽灵只在蓄力窗口内显形（显形期 = 玩家的攻击窗口）', () => {
  const { mgr, pm } = makeManager();
  const ghost = makeEnemy(mgr, 'ghost', new THREE.Vector3(0, 1, -8));
  const cycle = ENEMY_TYPES.ghost.ghostFireInterval;
  const charge = ENEMY_TYPES.ghost.ghostFireCharge;

  ghost._updateBehavior(cycle - charge - 0.1, PLAYER);      // 周期前段：未蓄力
  assert.equal(ghost.revealed, false);
  assert.equal(ghost.mesh.visible, false);

  ghost._updateBehavior(0.2, PLAYER);                       // 进入蓄力窗口
  assert.equal(ghost.revealed, true);
  assert.equal(ghost.mesh.visible, true);
  assert.equal(ghost._chargeOrb.visible, true, '蓄力期头顶显示光球');

  ghost._updateBehavior(charge, PLAYER);                    // 蓄力结束 → 投鬼火
  assert.equal(pm.count, 1);
  assert.equal(ghost._chargeOrb.visible, false);
  assert.equal(ghost.revealed, false, '投掷后回到隐身');
});

test('命中玩家：回调带伤害与类型，伤害可被调用方覆盖', () => {
  const pm = new ProjectileManager(new THREE.Scene());
  const hits = [];
  pm.setOnHit((d, kind) => hits.push([d, kind]));

  pm.spawn('ghostfire', new THREE.Vector3(0, 1.4, -6), PLAYER);
  for (let i = 0; hits.length === 0 && i < 120; i++) pm.update(DT, PLAYER);
  assert.deepEqual(hits, [[PROJECTILE.GHOST_FIRE.DAMAGE, 'ghostfire']]);
  assert.equal(pm.count, 0, '命中即回收');

  pm.spawn('ink', new THREE.Vector3(0, 1.4, -6), PLAYER, { damage: 7 });
  for (let i = 0; hits.length < 2 && i < 120; i++) pm.update(DT, PLAYER);
  assert.deepEqual(hits[1], [7, 'ink'], '单发伤害以敌人配置为准（enemies.js 优先）');
});

test('未命中的投射物按 MAX_LIFE 自动回收', () => {
  const pm = new ProjectileManager(new THREE.Scene());
  pm.spawn('ink', new THREE.Vector3(0, 1.4, 6), new THREE.Vector3(0, 1.4, 30));
  const away = new THREE.Vector3(0, 1.4, -40);
  const steps = Math.ceil((PROJECTILE.INK.MAX_LIFE + 0.5) / DT);
  for (let i = 0; i < steps; i++) pm.update(DT, away);
  assert.equal(pm.count, 0);
});

test('命中着色层：挂在相机下、渐亮再褪回透明、并按 FOV 铺满视野', () => {
  const cam = new THREE.PerspectiveCamera(70, 1.7, 0.05, 200);
  const v = new Vignette(cam);
  assert.equal(v.sprite.parent, cam, '挂在相机下才会随头动');
  assert.equal(v.sprite.material.depthTest, false, '必须压在所有物体之上');
  assert.equal(v.sprite.visible, false);
  assert.ok(v.sprite.scale.y > 0);

  v.flash(PROJECTILE.INK.TINT);
  assert.equal(v.sprite.visible, true);
  assert.equal(v.sprite.material.color.getHex(), PROJECTILE.INK.TINT);
  assert.equal(v.sprite.material.opacity, 0, '从上色起点开始');

  v.update(PROJECTILE.VIGNETTE.RISE);
  const peak = v.sprite.material.opacity;
  assert.ok(peak > 0.4 && peak <= PROJECTILE.VIGNETTE.OPACITY + 1e-9, '峰值应接近 OPACITY，实际 ' + peak);

  v.update(PROJECTILE.VIGNETTE.FADE + 0.01);
  assert.equal(v.sprite.visible, false, '褪色结束自动隐藏');
  assert.equal(v.sprite.material.opacity, 0);

  cam.fov = 90;                       // XR 下 three 会把 fov 改写成单眼 FOV → 尺寸需跟着变
  v.flash(PROJECTILE.GHOST_FIRE.TINT);
  v.update(0.01);
  assert.ok(v.sprite.scale.y > v.sprite.scale.x / PROJECTILE.VIGNETTE.ASPECT - 1e-6);
  assert.ok(v.sprite.scale.y > 0.5, 'fov 90 时应覆盖约 1m 高的视野平面，实际 ' + v.sprite.scale.y);
});

test('设计值：鬼火/墨汁单发伤害为 5，命中着色分别为紫 / 黑', () => {
  assert.equal(ENEMY_TYPES.ghost.ghostFireDamage, 5);
  assert.equal(ENEMY_TYPES.octopus.inkDamage, 5);
  assert.equal(PROJECTILE.GHOST_FIRE.DAMAGE, 5);
  assert.equal(PROJECTILE.INK.DAMAGE, 5);
  assert.equal(PROJECTILE.GHOST_FIRE.TINT, 0xb46bff);
  assert.equal(PROJECTILE.INK.TINT, 0x05050c);
});