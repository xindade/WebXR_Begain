import * as THREE from 'three';
import { SHOOT, BUDDHA, SHIP, GUN_MODES, LOADOUTS } from '../core/constants.js';

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

  reset(gunMode = 'preview', loadout = null) {
    const g = GUN_MODES[gunMode] || GUN_MODES.preview;
    this.atk = 100;
    this.shootCooldown = g.cooldown;   // 射击冷却 ms（实际节流在 input.js，player 仅用于存档快照）
    this.fireRate = 2;                 // 射速基线（发/秒）：笔记 2 发/秒，卡 +2/次，上限 20（见 cards.ATTRIBUTE_STATS；真实节流在 input）
    this.shotCount = g.shotCount;      // 每发子弹的弹道数（fire 确定性扇形）
    this.skillCost = 500;              // 技能消耗积分（笔记默认 500，卡 -100/次，下限 100）
    this.skillDamageMul = 1;           // 技能伤害倍率（笔记默认 ×1，卡 +1/次，上限 ×5）
    this.regen = 0;                    // 自我修复 %/s（笔记默认 0，卡 +2/次，上限 10%）
    this.forceSingleShot = false;      // 抽卡等需要精确选靶时强制单发（由外部置位）
    this.bonusShotCount = 0;           // 第五十五修 · 商店道具「多才是王道」：临时追加的弹道数（由 game._tickShopItems 维护）
    this.skillCdDown = 0;              // 第五十五修 · 商店「技能冷却-」：累计减少的冷却秒数（见 game._skillCdTotal）
    this.multiShotChance = 0;          // 已弃用：随机多重射击改为 shotCount 确定性（爆炸系统已删除）
    this.maxHp = SHIP.MAX_HP;
    this.hp = SHIP.MAX_HP;
    this.buddhaUnlocked = false;     // 第 0 波后由游戏默认解锁
    this.buddhaCooldown = BUDDHA.COOLDOWN;
    this.buddhaTimer = 0;
    this.shieldTime = 0;
    this.ship.visible = true;

    // ★ 第二十二修：进 VR 前二选一的**开局加成**。只改初始值，后续卡牌/死亡加成不受影响。
    //   取整/下限是为了让腕表 UI 与 HUD 上显示的是干净数字（射速保留一位小数）。
    const lo = loadout ? LOADOUTS[loadout] : null;
    if (lo) {
      this.atk = Math.max(1, Math.round(this.atk * lo.atkMul));
      this.fireRate = Math.max(0.5, Math.round(this.fireRate * lo.fireRateMul * 100) / 100);
      this.loadoutKey = lo.key;
    } else {
      this.loadoutKey = null;
    }
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
    // 自我修复：每秒回血 regen%（占上限比例），不超过上限
    if (this.regen > 0 && this.hp < this.maxHp) {
      this.hp = Math.min(this.maxHp, this.hp + this.maxHp * this.regen / 100 * dt);
    }
  }

  // 发射：按 shotCount 确定性扇形铺开（1=单发，>1=多弹道）。
  //   返回**这一枪实际打出的弹数**（第五十修：龙族宝箱按打出的发数给加成；旧注释写的「返回是否开火」从来没实现过）
  // boost（第四十九修）：连杀加速期打出的子弹 —— 交给 BulletManager 用实例色染蓝、曳光加长
  fire(shot, bullets, audio, boost = false) {
    // 第五十五修：商店道具「多才是王道」在基础弹道数上叠加临时弹道（抽卡/商店关强制单发时不叠加）
    const n = this.forceSingleShot ? 1 : (this.shotCount || 1) + (this.bonusShotCount || 0);
    if (n <= 1) {
      bullets.spawn(shot.position, shot.direction, this.atk, boost);
    } else {
      // 第五十四修：半角随弹道数增长 —— 每多一条弹道，扇形外沿再多展开一个步进
      //   （步进 = SPREAD_ANGLE/(SPREAD_FULL_N-1)），到 SPREAD_FULL_N 条时用满 SPREAD_ANGLE。
      //   于是「额外子弹+1」在 2~3 条时几乎贴着准星（读作「同一点上多一发伤害」），
      //   堆满 12 条才铺成一把扇形；改前是恒定半角 ⇒ 加弹道只是变密、张角不涨。
      //   SPREAD_FULL_N 缺省 / 写 1 时退化成恒定半角（公式自动取 1，不会 NaN）。
      const spread = SHOOT.SPREAD_ANGLE * Math.min(1, (n - 1) / ((SHOOT.SPREAD_FULL_N || 2) - 1));
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
        bullets.spawn(shot.position, d, this.atk, boost);
      }
    }
    audio.playShoot();
    return n;
  }

  canBuddha() { return this.buddhaUnlocked && this.buddhaTimer <= 0; }

  triggerBuddha() {
    if (!this.canBuddha()) return false;
    this.buddhaTimer = this.buddhaCooldown;
    return true;
  }
}
