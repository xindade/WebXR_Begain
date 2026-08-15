import * as THREE from 'three';
import { SHOOT } from '../core/constants.js';

// 子弹对象池（知识库要求 20 个循环使用）
export class BulletManager {
  constructor(scene) {
    this.scene = scene;
    this.active = [];
    this._pool = [];
  }

  _obtain() {
    let b = this._pool.pop();
    if (!b) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(SHOOT.BULLET_RADIUS, 8, 8),  // 子弹大小由 SHOOT.BULLET_RADIUS 控制
        new THREE.MeshStandardMaterial({ color: 0xffe066, emissive: 0xffcc33, emissiveIntensity: 1.2 })
      );
      b = { mesh, vel: new THREE.Vector3(), life: 0, alive: false };
    }
    this.scene.add(b.mesh);
    b.alive = true;
    this.active.push(b);
    return b;
  }

  spawn(position, direction, dmg) {
    if (this.active.length >= SHOOT.BULLET_POOL_SIZE + this._pool.length) {
      // 池耗尽则复用最旧的
      this.release(this.active[0]);
    }
    const b = this._obtain();
    b.mesh.position.copy(position);
    b.vel.copy(direction).normalize().multiplyScalar(SHOOT.BULLET_SPEED);
    b.life = SHOOT.BULLET_LIFE;
    b.dmg = dmg;
  }

  release(b) {
    const i = this.active.indexOf(b);
    if (i !== -1) {
      const last = this.active.length - 1;
      if (i !== last) this.active[i] = this.active[last]; // swap-pop: O(1) 替代 splice O(n)
      this.active.pop();
    }
    b.alive = false;
    this.scene.remove(b.mesh);
    this._pool.push(b);
  }

  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const b = this.active[i];
      b.mesh.position.addScaledVector(b.vel, dt);
      b.life -= dt;
      if (b.life <= 0) this.release(b);
    }
  }

  clear() {
    while (this.active.length > 0) this.release(this.active[this.active.length - 1]);
  }
}
