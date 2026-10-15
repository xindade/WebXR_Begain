// 第四十九修 · 连杀加速的「看得见」：加速期打出的子弹变蓝 + 曳光加长一倍
//
// 现场反馈「完成杀敌十个的时候感觉不明显」，于是加速期发射的子弹改用实例色染蓝（不增加 Draw Call）、
// 曳光变蓝并加长一倍。这里守四件事：
//   ① 材质基色必须是白（实例色是乘上去的，材质带蓝会把加速蓝乘脏）；
//   ② instanceColor 缓冲在**构造时**就建好（否则第一次加速现场上传整块缓冲 → 又多一个卡顿点）；
//   ③ boost 标记从 Player.fire 一路传到 BulletManager.spawn → sync 写实例色；
//   ④ game._updateFx 只给加速弹换色/加长，普通弹一个字节都不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BulletManager } from '../src/game/bullets.js';
import { TracerTail } from '../src/game/fx.js';
import { Player } from '../src/game/player.js';
import { SHOOT, RAPID_FIRE, FX } from '../src/core/constants.js';

// game.js 顶部会 preload 视觉纹理；这里只需要一个最小桩（同 boss-skills.test.mjs）
const originalLoad = THREE.TextureLoader.prototype.load;
let Game;
try {
  THREE.TextureLoader.prototype.load = () => new THREE.Texture();
  ({ Game } = await import('../src/game/game.js'));
} finally { THREE.TextureLoader.prototype.load = originalLoad; }

const vec = (x, y, z) => new THREE.Vector3(x, y, z);
// 颜色比较统一走「同一条 setHex 路径」——ColorManagement 会把 sRGB 转线性再转回来，直接比 getHex 会有舍入噪声
const sameHex = (col, hex) => col.getHex() === new THREE.Color().setHex(hex).getHex();

test('第四十九修 · 子弹材质基色是白（实例色乘法：非白会把加速蓝乘脏）', () => {
  const mgr = new BulletManager(new THREE.Scene());
  assert.ok(sameHex(mgr._instanced.material.color, 0xffffff), 'MeshBasicMaterial 基色必须 0xffffff');
});

test('第四十九修 · instanceColor 缓冲在构造时就建好（第一次加速不再现场上传）', () => {
  const mgr = new BulletManager(new THREE.Scene());
  assert.ok(mgr._instanced.instanceColor, '构造后就该有 instanceColor');
  assert.equal(mgr._instanced.instanceColor.count, mgr.capacity, '整池一次性刷成默认色');
  const col = new THREE.Color();
  mgr._instanced.getColorAt(0, col);
  assert.ok(sameHex(col, SHOOT.BULLET_COLOR), '池子初始色 = 普通子弹色');
  mgr._instanced.getColorAt(mgr.capacity - 1, col);
  assert.ok(sameHex(col, SHOOT.BULLET_COLOR), '池尾也是默认色');
});

test('第四十九修 · spawn(boost) → sync 写实例色：加速弹蓝、普通弹原色', () => {
  const mgr = new BulletManager(new THREE.Scene());
  mgr.spawn(vec(0, 0, 0), vec(0, 0, -1), 5, true);    // 加速期打出
  mgr.spawn(vec(0, 0, 0), vec(0, 0, -1), 5);          // 普通
  mgr.sync();
  const col = new THREE.Color();
  mgr._instanced.getColorAt(0, col);
  assert.ok(sameHex(col, RAPID_FIRE.VISUAL.BULLET_COLOR), '加速弹 = 青蓝');
  mgr._instanced.getColorAt(1, col);
  assert.ok(sameHex(col, SHOOT.BULLET_COLOR), '普通弹 = 默认色');
  // 复用池里的旧对象必须被重置：否则「上一颗是加速弹」的 boost 会粘到复用出来的新弹上
  const reused = mgr.active[0];
  mgr.release(reused);
  mgr.spawn(vec(0, 0, 0), vec(0, 0, -1), 5);
  mgr.sync();
  const idx = mgr.active.indexOf(mgr.active[mgr.active.length - 1]);
  mgr._instanced.getColorAt(idx, col);
  assert.ok(sameHex(col, SHOOT.BULLET_COLOR), '复用出来的普通弹不能被上一颗的 boost 污染');
});

test('第四十九修 · Player.fire 把 boost 透传给每一发子弹（单发 / 多弹道都要）', () => {
  const shot = { position: vec(0, 1, 0), direction: vec(0, 0, -1) };
  const audio = { playShoot() {} };
  const one = [];
  Player.prototype.fire.call({ forceSingleShot: false, shotCount: 1, atk: 9 }, shot, { spawn: (p, d, dmg, b) => one.push(b) }, audio, true);
  assert.deepEqual(one, [true], '单发：boost 透传');
  const many = [];
  Player.prototype.fire.call({ forceSingleShot: false, shotCount: 4, atk: 9 }, shot, { spawn: (p, d, dmg, b) => many.push(b) }, audio, true);
  assert.deepEqual(many, [true, true, true, true], '多弹道：每一发都是加速弹');
  const off = [];
  Player.prototype.fire.call({ forceSingleShot: false, shotCount: 1, atk: 9 }, shot, { spawn: (p, d, dmg, b) => off.push(b) }, audio);
  assert.deepEqual(off, [false], '不传 boost 时默认 false（加速结束后立刻恢复正常色）');
});

test('第四十九修 · 曳光 lenScale：加速弹的长度是配置的两倍', () => {
  const t = new TracerTail(new THREE.Scene());
  t.begin();
  assert.equal(t.add(vec(0, 0, -10), vec(0, 0, -1), null, null, RAPID_FIRE.VISUAL.TRACER_MUL), true);
  t.end();
  const m = new THREE.Matrix4();
  t.mesh.getMatrixAt(0, m);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  assert.ok(Math.abs(s.y - FX.TRACER.LENGTH * RAPID_FIRE.VISUAL.TRACER_MUL) < 1e-6, '长轴 = LENGTH × 2');
});

test('第四十九修 · game._updateFx：只有加速弹换蓝加长，普通弹保持原样', () => {
  const calls = [];
  const tail = { begin() {}, end() {}, add: (pos, dir, color, back, lenScale) => calls.push({ color, back, lenScale }) };
  const that = {
    fx: { update() {}, tracer: tail },
    bullets: { active: [
      { pos: vec(0, 0, -10), vel: vec(0, 0, -1), origin: vec(0, 0, 0), boost: true },
      { pos: vec(1, 0, -10), vel: vec(0, 0, -1), origin: vec(1, 0, 0), boost: false },
    ] },
    projectiles: null, damageNumbers: null, _tailDir: new THREE.Vector3(),
  };
  Game.prototype._updateFx.call(that, 1 / 60);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].color, RAPID_FIRE.VISUAL.TRACER_COLOR, '加速弹曳光 = 青蓝');
  assert.equal(calls[0].lenScale, RAPID_FIRE.VISUAL.TRACER_MUL, '加速弹曳光加长');
  assert.equal(calls[1].color, FX.TRACER.COLOR, '普通弹曳光色不变');
  assert.equal(calls[1].lenScale, 1, '普通弹曳光长度不变');
});
