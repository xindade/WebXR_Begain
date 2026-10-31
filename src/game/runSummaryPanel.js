// 本局结算面板（第九十二修）
// VR 头显里 DOM HUD 不可见，故与通关横幅一样走场景内 Sprite：
//   · 始终停在玩家视线前方，不主动消失；
//   · 只负责展示，不触发退出。真正的关闭由平台 closeGame 驱动。
import * as THREE from 'three';

const CANVAS_W = 1600;
const CANVAS_H = 1000;
const WORLD_W = 3.2;
const WORLD_H = WORLD_W * (CANVAS_H / CANVAS_W);
const VIEW_DISTANCE = 3.1;

const _tmpPos = new THREE.Vector3();
const _tmpDir = new THREE.Vector3();

export class RunSummaryPanel3D {
  constructor(scene, camera, data = {}) {
    this.scene = scene;
    this.camera = camera;
    this.data = data;

    this.cv = document.createElement('canvas');
    this.cv.width = CANVAS_W;
    this.cv.height = CANVAS_H;
    this.ctx = this.cv.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.cv);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mat = new THREE.SpriteMaterial({
      map: this.tex, transparent: true, depthTest: false, depthWrite: false,
    });
    this.sprite = new THREE.Sprite(this.mat);
    this.sprite.scale.set(WORLD_W, WORLD_H, 1);
    this.sprite.renderOrder = 5000;
    this.scene?.add(this.sprite);

    this._draw();
    this._followCamera();
  }

  _draw() {
    const c = this.ctx;
    const d = this.data || {};
    c.clearRect(0, 0, CANVAS_W, CANVAS_H);

    _roundRect(c, 10, 10, CANVAS_W - 20, CANVAS_H - 20, 34);
    c.fillStyle = 'rgba(7, 12, 24, 0.94)';
    c.fill();
    c.strokeStyle = '#ffcf5a';
    c.lineWidth = 7;
    c.stroke();

    c.fillStyle = '#ffcf5a';
    c.font = 'bold 62px sans-serif';
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.fillText(d.title || '本局结算', 72, 82);
    c.fillStyle = '#9fb0c9';
    c.font = '28px sans-serif';
    c.fillText(_fit(c, d.subtitle || '本局已结束', CANVAS_W - 144), 74, 132);

    _panelBox(c, 56, 174, 730, 730);
    _panelBox(c, 814, 174, 730, 730);

    this._section(c, 92, 214, 660, '战斗统计', d.combatLines || []);
    // 强化最多 7 条：570 与战斗统计留出清晰间距，7 条也不会越过 904 的面板下沿。
    this._section(c, 92, 570, 660, '强化选择', d.upgradeLines || []);
    this._section(c, 850, 214, 660, '技能构筑', d.skillLines || []);
    this._section(c, 850, 486, 660, '商店道具', d.itemLines || []);

    c.strokeStyle = 'rgba(255, 207, 90, 0.35)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(72, 924);
    c.lineTo(CANVAS_W - 72, 924);
    c.stroke();

    c.fillStyle = '#8fd3ff';
    c.font = 'bold 34px sans-serif';
    c.textAlign = 'center';
    c.fillText(d.footer || '请等待平台关闭游戏', CANVAS_W / 2, 961);
    this.tex.needsUpdate = true;
  }

  _section(c, x, y, width, title, lines) {
    c.fillStyle = '#ffcf5a';
    c.font = 'bold 34px sans-serif';
    c.textAlign = 'left';
    c.fillText(title, x, y);
    c.strokeStyle = 'rgba(255, 207, 90, 0.28)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(x, y + 18);
    c.lineTo(x + width, y + 18);
    c.stroke();

    c.font = '29px sans-serif';
    let ly = y + 62;
    for (const line of lines) {
      c.fillStyle = _lineColor(line);
      c.fillText(_fit(c, String(line || ''), width), x, ly);
      ly += 38;
    }
  }

  update() {
    this._followCamera();
  }

  _followCamera() {
    if (!this.camera || !this.sprite) return;
    const p = this.camera.getWorldPosition(_tmpPos);
    const dir = this.camera.getWorldDirection(_tmpDir);
    this.sprite.position.copy(p).addScaledVector(dir, VIEW_DISTANCE);
  }

  dispose() {
    if (this.scene && this.sprite) this.scene.remove(this.sprite);
    this.mat?.dispose();
    this.tex?.dispose();
    this.sprite = null;
    this.mat = null;
    this.tex = null;
    this.camera = null;
    this.scene = null;
    this.data = null;
  }
}

function _panelBox(c, x, y, w, h) {
  _roundRect(c, x, y, w, h, 22);
  c.fillStyle = 'rgba(20, 31, 52, 0.72)';
  c.fill();
  c.strokeStyle = 'rgba(120, 190, 255, 0.2)';
  c.lineWidth = 2;
  c.stroke();
}

function _lineColor(line) {
  const s = String(line || '');
  if (s.startsWith('角色') || s.startsWith('技能 ')) return '#ffffff';
  if (s.startsWith('Boss') || s.includes('Boss ')) return '#ff9f9f';
  if (s.startsWith('普通')) return '#b9d7ff';
  if (s.startsWith('（')) return '#73839a';
  return '#d8e2f2';
}

function _fit(c, text, maxWidth) {
  if (!text || c.measureText(text).width <= maxWidth) return text;
  let s = String(text);
  while (s.length > 1 && c.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
  return s + '…';
}

function _roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
