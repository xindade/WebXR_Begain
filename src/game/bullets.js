import * as THREE from 'three';
import { SHOOT } from '../core/constants.js';

// 子弹对象池（知识库要求 20 个循环使用）
export class BulletManager {
  constructor(scene) {
    this.scene = scene;
    this.active = [];
    this._pool = [];
    this.dmg = 100; // 由 player.atk 每帧同步
  }

  _obtain() {
    let b = this._pool.pop();
    if (!b) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 8, 8),
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
    if (i !== -1) this.active.splice(i, 1);
    b.alive = false;
    this.scene.remove(b.mesh);
    this._pool.push(b);
  }

  update(dt) {
    for (const b of [...this.active]) {
      b.mesh.position.addScaledVector(b.vel, dt);
      b.life -= dt;
      if (b.life <= 0) this.release(b);
    }
  }

  clear() {
    for (const b of [...this.active]) this.release(b);
  }
}
