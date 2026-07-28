// 开场动画模型：第3/9/15关开局时，在玩家前方加载「魔术师动画版」GLB，
// 循环播放其内嵌动画 10 秒后自动从场景移除并释放资源。
// 参照 LaserLevel / DragonBoss 的风格：持有 scene + mixer + timer，由 Game 在关卡开始实例化、update 驱动、切关时 dispose。
import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/GLTFLoader.js';
import { DRACOLoader } from '../../vendor/DRACOLoader.js';

const MODEL_URL = 'Model/魔术师动画版.glb';
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
  start() {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('vendor/draco/');
    loader.setDRACOLoader(draco);

    loader.load(
      MODEL_URL,
      (gltf) => {
        // 极少见：关卡已切走（dispose 先发生）→ 释放本次加载的几何/材质，不入场景
        if (this._disposed) {
          gltf.scene.traverse((o) => {
            if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
          });
          return;
        }

        this.root = gltf.scene;

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
      },
      undefined,
      (err) => { console.warn('[OpeningModel] 加载失败，跳过开场动画:', err); }
    );
  }

  // 每帧由 Game.update 调用：推进动画 + 计时，到点自动消失
  update(dt) {
    if (!this._ready || this._disposed) return;
    if (this.mixer) this.mixer.update(dt);
    this._t += dt;
    if (this._t >= SHOW_SECONDS) this.dispose();
  }

  // 幂等释放：移出场景、释放私有几何/材质、停止动画
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
      // 本类每次新建 GLTFLoader 单独加载，root 不与他人共享 → 可整体释放
      this.root.traverse((o) => {
        if (o.isMesh) {
          o.geometry?.dispose?.();
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material?.dispose?.();
        }
      });
      this.root = null;
    }
  }
}
