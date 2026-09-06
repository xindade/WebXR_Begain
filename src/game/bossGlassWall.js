// 玻璃墙：4×8 网格立在 Boss 与玩家之间。
//  - 有效格(VALID_CELLS)闪烁：子弹命中 → 扣 Boss 血（onValidHit 回调），子弹被消耗
//  - 整面墙拦截子弹（BLOCK_ALL=true）：子弹命中任一格 → 被挡下（移除 + 火花），不伤 Boss
// tryBlock(bullet) 由 game.js 子弹循环调用；返回 true 表示子弹已被墙处理（消费/拦截）。
// 由 bossMagician.js 在「玻璃墙阶段」实例化，阶段结束 dispose。
import * as THREE from 'three';
import { MAGICIAN_BOSS } from '../core/constants.js';

export class BossGlassWall {
  constructor(scene, bossPos, playerPos, onValidHit) {
    this.scene = scene;
    this.onValidHit = onValidHit;       // (bulletDmg) => void（命中有效格扣 Boss 血）
    this._disposed = false;
    this._t = 0;
    const G = MAGICIAN_BOSS.GLASS_WALL;
    this.cols = G.COLS; this.rows = G.ROWS;
    this.cellW = G.CELL_W; this.cellH = G.CELL_H; this.gap = G.GAP;
    this.flashSpeed = G.FLASH_SPEED;
    this.blockAll = G.BLOCK_ALL;

    // 墙朝向：法线指向玩家（水平）
    const n = new THREE.Vector3().subVectors(playerPos, bossPos); n.y = 0;
    if (n.lengthSq() < 1e-6) n.set(0, 0, 1); else n.normalize();
    this.normal = n;
    this.right = new THREE.Vector3().crossVectors(n, new THREE.Vector3(0, 1, 0)).normalize();
    this.up = new THREE.Vector3(0, 1, 0);
    // 墙中心 = Boss 朝玩家方向 DIST 处（贴地）
    this.center = new THREE.Vector3().copy(bossPos).addScaledVector(n, G.DIST);
    this.center.y = 0;

    // 整面墙外框半宽/半高（用于整体拦截判定）
    this.halfW = (this.cols * this.cellW + (this.cols - 1) * this.gap) / 2;
    this.yBottom = G.Y_BASE - this.cellH / 2;
    this.yTop = G.Y_BASE + (this.rows - 1) * (this.cellH + this.gap) + this.cellH / 2;

    this.cells = [];
    this.group = new THREE.Group();
    this.scene.add(this.group);
    const validSet = new Set(G.VALID_CELLS.map(([r, c]) => r + ',' + c));
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const isValid = validSet.has(r + ',' + c);
        const lx = (c - (this.cols - 1) / 2) * (this.cellW + this.gap);
        const ly = G.Y_BASE + r * (this.cellH + this.gap);
        const world = new THREE.Vector3()
          .copy(this.center)
          .addScaledVector(this.right, lx)
          .addScaledVector(this.up, ly);
        const mat = new THREE.MeshBasicMaterial({
          color: isValid ? 0x44ff88 : 0x88ccff,
          transparent: true, opacity: isValid ? 0.35 : 0.18,
          side: THREE.DoubleSide, depthWrite: false,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(this.cellW, this.cellH), mat);
        mesh.position.copy(world);
        mesh.lookAt(world.clone().add(this.normal)); // 朝向玩家
        this.group.add(mesh);
        this.cells.push({ r, c, isValid, world, mesh, mat, halfW: this.cellW / 2, halfH: this.cellH / 2, lx, ly });
      }
    }
  }

  update(dt) {
    if (this._disposed) return;
    this._t += dt;
    const G = MAGICIAN_BOSS.GLASS_WALL;
    const k = (Math.sin(this._t * G.FLASH_SPEED * Math.PI * 2) + 1) / 2;
    for (const cell of this.cells) {
      if (cell.isValid) {
        cell.mat.opacity = 0.25 + 0.5 * k;
        cell.mat.color.setHex(k > 0.5 ? 0x66ffaa : 0x22cc66);
      }
    }
  }

  // 世界点 → 墙局部坐标（x=沿 right, y=沿 up, z=沿 normal）
  _toLocal(p) {
    const d = new THREE.Vector3().subVectors(p, this.center);
    return { x: d.dot(this.right), y: d.dot(this.up), z: d.dot(this.normal) };
  }

  // 子弹命中检测：线段(prevPos → pos) 是否穿过墙平面并落于墙范围内。
  // 返回 true 表示子弹已被处理（消费/拦截），game.js 应释放该子弹。
  tryBlock(bullet) {
    if (this._disposed) return false;
    const a = this._toLocal(bullet.prevPos);
    const b = this._toLocal(bullet.pos);
    if ((a.z < 0 && b.z < 0) || (a.z > 0 && b.z > 0)) return false; // 未穿越墙平面
    const denom = a.z - b.z;
    if (Math.abs(denom) < 1e-6) return false;
    const t = a.z / denom; // 与 z=0 平面交点参数
    if (t < 0 || t > 1) return false;
    const lx = a.x + (b.x - a.x) * t;
    const ly = a.y + (b.y - a.y) * t;
    // 整体拦截（外框）
    if (this.blockAll) {
      if (Math.abs(lx) > this.halfW || ly < this.yBottom || ly > this.yTop) return false;
    } else {
      // 仅无效格拦截：先找所在格
      const hit = this._cellAt(lx, ly);
      if (!hit || hit.isValid) return false; // 有效格不拦截（穿透由 Boss 代理承接）
    }
    // 命中具体格
    const cell = this._cellAt(lx, ly);
    if (cell && cell.isValid) this.onValidHit(bullet.dmg);
    return true; // 子弹被墙消费
  }

  _cellAt(lx, ly) {
    for (const cell of this.cells) {
      if (Math.abs(lx - cell.lx) <= cell.halfW && Math.abs(ly - cell.ly) <= cell.halfH) return cell;
    }
    return null;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.scene.remove(this.group);
    for (const cell of this.cells) { cell.mesh.geometry.dispose(); cell.mat.dispose(); }
    this.cells = [];
  }
}
