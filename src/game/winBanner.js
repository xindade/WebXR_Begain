// 第18关魔术师 Boss · 通关 3D 横幅
// 锚定在玩家相机（准星）正前方，始终面向玩家；显示 WIN_BANNER_DURATION 秒后自动调用 onExpire（退出游戏）。
// 与 BossHealthBar3D 同理：VR 头显里 DOM HUD(hud.message) 不可见，故通关提示必须走场景内 3D 方案。
import * as THREE from 'three';

const CANVAS_W = 1024;
const CANVAS_H = 384;          // 画布 1024:384（≈2.67:1），与下方世界尺寸比例一致
const WORLD_W = 3.0;           // 横幅世界宽度(m)：上机后按可视距离微调
const WORLD_H = 1.125;         // 横幅世界高度(m) = WORLD_W × (CANVAS_H/CANVAS_W)
const VIEW_DISTANCE = 3.0;     // 距相机前方距离(m)：横幅停在准星处
const WIN_BANNER_DURATION = 10;// 持续秒数，到点自动退出游戏

export class WinBanner3D {
  constructor(scene, camera, text, onExpire = null) {
    this.scene = scene;
    this.camera = camera;
    this.text = (text || '').split('\n');
    this._onExpire = onExpire;
    this._t = 0;
    this._done = false;

    this.cv = document.createElement('canvas');
    this.cv.width = CANVAS_W; this.cv.height = CANVAS_H;
    this.ctx = this.cv.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.cv);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mat = new THREE.SpriteMaterial({
      map: this.tex, transparent: true, depthTest: false, depthWrite: false,
    });
    this.sprite = new THREE.Sprite(this.mat);
    this.sprite.scale.set(WORLD_W, WORLD_H, 1);
    this.sprite.renderOrder = 1000; // 始终画在最前，不被 Boss/场景遮挡
    this.scene.add(this.sprite);
    this._draw();
    this._followCamera(); // 首帧立即定位，避免闪现在原点
  }

  _draw() {
    const c = this.ctx;
    c.clearRect(0, 0, CANVAS_W, CANVAS_H);
    // 背板（半透明深色 + 金边）
    c.fillStyle = 'rgba(8,12,20,0.88)';
    _bannerRoundRect(c, 0, 0, CANVAS_W, CANVAS_H, 36); c.fill();
    c.strokeStyle = '#ffcf5a'; c.lineWidth = 8;
    _bannerRoundRect(c, 8, 8, CANVAS_W - 16, CANVAS_H - 16, 30); c.stroke();
    // 双行标题（准星处居中，玩家自然看得清）
    c.fillStyle = '#ffcf5a';
    c.font = 'bold 80px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const m = this.text.length;
    const cx = CANVAS_W / 2;
    const mid = CANVAS_H / 2;
    const gap = Math.min(96, CANVAS_H / (m + 1)); // 行间距
    for (let i = 0; i < m; i++) {
      const y = mid + (i - (m - 1) / 2) * gap;
      c.fillText(this.text[i], cx, y);
    }
    this.tex.needsUpdate = true;
  }

  // 每帧把横幅放到相机正前方（准星处），并累计 10s 计时
  update(dt) {
    this._followCamera();
    if (this._done) return;
    this._t += dt;
    if (this._t >= WIN_BANNER_DURATION) {
      this._done = true;
      if (this._onExpire) this._onExpire();
    }
  }

  _followCamera() {
    if (!this.camera) return;
    const pos = this.camera.getWorldPosition(_tmpV1);
    const dir = this.camera.getWorldDirection(_tmpV2);
    this.sprite.position.copy(pos).addScaledVector(dir, VIEW_DISTANCE);
  }

  dispose() {
    if (this.scene && this.sprite) this.scene.remove(this.sprite);
    if (this.mat) this.mat.dispose();
    if (this.tex) this.tex.dispose();
    this.sprite = null; this.mat = null; this.tex = null; this.camera = null;
  }
}

const _tmpV1 = new THREE.Vector3();
const _tmpV2 = new THREE.Vector3();

function _bannerRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
