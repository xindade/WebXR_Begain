import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BUDDHA } from '../src/core/constants.js';
import { buddhaSweepDamage } from '../src/game/buddhaMath.js';
import { BulletManager } from '../src/game/bullets.js';
import { Player } from '../src/game/player.js';

const vec = (x, y, z) => new THREE.Vector3(x, y, z);

test('第八十四修 · 如来神掌初始数值与掌风弹窗口', () => {
  assert.equal(BUDDHA.DAMAGE, 350);
  assert.equal(BUDDHA.COOLDOWN, 12);
  assert.equal(BUDDHA.DAMAGE_MUL_CAP, 3);
  assert.equal(BUDDHA.ELITE_MUL, 0.5);
  assert.equal(BUDDHA.BOSS_MUL, 0.25);
  assert.equal(BUDDHA.PALM_WIND.ENABLED, true);
  assert.equal(BUDDHA.PALM_WIND.DURATION, 5);
  assert.equal(BUDDHA.PALM_WIND.DAMAGE_MUL, 1.5);
  assert.equal(BUDDHA.PALM_WIND.PIERCE, 1);
  assert.ok(BUDDHA.GROW_TIME + BUDDHA.MOVE_TIME <= 1.5, '起手演出应在 1.5 秒内收掌');
});

test('第八十四修 · 初始横扫：基础 350，倍率封顶 3，精英/Boss 单独减伤', () => {
  assert.equal(buddhaSweepDamage(null, 1), 350);
  assert.equal(buddhaSweepDamage({}, 3), 1050);
  assert.equal(buddhaSweepDamage({}, 5), 1050, '技能倍率 5 也必须被 DAMAGE_MUL_CAP 封到 3');
  assert.equal(buddhaSweepDamage({ isElite: true }, 3), 525);
  assert.equal(buddhaSweepDamage({ isBoss: true }, 3), 262.5);
  assert.equal(buddhaSweepDamage({ isDragonPart: true }, 3), 262.5);
});

test('第八十四修 · 掌风弹：攻击力 ×1.5、穿透 1、走独立 InstancedMesh', () => {
  const mgr = new BulletManager(new THREE.Scene(), new THREE.PerspectiveCamera());
  const p = new Player(new THREE.Scene(), new THREE.Group());
  p.shotCount = 1;
  p.atk = 100;
  p.fire(
    { position: vec(0, 1.4, 0), direction: vec(0, 0, -1) },
    mgr,
    { playShoot() {} },
    false,
    { palm: true, dmgMul: BUDDHA.PALM_WIND.DAMAGE_MUL, pierce: BUDDHA.PALM_WIND.PIERCE, trailMul: BUDDHA.PALM_WIND.TRAIL_MUL },
  );
  assert.equal(mgr.active.length, 1);
  assert.equal(mgr.active[0].palm, true);
  assert.equal(mgr.active[0].dmg, 150);
  assert.equal(mgr.active[0].pierce, 1);
  assert.equal(mgr.active[0].trailMul, 1.2);
  mgr.sync();
  assert.equal(mgr._instanced.count, 0, '掌风弹不应进入普通球体实例');
  assert.equal(mgr._palmInstanced.count, 1, '掌风弹应进入独立面片实例（+1 Draw Call）');
});

test('第八十四修 · 普通弹仍走原球体实例，不因掌风系统改变', () => {
  const mgr = new BulletManager(new THREE.Scene());
  const p = new Player(new THREE.Scene(), new THREE.Group());
  p.shotCount = 1;
  p.fire({ position: vec(0, 1.4, 0), direction: vec(0, 0, -1) }, mgr, { playShoot() {} });
  mgr.sync();
  assert.equal(mgr.active[0].palm, false);
  assert.equal(mgr._instanced.count, 1);
  assert.equal(mgr._palmInstanced.count, 0);
});
