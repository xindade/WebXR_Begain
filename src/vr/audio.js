// 程序化音效（Web Audio API，全部代码生成，无需音频文件）
// 知识库要求：射击/爆炸/BGM 均程序生成。

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.bgmNodes = null;
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
  }
}
