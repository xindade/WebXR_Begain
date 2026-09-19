// 程序化音频（Web Audio API，全部代码合成，零音频文件）
// 规格见桌面 AUDIO-SPEC.md：2 音效（shoot / pop）+ 3 套 BGM（normal / laser / boss）+ 强度分层。
// 关卡映射：普通关(normal) + 危机关(crisis) → 'normal'（mood=night 用黑夜变体）；
//          机制关(laser：第3/9/15关) → 'laser'；Boss 关(第6/12/18关) → 'boss'。
// 全部由代码实时合成，替换原 music/*.wav 文件 BGM。语音(_pendingOpenVoice)仍走文件 playVoice。

import { BGM_VOLUME } from '../core/constants.js'; // 各关卡 BGM 音量倍率（normal/laser/boss），可经 userConfig 热调

// ===== 关卡和弦 / 贝斯 / 音序（MIDI 音高；A4=69=440Hz）=====
const NORMAL_CHORDS = {
  dusk:  [[60,64,67],[57,60,64],[53,57,60],[55,59,62]], // 黄昏：C – Am – F – G
  night: [[57,60,64],[53,57,60],[50,53,57],[52,56,59]], // 黑夜：Am – F – Dm – E
};
const NORMAL_BASS = {
  dusk:  [48,45,41,43],  // C3 A2 F2 G2
  night: [45,41,38,40],  // A2 F2 D2 E2
};
const LASER_SEQ  = [57,60,64,67,64,60];   // A3 C4 E4 G4 E4 C4 机械琶音音型
const BOSS_BASS  = [38,38,39,33];         // Dm Dm E♭(那不勒斯) A(属) —— 永远绷着不解决
const BOSS_OST   = [0,0,7,0,12,0,7,0,0,12,7,0,0,7,12,7]; // 根-五-八 马达式推进

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.bgmBus = null;           // 程序化 BGM 总线（startBGM 创建，stopBGM 淡出后销毁）
    this._schedTimer = null;      // lookahead 调度器定时器
    this.track = 'normal';        // 'normal' | 'laser' | 'boss'
    this.variant = 'dusk';        // 仅 normal 有效：'dusk'(黄昏) | 'night'(黑夜)
    this.pendingTrack = null;     // 小节边界待切换
    this.pendingVariant = null;
    this.intensity = 0;            // 0~1 强度，仅改变编排密度/亮度（非音量）
    this.step = 0;                // 0..63，4 小节 × 16 分音符
    this.bar = 0;                 // 已循环的小节组数
    this.nextStepTime = 0;        // 下一个待排音符绝对时间
    this._bgmEl = null;           // 文件语音/音效的 HTMLAudioElement（playVoice 创建）
    this._bgmUrl = null;
    this._loopVoiceEl = null;     // 循环语音元素（playLoopVoice 创建，stopLoopVoice 停止）
    this._unlocked = false;
    this._bgmVol = 1.0;       // 当前曲目 BGM 音量倍率（= BGM_VOLUME[track]），由 startBGM/_onBar 更新
    this._laserHums = {};     // 激光嗡鸣实例表：key('sword'|'level') → {osc,osc2,g,lfo}；按 key 独立开关
  }

  // ===== 解锁（须在用户手势内调用）=====
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
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1; // 均匀白噪
    return buf;
  }

  _midi(n) { return 440 * Math.pow(2, (n - 69) / 12); }

  // ===== 生命周期 =====
  // 总线基准增益（与历史一致）；各曲目实际目标增益 = BGM_BUS_BASE × BGM_VOLUME[track]
  _bgmVolFor(kind) {
    return (BGM_VOLUME && typeof BGM_VOLUME[kind] === 'number') ? BGM_VOLUME[kind] : 1.0;
  }

  startBGM() {
    if (!this.ctx || this.bgmBus) return;
    if (this.ctx.state === 'suspended') this.ctx.resume(); // 浏览器自动播放策略：确保播前已恢复（否则整条 BGM 静音，但 HTML 语音照常）
    this._stopBgmEl();
    const t = this.ctx.currentTime;
    this.bgmBus = this.ctx.createGain();
    this.bgmBus.gain.setValueAtTime(0.0001, t);
    this._bgmVol = this._bgmVolFor(this.track);
    this.bgmBus.gain.linearRampToValueAtTime(0.18 * this._bgmVol, t + 0.8);  // 0.8s 内升到 0.18×当前曲目倍率
    this.bgmBus.connect(this.master);
    this.step = 0; this.bar = 0;
    this.nextStepTime = t + 0.1;
    this._schedTimer = setInterval(() => this._schedule(), 25); // 25ms 轮询
  }

  _schedule() {
    if (!this.ctx || !this.bgmBus) return;
    const now = this.ctx.currentTime;
    if (this.nextStepTime < now) this.nextStepTime = now + 0.05; // 休眠恢复后重新对齐（不清算补发）
    const stepDur = 60 / this._bpm() / 4;
    while (this.nextStepTime < now + 0.2) {                      // 0.2s 预排窗口
      this._playStep(this.step, this.nextStepTime);
      this.nextStepTime += stepDur;
      this.step += 1;
      if (this.step >= 64) { this.step = 0; this.bar += 1; this._onBar(); }
    }
  }

  _onBar() {
    if (this.pendingTrack) {
      this.track = this.pendingTrack;
      this.variant = this.pendingVariant;
      this.pendingTrack = null;
      this.pendingVariant = null;
      this._rampBgmVol(this._bgmVolFor(this.track), 0.55); // 切轨后把总线音量平滑过渡到新曲目设定
    }
  }

  // 平滑改变 BGM 总线音量（受 BGM_VOLUME 倍率控制）；用 _bgmVol 记录当前倍率，供 _duck 回弹
  _rampBgmVol(vol, dur = 0.55) {
    if (!this.bgmBus) return;
    this._bgmVol = vol;
    const t = this.ctx.currentTime;
    const g = this.bgmBus.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(Math.max(0.0001, 0.18 * vol), t + dur);
  }

  stopBGM() {
    if (this._schedTimer) { clearInterval(this._schedTimer); this._schedTimer = null; }
    if (this.bgmBus) {
      const now = this.ctx.currentTime;
      const g = this.bgmBus.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0.0001, now + 0.25);             // 0.25s 淡出
      const bus = this.bgmBus;
      setTimeout(() => { try { bus.disconnect(); } catch (e) {} }, 400);
      this.bgmBus = null;
    }
    this._stopBgmEl();
  }

  // 切轨：未播放→直接写；播放中→排到下一循环边界并 duck
  setTrack(kind, variant) {
    const v = variant || (kind === 'normal' ? 'dusk' : null);
    if (this.bgmBus) {
      this.pendingTrack = kind;
      this.pendingVariant = v;
      this._duck();
    } else {
      this.track = kind;
      this.variant = v;
    }
  }

  setIntensity(v) { this.intensity = Math.max(0, Math.min(1, v || 0)); }

  _duck() {
    if (!this.bgmBus) return;
    const now = this.ctx.currentTime;
    const g = this.bgmBus.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0.02, now + 0.18);  // 0.18s 压到近乎静音
    g.linearRampToValueAtTime(Math.max(0.0001, 0.18 * this._bgmVol), now + 0.55);  // 再 0.37s 回到当前曲目设定音量
  }

  _bpm() {
    if (this.track === 'laser') return 104;
    if (this.track === 'boss')  return 140;
    return this.variant === 'night' ? 116 : 124;  // normal：黄昏 124 / 黑夜 116
  }

  _playStep(step, t) {
    const s = step % 16;     // 小节内 16 分位置
    const b = Math.floor(step / 16); // 第几小节 0..3
    if (this.track === 'normal') this._stepNormal(s, b, t);
    else if (this.track === 'laser') this._stepLaser(s, b, t);
    else if (this.track === 'boss')  this._stepBoss(s, b, t);
  }

  // ===== 鼓组 =====
  _kick(t, gain = 0.6) {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.1);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    o.connect(g).connect(this.bgmBus);
    o.start(t); o.stop(t + 0.18);
  }

  _snare(t, gain = 0.32) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(0.2);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1300;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    src.connect(hp).connect(g).connect(this.bgmBus);
    src.start(t); src.stop(t + 0.2);
  }

  _hat(t, gain = 0.1, dur = 0.045, hpFreq = 7000) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(dur + 0.02);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = hpFreq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(hp).connect(g).connect(this.bgmBus);
    src.start(t); src.stop(t + dur + 0.02);
  }

  // 太鼓（boss 关主打击）
  _taiko(t, gain = 0.5) {
    const o = this.ctx.createOscillator();                 // 落音
    o.type = 'sine';
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.18);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    o.connect(g).connect(this.bgmBus);
    o.start(t); o.stop(t + 0.26);
    const n = this.ctx.createBufferSource();               // 瞬态
    n.buffer = this._noiseBuffer(0.05);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 900;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(gain * 0.45, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    n.connect(bp).connect(ng).connect(this.bgmBus);
    n.start(t); n.stop(t + 0.06);
  }

  _cymbal(t, gain = 0.12, dur = 0.45) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(dur);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 5000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(hp).connect(g).connect(this.bgmBus);
    src.start(t); src.stop(t + dur + 0.02);
  }

  // ===== 旋律 / 和声 =====
  _pluck(t, freq, gain = 0.16, dur = 0.26, type = 'triangle') {
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.bgmBus);
    o.start(t); o.stop(t + dur + 0.02);
  }

  _bassPluck(t, freq, gain = 0.2, dur = 0.2) {
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth'; o.frequency.value = freq;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 6; // 谐振低通=拨弦鼻音
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(lp).connect(g).connect(this.bgmBus);
    o.start(t); o.stop(t + dur + 0.02);
  }

  _pad(t, freq, dur, gain = 0.06, cutoff = 400) {
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = cutoff;
    const g = this.ctx.createGain();
    lp.connect(g).connect(this.bgmBus);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + dur * 0.25);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    for (const det of [-6, 6]) {                       // 失谐加厚
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det;
      o.connect(lp);
      o.start(t); o.stop(t + dur + 0.05);
    }
  }

  _brass(t, freq, dur = 0.2, gain = 0.11) {
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2400;
    const g = this.ctx.createGain();
    lp.connect(g).connect(this.bgmBus);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.02);
    g.gain.setValueAtTime(gain, t + dur * 0.6);          // 平台后收尾
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    for (const det of [-10, 0, 10]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det;
      o.connect(lp);
      o.start(t); o.stop(t + dur + 0.03);
    }
  }

  _arp(t, freq, cutoff, gain = 0.05, dur = 0.12) {
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth'; o.frequency.value = freq;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = cutoff; lp.Q.value = 8; // 高 Q=金属味
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(lp).connect(g).connect(this.bgmBus);
    o.start(t); o.stop(t + dur + 0.02);
  }

  _ost(t, freq, cutoff, gain = 0.08, dur = 0.08) {
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth'; o.frequency.value = freq;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = cutoff; lp.Q.value = 5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);   // 极短=马达断续感
    o.connect(lp).connect(g).connect(this.bgmBus);
    o.start(t); o.stop(t + dur + 0.02);
  }

  _stab(t, freq, dur = 0.18, gain = 0.12, dissonant = false) {
    const notes = dissonant ? [freq, freq * 1.0595] : [freq]; // 小二度≈半音比 1.0595
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600;
    const g = this.ctx.createGain();
    lp.connect(g).connect(this.bgmBus);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);
    g.gain.setValueAtTime(gain, t + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    for (const f of notes) {
      for (const det of [-11, 0, 11]) {
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
        o.connect(lp);
        o.start(t); o.stop(t + dur + 0.02);
      }
    }
  }

  // 高速颤音弦（LFO 叠加到包络增益上）
  _tremString(t, freq, dur, gain = 0.05, rate = 13, dissonant = false) {
    const notes = dissonant ? [freq, freq * 1.0595, freq * 1.4983]
                            : [freq, freq * 1.005];            // 微失谐
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1100;
    const g = this.ctx.createGain();
    lp.connect(g).connect(this.bgmBus);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + dur * 0.18);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = rate;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = gain * 0.75;
    lfo.connect(lfoGain).connect(g.gain);                     // 叠加到包络
    lfo.start(t); lfo.stop(t + dur);
    for (const f of notes) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f;
      o.connect(lp);
      o.start(t); o.stop(t + dur + 0.02);
    }
  }

  _tremoloPad(t, freq, dur, gain = 0.05) { // 6Hz 颤音垫（备用）
    const notes = [freq, freq * 1.5];
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 700;
    const g = this.ctx.createGain();
    lp.connect(g).connect(this.bgmBus);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + dur * 0.2);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 6;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = gain * 0.6;
    lfo.connect(lfoGain).connect(g.gain);
    lfo.start(t); lfo.stop(t + dur);
    for (const f of notes) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f;
      o.connect(lp);
      o.start(t); o.stop(t + dur + 0.02);
    }
  }

  // ===== 低频与特效 =====
  // 极低频 sub（心跳/落雷）。⚠ 头显小喇叭对 50Hz 以下几乎无响应 → 叠二次谐波保证可闻。
  _sub(t, f0, f1, dur = 0.32, gain = 0.45) {
    const o = this.ctx.createOscillator();    // 基频
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.bgmBus);
    o.start(t); o.stop(t + dur + 0.02);
    const o2 = this.ctx.createOscillator();   // 二次谐波
    o2.type = 'sine';
    o2.frequency.setValueAtTime(f0 * 2, t);
    o2.frequency.exponentialRampToValueAtTime(f1 * 2, t + dur);
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.linearRampToValueAtTime(gain * 0.4, t + 0.012);
    g2.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o2.connect(g2).connect(this.bgmBus);
    o2.start(t); o2.stop(t + dur + 0.02);
  }

  _subDrop(t) { // 低频坠落（每两小节"又要来了"的预感）
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(26, t + 0.7);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.42, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.75);
    o.connect(g).connect(this.bgmBus);
    o.start(t); o.stop(t + 0.78);
    const o2 = this.ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.setValueAtTime(190, t);
    o2.frequency.exponentialRampToValueAtTime(52, t + 0.7);
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.linearRampToValueAtTime(0.1, t + 0.03);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.75);
    o2.connect(g2).connect(this.bgmBus);
    o2.start(t); o2.stop(t + 0.78);
  }

  _blip(t, freq = 2400, gain = 0.05) { // 机械时钟脉冲
    const o = this.ctx.createOscillator();
    o.type = 'sine'; o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
    o.connect(g).connect(this.bgmBus);
    o.start(t); o.stop(t + 0.05);
  }

  _clank(t, gain = 0.16) { // 金属撞击
    const n = this.ctx.createBufferSource();
    n.buffer = this._noiseBuffer(0.12);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2800; bp.Q.value = 3;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(gain, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
    n.connect(bp).connect(ng).connect(this.bgmBus);
    n.start(t); n.stop(t + 0.12);
    const o = this.ctx.createOscillator();
    o.type = 'square'; o.frequency.value = 180;
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(gain * 0.5, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    o.connect(og).connect(this.bgmBus);
    o.start(t); o.stop(t + 0.08);
  }

  _screech(t, gain = 0.05) { // 不协和高频尖刺
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    g.connect(this.bgmBus);
    for (const f of [1864, 1976]) {      // 小二度互相打架
      const o = this.ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      o.connect(g);
      o.start(t); o.stop(t + 0.18);
    }
  }

  _gong(t) { // 铜锣（Boss 进场）
    const partials = [
      { f: 92,  g: 0.16 },
      { f: 138, g: 0.16 / (138 / 92) },
      { f: 205, g: 0.16 / (205 / 92) },
      { f: 311, g: 0.16 / (311 / 92) },
    ];
    for (const p of partials) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(p.f, t);
      o.frequency.exponentialRampToValueAtTime(p.f * 0.82, t + 1.6);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(p.g, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
      o.connect(g).connect(this.bgmBus);
      o.start(t); o.stop(t + 1.85);
    }
    const n = this.ctx.createBufferSource();
    n.buffer = this._noiseBuffer(1.2);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 1.2;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.1, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
    n.connect(bp).connect(ng).connect(this.bgmBus);
    n.start(t); n.stop(t + 1.2);
  }

  _riser(t, dur = 1.1) { // 升调铺垫（Boss 进场）
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(880, t + dur);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(400, t);
    lp.frequency.exponentialRampToValueAtTime(6000, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.12, t + dur * 0.85);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(lp).connect(g).connect(this.bgmBus);
    o.start(t); o.stop(t + dur + 0.02);
  }

  // Boss 进场组合：升调 → 铜锣 → 三连太鼓
  playBossSting() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._riser(t, 1.0);
    this._gong(t + 1.0);
    for (let i = 0; i < 3; i++) this._taiko(t + 1.0 + i * 0.18, 0.45);
  }

  // ===== 激光嗡鸣（激光剑技能 + 机制关激光 共用）=====
  // 经典 "vveeee" 激光声：双锯齿(略失谐加厚) → 带通滤波 → 增益；叠 18Hz 颤音 LFO 让声音"活"起来。
  // 出现时淡入、消失时淡出；按 key('sword'|'level') 多实例独立开关，互不干扰。
  // 音量区间约 0.02~0.16（接入 master，不经 bgmBus，与 BGM 互不影响）。
  startLaserHum(key) {
    if (!this.ctx || this._laserHums[key]) return; // 已在响 → 幂等
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.linearRampToValueAtTime(220, t + 0.15); // 出现瞬间音高微升（经典的"蓄能"感）
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(184, t);
    osc2.frequency.linearRampToValueAtTime(226, t + 0.15);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 4; // 带通保留中段，去掉刺耳毛刺
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.14, t + 0.08);   // 0.08s 淡入
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 18;      // 颤音速率
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.04;                        // 颤音深度
    lfo.connect(lfoGain).connect(g.gain);             // 叠加到增益（音量抖动）
    osc.connect(bp); osc2.connect(bp);
    bp.connect(g).connect(this.master);
    osc.start(t); osc2.start(t); lfo.start(t);
    this._laserHums[key] = { osc, osc2, g, lfo };
  }

  // 设置某 key 激光嗡鸣的目标音量（level∈[0,1]，0=最轻静默感、1=最大）
  setLaserHumLevel(key, level) {
    const h = this._laserHums[key];
    if (!h) return;
    const t = this.ctx.currentTime;
    const target = 0.02 + 0.14 * Math.max(0, Math.min(1, level));
    const g = h.g.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(target, t + 0.05); // 平滑跟随出现/消失
  }

  stopLaserHum(key) {
    const h = this._laserHums[key];
    if (!h) return;
    this._laserHums[key] = null;
    const t = this.ctx.currentTime;
    const g = h.g.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.0001, t + 0.12); // 0.12s 淡出
    const stopAt = t + 0.16;
    try { h.osc.stop(stopAt); h.osc2.stop(stopAt); h.lfo.stop(stopAt); } catch (e) {}
  }

  // ===== 编排：三套 BGM =====
  _stepNormal(s, b, t) {
    const night = this.variant === 'night';
    const chord = (night ? NORMAL_CHORDS.night : NORMAL_CHORDS.dusk)[b];
    const bass  = (night ? NORMAL_BASS.night  : NORMAL_BASS.dusk)[b];
    const barLen = (60 / this._bpm() / 4) * 16;
    if (s % 4 === 0) this._kick(t, night ? 0.5 : 0.6);                 // 底鼓
    if (s === 10 && !night) this._kick(t, 0.3);                        // 弹跳鬼音（仅非黑夜）
    if (s === 4 || s === 12) this._snare(t, night ? 0.26 : 0.32);      // 军鼓
    if (s % 4 === 2) this._hat(t, night ? 0.07 : 0.1, 0.045, night ? 6000 : 7000); // 踩镲（反拍八分）
    if ([0,3,6,8,11,14].includes(s)) this._bassPluck(t, this._midi(bass), night ? 0.18 : 0.2, 0.2); // 贝斯（切分）
    if (s % 2 === 0) {                                                 // 木琴琶音
      const shape = [0,1,2,1];
      const k = (s / 2) % 8;
      const n = chord[shape[k % 4]] + (k >= 4 ? 12 : 0);
      this._pluck(t, this._midi(n), night ? 0.12 : 0.16, night ? 0.3 : 0.26);
    }
    if (night && s === 0) this._pad(t, this._midi(bass - 12), barLen, 0.055, 320); // 夜垫
  }

  _stepLaser(s, b, t) {
    const inten = this.intensity;
    const barLen = (60 / this._bpm() / 4) * 16;
    // 基础层在起步强度(0.2)即清晰可闻（原增益/低通过轻，在 PICO 小喇叭上几乎听不见）；
    // 强度越高再叠加副脉冲/踩镲/高八度（见下方阈值），分层语义不变。
    if (s === 0) this._pad(t, this._midi(33), barLen, 0.12, 420 + inten * 320);     // drone（原 0.07/352 → 0.12/420，更实更亮）
    if (s % 4 === 0) this._blip(t, 2400, 0.14);                                     // 时钟脉冲（原 0.05 → 0.14，清晰节拍）
    if (inten >= 0.5 && s % 4 === 2) this._blip(t, 1800, 0.06);                    // 副脉冲（≥0.5）
    const seq = LASER_SEQ[s % 6];
    this._arp(t, this._midi(seq), 700 + inten * 1600, 0.09 + inten * 0.035, 0.12);  // 琶音（每步，原 0.045/680 → 0.09/700，更亮更清楚）
    if (inten >= 0.7) this._arp(t, this._midi(seq + 12), 900 + inten * 1800, 0.05, 0.1); // 高八度（≥0.7）
    if (s === 0 || s === 8) {                                                       // 低频脉冲：基频 55Hz + 二次谐波 110Hz（§4.3 小喇叭可闻，原仅基频）
      const f0 = this._midi(33);
      const o = this.ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f0;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.22, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
      o.connect(g).connect(this.bgmBus);
      o.start(t); o.stop(t + 0.34);
      const o2 = this.ctx.createOscillator();   // 二次谐波：基频在 PICO 上几乎无感，叠谐波才听得到实体低频
      o2.type = 'sine'; o2.frequency.value = f0 * 2;
      const g2 = this.ctx.createGain();
      g2.gain.setValueAtTime(0.12, t);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
      o2.connect(g2).connect(this.bgmBus);
      o2.start(t); o2.stop(t + 0.34);
    }
    if (s === 8) this._clank(t, 0.2);                                              // 金属撞击（原 0.16 → 0.2）
    if (inten >= 0.5 && s % 4 === 2) this._hat(t, 0.08, 0.04, 8000);               // 踩镲（≥0.5）
  }

  _stepBoss(s, b, t) {
    const inten = this.intensity;
    const barLen = (60 / this._bpm() / 4) * 16;
    const br = BOSS_BASS[b];
    const breather = (b === 3 && s >= 14 && inten < 0.85);  // 留白：终期(≥0.85)取消
    // 1 ostinato（推进感核心）
    if (!breather) this._ost(t, this._midi(br + BOSS_OST[s]), 240 + inten * 280, 0.07 + inten * 0.035, 0.075);
    // 2 心跳 sub
    if (!breather && (s === 0 || s === 3 || s === 8 || s === 11)) {
      if (s === 0 || s === 8) this._sub(t, 47, 29, 0.34, 0.5);
      else this._sub(t, 41, 27, 0.24, 0.3);
    }
    // 3 太鼓
    if (!breather && (s === 0 || s === 6 || s === 8 || s === 14)) this._taiko(t, 0.52);
    if (inten >= 0.6 && (s === 3 || s === 11)) this._taiko(t, 0.32);             // 3b 加密太鼓
    if (inten >= 0.85 && b === 3 && (s === 12 || s === 13 || s === 15)) this._taiko(t, 0.3); // 3c 终期滚奏（只补12/13/15）
    // 4 颤音弦
    if (s === 0) this._tremString(t, this._midi(br + 12), barLen, 0.045 + inten * 0.03, 12 + inten * 6, inten >= 0.7);
    // 5 铜管 stab
    if (!breather && b !== 3 && (s === 0 || s === 6 || s === 10)) this._stab(t, this._midi(s === 10 ? 63 : 62), 0.18, 0.11 + inten * 0.03, inten >= 0.75);
    // 5b 属音长音（卡住不解决）
    if (!breather && b === 3 && s === 0) this._brass(t, this._midi(69), barLen * 0.9, 0.1 + inten * 0.03);
    // 6 踩镲
    if (!breather) {
      if (inten >= 0.55) { if (s % 2 === 0) this._hat(t, 0.055, 0.032, 9000); }
      else { if (s % 4 === 2) this._hat(t, 0.06, 0.04, 8000); }
    }
    // 7 坠落 + 钹（每两小节）
    if (b % 2 === 0 && s === 0) { this._subDrop(t); this._cymbal(t, 0.11, 0.4); }
    // 8 尖刺
    if (inten >= 0.8 && s === 13) this._screech(t, 0.05);
    // 9 留白低吼
    if (breather && s === 14) this._pad(t, this._midi(br), barLen, 0.07, 180);
    // 9b 蓄力下坠（接下一小节砸击）
    if (breather && s === 15 && inten >= 0.7) this._sub(t, 62, 30, 0.45, 0.4);
  }

  // ===== 音效（接 master，不经 bgmBus）=====
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

  // 手里剑投掷：短促 whoosh（带通噪声，频率上扫）
  playShurikenThrow() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(0.18);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1200, t);
    bp.frequency.exponentialRampToValueAtTime(3500, t + 0.18);
    bp.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t); src.stop(t + 0.18);
  }

  // 手里剑命中玩家：金属 ping（三角+方波双振子下扫，带打击感）
  playShurikenHit() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    g.connect(this.master);
    const o1 = this.ctx.createOscillator();
    o1.type = 'triangle';
    o1.frequency.setValueAtTime(2400, t);
    o1.frequency.exponentialRampToValueAtTime(1400, t + 0.18);
    o1.connect(g);
    const o2 = this.ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.setValueAtTime(3600, t);
    o2.frequency.exponentialRampToValueAtTime(2100, t + 0.18);
    const g2 = this.ctx.createGain();
    g2.gain.value = 0.4;
    o2.connect(g2).connect(g);
    o1.start(t); o1.stop(t + 0.18);
    o2.start(t); o2.stop(t + 0.18);
  }

  // ===== 文件音频（仅语音/一次性音效，不循环）=====
  playVoice(url, volume = 1) {
    if (!url) return;
    const el = new Audio(url);
    el.preload = 'auto';
    el.volume = volume;
    el.play().catch(() => {});
    return el;
  }

  // 循环语音（如龙 Boss 登场咆哮氛围音）：loop=true，需手动 stopLoopVoice 停止
  playLoopVoice(url, volume = 1) {
    if (!url) return null;
    this.stopLoopVoice();                 // 先停上一个，避免叠加
    const el = new Audio(url);
    el.preload = 'auto';
    el.loop = true;
    el.volume = volume;
    el.play().catch(() => {});
    this._loopVoiceEl = el;
    return el;
  }

  stopLoopVoice() {
    if (this._loopVoiceEl) {
      try { this._loopVoiceEl.pause(); this._loopVoiceEl.src = ''; } catch (e) { /* 忽略 */ }
      this._loopVoiceEl = null;
    }
  }

  _stopBgmEl() {
    if (this._bgmEl) {
      try { this._bgmEl.pause(); this._bgmEl.src = ''; } catch (e) { /* 忽略 */ }
      this._bgmEl = null;
      this._bgmUrl = null;
    }
  }
}
