import * as THREE from 'three';
import { INTRO_VIDEO } from '../core/constants.js';

// ============================================================
// 进入游戏前的「开场视频」过场（VR 内播放 MP4）
//   用法：game._startIntroVideo() → new IntroVideo(scene, { log, onDone }) → start()
//   设计要点（来自《头显里播放视频》实测手册，勿随意改动）：
//   ① immersive 模式下 DOM 不可见 → 必须把视频贴到 3D 平面上（VideoTexture）；
//   ② **单消费者原则**：同一个 <video> 被两个消费者取帧会争用解码缓冲 → 闪/黑。
//      故本类全程只用 VideoTexture（不用 drawImage 中转），且预热元素「移交所有权」后不再复用；
//   ③ 三重兜底：ended / error / 看门狗（时长+余量）任一都要能推进流程，绝不软锁；
//   ④ 自动播放策略：带音轨的 play() 可能被拦 → 静音重试 + 首次手势恢复声音；
//   ⑤ 释放：pause() + removeAttribute('src') + load() 才真正回收解码器。
// ============================================================

// 模块级预热元素：在「点进入 VR」时先建好并 preload，进 VR 时文件多半已在 HTTP 缓存里。
// 本素材 19MB 且 moov 在文件尾部（未 faststart）→ 元数据必须等整包下载完，预热能明显缩短首帧等待。
let _prewarmed = null;

function _makeVideoEl() {
  const v = document.createElement('video');
  v.playsInline = true;   // 头显浏览器必需：否则可能被当成"需要全屏"处理
  v.preload = 'auto';     // 预加载，缩短首帧时间
  return v;
}

export function prewarmIntroVideo() {
  if (_prewarmed || !INTRO_VIDEO.ENABLED) return _prewarmed;
  const v = _makeVideoEl();
  v.src = INTRO_VIDEO.SRC;   // 相对路径：跟随页面 origin，避免 CORS / 混合内容
  v.load();
  _prewarmed = v;
  return v;
}

export class IntroVideo {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this._o = { ...INTRO_VIDEO, ...opts };   // 允许调用方覆盖（便于测试/调试）
    this._log = opts.log || null;
    this._onDone = opts.onDone || null;

    this._disposed = false;
    this._done = false;
    this._elapsed = 0;                                              // 已播放时长(s)，用于帧驱动看门狗
    this._watchdogLimit = this._o.FALLBACK_DURATION_S + this._o.WATCHDOG_PAD_S;
    this._unmute = null;
    this._firstFrameLogged = false;

    // ---- <video>：优先接管预热元素（保证同一时刻只有一个消费者）----
    const v = _prewarmed || _makeVideoEl();
    _prewarmed = null;                       // 所有权移交：预热元素不再被他人引用
    if (!v.src) v.src = this._o.SRC;
    v.loop = false;
    v.muted = false;
    try { v.volume = Math.max(0, Math.min(1, this._o.VOLUME)); } catch (e) { /* 忽略：个别内核设 volume 早于加载会抛 */ }
    this._video = v;
    this._audio = opts.audio;
    this._audio?.registerMedia(v, this._o.VOLUME);

    // ---- 事件处理器（绑定一次，dispose 时解绑）----
    this._onEnded = () => this._finish('播完');
    this._onError = () => { const e = v.error; this._finish(`媒体错误 code=${e ? e.code : '?'}`); };
    this._onPlaying = () => {
      if (this._firstFrameLogged) return;
      this._firstFrameLogged = true;
      this._say(`首帧已出 readyState=${v.readyState} size=${v.videoWidth}x${v.videoHeight}`);
    };
    this._onMeta = () => {
      if (this._disposed) return;
      const dur = (isFinite(v.duration) && v.duration > 0) ? v.duration : this._o.FALLBACK_DURATION_S;
      this._watchdogLimit = dur + this._o.WATCHDOG_PAD_S;
      this._applySize(v.videoWidth, v.videoHeight);   // 按真实宽高比重算（防拉伸）
      this._rebuildGeometry();
      this._say(`元数据就绪 ${v.videoWidth}x${v.videoHeight} 时长 ${dur.toFixed(2)}s`);
    };

    // ---- 3D：贴图 + 平面 ----
    this._texture = new THREE.VideoTexture(v);
    this._texture.colorSpace = THREE.SRGBColorSpace;   // 漏了这行画面会发灰
    this._material = new THREE.MeshBasicMaterial({ map: this._texture });  // 自发光贴图，不吃光照
    this._applySize(16, 9);                            // 初建按 16:9 估算，元数据到后重算
    this._geometry = new THREE.PlaneGeometry(this._w, this._h);
    this._mesh = new THREE.Mesh(this._geometry, this._material);
    this._mesh.rotation.y = THREE.MathUtils.degToRad(this._o.ROT_Y_DEG);  // 默认 +90° → 法线 +Z 转向 +X（正对场地中心）
    this._place();
    this.group = new THREE.Group();
    this.group.add(this._mesh);
    scene.add(this.group);
  }

  // 在最大宽高内等比 contain（不裁剪、不拉伸）
  _applySize(vw, vh) {
    const o = this._o;
    const ar = (vw > 0 && vh > 0) ? vw / vh : 16 / 9;
    let w = o.WIDTH_M, h = w / ar;
    if (h > o.HEIGHT_M) { h = o.HEIGHT_M; w = h * ar; }
    this._w = w;
    this._h = h;
  }

  // 屏幕位置：X/Z 取配置值，Y = 底边离地高度 + 半高（"离地 1 米"约束的是**底边**）
  _place() {
    const o = this._o;
    this._mesh.position.set(o.X_M, o.BOTTOM_Y_M + this._h / 2, o.Z_M);
  }

  _rebuildGeometry() {
    const old = this._geometry;
    this._geometry = new THREE.PlaneGeometry(this._w, this._h);
    this._mesh.geometry = this._geometry;
    old?.dispose();          // 旧几何必须释放
    this._place();           // 高度变了 → 底边约束要重算
  }

  _say(msg) { if (this._log) this._log(`[开场视频] ${msg}`); }

  // 开始播放。onDone 在「播完 / 出错 / 看门狗」任一路径触发，且只触发一次。
  start(onDone) {
    if (this._disposed) return;
    if (onDone) this._onDone = onDone;
    const v = this._video;
    v.addEventListener('ended', this._onEnded);
    v.addEventListener('error', this._onError);
    v.addEventListener('playing', this._onPlaying);
    v.addEventListener('loadedmetadata', this._onMeta);
    if (v.readyState >= 1) this._onMeta();   // 预热已拿到元数据：补一次（事件不会再补发）
    this._say('开始播放');
    const p = v.play();
    if (p && typeof p.catch === 'function') {
      p.catch((error) => {
        if (this._disposed || this._audio?.paused || error?.name === 'AbortError') return;
        // 带音轨的视频在没有用户手势时会被拦 → 静音重试（静音视频允许自动播放）
        v.muted = true;
        const p2 = v.play();
        if (p2 && typeof p2.catch === 'function') p2.catch((error) => {
          if (!this._disposed && !this._audio?.paused && error?.name !== 'AbortError') this._finish('播放被拦且静音重试失败');
        });
        // 一次性手势监听：玩家一交互就恢复声音；摘监听在 _removeUnmute
        this._unmute = () => { v.muted = false; this._removeUnmute(); };
        window.addEventListener('pointerdown', this._unmute);
        window.addEventListener('keydown', this._unmute);
      });
    }
  }

  // 每帧驱动：帧计数式看门狗（比 setTimeout 更稳，且不依赖计时器在 XR 会话里被节流）
  update(dt) {
    if (this._disposed || this._done) return;
    this._elapsed += dt;
    if (this._elapsed >= this._watchdogLimit) {
      const v = this._video;
      const info = v ? `readyState=${v.readyState} size=${v.videoWidth}x${v.videoHeight}` : '无视频元素';
      this._finish(`看门狗超时 ${this._elapsed.toFixed(1)}s（${info}）`);
    }
  }

  _removeUnmute() {
    if (!this._unmute) return;
    window.removeEventListener('pointerdown', this._unmute);
    window.removeEventListener('keydown', this._unmute);
    this._unmute = null;
  }

  _finish(reason) {
    if (this._done || this._disposed) return;   // 双守卫：ended 与看门狗可能几乎同时到
    this._done = true;
    this._removeUnmute();
    const cb = this._onDone;
    this._onDone = null;
    this._say(`结束（${reason}）`);
    if (cb) cb(reason);
  }

  // 结束瞬间的「廉价」收尾：暂停并**保留最后一帧**（供切关前的短暂静止画面用）。
  //   ⚠ 这里刻意不做解码器回收/显存释放 —— 那是重活，必须等画面不再播放（见 detach/dispose 与 game 的延迟回收）。
  holdLastFrame() {
    if (this._disposed) return;
    this._removeUnmute();
    try { this._video?.pause(); } catch (e) { /* 忽略 */ }
  }

  // 把画面从场景摘除（廉价）：video 元素与纹理/解码器继续存活，稍后再 dispose。
  //   用途：切关那一帧只做「摘除」，把解码器回收推迟到穿云期间，避免两件重活挤同一帧。
  detach() {
    if (this._disposed) return;
    if (this.scene && this.group) this.scene.remove(this.group);
    this.group = null;
    this._mesh = null;   // 注意：不释放 geometry/material/texture，留给 dispose()
  }

  // 幂等释放：解绑监听 → 从场景摘除 → 释放 three 资源 → 回收视频解码器
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._audio?.unregisterMedia(this._video);
    const v = this._video;
    if (v) {
      v.removeEventListener('ended', this._onEnded);
      v.removeEventListener('error', this._onError);
      v.removeEventListener('playing', this._onPlaying);
      v.removeEventListener('loadedmetadata', this._onMeta);
    }
    this._removeUnmute();
    if (this.scene && this.group) this.scene.remove(this.group);   // detach() 已摘除时为空操作
    this.group = null;
    this._mesh = null;
    this._geometry?.dispose();
    this._material?.dispose();
    this._texture?.dispose();
    if (v) {
      try {
        v.pause();
        v.removeAttribute('src');   // 断开数据源
        v.load();                   // 触发解码器与缓冲回收（关键一步）
      } catch (e) { /* 忽略：回收失败不影响流程 */ }
    }
    this._video = null;
  }
}
