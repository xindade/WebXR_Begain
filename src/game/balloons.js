import * as THREE from 'three';
import { ENEMY_TYPES } from '../content/enemies.js';
import { BALLOON } from '../core/constants.js';
import { attachBalloonModel } from './balloonModels.js';

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
    this.effectiveRadius = t.radius * (t.scale || 1); // 碰撞/分离/血条用的实际半径：含 scale 放大（解决骑士模型大但碰撞没跟着变大）
    this.score = t.score;
    this.behavior = t.behavior;
    this.selfDamage = t.selfDamage !== undefined ? t.selfDamage : BALLOON.DAMAGE; // 自爆（撞船）伤害，默认全局值
    this.alive = true;
    // 召唤怪专用：维持的小怪列表与重生计时
    this.minions = [];
    this.summonTimer = 0;
    this.minionCap = 2;

    const hex = t.tint != null ? '#' + t.tint.toString(16).padStart(6, '0') : COLORS[Math.floor(Math.random() * COLORS.length)];
    const geo = new THREE.SphereGeometry(t.radius, 20, 16);
    const mat = new THREE.MeshStandardMaterial({ map: faceTexture(hex), roughness: 0.6, metalness: 0.0 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.userData.balloon = this;
    this.bodyModel = null;     // GLB 模型（若有）
    this._modelMats = null;    // 模型材质数组（用于受击闪烁）
    this._hasModel = false;

    // 模型：专用模型优先（不打 tint，模型自带外观）；无专用模型则统一用「基础怪」作通用身体，
    // 并按该类型 tint 染色保持区分。先隐藏程序化球体，模型加载完再挂上，避免「笑脸 → 模型」闪现。
    const modelUrl = t.model || 'Model/基础怪.glb';
    const modelTint = t.model ? null : (t.tint != null ? t.tint : null);
    this._hasModel = true;
    this.mesh.material.visible = false; // 先隐藏球体，杜绝笑脸闪现
    attachBalloonModel(this, modelUrl, t.radius, modelTint);

    // 锥形头盔仅在无模型时显示（有模型则模型自带外观）；血条始终为 knight/scale/summon 显示
    if ((t.behavior === 'knight' || t.scale || t.behavior === 'summon') && !this._hasModel) {
      const helmet = new THREE.Mesh(
        new THREE.ConeGeometry(t.radius * 0.7, t.radius * 0.8, 12),
        new THREE.MeshStandardMaterial({ color: 0xb2bec3, metalness: 0.4, roughness: 0.4 })
      );
      helmet.position.y = t.radius * 0.9;
      this.mesh.add(helmet);
    }
    if (t.behavior === 'knight' || t.scale || t.behavior === 'summon') {
      this._makeHealthBar(this.effectiveRadius);
    }
    if (t.scale) this.mesh.scale.setScalar(t.scale);

    this._flash = 0;
    this._hop = Math.random() * Math.PI * 2;
    this.controlled = false;   // 由外部(如龙Boss)逐帧接管位置时为 true：跳过自动朝玩家移动与分离力
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
    this.mesh.add(bar);
    this._hpBar = bar;
  }

  takeDamage(dmg) {
    this.hp -= dmg;
    this._flash = 0.1;
    if (this._hpBar) {
      const k = Math.max(0, this.hp / this.maxHp);
      this._hpFg.scale.x = k;
      this._hpFg.position.x = -((1 - k) * this.effectiveRadius); // 左对齐收缩（跟随实际半径）
      this._hpFg.material.color.setHSL(0.33 * k, 0.7, 0.5);
    }
    if (this.hp <= 0) { this.alive = false; return true; }
    return false;
  }

  update(dt, target, camera) {
    // 朝玩家移动（controlled 气球由外部逐帧设位置，跳过自动移动）
    if (!this.controlled) {
      const dir = target.clone().sub(this.mesh.position);
      dir.y = 0;
      const dist = dir.length();
      if (dist > 0.001) dir.normalize();
      this.mesh.position.addScaledVector(dir, this.speed * dt);
    }

    // 笑脸朝向玩家
    this.mesh.lookAt(target.x, target.y, target.z);

    // 跳跃行为
    if (this.behavior === 'hop') {
      this._hop += dt * 6;
      this.mesh.position.y = (this.type.radius) + Math.abs(Math.sin(this._hop)) * 0.6;
    }
    // 受击闪烁（有 GLB 模型则闪模型材质，否则闪程序化球体）
    if (this._flash > 0) {
      this._flash -= dt;
      const inten = Math.max(0, this._flash * 6);
      if (this._modelMats) {
        for (const m of this._modelMats) { m.emissive.setRGB(1, 1, 1); m.emissiveIntensity = inten; }
      } else {
        this.mesh.material.emissive = new THREE.Color(0xffffff);
        this.mesh.material.emissiveIntensity = inten;
      }
    } else if (this._modelMats) {
      for (const m of this._modelMats) m.emissiveIntensity = 0;
    } else if (this.mesh.material.emissiveIntensity) {
      this.mesh.material.emissiveIntensity = 0;
    }
    // 血条朝向相机
    if (this._hpBar && camera) this._hpBar.lookAt(camera.getWorldPosition(new THREE.Vector3()));
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    // GLB 模型（独立克隆材质/几何）随球体一起释放
    if (this.bodyModel) {
      this.mesh.remove(this.bodyModel);
      this.bodyModel.traverse((o) => {
        if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
      });
      this.bodyModel = null;
    }
  }
}

export class BalloonManager {
  constructor(scene) {
    this.scene = scene;
    this.list = [];
    this._sepVec = new THREE.Vector3();
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
    this._applySeparation();
  }

  // 气球间分离力：O(n²) 两两检查，最大10个=45对，性能无忧
  _applySeparation() {
    const GAP = 0.2; // 最小间隙(m)
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.controlled) continue; // 受外部控制的龙气球：位置由路径决定，不参与自动分离
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.controlled) continue;
        this._sepVec.subVectors(a.mesh.position, b.mesh.position);
        this._sepVec.y = 0; // 仅在 xz 平面分离
        const dist = this._sepVec.length();
        const minDist = a.effectiveRadius + b.effectiveRadius + GAP;
        if (dist < minDist) {
          if (dist > 0.001) {
            this._sepVec.normalize();
            const overlap = (minDist - dist) * 0.5;
            a.mesh.position.addScaledVector(this._sepVec, overlap);
            b.mesh.position.addScaledVector(this._sepVec, -overlap);
          } else {
            // 完全重合：随机方向推开
            const angle = Math.random() * Math.PI * 2;
            this._sepVec.set(Math.cos(angle), 0, Math.sin(angle));
            const push = minDist * 0.5;
            a.mesh.position.addScaledVector(this._sepVec, push);
            b.mesh.position.addScaledVector(this._sepVec, -push);
          }
        }
      }
    }
  }

  clear() {
    for (const b of [...this.list]) this.remove(b);
  }

  get count() { return this.list.length; }
}
