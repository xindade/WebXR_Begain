// 抽卡卡牌配置（知识库「卡片」笔记，已统一两处矛盾）
// 属性类：攻击力/射速/多重/爆炸/回血/减冷却
// 技能类（金色）：如来神掌 / 金钟罩 / 金箍棒

import { SHOOT, BUDDHA } from '../core/constants.js';

// 每个属性：各稀有度增量 + apply(player)
export const ATTR_TYPES = [
  {
    id: 'atk', label: '攻击力', desc: '子弹伤害',
    values: { white: 10, blue: 20, purple: 50, gold: 100 },
    apply: (p, v) => { p.atk += v; },
  },
  {
    id: 'fireRate', label: '射速', desc: '射击更快',
    values: { white: 20, blue: 40, purple: 100, gold: 200 },
    apply: (p, v) => { p.shootCooldown = Math.max(SHOOT.COOLDOWN * 0.25, p.shootCooldown - v); },
  },
  {
    id: 'multiShot', label: '多重', desc: '概率额外弹',
    values: { white: 10, blue: 20, purple: 50, gold: 100 },
    apply: (p, v) => { p.multiShotChance = Math.min(100, p.multiShotChance + v); },
  },
  {
    id: 'explosion', label: '爆炸', desc: '击杀范围伤害',
    values: { white: 0.2, blue: 0.4, purple: 1, gold: 2 },
    apply: (p, v) => { p.explosion = Math.min(3, p.explosion + v); },
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

// 技能卡（仅金色）
export const SKILL_CARDS = [
  {
    id: 'buddha', label: '如来神掌', rarity: 'gold', desc: '解锁/刷新大招',
    apply: (p) => { p.buddhaUnlocked = true; p.buddhaTimer = 0; },
  },
  {
    id: 'bell', label: '金钟罩', rarity: 'gold', desc: '场地护盾 3 秒',
    apply: (p) => { p.shieldTime = Math.max(p.shieldTime, 3); },
  },
  {
    id: 'staff', label: '金箍棒', rarity: 'gold', desc: '攻击力 +200',
    apply: (p) => { p.atk += 200; },
  },
];
