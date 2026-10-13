// 一次性冒烟测试：用 DOM + Web Audio 桩真实模拟点击，验证三张卡都能出声
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(import.meta.dirname, 'index.html'), 'utf8');
const parts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (parts.length !== 2) throw new Error('期望 2 个 script 块，实际 ' + parts.length);

// ── Web Audio 桩 ──────────────────────────────────────────────────────────
const T0 = Date.now();
const CTXS = [];
class Param {
  constructor(v) { this.value = v; }
  setValueAtTime(v) { this.value = v; return this; }
  linearRampToValueAtTime(v) { this.value = v; return this; }
  exponentialRampToValueAtTime(v) {
    if (v === 0) throw new Error('exponentialRamp 目标为 0（非法）');
    this.value = v; return this;
  }
  cancelScheduledValues() { return this; }
}
class Node {
  constructor(ctx, kind) {
    this.kind = kind; this.ctx = ctx;
    this.gain = new Param(1); this.frequency = new Param(440);
    this.detune = new Param(0); this.Q = new Param(1);
    this.type = 'sine'; this.buffer = null;
    this.playbackRate = new Param(1);
  }
  connect(n) { return n; }
  disconnect() { }
  start() { this.ctx.stats.starts++; }
  stop() { }
}
class FakeCtx {
  constructor() {
    this.sampleRate = 48000; this.state = 'running';
    this.destination = new Node(this, 'dest');
    this.stats = { osc: 0, buf: 0, filt: 0, gain: 0, starts: 0 };
    CTXS.push(this);
  }
  get currentTime() { return (Date.now() - T0) / 1000; }
  createGain() { this.stats.gain++; return new Node(this, 'gain'); }
  createOscillator() { this.stats.osc++; return new Node(this, 'osc'); }
  createBiquadFilter() { this.stats.filt++; return new Node(this, 'filter'); }
  createBufferSource() { this.stats.buf++; return new Node(this, 'bufsrc'); }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
  resume() { this.state = 'running'; return Promise.resolve(); }
}

// ── DOM 桩 ────────────────────────────────────────────────────────────────
const byId = {};
function mkEl(tag) {
  return {
    tagName: tag, className: '', innerHTML: '', textContent: '', style: {},
    children: [], onclick: null, oninput: null,
    value: '0.5', type: '', min: '', max: '', step: '',
    appendChild(c) { this.children.push(c); return c; },
    classList: { toggle() { }, add() { }, remove() { } },
  };
}
globalThis.document = {
  createElement: mkEl,
  getElementById(id) { return byId[id] || (byId[id] = mkEl('div')); },
};
globalThis.window = { AudioContext: FakeCtx };
globalThis.alert = () => { };
let rafUsed = false;
globalThis.requestAnimationFrame = (cb) => { if (!rafUsed) { rafUsed = true; setTimeout(cb, 0); } };

// ── 执行页面脚本 ──────────────────────────────────────────────────────────
(0, eval)(parts[0] + '\n;globalThis.__AM = AudioManager;\n' + parts[1]);

// 收集所有 className 含 'play' 的按钮（在 grid 卡片里）
const buttons = [];
(function walk(e) {
  if (typeof e.className === 'string' && e.className.split(' ').includes('play')) buttons.push(e);
  (e.children || []).forEach(walk);
})(byId.grid);
const all = [];
(function walk2(e) { all.push(e); (e.children || []).forEach(walk2); })(byId.grid);

const chips = all.filter(e => e.className === 'chip');
const playBtns = buttons;

console.log('卡片播放按钮数:', playBtns.length, '(期望 3)');
console.log('chip 按钮数:', chips.length, '(grid 卡片内的变体/预设/sting 按钮)');
if (playBtns.length !== 3) throw new Error('播放按钮数量不对');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const names = ['普通关 normal', '机制关 laser', 'Boss 关 boss'];
  for (let i = 0; i < playBtns.length; i++) {
    byId.stopAll.onclick && byId.stopAll.onclick();   // 先停
    await sleep(30);
    const ctxBefore = CTXS.length;
    playBtns[i].onclick();                             // 点击「播放」
    const ctx = CTXS[CTXS.length - 1];
    const snap = Object.assign({}, ctx.stats);
    await sleep(1100);                                 // 跑约 1.1 秒真实时间
    const d = {
      osc: ctx.stats.osc - snap.osc,
      buf: ctx.stats.buf - snap.buf,
      start: ctx.stats.starts - snap.starts,
    };
    console.log('[' + names[i] + '] 节点增量 osc=' + d.osc + ' bufferSource=' + d.buf + ' start()=' + d.start +
      (d.osc + d.buf > 0 && d.start > 0 ? '  ✅ 有声音' : '  ❌ 无声'));
    if (d.osc + d.buf === 0 || d.start === 0) throw new Error(names[i] + ' 未产生音频节点');
    byId.stopAll.onclick && byId.stopAll.onclick();
    await sleep(20);
  }

  // 强度预设 + 变体 + sting 按钮可点击且不抛错
  let clicked = 0;
  chips.forEach(c => { if (c.onclick) { c.onclick(); clicked++; } });
  console.log('chip 按钮全部可点击:', clicked + '/' + chips.length, clicked === chips.length ? '✅' : '❌');

  // 主音量滑块
  byId.vol.value = '0.8'; byId.vol.oninput && byId.vol.oninput();
  console.log('主音量联动:', byId.volVal.textContent, byId.volVal.textContent === '0.80' ? '✅' : '❌');

  // ── 第四十修 · 打击感音效：新增的按钮每一个都必须真的产出音频节点 ──
  //    （页面里 el() 写的是 innerHTML，不是 textContent）
  const sfxRow = byId.sfxRow;
  const sfxBtns = (sfxRow.children || []).filter(e => e.className === 'chip');
  console.log('\n打击感音效按钮数:', sfxBtns.length, '(期望 13)');
  if (sfxBtns.length !== 13) throw new Error('打击感音效按钮数量不对: ' + sfxBtns.length);
  const sfxCtx = CTXS[0];                 // 页面 AudioManager 的上下文（首次播放时创建）
  let sfxChecked = 0;
  for (const b of sfxBtns) {
    const label = String(b.innerHTML);
    if (label.indexOf('连击') >= 0) continue;   // 连击是定时器驱动的，单独验
    const before = sfxCtx.stats.osc + sfxCtx.stats.buf;
    b.onclick();
    const after = sfxCtx.stats.osc + sfxCtx.stats.buf;
    if (after <= before) throw new Error('音效按钮无声: ' + label);
    sfxChecked++;
  }
  console.log('音效按钮产出音频节点:', sfxChecked + '/' + sfxChecked, '✅');
  // 连击演示：等一拍确认它确实在按时序继续出音（而不是只建了个定时器）
  const comboBtn = sfxBtns.find(b => String(b.innerHTML).indexOf('连击') >= 0);
  const comboBefore = sfxCtx.stats.osc + sfxCtx.stats.buf;
  comboBtn.onclick();
  await sleep(500);
  if (sfxCtx.stats.osc + sfxCtx.stats.buf <= comboBefore) throw new Error('连击演示无声');
  console.log('连击演示按序出音 ✅');
  // ── Boss 强度分层：直接驱动 _playStep 跑满 4 小节，验证高压层真的会加进来 ──
  const AM = globalThis.__AM;
  const am2 = new AM();
  const ctx2 = new FakeCtx();
  am2.ctx = ctx2;
  am2.master = new Node(ctx2, 'master');
  am2.bgmBus = new Node(ctx2, 'bus');
  am2.track = 'boss'; am2.bar = 0; am2.step = 0;

  console.log('\nBoss 关 4 小节节点统计（验证强度分层）:');
  const rows = [];
  for (const inten of [0.45, 0.6, 0.8, 1.0]) {
    ctx2.stats = { osc: 0, buf: 0, filt: 0, gain: 0, starts: 0 };
    am2.setIntensity(inten);
    for (let i = 0; i < 64; i++) am2._playStep(i, 1 + i * 0.107);
    const total = ctx2.stats.osc + ctx2.stats.buf;
    rows.push({ inten, total, osc: ctx2.stats.osc, buf: ctx2.stats.buf });
    console.log('  强度 ' + inten.toFixed(2) + ' → osc ' + ctx2.stats.osc + ' + buf ' + ctx2.stats.buf + ' = ' + total);
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].total <= rows[i - 1].total) {
      throw new Error('强度 ' + rows[i].inten + ' 没有比 ' + rows[i - 1].inten + ' 更密 → 分层未生效');
    }
  }
  console.log('分层单调递增 ✅（越高强度声音越密）');

  console.log('\n全部通过 ✅');
  process.exit(0);
})().catch(e => { console.error('❌ 失败:', e.message); process.exit(1); });
