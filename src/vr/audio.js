// 程序化音效（Web Audio API，全部代码生成，无需音频文件）
// 知识库要求：射击/爆炸/BGM 均程序生成。

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.bgmNodes = null;       // 程序化 BGM 节点（startBGM 创建）
    this._bgmEl = null;         // 文件 BGM 的 HTMLAudioElement（playBGM 创建）
    this._bgmUrl = null;        // 当前文件 BGM 的 url（同曲跳过重复启动）
    this._unlocked = false;
  }

  unlock() {
    if (this._unlocked) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this._unlocked = true;
  }

  _noiseBuffer(dur) {
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  playShoot() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(0.12);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t); src.stop(t + 0.12);
  }

  playPop() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(200, t);
    osc.frequency.exponentialRampToValueAtTime(800, t + 0.12);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    osc.connect(g).connect(this.master);
    osc.start(t); osc.stop(t + 0.15);
  }

  startBGM() {
    if (!this.ctx || this.bgmNodes) return;
    this._stopBgmEl();   // 切到程序化 BGM 前先停掉文件 BGM
    const t = this.ctx.currentTime;
    const bus = this.ctx.createGain();
    bus.gain.value = 0.18;
    bus.connect(this.master);
    // 4s 循环：简单鼓点 + 木琴音
    const step = 0.25;
    for (let i = 0; i < 16; i++) {
      const tt = t + i * step;
      // 鼓点
      const k = this.ctx.createOscillator();
      k.type = 'sine';
      k.frequency.setValueAtTime(150, tt);
      k.frequency.exponentialRampToValueAtTime(50, tt + 0.1);
      const kg = this.ctx.createGain();
      kg.gain.setValueAtTime(i % 4 === 0 ? 0.6 : 0.3, tt);
      kg.gain.exponentialRampToValueAtTime(0.001, tt + 0.15);
      k.connect(kg).connect(bus);
      k.start(tt); k.stop(tt + 0.15);
      // 木琴
      if (i % 2 === 0) {
        const notes = [523, 659, 784, 880];
        const o = this.ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = notes[(i / 2) % notes.length];
        const og = this.ctx.createGain();
        og.gain.setValueAtTime(0.2, tt);
        og.gain.exponentialRampToValueAtTime(0.001, tt + 0.3);
      o.connect(og).connect(bus);
      o.start(tt); o.stop(tt + 0.3);
    }
  }
  this.bgmNodes = bus;   // 保存引用，供 stopBGM 断开（原仅判空不赋值，重复 start 会叠加）
}

stopBGM() {
  // 统一出口：程序化 BGM 与文件 BGM 都停
  if (this.bgmNodes) {
    try { this.bgmNodes.disconnect(); } catch (e) { /* 已断开 */ }
    this.bgmNodes = null;
  }
  this._stopBgmEl();
}

// ===== 文件音频（music/ 下的 wav/mp3）=====
// 用 HTMLAudioElement 播放，不依赖 AudioContext 解码，鲁棒且简单。
// 相对路径与 GLB 同机制（项目根 index.html 为基址），中文文件名浏览器自动编码。

// 文件 BGM（循环）：更换前先停掉旧 BGM（文件或程序化）
playBGM(url, volume = 0.5) {
  if (this._bgmUrl === url && this._bgmEl) return;   // 同曲已在播 → 跳过
  this._stopBgmEl();
  this.stopProceduralBGM();
  if (!url) return;
  const el = new Audio(url);
  el.loop = true;
  el.preload = 'auto';
  el.volume = volume;
  el.play().catch(() => {});
  this._bgmEl = el;
  this._bgmUrl = url;
}

// 一次性语音/音效（不循环），播完即弃（无引用由 GC 回收）
playVoice(url, volume = 1) {
  if (!url) return;
  const el = new Audio(url);
  el.preload = 'auto';
  el.volume = volume;
  el.play().catch(() => {});
  return el;
}

_stopBgmEl() {
  if (this._bgmEl) {
    try { this._bgmEl.pause(); this._bgmEl.src = ''; } catch (e) { /* 忽略 */ }
    this._bgmEl = null;
    this._bgmUrl = null;
  }
}

stopProceduralBGM() {
  if (this.bgmNodes) {
    try { this.bgmNodes.disconnect(); } catch (e) { /* 已断开 */ }
    this.bgmNodes = null;
  }
}
}
