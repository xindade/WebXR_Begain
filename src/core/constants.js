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
  BULLET_SPEED: 15, // 子弹速度 m/s（子弹飞行速度）
  BULLET_LIFE: 2,   // 子弹存活时间 s
  BULLET_POOL_SIZE: 20,

  // ===== 子弹外观与出膛（随时可调，改完刷新页面即生效）=====
  BULLET_RADIUS: 0.02,   // 子弹球体半径 m（越大越粗）

  // ===== 右手柄射线 / 子弹方向俯角（VR 手持 AK 枪用）=====
  // 手柄默认瞄准方向是本地 -Z（正前方）。绕 X 轴旋转此角度调整俯仰：
  //   负值 = 枪口向下压（射线向下倾斜），正值 = 向上抬。默认 -27°。
  // 射线与子弹方向共用同一俯角，保证「所见即所打」。
  RIGHT_PITCH_DEG: -27,

  // 子弹出生点：从手柄原点沿「已俯仰后的瞄准方向」前移的距离 m（模拟枪口位置）。
  // 0 = 从手柄中心射出；调大 = 出生点更靠前（贴近枪口）。
  SPAWN_OFFSET: 0.5,

  // ===== 右手柄射线视觉 =====
  RAY_COLOR: 0xff2222,   // 右手射线颜色（红）
  RAY_LENGTH: 5,         // 射线可见长度 m
  RAY_COLOR_LEFT: 0x66ccff, // 左手射线颜色（青，保持原样）
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

export const EXPLOSION = {        // 气球进入4×8区域自爆特效
  DURATION: 0.4,       // 爆炸动画时长 s
  MAX_SCALE: 2.5,      // 最大缩放倍数（相对气球半径）
  START_OPACITY: 0.7,  // 起始不透明度
  COLOR: 0xff6b3d,     // 爆炸颜色（橙红）
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
  CORRECT: [3,7,9,10,11,12,13,17,18,22,23,27,29,30,31,32], // 用户指定正确格（安全格）
  WIN_CELL: 3,             // 走到此格通关
};

// 第十五关「九宫格翻转射击」参数（供 flipGrid.js / laser.js / game.js 引用）
export const FLIP = {
  HOLD_DUR: 2,              // flip 模式：驱赶到位后保持原地(仍致命)秒数；第九关 drive 为 10
  COUNTDOWN: 180,           // 安全解谜期总时长(秒)：解出→抽卡，归零→直接下一关(不抽卡)
  COLS: 3, ROWS: 3,        // 3×3 = 9 格
  CELL: 1,                 // 每格 1.0m
  BASE: { x: 0, y: 2.25, z: -3 },  // 九宫格底边中心（世界坐标；group.position.z=-3）
  BALLOON_R: 0.75,         // 气球视觉半径 m（×1.5 放大）
  BALLOON_OFFSET_Z: 0.525, // 气球相对格中心沿 +z 凸向玩家的偏移（白=前/黑=后同此值，×1.5）
  WALL_WIDTH: 4.5,         // 整墙 4.5m 宽（×1.5）
  WALL_HEIGHT: 4.5,        // 整墙 4.5m 高（y≈2.25~6.75，×1.5+下移1米）
  FLIP_DUR: 0.5,           // 单格翻转动画时长 s
  VICTORY_DUR: 1.0,        // 胜利闪烁后消失时长 s
  HIT_R: 0.75,              // 子弹命中判定半径（≈气球半径，×1.5 同步放大）
  RESET_X: 3.5,             // 重置气球 X 坐标（九宫格右侧，留0.5m间隙）
  // 初始布局：0=白(前显白),1=黑(前显黑)，行从上到下(row0 顶 ~ row2 底)
  //   右下角(行2,列2)显白，其余 8 格显黑（参考文档"方案一"4 步可解）
  INITIAL: [
    [1, 1, 1],
    [1, 1, 1],
    [1, 1, 0],
  ],
};

// 稀有度配置：权重、颜色、倍率
export const RARITY = {
  white:  { name: '普通', weight: 60, color: '#dfe6e9', mult: 1 },
  blue:   { name: '稀有', weight: 25, color: '#4dabf7', mult: 1 },
  purple: { name: '史诗', weight: 10, color: '#b197fc', mult: 1 },
  gold:   { name: '传说', weight: 5,  color: '#ffd43b', mult: 1 },
};

// ============================================================
// 右手柄 AK 枪模型挂载参数（随时可调，改完刷新页面即生效）
// 坐标系：相对右手柄(grip)本地坐标；右手柄默认朝 -Z 为「前方」
//   X = 右(玩家视角) / Y = 上 / Z = 前(负值更靠前)
// 上机后在 PICO 里看效果微调：枪口朝上就绕 X 转 -90°，偏左偏右调 Y，前后调 Z
// ============================================================
export const GUN = {
  MODEL_URL: 'Model/Ak枪.glb',                 // 模型路径（相对 index.html，项目根 Model 目录）
  POSITION: { x: 0.0, y: -0.25, z: 0.0 },       // 位置偏移（米）：x=右, y=上, z=前(负为更靠前)
  ROTATION: { x: -60,   y: 90,   z: 0   },       // 旋转（度，绕 XYZ）：模型默认朝向未知，上机后调
  SCALE:    0.5,                              // 整体缩放（模型过大/过小，先 1.0 看效果再调）
};

// ============================================================
// 手柄手腕 UI 面板放置参数（随时可调，改完刷新页面即生效）
//   - RIGHT：右手柄战斗信息面板（青色边框）
//   - LEFT ：左手柄日志面板（橙色边框）
// 坐标系：相对手柄(grip)本地坐标；右手柄默认朝 -Z 为「前方」
//   X = 右(玩家视角) / Y = 上 / Z = 前(正值更靠前)
//   SCALE 越大面板越大（物理尺寸 = Canvas 像素 / 1024 × SCALE，1px≈1mm）
//   ROTATION 为角度(度)，绕 XYZ；x 向下倾斜方便低头看手腕
// ============================================================
export const WRIST_UI = {
  RIGHT: {
    SCALE:    1 / 3,                          // 大小：物理尺寸缩放（1/3 ≈ 0.17m×0.17m）
    POSITION: { x: 0.1, y: -0.0167, z: 0.03 }, // 位置（米）：略低于手背、前移一点
    ROTATION: { x: -90, y: 0, z: 0 },       // 旋转（度）：向下倾斜约 34° 方便看
    BORDER:   '#00e5ff',                      // 边框颜色（青）
    CANVAS:   { w: 512, h: 512 },            // 画布分辨率（像素）：只影响清晰度，不影响物理大小
  },
  LEFT: {
    SCALE:    1 / 2,                          // 大小：放大 3 倍（比右手大，约 0.25m×0.125m）
    POSITION: { x: 0.0, y: -0.025, z: 0.045 }, // 位置（米）：略低于手背、前移一点
    ROTATION: { x: -34, y: 0, z: 0 },       // 旋转（度）：向下倾斜约 34°
    BORDER:   '#ff7a00',                      // 边框颜色（橙）
    CANVAS:   { w: 512, h: 256 },            // 画布分辨率（像素）：只影响清晰度
  },
};

