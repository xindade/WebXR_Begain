// 气球敌人配置（知识库「气球种类设计」13 种）
// behavior 决定移动/攻击逻辑；当前原型完整实现 basic / knight，其余以 basic 占位（含外观差异），
// 后续按知识库逐项补齐特殊行为。

export const ENEMY_TYPES = {
  basic:   { id: 'basic',   name: '白板气球',   hp: 100, speed: 0.5, radius: 0.5, score: 10, behavior: 'basic' },
  speed:   { id: 'speed',   name: '速度气球',   hp: 100, speed: 1.1, radius: 0.5, score: 14, behavior: 'basic', tint: 0xffe066 },
  ninja:   { id: 'ninja',   name: '忍者气球',   hp: 120, speed: 0.9, radius: 0.5, score: 16, behavior: 'hop', tint: 0x2d3436 },
  shield:  { id: 'shield',  name: '盾牌气球',   hp: 160, speed: 0.4, radius: 0.6, score: 18, behavior: 'basic', tint: 0x74b9ff },
  knight:  { id: 'knight',  name: '骑士气球',   hp: 500, speed: 0.35, radius: 1.5, score: 30, behavior: 'knight', scale: 3 },
  chameleon:{ id: 'chameleon', name: '变色气球', hp: 110, speed: 0.5, radius: 0.5, score: 12, behavior: 'basic', tint: 0x55efc4 },
  bomber:  { id: 'bomber',  name: '投掷气球',   hp: 130, speed: 0.4, radius: 0.6, score: 18, behavior: 'basic', tint: 0xff7675 },
  ray:     { id: 'ray',     name: '射线气球',   hp: 200, speed: 0.2, radius: 0.7, score: 24, behavior: 'basic', tint: 0xa29bfe },
  drag:    { id: 'drag',    name: '拖拽气球',   hp: 150, speed: 0.3, radius: 0.7, score: 20, behavior: 'basic', tint: 0x636e72 },
  spinner: { id: 'spinner', name: '旋转气球',   hp: 300, speed: 0.4, radius: 0.9, score: 26, behavior: 'basic', tint: 0xfd79a8 },
  abyss:   { id: 'abyss',   name: '深渊气球',   hp: 140, speed: 0.5, radius: 0.5, score: 18, behavior: 'basic', tint: 0x2d3436 },
  cloud:   { id: 'cloud',   name: '黑云气球',   hp: 180, speed: 0.3, radius: 0.9, score: 22, behavior: 'basic', tint: 0x341f97 },
  heart:   { id: 'heart',   name: '心形气球',   hp: 80,  speed: 0.5, radius: 0.5, score: 8,  behavior: 'heal',  tint: 0xff6b81 },
  panda:   { id: 'panda',   name: '熊猫气球',   hp: 120, speed: 0.5, radius: 0.6, score: 14, behavior: 'basic', tint: 0xffffff },
  magician:{ id: 'magician',name: '魔术师气球', hp: 200, speed: 0.2, radius: 0.8, score: 30, behavior: 'basic', tint: 0x6c5ce7 },
};

// 普通关可用池（排除特殊机制型，后面关卡逐步引入）
export const NORMAL_POOL = ['basic', 'speed', 'chameleon', 'panda', 'shield'];
export const CRISIS_POOL = ['basic', 'speed', 'ninja', 'shield', 'knight', 'bomber', 'spinner'];
