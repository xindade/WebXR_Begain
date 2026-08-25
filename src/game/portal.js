// 传送门装饰：小怪关（非 boss、非激光机制）按本关方向表在场地中心四周生成，
// 循环播放「传送门动画.glb」内嵌动画，叠加整体轻微上下浮动（sin）。
// 纯视觉装饰（不做摇杆操控、不挂数值标签），不影响射击/碰撞/出怪。
// 结构仿 openingModel.js：持有 scene + root + mixer，由 Game 在关卡加载时实例化、
// update 驱动、切关/回菜单时 dispose。
// 所有尺寸/朝向/距离参数集中在 constants.js 的 PORTAL / PORTAL_BEAM 配置块。
// GLB 经共享缓存（glbCache.js）加载：跨关复用，每门 clone 独立实例（dispose 只摘除、不释放共享资源）。
import * as THREE from 'three';
import { PORTAL } from '../core/constants.js';
import { loadGLB, cloneGLBScene } from './glbCache.js';

export const MODEL_URL = 'Model/传送门动画.glb'; // 单一事实来源（main.js 预加载复用）

export class Portal {
  constructor(scene, position, rotation = null) {
    this.scene = scene;
    this.base = position.clone();          // 基准位置（浮动围绕其 y 上下偏移）
    // 绕本地 X/Y/Z 三轴旋转（弧度，左右门定向用）：{x, y, z}，缺省全 0
    this._rot = rotation || { x: 0, y: 0, z: 0 };
    this.root = null;                      // 加载完成后的 GLB 根节点
    this.mixer = null;                     // 动画混合器（无动画则为 null）
    this._phase = Math.random() * Math.PI * 2; // 随机相位，让各门浮动态势错开
    this._t = 0;                           // 已存活时长累计（秒）
    this._ready = false;                   // 模型已加入场景、开始计时
    this._disposed = false;                // 防止重复释放
  }

  // 异步加载并播放；加载失败仅告警、不影响关卡进行
  // GLB 走共享缓存（glbCache.js）：跨关复用同一 gltf，本门 clone 独立实例 + 独立 mixer
  start() {
    loadGLB(MODEL_URL)
      .then((gltf) => {
        // 极少见：关卡已切走（dispose 先发生）→ 不挂场景。
        // gltf 是共享缓存资源，绝不能释放（由 glbCache 跨关持有）
        if (this._disposed) return;

        this.root = cloneGLBScene(gltf); // 克隆：各门各自独立实例 + 独立 mixer

        // 缩放 = (目标高度/原始高) × 整体倍数：TARGET_HEIGHT 定基准高度，SCALE 再整体放大/缩小。
        // 两者解耦：改高度不影响 SCALE 语义，改 SCALE 高宽厚一起变。
        this.root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(this.root);
        const size = box.getSize(new THREE.Vector3());
        if (size.y > 0) this.root.scale.setScalar((PORTAL.TARGET_HEIGHT / size.y) * (PORTAL.SCALE || 1));

        this.root.position.copy(this.base);
        // 应用三轴旋转（X/Y/Z，弧度）
        this.root.rotation.set(this._rot.x || 0, this._rot.y || 0, this._rot.z || 0);
        this.scene.add(this.root);

        // 播放第 1 条内嵌动画，循环（mixer 绑定克隆体 root，动画状态独立）
        if (gltf.animations && gltf.animations.length) {
          this.mixer = new THREE.AnimationMixer(this.root);
          const action = this.mixer.clipAction(gltf.animations[0]);
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.play();
        }

        this._ready = true;
      })
      .catch((err) => { console.warn('[Portal] 加载失败，跳过传送门:', err); });
  }

  // 每帧由 Game.update 调用：推进动画 + 上下浮动
  // playerPos：保留签名（出怪光点用 getWorldPos，不依赖此参数），忽略。
  update(dt, playerPos) {
    if (!this._ready || this._disposed) return;
    if (this.mixer) this.mixer.update(dt);
    this._t += dt;
    // 位置 = 基准 + 上下浮动（浮动仅 y，幅度见 PORTAL.FLOAT_AMP）
    const fy = this.base.y
             + Math.sin(this._t * Math.PI * 2 * PORTAL.FLOAT_FREQ + this._phase) * PORTAL.FLOAT_AMP;
    this.root.position.set(this.base.x, fy, this.base.z);
  }

  // 传送门稳定中心世界坐标（供出怪光点起点使用）
  // out 可传入复用 Vector3；root 未加载完成也有效（只用构造时就确定的 base）
  getWorldPos(out) {
    out = out || new THREE.Vector3();
    return out.set(this.base.x, this.base.y, this.base.z);
  }

  // 幂等释放：移出场景、停止动画（共享 GLB 资源由 glbCache 持有，只摘除、绝不 dispose）
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._ready = false;

    // 停掉动画：AnimationMixer 只有 stopAllAction()，没有 stop()
    if (this.mixer) {
      try { this.mixer.stopAllAction(); } catch (e) { console.warn('[Portal] 停止动画失败:', e); }
      this.mixer = null;
    }
    if (this.root) {
      this.scene.remove(this.root);
      // ⚠️ root 是共享 gltf 的 clone：geometry/material/texture 由 glbCache 跨关持有，
      //    只摘除、绝不 dispose（否则首关后缓存资源被释放，重进关克隆失效）
      this.root = null;
    }
  }
}
