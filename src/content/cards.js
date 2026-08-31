// 抽卡卡牌配置（对齐 iMA 笔记「选项卡调整」）
// 属性类（加法叠加 + 封顶）：射速 / 子弹 / 攻击 / 技能消耗 / 技能伤害 / 自我修复 / 生命
// 技能类（红色）：如来神掌 / 激光剑 / 散射强化（仅第3关机制关固定三张）
//
// 卡面统一用 canvas 程序化「简笔画」图标（见 cardDraft.drawSketchIcon）+ 文字，不再依赖 PNG。

// 属性卡：icon 字段标识卡面简笔画图案；color 用于边框/图标色，rarity 仅作配色不做数值（加法叠加 + 封顶）。
export const ATTR_TYPES = [
  {
    id: 'fireRate', label: '射速+2', desc: '射速+2/秒（上限14）',
    color: '#2e86de', icon: 'fireRate',
    // 落到真实节流源（input.setFireRate）：选卡后射速真正提升，封顶 14 发/秒
    apply: (p) => {
      p.fireRate = Math.min(14, (p.fireRate || 2) + 2);
      p.input?.setFireRate(p.fireRate);
    },
  },
  {
    id: 'multiShot', label: '额外子弹+1', desc: '每发+1子弹（上限7）',
    color: '#27ae60', icon: 'multiShot',
    apply: (p) => { p.shotCount = Math.min(7, (p.shotCount || 1) + 1); },
  },
  {
    id: 'atk', label: '攻击力+100', desc: '攻击力+100（上限700）',
    color: '#e67e22', icon: 'atk',
    apply: (p) => { p.atk = Math.min(700, (p.atk || 100) + 100); },
  },
  {
    id: 'skillCost', label: '技能消耗-100', desc: '技能消耗-100（下限100）',
    color: '#8e44ad', icon: 'skillCost',
    apply: (p) => { p.skillCost = Math.max(100, (p.skillCost || 500) - 100); },
  },
  {
    id: 'skillDamage', label: '技能伤害+1倍', desc: '技能伤害×(+1)（上限×5）',
    color: '#c0392b', icon: 'skillDamage',
    apply: (p) => { p.skillDamageMul = Math.min(5, (p.skillDamageMul || 1) + 1); },
  },
  {
    id: 'selfRepair', label: '自我修复+2%/s', desc: '每秒回血+2%（上限10%）',
    color: '#16a085', icon: 'selfRepair',
    apply: (p) => { p.regen = Math.min(10, (p.regen || 0) + 2); },
  },
  {
    id: 'hp', label: '生命+50', desc: '生命上限+50（上限400），并回50',
    color: '#2980b9', icon: 'hp',
    apply: (p) => {
      p.maxHp = Math.min(400, (p.maxHp || 100) + 50);
      p.hp = Math.min(p.maxHp, (p.hp || 0) + 50);
    },
  },
];

// 技能卡（红色）：第3关固定三张（buddha/lightsaber/scatterburst）
export const SKILL_CARDS = [
  {
    id: 'buddha', label: '如来神掌', rarity: 'gold', color: '#ff3b3b', icon: 'buddha',
    desc: '全屏伤害200（×技能倍率）',
    apply: (p) => { p.buddhaUnlocked = true; p.buddhaTimer = 0; },
  },
  {
    id: 'lightsaber', label: '激光剑', rarity: 'gold', color: '#ff3b3b', icon: 'lightsaber',
    desc: '左手激光剑近战，伤害400（×倍率），持续5秒',
    apply: () => { /* 伤害由 game._castLaserSword 执行（需场景上下文）*/ },
  },
  {
    id: 'scatterburst', label: '散射强化', rarity: 'gold', color: '#ff3b3b', icon: 'scatterburst',
    desc: '一次性100发×100伤害（×倍率）',
    apply: () => { /* 伤害由 game._castScatterBurst 执行 */ },
  },
];
