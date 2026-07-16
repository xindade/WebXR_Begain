import * as THREE from 'three';
import { Player } from './player.js';
import { BalloonManager } from './balloons.js';
import { BulletManager } from './bullets.js';
import { WaveManager } from './waves.js';
import { CardDraft } from './cardDraft.js';
import { LaserLevel } from './laser.js';
import { GlassGrid } from './glassGrid.js';
import { FlipGrid } from './flipGrid.js';
import { LEVELS, isLaser } from '../content/levels.js';
import { BALLOON, BUDDHA, SHIP, LASER, GRID, FLIP } from '../core/constants.js';

const KIND_NAME = { normal: '普通关', crisis: '危机关', bonus: '奖励关', boss: 'Boss关', laser: '激光关' };

export class Game {
  constructor(world, hud) {
    this.world = world;
    this.hud = hud;

    this.rig = new THREE.Group();
    world.scene.add(this.rig);
    world.camera.position.set(...SHIP.POS);
    this.rig.add(world.camera);

    this.audio = null; // 由 main 注入
    this.input = null; // 由 main 注入

    this.player = new Player(world.scene, this.rig);
    this.balloons = new BalloonManager(world.scene);
    this.bullets = new BulletManager(world.scene);
    this.waves = new WaveManager(world.scene, this.balloons, () => this.rig.getWorldPosition(new THREE.Vector3()));
    this.cards = new CardDraft(world.scene);

    this.state = 'menu';
    this.levelIndex = 0;
    this.laser = null;       // 激光关实例（仅第3关）
    this.laserMode = false;  // 当前是否处于激光关
    this.grid = null;        // 第九关玻璃走格子实例（仅第9关）
    this.gridPhase = false;  // 是否处于走格子阶段
    this.flipGrid = null;    // 第十五关九宫格实例（仅第15关）
    this.flipPhase = false;  // 是否处于"安全解谜期"(18s 后、激光不致命)
    this.flipTimer = 0;      // 180s 倒计时剩余秒
    this.score = 0;
    this._buddhaFx = null;
    this._cardState = null;

    this._tmp = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
  }

  setSystems(audio, input, wristUI = null, pageLog = null) {
    this.audio = audio; this.input = input; this.wristUI = wristUI; this.pageLog = pageLog;
  }

  // 游戏内日志：同时送往左手腕面板（VR 可见）和页面日志（预览可见、最高优先）
  log(msg) {
    this.wristUI?.log(msg);
    this.pageLog?.log(msg);
  }

  start(atIndex = 0) {
    this.player.reset();
    this.balloons.clear();
    this.bullets.clear();
    this.score = 0;
    this.levelIndex = atIndex;
    this.gridPhase = false;
    this._lastCell = 0;
    this._failing = false;
    this._failTimer = 0;
    this.hud.hideStart();
    this.hud.clearMessage();
    this.hud.setScore(0);
    this.hud.setHp(this.player.hp, this.player.maxHp);
    this.audio?.unlock();
    this.audio?.startBGM();
    this.log('游戏开始');
    this._loadLevel(this.levelIndex);
    this.state = 'playing';
  }

  _loadLevel(i) {
    const lv = LEVELS[i];
    // 离开上一关时清理激光关实例与玻璃网格
    if (this.laser) { this.laser.dispose(); this.laser = null; }
    if (this.grid) { this.grid.dispose(); this.grid = null; }
    if (this.flipGrid) { this.flipGrid.dispose(); this.flipGrid = null; }
    this.gridPhase = false;
    this.flipPhase = false; this.flipTimer = 0;
    this._lastCell = 0;
    this.bullets.clear();        // 防跨关残留子弹误击
    this.hud.clearCountdown();   // 关倒计时显示
    this.world.setSkyMood(lv.mood);
    this.hud.setLevel(`第 ${lv.n} 关 · ${KIND_NAME[lv.kind]}`);
    if (isLaser(lv)) {
      this.laserMode = true;
      // 透传 laserMode：'drive' 为第九关（生成→驱赶→保持原地→走格子），'full' 为第三关（搭阵），'flip' 为第十五关（九宫格）
      const holdDur = lv.laserMode === 'flip' ? FLIP.HOLD_DUR : undefined;
      this.laser = new LaserLevel(this.world.scene, (m) => this.log(m), lv.laserMode || 'full', holdDur);
      this.laser.start();
      if (lv.laserMode === 'drive') {
        // 第九关：在游玩区铺设玻璃走格子（编号 1–32）
        this.grid = new GlassGrid(this.world.scene);
        this.grid.setCorrect(GRID.CORRECT, GRID.WIN_CELL); // 正确格集合 + 通关格(cell 3)
        this.log(`第 ${lv.n} 关 · 激光驱赶：等待→驱赶→保持原地10秒→走格子`);
      } else {
        this.log(`第 ${lv.n} 关 · 激光驱赶：等待→驱赶→保持原地2秒→九宫格翻转`);
      }
    } else {
      this.laserMode = false;
      this.waves.startLevel(lv);
      this.log(`第 ${lv.n} 关 · ${KIND_NAME[lv.kind]}`);
    }
  }

  _playerPos() { return this.rig.getWorldPosition(this._tmp); }

  update(dt) {
    dt = Math.min(dt, 0.05);
    this.world.update(dt);
    this.wristUI?.update(dt, this, this.input); // 手腕面板（VR 下显示，桌面忽略）
    this._updateBuddhaFx(dt);

    if (this.state === 'playing') this._updatePlaying(dt);
    else if (this.state === 'card') this._updateCard(dt);
  }

  _updatePlaying(dt) {
    this.input.update(dt);
    this.player.update(dt);
    this.bullets.update(dt);
    const pp = this._playerPos();

    for (const shot of this.input.shots) this.player.fire(shot, this.bullets, this.audio);

    if (this.input.consumeBuddha() && this.player.canBuddha()) {
      if (this.player.triggerBuddha()) this._doBuddha();
    }

    // ====== 激光关：无普通敌人，仅激光气球 ======
    if (this.laserMode) {
      this._updateLaserLevel(dt, pp);
      return;
    }

    // ====== 普通关 ======
    this.balloons.update(dt, pp, this.world.camera);
    this.waves.update(dt);

    this._collide();

    this.hud.setScore(this.score);
    this.hud.setHp(this.player.hp, this.player.maxHp);

    if (!this.player.alive) { this._gameOver(); return; }
    if (this.waves.cleared) this._enterCard();
  }

  // 激光关主循环：激光动画 + 保持期发光驱动 + 走格子/九宫格阶段分派
  _updateLaserLevel(dt, pp) {
    this.laser.update(dt, pp);

    // ===== flip 模式（第十五关：九宫格翻转射击）=====
    if (this.laser.mode === 'flip') {
      // 1) 16s 保持期起点：生成九宫格（用户修改①：在 16–18s 窗口内出现）
      if (!this.flipGrid && this.laser.isHoldPhase()) {
        this.flipGrid = new FlipGrid(this.world.scene);
        this.log('九宫格已生成：击破正面气球触发十字翻转');
      }
      // 2) 九宫格交互（16–18s 与 18s+ 都生效）
      if (this.flipGrid) {
        for (const b of [...this.bullets.active]) {
          if (this.flipGrid.tryHit(b)) { this.bullets.release(b); this.audio?.playPop(); }
        }
        this.flipGrid.update(dt);
        if (!this.flipGrid.victory && this.flipGrid.checkWin()) this.flipGrid.beginVictory();
        if (this.flipGrid.victoryDone) { this._finishFlipLevel(); return; }
      }
      // 3) 致命判定：进入安全期前激光仍致命（用户修改①：16–18s 致命）
      if (!this.flipPhase) {
        const hit = this.laser.hitTest(pp, LASER.PLAYER_R);
        if (hit) { this._dieInLaserLevel(); return; }
      }
      // 4) 18s 进入安全解谜期：激光淡出不致命 + 启动 180s 倒计时（用户修改②）
      if (!this.flipPhase && this.laser.reachedGoal(pp)) {
        this.flipPhase = true;
        this.laser.enterGridPhase();
        this.flipTimer = FLIP.COUNTDOWN;
        this.log('激光消散，180 秒倒计时解谜（解出或归零均进入下一关）');
      }
      // 5) 安全期倒计时（用户修改②）
      if (this.flipPhase) {
        this.flipTimer -= dt;
        this.hud.setCountdown(Math.max(0, Math.ceil(this.flipTimer)));
        if (this.flipTimer <= 0) { this._finishFlipLevel(); return; }
      }
      this.hud.setScore(this.score);
      this.hud.setHp(this.player.hp, this.player.maxHp);
      return;
    }

    // ===== drive / full 模式（第三、九关，原逻辑不变）=====
    // 保持原地期（驱赶到位后、激光未消散前）：正确格持续闪烁发光
    const holdPhase = this.laser.isHoldPhase();
    if (this.grid && !this.gridPhase) this.grid.update(dt, holdPhase);

    if (this.gridPhase) { this._updateGridPhase(dt, pp); return; }

    // ---- 激光阶段（生成 / 驱赶 / 保持原地）----
    const hit = this.laser.hitTest(pp, LASER.PLAYER_R);
    if (hit) { this._dieInLaserLevel(); return; }
    if (this.laser.reachedGoal(pp)) {
      if (this.laser.mode === 'drive') {
        // 保持期结束 → 激光消散，转入走格子阶段
        this.gridPhase = true;
        this._lastCell = 0;
        this._failing = false;
        this.laser.enterGridPhase();
        this.log('激光消散，开始走格子：踩正确格子，踩错会破碎');
      } else {
        this.laser.dispose();
        this.laser = null;
        this._enterCard();
      }
      return;
    }
    this.hud.setScore(this.score);
    this.hud.setHp(this.player.hp, this.player.maxHp);
  }

  // 第九关 drive 模式：走格子阶段（激光已消散，玩家在玻璃格上行走）
  _updateGridPhase(dt, pp) {
    if (this._failing) {
      this._failTimer -= dt;
      const k = Math.min(1, 1 - Math.max(0, this._failTimer) / 0.6);
      this.rig.position.y = -10 * k * k;   // 踩错掉落 10 米（重力加速感）
      if (this._failTimer <= 0) { this._dieInLaserLevel(); return; }
    }
    const idx = this.grid ? this.grid.cellAt(pp) : 0;
    if (idx && idx !== this._lastCell) {
      this._lastCell = idx;
      const r = this.grid.onEnter(idx);
      if (r === 'wrong') {
        this.grid.breakCell(idx);          // 踩错：破碎动画
        this._failing = true;
        this._failTimer = 0.6;             // 0.6s 后本关重开
        this.log('踩到错误格子，玻璃破碎！本关重开');
        return;
      }
      if (r === 'win') {
        this.laser.dispose(); this.laser = null;
        if (this.grid) { this.grid.dispose(); this.grid = null; }
        this.gridPhase = false;
        this._enterCard();
        return;
      }
    }
    if (this.grid) this.grid.update(dt, false); // 走格子阶段：激光已消散，发光关闭
    this.hud.setScore(this.score);
    this.hud.setHp(this.player.hp, this.player.maxHp);
  }

  // 激光关死亡：不触发全局 GameOver，本关从头重开、激光重新初始化
  _dieInLaserLevel() {
    this.log('失败，本关重开');
    this.rig.position.set(0, 0, 0);
    this.player.hp = this.player.maxHp;
    if (this.laser) this.laser.reset();
    if (this.grid) this.grid.reset();   // 玻璃网格（含破碎格）一并重建
    if (this.flipGrid) { this.flipGrid.dispose(); this.flipGrid = null; } // 九宫格 dispose，下次 16s 由 isHoldPhase 重建为初始布局
    this.gridPhase = false;
    this.flipPhase = false; this.flipTimer = 0;
    this._lastCell = 0;
    this._failing = false;
    this._failTimer = 0;
    this.hud.clearCountdown();
  }

  // 第十五关收尾：通关(解出)或 180s 倒计时归零，均进入下一关、无抽卡
  _finishFlipLevel() {
    if (this.flipGrid) { this.flipGrid.dispose(); this.flipGrid = null; }
    if (this.laser) { this.laser.dispose(); this.laser = null; }
    this.flipPhase = false;
    this.flipTimer = 0;
    this.hud.clearCountdown();
    this.laserMode = false;
    this.levelIndex++;
    if (this.levelIndex >= LEVELS.length) {
      this.state = 'over';
      this.hud.message('通关！', '按「开始游戏」重新挑战', '#2ecc71');
      this.hud.showStart();
      return;
    }
    this._loadLevel(this.levelIndex);
    this.state = 'playing';
  }

  _collide() {
    const pp = this._playerPos();
    // 子弹 vs 气球
    for (const b of [...this.bullets.active]) {
      for (const balloon of [...this.balloons.list]) {
        if (b.mesh.position.distanceTo(balloon.mesh.position) < balloon.radius + 0.12) {
          const killed = balloon.takeDamage(b.dmg);
          this.bullets.release(b);
          this.audio?.playPop();
          if (killed) this._onKilled(balloon);
          break;
        }
      }
    }
    // 气球 vs 飞船
    for (const balloon of [...this.balloons.list]) {
      const d = balloon.mesh.position.distanceTo(pp);
      if (d < SHIP.COLLISION_RADIUS + balloon.radius) {
        const dead = this.player.takeDamage(balloon.isBoss ? 40 : BALLOON.DAMAGE);
        this.balloons.remove(balloon);
        if (dead) { this._gameOver(); return; }
      }
    }
  }

  _onKilled(balloon) {
    this.score += balloon.score;
    if (balloon.behavior === 'heal') {
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + 20);
    }
    // 爆炸范围伤害
    if (this.player.explosion > 0) {
      for (const other of [...this.balloons.list]) {
        if (other === balloon) continue;
        if (other.mesh.position.distanceTo(balloon.mesh.position) < this.player.explosion) {
          if (other.takeDamage(this.player.atk * 0.5)) this._onKilled(other);
        }
      }
    }
    this.balloons.remove(balloon);
  }

  _doBuddha() {
    const pp = this._playerPos();
    this.log('如来神掌！');
    // 伤害范围内所有气球
    for (const b of [...this.balloons.list]) {
      if (b.mesh.position.distanceTo(pp) < BUDDHA.KILL_RADIUS) {
        if (b.takeDamage(BUDDHA.DAMAGE)) this._onKilled(b);
      }
    }
    // 视觉：金色巨掌从天而降
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0xffd43b, emissive: 0xffa500, emissiveIntensity: 0.6, transparent: true, opacity: 0.85 })
    );
    mesh.scale.setScalar(BUDDHA.FALL_START_SCALE);
    mesh.position.copy(pp).add(new THREE.Vector3(0, 20, 0));
    this.world.scene.add(mesh);
    this._buddhaFx = { mesh, t: 0 };
  }

  _updateBuddhaFx(dt) {
    if (!this._buddhaFx) return;
    this._buddhaFx.t += dt;
    const k = Math.min(1, this._buddhaFx.t / BUDDHA.FALL_DURATION);
    const s = THREE.MathUtils.lerp(BUDDHA.FALL_START_SCALE, BUDDHA.FALL_END_SCALE, k);
    this._buddhaFx.mesh.scale.setScalar(s);
    this._buddhaFx.mesh.position.y = THREE.MathUtils.lerp(20, 0, k) + this._playerPos().y;
    if (k >= 1) {
      this.world.scene.remove(this._buddhaFx.mesh);
      this._buddhaFx = null;
    }
  }

  _enterCard() {
    this.state = 'card';
    this.bullets.clear(); // 清掉上一波残留子弹，避免误击卡气球
    this.log('波次清空，选择强化');
    const pp = this._playerPos();
    this.world.camera.getWorldDirection(this._fwd);
    this._fwd.negate(); // 相机/手柄前向为 -Z，getWorldDirection 返回 +Z，需取反，否则卡牌会生成在身后
    this._cardState = {
      player: this.player,
      // score 访问解耦：注入回调，cardDraft 不再反向持有 game 实例
      getScore: () => this.score,
      spendScore: (cost) => { this.score -= cost; },
    };
    this.hud.message('选择强化', '射击对应气球进行选择（刷新气球可重roll，积分不足时锁定）', '#ffd43b');
    this.cards.open(pp, this._fwd.clone(), this._cardState, () => this._onCardDone());
  }

  // 抽卡模式：允许自由移动 + 射击，子弹命中卡气球即选卡
  _updateCard(dt) {
    this.input.update(dt);
    this.player.update(dt);
    this.bullets.update(dt);
    for (const shot of this.input.shots) this.player.fire(shot, this.bullets, this.audio);
    this.cards.update(dt, this.bullets, this._playerPos().clone());
  }

  _onCardDone() {
    this.hud.setScore(this.score); // game.score 已由抽卡实时维护
    this.hud.clearMessage();
    this.levelIndex++;
    if (!this.player.buddhaUnlocked) this.player.buddhaUnlocked = true; // 首波后解锁大招
    this.log('强化完成 → 进入下一关');
    if (this.levelIndex >= LEVELS.length) {
      this.state = 'over';
      this.hud.message('通关！', '按「开始游戏」重新挑战', '#2ecc71');
      this.hud.showStart();
      return;
    }
    this._loadLevel(this.levelIndex);
    this.state = 'playing';
  }

  _gameOver() {
    this.state = 'over';
    this.log('飞船坠落，游戏结束');
    this.balloons.clear();
    this.bullets.clear();
    this.hud.message('飞船坠落', `得分 ${this.score} · 按「开始游戏」重来`, '#e74c3c');
    this.hud.showStart();
  }
}
