import * as THREE from 'three';
import { SHOOT } from '../core/constants.js';

// 子弹系统：InstancedMesh 单 Draw Call 渲染所有子弹，支持大数量（割草）
// 子弹对象只存逻辑数据（pos/vel/life/dmg），不再持有独立 Mesh，
// 渲染由 _instanced 实例矩阵统一管理 —— 无论多少颗子弹都只有 1 次 Draw Call。
export class BulletManager {
  constructor(scene) {
    this.scene = scene;
    this.active = [];
    this._pool = [];
    this.capacity = SHOOT.BULLET_POOL_SIZE;

    // 共享几何体 + 廉价材质（发光小球不需要 PBR 光照，MeshBasicMaterial 不吃光照计算）
    const geo = new THREE.SphereGeometry(SHOOT.BULLET_RADIUS, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color: SHOOT.BULLET_COLOR });
    this._instanced = new THREE.InstancedMesh(geo, mat, this.capacity);
    this._instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // 每帧更新
    this._instanced.frustumCulled = false;  // 单实例包围盒不准，关闭裁剪避免整体消失
    this._instanced.count = 0;
    scene.add(this._instanced);

    this._m = new THREE.Matrix4();
  }

  _obtain() {
    let b = this._pool.pop();
    if (!b) {
      b = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, dmg: 0, alive: false };
    }
    b.alive = true;
    this.active.push(b);
    return b;
  }

  spawn(position, direction, dmg) {
    // 池/容量耗尽则复用最旧的（保证 active 不超过 capacity，实例矩阵不越界）
    if (this.active.length >= this.capacity + this._pool.length) {
      this.release(this.active[0]);
    }
    const b = this._obtain();
    b.pos.copy(position);
    b.vel.copy(direction).normalize().multiplyScalar(SHOOT.BULLET_SPEED);
    b.life = SHOOT.BULLET_LIFE;
    b.dmg = dmg;
  }

  release(b) {
    const i = this.active.indexOf(b);
    if (i === -1) return;
    const last = this.active.length - 1;
    if (i !== last) this.active[i] = this.active[last]; // swap-pop：O(1) 替代 splice O(n)
    this.active.pop();
    b.alive = false;
    this._pool.push(b);
  }

  // 将 active 中所有子弹位置写入 InstancedMesh 实例矩阵（碰撞/生成后调用）
  sync() {
    for (let i = 0; i < this.active.length; i++) {
      const b = this.active[i];
      this._m.identity().setPosition(b.pos);
      this._instanced.setMatrixAt(i, this._m);
    }
    this._instanced.count = this.active.length;
    this._instanced.instanceMatrix.needsUpdate = true;
  }

  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const b = this.active[i];
      b.pos.addScaledVector(b.vel, dt);
      b.life -= dt;
      if (b.life <= 0) this.release(b);
    }
    this.sync();
  }

  clear() {
    while (this.active.length > 0) this.release(this.active[this.active.length - 1]);
    this.sync();
  }
}
