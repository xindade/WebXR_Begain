// 开场动画模型：第3/9/15关开局时，在玩家前方加载「魔术师动画版」GLB，
// 循环播放其内嵌动画 10 秒后自动从场景移除并释放资源。
// 参照 LaserLevel / DragonBoss 的风格：持有 scene + mixer + timer，由 Game 在关卡开始实例化、update 驱动、切关时 dispose。
// GLB 经共享缓存（glbCache.js）加载：跨关复用，每次 clone 独立实例（dispose 只摘除、不释放共享资源）。
import * as THREE from 'three';
import { loadGLB, cloneGLBScene } from './glbCache.js';

export const MODEL_URL = 'Model/魔术师动画版.glb'; // 单一事实来源（main.js 预加载复用）
const SHOW_SECONDS = 10;      // 出现后循环播放的时长，到时自动消失
const TARGET_HEIGHT = 2.0;    // 自动缩放到约 2 米高，保证稳定可见

export class OpeningModel {
  constructor(scene, position) {
    this.scene = scene;
    this.position = position.clone();
    this.root = null;        // 加载完成后的 GLB 根节点
    this.mixer = null;       // 动画混合器（无动画则为 null）
    this._t = 0;             // 已显示时长累计（秒）
    this._ready = false;     // 模型已加入场景、开始计时
    this._disposed = false;  // 防止重复释放
  }

  // 异步加载并播放；加载失败仅告警、不影响关卡进行
  // GLB 走共享缓存（glbCache.js）：跨关复用同一 gltf，本实例 clone 独立 root + 独立 mixer
  start() {
    loadGLB(MODEL_URL)
      .then((gltf) => {
        // 极少见：关卡已切走（dispose 先发生）→ 不挂场景。
        // gltf 是共享缓存资源，绝不能释放（由 glbCache 跨关持有）
        if (this._disposed) return;

        this.root = cloneGLBScene(gltf); // 克隆：独立实例 + 独立 mixer

        // 自动缩放到约 TARGET_HEIGHT 米高（不受 GLB 原生尺寸影响）
        this.root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(this.root);
        const size = box.getSize(new THREE.Vector3());
        if (size.y > 0) this.root.scale.setScalar(TARGET_HEIGHT / size.y);

        this.root.position.copy(this.position);
        this.scene.add(this.root);

        // 播放第 1 条内嵌动画（node_0动作.001），循环
        if (gltf.animations && gltf.animations.length) {
          this.mixer = new THREE.AnimationMixer(this.root);
          const action = this.mixer.clipAction(gltf.animations[0]);
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.play();
        }

        this._ready = true; // 计时起点：从真正出现在场景这一刻算起
      })
      .catch((err) => { console.warn('[OpeningModel] 加载失败，跳过开场动画:', err); });
  }

  // 每帧由 Game.update 调用：推进动画 + 计时，到点自动消失
  update(dt) {
    if (!this._ready || this._disposed) return;
    if (this.mixer) this.mixer.update(dt);
    this._t += dt;
    if (this._t >= SHOW_SECONDS) this.dispose();
  }

  // 幂等释放：移出场景、停动画。root 是共享 gltf 的 clone，
  // geometry/material 由 glbCache 跨关持有 → 只摘除、不 dispose
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._ready = false;

    // 停掉动画：AnimationMixer 只有 stopAllAction()，没有 stop()
    if (this.mixer) {
      try { this.mixer.stopAllAction(); } catch (e) { console.warn('[OpeningModel] 停止动画失败:', e); }
      this.mixer = null;
    }
    if (this.root) {
      this.scene.remove(this.root);
      this.root = null; // 共享 geometry/material 由 glbCache 跨关持有
    }
  }
}
