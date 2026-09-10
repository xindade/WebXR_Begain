// 第18关魔术师Boss · 第三阶段「黑白球墙」（替换原九宫格 BossNineGrid）
// 布局：两片 3×3 纯色球墙（一片全白、一片全黑），阵列平面自动转向场地中心（世界原点），
//       使玩家站在场地中心时正对看到两面整齐的球阵（不会看到侧边薄面）。
// 机制：每球 HP 血；前 FLOAT_TIME 秒球被锁在墙体原位做上下浮动（不受 AI/分离位移、不追击），
//       时间到后仍存活的球脱离墙体、朝玩家追击；进入 4×8 区域即自爆 ——
//       自爆伤害由 game._checkExplosions 按 balloon.selfDamage 结算（本类写入 SELF_DAMAGE）。
// 球是 balloons.list 中的真实气球（behavior='orb'，玩家子弹可正常击破），视觉为纯色球体。
// 由 bossMagician.js 在「九宫格阶段」实例化；阶段结束/切换时 dispose（移除残球）。
import * as THREE from 'three';
import { MAGICIAN_BOSS } from '../core/constants.js';

export class BossBallWall {
  constructor(scene, balloons, bossPos) {
    this.scene = scene;
    this.balloons = balloons;                 // BalloonManager
    this.W = MAGICIAN_BOSS.ORB_WALL;
    this.balls = [];
    this.timer = 0;                           // 阶段内已流逝时间（驱动浮动 + 计时释放）
    this.released = false;                    // 是否已脱离墙体（开始追击）
    this._disposed = false;
    this._spawn();
  }

  // 生成两片墙（每片 3×3；WALLS[0]=白、WALLS[1]=黑，交替取色，可自行加更多片）
  _spawn() {
    const W = this.W;
    const sp = W.SPACING;
    const lane = [-sp, 0, sp];                // 阵列水平偏移（局部 X）
    W.WALLS.forEach((wall, wi) => {
      const isWhite = wi % 2 === 0;
      const color = isWhite ? W.WHITE_COLOR : W.BLACK_COLOR;
      // 让阵列正面(+Z)指向场地中心(原点)：绕 Y 转 atan2(-x, -z)。
      // 旋转后局部 (lx, 0, 0) → 世界 (lx·cos, 0, -lx·sin)，故下面按此换算。
      const yaw = (wall.x === 0 && wall.z === 0) ? 0 : Math.atan2(-wall.x, -wall.z);
      const cos = Math.cos(yaw), sin = Math.sin(yaw);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const lx = lane[c];
          const ly = sp - r * sp;             // 竖直偏移（上→下，与第15关九宫格一致）
          const pos = new THREE.Vector3(
            wall.x + lx * cos,
            W.CENTER_Y + ly,
            wall.z - lx * sin
          );
          const b = this.balloons.spawn('orb', pos);   // 同步加入 balloons.list（无传送门光点）
          // BalloonManager.spawn 不调用 onSpawn → 这里手动覆盖属性
          b.maxHp = W.HP; b.hp = W.HP;
          b.radius = W.RADIUS; b.effectiveRadius = W.RADIUS; b.hitRadius = W.RADIUS;
          b.controlled = true;                 // 浮动期由本控制器逐帧接管位置（也跳过 4×8 自爆判定）
          b.damageReduction = 0;
          b.score = W.SCORE;
          b.selfDamage = W.SELF_DAMAGE;        // 进 4×8 区域自爆对玩家的伤害
          b.speed = W.CHASE_SPEED;             // 脱离墙体后的追击速度
          b.isElite = false;
          if (b.mesh.material && b.mesh.material.color) {
            b.mesh.material.color.setHex(color);
            // 黑球在暗环境下几乎不可见 → 给极弱自发光勾出轮廓（白球本来就亮，不加）
            if (!isWhite && b.mesh.material.emissive) b.mesh.material.emissive.setHex(0x0d0d0d);
          }
          b._home = pos.clone();               // 墙体原位（浮动期每帧覆写，防止被 AI/分离带走）
          b._bobPhase = Math.random() * Math.PI * 2; // 各自相位 → 球阵浮动不同步
          this.balls.push(b);
        }
      }
    });
  }

  update(dt) {
    if (this._disposed) return;
    this.timer += dt;
    if (this.released) return;                 // 已释放：位置交给 Balloon.update 自动追击
    const W = this.W;
    // 浮动期：锁回墙体原位 + 各自相位的上下浮动
    for (const b of this.balls) {
      if (!b.alive) continue;
      b.mesh.position.copy(b._home);
      b.mesh.position.y += Math.sin(b._bobPhase + this.timer * W.FLOAT_FREQ * Math.PI * 2) * W.FLOAT_AMP;
    }
    if (this.timer >= W.FLOAT_TIME) this._release();
  }

  // 浮动结束：存活球脱离墙体 → 交还 Balloon.update 自动朝玩家追击（进 4×8 即自爆）
  _release() {
    this.released = true;
    for (const b of this.balls) {
      if (!b.alive) continue;
      b.controlled = false;
    }
  }

  get aliveCount() {
    let n = 0;
    for (const b of this.balls) if (b.alive) n++;
    return n;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const b of this.balls) {
      if (b.alive && this.balloons.list.includes(b)) this.balloons.remove(b);
    }
    this.balls = [];
  }
}
