import * as THREE from 'three';
import { WAVE } from '../core/constants.js';
import { NORMAL_POOL, CRISIS_POOL, ENEMY_TYPES } from '../content/enemies.js';
import { isCrisis, isBoss } from '../content/levels.js';
import { LEVEL_PLANS } from '../content/spawnPlans.js';

// ===== 召唤怪小兵参数（手动微调入口，改这里即可）=====
const SUMMON_MINION_DISTANCE = 1.5; // 小兵出生在召唤者「身后」的距离(m)：调大 → 离本体更远
const SUMMON_MINION_SPREAD   = 3.0; // 小兵出生点相对身后的左右/前后随机偏移(m)：调大 → 散布更开
const SUMMON_RESPAWN_DELAY   = 1.5; // 小兵死亡后延迟重生间隔(s)：调大 → 补怪更慢

// ===== 盾牌绕骑士公转参数（手动微调入口，改这里即可）=====
const SHIELD_ORBIT_PERIOD = 2.0;   // 公转周期(s)：盾牌绕骑士转一整圈耗时；调小 → 转更快
const SHIELD_ORBIT_GAP    = 0.8;   // 公转留白(m)：盾牌中心到「骑士外壳外」的额外距离；调大 → 离骑士更远
const SHIELD_ORBIT_Y      = 0.0;   // 公转高度偏移(m)：相对骑士中心的 y 偏移；正值 → 飞更高
const SHIELD_ORBIT_SPEED  = (Math.PI * 2) / SHIELD_ORBIT_PERIOD; // 角速度(rad/s)，由周期推导（勿手改）

// 波次管理：分阶段生成（前→左右→全向），清空后触发抽卡
export class WaveManager {
  constructor(scene, balloons, getPlayerPos) {
    this.scene = scene;
    this.balloons = balloons;
    this.getPlayerPos = getPlayerPos;
    this.reset();
  }

  reset() {
    this.level = null;
    this.total = 0;
    this.spawned = 0;
    this.elapsed = 0;
    this.timer = 0;
    this.cleared = false;
    this.bossSpawned = false;
    this.boss = null;
  }

  // 本关剩余敌人数 = 尚未生成 + 场上存活
  get remaining() {
    if (!this.level) return 0;
    return (this.total - this.spawned) + this.balloons.count;
  }

  startLevel(level) {
    this.level = level;
    this.elapsed = 0;
    this.timer = 0;
    this.spawned = 0;
    this.cleared = false;
    this.bossSpawned = false;
    this.boss = null;

    // 01/02 关：走固定编队计划；其余关保持原随机池
    const plan = LEVEL_PLANS[level.n];
    if (plan) {
      this.plan = plan;
      // 预展开每段队列（类型数组），数量之和计入 total
      this.segQueues = plan.segments.map(seg => {
        const q = [];
        for (const [type, count] of seg.spawns) {
          for (let i = 0; i < count; i++) q.push(type);
        }
        return q;
      });
      this.segIndex = 0;
      this.total = this.segQueues.reduce((s, q) => s + q.length, 0);
    } else {
      this.plan = null;
      this.segQueues = null;
      this.segIndex = 0;
      this.total = WAVE.BASE_SPAWN_COUNT + level.n * 5;
    }
  }

  _phase() {
    if (this.elapsed >= WAVE.PHASE3_AT) return 3;
    if (this.elapsed >= WAVE.PHASE2_AT) return 2;
    return 1;
  }

  _spawnPos(spawnRadius = 0.5) {
    const GAP = 0.2;
    const MAX_ATTEMPTS = 10;
    let pos, attempts = 0;
    do {
      const phase = this._phase();
      let a;
      if (phase === 1) a = (-40 + Math.random() * 80) * Math.PI / 180;
      else if (phase === 2) a = (-110 + Math.random() * 220) * Math.PI / 180;
      else a = Math.random() * Math.PI * 2;
      // 前方为 -Z
      const dir = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
      // 相对原点(0,0,0)生成，而非 getPlayerPos()
      pos = new THREE.Vector3(0, 0, 0).addScaledVector(dir, WAVE.SPAWN_DISTANCE);
      pos.x += (Math.random() - 0.5) * WAVE.SPAWN_SPREAD;
      pos.y = 1 + Math.random() * 2.5;
      attempts++;
    } while (attempts < MAX_ATTEMPTS && this._isSpawnTooClose(pos, spawnRadius, GAP));
    return pos;
  }

  _isSpawnTooClose(pos, spawnRadius, gap) {
    for (const b of this.balloons.list) {
      const dx = pos.x - b.mesh.position.x;
      const dz = pos.z - b.mesh.position.z;
      const minDist = spawnRadius + b.radius + gap;
      if (dx * dx + dz * dz < minDist * minDist) return true;
    }
    return false;
  }

  _pickType() {
    const pool = isCrisis(this.level) ? CRISIS_POOL : NORMAL_POOL;
    // 危机关有概率出骑士
    if (isCrisis(this.level) && Math.random() < 0.18) return 'knight';
    return pool[Math.floor(Math.random() * pool.length)];
  }

  _spawnBoss() {
    const b = this.balloons.spawn('knight', this._spawnPos(ENEMY_TYPES.knight.radius));
    b.maxHp = 3000; b.hp = 3000; b.speed = 0.25; b.radius = 2; b.score = 500;
    b.mesh.scale.setScalar(4);
    b.isBoss = true;
    this.boss = b;
    this.bossSpawned = true;
  }

  update(dt) {
    if (!this.level || this.cleared) return;
    this.elapsed += dt;

    if (isBoss(this.level)) {
      if (!this.bossSpawned) this._spawnBoss();
      // 击杀或撞船移除都算通关，避免撞船后 boss 仍在 list 之外导致卡死
      if (this.boss && (!this.boss.alive || !this.balloons.list.includes(this.boss))) this.cleared = true;
      return;
    }

    // 01/02/04 关：固定编队计划驱动
    if (this.plan) {
      this._updatePlan(dt);
      this._updateSummoners(dt);
      this._updateShieldOrbit(dt);
      return;
    }

    // 其余关：分批随机生成
    this.timer += dt;
    if (this.timer >= WAVE.BATCH_INTERVAL && this.spawned < this.total) {
      this.timer = 0;
      const room = WAVE.MAX_ACTIVE - this.balloons.count;
      const n = Math.min(WAVE.BATCH_SIZE, room, this.total - this.spawned);
      for (let i = 0; i < n; i++) {
        const typeId = this._pickType();
        const spawnRadius = ENEMY_TYPES[typeId]?.radius || 0.5;
        this.balloons.spawn(typeId, this._spawnPos(spawnRadius));
        this.spawned++;
      }
    }

    // 本波清空
    if (this.spawned >= this.total && this.balloons.count === 0) {
      this.cleared = true;
    }

    this._updateShieldOrbit(dt);
  }

  // —— 01/02 固定编队出怪 ——
  _updatePlan(dt) {
    const segs = this.plan.segments;
    const last = segs.length - 1;

    // 推进到下一时段：当前段已到 until 且队列已排空（确保本段全部生成，避免漏怪卡死清场）
    while (this.segIndex < last &&
           this.elapsed >= segs[this.segIndex].until &&
           this.segQueues[this.segIndex].length === 0) {
      this.segIndex++;
    }
    const seg = segs[this.segIndex];

    // 分批生成当前段队列
    this.timer += dt;
    if (this.timer >= WAVE.BATCH_INTERVAL && this.spawned < this.total && this.segQueues[this.segIndex].length > 0) {
      this.timer = 0;
      const room = WAVE.MAX_ACTIVE - this.balloons.count;
      const n = Math.min(WAVE.BATCH_SIZE, room, this.segQueues[this.segIndex].length);
      for (let i = 0; i < n; i++) {
        const typeId = this.segQueues[this.segIndex].shift();
        const spawnRadius = ENEMY_TYPES[typeId]?.radius || 0.5;
        this.balloons.spawn(typeId, this._spawnPosForPlan(seg.dirs, spawnRadius));
        this.spawned++;
      }
    }

    // 全部生成完且场上清空 → 通关
    if (this.spawned >= this.total && this.balloons.count === 0) {
      this.cleared = true;
    }
  }

  // 按 dirs 选方位角生成（front=0°, left=+90°, right=-90°，各 ±40° 扇形）
  _spawnPosForPlan(dirs, spawnRadius = 0.5) {
    const GAP = 0.2;
    const MAX_ATTEMPTS = 10;
    const center = (d) => d === 'front' ? 0 : d === 'left' ? Math.PI / 2 : -Math.PI / 2;
    const half = 40 * Math.PI / 180;
    let pos, attempts = 0;
    do {
      const d = dirs[Math.floor(Math.random() * dirs.length)];
      const a = center(d) + (Math.random() * 2 - 1) * half;
      const dir = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a)); // 前方为 -Z
      pos = new THREE.Vector3(0, 0, 0).addScaledVector(dir, WAVE.SPAWN_DISTANCE);
      pos.x += (Math.random() - 0.5) * WAVE.SPAWN_SPREAD;
      pos.y = 1 + Math.random() * 2.5;
      attempts++;
    } while (attempts < MAX_ATTEMPTS && this._isSpawnTooClose(pos, spawnRadius, GAP));
    return pos;
  }

  // 召唤怪：存活期间维持 minionCap 只基础怪；死后由 _onKilled 清场（此处兜底）
  _updateSummoners(dt) {
    for (const b of [...this.balloons.list]) {
      if (b.behavior !== 'summon') continue;
      // 死亡兜底清理（主清理在 game._onKilled）
      if (!b.alive) {
        if (b.minions.length) {
          for (const m of b.minions) if (m.alive) this.balloons.remove(m);
          b.minions.length = 0;
        }
        continue;
      }
      // 剔除已死小怪
      b.minions = b.minions.filter(m => m.alive && this.balloons.list.includes(m));
      // 计时到则补满（小怪死后延迟重生）
      b.summonTimer -= dt;
      if (b.minions.length < b.minionCap && b.summonTimer <= 0) {
        const pp = this.getPlayerPos();
        const back = b.mesh.position.clone().sub(pp);
        back.y = 0;
        if (back.length() > 0.001) back.normalize(); else back.set(0, 0, 1);
        while (b.minions.length < b.minionCap) {
          const mp = b.mesh.position.clone().addScaledVector(back, SUMMON_MINION_DISTANCE);
          mp.x += (Math.random() - 0.5) * SUMMON_MINION_SPREAD;
          mp.z += (Math.random() - 0.5) * SUMMON_MINION_SPREAD;
          const minion = this.balloons.spawn('basic', mp);
          minion.owner = b;
          b.minions.push(minion);
        }
        b.summonTimer = SUMMON_RESPAWN_DELAY; // 死后延迟重生间隔
      }
    }
  }

  // 盾牌绕骑士公转（仅第 4 关启用）：每个盾牌锁定最近的存活骑士，绕其旋转一圈/周期。
  // 骑士全灭则盾牌恢复自主追击（controlled=false），不影响清场。
  _updateShieldOrbit(dt) {
    if (!this.level || this.level.n !== 4) return; // 仅第 4 关：盾牌护卫骑士
    const knights = this.balloons.list.filter(b => b.alive && (b.behavior === 'knight' || b.isBoss));
    for (const s of this.balloons.list) {
      if (s.type.id !== 'shield' || !s.alive) continue;
      // 找最近的存活骑士
      let knight = null, best = Infinity;
      for (const k of knights) {
        const d = s.mesh.position.distanceTo(k.mesh.position);
        if (d < best) { best = d; knight = k; }
      }
      if (!knight) { s.controlled = false; continue; } // 无骑士可绕 → 恢复自主移动
      s.controlled = true;                              // 暂停自动移动，由公转逻辑接管位置
      if (s.orbitAngle === undefined) s.orbitAngle = Math.random() * Math.PI * 2; // 初相位随机，避免多盾重叠
      s.orbitAngle += SHIELD_ORBIT_SPEED * dt;
      // 公转半径 = 骑士实际可见半径 + 盾牌半径 + 留白（自动随骑士缩放适配）
      const kr = knight.radius * (knight.mesh.scale.x || 1);
      const orbitR = kr + s.radius + SHIELD_ORBIT_GAP;
      s.mesh.position.set(
        knight.mesh.position.x + Math.cos(s.orbitAngle) * orbitR,
        knight.mesh.position.y + SHIELD_ORBIT_Y,
        knight.mesh.position.z + Math.sin(s.orbitAngle) * orbitR
      );
    }
  }
}
