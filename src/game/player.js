import * as THREE from 'three';
import { SHOOT, BUDDHA, SHIP } from '../core/constants.js';

// 玩家：属性成长、飞船血量、大招（如来神掌）
export class Player {
  constructor(scene, rig) {
    this.scene = scene;
    this.rig = rig;
    this._buildShip();
    this.reset();
  }

  _buildShip() {
    // 飞船视觉为占位，已由 world.js 的边界长方体（蓝色地板）替代行动边界标识，
    // 故此处只保留空 Group，避免破坏 rig.add / reset 的引用。
    // 之前贴在脸上的气球、绳子(长柱体)、篮子(柱体下方)已全部移除。
    this.ship = new THREE.Group();
    this.rig.add(this.ship);
  }

  reset() {
    this.atk = 100;
    this.shootCooldown = SHOOT.COOLDOWN;
    this.multiShotChance = 0;
    this.explosion = 0;
    this.maxHp = SHIP.MAX_HP;
    this.hp = SHIP.MAX_HP;
    this.buddhaUnlocked = false;     // 第 0 波后由游戏默认解锁
    this.buddhaCooldown = BUDDHA.COOLDOWN;
    this.buddhaTimer = 0;
    this.shieldTime = 0;
    this.ship.visible = true;
  }

  get alive() { return this.hp > 0; }

  takeDamage(dmg) {
    if (this.shieldTime > 0) return false;
    this.hp = Math.max(0, this.hp - dmg);
    return this.hp <= 0;
  }

  update(dt) {
    if (this.buddhaTimer > 0) this.buddhaTimer -= dt;
    if (this.shieldTime > 0) this.shieldTime -= dt;
  }

  // 发射：返回是否真的开了火（供音效）
  fire(shot, bullets, audio) {
    bullets.spawn(shot.position, shot.direction, this.atk);
    if (this.multiShotChance > 0 && Math.random() * 100 < this.multiShotChance) {
      const d = shot.direction.clone();
      d.x += (Math.random() - 0.5) * 0.12;
      d.y += (Math.random() - 0.5) * 0.12;
      bullets.spawn(shot.position, d, this.atk);
    }
    audio.playShoot();
  }

  canBuddha() { return this.buddhaUnlocked && this.buddhaTimer <= 0; }

  triggerBuddha() {
    if (!this.canBuddha()) return false;
    this.buddhaTimer = this.buddhaCooldown;
    return true;
  }
}
