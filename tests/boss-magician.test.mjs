import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MagicianBoss, introPose, planRefill } from '../src/game/bossMagician.js';
import { WinBanner3D } from '../src/game/winBanner.js';
import { MAGICIAN_BOSS } from '../src/core/constants.js';

// 第三十八修：第18关魔术师 Boss
//   ① 开场演出时间轴（念白 → 0.6s 飞回 Boss 位 → 瞬间变大 ×2）
//   ② 召唤池（场上维持 20 只、其中 3 只阶段精英怪；少于 5 只才补满；切阶段只换精英种类不清场）
//   ③ 收尾（第三十九修）：Boss 死亡立刻清场（召唤物 + 在飞光点）、通关横幅时长
// 本文件不测渲染，只测时间轴/召唤池/收尾这三套纯逻辑与状态机。

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
    _winBanner: null,                 // 第18关通关横幅（bossMagician._win 写入；timeout 由 game 驱动）
    _cancelled: [],                   // 被 _cancelPendingGroup 撤销的分组（第三十九修：通关清场）
    _spawnGroups: [],                 // 每个召唤物落地时的 group 标记
    _cancelPendingGroup(tag) { this._cancelled.push(tag); },
    getPlayerPos: () => new THREE.Vector3(0, 1.4, 0),
    getPlayerDPS: () => 0,
    damagePlayer: () => {},
    camera: new THREE.PerspectiveCamera(),
    onWinExit: () => {},
    bossSpawned: false,
    _queueSpawn: (type, pos, opts) => {
      waves._spawnGroups.push(opts && opts.group);
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
// ===================== ③ 收尾（第三十九修） =====================

test('Boss 死亡立刻清场：召唤物全部移除 + 在飞光点撤销', () => {
  const waves = makeWaves();
  const boss = new MagicianBoss(waves);
  boss._sizeY = 1;
  boss.onOpeningVoiceEnd();          // 结束开场演出 → 进激光阶段（召唤池开始工作）
  // 注意：不要先 step —— 激光阶段一进就会把召唤池补满到 MAX(20)，测试要的是「可控的几只」
  for (let i = 0; i < 4; i++) boss._spawnMinion(i === 0);   // 3 普通 + 1 精英
  const minions = boss._minions.slice();
  assert.equal(minions.length, 4, '先确认场上确实有召唤物');
  assert.ok(minions.every((b) => waves.list.includes(b)));

  boss._proxy.alive = false;         // 模拟代理被击杀
  boss.update(DT);                   // → _win()

  assert.equal(boss._disposed, true, 'Boss 应已 dispose');
  assert.equal(waves.cleared, true, '应标记 cleared（供 game 判定通关）');
  assert.equal(waves.magicianCleared, true, '应显式标记第18关已清（挡住抽卡/毕业汇总）');
  assert.equal(boss._minions.length, 0, '召唤物清单应清空');
  for (const m of minions) assert.ok(!waves.list.includes(m), '召唤物应从场上移除（否则横幅期间还在打玩家）');
  assert.ok(waves._cancelled.includes('magicianSub'), '在飞光点应被撤销');
  assert.ok(waves._spawnGroups.includes('magicianSub'), '召唤物应带 magicianSub 分组');
});

test('通关横幅时长 = MAGICIAN_BOSS.WIN_BANNER_SECONDS；0 = 不建横幅直接结束本局', () => {
  const old = MAGICIAN_BOSS.WIN_BANNER_SECONDS;
  try {
    MAGICIAN_BOSS.WIN_BANNER_SECONDS = 3;
    let waves = makeWaves();
    let boss = new MagicianBoss(waves);
    boss._sizeY = 1;
    boss.onOpeningVoiceEnd();
    boss._proxy.alive = false;
    boss.update(DT);
    assert.ok(waves._winBanner, '应建出通关横幅');
    assert.equal(waves._winBanner.duration, 3, '横幅时长应取配置值');

    MAGICIAN_BOSS.WIN_BANNER_SECONDS = 0;
    let exited = 0;
    waves = makeWaves();
    waves.onWinExit = () => { exited++; };
    boss = new MagicianBoss(waves);
    boss._sizeY = 1;
    boss.onOpeningVoiceEnd();
    boss._proxy.alive = false;
    boss.update(DT);
    assert.equal(waves._winBanner, null, '时长 0 不应建横幅');
    assert.equal(exited, 1, 'Boss 一死就应直接结束本局（回调 onWinExit）');
  } finally {
    MAGICIAN_BOSS.WIN_BANNER_SECONDS = old;
  }
});

test('WinBanner3D：按传入时长到期（缺省仍是 10s，只回调一次）', () => {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera();
  let expired = 0;
  const b = new WinBanner3D(scene, cam, 'A\nB', () => { expired++; }, 2.5);
  for (let i = 0; i < 152; i++) b.update(DT);      // 2.5s（DT=1/60 累加有浮点误差，多走两帧）
  assert.equal(expired, 1, '到 2.5s 应到期');
  b.update(DT);
  assert.equal(expired, 1, '到期只回调一次');
  const d = new WinBanner3D(scene, cam, 'A');
  assert.equal(d.duration, 10, '缺省 = 10s');
});
