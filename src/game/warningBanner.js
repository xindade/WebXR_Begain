import * as THREE from 'three';
import { MID_WARNING, LEVEL_TITLE, HEAL_BANNER } from '../core/constants.js';

// ============================================================
// 准星正前方的 3D 卡片（第四十二修做中场预警；第四十九修扩成「警告 / 关卡标题」两种样式）
//   · style 'warn'  —— 中场预警 / 精英来袭：暗红底 + 橙红边框 + 左右警示三角（原样保留）
//   · style 'title' —— 关卡标题卡：深蓝底 + 冰蓝边框 + 左右菱形与横线，文字自动缩放到放得下
//
// 为什么是场景内 Sprite 而不是 DOM：头显沉浸态里页面 DOM 不可见
//   （同 winBanner / wristUI / vignette 的结论）—— 所有「必须让玩家看到」的提示都只能在场景里做。
//
// 与 winBanner 的区别（别把两者合并）：
//   · winBanner 是一次性的通关横幅（跟着 Boss 结算，走 onExpire 收尾）；
//   · 本类只做「一瞥」：**复用同一个 Sprite 与同一张 canvas**，文本/样式变了才重绘。
//     ⚠ 正因为它只有一个 Sprite，标题卡与精英来袭横幅**共用同一个实例**：
//       两者的时间窗必须错开（标题在开局 DELAY 秒、精英最早 5s；见 constants.LEVEL_TITLE.SKIP_MECHANIC
//       与 spawnDirector 的脚本表）。若日后要同屏同时显示，得再建一个实例。
// ============================================================

const CANVAS_W = 1024;
const CANVAS_H = 256;
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

function _roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 某个样式对应的显示参数（尺寸/时长/距离）。纯函数，便于单测。 */
export function styleConfig(style) {
  if (style === 'title') return LEVEL_TITLE;
  if (style === 'heal') return HEAL_BANNER;   // 第五十修：回血提示（绿色）
  return MID_WARNING;
}

/**
 * 触发判据（纯函数，便于单测）：本关有倒计时 && 时间窗已过半 && 本关还没弹过。
 *   机制关(3/9/15)与 Boss 关(6/12/18)没有倒计时 —— 调用方传 seconds<=0 即自然为 false。
 * @param {number} elapsed 本关已进行秒数（waves.elapsed）
 * @param {number} seconds 本关时间窗（levelSecondsOf(n)）
 * @param {boolean} alreadyWarned 本关是否已经弹过（game._midWarned）
 */
export function midWarningDue(elapsed, seconds, alreadyWarned) {
  if (alreadyWarned) return false;
  const total = Number(seconds);
  if (!(total > 0)) return false;
  return Number(elapsed) >= total * MID_WARNING.AT;
}

export class WarningBanner3D {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this._t = Infinity;      // 已显示时长（Infinity = 未显示）
    this._text = null;
    this._style = null;
    const cfg = styleConfig('warn');
    this._seconds = cfg.SECONDS;
    this._fadeIn = cfg.FADE_IN;
    this._fadeOut = cfg.FADE_OUT;
    this._dist = cfg.DIST;
    this._rise = cfg.RISE || 0;

    this.cv = document.createElement('canvas');
    this.cv.width = CANVAS_W; this.cv.height = CANVAS_H;
    this.ctx = this.cv.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.cv);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mat = new THREE.SpriteMaterial({
      map: this.tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
    });
    this.sprite = new THREE.Sprite(this.mat);
    const h = cfg.WIDTH * (CANVAS_H / CANVAS_W);
    this.sprite.scale.set(cfg.WIDTH, h, 1);
    this.sprite.renderOrder = 900;   // 压在场景之上、通关横幅(1000)之下
    this.sprite.visible = false;
    scene.add(this.sprite);
  }

  /**
   * 弹一次。
   * @param {string} [text]  文案（缺省 = 该样式的默认文案）
   * @param {'warn'|'title'} [style] 样式：警告（默认）/ 关卡标题卡
   */
  show(text, style = 'warn') {
    const cfg = styleConfig(style);
    const t = text == null ? cfg.TEXT : text;
    if (t !== this._text || style !== this._style) {
      this._text = t; this._style = style;
      this._draw(t, style);
    }
    // 每次弹都重取尺寸/时长（同一实例两种样式交替用）
    const h = cfg.WIDTH * (CANVAS_H / CANVAS_W);
    this.sprite.scale.set(cfg.WIDTH, h, 1);
    this._seconds = cfg.SECONDS;
    this._fadeIn = cfg.FADE_IN;
    this._fadeOut = cfg.FADE_OUT;
    this._dist = cfg.DIST;
    this._rise = cfg.RISE || 0;
    this._t = 0;
    this.sprite.visible = true;
  }

  update(dt) {
    if (this._t === Infinity) return;
    const total = Math.max(0.01, this._seconds);
    this._t += dt;
    this._followCamera();
    if (this._t >= total) { this.hide(); return; }
    const fin = Math.max(1e-4, this._fadeIn);
    const fout = Math.max(1e-4, this._fadeOut);
    let a = 1;
    if (this._t < fin) a = this._t / fin;                                  // 淡入
    else if (this._t > total - fout) a = Math.max(0, (total - this._t) / fout); // 淡出
    this.mat.opacity = a;
  }

  hide() {
    this._t = Infinity;
    this.mat.opacity = 0;
    this.sprite.visible = false;
  }

  _followCamera() {
    if (!this.camera) return;
    const pos = this.camera.getWorldPosition(_v1);
    const dir = this.camera.getWorldDirection(_v2);
    this.sprite.position.copy(pos).addScaledVector(dir, this._dist);
    this.sprite.position.y += this._rise;   // 标题卡上抬一点，别正好压在准星上
  }

  _draw(text, style) {
    const c = this.ctx;
    c.clearRect(0, 0, CANVAS_W, CANVAS_H);
    if (style === 'title') this._drawTitle(c, text);
    else if (style === 'heal') this._drawHeal(c, text);
    else this._drawWarn(c, text);
    this.tex.needsUpdate = true;
  }

  // —— 警告样式（中场预警 / 精英来袭）——
  _drawWarn(c, text) {
    c.fillStyle = 'rgba(28,6,8,0.86)';
    _roundRect(c, 0, 0, CANVAS_W, CANVAS_H, 30); c.fill();
    c.strokeStyle = MID_WARNING.COLOR; c.lineWidth = 10;
    _roundRect(c, 10, 10, CANVAS_W - 20, CANVAS_H - 20, 24); c.stroke();

    // 左右各一个警示三角，中间一行文字（不依赖任何字体图标）
    c.fillStyle = MID_WARNING.COLOR;
    for (const cx of [96, CANVAS_W - 96]) {
      c.beginPath();
      c.moveTo(cx, 62); c.lineTo(cx + 52, 172); c.lineTo(cx - 52, 172);
      c.closePath(); c.fill();
      c.fillStyle = '#1c0608';
      c.font = 'bold 76px sans-serif';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('!', cx, 138);
      c.fillStyle = MID_WARNING.COLOR;
    }

    c.fillStyle = '#ffe9c9';
    c.font = 'bold 88px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, CANVAS_W / 2, CANVAS_H / 2 + 4);
  }

  // —— 回血提示（第五十修）—— 与警告同构的卡片，换成绿色 + 左侧一枚十字
  //     为什么复用同一个 Sprite：沉浸态里 DOM HUD 不可见，所有「必须看到」的提示
  //     都只能走场景内 Sprite；两块卡的时间窗错开即可（见文件头的说明）。
  _drawHeal(c, text) {
    c.fillStyle = HEAL_BANNER.BG;
    _roundRect(c, 0, 0, CANVAS_W, CANVAS_H, 30); c.fill();
    c.strokeStyle = HEAL_BANNER.COLOR; c.lineWidth = 10;
    _roundRect(c, 10, 10, CANVAS_W - 20, CANVAS_H - 20, 24); c.stroke();

    const cx = 108, cy = CANVAS_H / 2, arm = 34, thick = 22;
    c.fillStyle = HEAL_BANNER.COLOR;
    c.fillRect(cx - arm, cy - thick / 2, arm * 2, thick);
    c.fillRect(cx - thick / 2, cy - arm, thick, arm * 2);

    c.fillStyle = HEAL_BANNER.TEXT_COLOR;
    c.font = 'bold 88px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, CANVAS_W / 2 + 40, CANVAS_H / 2 + 4);
  }

  // —— 关卡标题卡（第四十九修）——
  //   深蓝渐变底 + 冰蓝双层描边 + 左右菱形与横线 + 自动缩放的一行「第 N 关 · 场景名」。
  _drawTitle(c, text) {
    const accent = LEVEL_TITLE.COLOR;
    const g = c.createLinearGradient(0, 0, 0, CANVAS_H);
    g.addColorStop(0, 'rgba(10,32,54,0.90)');
    g.addColorStop(1, 'rgba(4,12,24,0.92)');
    c.fillStyle = g;
    _roundRect(c, 0, 0, CANVAS_W, CANVAS_H, 34); c.fill();
    c.strokeStyle = accent; c.lineWidth = 8;
    _roundRect(c, 12, 12, CANVAS_W - 24, CANVAS_H - 24, 28); c.stroke();
    c.strokeStyle = 'rgba(127,212,255,0.30)'; c.lineWidth = 2;
    _roundRect(c, 24, 24, CANVAS_W - 48, CANVAS_H - 48, 22); c.stroke();

    // 左右装饰：一枚菱形 + 一条朝内的横线（纯画布绘制，不依赖字体图标）
    const cy = CANVAS_H / 2;
    const dB = 12, barW = 76, barGap = 16, edge = 60;
    c.fillStyle = accent;
    for (const sgn of [1, -1]) {
      const cx = sgn > 0 ? edge : CANVAS_W - edge;
      const bx = sgn > 0 ? edge + dB + barGap : CANVAS_W - edge - dB - barGap - barW;
      c.beginPath();
      c.moveTo(cx, cy - dB); c.lineTo(cx + dB, cy); c.lineTo(cx, cy + dB); c.lineTo(cx - dB, cy);
      c.closePath(); c.fill();
      c.fillRect(bx, cy - 3, barW, 6);
    }

    // 文字：先按可用宽度自动降字号，再「描边压字」保证远处也读得清
    const reserved = edge + dB + barGap + barW + 24;      // 单侧被装饰占掉的宽度
    const maxW = CANVAS_W - reserved * 2;
    let size = 92;
    c.font = 'bold ' + size + 'px sans-serif';
    while (size > 40 && c.measureText(text).width > maxW) {
      size -= 4;
      c.font = 'bold ' + size + 'px sans-serif';
    }
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineWidth = 10; c.strokeStyle = 'rgba(2,10,20,0.92)'; c.lineJoin = 'round';
    c.strokeText(text, CANVAS_W / 2, cy + 4);
    c.fillStyle = '#eaf6ff';
    c.fillText(text, CANVAS_W / 2, cy + 4);
  }

  dispose() {
    if (this.scene && this.sprite) this.scene.remove(this.sprite);
    if (this.mat) this.mat.dispose();
    if (this.tex) this.tex.dispose();
    this.sprite = null; this.mat = null; this.tex = null; this.camera = null;
  }
}
