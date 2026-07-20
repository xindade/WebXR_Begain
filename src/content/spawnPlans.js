// 关卡 → 单一敌人映射（需求：每关只出现一种敌人；一次只出一个，死后出下一个）。
// 覆盖 12 个非 Boss 战斗关：1,2,4,5,7,8,10,11,13,14,16,17。
// Boss 关(6/12/18) 与激光关(3/9/15) 不在此表，由各自系统处理。
// 10 种小怪各占一关；16/17 复用章鱼/龙头，覆盖更均衡。
// count：本关该敌人连续出场总数（场上始终只留 1 个，死亡后补下一个）。
export const LEVEL_ENEMY = {
  1:  { type: 'basic',      count: 8 },
  2:  { type: 'shield',     count: 6 },
  4:  { type: 'summoner',   count: 5 },
  5:  { type: 'ninja',      count: 6 },
  7:  { type: 'chest',      count: 5 },
  8:  { type: 'ghost',      count: 6 },
  10: { type: 'octopus',    count: 6 },
  11: { type: 'heart',      count: 5 },
  13: { type: 'dragonhead', count: 5 },
  14: { type: 'treasure',   count: 3 },
  16: { type: 'octopus',    count: 6 },  // 复用：章鱼
  17: { type: 'dragonhead', count: 5 },  // 复用：龙头
};

// 选项卡品质覆盖（供 cardDraft / game.js 读取；与出怪逻辑无关）。
// 仅 01/02 关有自定义品质；其余关用全局默认 RARITY。
export const LEVEL_PLANS = {
  1: { cards: { white: 60, blue: 40 } },
  2: { cards: { white: 50, blue: 30, purple: 20 }, firstCardForceAttackPurple: true },
};
