// ⚠ 合并说明（2026-09-23）：本文件来自 E 线（推流/平台线）的等待房间实现，**当前未被引用**。
//   新基线已用同一素材实现了更新的一版「开场影片过场」：src/game/introVideo.js + constants.INTRO_VIDEO
//   （单消费者 VideoTexture、预热移交、三重兜底、与穿云/关卡交接解耦），game.js 走的是那一版。
//   本文件保留作对照与回退参考；若要切回本实现，需恢复 game._enterWaitingRoom/_updateWaitingRoom 等钩子
//   并接上 CAST.VIDEO_MODE 的 castVideoSwap 镜像链路。// 等待房间：进入第 1 关前的开场影片。
//   不做封闭房间，而是「黑底空间 + 一块悬浮视频屏」：背景由 world.setAmbientVisible(false) 隐藏，
//   仅左侧(-X)一块 VideoTexture 屏幕可见（按原始宽高比适配居中，不变形）。
//   视频结束 / 加载失败 / 看门狗超时 → onDone() → game 进第 1 关（绝不软锁）。
//   等待期间玩家可自由走动（game._updateWaitingRoom 调 input.update，射击事件每帧自动清空丢弃）。
import * as THREE from 'three';
import { WAITING_ROOM, MOVE, CAST } from '../core/constants.js';

export class WaitingRoom {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this._disposed = false;   // dispose 后 ended/error 不再触发回调
    this._done = false;       // onDone 一次性守卫
    this._video = null;
    this._texture = null;
    this._videoMesh = null;
    this._watchdog = null;
    this._unmuteHandler = null;
    // —— 直播镜像（video 的唯一消费者）——
    this._mirror = null;        // 中转 2D canvas
    this._mirrorCtx = null;
    this._castTex = null;       // 主视角与离屏视角**共用**的 CanvasTexture
    this._hideMat = null;       // ?vmode=hide 时离屏用的纯黑材质
    this._savedMat = null;
    this._mirrorTimer = null;   // 无 requestVideoFrameCallback 时的定时兜底
    this._rvfcHandle = 0;       // requestVideoFrameCallback 句柄（取消用）
    this._mirrorFrames = 0;     // 诊断：成功取到的帧数
    this._mirrorErr = '';       // 诊断：最近一次 drawImage 异常
    this._buildVideoWall();
    scene.add(this.group);
    // 标记「影片阶段」：cast.js 读它来决定是否暂停推流（见 CAST.PAUSE_ON_INTRO）。
    // 为什么需要：影片播放时头显同时在做「视频硬件解码」与「H.264 硬件编码（推流）」，
    // 两者争用同一个媒体硬件块（VPU）→ 解码输出被抢 → 头显里影片一闪一闪。
    // 实测：游玩阶段（无解码）不闪；去掉 ?cast=1（无编码）也不闪 → 只有「解码 × 编码」同时存在才闪。
    if (scene.userData) scene.userData.castIntro = true;
  }

  /**
   * 取帧模式：'mirror' | 'raw'
   * URL 可用 ?vmode= 覆盖（'hide' | 'raw' | 'mirror'）。
   *
   * ⚠ 'hide' 与 'raw' 都返回 'raw'（主视角用 VideoTexture）：
   * 'hide' 只是让**直播画面**把视频屏换成纯黑，主视角取帧方式与 raw 相同。
   * 这样 <video> 只剩主视角一个消费者 —— 头显内影片正常，且 PC 端不会因跨上下文争用而闪。
   */
  _pickVideoMode() {
    const q = new URLSearchParams(location.search);
    const m = q.get('vmode') || CAST.VIDEO_MODE;
    return m === 'mirror' ? 'mirror' : 'raw';
  }

  // 视频屏：动态 <video>（不入 DOM 也可解码）+ VideoTexture 贴 PlaneGeometry。
  // 视频面离玩家钳制边界（x=-BOUND_X）内收 10cm，防相机近裁剪(0.05)贴脸穿模。
  _buildVideoWall() {
    // —— 视频元素（有声；自动播放被拦时 start() 内做 muted 兜底）——
    const v = document.createElement('video');
    v.playsInline = true;
    v.preload = 'auto';
    v.src = WAITING_ROOM.VIDEO_URL;
    this._video = v;

    this._mode = this._pickVideoMode();

    // —— 中转 canvas（仅 ?vmode=mirror 时启用）——
    //
    // 【历史与最终结论（2026-09-09，别再绕回去）】
    // 直播用的是**第二个 WebGL 上下文**（见 src/net/cast.js：离屏 renderer）。
    // 只要有两个消费者同时从同一个 <video> 取帧，就会争用同一份解码输出缓冲，画面一闪一闪：
    //   ① 两个 GL 上下文各传一次 VideoTexture  → 离屏侧交替拿到已释放缓冲 → **PC 端**闪；
    //   ② drawImage（离屏镜像）+ VideoTexture（主视角）互相抢当前帧 → **头显里也**闪，
    //      且离屏常被抢空 → PC 端直接黑屏。
    // 曾尝试「drawImage 作唯一消费者、主视角与离屏共用一张 CanvasTexture」根治，
    // 但 PICO 实测**取不到帧（头显里影片全黑、只有声音）** → 已改回默认 'hide'：
    // 主视角用 VideoTexture（头显内正常播放），**直播画面把视频屏换成纯黑**
    // → <video> 只剩一个消费者 → 两端都不闪。代价：影片那几秒 PC 大屏看不到画面。
    // 想再试 mirror 用 ?vmode=mirror（宽度 ?mw= 可调，默认 CAST.MIRROR_W=640）。
    this._mirrorW = +(new URLSearchParams(location.search).get('mw') || CAST.MIRROR_W);
    this._mirror = document.createElement('canvas');
    this._mirror.width = this._mirrorW;
    this._mirror.height = Math.max(2, Math.round(this._mirrorW * 9 / 16));
    this._mirrorCtx = this._mirror.getContext('2d');
    this._paintMirrorBackground();
    this._castTex = new THREE.CanvasTexture(this._mirror);
    this._castTex.colorSpace = THREE.SRGBColorSpace;   // 视频是 sRGB，否则画面发灰

    // —— 贴图与网格 ——
    if (this._mode === 'raw') {
      // 对照组：主视角直接用 VideoTexture（会闪，仅用于验证根因，勿默认启用）
      this._texture = new THREE.VideoTexture(v);
      this._texture.colorSpace = THREE.SRGBColorSpace;
    } else {
      this._texture = this._castTex;                   // 主视角也用镜像 canvas（推荐）
    }
    // 初建按 16:9 估尺寸；loadedmetadata 后按真实宽高比重新适配（防拉伸变形）
    this._applyVideoSize(16, 9);
    const mat = new THREE.MeshBasicMaterial({ map: this._texture });
    this._videoMesh = new THREE.Mesh(new THREE.PlaneGeometry(this._vw, this._vh), mat);
    // 朝向：PlaneGeometry 默认面朝 +Z，绕 Y 转 +90° 后面朝 +X（正对房间内的玩家）
    this._videoMesh.rotation.y = Math.PI / 2;
    // 位置：左墙(-X)内侧、垂直居中于 VIDEO_CENTER_Y、沿墙(Z 向)居中
    this._videoMesh.position.set(-(MOVE.BOUND_X - 0.10), WAITING_ROOM.VIDEO_CENTER_Y, 0);
    this.group.add(this._videoMesh);

    // 拿到真实宽高比后重设平面尺寸（保持中心位置不变）
    v.addEventListener('loadedmetadata', () => {
      if (this._disposed) return;
      const vw = v.videoWidth || 16;
      const vh = v.videoHeight || 9;
      this._applyVideoSize(vw, vh);
      this._videoMesh.geometry.dispose();
      this._videoMesh.geometry = new THREE.PlaneGeometry(this._vw, this._vh);
      // 同步中转 canvas 的宽高比，避免镜像画面被拉伸
      // 注意：改 canvas 尺寸会清空内容 → 重铺黑底并标记重传，否则会闪一下透明/黑
      if (this._mirror) {
        this._mirror.height = Math.max(2, Math.round(this._mirrorW / (vw / vh)));
        this._paintMirrorBackground();
        if (this._castTex) this._castTex.needsUpdate = true;
      }
    });

    // 钩子：由 cast.js 在离屏渲染前后成对调用（见 CAST.VIDEO_MODE）
    // 'mirror' 时是 no-op（主材质本来就是共享的 CanvasTexture，无需切换）；
    // 'hide' 时把视频屏换成纯黑，直播大屏不显示影片（最省 GPU）。
    this.scene.userData.castVideoSwap = (mode) => this._castVideoSwap(mode);
  }

  // 镜像 canvas 底色（全黑）：视频首帧未到之前不至于显示透明/花屏
  _paintMirrorBackground() {
    if (!this._mirrorCtx) return;
    this._mirrorCtx.fillStyle = '#000';
    this._mirrorCtx.fillRect(0, 0, this._mirror.width, this._mirror.height);
  }

  /**
   * 自愈：mirror 取帧迟迟拿不到帧时，自动改用 VideoTexture。
   *
   * 背景：mirror 依赖 requestVideoFrameCallback（新帧呈现时回调）。若 PICO 浏览器上
   * 该回调不触发（或视频根本没解码出新帧），主视角会一直贴着一张纯黑的中转 canvas
   * → **头显里影片全黑**。黑屏比闪烁更糟，所以这里宁可退回会闪的原始方式。
   * 触发条件：视频已就绪（readyState≥2）但 2.5 秒内一帧都没取到。
   */
  _fallbackToRaw() {
    if (this._mode === 'raw' || this._disposed) return;
    const v = this._video;
    if (!v) return;
    this._stopMirror();
    this._mode = 'raw';
    console.warn('[waitingRoom] 镜像取帧 2.5s 未拿到帧 → 自动改用 VideoTexture（头显可看影片，PC 端可能闪）');
    if (!this._videoMesh) return;
    const tex = new THREE.VideoTexture(v);
    tex.colorSpace = THREE.SRGBColorSpace;
    this._videoMesh.material.map = tex;
    this._videoMesh.material.needsUpdate = true;
    this._texture?.dispose?.();          // 原为共享的 _castTex，切换后不再需要
    this._texture = tex;
  }

  /**
   * 启动镜像取帧：把视频帧画进 2D canvas（<video> 的唯一消费者）。
   * 优先用 requestVideoFrameCallback（Chrome 83+，PICO 浏览器可用）——它在视频**新帧呈现**
   * 时回调，是取帧的正确方式，且天然按视频实际帧率（25/30fps）节流，不做无用功；
   * 老内核无此 API 时回退到 33ms（约 30fps）定时取帧。
   */
  _startMirror() {
    if (this._mode === 'raw' || this._disposed) return;   // raw 对照模式不用镜像
    const v = this._video;
    if (!v) return;

    const draw = () => {
      if (this._disposed || !v) return;
      if (v.readyState < 2) return;                        // 尚无可用帧 → 保留上一帧，不闪黑
      try {
        this._mirrorCtx.drawImage(v, 0, 0, this._mirror.width, this._mirror.height);
        this._castTex.needsUpdate = true;                  // 关键：通知两个 GL 上下文重新上传
        this._mirrorFrames++;
      } catch (e) {
        this._mirrorErr = String((e && e.message) || e);
      }
    };

    if (typeof v.requestVideoFrameCallback === 'function') {
      const loop = () => {
        if (this._disposed) return;
        draw();
        this._rvfcHandle = v.requestVideoFrameCallback(loop);
      };
      this._rvfcHandle = v.requestVideoFrameCallback(loop);
    } else {
      this._mirrorTimer = setInterval(draw, 33);           // 兜底：约 30fps
    }
  }

  _stopMirror() {
    if (this._mirrorTimer) { clearInterval(this._mirrorTimer); this._mirrorTimer = null; }
    const v = this._video;
    if (this._rvfcHandle && v && typeof v.cancelVideoFrameCallback === 'function') {
      try { v.cancelVideoFrameCallback(this._rvfcHandle); } catch (e) { /* 忽略 */ }
    }
    this._rvfcHandle = 0;
  }

  /**
   * 离屏（直播）渲染时切换视频屏材质，渲染后必须传 false 还原。
   * @param {string|false} mode 'hide' 黑屏 | 'mirror'/'raw'/false 还原主视角材质
   */
  _castVideoSwap(mode) {
    const mesh = this._videoMesh;
    if (!mesh) return;
    if (mode === 'hide') {
      if (!this._savedMat) this._savedMat = mesh.material;
      if (!this._hideMat) this._hideMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
      mesh.material = this._hideMat;
      return;
    }
    // 还原：'mirror' 时主材质就是共享 CanvasTexture，无需切换；此处只兜底 hide 残留
    if (this._savedMat) { mesh.material = this._savedMat; this._savedMat = null; }
  }

  // 按 vw:vh 宽高比在 VIDEO_MAX_W × VIDEO_MAX_H 内适配（contain，不拉伸），结果写入 _vw/_vh
  _applyVideoSize(vw, vh) {
    const ar = (vw && vh) ? vw / vh : 16 / 9;
    let w = WAITING_ROOM.VIDEO_MAX_W;
    let h = w / ar;
    if (h > WAITING_ROOM.VIDEO_MAX_H) { h = WAITING_ROOM.VIDEO_MAX_H; w = h * ar; }
    this._vw = w;
    this._vh = h;
  }

  // 开始播放；onDone 在视频结束/失败/看门狗超时后触发一次（进入第 1 关）
  start(onDone) {
    this._onDone = onDone;
    const v = this._video;

    const finish = () => {
      if (this._done || this._disposed) return;
      this._done = true;
      this._clearWatchdog();
      this._removeUnmuteHandler();
      this._onDone?.();
    };

    v.addEventListener('ended', finish);
    v.addEventListener('error', finish); // 文件缺失/解码失败 → 直接进第 1 关，不卡死

    // 启动镜像取帧（<video> 的唯一消费者；主视角与直播画面共用同一张 CanvasTexture）
    this._startMirror();

    // 看门狗兜底：无论何种异常（含视频一直不出画面），超时也放行进第 1 关
    this._watchdog = setTimeout(finish, WAITING_ROOM.WATCHDOG_MS);

    // 通知 PC 端：开场影片开始 → 它同步播放**本地**同一段影片。
    // 影片期间头显不做编码（解码×编码争 VPU 会让头显闪），PC 大屏看不到头显画面，
    // 用本地影片顶上，两端结束时头显立刻恢复推流、PC 端切回游戏画面。
    try { window.__cast?.notifyIntro?.('play'); } catch (e) { /* 未启用直播则忽略 */ }

    v.play().catch(() => {
      // 有声播放被自动播放策略拦截（页面缺手势）→ 静音重试 + 首次交互取消静音
      v.muted = true;
      v.play().catch(() => finish()); // 连静音都失败 → 直接进第 1 关
      this._unmuteHandler = () => {
        v.muted = false;
        this._removeUnmuteHandler();
      };
      window.addEventListener('pointerdown', this._unmuteHandler);
      window.addEventListener('keydown', this._unmuteHandler);
    });
  }

  update(dt) {
    // mirror 模式：取帧由 requestVideoFrameCallback（或 33ms 兜底定时器）驱动，这里只做周期诊断。
    // raw 模式：VideoTexture 由渲染器在 render 时自动刷新，无需手动 needsUpdate。
    if (this._mode === 'raw') return;
    const v = this._video;

    // 自愈：视频已就绪却 2.5s 一帧都没取到 → 退回 VideoTexture（否则头显里影片全黑）
    if (this._mirrorFrames === 0 && v && v.readyState >= 2) {
      this._noFrameT = (this._noFrameT || 0) + dt;
      if (this._noFrameT > 2.5) { this._fallbackToRaw(); return; }
    } else if (this._mirrorFrames > 0) {
      this._noFrameT = 0;
    }

    this._diagT = (this._diagT || 0) + dt;
    if (this._diagT < 2) return;          // 每 2 秒打一次，避免刷屏
    this._diagT = 0;
    console.log(`[waitingRoom] 镜像取帧 frames=${this._mirrorFrames} `
      + `readyState=${v ? v.readyState : '-'} canvas=${this._mirror.width}x${this._mirror.height}`
      + ` mode=${this._mode}${this._mirrorErr ? ` err=${this._mirrorErr}` : ''}`);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._clearWatchdog();
    this._removeUnmuteHandler();
    this.scene.remove(this.group);
    // 释放几何/材质/贴图
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material?.dispose();
      }
    });
    this._texture?.dispose();
    // 停止镜像取帧并释放直播相关资源，摘掉钩子（否则 cast.js 会调到已销毁的对象）
    // 影片结束 → 通知 PC 端停止本地影片（随后头显恢复推流，PC 端切回游戏画面）。
    // 必须在删除 castIntro 之前发：cast.js 一看到 castIntro 消失就会开始建离屏渲染器。
    try { window.__cast?.notifyIntro?.('end'); } catch (e) { /* 未启用直播则忽略 */ }
    this._stopMirror();
    if (this.scene?.userData) {
      delete this.scene.userData.castVideoSwap;
      delete this.scene.userData.castIntro;      // 影片结束 → cast.js 恢复推流
    }
    this._castTex?.dispose();
    this._hideMat?.dispose();
    this._castTex = null; this._hideMat = null; this._mirror = null; this._mirrorCtx = null;
    // 释放视频解码器：pause + 清 src + load() 触发回收
    if (this._video) {
      try {
        this._video.pause();
        this._video.removeAttribute('src');
        this._video.load();
      } catch (e) { /* 忽略释放异常 */ }
      this._video = null;
    }
    this._videoMesh = null;
  }

  _clearWatchdog() {
    if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
  }

  _removeUnmuteHandler() {
    if (this._unmuteHandler) {
      window.removeEventListener('pointerdown', this._unmuteHandler);
      window.removeEventListener('keydown', this._unmuteHandler);
      this._unmuteHandler = null;
    }
  }
}
