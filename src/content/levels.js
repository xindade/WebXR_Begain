// 18 关数据表（知识库「关卡机制」笔记）
// kind: normal(黄昏) / crisis(黑夜) / bonus(白天奖励) / boss(白天Boss)
// mood: dusk / night / day —— 控制天空与出怪

export const LEVELS = [
  { n: 1,  kind: 'normal', mood: 'dusk' },
  { n: 2,  kind: 'crisis', mood: 'night' },
  { n: 3,  kind: 'laser',  mood: 'day' },
  { n: 4,  kind: 'normal', mood: 'dusk' },
  { n: 5,  kind: 'crisis', mood: 'night' },
  { n: 6,  kind: 'boss',   mood: 'day', boss: 'face' },
  { n: 7,  kind: 'normal', mood: 'dusk' },
  { n: 8,  kind: 'crisis', mood: 'night' },
  { n: 9,  kind: 'laser',  mood: 'day', laserMode: 'drive' },
  { n: 10, kind: 'normal', mood: 'dusk' },
  { n: 11, kind: 'crisis', mood: 'night' },
  { n: 12, kind: 'boss',   mood: 'day', boss: 'dragon' },
  { n: 13, kind: 'normal', mood: 'dusk' },
  { n: 14, kind: 'crisis', mood: 'night' },
  { n: 15, kind: 'laser',  mood: 'day', laserMode: 'flip' },
  { n: 16, kind: 'normal', mood: 'dusk' },
  { n: 17, kind: 'crisis', mood: 'night' },
  { n: 18, kind: 'boss',   mood: 'day', boss: 'face' },
];

// 是否危机关：精英比例提升、四周奖励气球
export function isCrisis(lv) { return lv.kind === 'crisis'; }
export function isBoss(lv) { return lv.kind === 'boss'; }
export function isLaser(lv) { return lv.kind === 'laser'; }
