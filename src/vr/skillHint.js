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

// 第四十四修：沿矩形边框**等距**排 n 个方块（连杀计数搬到技能框边缘）。
//   · 边框 = 距画布四边 inset 像素的矩形；按**周长**等分，phase=0.5 → 首尾都不落在四角；
//   · 纯函数（不碰 canvas），便于单测；现场觉得压字/贴边只调 SKILL_HINT.STREAK 的 INSET/SIZE/PHASE。
export function edgeDotPositions(w, h, n, inset = 13, phase = 0.5) {
  const count = Math.max(1, n | 0);
  const x0 = inset, y0 = inset, x1 = w - inset, y1 = h - inset;
  const segs = [
    [x0, y0, x1, y0],   // 上
    [x1, y0, x1, y1],   // 右
    [x1, y1, x0, y1],   // 下
    [x0, y1, x0, y0],   // 左
  ];
  const lens = segs.map(([ax, ay, bx, by]) => Math.hypot(bx - ax, by - ay));
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const out = [];
  for (let i = 0; i < count; i++) {
    let s = (((i + phase) / count) * total) % total;
    if (s < 0) s += total;
    let k = 0;
    while (k < segs.length - 1 && s > lens[k]) { s -= lens[k]; k++; }
    const seg = segs[k];
    const t = Math.min(1, Math.max(0, s / (lens[k] || 1)));
    out.push({ x: seg[0] + (seg[2] - seg[0]) * t, y: seg[1] + (seg[3] - seg[1]) * t });
  }
  return out;
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
    // —— 第四十四修 · 连杀计数（原枪身红点环搬到这里）——
    const S = cfg.STREAK || {};
    this._streakNeed = Math.max(1, (S.DOTS | 0) > 0 ? (S.DOTS | 0) : 10);
    this._streakDots = edgeDotPositions(
      cfg.CANVAS.w, cfg.CANVAS.h, this._streakNeed,
      S.INSET != null ? S.INSET : 13, S.PHASE != null ? S.PHASE : 0.5,
    );
    this._streakFill = 0;            // 当前连杀数（已点亮方块数）
    this._streakBoost = false;       // 是否处于射速加速期（点变金 + 显示剩余秒数）
    this._streakFlashing = false;    // 集齐那一瞬的整圈闪光
    this._streakFlashT = Infinity;   // 闪光计时（Infinity = 没在闪）
    this._streakLastUntil = 0;       // 上一次看到的加速结束时刻（变了 = 新一次加速）
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
    // —— 第四十四修 · 连杀计数（子弹击杀；技能/神掌杀的不计入，见 game._bulletKill）——
    const S = cfg.STREAK || {};
    const streak = Math.max(0, game._bulletStreak | 0);
    const until = game._rapidUntil || 0;
    const now = game._gameTime || 0;
    const boost = until > now;
    // 加速结束时刻变了 = 刚刚集齐触发了一次新加速 → 整圈闪一下（此后计数已被清零）
    if (until !== this._streakLastUntil) {
      this._streakLastUntil = until;
      if (boost) this._streakFlashT = 0;
    }
    const flashing = this._streakFlashT < (S.FLASH_TIME > 0 ? S.FLASH_TIME : 0.35);
    if (flashing) this._streakFlashT += dt;
    this._streakFill = Math.min(streak, this._streakNeed);
    this._streakBoost = boost;
    this._streakFlashing = flashing;

    this._draw({ red, ready, cd, cdTotal, skillCost, game, flashing, boost, boostLeft: Math.max(0, until - now) });
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

  // 四行版式（第五十九修 · 现场口径）：
  //   ① 技能信息（名字 + 消耗）  ② 冷却条（状态文字 + 进度）  ③ 攻击力 / 弹道  ④ 射速 / 击杀充能
  //   加速期在第 4 行下方再补一行金色「加速 N.Ns」（属于第 4 行的补充信息，不另起一栏）。
  //   行高/基线全部来自 SKILL_HINT（可热调）；边框按状态取色，与旧版一致。
  _draw(s) {
    const { red, ready, cd, cdTotal, skillCost, game } = s;
    const cfg = SKILL_HINT;
    const c = this.ctx;
    const W = this.w, H = this.h;
    const PAD = cfg.PAD_X > 0 ? cfg.PAD_X : 34;
    const S = cfg.STREAK || {};
    c.clearRect(0, 0, W, H);
    c.textAlign = 'left';

    // 背景
    c.fillStyle = 'rgba(8,12,20,0.86)';
    roundRect(c, 0, 0, W, H, 28); c.fill();

    // 边框按状态取色
    let border = cfg.IDLE_BORDER, borderW = 6;
    if (red)                       { border = cfg.FLASH_BORDER;      borderW = 12; }
    else if (ready)                { border = cfg.READY_BORDER;      borderW = 6;  }
    else if (cd > 0)               { border = cfg.COOLDOWN_BORDER;   borderW = 6;  }
    else                          { border = cfg.INSUFFICIENT_BORDER; borderW = 6; }
    c.strokeStyle = border;
    c.lineWidth = borderW;
    roundRect(c, 8, 8, W - 16, H - 16, 22); c.stroke();

    // ===== 第一行：技能信息（名字 + 消耗）=====
    c.fillStyle = border;
    c.font = 'bold 38px sans-serif';
    c.textAlign = 'left';
    c.fillText('⚡ ' + this._skillName(game), PAD, cfg.ROW1_Y);
    // 消耗：现在放得出（就绪/冷却中）金色，积分不够浅灰 —— 一眼看出「能不能放」
    c.fillStyle = (cd <= 0 && !ready) ? cfg.INSUFFICIENT_TEXT : '#ffd24a';
    c.font = 'bold 30px sans-serif';
    c.textAlign = 'right';
    c.fillText('消耗 ' + skillCost, W - PAD, cfg.ROW1_Y);

    // ===== 第二行：冷却条（状态文字 + 进度条）=====
    let barCol = cfg.COOLDOWN_BAR_COLOR, frac = 0, label, labelCol;
    if (cd > 0) {
      label = '冷却 ' + cd.toFixed(1) + 's'; labelCol = cfg.COOLDOWN_BORDER;
      frac = cdTotal > 0 ? Math.max(0, Math.min(1, 1 - cd / cdTotal)) : 0;   // 0→刚释放，1→就绪
    } else if (ready) {
      label = '技能就绪 · 扣左手柄 Grip 释放'; labelCol = cfg.READY_BORDER;
      frac = 1; barCol = cfg.READY_BORDER;
    } else {
      label = '积分不足 · 现有 ' + Math.floor(game.score || 0); labelCol = cfg.INSUFFICIENT_TEXT;
      frac = skillCost > 0 ? Math.max(0, Math.min(1, (game.score || 0) / skillCost)) : 0;
      barCol = cfg.INSUFFICIENT_BORDER;
    }
    c.fillStyle = labelCol;
    c.font = 'bold 26px sans-serif';
    c.textAlign = 'left';
    c.fillText(label, PAD, cfg.ROW2_Y);
    const bx = PAD, by = cfg.ROW2_BAR_Y, bw = W - PAD * 2, bh = cfg.ROW2_BAR_H;
    c.fillStyle = cfg.COOLDOWN_BG;
    roundRect(c, bx, by, bw, bh, 10); c.fill();
    if (frac > 0) { c.fillStyle = barCol; roundRect(c, bx, by, bw * frac, bh, 10); c.fill(); }

    // ===== 第三行：攻击力 / 弹道 =====
    const p = game.player || {};
    const shots = (p.shotCount > 1) ? (p.shotCount + ' 发/枪') : '单发';
    c.fillStyle = '#9fe8ff';
    c.font = '28px sans-serif';
    c.textAlign = 'left';
    c.fillText('攻击力 ' + (p.atk != null ? p.atk : '-'), PAD, cfg.ROW3_Y);
    c.textAlign = 'right';
    c.fillText('弹道 ' + shots, W - PAD, cfg.ROW3_Y);

    // ===== 第四行：射速 / 击杀充能（充能 = 连杀计数，与边框方块同源）=====
    c.textAlign = 'left';
    c.fillText('射速 ' + (p.fireRate != null ? p.fireRate : '-') + ' 发/秒', PAD, cfg.ROW4_Y);
    c.textAlign = 'right';
    c.font = 'bold 28px sans-serif';
    c.fillStyle = s.boost ? (S.BOOST_COLOR || '#ffd24a') : '#ffffff';
    c.fillText((cfg.CHARGE_LABEL || '充能') + ' ' + this._streakFill + '/' + this._streakNeed, W - PAD, cfg.ROW4_Y);
    if (s.boost) {
      c.fillStyle = S.BOOST_COLOR || '#ffd24a';
      c.font = 'bold 26px sans-serif';
      c.fillText((S.BOOST_LABEL || '加速') + ' ' + (s.boostLeft || 0).toFixed(1) + 's', W - PAD, cfg.ROW5_BOOST_Y);
    }

    // 调试：显示当前相对右手柄的本地坐标（调位时把这三个值抄进 SKILL_HINT.POSITION 即可）
    if (cfg.DEBUG) {
      c.fillStyle = '#ffd43b';
      c.font = 'bold 18px sans-serif';
      c.textAlign = 'left';
      c.fillText('调试 x:' + this.mesh.position.x.toFixed(3) + ' y:' + this.mesh.position.y.toFixed(3) + ' z:' + this.mesh.position.z.toFixed(3), PAD, 176);
    }

    this._drawStreak(c, s);
    this.tex.needsUpdate = true;
  }

  //   · 杀一个亮一个（子弹击杀，见 game._bulletKill）；加速期间新攒的点改用金色；
  //   · 集齐（= 触发加速）那一瞬整圈闪一下（放大 + 变白）；
  //   · 方块贴着边框线画 → 不占正文区，不挡准星（正文四行的 PAD_X 已避开方块）。
  _drawStreak(c, s) {
    const S = SKILL_HINT.STREAK || {};
    if (S.ENABLED === false) return;
    const need = this._streakNeed;
    const fill = this._streakFill;
    const flashing = !!s.flashing;
    const size = S.SIZE > 0 ? S.SIZE : 26;
    const shown = flashing ? need : fill;
    const col = flashing ? (S.FLASH_COLOR || '#ffffff')
      : (s.boost ? (S.BOOST_COLOR || '#ffd24a') : (S.COLOR || '#ff2f2b'));
    const side = size * (flashing ? 1.25 : 1);
    for (let i = 0; i < this._streakDots.length; i++) {
      const p = this._streakDots[i];
      if (i < shown) {
        c.fillStyle = col;
        c.fillRect(p.x - side * 0.5, p.y - side * 0.5, side, side);
      } else {
        c.fillStyle = S.EMPTY_COLOR || 'rgba(255,255,255,0.16)';   // 空槽画小一号，弱化但不消失（便于数数）
        const e = side * 0.68;
        c.fillRect(p.x - e * 0.5, p.y - e * 0.5, e, e);
      }
    }
    // 第五十九修：右下角「杀敌 N/M / 加速 N.Ns」已搬到正文第 4 行（击杀充能）——
    //   这里只画边框方块，避免同一信息画两遍、并与第 4 行 / 加速行重叠。
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
