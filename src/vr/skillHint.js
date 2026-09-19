import * as THREE from 'three';
import { SKILL_HINT } from '../core/constants.js';

const D2R = THREE.MathUtils.degToRad;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 右手枪中央技能面板：始终浮现（不再隐藏）。三态：
//   ① 冷却中(skillCooldown>0)  → 橙色边框 + 剩余秒数 + 恢复进度条；
//   ② 积分不足(score<skillCost) → 灰色边框 + "需 X 积分"；
//   ③ 就绪(score≥skillCost 且 cooldown=0) → 达标瞬间红框闪 FLASH_COUNT 下 → 之后金框常亮。
// 仅在"就绪跳变"(上帧未就绪→本帧就绪)时闪一次；释放技能会扣分+进冷却→未就绪，再次达标→再闪。
// 参数全部集中在 constants.SKILL_HINT（userConfig 可热调）。
export class SkillHintPanel {
  constructor() {
    const cfg = SKILL_HINT;
    const cv = document.createElement('canvas');
    cv.width = cfg.CANVAS.w; cv.height = cfg.CANVAS.h;
    const ctx = cv.getContext('2d');
    const tex = new THREE.CanvasTexture(cv);
    const geo = new THREE.PlaneGeometry((cfg.CANVAS.w / 1024) * cfg.SCALE, (cfg.CANVAS.h / 1024) * cfg.SCALE);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1000;                 // 始终画在最前，不被枪模型挡住
    mesh.position.set(cfg.POSITION.x, cfg.POSITION.y, cfg.POSITION.z);  // 相对右手柄(grip)本地坐标（默认落在右手枪中央）
    mesh.rotation.set(D2R(cfg.ROTATION.x), D2R(cfg.ROTATION.y), D2R(cfg.ROTATION.z));
    mesh.visible = true;                     // 始终浮现：进关即显示，不随积分/冷却隐藏
    this.cv = cv; this.ctx = ctx; this.tex = tex; this.mesh = mesh;
    this.w = cfg.CANVAS.w; this.h = cfg.CANVAS.h;
    this._prevReady = false;   // 上一帧是否"就绪"（检测达标跳变，触发闪烁）
    this._flashT = 0;         // 剩余闪烁时长（秒）；>0 表示正在闪烁
  }

  // 挂到右手柄(grip)；anchor 即右手枪同源父节点，故视觉落在枪中央。幂等。
  attach(anchor) {
    if (anchor && this.mesh.parent !== anchor) anchor.add(this.mesh);
  }

  update(dt, game) {
    const cfg = SKILL_HINT;
    const skillCost = game.player ? game.player.skillCost : 0;
    const cd = game.skillCooldown || 0;            // 剩余冷却（秒），>0 表示刚释放后冷却中
    const cdTotal = (typeof game._skillCdTotal === 'function') ? game._skillCdTotal() : 0;
    const ready = skillCost > 0 && game.score >= skillCost && cd <= 0;  // 两条件同时满足才"就绪"

    // 就绪跳变（未就绪→就绪）：启动一次"闪 N 下"动画（释放后冷却+扣分→未就绪，再次达标→再闪）
    if (ready && !this._prevReady) {
      this._flashT = cfg.FLASH_COUNT * (cfg.FLASH_ON + cfg.FLASH_OFF);
    }
    this._prevReady = ready;

    this.mesh.visible = true;   // 始终浮现
    let red = false;            // 当前是否处于"红"相位
    if (this._flashT > 0) {
      this._flashT = Math.max(0, this._flashT - dt);
      const cycle = cfg.FLASH_ON + cfg.FLASH_OFF;
      const elapsed = cfg.FLASH_COUNT * cycle - this._flashT;  // 已进行时长
      red = (elapsed % cycle) < cfg.FLASH_ON;
    }
    this._draw({ red, ready, cd, cdTotal, skillCost, game });
  }

  // 调试：读取左手柄摇杆(前后左右)与 X/Y键(上下)，按 DEBUG_STEP 平移本面板（实时调位）。
  //   摇杆：x→本地左右，sy→本地前后（PICO 前推为负=前=-Z）；X键→上(+y)，Y键→下(-y)。
  debugMove(input, dt) {
    if (!input) return;
    const step = (SKILL_HINT.DEBUG_STEP || 0.5) * dt;
    const dead = 0.15;
    const s = input.getLeftStick();
    if (Math.abs(s.x) > dead) this.mesh.position.x += s.x * step;
    if (Math.abs(s.y) > dead) this.mesh.position.z += s.y * step;   // 前推(sy<0)→z减→前移
    const b = input.getLeftButtons();
    if (b.x) this.mesh.position.y += step;   // 左X键=上
    if (b.y) this.mesh.position.y -= step;   // 左Y键=下
  }

  _draw(s) {
    const { red, ready, cd, cdTotal, skillCost, game } = s;
    const cfg = SKILL_HINT;
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);
    // 背景
    c.fillStyle = 'rgba(8,12,20,0.86)';
    roundRect(c, 0, 0, this.w, this.h, 28); c.fill();

    // 边框按状态取色
    let border = cfg.IDLE_BORDER, borderW = 6;
    if (red)                       { border = cfg.FLASH_BORDER;      borderW = 12; }
    else if (ready)                { border = cfg.READY_BORDER;      borderW = 6;  }
    else if (cd > 0)               { border = cfg.COOLDOWN_BORDER;   borderW = 6;  }
    else                          { border = cfg.INSUFFICIENT_BORDER; borderW = 6;  }
    c.strokeStyle = border;
    c.lineWidth = borderW;
    roundRect(c, 8, 8, this.w - 16, this.h - 16, 22); c.stroke();

    // 标题：技能名
    const name = this._skillName(game);
    c.fillStyle = border;
    c.font = 'bold 40px sans-serif';
    c.textAlign = 'center';
    c.fillText('⚡ ' + name, this.w / 2, 58);
    c.textAlign = 'left';

    // 调试：显示当前相对右手柄的本地坐标（调位时把这三个值抄进 SKILL_HINT.POSITION 即可）
    if (cfg.DEBUG) {
      c.fillStyle = '#ffd43b';
      c.font = 'bold 22px sans-serif';
      c.fillText('调试 x:' + this.mesh.position.x.toFixed(3) + ' y:' + this.mesh.position.y.toFixed(3) + ' z:' + this.mesh.position.z.toFixed(3), 28, 92);
    }

    if (red) {
      c.fillStyle = cfg.FLASH_BORDER;
      c.font = 'bold 34px sans-serif';
      c.fillText('技能就绪', 28, 124);
      c.fillStyle = '#ffffff';
      c.font = 'bold 28px sans-serif';
      c.fillText('用「中指」扣左手柄', 28, 176);
      c.fillText('握把键(Grip)释放', 28, 216);
    } else if (cd > 0) {
      // 冷却中：剩余秒数 + 恢复进度条
      c.fillStyle = cfg.COOLDOWN_BORDER;
      c.font = 'bold 34px sans-serif';
      c.fillText('冷却中 ' + cd.toFixed(1) + 's', 28, 116);
      const bx = 28, by = 144, bw = this.w - 56, bh = 36;
      c.fillStyle = cfg.COOLDOWN_BG;
      roundRect(c, bx, by, bw, bh, 10); c.fill();
      const frac = cdTotal > 0 ? Math.max(0, Math.min(1, 1 - cd / cdTotal)) : 0;  // 0→释放时，1→就绪
      if (frac > 0) { c.fillStyle = cfg.COOLDOWN_BAR_COLOR; roundRect(c, bx, by, bw * frac, bh, 10); c.fill(); }
      c.fillStyle = '#cfd6e4';
      c.font = '24px sans-serif';
      c.fillText('恢复中… ' + Math.round(frac * 100) + '%', 28, 214);
    } else if (ready) {
      c.fillStyle = cfg.READY_BORDER;
      c.font = 'bold 34px sans-serif';
      c.fillText('✓ 就绪', 28, 116);
      c.fillStyle = '#ffffff';
      c.font = 'bold 28px sans-serif';
      c.fillText('扣左手柄 Grip 释放', 28, 176);
    } else {
      // 积分不足
      c.fillStyle = cfg.INSUFFICIENT_TEXT;
      c.font = 'bold 30px sans-serif';
      c.fillText('需 ' + skillCost + ' 积分', 28, 124);
      c.fillStyle = '#cfd6e4';
      c.font = '24px sans-serif';
      c.fillText('继续击杀以蓄能', 28, 176);
    }

    // 底部积分（始终显示当前/所需）
    c.fillStyle = '#9fe8ff';
    c.font = '28px sans-serif';
    c.fillText('积分 ' + Math.floor(game.score) + ' / ' + skillCost, 28, this.h - 26);
    this.tex.needsUpdate = true;
  }

  _skillName(game) {
    const s = game.selectedSkill;
    if (s === 'buddha') return '如来神掌';
    if (s === 'lightsaber') return '激光剑';
    if (s === 'scatterburst') return '散射强化';
    if (s === 'scatter') return '积分散射';
    return '技能';
  }
}
