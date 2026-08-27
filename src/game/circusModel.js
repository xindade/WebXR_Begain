// 马戏团模型：第3/9/15关固定场景装饰，常驻整关（区别于开场魔术师动画的 10 秒自动消失）。
// 读 CIRCUS 配置（位置/旋转/缩放），经共享缓存 glbCache 加载，clone 独立实例；切关 dispose 摘除。
// 缩放策略：先把模型归一化到 BASE_HEIGHT 米高，再乘 CIRCUS.SCALE（=整体缩放倍数，1.0≈2米高基准）。
import * as THREE from 'three';
import { loadGLB, cloneGLBScene } from './glbCache.js';
import { CIRCUS } from '../core/constants.js';

const D2R = THREE.MathUtils.degToRad;
const BASE_HEIGHT = 2.0;   // 归一化基准高度（米）：SCALE=1.0 时模型约 2 米高

export class CircusModel {
  constructor(scene) {
    this.scene = scene;
    this.root = null;        // 加载完成后的 GLB 根节点
    this.mixer = null;       // 动画混合器（无动画则为 null）
    this._disposed = false;  // 防止重复释放
  }

  // 异步加载并挂场景；失败仅告警、不影响关卡进行
  start() {
    loadGLB(CIRCUS.MODEL_URL)
      .then((gltf) => {
        // 关卡已切走（dispose 先发生）→ 不挂场景；gltf 是共享缓存，绝不能释放
        if (this._disposed) return;

        this.root = cloneGLBScene(gltf);
        this.root.updateMatrixWorld(true);

        // 归一化高度后套用整体缩放倍数
        const box = new THREE.Box3().setFromObject(this.root);
        const size = box.getSize(new THREE.Vector3());
        if (size.y > 0) this.root.scale.setScalar((BASE_HEIGHT / size.y) * CIRCUS.SCALE);

        this.root.position.set(CIRCUS.POSITION.x, CIRCUS.POSITION.y, CIRCUS.POSITION.z);
        this.root.rotation.set(D2R(CIRCUS.ROTATION.x), D2R(CIRCUS.ROTATION.y), D2R(CIRCUS.ROTATION.z));
        this.scene.add(this.root);

        // 若有内嵌动画则循环播放
        if (gltf.animations && gltf.animations.length) {
          this.mixer = new THREE.AnimationMixer(this.root);
          const action = this.mixer.clipAction(gltf.animations[0]);
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.play();
        }
      })
      .catch((err) => { console.warn('[CircusModel] 加载失败，跳过马戏团:', err); });
  }

  // 每帧由 Game.update 调用：推进动画
  update(dt) {
    if (this.mixer) this.mixer.update(dt);
  }

  // 幂等释放：移出场景、停动画。root 是共享 gltf 的 clone，geometry/material 由 glbCache 跨关持有 → 只摘除、不 dispose
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.mixer) {
      try { this.mixer.stopAllAction(); } catch (e) { console.warn('[CircusModel] 停止动画失败:', e); }
      this.mixer = null;
    }
    if (this.root) {
      this.scene.remove(this.root);
      this.root = null; // 共享 geometry/material 由 glbCache 跨关持有
    }
  }
}
