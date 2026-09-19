// 第九关「玻璃走格子」：4×8=32 个玻璃格，编号 1–32，支持踩格检测 / 正确集 / 踩错破碎
// 仅在第 9 关（laserMode:'drive'）创建，离开或本关重开时销毁/重建。
import * as THREE from 'three';
import { GRID, MOVE } from '../core/constants.js';
import { makeTextTexture } from '../core/canvasTexture.js';

// 列/行中心由玩家移动边界 MOVE.BOUND_* 与行列数派生：改边界自动适配网格，消除配置漂移
const COL_W = (2 * MOVE.BOUND_X) / GRID.COLS; // 每列宽 (m)
const ROW_W = (2 * MOVE.BOUND_Z) / GRID.ROWS; // 每行宽 (m)
const COL_X = Array.from({ length: GRID.COLS }, (_, c) => -MOVE.BOUND_X + (c + 0.5) * COL_W);
const ROW_Z = Array.from({ length: GRID.ROWS }, (_, r) => -MOVE.BOUND_Z + (r + 0.5) * ROW_W);
const BREAK_DUR = 0.5; // 破碎动画时长(s)

// ---- 模块级共享资源（不随 reset/重建销毁，避免死亡重开反复分配几何、反复上传 32 张编号纹理到 GPU）----
const cellGeo = new THREE.BoxGeometry(0.96, 0.08, 0.96);          // 所有格子尺寸一致，可共享
const numGeo  = new THREE.PlaneGeometry(GRID.NUM_SIZE, GRID.NUM_SIZE);
const numTexCache = new Map();                                    // 编号纹理 1..32 仅首次创建，永久复用
function numTexture(n) {
  if (!numTexCache.has(n)) {
    numTexCache.set(n, makeTextTexture({ text: String(n), font: 'bold 80px sans-serif', color: '#eaffff', width: 128, height: 128 }));
  }
  return numTexCache.get(n);
}

export class GlassGrid {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.cells = {};                 // index(1..32) -> { index,x,z,mesh,numMesh,broken,_breakT }
    this.correct = new Set();        // 安全格编号（由 setCorrect 指定）
    this.visited = new Set();
    this.winCell = 0;                // 走到此格通关（由 setCorrect 指定）
    this._t = 0;                     // 累积时间，用于发光脉冲
    this._build();
    scene.add(this.group);
  }

  _build() {
    let n = 0;
    for (let row = 0; row < GRID.ROWS; row++) {
      for (let col = 0; col < GRID.COLS; col++) {
        n++;
        const x = COL_X[col];
        const z = ROW_Z[row];
        const mesh = this._makeCell();
        mesh.position.set(x, GRID.Y, z);
        this.group.add(mesh);
        const numMesh = this._makeNumMesh(n);
        numMesh.position.set(x, GRID.Y + GRID.NUM_Y_OFFSET, z);
        this.group.add(numMesh);
        this.cells[n] = { index: n, x, z, mesh, numMesh, broken: false, _breakT: undefined };
      }
    }
  }

  _makeCell() {
    // 玻璃外观用「半透明 + clearcoat 高光」模拟；故意去掉 transmission/thickness/ior：
    // MeshPhysicalMaterial.transmission>0 会强制每帧多做一次全场景透射渲染 pass，
    // 32 个格子叠加让第九关走格子阶段帧率只剩普通关一半。空场景里折射几乎无可见差异，却极费。
    const mat = new THREE.MeshPhysicalMaterial({
      color: GRID.GLASS_COLOR,
      metalness: 0,
      roughness: 0.12,
      clearcoat: 0.6,
      clearcoatRoughness: 0.1,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide,
      emissive: new THREE.Color(GRID.GLASS_GLOW), // 保持原地期脉冲发光（默认不发光）
      emissiveIntensity: 0,
    });
    return new THREE.Mesh(cellGeo, mat);
  }

  // 编号：平躺于格面正中心的平面，复用共享几何与共享编号纹理（朝上可读、贴表面）
  _makeNumMesh(n) {
    const mat = new THREE.MeshBasicMaterial({ map: numTexture(n), transparent: true, depthWrite: false });
    const m = new THREE.Mesh(numGeo, mat);
    m.rotation.x = -Math.PI / 2; // 平躺于 XZ 面，朝上可读
    m.renderOrder = 2;
    return m;
  }

  // 玩家世界坐标 → 格子编号 1..32；越界返回 0
  cellAt(p) {
    const col = Math.floor((p.x + MOVE.BOUND_X) / COL_W); // x∈[-BOUND_X,BOUND_X) -> 0..COLS-1
    const row = Math.floor((p.z + MOVE.BOUND_Z) / ROW_W); // z∈[-BOUND_Z,BOUND_Z) -> 0..ROWS-1
    if (col < 0 || col >= GRID.COLS || row < 0 || row >= GRID.ROWS) return 0;
    return row * GRID.COLS + col + 1;
  }

  // 玩家踏上一个格子：返回 'correct' | 'wrong' | 'win' | 'neutral'
  onEnter(idx) {
    const c = this.cells[idx];
    if (!c || c.broken) return 'neutral';
    if (this.correct.has(idx)) {
      c.visited = true;
      this.visited.add(idx);
      return idx === this.winCell ? 'win' : 'correct'; // 正确格安全；通关格 = cell 3
    }
    return 'wrong'; // 非正确格 = 踩错
  }

  // 指定安全格集合与通关格
  setCorrect(arr, winCell) {
    this.correct = new Set(arr);
    this.winCell = winCell ?? GRID.WIN_CELL;
    this.visited.clear();
  }

  // 标记某格破碎（启动破碎动画）
  breakCell(idx) {
    const c = this.cells[idx];
    if (!c || c.broken) return;
    c.broken = true;
    c._breakT = 0;
  }

  // 每帧：发光脉冲（仅保持原地期）+ 破碎动画推进
  update(dt, glow = false) {
    this._t += dt;
    // 正确格发光：hold 阶段脉冲，其余阶段熄灭
    const pulse = 0.2 + 0.8 * (0.5 + 0.5 * Math.sin(this._t * 6));
    for (const idx of this.correct) {
      const c = this.cells[idx];
      if (c && c.mesh.material) c.mesh.material.emissiveIntensity = glow ? pulse : 0;
    }
    // 破碎动画
    for (const key in this.cells) {
      const c = this.cells[key];
      if (c.broken && c._breakT !== undefined && c._breakT < BREAK_DUR) {
        c._breakT += dt;
        const k = Math.max(0, 1 - c._breakT / BREAK_DUR);
        c.mesh.scale.set(k, k, k);
        c.mesh.position.y = GRID.Y - (1 - k) * 0.6; // 下落
        if (c.mesh.material) c.mesh.material.opacity = 0.55 * k;
        if (c.numMesh.material) c.numMesh.material.opacity = k;
        if (k <= 0) { c.mesh.visible = false; c.numMesh.visible = false; }
      }
    }
  }

  reset() {
    this.dispose();
    this.cells = {};
    this.visited.clear();
    this._build();
    this.scene.add(this.group);
  }

  dispose() {
    this.scene.remove(this.group);
    // 关键：必须先摘除子节点再释放 GPU 资源，否则 reset() 复用同一 group 重建时，
    // 残留的旧 mesh 节点会累积在 group 里被持续渲染 —— 每次死亡重开渲染负载翻倍（帧率暴跌）。
    for (const o of [...this.group.children]) {
      this.group.remove(o);
      o.traverse((c) => {
        if (c.isMesh && c.material) c.material.dispose(); // 几何/纹理为模块级共享，不可 dispose
      });
    }
  }
}
