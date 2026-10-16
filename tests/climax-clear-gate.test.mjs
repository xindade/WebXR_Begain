// 第六十三修 · 关卡收尾闸门（现场：「有时候只打死忍者精英而非末尾精英也能通关」）
//
// 根因：关卡收尾判据「时间到 + 场上清空」**不看脚本进度**。
//   末尾横幅闸门（_holdClimaxBanner）会把脚本时钟冻在末尾横幅那一刻（第 13 关 = 45s），
//   玩家一直杀到关卡时长（60s）之后才把 45s 之前那批精英（ninja ×3）清完
//   ⇒ 闸门放行的那一帧场上正好空了 ⇒ 当场判通关，
//   后面的「前方精英来袭」横幅、清场融合、末尾批**根本没生成**。
// 修法：新增 _canClear() —— 除了时间与场上，还要「脚本事件全部走完」+「没有待结算的末尾批」。
//
// 全是纯逻辑（假气球管理器），本地几毫秒就能挡住。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WaveManager } from '../src/game/waves.js';
import { scriptEndTime, SPAWN_SCRIPT, FUSE } from '../src/content/spawnDirector.js';
import { levelSecondsOf } from '../src/core/constants.js';

// 最小假气球管理器：只提供 waves 真正会碰的面（list / count / spawn / remove）
function mkWave() {
  const spawned = [];
  const banners = [];
  const balloons = {
    list: [],
    get count() { return this.list.length; },
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
  w.hooks.banner = (t) => { banners.push(t); };
  return { w, spawned, balloons, banners };
}

test('scriptEndTime：取最后一个事件时刻；无限 every 不计入（防软锁）', () => {
  assert.equal(scriptEndTime(null), 0);
  assert.equal(scriptEndTime({ events: [] }), 0);
  assert.equal(scriptEndTime(SPAWN_SCRIPT[13]), 47, '第 13 关末尾批在 47s（45s 横幅 → 47s 批次）');
  assert.equal(scriptEndTime(SPAWN_SCRIPT[11]), 38);
  assert.equal(scriptEndTime({ events: [{ t: 5, every: 10, until: 25, do: 'elite' }] }), 25, '循环事件取 until');
  assert.equal(scriptEndTime({ events: [{ t: 5, every: 10, do: 'trashBurst' }] }), 0, '无限循环不延长关卡');
});

test('_scriptPending：脚本时钟没走到最后一个事件 = 还没走完（闸门冻住的正是它）', () => {
  const { w } = mkWave();
  assert.equal(w._scriptPending(), false, '没有脚本 → 永不 pending');
  w._script = SPAWN_SCRIPT[13];        // 末尾事件 47s
  w._scriptElapsed = 45;               // 被末尾横幅闸门冻在 45s
  assert.equal(w._scriptPending(), true);
  w._scriptElapsed = 47;
  assert.equal(w._scriptPending(), false, '走到末尾事件就算走完');
});

test('_canClear：闸门中 / 脚本没走完 / 末尾批待结算 —— 任一条都能拦住收尾', () => {
  const { w } = mkWave();
  assert.equal(w._canClear(), true, '什么阻碍都没有 → 可以收尾');
  w._climaxHeld = true;
  assert.equal(w._canClear(), false, '闸门还在等精英 → 不许收尾');
  w._climaxHeld = false;
  w._script = SPAWN_SCRIPT[13];
  w._scriptElapsed = 10;
  assert.equal(w._canClear(), false, '脚本事件还没走完 → 不许收尾');
  w._scriptElapsed = 47;
  assert.equal(w._canClear(), true);
  w._eliteWatch.push({ batch: 1, seen: true, t: 0, hold: false });
  assert.equal(w._canClear(), false, '末尾批还在金点观察队列里（金点还没弹卡）→ 不许收尾');
});

test('末尾横幅闸门：场上有精英就冻脚本时钟，精英一清完立刻放行', () => {
  const { w, balloons } = mkWave();
  w._script = SPAWN_SCRIPT[13];
  w._scriptPrev = 44.5; w._scriptElapsed = 44.5;      // 45s 的横幅马上到点
  balloons.list = [{ alive: true, isElite: true, batchId: 1, type: { id: 'ninja' } }];
  assert.equal(w._holdClimaxBanner(1), true, '场上有精英 → 冻住脚本时钟（横幅/融合/末尾批一起推迟）');
  assert.equal(w._climaxHeld, true);
  balloons.list = [];
  assert.equal(w._holdClimaxBanner(0.016), false, '精英清完 → 放行');
  assert.equal(w._climaxHeld, false);
});

test('★回归：关卡时长到了、场上也空了，但脚本还没走完 → 不许判通关；末尾批必须真的生成', () => {
  const { w, balloons, banners } = mkWave();
  w.level = { n: 13 };
  w.mode = 'normalTest';
  w._script = SPAWN_SCRIPT[13];
  w._scriptElapsed = 45; w._scriptPrev = 45;          // 闸门冻在这一刻（场上还有 35s 那批忍者）
  w.elapsed = levelSecondsOf(13) + 2;                 // 已经超过本关时长
  assert.equal(w._active, 0, '场上清空：_active = 落地气球 + 在飞光点');

  // ① 玩家刚把最后一只忍者打死的那一帧：旧实现就是在这里「直接通关」，末尾批再也没出现
  w._updateDpsSpawn(1 / 60);
  assert.equal(w.cleared, false, '★ 末尾批还没生成，绝不能收尾（现场「只打死忍者精英也能通关」）');

  // ② 闸门放行 → 脚本补跑 45→48s：45s 横幅 + 47s 末尾批都得走
  w._updateSpawnScript(3);
  assert.equal(w._fuseGroups.length, 1, '末尾批走清场融合演出（不是凭空消失）');
  assert.equal(w._eliteWatch.length, 1, '末尾批进了金点观察队列');
  w._updateDpsSpawn(1 / 60);
  assert.equal(w.cleared, false, '末尾批还在融合光点里飞 → 不许收尾');

  // ③ 融合落地 → 末尾精英真出现在场上
  w._updateFuseGroups(FUSE.IN_DUR + 0.01);
  w._updateFuseGroups(FUSE.OUT_DUR + 0.01);
  assert.ok(balloons.count > 0, '末尾精英已落地');
  w._updateDpsSpawn(1 / 60);
  assert.equal(w.cleared, false, '末尾精英还活着 → 不许收尾');

  // ④ 打完末尾批 → 金点飞向选项卡 → 之后才允许收尾
  w._updateEliteWatch(0.1);                          // 先「见到」这一批
  assert.equal(w._fired, 0, '刚落地不算清空');
  for (const b of [...balloons.list]) balloons.remove(b);
  w._updateEliteWatch(0.1);                          // 整批清空 → 金点
  assert.equal(w._fired, 1, '末尾批清空 → 金点飞向选项卡');
  assert.equal(w._eliteWatch.length, 0, '观察条目回收');
  assert.ok(banners.length >= 0);
  w._updateDpsSpawn(1 / 60);
  assert.equal(w.cleared, true, '末尾批结算完 + 时间已到 → 正常收尾');
});
