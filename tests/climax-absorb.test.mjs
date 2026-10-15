// 第四十九修 · 三轮：末尾批（现场说的「精英Boss」）出现时，场上已有的精英也算光球吸进去
//
// 现场：「偶尔精英Boss死了，还有一个精英出现」。根因是旧口径只清杂鱼 ——
//   末尾批融合时 `!isElite` 把精英排除在外，金点批收尾时 `_clearTrash` 同样不动精英，
//   于是 5/15/25s 那批没被打死的普通精英继续在场上往玩家飘，看着就像"又冒出来一个"。
//   现在：末尾批融合时**精英优先化成光点**被吸走 + 收尾时兜底清精英。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WaveManager } from '../src/game/waves.js';
import { FUSE, isClimaxEvent } from '../src/content/spawnDirector.js';
import { SPAWN_LAYER } from '../src/core/constants.js';

function mkWave() {
  const removed = [];
  const balloons = {
    list: [],
    spawn() { throw new Error('本测试不该走 spawn'); },
    remove(b) { const i = balloons.list.indexOf(b); if (i >= 0) balloons.list.splice(i, 1); removed.push(b); },
  };
  const w = new WaveManager(new THREE.Scene(), balloons, () => new THREE.Vector3(), null, () => null);
  w.hooks = {};
  w._fired = 0;
  w.hooks.goldToCards = () => { w._fired++; };
  return { w, balloons, removed };
}

const mkB = (isElite, pos, isBoss = false) => ({
  alive: true, isElite, isBoss, batchId: 0,
  mesh: { position: new THREE.Vector3(pos[0], pos[1], pos[2]) },
});

const CLIMAX_EV = { do: 'elite', combos: [{ type: 'eliteKnight', count: 2 }], dir: 'frontLeft', via: 'merge', goldReturn: true };
const PLAIN_MERGE_EV = { do: 'elite', combos: [{ type: 'eliteKnight', count: 1 }], dir: 'front', via: 'merge' };
const POS = [new THREE.Vector3(0, 1.2, -22)];

test('前提：FUSE_CLEAR 开着、末尾批的判据是 goldReturn', () => {
  assert.equal(SPAWN_LAYER.FUSE_CLEAR, true);
  assert.equal(isClimaxEvent(CLIMAX_EV), true);
  assert.equal(isClimaxEvent(PLAIN_MERGE_EV), false);
});

test('★末尾批融合：场上已有精英（上一批 5/15/25s 的）也化成光点被吸走', () => {
  const { w, balloons } = mkWave();
  const oldElite = mkB(true, [0, 1, -8]);
  const trash1 = mkB(false, [0, 1, -5]);
  const trash2 = mkB(false, [0, 1, -3]);
  balloons.list = [oldElite, trash1, trash2];
  w._fuseSpawn(CLIMAX_EV, POS, 0x8888ff, 'mini', 7);
  assert.equal(balloons.list.length, 0, '精英 + 杂鱼全部被吸走');
  assert.equal(w._fuseGroups.length, 1);
  assert.equal(w._fuseGroups[0].items.length, 3, '三个来源各留一个光点');
  assert.equal(w._fuseGroups[0].items[0].from.z, -8, '精英优先当光源（第一个光点来自精英）');
});

test('非末尾批融合维持原口径：精英留在场上给玩家打', () => {
  const { w, balloons } = mkWave();
  const elite = mkB(true, [0, 1, -8]);
  const trash = mkB(false, [0, 1, -5]);
  balloons.list = [elite, trash];
  w._fuseSpawn(PLAIN_MERGE_EV, POS, null, 'mini', 1);
  assert.deepEqual(balloons.list, [elite], '只清杂鱼');
  assert.equal(w._fuseGroups[0].items.length, 1);
});

test('Boss 本体不受影响（只吸精英/杂鱼）', () => {
  const { w, balloons } = mkWave();
  const boss = mkB(false, [0, 2, -30], true);
  balloons.list = [boss];
  w._fuseSpawn(CLIMAX_EV, POS, null, 'mini', 2);
  assert.deepEqual(balloons.list, [boss], 'Boss 不能被融合吃掉');
  assert.equal(w._fuseGroups[0].items.length, 0);
});

test('融合时清掉未落地的旧光点（但不动融合自己的）', () => {
  const { w, balloons } = mkWave();
  balloons.list = [];
  const mkBeam = () => new THREE.Mesh(new THREE.SphereGeometry(0.1, 4, 4), new THREE.MeshBasicMaterial());
  const beamOld = mkBeam();
  const beamFuse = mkBeam();
  w._pendingSpawns = [
    { group: null, mesh: beamOld },
    { group: 'fuse', mesh: beamFuse },
  ];
  w._fuseSpawn(CLIMAX_EV, POS, null, 'mini', 3);
  assert.equal(w._pendingSpawns.length, 1);
  assert.equal(w._pendingSpawns[0].mesh, beamFuse);
});

test('★收尾：末尾批清空 → 金点抽卡，且场上不留任何精英', () => {
  const { w, balloons } = mkWave();
  w._eliteWatch.push({ batch: 9, seen: true, t: 0, hold: true });
  balloons.list = [mkB(true, [0, 1, -6])];   // 残留精英（旧口径会留着 → 现场"又冒出一个"）
  w._updateEliteWatch(0.1);
  assert.equal(w._fired, 1, '批次清空 → 触发抽卡');
  assert.equal(balloons.list.length, 0, '★ 收尾后场上不许再有精英');
});

test('_clearElites：只清精英，杂鱼与 Boss 不动', () => {
  const { w, balloons } = mkWave();
  const elite = mkB(true, [0, 1, -8]);
  const trash = mkB(false, [0, 1, -5]);
  const boss = mkB(false, [0, 2, -30], true);
  balloons.list = [elite, trash, boss];
  w._clearElites();
  assert.deepEqual(balloons.list, [trash, boss]);
});
