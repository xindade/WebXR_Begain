// shopCoinDisplay.js —— 第六十五修 · 枪上「商店币」小框的**显示值**推进（纯函数）
//
// 现场口径：「怪打死后要有金色光点飞到这里接着数字变动」——数字**不许瞬间跳**，
//   要等金点落到枪上那个小框，数字才跟着涨。
//
// 与真实值的关系（关键，别改错）：
//   · 真实值 game.shopCoin **即时入账**：商店扣款、切关、对账都读它，绝不能为了动画延后；
//   · 显示值 _shown 只是「玩家眼下看到的数」，允许落后真实值几帧（就是金点在飞的那段时间）；
//   · 一旦**没有在飞的金点**（inflight = 0）→ 立刻对齐真实值。
//     这条兜底覆盖所有「金点没了」的情形：池满被并进别的槽、切关 fx.clear()、菜单收起、
//     ORB.ENABLED=false（不飞金点，数字就该立刻变）…… 所以不会出现「数字永远追不上」的错账观感。
//
// 纯计算：不 import three、不碰 DOM ⇒ 可单测（tests/coin-orb.test.mjs）。

/**
 * 推进「显示值」。
 * @param {number} shown     上一帧的显示值
 * @param {number} total     真实商店币（即时入账，可能已经大于显示值）
 * @param {number} inflight  还在飞的金点数量（> 0 时显示值允许落后，等落地补齐）
 * @param {number} landed    本帧落地的金额（推显示值）
 * @returns {number} 本帧应该显示的整数
 */
export function advanceShown(shown, total, inflight, landed = 0) {
  const t = Math.max(0, Math.round(total || 0));
  let s = Math.max(0, Math.round(shown || 0)) + Math.max(0, Math.round(landed || 0));
  // 没有在飞的金点 → 直接对齐；显示值超过真实值（商店花了钱 / 一局清零）→ 也只能降到真实值
  if (!((inflight | 0) > 0) || s > t) s = t;
  return s;
}

/** 小框文案（「商店币 N」；与商店里那两块区域牌子同口径）。文字没变 → makeBadge.set 内部不重绘。 */
export function coinBadgeText(shown) {
  return '商店币 ' + Math.max(0, Math.round(shown || 0));
}
