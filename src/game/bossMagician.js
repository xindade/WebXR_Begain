// 第18关 · 魔术师 Boss 控制器
// 阶段循环：开场演出 → 激光(10s, 正前30m) → 玻璃墙(10s, 闪现左边30m) → 黑白球墙(10s, 闪现右边30m) → A→B→C…
// 血量动态 = HP_BASE + 玩家DPS × HP_DPS_SEC；Boss 代理气球受击即扣血，血空触发通关。
//
// ★ 第三十八修（开场演出 + 召唤池）：
//   1. 开场：以「第15关开场魔术师」的体型/位置在玩家前方念白（music/魔术师Boss开头.wav），
//      语音播到 INTRO.CUE_AT 秒时 0.6s 飞回 Boss 位（POSITIONS[0]），到点瞬间放大约 2 倍 → 巨物感；
//      语音播完（game.js 的 ended 回调 → onOpeningVoiceEnd）即进入激光阶段，INTRO 兜底上限见 PHASE.INTRO。
//   2. 召唤：由「按时间点的波次」改为「场上维持池」（见 constants.MAGICIAN_BOSS.POOL）——
//      场上维持 POOL.MAX 只（其中 POOL.ELITE 只为当前阶段的精英怪），总数 < POOL.REFILL_AT 时一次补满；
//      出生点固定在距场地中心 POOL.SPAWN_R 米的环上，以敌种自身速度飘向玩家；
//      出现方式 = 从 Boss 身上飞出光点（waves._queueSpawn 的 opts.from）。
//      切阶段只更换「精英怪种类」，**不清场**：上一阶段召唤的怪留在场上直到被打掉。
//
// ★ 第三十九修（Boss 死亡收尾 / 加载预热）：
//   1. _win() 先清场再显示横幅 —— ① 撤掉在飞的光点（group='magicianSub'）② 移除场上全部召唤物。
//      旧实现只 dispose() 自己（模型/血条/机制），召唤物归 balloons 管、要等切关才清
//      ⇒ 现场实测 Boss 死后玩家还在通关横幅里挨 20 只小兵的打。
//   2. 横幅时长改配置项 MAGICIAN_BOSS.WIN_BANNER_SECONDS（0 = 不显示横幅，直接结束本局）。
//   3. 真正的「结束本局 / 关浏览器」不在这里 —— 见 game.js 的 _onFinalBossClear/_finishRound。
//
// 复用 glbCache 加载「魔术师动画版」GLB 并循环播放内嵌动画（常驻，不自动消失）；
// 视觉模型与命中代理解耦：代理气球(balloons.list) 只做命中靶子，模型独立动画 + 每帧同步位置。
import * as THREE from 'three';
import { MAGICIAN_BOSS } from '../core/constants.js';
import { loadGLB, cloneGLBScene } from './glbCache.js';
import { BossLaserGroup } from './bossLaserGroup.js';
import { BossGlassWall } from './bossGlassWall.js';
import { BossNineGrid } from './bossNineGrid.js';
import { BossBallWall } from './bossBallWall.js';   // 第三阶段「黑白球墙」（替代九宫格，ORB_WALL.ENABLED=false 可回退）
import { BossHealthBar3D } from './bossHealthBar.js'; // Boss 头顶 3D 血条（sprite 自动面向相机）
import { WinBanner3D } from './winBanner.js';        // Boss 死亡后 VR 横幅（锚定准星、10s 后自动退出，见 winBanner.js）

const D2R = Math.PI / 180; // 度→弧度（MODEL_ROTATION 用度标注）
const WIN_BANNER_TEXT = '邪恶魔术师终于死了\n你成功拯救了公主'; // Boss 死亡 3D 横幅文案（双行）

/**
 * 开场演出时间轴（纯函数，供单测/调参）：t = 开场阶段内已过秒数。
 *   t < CUE_AT          → 停在念白位（INTRO.POS），未变大
 *   CUE_AT ~ CUE_AT+FLY → 沿 smoothstep 从念白位飞到 POSITIONS[0]
 *   飞完（k>=1）        → big=true（调用方据此把模型瞬间放大）
 * @param {object} cfg constants.MAGICIAN_BOSS
 * @param {number} t 秒
 * @return {{pos:number[], big:boolean}}
 */
export function introPose(cfg, t) {
  const I = cfg.INTRO;
  const src = I.POS;
  const dst = cfg.POSITIONS[0];
  if (t < I.CUE_AT) return { pos: [src[0], src[1], src[2]], big: false };
  const k = Math.min(1, (t - I.CUE_AT) / Math.max(0.01, I.FLY_TIME));
  const e = k * k * (3 - 2 * k);   // smoothstep：起飞柔和、到位不顿
  return {
    pos: [
      src[0] + (dst[0] - src[0]) * e,
      src[1] + (dst[1] - src[1]) * e,
      src[2] + (dst[2] - src[2]) * e,
    ],
    big: k >= 1 - 1e-6,   // 容差：t 由帧累加，末端可能差 1e-16 没到 1
  };
}

/**
 * 召唤池补充计划（纯函数）：场上（含已发出光点、尚未落地）总数 < POOL.REFILL_AT 时，
 * 一次补到 POOL.MAX；其中精英怪补到 POOL.ELITE 只，其余用基础怪。
 * @param {object} cfg constants.MAGICIAN_BOSS
 * @param {{alive:number, elites:number, pending:number, pendingElite:number, queued:number, queuedElite:number}} s
 * @return {{elites:number, basics:number}|null} null = 还不到补充阈值
 */
export function planRefill(cfg, s) {
  const P = cfg.POOL;
  const total = (s.alive || 0) + (s.pending || 0) + (s.queued || 0);
  if (total >= P.REFILL_AT) return null;
  const need = Math.max(0, P.MAX - total);
  if (need <= 0) return null;
  const eliteHave = (s.elites || 0) + (s.pendingElite || 0) + (s.queuedElite || 0);
  const elites = Math.max(0, Math.min(P.ELITE - eliteHave, need));
  return { elites, basics: need - elites };
}

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
    this._sizeY = 1;                             // GLB 原生高度（模型缩放基准）
    this._mixer = null;
    this._laser = null;
    this._glass = null;
    this._nine = null;
    this._ballWall = null;                       // 第三阶段「黑白球墙」控制器
    this._disposed = false;
    this._big = false;                           // 开场「瞬间变大」是否已触发
    this._hpBar = null;                          // Boss 头顶 3D 血条（代理落地后创建）
    this._hpBarOffsetY = MAGICIAN_BOSS.HP_BAR_OFFSET_Y; // 血条抬高（随体型放大同步，见 _grow）
    this._tmpV = new THREE.Vector3();            // 血条定位临时量
    // —— 召唤池（第三十八修）——
    this._minions = [];          // 场上召唤物（含精英；切阶段不清场）
    this._refillQueue = [];      // 待落地队列 [{elite}]（错峰消费）
    this._pendingRefill = 0;     // 已发出光点、尚未落地的召唤物数
    this._pendingElite = 0;      // 其中精英怪数
    this._refillCd = 0;          // 两次补充之间的冷却（秒）

    this._spawnProxy();
    this._loadModel();
  }

  // 命中代理：开场先落在「念白位」（第15关开场魔术师的位置/体型），由 update 的开场时间轴接管移动
  _spawnProxy() {
    const I = MAGICIAN_BOSS.INTRO;
    const pos = new THREE.Vector3(I.POS[0], I.POS[1], I.POS[2]);
    // 第五十一修：代理类型从 'basic' 换成专用 'bossProxy'（无模型/不在立绘白名单）
    //   —— 借 'basic' 时异步挂上的基础怪立绘会把 hitRadius 改写成薄板，Boss 因此打不中。
    this.spawn('bossProxy', pos, {
      effect: false,                            // Boss 代理不走光点，直接落地
      onSpawn: (b) => {
        const hp = MAGICIAN_BOSS.HP_BASE + (this.getPlayerDPS ? this.getPlayerDPS() : 0) * MAGICIAN_BOSS.HP_DPS_SEC;
        b.maxHp = hp; b.hp = hp;
        b.isBoss = true;
        b.controlled = true;     // 由本控制器逐帧接管位置
        b.damageReduction = 0;   // 直接命中即全额扣血
        b.score = 2000;
        b.mesh.scale.setScalar(1);
        b.mesh.visible = false; // 隐藏整个代理子树（最外层球 + 占位胶囊/眼睛/名牌子网格），避免 Boss 脚下出现"可见基础小怪"
        this._proxy = b;
        this._applyRadius(this._radiusForHeight(I.SCALE_HEIGHT)); // 命中半径随体型同步（开场小 → 变大后大）
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
        this._sizeY = size.y > 0 ? size.y : 1;
        this._setModelHeight(MAGICIAN_BOSS.INTRO.SCALE_HEIGHT);   // 开场体型 = 第15关开场魔术师
        // 三轴旋转（度→弧度）与相对代理的偏移（米），均集中在 constants.MAGICIAN_BOSS
        const rot = MAGICIAN_BOSS.MODEL_ROTATION;
        this._modelRoot.rotation.set(rot.x * D2R, rot.y * D2R, rot.z * D2R);
        const off = MAGICIAN_BOSS.MODEL_POSITION;
        const p0 = MAGICIAN_BOSS.INTRO.POS;
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

  // ===== 体型 / 命中半径换算 =====
  // 常规体型 = SCALE(基准2m) × MODEL_SCALE(5) = 10m；开场体型与放大后体型都由「目标身高(米)」直接换算，
  // 命中半径与血条高度按同一比例缩放 → 瞄准躯干的手感不随体型变化。
  _normalHeight() { return MAGICIAN_BOSS.SCALE * MAGICIAN_BOSS.MODEL_SCALE; }
  _bigHeight() { return this._normalHeight() * MAGICIAN_BOSS.INTRO.BIG_MULT; }
  _setModelHeight(h) { if (this._modelRoot) this._modelRoot.scale.setScalar(h / this._sizeY); }
  _radiusForHeight(h) { return MAGICIAN_BOSS.PROXY_RADIUS * (h / this._normalHeight()); }
  _applyRadius(r) {
    const b = this._proxy;
    if (!b) return;
    b.radius = r; b.effectiveRadius = r; b.hitRadius = r;
  }
  // 瞬间变大：模型身高 ×BIG_MULT，命中半径与血条高度同步
  _grow() {
    if (this._big) return;
    this._big = true;
    const h = this._bigHeight();
    this._setModelHeight(h);
    this._applyRadius(this._radiusForHeight(h));
    this._hpBarOffsetY = MAGICIAN_BOSS.HP_BAR_OFFSET_Y * (h / this._normalHeight());
  }

  update(dt) {
    if (this._disposed) return;
    if (this._mixer) this._mixer.update(dt);

    this.phaseTimer += dt;
    if (this.phase === 'intro') {
      this._updateIntro();
    } else {
      this._updateSummonPool(dt);          // 召唤池维护（开场念白期间不召唤）
      const P = MAGICIAN_BOSS.PHASE;
      if (this.phase === 'laser') {
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

    // 代理位置 → 视觉模型（放在阶段推进之后：闪现/飞行同帧跟随，不慢一帧）
    if (this._modelRoot && this._proxy && this._proxy.alive) {
      const off = MAGICIAN_BOSS.MODEL_POSITION;
      this._modelRoot.position.set(
        this._proxy.mesh.position.x + off.x,
        this._proxy.mesh.position.y + off.y,
        this._proxy.mesh.position.z + off.z
      );
    }
    // 分帧消费补充队列（错峰，防同帧多个重型 GLB 解码卡死主线程）
    if (this._refillQueue.length) this._drainRefillQueue();
    // Boss 头顶 3D 血条：跟随代理位置（头顶上方）+ 实时血量
    if (this._hpBar && this._proxy && this._proxy.alive) {
      this._hpBar.update(this._proxy.hp, this._proxy.maxHp);
      this._hpBar.setPosition(
        this._tmpV.copy(this._proxy.mesh.position).setY(this._proxy.mesh.position.y + this._hpBarOffsetY)
      );
    }
    // 通关判定：代理死亡或被移除
    if (!this._proxy || !this._proxy.alive || !this.balloons.list.includes(this._proxy)) {
      this._win();
      return;
    }
  }

  // ===== 开场演出 =====
  // 念白（原地）→ 0.6s 飞回 Boss 位 → 瞬间变大。位置逐帧由纯函数 introPose 给出，
  // 无状态机、无累积误差；放大用 _big 一次性触发。
  _updateIntro() {
    const s = introPose(MAGICIAN_BOSS, this.phaseTimer);
    if (this._proxy && this._proxy.alive) this._proxy.mesh.position.set(s.pos[0], s.pos[1], s.pos[2]);
    if (s.big) this._grow();
    if (this.phaseTimer >= MAGICIAN_BOSS.PHASE.INTRO) this._finishIntro(); // 兜底：语音没播/加载失败
  }

  // 开场结束（语音播完 / 兜底超时共用）：确保已到 Boss 位并变大，然后进激光阶段
  _finishIntro() {
    if (this.phase !== 'intro') return;
    const d = MAGICIAN_BOSS.POSITIONS[0];
    if (this._proxy && this._proxy.alive) this._proxy.mesh.position.set(d[0], d[1], d[2]);
    this._grow();
    this._enterPhase('laser');
  }

  /** 开场语音播完（game.js 的 ended 回调）：立刻结束开场演出，进激光阶段 */
  onOpeningVoiceEnd() { this._finishIntro(); }

  _enterPhase(phase) {
    this._clearPhaseSystems();
    this.phase = phase;
    this.phaseTimer = 0;
    this._refillCd = 0;                          // 新阶段立刻允许补充（补的精英怪种类随阶段变化）
    if (phase !== 'intro') this._grow();         // 兜底：万一没走完开场演出，也保证是「大 Boss」体型
    const idx = phase === 'glass' ? 1 : phase === 'nine' ? 2 : 0;
    if (this._proxy && this._proxy.alive) this._proxy.mesh.position.set(...MAGICIAN_BOSS.POSITIONS[idx]);

    if (phase === 'laser') {
      // 第一阶段：激光机制保留（召唤统一由 _updateSummonPool 维护，精英怪 = 盾兵怪）
      // 第六十三修：进激光阶段就弹预警横幅（走 game._showBanner → 通用一次性横幅，默认 4s）。
      //   为什么挂在这里：这是「每次进激光」的唯一真值点（含 laser→glass→nine→laser 循环回来那次），
      //   不需要在 game.update 里另做边沿检测；banner 回调由 game._loadLevel 注入 waves.hooks。
      const warn = MAGICIAN_BOSS.LASER_WARN;
      if (warn && warn.ENABLED !== false && warn.TEXT) this.waves?.hooks?.banner?.(warn.TEXT);
      if (this._modelRoot) this._modelRoot.rotation.y = 0;            // 回正前：复位朝向
      this._laser = new BossLaserGroup(this.scene, this.getPlayerPos, this.damagePlayer, MAGICIAN_BOSS.LASER_GROUP);
    } else if (phase === 'glass') {
      if (this._modelRoot) this._modelRoot.rotation.y = Math.PI / 2;  // 向左闪现：Y 正向 +90°（头朝玩家）
      this._glass = new BossGlassWall(
        this.scene, this._proxy.mesh.position, this.getPlayerPos(),
        (dmg) => { if (this._proxy && this._proxy.alive) this._proxy.takeDamage(dmg); }
      );
      this.waves.magicianGlassWall = this._glass; // 供 game.js 子弹钩子拦截
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

  // ===== 召唤池（第三十八修）=====
  // 每帧：① 清掉已死的召唤物 ② 消费补充队列（每帧最多 PER_FRAME 只）③ 总数 < REFILL_AT 时补满到 MAX。
  // 「场上」含「已发出光点但还没落地」的部分，避免光点在飞时被重复补满。
  _updateSummonPool(dt) {
    if (!MAGICIAN_BOSS.SPAWN_ENEMIES) return;
    const P = MAGICIAN_BOSS.POOL;
    // ① 清掉已死亡/已被移除的
    if (this._minions.length) {
      this._minions = this._minions.filter((b) => b.alive && this.balloons.list.includes(b));
    }
    // ② 补充冷却（两次补充之间留出间隔，避免旧波刚清完就连着刷）
    if (this._refillCd > 0) this._refillCd = Math.max(0, this._refillCd - dt);
    if (this._refillQueue.length || this._refillCd > 0) return;
    // ③ 触发补充
    let elites = 0;
    for (const b of this._minions) if (b._bossElite && b.alive) elites++;
    const plan = planRefill(MAGICIAN_BOSS, {
      alive: this._minions.length,
      elites,
      pending: this._pendingRefill,
      pendingElite: this._pendingElite,
      queued: 0,
      queuedElite: 0,
    });
    if (!plan) return;
    for (let i = 0; i < plan.elites; i++) this._refillQueue.push({ elite: true });
    for (let i = 0; i < plan.basics; i++) this._refillQueue.push({ elite: false });
    this._refillCd = P.REFILL_COOLDOWN;
    console.log(`[MagicianBoss] 补充召唤：精英 ${plan.elites} + 基础 ${plan.basics}（阶段 ${this.phase}）`);
  }

  // 每帧最多落地 PER_FRAME 只（错峰，把 GLB 解码/立绘抓帧摊到多帧，关键防卡死）；单个失败不影响其余
  _drainRefillQueue() {
    const MAX_PER_FRAME = MAGICIAN_BOSS.POOL.PER_FRAME || 3;
    let n = 0;
    while (this._refillQueue.length && n < MAX_PER_FRAME) {
      const item = this._refillQueue.shift();
      try {
        this._spawnMinion(!!item.elite);
      } catch (e) {
        console.warn('[MagicianBoss] 召唤失败:', e);
      }
      n++;
    }
  }

  // 召唤一只：精英 = 当前阶段对应的精英怪种（POOL.ELITE_BY_PHASE），普通 = POOL.BASIC_TYPE。
  // 出生点 = 距场地中心 POOL.SPAWN_R 米的随机环位；以敌种自身速度（不覆盖 speed）飘向玩家；
  // 出现方式 = 从 Boss 身上飞出光点（waves._queueSpawn 的 opts.from）。
  _spawnMinion(elite) {
    const P = MAGICIAN_BOSS.POOL;
    const type = elite ? (P.ELITE_BY_PHASE[this.phase] || P.BASIC_TYPE) : P.BASIC_TYPE;
    const ang = Math.random() * Math.PI * 2;
    const pos = new THREE.Vector3(
      Math.cos(ang) * P.SPAWN_R,
      P.SPAWN_Y_MIN + Math.random() * Math.max(0, P.SPAWN_Y_MAX - P.SPAWN_Y_MIN),
      Math.sin(ang) * P.SPAWN_R
    );
    const opts = {
      group: 'magicianSub',    // ★ 第三十九修：分组 → 通关/清场时 _cancelPendingGroup 可撤掉在飞光点
      // 第五十一修：忍者/幽灵/章鱼在 Boss 关的血量 = 默认血量 + 玩家 DPS × 10（见 content/eliteMonsters.js）
      //   ⚠ 守卫必须是 rangedHpOpts —— 曾误写成 this.waves.rangedHp（恒为 undefined）⇒ 口径静默失效、
      //     Boss 召唤的远程精英退回敌种原生血量。waves.rangedHpOpts 缺失时（老存档/桩对象）保持 null。
      balloon: this.waves.rangedHpOpts ? this.waves.rangedHpOpts(type) : null,
      onSpawn: (b) => {
        this._pendingRefill = Math.max(0, this._pendingRefill - 1);
        if (elite) this._pendingElite = Math.max(0, this._pendingElite - 1);
        b._bossElite = !!elite;
        if (elite) b.isElite = true;   // 语义标记（外观不变，用于统计/后续扩展）
        this._minions.push(b);
      },
    };
    if (P.BEAM_ENABLED !== false) opts.from = this._beamOrigin();   // 光点从 Boss 身上飞出
    this._pendingRefill++;
    if (elite) this._pendingElite++;
    this.spawn(type, pos, opts);
  }

  // 光点出发点 = Boss 代理位置 + POOL.BEAM_Y（约胸口高度）
  _beamOrigin() {
    const P = MAGICIAN_BOSS.POOL;
    const p = (this._proxy && this._proxy.alive) ? this._proxy.mesh.position : null;
    const base = p || {
      x: MAGICIAN_BOSS.POSITIONS[0][0],
      y: MAGICIAN_BOSS.POSITIONS[0][1],
      z: MAGICIAN_BOSS.POSITIONS[0][2],
    };
    return new THREE.Vector3(base.x, base.y + P.BEAM_Y, base.z);
  }

  _win() {
    if (this._disposed) return;
    this._clearMinions();      // ★ 第三十九修：先清场再收尾（否则小兵在通关横幅期间继续打玩家）
    this.dispose();
    this.waves.cleared = true; // 标记通关（供 game 判定），但第18关走自定义横幅 + 结束本局，不进抽卡
    // 第三十九修：显式标记「第18关已清」—— WIN_BANNER_SECONDS=0 时不建横幅，
    // 只靠 _winBanner 非空来挡抽卡会漏（同一帧就会去开毕业汇总界面）。见 game.js 的抽卡入口判据。
    this.waves.magicianCleared = true;
    // VR 可见通关横幅：锚定玩家准星；到期（WIN_BANNER_SECONDS）即调 onWinExit → game 结束本局。
    // ★ 时长 0（或没有场景/相机）= 不建横幅，直接结束本局。
    const secs = MAGICIAN_BOSS.WIN_BANNER_SECONDS;
    if (this.scene && this.waves.camera && secs > 0) {
      const banner = new WinBanner3D(this.scene, this.waves.camera, WIN_BANNER_TEXT, () => {
        if (this.waves._winBanner) { this.waves._winBanner.dispose(); this.waves._winBanner = null; }
        if (this.waves.onWinExit) this.waves.onWinExit();
      }, secs);
      this.waves._winBanner = banner; // 交 waves/game 在切关或到期时清理
    } else if (this.waves.onWinExit) {
      this.waves.onWinExit();
    }
  }

  /**
   * ★ 第三十九修：把召唤物与「在飞的光点」一次清干净（Boss 死亡 / 通关收尾专用）。
   *
   * 为什么必须清：召唤物由 waves.balloons 统一管理，旧实现要等**切关**才整体清空 —— 而 Boss 死后
   * 走的是「横幅 → 结束本局」，中间不切关，于是那 20 只（含 3 只精英）会继续飘向玩家、继续造成
   * 伤害。现场表现即「Boss 死了小兵还在」。
   */
  _clearMinions() {
    this.waves._cancelPendingGroup?.('magicianSub');   // 撤掉还没落地的光点（否则收尾后还会冒怪）
    for (const b of this._minions) {
      if (b && b.alive && this.balloons.list.includes(b)) this.balloons.remove(b);
    }
    this._minions = [];
    this._refillQueue.length = 0;
    this._pendingRefill = 0;
    this._pendingElite = 0;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._clearPhaseSystems();
    if (this._modelRoot) { this.scene.remove(this._modelRoot); this._modelRoot = null; }
    if (this._mixer) { try { this._mixer.stopAllAction(); } catch (e) { /* ignore */ } this._mixer = null; }
    if (this._hpBar) { this._hpBar.dispose(); this._hpBar = null; }
    this._refillQueue.length = 0;
    this._minions = [];
    this._pendingRefill = 0;
    this._pendingElite = 0;
    // 场上召唤物由 balloons 统一管理，切关时整体清空；此处不单独移除
    this.waves.magicianGlassWall = null;
  }
}