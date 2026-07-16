import * as THREE from 'three';
import { FLIP } from '../core/constants.js';

// ============================================================
// 第十五关「九宫格翻转射击」谜题
// - 3×3 = 9 格组成竖直墙面，底边中心 (FLIP.BASE = 0,4,0)，每格 1m，整墙 3×3m（y=4~7）
// - 每格正反面各附一个气球：正面(朝玩家 +z) 白、反面(-z) 黑
// - 击破某格当前朝前气球 → 该格 + 上下左右相邻格一起绕 Y 轴翻转 180°（十字翻转）
// - 翻转动画 0.5s，期间所有参与格气球无敌
// - 胜利：9 格朝前气球全同色（全白或全黑）→ 无敌闪烁 1s 后消失
// 气球 mesh 从不销毁，翻转仅旋转 pivot + 切逻辑状态，天然满足"击破即重生"。
// ============================================================

// ---- 模块级共享几何（不随 reset 销毁）----
const balloonGeo = new THREE.SphereGeometry(FLIP.BALLOON_R, 20, 16);
const WHITE = { color: 0xffffff, roughness: 0.6, metalness: 0.0 };
const BLACK = { color: 0x111111, roughness: 0.6, metalness: 0.0 };
const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

export class FlipGrid {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.cells = [];           // 3×3
    this.victory = false;
    this.victoryT = 0;
    this.victoryDone = false;
    this._build();
    scene.add(this.group);
  }

  _build() {
    const xs = [-1, 0, 1], ys = [6.5, 5.5, 4.5];
    for (let r = 0; r < 3; r++) {
      this.cells[r] = [];
      for (let c = 0; c < 3; c++) {
        const pivot = new THREE.Group();
        pivot.position.set(xs[c], ys[r], 0);

        const flipped = FLIP.INITIAL[r][c] === 1; // 1=黑(初始朝玩家), 0=白
        const frontMat = new THREE.MeshStandardMaterial(WHITE); // 本地 +z 白
        const backMat  = new THREE.MeshStandardMaterial(BLACK);  // 本地 -z 黑
        const frontMesh = new THREE.Mesh(balloonGeo, frontMat);
        frontMesh.position.set(0, 0,  FLIP.BALLOON_OFFSET_Z);
        const backMesh = new THREE.Mesh(balloonGeo, backMat);
        backMesh.position.set(0, 0, -FLIP.BALLOON_OFFSET_Z);
        pivot.add(frontMesh, backMesh);
        this.group.add(pivot);

        this.cells[r][c] = {
          r, c, pivot, frontMesh, backMesh,
          rot: flipped ? Math.PI : 0,
          flipFrom: 0, flipTo: 0, flipT: undefined,
          flipped, invincible: false,
        };
        pivot.rotation.y = this.cells[r][c].rot;
      }
    }
  }

  // 当前朝向玩家、应被命中的那一面 mesh
  _frontMeshOf(cell) {
    // 未翻转：本地 +z 白球朝玩家；翻转后：本地 -z 黑球转到 +z 朝玩家
    return cell.flipped ? cell.backMesh : cell.frontMesh;
  }

  // 命中检测：遍历子弹，返回被击中的 {r,c} 或 null
  // 翻转中(invincible)的格跳过；胜利闪烁期间直接返回 null
  tryHit(bullet) {
    if (this.victory) return null;
    const wp = new THREE.Vector3();
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const cell = this.cells[r][c];
        if (cell.invincible) continue;
        const m = this._frontMeshOf(cell);
        m.getWorldPosition(wp);
        if (bullet.mesh.position.distanceTo(wp) < FLIP.HIT_R) {
          this.flip(r, c);
          return { r, c };
        }
      }
    }
    return null;
  }

  // 十字翻转：自身 + 上下左右相邻，各翻转 180°（0.5s），期间无敌
  flip(r, c) {
    const targets = [[r, c], [r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
    for (const [tr, tc] of targets) {
      if (tr < 0 || tr > 2 || tc < 0 || tc > 2) continue;
      const cell = this.cells[tr][tc];
      cell.flipped = !cell.flipped;     // 逻辑状态立即切换
      cell.flipFrom = cell.rot;
      cell.flipTo = cell.rot + Math.PI; // 连续累加，动画朝目标角
      cell.flipT = 0;
    }
  }

  // 胜利判定：所有格动画结束 + 全部 flipped 同值（首格为准）
  checkWin() {
    const first = this.cells[0][0].flipped;
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        const cell = this.cells[r][c];
        if (cell.flipT !== undefined) return false; // 仍有翻转动画 → 未定型
        if (cell.flipped !== first) return false;
      }
    return true;
  }

  beginVictory() {
    if (this.victory) return;
    this.victory = true;
    this.victoryT = 0;
    // 胜利期间全员无敌
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) this.cells[r][c].invincible = true;
  }

  update(dt) {
    // 1) 翻转动画推进
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const cell = this.cells[r][c];
        if (cell.flipT !== undefined) {
          cell.flipT += dt;
          const k = Math.min(1, cell.flipT / FLIP.FLIP_DUR);
          cell.rot = cell.flipFrom + (cell.flipTo - cell.flipFrom) * easeInOut(k);
          cell.pivot.rotation.y = cell.rot;
          if (k >= 1) {
            cell.rot = cell.flipTo;
            cell.pivot.rotation.y = cell.rot;
            cell.flipT = undefined;
          }
        }
        cell.invincible = cell.flipT !== undefined;
        // 翻转期间让当前朝前那面微微自发光，作为无敌反馈
        const m = this._frontMeshOf(cell);
        if (m.material.emissive) m.material.emissiveIntensity = cell.invincible ? 0.25 : 0;
      }
    }
    // 2) 胜利闪烁 1s 后消失
    if (this.victory) {
      this.victoryT += dt;
      this.group.visible = Math.floor(this.victoryT * 10) % 2 === 0; // ~10Hz 闪烁
      if (this.victoryT >= FLIP.VICTORY_DUR) {
        this.group.visible = false;
        this.victoryDone = true;
      }
    }
  }

  reset() {
    this.dispose();
    this.cells = [];
    this.victory = false; this.victoryT = 0; this.victoryDone = false;
    this._build();
    this.scene.add(this.group);
  }

  // 防泄漏写法：先摘除子节点再释放材质（几何 balloonGeo 为模块级共享，不可 dispose）
  dispose() {
    this.scene.remove(this.group);
    for (const o of [...this.group.children]) {
      this.group.remove(o);
      o.traverse((node) => {
        if (node.isMesh) {
          if (node.geometry && node.geometry !== balloonGeo) node.geometry.dispose();
          if (node.material) node.material.dispose(); // 每格独立材质，可安全释放
        }
      });
    }
  }
}
