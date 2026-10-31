import * as THREE from 'three';
import { CHARACTERS, GUN, BUDDHA } from '../../core/constants.js';
import { loadGLB, cloneGLBScene } from '../glbCache.js';
import { swarmState, archSlotOrder } from './rules.js';

const _camPos = new THREE.Vector3();
const _aimPos = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _aimDir = new THREE.Vector3();
const _slotDir = new THREE.Vector3();
const _shotDir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _gunUp = new THREE.Vector3();
const _gunRight = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _muzzle = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _targetPos = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const D2R = Math.PI / 180;

/**
 * 第八十五修 · 蜂群浮游炮。
 * 第八十六修：改为拱门排布 + 复用玩家手上的 AK 枪模。
 *
 * 设计约束：
 *   · 枪模从 GLB 缓存克隆（AK 只有 1 个 mesh/material ⇒ 满 10 支也只有 10 次 Draw Call）；
 *   · 拱门在玩家正前方，按「两侧先出现、逐对向中间补」的顺序填充；
 *   · 主枪只发一条弹道，副枪与主枪同一扳机开火；
 *   · 默认自动索敌（不再需要「自动开火」道具）；「集中火力」在瞄精英/Boss 时全员集火，
 *     每级提升浮游炮基础攻击 10%，最高 6 级。
 */
export class SatelliteRig {
  constructor(scene, camera, cfg = CHARACTERS.swarm.satellite) {
    this.scene = scene;
    this.camera = camera;
    this.cfg = cfg;
    this.count = 0;
    this.dmgMul = cfg.DMG_MUL || 0.4;
    this._prevCount = 0;
    this._slotX = archSlotOrder(cfg.MAX);
    this._slots = [];
    this._modelsReady = false;

    this.root = new THREE.Group();
    this.root.visible = false;
    scene.add(this.root);

    for (let i = 0; i < cfg.MAX; i++) {
      const pivot = new THREE.Group();
      pivot.visible = false;
      this.root.add(pivot);
      this._slots.push({ pivot, model: null });
    }
    this._loadModels();
  }

  /** AK 模型：包围盒最长轴 = X，枪口在 +X（已单独渲染确认）。 */
  _loadModels() {
    loadGLB(GUN.MODEL_URL).then((gltf) => {
      const src = cloneGLBScene(gltf);
      src.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(src);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const scale = (this.cfg.MODEL_LENGTH || 0.38) / maxDim;
      const muzzleDist = (this.cfg.MODEL_LENGTH || 0.38) * 0.5 + 0.01;
      for (const slot of this._slots) {
        const model = src.clone(true);
        model.position.sub(center);
        const holder = new THREE.Group();
        holder.scale.setScalar(scale);
        holder.add(model);
        slot.pivot.add(holder);
        slot.model = model;
        slot.muzzleDist = muzzleDist;
      }
      this._modelsReady = true;
      window.__pageLog?.info?.('[SatelliteRig] 浮游炮枪模加载完成');
    }).catch((err) => {
      console.error('[SatelliteRig] 枪模加载失败:', err);
      const geo = new THREE.BoxGeometry(0.30, 0.07, 0.045);
      const mat = new THREE.MeshBasicMaterial({ color: 0x3d4652 });
      for (const slot of this._slots) {
        const box = new THREE.Mesh(geo, mat);
        slot.pivot.add(box);
        slot.model = box;
        slot.muzzleDist = 0.16;
      }
      this._modelsReady = true;
    });
  }

  _syncState(game) {
    if (game.player?.fireMode !== 'satellite' || game._introActive || game.shopMode
      || game.state === 'menu' || game.state === 'intro' || game.state === 'over' || game.state === 'card') {
      this.count = 0;
      this.overflow = 0;
      return { count: 0, dmgMul: 0, overflow: 0 };
    }
    const st = swarmState(game.player?.shotCount || 1, game.player?.bonusShotCount || 0, this.cfg);
    this.count = st.count;
    this.dmgMul = st.dmgMul;
    this.overflow = st.overflow;
    return st;
  }

  _hideAll() {
    for (const s of this._slots) s.pivot.visible = false;
  }

  /** 每帧：拱门跟随玩家，整体朝向由右手枪支决定。 */
  update(dt, game) {
    const st = this._syncState(game);
    if (st.count <= 0) {
      this.root.visible = false;
      this._hideAll();
      this._prevCount = 0;
      return;
    }
    this.root.visible = true;

    const cam = this.camera;
    cam.getWorldPosition(_camPos);
    cam.getWorldDirection(_forward);
    // 第八十九修：只认「真实射击射线」——与子弹同源的 input.getMuzzle（含手部姿态 + 设备补偿角）。
    //   ⚠ 旧实现把右手枪模型的本地 +X 当枪口轴，但 +X 只是模型自身的一根轴，与手柄 -Z 的
    //     实际瞄准方向相差很大；枪一转，浮游炮就被带着自转，子弹甚至会与枪身垂直。
    //   现在：位置随瞄准方向的水平投影移动（前后左右），姿态只由该射线/索敌目标决定。
    _aimPos.copy(_camPos);
    cam.getWorldDirection(_shotDir);
    if (game.input && typeof game.input.getMuzzle === 'function') {
      game.input.getMuzzle(_aimPos, _shotDir);
    }
    if (_shotDir.lengthSq() < 1e-6) cam.getWorldDirection(_shotDir);
    _shotDir.normalize();
    _forward.copy(_shotDir);
    _forward.y = 0;
    if (_forward.lengthSq() < 1e-6) _forward.set(0, 0, -1);
    _forward.normalize();
    _right.crossVectors(_forward, _worldUp).normalize();

    const focus = this._focusTarget(game, _aimPos, _shotDir, this._focusLevel(game));
    // 默认索敌：始终优先当前瞄准的精英/Boss，否则取前方锥形内最近的怪。
    const target = focus || (this._autoTrack(game) ? this._nearestTarget(game, _aimPos, _shotDir) : null);
    const hasTarget = !!target;
    if (hasTarget) _targetPos.copy(target.mesh.position);

    for (let i = 0; i < this._slots.length; i++) {
      const slot = this._slots[i];
      if (i >= st.count) { slot.pivot.visible = false; continue; }
      slot.pivot.visible = true;

      const nx = this._slotX[i] != null ? this._slotX[i] : 0;
      const arch = Math.sqrt(Math.max(0, 1 - nx * nx));
      _pos.copy(_camPos)
        .addScaledVector(_forward, this.cfg.ARCH_FRONT_DIST || 1.35)
        .addScaledVector(_right, nx * (this.cfg.ARCH_HALF_WIDTH || 0.95));
      _pos.y = _camPos.y + (this.cfg.ARCH_BASE_OFFSET || -0.30) + arch * (this.cfg.ARCH_HEIGHT || 0.58);
      slot.pivot.position.copy(_pos);

      // 无索敌时枪身与本次射击射线**严格平行**（不能朝「前方 10m 的一点」收拢，
      // 否则两侧浮游炮会与自己的弹道形成几度夹角 —— 现场看到的就是「子弹不在枪管线上」）。
      if (hasTarget) {
        _dir.copy(_targetPos).sub(_pos);
        if (_dir.lengthSq() < 1e-6) _dir.copy(_shotDir);
        else _dir.normalize();
      } else {
        _dir.copy(_shotDir);
      }
      this._orientGun(slot.pivot, _dir);
    }

    this._prevCount = st.count;
  }

  /**
   * 枪模 +X = 枪口，+Y = 枪身向上；用正交基把枪口对准目标。
   * 第八十八修：+Y 一律取世界向上（而不是头显的 up）——
   *   旧实现把相机的滚转带进浮游炮，玩家转头/转枪时浮游炮会绕自身枪管自转，
   *   视觉上就像「枪身和弹道短暂不同轴」。浮游炮只需要瞄准转向，不需要继承头部滚转。
   */
  _orientGun(pivot, dir) {
    _gunUp.copy(_worldUp);
    _gunUp.addScaledVector(dir, -_gunUp.dot(dir));
    if (_gunUp.lengthSq() < 1e-5) {
      _gunUp.set(0, 0, 1).addScaledVector(dir, -dir.z);
      if (_gunUp.lengthSq() < 1e-5) _gunUp.set(0, 1, 0);
    }
    _gunUp.normalize();
    _gunRight.crossVectors(dir, _gunUp).normalize();
    _mat.makeBasis(dir, _gunUp, _gunRight);
    _quat.setFromRotationMatrix(_mat);
    pivot.quaternion.copy(_quat);
  }

  _collectTargets(game, origin, forward) {
    const list = game.balloons?.list;
    const out = [];
    if (!list || !list.length) return out;
    const minDot = Math.cos((this.cfg.AIM_CONE_DEG || 60) * D2R);
    const maxD2 = (this.cfg.AIM_RANGE || 30) ** 2;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!b || !b.alive || !b.mesh) continue;
      if (b.behavior === 'ghost' && !b.revealed) continue;
      _aimDir.copy(b.mesh.position).sub(origin);
      const d2 = _aimDir.lengthSq();
      if (d2 > maxD2 || d2 < 1e-4) continue;
      _aimDir.normalize();
      if (_aimDir.dot(forward) < minDot) continue;
      out.push({ b, d2 });
    }
    out.sort((a, b) => a.d2 - b.d2);
    return out;
  }

  _nearestTarget(game, origin, forward) {
    const t = this._collectTargets(game, origin, forward);
    return t.length ? t[0].b : null;
  }

  /** 集中火力：仅在玩家瞄准精英/Boss（含龙部件）时返回该目标。 */
  _focusTarget(game, origin, forward, level) {
    if (level <= 0) return null;
    const list = game.balloons?.list;
    if (!list || !list.length) return null;
    const minDot = Math.cos((this.cfg.FOCUS_CONE_DEG || 12) * D2R);
    const maxD2 = (this.cfg.AIM_RANGE || 30) ** 2;
    let best = null, bestD2 = Infinity;
    for (const b of list) {
      if (!b || !b.alive || !b.mesh) continue;
      if (!(b.isElite || b.isBoss || b.isDragonPart)) continue;
      if (b.behavior === 'ghost' && !b.revealed) continue;
      _aimDir.copy(b.mesh.position).sub(origin);
      const d2 = _aimDir.lengthSq();
      if (d2 > maxD2 || d2 < 1e-4) continue;
      _aimDir.normalize();
      if (_aimDir.dot(forward) < minDot) continue;
      if (d2 < bestD2) { bestD2 = d2; best = b; }
    }
    return best;
  }

  _focusLevel(game) {
    return game._itemLevel ? (game._itemLevel('focusFire') || 0) : 0;
  }

  /** 教学关蜂群：拿到「自动追踪」教学卡前不索敌，严格沿枪管直射。 */
  _autoTrack(game) {
    return game._satelliteAutoTrack !== false;
  }

  _palmMul(game) {
    const pw = BUDDHA.PALM_WIND || {};
    return (pw.ENABLED && game._gameTime < game._palmWindUntil) ? (pw.DAMAGE_MUL || 1) : 1;
  }

  _fireAtTargets(game, targets, boost, palmDamageMul, focusLevel, fallbackDirection) {
    const focusMul = 1 + Math.max(0, focusLevel) * (this.cfg.FOCUS_DMG_PER_LEVEL || 0.1);
    const dmg = (game.player?.atk || 0) * this.dmgMul * (palmDamageMul || 1) * focusMul;
    const opts = {
      tint: this.cfg.BULLET_TINT,
      scale: this.cfg.BULLET_SCALE,
      trailMul: this.cfg.TRAIL_MUL,
    };
    let fired = 0;
    for (let i = 0; i < this.count; i++) {
      const slot = this._slots[i];
      const t = targets.length ? targets[i % targets.length].b || targets[i % targets.length] : null;
      const pivot = slot.pivot;
      // 先让枪身转向，再从**同一个四元数**取子弹方向与枪口位置。
      // 旧实现枪身用 update 的目标、子弹用 fire 的目标，目标快速变化时会短暂不同轴。
      if (t && t.mesh) _slotDir.copy(t.mesh.position).sub(pivot.position);
      else _slotDir.copy(fallbackDirection || _shotDir);
      if (_slotDir.lengthSq() < 1e-6) continue;
      _slotDir.normalize();
      this._orientGun(pivot, _slotDir);
      _slotDir.set(1, 0, 0).applyQuaternion(pivot.quaternion).normalize();
      _muzzle.copy(pivot.position).addScaledVector(_slotDir, slot.muzzleDist || 0.19);
      game.bullets.spawn(_muzzle, _slotDir, dmg, boost, opts);
      fired++;
    }
    return fired;
  }

  /**
   * 主枪开火时调用。返回实际发射的副枪弹数（供串糖葫芦/宝箱计数）。
   * 副枪不继承掌风弹贴图，只继承掌风弹的伤害倍率。
   */
  fire(game, shot, boost, palmDamageMul = 1) {
    if (this.count <= 0 || !shot || game.player?.forceSingleShot) return 0;
    if (game.shopMode || game.state === 'card') return 0;
    const focusLv = this._focusLevel(game);
    _shotDir.copy(shot.direction);
    if (_shotDir.lengthSq() < 1e-6) this.camera.getWorldDirection(_shotDir);
    _shotDir.normalize();
    const focus = this._focusTarget(game, shot.position, _shotDir, focusLv);
    // 默认自动索敌；玩家瞄准精英/Boss（集中火力）时全员集火该目标。
    const targets = focus ? [{ b: focus }]
      : (this._autoTrack(game) ? this._collectTargets(game, shot.position, _shotDir) : []);
    // 无索敌时用本次主枪实际射向（shot.direction）兜底：枪身会先转到这个方向再出弹，
    // 保证「枪管指向 = 弹道」；必须用本次主枪的射向，不能缓存上一帧。
    return this._fireAtTargets(game, targets, boost, palmDamageMul, focus ? focusLv : 0, _shotDir);
  }

  /** 新一局/回菜单：清掉上一局的悬浮炮实例（避免菜单里残留）。 */
  reset() {
    this.count = 0;
    this._prevCount = 0;
    this.root.visible = false;
    this._hideAll();
  }

  dispose() {
    if (!this.root) return;
    this.scene.remove(this.root);
    this.root = null;
    this._slots.length = 0;
  }
}
