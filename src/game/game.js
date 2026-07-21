import * as THREE from 'three';
import { Player } from './player.js';
import { BalloonManager } from './balloons.js';
import { BulletManager } from './bullets.js';
import { WaveManager } from './waves.js';
import { CardDraft } from './cardDraft.js';
import { LaserLevel } from './laser.js';
import { GlassGrid } from './glassGrid.js';
import { FlipGrid } from './flipGrid.js';
import { RightGun } from '../vr/rightGun.js';
import { DragonBoss } from './dragonLevel.js';
import { LEVELS, isLaser } from '../content/levels.js';
import { LEVEL_PLANS } from '../content/spawnPlans.js';
import { BALLOON, BUDDHA, SHIP, LASER, GRID, FLIP, MOVE, EXPLOSION, SKY_PANORAMA } from '../core/constants.js';

const KIND_NAME = { normal: '普通关', crisis: '危机关', bonus: '奖励关', boss: 'Boss关', laser: '激光关' };
const ORIGIN = new THREE.Vector3(0, 0, 0);

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
    this.rightGun = new RightGun(world.scene);   // 右手柄 AK 枪（VR 手持，纯视觉）

    this.state = 'menu';
    this.levelIndex = 0;
    this.laser = null;       // 激光关实例（仅第3关）
    this.laserMode = false;  // 当前是否处于激光关
    this.grid = null;        // 第九关玻璃走格子实例（仅第9关）
    this.gridPhase = false;  // 是否处于走格子阶段
    this.flipGrid = null;    // 第十五关九宫格实例（仅第15关）
    this.flipPhase = false;  // 是否处于"安全解谜期"(18s 后、激光不致命)
    this.flipTimer = 0;      // 180s 倒计时剩余秒
    this.dragon = null;      // 第十二关龙 Boss 实例（boss==='dragon' 时存在）
    this.score = 0;
    this._buddhaFx = null;
    this._cardState = null;
    this._levelSnapshot = null;  // 关卡开始时的玩家属性+分数快照
    this._explosions = [];       // 爆炸视觉特效列表

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
    this._clearExplosions();
    this.log('游戏开始');
    this._loadLevel(this.levelIndex);
    this.state = 'playing';
  }

  // 回到「未开始」状态：供 sessionend 调用，使再次进入 VR 时 sessionstart 守卫生效、从干净状态开局
  toMenu() {
    this.state = 'menu';                       // 关键：让 sessionstart 的 game.start 守卫重新生效
    // 释放关卡专属实例（沿用 _loadLevel 头部写法）
    if (this.laser)    { this.laser.dispose();    this.laser = null; }
    if (this.grid)     { this.grid.dispose();     this.grid = null; }
    if (this.flipGrid) { this.flipGrid.dispose(); this.flipGrid = null; }
    if (this.dragon)   { this.dragon.dispose();   this.dragon = null; }
    // 清理实体
    this.balloons.clear();
    this.bullets.clear();
    this._clearExplosions();
    if (this._buddhaFx) { this.world.scene.remove(this._buddhaFx.mesh); this._buddhaFx = null; }
    this.cards.clearCards();                    // 清抽卡气球（不拆除 group，可再次 open 复用）
    this._cardState = null;
    this._levelSnapshot = null;
    // 重置数值
    this.player.reset();
    this.score = 0;
    this.levelIndex = 0;
    this.gridPhase = false;
    this.flipPhase = false; this.flipTimer = 0;
    this._lastCell = 0; this._failing = false; this._failTimer = 0;
    this.laserMode = false;
    // 位置 / 天空恢复预览初始态（默认天空 == dusk 预设，见 world.js 构造）
    this.rig.position.set(0, 0, 0);
    this.world.clearSkyPanorama();
    this.world.setSkyMood('dusk');
    // HUD / 音频
    this.hud.showStart();
    this.hud.clearMessage();
    this.hud.setScore(0);
    this.hud.setHp(this.player.maxHp, this.player.maxHp);
    this.audio?.stopBGM();
  }

  _loadLevel(i) {
    const lv = LEVELS[i];
    // 离开上一关时清理激光关实例与玻璃网格
    if (this.laser) { this.laser.dispose(); this.laser = null; }
    if (this.grid) { this.grid.dispose(); this.grid = null; }
    if (this.flipGrid) { this.flipGrid.dispose(); this.flipGrid = null; }
    if (this.dragon) { this.dragon.dispose(); this.dragon = null; }
    this.gridPhase = false;
    this.flipPhase = false; this.flipTimer = 0;
    this._lastCell = 0;
    this._firstCardOfLevel = true;   // 每关首次抽卡才强制攻击紫（02关）
    this.bullets.clear();        // 防跨关残留子弹误击
    this.hud.clearCountdown();   // 关倒计时显示
    this.world.setSkyMood(lv.mood);
    // 有全景配置的关卡（如第3/15关）用全景图作天空，覆盖渐变；无配置则维持渐变天空
    const pano = SKY_PANORAMA[lv.n];
    if (pano) this.world.setSkyPanorama(pano);
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
      if (lv.boss === 'dragon') {
        // 第十二关：龙 Boss（龙头 GLB + 龙身/龙爪气球沿动画路径移动）
        this.dragon = new DragonBoss(this.world.scene, this.balloons);
        this.dragon.audio = this.audio; // 注入音效，连爆时播放
        this.dragon.start();
        this.log(`第 ${lv.n} 关 · 龙 Boss：击破龙身/龙爪气球（打爆即复活，血量清零才击杀）`);
      } else {
        this.waves.startLevel(lv);
        this.log(`第 ${lv.n} 关 · ${KIND_NAME[lv.kind]}`);
      }
    }
    // 非激光关在关卡加载完成后拍照快照（用于死亡重开时恢复属性+分数）
    if (!isLaser(lv)) this._snapshotState();
  }

  _playerPos() { return this.rig.getWorldPosition(this._tmp); }

  update(dt) {
    dt = Math.min(dt, 0.05);
    this.world.update(dt);
    this.wristUI?.update(dt, this, this.input); // 手腕面板（VR 下显示，桌面忽略）
    this.rightGun.update(dt, this.input);        // 右手柄 AK 枪（VR 手持，桌面忽略）
    this._updateBuddhaFx(dt);
    this._updateExplosions(dt);

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
    // 气球追踪原点(0,0,0)而非玩家位置
    this.balloons.update(dt, ORIGIN, this.world.camera);
    if (this.dragon) {
      this.dragon.update(dt, pp);   // 龙 Boss：逐帧接管龙气球位置
    } else {
      this.waves.update(dt);
    }

    // 聚宝盆等脚本化死亡（寿命到期 → 标记 _pendingKill）在此结算
    for (const b of [...this.balloons.list]) {
      if (b._pendingKill && b.alive) { b.alive = false; this._onKilled(b); }
    }

    this._collide(); // 仅子弹vs气球（气球vs飞船已移除，改由 _checkExplosions 处理）

    // 气球进入4×8区域则自爆，可能伤害飞船并触发重开（龙气球为纯靶子，跳过不伤人）
    if (this._checkExplosions()) return;

    this.hud.setScore(this.score);
    this.hud.setHp(this.player.hp, this.player.maxHp);

    if (!this.player.alive) { this._restartLevel(); return; }
    const cleared = this.dragon ? this.dragon.cleared : this.waves.cleared;
    if (cleared) this._enterCard();
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
          const hit = this.flipGrid.tryHit(b);
          if (hit) {
            this.bullets.release(b);
            this.audio?.playPop();
            if (hit.reset) {
              this.flipGrid.resetState();
              this.flipTimer = FLIP.COUNTDOWN;   // 倒计时重置
              this.log('九宫格已重置，倒计时重置为180秒');
            }
          }
        }
        this.flipGrid.update(dt);
        if (!this.flipGrid.victory && this.flipGrid.checkWin()) this.flipGrid.beginVictory();
        if (this.flipGrid.victoryDone) { this._finishFlipLevel(true); return; }
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
        this.log('激光消散，180 秒倒计时解谜（解出→抽卡，归零→直接下一关）');
      }
      // 5) 安全期倒计时（用户修改②）
      if (this.flipPhase) {
        this.flipTimer -= dt;
        this.hud.setCountdown(Math.max(0, Math.ceil(this.flipTimer)));
        if (this.flipTimer <= 0) { this._finishFlipLevel(false); return; }
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

  // 第十五关收尾：解出→抽卡(withCard=true)；倒计时归零→直接下一关(withCard=false)
  _finishFlipLevel(withCard = true) {
    if (this.flipGrid) { this.flipGrid.dispose(); this.flipGrid = null; }
    if (this.laser) { this.laser.dispose(); this.laser = null; }
    this.flipPhase = false;
    this.flipTimer = 0;
    this.hud.clearCountdown();
    this.laserMode = false;
    if (withCard) {
      this._enterCard();   // 解出 → 抽卡（_onCardDone 负责 levelIndex++ 与加载下一关）
    } else {
      this.levelIndex++;   // 倒计时归零 → 直接下一关，不抽卡
      if (this.levelIndex >= LEVELS.length) {
        this.state = 'over';
        this.hud.message('通关！', '按「开始游戏」重新挑战', '#2ecc71');
        this.hud.showStart();
        return;
      }
      this._loadLevel(this.levelIndex);
      this.state = 'playing';
    }
  }

  _collide() {
    // 子弹 vs 气球
    for (const b of [...this.bullets.active]) {
      for (const balloon of [...this.balloons.list]) {
        if (!balloon.alive) continue; // 跳过已隐藏的龙气球（复活前），防重复触发
        // 幽灵怪隐身期间无视子弹（仅蓄力显形时可被击中）
        if (balloon.behavior === 'ghost' && !balloon.revealed) continue;
        if (b.mesh.position.distanceTo(balloon.mesh.position) < balloon.effectiveRadius + 0.12) {
          // 盾兵怪：盾牌当前朝向玩家且在挡弹夹角内 → 挡下子弹（不扣血）
          if (balloon.behavior === 'shield') {
            const sb = balloon.getShieldBlock();
            if (sb) {
              const toPlayer = this._playerPos().clone().sub(balloon.mesh.position);
              toPlayer.y = 0;
              if (toPlayer.lengthSq() > 1e-6) {
                toPlayer.normalize();
                if (toPlayer.dot(sb.dir) > Math.cos(sb.arc)) {
                  this.bullets.release(b);
                  this._spawnExplosionFx(b.mesh.position.clone(), 0.2); // 挡弹火花
                  continue; // 子弹被盾挡下，气球不受伤
                }
              }
            }
          }
          const killed = balloon.takeDamage(b.dmg);
          this.bullets.release(b);
          this.audio?.playPop();
          if (killed) this._onKilled(balloon);
          break;
        }
      }
    }
    // 气球 vs 飞船碰撞已移除 → 改由 _checkExplosions() 处理
  }

  _onKilled(balloon) {
    // 龙 Boss 部件：隐藏并由 DragonBoss 管理「1秒复活」，不从这里永久移除（且不再连锁炸其他龙部件）
    if (balloon.isDragonPart) {
      if (this.dragon && !this.dragon.dying) {
        this.score += balloon.score;
        this.audio?.playPop();
        this._spawnExplosionFx(balloon.mesh.position.clone(), balloon.effectiveRadius);
        this.dragon.notifyKilled(balloon);
      }
      balloon.alive = false;
      balloon.mesh.visible = false;
      return;
    }
    // 聚宝盆：无敌，仅寿命到期死亡；结算 = 自身携带积分 + 存活期间每死一个气球 +50
    if (balloon.behavior === 'treasure') {
      const bonus = (balloon.type.baseScore || 0) + (balloon._killsDuringLife || 0) * (balloon.type.perKillScore || 0);
      this.score += bonus;
      this.audio?.playPop();
      this.balloons.remove(balloon);
      return;
    }
    this.score += balloon.score;
    // 心型怪：击败后为船恢复血量（知识库 30）
    if (balloon.behavior === 'heal') {
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + (balloon.type.shipHealOnDeath || 30));
    }
    // 宝箱怪：死后弹出一次选项卡（占位：暂以奖励积分代替，待 mid-level 卡片系统接入）
    if (balloon.behavior === 'chest' && balloon.type.dropCard) {
      this.score += 50;
      this.log('宝箱怪被击破：待接入 mid-level 选项卡弹出');
      // TODO: 接入 mid-level 卡片弹窗（参考 _enterCard / cardDraft）
    }
    // 存活的聚宝盆记录「本气球死亡」计数（用于结算 +50/个）
    for (const t of this.balloons.list) {
      if (t.behavior === 'treasure' && t.alive && t !== balloon) {
        t._killsDuringLife = (t._killsDuringLife || 0) + 1;
      }
    }
    // 召唤怪被击杀：清掉其所有小怪（击杀召唤者才清场）
    if (balloon.behavior === 'summon' && balloon.minions && balloon.minions.length) {
      for (const m of balloon.minions) if (m.alive) this.balloons.remove(m);
      balloon.minions.length = 0;
    }
    // 爆炸范围伤害
    if (this.player.explosion > 0) {
      for (const other of [...this.balloons.list]) {
        if (other === balloon) continue;
        if (other.isDragonPart) continue; // 不让爆炸连锁白嫖龙部件
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

  // ====== 爆炸系统 ======

  // 检查气球是否进入4×8区域，进入则自爆并伤害飞船
  _checkExplosions() {
    for (const balloon of [...this.balloons.list]) {
      if (balloon.controlled) continue; // 龙 Boss 气球：纯靶子，不进入4×8自爆、不伤飞船
      const pos = balloon.mesh.position;
      // 4×8区域 = |x|<=BOUND_X(2), |z|<=BOUND_Z(4)；气球边缘触及区域边界即触发
      const inArea = Math.abs(pos.x) <= (MOVE.BOUND_X + balloon.effectiveRadius)
                  && Math.abs(pos.z) <= (MOVE.BOUND_Z + balloon.effectiveRadius);
      if (inArea) {
        this._spawnExplosionFx(balloon.mesh.position.clone(), balloon.effectiveRadius);
        this.balloons.remove(balloon);
        this.audio?.playPop();
        // 气球入侵飞船区域即造成伤害，不依赖玩家与爆炸点的距离；伤害按该气球自身自爆值
        const dead = this.player.takeDamage(balloon.isBoss ? 40 : (balloon.selfDamage ?? BALLOON.DAMAGE));
        if (dead) { this._restartLevel(); return true; }
      }
    }
    return false;
  }

  _spawnExplosionFx(position, radius) {
    const geo = new THREE.SphereGeometry(radius, 16, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: EXPLOSION.COLOR,
      transparent: true,
      opacity: EXPLOSION.START_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position);
    this.world.scene.add(mesh);
    this._explosions.push({ mesh, t: 0 });
  }

  _updateExplosions(dt) {
    for (const exp of [...this._explosions]) {
      exp.t += dt;
      const k = Math.min(1, exp.t / EXPLOSION.DURATION);
      exp.mesh.scale.setScalar(1 + k * EXPLOSION.MAX_SCALE);
      exp.mesh.material.opacity = EXPLOSION.START_OPACITY * (1 - k);
      if (k >= 1) {
        this.world.scene.remove(exp.mesh);
        exp.mesh.geometry.dispose();
        exp.mesh.material.dispose();
        const i = this._explosions.indexOf(exp);
        if (i !== -1) this._explosions.splice(i, 1);
      }
    }
  }

  _clearExplosions() {
    for (const exp of this._explosions) {
      this.world.scene.remove(exp.mesh);
      exp.mesh.geometry.dispose();
      exp.mesh.material.dispose();
    }
    this._explosions = [];
  }

  // ====== 快照与重开 ======

  _snapshotState() {
    const p = this.player;
    this._levelSnapshot = {
      atk: p.atk,
      shootCooldown: p.shootCooldown,
      multiShotChance: p.multiShotChance,
      explosion: p.explosion,
      maxHp: p.maxHp,
      hp: p.hp,
      buddhaUnlocked: p.buddhaUnlocked,
      buddhaCooldown: p.buddhaCooldown,
      buddhaTimer: p.buddhaTimer,
      shieldTime: p.shieldTime,
      score: this.score,
    };
  }

  _restoreSnapshot() {
    if (!this._levelSnapshot) return;
    const s = this._levelSnapshot;
    const p = this.player;
    p.atk = s.atk;
    p.shootCooldown = s.shootCooldown;
    p.multiShotChance = s.multiShotChance;
    p.explosion = s.explosion;
    p.maxHp = s.maxHp;
    p.hp = s.hp;
    p.buddhaUnlocked = s.buddhaUnlocked;
    p.buddhaCooldown = s.buddhaCooldown;
    p.buddhaTimer = s.buddhaTimer;
    p.shieldTime = s.shieldTime;
    this.score = s.score;
  }

  _restartLevel() {
    this.log('飞船坠毁，本关重开');
    this._restoreSnapshot();
    this.balloons.clear();
    this.bullets.clear();
    // 不调 _clearExplosions()：让死亡爆炸特效在 0.4s 内自然消亡
    this.rig.position.set(0, 0, 0);
    this._loadLevel(this.levelIndex); // 会重新拍快照（恢复后的状态）
    this.hud.setScore(this.score);
    this.hud.setHp(this.player.hp, this.player.maxHp);
  }

  _enterCard() {
    this._clearExplosions();
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
      // 01/02 关卡片品质覆盖（见 LEVEL_PLANS）；首卡强制攻击紫仅 02 关且本关首次
      rarity: LEVEL_PLANS[LEVELS[this.levelIndex].n]?.cards || null,
      forceAttackPurple: !!(LEVEL_PLANS[LEVELS[this.levelIndex].n]?.firstCardForceAttackPurple && this._firstCardOfLevel),
    };
    this._firstCardOfLevel = false; // 翻转：本关仅首张卡强制攻击紫
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
