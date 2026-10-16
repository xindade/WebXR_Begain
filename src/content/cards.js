// 抽卡卡牌配置（对齐 iMA 笔记「选项卡调整」）
// 属性类（加法叠加 + 封顶）：射速 / 子弹 / 攻击 / 技能消耗 / 技能伤害 / 自我修复
// 技能类（红色）：如来神掌 / 激光剑 / 散射强化（仅第3关机制关固定三张）
//
// 卡面统一用 canvas 程序化「简笔画」图标（见 cardDraft.drawSketchIcon）+ 文字，不再依赖 PNG。

// 属性卡：icon 字段标识卡面简笔画图案；color 用于边框/图标色，rarity 仅作配色不做数值（加法叠加 + 封顶）。
export const ATTR_TYPES = [
  {
    id: 'fireRate', label: '射速+2', desc: '射速+2/秒（上限20）',
    color: '#2e86de', icon: 'fireRate',
    // 落到真实节流源（input.setFireRate）：选卡后射速真正提升。
    // 上限只写在 ATTRIBUTE_STATS 一处（第五十四修：14 → 20），卡面文案也必须跟着改（单测会锁）。
    apply: (p) => {
      p.fireRate = Math.min(ATTRIBUTE_STATS.fireRate[2], (p.fireRate || 2) + 2);
      p.input?.setFireRate(p.fireRate);
    },
  },
  {
    id: 'multiShot', label: '额外子弹+1', desc: '每发+1子弹（上限12）',
    color: '#27ae60', icon: 'multiShot',
    // 上限见 ATTRIBUTE_STATS.multiShot（第五十四修：7 → 12）。
    // 扇形半角随弹道数增长，所以「加弹道」是既加伤害又慢慢铺开扇形，见 player.fire。
    apply: (p) => { p.shotCount = Math.min(ATTRIBUTE_STATS.multiShot[2], (p.shotCount || 1) + 1); },
  },
  {
    id: 'atk', label: '攻击力+100', desc: '攻击力+100（上限700）',
    color: '#e67e22', icon: 'atk',
    // 死亡补偿可超过成长上限；强化绝不扣除已获得的攻击。
    apply: (p) => { p.atk = Math.max(p.atk || 100, Math.min(700, (p.atk || 100) + 100)); },
  },
  {
    id: 'skillCost', label: '技能消耗-100', desc: '技能消耗-100（下限100）',
    color: '#8e44ad', icon: 'skillCost',
    apply: (p) => { p.skillCost = Math.max(100, (p.skillCost || 500) - 100); },
  },
  {
    id: 'skillDamage', label: '技能伤害+1倍', desc: '技能伤害×(+1)（上限×5）',
    color: '#c0392b', icon: 'skillDamage',
    apply: (p) => { p.skillDamageMul = Math.min(5, (p.skillDamageMul || 1) + 1); },
  },
  {
    id: 'selfRepair', label: '自我修复+2%/s', desc: '每秒回血+2%（上限10%）',
    color: '#16a085', icon: 'selfRepair',
    apply: (p) => { p.regen = Math.min(10, (p.regen || 0) + 2); },
  },
];

// 成长上限的**唯一口径**（第五十四修起，ATTR_TYPES 里的 apply 也读这里，避免「卡面写一套、代码封一套」）。
// 格式：[player 字段, 每次步进, 上限/下限, 基线]；卡面 desc 里写的数字必须与 limit 一致（tests/bullet-volume.test.mjs 会锁）。
export const ATTRIBUTE_STATS = {
  fireRate: ['fireRate', 2, 20, 2], multiShot: ['shotCount', 1, 12, 1], atk: ['atk', 100, 700, 100],
  skillCost: ['skillCost', -100, 100, 500], skillDamage: ['skillDamageMul', 1, 5, 1],
  selfRepair: ['regen', 2, 10, 0],
};
export function attributePreview(card, player) {
  const stats = ATTRIBUTE_STATS[card.id];
  if (!stats) return card.desc;
  const [key, step, limit, base] = stats;
  const before = player[key] ?? base;
  const after = step > 0 ? Math.max(before, Math.min(limit, before + step)) : Math.min(before, Math.max(limit, before + step));
  return `${before} → ${after}`;
}
/**
 * 本关可用的属性卡池（纯函数，便于单测）。
 * 第六十修：**前两关不再出现技能相关的选项卡**（技能消耗-100 / 技能伤害+1倍）——
 *   此时玩家还没拿到任何技能（第 3 关商店关才卖技能本体），抽到「技能消耗-100」等于空卡，
 *   只会把三选一浪费掉。池子因此收成三张必有用卡，并置 strictPool 关掉下面的「补位」兜底
 *   （否则玩家把这三张吃满后，补位又会把技能卡捡回来）。
 * @param {number} n 关卡号
 * @returns {{ pool: string[], strictPool: boolean }}
 */
export const EARLY_NO_SKILL_CARD_LEVELS = 2;   // 1~2 关：不出技能相关卡
export const ATTR_POOL_BASE = ['fireRate', 'multiShot', 'atk'];
export const ATTR_POOL_SKILL = ['skillCost', 'skillDamage'];   // 技能相关卡（前两关排除）
export function attrPoolForLevel(n) {
  if (Number(n) <= EARLY_NO_SKILL_CARD_LEVELS) {
    return { pool: [...ATTR_POOL_BASE], strictPool: true };
  }
  return { pool: [...ATTR_POOL_BASE, ...ATTR_POOL_SKILL], strictPool: false };
}

/**
 * 玩家当前可成长的属性卡。
 * @param {object} player  玩家（读 fireRate/shotCount/atk/...）
 * @param {string[]} [ids] 只允许这些 id（缺省 = 全表）
 * @param {boolean} [strict] true = 不足 3 张也不从全表补位（前两关用，见 attrPoolForLevel）
 */
export function availableAttributes(player, ids = ATTR_TYPES.map(c => c.id), strict = false) {
  const useful = card => {
    const [key, step, limit, base] = ATTRIBUTE_STATS[card.id];
    return step > 0 ? (player[key] ?? base) < limit : (player[key] ?? base) > limit;
  };
  const pool = ATTR_TYPES.filter(card => ids.includes(card.id) && useful(card));
  // 主池不足时补充仍可成长的生存属性；完全满级时提供明确的补给奖励。
  // 第六十修：strict（前两关）时不做全表补位 —— 否则满级后会把被排除的技能卡补回来
  if (!strict) for (const card of ATTR_TYPES) if (pool.length < 3 && useful(card) && !pool.includes(card)) pool.push(card);
  if (!pool.length) pool.push(RESUPPLY_CARD);
  return pool;
}

// 满级兜底卡：主池已无任何可用成长卡时使用（第五十五修：生命上限卡已移除，血上限固定 100）。
export const RESUPPLY_CARD = {
  id: 'resupply', label: '战场补给', desc: '回满生命，并获得3秒护盾', color: '#16a085', icon: 'hp',
  apply: p => { p.hp = p.maxHp; p.shieldTime = Math.max(p.shieldTime || 0, 3); },
};

// 技能卡（红色）：第3关固定三张（buddha/lightsaber/scatterburst）
export const SKILL_CARDS = [
  {
    id: 'buddha', label: '如来神掌', rarity: 'gold', color: '#ff3b3b', icon: 'buddha',
    desc: '全屏伤害200（×技能倍率）',
    apply: (p) => { p.buddhaUnlocked = true; p.buddhaTimer = 0; },
  },
  {
    id: 'lightsaber', label: '激光剑', rarity: 'gold', color: '#ff3b3b', icon: 'lightsaber',
    desc: '左手激光剑近战，伤害700（×倍率），持续5秒',
    apply: () => { /* 伤害由 game._castLaserSword 执行（需场景上下文）*/ },
  },
  {
    id: 'scatterburst', label: '散射强化', rarity: 'gold', color: '#ff3b3b', icon: 'scatterburst',
    desc: '一次性100发×100伤害（×倍率）',
    apply: () => { /* 伤害由 game._castScatterBurst 执行 */ },
  },
];
