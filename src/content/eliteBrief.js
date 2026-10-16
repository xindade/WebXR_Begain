// 商店关右侧「精英预告」卡（第五十七修 · 现场口径）
//
// 位置：商店关**右手边**一列只读卡（不绑气球、不可射击），与左手道具列（SHOP.ITEM_X = -3.0）镜像。
// 内容：每个商店只预告「本店 → 下一个商店之前」**新登场**的精英，以及该段里的那个 Boss。
//   · 第 3 关（窗口 4-8）   ：铁甲兵 / 盾甲兵 / 治疗术士 / 忍者队长 + 脸谱 Boss
//   · 第 9 关（窗口 10-14） ：幽灵法师 / 章鱼将军 + 龙 Boss（前面介绍过的省略）
//   · 第 15 关（窗口 16-18）：六种精英都介绍过了 → 只留「未知 Boss」（每种形态一张卡）
//   ★ 去重基线是**上一个商店的窗口**，不是 1~n 关：第 1/2 关虽然已经出过铁甲兵/盾甲兵，
//     但它们从没有过预告卡，所以第 3 关仍然要介绍它们。
//
// 数据全部取自既有单一口径（防手抄漂移）：
//   · 精英种类 = content/spawnDirector.js 的 SPAWN_SCRIPT（关卡脚本里 do==='elite' 的 combos）
//   · Boss 种类 = content/levels.js 的 LEVELS（kind==='boss' 的 boss 字段）
//   · 卡框色   = spawnDirector.LAYER 的层色（与局内出生光点同色：蓝=无技能 / 紫红=有技能 / 绿=辅助）
//
// 文案口径：**只写已经实现**的机制（别写愿景）；每条 tip ≤ 3 行（makeCardTexture 的 sub 最多 3 行）。
// 第 18 关的 Boss **不剧透为魔术师** —— 卡名只写「未知 Boss」，形态要点照实介绍。

import { LEVELS } from './levels.js';
import { SPAWN_SCRIPT, LAYER } from './spawnDirector.js';
import { ENEMY_TYPES } from './enemies.js';

// —— 精英介绍（名字 / 图标 key / 一句话要点）——
// 图标 key 由 game/cardDraft.js 的 drawSketchIcon 绘制（新增 9 个，见该文件「精英预告」段）
export const ELITE_BRIEF = {
  eliteKnight: { name: '铁甲兵', icon: 'eKnight', tip: '直冲近身、血厚，别被它和杂兵围住' },
  shield:      { name: '盾甲兵', icon: 'eShield', tip: '盾牌绕身旋转挡子弹，等它转开再打' },
  heart:       { name: '治疗术士', icon: 'eHealer', tip: '站桩不动，每 3 秒给最残血的精英回血，先集火它' },
  ninja:       { name: '忍者队长', icon: 'eNinja', tip: '会闪现贴身、扔手里剑，注意两侧与身后' },
  ghost:       { name: '幽灵法师', icon: 'eGhost', tip: '蓄力后投鬼火，命中会让你视野发紫' },
  octopus:     { name: '章鱼将军', icon: 'eOctopus', tip: '守在圈外喷墨，命中会让你视野发黑' },
};

/**
 * 精英卡的**立绘来源**（第五十七修 v2）：直接取 enemies.js 的模型字段 —— 与局内用的是同一份 GLB，
 * 不手抄路径。返回 null 表示该种类没有模型（则卡面退回简笔画图标）。
 * 盾甲兵是两个模型（骑士 + 旋转盾牌），由 enemyPortrait 组装后再抓图。
 * @returns {{url:string, shieldModel:string|null}|null}
 */
export function elitePortrait(type) {
  const t = ENEMY_TYPES[type];
  if (!t || !t.model) return null;
  // sideIcon（第六十三修）：盾牌抓帧失败时合成图左下角画的简笔画 key（见 enemyPortrait.composePortrait）
  const b = ELITE_BRIEF[type];
  return { url: t.model, shieldModel: t.shieldModel || null, sideIcon: (b && b.icon) || null };
}

// —— Boss 介绍 ——
// phases 存在时：每种形态占一张卡（第 18 关「未知 Boss」用），label 带「阶段一/二/三」后缀（第六十三修）
export const BOSS_BRIEF = {
  face: {
    name: '脸谱 Boss', icon: 'bossFace', color: '#ff4d6d',
    tip: '三张脸轮换：召唤阵 / 飞旗砸落 / 分身，先清子实体',
  },
  dragon: {
    name: '龙 Boss', icon: 'bossDragon', color: '#ffd43b',
    tip: '龙头无敌，打掉龙身与龙爪才能击杀',
  },
  magician: {
    // ⚠ 名字留「未知 Boss」：现场要求不剧透它是魔术师
    name: '未知 Boss', icon: 'bossUnknown', color: '#c44dff',
    // 第六十三修：现场逐条给的文案（照抄，别改口径）——阶段一召唤+激光 / 阶段二屏障+闪烁格 / 阶段三前后各 18 球突脸
    phases: [
      { tip: '会召唤小兵，场地中间出现激光，不能触碰' },
      { tip: '躲在防弹屏障后面，但闪烁格子似乎可以穿过' },
      { tip: '前后各召唤18个圆球，会突脸，优先消灭' },
    ],
  },
};

const PHASE_NAME = ['阶段一', '阶段二', '阶段三', '阶段四', '阶段五'];

/** 商店关列表（升序），供 shopWindow 定位「下一个商店」 */
function shopLevels() {
  return LEVELS.filter((l) => l.kind === 'shop').map((l) => l.n).sort((a, b) => a - b);
}

/**
 * 某个商店关的预告窗口：本店之后 → 下一个商店之前（纯函数）。
 * @returns {{from:number,to:number,levels:number[],prevShop:number|null}}
 */
export function shopWindow(shopLevel) {
  const shops = shopLevels();
  if (!shops.includes(shopLevel)) return { from: 0, to: -1, levels: [], prevShop: null };
  const prevShop = shops.filter((n) => n < shopLevel).pop() ?? null;
  const nextShop = shops.find((n) => n > shopLevel);
  const from = shopLevel + 1;
  const to = nextShop ? nextShop - 1 : LEVELS[LEVELS.length - 1].n;
  const levels = [];
  for (let n = from; n <= to; n++) levels.push(n);
  return { from, to, levels, prevShop };
}

/** 区间 [a,b] 内关卡脚本里出现过的精英种类（按首次出现顺序去重） */
function eliteTypesBetween(a, b) {
  const out = [];
  for (const lv of LEVELS) {
    if (lv.n < a || lv.n > b) continue;
    const script = SPAWN_SCRIPT[lv.n];
    if (!script) continue;
    for (const ev of script.events || []) {
      if (ev.do !== 'elite') continue;
      for (const c of ev.combos || []) {
        if (!out.includes(c.type)) out.push(c.type);
      }
    }
  }
  return out;
}

/** 敌种 → 卡框色（层色，与局内出生光点同色；查不到 → 白） */
function layerColor(type) {
  const need = { eliteKnight: 'mini', knight: 'mini', shield: 'mini', ghost: 'skill', ninja: 'skill', octopus: 'skill', heart: 'support' };
  const layer = LAYER[need[type] || 'trash'] || LAYER.trash;
  return '#' + layer.color.toString(16).padStart(6, '0');
}

/**
 * 生成某个商店关的预告卡（纯函数，便于单测）。
 * @param  {number} shopLevel 商店关号（3/9/15）；非商店关 → 空数组
 * @returns {Array<{key:string,label:string,sub:string,color:string,icon:string}>}
 */
export function previewCards(shopLevel) {
  const { levels, prevShop } = shopWindow(shopLevel);
  if (!levels.length) return [];

  // 去重基线 = 上一个商店的窗口（没有上一个商店 → 空）
  const introduced = new Set(prevShop != null ? eliteTypesBetween(prevShop + 1, shopLevel - 1) : []);
  const fresh = eliteTypesBetween(levels[0], levels[levels.length - 1]).filter((t) => !introduced.has(t));

  const cards = [];
  for (const t of fresh) {
    const b = ELITE_BRIEF[t];
    if (!b) continue;                       // 没写介绍的种类不出现（宁缺勿错字）
    // portrait：卡面立绘（模型截图）；boss 卡一律不给图 —— 现场口径「Boss 不露脸」
    cards.push({ key: t, label: b.name, sub: b.tip, color: layerColor(t), icon: b.icon, portrait: elitePortrait(t) });
  }

  // 本段里的 Boss（Boss 关在窗口内时给卡；每段只有一个）
  for (const n of levels) {
    const lv = LEVELS.find((l) => l.n === n);
    if (!lv || lv.kind !== 'boss' || !lv.boss) continue;
    const b = BOSS_BRIEF[lv.boss];
    if (!b) continue;
    if (b.phases) {
      b.phases.forEach((p, i) => cards.push({
        key: lv.boss + '-' + (i + 1), portrait: null,
        label: b.name + ' ' + (PHASE_NAME[i] || ('阶段' + (i + 1))),
        sub: p.tip, color: b.color, icon: b.icon,
      }));
    } else {
      cards.push({ key: lv.boss, label: b.name, sub: b.tip, color: b.color, icon: b.icon, portrait: null });
    }
  }
  return cards;
}