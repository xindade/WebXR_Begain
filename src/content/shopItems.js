// 商店关（第五十五修）—— 可购买项定义 + 纯函数（抽道具 / 价格 / 数值换算）
//
// 三类可购买项：
//   ① 技能本体（第3关正前方三个气球，各 SHOP.SKILL_PRICE）—— 玩家还没有三选一技能时出现；
//   ② 技能强化（技能威力+ / 技能消耗- / 技能冷却-，各 SHOP.UPGRADE_PRICE）——
//      玩家一旦拥有三选一技能，正前方就换成这三张；**每次进店每项限购 1 个**；
//   ③ 道具（左手边三个气球，6 选 3 不重复）—— 可重复购买升级，费用 = ITEM_BASE_PRICE × 目标等级。
//
// 数值口径全部落在 constants.SHOP（userConfig.SHOP 可覆盖），卡面文案与效果同源，避免「写一套跑一套」。

import { SHOP } from '../core/constants.js';

// —— 道具表（顺序即抽签池）——
// desc 只写「是什么」，卡面由 shop.js 再拼上「Lv.旧→新 ｜ 价格」。
export const SHOP_ITEMS = [
  {
    id: 'dogOwner', label: '打狗还要看主人', icon: 'dogOwner', color: '#b197fc',
    desc: '击杀时向精英射追踪弹',
  },
  {
    id: 'warFeed', label: '以战养战', icon: 'warFeed', color: '#f6b93b',
    desc: '击杀额外得商店币',
  },
  {
    id: 'candyString', label: '串糖葫芦', icon: 'candyString', color: '#e17055',
    desc: '每10发追加穿甲弹',
  },
  {
    id: 'moreIsBetter', label: '多才是王道', icon: 'moreIsBetter', color: '#4dabf7',
    desc: '临时多2条弹道',
  },
  {
    id: 'lifesteal', label: '吸血子弹', icon: 'lifesteal', color: '#e84393',
    desc: '击杀概率回血',
  },
  {
    id: 'strongHunter', label: '专打强者', icon: 'strongHunter', color: '#d63031',
    desc: '对精英/Boss加伤',
  },
];

// —— 技能强化表（正前方三张，每次进店每项限购 1 个）——
export const SKILL_UPGRADES = [
  {
    id: 'skillDamageUp', label: '技能威力+', icon: 'skillDamage', color: '#c0392b',
    desc: '技能伤害×(+1)',
  },
  {
    id: 'skillCostDown', label: '技能消耗-', icon: 'skillCost', color: '#8e44ad',
    desc: '技能消耗-100',
  },
  {
    id: 'skillCdDown', label: '技能冷却-', icon: 'skillCdDown', color: '#2e86de',
    desc: `技能冷却-${SHOP.CD_DOWN}s`,
  },
];

/** 道具升到「下一级」的价格：ITEM_BASE_PRICE × 目标等级（1 级 = 1000） */
export function shopItemPrice(id, levels) {
  const cur = (levels && levels[id]) || 0;
  return SHOP.ITEM_BASE_PRICE * (cur + 1);
}

/** 以战养战：击杀商店币倍率（1 级 +10% → 1.1） */
export function warFeedMul(level) {
  return 1 + (SHOP.WARFEED_PER_LEVEL / 100) * (level || 0);
}

/** 吸血子弹：每次子弹击杀的回血概率（10% → 0.1） */
export function lifestealChance(level) {
  return (SHOP.LIFESTEAL_PER_LEVEL / 100) * (level || 0);
}

/** 专打强者：对精英/Boss 的最终伤害倍率（1.2 → 1.4 → 1.6） */
export function strongHunterMul(level) {
  return 1 + SHOP.STRONG_PER_LEVEL * (level || 0);
}

/** 多才是王道：第 level 级的冷却秒数（每级 -1，下限 = 持续时间 ⇒ 可不间断） */
export function mibCooldown(level) {
  const cd = SHOP.MIB_COOLDOWN - Math.max(0, (level || 1) - 1);
  return Math.max(SHOP.MIB_DURATION, cd);
}

/** 6 选 count 不重复（洗牌取前 count 个）；rand 可注入便于单测 */
export function pickShopItems(count = 3, rand = Math.random) {
  const pool = SHOP_ITEMS.map((i) => i.id);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}

/** 补位：从「不在 exclude 里」的道具中随机取一个（买走一个就补一个同类） */
export function pickShopItemExcluding(exclude, rand = Math.random) {
  const pool = SHOP_ITEMS.map((i) => i.id).filter((id) => !(exclude || []).includes(id));
  if (!pool.length) return null;
  return pool[Math.floor(rand() * pool.length)];
}