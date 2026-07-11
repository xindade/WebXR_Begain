import * as THREE from 'three';
import { ENEMY_TYPES } from '../content/enemies.js';

// 程序化笑脸贴图（按颜色缓存）
const _faceCache = new Map();
function faceTexture(hex) {
  if (_faceCache.has(hex)) return _faceCache.get(hex);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = hex;
  x.fillRect(0, 0, 128, 128);
  x.fillStyle = '#222';
  x.beginPath(); x.arc(46, 54, 9, 0, 7); x.arc(82, 54, 9, 0, 7); x.fill();
  x.lineWidth = 6; x.strokeStyle = '#222';
  x.beginPath(); x.arc(64, 66, 26, 0.2, Math.PI - 0.2); x.stroke();
  const t = new THREE.CanvasTexture(c);
  _faceCache.set(hex, t);
  return t;
}

const COLORS = ['#ff5a5f', '#ffb400', '#ffd166', '#06d6a0', '#118ab2', '#9b5de5', '#f15bb5'];

class Balloon {
  constructor(typeId) {
    const t = ENEMY_TYPES[typeId] || ENEMY_TYPES.basic;
    this.type = t;
    this.maxHp = t.hp;
    this.hp = t.hp;
    this.speed = t.speed;
    this.radius = t.radius;
    this.score = t.score;
    this.behavior = t.behavior;
    this.alive = true;

    const hex = t.tint != null ? '#' + t.tint.toString(16).padStart(6, '0') : COLORS[Math.floor(Math.random() * COLORS.length)];
    const geo = new THREE.SphereGeometry(t.radius, 20, 16);
    const mat = new THREE.MeshStandardMaterial({ map: faceTexture(hex), roughness: 0.6, metalness: 0.0 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.userData.balloon = this;

    // 骑士/精英：头盔 + 血条
    if (t.behavior === 'knight' || t.scale) {
      const helmet = new THREE.Mesh(
        new THREE.ConeGeometry(t.radius * 0.7, t.radius * 0.8, 12),
        new THREE.MeshStandardMaterial({ color: 0xb2bec3, metalness: 0.4, roughness: 0.4 })
      );
      helmet.position.y = t.radius * 0.9;
      this.mesh.add(helmet);
      this._makeHealthBar(t.radius);
    }
    if (t.scale) this.mesh.scale.setScalar(t.scale);

    this._flash = 0;
    this._hop = Math.random() * Math.PI * 2;
    this.group = this.mesh;
  }

  _makeHealthBar(r) {
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(r * 2, 0.12), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    const fg = new THREE.Mesh(new THREE.PlaneGeometry(r * 2, 0.1), new THREE.MeshBasicMaterial({ color: 0x2ecc71 }));
    fg.position.z = 0.01;
    this._hpFg = fg;
    const bar = new THREE.Group();
    bar.add(bg); bar.add(fg);
    bar.position.y = r * 1.4;
    bar.lookAtCam = true;
    this.mesh.add(bar);
    this._hpBar = bar;
  }

  takeDamage(dmg) {
    this.hp -= dmg;
    this._flash = 0.1;
    if (this._hpBar) {
      const k = Math.max(0, this.hp / this.maxHp);
      this._hpFg.scale.x = k;
      this._hpFg.position.x = -((1 - k) * this.type.radius); // 左对齐收缩
      this._hpFg.material.color.setHSL(0.33 * k, 0.7, 0.5);
    }
    if (this.hp <= 0) { this.alive = false; return true; }
    return false;
  }

  update(dt, target, camera) {
    // 朝玩家移动
    const dir = target.clone().sub(this.mesh.position);
    dir.y = 0;
    const dist = dir.length();
    if (dist > 0.001) dir.normalize();
    this.mesh.position.addScaledVector(dir, this.speed * dt);

    // 笑脸朝向玩家
    this.mesh.lookAt(target.x, target.y, target.z);

    // 跳跃行为
    if (this.behavior === 'hop') {
      this._hop += dt * 6;
      this.mesh.position.y = (this.type.radius) + Math.abs(Math.sin(this._hop)) * 0.6;
    }
    // 受击闪烁
    if (this._flash > 0) {
      this._flash -= dt;
      this.mesh.material.emissive = new THREE.Color(0xffffff);
      this.mesh.material.emissiveIntensity = Math.max(0, this._flash * 6);
    } else if (this.mesh.material.emissiveIntensity) {
      this.mesh.material.emissiveIntensity = 0;
    }
    // 血条朝向相机
    if (this._hpBar && camera) this._hpBar.lookAt(camera.getWorldPosition(new THREE.Vector3()));
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

export class BalloonManager {
  constructor(scene) {
    this.scene = scene;
    this.list = [];
  }

  spawn(typeId, position) {
    const b = new Balloon(typeId);
    b.mesh.position.copy(position);
    this.scene.add(b.mesh);
    this.list.push(b);
    return b;
  }

  remove(b) {
    const i = this.list.indexOf(b);
    if (i !== -1) this.list.splice(i, 1);
    this.scene.remove(b.mesh);
    b.dispose();
  }

  update(dt, target, camera) {
    for (const b of this.list) b.update(dt, target, camera);
  }

  clear() {
    for (const b of [...this.list]) this.remove(b);
  }

  get count() { return this.list.length; }
}
