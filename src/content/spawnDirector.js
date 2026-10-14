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
// 本批只写 1 / 2 / 4 / 5 四关；机制关(3/9/15)与 Boss 关(6/12/18)不参与。
// 未列出的普通关继续走 ELITE_SCHEDULE 三期脉冲（旧路径，未改动）。
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

// 本关时间轴脚本
export const SPAWN_SCRIPT = {
  // 第一关：40s 教学关 —— 前 30s 让玩家体验「开枪 / 伤害数字 / 连杀加速」，
  //   30s 前沿方精英来袭 → 清场融合（未被击杀的杂鱼化成光点）→ 铁甲兵
  1: {
    trashMul: 1.5,                     // 前 30s 杂鱼密度 ×1.5（撑到连杀加速）
    trashMulUntil: 30,
    events: [
      { t: 30.0, do: 'banner', text: '前方精英来袭', dir: 'front' },
      { t: 30.7, do: 'elite', combos: [{ type: 'eliteKnight', count: 1 }],
        dir: 'front', via: 'merge', goldReturn: true },
    ],
  },

  // 第二关：前 30s 每 10s 一个铁甲兵（蓝点从传送门直出，场上最多 1 只）
  //   30s 左边精英来袭 → 融合出盾甲兵 → 击破后金点飞向选项卡（把视线从左引回正前方）
  2: {
    events: [
      { t: 5, every: 10, until: 30, do: 'elite', combos: [{ type: 'eliteKnight', count: 1 }],
        dir: 'front', via: 'portal', capOnField: 1 },
      { t: 30.0, do: 'banner', text: '左边精英来袭', dir: 'frontLeft' },
      { t: 30.7, do: 'elite', combos: [{ type: 'shield', count: 1 }],
        dir: 'frontLeft', via: 'merge', goldReturn: true },
    ],
  },

  // 第四关：技能验证关 —— 开局大量杂兵 + 横幅提示用技能（横幅前锁技能，防误按）
  //   20s 两个铁甲兵（直出）→ 30s 右边精英来袭 → 融合 2 铁甲兵 + 1 盾甲兵（盾兵在后）→ 金点抽卡
  4: {
    skillLockUntil: 4.2,               // 进本关锁技能，横幅（0.4s 起 2s）结束后解锁
    events: [
      { t: 0.2, do: 'trashBurst', count: 8 },
      { t: 0.4, do: 'banner', text: '大量敌兵来袭，快使用技能' },
      { t: 20.0, do: 'elite', combos: [{ type: 'eliteKnight', count: 2 }],
        dir: 'front', via: 'portal' },
      { t: 30.0, do: 'banner', text: '右边精英来袭', dir: 'frontRight' },
      { t: 30.7, do: 'elite', combos: [{ type: 'eliteKnight', count: 2 }, { type: 'shield', count: 1 }],
        dir: 'frontRight', via: 'merge', goldReturn: true, tailType: 'shield' },
    ],
  },

  // 第五关：左边来袭 = 治疗术士 ×1 + 铁甲兵 ×2（融合），治疗术士与铁甲兵之间连治疗线 + 绿色加号
  5: {
    events: [
      { t: 5, every: 10, until: 30, do: 'elite', combos: [{ type: 'eliteKnight', count: 1 }],
        dir: 'front', via: 'portal', capOnField: 1 },
      { t: 30.0, do: 'banner', text: '左边精英来袭', dir: 'frontLeft' },
      { t: 30.7, do: 'elite', combos: [{ type: 'heart', count: 1 }, { type: 'eliteKnight', count: 2 }],
        dir: 'frontLeft', via: 'merge', goldReturn: true, link: 'heal' },
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
