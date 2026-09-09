import * as THREE from 'three';
import { WRIST_UI } from '../core/constants.js';

// 手腕面板（参考 vr-controller-kit skill 的 ui.js 思路，改为自包含实现）
//   - 左手柄：战斗信息（关卡/剩余/船血/分数 + 龙Boss血条 + 攻/射/额外射击），橙色边框
//   - 右手柄：原战斗信息框已迁移到左手柄；右手腕位置现由「技能提示框」(skillHint.js) 占用，本面板隐藏
// 每个面板 = Canvas2D 画布 → CanvasTexture → PlaneGeometry，挂到手柄 grip 下。
// 不依赖原项目的 ship.js / buddhaPalm.js，数据直接从 Game 读取。
// 放置参数（位置/旋转/大小/边框/画布）统一在 constants.js 的 WRIST_UI 中，便于随时调整。

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
    // 右手：战斗信息（青），左手：日志（橙）。放置参数全部来自 constants.js 的 WRIST_UI。
    this.right = this._make(WRIST_UI.RIGHT);
    this.right.mesh.visible = false;  // 右手腕面板隐藏：位置已由 skillHint.js 技能提示框占用
    this.left = this._make(WRIST_UI.LEFT);
    this._frame = 0;
    this._log = [];
    this._attached = false;
  }

  // 由 WRIST_UI 配置构建面板。
  //   SCALE   : 物理尺寸相对 Canvas 像素(1px≈1mm)的缩放。Canvas 分辨率不变 → 缩小后文字依然锐利。
  //   POSITION: 相对手柄的放置位置（米），不再随尺寸自动缩放，方便独立微调。
  //   ROTATION: 角度(度)绕 XYZ；x 向下倾斜方便低头看手腕。
  //   CANVAS  : 画布分辨率（像素），只影响清晰度不影响物理大小。
  _make(cfg) {
    const cv = document.createElement('canvas');
    cv.width = cfg.CANVAS.w; cv.height = cfg.CANVAS.h;
    const ctx = cv.getContext('2d');
    const tex = new THREE.CanvasTexture(cv);
    // 1px ≈ 1mm：512px → 0.5m，再乘 SCALE 得到最终物理尺寸
    const geo = new THREE.PlaneGeometry((cfg.CANVAS.w / 1024) * cfg.SCALE, (cfg.CANVAS.h / 1024) * cfg.SCALE);
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 999; // 始终画在最前，不被头显模型挡住
    // 相对手柄：从配置应用位置 / 旋转（米 / 角度），上机后看效果微调。
    const D2R = THREE.MathUtils.degToRad;
    mesh.position.set(cfg.POSITION.x, cfg.POSITION.y, cfg.POSITION.z);
    mesh.rotation.set(D2R(cfg.ROTATION.x), D2R(cfg.ROTATION.y), D2R(cfg.ROTATION.z));
    return { cv, ctx, tex, mesh, w: cfg.CANVAS.w, h: cfg.CANVAS.h, border: cfg.BORDER };
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
    this._drawCombat(this.left, game);   // 左手柄：战斗信息（原右手内容；右手腕让位技能提示框）
    // 右手柄面板(this.right)已隐藏，位置由 skillHint.js 技能提示框占用
  }

  _drawCombat(panel, game) {
    const p = panel, c = panel.ctx;
    c.clearRect(0, 0, p.w, p.h);
    c.fillStyle = 'rgba(8,12,20,0.86)';
    roundRect(c, 0, 0, p.w, p.h, 28); c.fill();
    c.strokeStyle = p.border; c.lineWidth = 6;
    roundRect(c, 8, 8, p.w - 16, p.h - 16, 22); c.stroke();

    // —— 龙 Boss 关：右侧显示 Boss 实时血量条（进入 Boss 关后持续显示）——
    if (game.dragon) {
      c.fillStyle = p.border;
      c.font = 'bold 40px sans-serif';
      c.fillText('🐉 龙 Boss', 28, 56);

      const d = game.dragon;
      const max = d.maxHpPool || 1;
      const cur = Math.max(0, Math.round(d.hpPool));
      const ratio = Math.max(0, Math.min(1, cur / max));
      const bx = 28, by = 84, bw = p.w - 56, bh = 40;
      c.fillStyle = 'rgba(255,255,255,0.15)';            // 底槽
      roundRect(c, bx, by, bw, bh, 10); c.fill();
      c.fillStyle = ratio > 0.3 ? '#ff5a5f' : '#e63946'; // 血量（低于30%转深红）
      if (bw * ratio > 1) { roundRect(c, bx, by, bw * ratio, bh, 10); c.fill(); }
      c.fillStyle = '#ffffff';
      c.font = 'bold 30px sans-serif';
      c.fillText(`${cur} / ${max}`, bx, by + bh + 36);
      c.font = '34px sans-serif';
      c.fillText(`船血 : ${game.player.hp} / ${game.player.maxHp}`, 28, by + bh + 92);
      c.fillText(`分数 : ${game.score}`, 28, by + bh + 140);
      // —— 玩家战斗属性（攻击力 / 射速 / 额外射击）追加显示 ——
      const _p2 = game.player;
      const _extra2 = (_p2.shotCount > 1) ? (_p2.shotCount + ' 发/枪') : '单发';
      c.fillStyle = '#9fe8ff';
      c.font = '30px sans-serif';
      c.fillText('攻击力  : ' + _p2.atk, 28, by + bh + 188);
      c.fillText('射速    : ' + _p2.fireRate + ' 发/秒', 28, by + bh + 226);
      c.fillText('额外射击: ' + _extra2, 28, by + bh + 264);
      p.tex.needsUpdate = true;
      return;
    }

    c.fillStyle = p.border;
    c.font = 'bold 40px sans-serif';
    c.fillText('🎮 战斗信息', 28, 56);

    const lines = game.laserMode
      ? [
          `关卡    : ${game.levelIndex + 1} (激光)`,
          `激光气球: ${game.laser ? game.laser.groups.length : 0}`,
          `船血    : ${game.player.hp} / ${game.player.maxHp}`,
          `目标    : 到达底边过关`,
        ]
      : [
          `关卡    : ${game.levelIndex + 1}`,
          `剩余敌人: ${game.waves.remaining}`,
          `船血    : ${game.player.hp} / ${game.player.maxHp}`,
          `分数    : ${game.score}`,
        ];
    c.fillStyle = '#ffffff';
    c.font = '34px sans-serif';
    lines.forEach((t, i) => c.fillText(t, 28, 120 + i * 52));

    // —— 玩家战斗属性（攻击力 / 射速 / 额外射击）追加显示 ——
    const _p = game.player;
    const _extra = (_p.shotCount > 1) ? (_p.shotCount + ' 发/枪') : '单发';
    c.fillStyle = '#9fe8ff';
    c.font = '32px sans-serif';
    const _sy = 120 + lines.length * 52 + 14;
    c.fillText('攻击力  : ' + _p.atk, 28, _sy);
    c.fillText('射速    : ' + _p.fireRate + ' 发/秒', 28, _sy + 46);
    c.fillText('额外射击: ' + _extra, 28, _sy + 92);

    p.tex.needsUpdate = true;
  }

  // 左手柄面板现已改为战斗信息（由 _drawCombat(this.left, game) 绘制），本方法不再使用。
  // log() 缓冲接口仍保留，供 game.js 的 this.wristUI.log(...) 调用（仅入缓冲，不在界面显示）。
}
