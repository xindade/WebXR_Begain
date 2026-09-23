// src/net/cast.js —— 直播推流门面（?cast=1 才启用）
//
// 未带 ?cast=1 时返回空实现：不创建第二个 WebGL 上下文、不连信令、不渲染，
// 正常游玩与 VR 帧率完全不受影响。
//
// 采集方式（flat 与 VR 同一条路径）：观众相机 + 独立离屏 canvas。
//   1) 不能直接抓主 canvas —— WebXR 沉浸式下 three.js 把画面渲进 XR framebuffer
//      （vendor/three.module.js:29740），canvas 默认帧缓冲没有内容，抓出来是黑的；
//   2) captureStream() 依赖 WebGL 的 preserveDrawingBuffer:true，而主 renderer
//      （world.js:33）未开启，改开会拖累 VR 每帧带宽 → 离屏 renderer 自己开。
//   3) 离屏 renderer 的 xr.enabled 保持默认 false → 完全不触碰 XR 渲染状态，
//      即使直播崩了，头显里的游戏照常运行。

import * as THREE from 'three';
import { CAST, WAITING_ROOM } from '../core/constants.js';
import { Signaling, defaultSignalBase } from './signaling.js';
import { WebRtcPush } from './push-webrtc.js';
import { JpegPush } from './push-jpeg.js';

const log = (msg) => {
  const s = `[cast] ${msg}`;
  window.__pageLog?.info(s);
  console.log(s);            // 头显侧 __pageLog 通常不存在 → 落到 console，便于 ADB/远程调试查看
};

// 空实现：无 ?cast=1 时使用，所有调用都是 no-op
const NOOP_CAST = {
  enabled: false,
  update() {},
  stats: () => 'cast: off（未加 ?cast=1）',
  dispose() {},
};

/**
 * 创建推流对象。
 * @param {object} opt
 * @param {World}  opt.world  World 实例（取 scene / camera / _skydome / sky）
 * @returns 启用的 Cast 实例，或 NOOP_CAST
 */
export function createCast({ world, game, audio }) {
  if (!world) return NOOP_CAST;
  const q = new URLSearchParams(location.search);
  if (q.get('cast') !== '1') return NOOP_CAST;
  try {
    return new Cast({ world, game, audio, q });
  } catch (e) {
    console.error('[cast] 初始化失败，已停用推流:', e);
    return NOOP_CAST;
  }
}

class Cast {
  constructor({ world, game, audio, q }) {
    this.world = world;
    this.game = game || null;      // 用于判断「是否真的开始游玩」（见 _shouldPause）
    this.audio = audio || null;    // AudioManager：音频推流从这里取「总线轨道」
    this.audioTrack = null;        // 媒体流里的音频轨：与视频同生共死，靠 enabled 开关，不重协商
    this.enabled = true;

    // —— 可调参数（URL 覆盖 CAST 默认）——
    this.W = +(q.get('w') || CAST.W);
    this.H = +(q.get('h') || CAST.H);
    this.fps = +(q.get('fps') || CAST.FPS);
    this.mode = q.get('mode') || CAST.TRANSPORT;      // 'webrtc' | 'jpeg'
    this.quality = +(q.get('q') || CAST.JPEG_QUALITY); // ?q= 实时调 JPEG 质量（0~1）
    this.bitrate = +(q.get('bitrate') || CAST.MAX_BITRATE); // ?bitrate= 实时调码率 bps（嫌糊就加大）
    this.degrade = q.get('degrade') || CAST.DEGRADE;   // ?degrade=maintain-framerate 可切回「保帧率」
    this.videoMode = q.get('vmode') || CAST.VIDEO_MODE; // ?vmode=mirror|hide|raw 开场影片在直播画面里的画法
    this.preserveDb = q.get('pdb') === '1';             // ?pdb=1 强制开启 preserveDrawingBuffer（对照用）
    this.thumb = q.get('thumb') === '1';                // ?thumb=1 显示右下角缩略图（默认关闭：省一次页面合成）
    this.showAmbient = q.get('amb') !== '0';            // ?amb=0 直播画面不画天空球（纯色背景，最省）
    this.noScale = q.get('noscale') === '1';            // ?noscale=1 关闭「离屏过慢自动降分辨率」
    this.pauseBeforePlay = q.get('earlycast') !== '1';   // ?earlycast=1 关闭「游玩前不推流」（对照组：预览/影片阶段就开推）
    this.warmup = q.get('warmup') !== '0';               // ?warmup=0 关闭「2D 占位画面预热链路」（退回 PC 端纯黑等待）
    this._paused = null;      // 当前是否处于「游玩前暂停」状态（null=尚未判定过，用于打一次性日志）
    this._pendingStart = false; // 暂停期间 PC 已就位 → 记下来，恢复后立即补启动
    this._warm = null;        // 占位预热链路资源 { canvas, ctx, track, timer }（仅预览/影片阶段存在）
    this.interval = 1000 / this.fps;
    this.last = 0;
    this.frames = 0;
    this._renderMs = 0;      // 离屏渲染耗时累计（每 60 帧结算一次，诊断分辨率是否过重）

    // —— 观众相机：不挂进场景图，每帧从主相机世界矩阵取位姿 ——
    // 必须另建：XR 下 updateUserCamera 会覆写 world.camera 的 fov/projectionMatrix
    // （vendor/three.module.js:27468-27474），那是 XR 非对称投影，不能直接拿来渲染 2D 画面。
    this.cam = new THREE.PerspectiveCamera(CAST.FOV, this.W / this.H, 0.05, 200);

    // 离屏 canvas / renderer **延迟到真正开始游玩时才创建**（见 _ensureOffscreen）。
    // 原因：预览界面与开场影片阶段头显会闪，即使推流已暂停（不渲染、不编码）也照闪，
    // 说明「第二个 GL 上下文存在」本身就是干扰源之一。延迟创建 → 这两个阶段根本没有第二个上下文。

    // —— 信令 ——
    this.push = null;
    this.track = null;
    this.signal = new Signaling({
      base: defaultSignalBase(location.search),
      role: 'publisher',
      onReady: () => {
        this._startPush();
        // PC 端晚开时补发一次「影片阶段」：否则它会错过 waitingRoom.start() 那条通知，
        // 导致影片阶段只显示占位画面（而不是同步播放本地影片）。
        if (this.world.scene?.userData?.castIntro) {
          setTimeout(() => this.notifyIntro('play'), 200);
        }
      },
      onRemote: (sdp) => this.push?.onRemote?.(sdp),
      onIce: (c) => this.push?.onIce?.(c),
      onPeerLeft: () => this._stopPush(),
      onLog: log,
    });

    // 供 waitingRoom 通知「影片开始/结束」（PC 端据此同步播放本地影片），见 notifyIntro。
    window.__cast = this;

    log(`已启用 mode=${this.mode} ${this.W}x${this.H}@${this.fps} → ${this.signal.base}`);

    // 兜底：万一 SSE 下行被代理/网络吞掉 peer-ready，用 /api/info 轮询补触发推流。
    // /api/info 是普通短 GET（非长连接），在 APK 同源代理下最稳，不会因为缓冲而丢事件。
    this._infoTimer = setInterval(() => {
      if (this.push) return;                       // 已在推流 → 不再轮询
      fetch(`${this.signal.base}/info`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((info) => { if (info && info.viewer) this._startPush(); })
        .catch(() => {});
    }, 1500);
  }

  _buildCanvas() {
    const c = document.createElement('canvas');
    c.width = this.W;
    c.height = this.H;
    c.id = 'cast-canvas';
    // 注意：不能用 display:none —— 不参与合成的 canvas 不会产生新帧，
    // captureStream 会一直停在首帧。这里用 1px + opacity:0 藏在角落。
    c.style.cssText = this.thumb
      ? 'position:fixed;right:8px;bottom:8px;width:240px;height:135px;z-index:9998;'
        + 'border:1px solid #555;background:#000;pointer-events:none;'
      : 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(c);
    this.canvas = c;
  }

  _buildRenderer() {
    // preserveDrawingBuffer 只在「渲染后异步读回像素」时才需要（JPEG 模式的 toBlob）。
    // WebRTC 的 captureStream 由合成器抓帧，不需要它。
    // ⚠ 而它在移动端（PICO 是 Adreno tile-based GPU）代价极高：强制每帧把 tile buffer
    //   写回内存并保留，直接废掉 tile-based 优化 → 带宽暴涨 → 挤占主渲染 → 头显闪烁。
    //   故 webrtc 模式默认关（?pdb=1 可强制打开做对照），jpeg 模式必须开否则全黑。
    const needPdb = this.mode === 'jpeg' || this.preserveDb;
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: needPdb,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.W, this.H, false);          // false = 不改 canvas 的 CSS 尺寸
    this.renderer.toneMapping = THREE.NoToneMapping;        // 与主 renderer 对齐
    this.renderer.shadowMap.enabled = false;
    this.renderer.setClearColor(0x0a0a18, 1);               // 不画全景时兜底背景色

    // 第二个 GL 上下文崩溃不应该影响头显里的游戏
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      log('离屏上下文丢失，已停止推流（游戏不受影响）');
      this._stopPush();
    });
  }

  /**
   * 延迟创建离屏 canvas + 第二个 WebGL 上下文（首次真正需要渲染时才调用）。
   * 目的：预览界面 / 开场影片阶段根本不存在第二个 GL 上下文，排除它对头显画面的干扰。
   */
  _ensureOffscreen() {
    if (this.canvas) return;
    this._buildCanvas();
    this._buildRenderer();
    log(`离屏渲染器已创建 ${this.W}x${this.H}（延迟到开始游玩，避免预览/影片阶段干扰头显）`);
  }

  /**
   * 占位预热链路：预览 / 影片阶段先建立 WebRTC 链路，但用**普通 2D canvas** 出画。
   *
   * 为什么要单独做一条：上一轮为了不让头显闪，游玩前**完全不建链路**，结果 PC 端一直黑屏、
   * 连"连没连上"都看不出来（2026-09-09 用户反馈）。而建真实链路又会引入第二个 GL 上下文 → 头显闪。
   *
   * 2D canvas 正好两头都满足：
   *   · 不创建 WebGL 上下文 → 头显侧干扰源为零（该上下文的存在本身就是闪烁根因之一）；
   *   · ICE / 编码器提前就绪 → PC 端开机即出画，且进关卡时只需 replaceTrack 换轨道，不用重连。
   * 代价是 1fps 的极低编码负载（影片期间视频解码与编码争用媒体引擎，故帧率刻意压到 1）。
   */
  _startWarmup() {
    if (this.push || this._warm || this.mode !== 'webrtc') return;  // JPEG 兜底模式不做（软编码太贵）
    const probe = document.createElement('canvas');
    if (!probe.captureStream) return;

    const c = probe;
    c.width = this.W;
    c.height = this.H;
    c.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(c);
    const ctx = c.getContext('2d');
    if (!ctx) { c.remove(); return; }

    this._warm = { canvas: c, ctx, track: null, timer: 0, dots: 0 };
    this._drawPlaceholder();

    const fps = Math.max(1, CAST.WARMUP_FPS || 1);
    const stream = this._attachAudio(c.captureStream(fps));   // 音频轨必须赶在 createOffer 之前挂上
    const track = stream.getVideoTracks()[0] || null;
    if (!track) { this._clearWarmup(); return; }
    this._warm.track = track;
    // 内容变化时 captureStream 才会持续出帧 → 定时重绘（顺带做省略号动画，PC 端能看出"活着"）
    this._warm.timer = setInterval(() => this._drawPlaceholder(), 1000 / fps);

    this.push = new WebRtcPush(stream, {
      signal: this.signal,
      fps: this.fps,
      maxBitrate: this.bitrate,
      degrade: this.degrade,
      onLog: log,
      onState: (s) => { if (s === 'connected') clearTimeout(this._rtcFailTimer); },
    });
    this._rtcFailTimer = setTimeout(() => this._fallbackToJpeg(), 6000);
    this.push.start();
    log(`预热链路已启动（2D 占位画面 ${fps}fps，未创建 GL 上下文 → 头显不闪）`);
  }

  /** 绘制占位画面：黑底 + 提示文字。文字直接进流，PC 端无需额外改界面即可看到状态。 */
  _drawPlaceholder() {
    const w = this._warm;
    if (!w) return;
    const { ctx, canvas } = w;
    const W = canvas.width;
    const H = canvas.height;
    w.dots = (w.dots + 1) % 4;
    ctx.fillStyle = '#0a0a18';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const big = Math.round(H * 0.09);
    ctx.fillStyle = '#8ab4ff';
    ctx.font = `${big}px sans-serif`;
    ctx.fillText('PICO 直播 · 已连接', W / 2, H / 2 - big * 0.9);
    ctx.fillStyle = '#dddddd';
    ctx.font = `${Math.round(big * 0.62)}px sans-serif`;
    // 影片阶段 PC 端播的是本地影片（本画面被遮住），但头显若没发通知就会落到这一层，
    // 所以文案要能反映真实阶段，避免大屏显示"等待开始游戏"而其实正在放片。
    const intro = this.world.scene?.userData?.castIntro;
    ctx.fillText(intro ? '开场影片播放中…' : `等待头显开始游戏${'.'.repeat(w.dots)}`,
      W / 2, H / 2 + big * 0.35);
    ctx.fillStyle = '#666666';
    ctx.font = `${Math.round(big * 0.45)}px sans-serif`;
    ctx.fillText('进入第 1 关后自动切换到游戏画面', W / 2, H / 2 + big * 1.4);
  }

  /** 销毁占位链路的 canvas 与定时器（保留 push：轨道可能已被 replaceTrack 接管） */
  _clearWarmup() {
    const w = this._warm;
    if (!w) return;
    this._warm = null;
    clearInterval(w.timer);
    try { w.track?.stop(); } catch (e) { /* 忽略 */ }
    try { w.canvas.remove(); } catch (e) { /* 忽略 */ }
  }

  /**
   * 开始游玩 → 把占位画面换成真实的游戏画面。
   * 优先 replaceTrack（不重新协商、PC 端几乎无感）；不支持或失败时退回重建链路。
   */
  async _swapToOffscreen() {
    const warm = this._warm;
    if (this.mode !== 'webrtc' || !warm) {   // JPEG 兜底 / 无占位 → 直接换源或重建
      this._ensureOffscreen();
      if (this.push) this.push.canvas = this.canvas;   // JpegPush 只是持有 canvas 引用，原地换源即可
      else this._startPush();
      this._clearWarmup();
      return;
    }
    this._ensureOffscreen();
    let stream = this.canvas.captureStream(0);
    let track = stream.getVideoTracks()[0] || null;
    if (!track || !track.requestFrame) {      // 老内核无 requestFrame → 改用自动采样流
      stream = this.canvas.captureStream(this.fps);
      track = stream.getVideoTracks()[0] || null;
    }
    if (!track) { this._stopPush(); this._clearWarmup(); this._startPush(); return; }

    const ok = await this.push?.replaceTrack?.(track);
    if (ok) {
      this.track = track;
      this._clearWarmup();                   // 只销毁占位 canvas/track，PeerConnection 保留
      log('已切换到游戏画面（replaceTrack，链路未中断）');
      return;
    }
    // 换轨失败 → 让 PC 端先复位再重建（旧 pc 已 connected，直接发新 offer 会被拒）
    log('占位画面切换失败 → 重建链路');
    try { this.signal.send({ type: 'peer-left' }); } catch (e) { /* 忽略 */ }
    this._stopPush();
    this._clearWarmup();
    this._pendingStart = true;
    setTimeout(() => this._startPush(), 600);
  }

  /**
   * 是否处于「还没真正开始游玩」阶段：预览菜单（menu）或等待房间/开场影片（waiting）。
   * 这些阶段不需要直播画面，且实测会干扰头显 → 一律不渲染、不编码、不建立第二条链路。
   * 判定依据 game.state（见 game.js：'menu' / 'waiting' / 'playing' / 'card' / 'over'），
   * 并兼容 waitingRoom 的 scene.userData.castIntro 标记（waitingRoom 构造即置位、dispose 清除）。
   */
  _shouldPause() {
    if (!this.pauseBeforePlay) return false;
    if (this.world.scene?.userData?.castIntro) return true;
    const st = this.game?.state;
    if (!st) return false;                     // 拿不到状态 → 不暂停（宁可推流，别把直播搞没了）
    return CAST.PAUSE_STATES.indexOf(st) >= 0;
  }

  /**
   * 把音频总线轨道挂到「用于推流的 MediaStream」上（幂等）。
   * 时机关键：**必须在 new WebRtcPush/createOffer 之前**挂上去 —— 这样 offer 里天然带一条音频 m-line，
   * 之后换视频轨（replaceTrack）不影响音频；静音/取消静音只切 track.enabled，全程不重协商。
   * 开场影片期间与视频一起静音（见 update()）：那时 PC 端本地播同一段影片自带音轨，叠加会双声。
   */
  _attachAudio(stream) {
    if (!stream || !this.audio?.ensureCastAudioTrack) return stream;
    try {
      if (!this.audioTrack) {
        this.audioTrack = this.audio.ensureCastAudioTrack();
        if (this.audioTrack) log('已接入音频推流（BGM / 音效 / 语音走同一条 WebRTC 连接）');
      }
      if (!this.audioTrack) return stream;
      if (!stream.getAudioTracks().includes(this.audioTrack)) stream.addTrack(this.audioTrack);
      this.audioTrack.enabled = !this._shouldPause();   // 影片/预览阶段先静音
    } catch (e) {
      log(`音频轨接入失败（本次只推视频）：${e.message}`);
    }
    return stream;
  }

  _startPush() {
    if (this._shouldPause()) {                 // 还没开始游玩 → 记下来，等进了关卡再换成真实画面
      if (!this._pendingStart) {
        this._pendingStart = true;
        log('预览/影片阶段：暂不渲染游戏画面（PC 端显示等待，待开始游玩自动切换）');
      }
      // 不建 GL 上下文，但仍建立链路：用 2D 占位画面让 PC 端立刻出画（见 _startWarmup）
      if (this.warmup) this._startWarmup();
      return;
    }
    this._pendingStart = false;
    clearInterval(this._infoTimer);                // 一旦开始推流就停掉 info 轮询
    this._ensureOffscreen();
    if (this.push) return;
    if (this.mode === 'jpeg') {
      this.push = new JpegPush(this.canvas, {
        signal: this.signal, quality: this.quality, onLog: log,
      });
      log('JPEG 兜底链路已启动');
      return;
    }
    if (!this.canvas.captureStream) {
      log('captureStream 不可用，自动降级为 JPEG');
      this.mode = 'jpeg';
      this.push = new JpegPush(this.canvas, {
        signal: this.signal, quality: this.quality, onLog: log,
      });
      return;
    }
    // fps=0 → 手动驱动，配合 track.requestFrame() 精确按我们的节流节奏出帧
    let stream = this.canvas.captureStream(0);
    this.track = stream.getVideoTracks()[0] || null;
    if (!this.track || !this.track.requestFrame) {
      // 老内核没有 requestFrame：改用按帧率自动采样的流（注意要把新流交给推流器，
      // 否则 fps=0 的手动流永远收不到帧）
      log('requestFrame 不可用，改用 captureStream(fps) 自动采样');
      stream = this.canvas.captureStream(this.fps);
      this.track = null;   // 置空 → update() 里的 requestFrame 分支不再走，改由自动采样出帧
    }
    this.push = new WebRtcPush(stream, {
      signal: this.signal,
      fps: this.fps,
      maxBitrate: this.bitrate,
      degrade: this.degrade,
      onLog: log,
      // WebRTC 真正连通 → 取消自动降级计时器
      onState: (s) => { if (s === 'connected') clearTimeout(this._rtcFailTimer); },
    });
    // 6 秒内连不上 → 自动改用 JPEG 兜底链路（局域网/代理下 WebRTC 常因 mDNS 卡在 connecting）
    this._rtcFailTimer = setTimeout(() => this._fallbackToJpeg(), 6000);
    this.push.start();
  }

  /**
   * WebRTC 连不上时的兜底：销毁 WebRTC，改走 JPEG 链路（PC 端会持续轮询 /api/frame）。
   * 仅在仍为 webrtc 模式时生效；jpeg 模式或已销毁则直接返回。
   */
  _fallbackToJpeg() {
    if (this.disposed || this.mode === 'jpeg') return;
    // 双保险：PC 端可能已经 connected，而头显侧 connectionState 更新滞后。
    // 此时降级会关掉一条本来正常的链路，且 PC 端因 usingVideo 已置位而不再收 JPEG → 永久黑屏。
    const st = this.push?.pc?.connectionState;
    if (st === 'connected') {
      log('WebRTC 已连通，取消本次 JPEG 降级');
      return;
    }
    log(`WebRTC 未能连通（${st || '未知'}），自动切换为 JPEG 兜底链路`);
    this._stopPush();
    this.track = null;
    this.mode = 'jpeg';
    // JPEG 走 canvas.toBlob → 必须 preserveDrawingBuffer，而该属性**只能在创建上下文时指定**。
    // webrtc 模式下它是关的（省 PICO 带宽），所以正常情况下要换一张新 canvas 重建离屏渲染器。
    // ⚠ 但**暂停阶段绝不能重建**：那会立刻引入第二个 GL 上下文 → 头显又开始闪。
    //   此时改推占位的 2D canvas（2D 画布 toBlob 不需要 preserveDrawingBuffer），
    //   PC 端照样出画，头显侧依然零 GL 上下文。
    if (!this.preserveDb) {
      if (this._shouldPause() && this._warm) {
        log('播放前 JPEG 兜底：沿用 2D 占位画面（不创建 GL 上下文）');
      } else {
        this._rebuildForPdb();
      }
    }
    const src = this.canvas || this._warm?.canvas;
    if (!src) return;
    this.push = new JpegPush(src, {
      signal: this.signal, quality: this.quality, onLog: log,
    });
    log('JPEG 兜底链路已启动（软编码，PICO 上约 0.2fps，仅作保底出画）');
  }

  /** 换一张新 canvas 重建离屏渲染器（只为把 preserveDrawingBuffer 打开，JPEG 兜底需要） */
  _rebuildForPdb() {
    this.preserveDb = true;
    try { this.canvas.remove(); } catch (e) { /* 忽略 */ }
    try { this.renderer.dispose(); } catch (e) { /* 忽略 */ }
    this._buildCanvas();
    this._buildRenderer();
    log('已重建离屏渲染器以启用 preserveDrawingBuffer（JPEG 兜底必需）');
  }

  _stopPush() {
    clearTimeout(this._rtcFailTimer);
    try { this.push?.dispose(); } catch (e) { /* 忽略 */ }
    this.push = null;
    this.track = null;
  }

  /**
   * 由 main.js 主循环在 world.render() **之后**调用。
   * 放在 render 之后的原因：此时 camera.matrixWorld 才是本帧最终位姿
   * （XR 下由 updateUserCamera 写入，flat 下由 scene.updateMatrixWorld 写入）；
   * 且 XR 帧已提交，观众渲染再慢也只挤占下一帧预算，不会拖慢本帧。
   */
  update() {
    if (this.disposed) return;

    // —— 还没真正开始游玩（预览菜单 / 等待房间·开场影片）：一律不推流 ——
    // 【为什么要做到这么彻底】实测（2026-09-09 22:15）：
    //   预览界面头显 1 秒闪 2 次；影片期间约 5 秒黑屏一次；进入第 1 关后完全正常。
    //   而此时推流**已经暂停**（PC 端画面静止可证）→ 说明干扰不只是「编码/渲染」，
    //   「第二个 GL 上下文存在」本身也在干扰头显。故这两个阶段干脆不创建它
    //   （_ensureOffscreen 延迟到恢复时才调用），也不建立 captureStream/编码链路。
    // 若已建立过（比如中途退回菜单），用 track.enabled=false 关掉出帧：
    //   Chrome 会自动发黑帧维持 RTP，连接不断，且几乎不占编码器。
    if (this._shouldPause()) {
      if (this._paused !== true) {
        this._paused = true;
        log('预览/影片阶段 → 暂停推流（不渲染、不编码）');
      }
      if (this.track && this.track.enabled) this.track.enabled = false;
      // 影片阶段同样不推音频：PC 端本地影片自带声音，叠加会双声/回声
      if (this.audioTrack && this.audioTrack.enabled) this.audioTrack.enabled = false;
      return;
    }
    if (this._paused !== false) {
      this._paused = false;
      log('已开始游玩 → 启动推流');
      // 占位链路已建 → 只换轨道（不重连）；否则等 onReady/info 轮询触发
      if (this._warm) this._swapToOffscreen();
      else if (this._pendingStart) this._startPush();
      if (this.track && !this.track.enabled) this.track.enabled = true;
      if (this.audioTrack) this.audioTrack.enabled = true;   // 开玩 → 音频轨恢复出声
    }

    if (!this.push) return;                                  // 没有接收端 → 完全不渲染，零开销
    if (this._warm) return;                                  // 还在推占位画面 → 不渲染游戏场景（省 GPU）
    const now = performance.now();

    // 帧节流：XR 90Hz 下约每 4 帧取 1 帧
    if (now - this.last < this.interval) return;
    if (this.push.busy) { this.last = now; return; }         // 编码器忙（上一帧 toBlob 未完）→ 跳过离屏渲染，省 GPU 预算
    this.last = now;

    // 主相机是 game.rig 的子节点 → camera.position 是局部坐标，必须读 matrixWorld
    const mw = this.world.camera.matrixWorld;
    this.cam.position.setFromMatrixPosition(mw);
    this.cam.quaternion.setFromRotationMatrix(mw);           // 主相机无缩放，安全
    this.cam.updateMatrixWorld(true);

    // 观众渲染：临时隐藏全景穹顶。
    // 6K/8K 全景纹理若被第二个 GL 上下文上传一次就是上百 MB 显存；
    // three.js 只在纹理真正参与绘制时才上传 → 不画它，它就永远不会进第二个上下文。
    // 用 ?. 防御：world 内部结构若改名，最坏情况是恢复成「画天空」，不会报错。
    const dome = this.world._skydome;
    const grad = this.world.sky;
    const domeVisible = dome ? dome.visible : false;
    const gradVisible = grad ? grad.visible : false;
    // 等待房间期间 world.ambient 被整体隐藏（背景纯黑以突出开场影片），而 three.js 中
    // **父组不可见 → 子节点一律不渲染**，所以只把 grad.visible 设 true 是无效的，直播画面
    // 会只剩纯底色（表现为「电脑端黑屏」，尤其影片还没出帧时）。
    // 解法：把天空球**临时挂到 scene 根**（scene.add 会自动把节点从原父节点摘下），渲染后挂回。
    //
    // ⚠ 不要直接 `ambient.visible = true` 放开整个组：ambient 里除天空球外还有
    //   3 层星空 + 边界盒 + **几百个坐标数字标注 Sprite**（每个都是独立 CanvasTexture，
    //   见 world.js:285/305/317）。全部进第二个 GL 上下文会把 GPU 吃光 → 头显画面被挤占
    //   而闪烁（2026-09-09 实测：放开 ambient 后预览阶段就开始闪；去掉 ?cast=1 则不闪，可确证）。
    const gradParent = grad ? grad.parent : null;
    // 开场影片：由 waitingRoom 注册的离屏专用钩子（scene.userData.castVideoSwap）。
    // 必须成对调用且用 finally 还原，否则主视角会留着直播用的替代材质。
    const videoSwap = this.world.scene?.userData?.castVideoSwap;
    const swapOn = typeof videoSwap === 'function';
    const t0 = performance.now();
    try {
      if (CAST.HIDE_PANO && dome) dome.visible = false;
      if (CAST.HIDE_PANO && grad) grad.visible = true;       // 用渐变天空兜底，避免纯黑背景
      if (this.showAmbient && grad && gradParent && gradParent !== this.world.scene) {
        this.world.scene.add(grad);                          // 挂到 scene 根 → 脱离 ambient 的隐藏控制
      }
      if (swapOn) videoSwap(this.videoMode);                 // 'mirror' 是 no-op / 'hide' 隐藏视频屏
      this.renderer.render(this.world.scene, this.cam);
    } finally {
      if (swapOn) videoSwap(false);
      if (grad && gradParent) gradParent.add(grad);          // 挂回原父节点，绝不污染主渲染
      if (dome) dome.visible = domeVisible;
      if (grad) grad.visible = gradVisible;
    }
    this._renderMs += performance.now() - t0;                // 累计离屏渲染耗时（诊断渲染成本）

    this.frames++;
    if (this.frames % 60 === 0) {                            // 每 60 帧报一次均耗时，判断分辨率是否过重
      const avg = this._renderMs / 60;
      this._renderMs = 0;
      log(`离屏渲染均耗时 ${avg.toFixed(1)}ms/帧 ${this.W}x${this.H}`);
      this._autoScale(avg);                                  // 太重就自动降分辨率（见方法注释）
    }
    if (this.frames % 120 === 0) log(this.stats());          // 约每 5 秒一条心跳，便于判断是否在出帧
    if (this.track && this.track.requestFrame) this.track.requestFrame();  // WebRTC 手动推帧
    else this.push.tick?.();                                              // JPEG 模式
  }

  /**
   * 自适应降分辨率：头显闪烁的根因是「离屏渲染挤占 PICO GPU」，而每台设备/每个关卡
   * 能承受的离屏分辨率都不同，靠手工调 ?w=&h= 要反复往返。
   * 判据：XR 72Hz 单帧预算约 13.9ms，离屏渲染若平均吃掉 >CAST.SLOW_MS（默认 7ms），
   * 主渲染就会周期性超时 → 头显闪。连续两轮超标才降（避开纹理首次上传的冷启动尖峰），
   * 每次降到 0.75 倍，最多降 2 档（960→720→540）。?noscale=1 可关闭。
   */
  _autoScale(avgMs) {
    if (this.noScale || this._scaleStep >= 2 || this.frames < 180) return;
    if (avgMs <= CAST.SLOW_MS) { this._slowRounds = 0; return; }
    this._slowRounds = (this._slowRounds || 0) + 1;
    if (this._slowRounds < 2) return;
    this._slowRounds = 0;
    this._scaleStep = (this._scaleStep || 0) + 1;
    this.W = Math.max(320, Math.round(this.W * 0.75 / 2) * 2);   // 取偶数，H.264 要求
    this.H = Math.max(180, Math.round(this.H * 0.75 / 2) * 2);
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.renderer.setSize(this.W, this.H, false);
    this.cam.aspect = this.W / this.H;
    this.cam.updateProjectionMatrix();
    log(`离屏渲染过慢 → 自动降到 ${this.W}x${this.H}（第 ${this._scaleStep} 档）`);
  }

  /**
   * 通知 PC 端开场影片的播放阶段（'play' = 开始 / 'end' = 结束）。
   *
   * 为什么需要：影片期间头显**不能编码**（视频解码 × H.264 编码争用 VPU → 头显里影片闪，
   * 见 VIDEO_MODE 注释），PC 大屏因此看不到头显画面。改成让 PC 端**本地播放同一段影片**
   * （同源 `/assets/...`，由 EXE 托管游戏目录提供），两端靠这条信令对齐开始与结束；
   * 影片一结束头显立刻恢复推流，PC 端同步切回游戏画面 → 观感上是一条连续的视频。
   *
   * @param {'play'|'end'} stage
   * @param {string} src 影片相对路径（PC 端同源取，可省略 → 用 WAITING_ROOM.VIDEO_URL）
   */
  notifyIntro(stage, src) {
    try {
      this.signal.send({ type: 'intro', stage, src: src || WAITING_ROOM.VIDEO_URL });
      log(`已通知 PC 端：开场影片${stage === 'play' ? '开始' : '结束'}`);
    } catch (e) { /* 信令未就绪就忽略：最多少播影片，不影响推流 */ }
  }

  stats() {
    const rtc = this.push?.pc?.connectionState;
    return `cast: ${this.mode} ${this.W}x${this.H}@${this.fps} `
      + (this._warm ? '占位画面' : '游戏画面')
      + ` frames=${this.frames}${rtc ? ` rtc=${rtc}` : ''}`;
  }

  dispose() {
    clearInterval(this._infoTimer);
    clearTimeout(this._rtcFailTimer);
    this._stopPush();
    this._clearWarmup();
    try { this.signal?.close(); } catch (e) { /* 忽略 */ }
    try { this.renderer?.dispose(); } catch (e) { /* 忽略 */ }
    try { this.canvas?.remove(); } catch (e) { /* 忽略 */ }
  }
}
