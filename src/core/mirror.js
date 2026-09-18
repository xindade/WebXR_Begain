// ============================================================
// VR 桌面镜像（mirror.js）
//   进入 VR 沉浸会话后，运行游戏的标签页被头显接管而黑屏。此模块在 PC 显示器上实时显示头显
//   第一人称画面，让 PC 上也能看到（PCVR 场景：游戏跑在 PC、头显当显示器）。
//
//   两种呈现方式（MIRROR.MODE，可热调、可回退）：
//     · 'page'  （默认）：在游戏页内嵌一个 2D canvas（#mirror-canvas）直接画出头显画面。
//       优点：无需 window.open，不消耗浏览器「用户激活」令牌 → PCVR 首次点「进入 VR」即可同时进游戏+出镜像，
//             不会再出现「首次点黑屏、需二次点击」的问题。
//     · 'popup'（旧方案，可回退）：独立弹出窗口（mirror.html）+ BroadcastChannel。若 'page' 在你的 PCVR 桌面环境
//       因页面被 XR 接管而不显示，把 MIRROR.MODE 改回 'popup' 即可。
//
//   截帧原理（已对照 vendored three r168 源码确认，版本无关）：
//     · three.js 在 WebGLRenderer.render 内由 `xr.enabled && xr.isPresenting` 决定改用
//       XR 相机(cameraXR)并把画面渲到 XR 帧缓冲（three.module.js:29736）。
//     · 本模块在截帧瞬间临时把 `renderer.xr.enabled` 关掉，改用 `renderer.xr.getCamera()
//       .cameras[0]`（左眼头显相机，已含本帧头部姿态）渲到低分辨率 RenderTarget，
//       再 readRenderTargetPixels 读回 CPU，画到页内 canvas（page 模式）或经 BroadcastChannel 发到镜像窗（popup 模式）。
//     · 截帧结束后立即还原 `xr.enabled` 与 XR 帧缓冲绑定，确保本帧头显提交不受影响。
//
//   ⚠ 关键：镜像只在「游戏页跑在桌面 PC」时工作（isDesktopPage）。游戏直接跑在独立头显(PICO/Quest)
//     浏览器时，头显独占屏幕、没有第二块屏可显示镜像，且每帧多一次 RT 渲染+读回会拖垮 Adreno XR2
//     （实测就是独立头显「第一关 20 帧」的根因）。故非桌面环境一律跳过（见 isDesktopPage 守卫）。
// ============================================================
import * as THREE from 'three';
import { MIRROR } from './constants.js';

// linear(0~255 字节) → sRGB(0~255 字节) 查找表：修正镜像偏暗。
// 原因：截帧用的普通 WebGLRenderTarget 被 three 强制线性输出，读回的是线性值；而头显画面是 sRGB 编码，
// 故读回后必须手动 linear→sRGB 才能与头显亮度一致。NoToneMapping 下这就是正确映射。
const SRGB_LUT = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const lin = i / 255;
    const s = lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055;
    t[i] = Math.max(0, Math.min(255, Math.round(s * 255)));
  }
  return t;
})();

// ============================================================
// 环境判定
//   isDesktopPage：游戏页面是否跑在桌面 PC（Windows/Mac/ChromeOS）。这是「是否有第二块显示器可显示镜像」
//     的可靠信号。刻意排除移动/头显内核串 + 不含会被头显伪造命中的 "X11/Linux x86_64/Ubuntu"，
//     避免把「直接跑在 PICO 浏览器」的页面误判成桌面而在头显上开启镜像（会拖垮 Adreno XR2）。
//   ⚠ 注意：不再用「是否独立头显」来门控「开场视频」——头显上视频由 introVideo.js 的 10Hz 强制刷新兜底，
//     实测可正常播放；以 UA 判独立头显既不可靠（PICO 伪造桌面串）又会导致视频被错误跳过（见 game.start）。
// ============================================================
export function isDesktopPage() {
  const ua = navigator.userAgent || '';
  // 先排除移动/头显内核：PICO/Quest/Android/Vision/Mobile/VR/Headset/PlayStation 等一律判为非桌面，
  // 绝不开启镜像（避免镜像的每帧 1080p RT 渲染+读回拖垮 Adreno XR2）。
  if (/PICO|Quest|Android|Vision|Mobile|VR|Headset|PlayStation/i.test(ua)) return false;
  // 仅认「明确是 PC」的 UA 串：Windows / macOS / ChromeOS。
  // ⚠ 刻意不含 "X11" / "Linux x86_64" / "Ubuntu"：PICO 浏览器会伪造这类桌面串（如 "X11; Linux x86_64"），
  //   若把它们当桌面，会误在头显上开启镜像 → 独立头显从 60 掉到 30 帧（实测对照：加 PCVR 前备份版无镜像即 60~70）。
  return /Windows NT|Mac OS X|Macintosh|CrOS/i.test(ua);
}

export class MirrorManager {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   */
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.win = null;            // 镜像弹出窗口引用（popup 模式）
    this.channel = null;        // BroadcastChannel('webxr-mirror')（popup 模式）
    this.rt = null;             // 低分辨率 RenderTarget
    this.buf = null;            // 读回像素缓冲 Uint8Array
    this.frame = 0;             // 帧计数（用于降帧）
    this.active = false;        // 是否启用截帧（窗口/页内 canvas 已就位 + ENABLED + 桌面环境）
    this.w = MIRROR.W;
    this.h = MIRROR.H;
    this.interval = MIRROR.INTERVAL;
    this.mode = MIRROR.MODE === 'popup' ? 'popup' : 'page';   // 仅接受 'page' / 'popup'
    this.pageCanvas = null;     // 页内镜像 canvas（page 模式）
    this.pageCtx = null;
    this._pageImg = null;       // 翻转用的 ImageData 缓冲
  }

  // 打开镜像（page 模式无副作用、可随时调用；popup 模式需手势激活，失败会注册重试）。
  // 返回是否成功开启。
  open() {
    if (!MIRROR.ENABLED) return false;
    // ⚠ 镜像只服务「游戏页在桌面 PC」的 PCVR 场景：独立头显没有第二块屏，且每帧 RT+读回会拖垮 Adreno XR2。
    //   用 isDesktopPage 守卫：即便头显 UA 伪造桌面串也能正确跳过（见文件顶部环境判定说明）。
    if (!isDesktopPage()) return false;
    if (this.mode === 'popup') return this._openPopup();
    return this._openPage();
  }

  _openPopup() {
    if (this.win && !this.win.closed) { this.win.focus(); return true; }
    const w = window.open('mirror.html', 'xr-mirror', 'width=960,height=540');
    if (!w) {
      // 被拦截：多半是本手势的 transient activation 已被先调用的 requestSession 占用，window.open 拿不到激活。
      // 注册一次性重试：玩家下一次点击 / 按键（新的手势）时自动再开，保证「进 VR 后自动出镜像」体验。
      if (!this._retryBound) {
        this._retryBound = true;
        const retry = () => {
          window.removeEventListener('pointerdown', retry);
          window.removeEventListener('keydown', retry);
          this._retryBound = false;
          if (!this.win || this.win.closed) this.open();
        };
        window.addEventListener('pointerdown', retry, { once: true });
        window.addEventListener('keydown', retry, { once: true });
      }
      console.warn('[Mirror] 镜像窗口被拦截（本次手势 activation 已被 requestSession 占用），将在你下次点击/按键时自动重试；也可点页面「镜像」按钮');
      return false;
    }
    this.win = w;
    this.channel = new BroadcastChannel('webxr-mirror');
    this.active = true;
    this._watchTimer = setInterval(() => {
      if (!this.win || this.win.closed) this.close();
    }, 1000);
    return true;
  }

  _openPage() {
    const c = this._getPageCanvas();
    if (!c) { console.warn('[Mirror] 找不到页内镜像 canvas (#mirror-canvas)'); return false; }
    c.style.display = 'block';
    this.active = true;
    return true;
  }

  // 关闭镜像并停用截帧。
  close() {
    this.active = false;
    if (this._watchTimer) { clearInterval(this._watchTimer); this._watchTimer = null; }
    if (this.channel) { try { this.channel.close(); } catch (_) {} this.channel = null; }
    if (this.win && !this.win.closed) { try { this.win.close(); } catch (_) {} }
    this.win = null;
    if (this.pageCanvas) this.pageCanvas.style.display = 'none';   // page 模式：隐藏页内 canvas
    const lbl = document.getElementById('mirror-label');
    if (lbl) lbl.style.display = 'none';
  }

  // 每帧（XR 主渲染之后）调用：截取头显第一人称画面并呈现（页内 canvas 或镜像窗）。
  // 仅在 VR 呈现期间、桌面环境、且已开启时工作；非呈现期 / 独立头显直接返回。
  capture() {
    if (!this.active) return;
    if (!isDesktopPage()) return;   // 双保险：非桌面环境绝不截帧（避免拖垮独立头显 GPU）
    const xr = this.renderer.xr;
    if (!xr.isPresenting) return;

    this.frame++;
    if (this.frame % this.interval !== 0) return;

    const xrCam = xr.getCamera();   // ArrayCamera：本帧已含头部姿态（由主渲染的 updateCamera 更新）
    if (!xrCam || !xrCam.cameras || !xrCam.cameras.length) return;
    const eye = xrCam.cameras[0];   // 左眼相机（含投影 + 视矩阵），用其作为第一人称视角

    if (!this.rt) {
      this.rt = new THREE.WebGLRenderTarget(this.w, this.h, {
        depthBuffer: true,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      // ⚠ 注意：three.js 对非 XR 渲染目标强制「线性输出」(three.module.js:20651/30374)，
      //   无论这里把 texture.colorSpace 设成什么都不影响着色器输出。所以读回的是线性值，
      //   直接 putImageData 到 2D canvas（按 sRGB 解释）会整体偏暗。亮度修正放在 _drawToPage 用 LUT 做 linear→sRGB。
      this.buf = new Uint8Array(this.w * this.h * 4);
    }

    const wasEnabled = xr.enabled;
    xr.enabled = false;                                  // 关掉 XR 路由，本次 render 用我们指定的相机渲到 RT
    const prevTarget = this.renderer.getRenderTarget();   // 当前 XR 帧缓冲（稍后还原）
    const prevVp = eye.viewport.clone();                  // 左眼自带半屏 viewport，渲染前改成整屏
    eye.viewport.set(0, 0, this.w, this.h);

    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, eye);
    this.renderer.readRenderTargetPixels(this.rt, 0, 0, this.w, this.h, this.buf);

    // 还原：眼 viewport / XR 帧缓冲 / xr.enabled —— 确保本帧头显提交不受影响
    eye.viewport.copy(prevVp);
    this.renderer.setRenderTarget(prevTarget);
    xr.enabled = wasEnabled;

    // 呈现：page 模式直接画到页内 canvas；popup 模式经 BroadcastChannel 发到镜像窗
    if (this.mode === 'popup') {
      if (this.channel && this.win && !this.win.closed) {
        this.channel.postMessage({ type: 'frame', data: this.buf.slice(0), w: this.w, h: this.h });
      }
    } else {
      this._drawToPage();
    }
  }

  // 把读回像素（底向上、线性）垂直翻转 + linear→sRGB 编码后画到页内 2D canvas。
  // ⚠ 不做任何「亮度倍率」相乘：在已 sRGB 编码的像素上乘 <1 增益只会把暗部压向灰、降低对比/饱和
  //   （实测=灰蒙蒙、不鲜艳）。linear→sRGB 已是「与头显画面一致」的正确映射；PC 显示器与头显面板的
  //   亮度/对比差异是硬件层面、无法用全局亮度修正，故这里只做正确的色彩空间转换。
  _drawToPage() {
    const c = this._getPageCanvas();
    if (!c) return;
    if (!this.pageCtx) this.pageCtx = c.getContext('2d');
    const ctx = this.pageCtx;
    if (!this._pageImg || this._pageImg.width !== this.w) this._pageImg = ctx.createImageData(this.w, this.h);
    const src = this.buf, dst = this._pageImg.data, rb = this.w * 4;
    const lut = SRGB_LUT;
    for (let y = 0; y < this.h; y++) {
      const sRow = y * rb, dRow = (this.h - 1 - y) * rb;       // 读回是底向上，逐行翻转
      for (let x = 0; x < this.w; x++) {
        const s = sRow + x * 4, d = dRow + x * 4;
        dst[d]     = lut[src[s]];       // R：linear→sRGB（与头显一致，不额外调亮）
        dst[d + 1] = lut[src[s + 1]];   // G
        dst[d + 2] = lut[src[s + 2]];   // B
        dst[d + 3] = src[s + 3];        // A 不变
      }
    }
    ctx.putImageData(this._pageImg, 0, 0);
  }

  _getPageCanvas() {
    if (this.pageCanvas) return this.pageCanvas;
    const c = document.getElementById('mirror-canvas');
    if (!c) return null;
    c.width = this.w; c.height = this.h;                  // 后备分辨率 = 截帧分辨率；显示尺寸由 CSS 控制
    this.pageCanvas = c;
    return c;
  }
}
