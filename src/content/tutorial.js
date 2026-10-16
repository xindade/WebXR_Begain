// ============================================================
// 第六十修 · 第 1 关「教学关」脚本（用户口述稿逐条落地）
//
// 现场稿（原样存档，编号即用户稿里的「横幅提示 N」）：
//   0- 关卡名字显示完之后，玩家的前方、左边（就是传送门方向）各出现一个小怪气球
//   1- 横幅提示1：敌人出现，扣动扳机击杀他们
//   2- 击杀完敌人（或横幅1出现后超过 10 秒，敌人全部消失）→ 横幅提示2：很棒的枪法，打破前方气球获得奖励吧
//   3- 选项卡位置弹出一个选项卡：每射击杀敌 10 个射击速度加倍，持续 3 秒
//   4- 玩家打破选项卡气球（或横幅2出现后超过 12 秒，选项卡默认选择）→ 把连杀数重置为 8
//      → 前方出现五个小怪气球 → 横幅提示3：再杀两个试试加倍射速的威力吧
//   5- 击杀五个气球（或横幅3出现后超过 15 秒）→ 末尾精英横幅 → 内圈出现一个精英怪
//      → 横幅提示5：射击来不及了，快使用左手侧键的散射技能（精英阶段散射无消耗、无冷却）
//   6- 精英被杀死 → 横幅提示6：敌人已清空，拿完奖励去下一个空域 → 正常选项卡再弹出
//
// 为什么单开一个模块而不是塞进 spawnDirector.SPAWN_SCRIPT：
//   SPAWN_SCRIPT 的事件表是**纯时间驱动**（t / every），而教学关每一段都要等
//   「怪被打完」这种**条件**推进，还要在段落之间改玩家状态（连杀数 / 免费技能 / 开一张单卡）。
//   所以这里只放**数据 + 纯函数**（段落表 / 判据 / 出生方位），运行态在 game/tutorial.js。
//
// ⚠ 与 SPAWN_SCRIPT[1] 的关系：教学关开着时，第 1 关的原编排（前 30s 提密度 + 33s 融合铁甲兵）
//   会被 waves.startLevel 让位（见该处 isTutorialLevel 分支）。把 TUTORIAL.ENABLED 改成 false
//   即完整回到旧第 1 关 —— 这是本修的**唯一回退开关**，故旧编排数据保留不删。
// ============================================================

export const TUTORIAL = {
  ENABLED: true,
  LEVEL: 1,                        // 教学关 = 第 1 关

  // 关卡名字（标题卡）弹完再开场：等 _levelTitleDone，最多等 TITLE_WAIT 秒兜底
  TITLE_WAIT: 8,

  // 横幅文案（= 用户稿的提示 1/2/3/5/6；「提示4」是沿用的大字号「前方精英来袭」）
  BANNER: {
    KILL:  '敌人出现，扣动扳机击杀他们',
    CARD:  '很棒的枪法，打破前方气球获得奖励吧',
    RAPID: '再杀两个试试加倍射速的威力吧',
    ELITE: '前方精英来袭',
    SKILL: '射击来不及了，快使用左手侧键的散射技能',
    DONE:  '敌人已清空，拿完奖励去下一个空域',
  },

  // ① 开局两只小怪（前方 + 左边=传送门方向），打完或 10s 超时进下一段
  FIRST: { COUNT: 2, DIRS: ['front', 'frontLeft'], DIST: 15, SPREAD: 6, TIMEOUT: 10 },

  // ② 单张教学卡（选项卡位置）：讲「连杀加速」，拿卡后把连杀数种到 SEED.STREAK
  CARD: {
    ID: 'rapidFire', LABEL: '连杀加速', DESC: '每射击杀敌 10 个，射速加倍 3 秒',
    ICON: 'fireRate', COLOR: '#2e86de', TIMEOUT: 12,   // 12s 未打破 → 选项卡自动默认选择
  },

  // ③ 种连杀数 + 前方五只；杀完或 15s 超时进精英段
  //    STREAK=8 的含义：再杀 2 只（RAPID_FIRE.KILLS=10）就会触发一次加速，教玩家看见「加倍射速」
  SEED: { STREAK: 8, COUNT: 5, DIR: 'front', DIST: 15, SPREAD: 8, TIMEOUT: 15 },

  // ④ 内圈精英（铁甲兵）：血量口径「普通射击打不完 → 逼玩家用散射」
  //    · HP 4000：基线射击 ≈ 100 攻 × 2 发/秒 = 200 DPS → 20s 打不完；
  //      而一次能量散射 = 50 发 × 100 攻 = 5000 → 一击即杀（技能教学才有说服力）
  //    · SPEED 0.5：9m 外飘向玩家 ≈ 10s 才进飞毯，留够「先试着打枪」的时间
  //    · SELF_DAMAGE 0：教学怪不扣血（教学关不该出现玩家被打死重开）
  ELITE: {
    TYPE: 'eliteKnight', HP: 4000, SPEED: 0.5, SIZE_MUL: 3,
    DIST: 9, SPREAD: 3, SELF_DAMAGE: 0,
    HINT_DELAY: 2.4,               // 最早在精英标语 2.4s 后排「用散射」提示（横幅 4s 未播完则继续排队等它收掉）
    // 第六十二修（现场）：「精英出现可以先暂停移动」—— 玩家来不及思考，精英已经撞上场地了。
    //   ⚠ 这里只是**不动**（Balloon.moveFrozen），朝向/受击/血条照常 ⇒ 看着是「它停在那儿瞪着你」，
    //     不是卡死。解除判据见 eliteHoldOver()：放过技能 or 等够这么多秒。
    HOLD_SECONDS: 6,
  },

  // ⑤ 清空横幅 → 稍等片刻（避免横幅压住卡面）→ 正常三选一
  //   第六十二修（现场）：教学关通关**直接送 500 商店币** —— 玩家到第 3 关商店就能直接买一件，
  //   不用先用枪打死几只才敢进商店（「给玩家更快启动」）。
  //   ⚠ **只有教学关给**：第 2~18 关通关一律不奖励（不做关卡结算奖励）⇒ 这笔钱不是
  //     「击杀能量入账」，所以在 _finishTutorial 里直接加 shopCoin，不走 _addShopCoin。
  DONE: { CARD_DELAY: 2.2, SHOP_COIN: 500 },

  // 段落顺序（game/tutorial.js 的推进顺序）
  STAGES: ['first', 'card', 'seed', 'elite', 'done'],
};

// 方位 → 出生中心角（度）与 spawnDirector.DIR_TEXT 同口径：front 0 / frontLeft -45 / frontRight +45
export const TUT_DIR_DEG = { front: 0, frontLeft: -45, frontRight: 45 };

/** 教学关判定（唯一定义）：开关关掉即回到旧第 1 关 */
export function isTutorialLevel(n) { return !!TUTORIAL.ENABLED && Number(n) === TUTORIAL.LEVEL; }

/** 教学关要出现的敌种（预载口径，同 spawnDirector.scriptEnemyTypes） */
export function tutorialEnemyTypes() {
  return ['basic', TUTORIAL.ELITE.TYPE];
}

/**
 * 某段的出生计划（纯函数，便于单测）：返回 [{ type, dir, cfg }]
 *   · first 段 → 前方 + 左前各一只杂鱼（DIRS 有几个出几个）
 *   · seed  段 → 前方 COUNT 只
 *   · elite 段 → 内圈一只精英
 * @param {string} stage 段落 id（TUTORIAL.STAGES 之一）
 * @returns {Array<{type: string, dir: string, cfg: object}>}
 */
export function tutorialSpawnPlan(stage) {
  if (stage === 'first') {
    return TUTORIAL.FIRST.DIRS.map((dir) => ({ type: 'basic', dir, cfg: TUTORIAL.FIRST }));
  }
  if (stage === 'seed') {
    const s = TUTORIAL.SEED;
    return Array.from({ length: s.COUNT }, () => ({ type: 'basic', dir: s.DIR, cfg: s }));
  }
  if (stage === 'elite') {
    return [{ type: TUTORIAL.ELITE.TYPE, dir: 'front', cfg: TUTORIAL.ELITE }];
  }
  return [];
}

/** 某段是否「等场上怪被打完」才推进 */
export function tutorialWaitsKill(stage) { return stage === 'first' || stage === 'seed' || stage === 'elite'; }

/**
 * 教学精英「先暂停移动」何时解除（纯函数，便于单测）。
 *   现场：「实践中发现玩家来不及思考，精英已经撞上场地了」⇒ 精英一出现就**冻住不动**，
 *   等玩家把提示读完、决定动手了再放它走。
 *   解除条件（任一）：
 *     · skillUsed：玩家已经放过技能。教学段只有散射能秒它（4000 HP vs 5000 伤害），
 *       所以「放技能」= 已经读懂提示，不用再等；
 *     · 等够 HOLD_SECONDS：纯兜底，**绝不软锁**（冻住的怪永远不会自爆，必须给它一个下限）；
 *       HOLD_SECONDS <= 0 时直接视为不暂停（等于回到旧行为）。
 *   ⚠「被普通子弹打中」**不算解除**：那正是要教的反例（普通射击打不完 4000 HP），
 *     玩家一边试枪一边看提示是对的，精英该继续等着让他试。
 * @param {number} holdT 已经冻了多少秒
 * @param {boolean} skillUsed 冻住之后玩家放过技能没有
 */
export function eliteHoldOver(holdT, skillUsed) {
  if (skillUsed) return true;
  const H = TUTORIAL.ELITE.HOLD_SECONDS;
  return !(H > 0) || Number(holdT) >= H;
}

/** 某段的兜底超时（秒；0 = 不超时，只等条件） */
export function tutorialTimeout(stage) {
  if (stage === 'first') return TUTORIAL.FIRST.TIMEOUT;
  if (stage === 'seed')  return TUTORIAL.SEED.TIMEOUT;
  return 0;
}
