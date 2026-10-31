import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CHARACTERS } from '../src/core/constants.js';
import {
  swarmState, bombardState, blastDamage, archSlotOrder,
  rayHitsBalloon, raySphereExitDistance, BOMBARD_AIRBURST,
} from '../src/game/characters/rules.js';
import { roleAttrPool, roleBannedCards, ATTR_TYPES, ATTRIBUTE_STATS } from '../src/content/cards.js';
import { Player } from '../src/game/player.js';
import { BulletManager } from '../src/game/bullets.js';
import { BombardRig } from '../src/game/characters/bombard.js';
import { SatelliteRig } from '../src/game/characters/satellites.js';
import { Game } from '../src/game/game.js';

const vec = (x, y, z) => new THREE.Vector3(x, y, z);

test('第八十五修 · 角色初始属性：疾风 / 蜂群 / 爆炮手', () => {
  const p = new Player(new THREE.Scene(), new THREE.Group());

  p.reset('preview', 'rapid');
  assert.equal(p.atk, 50);
  assert.equal(p.fireRate, 4);
  assert.equal(p.fireMode, 'fan');
  assert.equal(p.characterKey, 'rapid');

  p.reset('preview', 'swarm');
  assert.equal(p.atk, 100);
  assert.equal(p.fireRate, 2);
  assert.equal(p.fireMode, 'satellite');
  assert.equal(p.characterKey, 'swarm');

  p.reset('preview', 'bombard');
  assert.equal(p.atk, 200);
  assert.equal(p.fireRate, 0.8);
  assert.equal(p.fireMode, 'bombard');
  assert.equal(p.characterKey, 'bombard');
});

test('第八十五修 · 蜂群：初始 2 支、10 支封顶、溢出加伤并封顶 100%', () => {
  const cfg = CHARACTERS.swarm.satellite;
  assert.deepEqual(
    pick(swarmState(1, 0, cfg)),
    { extra: 0, total: 2, count: 2, overflow: 0, dmgMul: 0.4 },
  );
  assert.deepEqual(
    pick(swarmState(9, 0, cfg)),
    { extra: 8, total: 10, count: 10, overflow: 0, dmgMul: 0.4 },
  );
  assert.deepEqual(
    pick(swarmState(12, 0, cfg)),
    { extra: 11, total: 13, count: 10, overflow: 3, dmgMul: 0.7 },
  );
  assert.equal(swarmState(20, 0, cfg).dmgMul, 1);
});

test('第八十六修 · 浮游炮拱门：两侧先出现，逐对向中间补齐', () => {
  const order = archSlotOrder(10);
  assert.equal(order[0], -1);
  assert.equal(order[1], 1);
  assert.ok(Math.abs(order[2] + 7 / 9) < 1e-12);
  assert.ok(Math.abs(order[3] - 7 / 9) < 1e-12);
  assert.deepEqual(archSlotOrder(2), [-1, 1]);
  assert.deepEqual(archSlotOrder(1), [0]);
});

test('第八十五修 · 爆炮手：1 条无微型火箭、6 枚封顶、溢出加伤并封顶 90%', () => {
  const cfg = CHARACTERS.bombard.bombard;
  assert.deepEqual(pick(bombardState(1, 0, cfg)), { extra: 0, count: 0, overflow: 0, dmgMul: 0.5 });
  assert.deepEqual(pick(bombardState(7, 0, cfg)), { extra: 6, count: 6, overflow: 0, dmgMul: 0.5 });
  assert.deepEqual(pick(bombardState(10, 0, cfg)), { extra: 9, count: 6, overflow: 3, dmgMul: 0.8 });
  assert.equal(bombardState(20, 0, cfg).dmgMul, 0.9);
});

test('第八十五修 · 爆炸伤害：中心全额、向边缘线性衰减、半径外为 0', () => {
  assert.equal(blastDamage(100, 2.5, 0, 0.4), 100);
  assert.equal(blastDamage(100, 2.5, 1.25, 0.4), 80);
  assert.equal(blastDamage(100, 2.5, 2.5, 0.4), 60);
  assert.equal(blastDamage(100, 2.5, 2.51, 0.4), 0);
});

test('第八十五修 · 爆炮手开火：主炮 1 枚 + 6 枚微型火箭，窄扇形且带爆炸参数', () => {
  const mgr = new BulletManager(new THREE.Scene());
  const p = new Player(new THREE.Scene(), new THREE.Group());
  p.reset('preview', 'bombard');
  p.shotCount = 7;
  const game = { player: p, bullets: mgr, audio: { playRocket() {} } };
  const rig = new BombardRig();
  const shot = { position: vec(0, 1.4, 0), direction: vec(0, 0, -1) };

  const n = rig.fire(game, shot, false, 1);
  assert.equal(n, 7);
  assert.equal(mgr.active.length, 7);

  const main = mgr.active[0];
  assert.equal(main.dmg, 200);
  assert.equal(main.blastRadius, CHARACTERS.bombard.bombard.MAIN_RADIUS);
  assert.equal(main.rocket, true);
  assert.equal(main.speed, CHARACTERS.bombard.bombard.SPEED);

  const extras = mgr.active.slice(1);
  for (const b of extras) {
    assert.equal(b.dmg, 100);
    assert.equal(b.blastRadius, CHARACTERS.bombard.bombard.EXTRA_RADIUS);
  }
  const xs = extras.map((b) => b.vel.x);
  assert.ok(Math.min(...xs) < 0 && Math.max(...xs) > 0, '微型火箭应左右铺开');
  assert.ok(new Set(xs.map((x) => x.toFixed(3))).size >= 5, '微型火箭方向不应重叠');
});

test('第八十五修 · 掌风窗口：火箭只继承伤害倍率，不切成掌形贴图', () => {
  const mgr = new BulletManager(new THREE.Scene());
  const p = new Player(new THREE.Scene(), new THREE.Group());
  p.reset('preview', 'bombard');
  p.shotCount = 7;
  const game = { player: p, bullets: mgr, audio: {} };
  new BombardRig().fire(game, { position: vec(0, 1.4, 0), direction: vec(0, 0, -1) }, false, 1.5);
  assert.equal(mgr.active[0].dmg, 300);
  assert.equal(mgr.active[1].dmg, 150);
  assert.ok(mgr.active.every((b) => b.palm === false));
});

test('第八十七修 · 「再大一点」：爆炮手爆炸半径翻倍，普通弹不受影响', () => {
  const mgr = new BulletManager(new THREE.Scene());
  const p = new Player(new THREE.Scene(), new THREE.Group());
  p.reset('preview', 'bombard');
  p.shotCount = 2;
  const game = {
    player: p, bullets: mgr, audio: { playRocket() {} },
    _itemLevel: (id) => (id === 'blastPlus' ? 1 : 0),
  };
  new BombardRig().fire(game, { position: vec(0, 1.4, 0), direction: vec(0, 0, -1) }, false, 1);
  const cfg = CHARACTERS.bombard.bombard;
  assert.equal(mgr.active[0].blastRadius, cfg.MAIN_RADIUS * 2);
  assert.equal(mgr.active[1].blastRadius, cfg.EXTRA_RADIUS * 2);
});

test('第八十八修 · 浮游炮：枪身 +X 与子弹方向严格同轴，枪口落在枪管轴线上', () => {
  const rig = Object.create(SatelliteRig.prototype);
  const pivot = new THREE.Object3D();
  pivot.position.set(0.8, 1.4, -1.3);
  rig._slots = [{ pivot, muzzleDist: 0.19 }];
  rig.count = 1;
  rig.dmgMul = 0.4;
  rig.cfg = CHARACTERS.swarm.satellite;
  const spawned = [];
  const game = {
    player: { atk: 100, characterKey: 'swarm', fireMode: 'satellite', shotCount: 5, bonusShotCount: 0 },
    bullets: { spawn: (pos, dir, dmg, boost, opts) => spawned.push({ pos: pos.clone(), dir: dir.clone(), dmg, opts }) },
    shopMode: false,
    state: 'playing',
    _gameTime: 0,
    _palmWindUntil: 0,
    _itemLevel: () => 0,
    _satelliteAutoTrack: false,
    balloons: { list: [] },
  };
  const n = rig.fire(game, { position: new THREE.Vector3(0, 1.4, 0), direction: new THREE.Vector3(0, 0, -1) }, false, 1);
  assert.equal(n, 1);
  assert.equal(spawned.length, 1);

  const barrel = new THREE.Vector3(1, 0, 0).applyQuaternion(pivot.quaternion).normalize();
  assert.ok(barrel.distanceTo(spawned[0].dir) < 1e-6, '子弹方向必须等于枪身 +X（同一根枪管）');
  assert.ok(spawned[0].pos.clone().sub(pivot.position).normalize().distanceTo(barrel) < 1e-6,
    '枪口必须沿枪管轴线在枪身前方');
  assert.ok(Math.abs(spawned[0].pos.distanceTo(pivot.position) - 0.19) < 1e-6);
});

test('第八十八修 · 浮游炮朝向不继承头显滚转：本地 +Y 保持世界向上', () => {
  const rig = Object.create(SatelliteRig.prototype);
  const pivot = new THREE.Object3D();
  rig._orientGun(pivot, new THREE.Vector3(0, 0, -1));
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(pivot.quaternion);
  assert.ok(up.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-6, '水平瞄准时枪身不应被头显滚转带歪');

  const pitched = new THREE.Vector3(0, 0.6, -0.8).normalize();
  rig._orientGun(pivot, pitched);
  const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(pivot.quaternion).normalize();
  const up2 = new THREE.Vector3(0, 1, 0).applyQuaternion(pivot.quaternion).normalize();
  assert.ok(fwd.distanceTo(pitched) < 1e-6, '枪口仍要严格对准目标方向');
  assert.ok(Math.abs(up2.x) < 1e-6, '枪身向上应落在世界竖直平面内，而不是跟随头部滚转');
});

test('第八十八修 · 蜂群教学前不索敌 / 解锁后才索敌', () => {
  const mkRig = () => {
    const rig = Object.create(SatelliteRig.prototype);
    const pivot = new THREE.Object3D();
    pivot.position.set(0, 1.3, -1.2);
    rig._slots = [{ pivot, muzzleDist: 0.19 }];
    rig.count = 1;
    rig.dmgMul = 0.4;
    rig.cfg = CHARACTERS.swarm.satellite;
    return { rig, pivot };
  };
  const target = { alive: true, mesh: { position: new THREE.Vector3(4, 1.3, -12) }, behavior: 'basic' };
  const mkGame = (auto) => {
    const out = [];
    return {
      out,
      player: { atk: 100, characterKey: 'swarm', fireMode: 'satellite', shotCount: 5, bonusShotCount: 0 },
      bullets: { spawn: (pos, dir) => out.push({ pos: pos.clone(), dir: dir.clone() }) },
      shopMode: false, state: 'playing', _gameTime: 0, _palmWindUntil: 0,
      _itemLevel: () => 0,
      _satelliteAutoTrack: auto,
      balloons: { list: [target] },
    };
  };
  const shot = { position: new THREE.Vector3(0, 1.3, 0), direction: new THREE.Vector3(0, 0, -1) };

  const locked = mkRig();
  const g0 = mkGame(false);
  locked.rig.fire(g0, shot, false, 1);
  assert.ok(g0.out[0].dir.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-6,
    '拿卡前浮游炮只沿枪管直射，不能自己拐向目标');

  const unlocked = mkRig();
  const g1 = mkGame(true);
  unlocked.rig.fire(g1, shot, false, 1);
  assert.ok(g1.out[0].dir.distanceTo(new THREE.Vector3(0, 0, -1)) > 0.01,
    '拿卡后才会自动追踪目标');
});

test('第八十九修 · 爆炮手 8 米空爆：先探测弹道，有敌人不空爆，无敌人飞到 8 米球面', () => {
  const mkBombardGame = (unlocked) => {
    const mgr = new BulletManager(new THREE.Scene());
    const p = new Player(new THREE.Scene(), new THREE.Group());
    p.reset('preview', 'bombard');
    p.shotCount = 2;                     // 主炮 + 1 枚微型火箭，便于同时验证两条弹道
    return { player: p, bullets: mgr, audio: {}, _bombardAirburst: unlocked, balloons: { list: [] } };
  };
  const g1 = mkBombardGame(true);
  new BombardRig().fire(g1, { position: vec(0, 1.4, 0), direction: vec(0, 0, -1) }, false, 1);
  const expect = Math.sqrt(8 * 8 - 1.4 * 1.4);
  assert.ok(Math.abs(g1.bullets.active[0].airburst - expect) < 1e-6, '主炮在 8 米球面空爆');
  assert.ok(Math.abs(g1.bullets.active[1].airburst - expect) < 1e-6, '微型火箭同样享受空爆');

  const g0 = mkBombardGame(false);
  new BombardRig().fire(g0, { position: vec(0, 1.4, 0), direction: vec(0, 0, -1) }, false, 1);
  assert.equal(g0.bullets.active[0].airburst, 0, '未解锁时保持原样');

  // 10m 外有敌人：必须继续飞过去打，不能提前在 8m 空爆。
  const gFar = mkBombardGame(true);
  gFar.balloons.list = [{ alive: true, mesh: { position: vec(0, 1.4, -10) }, hitRadius: 0.6 }];
  new BombardRig().fire(gFar, { position: vec(0, 1.4, 0), direction: vec(0, 0, -1) }, false, 1);
  assert.equal(gFar.bullets.active[0].airburst, 0, '10m 外有敌人 → 不提前空爆');

  // 背后的敌人不阻断前方空爆。
  const gBehind = mkBombardGame(true);
  gBehind.balloons.list = [{ alive: true, mesh: { position: vec(0, 1.4, 10) }, hitRadius: 0.6 }];
  new BombardRig().fire(gBehind, { position: vec(0, 1.4, 0), direction: vec(0, 0, -1) }, false, 1);
  assert.ok(gBehind.bullets.active[0].airburst > 7, '背后敌人不算弹道命中');

  // 直接驱动 _collide：没有敌人，飞过 8 米球面的那一帧应在球面空爆并消费子弹。
  const g = mkBombardGame(true);
  g.player.shotCount = 1;              // 只测主炮这一条弹道，便于断言「释放后清空」
  new BombardRig().fire(g, { position: vec(0, 1.4, 0), direction: vec(0, 0, -1) }, false, 1);
  const b = g.bullets.active[0];
  b.prevPos.copy(b.pos);
  b.pos.copy(b.origin).add(vec(0, 0, -9));
  g.balloons = { list: [] };
  g.world = { camera: new THREE.PerspectiveCamera() };
  g._camPos = new THREE.Vector3();
  g.waves = {};
  let blastAt = null;
  g._explodeBullet = (_b, at) => { blastAt = at.clone(); };
  g._spawnExplosionFx = () => {};
  Game.prototype._collide.call(g);
  assert.ok(blastAt, '飞过 8 米球面应自动空爆');
  assert.ok(Math.abs(blastAt.z + expect) < 1e-6, '空爆点必须在弹道上与 8 米球面的交点');
  assert.equal(g.bullets.active.length, 0, '空爆后子弹应释放');
});

test('第八十九修 · 空爆纯函数：球面距离 / 射线命中 / 背后目标不计入', () => {
  const origin = vec(0, 1.4, 0);
  assert.ok(Math.abs(raySphereExitDistance(origin, vec(0, 0, -1), { x: 0, y: 0, z: 0 }, 8)
    - Math.sqrt(64 - 1.96)) < 1e-6);
  const list = [{ alive: true, mesh: { position: vec(0, 1.4, -10) }, hitRadius: 0.6 }];
  assert.equal(rayHitsBalloon(origin, vec(0, 0, -1), list), true);
  assert.equal(rayHitsBalloon(origin, vec(0, 0, 1), list), false);
  assert.equal(rayHitsBalloon(origin, vec(0, 0, -1), [
    { alive: true, behavior: 'ghost', revealed: false, mesh: { position: vec(0, 1.4, -5) }, hitRadius: 0.6 },
  ]), false, '未显形幽灵不可命中，不应阻断空爆');
  assert.equal(BOMBARD_AIRBURST.RADIUS, 8);
});

test('第八十九修 · 爆炮手专属卡：multiShot → multiBlast，且原卡被禁用', () => {
  assert.deepEqual(roleAttrPool(['multiShot', 'atk'], 'bombard'), ['multiBlast', 'atk']);
  assert.deepEqual(roleAttrPool(['multiShot', 'atk'], 'swarm'), ['multiShot', 'atk']);
  assert.deepEqual(roleBannedCards('bombard'), ['multiShot']);
  assert.deepEqual(roleBannedCards('swarm'), ['multiBlast']);

  const def = ATTR_TYPES.find(c => c.id === 'multiBlast');
  assert.ok(def, '多重爆炸卡必须存在');
  const p = { multiBlast: 0 };
  def.apply(p); def.apply(p); def.apply(p); def.apply(p);
  assert.equal(p.multiBlast, ATTRIBUTE_STATS.multiBlast[2], '最多 3 级');
});

test('第八十九修 · 浮游炮姿态只认射击射线，不继承枪模/相机滚转', () => {
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(0, 1.6, 0);
  cam.rotation.set(0.3, 0.7, 0.9, 'YXZ');   // 故意给一个离谱的相机滚转
  const rig = new SatelliteRig(new THREE.Scene(), cam);
  const dir = vec(0.2, 0.1, -1).normalize();
  const game = {
    player: { fireMode: 'satellite', shotCount: 3, bonusShotCount: 0, characterKey: 'swarm' },
    input: { getMuzzle: (_p, out) => out.copy(dir) },
    rightGun: new THREE.Object3D(),
    balloons: { list: [] },
    state: 'playing', shopMode: false, _introActive: false,
  };
  rig.update(0.016, game);
  const got = new THREE.Vector3();
  let checked = 0;
  for (const slot of rig._slots) {
    if (!slot.pivot.visible) continue;
    got.set(1, 0, 0).applyQuaternion(slot.pivot.quaternion).normalize();
    assert.ok(got.distanceTo(dir) < 1e-6, '浮游炮 +X 必须严格等于本次射击射线');
    checked++;
  }
  assert.ok(checked > 0);

  // 有索敌目标时，枪身与「该炮到目标」的连线同轴；同样不受相机滚转影响。
  const target = { alive: true, mesh: { position: vec(5, 1.6, -5) } };
  game.balloons.list = [target];
  rig.update(0.016, game);
  for (const slot of rig._slots) {
    if (!slot.pivot.visible) continue;
    const want = target.mesh.position.clone().sub(slot.pivot.position).normalize();
    got.set(1, 0, 0).applyQuaternion(slot.pivot.quaternion).normalize();
    assert.ok(got.distanceTo(want) < 1e-6, '有目标时 +X 必须指向该炮自己的弹道目标');
  }
});

test('第八十九修 · 多重爆炸：首层追加 N 次弱化爆炸，且不递归', () => {
  const g = Object.create(Game.prototype);
  const target = {
    alive: true, effectiveRadius: 0.5, hits: 0,
    mesh: { position: vec(0, 0, 0) },
    takeDamage(d) { this.hits++; this.last = d; return false; },
  };
  g.balloons = { list: [target] };
  g.player = { characterKey: 'bombard', multiBlast: 3 };
  g._gameTime = 1;
  g._spawnBlastFx = () => {};
  g._applyShopDamage = (_t, d) => d;
  g._damageFeedback = () => {};
  g._onKilled = () => {};
  g._bulletKill = () => {};
  g._shopBulletKill = () => {};

  g._explodeBullet({ pos: vec(0, 0, 0), dmg: 100, blastRadius: 2.5, blastEdge: 0 });
  assert.equal(target.hits, 4, '本体 1 次 + 追加 3 次');
  assert.equal(target.last, 50, '追加爆炸按 50% 伤害，不会无限递归');

  const other = { characterKey: 'swarm', multiBlast: 3 };
  g.player = other;
  target.hits = 0; target.last = 0;
  g._explodeBullet({ pos: vec(0, 0, 0), dmg: 100, blastRadius: 2.5, blastEdge: 0 });
  assert.equal(target.hits, 1, '其它角色不触发多重爆炸');
});

test('第八十五修 · 爆炸结算：半径内按距离衰减，半径外不掉血', () => {
  const g = Object.create(Game.prototype);
  const mk = (x) => {
    const t = {
      alive: true, effectiveRadius: 0.5, _lastDamage: 0,
      mesh: { position: vec(x, 0, 0) },
      takeDamage(d) { this._lastDamage = d; this.alive = false; return true; },
    };
    return t;
  };
  const near = mk(0);
  const mid = mk(1.25);
  const far = mk(3.2);
  g.balloons = { list: [near, mid, far] };
  g._gameTime = 1;
  g._spawnBlastFx = () => {};
  g._applyShopDamage = (_t, d) => d;
  g._damageFeedback = () => {};
  g._onKilled = () => {};
  g._bulletKill = () => {};
  g._shopBulletKill = () => {};

  g._explodeBullet({ pos: vec(0, 0, 0), dmg: 100, blastRadius: 2.5, blastEdge: 0.4 });
  assert.equal(near._lastDamage, 100);
  assert.ok(mid._lastDamage > 60 && mid._lastDamage < 100, '中距离应衰减但仍高于边缘保底');
  assert.equal(far._lastDamage, 0);
});

test('第九十修 · 爆炮手的爆炸对龙部件额外衰减到 1.5%', () => {
  const g = Object.create(Game.prototype);
  const mk = (isDragonPart) => ({
    alive: true,
    effectiveRadius: 0.5,
    isDragonPart,
    damageReduction: isDragonPart ? 0.95 : 0,
    _lastDamage: 0,
    mesh: { position: vec(0, 0, 0) },
    takeDamage(d) {
      this._lastDamage = d * (1 - this.damageReduction);
      return false;
    },
  });
  const dragon = mk(true);
  const normal = mk(false);
  g.balloons = { list: [dragon, normal] };
  g._gameTime = 1;
  g._spawnBlastFx = () => {};
  g._applyShopDamage = (_t, d) => d;
  g._damageFeedback = () => {};
  g._onKilled = () => {};
  g._bulletKill = () => {};
  g._shopBulletKill = () => {};

  g.player = { characterKey: 'bombard' };
  g._explodeBullet({ pos: vec(0, 0, 0), dmg: 100, blastRadius: 2.5, blastEdge: 0 });
  assert.ok(Math.abs(dragon._lastDamage - 1.5) < 1e-9, '爆炮手：100 × 0.30 × 5% = 1.5（总减伤 98.5%）');
  assert.equal(normal._lastDamage, 100, '非龙部件不受额外衰减');

  dragon._lastDamage = 0;
  g.player = { characterKey: 'rapid' };
  g._explodeBullet({ pos: vec(0, 0, 0), dmg: 100, blastRadius: 2.5, blastEdge: 0 });
  assert.ok(Math.abs(dragon._lastDamage - 5) < 1e-9, '其它角色仍按原有 95% 减伤，实际 5%');
});

function pick(st) {
  const o = { extra: st.extra, count: st.count, overflow: st.overflow, dmgMul: st.dmgMul };
  if (st.total !== undefined) o.total = st.total;
  return o;
}
