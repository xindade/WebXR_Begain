// 核心常量速查表 —— 数据来自 ima 知识库「WebXR 肉鸽打气球」
// 所有可调参数集中在此，方便平衡性调整。

// 全景天空：按关卡号 lv.n 映射本地 360° 全景图（equirectangular，2:1，4096x2048 JPG）。
// 全部 18 关均用对应编号全景图作天空盒（替代原渐变天空），进关即懒加载（world.setSkyPanorama）。
// 图片均由原始 8K PNG 离线压缩为 4K JPG（Sky/sky-01.jpg ~ sky-18.jpg），单张 0.5~1.5MB，远省带宽/显存。
// 朝向偏航由 PANO_DOME_YAW 统一控制（默认 π/2：把 360 照片正前(图中心 u=0.5)对齐玩家初始朝向 -Z）。
export const SKY_PANORAMA = {
  1:  'Sky/sky-01.jpg',  // 第1关（清晨小怪）
  2:  'Sky/sky-02.jpg',  // 第2关（微光夜晚·危机）
  3:  'Sky/sky-03.jpg',  // 第3关（机制·激光）
  4:  'Sky/sky-04.jpg',  // 第4关（双马白天）
  5:  'Sky/sky-05.jpg',  // 第5关（极光夜晚·危机）
  6:  'Sky/sky-06.jpg',  // 第6关（水墨·脸谱Boss）
  7:  'Sky/sky-07.jpg',  // 第7关（巨鲲白天）
  8:  'Sky/sky-08.jpg',  // 第8关（巨型月夜晚·危机）
  9:  'Sky/sky-09.jpg',  // 第9关（机制·激光）
  10: 'Sky/sky-10.jpg',  // 第10关（彩虹白天）
  11: 'Sky/sky-11.jpg',  // 第11关（雷云闪电·危机）
  12: 'Sky/sky-12.jpg',  // 第12关（晴空环形云·龙Boss）
  13: 'Sky/sky-13.jpg',  // 第13关（棉花糖）
  14: 'Sky/sky-14.jpg',  // 第14关（台风黑夜·危机）
  15: 'Sky/sky-15.jpg',  // 第15关（机制·激光九宫格）
  16: 'Sky/sky-16.jpg',  // 第16关（天梯白天）
  17: 'Sky/sky-17.jpg',  // 第17关（天梯夜晚·危机）
  18: 'Sky/sky-18.jpg',  // 第18关（空中堡垒·脸谱Boss）
};

// 全景穹顶球绕 Y 的偏航（弧度）：让 360 照片的"正前(图中心 u=0.5)"对齐玩家初始朝向(-Z)。
// 原理：three.js SphereGeometry 默认 UV 下，贴图中心列(u=0.5)落在世界 +X（玩家右侧），
// 右 1/4(u=0.75) 落在 -Z（正前）。旋转 +π/2 把图中心转到正前。
// 若头显里城堡不在正前方：左右偏差约 ±π/2、背后则 ±π，调此值刷新即生效（同时影响 3/12/15 关天空，但皆为对称天空无影响）。
export const PANO_DOME_YAW = Math.PI / 2;

// 渲染分辨率系数（WebXR 帧缓冲缩放）：1.0=最稳，1.25=更清晰但更费 GPU，1.5 易掉帧。
// PICO 4 双目高分辨率下 1.0 最稳；若某关流畅可热调到 1.25 提清晰度（userConfig.RENDER 可调）。
export const RENDER = { FRAMEBUFFER_SCALE: 1.0 };

// 全景天空亮度倍率（天地朝向已确认正确，只调亮度用）。
// 1.0 = 原样；<1 = 变暗；>1 = 变亮。改完刷新页面即生效。
export const SKY_BRIGHTNESS = 1.0; // 全景天空亮度倍率（JPG 等距柱状全景）。1.0=原样；<1 变暗；>1 变亮。刷新即生效。

// 全景天空 mipmap 开关（用于一键回退）：
// false = 关闭 mipmap（省约一半显存带宽 + 去掉切换关时的 mip 生成单帧尖峰卡顿，推荐）；
// true  = 回退到原行为（生成 mipmap，远景更平滑但带宽/卡顿更重）。改完刷新页面即生效。
export const SKY_PANO_MIPMAPS = false;

export const MOVE = {
  SPEED: 3.5,        // 摇杆/键鼠 移动速度 m/s
  DEADZONE: 0.2,    // 摇杆死区
  BOUND_X: 2,       // X 轴移动边界 (米)
  BOUND_Z: 4,       // Z 轴移动边界 (米)
};

export const SHOOT = {
  COOLDOWN: 60,     // 射击冷却 ms（60 ≈ 16 发/秒，原 150）
  BULLET_SPEED: 15, // 子弹速度 m/s（子弹飞行速度）
  BULLET_LIFE: 2,   // 子弹存活时间 s
  BULLET_POOL_SIZE: 500, // 同时存在的子弹上限（InstancedMesh 单 Draw Call 承载）

  // ===== 子弹外观与出膛（随时可调，改完刷新页面即生效）=====
  BULLET_RADIUS: 0.02,   // 子弹球体半径 m（越大越粗）
  BULLET_COLOR: 0xffe066, // 子弹颜色（MeshBasicMaterial，发光黄，不吃光照）

  // ===== 多重射击 / 霰弹（player.fire 扇形散射）=====
  SPREAD_COUNT: 3,    // multiShot 触发时额外发射的扇形子弹数
  SPREAD_ANGLE: 0.18, // 扇形半角（弧度，约 10°），横向铺开割草

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

  // —— 命中判定几何（仅 DepthSprite 2D立绘怪生效；3D模型怪走真实包围球，不受这两项影响）——
  // 立绘怪是永远朝相机的扁平卡片，命中体积是一个「竖薄板盒子」：
  //   范围大小(左右=上下半径) = effectiveRadius × tune.scale × extraScale × DEPTH_SPRITE_HIT_MUL + HIT_PAD
  //   前后(朝相机方向)         = HIT_SLAB_DEPTH（卡片正前+正后各这么多米的容差）
  //   整体命中盒 = 宽=2×范围半径，高=2×范围半径，厚=2×HIT_SLAB_DEPTH
  HIT_PAD: 0.05,       // 【上下/左右】命中半径额外填充（米）：叠加在「范围半径」之外的容差；调小→更贴合，0=完全贴合
  HIT_SLAB_DEPTH: 0.4, // 【前后】2D立绘命中板厚（米）：卡片朝相机方向正前+正后各容差；调小→收紧前后误判
};

// 枪械模式（预览界面按钮切换）：preview=初始态，full=满状态（点击按钮进入游戏）
// shotCount = 每发子弹的弹道数（player.fire 确定性扇形），cooldown = 射击冷却 ms（input.js 节流）
export const GUN_MODES = {
  preview: { shotCount: 1, cooldown: 500 },  // 1 弹道 / 2 发每秒
  full:    { shotCount: 5, cooldown: 100 },  // 5 弹道 / 10 发每秒
};

// 积分散射技能（前期默认技能）：消耗积分，从枪口喷出 COUNT 弹头，轴向 DIST 米处铺成半径 RADIUS 圆盘
export const SCATTER = {
  COST: 500,          // 释放消耗积分（积分 <COST 时不释放、不进冷却）
  COUNT: 50,          // 弹头数量
  DIST: 9,            // 轴向距离（米）：弹头圆盘中心在枪口前方此距离处
  RADIUS: 3,          // 圆盘半径（米）：9 米轴向处铺成此半径圆盘
  COOLDOWN: 0.5,      // 释放后冷却（秒）
  DAMAGE: 0,          // 每发伤害（0=复用 player.atk）
  SPREAD_DISC: true,  // true=实心圆盘(面积均匀)；false=仅圆周
};

// 散射强化（第3关技能卡 scatterburst）：一次性喷出 COUNT 发、每发 DAMAGE 伤害，消耗走 player.skillCost
export const SCATTER_BURST = {
  COUNT: 100,         // 一次性弹头数量
  DAMAGE: 100,        // 每发伤害（×player.skillDamageMul 倍率）
  COOLDOWN: 1.0,      // 释放后冷却（秒，仅作 HUD 显示；用后回落到默认积分散射）
  DIST: 9,            // 轴向距离（米）：弹头圆盘中心在枪口前方此距离处
  RADIUS: 3,          // 圆盘半径（米）
  SPREAD_DISC: true,  // 实心圆盘
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
  COOLDOWN: 8,                     // 释放冷却 s
  HIT_MARGIN_XY: 1.3,             // 命中盒 XY 放大系数：以掌图平面半宽/半高为基准再乘该系数（1=完全贴合掌面）
  HIT_Z_BAND: 8,                  // 命中盒 Z 半厚（米）：掌图作「横扫墙」，仅命中其当前 Z 前后 ±HIT_Z_BAND 内的敌人（沿 +Z 扫过逐步清场）
  DAMAGE: 200,                     // 命中盒内单体基础伤害（×player.skillDamageMul 倍率），消耗 player.skillCost
  // —— 视觉参数（基于透明 PNG 贴图） ——
  TEXTURE_URL: 'assets/buddha-palm.jpg', // 贴图路径（相对 index.html）；若原图为 PNG 可换 .png
  COLOR_KEY_THRESHOLD: 0.92,       // 白底剔除阈值：R/G/B 均大于 0.92×255 的像素变透明（0~1，越低越激进）
  PLANE_WIDTH: 4.0,                // 平面宽度（米），贴图原始宽高比 2:3 左右
  PLANE_HEIGHT: 6.0,               // 平面高度（米）
  START_POS: { x: 0, y: 0, z: -30 }, // 出现位置（世界坐标）
  END_POS:   { x: 0, y: 0, z:  30 }, // 移动终点（世界坐标）
  START_SCALE: 1.0,                // 初始缩放倍数
  END_SCALE: 10.0,                 // 最终缩放倍数（10 倍）
  GROW_TIME: 1.0,                  // 原地放大总时长 s（1 秒内分两段变化：1→中间→10）
  MOVE_TIME: 1.0,                  // 沿 +Z 移动时长 s
  PAUSE_TIME: 1.0,                 // 到达终点后停顿 s
  FADE_TIME: 0.3,                  // 淡出消失时长 s
};

// 激光剑（左手柄近战武器，由「金箍棒」技能改造而来）
// 选卡装备后常驻左手柄；按左手柄 grip 激活「5 秒伤害状态」，期间左手自由挥动，
// 剑刃线段扫过怪物即扣血，每只怪 1 秒内只受一次。位置/旋转/缩放/伤害均可热调。
export const LASER_SWORD = {
  MODEL_URL:  'Model/激光剑.glb',           // 模型路径（相对 index.html，项目根 Model 目录）
  POSITION:   { x: 0.0, y: 0.0, z: 0.0 },  // 相对左手柄(grip)本地坐标（米）
  ROTATION:   { x: 0, y: 0, z: 0 },        // 旋转（度，绕 XYZ）：模型默认朝向未知，上机后调
  SCALE:      1.0,                          // 整体缩放（过大/过小先 1.0 看效果再调）
  BLADE_AXIS: { x: -1, y: 0, z: 0 },       // 剑刃方向（root 本地轴）：GLB 解析真实刃长轴=本地 X（extent 1.1994m）；配 ROTATION.y:270 映射到世界前向，与可见剑刃一致
  BLADE_LENGTH: 1.2,                        // 剑刃本地长度（米）；命中线段 = ×SCALE(4.0)=4.8m，与可见剑刃一致
  DAMAGE:     400,                          // 笔记：激光剑单次命中伤害（×player.skillDamageMul 倍率），消耗 player.skillCost
  DURATION:   5,                            // 激活后伤害状态持续秒数
  COOLDOWN:   5,                            // 激活后复用冷却秒数（HUD 显示）
  COST:       500,                          // 消耗积分
  // —— 释放缩放动画参数（未释放=base×IDLE；释放时放大到 base）——
  SWORD_IDLE_SCALE: 0.1,   // 未释放视觉缩放 = SCALE × 此值（0.1 = 缩小10倍）
  SWORD_GROW_TIME:  0.5,   // 第一段放大时长(s)：0.5s 内放大 GROW_STEP 倍
  SWORD_GROW_STEP:  5.0,   // 第一段放大倍数（字面 5 倍：idle 0.1 → 0.5）
  SWORD_HOLD:       0.2,   // 两段之间停顿(s)
  SWORD_GROW2_TIME: 0.5,   // 第二段放大时长(s)
  SWORD_GROW2_STEP: 2.0,   // 第二段放大倍数：0.5×2=1.0=回到 base（想更大改 5.0 → 最终 base×2.5）
  SWORD_SHRINK_TIME:0.6,   // 结束/卸下时反向缩回 idle 的时长(s)
};

// 积分上限：玩家持有积分不超过此值（≈一次技能释放机会，因技能消耗 player.skillCost=500）。改此值即调上限。
export const SCORE_CAP = 500;

// 输入/控制器：设备相关校准（不同头显手柄 handedness 上报可能相反）
export const INPUT = {
  // 枪/剑绑定手交换开关。默认 false=不交换（枪挂右手柄、剑挂左手柄，子弹始终从右手发射）。
  // 若某台设备出现「枪在左手、剑在右手」，改为 true 交换枪/剑绑定手。
  SWAP_HANDS: false,
};

// 测试工具（仅开发/调试用，正式上线把 ENABLED 改 false 即可整体关掉）
export const TEST = {
  ENABLED: true,          // 总开关：false 关闭所有测试快捷键（左手 X / 桌面 G）
  ADD_SCORE: 500,         // 按一次测试积分键赠送的积分数（走 _addScore，受 SCORE_CAP 上限裁剪→恰好满一格技能）
  VR_BUTTON_LEFT_X: true, // 说明用：左手柄 X 键(buttons[4])触发积分
  DESKTOP_KEY_G: true,    // 说明用：桌面 G 键触发积分
};

export const FREEZE = {           // 定身咒（暂停所有敌人行动，Boss 减半）
  DURATION: 5,                    // 小怪定身总时长 s
  BOSS_FACTOR: 0.5,               // Boss 定身时长系数：0.5 → Boss 只定身 DURATION*0.5 秒
  COOLDOWN: 8,                    // 释放冷却 s（与 BUDDHA 对齐）
};

export const WAVE = {
  BASE_SPAWN_COUNT: 30,
  BATCH_INTERVAL: 1.0,
  BATCH_SIZE: 3,
  MAX_ACTIVE: 10,
  SPAWN_DISTANCE: 15,
  SPAWN_SPREAD: 8,
  // 分阶段：0s 仅前方；20s 前方+左右；40s 全方向（配合60s关卡时长，各占1/3）
  PHASE2_AT: 20,
  PHASE3_AT: 40,
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
  // 卡面竖版（PNG 长边 1024，宽 578，aspect ≈ 0.564）
  WIDTH: 0.4,
  HEIGHT: 0.71,
  SPACING: 0.75,            // 卡片沿 X 轴均匀间距 m（卡窄了，略紧）
  // —— 固定世界坐标摆放（射击选卡版）——
  ROW_Z: -4,                // 卡片固定世界 Z（场地底边）
  ROW_Y: 2,                 // 卡片固定世界 Y（比原方案提高 1m）
  // 气球相对卡牌平面抬多高、细绳自身多长：二者独立可调（线长应略小于高度，使线底端落在卡面；若相等则线正好接卡牌中心）
  BALLOON_HEIGHT: 0.7,     // 气球（气球组）相对卡牌平面的竖直高度(m)：越大气球离卡牌越远
  BALLOON_STRING_LEN: 0.35, // 细绳自身长度(m)：从气球中心向下连到卡牌的线长（与气球高度独立，单独调线长短/松紧）
  BALLOON_R: 0.18,          // 气球可被击中半径 m
  BALLOON_BOB: 0.16,        // 气球上下浮动幅度 m（上下晃多高）
  BALLOON_BOB_FREQ: 1.5,    // 气球上下浮动频率(Hz)：每秒摆动次数，越大晃得越快
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

  // ===== 后坐力（仅作用于右手柄枪模型，不影响射击/碰撞/血量）=====
  // 设计目标：射速越快 → 后坐力「高频次」(每次开火都踢一下) 但「单发幅度变小」，
  // 使得整体抖动幅度反而更小（快射时是细密小抖，慢射时是大而稀的顿挫）。
  // 幅度由当前射击冷却(input._gunCooldown) 归一化映射：preview(500ms)=最慢→最大，full(100ms)=最快→最小。
  RECOIL: {
    ENABLED: true,
    MAX_BACK:   0.045,   // 最慢射速时单发「沿本地 +Z 后退」位移上限（米），约一手枪后坐
    MIN_BACK:   0.011,   // 最快射速时单发后退位移下限（细密小抖）
    MAX_PITCH:  0.16,    // 最慢射速时单发「绕本地 X 上抬(枪口跳)」角上限（弧度，≈9°）
    MIN_PITCH:  0.04,    // 最快射速时单发上抬角下限（≈2.3°）
    DECAY:      0.80,    // 每帧(60fps基准)回正系数，越小回正越快、抖得越短促
    CURVE:      1.5,     // 射速→幅度映射曲率(>1 让快射时幅度掉得更陡，强化「整体变小」)
  },
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

// ============================================================
// 第十二关「龙 Boss」参数（dragonLevel.js 引用）
//   龙头 = Model/龙头.glb（沿路径跟随移动）；龙身/龙爪 = 由敌人气球组成（默认 basic）
//   运动数据来自 ANIM_URL 的 JSON（schemaVersion 2，字段见 dragon-anim.json）
//   —— 换同格式文件 = 改 ANIM_URL 一行即可「一键套用」（如 dragon-anim-v2.json）
//   坐标系：数据为「世界中心」右手系、Y 向上、单位米；通过 SCALE 缩放 + HOME 平移贴合战场
// ============================================================
export const DRAGON = {
  ANIM_URL:   'Model/dragon-anim.json',   // 运动数据 JSON（相对 index.html；换文件只改这里）
  HEAD_MODEL: 'Model/龙头.glb',           // 龙头 GLB 模型（本地 Model/ 下已有；若之后换灭世龙头需先把文件放入 Model/ 并改此处）

  SCALE: 0.08,                            // 数据坐标 → 世界坐标缩放（越大龙越大；0.08≈体长27m、绕玩家盘旋）
  HOME:  { x: 0, y: 0, z: 0 },           // 龙「包围盒中心」落在：玩家正前方 9m、上方 4m 处（前方为 -Z）。即整条龙的整体位置
  YAW:   90,                               // 整体绕Y旋转(度)：修正龙的「水平朝向」偏差（数据系与游戏系转角差）
  PITCH: 0,                               // 整体绕X旋转(度)：修正龙的「俯仰」偏差
  ROLL:  0,                               // 整体绕Z旋转(度)：修正龙的「翻滚」偏差
  // ↑ 三轴组成全局刚体旋转，头/身/爪一起绕 HOME 转动；线下手动调这三个值对齐数据系与游戏系

  BODY_TYPE: 'dragonBody',               // 龙身「圆柱段」气球类型：黑红程序化几何体（见 enemies.dragonBody）
  CLAW_TYPE: 'dragonBody',               // 龙爪气球类型（同上，黑红圆柱）
  BODY_COUNT: 24,          // ① 龙身总段数（= 圆柱段 + 模型节点 总数；覆盖 JSON 里的 config.bodyCount）
  BODY_SPACING: 15,        // ① 相邻两段之间的「弧长间距」（越大龙身越长；覆盖 JSON 里的 config.bodySpacing）

  NODE_TYPE:  'dragonNode',              // ②/③ 模型节点气球类型（见 enemies.dragonNode）
  NODE_MODEL: 'Model/基础怪.glb',        // ②/③ 兜底默认模型（NODE_DEFS 里未写 model 时回退到它）
  // ②/③ 特殊模型节点：显式指定「出现在哪一段 + 用哪个模型 + 缩放 + 三轴旋转」
  //   at   : 节点所在「身体节号」（1..BODY_COUNT，1 = 紧挨龙头那节，BODY_COUNT = 尾节）
  //   model: 该节点挂载的小怪 GLB（可选模型见本文件末尾注释）
  //   scale: 相对身体半径的额外缩放（1.0 = 正常贴合；>1 更大，<1 更小）
  //   rot  : 三轴旋转 [绕X, 绕Y, 绕Z]（度）——模型节点保持竖直、不沿脊柱倾斜，纯做自身朝向微调
  // —— 默认 6 个节点（≈ pickEvenly(24,6)），全部用基础怪、scale=1、rot=0，保持原外观 ——
  NODE_DEFS: [
    { at: 1,  model: 'Model/基础怪.glb', scale: 1.0, rot: [0, 0, 0] },
    { at: 6,  model: 'Model/忍者.glb', scale: 1.0, rot: [0, 0, 0] },
    { at: 10, model: 'Model/幽灵.glb', scale: 1.0, rot: [0, 0, 0] },
    { at: 15, model: 'Model/骑士.glb', scale: 1.0, rot: [0, 0, 0] },
    { at: 19, model: 'Model/基础怪.glb', scale: 1.0, rot: [0, 0, 0] },
    { at: 23, model: 'Model/基础怪.glb', scale: 1.0, rot: [0, 0, 0] },
  ],
  // ③ 可选小怪模型清单（把 NODE_DEFS[].model 换掉即可；挑已跟踪的更稳）：
  //    Model/基础怪.glb   （默认，已跟踪）
  //    Model/召唤师.glb   （MODEL_TUNING.scale = 3.0，挂上会明显更大）
  //    Model/骑士.glb      （scale = 0.5，偏小）
  //    Model/心形怪.glb   Model/忍者.glb   Model/宝箱.glb   Model/幽灵.glb   Model/章鱼.glb
  //    Model/龙头.glb      （谨慎：本身就是龙头，套在身上略怪）
  //    —— 未跟踪、需先 `git add` 才能加载：Model/魔术师.glb、Model/变脸.glb ——
  //    —— 不推荐（细长/扁平道具经 fitToRadius 归一化会严重变形）：Ak枪/如来神掌/火焰/扇子/喇叭/魔术棒 ——
  CLAW_NODES: [7, 14],                     // 龙爪生成点（身体节号数组）：每个挂点左右各1爪 → 共4爪；增删挂点只改此数组

  HEAD_SCALE: 1.0,                        // 龙头模型额外缩放倍率（模型已按包围盒自动贴合身体尺寸，此项做微调）
  HEAD_YAW:   0,                          // 龙头模型自身前向轴修正(度)：在全局旋转之后，lookAt 路径切线时额外绕 Y 旋转
  HP_MULT:    1.0,                         // 龙气球血量倍率（>1 更肉，如 2.0 = 每节 200 血）

  // ===== 龙 Boss 行为可调参数 =====
  RESPAWN_DELAY: 1.0,                     // 龙身/龙爪被打破后「外形复活」延迟(s)：1秒后回到龙形，但不回血
  FINALE_INTERVAL: 0.07,                  // 死亡连爆：相邻气球爆炸间隔(s)（从尾到头逐个炸）
  IDLE_AMP: 0.45,                         // 暂停/待机时蛇形波动幅度(m)：幅度大，像盘旋呼吸
  MOVE_AMP: 0.18,                         // 移动时蛇形波动幅度(m)：更细微的流动感
  IDLE_FREQ: 2.2,                         // 蛇形波动频率
  PHASE_STEP: 0.55,                       // 每节相位差(弧度)：使波形沿龙身从头流到尾
};

// ============================================================
// DepthSprite 开关：用「运行时从 GLB 捕获的 2D 立绘 + 深度图」替 3D GLB 气球
//   DEPTH_SPRITE_MODE  : 总开关
//   DEPTH_SPRITE_TYPES : 白名单（先只基础怪）；扩到全类型即 ['basic','ninja','ghost','octopus','shield']
//   DEPTH_SPRITE_SCALE : 视差强度（沙盒校准值）
// ============================================================
export const DEPTH_SPRITE_MODE = true;
// 白名单：已扩到全部普通小怪（ghost 的隐身已让立绘跟随主体 visible，见 balloons.js）。
// 想单独压测某类型，把数组缩到该 id 即可。
export const DEPTH_SPRITE_TYPES = ['basic', 'ninja', 'shield', 'octopus', 'ghost', 'summoner', 'heart', 'chest', 'blackMaskClone'];
// 同屏压测：>0 时关卡启动后额外生成 N 个 basic 立绘同屏阵列（controlled 站定，仍可受击/视差）。
// 设 150 即「同屏 150 个 DepthSprite」压测；设 0 关闭。
export const DEPTH_SPRITE_STRESS = 150;
// 序列帧 idle：GLB 捕获时绕 Y 摆动取 frames 帧拼成 sheet；手绘 sheet 改映射里的 frameCount。
// 改 12 让「基础怪动画版」的骨骼动画采样更顺（动画版走 AnimationMixer 采样，非摆动）。
export const DEPTH_SPRITE_FRAMES = 12;
export const DEPTH_SPRITE_SWING = 0.18; // idle 摆动幅度(弧度)，绕 Y 小幅晃
// 正式手绘/离线素材映射：填了即走 loadDepthSpriteSheet 替运行时捕获。例：
// 'Model/基础怪.glb': { albedo:'assets/basic_albedo.png', depth:'assets/basic_depth.png', frameCount:8, cols:8, rows:1 }
export const DEPTH_SPRITE_HANDPAINTED = {}; // 清空即退回运行时 GLB 多帧捕获（basic 恢复 idle 摆动）
export const DEPTH_SPRITE_SCALE = 0.08;
// 立绘命中系数（范围大小的主旋钮）：captureGLB 用 45° 相机渲染，模型只占画幅 62.5%（相机距离按 0.8/tan(22.5°) 取景），
// 立绘纹理其余是透明留边。但命中半径按「整张贴图半幅」算，导致命中范围≈可见角色的 1/0.625≈1.6 倍。
// 这里把立绘命中半径 ×0.625（≈用户说的"缩小0.6倍"），折算取景留边，使命中等同可见角色。3D 模型怪不受影响。
// 用 let 以便 userConfig.DEPTH_SPRITE.HIT_MUL 单独覆盖（见文件末尾）。
export let DEPTH_SPRITE_HIT_MUL = 0.6;

// ============================================================
// 正常测试模式（NORMAL_TEST）：覆盖普通关出怪曲线
//   enabled = true 时，普通关走 _updateNormalTest()（升级式同屏出怪）
//   enabled = false 时，普通关走原 _updateLevel() 滴流出怪
//   DDA.enabled = true 时，在 normalTest 模式下由 DifficultyController 接管出怪
// ============================================================
export const NORMAL_TEST = {
  enabled: true,          // 开关：true 时普通关走压测出怪曲线
  startCount: 5,          // 初始同屏怪数
  rampInterval: 10,       // 每 N 秒加怪（DDA 关闭时的时间曲线）
  step: 2,                // 每次加多少
  peak: 40,               // 上限（DDA 关闭时）
  stopAt: 60,             // N 秒后停止补怪（每关限时1分钟）
  spawnCooldown: 1.2,     // 出怪间隔 s（DDA 关闭时）
  distance: 12,            // 出怪距离 m
  spread: 8,               // 出怪散布 m
  // 测试期间仅出基础怪；恢复全量改回 ['basic', 'ninja', 'octopus', 'shield', 'ghost', 'heart']
  pool: ['basic'],
};

// ============================================================
// DDA（Dynamic Difficulty Adjustment）动态难度
//   enabled = true 时，DifficultyController 根据玩家表现实时调整出怪
//   上限 70 同屏（PICO 4 / Adreno XR2 舒适区）
// ============================================================
export const DDA = {
  enabled: true,          // 开关：true 时由 DifficultyController 接管出怪
  maxConcurrency: 50,     // 同屏上限（测试期间降到50，仅基础怪）
  minConcurrency: 15,     // 同屏下限（提高初始出怪量，避免开局稀疏）
  difficultyStart: 0.5,   // 初始难度标量 (0..1)（提高开局出怪密度）
  killWindow: 10,          // 击杀率滑窗秒数
  smoothRate: 0.5,         // 难度平滑速率（越大越快跟随目标）
};

// ============================================================
// SPAWN_RING —— 玩家 DPS 基准 + 内外圈出怪调度（替换 DDA 击杀率滑窗）
//   基础出怪量 baseSpawn = clamp(DPS / DPS_DIVISOR × levelScale/LEVEL_BASE, MIN_BASE, MAX_BASE)
//   每 CHECK_INTERVAL 秒检查内圈存活数 → 查 RING_TABLE 得内圈系数 → 调整外圈配额
//   语义：内圈怪越少（玩家清得快）→ 系数越大 → 外圈出更多怪补足压力；放技能时系数=1
//   内圈 = 距场地中心(世界原点) 9m 圆（紧张区，离玩家近）；外圈 = 15m 圆（轻松区）
//   关卡常数 levelScale = LEVEL_BASE + (n-1)×LEVEL_INC（随关卡推进，玩家杀怪变快→增怪量）
//   （精英怪=5×普通：本版本暂不做，仅预留此注释；日后加 ENEMY_TYPES 精英变体即可）
// ============================================================
export const SPAWN_RING = {
  enabled: true,           // 总开关：true → 普通关走新调度；false → 回退现有 DDA/时间曲线
  INNER_RADIUS: 9,         // 内圈半径 m（紧张区）
  OUTER_RADIUS: 15,        // 外圈半径 m（轻松区）
  INNER_SPREAD: 3,         // 内圈出生散布 m（收窄，防怪横跨头顶）
  OUTER_SPREAD: 8,         // 外圈出生散布 m
  DPS_DIVISOR: 100,        // baseSpawn = DPS / 此值（调大 → 出怪更少）
  MIN_BASE: 4,             // baseSpawn 下限
  MAX_BASE: 40,            // baseSpawn 上限（对齐旧 DDA 同屏舒适区）
  INNER_RATIO: 0.5,        // 内圈初始配额占比（innerQuota = baseSpawn × 此值）
  INNER_CAP: 5,            // 内圈配额硬上限（对齐 RING_TABLE 索引 0..5）
  RING_TABLE: [2, 1.8, 1.6, 1.4, 1.2, 1], // 内圈存活 0..5 → 外圈系数（关卡常数=5 基准）
  CHECK_INTERVAL: 5,       // 每 N 秒检查一次内圈数量
  SKILL_CD_THRESHOLD: 3,   // 技能冷却 > 此值 → 判定「最近 5 秒释放过技能」（8-5=3）→ 系数=1
  REFILL_COOLDOWN: 0.3,    // 补怪滴流间隔 s（避免一次性涌出大量怪/光点）
  stopAt: 60,              // 停止补怪时间窗 s（对齐 NORMAL_TEST.stopAt；场上清空即通关）
  LEVEL_BASE: 5,           // 关卡常数基准（RING_TABLE 按此基准给出）
  LEVEL_INC: 0.5,          // 关卡常数随关卡推进增量：levelScale = LEVEL_BASE + (n-1)×LEVEL_INC
  pool: ['basic'],         // 出怪类型池（测试期仅基础怪；恢复全量改回 NORMAL_TEST.pool 列表）
};

// ============================================================
// 脸谱 Boss（第6/18关）— 单 Boss 多阶段循环
//   单 Boss 3000 HP + 95% 减伤，3 阶段循环（蓝→红→黑→蓝...）直到 HP 归零
//   每阶段 10s，变脸时换位置（前→左→右→前...）+ 清除子实体
//   击杀子实体扣 Boss 血量百分比（绕过减伤）
// ============================================================
export const FACE_BOSS = {
  // —— 通用 ——
  HP: 3000,
  DAMAGE_REDUCTION: 0.95,   // 直接射击减伤 95%（实际受击 = 伤害 × 5%）
  PHASE_DURATION: 15,       // 每阶段时长 s（前/中子阶段不变，多余时间给尾段动作）
  SCALE: 1.5,               // 主 Boss 体型（缩小一半，原 3；碰撞 effective=1.5*1.5=2.25m）
  RADIUS: 1.5,
  POSITIONS: [              // facePhase%3：0=蓝·前, 1=红·左, 2=黑·右
    [0, 2, -12],
    [-10, 2, 0],
    [10, 2, 0],
  ],
  MODELS: ['Model/蓝面脸谱.glb', 'Model/红面脸谱.glb', 'Model/黑面脸谱.glb'],
  FAN_MODEL: 'Model/京剧扇子.glb',

  // —— 子实体击杀 → Boss 扣血（× HP，绕过减伤）——
  KILL_FLAG_HP_PCT:   0.02,  // 旗子 2% = 60HP
  KILL_CLONE_HP_PCT:  0.01,  // 分身 1% = 30HP
  KILL_MINION_HP_PCT: 0.02,  // 小怪 2% = 60HP

  // —— 蓝色阶段：左右两侧各一个 3×3 召唤阵（中心格=骑士，其余=basic；阵型排在 Boss 前方朝玩家）——
  BLUE_FORMATION_ROWS: 3,       // 每侧阵型的行数（沿 Z 纵深，朝玩家递进）
  BLUE_FORMATION_COLS: 3,       // 每侧阵型的列数（沿 X 横向）；中心格(第2行第2列) = 骑士怪
  BLUE_FORMATION_COL_GAP: 2.5,  // 每侧阵型内：列间距(X) m
  BLUE_FORMATION_ROW_GAP: 2.5,  // 每侧阵型内：行间距(Z) m（朝玩家递进）
  BLUE_SIDE_OFFSET: 5,          // 左右两个侧阵中心，相对 Boss 的 X 距离 m（左 -X / 右 +X）
  BLUE_MINION_SPAWN_START: 2,   // 开始召唤 s（前段留空）
  BLUE_MINION_ACTIVE_START: 4,  // 小怪冲锋 + Boss 摆动 s（中段不变，尾段延至阶段末）
  BLUE_MINION_Y: [1, 2.5],      // 高度范围
  BLUE_SWAY_AMP: 1.5,           // Boss 摆动幅度 m
  BLUE_SWING_FREQ: 0.8,         // 摆动频率 Hz
  BLUE_MINION_BOB_AMP: 0.2,     // 子实体上下摆动幅度 m（与气球一致的悬浮感）
  BLUE_MINION_BOB_FREQ: 1.0,    // 子实体上下摆动频率 Hz

  // —— 红色阶段：旗子（变大3倍 + 公转半径5m）——
  RED_FLAG_COUNT: 5,
  RED_FLAG_SPAWN_START: 2,      // 旗子出现 s（前段留空）
  RED_FLAG_ORBIT_END: 6,        // 公转结束 s → 移到 Boss 上方、沿前后(Z)排列 + 自身绕 Z 轴逆时针转 90°
  RED_FLAG_LAUNCH_START: 8,     // 定位后开始飞向玩家 s（停在两侧展示 2s）
  RED_FLAG_LAUNCH_INTERVAL: 0.5,// 每批释放间隔 s
  RED_FLAG_LAUNCH_BATCH: 1,     // 每次释放的旗子数（两个一起冲）
  RED_FLAG_ORBIT_RADIUS: 5,    // 公转半径 m（大于 Boss 有效半径，不被遮挡）
  RED_FLAG_ORBIT_SPEED: 2,    // 公转角速度 rad/s
  RED_FLAG_FB_GAP: 3.0,         // 【转圈后·悬浮位置】前后(Z)排列间隔 m：相邻旗子沿 Z 的间距。偶索引→前(+Z)、奇索引→后(-Z)
  RED_FLAG_ABOVE_Y: 3.0,        // 【转圈后·悬浮位置】悬浮高度 m：旗子位于 Boss 中心上方多少（Y 偏移）
  RED_FLAG_PLACED_ROT_Z: Math.PI / 4, // 【转圈后·旋转角度】定位后旗子绕 Z 轴旋转弧度(π/2=逆时针90°)；改此即改旗子朝向，无需动代码
  RED_FLAG_Y: 2,
  RED_FLAG_HP: 200,
  RED_FLAG_SELF_DAMAGE: 5,
  RED_FLAG_SPEED: 8,          // 释放后冲向玩家速度
  RED_FLAG_RADIUS: 1.5,        // 碰撞半径（视觉3倍后同步，原0.5）
  RED_FLAG_SCALE: 3,          // 旗子视觉缩放（变大3倍，原1）

  // —— 黑色阶段：分身（体型缩小一半，原 scale 2→1）——
  BLACK_CLONE_MODEL: 'Model/黑面脸谱.glb',
  BLACK_CLONE_COUNT: 26,
  BLACK_CLONE_SPAWN_START: 2,
  BLACK_CLONE_SPAWN_END: 4,
  BLACK_CLONE_RING_RADIUS: 8, // 圆心(0,0,0) 半径 m
  BLACK_CLONE_Y: 1.5,
  BLACK_CLONE_HP: 120,
  BLACK_CLONE_SELF_DAMAGE: 2,
  BLACK_CLONE_CHARGE_START: 13,  // 冲锋 s（阶段末前 2 秒：13→15s 统一撞向玩家）
  BLACK_CLONE_CHARGE_SPEED: 6,   // 冲锋速度 m/s（分身原 speed=0，冲锋时必须给定）
  BLACK_CLONE_RADIUS: 1.0,
  BLACK_CLONE_SCALE: 1,          // 缩小一半（原2）
};

// ============================================================
// 传送门装饰（portal.js / game._spawnPortals 引用）
//   小怪关在场地中心前后左右各放 4 个传送门，可被左手摇杆整体操控：
//     左手 Y 轴（前推负）→ 4 门整体升降；左手 X 轴（右推正）→ 4 门整体远近（径向远离/收拢）
//   TARGET_HEIGHT / HEIGHT_Y 为独立参数：直接写最终值，与缩放倍数无推导关系
// ============================================================
export const PORTAL = {
  // —— 尺寸（独立参数，直接写最终米数；与缩放倍数解耦，可叠加）——
  TARGET_HEIGHT: 2.2,  // 门整体高度（米）：基准高度，独立参数
  SCALE: 1,            // 整体缩放倍数：在 TARGET_HEIGHT 基础上再整体放大/缩小（高宽厚一起）
                       //   1 = 按 TARGET_HEIGHT 原样；2 = 整体再大一倍；0.5 = 整体再小一半
  HEIGHT_Y: -2.6,      // 门中心离地高度（米）—— 注意：负值=中心在地面以下
  // 门距场地中心水平距离（米）：前/后门在 Z=±P，左/右门在 X=±P
  DISTANCE_P:   20,
  // 左/右门绕 X/Y/Z 三轴朝向（弧度）：模型正面默认朝玩家，侧门旋转面向场内
  //   左右门可分别指定；前/后门恒为 {x:0,y:0,z:0}
  ROT: {
    X: { LEFT: 0, RIGHT: 0 },                         // 绕 X 轴（弧度）
    Y: { LEFT: 0, RIGHT: 0 },                         // 绕 Y 轴（弧度）
    Z: { LEFT: Math.PI / 2, RIGHT: -Math.PI / 2 },    // 绕 Z 轴：左门逆时针90°/右门顺时针90°
  },

  // —— 上下浮动动画（纯装饰；数值标签显示用稳定值，不受浮动影响）——
  FLOAT_AMP:  0.1,   // 浮动幅度（米）：0.25 过大改轻微
  FLOAT_FREQ: 1.2,   // 浮动频率（Hz）

  // —— 每关传送门方向与数量（仅非 boss、非激光机制关生成；见 game._spawnPortals）——
  // 方向键：FRONT(前,-Z) BACK(后,+Z) LEFT(左,-X) RIGHT(右,+X)
  // 前几关固定布局；其余非机制/非Boss关从 RANDOM.POOL 随机抽 RANDOM.COUNT 个方向
  LEVEL_DIRS: {
    1: ['FRONT'],                     // 第1关：仅前门
    2: ['FRONT', 'LEFT'],             // 第2关：前+左
    4: ['FRONT', 'RIGHT'],            // 第4关：前+右
    5: ['FRONT', 'LEFT', 'RIGHT'],    // 第5关：前+左+右
    // 3/6/9/12/15/18 为激光或Boss关，由 isLaser/isBoss 跳过；其余关随机
  },
  RANDOM: {
    COUNT: 3,                         // 随机关传送门数量
    POOL: ['FRONT', 'BACK', 'LEFT', 'RIGHT'], // 随机抽选方向池
  },
};

// ============================================================
// 出怪光点（waves._queueSpawn 引用）——「怪物从传送门飞出」
//   普通关（有传送门）：每只怪在真正 spawn 前，从其最近传送门中心飞出一个光点
//   到出生点，落地后怪物才出现。Boss/激光关无传送门 → _queueSpawn 自动退化为
//   直接 spawn（视觉无变化）。龙 Boss / _spawnStress 不走此系统。
// ============================================================
export const PORTAL_BEAM = {
  ENABLED: true,          // 总开关：false 时所有 _queueSpawn 直接同步 spawn
  SPEED: 25,              // 光点飞行速度 m/s（门距出生点 18~32m → 时长 0.72~1.0s，接近 DDA cooldown）
  DUR_MIN: 0.25,          // 飞行时长下限 s（近门 clamp，防过短闪烁）
  DUR_MAX: 1.0,           // 飞行时长上限 s（远门 clamp，防节奏拖慢）
  START_Y_OFFSET: 3,      // 光点出发点相对门中心的上抬高度（米）：让光点从门上方飞出，视觉更明显
  Y_GAP_MAX: 6,           // 门中心与出生点 y 差距 > 此值(m) → 光点起点 y 向目标收敛（水平进场）
  COLOR: 0xff8a8a,        // 光点颜色（浅红）
  SIZE: 0.08,             // 光点球体半径 m
  OPACITY: 0.95,          // 光点不透明度（AdditiveBlending 叠加发光）
  // 类型范围开关（全部默认 true = 每只怪一个光点；单项 false = 该来源直接 spawn）
  // 注意：Boss 关无传送门，Boss 本体/子实体本就走无门兜底；此开关仅在 Boss 关也布门时生效。
  APPLY_SUMMON: true,     // 召唤怪小兵
  APPLY_FACE_SUB: true,   // 脸谱 Boss 子实体/旗子/克隆
};

// ============================================================
// 关卡开场「穿云」特效 + 出怪/动画延迟（cloudFx.js / game._loadLevel 引用）
//   每关开始先在玩家前方生成 COLS×ROWS 软雾团，整团向后飘 DRIFT_DUR 秒，
//   再「由前向后」缩短 SHRINK_DUR 秒（表现玩家突破云层），
//   期间冻结出怪与 Boss/机制动画，但场景(天空/传送门/激光几何/龙)已先出现。
//   总延迟 = INTRO_DELAY(默认 4s) = DRIFT_DUR(3) + SHRINK_DUR(1)，调参请保持此关系。
// ============================================================
export const CLOUD = {
  ENABLED:       true,    // 总开关：false → 跳过穿云与延迟，关卡直开
  COLS:          5,       // 横向(宽)雾团列数
  ROWS:          9,       // 纵深(前→后)雾团排数
  SPREAD_X:      14,      // 云雾总宽度（米）：越大越铺满视野
  DEPTH:         20,      // 云雾总纵深（米，沿玩家正前方向）
  FRONT_DIST:    0,       // 最前排距玩家的距离（米）：云在身前多远处起
  Y:             2.6,     // 云雾中心高度（米，约玩家眼高）
  Y_JITTER:      2.0,     // 单团高度随机抖动（米）：增加体积感
  PUFF_SIZE:     3.5,     // 单团基础尺寸（米）
  OPACITY:       0.95,     // 单团基础不透明度 0~1：越大越浓
  COLOR:         0xffffff,// 云雾颜色
  DRIFT_DUR:     3.0,     // 阶段1：整团向后飘动持续（秒）
  DRIFT_SPEED:   5.0,     // 阶段1：向后飘动速度（米/秒）
  SHRINK_DUR:    1.0,     // 阶段2：由前向后缩短持续（秒）
  INTRO_DELAY:   4.0,     // 关卡开场总延迟（秒）：普通关出怪 / Boss·机制关动画 延后至此才启动
};

// ============================================================
// 玩家参数覆盖（userConfig.js）—— 改动后刷新页面即生效
// 原理：本文件是依赖图叶子模块（无 import 业务模块），此合并先于所有消费方求值。
// 用户唯一编辑入口：src/core/userConfig.js（只写想改的键，其余保持默认）。
// ============================================================
import { USER_CONFIG } from './userConfig.js';

// 递归深合并：patch 为数组 → 整体替换；为对象 → 逐键合并；其余 → 覆盖
function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch;
  if (patch && typeof patch === 'object') {
    const out = { ...base };
    for (const k of Object.keys(patch)) out[k] = deepMerge(base?.[k], patch[k]);
    return out;
  }
  return patch !== undefined ? patch : base;
}

// 校验键名：拼错静默失效，此处给控制台提示（新增键也提示，忽略即可）
function _checkKeys(name, base, patch, path) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
  if (!base || typeof base !== 'object') return;
  for (const k of Object.keys(patch)) {
    if (!(k in base)) {
      console.warn(`[userConfig] ${name}.${path ? path + '.' : ''}${k} 不是有效配置键，未生效；请对照 constants.js 的 ${name} 检查拼写。`);
    } else {
      _checkKeys(name, base[k], patch[k], path ? `${path}.${k}` : k);
    }
  }
}

// 可覆盖对象白名单：只处理这 6 个；未来要加对象 → 此处加一行 + userConfig.js 加对应键
const _OVERRIDES = [
  ['PORTAL',  PORTAL,  USER_CONFIG.PORTAL],
  ['MOVE',    MOVE,    USER_CONFIG.MOVE],
  ['SHOOT',   SHOOT,   USER_CONFIG.SHOOT],
  ['BALLOON', BALLOON, USER_CONFIG.BALLOON],
  ['GUN',     GUN,     USER_CONFIG.GUN],
  ['WAVE',    WAVE,    USER_CONFIG.WAVE],
  ['PORTAL_BEAM', PORTAL_BEAM, USER_CONFIG.PORTAL_BEAM],
  ['SPAWN_RING', SPAWN_RING, USER_CONFIG.SPAWN_RING],
  ['LASER_SWORD', LASER_SWORD, USER_CONFIG.LASER_SWORD],
  ['BUDDHA', BUDDHA, USER_CONFIG.BUDDHA],
  ['RENDER', RENDER, USER_CONFIG.RENDER],
  ['CLOUD', CLOUD, USER_CONFIG.CLOUD],
  ['INPUT', INPUT, USER_CONFIG.INPUT],
  ['TEST', TEST, USER_CONFIG.TEST],
];
for (const [name, target, patch] of _OVERRIDES) {
  if (patch && typeof patch === 'object') {
    _checkKeys(name, target, patch);
    Object.assign(target, deepMerge(target, patch));
  }
}

// 立绘命中系数：允许在 userConfig.DEPTH_SPRITE.HIT_MUL 单独覆盖（它是独立常量，不入上面的对象白名单）
if (USER_CONFIG?.DEPTH_SPRITE?.HIT_MUL !== undefined) {
  DEPTH_SPRITE_HIT_MUL = USER_CONFIG.DEPTH_SPRITE.HIT_MUL;
  console.log('[userConfig] DEPTH_SPRITE.HIT_MUL 覆盖为', DEPTH_SPRITE_HIT_MUL);
}

// —— PORTAL 尺寸：TARGET_HEIGHT / HEIGHT_Y 为独立参数（与缩放解耦），直接按 userConfig 覆盖结果生效，
//    无需联动推导（SCALE/BASE_HEIGHT 已移除）。

