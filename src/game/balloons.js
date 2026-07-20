import * as THREE from 'three';
import { ENEMY_TYPES } from '../content/enemies.js';
import { BALLOON, MOVE } from '../core/constants.js';
import { attachBalloonModel, fitToRadius, loadBalloonModel, attachDragonSegment } from './balloonModels.js';

// 程序化笑脸贴图（按颜色缓存）——占位怪也复用调色板
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
    this.effectiveRadius = t.radius * (t.scale || 1); // 碰撞/分离/血条用的实际半径
    this.score = t.score;
    this.behavior = t.behavior;
    this.selfDamage = t.selfDamage !== undefined ? t.selfDamage : BALLOON.DAMAGE;
    this.alive = true;
    // 召唤怪专用
    this.minions = [];
    this.summonTimer = 0;
    this.minionCap = 2;

    const hex = t.tint != null ? '#' + t.tint.toString(16).padStart(6, '0') : COLORS[Math.floor(Math.random() * COLORS.length)];
    const geo = new THREE.SphereGeometry(t.radius, 20, 16);
    const mat = new THREE.MeshStandardMaterial({ map: faceTexture(hex), roughness: 0.6, metalness: 0.0 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.userData.balloon = this;
    this.bodyModel = null;     // GLB 模型（若有）
    this._modelMats = null;    // 模型/占位材质数组（用于受击闪烁）
    this._hasModel = false;

    // —— 外观装配 ——
    // 1) 有专用 GLB 模型 → 挂模型并隐藏程序化球体
    if (t.model) {
      this._hasModel = true;
      this.mesh.material.visible = false;
      // 盾兵怪复用骑士模型但需正常体型（Boss 骑士用 MODEL_TUNING 默认缩小），此处覆盖 scale
      const knightTuning = (t.id === 'shield') ? { scale: 1.0 } : null;
      attachBalloonModel(this, t.model, t.radius, null, knightTuning);
    } else if (t.dragonSegment) {
      // 2b) 龙身/龙爪：极轻量程序化几何体（见 balloonModels.attachDragonSegment），
      //     避免 14 份 48万面 基础怪.glb 拖垮 GPU（龙 Boss 掉帧核心修复）
      this._hasModel = true;
      this.mesh.material.visible = false;
      attachDragonSegment(this, t.radius);
    } else {
      // 2) 无模型 → 程序化占位（彩色胶囊 + 眼睛），保留 _modelMats 以便受击闪烁
      this._hasModel = true; // 跳过锥形头盔显示逻辑
      this._buildPlaceholder(t);
      this._makeNameLabel(t.name); // 需求④：占位怪加名牌，防止混淆
    }

    // 盾兵怪：在骑士模型基础上附加「会旋转的盾牌」（绕骑士旋转，挡子弹）
    if (t.shieldModel) this._buildShield(t);

    // 血条：所有非基础怪显示（含盾兵/召唤/心/忍者/宝箱/幽灵/龙头/聚宝盆/章鱼）；龙身(noHealthBar)除外——龙用全局血量池
    if (t.id !== 'basic' && !t.noHealthBar) this._makeHealthBar(this.effectiveRadius);
    if (t.scale) this.mesh.scale.setScalar(t.scale);

    // 幽灵怪：默认隐身，仅在自身蓄力攻击时显形（见 update）
    if (t.behavior === 'ghost') {
      this.revealed = false;
      this.mesh.visible = false;
      this._ghostTimer = Math.random() * (t.ghostFireInterval || 3);
    }
    // 聚宝盆：无敌 + 寿命计时
    if (t.behavior === 'treasure') {
      this._lifespan = t.lifespan || 10;
      this._killsDuringLife = 0;
    }
    // 忍者怪：闪现计时
    if (t.behavior === 'ninja') this._blinkTimer = Math.random() * (t.blinkInterval || 3);
    // 宝箱怪：跳跳计时
    if (t.behavior === 'chest') this._hopTimer = Math.random() * (t.hopInterval || 2);

    this._flash = 0;
    this._hop = Math.random() * Math.PI * 2;
    this.controlled = false;   // 由外部(如龙Boss)逐帧接管位置时为 true
    this._pendingKill = false; // 聚宝盆超时等脚本化死亡标记
    this.group = this.mesh;
  }

  // 占位外观：程序化胶囊 + 眼睛（无专用模型的小怪走这里）
  _buildPlaceholder(t) {
    const grp = new THREE.Group();
    const col = t.tint != null ? t.tint : 0xcccccc;
    const capMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.7, metalness: 0.05 });
    const cap = new THREE.Mesh(new THREE.CapsuleGeometry(t.radius * 0.7, t.radius * 1.1, 6, 12), capMat);
    cap.position.y = t.radius * 0.95;
    grp.add(cap);
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(t.radius * 0.13, 8, 8), eyeMat);
      eye.position.set(sx * t.radius * 0.3, t.radius * 1.25, t.radius * 0.62);
      grp.add(eye);
    }
    this.mesh.add(grp);
    this._modelMats = [capMat, eyeMat]; // 复用模型闪烁路径
    this.mesh.material.visible = false;
  }

  // 占位怪名牌：半透明底 + 白字，挂在气球上方；Sprite 始终朝向相机，depthTest 关闭永不被遮挡
  _makeNameLabel(text) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const x = c.getContext('2d');
    x.fillStyle = 'rgba(0,0,0,0.55)';
    x.fillRect(0, 0, 256, 64);
    x.fillStyle = '#ffffff';
    x.font = 'bold 38px sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, 128, 34);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(1.4, 0.35, 1);
    sp.position.y = this.radius * 2.6 + 0.3;
    sp.renderOrder = 999;
    this.mesh.add(sp);
    this.label = sp;
  }

  // 盾兵怪：骑士模型 + 会旋转的盾牌（盾作为 pivot 子节点，绕骑士旋转）
  _buildShield(t) {
    const pivot = new THREE.Group();
    this.mesh.add(pivot);
    this.shieldPivot = pivot;
    this.shieldAngle = Math.random() * Math.PI * 2;          // 初相位随机，避免多盾重叠
    this.shieldSpin = (Math.PI * 2) / (t.shieldSpinPeriod || 2.0); // rad/s，知识库「每2秒旋转一圈」
    this.shieldBlockArc = THREE.MathUtils.degToRad(t.shieldBlockArc || 75);
    this.shieldDist = t.radius * 1.35;                        // 盾牌中心到骑士中心距离
    this.shieldModel = null;
    loadBalloonModel(t.shieldModel)
      .then((gltfScene) => {
        if (!this.alive) { gltfScene.traverse(o => { if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); } }); return; }
        const s = gltfScene.clone(true);
        fitToRadius(s, t.radius * 1.1);
        s.position.set(0, 0, -this.shieldDist); // 放在 pivot 前方(-Z)：pivot 旋转即绕骑士转
        s.rotation.y = Math.PI;                  // 盾正面朝外(-Z)
        pivot.add(s);
        pivot.rotation.y = this.shieldAngle;
        this.shieldModel = s;
        s.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); this._modelMats.push(o.material); } });
      })
      .catch(() => { /* 盾牌加载失败：盾兵仍可用，仅缺盾外观 */ });
  }

  // 供 game._collide 判断「子弹是否被盾挡下」：返回盾牌世界朝向与挡弹半角
  getShieldBlock() {
    if (!this.shieldPivot || !this.shieldModel) return null;
    const sp = new THREE.Vector3();
    this.shieldModel.getWorldPosition(sp);
    const center = this.mesh.getWorldPosition(new THREE.Vector3());
    const dir = sp.sub(center); dir.y = 0;
    if (dir.lengthSq() < 1e-6) return null;
    dir.normalize();
    return { dir, arc: this.shieldBlockArc };
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
    if (this.type.invincible) return false; // 聚宝盆：无敌，子弹不扣血
    this.hp -= dmg;
    this._flash = 0.1;
    if (this._hpBar) {
      const k = Math.max(0, this.hp / this.maxHp);
      this._hpFg.scale.x = k;
      this._hpFg.position.x = -((1 - k) * this.effectiveRadius);
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

    // 盾牌绕骑士旋转（盾兵怪核心机制）
    if (this.shieldPivot) {
      this.shieldAngle += this.shieldSpin * dt;
      this.shieldPivot.rotation.y = this.shieldAngle;
    }

    // 小怪特殊行为
    this._updateBehavior(dt, target);

    // 笑脸/模型朝向玩家
    this.mesh.lookAt(target.x, target.y, target.z);

    // 受击闪烁（有模型/占位材质则闪材质，否则闪程序化球体）
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

  // 各小怪专属行为（占位/盾兵以外的特殊逻辑）
  _updateBehavior(dt, target) {
    const t = this.type;
    // 宝箱怪：绕着玩家短跳（2秒一次）
    if (t.behavior === 'chest') {
      this._hopTimer += dt;
      if (this._hopTimer >= (t.hopInterval || 2)) {
        this._hopTimer = 0;
        const a = Math.random() * Math.PI * 2;
        const r = 1.5 + Math.random() * 2.0;
        this.mesh.position.x = THREE.MathUtils.clamp(target.x + Math.cos(a) * r, -6, 6);
        this.mesh.position.z = THREE.MathUtils.clamp(target.z + Math.sin(a) * r, -8, 8);
      }
    }
    // 忍者怪：闪现（3秒一次，5米范围内）
    if (t.behavior === 'ninja') {
      this._blinkTimer += dt;
      if (this._blinkTimer >= (t.blinkInterval || 3)) {
        this._blinkTimer = 0;
        const a = Math.random() * Math.PI * 2;
        const r = 1.0 + Math.random() * (t.blinkRange || 5);
        this.mesh.position.x = THREE.MathUtils.clamp(target.x + Math.cos(a) * r, -6, 6);
        this.mesh.position.z = THREE.MathUtils.clamp(target.z + Math.sin(a) * r, -8, 8);
        // TODO: 手里剑抛射（每3秒一次，伤害5）后续补齐 enemyProjectiles 系统
      }
    }
    // 幽灵怪：隐身，仅自身蓄力攻击(最后 charge 秒)时显形并可被击中
    if (t.behavior === 'ghost') {
      this._ghostTimer += dt;
      const cycle = t.ghostFireInterval || 3;
      const charge = t.ghostFireCharge || 2;
      const phase = this._ghostTimer % cycle;
      this.revealed = phase >= (cycle - charge);
      this.mesh.visible = this.revealed;
      // TODO: 鬼火抛射（蓄力结束发射，伤害10）后续补齐
    }
    // 聚宝盆：无敌存活寿命，到点标记脚本化死亡
    if (t.behavior === 'treasure') {
      this._lifespan -= dt;
      if (this._lifespan <= 0) this._pendingKill = true;
    }
    // TODO: 龙头怪 cloud(造云隐身)/fireball(火球)、章鱼怪 ink(喷墨遮视线) 的特殊攻击后续补齐
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    if (this.bodyModel) {
      this.mesh.remove(this.bodyModel);
      this.bodyModel.traverse((o) => {
        if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
      });
      this.bodyModel = null;
    }
    if (this.shieldPivot) {
      this.shieldPivot.traverse((o) => {
        if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
      });
      this.mesh.remove(this.shieldPivot);
      this.shieldPivot = null;
    }
    if (this.label) {
      this.mesh.remove(this.label);
      this.label.material.map?.dispose();
      this.label.material.dispose();
      this.label = null;
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
    this._applyHealAura(dt);
  }

  // 心型怪治疗光环：每秒为 healRadius 内的其他敌人恢复 healAura 血量
  _applyHealAura(dt) {
    for (const h of this.list) {
      if (h.behavior !== 'heal' || !h.alive) continue;
      const hr = h.type.healRadius || 6;
      const ha = h.type.healAura || 10;
      for (const o of this.list) {
        if (o === h || !o.alive) continue;
        if (o.mesh.position.distanceTo(h.mesh.position) <= hr) {
          o.hp = Math.min(o.maxHp, o.hp + ha * dt);
        }
      }
    }
  }

  // 气球间分离力：O(n²) 两两检查，最多几十个，性能无忧
  _applySeparation() {
    const GAP = 0.2;
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.controlled) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.controlled) continue;
        this._sepVec.subVectors(a.mesh.position, b.mesh.position);
        this._sepVec.y = 0;
        const dist = this._sepVec.length();
        const minDist = a.effectiveRadius + b.effectiveRadius + GAP;
        if (dist < minDist) {
          if (dist > 0.001) {
            this._sepVec.normalize();
            const overlap = (minDist - dist) * 0.5;
            a.mesh.position.addScaledVector(this._sepVec, overlap);
            b.mesh.position.addScaledVector(this._sepVec, -overlap);
          } else {
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
