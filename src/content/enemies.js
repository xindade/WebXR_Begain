// 敌人配置（依据 IMA 知识库「小怪设计」文件夹 10 个小怪精确数值）。
// 每个小怪有专用 GLB 模型则填 model，无模型则留空 → 走程序化占位（彩色胶囊+眼睛）。
// 行为 behavior 决定移动/攻击逻辑；当前原型完整实现 basic / summon / shield / heal / treasure / ghost / ninja 的移动与核心机制，
// 其余（dragonhead / octopus / chest 的弹卡 / ninja 手里剑）以基础移动+占位外观呈现，特殊攻击后续按知识库逐项补齐。
//
// 速度说明（基准 = 基础怪 0.5 m/s）：
//   0.5   = 基础怪（基准，缓慢奔向玩家）
//   1.0   = 2 倍快冲（召唤 / 盾兵 / 宝箱 / 章鱼）
//   1.5   = 3 倍最快（忍者，闪现间隙移动）
//   0     = 原地（心型 / 幽灵 / 龙头 / 聚宝盆，无持续移动）
//   如需还原设计者原始数值，改下方 speed 字段即可。

export const ENEMY_TYPES = {
  // —— 01 基础怪 ——
  basic: {
    id: 'basic', name: '基础怪',
    hp: 100, speed: 0.5, radius: 0.5, score: 10,
    behavior: 'basic', selfDamage: 5,
    model: 'Model/基础怪.glb',
  },
  // —— 02 召唤怪 ——
  summoner: {
    id: 'summoner', name: '召唤怪',
    hp: 500, speed: 1.0, radius: 0.7, score: 30,
    behavior: 'summon', selfDamage: 15, minionCap: 2,
    model: 'Model/召唤师.glb',
  },
  // —— 03 盾兵怪（骑士模型 + 会旋转的盾牌组成）——
  shield: {
    id: 'shield', name: '盾兵怪',
    hp: 300, speed: 1.0, radius: 0.9, score: 18,
    behavior: 'shield', selfDamage: 10,
    model: 'Model/骑士.glb',          // 主体：骑士模型
    shieldModel: 'Model/盾牌.glb',    // 附加：会旋转的盾牌（绕骑士旋转，2s/圈，挡子弹）
    shieldSpinPeriod: 2.0,            // 盾牌旋转周期(s)，知识库「每2秒旋转一圈」
    shieldBlockArc: 75,               // 盾牌挡子弹的半角(°)：盾朝向玩家在此夹角内则挡下子弹
  },
  // —— 04 心型怪 ——
  heart: {
    id: 'heart', name: '心型怪',
    hp: 1000, speed: 0, radius: 0.9, score: 40,
    behavior: 'heal', selfDamage: 0,
    model: 'Model/心形怪.glb',
    healAura: 10,        // 每秒为周围敌人恢复血量
    healRadius: 6,       // 治疗光环半径(m)
    shipHealOnDeath: 30, // 击败后为船恢复血量
    tint: 0xff6b81,      // 占位外观色
  },
  // —— 05 忍者怪 ——
  ninja: {
    id: 'ninja', name: '忍者怪',
    hp: 500, speed: 1.5, radius: 0.6, score: 24,
    behavior: 'ninja', selfDamage: 5,
    model: 'Model/忍者.glb',
    blinkInterval: 3.0,  // 闪现间隔(s)
    blinkRange: 5.0,     // 闪现范围(m)
    shurikenInterval: 3.0, shurikenDamage: 5, // 手里剑（后续补齐抛射）
    tint: 0x2d3436,
  },
  // —— 06 宝箱怪 ——
  chest: {
    id: 'chest', name: '宝箱怪',
    hp: 500, speed: 1.0, radius: 0.7, score: 30,
    behavior: 'chest', selfDamage: 0,
    model: 'Model/宝箱.glb',
    hopInterval: 2.0,    // 绕玩家短跳间隔(s)
    dropCard: true,      // 死后弹出一次选项卡
    tint: 0xe1b12c,
  },
  // —— 07 幽灵怪 ——
  ghost: {
    id: 'ghost', name: '幽灵怪',
    hp: 800, speed: 0, radius: 0.8, score: 34,
    behavior: 'ghost', selfDamage: 10,
    model: 'Model/幽灵.glb',
    ghostFireInterval: 3.0, ghostFireCharge: 2.0, ghostFireDamage: 10, // 鬼火（蓄力2s后显形）
    tint: 0xdfe6e9,
  },
  // —— 08 龙头怪 ——
  dragonhead: {
    id: 'dragonhead', name: '龙头怪',
    hp: 1000, speed: 0, radius: 1.0, score: 50,
    behavior: 'dragonhead', selfDamage: 10,
    cloudInterval: 4.0,  // 制造云朵隐藏自己及周围
    fireballInterval: 4.0, fireballDamage: 10, // 火球砸玩家（后续补齐抛射）
    model: 'Model/龙头.glb',
  },
  // —— 09 聚宝盆怪 ——
  treasure: {
    id: 'treasure', name: '聚宝盆怪',
    hp: 999999, speed: 0, radius: 0.9, score: 0,
    behavior: 'treasure', selfDamage: 0,
    invincible: true,    // 无敌：子弹不扣血
    lifespan: 10.0,      // 存活 10s 后自动死亡结算
    baseScore: 500,      // 自身携带积分
    perKillScore: 50,    // 出现期间每死一个气球 +50
    tint: 0xfd9644,
  },
  // —— 10 章鱼怪 ——
  octopus: {
    id: 'octopus', name: '章鱼怪',
    hp: 1000, speed: 1.0, radius: 0.9, score: 30,
    behavior: 'octopus', selfDamage: 5,
    model: 'Model/章鱼.glb',
    inkInterval: 3.0, inkDuration: 1.0, inkDamage: 5, // 喷墨污染视线（后续补齐屏幕遮挡）
    tint: 0x6c5ce7,
  },

  // —— 骑士（Boss 专用，非小怪；第6/18关脸 Boss 放大此类型）——
  knight: {
    id: 'knight', name: '骑士Boss',
    hp: 500, speed: 0.35, radius: 1.5, score: 30,
    behavior: 'knight', scale: 3,
    model: 'Model/骑士.glb',
  },

  // —— 龙身/龙爪（Boss 专用，非小怪；由 dragonLevel 逐帧接管位置）——
  // 关键优化：dragonSegment=true → 走 balloonModels.attachDragonSegment 的极轻量程序化几何体，
  // 而非克隆 48万面 基础怪.glb。14 节合计仅约 4500 三角形（原 14×48万≈677万），是龙 Boss 关掉帧的核心修复。
  dragonBody: {
    id: 'dragonBody', name: '龙身',
    hp: 100, speed: 0, radius: 0.5, score: 10,
    behavior: 'basic', selfDamage: 0,
    dragonSegment: true,  // 触发 balloonModels.attachDragonSegment（轻量几何体，不加载 48万面 GLB）
    noHealthBar: true,    // 龙用全局血量池(d.hpPool 显示在手腕 UI)，逐节血条多余
  },
};

// 普通关可用池（10 小怪的子集：偏前期易处理）
export const NORMAL_POOL = ['basic', 'shield', 'ninja', 'heart', 'chest'];
// 危机关池（10 小怪全量，含高威胁型）
export const CRISIS_POOL = ['basic', 'summoner', 'shield', 'ninja', 'heart', 'chest', 'ghost', 'dragonhead', 'treasure', 'octopus'];

// 10 个小怪 id 列表（供 UI/调试遍历）
export const SMALL_MONSTER_IDS = ['basic', 'summoner', 'shield', 'heart', 'ninja', 'chest', 'ghost', 'dragonhead', 'treasure', 'octopus'];
