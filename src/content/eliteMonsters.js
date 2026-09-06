// 精英怪物排程表（数据来自 Excel/精英怪物配置表.xlsx，Sheet1）
// 关卡 × 3 阶段（前期 5-15s / 中期 20-35s / 后期 40-55s），精英波**叠加**于普通 DPS 出怪之上（不替换）。
//
// 敌种名归一（Excel 异体字 → ENEMY_TYPES id，见 enemies.js）：
//   骑士          → eliteKnight（新增变体：骑士模型 + basic 直冲 + 普通体型 scale:1）
//   盾兵怪/盾牌怪 → shield
//   心型怪/心形怪 → heart
//   幽灵怪        → ghost
//   忍者怪        → ninja
//   章鱼怪        → octopus
//
// ⚠️「默认血量」列的语义：
//   该列每行只点名**一个代表怪种**并给数值，例如：
//     L01 骑士1000 / L02 盾兵怪2000 / L04 心形怪5000 / L05 幽灵怪7000
//     L07 忍者怪8000 / L08 章鱼怪20000
//   这只是"在该关被点名的代表怪"，其数值实为**该敌种的全局默认血量**。
//   把这些值跨关聚合 → 得到 ELITE_BASE_HP（每个精英敌种自己的默认血量）。
//   骑士未在任何关单独被赋予更高值 → 沿用 L01 的 1000（故 L02 骑士也是 1000，而非 L02 的 2000）。
//
// 精英怪血量规则（已去掉「增幅血量」功能，只保留默认血量）：
//   每个精英敌种的血量 = ELITE_BASE_HP[该型]（固定默认血量，不随玩家 DPS 缩放）。
//   例：L02 精英骑士 = 1000、L02 精英盾兵 = 2000，各型按自己默认血量，互不串用。
//
// dir：front(前方) / frontLeft(前方+左边) / frontRight(前方+右边)，由 waves._eliteSpawnPositions 映射到出生方位。

// ===== 各精英敌种的「默认血量」（Excel 默认血量列按敌种跨关聚合）=====
// 取数：骑士1000(L01) / 盾兵2000(L02) / 心形5000(L04) / 幽灵7000(L05) / 忍者8000(L07) / 章鱼20000(L08)
export const ELITE_BASE_HP = {
  eliteKnight: 1000,   // 骑士（L01 骑士1000；未另行指定 → 全局 1000）
  knight:      1000,   // 普通骑士同值兜底
  shield:      2000,   // 盾兵怪/盾牌怪（L02 盾兵怪2000）
  heart:       5000,   // 心型怪/心形怪（L04 心形怪5000）
  ghost:       7000,   // 幽灵怪（L05 幽灵怪7000）
  ninja:       8000,   // 忍者怪（L07 忍者怪8000）
  octopus:     20000,  // 章鱼怪（L08 章鱼怪20000）
};

// 排程表：键为关卡号 n（number）。每关含 early/mid/late 三期（null = 该期无精英）。
// 注意：血量改由 ELITE_BASE_HP 按敌种提供（见上），已去掉原先的「增幅血量 / dpsSec」功能。
export const ELITE_SCHEDULE = {
  1: {
    early: null, mid: null,
    late: { combos: [{ type: 'eliteKnight', count: 1 }], dir: 'front' },
  },
  2: {
    early: { combos: [{ type: 'eliteKnight', count: 1 }], dir: 'front' },
    mid:   { combos: [{ type: 'eliteKnight', count: 2 }], dir: 'front' },
    late:  { combos: [{ type: 'eliteKnight', count: 2 }], dir: 'front' },
  },
  4: {
    early: { combos: [{ type: 'eliteKnight', count: 2 }], dir: 'front' },
    mid:   { combos: [{ type: 'eliteKnight', count: 3 }], dir: 'frontLeft' },
    late:  { combos: [{ type: 'shield', count: 1 }, { type: 'eliteKnight', count: 2 }], dir: 'frontRight' },
  },
  5: {
    early: { combos: [{ type: 'shield', count: 1 }, { type: 'eliteKnight', count: 2 }], dir: 'front' },
    mid:   { combos: [{ type: 'shield', count: 2 }, { type: 'eliteKnight', count: 1 }], dir: 'frontLeft' },
    late:  { combos: [{ type: 'shield', count: 3 }], dir: 'frontRight' },
  },
  7: {
    early: { combos: [{ type: 'shield', count: 2 }, { type: 'eliteKnight', count: 2 }], dir: 'front' },
    mid:   { combos: [{ type: 'shield', count: 2 }, { type: 'eliteKnight', count: 2 }], dir: 'frontLeft' },
    late:  { combos: [{ type: 'shield', count: 4 }, { type: 'eliteKnight', count: 4 }, { type: 'heart', count: 1 }], dir: 'frontRight' },
  },
  8: {
    early: { combos: [{ type: 'shield', count: 2 }, { type: 'eliteKnight', count: 4 }, { type: 'heart', count: 1 }], dir: 'front' },
    mid:   { combos: [{ type: 'shield', count: 3 }, { type: 'eliteKnight', count: 3 }, { type: 'heart', count: 1 }], dir: 'frontLeft' },
    late:  { combos: [{ type: 'shield', count: 4 }, { type: 'eliteKnight', count: 4 }, { type: 'heart', count: 2 }], dir: 'frontRight' },
  },
  10: {
    early: { combos: [{ type: 'shield', count: 2 }, { type: 'ghost', count: 2 }, { type: 'heart', count: 1 }], dir: 'front' },
    mid:   { combos: [{ type: 'shield', count: 3 }, { type: 'ghost', count: 3 }, { type: 'heart', count: 1 }], dir: 'frontLeft' },
    late:  { combos: [{ type: 'ghost', count: 6 }, { type: 'heart', count: 1 }], dir: 'frontRight' },
  },
  11: {
    early: { combos: [{ type: 'shield', count: 2 }, { type: 'ghost', count: 6 }, { type: 'eliteKnight', count: 2 }], dir: 'front' },
    mid:   { combos: [{ type: 'shield', count: 2 }, { type: 'ghost', count: 6 }, { type: 'eliteKnight', count: 2 }], dir: 'frontLeft' },
    late:  { combos: [{ type: 'shield', count: 2 }, { type: 'ghost', count: 6 }, { type: 'ninja', count: 2 }], dir: 'frontRight' },
  },
  13: {
    early: { combos: [{ type: 'shield', count: 2 }, { type: 'ghost', count: 6 }, { type: 'ninja', count: 2 }], dir: 'front' },
    mid:   { combos: [{ type: 'shield', count: 2 }, { type: 'ghost', count: 5 }, { type: 'ninja', count: 3 }], dir: 'frontLeft' },
    late:  { combos: [{ type: 'heart', count: 2 }, { type: 'ghost', count: 3 }, { type: 'ninja', count: 5 }], dir: 'frontRight' },
  },
  14: {
    early: { combos: [{ type: 'heart', count: 2 }, { type: 'ghost', count: 3 }, { type: 'ninja', count: 5 }], dir: 'front' },
    mid:   { combos: [{ type: 'heart', count: 2 }, { type: 'ghost', count: 3 }, { type: 'ninja', count: 5 }], dir: 'frontLeft' },
    late:  { combos: [{ type: 'heart', count: 1 }, { type: 'ghost', count: 3 }, { type: 'ninja', count: 5 }, { type: 'shield', count: 1 }], dir: 'frontRight' },
  },
  16: {
    early: { combos: [{ type: 'heart', count: 1 }, { type: 'ghost', count: 3 }, { type: 'ninja', count: 5 }, { type: 'shield', count: 1 }], dir: 'front' },
    mid:   { combos: [{ type: 'heart', count: 1 }, { type: 'ghost', count: 3 }, { type: 'ninja', count: 5 }, { type: 'octopus', count: 1 }], dir: 'frontLeft' },
    late:  { combos: [{ type: 'heart', count: 1 }, { type: 'ghost', count: 2 }, { type: 'ninja', count: 3 }, { type: 'octopus', count: 4 }], dir: 'frontRight' },
  },
  17: {
    early: { combos: [{ type: 'heart', count: 1 }, { type: 'ghost', count: 2 }, { type: 'ninja', count: 2 }, { type: 'octopus', count: 5 }], dir: 'front' },
    mid:   { combos: [{ type: 'heart', count: 1 }, { type: 'octopus', count: 9 }], dir: 'frontLeft' },
    late:  { combos: [{ type: 'heart', count: 1 }, { type: 'ghost', count: 2 }, { type: 'ninja', count: 2 }, { type: 'octopus', count: 5 }], dir: 'frontRight' },
  },
};

// 精英波触发时间窗（秒，进入窗口即生成一次）：前期 5s / 中期 20s / 后期 40s
export const ELITE_WINDOW = { early: 5, mid: 20, late: 40 };
