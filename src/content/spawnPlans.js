// 01/02 关固定出怪计划（依据 IMA 知识库《关卡设计》笔记）。
// 仅当 LEVEL_PLANS[level.n] 存在时，WaveManager 走本表（固定编队），其余关保持原随机池。
//
// segments：按时长分段的出怪节奏；until = 该段结束的累计秒数；
//   dirs   = 该段出怪方位：'front'(前/-Z) | 'left'(左) | 'right'(右)，多值为并集；
//   spawns = 该段要生成的 [{类型, 数量}]（数量之和计入本关 total）。
// cards：覆盖该关选项卡品质权重（见 cardDraft.js）；firstCardForceAttackPurple 仅第2关。

export const LEVEL_PLANS = {
  // ===== 01-普通关（教学）=====
  // 出怪点：先前方15s → 左15s → 前+左30s
  // 出怪种类：基础29 + 召唤1；卡片：白60 蓝40
  1: {
    segments: [
      { until: 15, dirs: ['front'],                spawns: [['basic', 10]] },
      { until: 30, dirs: ['left'],                 spawns: [['basic', 10]] },
      { until: 60, dirs: ['front', 'left'],        spawns: [['basic', 10], ['summoner', 1]] },
    ],
    cards: { white: 60, blue: 40 },
  },

  // ===== 02-普通关（适应）=====
  // 出怪点：先前方15s → 左+右15s → 前+左+右30s
  // 出怪种类：基础30 + 召唤4；卡片：白50 蓝30 紫20（首卡必出攻击紫）
  2: {
    segments: [
      { until: 15, dirs: ['front'],                spawns: [['basic', 10], ['summoner', 1]] },
      { until: 30, dirs: ['left', 'right'],        spawns: [['basic', 10], ['summoner', 1]] },
      { until: 60, dirs: ['front', 'left', 'right'], spawns: [['basic', 10], ['summoner', 2]] },
    ],
    cards: { white: 50, blue: 30, purple: 20 },
    firstCardForceAttackPurple: true,
  },

  // ===== 04-普通关（盾牌卫队）=====
  // 设计：骑士登场，盾牌气球环绕骑士旋转（每 2 秒 1 圈）形成护卫阵。
  // 出怪点：前15s → 前+左+右45s；种类 基础20 + 骑士2 + 盾牌9（共31）
  4: {
    segments: [
      { until: 15, dirs: ['front'],                  spawns: [['basic', 8], ['shield', 2]] },
      { until: 35, dirs: ['front', 'left', 'right'], spawns: [['knight', 1], ['shield', 3], ['basic', 6]] },
      { until: 99, dirs: ['front', 'left', 'right'], spawns: [['knight', 1], ['shield', 4], ['basic', 6]] },
    ],
  },
};
