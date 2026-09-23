// src/net/signaling.js —— 直播信令客户端（SSE 下行 + POST 上行，明文 HTTP）
//
// 为什么不用 WebSocket：
//   · HTTPS 页面会硬性拦截 ws://（被判定为 blockable mixed content）；
//   · 而 wss:// 在证书不被信任时**没有任何弹窗**，只静默抛 CloseEvent 1006，极难排查。
// 局域网 PoC 直接走明文 HTTP 信令：免去自签证书被头显/接收端拒绝的问题；
// 媒体流仍由 WebRTC 自身 DTLS 加密，仅信令/帧明文，风险在局域网内可接受。
//
// APK 自带本地服务时页面 origin 是 http://localhost，信令在 http://<PC>:8443，
// 属于跨域 —— 服务端已开放 CORS（Access-Control-Allow-Origin: *），无需接受证书。

import { CAST } from '../core/constants.js';

export class Signaling {
  /**
   * @param {object}   opt
   * @param {string}   opt.base   信令前缀，如 '/api' 或 'https://192.168.31.228:8443/api'
   * @param {string}   opt.role   'publisher'（游戏端推流）| 'viewer'（PC 接收端）
   * @param {Function} opt.onReady     对端就绪 → 可以开始协商
   * @param {Function} opt.onRemote    收到 answer（sdp 字符串）
   * @param {Function} opt.onIce       收到 ICE candidate
   * @param {Function} opt.onPeerLeft  对端离开
   * @param {Function} opt.onLog       日志（接到 window.__pageLog 上）
   */
  constructor({ base, role = 'publisher', onReady, onRemote, onIce, onPeerLeft, onLog }) {
    this.base = base;
    this.role = role;
    this.cb = { onReady, onRemote, onIce, onPeerLeft, onLog };
    this.es = null;
    this.retry = 0;
    this.closed = false;
    this._open();
  }

  get eventsUrl() {
    return `${this.base}/events?role=${encodeURIComponent(this.role)}`;
  }

  _open() {
    if (this.closed) return;
    const es = new EventSource(this.eventsUrl);
    this.es = es;

    es.onopen = () => {
      this.retry = 0;
      this.cb.onLog?.('信令已连接');
    };

    es.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      switch (m.type) {
        case 'welcome':
          this.cb.onLog?.(`角色注册成功 role=${m.role}`);
          break;
        case 'peer-ready':
          this.cb.onReady?.();          // publisher 收到 → 可以 createOffer
          break;
        case 'peer-left':
          this.cb.onPeerLeft?.();
          break;
        case 'answer':
          this.cb.onRemote?.(m.sdp);    // 只有 publisher 会收到 answer
          break;
        case 'ice':
          this.cb.onIce?.(m.candidate);
          break;
        case 'log':
          this.cb.onLog?.(m.msg);
          break;
        default:
          break;
      }
    };

    es.onerror = () => {
      // EventSource 自带重连，但服务端不可达时会高频重试；这里关掉自己做退避重连
      try { es.close(); } catch (e) { /* 忽略 */ }
      if (this.closed) return;
      const d = Math.min(8000, 500 * 2 ** this.retry++);
      this.cb.onLog?.(`信令断开，${d}ms 后重连`);
      setTimeout(() => this._open(), d);
    };
  }

  // 上行：JSON 消息（join / offer / ice ...）
  async send(obj) {
    if (this.closed) return;
    try {
      await fetch(`${this.base}/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...obj, role: this.role }),
      });
    } catch (e) {
      this.cb.onLog?.(`POST /signal 失败: ${e.message}`);
    }
  }

  // 上行：二进制帧（JPEG 兜底模式）
  // 关键修复：改成 fire-and-forget（不 await）。原先 await 整个 POST 往返，而 APK 代理又是
  // 同步转发（NanoHTTPD 处理线程要等 PC 返回才释放），导致帧与帧之间必须等上一帧的完整 RTT，
  // 在 PICO 局域网下被压到约 0.2fps（「5 秒才动一下」）。改为发完即走后，头显只负责把 JPEG
  // 推到 APK，APK 后台线程异步转给 PC，链路变生产者-消费者管道，帧率不再被 RTT 锁死。
  sendBlob(blob) {
    if (this.closed) return;
    fetch(`${this.base}/frame`, { method: 'POST', body: blob }).catch((e) => {
      this.cb.onLog?.(`POST /frame 失败: ${e.message}`);
    });
  }

  close() {
    this.closed = true;
    try { this.es?.close(); } catch (e) { /* 忽略 */ }
  }
}

// 供 cast.js 取默认前缀（同源时用 CAST.SIGNAL；APK 场景由 ?pc= 覆盖）
export function defaultSignalBase(search = location.search) {
  const q = new URLSearchParams(search);
  const pc = q.get('pc');                       // 例如 192.168.31.228:8443
  if (pc) {
    // 局域网 PoC 明文 HTTP 信令：免去自签证书被头显/接收端拒绝的问题；
    // 媒体流仍由 WebRTC 自身 DTLS 加密，仅信令/帧明文，风险在局域网内可接受。
    const host = pc.startsWith('http') ? pc : `http://${pc}`;
    return `${host}${CAST.SIGNAL}`;
  }
  return CAST.SIGNAL;                           // 同源：页面本身就由接收端托管
}
