import * as THREE from 'three';
import { MID_WARNING } from '../core/constants.js';

// ============================================================
// 中场预警 3D 横幅（第四十二修）
//   关卡过半时在准星正前方弹出「更强的敌人来袭」，停留 MID_WARNING.SECONDS 秒后自动淡出。
//
// 为什么是场景内 Sprite 而不是 DOM：头显沉浸态里页面 DOM 不可见
//   （同 winBanner / wristUI / vignette 的结论）—— 所有「必须让玩家看到」的提示都只能在场景里做。
//
// 与 winBanner 的区别（别把两者合并）：
//   · winBanner 是一次性的通关横幅（跟着 Boss 结算，走 onExpire 收尾）；
//   · 本类只做「一瞥」：每关最多一次，**复用同一个 Sprite 与同一张 canvas**
//     （18 关 × 每关一次，若每次新建 canvas + texture，等于白送 18 次纹理上传）。
// ============================================================

const CANVAS_W = 1024;
const CANVAS_H = 256;
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
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

    this.cv = document.createElement('canvas');
    this.cv.width = CANVAS_W; this.cv.height = CANVAS_H;
    this.ctx = this.cv.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.cv);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mat = new THREE.SpriteMaterial({
      map: this.tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
    });
    this.sprite = new THREE.Sprite(this.mat);
    const h = MID_WARNING.WIDTH * (CANVAS_H / CANVAS_W);
    this.sprite.scale.set(MID_WARNING.WIDTH, h, 1);
    this.sprite.renderOrder = 900;   // 压在场景之上、通关横幅(1000)之下
    this.sprite.visible = false;
    scene.add(this.sprite);
  }

  /** 弹一次（重复调用只是重新计时；文本变了才重绘 canvas） */
  show(text) {
    const t = text == null ? MID_WARNING.TEXT : text;
    if (t !== this._text) { this._text = t; this._draw(t); }
    this._t = 0;
    this.sprite.visible = true;
  }

  update(dt) {
    if (this._t === Infinity) return;
    const total = Math.max(0.01, MID_WARNING.SECONDS);
    this._t += dt;
    this._followCamera();
    if (this._t >= total) { this.hide(); return; }
    const fin = Math.max(1e-4, MID_WARNING.FADE_IN);
    const fout = Math.max(1e-4, MID_WARNING.FADE_OUT);
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
    this.sprite.position.copy(pos).addScaledVector(dir, MID_WARNING.DIST);
  }

  _draw(text) {
    const c = this.ctx;
    c.clearRect(0, 0, CANVAS_W, CANVAS_H);
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
    this.tex.needsUpdate = true;
  }

  dispose() {
    if (this.scene && this.sprite) this.scene.remove(this.sprite);
    if (this.mat) this.mat.dispose();
    if (this.tex) this.tex.dispose();
    this.sprite = null; this.mat = null; this.tex = null; this.camera = null;
  }
}