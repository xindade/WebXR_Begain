import * as THREE from 'three';
import { loadGLB, cloneGLBScene } from '../game/glbCache.js';
import { LASER_SWORD, INPUT } from '../core/constants.js';

const D2R = THREE.MathUtils.degToRad;

// 左手柄激光剑：加载 激光剑.glb → 幂等挂到左手柄(grip) → 每帧从 LASER_SWORD 配置应用变换。
// 选卡装备后常驻左手（可见）；按左手柄 grip 激活「5秒伤害状态」(setActive) 期间，
// game.js 每帧用 getBlade() 取剑柄/剑尖世界坐标做线段-球命中。纯视觉模型 + 命中几何辅助，伤害在 game 侧结算。
// 挂接模式参照 rightGun.js：模型异步加载、控制器连接前 getGrip('left') 为 null，故每帧尝试挂载，挂上后置 _attached 跳过。
export class LeftSword {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();   // 持有层：LASER_SWORD 变换作用在此层（模型作为子节点）
    this.model = null;               // 加载完成的 glb 克隆
    this._attached = false;          // 是否已挂到左手柄（幂等）
    this._equipped = false;          // 是否装备（选卡后 true → 可见）
    this._active = false;            // 是否处于「5秒伤害状态」
    this._scaleMul = LASER_SWORD.SWORD_IDLE_SCALE; // 当前视觉缩放系数（相对 base）
    this._phase = 'idle';            // idle | grow1 | hold | grow2 | active | shrink
    this._phaseT = 0;                // 当前阶段计时(s)
    this._readyForDamage = false;    // 完全展开后才 true（完全展开后才结算伤害）
    this._shrinkFrom = LASER_SWORD.SWORD_IDLE_SCALE; // 反向缩回动画的起始系数
    this._load();
    this.root.visible = false;       // 未装备时不可见
  }

  // 异步加载模型（走共享缓存 glbCache.js，与传送门/开场动画一致，零重复加载）
  _load() {
    loadGLB(LASER_SWORD.MODEL_URL)
      .then((gltf) => {
        this.model = cloneGLBScene(gltf);
        this.root.add(this.model);
        window.__pageLog?.info('[LeftSword] 激光剑模型加载完成');
      })
      .catch((err) => {
        console.error('[LeftSword] 模型加载失败:', err);
        window.__pageLog?.error('[LeftSword] 激光剑加载失败：' + (err?.message || err));
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(0.08, 0.08, 0.9),
          new THREE.MeshBasicMaterial({ color: 0x33ddff, wireframe: true })
        );
        this.root.add(box);
      });
  }

  // 每帧调用：幂等挂到左手柄，并从 LASER_SWORD 配置实时应用变换（便于控制台/刷新即时调参）
  update(dt, input) {
    this._advanceScale(dt);          // 先推进缩放动画（dt 已在 game.js 钳制 ≤0.05）
    this._applyTransform();
    if (this._attached) return;
    const anchor = input?.getGrip(INPUT.SWAP_HANDS ? 'right' : 'left');   // 左手握把空间（SWAP_HANDS 时交换到右手柄以校正 PICO 左右反）
    if (anchor) { anchor.add(this.root); this._attached = true; }
  }

  _applyTransform() {
    this.root.position.set(LASER_SWORD.POSITION.x, LASER_SWORD.POSITION.y, LASER_SWORD.POSITION.z);
    this.root.rotation.set(D2R(LASER_SWORD.ROTATION.x), D2R(LASER_SWORD.ROTATION.y), D2R(LASER_SWORD.ROTATION.z));
    this.root.scale.setScalar(LASER_SWORD.SCALE * this._scaleMul); // 每帧从常量重置后再乘动画系数
  }

  // 释放缩放动画状态机：idle(待机0.1×) → grow1(0.5s×5) → hold(0.2s) → grow2(0.5s×2回到base) → active(满尺寸) → shrink(平滑缩回)
  _advanceScale(dt) {
    const C = LASER_SWORD;
    const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
    switch (this._phase) {
      case 'grow1':
        this._phaseT += dt;
        this._scaleMul = lerp(C.SWORD_IDLE_SCALE, C.SWORD_IDLE_SCALE * C.SWORD_GROW_STEP, this._phaseT / C.SWORD_GROW_TIME);
        if (this._phaseT >= C.SWORD_GROW_TIME) { this._phase = 'hold'; this._phaseT = 0; }
        break;
      case 'hold':
        this._phaseT += dt;
        if (this._phaseT >= C.SWORD_HOLD) { this._phase = 'grow2'; this._phaseT = 0; }
        break;
      case 'grow2':
        this._phaseT += dt;
        this._scaleMul = lerp(C.SWORD_IDLE_SCALE * C.SWORD_GROW_STEP,
                              C.SWORD_IDLE_SCALE * C.SWORD_GROW_STEP * C.SWORD_GROW2_STEP,
                              this._phaseT / C.SWORD_GROW2_TIME);
        if (this._phaseT >= C.SWORD_GROW2_TIME) {
          this._phase = 'active';
          this._scaleMul = C.SWORD_IDLE_SCALE * C.SWORD_GROW_STEP * C.SWORD_GROW2_STEP; // = base（回到原尺寸）
          this._readyForDamage = true; // 完全展开 → 才开始生效伤害
        }
        break;
      case 'shrink':
        this._phaseT += dt;
        this._scaleMul = lerp(this._shrinkFrom, C.SWORD_IDLE_SCALE, this._phaseT / C.SWORD_SHRINK_TIME);
        if (this._phaseT >= C.SWORD_SHRINK_TIME) {
          this._phase = 'idle'; this._scaleMul = C.SWORD_IDLE_SCALE; this._readyForDamage = false;
        }
        break;
      case 'active': // 完全展开后停留满尺寸，直到 setActive(false) 才进入 shrink（修复：否则落入 default 被每帧重置为 idle 短剑）
        break;
      default: // idle
        this._scaleMul = C.SWORD_IDLE_SCALE;
    }
  }

  // 选卡装备/卸下：控制可见性（未装备时同时结束伤害状态 + 播放缩回动画）
  setEquipped(v) {
    this._equipped = !!v;
    this.root.visible = this._equipped;
    if (!this._equipped) {
      this._active = false;
      if (this._phase !== 'idle') { this._phase = 'shrink'; this._phaseT = 0; this._shrinkFrom = this._scaleMul; }
      this._readyForDamage = false;
    }
  }

  // 激活/结束「5秒伤害状态」（仅改状态标志，不改变可见性——装备后始终可见）
  setActive(v) {
    const on = !!v && this._equipped;
    this._active = on;
    if (on) {
      this._phase = 'grow1'; this._phaseT = 0;
      this._scaleMul = LASER_SWORD.SWORD_IDLE_SCALE; this._readyForDamage = false;
    } else if (this._phase !== 'idle') {
      // 进入反向缩回动画（平滑回到待机 0.1×）
      this._phase = 'shrink'; this._phaseT = 0; this._shrinkFrom = this._scaleMul; this._readyForDamage = false;
    }
  }

  get active() { return this._active; }
  get readyForDamage() { return this._readyForDamage; }

  // 取剑刃世界线段：hilt=剑柄(模型原点)，tip=剑尖 = hilt + 本地 BLADE_AXIS 旋转到世界 × BLADE_LENGTH。
  // 用于 game.js 线段-球命中。强制刷新世界矩阵，确保左手柄最新位姿。
  getBlade(outHilt, outTip) {
    this.root.updateWorldMatrix(true, false);
    this.root.getWorldPosition(outHilt);
    this.root.getWorldQuaternion(_q);
    _axis.set(LASER_SWORD.BLADE_AXIS.x, LASER_SWORD.BLADE_AXIS.y, LASER_SWORD.BLADE_AXIS.z)
      .normalize().applyQuaternion(_q);
    // 命中线段长度 = 本地刃长 × 整体缩放，与可见剑刃一致（damage 仅完全展开时结算，此时视觉 scale=base，一致）
    outTip.copy(outHilt).addScaledVector(_axis, LASER_SWORD.BLADE_LENGTH * LASER_SWORD.SCALE);
  }
}

const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();
