import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MagicianBoss, introPose, planRefill } from '../src/game/bossMagician.js';
import { MAGICIAN_BOSS } from '../src/core/constants.js';

// 第三十八修：第18关魔术师 Boss
//   ① 开场演出时间轴（念白 → 0.6s 飞回 Boss 位 → 瞬间变大 ×2）
//   ② 召唤池（场上维持 20 只、其中 3 只阶段精英怪；少于 5 只才补满；切阶段只换精英种类不清场）
// 本文件不测渲染，只测时间轴与召唤池这两套纯逻辑/状态机。

const DT = 1 / 60;

/** 最小 waves 桩：_queueSpawn 同步落地（跳过光点飞行），其余字段够 MagicianBoss 用即可。 */
function makeWaves() {
  const scene = new THREE.Scene();
  const list = [];
  const waves = {
    scene,
    list,
    balloons: {
      list,
      remove(b) { const i = list.indexOf(b); if (i >= 0) list.splice(i, 1); },
      // 黑白球墙（BossBallWall）会直接 spawn 纯色球：这里给个够用的最小实现
      spawn(type, pos) {
        const b = { type, alive: true, hp: 1, maxHp: 1, mesh: new THREE.Object3D(), takeDamage() {} };
        b.mesh.position.copy(pos);
        b.mesh.material = { color: { setHex() {} }, emissive: null };
        list.push(b);
        return b;
      },
    },
    getPlayerPos: () => new THREE.Vector3(0, 1.4, 0),
    getPlayerDPS: () => 0,
    damagePlayer: () => {},
    camera: new THREE.PerspectiveCamera(),
    onWinExit: () => {},
    bossSpawned: false,
    _queueSpawn: (type, pos, opts) => {
      const b = {
        type, alive: true, hp: 100, maxHp: 100, controlled: false,
        mesh: new THREE.Object3D(), takeDamage() {},
      };
      b.mesh.position.copy(pos);
      list.push(b);
      if (opts && opts.onSpawn) opts.onSpawn(b);
      return b;
    },
  };
  return waves;
}

function step(boss, seconds) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) boss.update(DT);
}

function round3(v) { return v.map((x) => Math.round(x * 1000) / 1000); }

// ===================== ① 开场演出时间轴 =====================

test('开场演出：念白期停在 INTRO.POS 且体型 = 第15关开场（5m）', () => {
  const waves = makeWaves();
  const boss = new MagicianBoss(waves);
  boss._sizeY = 1;   // 模型没加载也在测：身高换算不依赖 GLB

  assert.equal(boss.phase, 'intro');
  assert.deepEqual(round3(boss._proxy.mesh.position.toArray()), round3(MAGICIAN_BOSS.INTRO.POS));
  // 命中半径随体型缩放：开场 5m → 常规 10m 的一半
  assert.equal(boss._radiusForHeight(MAGICIAN_BOSS.INTRO.SCALE_HEIGHT), MAGICIAN_BOSS.PROXY_RADIUS / 2);

  step(boss, MAGICIAN_BOSS.INTRO.CUE_AT - 0.2);
  assert.deepEqual(round3(boss._proxy.mesh.position.toArray()), round3(MAGICIAN_BOSS.INTRO.POS));
  assert.equal(boss._big, false, '起飞前不应变大');
  assert.equal(boss.phase, 'intro');
});

test('开场演出：0.6s 飞到 Boss 位后瞬间变大 2 倍（20m）', () => {
  const I = MAGICIAN_BOSS.INTRO;
  const cfg = MAGICIAN_BOSS;

  // 纯函数时间轴：起飞中点在两端之间、飞完 = 目标位 + big
  const mid = introPose(cfg, I.CUE_AT + I.FLY_TIME / 2);
  assert.equal(mid.big, false);
  assert.ok(mid.pos[2] < I.POS[2] && mid.pos[2] > cfg.POSITIONS[0][2], '中途应在两槽位之间');
  const done = introPose(cfg, I.CUE_AT + I.FLY_TIME);
  assert.equal(done.big, true);
  assert.deepEqual(done.pos, cfg.POSITIONS[0]);

  const waves = makeWaves();
  const boss = new MagicianBoss(waves);
  step(boss, I.CUE_AT + I.FLY_TIME + 2 * DT);

  assert.equal(boss._big, true);
  assert.deepEqual(round3(boss._proxy.mesh.position.toArray()), round3(cfg.POSITIONS[0]));
  assert.equal(boss._bigHeight(), cfg.SCALE * cfg.MODEL_SCALE * I.BIG_MULT, '变大后身高 = 常规 10m × BIG_MULT');
  assert.equal(boss._proxy.hitRadius, cfg.PROXY_RADIUS * I.BIG_MULT, '命中半径同步放大');
  assert.equal(boss.phase, 'intro', '变大后仍等语音播完才进激光');
});

test('开场演出：语音播完（ended 回调）即进激光阶段；兜底超时也会进', () => {
  const waves = makeWaves();
  const boss = new MagicianBoss(waves);
  step(boss, 1.0);                       // 故意在起飞前
  boss.onOpeningVoiceEnd();               // 语音异常提前结束
  assert.equal(boss.phase, 'laser');
  assert.equal(boss._big, true, '提前结束也必须补上变大');
  assert.deepEqual(round3(boss._proxy.mesh.position.toArray()), round3(MAGICIAN_BOSS.POSITIONS[0]));

  const waves2 = makeWaves();
  const boss2 = new MagicianBoss(waves2);
  step(boss2, MAGICIAN_BOSS.PHASE.INTRO + 2 * DT);   // 语音没播（加载失败）→ 兜底
  assert.equal(boss2.phase, 'laser');
  assert.equal(boss2._big, true);
});

// ===================== ② 召唤池 =====================

test('召唤池：补满计划 = 20 只（其中 3 只精英），存活 ≥ 5 不补', () => {
  const cfg = MAGICIAN_BOSS;
  assert.equal(cfg.POOL.MAX, 20);
  assert.equal(cfg.POOL.ELITE, 3);
  assert.equal(cfg.POOL.REFILL_AT, 5);
  assert.equal(cfg.POOL.SPAWN_R, 15);
  assert.deepEqual(cfg.POOL.ELITE_BY_PHASE, { laser: 'shield', glass: 'ghost', nine: 'octopus' });

  // 空场 → 20（3 精英 + 17 普通）
  assert.deepEqual(planRefill(cfg, { alive: 0, elites: 0, pending: 0, pendingElite: 0, queued: 0, queuedElite: 0 }),
    { elites: 3, basics: 17 });
  // 场上 4 只且精英齐 → 补 16 只普通（精英不再补）
  assert.deepEqual(planRefill(cfg, { alive: 4, elites: 3, pending: 0, pendingElite: 0, queued: 0, queuedElite: 0 }),
    { elites: 0, basics: 16 });
  // 场上 4 只但精英全死 → 先补 3 精英
  assert.deepEqual(planRefill(cfg, { alive: 4, elites: 0, pending: 0, pendingElite: 0, queued: 0, queuedElite: 0 }),
    { elites: 3, basics: 13 });
  // 存活 5 只（= REFILL_AT）→ 不补
  assert.equal(planRefill(cfg, { alive: 5, elites: 1, pending: 0, pendingElite: 0, queued: 0, queuedElite: 0 }), null);
  // 光点在飞（尚未落地）也算「场上」，避免重复补满
  assert.equal(planRefill(cfg, { alive: 0, elites: 0, pending: 20, pendingElite: 3, queued: 0, queuedElite: 0 }), null);
});

test('召唤池：激光阶段补满 20 只 = 17 基础怪 + 3 盾牌骑士，且只补到 20 不超', () => {
  const waves = makeWaves();
  const boss = new MagicianBoss(waves);
  boss.onOpeningVoiceEnd();                       // 进激光阶段
  step(boss, 1.0);                                // 触发补充 + 分帧落地（PER_FRAME=3）

  assert.equal(boss._minions.length, 20, '应补满到 POOL.MAX');
  const elites = boss._minions.filter((b) => b._bossElite);
  assert.equal(elites.length, 3);
  assert.ok(elites.every((b) => b.type === 'shield'), '激光阶段精英 = 盾牌骑士');
  assert.ok(boss._minions.filter((b) => !b._bossElite).every((b) => b.type === 'basic'), '其余为普通怪');

  step(boss, 2.0);                                // 再跑 2 秒（无死亡）不应再刷
  assert.equal(boss._minions.length, 20);
});

test('召唤池：掉到 4 只才补，且切阶段只换精英种类、不清场', () => {
  const waves = makeWaves();
  const boss = new MagicianBoss(waves);
  boss.onOpeningVoiceEnd();
  step(boss, 1.0);
  assert.equal(boss._minions.length, 20);

  // 打掉 16 只 → 剩 4 只（含 3 精英）
  for (let i = 0; i < 16; i++) {
    const b = boss._minions[i];
    b.alive = false;
    waves.balloons.remove(b);
  }
  step(boss, 1.0);
  assert.equal(boss._minions.length, 20, '掉到 4 只后补回 20');
  assert.equal(boss._minions.filter((b) => b._bossElite).length, 3, '精英仍为 3 只（旧精英没被清掉）');
  assert.ok(boss._minions.some((b) => b.type === 'shield'), '上一阶段的盾牌骑士仍在场');

  // 切到玻璃墙阶段：只换精英种类，旧怪一只不删
  const before = boss._minions.slice();
  boss._enterPhase('glass');
  step(boss, 1.0);
  assert.ok(before.every((b) => boss._minions.includes(b)), '切阶段不清场');
  assert.equal(boss._minions.filter((b) => b.type === 'shield').length, 3, '旧精英（盾牌）仍在');
});

test('召唤池：精英怪种类按阶段切换（盾牌骑士 → 幽灵 → 章鱼）', () => {
  const waves = makeWaves();
  const boss = new MagicianBoss(waves);
  boss.onOpeningVoiceEnd();
  for (const [phase, type] of [['laser', 'shield'], ['glass', 'ghost'], ['nine', 'octopus']]) {
    boss._enterPhase(phase);
    boss._minions = [];                 // 清空场上（模拟被打光）→ 下一帧按新阶段精英补齐
    boss._refillQueue.length = 0;
    boss._refillCd = 0;
    step(boss, 1.0);
    assert.equal(boss._minions.filter((b) => b._bossElite).length, 3);
    assert.ok(boss._minions.filter((b) => b._bossElite).every((b) => b.type === type), phase + ' 阶段精英应为 ' + type);
  }
});

test('召唤池：SPAWN_ENEMIES=false 时完全不召唤', () => {
  const old = MAGICIAN_BOSS.SPAWN_ENEMIES;
  MAGICIAN_BOSS.SPAWN_ENEMIES = false;
  try {
    const waves = makeWaves();
    const boss = new MagicianBoss(waves);
    boss.onOpeningVoiceEnd();
    step(boss, 2.0);
    assert.equal(boss._minions.length, 0);
  } finally {
    MAGICIAN_BOSS.SPAWN_ENEMIES = old;
  }
});