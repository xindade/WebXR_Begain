// 第九关「玻璃走格子」：4×8=32 个玻璃格，编号 1–32，支持踩格检测 / 正确集 / 踩错破碎
// 仅在第 9 关（laserMode:'drive'）创建，离开或本关重开时销毁/重建。
import * as THREE from 'three';
import { GRID } from '../core/constants.js';

// 列中心 X（4 列）：左(-X) → 右(+X)
const COL_X = [-1.5, -0.5, 0.5, 1.5];
// 行中心 Z（8 行）：前(-Z) → 后(+Z)
const ROW_Z = [-3.5, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 3.5];
const BREAK_DUR = 0.5; // 破碎动画时长(s)

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
    const geo = new THREE.BoxGeometry(0.96, 0.08, 0.96);
    const mat = new THREE.MeshPhysicalMaterial({
      color: GRID.GLASS_COLOR,
      metalness: 0,
      roughness: 0.08,
      transmission: GRID.TRANSMISSION, // 玻璃透射
      thickness: 0.5,
      ior: 1.3,
      clearcoat: 0.8,
      clearcoatRoughness: 0.05,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide,
      emissive: new THREE.Color(GRID.GLASS_GLOW), // 保持原地期脉冲发光（默认不发光）
      emissiveIntensity: 0,
    });
    return new THREE.Mesh(geo, mat);
  }

  // 编号：平躺于格面正中心的平面（CanvasTexture），朝上可读、贴表面
  _makeNumMesh(n) {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 128;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, 128, 128);
    ctx.font = 'bold 80px sans-serif';
    ctx.fillStyle = '#eaffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), 64, 64);
    const tex = new THREE.CanvasTexture(cv);
    const geo = new THREE.PlaneGeometry(GRID.NUM_SIZE, GRID.NUM_SIZE);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2; // 平躺于 XZ 面，朝上可读
    m.renderOrder = 2;
    return m;
  }

  // 玩家世界坐标 → 格子编号 1..32；越界返回 0
  cellAt(p) {
    const col = Math.floor(p.x + 2); // x∈[-2,2) -> 0..3
    const row = Math.floor(p.z + 4); // z∈[-4,4) -> 0..7
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
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
  }
}
