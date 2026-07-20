// 集中配置表：关卡 + 敌人 + Boss（整合原 enemies.js / constants.js WAVE / waves.js / dragonLevel.js 的分散常量）
// 机制关（第3/9/15关为激光关）不在此表内。
// 出生点(spawn)指「敌人生成区域」，非玩家出生点（玩家出生点固定原点）。
// 动画速度(animSpeed)仅对 Boss/特殊敌人有意义（普通球体气球为程序化移动，无独立动画播放速度；animSpeed 为本次新增字段，默认 1）。
// 普通关 enemies 编队数量 = 30 + 关号*5（沿用原 WAVE 总数公式），按关卡递增梯度分配种类。
// 选项卡品质：每关可选 cardRarity 覆盖全局 RARITY；不写则继承默认（白60/蓝25/紫10/金5）。

// —— 全局默认敌人生成区域（普通关不写 spawn 时用此默认；源自 WAVE 常量）——
export const SPAWN_DEFAULT = {
  distance: 15,    // 玩家前方生成距离 m（WAVE.SPAWN_DISTANCE）
  spread: 8,       // 横向扩散 m（WAVE.SPAWN_SPREAD）
  phase2At: 15,    // 进入「前方+左右」阶段(s)（WAVE.PHASE2_AT）
  phase3At: 30,    // 进入「全向」阶段(s)（WAVE.PHASE3_AT）
};

// —— 敌人定义（生命 / 缩放 / 动画速度）——
// 数据来自 enemies.js ENEMY_TYPES（10 小怪 + knight Boss 专用）；scale 缺省 1（仅 knight 显式 3）。
export const ENEMIES = {
  basic:      { hp:100, scale:1, animSpeed:1 },
  summoner:   { hp:500, scale:1, animSpeed:1 },
  shield:     { hp:300, scale:1, animSpeed:1 },   // 盾兵怪：骑士模型 + 旋转盾
  heart:      { hp:1000, scale:1, animSpeed:1 },
  ninja:      { hp:500, scale:1, animSpeed:1.2 },
  chest:      { hp:500, scale:1, animSpeed:1 },
  ghost:      { hp:800, scale:1, animSpeed:1 },
  dragonhead: { hp:1000, scale:1, animSpeed:1 },
  treasure:   { hp:999999, scale:1, animSpeed:1 }, // 聚宝盆：无敌
  octopus:    { hp:1000, scale:1, animSpeed:1 },
  knight:     { hp:500, scale:3, animSpeed:1 },    // Boss 专用（脸 Boss 放大）
};

// —— Boss 定义 ——
export const BOSSES = {
  // 第6/18关：放大 knight（源自 waves._spawnBoss 硬编码）
  face: {
    type: 'knight',   // 用哪种敌人气球放大
    hp: 3000,         // 固定总血（_spawnBoss maxHp=3000）
    scale: 4,         // 放大倍率（mesh.scale.setScalar(4)）
    speed: 0.25,      // 移动速度（_spawnBoss speed=0.25）
    radius: 2,        // 实体半径（_spawnBoss radius=2）
    score: 500,       // 击杀分
    animSpeed: 1,
  },
  // 第12关：龙 Boss（源自 dragonLevel.js + DRAGON 常量）
  dragon: {
    bodyType: 'basic',
    clawType: 'basic',
    bodyCount: 10,        // dragon-anim.json config.bodyCount
    clawNodes: [7, 14],   // DRAGON.CLAW_NODES → 4 爪
    hpMult: 1.0,          // DRAGON.HP_MULT → 血量池 = (10+4)*100*1.0 = 1400
    scale: 0.08,          // DRAGON.SCALE
    home: { x:0, y:0, z:0 },
    yaw: 90, pitch: 0, roll: 0,
    headScale: 1.0, headYaw: 0,
    animSpeed: 180,       // 弧长推进速度（config.speed）：龙沿路径运动快慢
    waveAmpIdle: 0.45,    // DRAGON.IDLE_AMP
    waveAmpMove: 0.18,    // DRAGON.MOVE_AMP
    waveFreq: 2.2,        // DRAGON.IDLE_FREQ
    phaseStep: 0.55,      // DRAGON.PHASE_STEP
    respawnDelay: 1.0,    // DRAGON.RESPAWN_DELAY
    finaleInterval: 0.07, // DRAGON.FINALE_INTERVAL
  },
};

// —— 每关配置（跳过机制关 3/9/15）——
// type: normal | crisis | boss
// spawn: 敌人生成区域（覆盖 SPAWN_DEFAULT）
// enemies: 普通关显式编队 [{type, count}]（count 之和 = 30 + n*5）
// boss: Boss 关的 Boss 键名
// cardRarity: 该关选项卡品质权重（覆盖全局 RARITY；不写则继承默认）
export const LEVEL_CONFIG = {
  // ===== 普通关 / 危机关 =====
  1:  { type:'normal', enemies:[{"type":"basic","count":16},{"type":"ninja","count":6},{"type":"ghost","count":5},{"type":"octopus","count":5},{"type":"shield","count":3}] },  // 总数 35
  4:  { type:'normal', enemies:[{"type":"basic","count":20},{"type":"ninja","count":9},{"type":"ghost","count":7},{"type":"octopus","count":7},{"type":"shield","count":7}] },  // 总数 50
  7:  { type:'normal', enemies:[{"type":"basic","count":22},{"type":"ninja","count":12},{"type":"ghost","count":9},{"type":"octopus","count":9},{"type":"shield","count":13}] },  // 总数 65
  10:  { type:'normal', enemies:[{"type":"basic","count":24},{"type":"ninja","count":14},{"type":"ghost","count":11},{"type":"octopus","count":11},{"type":"shield","count":20}] },  // 总数 80
  13:  { type:'normal', enemies:[{"type":"basic","count":24},{"type":"ninja","count":17},{"type":"ghost","count":13},{"type":"octopus","count":13},{"type":"shield","count":28}] },  // 总数 95
  16:  { type:'normal', enemies:[{"type":"basic","count":25},{"type":"ninja","count":19},{"type":"ghost","count":14},{"type":"octopus","count":14},{"type":"shield","count":38}] },  // 总数 110
  2:  { type:'crisis', enemies:[{"type":"basic","count":14},{"type":"summoner","count":7},{"type":"ninja","count":5},{"type":"shield","count":5},{"type":"knight","count":3},{"type":"chest","count":3},{"type":"dragonhead","count":3}] },  // 总数 40
  5:  { type:'crisis', enemies:[{"type":"basic","count":16},{"type":"summoner","count":9},{"type":"ninja","count":6},{"type":"shield","count":6},{"type":"knight","count":6},{"type":"chest","count":6},{"type":"dragonhead","count":6}] },  // 总数 55
  8:  { type:'crisis', enemies:[{"type":"basic","count":18},{"type":"summoner","count":10},{"type":"ninja","count":8},{"type":"shield","count":8},{"type":"knight","count":10},{"type":"chest","count":8},{"type":"dragonhead","count":8}] },  // 总数 70
  11:  { type:'crisis', enemies:[{"type":"basic","count":18},{"type":"summoner","count":12},{"type":"ninja","count":9},{"type":"shield","count":9},{"type":"knight","count":15},{"type":"chest","count":11},{"type":"dragonhead","count":11}] },  // 总数 85
  14:  { type:'crisis', enemies:[{"type":"basic","count":16},{"type":"summoner","count":14},{"type":"ninja","count":10},{"type":"shield","count":10},{"type":"knight","count":20},{"type":"chest","count":15},{"type":"dragonhead","count":15}] },  // 总数 100
  17:  { type:'crisis', enemies:[{"type":"basic","count":14},{"type":"summoner","count":15},{"type":"ninja","count":11},{"type":"shield","count":11},{"type":"knight","count":26},{"type":"chest","count":19},{"type":"dragonhead","count":19}] },  // 总数 115
  // ===== Boss 关 =====
  6:  { type:'boss', boss:'face',   cardRarity:{ white:40, blue:30, purple:20, gold:10 } },
  12: { type:'boss', boss:'dragon', cardRarity:{ white:35, blue:30, purple:22, gold:13 } },
  18: { type:'boss', boss:'face',   cardRarity:{ white:35, blue:30, purple:22, gold:13 } },
};
