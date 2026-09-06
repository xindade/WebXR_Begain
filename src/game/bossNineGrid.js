// 第18关魔术师Boss · 九宫格阶段
// 视觉完全复用第十五关「九宫格」(flipGrid.js 的 buildFlipBall)：3×3 双面球墙（白前/黑后），
// 间距 1.5、竖直墙面、面朝玩家 —— 与第十五关"一模一样"。
// 机制（按 IMA 笔记《18关Boss》）：9 球各 BALL_HP 血，TIMER 秒内玩家可击破；
//   超时未破的残球每 RESIDUAL_GROUP 个一组飞向玩家，触碰爆炸每球 EXPLODE_DAMAGE 伤害。
// 9 球本身是 balloons.list 中的真实气球（controlled=true，玩家子弹可正常击破），仅视觉换成 FlipGrid 球。
// 由 bossMagician.js 在「九宫格阶段」实例化，阶段结束 dispose（移除残球）。
import * as THREE from 'three';
import { MAGICIAN_BOSS } from '../core/constants.js';
import { buildFlipBall } from './flipGrid.js';

export class BossNineGrid {
  constructor(scene, balloons, getPlayerPos, damagePlayer, bossPos) {
    this.scene = scene;
    this.balloons = balloons;             // BalloonManager
    this.getPlayerPos = getPlayerPos;     // () => Vector3
    this.damagePlayer = damagePlayer;     // (dmg) => void
    this.bossPos = bossPos.clone();
    this.N = MAGICIAN_BOSS.NINE_GRID;
    this.balls = [];
    this.timer = 0;
    this.resolved = false;
    this._disposed = false;
    this._spawnBalls();
  }

  _spawnBalls() {
    if (!MAGICIAN_BOSS.SPAWN_ENEMIES) return; // 排查期关闭基础怪召唤（用户实测临时关闭）：九宫格阶段不生成9球，仅保留 Boss 闪现
    const N = this.N;
    const sp = N.SPACING;                 // 1.5，与第十五关九宫格一致
    const cols = N.COLS, rows = N.ROWS;
    // 竖直墙面（X/Y 平面），面朝玩家(+Z)，位于 Boss 前方 FRONT_DIST
    const cx = this.bossPos.x;
    const cy = N.CENTER_Y;                // 墙面中心高度（Boss 头顶附近）
    const cz = this.bossPos.z - N.FRONT_DIST; // 朝玩家方向前移
    const xs = [-sp, 0, sp];
    const ys = [cy + sp, cy, cy - sp];    // 与 FlipGrid 一致（上→下）
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const pos = new THREE.Vector3(cx + xs[c], ys[r], cz);
        const b = this.balloons.spawn('basic', pos); // 同步加入 list（无光点）
        // 手动覆盖属性（BalloonManager.spawn 不调用 onSpawn）
        b.maxHp = N.BALL_HP; b.hp = N.BALL_HP;
        b.radius = N.RADIUS; b.effectiveRadius = N.RADIUS; b.hitRadius = N.RADIUS; // 命中半径对齐 FlipGrid 球(0.75)
        b.isElite = false; b.controlled = true; b.damageReduction = 0;
        b.score = 0;
        b.mesh.material.visible = false;  // 占位球隐藏，改用 FlipGrid 双面球视觉
        const vis = buildFlipBall();       // 与第十五关九宫格完全一致：白前/黑后双面球
        b.mesh.add(vis);
        b._home = pos.clone();             // 记录网格原位（每帧覆写，防止被 AI 带走）
        b._flying = false;
        this.balls.push(b);
      }
    }
  }

  update(dt) {
    if (this._disposed) return;
    if (!this.resolved) {
      this.timer += dt;
      // 每帧把球锁在网格原位 + 轻微悬浮（覆写任何 AI 位移）
      for (const b of this.balls) {
        if (!b.alive) continue;
        b.mesh.position.copy(b._home);
        b.mesh.position.y += Math.sin((this.timer + b._home.x) * 2) * 0.12;
      }
      if (this.timer >= this.N.TIMER) this._launchResiduals();
    }
    // 推进飞行中的残球
    for (const b of this.balls) {
      if (!b.alive || !b._flying) continue;
      const tp = this.getPlayerPos();
      const dir = new THREE.Vector3().subVectors(tp, b.mesh.position);
      const d = dir.length();
      if (d < 1.2) {
        this.damagePlayer(this.N.EXPLODE_DAMAGE);
        this._explode(b);
      } else {
        dir.normalize();
        b.mesh.position.addScaledVector(dir, this.N.EXPLODE_SPEED * dt);
      }
    }
  }

  _launchResiduals() {
    this.resolved = true;
    const survivors = this.balls.filter((b) => b.alive);
    let groupIdx = 0;
    for (let i = 0; i < survivors.length; i += this.N.RESIDUAL_GROUP) {
      const grp = survivors.slice(i, i + this.N.RESIDUAL_GROUP);
      const delay = groupIdx * 0.4;
      groupIdx++;
      setTimeout(() => {
        if (this._disposed) return;
        for (const b of grp) {
          if (b.alive) { b._flying = true; b.controlled = true; }
        }
      }, delay * 1000);
    }
  }

  _explode(b) {
    if (b.alive) this.balloons.remove(b);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const b of this.balls) {
      if (b.alive) this.balloons.remove(b);
    }
    this.balls = [];
  }
}
