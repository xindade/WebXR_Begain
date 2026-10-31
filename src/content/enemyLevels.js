// ============================================================
// 敌人等级 / 血量（第八十一~八十二修 · 现场口径）
//
// 等级：
//   基础怪 = 关卡数
//   精英   = 关卡数 + 首次出场偏移（铁甲 +1 / 盾甲 +2 / 治疗 +3 / 忍者 +4 / 幽灵 +5 / 章鱼 +6）
//
// 本体血量 = 基础血量 + 每级成长 × LV
//
// 普通精英：
//   忍者 / 幽灵 / 章鱼 = (本体 + 进入本关时的玩家 DPS × 1) × 1.3
//   其它精英           = 本体（不按 DPS 缩放）
//
// 末尾精英（关卡收尾那一批，第八十二修）：
//   每只最终血量 = 该只本体 × 1.5 + 进入本关时的玩家 DPS × 6 ÷ 本批只数
//
// ⚠ Boss 本体 / Boss 召唤物不套本表：
//   · 脸谱 / 龙 / 魔术师走各自 Boss 规则；
//   · 魔术师召唤池仍用 eliteMonsters.RANGED_DPS_HP 的 Boss 口径；
//   · 龙召唤、脸谱蓝阵等基础怪保持原生血量。
// ============================================================

export const LEVEL_HP = {
  basic:       { base: 100,  growth: 50,  offset: 0 },
  eliteKnight: { base: 1000, growth: 100, offset: 1 },
  shield:      { base: 1000, growth: 150, offset: 2 },
  heart:       { base: 3000, growth: 200, offset: 3 },
  ninja:       { base: 2000, growth: 200, offset: 4 },
  ghost:       { base: 3000, growth: 250, offset: 5 },
  octopus:     { base: 6000, growth: 300, offset: 6 },
};

// 普通关按「进入本关时的 DPS」加成的远程三兄弟。
export const RANGED_LEVEL_TYPES = ['ninja', 'ghost', 'octopus'];

// 第八十二修：远程三兄弟的普通精英总血量再 ×1.3。
export const RANGED_NORMAL_HP_MUL = 1.3;

// 末尾批：整批本体最多打 6 秒；每只额外再加 5 秒 DPS。
export const CLIMAX_BODY_SECONDS = 6;
export const CLIMAX_BONUS_SECONDS = 5;

/** 某敌种是否吃等级血量表（Boss / 龙身 / 机制球不在表内）。 */
export function hasLevelHp(type) {
  return !!LEVEL_HP[type];
}

/** 等级：基础怪 = 关卡数；精英 = 关卡数 + 首次出场偏移。 */
export function levelFor(type, stage) {
  const cfg = LEVEL_HP[type];
  if (!cfg) return 0;
  const n = Number(stage);
  return Math.max(1, (Number.isFinite(n) ? n : 0) + cfg.offset);
}

/** 本体血量 = 基础血量 + 每级成长 × LV；不认识的敌种返回 null。 */
export function bodyHp(type, stage) {
  const cfg = LEVEL_HP[type];
  if (!cfg) return null;
  return Math.max(1, Math.round(cfg.base + cfg.growth * levelFor(type, stage)));
}

/**
 * 普通精英血量。
 * 忍者 / 幽灵 / 章鱼额外吃「进入本关时的 DPS × 1」，再整体 ×1.3；
 * 其余只吃本体。
 * @param {string} type
 * @param {number} stage 当前关卡号
 * @param {number} stageDps 进入本关时快照的 DPS
 */
export function normalEliteHp(type, stage, stageDps = 0) {
  const body = bodyHp(type, stage);
  if (body == null) return null;
  const dps = Number(stageDps);
  const ranged = RANGED_LEVEL_TYPES.includes(type);
  const bonus = ranged && Number.isFinite(dps) && dps > 0 ? dps : 0;
  const total = body + bonus;
  return Math.max(1, Math.round(ranged ? total * RANGED_NORMAL_HP_MUL : total));
}

/**
 * 本批末尾精英的本体血量之和（用于按比例分摊）。
 * @param {Array<{type:string, count?:number}>} combos
 * @param {number} stage
 */
export function climaxBodyTotal(combos, stage) {
  return (combos || []).reduce((sum, c) => {
    const hp = bodyHp(c.type, stage);
    return sum + (hp == null ? 0 : hp) * (c.count || 0);
  }, 0);
}

/**
 * 普通关基础怪的构造参数：只给 basic 补等级血量。
 * Boss 关（Boss 召唤）原样返回 —— 召唤物不套等级血量。
 * @param {string} type
 * @param {number} stage
 * @param {object|null} opts 调用方原有的 balloon 参数
 * @param {boolean} bossLevel 是否 Boss 关
 */
export function stageSpawnOpts(type, stage, opts = null, bossLevel = false) {
  if (bossLevel || type !== 'basic') return opts || null;
  if (opts && opts.hp != null) return opts;
  const n = Number(stage);
  if (!Number.isFinite(n) || n <= 0) return opts || null;
  return Object.assign({}, opts || {}, {
    hp: bodyHp('basic', n),
    level: levelFor('basic', n),
  });
}
