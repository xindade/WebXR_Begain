import * as THREE from 'three';
import { TUTORIAL_HINT } from '../core/constants.js';
import { wrapBannerText } from './warningBanner.js';

// ============================================================
// 第六十二修 · 教学关常驻提示板（现场：「横幅提示时间太短，来不及看清」）
//
// 与 warningBanner 的区别（别把两者合并）：
//   · warningBanner ＝ 准星正前方 2s 一瞥的一次性横幅，负责**抓注意力**；
//   · 本板 ＝ **固定在场地前上方**的常驻板，负责**随时能读**：文案换到下一块横幅时才换字，
//     自己不超时、不自动消失（只在教学关显示，切关/教学流程结束必隐藏）。
//   两者同源：文案都来自 content/tutorial.js 的 TUTORIAL.BANNER，由 TutorialRunner 一处下发
//   （game._showTutorialHint），所以永远不会出现「板上写的和刚闪的横幅不是同一句」。
//
// 为什么是场景内 Sprite 而不是 DOM：头显沉浸态里页面 DOM 不可见（同 winBanner / 中场预警的结论）。
// Sprite 自带 billboard —— 板子固定在场地上，但永远正对玩家，不用自己写朝向。
//
// 位置/字号/底板全部走 constants.TUTORIAL_HINT（可经 userConfig 热调，改完刷新即生效）。
// ============================================================

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export class TutorialHintBoard {
  /** @param {THREE.Scene} scene @param {object} [cfg] 缺省 = constants.TUTORIAL_HINT */
  constructor(scene, cfg = TUTORIAL_HINT) {
    this.scene = scene;
    this.cfg = cfg;
    const { w, h } = cfg.CANVAS;
    this.cv = document.createElement('canvas');
    this.cv.width = w; this.cv.height = h;
    this.ctx = this.cv.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.cv);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mat = new THREE.SpriteMaterial({
      map: this.tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
    });
    this.sprite = new THREE.Sprite(this.mat);
    this.sprite.renderOrder = 890;   // 场景之上、一次性横幅(900)之下、通关横幅(1000)之下
    this.sprite.visible = false;
    this._text = null;               // 当前板上的文案（同文案不重绘，省纹理上传）
    this._t = 0;                     // 本次显示已进行秒数（淡入 + 轻浮相位）
    this._base = new THREE.Vector3(cfg.POSITION.x, cfg.POSITION.y, cfg.POSITION.z);
    this._applySize();
    scene.add(this.sprite);
  }

  get showing() { return !!this.sprite.visible; }
  get text() { return this._text; }

  // 世界宽度按画布比例折算高度（改 WIDTH 只动一个数）
  _applySize() {
    const cfg = this.cfg;
    this.sprite.scale.set(cfg.WIDTH, cfg.WIDTH * (cfg.CANVAS.h / cfg.CANVAS.w), 1);
  }

  /** 换一块横幅：文案变了才重绘；每次都重新淡入一次（「换新提示了」的提示感），并回到基准位置。 */
  show(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t || this.cfg.ENABLED === false) return;
    this._applySize();
    if (t !== this._text) {
      this._text = t;
      this._draw(t);
      if (this.cfg.LOG) console.log('[教学提示板] ' + t);
    }
    this.sprite.position.copy(this._base);
    this.sprite.visible = true;
    this._t = 0;
    this.mat.opacity = this.cfg.FADE_IN > 0 ? 0 : 1;
  }

  hide() {
    this.sprite.visible = false;
    this._t = 0;
    this.mat.opacity = 0;
  }

  /** 每帧调用：淡入 + 轻微上下浮动。浮完就完全静止，不再每帧写材质。 */
  update(dt) {
    if (!this.sprite.visible) return;
    const cfg = this.cfg;
    this._t += dt;
    const fin = cfg.FADE_IN > 0 ? cfg.FADE_IN : 0;
    if (fin > 0 && this._t < fin) {
      this.mat.opacity = Math.min(1, this._t / fin);
    } else if (this.mat.opacity !== 1) {
      this.mat.opacity = 1;
    }
    if (cfg.BOB) {
      this.sprite.position.y = this._base.y + cfg.BOB * Math.sin(this._t * Math.PI * 2 * (cfg.BOB_HZ || 0.35));
    }
  }

  _draw(text) {
    const cfg = this.cfg;
    const c = this.ctx;
    const W = cfg.CANVAS.w, H = cfg.CANVAS.h;
    c.clearRect(0, 0, W, H);

    // 底板 + 边框（半透明：真被什么挡住也还看得见后面的东西）
    c.fillStyle = cfg.BG;
    roundRect(c, 0, 0, W, H, 34); c.fill();
    c.strokeStyle = cfg.BORDER; c.lineWidth = cfg.BORDER_W;
    roundRect(c, cfg.BORDER_W / 2, cfg.BORDER_W / 2, W - cfg.BORDER_W, H - cfg.BORDER_W, 30); c.stroke();

    // 左侧竖标签「教学」：一枚深青圆角块，一眼区分「这是教学提示，不是警报」
    const tagW = cfg.TAG_W, tagH = cfg.TAG_H;
    const tx = cfg.PAD + 6;
    c.fillStyle = cfg.TAG_BG;
    roundRect(c, tx, (H - tagH) / 2, tagW, tagH, 22); c.fill();
    c.fillStyle = '#ffffff';
    c.font = 'bold ' + cfg.TAG_SIZE + 'px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(cfg.TAG, tx + tagW / 2, H / 2 + 2);

    // 正文：先折行（≤MAX_LINES 行）再降字号 —— 与一次性横幅同一套算法（warningBanner.wrapBannerText）
    const maxW = W - cfg.TEXT_LEFT - cfg.TEXT_RIGHT;
    const { lines, size } = wrapBannerText(c, text, {
      maxW, size: cfg.TEXT_SIZE, minSize: cfg.MIN_SIZE, maxLines: cfg.MAX_LINES,
    });
    const lh = size * (cfg.LINE_H || 1.06);
    const y0 = H / 2 - ((lines.length - 1) * lh) / 2;   // 多行时整体居中
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.lineWidth = cfg.OUTLINE_W;
    c.lineJoin = 'round';
    c.strokeStyle = cfg.OUTLINE;
    c.font = 'bold ' + size + 'px sans-serif';
    for (let i = 0; i < lines.length; i++) {
      const y = y0 + i * lh;
      c.strokeText(lines[i], cfg.TEXT_LEFT, y);       // 先描边：压住任意背景都读得清
      c.fillStyle = cfg.TEXT_COLOR;
      c.fillText(lines[i], cfg.TEXT_LEFT, y);
    }
    this.tex.needsUpdate = true;
  }

  dispose() {
    if (this.scene && this.sprite) this.scene.remove(this.sprite);
    if (this.mat) this.mat.dispose();
    if (this.tex) this.tex.dispose();
    this.sprite = null; this.mat = null; this.tex = null;
  }
}