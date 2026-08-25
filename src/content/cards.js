// 抽卡卡牌配置（知识库「卡片」笔记）
// 属性类：攻击力/射速/多重(新图) + 回血/减冷却（保留 4 档稀有度）
// 技能类（红色）：如来神掌 / 金钟罩 / 金箍棒 / 定身咒
//
// atk / fireRate / multiShot 改用新 PNG 卡图（assets/cards/{id}.png），单值效果（不再走 4 档）
// 爆炸卡已删除（爆炸系统全链路移除）

import { SHOOT, BUDDHA } from '../core/constants.js';

// 每个属性：各稀有度增量 + apply(player)
// 有 image 字段的条目：用新 PNG 作为卡面纹理，单值效果（rarity 仅用于背景色，不再影响数值）
export const ATTR_TYPES = [
  {
    id: 'atk',
    label: '攻击力加倍',
    desc: '攻击力×2',
    image: 'atk',  // 对应 assets/cards/atk.png，由 preloadCardImages 预加载
    values: { white: 0, blue: 0, purple: 0, gold: 0 },
    apply: (p) => { p.atk *= 2; },
  },
  {
    id: 'fireRate',
    label: '攻击速度加倍',
    desc: '射速×2',
    image: 'fireRate',
    values: { white: 0, blue: 0, purple: 0, gold: 0 },
    // 冷却减半，封底为原始 COOLDOWN 的 25%（避免无下限卡死）。
    // 改 player.shootCooldown 只是存档快照——真实节流在 input._gunCooldown，必须调 input.setFireRateMul 才生效。
    apply: (p) => {
      p.fireRateMul = Math.max(0.25, (p.fireRateMul ?? 1) * 0.5);
      p.shootCooldown = Math.max(SHOOT.COOLDOWN * 0.25, p.shootCooldown * 0.5); // 存档快照
      p.input?.setFireRateMul(p.fireRateMul); // 落到真实节流源：选卡后射速真正翻倍
    },
  },
  {
    id: 'multiShot',
    label: '额外发射一枚子弹',
    desc: '每发+1子弹',
    image: 'multiShot',
    values: { white: 0, blue: 0, purple: 0, gold: 0 },
    // 确定性 +1（与现 fire() 的水平扇形对齐，可多次叠加）
    apply: (p) => { p.shotCount = (p.shotCount || 1) + 1; },
  },
  {
    id: 'heal', label: '回血', desc: '恢复并提升上限',
    values: { white: 10, blue: 20, purple: 50, gold: 100 },
    apply: (p, v) => { p.maxHp += v; p.hp = Math.min(p.maxHp, p.hp + v); },
  },
  {
    id: 'cooldownReduction', label: '减冷却', desc: '大招冷却',
    values: { white: 10, blue: 20, purple: 30, gold: 35 },
    apply: (p, v) => { p.buddhaCooldown = Math.max(BUDDHA.COOLDOWN * 0.25, p.buddhaCooldown - v); },
  },
];

// 技能卡（红色）：第三关固定三张（buddha/staff/freeze）+ 其余关随机出现其一（含 bell）
export const SKILL_CARDS = [
  {
    id: 'buddha', label: '如来神掌', rarity: 'gold', color: '#ff3b3b', desc: '解锁/刷新大招',
    apply: (p) => { p.buddhaUnlocked = true; p.buddhaTimer = 0; },
  },
  {
    id: 'bell', label: '金钟罩', rarity: 'gold', color: '#ff3b3b', desc: '场地护盾 3 秒',
    apply: (p) => { p.shieldTime = Math.max(p.shieldTime, 3); },
  },
  {
    id: 'staff', label: '金箍棒', rarity: 'gold', color: '#ff3b3b', desc: '前方扇形伤害',
    apply: () => { /* 实际伤害由 game._castStaff 执行（需场景上下文）*/ },
  },
  {
    id: 'freeze', label: '定身咒', rarity: 'gold', color: '#ff3b3b', desc: '暂停所有敌人行动',
    apply: () => { /* 冻结由 game._castFreeze 执行 */ },
  },
];
