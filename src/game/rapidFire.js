import { RAPID_FIRE } from '../core/constants.js';

// ============================================================
// 连杀推进规则（第四十三修）—— 纯函数，单独成文件是为了能脱离 Game 做单测
//
// 为什么要把「加速期间」单独算：原实现里连杀计数在加速期间照常累加，
//   于是「一边加速一边继续杀」可以无限续杯（越杀越快、永不停）。
//   现在加速期间**封顶** BOOST_CARRY_MAX（默认 5）—— 加速里最多再给你攒一半，
//   剩下的必须等加速结束后重新连杀。
// ============================================================

/**
 * 推进一次连杀（子弹击杀时调用）。
 * @param {number}  prev     当前连杀数
 * @param {boolean} boosting 是否处于加速期（this._gameTime < this._rapidUntil）
 * @param {object}  cfg      RAPID_FIRE 配置
 * @returns {{next:number, triggered:boolean}} triggered=true 表示本次达成，且 next 已清零
 */
export function advanceStreak(prev, boosting, cfg = RAPID_FIRE) {
  const need = Math.max(1, cfg.KILLS | 0);
  const p = Math.max(0, prev | 0);
  if (boosting) {
    // 上限 = min(BOOST_CARRY_MAX, need-1)：need-1 保证加速期永远攒不满（不会二次触发）
    const raw = Number(cfg.BOOST_CARRY_MAX);
    const cap = Math.min(need - 1, Number.isFinite(raw) ? Math.max(0, raw | 0) : Math.floor(need / 2));
    if (p >= cap) return { next: p, triggered: false };
    return { next: p + 1, triggered: false };
  }
  const next = p + 1;
  if (next >= need) return { next: 0, triggered: true };
  return { next, triggered: false };
}