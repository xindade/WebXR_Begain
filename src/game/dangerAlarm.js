// 第六十一修 · 内圈报警（纯规则模块）：小怪逼近场地时「滴滴」提醒玩家赶紧清理。
//
// 现场口径（要防「到处都是滴滴滴，分不清又烦」）：
//   · 候选 = **已进内圈**的基础小怪 —— 与 balloons.bombMarkColor 同一判据（水平距场地圆心 ≤ INNER_RADIUS），
//     即「看得见闪红 ⇔ 听得到滴滴」；列表由调用方筛好传进来（本模块不认识气球对象）；
//   · 按**玩家前向**把四周划成 前 / 右 / 后 / 左 四个扇区，每个扇区只让**最靠近玩家**的那一只发声；
//   · 全场共用 INTERVAL 秒一个节拍，**同拍只响一声**；节拍之间按「最久没响过的方向」轮转
//     → 四个方向轮流提示，既不叠成一片、也不漏掉某个方向；
//   · 越近音高越高（PITCH_NEAR），并按扇区做左右声像（SECTOR_PAN × PAN）。
//
// 纯计算模块：不 import THREE、不碰 DOM，便于单测。

const R2D = 180 / Math.PI;

/** 扇区编号：0 前 / 1 右 / 2 后 / 3 左（与 DANGER_ALARM.SECTOR_PAN 的键一一对应）。 */
export const SECTOR_NAMES = ['front', 'right', 'back', 'left'];

/**
 * 目标相对「玩家前向」落在哪个扇区（纯函数）。
 *   · 前向 = 玩家面朝方向在 XZ 平面的投影（调用方已把相机的 +Z 取反，传**真实朝向**）；
 *   · 前方扇区宽 ±wedgeDeg，剩余的 360 − 2×wedgeDeg 平摊给 右 / 后 / 左；
 *   · 返回 -1 = 退化输入（目标与玩家重合 / 前向为零向量），调用方应跳过。
 *
 * 手性校验（右手系、Y 轴向上）——先算夹角再取反：
 *   相对前向 f = (fx, fz) 的有符号夹角 = atan2(dx·fz − dz·fx, dx·fx + dz·fz)，
 *   它**顺时针为正**（对前向而言 = 转向玩家左手边），故取反后：0° 前、+90° 玩家右手边。
 *   例：面朝 -Z（f = (0,-1)）——
 *     怪在 (−1, 0) = 玩家左手 → 270° → 左扇区；怪在 (1, 0) = 右手 → 90° → 右扇区。
 */
export function sectorOf(dx, dz, fx, fz, wedgeDeg = 45) {
  const fd = Math.hypot(fx, fz);
  const dd = Math.hypot(dx, dz);
  if (!(fd > 1e-6) || !(dd > 1e-6)) return -1;
  const cross = dx * fz - dz * fx;
  const dot = dx * fx + dz * fz;
  let deg = -(Math.atan2(cross, dot) * R2D);
  deg = ((deg % 360) + 360) % 360;
  const w = Math.max(1, Math.min(179, wedgeDeg));
  const span = (360 - 2 * w) / 3;
  if (deg <= w || deg >= 360 - w) return 0;
  if (deg <= w + span) return 1;
  if (deg <= w + 2 * span) return 2;
  return 3;
}

/**
 * 内圈报警调度器（状态很少，直接挂在 game 上）：
 *   · _t        距上一次发声累计的秒数（到 INTERVAL 才允许响）
 *   · _last[s]  各扇区**上一次发声的时刻**（游戏时间）—— 轮转就靠它挑「最久没响过」的方向
 */
export class DangerAlarm {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.reset();
  }

  reset() {
    this._t = 0;
    this._beats = 0;
    this._last = [-Infinity, -Infinity, -Infinity, -Infinity];
  }

  /**
   * 每帧调用一次。
   * @param {number} dt   帧间隔（秒）
   * @param {{x,z,fx,fz,inner?}|null} player 玩家水平位置 + 面朝方向（XZ 投影）+ 危险圈半径 inner（缺省回落 cfg.INNER_RADIUS/9）
   * @param {Array<{x,z}>} list 候选怪位置（调用方已按「已进内圈」筛好）
   * @param {number} now  游戏时间（秒），用于扇区轮转记账
   * @returns {null|{sector,name,index,dist,freq,gain,pan,count}} null = 这一帧不该响
   */
  update(dt, player, list, now) {
    const cfg = this.cfg || {};
    if (cfg.ENABLED === false) return null;
    this._t += dt;
    const interval = cfg.INTERVAL > 0 ? cfg.INTERVAL : 2;
    if (this._t < interval) return null;
    if (!player || !list || !list.length) return null;

    // ① 每个扇区只留**最靠近玩家**的那一只（同区多只不叠成一片）
    const best = [-1, -1, -1, -1];
    const bestD = [Infinity, Infinity, Infinity, Infinity];
    const wedge = cfg.WEDGE_DEG > 0 ? cfg.WEDGE_DEG : 45;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t) continue;
      const dx = t.x - player.x, dz = t.z - player.z;
      const s = sectorOf(dx, dz, player.fx, player.fz, wedge);
      if (s < 0) continue;
      const d = Math.hypot(dx, dz);
      if (d < bestD[s]) { bestD[s] = d; best[s] = i; }
    }

    // ② 轮转：本拍从「有候选」的扇区里挑**最久没响过**的那个（同拍只响一声）
    let pick = -1, oldest = Infinity;
    for (let s = 0; s < 4; s++) {
      if (best[s] < 0) continue;
      if (this._last[s] < oldest) { oldest = this._last[s]; pick = s; }
    }
    if (pick < 0) return null;

    this._t = 0;
    this._beats++;
    this._last[pick] = Number.isFinite(now) ? now : this._beats;

    const dist = bestD[pick];
    // 危险圈半径：优先用调用方给的（= BOMB_LABEL.INNER_RADIUS，与头顶「爆」字闪红同源），避免两处常量各写一份
    const inner = player.inner > 0 ? player.inner : (cfg.INNER_RADIUS > 0 ? cfg.INNER_RADIUS : 9);
    const near = Math.max(0, Math.min(1, 1 - dist / inner));      // 0 = 刚进内圈，1 = 贴脸
    const panCfg = cfg.SECTOR_PAN || {};
    const pan0 = panCfg[SECTOR_NAMES[pick]];
    return {
      sector: pick,
      name: SECTOR_NAMES[pick],
      index: best[pick],
      dist,
      freq: (cfg.FREQ > 0 ? cfg.FREQ : 1180) + (cfg.PITCH_NEAR || 0) * near,
      gain: cfg.GAIN != null ? cfg.GAIN : 0.16,
      pan: (Number.isFinite(pan0) ? pan0 : 0) * (Number.isFinite(cfg.PAN) ? cfg.PAN : 1),
      count: this._beats,
    };
  }
}