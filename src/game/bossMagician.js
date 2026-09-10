// 第18关 · 魔术师 Boss 控制器
// 阶段循环：开场(0-10s, 正前30m播动画) → 激光(11-20s, 正前30m) → 玻璃墙(21-30s, 闪现左边30m) → 九宫格(31-40s, 闪现右边30m) → A→B→C…
// 血量动态 = HP_BASE + 玩家DPS × HP_DPS_SEC；Boss 代理气球受击即扣血，血空触发通关。
// 复用 glbCache 加载「魔术师动画版」GLB 并循环播放内嵌动画（常驻，不自动消失）；
// 视觉模型与命中代理解耦：代理气球(balloons.list) 只做命中靶子，模型独立动画 + 每帧同步位置。
import * as THREE from 'three';
import { MAGICIAN_BOSS, MOVE, SHURIKEN } from '../core/constants.js';
import { ENEMY_TYPES } from '../content/enemies.js';   // 召唤怪速度回退（未显式配 SPEED 时用敌种默认）
import { loadGLB, cloneGLBScene } from './glbCache.js';
import { BossLaserGroup } from './bossLaserGroup.js';
import { BossGlassWall } from './bossGlassWall.js';
import { BossNineGrid } from './bossNineGrid.js';
import { BossBallWall } from './bossBallWall.js';   // 第三阶段「黑白球墙」（替代九宫格，ORB_WALL.ENABLED=false 可回退）
import { BossHealthBar3D } from './bossHealthBar.js'; // Boss 头顶 3D 血条（sprite 自动面向相机）
import { WinBanner3D } from './winBanner.js';        // Boss 死亡后 VR 横幅（锚定准星、10s 后自动退出，见 winBanner.js）

const D2R = Math.PI / 180; // 度→弧度（MODEL_ROTATION 用度标注）
const WIN_BANNER_TEXT = '邪恶魔术师终于死了\n你成功拯救了公主'; // Boss 死亡 3D 横幅文案（双行）

export class MagicianBoss {
  constructor(waves) {
    this.waves = waves;
    this.scene = waves.scene;
    this.balloons = waves.balloons;
    this.getPlayerPos = waves.getPlayerPos;
    this.getPlayerDPS = waves.getPlayerDPS;
    this.damagePlayer = waves.damagePlayer || (() => {});
    this.spawn = (type, pos, opts) => waves._queueSpawn(type, pos, opts);

    this.phase = 'intro';      // intro | laser | glass | nine
    this.phaseTimer = 0;
    this._proxy = null;
    this._modelRoot = null;
    this._mixer = null;
    this._laser = null;
    this._glass = null;
    this._nine = null;
    this._ballWall = null;                       // 第三阶段「黑白球墙」控制器
    this._disposed = false;
    this._summonQueue = [];                      // 召唤怪分帧消费队列（错峰，防同帧重度 GLB 解码卡死）
    this._summoned = 0;                          // 本阶段已召唤波数（见 _summonTick）
    this._hpBar = null;                          // Boss 头顶 3D 血条（代理落地后创建）
    this._tmpV = new THREE.Vector3();            // 血条定位临时量

    this._spawnProxy();
    this._loadModel();
  }

  _spawnProxy() {
    const pos = new THREE.Vector3(...MAGICIAN_BOSS.POSITIONS[0]);
    this.spawn('basic', pos, {
      onSpawn: (b) => {
        const hp = MAGICIAN_BOSS.HP_BASE + (this.getPlayerDPS ? this.getPlayerDPS() : 0) * MAGICIAN_BOSS.HP_DPS_SEC;
        b.maxHp = hp; b.hp = hp;
        b.isBoss = true;
        b.controlled = true;     // 由本控制器逐帧接管位置
        b.damageReduction = 0;   // 直接命中即全额扣血
        b.radius = MAGICIAN_BOSS.PROXY_RADIUS;
        b.effectiveRadius = MAGICIAN_BOSS.PROXY_RADIUS;
        b.hitRadius = MAGICIAN_BOSS.PROXY_RADIUS;
        b.score = 2000;
        b.mesh.scale.setScalar(1);
        b.mesh.visible = false; // 隐藏整个代理子树（最外层球 + 占位胶囊/眼睛/名牌子网格），避免 Boss 脚下出现"可见基础小怪"
        this._proxy = b;
        this.waves.bossSpawned = true;   // 落地即置位（防飞行期 cleared 误判）
        if (!this._hpBar) this._hpBar = new BossHealthBar3D(this.scene); // Boss 头顶 3D 血条
      },
    });
  }

  _loadModel() {
    loadGLB(MAGICIAN_BOSS.MODEL)
      .then((gltf) => {
        if (this._disposed) return;
        this._modelRoot = cloneGLBScene(gltf);
        this._modelRoot.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(this._modelRoot);
        const size = box.getSize(new THREE.Vector3());
        // 缩放：先算「2m 基准缩放」(SCALE/size.y)，再 ×MODEL_SCALE(10) → 最终放大 10 倍(20m)
        const baseScale = size.y > 0 ? MAGICIAN_BOSS.SCALE / size.y : 1;
        const s = baseScale * MAGICIAN_BOSS.MODEL_SCALE;
        this._modelRoot.scale.setScalar(s);
        // 三轴旋转（度→弧度）与相对代理的偏移（米），均集中在 constants.MAGICIAN_BOSS
        const rot = MAGICIAN_BOSS.MODEL_ROTATION;
        this._modelRoot.rotation.set(rot.x * D2R, rot.y * D2R, rot.z * D2R);
        const off = MAGICIAN_BOSS.MODEL_POSITION;
        const p0 = MAGICIAN_BOSS.POSITIONS[0];
        this._modelRoot.position.set(p0[0] + off.x, p0[1] + off.y, p0[2] + off.z);
        this.scene.add(this._modelRoot);
        if (gltf.animations && gltf.animations.length) {
          this._mixer = new THREE.AnimationMixer(this._modelRoot);
          const action = this._mixer.clipAction(gltf.animations[0]);
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.play();
        }
      })
      .catch((e) => console.warn('[MagicianBoss] 模型加载失败:', e));
  }

  update(dt) {
    if (this._disposed) return;
    if (this._mixer) this._mixer.update(dt);
    if (this._modelRoot && this._proxy && this._proxy.alive) {
      const off = MAGICIAN_BOSS.MODEL_POSITION;
      this._modelRoot.position.set(
        this._proxy.mesh.position.x + off.x,
        this._proxy.mesh.position.y + off.y,
        this._proxy.mesh.position.z + off.z
      );
    }
    // 分帧消费精英队列（错峰，防同帧多个重型 GLB 解码卡死主线程）
    if (this._summonQueue.length) this._drainSummonQueue();
    // Boss 头顶 3D 血条：跟随代理位置（头顶上方）+ 实时血量
    if (this._hpBar && this._proxy && this._proxy.alive) {
      this._hpBar.update(this._proxy.hp, this._proxy.maxHp);
      this._hpBar.setPosition(
        this._tmpV.copy(this._proxy.mesh.position).setY(this._proxy.mesh.position.y + MAGICIAN_BOSS.HP_BAR_OFFSET_Y)
      );
    }
    // 通关判定：代理死亡或被移除
    if (!this._proxy || !this._proxy.alive || !this.balloons.list.includes(this._proxy)) {
      this._win();
      return;
    }

    this.phaseTimer += dt;
    // 阶段召唤节拍：按时间点触发波次 + 分帧落地（第一阶段激光 / 第二阶段玻璃墙）
    this._summonTick();
    const P = MAGICIAN_BOSS.PHASE;
    if (this.phase === 'intro') {
      if (this.phaseTimer >= P.INTRO) this._enterPhase('laser');
    } else if (this.phase === 'laser') {
      if (this._laser) this._laser.update(dt);
      if (this.phaseTimer >= P.LASER) this._enterPhase('glass');
    } else if (this.phase === 'glass') {
      if (this._glass) this._glass.update(dt);
      if (this.phaseTimer >= P.GLASS) this._enterPhase('nine');
    } else if (this.phase === 'nine') {
      if (this._nine) this._nine.update(dt);
      if (this._ballWall) this._ballWall.update(dt);   // 第三阶段：黑白球墙（浮动 → 脱墙追击 → 4×8 自爆）
      if (this.phaseTimer >= P.NINE) this._enterPhase('laser'); // 循环 A→B→C
    }
  }

  _enterPhase(phase) {
    this._clearPhaseSystems();
    this.phase = phase;
    this.phaseTimer = 0;
    this._summoned = 0;                          // 新阶段重置召唤波计数
    const idx = phase === 'glass' ? 1 : phase === 'nine' ? 2 : 0;
    if (this._proxy && this._proxy.alive) this._proxy.mesh.position.set(...MAGICIAN_BOSS.POSITIONS[idx]);

    if (phase === 'laser') {
      // 第一阶段：激光机制保留，召唤改由 _summonTick 按时间点分 3 波（25 小怪冲锋 + 5 幽灵）
      if (this._modelRoot) this._modelRoot.rotation.y = 0;            // 回正前：复位朝向
      this._laser = new BossLaserGroup(this.scene, this.getPlayerPos, this.damagePlayer, MAGICIAN_BOSS.LASER_GROUP);
    } else if (phase === 'glass') {
      if (this._modelRoot) this._modelRoot.rotation.y = Math.PI / 2;  // 向左闪现：Y 正向 +90°（头朝玩家）
      this._glass = new BossGlassWall(
        this.scene, this._proxy.mesh.position, this.getPlayerPos(),
        (dmg) => { if (this._proxy && this._proxy.alive) this._proxy.takeDamage(dmg); }
      );
      this.waves.magicianGlassWall = this._glass; // 供 game.js 子弹钩子拦截
      // 第二阶段：玻璃墙机制保留，召唤改由 _summonTick 分 2 波（每波 10 盾兵）
    } else if (phase === 'nine') {
      // 第三阶段：原「九宫格」由「黑白球墙」替代（ORB_WALL.ENABLED=false 可回退）
      if (this._modelRoot) this._modelRoot.rotation.y = -Math.PI / 2; // 向右闪现：Y 反向 -90°（头朝玩家）
      if (MAGICIAN_BOSS.ORB_WALL.ENABLED) {
        this._ballWall = new BossBallWall(this.scene, this.balloons, this._proxy.mesh.position);
      } else {
        this._nine = new BossNineGrid(this.scene, this.balloons, this.getPlayerPos, this.damagePlayer, this._proxy.mesh.position);
      }
    }
  }

  _clearPhaseSystems() {
    if (this._laser) { this._laser.dispose(); this._laser = null; }
    if (this._glass) { this._glass.dispose(); this._glass = null; }
    if (this._nine) { this._nine.dispose(); this._nine = null; }
    if (this._ballWall) { this._ballWall.dispose(); this._ballWall = null; }   // 清掉未死的黑白球
    this.waves.magicianGlassWall = null;
  }

  // —— 阶段召唤节拍 ——
  // 第一/第二阶段内按「首次延迟 + 均分时间点」分波召唤，内容与数量见 MAGICIAN_BOSS.SUMMON。
  // 时间点 = FIRST_DELAY + 已召唤波数 × (阶段时长 / 波数)，故改 PHASE.LASER / PHASE.GLASS 会同步调整节奏。
  _summonTick() {
    if (!MAGICIAN_BOSS.SPAWN_ENEMIES) return;
    const S = MAGICIAN_BOSS.SUMMON;
    const times = this.phase === 'laser' ? S.LASER_TIMES
                : this.phase === 'glass' ? S.GLASS_TIMES : 0;
    if (!times) return;                                   // 第三阶段/开场不召唤
    if (this._summoned >= times) return;
    const dur = this.phase === 'laser' ? MAGICIAN_BOSS.PHASE.LASER : MAGICIAN_BOSS.PHASE.GLASS;
    const at = S.FIRST_DELAY + this._summoned * (dur / times);
    if (this.phaseTimer < at) return;
    this._summoned++;
    this._summonWave(at);
  }

  // 组装本波召唤怪：第一阶段=小怪冲锋 + 幽灵；第二阶段=盾兵
  //   at = 本波的时间点（阶段内秒数），用于反推「剩余时间 → 出生距离」
  _summonWave(at) {
    const S = MAGICIAN_BOSS.SUMMON;
    const dur = this.phase === 'laser' ? MAGICIAN_BOSS.PHASE.LASER : MAGICIAN_BOSS.PHASE.GLASS;
    const remainT = Math.max(S.MIN_REMAIN, dur - at);   // 本波召唤后到阶段结束的剩余时间
    if (this.phase === 'laser') {
      // 第一阶段：25 小怪冲锋 + 5 忍者（忍者由 _clampToRing 锁在 10~15m 环带内，不会靠近玩家）
      this._summonKind('basic', S.LASER_BASIC, S.LASER_BASIC_HP, S.LASER_BASIC_SPEED, remainT);
      this._summonKind('ninja', S.LASER_NINJA, S.LASER_NINJA_HP, S.LASER_NINJA_SPEED, remainT);
    } else if (this.phase === 'glass') {
      // 第二阶段：10 骑士（默认精英骑士 = 纯骑士无盾牌）
      this._summonKind(S.GLASS_KNIGHT_TYPE || 'eliteKnight', S.GLASS_KNIGHT, S.GLASS_KNIGHT_HP, S.GLASS_KNIGHT_SPEED, remainT);
    }
  }

  // 从场地中心(原点)沿 ang 方向走到「气球自爆边界」的距离（矩形，按射线与矩形求交）
  //   rad = 该怪的 effectiveRadius：game._checkExplosions 的判定是 |x|≤BOUND_X+rad、|z|≤BOUND_Z+rad，
  //   所以半径大的怪（幽灵 2.4m / 盾兵 0.9m）实际会提前触界，必须按同一半径折算否则会早到。
  _regionEdgeDist(ang, rad = 0) {
    const a = MOVE.BOUND_X + rad, b = MOVE.BOUND_Z + rad;
    const c = Math.abs(Math.cos(ang)), s = Math.abs(Math.sin(ang));
    const rx = c > 1e-6 ? a / c : Infinity;
    const rz = s > 1e-6 ? b / s : Infinity;
    return Math.min(rx, rz);
  }

  // 把 count 个同类怪推入分帧队列
  //   出生半径 = 「到 4×8 区域边界的距离」+「本波剩余时间内刚好能跑完的距离 ×(1±ARRIVE_JITTER)」
  //   → 每只怪都恰好在阶段结束时抵达活动区域（自爆点），既不贴脸也不会远到看不见。
  //   hp>0 → 覆盖血量；speed>0 → 覆盖移动速度（0=取敌种默认速度，距离仍按其真实速度计算）
  _summonKind(type, count, hp, speed, remainT) {
    if (!count || count <= 0) return;
    const S = MAGICIAN_BOSS.SUMMON;
    const t = ENEMY_TYPES[type];
    const typeSpeed = t ? t.speed : 0;
    const spd = speed > 0 ? speed : (typeSpeed > 0 ? typeSpeed : 1);  // 出生距离必须按「真实生效速度」算
    const rad = t ? (t.radius || 0) * (t.scale || 1) : 0;             // 实际自爆边界要加上 effectiveRadius
    const travel = spd * remainT * S.ARRIVE_FACTOR;                   // 剩余时间内能跑的距离
    const jit = S.ARRIVE_JITTER || 0;
    // 忍者：固有逻辑「不靠近玩家」——由 balloons._clampToRing 锁在距中心 SHURIKEN.RANGE_MIN~MAX 环带内，
    //   永不进入 4×8 自爆区，故不套用「按剩余时间反推」，直接出生在该环带内。
    const useRing = !!(S.NINJA_USE_RING && t && t.behavior === 'ninja');
    for (let k = 0; k < count; k++) {
      const ang = Math.random() * Math.PI * 2;
      let r;
      if (useRing) {
        r = SHURIKEN.RANGE_MIN + Math.random() * Math.max(0, SHURIKEN.RANGE_MAX - SHURIKEN.RANGE_MIN);
      } else {
        const jitter = 1 + (Math.random() * 2 - 1) * jit;             // 距离抖动 → 抵达时间错开
        r = this._regionEdgeDist(ang, rad) + travel * jitter;
        r = THREE.MathUtils.clamp(r, S.SPAWN_R_MIN, S.SPAWN_R_MAX);
      }
      this._summonQueue.push({
        type,
        pos: new THREE.Vector3(Math.cos(ang) * r, 1 + Math.random() * 2, Math.sin(ang) * r),
        hp: hp > 0 ? hp : 0,
        speed: spd,                                                    // 覆盖为计算距离时用的速度，保证准时抵达
      });
    }
  }

  // 每帧最多落地 PER_FRAME 个（错峰，把 GLB 解码/立绘抓帧摊到多帧，关键防卡死）；单个失败不影响其余
  _drainSummonQueue() {
    const MAX_PER_FRAME = MAGICIAN_BOSS.SUMMON.PER_FRAME || 3;
    let n = 0;
    while (this._summonQueue.length && n < MAX_PER_FRAME) {
      const item = this._summonQueue.shift();
      try {
        this.spawn(item.type, item.pos, {
          onSpawn: (b) => {
            if (item.hp > 0) { b.maxHp = item.hp; b.hp = item.hp; }
            if (item.speed > 0) b.speed = item.speed;
          },
        });
      } catch (e) {
        console.warn('[MagicianBoss] 召唤失败:', item.type, e);
      }
      n++;
    }
  }

  // —— 已移除外圈基础怪：Boss 战不应出现基础怪（用户实测反馈）——
  _win() {
    if (this._disposed) return;
    this.dispose();
    this.waves.cleared = true; // 标记通关（供 game 判定），但第18关走自定义横幅+10s退出，不进抽卡
    // VR 可见通关横幅：锚定玩家准星、10s 后自动退出游戏（DOM hud.message 在头显里不可见）
    if (this.scene && this.waves.camera) {
      const banner = new WinBanner3D(this.scene, this.waves.camera, WIN_BANNER_TEXT, () => {
        if (this.waves._winBanner) { this.waves._winBanner.dispose(); this.waves._winBanner = null; }
        if (this.waves.onWinExit) this.waves.onWinExit();
      });
      this.waves._winBanner = banner; // 交 waves/game 在切关或 10s 到期时清理
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._clearPhaseSystems();
    if (this._modelRoot) { this.scene.remove(this._modelRoot); this._modelRoot = null; }
    if (this._mixer) { try { this._mixer.stopAllAction(); } catch (e) { /* ignore */ } this._mixer = null; }
    if (this._hpBar) { this._hpBar.dispose(); this._hpBar = null; }
    this._summonQueue.length = 0;
    // 外圈小怪 / 精英由 balloons 统一管理，切关时整体清空；此处不单独移除
    this.waves.magicianGlassWall = null;
  }
}
