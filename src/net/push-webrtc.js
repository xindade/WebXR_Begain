// src/net/push-webrtc.js —— WebRTC 推流（游戏端作为 publisher，主动发 offer）
//
// 只走 LAN：iceServers 留空 → 只收集 host candidate，直连最快。
//   · 不要配 STUN：会引入 srflx 候选，家用路由通常不支持 NAT 回环，反而拖慢/连不上。
//   · 若 host candidate 被 Chrome 混淆成 xxx.local（mDNS）导致连不上，
//     改用 ?mode=jpeg 走 JPEG 兜底链路。

export class WebRtcPush {
  /**
   * @param {MediaStream} stream 由离屏 canvas.captureStream() 得到
   * @param {object} opt
   * @param {Signaling} opt.signal
   * @param {number} opt.maxBitrate 最大码率 bps
   * @param {number} opt.fps        目标帧率
   * @param {Function} opt.onLog
   */
  constructor(stream, { signal, maxBitrate = 1200000, fps = 24, onLog, onState, degrade = 'maintain-framerate' } = {}) {
    this.signal = signal;
    this.fps = fps;
    this.maxBitrate = maxBitrate;
    this.degrade = degrade;      // 编码器压力策略：maintain-resolution（保清晰度）/ maintain-framerate（保帧率）
    this.onLog = onLog;
    this.onState = onState;       // (state)=>void，state==='connected' 时通知上层（用于取消自动降级计时器）
    this.disposed = false;

    this.pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });

    this.pc.onicecandidate = (e) => {
      // candidate 为 null 表示收集结束，也发过去让对端知道
      this.signal.send({ type: 'ice', candidate: e.candidate ? e.candidate.toJSON() : null });
    };

    this.pc.onconnectionstatechange = () => {
      this.onLog?.(`RTC: ${this.pc.connectionState}`);
      // 成功连通 → 通知上层（取消自动降级计时器）
      if (this.pc.connectionState === 'connected') this.onState?.('connected');
      // failed 时不再自动重连（交给上层重建），避免 ICE 反复失败刷屏
    };

    for (const track of stream.getVideoTracks()) {
      this.sender = this.pc.addTrack(track, stream);
    }
    // 音频轨（调用方已挂到 stream 上）：与视频共用一条 PeerConnection，不单独重协商。
    // ⚠ 必须在 createOffer 之前 addTrack，否则 offer 里没有音频 m-line（事后加要重协商）。
    for (const track of stream.getAudioTracks()) {
      this.pc.addTrack(track, stream);
    }
  }

  // 我是 publisher：等 viewer 就绪后主动 createOffer
  async start() {
    if (this.disposed) return;
    try {
      const offer = await this.pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      await this.pc.setLocalDescription(offer);
      this._tuneBitrate();
      this.signal.send({ type: 'offer', sdp: this.pc.localDescription.sdp });
      this.onLog?.('已发送 offer，等待 answer');
    } catch (e) {
      this.onLog?.(`createOffer 失败: ${e.message}`);
    }
  }

  onRemote(sdp) {
    if (this.disposed || !sdp) return;
    if (this.pc.signalingState === 'have-local-offer') {
      this.pc.setRemoteDescription({ type: 'answer', sdp }).catch(() => {});
    }
  }

  onIce(candidate) {
    if (this.disposed || !candidate) return;
    this.pc.addIceCandidate(candidate).catch(() => {});
  }

  /**
   * 原地替换视频轨道（不重建 PeerConnection、不重新协商），用于「占位画面 → 游戏画面」的切换。
   * 两个轨道尺寸一致时编码器无需重初始化，PC 端画面几乎无感切换。
   * @param {MediaStreamTrack} track 新轨道（离屏 canvas 的 captureStream 轨道）
   * @returns {Promise<boolean>} 是否替换成功（失败时上层应重建链路）
   */
  async replaceTrack(track) {
    if (this.disposed || !track || !this.sender) return false;
    if (!this.sender.replaceTrack) return false;
    try {
      await this.sender.replaceTrack(track);
      this._tuneBitrate();          // 新轨道沿用同一套码率/帧率参数（setParameters 对 sender 生效）
      return true;
    } catch (e) {
      this.onLog?.(`replaceTrack 失败: ${e.message}`);
      return false;
    }
  }

  // 限制码率与帧率，并指定编码器压力策略（degradationPreference）
  _tuneBitrate() {
    if (!this.sender) return;
    try {
      const p = this.sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = this.maxBitrate;
      p.encodings[0].maxFramerate = this.fps;
      // 压力策略由 CAST.DEGRADE 控制（默认 'balanced'）。
      // ⚠ 勿用 'maintain-resolution'：PICO 硬件编码器在该策略下曾**一帧都不产出**
      //   （PC 端表现为「已 connected 但全程黑屏」，2026-09-09 实测）。
      p.degradationPreference = this.degrade;
      this.sender.setParameters(p).catch(() => {});
    } catch (e) { /* 某些内核不支持 setParameters，忽略 */ }
  }

  dispose() {
    this.disposed = true;
    try { this.pc.close(); } catch (e) { /* 忽略 */ }
  }
}
