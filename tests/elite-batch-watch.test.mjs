// 第四十九修 · 精英批次观察 / 名牌分档 / 直出路径带参数
//
// 为什么值得锁死：这三条全是**现场才炸**的表现层故障 ——
//   ① 「第 4 关：普通精英被打死时，末尾精英刚出来就把选项卡弹了」（批次观察按层判定）
//   ② 「末尾精英要加 Boss 后缀、普通精英只显示名字」（名牌分档）
//   ③ 无传送门时精英丢掉 hp/isElite/体型（_queueSpawn 的直出分支漏传 balloon）
// 全是纯逻辑，本地几毫秒就能挡住。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WaveManager } from '../src/game/waves.js';
import { eliteLabelText, CLIMAX_SUFFIX } from '../src/content/spawnDirector.js';
import { FUSE } from '../src/content/spawnDirector.js';

// 最小假气球管理器：只提供 waves 真正会碰的两个面（list / spawn / remove）
function mkWave() {
  const spawned = [];
  const balloons = {
    list: [],
    spawn(type, pos, opts) {
      const b = {
        type: { id: type }, pos, opts, alive: true, radius: 1,
        mesh: new THREE.Object3D(), isElite: !!(opts && opts.isElite),
        batchId: (opts && opts.batchId) || 0,
      };
      spawned.push(b); balloons.list.push(b); return b;
    },
    remove(b) { const i = balloons.list.indexOf(b); if (i >= 0) balloons.list.splice(i, 1); },
  };
  const w = new WaveManager(new THREE.Scene(), balloons, () => new THREE.Vector3(), null, () => null);
  w.hooks = {};
  w._fired = 0;
  w.hooks.goldToCards = () => { w._fired++; };
  return { w, spawned, balloons };
}

const ELITE_EV = (extra = {}) => Object.assign(
  { t: 30.7, do: 'elite', combos: [{ type: 'eliteKnight', count: 2 }], dir: 'front', via: 'portal' }, extra);

test('★回归：金点批次观察按「批」，普通精英被打死不会提前弹选项卡（第 4 关踩过）', () => {
  const { w, balloons } = mkWave();
  // 末尾批（batch=2）在观察中：它的怪还没落地
  w._eliteWatch.push({ batch: 2, seen: false, t: 0, hold: true });
  // 场上活着的却是**同层普通批**（batch=1）——旧实现按层判定，会把 seen 顶成 true
  balloons.list = [
    { alive: true, isElite: true, batchId: 1 },
    { alive: true, isElite: true, batchId: 1 },
  ];
  w._updateEliteWatch(0.1);
  assert.equal(w._fired, 0, '普通批出现不该算末尾批「已出现」');
  assert.equal(w._eliteWatch.length, 1, '观察条目必须留着');
  // 普通批被打死 → 仍不能触发（这就是现场那个「末尾精英刚出来就弹卡」）
  balloons.list = [];
  w._updateEliteWatch(0.1);
  assert.equal(w._fired, 0, '★ 普通批清空绝不能触发金点抽卡');

  // 末尾批自己落地 → seen；再被清空 → 才触发
  balloons.list = [{ alive: true, isElite: true, batchId: 2 }];
  w._updateEliteWatch(0.1);
  assert.equal(w._fired, 0, '刚落地还不该触发');
  balloons.list = [];
  w._updateEliteWatch(0.1);
  assert.equal(w._fired, 1, '末尾批清空 → 金点 → 抽卡');
  assert.equal(w._eliteWatch.length, 0, '触发后条目回收');
});

test('批次观察：只有末尾批（goldReturn）产生观察条目，普通批不产生', () => {
  const { w } = mkWave();
  w._spawnEliteEvent(ELITE_EV({ goldReturn: true }));
  assert.equal(w._eliteWatch.length, 1);
  assert.equal(w._eliteWatch[0].batch, 1);
  assert.equal(w._eliteWatch[0].hold, false, 'portal 批不停滴流');
  w._scriptElapsed = 60;   // 越过层间隔节流
  w._spawnEliteEvent(ELITE_EV());
  assert.equal(w._eliteWatch.length, 1, '普通批不该进观察队列');
});

test('批次编号：每批 +1，本批生成的怪都带同一个 batchId（融合批也一样）', () => {
  const { w, spawned } = mkWave();
  w._spawnEliteEvent(ELITE_EV({ goldReturn: true }));
  w._scriptElapsed = 60;
  w._spawnEliteEvent(ELITE_EV({ combos: [{ type: 'eliteKnight', count: 3 }], dir: 'frontLeft', goldReturn: true }));
  assert.equal(spawned.length, 5);
  assert.deepEqual(spawned.slice(0, 2).map((b) => b.opts.batchId), [1, 1]);
  assert.deepEqual(spawned.slice(2).map((b) => b.opts.batchId), [2, 2, 2]);
  assert.deepEqual(w._eliteWatch.map((x) => x.batch), [1, 2]);
});

test('融合批：演出结束落地的那批怪也带着本批 batchId 与 climax（out.batch 传递）', () => {
  const { w, spawned } = mkWave();
  const positions = [new THREE.Vector3(0, 0, -20), new THREE.Vector3(2, 0, -20)];
  w._fuseSpawn(ELITE_EV({ via: 'merge', goldReturn: true }), positions, 0x4d9dff, 'mini', 7);
  assert.equal(spawned.length, 0, '融合期间不生成，先演 in → out');
  w._updateFuseGroups(FUSE.IN_DUR + 0.01);   // 汇聚
  w._updateFuseGroups(FUSE.OUT_DUR + 0.01);  // 大光点落地
  assert.equal(spawned.length, 2, '落地生成整批');
  for (const b of spawned) {
    assert.equal(b.opts.batchId, 7);
    assert.equal(b.opts.climax, true);
    assert.equal(b.opts.isElite, true);
    assert.ok(b.opts.sizeMul > 1, '末尾批要放大');
  }
});

test('★回归：无传送门（直出）时精英的构造参数不能丢 —— hp/isElite/体型/批号都得到位', () => {
  const { w, spawned } = mkWave();     // getPortals 返回 null ⇒ 走 _queueSpawn 的直出分支
  w._spawnEliteEvent(ELITE_EV({ goldReturn: true }));
  assert.equal(spawned.length, 2);
  for (const b of spawned) {
    assert.equal(b.opts.isElite, true, '丢了 isElite 就不会挂名牌、也不算精英');
    assert.ok(b.opts.hp > 0, '丢了 hp 就退化成杂鱼血量');
    assert.ok(b.opts.sizeMul > 1, '丢了 sizeMul 末尾精英就不会变大');
    assert.equal(b.opts.climax, true);
    assert.equal(b.opts.batchId, 1);
  }
});

test('精英分档：普通批不放大、走路原生速度；末尾批放大 + 定速', () => {
  const { w, spawned } = mkWave();
  w._spawnEliteEvent(ELITE_EV());            // 普通批
  w._scriptElapsed = 60;
  w._spawnEliteEvent(ELITE_EV({ goldReturn: true }));
  const plain = spawned[0].opts, climax = spawned[2].opts;
  assert.equal(plain.climax, false);
  assert.equal(plain.sizeMul, 1, '普通精英 1 倍体型（覆盖敌种自带 scale）');
  assert.equal(plain.speed, undefined, '普通精英用敌种原生速度');
  assert.equal(climax.climax, true);
  assert.ok(climax.speed > 0, '末尾批是定速（由出生距离反推）');
});

test('名牌文字：只有末尾精英加 Boss 后缀，普通精英只显示名字', () => {
  assert.equal(eliteLabelText('铁甲兵', true), '铁甲兵' + CLIMAX_SUFFIX);
  assert.equal(eliteLabelText('铁甲兵', false), '铁甲兵');
  assert.equal(eliteLabelText('盾甲兵', true), '盾甲兵' + CLIMAX_SUFFIX);
  assert.ok(CLIMAX_SUFFIX.trim() === 'Boss', '后缀就是 Boss');
  assert.equal(eliteLabelText(undefined, false), 'undefined', '不炸就行（调用方会先兜底）');
});
