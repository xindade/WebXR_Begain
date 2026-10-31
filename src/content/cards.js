// 抽卡卡牌配置（对齐 iMA 笔记「选项卡调整」）
// 属性类（加法叠加 + 封顶）：射速 / 子弹 / 攻击 / 技能消耗 / 技能伤害 / 自我修复
// 技能类（红色）：如来神掌 / 激光剑 / 黑洞（第3关商店关出售；第六十七修把散射强化换成了黑洞）
//
// 卡面统一用 canvas 程序化「简笔画」图标（见 cardDraft.drawSketchIcon）+ 文字，不再依赖 PNG。

// 属性卡：icon 字段标识卡面简笔画图案；color 用于边框/图标色，rarity 仅作配色不做数值（加法叠加 + 封顶）。
export const ATTR_TYPES = [
  {
    id: 'fireRate', label: '射速+50%', desc: '射速+50%（上限20）',
    color: '#2e86de', icon: 'fireRate',
    // 按角色基线成长：疾风 4→6→8；蜂群 2→3→4；爆炮手 0.8→1.2→1.6。
    // 旧版固定 +2 会把爆炮手的 0.8 直接跳到 2.8，现场口径「计算不对」。
    apply: (p) => {
      p.fireRate = nextFireRate(p);
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
    // 瘟疫医生的攻击成长减半：卡面仍写 +100，但实际只增加 50。
    // 死亡补偿可超过成长上限；强化绝不扣除已获得的攻击。
    apply: (p) => {
      p.atk = Math.max(p.atk || 100, Math.min(700, (p.atk || 100) + attackCardStep(p)));
    },
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
  {
    // 第八十九修 · 爆炮手专属：替换「额外子弹+1」。
    //   每一级让每次爆炸额外再触发 1 次爆炸（同点，0.5 倍伤害/0.85 倍半径），最多 3 级。
    //   放在表尾：全表补位时优先捡通用生存卡，不会把专属卡漏给其它角色。
    id: 'multiBlast', label: '多重爆炸', desc: '子弹爆炸额外触发1次爆炸（上限3）',
    color: '#ff6b2c', icon: 'blastPlus',
    apply: (p) => {
      const limit = ATTRIBUTE_STATS.multiBlast[2];
      p.multiBlast = Math.min(limit, (p.multiBlast || 0) + 1);
    },
  },
];

// 成长上限的**唯一口径**（第五十四修起，ATTR_TYPES 里的 apply 也读这里，避免「卡面写一套、代码封一套」）。
// 格式：[player 字段, 每次步进, 上限/下限, 基线]；fireRate 例外：步进 = 角色基线的 50%，
// 由 nextFireRate 按 player.baseFireRate 计算。卡面 desc 里写的上限必须与 limit 一致（单测会锁）。
export const ATTRIBUTE_STATS = {
  fireRate: ['fireRate', 2, 20, 2], multiShot: ['shotCount', 1, 12, 1], atk: ['atk', 100, 700, 100],
  multiBlast: ['multiBlast', 1, 3, 0],
  skillCost: ['skillCost', -100, 100, 500], skillDamage: ['skillDamageMul', 1, 5, 1],
  selfRepair: ['regen', 2, 10, 0],
};

export function nextFireRate(player) {
  const limit = ATTRIBUTE_STATS.fireRate[2];
  const base = Number(player.baseFireRate) || Number(player.fireRate) || ATTRIBUTE_STATS.fireRate[3] || 2;
  const before = Number(player.fireRate) || base;
  return Math.min(limit, Math.round((before + base * 0.5) * 100) / 100);
}

/** 攻击力选项卡的实际增量（瘟疫医生为 +50；其它角色仍为 +100）。 */
export function attackCardStep(player) {
  const base = ATTRIBUTE_STATS.atk[1];
  const mul = Number(player?.atkGainMul) > 0 ? Number(player.atkGainMul) : 1;
  return Math.max(1, Math.round(base * mul));
}

/** 连续推进 n 档射速（每档 = 角色基线的 50%），并把结果推给真实节流源。 */
export function applyFireRateSteps(player, steps = 1) {
  const n = Math.max(0, Math.floor(Number(steps) || 0));
  for (let i = 0; i < n; i++) player.fireRate = nextFireRate(player);
  player.input?.setFireRate?.(player.fireRate);
  return player.fireRate;
}

export function attributePreview(card, player) {
  if (card.id === 'fireRate') {
    const before = Number(player.fireRate) || Number(player.baseFireRate) || 2;
    return `${before} → ${nextFireRate(player)}`;
  }
  const stats = ATTRIBUTE_STATS[card.id];
  if (!stats) return card.desc;
  const [key, step, limit, base] = stats;
  const effectiveStep = card.id === 'atk' ? attackCardStep(player) : step;
  const before = player[key] ?? base;
  const after = effectiveStep > 0
    ? Math.max(before, Math.min(limit, before + effectiveStep))
    : Math.min(before, Math.max(limit, before + effectiveStep));
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
export function availableAttributes(player, ids = ATTR_TYPES.map(c => c.id), strict = false, banned = null) {
  const bannedSet = banned && banned.length ? new Set(banned) : null;
  const allowed = (card) => ids.includes(card.id) && (!bannedSet || !bannedSet.has(card.id));
  const useful = card => {
    const [key, step, limit, base] = ATTRIBUTE_STATS[card.id];
    return step > 0 ? (player[key] ?? base) < limit : (player[key] ?? base) > limit;
  };
  const pool = ATTR_TYPES.filter(card => allowed(card) && useful(card));
  // 主池不足时补充仍可成长的生存属性；完全满级时提供明确的补给奖励。
  // 第六十修：strict（前两关）时不做全表补位 —— 否则满级后会把被排除的技能卡补回来
  // 第八十九修：补位沿用旧口径（可从全表捡），但必须尊重角色禁用卡。
  if (!strict) for (const card of ATTR_TYPES) if (pool.length < 3 && (!bannedSet || !bannedSet.has(card.id)) && useful(card) && !pool.includes(card)) pool.push(card);
  if (!pool.length) pool.push(RESUPPLY_CARD);
  return pool;
}

/**
 * 角色专属属性池：爆炮手把「额外子弹+1」换成「多重爆炸」。
 * 不修改传入数组；其它角色原样返回。
 */
export function roleAttrPool(ids, role) {
  if (role !== 'bombard' || !Array.isArray(ids)) return ids;
  return ids.map((id) => (id === 'multiShot' ? 'multiBlast' : id));
}

/** 角色禁用的属性卡：爆炮手不出「额外子弹+1」；其它角色不出专属的「多重爆炸」。 */
export function roleBannedCards(role) {
  return role === 'bombard' ? ['multiShot'] : ['multiBlast'];
}

// 满级兜底卡：主池已无任何可用成长卡时使用（第五十五修：生命上限卡已移除，血上限固定 100）。
export const RESUPPLY_CARD = {
  id: 'resupply', label: '战场补给', desc: '回满生命，并获得3秒护盾', color: '#16a085', icon: 'hp',
  apply: p => { p.hp = p.maxHp; p.shieldTime = Math.max(p.shieldTime || 0, 3); },
};

// 技能卡（红色）：第3关商店出售的三张（buddha/lightsaber/blackhole）
export const SKILL_CARDS = [
  {
    id: 'buddha', label: '如来神掌', rarity: 'gold', color: '#ff3b3b', icon: 'buddha',
    desc: '全屏350，收掌后5秒子弹化为掌风弹（伤害×1.5，穿透1）',
    apply: (p) => { p.buddhaUnlocked = true; p.buddhaTimer = 0; },
  },
  {
    id: 'lightsaber', label: '激光剑', rarity: 'gold', color: '#ff3b3b', icon: 'lightsaber',
    desc: '左手激光剑近战，伤害700（×倍率），持续5秒',
    apply: () => { /* 伤害由 game._castLaserSword 执行（需场景上下文）*/ },
  },
  {
    id: 'blackhole', label: '黑洞', rarity: 'gold', color: '#ff3b3b', icon: 'blackhole',
    desc: '面前15米生成漩涡，吸附全部非Boss敌人6秒，每秒20伤害',
    apply: () => { /* 吸附/伤害由 game._castBlackHole 执行（需场景上下文） */ },
  },
];
