import * as THREE from 'three';
import { WAVE, NORMAL_TEST, DDA, FACE_BOSS, PORTAL_BEAM, SPAWN_RING } from '../core/constants.js';
import { ENEMY_TYPES } from '../content/enemies.js';
import { ELITE_SCHEDULE, ELITE_WINDOW, ELITE_BASE_HP } from '../content/eliteMonsters.js';
import { isBoss } from '../content/levels.js';
import { LEVEL_ENEMY } from '../content/spawnPlans.js';
import { swapBalloonModel, loadBalloonModel, preCaptureDepthSprite } from './balloonModels.js';
import { MagicianBoss } from './bossMagician.js';

// ===== 召唤怪小兵参数（手动微调入口，改这里即可）=====
const SUMMON_MINION_DISTANCE = 1.5; // 小兵出生在召唤者「身后」的距离(m)：调大 → 离本体更远
const SUMMON_MINION_SPREAD   = 3.0; // 小兵出生点相对身后的左右/前后随机偏移(m)：调大 → 散布更开
const SUMMON_RESPAWN_DELAY   = 1.5; // 小兵死亡后延迟重生间隔(s)：调大 → 补怪更慢

// 出怪光点：最近传送门计算用临时量（_nearestPortal 内循环即消费，勿存引用）
const _portalTmp = new THREE.Vector3();

// 波次管理：分阶段生成（前→左右→全向），清空后触发抽卡
export class WaveManager {
  constructor(scene, balloons, getPlayerPos, dda, getPortals, getPlayerDPS = null, getSkillCd = null, damagePlayer = null, camera = null, onWinExit = null) {
    this.scene = scene;
    this.balloons = balloons;
    this.getPlayerPos = getPlayerPos;
    this.dda = dda || null;   // 动态难度控制器（DDA）；null 时 normalTest 走原时间曲线
    this.getPortals = getPortals || null; // () => game._portals；null 视为无门 → 直接 spawn
    this.getPlayerDPS = getPlayerDPS;             // () => number  玩家当前 DPS（game 注入）
    this.getSkillCd = getSkillCd || (() => 0);    // () => number  技能剩余冷却（>3=最近5秒放过技能）
    this.damagePlayer = damagePlayer || (() => {}); // (dmg) => void  供 Boss 子系统伤害玩家（game.js 注入）
    this.camera = camera;                         // THREE.Camera  玩家相机（通关横幅锚定准星位置）
    this.onWinExit = onWinExit || null;           // () => void  通关横幅 10s 后自动退出（game.js 注入 → toMenu）
    this.audio = null;                            // AudioManager 由 game.setSystems 注入（脸谱Boss 召唤语音）
    // —— 精英波（叠加于普通出怪之上，来自 ELITE_SCHEDULE）——
    this._eliteElapsed = 0;          // 精英波独立计时（秒），与 mode 的 elapsed 解耦
    this._elitePlan = null;          // 本关排程（ELITE_SCHEDULE[n] 或 null）
    this._eliteFired = null;         // {early,mid,late} 各期是否已触发
    // —— 新调度（DPS 内外圈）状态 ——
    this.levelScale = SPAWN_RING.LEVEL_BASE; // 关卡常数
    this.baseSpawn = 0;          // 基础出怪量
    this.innerQuota = 0;         // 内圈目标配额
    this.outerQuota = 0;         // 外圈目标配额（每 5s 由内圈系数调整）
    this.ringTimer = 0;          // 距上次内圈检查的累计秒
    this._lastCheckInner = 0;    // 上次检查时内圈存活数（调试用）
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
    this.mode = 'level';       // 'level' = 原配额滴流；'normalTest' = 升级式同屏测试
    this.spawnTimer = 0;       // 测试模式：两次生成最小间隔计时
    // 脸谱 Boss 状态（单 Boss 多阶段循环）
    this.faceBoss = null;           // 单 Boss 气球
    // 魔术师 Boss 状态（第18关）
    this._magicianBoss = null;          // MagicianBoss 控制器实例
    this.magicianGlassWall = null;       // 当前玻璃墙（供 game.js 子弹钩子拦截；非玻璃阶段为 null）
    this._winBanner = null;              // 第18关 Boss 死亡后的 VR 通关横幅（切关时清理，见 startLevel）
    this.facePhase = 0;             // 0=蓝, 1=红, 2=黑
    this.facePhaseTimer = 0;
    this.faceSubEntities = [];      // 当前阶段子实体（小怪/旗子/分身混合）
    this.faceFlags = [];            // 红阶段旗子引用
    this.faceOrbitAngle = 0;
    this.faceLaunchTimer = 0;
    this._blueSpawnedCount = 0;
    this._redSpawned = false;
    this._redPlaced = false;      // 红阶段旗子是否已移到 Boss 两侧（公转结束标记）
    this._redMerged = false;      // 红阶段是否已融合成一面大旗
    this._flagKeeper = null;      // 融合后保留的那面大旗
    this._cloneSpawnedCount = 0;
    this._pendingSpawns = [];   // 出怪光点队列 [{type,pos,from,dur,t,mesh,onSpawn,check,summonOwner,group,ring}]
    this._bossQueued = false;   // Boss 已在排队（防重复排队刷光点）
    this.ringTimer = 0;          // DPS 内外圈调度：检查计时
    this.baseSpawn = 0;          // 基础出怪量
    this.innerQuota = 0;         // 内圈目标配额
    this.outerQuota = 0;         // 外圈目标配额
  }

  // 本关剩余敌人数 = 尚未生成 + 场上存活 + 飞行中的光点（待落地怪）
  get remaining() {
    if (!this.level) return 0;
    return (this.total - this.spawned) + this._active;
  }

  // 场上存活 + 光点飞行中的待落地怪（所有占用判定用它，防光点未落地就连续补怪）
  get _active() { return this.balloons.count + this._pendingSpawns.length; }

  startLevel(level) {
    if (this._winBanner) { this._winBanner.dispose(); this._winBanner = null; } // 切关清理上关的 VR 通关横幅
    this.clearPending();       // 清残留光点 + _bossQueued（幂等）
    this.level = level;
    this.elapsed = 0;
    this.timer = 0;
    this.spawned = 0;
    this.cleared = false;
    this.bossSpawned = false;
    this.boss = null;
    this.spawnTimer = 0;
    // 精英波初始化：Boss/激光关无排程（ELITE_SCHEDULE 不含这些关 → null），普通/危机关按表载入
    this._eliteElapsed = 0;
    this._elitePlan = ELITE_SCHEDULE[level.n] || null;
    this._eliteFired = this._elitePlan ? { early: false, mid: false, late: false } : null;
    // 重置脸谱 Boss 状态（防止上一关残留引用）
    this.faceBoss = null;
    this.facePhase = 0;
    this.facePhaseTimer = 0;
    this.faceSubEntities = [];
    this.faceFlags = [];
    this.faceOrbitAngle = 0;
    this.faceLaunchTimer = 0;
    this._blueSpawnedCount = 0;
    this._redSpawned = false;
    this._redPlaced = false;
    this._redMerged = false;
    this._flagKeeper = null;
    this._cloneSpawnedCount = 0;

    // Boss 关（非龙）：直接走 _spawnBoss 流程，不走 NORMAL_TEST
    // （龙 Boss 由 game._loadLevel 独立创建 DragonBoss 实例，不会走到 waves）
    if (isBoss(level)) {
      this.mode = 'level';
      return;
    }

    // 正常测试模式：升级式同屏出怪，覆盖普通关原滴流逻辑（激光/Boss 关不走这里）
    if (NORMAL_TEST.enabled) {
      this.mode = 'normalTest';
      this.dda?.reset?.();   // 每关重置难度与击杀窗口，避免上一局残留拉高击杀率
      this._initDpsSpawn(level);   // 新调度：按 DPS + 关卡常数初始化内外圈配额
      return;
    }
    this.mode = 'level';

    // 需求①：每关单一敌人，从 LEVEL_ENEMY 取本关类型与总数；缺省兜底为基础怪
    const cfg = LEVEL_ENEMY[level.n];
    if (cfg) {
      this.singleType = cfg.type;
      this.total = cfg.count;
    } else {
      this.singleType = 'basic';
      this.total = WAVE.BASE_SPAWN_COUNT + level.n * 5;
    }
  }

  _phase() {
    // 第1关强制正前方出怪（新手引导）
    if (this.level?.n === 1) return 1;
    if (this.elapsed >= WAVE.PHASE3_AT) return 3;
    if (this.elapsed >= WAVE.PHASE2_AT) return 2;
    return 1;
  }

  _spawnPos(spawnRadius = 0.5, opts = null) {
    const GAP = 0.2;
    const MAX_ATTEMPTS = 10;
    let pos, attempts = 0;
    // 测试/DDA 模式可传入 dist/spread/phase 覆盖默认值
    const spawnDist = opts?.dist ?? (this.mode === 'normalTest' ? NORMAL_TEST.distance : WAVE.SPAWN_DISTANCE);
    const spawnSpread = opts?.spread ?? (this.mode === 'normalTest' ? NORMAL_TEST.spread : WAVE.SPAWN_SPREAD);
    const phaseOverride = opts?.phase;
    const centerDeg = opts?.centerDeg;   // 新增：方向中心角(度)；提供时按 (centerDeg ± arcDeg/2) 取角（精英波定向出生用）
    const arcDeg = opts?.arcDeg ?? 70;
    do {
      let a;
      if (centerDeg != null) {
        a = (centerDeg + (Math.random() - 0.5) * arcDeg) * Math.PI / 180;
      } else {
        const phase = phaseOverride ?? this._phase();
        if (phase === 1) a = (-40 + Math.random() * 80) * Math.PI / 180;
        else if (phase === 2) a = (-110 + Math.random() * 220) * Math.PI / 180;
        else a = Math.random() * Math.PI * 2;
      }
      // 前方为 -Z
      const dir = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
      pos = new THREE.Vector3(0, 0, 0).addScaledVector(dir, spawnDist);
      pos.x += (Math.random() - 0.5) * spawnSpread;
      pos.y = 1 + Math.random() * 2.5;
      attempts++;
    } while (attempts < MAX_ATTEMPTS && this._isSpawnTooClose(pos, spawnRadius, GAP));
    return pos;
  }

  _isSpawnTooClose(pos, spawnRadius, gap) {
    for (const b of this.balloons.list) {
      const dx = pos.x - b.mesh.position.x;
      const dz = pos.z - b.mesh.position.z;
      const minDist = spawnRadius + b.radius + gap;
      if (dx * dx + dz * dz < minDist * minDist) return true;
    }
    return false;
  }

  // 出怪类型由 LEVEL_ENEMY 单一指定，不再随机挑选

  // ===== 出怪光点（传送门 → 出生点，「怪物从传送门飞出」）=====

  // 统一出怪入口：有门 → 光点入队；无门/开关关 → 同步直接 spawn（保持原行为，onSpawn 也同步执行）
  _queueSpawn(type, pos, opts = {}) {
    // 类型开关关 → 直接 spawn
    if (opts.effect === false) return this._commitSpawn({ type, pos, onSpawn: opts.onSpawn });
    // 无门 / 总开关关 → 直接 spawn（Boss/激光关自动兜底）
    const portals = this.getPortals ? this.getPortals() : null;
    if (!PORTAL_BEAM.ENABLED || !portals || !portals.length) {
      return this._commitSpawn({ type, pos, onSpawn: opts.onSpawn });
    }
    // 最近传送门稳定中心
    const nearest = this._nearestPortal(portals, pos);
    if (!nearest) return this._commitSpawn({ type, pos, onSpawn: opts.onSpawn });
    const from = nearest.getWorldPos(new THREE.Vector3());
    // 出发点相对门中心上抬 START_Y_OFFSET 米（让光点从门上方飞出，视觉更明显）
    from.y += PORTAL_BEAM.START_Y_OFFSET || 0;
    // 门升太高 → 起点 y 向目标收敛，保持水平进场（避免纵向跳水）
    const dy = from.y - pos.y;
    if (Math.abs(dy) > PORTAL_BEAM.Y_GAP_MAX) from.y = pos.y + Math.sign(dy) * PORTAL_BEAM.Y_GAP_MAX;
    // 飞行时长 = 距离 / SPEED，clamp
    const dur = THREE.MathUtils.clamp(
      from.distanceTo(pos) / PORTAL_BEAM.SPEED,
      PORTAL_BEAM.DUR_MIN, PORTAL_BEAM.DUR_MAX
    );
    const mesh = this._makeBeamMesh();
    mesh.position.copy(from);
    this.scene.add(mesh);
    this._pendingSpawns.push({
      type, pos: pos.clone(), from: from.clone(), dur, t: dur, mesh,
      onSpawn: opts.onSpawn || null,
      check: opts.check || null,
      summonOwner: opts.summonOwner || null,
      group: opts.group || null,
      ring: opts.ring || null,   // 'inner' | 'outer'：供 _pendingInRing 统计
    });
    return null;   // 已入队，无 balloon 引用
  }

  // 最近传送门（世界中心稳定值），返回 Portal 实例
  _nearestPortal(portals, pos) {
    let best = null, bestD = Infinity;
    for (const p of portals) {
      p.getWorldPos(_portalTmp);
      const d = _portalTmp.distanceToSquared(pos);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  // 光点 mesh：小球 + AdditiveBlending 发光
  _makeBeamMesh() {
    const geo = new THREE.SphereGeometry(PORTAL_BEAM.SIZE, 10, 8);
    const mat = new THREE.MeshBasicMaterial({
      color: PORTAL_BEAM.COLOR,
      transparent: true,
      opacity: PORTAL_BEAM.OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    return new THREE.Mesh(geo, mat);
  }

  // 落地/兜底：check 通过才真正 spawn；无论走哪条路径都执行 onSpawn（Boss 配置等依赖它）
  _commitSpawn(item) {
    if (item.check && !item.check()) {
      if (item.mesh) this._removeBeam(item.mesh);
      return null;
    }
    if (item.mesh) this._removeBeam(item.mesh);
    const b = this.balloons.spawn(item.type, item.pos);
    if (item.onSpawn) item.onSpawn(b);
    return b;
  }

  _removeBeam(mesh) {
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }

  // 每帧推进光点（放 update() 最顶部，任何模式都执行）
  _updatePendingSpawns(dt) {
    for (let i = this._pendingSpawns.length - 1; i >= 0; i--) {
      const it = this._pendingSpawns[i];
      it.t -= dt;
      if (it.t <= 0) {
        // 落地前补最后一帧位置（贴出生点消失，无跳变感）
        it.mesh.position.copy(it.pos);
        this._commitSpawn(it);
        this._pendingSpawns.splice(i, 1);
      } else {
        const k = 1 - it.t / it.dur;
        const e = k * k * (3 - 2 * k);   // smoothstep（与 cardDraft 一致）
        it.mesh.position.set(
          it.from.x + (it.pos.x - it.from.x) * e,
          it.from.y + (it.pos.y - it.from.y) * e,
          it.from.z + (it.pos.z - it.from.z) * e
        );
      }
    }
  }

  // 清理全部光点（切关/回菜单/死亡重开），幂等
  clearPending() {
    for (const it of this._pendingSpawns) if (it.mesh) this._removeBeam(it.mesh);
    this._pendingSpawns = [];
    this._bossQueued = false;
  }

  // 批量取消某组光点（脸谱阶段切换/清场用）
  _cancelPendingGroup(tag) {
    for (let i = this._pendingSpawns.length - 1; i >= 0; i--) {
      if (this._pendingSpawns[i].group === tag) {
        const it = this._pendingSpawns[i];
        if (it.mesh) this._removeBeam(it.mesh);
        this._pendingSpawns.splice(i, 1);
      }
    }
  }

  _spawnBoss() {
    // 魔术师 Boss（第18关 boss='magician'）
    if (this.level.boss === 'magician') {
      this._spawnMagicianBoss();
      return;
    }
    // 脸谱 Boss（第6关 boss='face'）
    if (this.level.boss === 'face') {
      this._spawnFaceBoss();
      return;
    }
    // 默认：骑士 Boss（排队即占位，_bossQueued 防重复排队）
    if (this._bossQueued) return;
    this._bossQueued = true;
    const pos = this._spawnPos(ENEMY_TYPES.knight.radius);
    this._queueSpawn('knight', pos, {
      onSpawn: (b) => {
        b.maxHp = 3000; b.hp = 3000; b.speed = 0.25; b.radius = 2; b.score = 500;
        b.mesh.scale.setScalar(4);
        b.isBoss = true;
        this.boss = b;
        this.bossSpawned = true;   // 落地才置位，避免飞行期 cleared 误判
      },
    });
  }

  // 魔术师 Boss（第18关 boss='magician'）：实例化 MagicianBoss 控制器
  // （控制器内部建命中代理气球 + 常驻动画模型，并接管阶段循环）
  _spawnMagicianBoss() {
    if (this._magicianBoss) return;   // 防每帧重入（bossSpawned 在代理落地后才置位）
    this._bossQueued = true;
    this._magicianBoss = new MagicianBoss(this);
  }

  // ===== 精英波（叠加于普通出怪之上，来自 ELITE_SCHEDULE）=====

  // 取某敌种的「默认血量」：优先用 Excel 跨关聚合的全局表 ELITE_BASE_HP
  // （骑士1000/盾兵2000/心形5000/幽灵7000/忍者8000/章鱼20000）。
  // 未收录的敌种回退到其基础血量（ENEMY_TYPES.hp），再不行给 500。
  _eliteBaseHP(type) {
    if (ELITE_BASE_HP[type] != null) return ELITE_BASE_HP[type];
    const t = ENEMY_TYPES[type];
    return t ? t.hp : 500;
  }

  // 每帧推进精英波计时，按时间窗触发三期（前期5s/中期20s/后期40s，进入即生成一次）
  _updateEliteWaves(dt) {
    if (!this._elitePlan || !this._eliteFired) return;
    this._eliteElapsed += dt;
    const e = this._eliteElapsed;
    if (!this._eliteFired.early && e >= ELITE_WINDOW.early) { this._eliteFired.early = true; this._fireElitePhase('early'); }
    if (!this._eliteFired.mid   && e >= ELITE_WINDOW.mid)   { this._eliteFired.mid   = true; this._fireElitePhase('mid'); }
    if (!this._eliteFired.late  && e >= ELITE_WINDOW.late)  { this._eliteFired.late  = true; this._fireElitePhase('late'); }
  }

  // 触发某期精英波：按各敌种分别计算血量并逐个生成组合敌种
  // ⚠️ 血量按「敌种」分别计算（互不串用）：HP(某型) = ELITE_BASE_HP[该型]（固定默认血量，已去掉「增幅血量」DPS 缩放）。
  //   · 例：L02 后期 shield=2000、eliteKnight=1000（各型按自己默认血量，互不串用）。
  _fireElitePhase(phase) {
    const plan = this._elitePlan[phase];
    if (!plan) return;
    const positions = this._eliteSpawnPositions(plan.dir, plan.combos);
    let pi = 0;
    for (const combo of plan.combos) {
      // 本型血量 = 该型默认血量（ELITE_BASE_HP），不随玩家 DPS 缩放
      const hp = this._eliteBaseHP(combo.type);
      for (let k = 0; k < combo.count; k++) {
        const pos = positions[pi++ % positions.length];
        this._queueSpawn(combo.type, pos, {
          onSpawn: (b) => {
            b.maxHp = hp; b.hp = hp;     // 用按型计算的血量覆盖基础血量
            b.isElite = true;
          },
        });
      }
    }
  }

  // 按方向生成一组出生点（精英波在指定方位成簇出现）
  //   front      → 正前方(0°)     frontLeft → 前偏左(-45°)   frontRight → 前偏右(+45°)
  _eliteSpawnPositions(dir, combos) {
    const total = combos.reduce((s, c) => s + c.count, 0);
    let centerDeg, arcDeg;
    if (dir === 'frontLeft')       { centerDeg = -45; arcDeg = 70; }
    else if (dir === 'frontRight') { centerDeg =  45; arcDeg = 70; }
    else                           { centerDeg =   0; arcDeg = 70; } // front
    const out = [];
    const r0 = ENEMY_TYPES[combos[0]?.type]?.radius || 0.9;
    for (let i = 0; i < total; i++) {
      out.push(this._spawnPos(r0, { dist: 15, spread: 6, centerDeg, arcDeg }));
    }
    return out;
  }

  // ===== 脸谱 Boss（单 Boss 多阶段循环）=====
  // 蓝(10s)→红(10s)→黑(10s)→蓝... 每次变脸换位置+清子实体
  // Boss 3000HP、95%减伤；击杀子实体按百分比扣 Boss 血（绕过减伤）
  _spawnFaceBoss() {
    // 预加载所有脸谱模型 + 小怪模型（每个 .catch 兜底，避免模型加载失败时变成 unhandled rejection 刷控制台）
    const _swallow = (p) => { if (p && typeof p.catch === 'function') p.catch(() => {}); return p; };
    for (const url of FACE_BOSS.MODELS) _swallow(loadBalloonModel(url));
    _swallow(loadBalloonModel(FACE_BOSS.FAN_MODEL));
    _swallow(loadBalloonModel(ENEMY_TYPES.flagMask.model));
    // 蓝阶段 3×3 阵型只用 basic（两侧列）与 knight（中心列）
    _swallow(loadBalloonModel(ENEMY_TYPES.basic.model));
    _swallow(loadBalloonModel(ENEMY_TYPES.knight.model));

    // 蓝阶段 = POSITIONS[0] = 前方
    const [x, y, z] = FACE_BOSS.POSITIONS[0];
    this._bossQueued = true;   // 排队即占位（防每帧重入）
    this._queueSpawn('faceMask', new THREE.Vector3(x, y, z), {
      onSpawn: (b) => {
        b.maxHp = FACE_BOSS.HP;
        b.hp = FACE_BOSS.HP;
        b.speed = 0;
        b.radius = FACE_BOSS.RADIUS;
        b.score = 500;
        b.mesh.scale.setScalar(FACE_BOSS.SCALE);
        b.isBoss = true;
        b.controlled = true;            // 呆在原地，不自动朝玩家移动
        b.damageReduction = FACE_BOSS.DAMAGE_REDUCTION;
        b.isFaceMask = true;
        this.faceBoss = b;
        this.bossSpawned = true;        // 落地才置位（防飞行期 cleared 误判）
      },
    });
  }

  // 脸谱 Boss 每帧更新：阶段计时 + 分发到对应颜色阶段处理器
  _updateFaceBoss(dt) {
    if (!this.bossSpawned) { if (!this._bossQueued) this._spawnFaceBoss(); return; }
    const b = this.faceBoss;

    // 通关判定：Boss 死亡或被移除
    if (!b || !b.alive || !this.balloons.list.includes(b)) {
      this._faceClearSubEntities();
      this.cleared = true;
      return;
    }

    this.facePhaseTimer += dt;
    if (this.facePhaseTimer >= FACE_BOSS.PHASE_DURATION) {
      this._faceNextPhase();
      return;
    }
    const t = this.facePhaseTimer;
    if (this.facePhase === 0) this._faceUpdateBlue(dt, t);
    else if (this.facePhase === 1) {
      this._faceUpdateRed(dt, t);
      if (this._redEndNow) {          // 红阶段：Boss 已落地 → 立刻变脸进入下一阶段
        this._redEndNow = false;
        this._faceNextPhase();
        return;
      }
    }
    else this._faceUpdateBlack(dt, t);
  }

  // 阶段切换：清子实体 → 换脸谱模型 → 换位置 → 黑阶段预捕获
  _faceNextPhase() {
    this._faceClearSubEntities();
    this.facePhase = (this.facePhase + 1) % 3;
    this.facePhaseTimer = 0;
    const b = this.faceBoss;
    if (b && b.alive && this.balloons.list.includes(b)) {
      const [nx, ny, nz] = FACE_BOSS.POSITIONS[this.facePhase];
      b.mesh.position.set(nx, ny, nz);
      swapBalloonModel(b, FACE_BOSS.MODELS[this.facePhase], b.radius);
    }
    // 进入黑阶段时预捕获 DepthSprite（避免 25 分身首帧卡顿）
    if (this.facePhase === 2) {
      preCaptureDepthSprite(FACE_BOSS.BLACK_CLONE_MODEL, ENEMY_TYPES.blackMaskClone.radius);
    }
    // 脸谱Boss相位「登场」语音（仅阶段切换时播；穿云开场的蓝色儿郎冲锋由 game 延迟播）：
    // 蓝(0)→儿郎冲锋 / 红(1)→帅字旗 / 黑(2)→身化万千，循环轮替
    if (this.facePhase === 0) this.audio?.playVoice('music/儿郎冲锋.mp3');
    else if (this.facePhase === 1) this.audio?.playVoice('music/帅字旗.wav');
    else if (this.facePhase === 2) this.audio?.playVoice('music/身化万千.wav');
  }

  // 蓝色阶段：0-2s 留空 → 2-4s 渐进召唤左右两侧各 3×3（中心格骑士、其余basic） → 4-15s 小怪冲锋 + Boss 摆动 + 子实体上下浮动
  _faceUpdateBlue(dt, t) {
    const b = this.faceBoss;
    const perSide = FACE_BOSS.BLUE_FORMATION_ROWS * FACE_BOSS.BLUE_FORMATION_COLS; // 单侧 9
    const total = perSide * 2;                                                     // 左右两侧共 18
    // 蓝阶段开场「儿郎冲锋」语音已由 game 在穿云结束后播；此处不再重复（红/黑阶段语音见 _faceNextPhase）
    // 2-4s: 渐进召唤（按阵型顺序逐格生成）
    if (t >= FACE_BOSS.BLUE_MINION_SPAWN_START && t < FACE_BOSS.BLUE_MINION_ACTIVE_START) {
      const span = FACE_BOSS.BLUE_MINION_ACTIVE_START - FACE_BOSS.BLUE_MINION_SPAWN_START;
      const target = Math.floor(((t - FACE_BOSS.BLUE_MINION_SPAWN_START) / span) * total);
      while (this._blueSpawnedCount < target && this._blueSpawnedCount < total) {
        this._faceSpawnMinion();
      }
    }
    // 子实体轻微上下摆动（与气球一致的悬浮感，召唤期与冲锋期都生效）
    const bobAmp = FACE_BOSS.BLUE_MINION_BOB_AMP;
    const bobFreq = FACE_BOSS.BLUE_MINION_BOB_FREQ;
    for (const m of this.faceSubEntities) {
      if (!m.alive || !this.balloons.list.includes(m)) continue;
      m.mesh.position.y = m._bobBaseY + Math.sin(this.facePhaseTimer * bobFreq + m._bobPhase) * bobAmp;
    }
    // 4-15s: 小怪解除 controlled 冲向玩家 + Boss X 轴正弦摆动
    if (t >= FACE_BOSS.BLUE_MINION_ACTIVE_START) {
      for (const m of this.faceSubEntities) {
        if (m.alive && this.balloons.list.includes(m) && m.controlled) m.controlled = false;
      }
      if (b && b.alive) {
        const k = Math.sin((t - FACE_BOSS.BLUE_MINION_ACTIVE_START) * FACE_BOSS.BLUE_SWING_FREQ * Math.PI * 2);
        b.mesh.position.x = FACE_BOSS.POSITIONS[this.facePhase][0] + k * FACE_BOSS.BLUE_SWAY_AMP;
      }
    }
  }

  // 蓝阶段生成一个怪：左右两侧各一个 3×3 阵，中心格(第2行第2列)=骑士，其余=basic
  // 阵型排在 Boss 前方（朝玩家 +Z 递进），左阵居中于 Boss.X - BLUE_SIDE_OFFSET，右阵 +BLUE_SIDE_OFFSET
  _faceSpawnMinion() {
    const i = this._blueSpawnedCount++;
    const rows = FACE_BOSS.BLUE_FORMATION_ROWS;   // 3
    const cols = FACE_BOSS.BLUE_FORMATION_COLS;   // 3
    const perSide = rows * cols;                  // 9
    const sideIdx = Math.floor(i / perSide);      // 0 = 左阵, 1 = 右阵
    const cell = i % perSide;                     // 0..8 阵内序号
    const row = Math.floor(cell / cols);          // 0..2
    const col = cell % cols;                      // 0..2
    const centerRow = (rows - 1) / 2;             // 1
    const centerCol = (cols - 1) / 2;             // 1
    const type = (row === centerRow && col === centerCol) ? 'knight' : 'basic';
    const b = this.faceBoss;
    const s = (sideIdx === 0) ? -1 : 1;           // 左 = -X，右 = +X
    // 侧阵中心 X：偏离 Boss；中心行基准 Z：Boss 前方一个行距，整体朝玩家递进
    const cx = b.mesh.position.x + s * FACE_BOSS.BLUE_SIDE_OFFSET;
    const cz = b.mesh.position.z + FACE_BOSS.BLUE_FORMATION_ROW_GAP;
    const x = cx + (col - centerCol) * FACE_BOSS.BLUE_FORMATION_COL_GAP;
    const z = cz + (row - centerRow) * FACE_BOSS.BLUE_FORMATION_ROW_GAP;
    const y = FACE_BOSS.BLUE_MINION_Y[0] + Math.random() * (FACE_BOSS.BLUE_MINION_Y[1] - FACE_BOSS.BLUE_MINION_Y[0]);
    const p = new THREE.Vector3(x, y, z);
    this._queueSpawn(type, p, {
      group: 'faceSub',
      effect: PORTAL_BEAM.APPLY_FACE_SUB,
      check: () => !!b && b.alive && this.balloons.list.includes(b),
      onSpawn: (m) => {
        // knight 默认按 Boss 体型生成（spawn 时已用 Boss 半径建了超长血条）→ 缩为正常体型，并重建血条匹配新体型
        if (type === 'knight') {
          m.radius = 0.9; m.effectiveRadius = 0.9; m.hitRadius = 0.9;
          m.mesh.scale.setScalar(1);
          // 重建血条：丢弃 spawn 时按 Boss 体型建的超长血条，改以缩小后的 effectiveRadius(0.9) 重建
          // → 长度≈体型；扣血偏移 -(1-k)*effectiveRadius 与半宽一致，显示为从右往左缩减
          if (m._hpBar) { m.mesh.remove(m._hpBar); m._hpBar = null; m._hpFg = null; }
          m._makeHealthBar(m.effectiveRadius);
        }
        m.controlled = true;           // 召唤阶段受控不动
        m.isFaceSub = true;            // 标记为脸谱 Boss 子实体
        m.faceBossRef = b;             // 指向 Boss（击杀时扣 Boss 血量）
        m._bobBaseY = y;               // 记录基准高度，供上下摆动
        m._bobPhase = Math.random() * Math.PI * 2;
        this.faceSubEntities.push(m);
      },
    });
  }

  // 红色阶段：0-2s 留空 → 2-6s 旗子绕Boss公转 → 6s 公转结束：旗子移到 Boss 两侧均匀分布 + 自身绕Z轴逆时针转90° → 8-14s 仍逐个飞向玩家
  _faceUpdateRed(dt, t) {
    const b = this.faceBoss;
    // —— Boss 本体动作（红阶段：随旗子一起"原地旋转 / 原地升空 / 原地落地"）——
    //   · 旗子公转期间：Boss 原地自转（角速度 RED_BOSS_SPIN_SPEED，方向与旗子公转同向）
    //   · 升空/砸落：Boss 与"保留的大旗"同步升降（只动 Y，X/Z 钉在原位 → 就是"原地"升落）
    // 注意：所有气球每帧都会 mesh.lookAt(玩家)，故朝向/高度必须在本方法里覆写（本方法晚于 balloons.update 执行）。
    if (b && b.alive) {
      const BP = FACE_BOSS.POSITIONS[1];
      b.mesh.position.x = BP[0];
      b.mesh.position.z = BP[2];
      b._redBaseY = BP[1];                                  // 升降基准高度（落地时回到这里）
      // 正面基准角：红阶段开始时"面向玩家"的那个角度，自转结束要精确回到它（用户要求：刚好转回正面）
      if (b._spinFront == null) {
        const pl = this.getPlayerPos ? this.getPlayerPos() : null;
        b._spinFront = pl ? Math.atan2(pl.x - BP[0], pl.z - BP[2]) : 0;
      }
      // 自转：在可用窗口内推进"整数圈" —— 用进度(k)算角度而非逐帧累加，末端必然 = 正面 + 整数圈(视觉上即正面)。
      //   圈数 = RED_BOSS_SPIN_TURNS(>0 固定) 或 最接近 RED_BOSS_SPIN_SPEED 的整数圈(自动)；
      //   实际角速度 = 2π×圈数 / 窗口时长（所以想转更久就把 RED_FLAG_ORBIT_END 调大）。
      const spinStart = FACE_BOSS.RED_FLAG_SPAWN_START;
      const spinEnd = FACE_BOSS.RED_FLAG_ORBIT_END;
      const spinning = t >= spinStart && t < spinEnd;
      if (b._spinTurns == null && FACE_BOSS.RED_BOSS_SPIN_SPEED) {
        const win = Math.max(0.1, spinEnd - spinStart);
        b._spinTurns = FACE_BOSS.RED_BOSS_SPIN_TURNS > 0
          ? FACE_BOSS.RED_BOSS_SPIN_TURNS
          : Math.max(1, Math.round(FACE_BOSS.RED_BOSS_SPIN_SPEED * win / (Math.PI * 2)));
        b._spinSpeed = (Math.PI * 2 * b._spinTurns) / win;   // 实际角速度（整圈折算后）
      }
      if (b._spinTurns != null) {
        if (spinning) {
          const k = Math.min(1, Math.max(0, (t - spinStart) / Math.max(0.1, spinEnd - spinStart)));
          b._spinYaw = b._spinFront + Math.PI * 2 * b._spinTurns * k;
        } else if (t >= spinEnd) {
          b._spinYaw = b._spinFront + Math.PI * 2 * b._spinTurns;  // 定格：恰好正面（不受帧率累积误差影响）
        }
        if (b._spinYaw != null) b.mesh.rotation.set(0, b._spinYaw, 0); // 覆盖 lookAt，转完冻结在正面
      }
    }
    // 2-6s: 旗子出现 + 绕 Boss 公转
    if (t >= FACE_BOSS.RED_FLAG_SPAWN_START && !this._redSpawned) {
      this._redSpawned = true;
      this.faceOrbitAngle = 0;
      for (let i = 0; i < FACE_BOSS.RED_FLAG_COUNT; i++) {
        const ang = (i / FACE_BOSS.RED_FLAG_COUNT) * Math.PI * 2;
        const pos = new THREE.Vector3(
          b.mesh.position.x + Math.cos(ang) * FACE_BOSS.RED_FLAG_ORBIT_RADIUS,
          FACE_BOSS.RED_FLAG_Y,
          b.mesh.position.z + Math.sin(ang) * FACE_BOSS.RED_FLAG_ORBIT_RADIUS
        );
        this._queueSpawn('flagMask', pos, {
          group: 'faceSub',
          effect: PORTAL_BEAM.APPLY_FACE_SUB,
          check: () => !!b && b.alive && this.balloons.list.includes(b),
          onSpawn: (f) => {
            f.maxHp = FACE_BOSS.RED_FLAG_HP;
            f.hp = FACE_BOSS.RED_FLAG_HP;
            f.speed = 0;
            f.radius = FACE_BOSS.RED_FLAG_RADIUS;
            f.effectiveRadius = FACE_BOSS.RED_FLAG_RADIUS;  // 视觉3倍后同步碰撞
            f.hitRadius = FACE_BOSS.RED_FLAG_RADIUS;
            f.mesh.scale.setScalar(FACE_BOSS.RED_FLAG_SCALE);
            f.controlled = true;
            f.selfDamage = FACE_BOSS.RED_FLAG_SELF_DAMAGE;
            f.isFaceSub = true;
            f.faceBossRef = b;
            f._flagAngleOffset = ang;
            f._flagLaunched = false;
            f._flagPlaced = false;
            f._flagRiseT = 0;       // 升空+放大进度计时(s)
            f._flagSlam = false;    // 是否已进入砸落(controlled=false 飞向玩家)
            f._flagBaseY = 0;       // 升空基准Y(放置时写入)
            this.faceSubEntities.push(f);
            this.faceFlags.push(f);
          },
        });
      }
      // 「帅字旗」语音改在脸谱Boss红阶段「登场」时播（见 _faceNextPhase），此处不再重复
    }
    // 公转推进（仅公转阶段、未放置未释放的旗子）
    if (this._redSpawned && !this._redPlaced && b && b.alive) {
      this.faceOrbitAngle += FACE_BOSS.RED_FLAG_ORBIT_SPEED * dt;
      const r = FACE_BOSS.RED_FLAG_ORBIT_RADIUS;
      for (const f of this.faceFlags) {
        if (!f.alive || !this.balloons.list.includes(f) || f._flagLaunched || f._flagPlaced) continue;
        const a = this.faceOrbitAngle + f._flagAngleOffset;
        f.mesh.position.set(
          b.mesh.position.x + Math.cos(a) * r,
          FACE_BOSS.RED_FLAG_Y,
          b.mesh.position.z + Math.sin(a) * r
        );
      }
    }
    // 公转结束（t>=RED_FLAG_ORBIT_END）：旗子移到 Boss 左右两侧 1m 间隔排列，并自身绕 Z 轴逆时针转 90°
    if (this._redSpawned && !this._redPlaced && t >= FACE_BOSS.RED_FLAG_ORBIT_END) {
      this._redPlaced = true;
      this.faceFlags.forEach((f, i) => {
        if (!f.alive || !this.balloons.list.includes(f) || f._flagLaunched) return;
        this._facePlaceRedFlag(f, i, b);
      });
    }
    // —— 融合：转圈结束、升空前，多面旗合成一面大旗 ——
    //   保留第 1 面（移正到 Boss 正上方），其余旗子飞向它并缩小 → 到位即移除（"其它旗子消失只保留一个旗子"）
    if (this._redPlaced && b && b.alive && FACE_BOSS.RED_FLAG_MERGE && !this._redMerged) {
      this._redMerged = true;
      const live = this.faceFlags.filter((f) => f.alive && this.balloons.list.includes(f) && !f._flagLaunched);
      this._flagKeeper = live[0] || null;
      if (this._flagKeeper) {
        const kp = this._flagKeeper;
        kp.mesh.position.set(b.mesh.position.x, b.mesh.position.y + FACE_BOSS.RED_FLAG_ABOVE_Y, b.mesh.position.z);
        kp._flagBaseY = b.mesh.position.y + FACE_BOSS.RED_FLAG_ABOVE_Y;   // 大旗升空基准（Boss 正上方）
        for (let i = 1; i < live.length; i++) {
          const f = live[i];
          f._merging = true;                    // 融合中：跳过升空/下砸，由下方"融合推进"接管位置
          f._mergeT = 0;
          f._mergeFrom = f.mesh.position.clone();
          f._mergeScale0 = f.mesh.scale.x;
        }
      }
    }
    // 融合推进：其余旗子飞向大旗并缩小，到位即从场上移除
    if (this._flagKeeper) {
      const dst = this._flagKeeper.mesh.position;
      for (const f of this.faceFlags) {
        if (!f._merging) continue;
        f._mergeT += dt;
        const k = FACE_BOSS.RED_FLAG_MERGE_TIME > 0 ? Math.min(1, f._mergeT / FACE_BOSS.RED_FLAG_MERGE_TIME) : 1;
        if (k >= 1) {
          f._merging = false;
          if (this.balloons.list.includes(f)) this.balloons.remove(f);   // 融合完成：消失
          continue;
        }
        f.mesh.position.set(
          f._mergeFrom.x + (dst.x - f._mergeFrom.x) * k,
          f._mergeFrom.y + (dst.y - f._mergeFrom.y) * k,
          f._mergeFrom.z + (dst.z - f._mergeFrom.z) * k
        );
        f.mesh.scale.setScalar(f._mergeScale0 * (1 - k));
      }
    }
    // 转圈结束(已放置)后：大旗升空 + 放大到十倍 → 高速砸向玩家
    if (this._redPlaced && b && b.alive) {
      for (const f of this.faceFlags) {
        if (!f.alive || !this.balloons.list.includes(f) || f._flagSlam || f._merging) continue;
        if (f._flagLaunched) continue; // 兼容旧逻辑：理论上不再触发
        f._flagRiseT = (f._flagRiseT || 0) + dt;
        const k = Math.min(1, f._flagRiseT / FACE_BOSS.RED_FLAG_SLAM_RISE_TIME);
        const ease = k * k * (3 - 2 * k); // smoothstep 缓动
        // 升空：从放置高度抬升 RED_FLAG_SLAM_RISE_Y
        f.mesh.position.y = f._flagBaseY + FACE_BOSS.RED_FLAG_SLAM_RISE_Y * ease;
        // 放大：RED_FLAG_SCALE(3) → RED_FLAG_SLAM_SCALE(10)
        const sc = FACE_BOSS.RED_FLAG_SCALE + (FACE_BOSS.RED_FLAG_SLAM_SCALE - FACE_BOSS.RED_FLAG_SCALE) * ease;
        f.mesh.scale.setScalar(sc);
        if (k >= 1) { // 升空+放大完成 → 进入砸落
          f._flagSlam = true;
          f.controlled = false;      // 交还自动朝玩家移动（balloon.update 朝 target）
          f.speed = FACE_BOSS.RED_FLAG_SLAM_SPEED;
          // 冻结下砸期间的朝向：旗子飞到玩家正上方时 mesh.lookAt 方向近似退化（yaw 每帧乱跳）→ 剧烈抖动
          f._slamRot = { x: f.mesh.rotation.x, y: f.mesh.rotation.y, z: f.mesh.rotation.z };
        }
      }
      // 下砸：升空后一边追玩家(XZ 由 balloon.update 接管)一边快速下降，
      // 降到 RED_FLAG_HIT_Y 以下才允许结算命中（见 game._checkExplosions 的高度门限）→ 真正"砸到玩家"
      for (const f of this.faceFlags) {
        if (!f.alive || !this.balloons.list.includes(f) || !f._flagSlam) continue;
        f.mesh.position.y = Math.max(FACE_BOSS.RED_FLAG_HIT_Y, f.mesh.position.y - FACE_BOSS.RED_FLAG_DIVE_SPEED * dt);
        // 冻结朝向（覆盖 lookAt）：RED_FLAG_SLAM_LOCK_ROT=false 可关掉恢复原样
        if (FACE_BOSS.RED_FLAG_SLAM_LOCK_ROT && f._slamRot) {
          f.mesh.rotation.set(f._slamRot.x, f._slamRot.y, f._slamRot.z);
        }
      }
      // —— Boss 随大旗"原地升空 / 原地落地"：高度与大旗完全同步（只改 Y，X/Z 不动）——
      const kp = this._flagKeeper;
      const kpAlive = !!(kp && kp.alive && this.balloons.list.includes(kp));
      if (FACE_BOSS.RED_BOSS_RISE_WITH_FLAG && b._redBaseY != null) {
        if (kpAlive && !kp._flagSlam) {  // 大旗升空中 → Boss 同步升空（同一缓动曲线）
          const kk = Math.min(1, (kp._flagRiseT || 0) / FACE_BOSS.RED_FLAG_SLAM_RISE_TIME);
          const ez = kk * kk * (3 - 2 * kk);
          b.mesh.position.y = b._redBaseY + FACE_BOSS.RED_FLAG_SLAM_RISE_Y * ez;
        } else {                         // 大旗下砸中（或大旗被打死/移除）→ Boss 同步落地，回到基准高度
          b.mesh.position.y = Math.max(b._redBaseY, b.mesh.position.y - FACE_BOSS.RED_FLAG_DIVE_SPEED * dt);
        }
      }
    }
    // —— 落地即切阶段（用户要求）：大旗开始下砸后，Boss 一落回基准高度就请 _updateFaceBoss 切到下一阶段 ——
    if (FACE_BOSS.RED_END_ON_LAND && this._flagKeeper && !this._redEndNow && b && b._redBaseY != null) {
      const kpf = this._flagKeeper;
      const slamStarted = !!kpf._flagSlam || !(kpf.alive && this.balloons.list.includes(kpf));
      if (slamStarted && b.mesh.position.y <= b._redBaseY + 1e-3) this._redEndNow = true;
    }
  }

  // 红阶段旗子定位（转圈结束后）：参数集中在 constants.js 的 FACE_BOSS
  //   · 悬浮位置：Boss 正上方 RED_FLAG_ABOVE_Y 米，沿前后(Z)排列，相邻间隔 RED_FLAG_FB_GAP 米
  //   · 旋转角度：每个旗子绕 Z 轴转 RED_FLAG_PLACED_ROT_Z 弧度（默认 π/2 = 逆时针 90°）
  _facePlaceRedFlag(f, i, b) {
    const fb = (i % 2 === 0) ? 1 : -1;                   // 偶数索引→前(+Z)，奇数→后(-Z)
    const rank = Math.floor(i / 2);                      // 同向前/后序号 0,1,2...
    f.mesh.position.set(
      b.mesh.position.x,
      b.mesh.position.y + FACE_BOSS.RED_FLAG_ABOVE_Y,    // 悬浮在 Boss 上方 RED_FLAG_ABOVE_Y 米
      b.mesh.position.z + fb * (rank + 1) * FACE_BOSS.RED_FLAG_FB_GAP  // 前后间隔 RED_FLAG_FB_GAP 米
    );
    f.mesh.rotation.z = FACE_BOSS.RED_FLAG_PLACED_ROT_Z; // 绕 Z 轴旋转（默认逆时针 90°）
    f._flagBaseY = b.mesh.position.y + FACE_BOSS.RED_FLAG_ABOVE_Y; // 升空基准Y（砸落时从此外抬升）
    f._flagPlaced = true;
  }

  // 黑色阶段：0-2s 留空(预捕获DepthSprite) → 2-4s 25分身渐进生成(r=8m圆) → 4-14s 可击杀 → 14-15s 剩余冲锋
  _faceUpdateBlack(dt, t) {
    const b = this.faceBoss;
    // 黑阶段：开始生成分身后 Boss 自身隐身（仅隐藏 3D 模型 bodyModel，血条保留可见以反馈血量），分身保持可见
    if (b && b.alive && b.bodyModel && t >= FACE_BOSS.BLACK_CLONE_SPAWN_START) b.bodyModel.visible = false;
    // 2-4s: 渐进生成分身（圆心0,0,0, r=8m, DepthSprite 立绘）
    if (t >= FACE_BOSS.BLACK_CLONE_SPAWN_START && t < FACE_BOSS.BLACK_CLONE_SPAWN_END) {
      const span = FACE_BOSS.BLACK_CLONE_SPAWN_END - FACE_BOSS.BLACK_CLONE_SPAWN_START;
      const target = Math.floor(((t - FACE_BOSS.BLACK_CLONE_SPAWN_START) / span) * FACE_BOSS.BLACK_CLONE_COUNT);
      while (this._cloneSpawnedCount < target && this._cloneSpawnedCount < FACE_BOSS.BLACK_CLONE_COUNT) {
        this._faceSpawnClone();
      }
    }
    // 阶段末前 2 秒（t>=13）：所有分身统一解除 controlled 并设置冲锋速度撞向玩家
    if (t >= FACE_BOSS.BLACK_CLONE_CHARGE_START) {
      for (const c of this.faceSubEntities) {
        if (c.alive && this.balloons.list.includes(c) && c.controlled) {
          c.controlled = false;
          c.speed = FACE_BOSS.BLACK_CLONE_CHARGE_SPEED; // 分身原 speed=0，必须给定才会移动
        }
      }
    }
  }

  // 黑阶段生成分身（圆上均匀分布，DepthSprite 立绘减少性能开销）
  _faceSpawnClone() {
    const i = this._cloneSpawnedCount++;
    const ang = (i / FACE_BOSS.BLACK_CLONE_COUNT) * Math.PI * 2;
    const r = FACE_BOSS.BLACK_CLONE_RING_RADIUS;
    const p = new THREE.Vector3(Math.cos(ang) * r, FACE_BOSS.BLACK_CLONE_Y, Math.sin(ang) * r);
    const b = this.faceBoss;
    this._queueSpawn('blackMaskClone', p, {
      group: 'faceSub',
      effect: PORTAL_BEAM.APPLY_FACE_SUB,
      check: () => !!b && b.alive && this.balloons.list.includes(b),
      onSpawn: (c) => {
        c.maxHp = FACE_BOSS.BLACK_CLONE_HP;
        c.hp = FACE_BOSS.BLACK_CLONE_HP;
        c.speed = 0;
        c.radius = FACE_BOSS.BLACK_CLONE_RADIUS;
        c.mesh.scale.setScalar(FACE_BOSS.BLACK_CLONE_SCALE);
        c.controlled = true;
        c.selfDamage = FACE_BOSS.BLACK_CLONE_SELF_DAMAGE;
        c.isFaceSub = true;
        c.faceBossRef = b;
        // 黑色分身保持可见（隐身的是 Boss 本体，见 _faceUpdateBlack）；分身仍可被击中扣 Boss 血
        this.faceSubEntities.push(c);
      },
    });
  }

  // 清除所有存活子实体（阶段切换 / Boss 死亡时调用）
  _faceClearSubEntities() {
    this._cancelPendingGroup('faceSub');   // 取消飞行中的子实体光点（防下阶段残留孤儿怪）
    for (const s of this.faceSubEntities) {
      if (s.alive && this.balloons.list.includes(s)) this.balloons.remove(s);
    }
    this.faceSubEntities = [];
    this.faceFlags = [];
    // 清红阶段 Boss 动作/自转缓存（下次进红阶段重新取"正面"基准角并重新算整圈）
    if (this.faceBoss) {
      this.faceBoss._spinYaw = null;
      this.faceBoss._spinFront = null;
      this.faceBoss._spinTurns = null;
      this.faceBoss._spinSpeed = null;
      this.faceBoss._redBaseY = null;
    }
    this._redEndNow = false;
    this._redMerged = false;
    this._flagKeeper = null;
    this._redSpawned = false;
    this._redPlaced = false;
    this._blueSpawnedCount = 0;
    this._cloneSpawnedCount = 0;
    this.faceOrbitAngle = 0;
    this.faceLaunchTimer = FACE_BOSS.RED_FLAG_LAUNCH_INTERVAL;
  }

  update(dt) {
    this._updatePendingSpawns(dt);   // 光点推进 + 落地 spawn（任何模式都执行）
    if (!this.level || this.cleared) return;

    // 精英波叠加（独立于普通出怪；Boss/激光关 _elitePlan 为 null，无操作）
    if (!isBoss(this.level)) this._updateEliteWaves(dt);

    // 正常测试模式：升级式同屏出怪（boss 关不会走到这里，startLevel 已分流）
    if (this.mode === 'normalTest') {
      this._updateNormalTest(dt);
      return;
    }

    if (isBoss(this.level)) {
      if (!this.bossSpawned) this._spawnBoss();
      // 魔术师 Boss：控制器接管阶段循环 + 通关判定
      if (this.level.boss === 'magician') {
        if (this._magicianBoss) this._magicianBoss.update(dt);
        return;
      }
      // 脸谱 Boss：每帧更新变脸 + 通关判定
      if (this.level.boss === 'face') {
        this._updateFaceBoss(dt);
      } else {
        // 骑士 Boss：击杀或撞船移除都算通关
        if (this.boss && (!this.boss.alive || !this.balloons.list.includes(this.boss))) this.cleared = true;
      }
      return;
    }

    // 需求②：每关单一敌人、一次只出一个；场上清空（死亡 + 光点落地）后才出下一个
    this.elapsed += dt;
    if (this.spawned < this.total && this._active === 0) {
      const spawnRadius = ENEMY_TYPES[this.singleType]?.radius || 0.5;
      this._queueSpawn(this.singleType, this._spawnPos(spawnRadius));
      this.spawned++;
    }
    if (this.spawned >= this.total && this._active === 0) {
      this.cleared = true;
    }

    // 召唤怪持续维持小兵（其机制的一部分；小兵随主敌同屏，不再额外计为「另一种敌人」）
    this._updateSummoners(dt);
  }

  // ===== 正常测试：升级式同屏出怪 =====
  // 目标同屏数 = min(startCount + floor(t/rampInterval)*step, peak)
  _targetConcurrency(t) {
    return Math.min(
      NORMAL_TEST.startCount + Math.floor(t / NORMAL_TEST.rampInterval) * NORMAL_TEST.step,
      NORMAL_TEST.peak
    );
  }

  // ===== 新调度：玩家 DPS 基准 + 内外圈（SPAWN_RING）=====

  // 每关开始：以玩家 DPS 为基准算出基础出怪量，平均分配内外圈初始配额
  // 基础出怪量 = clamp(DPS/DPS_DIVISOR × levelScale/LEVEL_BASE, MIN_BASE, MAX_BASE)
  // 关卡常数 levelScale = LEVEL_BASE + (n-1)×LEVEL_INC（随关卡推进增加怪量）
  _initDpsSpawn(level) {
    const S = SPAWN_RING;
    const dps = this.getPlayerDPS ? this.getPlayerDPS() : 200; // 兜底预览模式初始 DPS
    this.levelScale = S.LEVEL_BASE + (level.n - 1) * S.LEVEL_INC;
    this.baseSpawn = THREE.MathUtils.clamp(
      Math.round((dps / S.DPS_DIVISOR) * (this.levelScale / S.LEVEL_BASE)),
      S.MIN_BASE, S.MAX_BASE
    );
    // 内圈配额 = baseSpawn×50%，硬上限 INNER_CAP=5（对齐 RING_TABLE 索引 0..5，保证反馈生效）
    this.innerQuota = Math.min(Math.round(this.baseSpawn * S.INNER_RATIO), S.INNER_CAP);
    this.outerQuota = Math.round(this.baseSpawn * S.INNER_RATIO); // 初始外圈 = 50%（首查后由内圈系数接管）
    this.ringTimer = 0;
    this.spawnTimer = 0;
    this._lastCheckInner = 0;
  }

  // 每帧驱动：5s 检查内圈 → 系数调外圈；时间窗内滴流补怪；窗后清空通关
  _updateDpsSpawn(dt) {
    const S = SPAWN_RING;
    this.ringTimer += dt;

    // 每 CHECK_INTERVAL 秒：检查内圈存活 → 算系数 → 调外圈配额
    if (this.ringTimer >= S.CHECK_INTERVAL) {
      this.ringTimer = 0;
      this._ringCheck();
    }

    // 停止补怪时间窗内：滴流补怪到配额
    if (this.elapsed < S.stopAt) this._refillDrip(dt);

    // 时间窗结束且场上清空（含飞行光点）→ 通关
    if (this.elapsed >= S.stopAt && this._active === 0) this.cleared = true;
  }

  // 每 5 秒检查：内圈存活数 → RING_TABLE → 内圈系数 → 外圈目标
  // 语义：内圈怪越少（玩家清得快）→ 系数越大 → 外圈出更多怪补足压力；放过技能 → 系数恒 1
  _ringCheck() {
    const S = SPAWN_RING;
    const inner = this._countInRing(S.INNER_RADIUS);   // 只统计已落地存活怪（不计 pending 光点）
    this._lastCheckInner = inner;
    let coeff = 1;
    if (!(this.getSkillCd() > S.SKILL_CD_THRESHOLD)) { // 最近 5 秒未放技能 → 用系数表
      const idx = Math.min(Math.max(inner, 0), S.RING_TABLE.length - 1); // clamp 0..5
      coeff = S.RING_TABLE[idx];
    }
    // 释放过技能 → 系数恒为 1（不追加外圈压力）
    this.outerQuota = Math.round(this.baseSpawn * coeff);
    this.innerQuota = Math.min(Math.round(this.baseSpawn * S.INNER_RATIO), S.INNER_CAP);
  }

  // 每帧滴流补怪：按内外圈缺口大小，优先补缺口大的环，一次一只，受 REFILL_COOLDOWN 节流
  _refillDrip(dt) {
    const S = SPAWN_RING;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;

    const innerAlive  = this._countInRing(S.INNER_RADIUS);
    const outerAlive  = this.balloons.count - innerAlive;  // 内圈以外均算外圈（含 9~15m 过渡带）
    const pendInner   = this._pendingInRing('inner');
    const pendOuter   = this._pendingInRing('outer');
    const innerNeed   = this.innerQuota - (innerAlive + pendInner); // 含飞行光点防超量排队
    const outerNeed   = this.outerQuota - (outerAlive + pendOuter);
    if (innerNeed <= 0 && outerNeed <= 0) { this.spawnTimer = 0.1; return; }

    const type = S.pool[(Math.random() * S.pool.length) | 0] || 'basic';
    const radius = ENEMY_TYPES[type]?.radius || 0.5;
    const spawnInner = () => this._queueSpawn(type,
      this._spawnPos(radius, { dist: S.INNER_RADIUS, spread: S.INNER_SPREAD }), { ring: 'inner' });
    const spawnOuter = () => this._queueSpawn(type,
      this._spawnPos(radius, { dist: S.OUTER_RADIUS, spread: S.OUTER_SPREAD }), { ring: 'outer' });

    if (innerNeed >= outerNeed) {
      if (innerNeed > 0) spawnInner(); else if (outerNeed > 0) spawnOuter();
    } else {
      if (outerNeed > 0) spawnOuter(); else if (innerNeed > 0) spawnInner();
    }
    this.spawnTimer = S.REFILL_COOLDOWN;
  }

  // 统计：距场地中心（世界原点）水平距离 < maxDist 的存活怪数
  _countInRing(maxDist) {
    let n = 0;
    const r2 = maxDist * maxDist;
    for (const b of this.balloons.list) {
      if (!b.alive) continue;
      const x = b.mesh.position.x, z = b.mesh.position.z;
      if (x * x + z * z < r2) n++;
    }
    return n;
  }

  // 统计：飞行中的光点里属于某环的数量
  _pendingInRing(ring) {
    let n = 0;
    for (const it of this._pendingSpawns) if (it.ring === ring) n++;
    return n;
  }

  _updateNormalTest(dt) {
    this.elapsed += dt;

    // 新调度（DPS 基准内外圈）：SPAWN_RING.enabled=true 时完全接管，替换下方 DDA 分支
    if (SPAWN_RING.enabled) {
      this._updateDpsSpawn(dt);
      return;
    }

    // 方案 A：DDA 完全接管出怪（数量/种类/位置由难度标量驱动），替换原时间升级曲线
    if (DDA.enabled && this.dda) {
      const D = this.dda.update(dt);
      const plan = this.dda.getPlan();
      if (this.elapsed < NORMAL_TEST.stopAt) {
        this.spawnTimer -= dt;
        if (this._active < plan.concurrency && this.spawnTimer <= 0) {
          // 场上缺口大时批量补充（避免一个个慢慢滴出，体感稀疏）
          const deficit = plan.concurrency - this._active;
          const burst = deficit > plan.concurrency * 0.5 ? Math.min(3, deficit) : 1;
          for (let s = 0; s < burst; s++) {
            if (this._active >= plan.concurrency) break;
            const type = plan.pickType();
            this._queueSpawn(type, this._spawnPos(ENEMY_TYPES[type]?.radius || 0.5,
              { dist: plan.dist, spread: plan.spread }));
          }
          this.spawnTimer = plan.cooldown;
        }
      }
      // 停止补怪后场上清空 → 通关
      if (this.elapsed >= NORMAL_TEST.stopAt && this._active === 0) {
        this.cleared = true;
      }
      return;
    }

    // 原时间曲线（DDA 关闭时回退）
    if (this.elapsed < NORMAL_TEST.stopAt) {
      this.spawnTimer -= dt;
      const target = this._targetConcurrency(this.elapsed);
      if (this._active < target && this.spawnTimer <= 0) {
        const type = NORMAL_TEST.pool[(Math.random() * NORMAL_TEST.pool.length) | 0];
        this._queueSpawn(type, this._spawnPos(ENEMY_TYPES[type]?.radius || 0.5));
        this.spawnTimer = NORMAL_TEST.spawnCooldown;
      }
    }
    if (this.elapsed >= NORMAL_TEST.stopAt && this._active === 0) {
      this.cleared = true;
    }
  }

  // 召唤怪：存活期间维持 minionCap 只基础怪；死后由 _onKilled 清场（此处兜底）
  _updateSummoners(dt) {
    for (let i = this.balloons.list.length - 1; i >= 0; i--) {
      const b = this.balloons.list[i];
      if (b.behavior !== 'summon') continue;
      // 死亡兜底清理（主清理在 game._onKilled）
      if (!b.alive) {
        if (b.minions.length) {
          for (const m of b.minions) if (m.alive) this.balloons.remove(m);
          b.minions.length = 0;
        }
        continue;
      }
      // 剔除已死小怪
      b.minions = b.minions.filter(m => m.alive && this.balloons.list.includes(m));
      // 计时到则补满（小怪死后延迟重生）；飞行中的光点也计入待补数，防 while 死循环
      b.summonTimer -= dt;
      const pendingM = this._pendingSpawns.filter(it => it.summonOwner === b).length;
      if (b.minions.length + pendingM < b.minionCap && b.summonTimer <= 0) {
        const pp = this.getPlayerPos();
        const back = b.mesh.position.clone().sub(pp);
        back.y = 0;
        if (back.length() > 0.001) back.normalize(); else back.set(0, 0, 1);
        while (b.minions.length + pendingM < b.minionCap) {
          const mp = b.mesh.position.clone().addScaledVector(back, SUMMON_MINION_DISTANCE);
          mp.x += (Math.random() - 0.5) * SUMMON_MINION_SPREAD;
          mp.z += (Math.random() - 0.5) * SUMMON_MINION_SPREAD;
          const ret = this._queueSpawn('basic', mp, {
            summonOwner: b,
            effect: PORTAL_BEAM.APPLY_SUMMON,
            check: () => b.alive && this.balloons.list.includes(b),  // 召唤者死亡 → 取消
            onSpawn: (m) => { m.owner = b; b.minions.push(m); },
          });
          if (ret === null) pendingM++;   // 入队才算待落地；同步路径 onSpawn 已入 minions
        }
        b.summonTimer = SUMMON_RESPAWN_DELAY; // 死后延迟重生间隔
      }
    }
  }

  // 盾兵怪（shield）现已自带「骑士模型 + 会旋转的盾牌」，盾牌在 balloons.js 内自转并挡子弹，
  // 不再需要 waves 层做「盾牌绕骑士公转」的编队逻辑，故此处移除。第 4 关「盾牌卫队」改为直接出盾兵怪。
}

// ===== 盾牌绕骑士公转参数（已废弃，保留注释以备回溯）=====
// 原设计：盾牌气球环绕骑士旋转形成护卫阵（每 2 秒 1 圈）。现盾兵怪自身即「骑士+旋转盾」，
// 故改为每个盾兵怪独立持盾自转。以下常量不再被引用。
// const SHIELD_ORBIT_PERIOD = 2.0;
// const SHIELD_ORBIT_GAP    = 0.8;
// const SHIELD_ORBIT_Y      = 0.0;
// const SHIELD_ORBIT_SPEED  = (Math.PI * 2) / SHIELD_ORBIT_PERIOD;
