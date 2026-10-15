// 精英怪数值表（数据来自 Excel/精英怪物配置表.xlsx，Sheet1 的「默认血量」列）
//
// ⚠ 第五十修后本文件只剩两块在生效：
//   · ELITE_BASE_HP —— 各精英敌种的**固定默认血量**（普通精英与收尾批的基础量，见 waves._eliteOpts）；
//   · ELITE_WINDOW  —— 旧的「三期脉冲」时间窗常量（保留常量本身；三期脉冲已无人使用）。
//   排程表 ELITE_SCHEDULE 已停用 —— **18 关的精英编排现在全部来自 content/spawnDirector.js
//   （SPAWN_SCRIPT，唯一口径 = 现场《关卡安排.log》）**，理由见下方 ELITE_SCHEDULE 处的说明。
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
  shield:      1300,   // 盾兵怪/盾牌怪（L02 盾兵怪2000）
  heart:       5000,   // 心型怪/心形怪（L04 心形怪5000）
  ghost:       7000,   // 幽灵怪（L05 幽灵怪7000）
  ninja:       8000,   // 忍者怪（L07 忍者怪8000）
  octopus:     20000,  // 章鱼怪（L08 章鱼怪20000）
};

// ============================================================
// 第五十一修 · 远程三兄弟（忍者 / 幽灵 / 章鱼）的血量与体型口径（现场指定）：
//   · Boss 关（第 6/12/18 关，这三只是 Boss 召唤/阶段精英）：
//       血量 = ELITE_BASE_HP[型] + 玩家DPS × BOSS_SEC(10)
//   · 普通关（它们作为「有技能精英」登场）：
//       血量 = ELITE_BASE_HP[型] + 玩家DPS × NORMAL_SEC(2)
//       体型 = NORMAL_SIZE_MUL(2) 倍（原先被普通精英口径压回 1 倍，现场要放大两倍）
//   为什么按 DPS 缩放：固定血量在后期高 DPS 下被秒杀、低 DPS 下变成打不动的墙；
//   这两档正好是「普通关给压力、Boss 关验证输出」。
//   实现见 waves.rangedHpOpts / game._playerDPS，Boss 召唤侧见 bossMagician._spawnMinion。
// ============================================================
export const RANGED_DPS_HP = {
  ENABLED: true,
  TYPES: ['ninja', 'ghost', 'octopus'],
  BOSS_SEC: 10,        // Boss 关：默认血量 + DPS × 10
  NORMAL_SEC: 2,       // 普通关：默认血量 + DPS × 2
  NORMAL_SIZE_MUL: 2,  // 普通关体型倍数（Boss 关保持敌种自带 scale:3）
};

// ============================================================
// ⚠ 第五十修：ELITE_SCHEDULE 已**停用**。
//
//   从第五十修起，18 关的精英编排**全部**来自 content/spawnDirector.js 的 SPAWN_SCRIPT ——
//   现场《关卡安排.log》是唯一口径。waves._initLevel 里的判据是「有关卡脚本 → _elitePlan = null」，
//   而第五十修把除机制关(3/9/15)与 Boss 关(6/12/18)外的每一关都配上了脚本 ⇒ 这张表一个字也没生效。
//
//   为什么清空而不是留着：它和 SPAWN_SCRIPT 手写的时间轴是**两套互相矛盾**的排期
//   （本表 = 早期从 Excel「精英怪物配置表.xlsx」导出的三期脉冲：early 5s / mid 20s / late 40s，
//     再按 levelTimeScale 等比前移；SPAWN_SCRIPT = 5/15/25s 波次 + 36~47s 收尾融合）。
//   两份都留着，下次改关卡时非常容易改错一份。
//
//   旧数据（1/2/4/5/7/8/10/11/13/14/16/17 的三期波次）在 git 历史里：
//     git log -p -- src/content/eliteMonsters.js
//   真要回退三期脉冲：把旧表贴回来 + 删掉 spawnDirector.js 里对应关卡的脚本，两步都要做。
// ============================================================
export const ELITE_SCHEDULE = {};

// 精英波触发时间窗（秒，进入窗口即生成一次）：前期 5s / 中期 20s / 后期 40s
export const ELITE_WINDOW = { early: 5, mid: 20, late: 40 };
