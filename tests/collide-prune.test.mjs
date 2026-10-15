// 第五十三修 · 子弹命中剪枝（_collide 的「第 0 步」）
//
// 现场口径：用户要的是「更多子弹」。并发子弹数 ≈ 射速 × 弹道数 × BULLET_LIFE，渲染侧几乎免费
//   （bullets.js 是 InstancedMesh，500 发 = 1 个 draw call + 一次 32KB 矩阵上传），
//   真正的门槛在 game._collide 的 O(子弹 × 敌人 × 2 pass)：每个 pair 都要算一次
//   「点到本帧线段最近点」，立绘那条分支还多一次 normalize()（sqrt + 三次除法）。
// 这一修只做两件**纯性能、零行为变化**的事：
//   ① 场上没有 Boss 时只跑一轮 —— 原来无条件两遍，非 Boss 关的 pass1 每帧纯空转；
//   ② 每个 pair 先过一道「本帧线段 AABB」粗筛（6 次比较），出盒直接跳过精确判定。
//
// 本文件用「把改动之前的实现原样抄成 oracle」的办法锁等价性：同一批（随机 + 定点）场景下，
//   新旧两边的命中/消费轨迹必须逐条一致 —— 剪枝一旦漏判（假阴性）立刻红。
//   另外用 alive 读取数 / Math.sqrt 调用数证明剪枝真的省下了东西（不是白改）。
// ⚠ oracle 是**冻结副本**：日后若有意改动精确判定（薄板厚、命中球口径…），必须同步重新抄一份，
//   否则本文件会拿旧口径把新行为判成「不一致」。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Game } from '../src/game/game.js';
import { SHOOT } from '../src/core/constants.js';

// ---------- 与 game.js 模块内同名的私有工具（原样抄来给 oracle 用） ----------
const _segAB = new THREE.Vector3();
const _segAP = new THREE.Vector3();
const _segClosest = new THREE.Vector3();
const _segN = new THREE.Vector3();

function _pointSegDistSq(p, a, b) {
  _segAB.copy(b).sub(a);
  const ab2 = _segAB.lengthSq();
  if (ab2 < 1e-12) return p.distanceToSquared(a);
  _segAP.copy(p).sub(a);
  let t = _segAP.dot(_segAB) / ab2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  _segClosest.copy(a).addScaledVector(_segAB, t);
  return _segClosest.distanceToSquared(p);
}

function _closestPointOnSeg(out, p, a, b) {
  _segAB.copy(b).sub(a);
  const ab2 = _segAB.lengthSq();
  if (ab2 < 1e-12) { out.copy(a); return; }
  _segAP.copy(p).sub(a);
  let t = _segAP.dot(_segAB) / ab2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  out.copy(a).addScaledVector(_segAB, t);
}

// ---------- oracle：改动之前的 _collide（逐行抄自旧实现） ----------
function oldCollide() {
  const bullets = this.bullets.active;
  this.world.camera.getWorldPosition(this._camPos);
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    if (this.waves.magicianGlassWall && this.waves.magicianGlassWall.tryBlock(b)) {
      this.bullets.release(b);
      continue;
    }
    const list = this.balloons.list;
    let hitBalloon = null;
    for (let pass = 0; pass < 2 && !hitBalloon; pass++) {
      const wantBoss = pass === 1;
      for (let j = 0; j < list.length; j++) {
        const balloon = list[j];
        if (!balloon.alive) continue;
        if (balloon.behavior === 'ghost' && !balloon.revealed) continue;
        if (!!balloon.isBoss !== wantBoss) continue;
        const rr = balloon.hitRadius + SHOOT.HIT_PAD;
        let _hit = false;
        if (balloon.depthSprite) {
          _closestPointOnSeg(_segClosest, balloon.mesh.position, b.prevPos, b.pos);
          _segAB.copy(_segClosest).sub(balloon.mesh.position);
          _segN.copy(this._camPos).sub(balloon.mesh.position).normalize();
          const _depth = _segAB.dot(_segN);
          const _inPlaneSq = Math.max(0, _segAB.lengthSq() - _depth * _depth);
          if (_inPlaneSq < rr * rr && Math.abs(_depth) < SHOOT.HIT_SLAB_DEPTH) _hit = true;
        } else {
          if (_pointSegDistSq(balloon.mesh.position, b.prevPos, b.pos) < rr * rr) _hit = true;
        }
        if (_hit) { hitBalloon = balloon; break; }
      }
    }
    if (hitBalloon) {
      if (hitBalloon.behavior === 'shield') {
        const sb = hitBalloon.getShieldBlock();
        if (sb) {
          this._tmp2.copy(this._playerPos()).sub(hitBalloon.mesh.position);
          this._tmp2.y = 0;
          if (this._tmp2.lengthSq() > 1e-6) {
            this._tmp2.normalize();
            if (this._tmp2.dot(sb.dir) > Math.cos(sb.arc)) {
              this.bullets.release(b);
              this._spawnExplosionFx(b.pos, 0.2);
              continue;
            }
          }
        }
      }
      const killed = hitBalloon.takeDamage(b.dmg);
      this.bullets.release(b);
      this._damageFeedback(hitBalloon, killed, b.pos);
      if (killed) this._onKilled(hitBalloon);
      if (killed) this._bulletKill(hitBalloon);
    }
  }
  this.bullets.sync();
}

const NEW_COLLIDE = Game.prototype._collide;

// ---------- 假 game：只喂 _collide 真正用到的字段 ----------
const CAM = new THREE.Vector3(0, 1.6, 0);      // 相机（玩家站原点、眼高 1.6）
const PLAYER = new THREE.Vector3(0, 1.6, 0);

function makeBalloon(spec, i) {
  const o = {
    key: spec.key || ('B' + i),
    hitRadius: spec.hitRadius,
    depthSprite: spec.depthSprite ? { fake: 'depthSprite' } : null,
    isBoss: !!spec.isBoss,
    behavior: spec.behavior || 'basic',
    revealed: spec.revealed !== false,
    hp: spec.hp == null ? 1000 : spec.hp,
    aliveReads: 0,                 // 读一次 alive 记一次（用来数遍历了多少 pair）
    _alive: spec.alive !== false,
    _lastDamage: null,
    mesh: { position: new THREE.Vector3(spec.p[0], spec.p[1], spec.p[2]) },
    takeDamage(d) { this._lastDamage = d; this.hp -= d; return this.hp <= 0; },
    getShieldBlock() { return spec.shieldBlock || null; },
  };
  Object.defineProperty(o, 'alive', {
    get() { this.aliveReads++; return this._alive; },
    set(v) { this._alive = v; },
  });
  return o;
}

function makeCtx(fx) {
  const trace = [];
  const active = fx.bullets.map((s, i) => ({
    key: 'U' + i,
    dmg: s.dmg == null ? 10 : s.dmg,
    pos: new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]),
    prevPos: new THREE.Vector3(s.prev[0], s.prev[1], s.prev[2]),
  }));
  const list = fx.balloons.map(makeBalloon);
  const all = list.slice();        // 打死会被 splice 掉，计数要留着原表
  const wall = fx.glassWall || null;
  const ctx = {
    bullets: {
      active,
      release(b) {                                  // 复刻 bullets.js 的 swap-pop
        const i = active.indexOf(b);
        if (i === -1) return;
        const last = active.length - 1;
        if (i !== last) active[i] = active[last];
        active.pop();
        trace.push('release:' + b.key);
      },
      sync() { trace.push('sync'); },
    },
    world: { camera: { getWorldPosition(v) { return v.copy(CAM); } } },
    waves: { magicianGlassWall: wall ? { tryBlock: (b) => b.key === wall } : null },
    balloons: {
      list,
      remove(b) { const i = list.indexOf(b); if (i !== -1) list.splice(i, 1); },
    },
    _camPos: new THREE.Vector3(),
    _tmp2: new THREE.Vector3(),
    player: { hp: 100, maxHp: 100 },
    _playerPos() { return PLAYER; },
    _spawnExplosionFx(_p, r) { trace.push('blockfx:' + r); },
    _damageFeedback(b, killed) { trace.push('dmg:' + b.key + ':' + b._lastDamage + ':' + (killed ? 'kill' : 'hit')); },
    _onKilled(b) { trace.push('onKilled:' + b.key); const i = list.indexOf(b); if (i !== -1) list.splice(i, 1); },
    _bulletKill(b) { trace.push('bulletKill:' + b.key); },
  };
  return { ctx, trace, all };
}

function run(impl, fx) {
  const { ctx, trace, all } = makeCtx(fx);
  impl.call(ctx);
  let aliveReads = 0;
  for (const b of all) aliveReads += b.aliveReads;
  return { trace: trace.slice(), aliveReads };
}

/** 同一场景下新旧实现必须完全一致（命中对象、扣血量、击杀、消费顺序、末尾 sync） */
function assertSame(fx, label) {
  const a = run(NEW_COLLIDE, fx).trace;
  const b = run(oldCollide, fx).trace;
  assert.deepEqual(a, b, label + ' —— 新旧 _collide 轨迹不一致');
  return a;
}

function countSqrt(fn) {
  const orig = Math.sqrt;
  let n = 0;
  Math.sqrt = (v) => { n++; return orig(v); };
  try { fn(); } finally { Math.sqrt = orig; }
  return n;
}

// 子弹：从 prev 飞到 pos（≈ 一帧 0.21m）
const shot = (prev, pos, dmg) => ({ prev, pos, dmg: dmg == null ? 10 : dmg });

// ---------- ① 粗筛不能把该命中的挡掉：命中球边界内外 ----------

test('第五十三修 · 命中球边界：rr 内必中、rr 外必不中（非立绘路径）', () => {
  const base = { depthSprite: false, hitRadius: 0.5 };          // rr = 0.5 + HIT_PAD = 0.55
  const rr = 0.5 + SHOOT.HIT_PAD;
  const line = shot([0, 1, -2], [0, 1, -2.21]);

  const inside = { bullets: [line], balloons: [{ ...base, p: [rr - 0.01, 1, -2.1] }] };
  const outside = { bullets: [line], balloons: [{ ...base, p: [rr + 0.01, 1, -2.1] }] };

  assert.deepEqual(assertSame(inside, '边界内'), ['release:U0', 'dmg:B0:10:hit', 'sync']);
  assert.deepEqual(assertSame(outside, '边界外'), ['sync']);
});

test('第五十三修 · 退化线段（prevPos === pos，首帧）仍能命中重叠的怪', () => {
  const fx = {
    bullets: [shot([0, 1, -2], [0, 1, -2])],
    balloons: [{ depthSprite: false, hitRadius: 0.5, p: [0.4, 1, -2] }],
  };
  assert.deepEqual(assertSame(fx, '退化线段'), ['release:U0', 'dmg:B0:10:hit', 'sync']);
});

// ---------- ② 立绘薄板：粗筛的垫厚必须是 rr + 板厚，不能只垫 rr ----------

test('第五十三修 · 立绘薄板：离线段比 rr 还远、但纵深在板厚内 ⇒ 仍必须算命中', () => {
  // 相机在 (0,1.6,0)，怪在 (0,1.6,-3) ⇒ 卡片法线 n = (0,0,1)。
  // 子弹线在 x=0.5、z ∈ [-1.5,-2.63]，离怪最近的是 -Z 端点 ⇒
  // delta = (0.5, 0, 0.37)：横向 0.5 < rr(0.55) ✓、纵深 0.37 < 板厚(0.4) ✓ ⇒ 命中，
  // 但「点到线段距离」= sqrt(0.25+0.1369) = 0.622 > rr ⇒ 只垫 rr 的粗筛会把它漏成假阴性。
  const bullet = shot([0.5, 1.6, -1.5], [0.5, 1.6, -2.63]);
  const base = { depthSprite: true, hitRadius: 0.5 };
  const dist = Math.hypot(0.5, 0.37);
  assert.ok(dist > 0.5 + SHOOT.HIT_PAD, '前提：点到线段的距离确实大于 rr（否则这条用例证明不了什么）');

  const hit = { bullets: [bullet], balloons: [{ ...base, p: [0, 1.6, -3.0] }] };
  assert.deepEqual(assertSame(hit, '薄板纵深命中'), ['release:U0', 'dmg:B0:10:hit', 'sync']);

  // 纵深顶出板厚（0.45 > 0.4）⇒ 谁都不该命中
  const miss = { bullets: [bullet], balloons: [{ ...base, p: [0, 1.6, -3.08] }] };
  assert.deepEqual(assertSame(miss, '薄板纵深越界'), ['sync']);
});

// ---------- ③ 玻璃墙 / 盾牌：这两条旁路不能被剪枝绕过 ----------

test('第五十三修 · 玻璃墙拦截优先于气球命中（挡下即消费子弹，怪不掉血）', () => {
  const fx = {
    bullets: [shot([0, 1, -2], [0, 1, -2.21])],
    balloons: [{ depthSprite: false, hitRadius: 1, p: [0, 1, -2.1] }],
    glassWall: 'U0',
  };
  assert.deepEqual(assertSame(fx, '玻璃墙'), ['release:U0', 'sync']);
});

test('第五十三修 · 盾兵挡弹：夹角内消费子弹 + 挡弹火花，夹角外照常扣血', () => {
  const dir = new THREE.Vector3(0, 0, 1);         // 盾朝玩家（玩家在 +Z 侧）
  const blocked = {
    bullets: [shot([0, 1, -2], [0, 1, -2.21])],
    balloons: [{ depthSprite: false, hitRadius: 1, behavior: 'shield', p: [0, 1, -2.1], shieldBlock: { dir, arc: Math.PI / 2 } }],
  };
  assert.deepEqual(assertSame(blocked, '挡弹'), ['release:U0', 'blockfx:0.2', 'sync']);

  const through = {
    bullets: [shot([0, 1, -2], [0, 1, -2.21])],
    balloons: [{ depthSprite: false, hitRadius: 1, behavior: 'shield', p: [0, 1, -2.1], shieldBlock: { dir: new THREE.Vector3(0, 0, -1), arc: Math.PI / 2 } }],
  };
  assert.deepEqual(assertSame(through, '背身'), ['release:U0', 'dmg:B0:10:hit', 'sync']);
});

// ---------- ④ 两轮命中的取舍：无 Boss 只跑一轮，有 Boss 优先级不变 ----------

test('第五十三修 · 无 Boss ⇒ 只跑一轮（alive 读取数从 2NM 降到 NM+M）', () => {
  const bullets = [];
  for (let i = 0; i < 10; i++) bullets.push(shot([-6 + i * 0.6, 1, -1], [-6 + i * 0.6, 1, -1.21]));
  const balloons = [];
  for (let j = 0; j < 12; j++) balloons.push({ depthSprite: false, hitRadius: 0.5, p: [40 + j, 3, -25 - j] });
  const fx = { bullets, balloons };

  const now = run(NEW_COLLIDE, fx);
  const before = run(oldCollide, fx);
  assert.deepEqual(now.trace, before.trace);
  assert.equal(before.aliveReads, 2 * 10 * 12, '改前：pass0 + pass1 各扫一遍');
  assert.equal(now.aliveReads, 10 * 12 + 12, '改后：一遍 pair + 一次 hasBoss 扫描');
});

test('第五十三修 · 有 Boss ⇒ 两轮都跑；非 Boss 优先，只有 Boss 时 Boss 照样吃伤害', () => {
  const bullet = shot([0, 1, -2], [0, 1, -2.21]);
  const basic = { depthSprite: false, hitRadius: 0.5, p: [0, 1, -2.15] };
  const boss = { depthSprite: false, hitRadius: 4, isBoss: true, key: 'BOSS', p: [0, 1, -5] };

  // 前方小怪在 Boss 命中球内 → 子弹必须落在小怪身上（打小怪不能掉 Boss 血）
  const both = { bullets: [bullet], balloons: [boss, basic] };
  assert.deepEqual(assertSame(both, '非 Boss 优先'), ['release:U0', 'dmg:B1:10:hit', 'sync']);

  // 只有 Boss（且它在 list 首位）→ 第二轮必须照跑，否则就是「打不中 Boss」回归
  const onlyBoss = { bullets: [bullet], balloons: [boss] };
  assert.deepEqual(assertSame(onlyBoss, '只有 Boss'), ['release:U0', 'dmg:BOSS:10:hit', 'sync']);
});

test('第五十三修 · 死怪 / 隐身幽灵仍然不吃弹（粗筛不能把它们「选中」）', () => {
  const bullet = shot([0, 1, -2], [0, 1, -2.21]);
  const dead = { depthSprite: false, hitRadius: 1, alive: false, key: 'DEAD', p: [0, 1, -2.1] };
  const ghost = { depthSprite: false, hitRadius: 1, behavior: 'ghost', revealed: false, key: 'GHOST', p: [0, 1, -2.1] };
  const live = { depthSprite: false, hitRadius: 1, key: 'LIVE', p: [0, 1, -2.1] };

  assert.deepEqual(assertSame({ bullets: [bullet], balloons: [dead, live] }, '死怪在前'), ['release:U0', 'dmg:LIVE:10:hit', 'sync']);
  assert.deepEqual(assertSame({ bullets: [bullet], balloons: [ghost, live] }, '隐身幽灵在前'), ['release:U0', 'dmg:LIVE:10:hit', 'sync']);
  assert.deepEqual(assertSame({ bullets: [bullet], balloons: [ghost] }, '只有隐身幽灵'), ['sync']);
});

// ---------- ⑤ 剪枝真的省了东西：远场全立绘场景一次 normalize 都不做 ----------

test('第五十三修 · 远场场景零 normalize：精确判定被粗筛整片挡掉', () => {
  const bullets = [];
  for (let i = 0; i < 20; i++) bullets.push(shot([-6 + i * 0.6, 1 + (i % 3) * 0.2, -1], [-6 + i * 0.6, 1 + (i % 3) * 0.2, -1.21]));
  const balloons = [];
  for (let j = 0; j < 30; j++) balloons.push({ depthSprite: true, hitRadius: 0.5, p: [40 + j * 0.1, 3 + (j % 5), -25 - j * 0.1] });
  const fx = { bullets, balloons };

  // 立绘分支里 normalize() 是唯一会调 Math.sqrt 的地方
  const before = countSqrt(() => run(oldCollide, fx));
  const now = countSqrt(() => run(NEW_COLLIDE, fx));
  assert.equal(before, 20 * 30, '改前：每个 pair 都要算一次最近点法线');
  assert.equal(now, 0, '改后：一个 pair 都进不了精确判定');
  assert.deepEqual(run(NEW_COLLIDE, fx).trace, run(oldCollide, fx).trace);
});

// ---------- ⑥ 随机场景等价性（等价性的主证据） ----------

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomFixture(seed, withBoss) {
  const rnd = mulberry32(seed);
  const R = (a, b) => a + rnd() * (b - a);
  const bullets = [];
  for (let i = 0, n = 6 + ((rnd() * 10) | 0); i < n; i++) {
    const x = R(-2.5, 2.5), y = R(-0.4, 1.4), z = R(-6, -1.5);
    const len = 0.05 + rnd() * 0.4;
    const dir = new THREE.Vector3(R(-0.35, 0.35), R(-0.25, 0.25), -1).normalize();
    const prev = new THREE.Vector3(x, y, z);
    const pos = prev.clone().addScaledVector(dir, len);
    bullets.push({ prev: prev.toArray(), pos: pos.toArray(), dmg: 10 });
  }
  const balloons = [];
  for (let j = 0, m = 5 + ((rnd() * 10) | 0); j < m; j++) {
    let p;
    if (rnd() < 0.45) {
      // 45% 直接挂在某条子弹轨迹上（保证场景里有命中，而不是「两边都没打中」的假等价）
      const s = bullets[(rnd() * bullets.length) | 0];
      const on = new THREE.Vector3(...s.prev).lerp(new THREE.Vector3(...s.pos), rnd());
      const off = rnd() < 0.5 ? 0 : R(-1.4, 1.4);
      p = [on.x + off, on.y + off * R(-0.4, 0.4), on.z + R(-0.6, 0.6)];
    } else {
      p = [R(-8, 8), R(-1, 6), R(-30, -2)];
    }
    const behavior = rnd() < 0.15 ? 'ghost' : (rnd() < 0.1 ? 'shield' : 'basic');
    balloons.push({
      p,
      depthSprite: rnd() < 0.5,
      hitRadius: rnd() < 0.4 ? 0.2 : R(0.4, 2.5),   // 0.2 = 模型到位后被改写过的薄血条口径
      behavior,
      revealed: rnd() < 0.5,
      alive: rnd() < 0.85,
      shieldBlock: behavior === 'shield' && rnd() < 0.5
        ? { dir: new THREE.Vector3(R(-1, 1), 0, R(-1, 1)).normalize(), arc: R(0.2, 1.2) }
        : null,
    });
  }
  if (withBoss) balloons.push({ p: [R(-1, 1), R(0, 2), R(-30, -6)], depthSprite: rnd() < 0.5, hitRadius: 4, isBoss: true });
  return { bullets, balloons };
}

test('第五十三修 · 随机场景 600 组：新旧 _collide 轨迹逐条一致', () => {
  let hits = 0;
  for (let seed = 1; seed <= 300; seed++) {
    for (const withBoss of [false, true]) {
      const fx = randomFixture(seed * 7 + (withBoss ? 1 : 0), withBoss);
      const trace = assertSame(fx, 'seed=' + seed + ' withBoss=' + withBoss);
      if (trace.some((t) => t.startsWith('dmg:'))) hits++;
    }
  }
  assert.ok(hits > 300, '随机场景必须真的打中过（否则等价性只是「两边都没命中」的空转），实际 ' + hits);
});