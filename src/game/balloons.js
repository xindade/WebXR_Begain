import * as THREE from 'three';
import { ENEMY_TYPES } from '../content/enemies.js';
import { BALLOON, MOVE, SHURIKEN } from '../core/constants.js';
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

// 模块级临时量：消除 update 热循环里每怪每帧 new Vector3 / new Color 的 GC 压力
const _moveDir   = new THREE.Vector3();   // update() 朝玩家方向（每怪复用，调用即消费）
const _camPos    = new THREE.Vector3();   // update() 血条 lookAt 的相机世界坐标
const _shieldSp  = new THREE.Vector3();   // getShieldBlock() 盾牌世界坐标
const _shieldCt  = new THREE.Vector3();   // getShieldBlock() 气球中心世界坐标
const _orbTmp    = new THREE.Vector3();   // 忍者蓄力光球定位临时量（_updateChargeOrb 复用，消除每帧 new 的 GC 压力）

class Balloon {
  constructor(typeId, opts = null) {
    const t = ENEMY_TYPES[typeId] || ENEMY_TYPES.basic;
    this.type = t;
    this.maxHp = t.hp;
    this.hp = t.hp;
    // 精英怪：允许外部覆盖血量（由 waves._fireElitePhase 按敌种计算 = ELITE_BASE_HP[型] + DPS×秒，叠加式）并标记
    if (opts && opts.hp != null) { this.maxHp = opts.hp; this.hp = opts.hp; }
    this.isElite = !!(opts && opts.isElite);
    this.speed = t.speed;
    this.radius = t.radius;
    this.effectiveRadius = t.radius * (t.scale || 1); // 碰撞/分离/血条用的实际半径
    this.healthBarRadius = t.barRadius != null ? t.barRadius : t.radius; // 血条宽度半径(米)：默认=基础半径(不含 scale)。血条是 mesh.scale 子节点，会被 scale 放大 → 最终宽度≈模型直径，各型一致；可用 barRadius 单独覆盖
    this.hitRadius = this.effectiveRadius;            // 子弹命中球半径（模型加载后按视觉尺寸放大；占位怪构造里再放大）
    this.score = t.score;
    this.behavior = t.behavior;
    this.selfDamage = t.selfDamage !== undefined ? t.selfDamage : BALLOON.DAMAGE;
    this.damageReduction = t.damageReduction || 0;  // 0~1 减伤比例（脸谱 Boss 95%）
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
      // 程序化球体默认隐藏：模型加载成功由 attachBalloonModel 挂上模型（球体保持隐藏）；
      // 加载失败也保持隐藏（不再用彩色球体兜底，避免破坏沉浸），仅 console.warn 暴露 404/解码问题。
      this.mesh.material.visible = false;
      // 盾兵怪/精英骑士复用骑士模型但需正常体型（Boss 骑士用 MODEL_TUNING 默认缩小），此处覆盖 scale
      const knightTuning = (t.id === 'shield' || t.id === 'eliteKnight') ? { scale: 1.0 } : null;
      attachBalloonModel(this, t.model, t.radius, null, knightTuning, 1, t.id);
    } else if (t.dragonSegment) {
      // 2b) 龙身/龙爪：外观装配延后到 dragonLevel._spawnBalloons 显式调用 attachDragonSegment，
      //     因为逐段 taper（头粗尾细）在构造时未知，需由外部传入。
      //     此处仅隐藏程序化球体 + 标记 _hasModel（跳过锥形头盔逻辑）。
      this._hasModel = true;
      this.mesh.material.visible = false;
    } else {
      // 2) 无模型 → 程序化占位（彩色胶囊 + 眼睛），保留 _modelMats 以便受击闪烁
      this._hasModel = true; // 跳过锥形头盔显示逻辑
      this._buildPlaceholder(t);
      this._makeNameLabel(t.name); // 需求④：占位怪加名牌，防止混淆
    }

    // 盾兵怪：在骑士模型基础上附加「会旋转的盾牌」（绕骑士旋转，挡子弹）
    if (t.shieldModel) this._buildShield(t);

    // 血条：所有非基础怪显示（含盾兵/召唤/心/忍者/宝箱/幽灵/龙头/聚宝盆/章鱼）；龙身(noHealthBar)除外——龙用全局血量池
    if (t.id !== 'basic' && !t.noHealthBar) this._makeHealthBar(this.healthBarRadius);
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
    // ninja lifecycle: 出现→蓄力→投掷→闪现（全局统一，非龙Boss专属）
    if (t.behavior === 'ninja') {
      this._ninjaPhase = 'appear';
      this._ninjaTimer = 0;
      this._chargeOrb = null;
    }
    // 宝箱怪：跳跳计时
    if (t.behavior === 'chest') this._hopTimer = Math.random() * (t.hopInterval || 2);

    this._flash = 0;
    this._hop = Math.random() * Math.PI * 2;
    // 立绘气球浮动（破「整齐划一」）：每怪独立的相位/幅度/频率 → 群体不再同步
    this._bobPhase = Math.random() * Math.PI * 2;
    this._bobAmp   = (t.radius || 1) * (0.04 + Math.random() * 0.06); // 上下浮动幅度 ≈ 半径的 4%~10%
    this._bobFreq  = 0.5 + Math.random() * 0.8;                       // 浮动频率(Hz)，个体不同
    this._bobT = 0;
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
    this.hitRadius = this.effectiveRadius * 2.2; // 占位胶囊+眼睛视觉高于球体，放大命中球直到上半身
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
    this.shieldModel.getWorldPosition(_shieldSp);
    this.mesh.getWorldPosition(_shieldCt);
    const dir = _shieldSp.sub(_shieldCt); dir.y = 0;
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

  takeDamage(dmg, ignoreReduction = false) {
    if (this.type.invincible) return false; // 聚宝盆：无敌，子弹不扣血
    if (!this.alive) return false;          // 已死亡：防止爆炸链重复触发 _onKilled 导致无限递归
    let final = dmg;
    if (this.damageReduction > 0 && (!ignoreReduction || this.isDragonPart))
      final = dmg * (1 - this.damageReduction);  // 95% 减伤 → 实际 5%（isDragonPart 强制减伤，含激光剑穿透）
    this.hp -= final;
    this._flash = 0.1;
    if (this._hpBar) {
      const k = Math.max(0, this.hp / this.maxHp);
      this._hpFg.scale.x = k;
      this._hpFg.position.x = -((1 - k) * this.healthBarRadius);
      this._hpFg.material.color.setHSL(0.33 * k, 0.7, 0.5);
    }
    if (this.hp <= 0) { this.alive = false; return true; }
    return false;
  }

  update(dt, target, camera) {
    // 朝玩家移动（controlled 气球由外部逐帧设位置，跳过自动移动）
    if (!this.controlled) {
      _moveDir.copy(target).sub(this.mesh.position);
      _moveDir.y = 0;
      const dist = _moveDir.length();
      if (dist > 0.001) _moveDir.normalize();
      this.mesh.position.addScaledVector(_moveDir, this.speed * dt);
      // 普通忍者：约束在距中心点(世界原点) 10~15m 环带内（龙形 Boss 的组成忍者 isDragonPart 跳过）
      if (this.behavior === 'ninja' && !this.isDragonPart) this._clampToRing();
    }

    // 盾牌绕骑士旋转（盾兵怪核心机制）
    if (this.shieldPivot) {
      this.shieldAngle += this.shieldSpin * dt;
      this.shieldPivot.rotation.y = this.shieldAngle;
    }

    // 小怪特殊行为
    this._updateBehavior(dt, target);

    // 笑脸/模型朝向玩家（龙部件由 dragonLevel 逐帧接管朝向，跳过以免被 lookAt 覆盖）
    if (!this.isDragonPart) this.mesh.lookAt(target.x, target.y, target.z);

    // DepthSprite 同步：位置跟随气球 + 仅 yaw 朝向玩家（视差基于世界空间相机，XR 逐眼立体）
    if (this.depthSprite) {
      this._bobT += dt;
      // 每帧重置为气球逻辑位置（不累积），再叠加独立上下浮动 → 气球悬浮感
      this.depthSprite.mesh.position.copy(this.mesh.position);
      this.depthSprite.mesh.position.y += this._bobAmp * Math.sin(this._bobPhase + this._bobT * this._bobFreq);
      this.depthSprite.faceYaw(target);
      this.depthSprite.advance(dt); // idle 序列帧推进（多帧 sheet 循环播放）
    }

    // 受击闪烁（有模型/占位材质则闪材质，否则闪程序化球体；DepthSprite 用 uFlash 白闪）
    if (this._flash > 0) {
      this._flash -= dt;
      const inten = Math.max(0, this._flash * 6);
      if (this.depthSprite) {
        this.depthSprite.setFlash(inten);
      } else if (this._modelMats) {
        for (const m of this._modelMats) { m.emissive.setRGB(1, 1, 1); m.emissiveIntensity = inten; }
      } else {
        this.mesh.material.emissive.setRGB(1, 1, 1);
        this.mesh.material.emissiveIntensity = inten;
      }
    } else if (this.depthSprite) {
      this.depthSprite.setFlash(0);
    } else if (this._modelMats) {
      for (const m of this._modelMats) m.emissiveIntensity = 0;
    } else if (this.mesh.material.emissiveIntensity) {
      this.mesh.material.emissiveIntensity = 0;
    }
    // 血条朝向相机
    if (this._hpBar && camera) this._hpBar.lookAt(camera.getWorldPosition(_camPos));

    // DepthSprite 显隐跟随主体（ghost 隐身机制需要：显形时才显示立绘）
    if (this.depthSprite) this.depthSprite.mesh.visible = this.mesh.visible;
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
    // 忍者怪：生命周期状态机（全局统一，非龙Boss关专属）。
    // 出现(APPEAR秒) → 蓄力(CHARGE秒, 头顶显示蓄力光球) → 投掷(仅最近忍者) → 等待(BLINK_DELAY秒) → 闪现 → 回到蓄力。
    // 龙形 Boss 的组成忍者(isDragonPart)与受控忍者(controlled)跳过，由龙逐帧接管位置。
    if (t.behavior === 'ninja' && !this.isDragonPart && !this.controlled) {
      this._ninjaTimer += dt;
      const S = SHURIKEN;
      switch (this._ninjaPhase) {
        case 'appear':  // 出现期：仅存在，不蓄力/不投掷/不闪现
          if (this._ninjaTimer >= S.APPEAR) { this._ninjaPhase = 'charge'; this._ninjaTimer = 0; this._showChargeOrb(true); }
          break;
        case 'charge':  // 蓄力期：头顶光球渐大脉动；结束即投掷（仅最近忍者真正投出）
          this._updateChargeOrb(dt);
          if (this._ninjaTimer >= S.CHARGE) {
            if (this.manager && this.manager.isNearestNinja(this) && this.manager.shurikens && this.manager._playerPos) {
              const hy = this.mesh.position.y + 1.0 * (this.mesh.scale.x || 1) + 0.3; // 头顶高度（按模型缩放）
              this.manager.shurikens.spawn(new THREE.Vector3(this.mesh.position.x, hy, this.mesh.position.z), this.manager._playerPos);
            }
            this._showChargeOrb(false);
            this._ninjaPhase = 'post'; this._ninjaTimer = 0;
          }
          break;
        case 'post':    // 投掷后等待期：BLINK_DELAY 秒后开始闪现
          if (this._ninjaTimer >= S.BLINK_DELAY) { this._ninjaPhase = 'blink'; this._ninjaTimer = 0; }
          break;
        case 'blink':   // 闪现：瞬移到「朝向玩家、距中心 10~15m 环带内」随机点，然后回到蓄力
          {
            const ang = Math.atan2(target.z, target.x) + (Math.random() - 0.5) * 1.2;
            const r = S.RANGE_MIN + Math.random() * (S.RANGE_MAX - S.RANGE_MIN);
            this.mesh.position.x = Math.cos(ang) * r;
            this.mesh.position.z = Math.sin(ang) * r;
          }
          this._ninjaPhase = 'charge'; this._ninjaTimer = 0;
          break;
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

  // 将水平位置夹紧到距中心(世界原点) RANGE_MIN~RANGE_MAX 的环带内（忍者活动范围约束）
  _clampToRing() {
    const min = SHURIKEN.RANGE_MIN, max = SHURIKEN.RANGE_MAX;
    const x = this.mesh.position.x, z = this.mesh.position.z;
    const d = Math.hypot(x, z);
    if (d < 1e-4) {                       // 落在正中心：随机推到环带内界
      const a = Math.random() * Math.PI * 2;
      this.mesh.position.x = Math.cos(a) * min;
      this.mesh.position.z = Math.sin(a) * min;
      return;
    }
    if (d < min) { const s = min / d; this.mesh.position.x *= s; this.mesh.position.z *= s; }
    else if (d > max) { const s = max / d; this.mesh.position.x *= s; this.mesh.position.z *= s; }
  }

  // 蓄力光球：场景级小球，悬于忍者头顶上方，蓄力时渐大脉动，直观表现「手里剑蓄力」。
  // 场景级（非 mesh 子节点）可避开父节点可见性（DepthSprite 模式主体不可见）影响。
  _showChargeOrb(on) {
    if (on) {
      if (!this._chargeOrb && this.manager) {
        const R = SHURIKEN.SIZE * 1.5;
        const g = new THREE.SphereGeometry(R, 12, 10);
        const m = new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.85, depthWrite: false });
        this._chargeOrb = new THREE.Mesh(g, m);
        this._chargeOrb.renderOrder = 998;
        this.manager.scene.add(this._chargeOrb);
      }
      if (this._chargeOrb) this._chargeOrb.visible = true;
    } else if (this._chargeOrb) {
      this._chargeOrb.visible = false;
    }
  }

  _updateChargeOrb(dt) {
    if (!this._chargeOrb || !this._chargeOrb.visible) return;
    const p = this.mesh.getWorldPosition(_orbTmp);
    const top = 1.2 * (this.mesh.scale.x || 1) + 0.3; // 头顶上方（按模型缩放）
    this._chargeOrb.position.set(p.x, p.y + top, p.z);
    const k = 0.4 + 0.6 * Math.min(1, this._ninjaTimer / Math.max(0.001, SHURIKEN.CHARGE)); // 随蓄力进度放大
    const pulse = 1 + 0.15 * Math.sin(this._ninjaTimer * 18);                                // 脉动
    this._chargeOrb.scale.setScalar(k * pulse);
  }

  dispose() {
    if (this._chargeOrb) {
      this.manager?.scene?.remove(this._chargeOrb);
      this._chargeOrb.geometry.dispose();
      this._chargeOrb.material.dispose();
      this._chargeOrb = null;
    }
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    if (this.bodyModel) {
      this.mesh.remove(this.bodyModel);
      this.bodyModel.traverse((o) => {
        if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
      });
      this.bodyModel = null;
    }
    // 脸谱 Boss 装饰物（扇子/旗子）：随 balloon 一起释放
    if (this._decorations) {
      for (const d of this._decorations) {
        this.mesh.remove(d);
        d.traverse((o) => {
          if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
        });
      }
      this._decorations = null;
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
    if (this.depthSprite) {
      this._dsScene?.remove(this.depthSprite.mesh);
      this.depthSprite.dispose();
      this.depthSprite = null;
    }
  }
}

export class BalloonManager {
  constructor(scene) {
    this.scene = scene;
    this.list = [];
    this._sepVec = new THREE.Vector3();
    this.depthDebug = false; // DepthSprite 深度调试：按 D 切换（中心亮=凸、边缘亮=凹）
    this.shurikens = null;   // 手里剑管理器（由 game.js 注入）；非空时启用忍者投掷
    this._playerPos = null;  // 每帧玩家位置（update 注入），供「最近忍者」判定
  }

  setShurikenManager(m) { this.shurikens = m; }

  // 最近忍者判定：在「所有非龙部件/非受控/存活的 ninja」中，返回距玩家最近者。
  // 用于保证「有且只有最靠近玩家的忍者投掷手里剑」（其余忍者不投）。
  isNearestNinja(b) {
    if (!b || b.behavior !== 'ninja' || b.isDragonPart || b.controlled || !b.alive) return false;
    const pp = this._playerPos;
    if (!pp) return false;
    let best = b, bestD = b.mesh.position.distanceToSquared(pp);
    for (const o of this.list) {
      if (o === b || o.behavior !== 'ninja' || o.isDragonPart || o.controlled || !o.alive) continue;
      const d = o.mesh.position.distanceToSquared(pp);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best === b;
  }

  spawn(typeId, position, opts = null) {
    const b = new Balloon(typeId, opts);
    b.mesh.position.copy(position);
    b.manager = this;        // 供忍者反查管理器（最近判定 / 投掷）
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

  update(dt, target, camera, opts = {}) {
    this._playerPos = target;   // cache player pos for nearest-ninja check
    const freezeNormal = !!opts.freezeNormal;
    const freezeBoss   = !!opts.freezeBoss;
    for (const b of this.list) {
      const isBossBal = b.isBoss || b.isDragonPart;
      b._frozen = isBossBal ? freezeBoss : freezeNormal;
      if (b._frozen) continue;           // 冻结：跳过移动/行为，但仍可被击中/受击/死亡（由 game 层独立处理）
      b.update(dt, target, camera);
      if (b.depthSprite) b.depthSprite.material.uniforms.uDebugDepth.value = this.depthDebug ? 1 : 0;
    }
    this._applySeparation();
    this._applyHealAura(dt);

  }

  // 心型怪治疗光环：每秒为 healRadius 内的其他敌人恢复 healAura 血量
  _applyHealAura(dt) {
    for (const h of this.list) {
      if (h.behavior !== 'heal' || !h.alive || h._frozen) continue; // 冻结中的治疗者暂停治疗
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
      if (a.controlled || a._frozen) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.controlled || b._frozen) continue;
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
    for (let i = this.list.length - 1; i >= 0; i--) this.remove(this.list[i]);
  }

  get count() { return this.list.length; }
}
