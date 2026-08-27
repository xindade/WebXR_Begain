import * as THREE from 'three';
import { loadGLB, cloneGLBScene } from '../game/glbCache.js';
import { LASER_SWORD } from '../core/constants.js';

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
    this._applyTransform();
    if (this._attached) return;
    const anchor = input?.getGrip('left');   // 左手握把空间
    if (anchor) { anchor.add(this.root); this._attached = true; }
  }

  _applyTransform() {
    this.root.position.set(LASER_SWORD.POSITION.x, LASER_SWORD.POSITION.y, LASER_SWORD.POSITION.z);
    this.root.rotation.set(D2R(LASER_SWORD.ROTATION.x), D2R(LASER_SWORD.ROTATION.y), D2R(LASER_SWORD.ROTATION.z));
    this.root.scale.setScalar(LASER_SWORD.SCALE);
  }

  // 选卡装备/卸下：控制可见性（未装备时同时结束伤害状态）
  setEquipped(v) {
    this._equipped = !!v;
    this.root.visible = this._equipped;
    if (!this._equipped) this._active = false;
  }

  // 激活/结束「5秒伤害状态」（仅改状态标志，不改变可见性——装备后始终可见）
  setActive(v) {
    this._active = !!v && this._equipped;
  }

  get active() { return this._active; }

  // 取剑刃世界线段：hilt=剑柄(模型原点)，tip=剑尖 = hilt + 本地 BLADE_AXIS 旋转到世界 × BLADE_LENGTH。
  // 用于 game.js 线段-球命中。强制刷新世界矩阵，确保左手柄最新位姿。
  getBlade(outHilt, outTip) {
    this.root.updateWorldMatrix(true, false);
    this.root.getWorldPosition(outHilt);
    this.root.getWorldQuaternion(_q);
    _axis.set(LASER_SWORD.BLADE_AXIS.x, LASER_SWORD.BLADE_AXIS.y, LASER_SWORD.BLADE_AXIS.z)
      .normalize().applyQuaternion(_q);
    outTip.copy(outHilt).addScaledVector(_axis, LASER_SWORD.BLADE_LENGTH);
  }
}

const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();
