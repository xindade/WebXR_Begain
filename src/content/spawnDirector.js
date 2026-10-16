// ============================================================
// 出怪编排表（第四十六修）—— 三层出怪 + 每关时间轴脚本
//
// 三层（LAYER）：
//   trash  杂鱼      —— 白色光点；DPS 基准内外圈滴流（SPAWN_RING），保证玩家永远有怪打
//   mini   无技能精英 —— 蓝色光点；**前期起手**、中后期放量（铁甲兵 / 盾甲兵）
//   skill  有技能精英 —— 紫红光点；**中期起手**、后期放量（幽灵法师 / 忍者队长 / 章鱼将军）
//   support 辅助目标  —— 治疗术士（heart）：只治不攻，跟无技能层同批出现，逼玩家做「先杀谁」的取舍
//
// 出现方式（via）：
//   portal → 传送门飞光点（现有行为：最近传送门 → 目标点）
//   merge  → 清场融合：场上全部**非精英**化为光点 + 不足则从最近传送门补足到 FUSE.COUNT 个
//            → 汇聚成一个大号**层色**光点 → 落地生成精英（waves._fuseSpawn 实现）
//   direct → 原地直接生成（不经光点；Boss/特殊用）
//
// 时间轴脚本 = 「关卡 → 事件表」，事件字段：
//   t           触发秒（绝对秒，从本关开始算）
//   every/until 循环触发：每 every 秒一次，到 until 秒为止（不写 every 则只触发一次）
//   do          'banner' | 'elite' | 'trashBurst' | 'clearTrash'
//   dir         'front' | 'frontLeft' | 'frontRight' → 出生方位 + 横幅文案（前方/左边/右边）
//   combos      [{ type, count }] 精英组成（血量走 ELITE_BASE_HP，见 eliteMonsters.js）
//   via         'portal' | 'merge' | 'direct'
//   capOnField  同屏该层上限（防堆；到达上限时本次跳过）
//   goldReturn  true = 全批击破后金色光点飞向选项卡位置并**打开抽卡**
//   link        'heal' → 与同批的心形怪连治疗线（表现）
//   label       覆盖名牌文字（不写则用 ELITE_DISPLAY_NAME[type]）
//
// 第五十修：按现场《关卡安排.log》把普通关**全部**铺开（1/2/4/5/7/8/10/11/13/14/16/17）；
//   机制关(3/9/15)与 Boss 关(6/12/18)不配脚本（waves 走 Boss / 机制分支）。
//   ⚠ 从此 ELITE_SCHEDULE 的三期脉冲**没有关卡在用了**（所有普通关都有脚本）——见 eliteMonsters.js 顶部的说明。
// ============================================================

// 层的基本信息：id / 光点颜色 / 中文名（日志与调试用）
export const LAYER = {
  trash:   { id: 'trash',   color: 0xffffff, name: '杂鱼' },
  mini:    { id: 'mini',    color: 0x4d9dff, name: '无技能精英' },
  skill:   { id: 'skill',   color: 0xc44dff, name: '有技能精英' },
  support: { id: 'support', color: 0x51cf66, name: '辅助目标' },
};

// 敌种 → 层（决定光点颜色与调度归属）
export const TYPE_LAYER = {
  basic: 'trash', summoner: 'trash', chest: 'trash', dragonhead: 'trash', treasure: 'trash',
  knight: 'mini', eliteKnight: 'mini', shield: 'mini',
  ghost: 'skill', ninja: 'skill', octopus: 'skill',
  heart: 'support',
};

// 精英名牌显示名（替换旧的「精英骑士 / 盾兵怪 / 心型怪 …」）
export const ELITE_DISPLAY_NAME = {
  eliteKnight: '铁甲兵',
  shield:      '盾甲兵',
  heart:       '治疗术士',
  ghost:       '幽灵法师',
  ninja:       '忍者队长',
  octopus:     '章鱼将军',
};

// 末尾精英（Boss 档）的名牌后缀（第四十九修）：
//   末尾批 = 脚本里带 goldReturn 的那一批（横幅 → 清场融合 → 金点 → 抽卡），
//   它是本关的收尾高潮 ⇒ 名字后统一加「 Boss」，与前面零星出现的普通精英区分开。
export const CLIMAX_SUFFIX = ' Boss';

/**
 * 名牌文字（第四十九修）。纯函数，便于单测。
 *   收「基础显示名」而不是敌种：调用方（balloons）本来就要在 ELITE_DISPLAY_NAME 查不到时
 *   退回 ENEMY_TYPES 的 t.name，本函数只负责「加不加后缀」这一件事。
 * @param {string} baseName 基础显示名（如「铁甲兵」）
 * @param {boolean} climax  是否末尾精英（Boss 档）
 * @returns {string} 普通精英 = 本名；末尾精英 = 本名 + CLIMAX_SUFFIX（「铁甲兵 Boss」）
 */
export function eliteLabelText(baseName, climax) {
  return climax ? String(baseName) + CLIMAX_SUFFIX : String(baseName);
}

// 方位 → 横幅文案（横幅本身固定在准星正前方，只用文案表达方位）
export const DIR_TEXT = { front: '前方', frontLeft: '左边', frontRight: '右边' };

// 清场融合参数（waves._fuseSpawn）
export const FUSE = {
  COUNT:    5,      // 汇聚光点数量：场上存活非精英不足此数 → 从最近传送门补足
  IN_DUR:   0.9,    // 各光点飞向汇聚点耗时 s
  OUT_DUR:  0.55,   // 汇聚后的「大光点」飞向出生点耗时 s
  OUT_MUL:  2.6,    // 大光点相对普通光点的尺寸倍率（视觉：融合成了更大的东西）
  ORB_SIZE: 0.22,   // 汇聚光点半径 m（普通出怪光点见 PORTAL_BEAM.SIZE）
};

// 本关时间轴脚本（第五十修：按现场《关卡安排.log》把普通关全部铺开）
//   时间口径以文件为准：横幅 31-32s → 清场融合 33s（7~11 关 36-37s → 38s；13/14/16/17 关 45-46s → 47s）。
//   收尾融合一定落在倒计时内：1/2/4/5 关 40s，7/8/10/11 关 50s，13/14/16/17 关 60s（constants.LEVEL_SECONDS）。
//   ⚠ 文件里只给第 5 关标了方位（左边）；其余关没写方位 → 统一走 front，需要「换方向」再单独加 dir。
export const SPAWN_SCRIPT = {
  // 01：前 30s 普通怪（密度 ×1.5，撑到连杀加速）→ 31-32s 横幅 → 33s 铁甲兵 Boss 清场融合
  1: {
    trashMul: 1.5,                     // 前 30s 杂鱼密度 ×1.5（撑到连杀加速）
    trashMulUntil: 30,
    events: [
      { t: 31.0, do: 'banner', text: '前方精英来袭', dir: 'front' },
      { t: 33.0, do: 'elite', combos: [{ type: 'eliteKnight', count: 1 }],
        dir: 'front', via: 'merge', goldReturn: true },
    ],
  },

  // 02：5s / 20s 各一只铁甲兵（蓝点从传送门直出，场上最多 1 只）→ 31-32s 横幅 → 33s 左边盾甲兵 Boss 融合
  2: {
    events: [
      { t: 5,  do: 'elite', combos: [{ type: 'eliteKnight', count: 1 }],
        dir: 'front', via: 'portal', capOnField: 1 },
      { t: 20, do: 'elite', combos: [{ type: 'eliteKnight', count: 1 }],
        dir: 'front', via: 'portal', capOnField: 1 },
      { t: 31.0, do: 'banner', text: '左边精英来袭', dir: 'frontLeft' },
      { t: 33.0, do: 'elite', combos: [{ type: 'shield', count: 1 }],
        dir: 'frontLeft', via: 'merge', goldReturn: true },
    ],
  },

  // 04：开局 8 只批量杂鱼 + 横幅提示用技能（横幅前锁技能）；15s 铁甲兵 ×2（直出）
  //     → 31-32s 横幅 → 33s 右边融合 2 铁甲兵 + 1 盾甲兵（盾兵在后）
  4: {
    skillLockUntil: 4.2,               // 进本关锁技能，横幅（0.4s 起 2s）结束后解锁
    events: [
      { t: 0.2, do: 'trashBurst', count: 8 },
      { t: 0.4, do: 'banner', text: '大量敌兵来袭，快使用技能' },
      { t: 15.0, do: 'elite', combos: [{ type: 'eliteKnight', count: 2 }],
        dir: 'front', via: 'portal' },
      { t: 31.0, do: 'banner', text: '右边精英来袭', dir: 'frontRight' },
      { t: 33.0, do: 'elite', combos: [{ type: 'eliteKnight', count: 2 }, { type: 'shield', count: 1 }],
        dir: 'frontRight', via: 'merge', goldReturn: true, tailType: 'shield' },
    ],
  },

  // 05：5/15/25s 每 10s 一只铁甲兵（场上最多 1 只）→ 31-32s 横幅
  //     → 33s 左边融合 治疗术士 ×1 + 铁甲兵 ×2（术士与铁甲兵之间有治疗线）
  5: {
    events: [
      { t: 5, every: 10, until: 25, do: 'elite', combos: [{ type: 'eliteKnight', count: 1 }],
        dir: 'front', via: 'portal', capOnField: 1 },
      { t: 31.0, do: 'banner', text: '左边精英来袭', dir: 'frontLeft' },
      { t: 33.0, do: 'elite', combos: [{ type: 'heart', count: 1 }, { type: 'eliteKnight', count: 2 }],
        dir: 'frontLeft', via: 'merge', goldReturn: true, link: 'heal' },
    ],
  },

  // 07：5s 铁甲兵 ×2 → 15s 铁甲兵 ×1 + 盾甲兵 ×1 → 25s 盾甲兵 ×1 + 铁甲兵 ×1
  //     → 36-37s 横幅 → 38s 治疗术士 ×1 + 铁甲兵 Boss ×2 + 盾甲兵 Boss ×1（融合）
  7: {
    events: [
      { t: 5,  do: 'elite', combos: [{ type: 'eliteKnight', count: 2 }], dir: 'front', via: 'portal' },
      { t: 15, do: 'elite', combos: [{ type: 'eliteKnight', count: 1 }, { type: 'shield', count: 1 }],
        dir: 'front', via: 'portal' },
      { t: 25, do: 'elite', combos: [{ type: 'shield', count: 1 }, { type: 'eliteKnight', count: 1 }],
        dir: 'front', via: 'portal' },
      { t: 36.0, do: 'banner', text: '前方精英来袭', dir: 'front' },
      { t: 38.0, do: 'elite',
        combos: [{ type: 'heart', count: 1 }, { type: 'eliteKnight', count: 2 }, { type: 'shield', count: 1 }],
        dir: 'front', via: 'merge', goldReturn: true, link: 'heal' },
    ],
  },

  // 08：5s 铁甲兵 ×2 → 15s 铁甲兵 ×2 + 盾甲兵 ×1 → 25s 盾甲兵 ×2 → 36-37s 横幅 → 38s 忍者 Boss ×1（融合）
  8: {
    events: [
      { t: 5,  do: 'elite', combos: [{ type: 'eliteKnight', count: 2 }], dir: 'front', via: 'portal' },
      { t: 15, do: 'elite', combos: [{ type: 'eliteKnight', count: 2 }, { type: 'shield', count: 1 }],
        dir: 'front', via: 'portal' },
      { t: 25, do: 'elite', combos: [{ type: 'shield', count: 2 }], dir: 'front', via: 'portal' },
      { t: 36.0, do: 'banner', text: '前方精英来袭', dir: 'front' },
      { t: 38.0, do: 'elite', combos: [{ type: 'ninja', count: 1 }],
        dir: 'front', via: 'merge', goldReturn: true },
    ],
  },

  // 10：5s 铁甲兵 ×2 → 15s 铁甲兵 ×2 + 盾甲兵 ×1 → 25s 铁甲兵 ×2 + 忍者 ×1
  //     → 36-37s 横幅 → 38s 治疗术士 ×1 + 铁甲兵 Boss ×1 + 忍者 Boss ×2（融合）
  10: {
    events: [
      { t: 5,  do: 'elite', combos: [{ type: 'eliteKnight', count: 2 }], dir: 'front', via: 'portal' },
      { t: 15, do: 'elite', combos: [{ type: 'eliteKnight', count: 2 }, { type: 'shield', count: 1 }],
        dir: 'front', via: 'portal' },
      { t: 25, do: 'elite', combos: [{ type: 'eliteKnight', count: 2 }, { type: 'ninja', count: 1 }],
        dir: 'front', via: 'portal' },
      { t: 36.0, do: 'banner', text: '前方精英来袭', dir: 'front' },
      { t: 38.0, do: 'elite',
        combos: [{ type: 'heart', count: 1 }, { type: 'eliteKnight', count: 1 }, { type: 'ninja', count: 2 }],
        dir: 'front', via: 'merge', goldReturn: true, link: 'heal' },
    ],
  },

  // 11：5s 铁甲兵 ×3 → 15s 铁甲兵 ×3 + 盾甲兵 ×1 → 25s 铁甲兵 ×2 + 治疗术士 ×1 + 忍者 ×2
  //     → 36-37s 横幅 → 38s 幽灵 Boss（融合）
  11: {
    events: [
      { t: 5,  do: 'elite', combos: [{ type: 'eliteKnight', count: 3 }], dir: 'front', via: 'portal' },
      { t: 15, do: 'elite', combos: [{ type: 'eliteKnight', count: 3 }, { type: 'shield', count: 1 }],
        dir: 'front', via: 'portal' },
      { t: 25, do: 'elite',
        combos: [{ type: 'eliteKnight', count: 2 }, { type: 'heart', count: 1 }, { type: 'ninja', count: 2 }],
        dir: 'front', via: 'portal' },
      { t: 36.0, do: 'banner', text: '前方精英来袭', dir: 'front' },
      { t: 38.0, do: 'elite', combos: [{ type: 'ghost', count: 1 }],
        dir: 'front', via: 'merge', goldReturn: true },
    ],
  },

  // 13：5s 铁甲兵 ×2 + 忍者 ×1 → 15s 铁甲兵 ×1 + 盾甲兵 ×2 → 25s 铁甲兵 ×3 + 治疗术士 ×2 + 忍者 ×2
  //     → 35s 忍者 ×3 → 45-46s 横幅 → 47s 幽灵 Boss + 忍者 Boss（融合）
  13: {
    events: [
      { t: 5,  do: 'elite', combos: [{ type: 'eliteKnight', count: 2 }, { type: 'ninja', count: 1 }],
        dir: 'front', via: 'portal' },
      { t: 15, do: 'elite', combos: [{ type: 'eliteKnight', count: 1 }, { type: 'shield', count: 2 }],
        dir: 'front', via: 'portal' },
      { t: 25, do: 'elite',
        combos: [{ type: 'eliteKnight', count: 3 }, { type: 'heart', count: 2 }, { type: 'ninja', count: 2 }],
        dir: 'front', via: 'portal' },
      { t: 35, do: 'elite', combos: [{ type: 'ninja', count: 3 }], dir: 'front', via: 'portal' },
      { t: 45.0, do: 'banner', text: '前方精英来袭', dir: 'front' },
      { t: 47.0, do: 'elite', combos: [{ type: 'ghost', count: 1 }, { type: 'ninja', count: 1 }],
        dir: 'front', via: 'merge', goldReturn: true },
    ],
  },

  // 14：5s 铁甲兵 ×2 + 忍者 ×1 → 15s 铁甲兵 ×2 + 盾甲兵 ×2 → 25s 铁甲兵 ×2 + 治疗术士 ×1 + 忍者 ×2 + 幽灵 ×1
  //     → 35s 忍者 ×3 → 45-46s 横幅 → 47s 章鱼 Boss（融合）
  14: {
    events: [
      { t: 5,  do: 'elite', combos: [{ type: 'eliteKnight', count: 2 }, { type: 'ninja', count: 1 }],
        dir: 'front', via: 'portal' },
      { t: 15, do: 'elite', combos: [{ type: 'eliteKnight', count: 2 }, { type: 'shield', count: 2 }],
        dir: 'front', via: 'portal' },
      { t: 25, do: 'elite',
        combos: [{ type: 'eliteKnight', count: 2 }, { type: 'heart', count: 1 }, { type: 'ninja', count: 2 },
                 { type: 'ghost', count: 1 }],
        dir: 'front', via: 'portal' },
      { t: 35, do: 'elite', combos: [{ type: 'ninja', count: 3 }], dir: 'front', via: 'portal' },
      { t: 45.0, do: 'banner', text: '前方精英来袭', dir: 'front' },
      { t: 47.0, do: 'elite', combos: [{ type: 'octopus', count: 1 }],
        dir: 'front', via: 'merge', goldReturn: true },
    ],
  },

  // 16：5s 铁甲兵 ×2 + 幽灵 ×1 → 15s 铁甲兵 ×1 + 盾甲兵 ×2 → 25s 铁甲兵 ×3 + 治疗术士 ×2 + 忍者 ×2 + 幽灵 ×1
  //     → 35s 忍者 ×3 → 45-46s 横幅 → 47s 章鱼 Boss + 幽灵 Boss（融合）
  16: {
    events: [
      { t: 5,  do: 'elite', combos: [{ type: 'eliteKnight', count: 2 }, { type: 'ghost', count: 1 }],
        dir: 'front', via: 'portal' },
      { t: 15, do: 'elite', combos: [{ type: 'eliteKnight', count: 1 }, { type: 'shield', count: 2 }],
        dir: 'front', via: 'portal' },
      { t: 25, do: 'elite',
        combos: [{ type: 'eliteKnight', count: 3 }, { type: 'heart', count: 2 }, { type: 'ninja', count: 2 },
                 { type: 'ghost', count: 1 }],
        dir: 'front', via: 'portal' },
      { t: 35, do: 'elite', combos: [{ type: 'ninja', count: 3 }], dir: 'front', via: 'portal' },
      { t: 45.0, do: 'banner', text: '前方精英来袭', dir: 'front' },
      { t: 47.0, do: 'elite', combos: [{ type: 'octopus', count: 1 }, { type: 'ghost', count: 1 }],
        dir: 'front', via: 'merge', goldReturn: true },
    ],
  },

  // 17：5s 铁甲兵 ×2 + 幽灵 ×1 + 章鱼 ×1 → 15s 铁甲兵 ×1 + 盾甲兵 ×1 + 忍者 ×2 + 幽灵 ×2 + 章鱼 ×1
  //     → 25s 铁甲兵 ×3 + 治疗术士 ×2 + 忍者 ×2 + 幽灵 ×2 + 章鱼 ×2 → 35s 忍者 ×3
  //     → 45-46s 横幅 → 47s 章鱼 Boss + 幽灵 Boss + 忍者 Boss（融合）
  17: {
    events: [
      { t: 5,  do: 'elite',
        combos: [{ type: 'eliteKnight', count: 2 }, { type: 'ghost', count: 1 }, { type: 'octopus', count: 1 }],
        dir: 'front', via: 'portal' },
      { t: 15, do: 'elite',
        combos: [{ type: 'eliteKnight', count: 1 }, { type: 'shield', count: 1 }, { type: 'ninja', count: 2 },
                 { type: 'ghost', count: 2 }, { type: 'octopus', count: 1 }],
        dir: 'front', via: 'portal' },
      { t: 25, do: 'elite',
        combos: [{ type: 'eliteKnight', count: 3 }, { type: 'heart', count: 2 }, { type: 'ninja', count: 2 },
                 { type: 'ghost', count: 2 }, { type: 'octopus', count: 2 }],
        dir: 'front', via: 'portal' },
      { t: 35, do: 'elite', combos: [{ type: 'ninja', count: 3 }], dir: 'front', via: 'portal' },
      { t: 45.0, do: 'banner', text: '前方精英来袭', dir: 'front' },
      { t: 47.0, do: 'elite',
        combos: [{ type: 'octopus', count: 1 }, { type: 'ghost', count: 1 }, { type: 'ninja', count: 1 }],
        dir: 'front', via: 'merge', goldReturn: true },
    ],
  },
};

/** 本关的编排脚本（无 → null，走旧的三期脉冲） */
export function scriptFor(n) { return SPAWN_SCRIPT[n] || null; }

/** 取敌种所属层（未知 → trash） */
export function layerOfType(type) { return TYPE_LAYER[type] || 'trash'; }

/** combos 总数 */
export function comboTotal(combos) {
  let n = 0;
  for (const c of combos || []) n += (c.count || 0);
  return n;
}

/**
 * 纯函数：某事件在 (from, to] 区间内的触发时刻（含 every 循环）。便于单测。
 * @param {object} ev   事件
 * @param {number} from 上一帧的已进行秒数
 * @param {number} to   本帧的已进行秒数
 */
export function scriptEventTimes(ev, from, to) {
  if (!ev) return [];
  if (!ev.every) return (ev.t > from && ev.t <= to) ? [ev.t] : [];
  const until = ev.until != null ? ev.until : Infinity;
  const out = [];
  for (let t = ev.t; t <= until && t <= to + 1e-9; t += ev.every) if (t > from) out.push(t);
  return out;
}

/**
 * 纯函数：脚本里最后一个事件的时间点（秒）。
 *
 * <p>用途（第六十三修 · 现场「只打死忍者精英而非末尾精英也能通关」）：
 *    关卡收尾判定必须等**脚本的全部事件都走完**。反例正是现场那条：
 *    末尾横幅闸门（_holdClimaxBanner）把脚本时钟冻住 → 玩家在关卡时长（如 60s）之后才清完场上的精英
 *    → 闸门一放行，「时间到 + 场上清空」当场成立 → 关卡在末尾批生成之前就被判通关。
 *
 * <p>无限循环事件（`every` 且没写 `until`）**不计入**结束时间：它是「一直有效」的滴流，
 *    让它无限延长关卡会变成软锁。
 */
export function scriptEndTime(script) {
  if (!script || !Array.isArray(script.events)) return 0;
  let end = 0;
  for (const ev of script.events) {
    if (ev.every && ev.until == null) continue;          // 无限循环：不参与「脚本走完」的判定
    const t = (ev.every ? ev.until : ev.t) || 0;
    if (t > end) end = t;
  }
  return end;
}

/** 纯函数：本关脚本里的精英事件按时间顺序（供调度器与日志） */
export function eliteEvents(n) {
  const s = scriptFor(n);
  if (!s) return [];
  return s.events.filter((e) => e.do === 'elite');
}

// ============================================================
// 精英强化（第四十七~四十八修）—— 纯函数，调用点 waves._eliteOpts（参数表见 constants.ELITE_TUNING）
//
// ★ 第四十八修：**只有「末尾精英」才强化**。末尾批 = 关卡脚本里带 goldReturn 的那一批
//   （弹「…精英来袭」横幅 → 清场融合 → 金点飞向选项卡 → 抽卡），也就是每关的收尾高潮。
//   前面零星出现的精英（L2/L5 每 10s 一只的铁甲兵、L4 的 2 只直出）走**原生**口径：
//   原生体型（1 倍，连敌种自带的 scale 也压回去）+ 固定血量 ELITE_BASE_HP[型] + 原生速度。
//   起因（现场实测）：第四十七修让**全员** ×3 体型 + 全员 DPS 血量 → 中段精英也变成打不动的墙，
//   玩家连「先清杂鱼」都做不到；末尾精英更是必定走完路程撞进玩家区域。
//
// 末尾批血量 = clamp(本批基础血量 × HP_MUL, DPS × HP_MIN_SECONDS, DPS × HP_MAX_SECONDS)
//   —— 把「纯输出秒数」夹在 [MIN, MAX]：
//     · 上限 HP_MAX_SECONDS 就是**可击杀保证**（再弱的构筑也不会撞上打不死的墙）；
//     · 下限 HP_MIN_SECONDS 是**仪式感保证**（DPS 再高也不是一秒蒸发）；
//     · 同批按各型基础血量**按比例**摊（L4 的 盾甲兵 仍比 铁甲兵 厚）。
//   速度 = 出生距离 × TRAVEL_FRACTION / TRAVEL_SECONDS（10 秒走 2/3 路程）。
// ============================================================

/** 末尾精英事件判定（唯一定义）：带 goldReturn 的那一批 = 本关收尾。 */
export function isClimaxEvent(ev) { return !!(ev && ev.goldReturn); }

/**
 * 「末尾批预告横幅」判定（纯函数，第五十七修）。
 *
 * <p>末尾批的脚本形态：`banner`（如 31s）→ `elite { goldReturn }`（如 33s）→ …。玩家口径是
 *    「到横幅时间先看场上有没有精英，有就推迟，直到精英被杀，横幅才出现」——
 *    闸门因此打在**横幅**上：横幅一放，后面的清场融合与精英生成才跟着走。
 *
 * <p>判据：这条 banner 之后**第一个精英事件**带 goldReturn（中间又插了 banner 就不算）。
 */
export function isClimaxGateBanner(ev, events) {
  if (!ev || ev.do !== 'banner' || !Array.isArray(events)) return false;
  const i = events.indexOf(ev);
  if (i < 0) return false;
  for (let k = i + 1; k < events.length; k++) {
    const e = events[k];
    if (e.do === 'elite') return isClimaxEvent(e);
    if (e.do === 'banner') return false;
  }
  return false;
}

/**
 * 清场融合「吃谁」（纯函数，第五十七修）。
 *
 * <p>玩家口径：末尾批把**普通小怪化成光点**（不够就从传送门补光点），**多出来的小怪留在场上**。
 *    旧实现是「全都清掉、只记前 COUNT 个位置」——多出来的小怪也一起没了。
 *
 * <p>规则：① 末尾批（climax）先把精英吃进来（可视化「被吸走」，防上一批精英残留）；
 *    ② 每档只吃到 count 为止；③ 离 center 近的先吃（汇聚点附近的先被吸进去）。
 *
 * @param {Array} list 场上气球（balloons.list）
 * @param {number} count 最多吃几个（= FUSE.COUNT）
 * @param {{center?: object, climax?: boolean}} opts center = 汇聚点（缺省按场上顺序）
 * @returns {Array} 要被吸收（从场上移除）的气球，长度 ≤ count
 */
export function pickFuseAbsorb(list, count, opts = {}) {
  const { center = null, climax = false } = opts;
  const cap = Math.max(0, count | 0);
  const out = [];
  const dist2 = (b) => (center && b.mesh && b.mesh.position) ? b.mesh.position.distanceToSquared(center) : 0;
  const take = (eliteOnly) => {
    const arr = (list || []).filter((b) => b && b.alive && !b.isBoss && (eliteOnly ? b.isElite : !b.isElite));
    arr.sort((a, b) => dist2(a) - dist2(b));
    for (const b of arr) { if (out.length >= cap) return; out.push(b); }
  };
  if (climax) take(true);
  take(false);
  return out;
}

/**
 * 末尾批里「某一只」的血量。
 * @param {number} base           该只的基础血量（ELITE_BASE_HP[型]）
 * @param {number} batchBaseTotal 本批全部成员的基础血量之和（按型 × 只数）
 * @param {number} dps            玩家当前 DPS（<=0 / 非法 → 退化为固定血量）
 * @param {object} tune           ELITE_TUNING
 */
export function climaxEliteHp(base, batchBaseTotal, dps, tune = {}) {
  const mul = numOr(tune.HP_MUL, 2);
  const raw = numOr(base, 0) * mul;
  const rawTotal = numOr(batchBaseTotal, raw) * mul;
  const d = (Number.isFinite(dps) && dps > 0) ? dps : 0;
  if (d <= 0 || rawTotal <= 0) return Math.max(1, Math.round(raw));
  const lo = d * numOr(tune.HP_MIN_SECONDS, 2.5);
  const hi = d * numOr(tune.HP_MAX_SECONDS, 6);
  const target = Math.min(Math.max(rawTotal, lo), hi);   // clamp(rawTotal, lo, hi)
  return Math.max(1, Math.round(raw * (target / rawTotal)));
}

export function eliteTravelSpeed(tune = {}) {
  const dist = numOr(tune.SPAWN_DIST, 24);
  const frac = numOr(tune.TRAVEL_FRACTION, 2 / 3);
  const secs = Math.max(0.1, numOr(tune.TRAVEL_SECONDS, 10));
  return dist * frac / secs;
}

function numOr(v, def) { return Number.isFinite(v) ? v : def; }
