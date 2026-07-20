import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/GLTFLoader.js';
import { DRACOLoader } from '../../vendor/DRACOLoader.js';
import { DRAGON, EXPLOSION } from '../core/constants.js';

// 第十二关「龙 Boss」
//   龙头 = Model/龙头.glb（沿 headPath 跟随移动，自动按包围盒缩放贴合龙身）
//   龙身/龙爪 = 由敌人气球组成（默认 basic，受 DragonBoss 逐帧接管位置 → controlled）
//   运动数据 = DRAGON.ANIM_URL 指向的 JSON（schemaVersion 2）
//     重建配方（见 JSON 内 reconstruction）：
//       1) 弧长 s 由 speed 推进，loop 模式对总弧长取模循环；跨过 pauses 的 s 时冻结 duration 秒并轻微晃动
//       2) 龙头位置：在 headPath 按累计弧长 s 线性插值
//       3) 身体第 i 节：按弧长 (s − i*bodySpacing) 取点 → 形成龙身/龙尾
//       4) 龙爪：在「第 CLAW_NODE 节」处取切向 T、法线 N = T × 上方向；左右爪 = 节点 ± N*clawSpread
//   坐标贴合：原始数据为「世界中心」右手系米制（范围 ±180m），经 SCALE 缩放 + HOME 平移到玩家前方战场。
//   换同格式动画 = 改 DRAGON.ANIM_URL 一行（一键套用）。

const D2R = THREE.MathUtils.degToRad;
const UP = new THREE.Vector3(0, 1, 0);

// 模块级临时量：消除 update 热循环里每帧 new Vector3 的 GC 压力（龙身/龙爪每帧多次采样）
const _wob = new THREE.Vector3();   // _toWorld 的悬停位移（每帧赋值）
const _lat = new THREE.Vector3();   // _undulate 的侧向向量（调用即消费，安全复用）

// ── 预览阶段预加载缓存（避免进第 12 关时黑屏/空等）──
let _animData = null;    // 龙动画 JSON（已解析）
let _headGltf = null;    // 龙头 GLB（已加载，跨关共享复用，dispose 时只摘除不释放）
let _preloadPromise = null;

// 预览阶段调用：加载龙关专属资产（动画 JSON + 龙头 GLB）。进第 12 关时直接命中缓存。
// onProgress(loaded, total) 报告 GLB 下载进度（JSON 体积小忽略不计）。
export function preloadDragonAssets(onProgress) {
  if (_preloadPromise) return _preloadPromise;
  _preloadPromise = (async () => {
    if (!_animData) {
      try {
        const res = await fetch(DRAGON.ANIM_URL);
        if (res.ok) _animData = await res.json();
      } catch (e) { console.warn('[DragonBoss] 预加载动画 JSON 失败:', e); }
    }
    if (!_headGltf) {
      const draco = new DRACOLoader();
      draco.setDecoderPath('vendor/draco/');
      const loader = new GLTFLoader();
      loader.setDRACOLoader(draco);
      _headGltf = await new Promise((resolve, reject) => {
        loader.load(
          DRAGON.HEAD_MODEL,
          (g) => resolve(g),
          (e) => onProgress && onProgress(e.loaded || 0, e.total || 1),
          (err) => reject(err)
        );
      });
    }
  })();
  return _preloadPromise;
}

// 归一化（手写，避免 new THREE.Vector3 的额外开销）
function _norm(v) {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

export class DragonBoss {
  constructor(scene, balloons) {
    this.scene = scene;
    this.balloons = balloons;          // BalloonManager（气球自动纳入碰撞/计分，每帧位置由本类接管）
    this.dead = false;
    this.cleared = false;
    this.aliveCount = 0;

    this.headGroup = new THREE.Group(); // 龙头挂载层（位置/朝向由本类逐帧设）
    this.scene.add(this.headGroup);
    this.headModel = null;
    this.headFitScale = 1;

    // 数据（_buildFromData 填充）
    this.config = null;
    this.path = [];                     // [{s,x,y,z}]
    this.total = 0;                     // 主路径总弧长
    this.center = new THREE.Vector3();  // headPath 包围盒中心（用于居中到 HOME）
    this.pauses = [];
    this.dScale = DRAGON.SCALE;

    // 全局刚体变换（绕 HOME 旋转整个龙：头+身+爪）
    this._rigQuat = new THREE.Quaternion();
    this._rigPos = new THREE.Vector3();
    this.loopTotal = 0;                 // 含闭合回程段的总弧长
    this.closingLen = 0;                // 首尾回程段长度

    // 运行状态
    this.s = 0;                         // 当前龙头弧长
    this.pauseTimer = 0;
    this.pauseWobble = 0;
    this.pauseElapsed = 0;
    this._wobbleY = 0;

    // 血量池（固定总血，只降不升：打爆即复活但「不回血」）
    this.maxHpPool = 0;
    this.hpPool = 0;
    this._respawns = [];                // 复活队列：{b, t}（t=剩余延迟秒）
    this.dying = false;                 // 死亡连爆阶段（冻结运动）
    this._finale = null;                // 死亡连爆状态机
    this._deathFx = [];                 // 连爆爆炸特效列表
    this.audio = null;                  // 由 game 注入（播放爆炸音效）
    this._t = 0;                        // 全局时间累加（波动/动画用）

    // 蛇形波动参数（来自 DRAGON，带默认）
    this._idleAmp = DRAGON.IDLE_AMP ?? 0.45;
    this._moveAmp = DRAGON.MOVE_AMP ?? 0.18;
    this._idleFreq = DRAGON.IDLE_FREQ ?? 2.2;
    this._phaseStep = DRAGON.PHASE_STEP ?? 0.55;

    // 部件（气球引用）
    this.bodyParts = [];                // [{balloon, i}]  i=1..bodyCount
    this.clawParts = [];                // [{balloon, side}] side=-1/+1
    this.allParts = [];                 // 全部龙气球（用于 alive 统计）
  }

  // 异步加载：解析 JSON → 生成气球 → 加载龙头模型（JSON/GLB 命中预览预加载缓存）
  async start() {
    try {
      await preloadDragonAssets();
      const data = _animData;
      if (data) this._buildFromData(data);
      this._spawnBalloons();
      this._loadHead();
    } catch (err) {
      console.error('[DragonBoss] 加载动画数据失败:', err);
      window.__pageLog?.error('[DragonBoss] 龙动画加载失败：' + (err?.message || err));
    }
  }

  _buildFromData(data) {
    this.config = data.config || {};
    this.pauses = Array.isArray(data.pauses) ? data.pauses : [];
    this.dScale = DRAGON.SCALE;
    const raw = data.headPath || [];
    this.path = raw.map((k) => ({ s: k.s, x: k.p[0], y: k.p[1], z: k.p[2] }));
    this.path.sort((a, b) => a.s - b.s);
    this.total = this.path.length ? this.path[this.path.length - 1].s : 0;
    // 包围盒中心 → 居中到 HOME
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const k of this.path) box.expandByPoint(v.set(k.x, k.y, k.z));
    box.getCenter(this.center);

    // 全局刚体旋转（YAW/PITCH/ROLL，顺序 Y→X→Z），头/身/爪一起绕 HOME 转
    const e = new THREE.Euler(D2R(DRAGON.PITCH), D2R(DRAGON.YAW), D2R(DRAGON.ROLL), 'YXZ');
    this._rigQuat.setFromEuler(e);
    this._rigPos.set(DRAGON.HOME.x, DRAGON.HOME.y, DRAGON.HOME.z);

    // 循环闭合：在末点(A)→首点(B)补一段「平滑回程」，让 loop 首尾完全连贯
    //   —— 回程用三次贝塞尔（控制臂沿 A、B 两端切向），保证 A、B 处切向连续，消除急转
    //   —— 龙身/龙爪按弧长取点时对 loopTotal 取模环绕，循环时不会在 B 点塌成一个点
    if (this.path.length >= 2) {
      const A = this.path[this.path.length - 1];
      const B = this.path[0];
      const prev = this.path[this.path.length - 2];
      const nxt = this.path[1];
      this.closingLen = Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z);
      this.loopTotal = this.total + this.closingLen;
      const Tend = _norm({ x: A.x - prev.x, y: A.y - prev.y, z: A.z - prev.z });   // A 处出射切向（最后一段方向）
      const Tstart = _norm({ x: nxt.x - B.x, y: nxt.y - B.y, z: nxt.z - B.z });   // B 处入射切向（第一段方向）
      const k = 1 / 3;
      this._close = {
        A: { x: A.x, y: A.y, z: A.z },
        P1: { x: A.x + Tend.x * this.closingLen * k, y: A.y + Tend.y * this.closingLen * k, z: A.z + Tend.z * this.closingLen * k },
        P2: { x: B.x - Tstart.x * this.closingLen * k, y: B.y - Tstart.y * this.closingLen * k, z: B.z - Tstart.z * this.closingLen * k },
        B: { x: B.x, y: B.y, z: B.z },
      };
    } else {
      this.closingLen = 0;
      this.loopTotal = this.total;
      this._close = null;
    }

    // 初始：龙头从「路径起点稍前方」开始，龙身沿路径向后铺满 → 龙一开始就摆好形状（不再从一点冒出）
    const bodyCount = this.config.bodyCount || 10;
    const bodySpacing = this.config.bodySpacing || 10;
    this.s = Math.min(this.total, bodyCount * bodySpacing);
  }

  // 原始坐标(raw) → 世界坐标：以包围盒中心为锚，缩放 → 全局刚体旋转 → 平移到 HOME（+ 暂停晃动）
  _toWorld(raw) {
    const off = new THREE.Vector3(
      raw.x - this.center.x,
      raw.y - this.center.y,
      raw.z - this.center.z
    ).multiplyScalar(this.dScale);
    off.applyQuaternion(this._rigQuat); // 全局刚体旋转（YAW/PITCH/ROLL）
    _wob.set(0, this._wobbleY, 0);
    return off.add(this._rigPos).add(_wob);
  }

  // 取 raw 空间某「单位方向」经全局刚体变换后的世界单位方向（用于龙爪法线方向）
  _worldOffsetDir(baseRaw, unitRaw) {
    const base = this._toWorld(baseRaw);
    const tip = this._toWorld({ x: baseRaw.x + unitRaw.x, y: baseRaw.y + unitRaw.y, z: baseRaw.z + unitRaw.z });
    return tip.sub(base).normalize();
  }

  // 按累计弧长取点：对 loopTotal 取模环绕（龙身/龙爪在循环首尾也连续），含闭合回程段
  _sample(arc) {
    const L = this.loopTotal || this.total;
    // 环绕到 [0, L) —— 负弧长接到回程段末尾，超长环绕回开头，循环时龙不会塌成一点
    let a = arc;
    if (a < 0) a = ((a % L) + L) % L;
    else if (a >= L) a = a % L;
    const path = this.path;
    if (path.length === 0) return { x: 0, y: 0, z: 0 };
    if (a <= this.total) {
      // —— 主路径线性插值 ——
      let i = 0;
      while (i < path.length - 1 && path[i + 1].s < a) i++;
      const A = path[i];
      const B = path[Math.min(i + 1, path.length - 1)];
      const span = (B.s - A.s) || 1;
      const t = Math.max(0, Math.min(1, (a - A.s) / span));
      return {
        x: A.x + (B.x - A.x) * t,
        y: A.y + (B.y - A.y) * t,
        z: A.z + (B.z - A.z) * t,
      };
    }
    // —— 闭合回程段：三次贝塞尔(A→B)，在 A、B 处切向与主路径连续（无急转）——
    if (this._close) {
      const u = this.closingLen > 0 ? (a - this.total) / this.closingLen : 0;
      const mu = 1 - u;
      const w0 = mu * mu * mu, w1 = 3 * mu * mu * u, w2 = 3 * mu * u * u, w3 = u * u * u;
      const c = this._close;
      return {
        x: w0 * c.A.x + w1 * c.P1.x + w2 * c.P2.x + w3 * c.B.x,
        y: w0 * c.A.y + w1 * c.P1.y + w2 * c.P2.y + w3 * c.B.y,
        z: w0 * c.A.z + w1 * c.P1.z + w2 * c.P2.z + w3 * c.B.z,
      };
    }
    // 退化兜底：A→B 直线
    const last = path[path.length - 1];
    const first = path[0];
    const u = this.closingLen > 0 ? (a - this.total) / this.closingLen : 0;
    return {
      x: last.x + (first.x - last.x) * u,
      y: last.y + (first.y - last.y) * u,
      z: last.z + (first.z - last.z) * u,
    };
  }

  // 弧长处的单位切向
  _tangent(arc) {
    const d = Math.max(1, this.total * 0.002);
    const a = this._sample(arc - d);
    const b = this._sample(arc + d);
    const t = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
    if (t.lengthSq() < 1e-9) t.set(0, 0, 1);
    return t.normalize();
  }

  _spawnBalloons() {
    const bodyCount = this.config.bodyCount || 10;
    const hpMult = DRAGON.HP_MULT;

    // 龙身
    for (let i = 1; i <= bodyCount; i++) {
      const b = this.balloons.spawn(DRAGON.BODY_TYPE, new THREE.Vector3(0, -999, 0));
      b.controlled = true; // 跳过自动朝玩家移动 + 分离力
      b.isDragonPart = true; // 标记为龙部件：击破后由本类管理「1秒复活」而非永久移除
      if (hpMult !== 1) { b.maxHp = Math.round(b.maxHp * hpMult); b.hp = b.maxHp; }
      // 龙身由头(i=1)到尾(i=bodyCount)渐细：仅改外观(bodyModel.scale)，不影响碰撞半径
      const taper = 1.4 - 0.9 * ((i - 1) / Math.max(1, bodyCount - 1));
      if (b.bodyModel) b.bodyModel.scale.setScalar(taper);
      this.maxHpPool += b.maxHp;
      this.bodyParts.push({ balloon: b, i });
      this.allParts.push(b);
    }

    // 龙爪（每个挂点 CLAW_NODES 左右各1爪 → 默认 [3,7] 共4爪）
    const clawNodes = Array.isArray(DRAGON.CLAW_NODES) ? DRAGON.CLAW_NODES : [DRAGON.CLAW_NODE];
    for (const node of clawNodes) {
      for (const side of [-1, 1]) {
        const b = this.balloons.spawn(DRAGON.CLAW_TYPE, new THREE.Vector3(0, -999, 0));
        b.controlled = true;
        b.isDragonPart = true;
        if (hpMult !== 1) { b.maxHp = Math.round(b.maxHp * hpMult); b.hp = b.maxHp; }
        this.maxHpPool += b.maxHp;
        this.clawParts.push({ balloon: b, side, node });
        this.allParts.push(b);
      }
    }

    this.hpPool = this.maxHpPool; // 固定总血量池（只降不升）
    this.aliveCount = this.allParts.length;
  }

  _loadHead() {
    // 命中预览预加载缓存：直接复用已加载的 GLB（不重复下载/解码）
    if (_headGltf) {
      this.headModel = _headGltf.scene;
      this._fitHead();
      this.headGroup.add(this.headModel);
      return;
    }
    // 兜底：未预加载时异步加载（含红色线框占位，便于上机确认路径正确）
    const draco = new DRACOLoader();
    draco.setDecoderPath('vendor/draco/');
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    loader.load(
      DRAGON.HEAD_MODEL,
      (gltf) => {
        this.headModel = gltf.scene;
        this._fitHead();
        this.headGroup.add(this.headModel);
      },
      undefined,
      (err) => {
        console.error('[DragonBoss] 龙头模型加载失败:', err);
        window.__pageLog?.error('[DragonBoss] 龙头加载失败：' + (err?.message || err));
        // 红色线框占位，便于上机确认路径正确
        const m = new THREE.Mesh(
          new THREE.SphereGeometry(0.6, 12, 10),
          new THREE.MeshBasicMaterial({ color: 0xe63946, wireframe: true })
        );
        this.headGroup.add(m);
      }
    );
  }

  // 自动按包围盒缩放：使龙头直径 ≈ 2 * headRadius * SCALE（与龙身尺寸一致）
  _fitHead() {
    const box = new THREE.Box3().setFromObject(this.headModel);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const desiredDiameter = 2 * (this.config.headRadius || 10) * this.dScale;
    this.headFitScale = desiredDiameter / maxDim;
    this.headModel.scale.setScalar(this.headFitScale * DRAGON.HEAD_SCALE);
  }

  update(dt, playerPos) {
    if (this.dead || !this.config) return;
    this._t += dt;

    // —— 死亡连爆阶段：冻结运动，只跑连爆动画 ——
    if (this.dying) {
      this._updateFinale(dt);
      this._updateDeathFx(dt);
      return;
    }

    // —— 推进弧长（含 pause 冻结）——
    if (this.pauseTimer > 0) {
      this.pauseTimer -= dt;
      this.pauseElapsed += dt;
    } else {
      this.pauseElapsed = 0;
      const next = this.s + (this.config.speed || 180) * dt;
      let crossed = false;
      for (const p of this.pauses) {
        if (this.s < p.s && next >= p.s) {
          this.s = p.s;
          this.pauseTimer = p.duration || 0;
          this.pauseWobble = p.wobble || 0;
          crossed = true;
          break;
        }
      }
      if (!crossed) this.s = next % this.loopTotal;
    }

    // 暂停/待机时波动幅度更大（呼吸感），移动时保留细微流动
    const amp = this.pauseTimer > 0 ? this._idleAmp : this._moveAmp;

    // —— 复活计时（外形复活，不回血）——
    // 必须放在「位置更新循环」之前：刚复活的龙气球在本帧就会被下方 body/claw 循环
    // 摆到当前龙身正确位置，否则会先以「死亡原地」闪现一帧 → 玩家看到原地残影。
    for (let k = this._respawns.length - 1; k >= 0; k--) {
      const r = this._respawns[k];
      r.t -= dt;
      if (r.t <= 0) {
        r.b.alive = true;
        r.b.hp = r.b.maxHp;
        r.b.mesh.visible = true;
        r.b._flash = 0;
        this._respawns.splice(k, 1);
      }
    }

    // —— 龙头（极轻微 idle 浮沉，不放大波动，避免龙头「飘」）——
    const headRaw = this._sample(this.s);
    if (this.headModel) {
      const headBob = 0.06 * Math.sin(this._t * 1.5);
      const headPos = this._toWorld(headRaw);
      headPos.y += headBob;
      this.headGroup.position.copy(headPos);
      const t = this._tangent(this.s);
      const ahead = this._toWorld({ x: headRaw.x + t.x, y: headRaw.y + t.y, z: headRaw.z + t.z });
      ahead.y += headBob;
      this.headGroup.lookAt(ahead);
      this.headGroup.rotateY(D2R(DRAGON.HEAD_YAW)); // 若龙头朝向与前进方向相反，把 HEAD_YAW 改成 180
    }

    // —— 龙身（蛇形波动，替换原整体上下平移）——
    const bodySpacing = this.config.bodySpacing || 10;
    for (const part of this.bodyParts) {
      if (!part.balloon.alive) continue;
      const arc = this.s - part.i * bodySpacing;   // 负弧长由 _sample 取模环绕 → 循环时龙身连续
      const base = this._toWorld(this._sample(arc));
      const tan = this._tangent(arc);
      base.add(this._undulate(part.i, tan, amp));
      part.balloon.mesh.position.copy(base);
    }

    // —— 龙爪：每个挂点(node)处，沿世界法线左右偏移 + 同样蛇形波动 ——
    const clawSpread = this.config.clawSpread || 6;
    for (const part of this.clawParts) {
      if (!part.balloon.alive) continue;
      const nodeArc = this.s - part.node * bodySpacing;   // 取模环绕，与龙身一致
      const nodeRaw = this._sample(nodeArc);
      const t = this._tangent(nodeArc);
      const Nraw = new THREE.Vector3(-t.z, 0, t.x); // T × up（raw 空间单位法线）
      if (Nraw.lengthSq() < 1e-9) Nraw.set(1, 0, 0);
      Nraw.normalize();
      const Nworld = this._worldOffsetDir(nodeRaw, Nraw); // 经全局刚体旋转后的世界法线
      const nodeWorld = this._toWorld(nodeRaw);
      nodeWorld.addScaledVector(Nworld, part.side * clawSpread * this.dScale);
      nodeWorld.add(this._undulate(part.node, t, amp));
      part.balloon.mesh.position.copy(nodeWorld);
    }

    // —— 通关判定：仅死亡连爆结束后由 _updateFinale 置 cleared（打爆即复活，故不以全灭判定）——
    let alive = 0;
    for (const b of this.allParts) if (b.alive) alive++;
    this.aliveCount = alive;
  }

  // 蛇形波动偏移：沿龙身流动的侧向摆动 + 轻微起伏（世界空间）
  //   phaseIdx = 节号（i / node），tangentWorld = 该处单位切向，amp = 当前幅度
  _undulate(phaseIdx, tangentWorld, amp) {
    _lat.crossVectors(tangentWorld, UP);
    if (_lat.lengthSq() < 1e-6) _lat.set(1, 0, 0); else _lat.normalize(); // 切向近竖直时兜底
    const phase = phaseIdx * this._phaseStep;
    const a = Math.sin(this._t * this._idleFreq + phase) * amp;          // 侧向摆动
    const b = Math.sin(this._t * this._idleFreq * 0.8 + phase) * amp * 0.4; // 轻微起伏
    const off = _lat.multiplyScalar(a);
    off.addScaledVector(UP, b);
    return off; // 注：返回 _lat 本身，调用方(base.add)立即消费，无跨调用别名风险
  }

  // 龙气球被击破：扣固定血量池（只降不升），排入 1 秒复活队列；血量清零则触发死亡连爆
  notifyKilled(balloon) {
    if (this.dying) return;
    this.hpPool -= balloon.maxHp;
    this._respawns.push({ b: balloon, t: DRAGON.RESPAWN_DELAY ?? 1.0 });
    if (this.hpPool <= 0) this._startDeath();
  }

  // 血量清零 → 进入死亡连爆阶段（冻结运动）
  _startDeath() {
    this.dying = true;
    // 顺序：龙尾(i 大) → 龙头(i 小)，最后龙爪
    const order = [...this.bodyParts]
      .sort((a, b) => b.i - a.i)
      .map((p) => p.balloon)
      .concat(this.clawParts.map((p) => p.balloon));
    this._finale = {
      queue: order,
      idx: 0,
      timer: 0,
      interval: DRAGON.FINALE_INTERVAL ?? 0.07,
      done: 0,
    };
  }

  // 死亡连爆：从尾到头逐个爆炸；全部炸完后等最后一发特效播完，再置 cleared（选项卡随后才弹）
  _updateFinale(dt) {
    const f = this._finale;
    if (!f) return;
    f.timer -= dt;
    while (f.idx < f.queue.length && f.timer <= 0) {
      const b = f.queue[f.idx];
      if (b && b.mesh.visible) {
        this._spawnDeathFx(b.mesh.position.clone(), b.radius);
        b.alive = false;
        b.mesh.visible = false;
        this.audio?.playPop();
      }
      f.idx++;
      f.timer += f.interval;
    }
    if (f.idx >= f.queue.length) {
      f.done += dt;
      if (f.done >= EXPLOSION.DURATION) {
        this.headGroup.visible = false; // 龙头也炸完 → 消失
        this.cleared = true;            // 触发 game._enterCard（选项卡）
        // 清理残留特效，避免进入选项卡后还残留冻结的爆炸球
        for (const fx of [...this._deathFx]) {
          this.scene.remove(fx.mesh);
          fx.mesh.geometry.dispose();
          fx.mesh.material.dispose();
        }
        this._deathFx = [];
      }
    }
  }

  // 连爆专用爆炸特效（与 game._spawnExplosionFx 同款，避免反向依赖 game）
  _spawnDeathFx(position, radius) {
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
    this.scene.add(mesh);
    this._deathFx.push({ mesh, t: 0 });
  }

  _updateDeathFx(dt) {
    for (const fx of [...this._deathFx]) {
      fx.t += dt;
      const k = Math.min(1, fx.t / EXPLOSION.DURATION);
      fx.mesh.scale.setScalar(1 + k * EXPLOSION.MAX_SCALE);
      fx.mesh.material.opacity = EXPLOSION.START_OPACITY * (1 - k);
      if (k >= 1) {
        this.scene.remove(fx.mesh);
        fx.mesh.geometry.dispose();
        fx.mesh.material.dispose();
        const i = this._deathFx.indexOf(fx);
        if (i !== -1) this._deathFx.splice(i, 1);
      }
    }
  }

  dispose() {
    this.dead = true;
    // 移除全部龙气球（避免残留隐藏气球进入下一关的 waves）
    for (const b of [...this.allParts]) {
      if (b.isDragonPart) this.balloons.remove(b);
    }
    // 清理连爆特效
    for (const fx of [...this._deathFx]) {
      this.scene.remove(fx.mesh);
      fx.mesh.geometry.dispose();
      fx.mesh.material.dispose();
    }
    this._deathFx = [];
    this._respawns = [];
    this._finale = null;
    this.dying = false;
    this.cleared = false;

    // 移除龙头：龙头模型是预览预加载的共享缓存（_headGltf），只从 headGroup 摘下，
    // 不 dispose 其几何/材质（否则重玩第 12 关时缓存已失效），由缓存自行跨关复用。
    this.scene.remove(this.headGroup);
    if (this.headModel) this.headGroup.remove(this.headModel);
    this.headModel = null;
    this.headGroup.visible = true;
    this.bodyParts = [];
    this.clawParts = [];
    this.allParts = [];
  }
}
