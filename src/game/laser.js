import * as THREE from 'three';
import { LASER } from '../core/constants.js';

// ============================================================
// 第三关「激光气球」关卡
// 移植自 F:\desk\Pico\功能验证\激光气球关卡.html
// - 双锥体（八面体）气球 + 核心/辉光/光晕三层激光束
// - 8 个气球（左列 posX / 右列 negX），按参考文档坐标生成
// 三阶段时间线：
//   1) 生成期(0~10s)：气球前7s一对对冒出，激光后3s一对对淡入（NPC空占位交待窗口）
//   2) 驱赶期(10s后)：气球从 z=-4.5 缓慢移到 z=2.5（速度 1/3），玩家自由移动
//   3) 搭关卡期：r1/r2/r3 把气球排成激光阵，玩家穿越到达底边过关
// - 玩家碰到气球实体或激光光束即死亡（生成期不致命）→ 本关重开
// - 玩家到达底边 (z <= LASER.GOAL_Z) 且在关卡搭建完成后即过关
// ============================================================

// ---- 模块级共享几何（不随 reset 销毁）----
function createDoublePyramidGeometry() {
  const v = new Float32Array([
    0, 1.5, 0,    // 顶点 (上)
    0, -1.5, 0,   // 顶点 (下)
    0, 0, 1,      // 腰 (前)
    1, 0, 0,      // 腰 (右)
    0, 0, -1,     // 腰 (后)
    -1, 0, 0,     // 腰 (左)
  ]);
  const idx = new Uint16Array([
    0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 2,    // 上锥 4 面
    1, 3, 2, 1, 4, 3, 1, 5, 4, 1, 2, 5,    // 下锥 4 面
  ]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}
const balloonGeo = createDoublePyramidGeometry();

// 参考文档 8 色（按 groups 索引）
const balloonColors = [
  0xff2222,  // [0] 左列·最底层 红
  0xff6600,  // [1] 左列·第二层 橙
  0xffcc00,  // [2] 左列·第三层 黄
  0x22dd22,  // [3] 左列·最顶层 绿
  0x22dddd,  // [4] 右列·最底层 青
  0x2266ff,  // [5] 右列·第二层 蓝
  0x8822ff,  // [6] 右列·第三层 紫
  0xff22ff,  // [7] 右列·最顶层 粉
];

const LASER_LEN = 16;             // 激光长度（缩放前）
const LASER_ATTACH_Y = -1.5 - LASER_LEN / 2; // -9.5，从气球底部向下延伸
const GROUP_SCALE = 0.25;         // 整体缩小倍数

// 参考文档坐标
const pos1 = { x: -2.5, z: -4.5 };  // 左列起始
const pos6 = { x: 2.5, z: -4.5 };   // 右列起始
const targetZ = 2.5;                // 发射后到达的 Z
const STACK = [2.0, 4.5, 7.0, 9.5]; // 四层气球 Y 高度

function easeInOut(p) {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}

// 点到线段最近距离
function distPointSegment(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 0 ? (apx * abx + apy * aby + apz * abz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + abx * t, cy = a.y + aby * t, cz = a.z + abz * t;
  const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// 创建单个激光气球组
function createGroup(dir, color) {
  dir = dir || 'negZ';
  const group = new THREE.Group();

  // -- 气球材质 --
  const mat = new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0, roughness: 0.12,
    transmission: 0.35, thickness: 0.4,
    clearcoat: 0.7, clearcoatRoughness: 0.05,
    ior: 1.15, specularIntensity: 1,
    side: THREE.DoubleSide,
    transparent: true, opacity: 0.88, depthWrite: false,
  });
  const balloonMesh = new THREE.Mesh(balloonGeo, mat);
  balloonMesh.renderOrder = 0;
  group.add(balloonMesh);
  balloonMesh.add(new THREE.LineSegments(
    new THREE.WireframeGeometry(balloonGeo),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 })
  ));

  // -- 三层激光（核心/辉光/光晕）--
  const layers = [
    { r: 0.012, key: 'core', mat: new THREE.MeshBasicMaterial({ color: 0xff3300, transparent: true, opacity: 1, toneMapped: false, depthWrite: false }) },
    { r: 0.05, key: 'glow', mat: new THREE.MeshBasicMaterial({ color: 0xff5500, transparent: true, opacity: 0.3, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending }) },
    { r: 0.14, key: 'halo', mat: new THREE.MeshBasicMaterial({ color: 0xff7700, transparent: true, opacity: 0.08, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending }) },
  ];
  let coreMat, glowMat, haloMat;
  for (const ll of layers) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(ll.r, ll.r, LASER_LEN, ll.key === 'core' ? 6 : 8), ll.mat);
    mesh.position.set(0, LASER_ATTACH_Y, 0);
    group.add(mesh);
    if (ll.key === 'core') coreMat = ll.mat;
    else if (ll.key === 'glow') glowMat = ll.mat;
    else haloMat = ll.mat;
  }

  // -- 方向旋转 --
  if (dir === 'posX') group.rotation.z = Math.PI / 2;     // 指向 +X
  else if (dir === 'negX') group.rotation.z = -Math.PI / 2; // 指向 -X
  else group.rotation.x = Math.PI / 2;

  group.scale.set(GROUP_SCALE, GROUP_SCALE, GROUP_SCALE);
  group.userData = { coreMat, glowMat, haloMat, balloonMesh, mat, dir };
  return group;
}

export class LaserLevel {
  constructor(scene, log = () => {}, mode = 'full') {
    this.scene = scene;
    this.log = log;
    this.mode = mode;          // 'full' = 第三关（生成→驱赶→搭阵）；'drive' = 第九关（生成→驱赶→保持原地→走格子）
    this.groups = [];
    this.npc = null;
    this.elapsed = 0;
    this.launch = { done: true, t: 0 };
    this.lethal = false;        // 生成期结束后才致命
    this.courseReady = false;   // 激光阵搭建完成后才允许过关
    this._announcedDrive = false;
    this.fading = false;        // 进入走格子阶段后激光气球淡出
    this.fadeT = 0;
    this.gridActive = false;    // 走格子阶段：停止致命，仅淡出
    this.r1 = { active: false, phase: 0, t: 0, y0: 0, y1: 0, y1t: 0 };
    this.r2 = { active: false, phase: 0, t: 0, z2: undefined, z3: undefined, x3: undefined };
    this.r3 = { active: false, phase: 0, t: 0, z4: undefined, x4: undefined, z5: undefined, z6: undefined, x6: undefined, z7: undefined };
  }

  start() {
    this.elapsed = 0;
    this.launch = { done: false, t: 0 };
    this.lethal = false;
    this.courseReady = false;
    this._announcedDrive = false;
    this.fading = false;
    this.fadeT = 0;
    this.gridActive = false;
    this.r1 = { active: false, phase: 0, t: 0, y0: 0, y1: 0, y1t: 0 };
    this.r2 = { active: false, phase: 0, t: 0, z2: undefined, z3: undefined, x3: undefined };
    this.r3 = { active: false, phase: 0, t: 0, z4: undefined, x4: undefined, z5: undefined, z6: undefined, x6: undefined, z7: undefined };

    // 时间门控：full 模式算搭阵三排时刻；drive 模式算「保持原地结束」时刻
    if (this.mode === 'full') {
      this.ROW1_AT = LASER.SPAWN_DELAY + LASER.LAUNCH_DUR + LASER.ROW1_DELAY;
      this.ROW2_AT = this.ROW1_AT + LASER.ROW2_DELAY;
      this.ROW3_AT = this.ROW2_AT + LASER.ROW3_DELAY;
    } else {
      // 生成(0-10) + 驱赶(10-16) + 保持原地(16-26) → 26s 后转入走格子
      this.HOLD_AT = LASER.SPAWN_DELAY + LASER.LAUNCH_DUR + LASER.HOLD_DUR;
    }

    // 生成期：气球/激光逐对出现的时刻表（一对 = 左右同高 2 个）
    this.balloonReveal = [];
    this.laserReveal = [];
    const nPairs = STACK.length;
    for (let k = 0; k < nPairs; k++) {
      this.balloonReveal.push({ at: (k * LASER.BALLOON_SPAWN) / nPairs, dur: 0.5 });
      this.laserReveal.push({ at: LASER.BALLOON_SPAWN + (k * LASER.LASER_SPAWN) / nPairs, dur: 0.5 });
    }

    // NPC 空占位（目前无模型/对话，预留交待窗口）
    if (!this.npc) {
      this.npc = new THREE.Group();
      this.npc.position.set(0, 1.4, -1.5);
      this.scene.add(this.npc);
    }

    this.groups = [];
    for (let si = 0; si < STACK.length; si++) {
      const g1 = createGroup('posX', balloonColors[si]);
      g1.position.set(pos1.x, STACK[si], pos1.z);
      g1.userData.baseY = STACK[si];
      g1.userData.startZ = pos1.z;
      g1.userData.targetZ = targetZ;
      g1.visible = false;            // 生成期逐对显形
      g1.scale.setScalar(0);
      g1.userData.beamReveal = 0;    // 激光逐对淡入
      g1.userData.revealed = false;
      this.scene.add(g1);
      this.groups.push(g1);

      const g6 = createGroup('negX', balloonColors[si + 4]);
      g6.position.set(pos6.x, STACK[si], pos6.z);
      g6.userData.baseY = STACK[si];
      g6.userData.startZ = pos6.z;
      g6.userData.targetZ = targetZ;
      g6.visible = false;
      g6.scale.setScalar(0);
      g6.userData.beamReveal = 0;
      g6.userData.revealed = false;
      this.scene.add(g6);
      this.groups.push(g6);
    }

    this.log('NPC 交待中…（10秒）激光气球就位');
  }

  reset() {
    this.dispose();
    this.start();
  }

  dispose() {
    if (this.npc) {
      this.scene.remove(this.npc);
      this.npc = null;
    }
    for (const g of this.groups) {
      this.scene.remove(g);
      g.traverse((o) => {
        if (o.isMesh) {
          // 不销毁共享的 balloonGeo
          if (o.geometry && o.geometry !== balloonGeo) o.geometry.dispose();
          if (o.material) o.material.dispose();
        }
      });
    }
    this.groups = [];
  }

  update(dt, playerPos) {
    void playerPos;
    this.elapsed += dt;
    const t = this.elapsed;

    // ====== 阶段1 生成期：气球一对对冒出 + 激光一对对淡入 ======
    if (t < LASER.SPAWN_DELAY) {
      this._updateSpawn(t);
    } else {
      this._ensureAllRevealed();
      if (!this._announcedDrive) {
        this._announcedDrive = true;
        this.log('气球就位，开始驱赶！');
      }
    }

    // ====== 阶段2 驱赶期：生成期结束后才缓慢移到另一端（速度 1/3）======
    if (t >= LASER.SPAWN_DELAY && !this.launch.done) {
      this.launch.t += dt;
      const p = Math.min(this.launch.t / LASER.LAUNCH_DUR, 1);
      const ep = easeInOut(p);
      for (const g of this.groups) {
        g.position.z = g.userData.startZ + (g.userData.targetZ - g.userData.startZ) * ep;
      }
      if (p >= 1) this.launch.done = true;
    }

    // ====== 阶段3：仅 full 模式搭阵（r1/r2/r3）；drive 模式跳过，气球保持原位 ======
    if (this.mode === 'full') {
      if (t >= this.ROW1_AT) this._activateR1();
      if (t >= this.ROW2_AT) this._activateR2();
      if (t >= this.ROW3_AT) this._activateR3();
      this._updateR1(dt);
      this._updateR2(dt);
      this._updateR3(dt);
    }

    // ====== 通用每帧更新 ======
    const FLOAT_AMP = (this.mode === 'drive' && this.launch.done) ? 0.12 : 0.3; // drive 保持期仅极轻浮动
    const FLOAT_FREQ = 0.8, SPIN_SPEED = 0.4, TILT_AMP = 0.15;
    const CORE_FREQ = 15, GLOW_FREQ = 6, HALO_FREQ = 3;
    for (let i = 0; i < this.groups.length; i++) {
      const g = this.groups[i];
      const d = g.userData;
      const skip = (this.r1.active && (i === 0 || i === 1)) ||
        (this.r2.active && (i === 2 || i === 3)) ||
        (this.r3.active && i >= 4);
      if (!skip) g.position.y = d.baseY + FLOAT_AMP * Math.sin(t * FLOAT_FREQ + i * 0.5);
      d.balloonMesh.rotation.y = t * SPIN_SPEED + i;
      d.balloonMesh.rotation.z = TILT_AMP * Math.sin(t * 0.3 + i * 0.5);
      const br = d.beamReveal ?? 1;   // 生成期内=0（激光不可见）
      d.coreMat.opacity = br * (0.65 + 0.35 * (0.5 + 0.5 * Math.sin(t * CORE_FREQ + i)));
      d.glowMat.opacity = br * (0.15 + 0.25 * (0.5 + 0.5 * Math.sin(t * GLOW_FREQ + i)));
      d.haloMat.opacity = br * (0.03 + 0.09 * (0.5 + 0.5 * Math.sin(t * HALO_FREQ + i)));
    }

    // ====== 进入走格子阶段后：激光气球淡出 ======
    if (this.fading) {
      this.fadeT += dt;
      const k = Math.max(0, 1 - this.fadeT / 1); // 1s 内缩到 0
      for (const g of this.groups) g.scale.setScalar(GROUP_SCALE * k);
      if (k <= 0) for (const g of this.groups) g.visible = false;
    }

    // ====== 致命 / 过关门控 ======
    // 走格子阶段（gridActive）停止致命；否则生成期不致命、10s 后致命
    if (!this.gridActive) this.lethal = t >= LASER.SPAWN_DELAY;
    this.courseReady = this.mode === 'full' ? (t >= this.ROW3_AT) : (t >= this.HOLD_AT);
  }

  // 进入走格子阶段：停止致命并启动激光气球淡出（由 game.js 在保持期结束后调用）
  enterGridPhase() {
    this.gridActive = true;
    this.lethal = false;
    this.fading = true;
    this.fadeT = 0;
  }

  // 生成期：逐对把气球缩放显形、激光淡入
  _updateSpawn(t) {
    const nPairs = this.balloonReveal.length;
    for (let k = 0; k < nPairs; k++) {
      const br = this.balloonReveal[k];
      const bp = Math.min(Math.max((t - br.at) / br.dur, 0), 1);
      const lr = this.laserReveal[k];
      const lp = Math.min(Math.max((t - lr.at) / lr.dur, 0), 1);
      const gL = this.groups[2 * k];
      const gR = this.groups[2 * k + 1];
      const ep = easeInOut(bp);
      for (const g of [gL, gR]) {
        if (bp > 0) {
          g.visible = true;
          const s = GROUP_SCALE * ep;
          g.scale.set(s, s, s);
          g.userData.revealed = bp >= 1;
        }
        g.userData.beamReveal = easeInOut(lp);
      }
    }
  }

  // 生成期结束后，确保全部气球/激光就位
  _ensureAllRevealed() {
    for (const g of this.groups) {
      g.visible = true;
      g.scale.set(GROUP_SCALE, GROUP_SCALE, GROUP_SCALE);
      g.userData.beamReveal = 1;
      g.userData.revealed = true;
    }
  }

  // ---------- 第一排 (0,1) 1号上升0.5m → 一起垂直振荡 ----------
  _activateR1() {
    if (this.r1.active) return;
    this.r1.active = true; this.r1.phase = 0; this.r1.t = 0;
    this.r1.y0 = this.groups[0].position.y;
    this.r1.y1 = this.groups[1].position.y;
    this.r1.y1t = this.r1.y1 + 0.5;
  }
  _updateR1(dt) {
    if (!this.r1.active) return;
    this.r1.t += dt;
    if (this.r1.phase === 0) {
      const p = Math.min(this.r1.t / 0.5, 1);
      this.groups[1].position.y = this.r1.y1 + (this.r1.y1t - this.r1.y1) * p;
      if (p >= 1) { this.r1.phase = 1; this.r1.t = 0; }
    } else if (this.r1.phase === 1) {
      const OSC_A1 = 1.5, OSC_P1 = 8;
      const osc = OSC_A1 * Math.sin(2 * Math.PI * this.r1.t / OSC_P1);
      this.groups[0].position.y = this.r1.y0 + osc;
      this.groups[1].position.y = this.r1.y1t + osc;
    }
  }

  // ---------- 第二排 (2,3) 移到 z=0.5 + 激光指向地面 + X 聚合 ----------
  _activateR2() {
    if (this.r2.active) return;
    this.r2.active = true; this.r2.phase = 0; this.r2.t = 0;
  }
  _updateR2(dt) {
    if (!this.r2.active) return;
    this.r2.t += dt;
    if (this.r2.phase === 0) {
      const p = Math.min(this.r2.t / 1, 1);
      const ep = easeInOut(p);
      if (this.r2.z2 === undefined) { this.r2.z2 = this.groups[2].position.z; this.r2.z3 = this.groups[3].position.z; this.r2.x3 = this.groups[3].position.x; }
      this.groups[2].position.z = this.r2.z2 + (0.5 - this.r2.z2) * ep;
      this.groups[3].position.z = this.r2.z3 + (0.5 - this.r2.z3) * ep;
      this.groups[3].position.x = this.r2.x3 + (2.5 - this.r2.x3) * ep;
      if (p >= 1) { this.r2.phase = 1; this.r2.t = 0; }
    } else if (this.r2.phase === 1) {
      const p = Math.min(this.r2.t / 0.5, 1);
      const ep = easeInOut(p);
      this.groups[2].rotation.z = Math.PI / 2 - ep * Math.PI / 2;
      this.groups[3].rotation.z = -Math.PI / 2 + ep * Math.PI / 2;
      if (p >= 1) { this.groups[2].rotation.z = 0; this.groups[3].rotation.z = 0; this.r2.phase = 2; this.r2.t = 0; }
    } else if (this.r2.phase === 2) {
      const AGG_P2 = 4;
      const p2 = (this.r2.t % AGG_P2) / AGG_P2;
      const tri = 1 - Math.abs(2 * p2 - 1);
      const AGG_R2 = 2.5;
      this.groups[2].position.x = -2.5 + AGG_R2 * tri;
      this.groups[3].position.x = 2.5 - AGG_R2 * tri;
    }
  }

  // ---------- 第三排 (4-7) 移到指定位置 + 振荡/聚合 ----------
  _activateR3() {
    if (this.r3.active) return;
    this.r3.active = true; this.r3.phase = 0; this.r3.t = 0;
  }
  _updateR3(dt) {
    if (!this.r3.active) return;
    this.r3.t += dt;
    if (this.r3.phase === 0) {
      const p = Math.min(this.r3.t / 1, 1);
      const ep = easeInOut(p);
      if (this.r3.z4 === undefined) { this.r3.z4 = this.groups[4].position.z; this.r3.x4 = this.groups[4].position.x; }
      if (this.r3.z6 === undefined) { this.r3.z6 = this.groups[6].position.z; this.r3.x6 = this.groups[6].position.x; }
      if (this.r3.z5 === undefined) this.r3.z5 = this.groups[5].position.z;
      if (this.r3.z7 === undefined) this.r3.z7 = this.groups[7].position.z;
      this.groups[4].position.z = this.r3.z4 + (-1.5 - this.r3.z4) * ep;
      this.groups[4].position.x = this.r3.x4 + (-2.5 - this.r3.x4) * ep;
      this.groups[4].position.y = 2 + (3 - 2) * ep;
      this.groups[6].position.z = this.r3.z6 + (-1.5 - this.r3.z6) * ep;
      this.groups[6].position.x = this.r3.x6 + (-2.5 - this.r3.x6) * ep;
      this.groups[6].position.y = 2 + (3 - 1) * ep;
      this.groups[5].position.z = this.r3.z5 + (-1.5 - this.r3.z5) * ep;
      this.groups[5].position.y = 4.5 + (3 - 4.5) * ep;
      this.groups[7].position.z = this.r3.z7 + (-1.5 - this.r3.z7) * ep;
      this.groups[7].position.y = 2 + (3 - 1) * ep;
      for (let i = 6; i <= 7; i++) this.groups[i].rotation.z = -Math.PI / 2 + ep * Math.PI / 2;
      if (p >= 1) { for (let i = 6; i <= 7; i++) this.groups[i].rotation.z = 0; this.r3.phase = 1; this.r3.t = 0; }
    } else if (this.r3.phase === 1) {
      const OSC_A3 = 1.5, OSC_P3 = 8;
      const osc45 = OSC_A3 * Math.sin(2 * Math.PI * this.r3.t / OSC_P3);
      this.groups[4].position.y = 3 + osc45;
      this.groups[5].position.y = 3 + osc45;
      const AGG_P3 = 4;
      const px = (this.r3.t % AGG_P3) / AGG_P3;
      const tri = 1 - Math.abs(2 * px - 1);
      const AGG_R3 = 2.5;
      this.groups[6].position.x = -2.5 + AGG_R3 * tri;
      this.groups[7].position.x = 2.5 - AGG_R3 * tri;
    }
  }

  // ---------- 命中检测：气球实体 + 激光光束 ----------
  hitTest(playerPos, playerRadius) {
    if (!this.lethal) return null; // 生成期不致命
    const pr = playerRadius ?? LASER.PLAYER_R;
    const _a = new THREE.Vector3();
    const _b = new THREE.Vector3();
    for (const g of this.groups) {
      g.updateWorldMatrix(true, false);
      // 气球实体
      g.getWorldPosition(_a);
      if (_a.distanceTo(playerPos) < LASER.BALLOON_R + pr) return g;
      // 激光光束（世界线段）
      _a.set(0, -1.5, 0).applyMatrix4(g.matrixWorld);  // 靠近气球一端
      _b.set(0, -17.5, 0).applyMatrix4(g.matrixWorld); // 远端
      if (distPointSegment(playerPos, _a, _b) < LASER.BEAM_LETHAL_R + pr) return g;
    }
    return null;
  }

  // ---------- 过关判定 ----------
  // full 模式：激光阵搭建完成且到达底边 z<=GOAL_Z
  // drive 模式：保持期结束（HOLD_AT）即视为可进入走格子阶段，不看玩家位置
  reachedGoal(playerPos) {
    if (this.mode === 'full') return this.courseReady && playerPos.z <= LASER.GOAL_Z;
    return this.courseReady;
  }
}
