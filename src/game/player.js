import * as THREE from 'three';
import { SHOOT, BUDDHA, SHIP, GUN_MODES } from '../core/constants.js';

// 模块级复用向量：避免每发子弹分配新对象（契合热循环 GC 优化）
const _WORLD_UP = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3();
const _spreadTs = []; // fire 内复用：弹道归一化偏移序列（0=中心，±对称）

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

  reset(gunMode = 'preview') {
    const g = GUN_MODES[gunMode] || GUN_MODES.preview;
    this.atk = 100;
    this.shootCooldown = g.cooldown;   // 射击冷却 ms（实际节流在 input.js，player 仅用于存档快照）
    this.fireRateMul = 1;              // 射速倍率快照（1=原速；射速卡减半为 0.5；真实节流在 input._gunCooldown）
    this.shotCount = g.shotCount;      // 每发子弹的弹道数（fire 确定性扇形）
    this.forceSingleShot = false;      // 抽卡等需要精确选靶时强制单发（由外部置位）
    this.multiShotChance = 0;          // 已弃用：随机多重射击改为 shotCount 确定性（爆炸系统已删除）
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

  // 发射：按 shotCount 确定性扇形铺开（1=单发，>1=多弹道），返回是否真的开了火（供音效）
  fire(shot, bullets, audio) {
    const n = this.forceSingleShot ? 1 : (this.shotCount || 1);
    if (n <= 1) {
      bullets.spawn(shot.position, shot.direction, this.atk);
    } else {
      const spread = SHOOT.SPREAD_ANGLE;
      const dir = shot.direction.clone().normalize();
      // 水平向右向量（与瞄准方向垂直、y=0）→ 纯水平扇形，不受俯仰/偏航影响
      _right.crossVectors(dir, _WORLD_UP);
      _right.y = 0;
      if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0); // 瞄正上/正下时退化
      _right.normalize();

      // 弹道偏移序列：中心固定一条 t=0（精确对准枪口/准星），其余成对对称 ±1,±2...
      // 修复：旧算法 t=(k/(n-1))*2-1 在偶数弹道时中心是空档（n=2 → -1,+1 无中心弹道）；
      // 新算法任何 n≥2 都保证恰有一条 t=0 的正中弹道。
      _spreadTs.length = 0;
      _spreadTs.push(0);                       // 中心固定弹道
      for (let i = 1; _spreadTs.length < n; i++) {
        _spreadTs.push(i);                     // 右侧 +i
        if (_spreadTs.length < n) _spreadTs.push(-i); // 左侧 -i（成对对称）
      }
      const maxT = Math.abs(_spreadTs[_spreadTs.length - 1]) || 1; // 归一化到 ±1
      for (let k = 0; k < n; k++) {
        const t = _spreadTs[k] / maxT;
        const d = dir.clone().addScaledVector(_right, t * spread);
        bullets.spawn(shot.position, d, this.atk);
      }
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
