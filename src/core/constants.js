// 核心常量速查表 —— 数据来自 ima 知识库「WebXR 肉鸽打气球」
// 所有可调参数集中在此，方便平衡性调整。

export const MOVE = {
  SPEED: 3.5,        // 摇杆/键鼠 移动速度 m/s
  DEADZONE: 0.2,    // 摇杆死区
  BOUND_X: 2,       // X 轴移动边界 (米)
  BOUND_Z: 4,       // Z 轴移动边界 (米)
};

export const SHOOT = {
  COOLDOWN: 150,    // 射击冷却 ms
  BULLET_SPEED: 15, // 子弹速度 m/s
  BULLET_LIFE: 2,   // 子弹存活时间 s
  BULLET_POOL_SIZE: 20,
};

export const BALLOON = {
  HP: 100,
  SPEED: 0.5,       // 普通气球移动速度 m/s
  RADIUS: 0.5,
  SCORE: 10,
  DAMAGE: 5,        // 撞船伤害
};

export const SHIP = {
  MAX_HP: 100,
  POS: [0, 1.4, 0],     // 玩家视点高度（站在飞船篮子里）
  COLLISION_RADIUS: 2.5,
};

export const BUDDHA = {            // 如来神掌（大招）
  COOLDOWN: 8,
  KILL_RADIUS: 50,
  DAMAGE: 1000,
  FALL_DURATION: 0.5,
};

export const WAVE = {
  BASE_SPAWN_COUNT: 30,
  BATCH_INTERVAL: 1.0,
  BATCH_SIZE: 3,
  MAX_ACTIVE: 10,
  SPAWN_DISTANCE: 15,
  SPAWN_SPREAD: 8,
  // 分阶段：0s 仅前方；15s 前方+左右；30s 全方向
  PHASE2_AT: 15,
  PHASE3_AT: 30,
};

export const CARD = {
  COUNT: 3,                 // 每次抽卡展示数量
  REFRESH_BASE_COST: 20,    // 刷新基础积分，逐次翻倍
  DURATION: 15,             // 选项卡存在秒数（超时自动随机选）
  WIDTH: 0.5,
  HEIGHT: 0.3,
  SPACING: 0.8,             // 卡片沿 X 轴均匀间距 m
  // —— 固定世界坐标摆放（射击选卡版）——
  ROW_Z: -4,                // 卡片固定世界 Z（场地底边）
  ROW_Y: 2,                 // 卡片固定世界 Y（比原方案提高 1m）
  BALLOON_DY: 0.45,         // 气球在卡片上方偏移 m
  BALLOON_R: 0.18,          // 气球可被击中半径 m
  BALLOON_BOB: 0.06,        // 气球上下浮动幅度 m
  RESOLVE_DUR: 2,           // 其余卡/气球向上飞走耗时 s
  FLY_TOP_Y: 10,            // 其余卡/气球飞到该高度后消失
  LIGHT_DUR: 1.0,           // 选中卡化为光点飞向玩家耗时 s
  LIGHT_SIZE: 0.02,         // 光点粒子尺寸（小粒子）(m)
  STREAM_SPREAD: 0.6,       // 50 粒错峰出发的总铺开时长(s)，形成数据流而非齐射
};

// 第三关「激光气球」参数（供 laser.js 引用，便于平衡）
export const LASER = {
  SPAWN_DELAY: 10,   // 生成期总时长(s)：气球前7s一对对出现 + 激光后3s一对对淡入（NPC交待窗口）
  BALLOON_SPAWN: 7,  // 生成期内：气球逐对出现时长(s)，4对均分
  LASER_SPAWN: 3,    // 生成期内：激光束逐对淡入时长(s)，4对均分
  LAUNCH_DUR: 6,     // 驱赶动画时长(s)：气球从起始端移到另一端（原2s，降到1/3速度）
  ROW1_DELAY: 1,     // 发射到位后多久第一排动画 (s)
  ROW2_DELAY: 3,     // 第一排后多久第二排 (s)
  ROW3_DELAY: 3,     // 第二排后多久第三排 (s)
  GOAL_Z: -3.5,      // 玩家 z 到达此值即过关（底边）
  BEAM_LETHAL_R: 0.15, // 激光光束致命半径（含辉光余量）(m)
  PLAYER_R: 0.4,     // 玩家在激光关的碰撞半径 (m)
  BALLOON_R: 0.4,    // 激光气球实体致命半径 (m)
  HOLD_DUR: 10,      // drive 模式：驱赶到位后保持原地（仍致命）的秒数
};

// 第九关「玻璃走格子」参数（供 glassGrid.js 引用，便于平衡）
export const GRID = {
  COLS: 4, ROWS: 8,        // 4×8 = 32 格
  CELL: 1,                 // 每格 1m
  Y: 0.11,                 // 玻璃格顶面高度（略高于边界盒 0.10，避免 z-fighting）
  NUM_Y_OFFSET: 0.06,      // 编号平面高出玻璃顶面的距离，防 z-fighting
  NUM_SIZE: 0.5,           // 编号平面边长 = 1m 格子的 1/2 边长 → 占 1/4 面积（"占据1/4大小"按面积解；可调）
  GLASS_COLOR: 0x9fe8ff,   // 淡青光玻璃
  GLASS_GLOW: 0x33ff99,    // 正确格发光色（淡绿，保持原地期脉冲）
  TRANSMISSION: 0.92,      // 玻璃透射（MeshPhysicalMaterial.transmission）
  CORRECT: [3,7,9,10,11,12,13,17,18,22,23,27,29,30,31,32], // 用户指定正确格（安全格）
  WIN_CELL: 3,             // 走到此格通关
};

// 稀有度配置：权重、颜色、倍率
export const RARITY = {
  white:  { name: '普通', weight: 60, color: '#dfe6e9', mult: 1 },
  blue:   { name: '稀有', weight: 25, color: '#4dabf7', mult: 1 },
  purple: { name: '史诗', weight: 10, color: '#b197fc', mult: 1 },
  gold:   { name: '传说', weight: 5,  color: '#ffd43b', mult: 1 },
};
