// 18 关数据表（知识库「关卡机制」笔记）
// kind: normal(黄昏) / crisis(黑夜) / bonus(白天奖励) / boss(白天Boss)
// mood: dusk / night / day —— 控制天空与出怪
// name  —— 关卡场景名（第四十九修）。开局在玩家正前方弹一张标题卡（见 game._showLevelTitle /
//          constants.LEVEL_TITLE）；这里是**唯一**的名字来源，改名只动本表。
//          ⚠ 名字尽量 4 个字：标题卡按固定字号绘制，太长会顶到卡片边框。

export const LEVELS = [
  { n: 1,  kind: 'normal', mood: 'dusk',  name: '落日余晖' },
  { n: 2,  kind: 'crisis', mood: 'night', name: '长夜突袭' },
  { n: 3,  kind: 'laser',  mood: 'day',   name: '魔术空间' },
  { n: 4,  kind: 'normal', mood: 'dusk',  name: '双马拱日' },
  { n: 5,  kind: 'crisis', mood: 'night', name: '暮色极光' },
  { n: 6,  kind: 'boss',   mood: 'day',   name: '脸谱画廊', boss: 'face' },
  { n: 7,  kind: 'normal', mood: 'dusk',  name: '云海鲲鹏' },
  { n: 8,  kind: 'crisis', mood: 'night', name: '血月之夜' },
  { n: 9,  kind: 'laser',  mood: 'day',   name: '魔术空间', laserMode: 'drive' },
  { n: 10, kind: 'normal', mood: 'dusk',  name: '彩虹之桥' },
  { n: 11, kind: 'crisis', mood: 'night', name: '雷云密布' },
  { n: 12, kind: 'boss',   mood: 'day',   name: '巨龙云潭', boss: 'dragon' },
  { n: 13, kind: 'normal', mood: 'dusk',  name: '夕阳双糖' },
  { n: 14, kind: 'crisis', mood: 'night', name: '云卷暴风' },
  { n: 15, kind: 'laser',  mood: 'day',   name: '魔术空间', laserMode: 'flip' },
  { n: 16, kind: 'normal', mood: 'dusk',  name: '天梯初现' },
  { n: 17, kind: 'crisis', mood: 'night', name: '黎明之前' },
  { n: 18, kind: 'boss',   mood: 'day',   name: '公主堡垒', boss: 'magician' },
];

/** 关卡场景名（越界/未命名 → 空串；调用方自行决定是否显示） */
export function levelName(n) {
  const lv = LEVELS.find((l) => l.n === n);
  return (lv && lv.name) || '';
}

/**
 * 关卡标题卡文案（纯函数，便于单测）：把模板里的 {n} / {name} 填好。
 *   没写名字的关卡 → 空串（调用方据此不弹卡），不会出现「第 7 关 · 」
 * @param {number} n        关号
 * @param {string} template 模板，如 '第 {n} 关 · {name}'
 */
export function levelTitleText(n, template) {
  const name = levelName(n);
  if (!name) return '';
  return String(template).replace('{n}', String(n)).replace('{name}', name);
}

/**
 * 本关是否弹标题卡（纯函数，便于单测）。三条判据：
 *   ① 总开关 LEVEL_TITLE.ENABLED；
 *   ② 机制关(3/9/15)开局有魔术师开场动画 → SKIP_MECHANIC 时跳过，避免和动画叠在视线正前方；
 *   ③ 本关要有名字（没名字就没得显示）。
 * @param {object} lv  LEVELS 里的一项
 * @param {object} cfg constants.LEVEL_TITLE
 */
export function shouldShowLevelTitle(lv, cfg) {
  if (!lv || !cfg || !cfg.ENABLED) return false;
  if (cfg.SKIP_MECHANIC && lv.kind === 'laser') return false;
  return levelTitleText(lv.n, cfg.TEXT) !== '';
}

// 是否危机关：精英比例提升、四周奖励气球
export function isCrisis(lv) { return lv.kind === 'crisis'; }
export function isBoss(lv) { return lv.kind === 'boss'; }
export function isLaser(lv) { return lv.kind === 'laser'; }
