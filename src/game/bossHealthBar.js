// 第18关魔术师 Boss · 头顶 3D 血量条
// 用 THREE.Sprite（始终自动面向相机）承载 Canvas2D 血条，置于 Boss 头顶上方。
// VR 头显里 DOM HUD 不可见，故 Boss 血量必须走场景内 3D 方案；Sprite 无需手动 billboard。
import * as THREE from 'three';

const CANVAS_W = 256;
const CANVAS_H = 80;
const WORLD_W = 8;   // 血条世界宽度(m)：上机后按可视距离微调
const WORLD_H = 2.5; // 血条世界高度(m)

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class BossHealthBar3D {
  constructor(scene) {
    this.scene = scene;
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
    this.sprite.renderOrder = 999; // 始终画在最前，不被 Boss 模型遮挡
    this.sprite.visible = false;   // 待首次 update 有血量后再显示
    this.scene.add(this.sprite);
    this._lastHp = -1; this._lastMax = -1; // 仅血量变化时重绘，省算力
  }

  // 重绘 Canvas（底槽 + 绿→红填充条 + 文本）；Sprite 自动面向相机
  update(hp, maxHp) {
    const cur = Math.max(0, Math.round(hp));
    const max = maxHp || 1;
    if (cur === this._lastHp && max === this._lastMax) return;
    this._lastHp = cur; this._lastMax = max;
    this.sprite.visible = true;

    const c = this.ctx;
    c.clearRect(0, 0, CANVAS_W, CANVAS_H);
    // 背板
    c.fillStyle = 'rgba(8,12,20,0.82)';
    _roundRect(c, 0, 0, CANVAS_W, CANVAS_H, 14); c.fill();
    c.strokeStyle = '#ffcf5a'; c.lineWidth = 4;
    _roundRect(c, 3, 3, CANVAS_W - 6, CANVAS_H - 6, 12); c.stroke();

    // 标题
    c.fillStyle = '#ffcf5a';
    c.font = 'bold 26px sans-serif';
    c.textBaseline = 'top';
    c.fillText('🎩 魔术师 Boss', 14, 10);

    // 血条（绿→红）
    const ratio = Math.max(0, Math.min(1, cur / max));
    const bx = 14, by = 46, bw = CANVAS_W - 28, bh = 20;
    c.fillStyle = 'rgba(255,255,255,0.15)';
    _roundRect(c, bx, by, bw, bh, 8); c.fill();
    c.fillStyle = ratio > 0.5 ? '#2ecc71' : ratio > 0.25 ? '#f1c40f' : '#e74c3c';
    if (bw * ratio > 1) { _roundRect(c, bx, by, bw * ratio, bh, 8); c.fill(); }
    // 数值
    c.fillStyle = '#ffffff';
    c.font = 'bold 20px sans-serif';
    c.textBaseline = 'middle';
    c.fillText(`${cur} / ${max}`, bx + bw / 2 - c.measureText(`${cur} / ${max}`).width / 2, by + bh / 2);

    this.tex.needsUpdate = true;
  }

  // 每帧置于 Boss 头顶上方（worldPos = 代理位置 + 抬高偏移）
  setPosition(vec3) {
    this.sprite.position.copy(vec3);
  }

  dispose() {
    if (this.scene) this.scene.remove(this.sprite);
    if (this.mat) this.mat.dispose();
    if (this.tex) this.tex.dispose();
    this.sprite = null; this.mat = null; this.tex = null;
  }
}
