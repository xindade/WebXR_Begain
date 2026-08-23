import * as THREE from 'three';
import { WAVE, NORMAL_TEST, DDA, FACE_BOSS, PORTAL_BEAM } from '../core/constants.js';
import { ENEMY_TYPES } from '../content/enemies.js';
import { isBoss } from '../content/levels.js';
import { LEVEL_ENEMY } from '../content/spawnPlans.js';
import { swapBalloonModel, loadBalloonModel, preCaptureDepthSprite } from './balloonModels.js';

// ===== 召唤怪小兵参数（手动微调入口，改这里即可）=====
const SUMMON_MINION_DISTANCE = 1.5; // 小兵出生在召唤者「身后」的距离(m)：调大 → 离本体更远
const SUMMON_MINION_SPREAD   = 3.0; // 小兵出生点相对身后的左右/前后随机偏移(m)：调大 → 散布更开
const SUMMON_RESPAWN_DELAY   = 1.5; // 小兵死亡后延迟重生间隔(s)：调大 → 补怪更慢

// 出怪光点：最近传送门计算用临时量（_nearestPortal 内循环即消费，勿存引用）
const _portalTmp = new THREE.Vector3();

// 波次管理：分阶段生成（前→左右→全向），清空后触发抽卡
export class WaveManager {
  constructor(scene, balloons, getPlayerPos, dda, getPortals) {
    this.scene = scene;
    this.balloons = balloons;
    this.getPlayerPos = getPlayerPos;
    this.dda = dda || null;   // 动态难度控制器（DDA）；null 时 normalTest 走原时间曲线
    this.getPortals = getPortals || null; // () => game._portals；null 视为无门 → 直接 spawn
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
    this.facePhase = 0;             // 0=蓝, 1=红, 2=黑
    this.facePhaseTimer = 0;
    this.faceSubEntities = [];      // 当前阶段子实体（小怪/旗子/分身混合）
    this.faceFlags = [];            // 红阶段旗子引用
    this.faceOrbitAngle = 0;
    this.faceLaunchTimer = 0;
    this._blueSpawnedCount = 0;
    this._redSpawned = false;
    this._redPlaced = false;      // 红阶段旗子是否已移到 Boss 两侧（公转结束标记）
    this._cloneSpawnedCount = 0;
    this._pendingSpawns = [];   // 出怪光点队列 [{type,pos,from,dur,t,mesh,onSpawn,check,summonOwner,group}]
    this._bossQueued = false;   // Boss 已在排队（防重复排队刷光点）
  }

  // 本关剩余敌人数 = 尚未生成 + 场上存活 + 飞行中的光点（待落地怪）
  get remaining() {
    if (!this.level) return 0;
    return (this.total - this.spawned) + this._active;
  }

  // 场上存活 + 光点飞行中的待落地怪（所有占用判定用它，防光点未落地就连续补怪）
  get _active() { return this.balloons.count + this._pendingSpawns.length; }

  startLevel(level) {
    this.clearPending();       // 清残留光点 + _bossQueued（幂等）
    this.level = level;
    this.elapsed = 0;
    this.timer = 0;
    this.spawned = 0;
    this.cleared = false;
    this.bossSpawned = false;
    this.boss = null;
    this.spawnTimer = 0;
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
    do {
      const phase = phaseOverride ?? this._phase();
      let a;
      if (phase === 1) a = (-40 + Math.random() * 80) * Math.PI / 180;
      else if (phase === 2) a = (-110 + Math.random() * 220) * Math.PI / 180;
      else a = Math.random() * Math.PI * 2;
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
    // 脸谱 Boss（第6/18关 boss='face'）
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

  // ===== 脸谱 Boss（单 Boss 多阶段循环）=====
  // 蓝(10s)→红(10s)→黑(10s)→蓝... 每次变脸换位置+清子实体
  // Boss 3000HP、95%减伤；击杀子实体按百分比扣 Boss 血（绕过减伤）
  _spawnFaceBoss() {
    // 预加载所有脸谱模型 + 小怪模型
    for (const url of FACE_BOSS.MODELS) loadBalloonModel(url);
    loadBalloonModel(FACE_BOSS.FAN_MODEL);
    loadBalloonModel(ENEMY_TYPES.flagMask.model);
    // 蓝阶段 3×3 阵型只用 basic（两侧列）与 knight（中心列）
    loadBalloonModel(ENEMY_TYPES.basic.model);
    loadBalloonModel(ENEMY_TYPES.knight.model);

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
    else if (this.facePhase === 1) this._faceUpdateRed(dt, t);
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
  }

  // 蓝色阶段：0-2s 留空 → 2-4s 渐进召唤左右两侧各 3×3（中心格骑士、其余basic） → 4-15s 小怪冲锋 + Boss 摆动 + 子实体上下浮动
  _faceUpdateBlue(dt, t) {
    const b = this.faceBoss;
    const perSide = FACE_BOSS.BLUE_FORMATION_ROWS * FACE_BOSS.BLUE_FORMATION_COLS; // 单侧 9
    const total = perSide * 2;                                                     // 左右两侧共 18
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
            this.faceSubEntities.push(f);
            this.faceFlags.push(f);
          },
        });
      }
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
    // 放置后：Boss 静止，逐帧锁定未释放旗子的两侧站位（展示用）
    if (this._redPlaced && b && b.alive) {
      this.faceFlags.forEach((f, i) => {
        if (!f.alive || !this.balloons.list.includes(f) || f._flagLaunched || !f._flagPlaced) return;
        this._facePlaceRedFlag(f, i, b);
      });
    }
    // 8s 起：每间隔释放一批(2面)旗子一起飞向玩家
    if (t >= FACE_BOSS.RED_FLAG_LAUNCH_START) {
      this.faceLaunchTimer -= dt;
      if (this.faceLaunchTimer <= 0) {
        this.faceLaunchTimer = FACE_BOSS.RED_FLAG_LAUNCH_INTERVAL;
        let launched = 0;
        for (const f of this.faceFlags) {
          if (launched >= FACE_BOSS.RED_FLAG_LAUNCH_BATCH) break;
          if (f.alive && this.balloons.list.includes(f) && !f._flagLaunched) {
            f._flagLaunched = true;
            f.controlled = false;
            f.speed = FACE_BOSS.RED_FLAG_SPEED;
            launched++;
          }
        }
      }
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

    // 正常测试模式：升级式同屏出怪（boss 关不会走到这里，startLevel 已分流）
    if (this.mode === 'normalTest') {
      this._updateNormalTest(dt);
      return;
    }

    if (isBoss(this.level)) {
      if (!this.bossSpawned) this._spawnBoss();
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

  _updateNormalTest(dt) {
    this.elapsed += dt;

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
