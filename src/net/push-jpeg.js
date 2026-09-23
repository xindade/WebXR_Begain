// src/net/push-jpeg.js —— JPEG 兜底推流（无 ICE / 无 mDNS / 无 NAT 依赖）
//
// 用途：WebRTC 在局域网被 mDNS 候选混淆、防火墙或多网卡搞挂时的保险链路。
// 只要页面能打开、POST 能通，就一定能出图（代价是延迟与带宽高于 WebRTC）。
//
// 性能关键（PICO 实测）：canvas.toBlob 直接对「带 preserveDrawingBuffer 的 WebGL 画布」编码时，
// Chrome 会把 readback(显存→内存) 与 JPEG 编码锁在同一个 GL 上下文里，触发整段管线停顿，
// PICO 上单帧编码可长达 5~6 秒 —— 这就是「5 秒才动一下、且只传当前帧」的根因
// （_busy 锁让上一帧编码期间所有帧被跳过，编码完只抓到最新一帧）。
//
// 修复：先用 drawImage 把 WebGL 画布一次性拷到「普通 2D 画布」（一次 readback），
// 再对 2D 画布 toBlob（纯 CPU 编码、完全不碰 GL 上下文，无管线停顿）。
// 实测 2D 画布的 toBlob 比 WebGL 画布快一个数量级，单帧从数秒降到亚秒级。
// 分辨率默认降到 854×480（1280×720 在 PICO 上太重），可用 ?w=&h=&q= 实时调。

export class JpegPush {
  /**
   * @param {HTMLCanvasElement} canvas 离屏观众 canvas（WebGL，preserveDrawingBuffer:true）
   * @param {object} opt
   * @param {Signaling} opt.signal
   * @param {number} opt.quality  JPEG 质量 0~1
   * @param {Function} opt.onLog
   */
  constructor(canvas, { signal, quality = 0.6, onLog } = {}) {
    this.canvas = canvas;
    this.signal = signal;
    this.quality = quality;
    this.onLog = onLog;
    this._busy = false;      // 上一帧还没编码完就跳过，防止堆积
    this.frames = 0;
    this._encMs = 0;         // 最近一次编码耗时（仅日志用）

    // 2D 中转画布：drawImage 拷入 + 2D.toBlob 编码。避开 WebGL 画布 toBlob 的 GL 管线停顿。
    this.tmp = document.createElement('canvas');
    this.tmp.width = canvas.width;
    this.tmp.height = canvas.height;
    this.t2d = this.tmp.getContext('2d');
  }

  /** 编码器是否正忙（cast.js 用它跳过无谓的离屏重渲染，省 GPU） */
  get busy() { return this._busy; }

  // 由 cast.js 在「刚画完一帧」之后调用（必须在同一 tick，否则 drawing buffer 已被清）
  tick() {
    if (this._busy) return;
    this._busy = true;
    const t0 = performance.now();

    // 优先走「2D 中转」：WebGL → 2D 拷贝(一次 readback) → 2D.toBlob(纯 CPU 编码)
    if (this.t2d) {
      try {
        this.t2d.drawImage(this.canvas, 0, 0, this.tmp.width, this.tmp.height);
      } catch (e) {
        this._busy = false;
        return;                 // 拷贝失败（理论上不会发生）→ 跳过本帧，不堆积
      }
      const tDraw = performance.now();
      this.tmp.toBlob((blob) => {
        this._encMs = performance.now() - tDraw;
        this._busy = false;
        if (!blob) return;
        this._emit(blob, t0);
      }, 'image/jpeg', this.quality);
      return;
    }

    // 兜底：2D 上下文不可用，退回直接对 WebGL 画布编码（PICO 上会慢，仅保险）
    this.canvas.toBlob((blob) => {
      this._encMs = performance.now() - t0;
      this._busy = false;
      if (!blob) return;
      this._emit(blob, t0);
    }, 'image/jpeg', this.quality);
  }

  _emit(blob, t0) {
    this.frames++;
    this.signal.sendBlob(blob);
    if (this.frames % 30 === 0) {
      this.onLog?.(`[cast] JPEG 单帧: 总=${Math.round(performance.now() - t0)}ms enc=${Math.round(this._encMs)}ms 累计=${this.frames}`);
    }
  }

  // WebRTC 路径没有这个方法，cast.js 用 `this.push.tick?.()` 统一调用
  dispose() { /* 无资源需要释放 */ }
}
