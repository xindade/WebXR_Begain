import * as THREE from 'three';
import { SHURIKEN } from '../core/constants.js';

// ==================== 手里剑（忍者气球投掷物） ====================
// 低多边形 4 角星（掷星），由忍者气球在头顶生成、射向玩家；命中扣飞船血量(player.takeDamage)。
// 全局冷却由 BalloonManager 统一控制：到点只让最靠近玩家的一个忍者投掷（满足「唯一投掷者」需求）。
// 这里只负责单发手里剑的几何/飞行/自旋/命中回收，不关心冷却与「谁投」。

// 共享几何：模块级只建一次，所有手里剑实例复用（避免每发 new 几何的 GC 压力）。
function _buildShurikenGeometry() {
  const R = SHURIKEN.SIZE;     // 外接半径(米)
  const r = R * 0.40;          // 内凹半径(米)：尖角之间的凹口
  const shape = new THREE.Shape();
  const n = 4;                 // 4 角星
  for (let i = 0; i < n * 2; i++) {
    // 偏移 π/n 使一个尖角正朝上(+Y 投影平面)，视觉对称
    const ang = (i / (n * 2)) * Math.PI * 2 + Math.PI / n;
    const rad = (i % 2 === 0) ? R : r;
    const x = Math.cos(ang) * rad;
    const y = Math.sin(ang) * rad;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  // 中心圆孔（减重感，更像真掷星）
  const hole = new THREE.Path();
  hole.absarc(0, 0, R * 0.16, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: R * 0.22, bevelEnabled: true,
    bevelThickness: R * 0.04, bevelSize: R * 0.04, bevelSegments: 1, steps: 1,
  });
  geo.center(); // 居中：旋转轴落在几何中心，自旋才自然
  return geo;
}

// 共享材质：低多边形金属感（flatShading），略带自发光以便在暗场景可见
const _shurikenMat = new THREE.MeshStandardMaterial({
  color: 0x9aa3ad, metalness: 0.9, roughness: 0.35,
  emissive: 0x223344, emissiveIntensity: 0.25, flatShading: true,
});

export class ShurikenManager {
  constructor(scene) {
    this.scene = scene;
    this.list = [];          // 飞行中的手里剑实例
    this._onHit = null;      // 命中回调：(dmg) => void
    this._audio = null;      // 音效管理器（注入）
    this._geo = _buildShurikenGeometry();
    this._mat = _shurikenMat;
    this._dir = new THREE.Vector3(); // 复用临时量
  }

  setOnHit(fn) { this._onHit = fn; }
  setAudio(a) { this._audio = a; }

  // originPos：忍者气球世界坐标；targetPos：玩家世界坐标（多为头部/rig 位置）
  spawn(originPos, targetPos) {
    const mesh = new THREE.Mesh(this._geo, this._mat);
    // 头顶 1 米生成
    mesh.position.set(originPos.x, originPos.y + 1.0, originPos.z);
    mesh.lookAt(targetPos.x, targetPos.y, targetPos.z); // 面朝飞行方向，自旋绕本地 Z 才有「掷星」观感
    const dir = this._dir.copy(targetPos).sub(mesh.position);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    const vel = dir.multiplyScalar(SHURIKEN.SPEED); // 速度向量(米/秒)
    this.scene.add(mesh);
    this.list.push({ mesh, vel, life: SHURIKEN.MAX_LIFE });
    if (this._audio && this._audio.playShurikenThrow) this._audio.playShurikenThrow();
  }

  update(dt, playerPos) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const s = this.list[i];
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotateZ(THREE.MathUtils.degToRad(SHURIKEN.SPIN) * dt); // 绕面法线自旋
      s.life -= dt;
      const hit = playerPos ? s.mesh.position.distanceTo(playerPos) <= SHURIKEN.HIT_RADIUS : false;
      if (hit) {
        if (this._onHit) this._onHit(SHURIKEN.DAMAGE); // 扣飞船血量
        if (this._audio && this._audio.playShurikenHit) this._audio.playShurikenHit();
        this._removeAt(i);
      } else if (s.life <= 0) {
        this._removeAt(i); // 超时未命中自动回收
      }
    }
  }

  _removeAt(i) {
    const s = this.list[i];
    this.scene.remove(s.mesh);
    // 几何/材质为模块级共享，不 dispose
    this.list.splice(i, 1);
  }

  clear() {
    for (let i = this.list.length - 1; i >= 0; i--) this.scene.remove(this.list[i].mesh);
    this.list.length = 0;
  }

  get count() { return this.list.length; }
}
