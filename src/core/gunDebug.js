// 调试用「构筑拉满」参数（第五十四修）
//
// 为什么需要它：第五十四修把弹道上限放开到 12，但 12 条弹道要靠抽卡堆十几关才凑得出来 ——
//   现场根本没法验收「扇形铺开」这一项。于是给一个网址开关，**直接给开局属性**：
//     ?gun=12x20   12 条弹道 × 20 发每秒
//     ?gun=8       只改弹道（射速不动）
//     ?gun=x20     只改射速（弹道不动）
//   解析出来的值一律**夹到卡池上限**（ATTRIBUTE_STATS），不给超越合法构筑的数字。
//
// 生效点：main.js 的 startGame() 末尾 → 改 game.player.shotCount / fireRate + input.setFireRate。
// 与 ?gate=0 / ?vrbtn 同级：属于现场排障开关，正式包也认，但平台拉起时不会带它（不会影响正常局）。
// ⚠ userConfig.js 的 SHOOT 里没有对应项 —— 这是调试入口，不是可配参数。
import { ATTRIBUTE_STATS } from '../content/cards.js';

/**
 * 解析 `?gun=` 参数。
 * @param {string|null} raw 网址参数原文（如 '12x20' / '8' / 'x20'）
 * @returns {{shot: number|null, rate: number|null}|null} 夹到上限后的结果；无参数/全非法 → null
 */
export function parseGunDebug(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return null;
  let shotPart = null;
  let ratePart = null;
  if (s.includes('x') || s.includes('*')) {
    const parts = s.split(/[x*]/);
    shotPart = parts[0] || null;
    ratePart = parts[1] || null;
  } else {
    shotPart = s;
  }
  // 上限/下限都取卡池口径：合法构筑到不了的数字，调试也不该给
  const pick = (v, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };
  const shot = shotPart === null ? null : pick(shotPart, 1, ATTRIBUTE_STATS.multiShot[2]);
  const rate = ratePart === null ? null : pick(ratePart, 1, ATTRIBUTE_STATS.fireRate[2]);
  if (!shot && !rate) return null;
  return { shot, rate };
}