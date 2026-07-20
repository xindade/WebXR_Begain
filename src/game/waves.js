import * as THREE from 'three';
import { WAVE } from '../core/constants.js';
import { ENEMY_TYPES } from '../content/enemies.js';
import { isBoss } from '../content/levels.js';
import { LEVEL_ENEMY } from '../content/spawnPlans.js';

// ===== 召唤怪小兵参数（手动微调入口，改这里即可）=====
const SUMMON_MINION_DISTANCE = 1.5; // 小兵出生在召唤者「身后」的距离(m)：调大 → 离本体更远
const SUMMON_MINION_SPREAD   = 3.0; // 小兵出生点相对身后的左右/前后随机偏移(m)：调大 → 散布更开
const SUMMON_RESPAWN_DELAY   = 1.5; // 小兵死亡后延迟重生间隔(s)：调大 → 补怪更慢

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

    // 需求①：每关单一敌人，从 LEVEL_ENEMY 取本关类型与总数；缺省兜底为基础怪
    const cfg = LEVEL_ENEMY[level.n];
    if (cfg) {
      this.singleType = cfg.type;
      this.total = cfg.count;
    } else {
      this.singleType = 'basic';
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

  // 出怪类型由 LEVEL_ENEMY 单一指定，不再随机挑选

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

    if (isBoss(this.level)) {
      if (!this.bossSpawned) this._spawnBoss();
      // 击杀或撞船移除都算通关，避免撞船后 boss 仍在 list 之外导致卡死
      if (this.boss && (!this.boss.alive || !this.balloons.list.includes(this.boss))) this.cleared = true;
      return;
    }

    // 需求②：每关单一敌人、一次只出一个；场上清空（死亡）后才出下一个
    this.elapsed += dt;
    if (this.spawned < this.total && this.balloons.count === 0) {
      const spawnRadius = ENEMY_TYPES[this.singleType]?.radius || 0.5;
      this.balloons.spawn(this.singleType, this._spawnPos(spawnRadius));
      this.spawned++;
    }
    if (this.spawned >= this.total && this.balloons.count === 0) {
      this.cleared = true;
    }

    // 召唤怪持续维持小兵（其机制的一部分；小兵随主敌同屏，不再额外计为「另一种敌人」）
    this._updateSummoners(dt);
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

  // 盾兵怪（shield）现已自带「骑士模型 + 会旋转的盾牌」，盾牌在 balloons.js 内自转并挡子弹，
  // 不再需要 waves 层做「盾牌绕骑士公转」的编队逻辑，故此处移除。第 4 关「盾牌卫队」改为直接出盾兵怪。
}

// ===== 盾牌绕骑士公转参数（已废弃，保留注释以备回溯）=====
// 原设计：盾牌气球环绕骑士旋转形成护卫阵（每 2 秒 1 圈）。现盾兵怪自身即「骑士+旋转盾」，
// 故改为每个盾兵怪独立持盾自转。以下常量不再被引用。
// const SHIELD_ORBIT_PERIOD = 2.0;
// const SHIELD_ORBIT_GAP    = 0.8;
// const SHIELD_ORBIT_Y      = 0.0;
// const SHIELD_ORBIT_SPEED  = (Math.PI * 2) / SHIELD_ORBIT_PERIOD;
