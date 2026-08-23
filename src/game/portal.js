// 传送门装饰：小怪关（非 boss、非激光机制）在场地中心前后左右各放一个，
// 循环播放「传送门动画.glb」内嵌动画，叠加整体轻微上下浮动（sin），
// 并可由左手摇杆整体操控（上下/远近），门上挂 3D 数值标签（高度/距离）。
// 结构仿 openingModel.js：持有 scene + root + mixer，由 Game 在关卡加载时实例化、
// update 驱动、切关/回菜单时 dispose。纯视觉装饰，不影响射击/碰撞/出怪。
// 所有尺寸/速度/范围参数集中在 constants.js 的 PORTAL 配置块。
import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/GLTFLoader.js';
import { DRACOLoader } from '../../vendor/DRACOLoader.js';
import { PORTAL } from '../core/constants.js';

const MODEL_URL = 'Model/传送门动画.glb';

export class Portal {
  constructor(scene, position, rotation = null) {
    this.scene = scene;
    this.base = position.clone();          // 基准位置（浮动围绕其 y 上下偏移）
    // 绕本地 X/Y/Z 三轴旋转（弧度，左右门定向用）：{x, y, z}，缺省全 0
    this._rot = rotation || { x: 0, y: 0, z: 0 };
    this.root = null;                      // 加载完成后的 GLB 根节点
    this.mixer = null;                     // 动画混合器（无动画则为 null）
    this._phase = Math.random() * Math.PI * 2; // 随机相位，让 4 个门浮动态势错开
    this._t = 0;                           // 已存活时长累计（秒）
    this._ready = false;                   // 模型已加入场景、开始计时
    this._disposed = false;                // 防止重复释放

    // —— 左手摇杆可调偏移 ——
    this.offsetY = 0;        // 高度偏移（米，+ 升 / − 降），叠加到 base.y
    this.distOffset = 0;     // 径向偏移（米，+ 远离场地中心 / − 收拢），叠加到 base.xz
    // 径向单位方向（场地中心 → 本门的水平方向）：把 distOffset 正确作用到 4 个朝向不同的门。
    // 注意用普通对象存 {x, z}（THREE.Vector2 只有 .x/.y，取 .z 会是 undefined → NaN 位置）
    const len = Math.hypot(position.x, position.z) || 1;
    this.dir = { x: position.x / len, z: position.z / len };
    this.baseDist = Math.hypot(position.x, position.z); // 基准距中心距离（= PORTAL.DISTANCE_P）

    // —— 数值标签（挂 scene 手动同步位置，避开 root 缩放/旋转；见下方注释）——
    this.label = null;
    this._labelCtx = null;
    this._labelTex = null;
    this._lastH = NaN;   // 上次绘制的显示高度（NaN 保证首帧必绘）
    this._lastD = NaN;   // 上次绘制的显示距离
    this._labelTimer = 0;
    this._makeLabel();
  }

  // 异步加载并播放；加载失败仅告警、不影响关卡进行
  start() {
    // 每个传送门独立 new loader：GLTFLoader 文件级缓存只缓存原始数据，
    // 每次 load 重新 parse 出新对象 → 4 份独立 geometry，dispose 互不冲突。
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

        // 播放第 1 条内嵌动画，循环
        if (gltf.animations && gltf.animations.length) {
          this.mixer = new THREE.AnimationMixer(this.root);
          const action = this.mixer.clipAction(gltf.animations[0]);
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.play();
        }

        this._ready = true;
      },
      undefined,
      (err) => { console.warn('[Portal] 加载失败，跳过传送门:', err); }
    );
  }

  // 创建数值标签（同步，不需等模型加载）。
  // 挂 scene 而非 root：root 有等比缩放 + 左/右门绕 Z 旋转，
  // 子 sprite 会被放大且本地 +y 偏移被转到水平方向 → 标签变形/跑偏。
  _makeLabel() {
    const cfg = PORTAL.LABEL;
    const cv = document.createElement('canvas');
    cv.width = cfg.CANVAS.w; cv.height = cfg.CANVAS.h;
    this._labelCtx = cv.getContext('2d');
    this._labelTex = new THREE.CanvasTexture(cv);
    const mat = new THREE.SpriteMaterial({
      map: this._labelTex, transparent: true, depthTest: false, depthWrite: false,
    });
    this.label = new THREE.Sprite(mat);
    this.label.scale.set(cfg.W, cfg.H, 1);
    this.label.renderOrder = 999; // 始终画在最前（同 balloons 怪名牌）
    // 防加载期标签重叠在原点：先放到基准位置
    this.label.position.set(this.base.x, this.base.y + cfg.Y_OFFSET, this.base.z);
    this.scene.add(this.label);
  }

  // 双行绘制：高度（白）/ 距离（浅蓝）。节流：数值变化 < 阈值不重绘（静止省算力）。
  _drawLabel(h, d) {
    if (Math.abs(h - this._lastH) < PORTAL.LABEL.CHANGE_THRESHOLD
        && Math.abs(d - this._lastD) < PORTAL.LABEL.CHANGE_THRESHOLD) return;
    const w = PORTAL.LABEL.CANVAS.w, hh = PORTAL.LABEL.CANVAS.h;
    const ctx = this._labelCtx;
    ctx.clearRect(0, 0, w, hh);
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, w, hh); // 半透明底，提高可读性
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 40px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`高度 ${h.toFixed(1)} m`, w / 2, hh * 0.28);
    ctx.fillStyle = '#7fd7ff';
    ctx.fillText(`距离 ${d.toFixed(1)} m`, w / 2, hh * 0.72);
    this._labelTex.needsUpdate = true; // 复用同一 CanvasTexture，勿每次重建
    this._lastH = h; this._lastD = d;
  }

  // 每帧由 Game.update 调用：推进动画 + 浮动 + 摇杆偏移 + 数值标签
  // playerPos：玩家世界位置（Game 每帧取一次共用；null 时距离用兜底公式）
  update(dt, playerPos) {
    if (!this._ready || this._disposed) return;
    if (this.mixer) this.mixer.update(dt);
    this._t += dt;
    // 位置 = 基准 + 摇杆偏移 + 浮动（浮动仅 y，幅度见 PORTAL.FLOAT_AMP）
    const fx = this.base.x + this.dir.x * this.distOffset;
    const fz = this.base.z + this.dir.z * this.distOffset;
    const fy = this.base.y + this.offsetY
             + Math.sin(this._t * Math.PI * 2 * PORTAL.FLOAT_FREQ + this._phase) * PORTAL.FLOAT_AMP;
    this.root.position.set(fx, fy, fz);

    // 数值标签：位置跟浮动的 root（视觉贴合）；数值用稳定值（不含浮动，防数字跳动）
    if (this.label) {
      this.label.position.set(fx, fy + PORTAL.LABEL.Y_OFFSET, fz);
      const h = this.base.y + this.offsetY;   // 稳定高度 = 门中心（未含 ±FLOAT_AMP 浮动）
      const d = playerPos
        ? Math.hypot(playerPos.x - fx, playerPos.z - fz) // 玩家到门水平距离
        : this.baseDist + this.distOffset;               // 兜底
      this._labelTimer += dt;
      if (this._labelTimer >= 1 / PORTAL.LABEL.REFRESH_HZ) { // ~15fps 刷新节流
        this._labelTimer = 0;
        this._drawLabel(h, d);
      }
    }
  }

  // 左手摇杆逐帧增量：dy = 高度增量（米/帧，+ 升），dr = 径向增量（米/帧，+ 远离中心）
  // 内部 clamp，保证门中心高度 ∈ [HEIGHT_MIN, HEIGHT_MAX]、距中心 ∈ [DIST_MIN, DIST_MAX]
  applyStick(dy, dr) {
    this.offsetY = THREE.MathUtils.clamp(
      this.offsetY + dy,
      PORTAL.STICK.HEIGHT_MIN - this.base.y,
      PORTAL.STICK.HEIGHT_MAX - this.base.y
    );
    this.distOffset = THREE.MathUtils.clamp(
      this.distOffset + dr,
      PORTAL.STICK.DIST_MIN - this.baseDist,
      PORTAL.STICK.DIST_MAX - this.baseDist
    );
  }

  // 传送门稳定中心世界坐标（含摇杆偏移，不含 ±FLOAT_AMP 浮动）——供出怪光点起点使用
  // out 可传入复用 Vector3；root 未加载完成也有效（只用构造时就确定的 base/offsetY/dir）
  getWorldPos(out) {
    out = out || new THREE.Vector3();
    return out.set(
      this.base.x + this.dir.x * this.distOffset,
      this.base.y + this.offsetY,
      this.base.z + this.dir.z * this.distOffset
    );
  }

  // 幂等释放：移出场景、释放私有几何/材质、停止动画、释放标签纹理
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._ready = false;

    // 释放数值标签（SpriteMaterial + CanvasTexture，勿漏，否则切关残留纹理）
    if (this.label) {
      this.scene.remove(this.label);
      this.label.material.map?.dispose?.();
      this.label.material.dispose();
      this.label = null;
      this._labelCtx = null; this._labelTex = null;
    }

    // 停掉动画：AnimationMixer 只有 stopAllAction()，没有 stop()
    if (this.mixer) {
      try { this.mixer.stopAllAction(); } catch (e) { console.warn('[Portal] 停止动画失败:', e); }
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
