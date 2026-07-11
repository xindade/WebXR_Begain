import * as THREE from 'three';
import { WAVE } from '../core/constants.js';
import { NORMAL_POOL, CRISIS_POOL, ENEMY_TYPES } from '../content/enemies.js';
import { isCrisis, isBoss } from '../content/levels.js';

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
    this.total = WAVE.BASE_SPAWN_COUNT + level.n * 5;
  }

  _phase() {
    if (this.elapsed >= WAVE.PHASE3_AT) return 3;
    if (this.elapsed >= WAVE.PHASE2_AT) return 2;
    return 1;
  }

  _spawnPos() {
    const p = this.getPlayerPos();
    const phase = this._phase();
    let a;
    if (phase === 1) a = (-40 + Math.random() * 80) * Math.PI / 180;
    else if (phase === 2) a = (-110 + Math.random() * 220) * Math.PI / 180;
    else a = Math.random() * Math.PI * 2;
    // 前方为 -Z
    const dir = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
    const pos = p.clone().addScaledVector(dir, WAVE.SPAWN_DISTANCE);
    pos.x += (Math.random() - 0.5) * WAVE.SPAWN_SPREAD;
    pos.y = 1 + Math.random() * 2.5;
    return pos;
  }

  _pickType() {
    const pool = isCrisis(this.level) ? CRISIS_POOL : NORMAL_POOL;
    // 危机关有概率出骑士
    if (isCrisis(this.level) && Math.random() < 0.18) return 'knight';
    return pool[Math.floor(Math.random() * pool.length)];
  }

  _spawnBoss() {
    const b = this.balloons.spawn('knight', this._spawnPos());
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

    // 分批生成
    this.timer += dt;
    if (this.timer >= WAVE.BATCH_INTERVAL && this.spawned < this.total) {
      this.timer = 0;
      const room = WAVE.MAX_ACTIVE - this.balloons.count;
      const n = Math.min(WAVE.BATCH_SIZE, room, this.total - this.spawned);
      for (let i = 0; i < n; i++) {
        this.balloons.spawn(this._pickType(), this._spawnPos());
        this.spawned++;
      }
    }

    // 本波清空
    if (this.spawned >= this.total && this.balloons.count === 0) {
      this.cleared = true;
    }
  }
}
