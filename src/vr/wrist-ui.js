import * as THREE from 'three';

// 手腕面板（参考 vr-controller-kit skill 的 ui.js 思路，改为自包含实现）
//   - 右手柄：当前关卡 / 剩余敌人 / 船血 / 分数（青色边框）
//   - 左手柄：实时日志（橙色边框）
// 每个面板 = Canvas2D 画布 → CanvasTexture → PlaneGeometry，挂到手柄 grip 下。
// 不依赖原项目的 ship.js / buddhaPalm.js，数据直接从 Game 读取。

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class WristUI {
  constructor() {
    // 右手：战斗信息（青），物理尺寸 0.5m × 0.5m
    this.right = this._make(512, 512, '#00e5ff', 1);
    // 左手：日志（橙），物理尺寸缩到 1/6（约 0.083m × 0.042m），保持 Canvas 分辨率清晰
    this.left = this._make(512, 256, '#ff7a00', 1 / 6);
    this._frame = 0;
    this._log = [];
    this._attached = false;
  }

  // scale：物理尺寸相对 Canvas 像素(1px≈1mm)的缩放。Canvas 分辨率不变 → 缩小后文字依然锐利。
  _make(w, h, border, scale = 1) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const tex = new THREE.CanvasTexture(cv);
    // 1px ≈ 1mm：512px → 0.5m，再乘 scale 得到最终物理尺寸
    const geo = new THREE.PlaneGeometry((w / 1024) * scale, (h / 1024) * scale);
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 999; // 始终画在最前，不被头显模型挡住
    // 相对手柄：略低于手背、前移一点，向上倾斜方便低头看。偏移随尺寸同步缩小。
    mesh.position.set(0, -0.05 * scale, 0.09 * scale);
    mesh.rotation.x = -0.6;
    return { cv, ctx, tex, mesh, w, h, border };
  }

  // 追加一条日志（带时间戳），环形缓冲
  log(msg) {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    this._log.push(`[${t}] ${msg}`);
    if (this._log.length > 60) this._log.shift();
  }

  // 把手腕面板挂到手柄上（控制器连接后才可用，调用幂等）
  attach(input) {
    if (this._attached) return;
    const rightAnchor = input.getGrip('right') || input.getController('right') || input.getController('left');
    const leftAnchor = input.getGrip('left') || input.getController('left') || input.getController('right');
    if (!rightAnchor && !leftAnchor) return;
    if (rightAnchor) rightAnchor.add(this.right.mesh);
    if (leftAnchor) leftAnchor.add(this.left.mesh);
    this._attached = true;
  }

  update(dt, game, input) {
    this.attach(input);
    this._frame++;
    if (this._frame % 6 !== 0) return; // ~15fps 刷新，省算力
    this._drawRight(game);
    this._drawLeft();
  }

  _drawRight(game) {
    const p = this.right, c = p.ctx;
    c.clearRect(0, 0, p.w, p.h);
    c.fillStyle = 'rgba(8,12,20,0.86)';
    roundRect(c, 0, 0, p.w, p.h, 28); c.fill();
    c.strokeStyle = p.border; c.lineWidth = 6;
    roundRect(c, 8, 8, p.w - 16, p.h - 16, 22); c.stroke();

    c.fillStyle = p.border;
    c.font = 'bold 40px sans-serif';
    c.fillText('🎮 战斗信息', 28, 56);

    const lines = [
      `关卡    : ${game.levelIndex + 1}`,
      `剩余敌人: ${game.waves.remaining}`,
      `船血    : ${game.player.hp} / ${game.player.maxHp}`,
      `分数    : ${game.score}`,
    ];
    c.fillStyle = '#ffffff';
    c.font = '34px sans-serif';
    lines.forEach((t, i) => c.fillText(t, 28, 120 + i * 52));

    p.tex.needsUpdate = true;
  }

  _drawLeft() {
    const p = this.left, c = p.ctx;
    c.clearRect(0, 0, p.w, p.h);
    c.fillStyle = 'rgba(8,12,20,0.86)';
    roundRect(c, 0, 0, p.w, p.h, 24); c.fill();
    c.strokeStyle = p.border; c.lineWidth = 6;
    roundRect(c, 8, 8, p.w - 16, p.h - 16, 18); c.stroke();

    c.fillStyle = p.border;
    c.font = 'bold 34px sans-serif';
    c.fillText('📜 日志', 24, 44);

    c.fillStyle = '#e8e8e8';
    c.font = '26px sans-serif';
    this._log.slice(-6).forEach((t, i) => c.fillText(t, 24, 92 + i * 30));

    p.tex.needsUpdate = true;
  }
}
