// ============================================================
// 玩家参数调节入口 —— 改完刷新页面即生效（无构建步骤）。
// 只写你想改的项；未列出的键保持游戏默认值。
// 键名拼错不生效，并会在控制台出现 [userConfig] 警告（对照 constants.js 检查拼写）。
// 原理：constants.js 末尾会 import 本文件并深合并覆盖对应对象。
// ============================================================
export const USER_CONFIG = {
  // ==================== 开场魔术师模型（第3/9/15关机制关）位置与缩放 ====================
  // 三关默认同值；只写想改的关。pos=[x,y,z]（米，Z负=玩家前方），scaleHeight=目标身高（米）。
  OPENING_MAGICIAN: {
    3:  { pos: [0, 5.4, -10], scaleHeight: 3.0 },   // 第3关 · 激光搭阵
    9:  { pos: [0, 6.4, -10], scaleHeight: 4.0 },   // 第9关 · 玻璃走格子
    15: { pos: [0, 7.4, -10], scaleHeight: 5.0 },   // 第15关 · 九宫格翻转
    SHOW_SECONDS: 10,   // 循环播放时长（秒）；也是语音联动的兜底上限
    FOLLOW_VOICE: true, // 机制关开场语音播完，魔术师同步消失（动画与语音对齐）
  },

  // ==================== 左手腕信息提示框（战斗信息）位置 / 旋转 / 大小 ====================
  // 当前左手柄显示战斗信息（关卡/船血/分数 + 龙Boss血条 + 攻/射/额外射击）。
  // 位置/旋转单位同 constants.WRIST_UI：POSITION 米(相对左手柄本地坐标 +X右/+Y上/+Z朝前)，
  // ROTATION 度(绕本地XYZ，x负=面板下倾便于看手腕)。只调想改的键。
  WRIST_UI: {
    LEFT: {
      SCALE:    1 / 3,                          // 大小：1/3 ≈ 0.167m×0.167m
      POSITION: { x: 0.0, y: -0.025, z: 0.045 }, // 位置（米）：x=0(手腕居中) / y=-0.025(略低于手背) / z=0.045(略朝前)
      ROTATION: { x: -45, y: 0, z: 0 },       // 旋转（度）：x=-34°(俯仰下倾) / y=0(无偏航) / z=0(无翻滚)
      BORDER:   '#ff7a00',                      // 边框颜色（橙）
      CANVAS:   { w: 512, h: 512 },            // 画布分辨率（像素）
    },
    // RIGHT 现由技能提示框(skillHint)占用、面板隐藏；参数保留以备切换/复用
    RIGHT: {
      SCALE:    1 / 3,
      POSITION: { x: 0.1, y: -0.0167, z: 0.03 },
      ROTATION: { x: -90, y: 0, z: 0 },
      BORDER:   '#00e5ff',
      CANVAS:   { w: 512, h: 512 },
    },
  },

  // ==================== 技能就绪提示（右手枪中央）位置与闪烁 ====================
  // 积分达标时红框闪 FLASH_COUNT 下后常亮；释放技能且积分再次达标再闪。仅调想改的键。
  SKILL_HINT: {
    SCALE: 0.4,
    POSITION: { x: 0.119, y: -0.057, z: -0.018 },
    ROTATION: { x: -90, y: 0, z: 0 },
    CANVAS: { w: 512, h: 320 },
    FLASH_COUNT: 3,
    FLASH_ON: 0.18,
    FLASH_OFF: 0.12,
    FLASH_BORDER: '#ff3b30',
    READY_BORDER: '#ffd24a',
    COOLDOWN_BORDER: '#ff7a00',
    COOLDOWN_BAR_COLOR: '#ff9d2e',
    COOLDOWN_BG: 'rgba(255,255,255,0.15)',
    INSUFFICIENT_BORDER: '#8a93a6',
    INSUFFICIENT_TEXT: '#cfd6e4',
    IDLE_BORDER: '#5a6b85',
    DEBUG:           false,              // 调试模式：左手柄摇杆(前后左右)+X/Y键(上下)微调位置（调完改 false）
    DEBUG_STEP:      0.5,               // 调试移动速度（米/秒）

    // —— 连杀计数（第四十四修：从「枪身红点环」搬到本面板边缘）——
    //   每用**子弹**击杀一个敌人 → 沿面板边框**等距**亮一个方块（共 DOTS 个）；
    //   集齐整圈闪一下（同时触发射速加速，见下面的 RAPID_FIRE）；加速期间新攒的点用 BOOST_COLOR；
    //   右下角常显「杀敌 N/DOTS」（画在最上层）。方块贴着边框线 → 不占正文区、不挡准星。
    //   位置全自动；现场只可能要调 INSET（离画布边距）/ SIZE（方块大小）/ PHASE（起点错开半格）。
    STREAK: {
      ENABLED:     true,                     // 总开关：false → 面板上不画方块也不画计数
      DOTS:        10,                       // 方块个数（应与 RAPID_FIRE.KILLS 一致）
      SIZE:        26,                       // 方块边长（画布像素）
      INSET:       13,                       // 方块中心距画布边缘的像素距离
      PHASE:       0.5,                      // 起点相位：0.5 = 首尾都不落在四角
      COLOR:       '#ff2f2b',                // 已点亮（红）
      BOOST_COLOR: '#ffd24a',                // 加速期间新攒的点（金）
      EMPTY_COLOR: 'rgba(255,255,255,0.16)', // 未点亮的空槽（暗底小方块，便于数数）
      FLASH_TIME:  0.35,                     // 集齐后「整圈闪一下」的时长 s
      FLASH_COLOR: '#ffffff',                // 闪光时的颜色
      COUNT_LABEL: '杀敌',                    // 计数文字前缀（显示「杀敌 3/10」）
      COUNT_COLOR: '#ffffff',                // 计数文字色（未加速时）
      BOOST_LABEL: '加速',                    // 加速期第二行前缀（显示「加速 2.1s」）
    },
  },

  // ==================== 基础怪群体语音（"冲冲冲"）触发阈值 / 停顿 ====================
  // 场上存活基础怪数量 ≥ THRESHOLD 时播放一次，停顿 PAUSE 秒后再判断。只调想改的键。
  BASIC_VOICE: {
    URL:       'music/冲冲冲.wav',   // 语音文件（一次性，不循环）
    THRESHOLD: 10,                  // 触发阈值（个）：存活基础怪 ≥ 该值才播放
    PAUSE:     10,                   // 停顿时间（秒）：播放后等待该秒数再重新判断
    VOLUME:    1.0,                 // 播放音量（0~1）
  },

  // ==================== 第18关 魔术师Boss（三阶段召唤 / 黑白球墙） ====================
  // 只调想改的键；改完刷新页面即生效。召唤数量调小可显著降卡顿。
  MAGICIAN_BOSS: {
    SPAWN_ENEMIES: true,   // 召唤总开关：false → 三阶段都不召唤（排查卡顿/伤害用）
    HP_BASE: 20000,        // Boss 基础血量
    HP_DPS_SEC: 30,        // 血量 = HP_BASE + 玩家DPS × 此值
    PHASE: {
      INTRO: 8,            // 开场演出兜底上限（秒）：正常由开场语音播完触发，秒数对不上先看这条
      LASER: 10,           // 第一阶段·激光（秒）：召唤时间点按此时长均分
      GLASS: 10,           // 第二阶段·玻璃墙（秒）：同上
      NINE: 10,            // 第三阶段·黑白球墙（秒）：需 ≥ 浮动5s + 追击到位时间
    },
    // —— 开场演出（第三十八修）：念白 → 0.6s 飞回 Boss 位 → 瞬间变大 → 语音播完进激光阶段 ——
    INTRO: {
      VOICE_URL: 'music/魔术师Boss开头.wav', // 开场语音（实际 7.494s）
      POS: [0, 7.4, -10],    // 念白位置（与第15关开场魔术师同款）：[x,y,z] 米，z 负=玩家正前方
      SCALE_HEIGHT: 5.0,     // 念白体型：目标身高（米），与第15关开场一致
      CUE_AT: 5.4,           // 语音播到此秒 → 起飞（现场标定：看留痕里的「开场语音 x.xs」）
      FLY_TIME: 0.6,         // 飞回 Boss 位耗时（秒）
      BIG_MULT: 2,           // 变大后身高 = 常规 10m × 此倍数
      LOG_VOICE: true,       // 标定用留痕（标定完改 false）
      LOG_STEP: 0.5,
    },

    // —— 收尾（第三十九修）：Boss 死亡 → 清场 → 横幅 WIN_BANNER_SECONDS 秒 → 结束本局（退出浏览器）——
    WIN_BANNER_SECONDS: 5,   // 通关横幅持续（秒）；0 = 不显示横幅，Boss 一死立即结束本局

    // —— 召唤池（第三十八修）：场上维持 MAX 只（含 ELITE 只阶段精英怪），总数 < REFILL_AT 时补满 ——
    POOL: {
      MAX: 20,               // 场上上限（只）
      ELITE: 3,              // 其中精英怪数量（只）
      REFILL_AT: 5,          // 存活 < 此值 → 一次补满到 MAX
      REFILL_COOLDOWN: 0.5,  // 两次补充之间的最小间隔（秒）
      SPAWN_R: 15,           // 出生半径（米，距场地中心）
      SPAWN_Y_MIN: 1,
      SPAWN_Y_MAX: 3,
      BASIC_TYPE: 'basic',   // 普通怪敌种
      ELITE_BY_PHASE: {      // 各阶段精英怪敌种（只换种类、不清场）
        laser: 'shield',     // 激光阶段 = 盾牌骑士
        glass: 'ghost',      // 玻璃墙阶段 = 幽灵怪
        nine:  'octopus',    // 黑白球墙阶段 = 章鱼怪
      },
      PER_FRAME: 3,          // 每帧最多落地几只（错峰，越大越卡）
      BEAM_ENABLED: true,    // 从 Boss 身上飞出光点后再出现
      BEAM_Y: 8,             // 光点出发点抬高（米，约胸口）
    },

    ORB_WALL: {
      ENABLED: true,       // false → 回退到原「九宫格」机制
      HP: 1500,            // 每球血量
      RADIUS: 0.75,        // 球半径（米）
      SPACING: 1.5,        // 3×3 阵列间距（米）
      CENTER_Y: 4.5,       // 阵列中心高度（米）
      FLOAT_TIME: 5,       // 上下浮动持续（秒）→ 之后脱离墙体追击
      FLOAT_AMP: 0.35,     // 浮动幅度（米）
      FLOAT_FREQ: 1.6,     // 浮动频率（Hz）
      CHASE_SPEED: 3.0,    // 脱墙后追击速度（米/秒）
      SELF_DAMAGE: 2,      // 进 4×8 区域自爆对玩家的伤害
      SCORE: 0,            // 击破得分
      WHITE_COLOR: 0xffffff,
      BLACK_COLOR: 0x111111,
    },
  },

  // ==================== 传送门（小怪关前后左右各一个） ====================
  PORTAL: {
    TARGET_HEIGHT: 2.2,    // 门整体高度（米）：基准高度，独立参数（与缩放倍数解耦）
    SCALE: 3,              // 整体缩放倍数：在 TARGET_HEIGHT 基础上再整体放大/缩小（高宽厚一起）
                           //   1 = 按 TARGET_HEIGHT 原样；2 = 整体再大一倍；0.5 = 整体再小一半
    HEIGHT_Y: 2.6,        // 门中心离地高度（米）：独立参数，直接写最终值。注意：负值=中心在地面以下
    DISTANCE_P: 30,        // 门距场地中心水平距离（米）：前后门在 Z=±P，左右门在 X=±P
    ROT: {                 // 左/右门绕 X/Y/Z 三轴朝向（弧度）；前/后门恒为 {0,0,0}
      X: { LEFT: 0, RIGHT: 0 },       // 绕 X 轴（弧度）
      Y: { LEFT: Math.PI / 2, RIGHT: -Math.PI / 2 },       // 绕 Y 轴（弧度）
      Z: { LEFT: 0, RIGHT: 0 }, // 绕 Z 轴：左门逆时针90°/右门顺时针90°
    },
    FLOAT_AMP: 0.1,        // 上下浮动幅度（米）：0.25 过大、0.1 轻微
    FLOAT_FREQ: 1.0,       // 浮动频率（Hz）
  },

  // ==================== 玩家移动 ====================
  MOVE: {
    JOYSTICK: 1,           // 摇杆/虚拟移动开关：1=启用（摇杆+键鼠可移动）；0=禁用，只靠玩家现实行走
                           //   ⚠ 置 0 后区域边界约束(BOUND_X/Z)同样不再执行（详见 constants.MOVE 注释）；
                           //     现实场地本身 4×8、与游戏区域一一对应，故无需该约束
    SPEED: 3.5,            // 摇杆/键鼠移动速度（米/秒）：仅在 JOYSTICK=1 时有效
    DEADZONE: 0.2,         // 摇杆死区
    BOUND_X: 2,            // X 轴移动边界（米）：玩家「世界位置」X 允许范围 ±该值（4m 宽）
    BOUND_Z: 4,            // Z 轴移动边界（米）：玩家「世界位置」Z 允许范围 ±该值（8m 深）
  },

  // ==================== 射击 / 子弹 ====================
  // 注：实际射速由 GUN_MODES（预览/满状态按钮）控制，SHOOT.COOLDOWN 为兜底值。
  SHOOT: {
    COOLDOWN: 60,          // 射击冷却 ms
    BULLET_SPEED: 15,      // 子弹速度（米/秒）
    BULLET_LIFE: 2,        // 子弹存活时间（秒）
    BULLET_POOL_SIZE: 1000, // 同时存在子弹上限（第五十四修 500 → 1000）
    BULLET_RADIUS: 0.02,   // 子弹半径（米）：越大越粗
    BULLET_COLOR: 0xffe066, // 子弹颜色（发光黄）
    SPREAD_COUNT: 3,       // （旧字段，已无引用）
    SPREAD_ANGLE: 0.15,    // 扇形半角上限（弧度 ≈8.6°）：12 条弹道时用满 ⇒ 总张角 ≈17.1°（第五十四修 0.08 → 0.15）
    SPREAD_FULL_N: 12,     // 用满 SPREAD_ANGLE 的弹道数；写 2 = 恒定半角（第五十四修之前的行为）
    RIGHT_PITCH_DEG: -27,  // 兜底俯角（度，负=枪口下压）：仅在 AIM 总开关关闭 / 设备槽未配时生效；正常走 AIM.BY_DEVICE
    SPAWN_OFFSET: 0.5,     // 子弹出生点前移距离（米）
    RAY_COLOR: 0xff2222,   // 右手射线颜色（红）
    RAY_LENGTH: 5,         // 射线可见长度（米）
    RAY_COLOR_LEFT: 0x66ccff, // 左手射线颜色（青；仅 OFFHAND_RAY=true 时可见）
    OFFHAND_RAY: false,    // 第四十三修：非射击手是否也画射线。false = 只留主手那条（现场定稿）
    // —— 命中判定几何（仅 DepthSprite 2D立绘怪生效；3D模型怪走真实包围球，不受这两项影响）——
    // 立绘怪是永远朝相机的扁平卡片，命中体积是一个「竖薄板盒子」：
    //   范围大小(左右=上下半径) = effectiveRadius × tune.scale × extraScale × DEPTH_SPRITE.HIT_MUL + HIT_PAD
    //   前后(朝相机方向)         = HIT_SLAB_DEPTH（卡片正前+正后各这么多米的容差）
    //   整体命中盒 = 宽=2×范围半径，高=2×范围半径，厚=2×HIT_SLAB_DEPTH
    HIT_PAD: 0.05,        // 【上下/左右】命中半径额外填充（米）：叠加在「范围半径」之外的容差；调小→更贴合，0=完全贴合
    HIT_SLAB_DEPTH: 0.4,  // 【前后】2D立绘命中板厚（米）：卡片朝相机方向正前+正后各容差；调小→收紧前后误判
  },

  // ==================== 手柄瞄准基准（设备识别 + 三轴补偿角） ====================
  // 射线与子弹共用同一角：手柄本地 -Z 套上 {x,y,z} 后转世界。角度按设备标定过 PICO 4；
  // Quest / SteamVR 的 targetRay↔grip 空间约定不同 → 同一角会整体偏，故按设备槽各存一份，
  // 自动识别设备后取对应槽。详见 docs/设备识别与瞄准角度.md（第三十三修）。
  //   x = 俯仰（负=射线下压 / 正=上抬，**主要调这个**）
  //   y = 偏航（负=左偏 / 正=右偏）
  //   z = 翻滚（⚠ 不改变方向，只调方向请保持 0）
  // 改这里的数字 → 刷新页面即生效（本文件覆盖 constants.js 的同名键）。
  // 第三十四修：VR 内「摇杆标定工具」已按需求移除（不再占用左手摇杆 / 不再动 X 键）
  // 第四十三修 · 现场快速试角（不用重打包、不用重发内容包）：
  //   在头显浏览器的地址栏里加参数即可临时覆盖，例如
  //     http://localhost:8080/?cast=1&pc=192.168.31.228&aim=-14,-14,0      三轴一次写完
  //     http://localhost:8080/?cast=1&pc=192.168.31.228&aimx=20&aimy=-14  只覆盖某几轴
  //   它落到 AIM.FORCE（优先级最高、不落盘、刷新即丢）→ 只影响带着该参数的那台设备；
  //   PICO 的启动地址不带它就是原样，调 Quest 时完全不必动 pico 槽的固化角。
  //   调好了再写进下面的 BY_DEVICE[槽]（写进本文件要重发内容包，见 docs/tech/09）。
  //   ⇒ 各槽角度只由本表决定；要试新角度可用 FORCE，或从 git 历史取回标定工具。
  AIM: {
    ENABLED: true,   // 总开关：false → 恒用 SHOOT.RIGHT_PITCH_DEG（改造前行为）
    DEVICE: null,    // null / 'auto' = 自动识别；识别不准时钉死：'pico' | 'quest' | 'steamvr' | 'unknown'
    BY_DEVICE: {
      pico:    { x: -27, y: 0,   z: 0 },   // PICO 4 实测基准，勿随意改
      quest:   { x: -14, y: -14, z: 0 },   // Quest：2026-10-14 现场复核为 -14/-14/0（原 14 俯角符号写反）
      steamvr: { x: -27, y: -2,  z: 0 },   // ← 占位值，待实测（Vive / Index / WMR 共用本槽）
      unknown: { x: -27, y: 0,   z: 0 },   // 兜底：识别不出设备时用
    },
    FORCE: null,     // 排障强制：{ x: -20 } / { x: -20, y: 3 }（可只写部分轴），优先级最高、不落盘
  },

  // ==================== 命中判定微调（2D立绘怪 DepthSprite 专用） ====================
  // HIT_MUL 现在是「命中半径 = 立绘可见角色半高 × 本倍率」的倍率：
  //   取景留边已由 glbCapture.captureFrameFit(radius) 按各自 radius 自动折算
  //   （可见角色占画幅比例 = radius/1.2，半径越大填得越满），不再需要一刀切的小系数。
  //   1.0 = 完全贴合可见角色（默认）；<1 收紧手感，>1 放宽。
  // 注：HIT_PAD / HIT_SLAB_DEPTH 在上面 SHOOT 块内（同名键），一起调。
  DEPTH_SPRITE: {
    HIT_MUL: 1.0,        // 【范围大小】立绘命中半径倍率（相对"可见角色半高"）：1.0=贴合；想更紧用 0.85/0.7
  },

  // ==================== 积分散射技能（前期默认技能） ====================
  // 消耗积分从枪口喷出 50 弹头，枪口前方 9 米铺成半径 3 米圆盘；积分不足时释放失败不进冷却。
  SCATTER: {
    COST: 300,          // 释放消耗积分
    COUNT: 50,          // 弹头数量
    DIST: 9,            // 轴向距离（米）：圆盘中心在枪口前方此距离处
    RADIUS: 3,          // 圆盘半径（米）：9米轴向处铺成半径3米圆盘
    COOLDOWN: 0.5,      // 释放冷却（秒）
    DAMAGE: 0,          // 每发伤害（0=复用玩家攻击力）
    SPREAD_DISC: true,  // true=实心圆盘；false=仅圆周
  },

  // ==================== 敌人模型加载期间的「光点」占位 ====================
  // 敌人 GLB 还没解码完时显示的光点（原来是彩色笑脸球，模型一到就「换脸」，太出戏）。
  // 光点直径 = 占位球直径(2×敌人 radius) × MUL；只改观感，不影响命中判定与玩法；
  // 加载失败（404）仍回退成可见彩色球体。改完刷新页面即生效。
  ENEMY_DOT: {
    MUL: 2.0,        // 大小倍率：2.0 = 占位球的两倍大（想更大/更小改这里）
    CORE: 0.34,      // 实心核心直径占比（其余为向外渐隐的光晕，越大越像实心圆点）
    COLOR: 0xfff2c4, // 颜色（暖白）
    OPACITY: 0.85,   // 最大不透明度 0~1
  },

  // ==================== 气球敌人 ====================
  BALLOON: {
    HP: 100,               // 普通气球血量
    SPEED: 0.35,            // 移动速度（米/秒）
    RADIUS: 0.5,           // 半径（米）
    SCORE: 10,             // 击破得分
    DAMAGE: 3,             // 撞船伤害
  },

  // ==================== 输入/控制器（设备相关） ====================
  // 枪/剑绑定手的交换开关。本机(PICO 4)实测：保持默认 false 即可——枪挂右手柄、剑挂左手柄，
  // 子弹发射口 _hands['right'] 不变（始终从右手发射）。若某台设备出现「枪在左手、剑在右手」，
  // 再把此项改 true（交换枪/剑绑定手）。
  INPUT: {
    SWAP_HANDS: false,
  },

  // ==================== 测试工具（调试用） ====================
  // 左手柄 X 键（或桌面 G 键）按一下 +ADD_SCORE 积分，用于快速测试技能。
  // 正式上线把 ENABLED 改 false 即可关闭，避免误触加分。
  TEST: {
    ENABLED: false,          // 总开关：false 关闭测试快捷键
    ADD_SCORE: 500,         // 每次按下赠送的积分数（受 SCORE_CAP 上限裁剪）
    VR_BUTTON_LEFT_X: true, // 左手柄 X 键(buttons[4])触发
    DESKTOP_KEY_G: true,    // 桌面 G 键触发
  },

  // ==================== 右手 AK 枪 ====================
  GUN: {
    MODEL_URL: 'Model/Ak枪.glb', // 模型路径
    POSITION: { x: 0.0, y: -0.25, z: 0.0 }, // 位置偏移（米）
    ROTATION: { x: -60, y: 90, z: 0 },      // 旋转（度）
    SCALE: 0.5,            // 整体缩放
    RECOIL: {              // 后坐力（仅枪模型视觉）
      ENABLED: true,
      MAX_BACK: 0.045,     // 最慢射速单发后退位移上限（米）
      MIN_BACK: 0.011,     // 最快射速单发后退位移下限（米）
      MAX_PITCH: 0.16,     // 最慢射速单发枪口上抬角上限（弧度）
      MIN_PITCH: 0.04,     // 最快射速单发上抬角下限（弧度）
      DECAY: 0.80,         // 回正系数（越小回正越快）
      CURVE: 1.5,          // 射速→幅度映射曲率
    },
  },

  // ==================== 左手柄激光剑（近战技能） ====================
  // 选卡装备后常驻左手柄；按左手柄 grip 激活「5秒伤害状态」；位置/旋转/缩放/伤害均可热调。
  LASER_SWORD: {
    POSITION: { x: 0.0, y: 0.0, z: 0.0 },   // 相对左手柄(grip)本地坐标（米）
    ROTATION: { x: -90, y: 0, z: 0 },         // 旋转(度)：本地+Y剑刃经 -π/2 绕X → 世界 -Z（手柄前方）
    SCALE: 1.0,                              // 整体缩放（恒等；剑尺寸由子网格 scale 决定，单位米）
    BLADE_AXIS: { x: 0, y: 1, z: 0 },       // 剑刃方向（root 本地轴）= +Y（配合 ROTATION.x:-90 → 世界 -Z 前向）
    // —— 伤害/技能 ——
    DAMAGE: 700,                              // 单次命中伤害（×player.skillDamageMul）
    DURATION: 7,                              // 激活后伤害状态持续秒数（击发后挥剑伤害的窗口）
    HIT_INTERVAL: 0.15,                      // 同一只怪被剑刃持续扫到时，两次扣血的最小间隔(秒)；调小=连续高 DPS
    COOLDOWN: 5,                              // 激活后复用冷却秒数（HUD 显示）
    COST: 500,                                // 消耗积分
    // —— 程序化剑刃参数（文档《激光剑方案-接入文档》）——
    BLADE_LEN_MIN:  0.05,   // 迷你态剑刃长度/米（巴掌大小短剑）
    BLADE_LEN_MAX:  20.0,   // 剑刃展开长度/米（文档默认；伤害范围=此值）
    BLADE_R_MIN:    0.009,  // 迷你态剑刃半径/米
    BLADE_R_MAX:    0.07,   // 展开态剑刃半径/米
    HILT_LEN:       0.10,   // 剑柄基础长度/米
    HILT_SCALE_EXT: 3.0,    // 展开时剑柄放大倍数（10cm→30cm）
    GLOW_SCALE:     1.8,    // 辉光层半径 / 核心半径
    HALO_SCALE:     3.0,    // 外晕层半径 / 核心半径
    GLOW_POWER:     2.2,    // 辉光衰减指数（越大越集中核心）
    HALO_POWER:     1.4,    // 外晕衰减指数（越小越扩散）
    GLOW_INTENSITY: 0.55,   // 辉光强度
    HALO_INTENSITY: 0.22,   // 外晕强度
    BLADE_COLOR:    0x66ccff, // 剑刃颜色（青蓝）
    CORE_COLOR:     0xf2ffff, // 核心白热色（略偏青的白）
    EXTEND_TIME:    0.45,   // 展开/收回动画时长/秒
    BLADE_LIGHT_MAX: 45.0,  // 展开态剑刃点光强度(candela)
    BLADE_LIGHT_DIST: 30.0, // 剑刃点光影响半径/米
  },

  // ==================== 各关卡 BGM 音量（程序化三套曲目总线增益倍率） ====================
  // 生效值 = 总线基准(0.18) × 该倍率；改这里整体调响/调轻，不用动音频合成代码。
  // 普通关/危机关(normal)、机制关(激光 3/9/15, laser)、Boss 关(6/12/18, boss) 各一档。
  // 默认 laser 偏高(1.4)：机制关 BGM 在 PICO 小喇叭上偏轻；嫌响/嫌轻改这里（刷新即生效）。
  BGM_VOLUME: {
    normal: 4.0,  // 普通关/危机关 BGM 音量倍率
    laser:  5.4,  // 机制关(激光 3/9/15) BGM 音量倍率（默认偏高，PICO 小喇叭偏轻）
    boss:   4.0,  // Boss 关(6/12/18) BGM 音量倍率
  },

  // ==================== 手里剑（忍者气球投掷物） ====================
  // 与 constants.SHURIKEN 同名；改这里刷新即生效，不用动源码。详见 constants.js 注释。
  SHURIKEN: {
    INTERVAL:   3.0,   // 全局投掷冷却（秒）
    SPEED:      14.0,  // 飞行速度（米/秒）
    DAMAGE:     3.0,   // 命中扣血量（飞船血量）
    HIT_RADIUS: 0.6,   // 命中判定半径（米）
    MAX_LIFE:   4.0,   // 最长存活（秒）
    SPIN:       18.0,   // 自旋角速度（度/秒）
    SIZE:       0.18,  // 视觉外接半径（米）
    RANGE_MIN:  10.0,  // 忍者活动环带内界（米）
    RANGE_MAX:  15.0,  // 忍者活动环带外界（米）
    APPEAR:      3.0,  // 忍者出现静止时长（秒）
    CHARGE:      2.0,  // 手里剑蓄力时长（秒）
    BLINK_DELAY: 1.0,  // 投掷后到闪现的间隔（秒）
  },

  // ==================== 远程投射物（幽灵鬼火 / 章鱼墨汁，projectiles.js） ====================
  // 与 constants.PROJECTILE 同名；改这里刷新即生效，不用动源码。详见 constants.js 注释。
  PROJECTILE: {
    GHOST_FIRE: {
      SPEED:      13.0,   // 飞行速度（米/秒）
      DAMAGE:      5.0,   // 命中扣飞船血量（兜底值；实际以 enemies.ghostFireDamage 为准）
      HIT_RADIUS:  0.7,   // 命中判定半径（米）
      MAX_LIFE:    4.0,   // 最长存活（秒）：超时自动回收
      SIZE:        0.26,  // 视觉半径（米）
      SPIN:        0.0,   // 自旋角速度（度/秒）：鬼火不转
      COLOR:  0xb46bff,   // 核心颜色（紫）
      GLOW:   0x8a2be2,   // 外发光颜色（加色光晕）；null = 不发光晕
      TINT:   0xb46bff,   // 命中后视野周边着色（紫）
    },
    INK: {
      SPEED:      12.0,   // 飞行速度（米/秒）
      DAMAGE:      5.0,   // 命中扣飞船血量（兜底值；实际以 enemies.inkDamage 为准）
      HIT_RADIUS:  0.8,   // 命中判定半径（米）
      MAX_LIFE:    4.0,   // 最长存活（秒）
      SIZE:        0.36,  // 视觉半径（米）
      SPIN:       55.0,   // 翻滚角速度（度/秒）
      COLOR:  0x12121e,   // 墨色（近黑，留一点蓝以便在暗夜关卡里仍能看出飞行轨迹）
      GLOW:   null,       // 墨汁不发光晕
      TINT:   0x05050c,   // 命中后视野周边着色（黑）
    },
    // —— 命中着色层（src/vr/vignette.js）：贴在相机前的「视野周边着色」，中心透明、边缘着色 ——
    VIGNETTE: {
      ENABLED:  true,   // 总开关：false = 只扣血、不着色
      DIST:     0.42,   // 距相机距离(m)：越小越像「眼睛被打花」，越大越像「面前有块玻璃」
      MARGIN:   1.18,   // 尺寸余量：按相机 FOV 算出的平面再乘此值（>1 保证铺满视野）
      ASPECT:   1.15,   // 宽高比（XR 单眼约 1.0~1.2）
      OPACITY:  0.55,   // 峰值不透明度 0~1
      RISE:     0.10,   // 上色时间(s)
      FADE:     0.55,   // 褪色时间(s)
    },
  },
  // ==================== 龙 Boss 召唤（dragonLevel.js） ====================
  // 与 constants.DRAGON_SUMMON 同名；改这里刷新即生效，不用动源码。详见 constants.js 注释。
  DRAGON_SUMMON: {
    INTERVAL:   10.0,  // 召唤周期（秒）：每 10 秒一次
    BASE_COUNT: 12,    // 基准基础怪数量（场上 ≥ LOW_THRESHOLD 时）
    RAMP_ADD: 5,    // 场上 < LOW_THRESHOLD 时，在上次召唤数上 +10（加压）
    LOW_THRESHOLD: 5,  // 场上基础怪低于此值 → 触发加压
    MAX_BASIC: 50,   // 单次召唤基础怪硬上限(保护 PICO)：设更大或 Infinity 解除
    NINJA_PER_SUMMON: 1, // 每次召唤必带忍者数（遵守不靠近 10m 内）
    RING_MIN:   10.0,  // 出生环带内半径（米）：距中心 ≥10 才出现
    RING_MAX:   15.0,  // 出生环带外半径（米）
    SPAWN_Y:    1.5,
    // 召唤光点（详见 constants.DRAGON_SUMMON.BEAM 注释）；改这里刷新即生效
    BEAM: {
      ENABLED: true,    // 总开关：false → 直接生成（无光点）
      SPEED:   22,      // 光点飞行速度（米/秒）
      SIZE:    0.16,    // 光点球体半径（米）
      COLOR:   0xffd24a,// 光点颜色（金黄）
      OPACITY: 0.95,    // 不透明度
      STAGGER: 0.04,    // 每只光点出发间隔（秒）：连续抛出的流
      Y_OFFSET: 1.2,    // 光点起点相对龙身位置上抬（米）
    },   // 出生高度（米）：与常规气球(1~3.5)一致
  },

  // ==================== 龙 Boss 登场语音 ====================
  DRAGON_VOICE: {
    ENABLED: true,                // 是否播放龙 Boss 登场语音（关 → 不播）
    LOOP:    true,                // 是否循环播放：true=持续循环到死亡/切关；false=只播一次
    URL:     'music/龙Boss.wav',  // 语音文件（相对 index.html；放在 music/ 下）
    VOLUME:  1.0,                 // 音量(0~1)：默认满音量，觉得吵可调小
    DELAY:   0.6,                 // Boss 开始运动(揭示)后延迟播放(秒)
  },

  // ==================== 龙 Boss 减伤 & 击杀基础怪扣血（热调） ====================
  DRAGON: {
    DAMAGE_REDUCTION: 0.95,       // 龙身/龙爪气球减伤比例（受击只吃 5%）
    BASIC_KILLS_PER_PERCENT: 5,   // 每消灭多少个基础怪扣 Boss 1% 总血量
    BASIC_KILL_PERCENT: 0.01,     // 每次扣 Boss 总血量比例（1%）
  },

  // ==================== 红脸旗子「升空十倍砸落」（热调） ====================
  FACE_BOSS: {
    RED_FLAG_SLAM_RISE_Y: 18,      // 升空高度(m)
    RED_FLAG_SLAM_RISE_TIME: 1.0, // 升空+放大耗时(s)
    RED_FLAG_SLAM_SCALE: 10,      // 最终视觉放大倍数（约10倍）
    RED_FLAG_SLAM_SPEED: 26,      // 砸向玩家速度(m/s)
    // —— 红阶段演出 ——
    RED_FLAG_SLAM_LOCK_ROT: true, // 下砸期间冻结旗子朝向（修"正上方 lookAt 退化 → 抖动"）；false=恢复原样
    RED_FLAG_DIVE_SPEED: 20,      // 旗子砸落俯冲下降速度(m/s)（大旗砸向玩家）
    RED_FLAG_HIT_Y: 2.0,          // 砸落命中高度(m)：低于此高度才算砸到玩家
    RED_BOSS_SPIN_SPEED: 2.0,     // 公转期间 Boss 原地自转角速度(rad/s)：0=不转（仅"期望速度"，实际按整圈折算）
    RED_BOSS_SPIN_TURNS: 0,       // Boss 自转圈数：0=自动取最接近的整数圈；>0=固定圈数（整数圈 → 停下刚好回到正面）
    RED_END_ON_LAND: true,        // Boss 落地瞬间切下一阶段（false=按 PHASE_DURATION 走完红阶段）
    // 旗子转圈(公转)时间：要更长/更短的自转时间就调它们——自转窗口 = ORBIT_END - SPAWN_START
    RED_FLAG_SPAWN_START: 2,      // 旗子出现时刻(s)：公转开始
    RED_FLAG_ORBIT_END: 6,        // 公转结束时刻(s)：旗子定位 + Boss 自转结束（改大 → 自转更久/圈数更多）
    RED_BOSS_RISE_WITH_FLAG: true,// Boss 是否随大旗一起原地升空/落地
    RED_FLAG_MERGE: true,         // 升空时多旗融合成一面大旗
    RED_FLAG_MERGE_TIME: 0.35,    // 融合动画时长(s)：0=瞬间消失
  },

  // ==================== 如来神掌（大招） ====================
  // 第三关可选技能；按左手柄 grip 释放。消耗 player.skillCost 积分。
  // 伤害仅「变化(grow)/运动(move)」阶段结算：掌图作横扫墙，只命中命中盒内的敌人（不再全屏秒杀）。
  // 视觉：贴图 Palm 在 START_POS 出现 → GROW_TIME 内放大到 END_SCALE（分两段）→ MOVE_TIME 内沿 +Z 移到 END_POS → 停顿 PAUSE_TIME → 淡出消失。
  BUDDHA: {
    TEXTURE_URL: 'assets/buddha-palm.jpg', // 贴图路径（相对 index.html）
    COLOR_KEY_THRESHOLD: 0.99,   // 白底剔除阈值（0~1）：越低剔除范围越大
    PLANE_WIDTH: 4.0,            // 平面宽度（米）
    PLANE_HEIGHT: 6.0,           // 平面高度（米）
    START_POS: { x: 0, y: 0, z: -30 }, // 出现位置（世界坐标，米）
    END_POS:   { x: 0, y: 0, z:  30 }, // 移动终点（世界坐标，米）
    START_SCALE: 1.0,            // 初始缩放倍数
    END_SCALE: 15.0,             // 最终缩放倍数（10 倍）
    GROW_TIME: 1.5,              // 原地放大总时长（秒）
    MOVE_TIME: 1.0,              // 沿 +Z 移动时长（秒）
    PAUSE_TIME: 1.0,             // 到达终点后停顿（秒）
    FADE_TIME: 0.3,              // 淡出消失时长（秒）
    LATCH_FACING: true,          // 第四十五修：掌面固定朝向（法线=飞行轴、上方向⊥地面）；false=旧行为（每帧朝相机，会倾斜/翻面）
    HIT_MARGIN_XY: 1.3,          // 命中盒 XY 放大系数（1=完全贴合掌面）
    HIT_Z_BAND: 8,               // 命中盒 Z 半厚（米）：仅命中掌图当前 Z 前后 ±该值的敌人
    MAX_DAMAGE_PER_FRAME: 6,     // 第四十二修：单帧最多结算几只怪（削「神掌一放就卡一下」的 GPU 尖峰）。
                                 //   调大=更「同帧齐爆」但更容易在 Pico 上卡；调 0/1 = 最平滑。
    // —— 程序化 SDF 金掌（VFX_MODE='shader'）—— 不满意就把 VFX_MODE 改回 'texture' 一键回退
    VFX_MODE: 'texture', // 'texture'=优化抠图的 JPG 掌图（当前默认）；'canvas'=Canvas 矢量金掌；'shader'=SDF 金掌
    // —— JPG 抠图优化参数（改完刷新页面即生效）——
    EDGE_SOFTNESS: 0.02,  // 软阈值过渡宽度 0~1：越大越柔但越易误伤过曝高光，0=硬边
    SAT_SAFE: 0.25,       // 高饱和保护：饱和度>此值强制不透明（金掌永不破洞）
    HOLE_FILL: 0.8,       // 补洞阈值：低alpha像素邻域不透明占比≥此值则填回，0=关闭
    HOLE_RADIUS: 4,       // 补洞邻域半径(px)：洞较大时调大
    EDGE_FEATHER: 1.5,    // alpha 羽化半径(px)：消 JPG 分块伪影，0=关闭
    DECONTAM: 1.0,        // 去白边强度 0~1：1=完全替换半透明白边
    DECONTAM_RADIUS: 3,   // 去白边取色邻域半径(px)：白边宽时调大
    SATURATION: 1.15,     // 饱和度（1=原样，>1 更金）
    BRIGHTNESS: 1.0,      // 亮度（1=原样）
    ANISOTROPY: 4,        // 各向异性 1~16：斜视/放大更清晰
    UPSCALE: 1,           // 扣图前上采样倍数：2=更平滑但更慢更占显存
    // —— Canvas 矢量金掌绘制参数（一次性生成，改完刷新页面即生效）——
    CANVAS_W: 1024,       // 贴图宽(px)
    CANVAS_H: 1536,       // 贴图高(px)
    TENSION: 1.0,         // 轮廓平滑张力：0=尖角，1=平滑推荐
    MARGIN: 0.86,         // 掌占画布比例：越小留白越多（留白须≥发光半径）
    OFFSET_Y: 0.02,       // 整体上下偏移（画布高比例），正=上移
    GLOW_LAYERS: 2,       // 外发光层数
    GLOW_BLUR: 0.10,      // 外发光模糊半径（掌单位）
    GLOW_ALPHA: 0.5,      // 外发光强度 0~1
    GLOW_COLOR: '#ffae2b',// 外发光颜色
    COL_MID: '#ff9d2e',   // 掌中过渡金
    CORE_GLOW: 0.55,      // 掌心亮核强度 0~1
    STROKE_WIDTH: 0.045,  // 轮廓描边粗细（掌单位）
    STROKE_COLOR: '#fff3c4', // 描边颜色
    STROKE_ALPHA: 0.95,   // 描边不透明度
    LINES_ENABLE: true,   // 掌纹
    LINES_COLOR: '#ffdca8',
    LINES_WIDTH: 0.028,
    LINES_ALPHA: 0.45,
    SIGIL_ENABLE: true,   // 掌心法阵
    SIGIL_X: 0.0,
    SIGIL_Y: -0.25,
    SIGIL_RADIUS: 0.42,
    SIGIL_RINGS: 3,
    SIGIL_RAYS: 12,
    SIGIL_ROT: 0,
    SIGIL_COLOR: '#ffe9b0',
    SIGIL_WIDTH: 0.022,
    SIGIL_ALPHA: 0.75,
    SPARK_ENABLE: true,   // 能量火花
    SPARK_COUNT: 90,
    SPARK_RADIUS: 0.05,
    SPARK_COLOR: '#fff6d8',
    SPARK_ALPHA: 0.55,
    USE_OFFSCREEN: false, // PICO 不支持 OffscreenCanvas 时设 false
    SHAPE_SCALE: 1.15,    // 掌形放大系数（1=原始比例）
    AA: 1.0,              // 边缘柔化倍率（越大越柔/越糊）
    COL_DEEP: '#8a4a00',  // 掌根暗金
    COL_BRIGHT: '#ffd76a',// 掌尖明金
    COL_RIM: '#fff3c4',   // 边缘金光
    RIM_WIDTH: 0.16,      // 金边厚度
    NOISE_SIZE: 128,      // 噪声图边长(px)
    NOISE_SCALE: 1.6,     // 噪声密度
    NOISE_SPEED: 0.35,    // 流动速度（UV/秒）
    NOISE_STRENGTH: 0.45, // 流动强度 0~1（0=关闭最省 GPU）
    GLOW: 1.15,           // 整体辉光
    CHARGE_GLOW: 0.6,     // 蓄能增亮
    ADDITIVE: false,      // true=加法混合（发光）；false=普通混合（更实、不易被看成光柱）
  },

  // ==================== 渲染分辨率（WebXR 帧缓冲缩放） ====================
  // 1.0=最稳；1.25=更清晰但更费 GPU。第3关实测 GPU 99%/10fps 故桌面默认 1.0；流畅后可热调 1.25 提清晰度。
  // 独立头显(Adreno XR2 弱)默认 0.7 冲 60fps；若帧率富余且想更清晰，调到 0.85~1.0。
  RENDER: {
    FRAMEBUFFER_SCALE: 1.0,                 // 渲染分辨率倍率（桌面 PCVR）：1.0=最稳；流畅后可热调 1.25 提清晰度
    FRAMEBUFFER_SCALE_STANDALONE: 1.0,      // 独立头显专用（Adreno XR2 弱）：默认 0.7 冲 60fps；富余时可调回 0.85~1.0
  },

  // ==================== 出怪 ====================
  // 注：NORMAL_TEST 开启时 SPAWN_DISTANCE/SPAWN_SPREAD 被 DDA 接管；BATCH_* 无引用。
  WAVE: {
    BASE_SPAWN_COUNT: 30,  // 基准出怪总数
    BATCH_INTERVAL: 1.0,   // 批次间隔（秒，当前无引用）
    BATCH_SIZE: 3,         // 每批数量（当前无引用）
    MAX_ACTIVE: 10,        // 同屏上限（当前无引用）
    SPAWN_DISTANCE: 15,    // 生成环半径（米）
    SPAWN_SPREAD: 8,       // 生成位置散布（米）
    PHASE2_AT: 20,         // 前方+左右阶段起始秒
    PHASE3_AT: 40,         // 全方向阶段起始秒
  },

  // ==================== 出怪光点（怪物从传送门飞出） ====================
  // 普通关每只怪出生前，从最近传送门中心飞出一个光点到出生点，落地后怪物才出现。
  // Boss/激光关无传送门 → 自动退化为直接生成（视觉无变化）。龙 Boss/压测不走此系统。
  PORTAL_BEAM: {
    ENABLED: true,        // 总开关：false → 所有怪直接生成（无光点）
    SPEED: 25,            // 光点飞行速度（米/秒）：越大光点越快、节奏越紧
    DUR_MIN: 0.25,        // 飞行时长下限（秒）
    DUR_MAX: 1.0,         // 飞行时长上限（秒）：越大拖慢刷怪节奏
    START_Y_OFFSET: 3,    // 光点出发点相对门中心的上抬高度（米）：让光点从门上方飞出，视觉更明显
    Y_GAP_MAX: 6,         // 门中心与出生点高度差超过此值（米）→ 光点水平进场（防垂直跳水）
    COLOR: 0xff8a8a,      // 光点颜色（浅红）
    SIZE: 0.18,           // 光点半径（米）：越大越明显
    OPACITY: 0.95,        // 光点不透明度
    APPLY_SUMMON: true,   // 召唤怪小兵也走光点
    APPLY_FACE_SUB: true, // 脸谱 Boss 子实体走光点（Boss 关无门时无实际效果）
  },

  // ==================== DPS 基准内外圈出怪 ====================
  // 普通关出怪调度：基础出怪量由玩家 DPS 决定，内外圈分布；
  // 每 CHECK_INTERVAL 秒检查内圈存活数 → 内圈系数 → 调整外圈配额（内圈空→外圈多出）。
  SPAWN_RING: {
    enabled: true,        // 总开关：false → 回退原 DDA/时间曲线出怪
    INNER_RADIUS: 9,      // 内圈半径（米）：紧张区，离玩家近
    OUTER_RADIUS: 15,     // 外圈半径（米）：轻松区，离玩家远
    INNER_SPREAD: 3,      // 内圈出生散布（米）：小 → 更贴 9m 圈
    OUTER_SPREAD: 8,      // 外圈出生散布（米）
    DPS_DIVISOR: 100,     // 基础出怪量 = 玩家DPS / 此值（调大 → 出怪更少）
    MIN_BASE: 4,          // 基础出怪量下限
    MAX_BASE: 40,         // 基础出怪量上限（PICO 同屏舒适区）
    INNER_RATIO: 0.5,     // 内圈初始配额占比（50% = 内外圈平均分布）
    INNER_CAP: 5,         // 内圈配额硬上限（与系数表索引对齐）
    RING_TABLE: [2, 1.8, 1.6, 1.4, 1.2, 1], // 内圈存活 0..5 → 外圈出怪系数
    CHECK_INTERVAL: 5,    // 每 N 秒检查一次内圈数量
    SKILL_CD_THRESHOLD: 3, // 技能冷却 > 此值 = 最近 5 秒放过技能 → 系数=1（不追加外圈压力）
    REFILL_COOLDOWN: 0.3, // 补怪滴流间隔（秒）
    stopAt: 60,           // 停止补怪时间窗（秒）：之后场上清空即通关
    LEVEL_BASE: 5,        // 关卡常数基准
    LEVEL_INC: 0.5,       // 关卡常数推进增量（每关 +0.5）
    pool: ['basic'],      // 出怪类型池
  },

  // ==================== 穿云特效（关卡开场过渡） ====================
  // 每关开始先在玩家前方生成云雾，向后飘 3s → 由前向后缩短 1s 消失；
  // 期间冻结出怪与 Boss/机制动画，但场景已先出现。改完刷新即生效。
  CLOUD: {
    ENABLED:     true,   // 总开关：false → 跳过穿云与延迟，关卡直开
    COLS:        5,      // 横向(宽)雾团列数
    ROWS:        9,      // 纵深(前→后)雾团排数
    SPREAD_X:    14,     // 云雾总宽度（米）
    DEPTH:       20,     // 云雾总纵深（米，沿玩家正前）
    FRONT_DIST:  6,      // 最前排距玩家距离（米）
    Y:           1.6,    // 云雾中心高度（米，约眼高）
    Y_JITTER:    2.0,    // 单团高度随机抖动（米）
    PUFF_SIZE:   3.5,    // 单团基础尺寸（米）
    OPACITY:     0.5,    // 单团基础不透明度 0~1
    COLOR:       0xffffff,
    DRIFT_DUR:   3.0,    // 阶段1 向后飘动持续（秒）
    DRIFT_SPEED: 5.0,    // 阶段1 飘动速度（米/秒）
    SHRINK_DUR:  1.0,    // 阶段2 由前向后缩短持续（秒）
    INTRO_DELAY: 4.0,    // 开场总延迟（秒）：出怪/Boss/机制动画延后至此才启动
  },

  // ==================== 进入游戏前的开场视频过场（仅 VR） ====================
  // 点「进入 VR」→ 第 1 关加载前：场景只留「飞毯 + 星空」（纯黑底），
  // 西侧 8m 处一块屏幕播 assets/intro/intro.mp4；播完（或出错/看门狗兜底）才进第 1 关。
  // 桌面预览不播；关卡直达面板不播。改完刷新即生效。
  INTRO_VIDEO: {
    ENABLED:        true,                     // 总开关：false → 跳过视频直接进第 1 关
    SRC:            'assets/intro/intro.mp4', // 视频相对路径（ASCII 文件名）
    X_M:            -8,                       // 屏幕中心 X（米）：场地中心左方 8m（玩家开局面朝 -Z，左手边=-X）
    Z_M:            0,                        // 屏幕中心 Z（米）
    BOTTOM_Y_M:     1.0,                      // 屏幕【底边】离地米数
    ROT_Y_DEG:      90,                       // 屏幕绕 Y 旋转（度）：90=正对场地中心
    WIDTH_M:        7.2,                      // 最大宽度（米，按视频宽高比等比 contain）
    HEIGHT_M:       4.05,                     // 最大高度（米）
    VOLUME:         1.0,                      // 音量 0~1
    STAR_OPACITY:   0.95,                     // 过场星空不透明度 0~1（黄昏默认约 0.5，这里调亮）
    WATCHDOG_PAD_S: 2.0,                      // 看门狗余量（秒）：兜底超时 = 时长 + 该值；正常靠 ended+currentTime 前进，余量过大会卡死不能射击
    HANDOFF_DELAY_S: 0.08,                    // 播完后画面静止多久再加载关卡（秒）：调大=更稳但静止更久
    DISPOSE_DELAY_S: 2.0,                     // 画面摘除后延迟多久真正回收解码器（秒）：藏进穿云里
},
  // ==================== 打击感：命中/击杀音效 + 手柄震动（第四十修） ====================
  // 覆盖 constants.js 的 HIT_FEEDBACK。只写想改的键，其余保持默认。
  //   HIT_VOLUME    普通命中音音量（默认 0.16，比击杀轻很多 —— 高射速下才不糊）
  //   KILL_VOLUME   击杀音音量（默认 0.34）
  //   PITCH_JITTER  每次播放音高随机 ±8%（消除「机关枪嗡嗡」的关键；调 0 = 关闭抖动）
  //   COMBO_*       连击窗口 / 起效连击数 / 音高上爬步长
  //   HAPTIC        手柄震动四档（命中/击杀/精英/受伤）与最小间隔；ENABLED:false 可整体关闭
  // HIT_FEEDBACK: {
  //   SOUND: { HIT_VOLUME: 0.16, KILL_VOLUME: 0.34, PITCH_JITTER: 0.08, VOLUME_JITTER: 0.15 },
  //   COMBO: { WINDOW: 1.5, MIN_FOR_FEEDBACK: 3, MAX: 99 },
  //   HAPTIC: { ENABLED: true, MIN_GAP: 0.05 },
  // },

  // ==================== 伤害数字（第四十修） ====================
  // 覆盖 constants.js 的 DAMAGE_NUMBER。颜色分档：每满 STEP(=100) 伤害加深一档。
  //   想要「每 50 加深一次」→ 改 STEP: 50；不想看到数字 → ENABLED: false（保留计分与音效）。
  //   COLORS 是数组，写了就整体替换（顺序 = 由浅到深）。
  // DAMAGE_NUMBER: {
  //   ENABLED: true,
  //   STEP: 100,
  //   SIZE: 0.30,             // 数字世界高度(m)
  //   LIFE: 0.75,             // 存活秒数
  //   AGGREGATE_WINDOW: 0.14, // 同一只怪的合并窗口(s)：调大 = 数字跳得更粗、更少
  //   POOL: 24,               // 同时存在的数字上限
  //   UPLOAD_PER_FRAME: 6,    // 每帧最多上传几张数字贴图（第四十二修：神掌同帧几十个数字的尖峰）
  // },

  // ==================== 档2 打击感视觉层（第四十一修） ====================
  // 覆盖 constants.js 的 FX。四项：曳光 / 命中火花 / 击杀碎片 / 枪口焰。
  //   全部走 InstancedMesh + 预分配池；ENABLED:false 即整项关闭（关掉后连实例都不创建）。
  //   想更狠：调大 SPARK.SIZE / DEBRIS.SIZE、提高 DEBRIS.COUNT 上限；
  //   想省性能：先把 DEBRIS.POOL 降到 60、SPARK.POOL 降到 32，再考虑关掉 SPARK。
  // FX: {
  //   TRACER: { ENABLED: true, LENGTH: 0.55, WIDTH: 0.022, OPACITY: 0.55 },
  //   SPARK:  { ENABLED: true, POOL: 64, COUNT: [3, 5], LIFE: 0.14, SIZE: 0.055, SPEED: 3.2 },
  //   DEBRIS: { ENABLED: true, POOL: 120, COUNT: [6, 10], ELITE_MUL: 1.6, LIFE: 0.55, SIZE: 0.075, GRAVITY: 9.0 },
  //   MUZZLE: { ENABLED: true, POOL: 2, LIFE: 0.05, SIZE: 0.22 },
  //   MUZZLE: { ENABLED: true, POOL: 2, LIFE: 0.05, SIZE: 0.22, FORWARD: 0.20 },
  //   //  TRACER.MIN_BACK：尾迹「后拖」的最短长度（米，第四十二修）——不足就不画。
  //   //    出生点在枪管内部，照常拖满 LENGTH 会看到曳光穿到枪管后方；调大=更提前消失。
  //   //  MUZZLE.FORWARD：枪口焰沿枪口方向再前移的距离（米）——枪管长就调大。
  // },

  // ==================== 关卡时长与精英波前移（第四十一修） ====================
  // 覆盖 constants.js 的 LEVEL_SECONDS。只作用于普通关/危机关（机制关 3/9/15 与 Boss 关 6/12/18 没有倒计时）。
  //   精英波三期（ELITE_WINDOW：5/20/40s）会按「本关时长 ÷ REF_SECONDS」等比前移，无需单独配。
  //   BY_LEVEL 里删掉某关（或写 0）= 该关回落到 REF_SECONDS。
  // LEVEL_SECONDS: {
  //   REF_SECONDS: 60,
  //   BY_LEVEL: { 1: 40, 2: 40, 4: 40, 5: 40, 7: 50, 8: 50, 10: 50, 11: 50 },
  // },

  // ==================== 中场预警横幅（第四十二修） ====================
  // 覆盖 constants.js 的 MID_WARNING。普通关/危机关**过半**时在准星正前方弹 2 秒「更强的敌人来袭」。
  //   AT     触发点 = 本关时间窗 × AT（0.5 = 刚好过半；调 0.75 = 更靠后）
  //   SECONDS 停留时长（秒）；DIST 出现在准星前方多远（米）；WIDTH 横幅宽度（米）
  //   ENABLED: false 可整体关掉（机制关 3/9/15 与 Boss 关 6/12/18 本来就不会弹）
  // MID_WARNING: { ENABLED: true, AT: 0.5, SECONDS: 2, DIST: 2.6, WIDTH: 2.2, TEXT: '更强的敌人来袭' },

  // ==================== 连杀加速（第四十二修 · 第四十三修红点环 · 第四十四修搬到技能框） ====================
  // 覆盖 constants.js 的 RAPID_FIRE。连续用**子弹**击杀 10 个敌人 → 射速 ×1.5 持续 3 秒 + 奖励音。
  //   只认子弹击杀：技能/如来神掌/激光剑杀的不计数（也不打断连杀）。
  //   GAP             距上次子弹击杀超过该秒数就清零（别调太小，否则很难凑满 10 个）
  //   MULT            射速倍率（1.5 = 2 发/秒 → 3 发/秒）；SECONDS 持续秒数；KILLS 触发连杀数
  //   BOOST_CARRY_MAX 第四十三修：加速期间最多只能再攒这么多个（默认 5）——
  //                   修掉「一边加速一边继续杀 → 无限续杯」；剩下的要等加速结束再重新连杀。
  //   COUNTER 枪身红点环（第四十三修，替换原「枪管大牌子」）：
  //           ★ 第四十四修：**默认关闭**（BARREL_DOTS: false）——红点已搬到「右手技能框边缘」
  //             （见上面 SKILL_HINT.STREAK）。改回 BARREL_DOTS: true 即恢复枪身环（功能没删）。
  //           ALONG 环心位置(0=枪托 0.5=正中 1=枪口)、RING_FRAC/RING_RADIUS 环半径、
  //           DOT_FRAC/DOT_SIZE 点径、DOTS 点数(0=取 KILLS)、COLOR/COLOR_BOOST 颜色、
  //           FLASH_TIME/FLASH_SCALE 集齐后「闪一下」的时长与放大倍数
  //   MIST    加速期间向后飘的雾（表现「枪已经加速」）：COUNT 雾团数、LIFE 单团存活、
  //           SIZE 单团大小(0=自动)、SPEED 后飘速度、OPACITY 浓度；
  //           ⚠ 第四十四修后枪身的「连杀表现」只剩这团雾了，默认别关。
  //           性能吃紧就把 MIST.ENABLED 设 false（或 COUNT: 0）——技能框上的计数不受影响。
  // RAPID_FIRE: {
  //   ENABLED: true, KILLS: 10, GAP: 6, MULT: 1.5, SECONDS: 3, BOOST_CARRY_MAX: 5,
  //   COUNTER: { ENABLED: true, BARREL_DOTS: false, DOTS: 0, ALONG: 0.5, RING_RADIUS: 0, RING_FRAC: 1.45,
  //              DOT_SIZE: 0, DOT_FRAC: 0.28, FLASH_TIME: 0.28, FLASH_SCALE: 2.6 },
  //   MIST: { ENABLED: true, COUNT: 8, LIFE: 0.85, INTERVAL: 0.10, SIZE: 0, SPEED: 1.5,
  //           SPREAD: 0.35, COLOR: 0xbfe9ff, OPACITY: 0.34 },
  // },

  // ==================== 直播推流（?cast=1 时生效） ====================
  // 覆盖 constants.js 的 CAST。本文件在 PC 端 CONFIG_MANIFEST 里 → 改这里会由 EXE 自动
  // 下发到头显覆盖层，**不用重打包 APK**（纯本地模式仍走 assets，需重打包）。
  CAST: {
    HIDE_PANO: false,   // 直播画面是否隐藏 360 全景穹顶（决定「直播端有没有天空」）
                        //   false = 直播端也画全景天空，与头显一致；
                        //           代价：全景纹理要在「第二个 GL 上下文」里再占一份显存
                        //           —— 4K 全景(第1/18关)约 44MB，6K(第3关)约 100MB。
                        //   true  = 原默认：直播端只画渐变天空球，省显存但看着像「纯色」。
                        // 详见 cast.js 渲染段（dome.visible / grad.visible）与 cast-architecture.md。
    // WARMUP: false,   // 【排查「影片阶段闪屏」的对照开关，默认别去掉注释】
                        //   影片阶段头显本该「不渲染、不编码」（CAST.PAUSE_BEFORE_PLAY），
                        //   但预热的 1fps H.264 编码仍在跑 → 与影片解码争 PICO 的媒体引擎(VPU)
                        //   → 头显里影片一闪一闪（见 cast-architecture.md 第二层根因）。
                        //   置 false 可把影片期间的编码彻底停掉（代价：PC 端在预览/影片阶段
                        //   没有占位画面；若 PC 端能播本地影片则观感不受影响）。
  },

  // ==================== VR 桌面镜像（让 PC 显示器也能看到头显第一人称画面） ====================
  // 进入 VR 后游戏主标签页被头显接管而黑屏；此功能在独立弹出窗口实时显示头显画面。
  // 代价：每帧多一次低分辨率渲染 + 一次读回；清晰度与开销用下面 W/H/INTERVAL 权衡。改完刷新即生效。
  MIRROR: {
    ENABLED:   true,   // 总开关：false → 不截帧（镜像窗口打开也收不到画面）
    W:         1920,   // 镜像分辨率宽（像素）：越大越清晰、越费；PC 端不卡可拉满 1080p；掉帧可降到 1280/720
    H:         1080,   // 镜像分辨率高（像素）
    INTERVAL:  2,      // 每 N 帧截一帧（降帧省开销）：1=每帧，2=隔帧，3=每 3 帧
    AUTO_OPEN: true,   // 进入 VR 时自动弹镜像窗（仅 PCVR/PC 显示器有用；独立头显自动跳过）
    // ⚠ 已移除 BRIGHTNESS 亮度倍率：在已 sRGB 编码的像素上乘增益只会让画面灰蒙蒙、不鲜艳；
    //   镜像靠 linear→sRGB 与头显色彩一致即可，PC/头显面板差异是硬件层、无法用全局亮度修正。
  },
};
