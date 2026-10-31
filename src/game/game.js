import * as THREE from 'three';
import { TEST } from '../core/constants.js';
import { Player } from './player.js';
import { BalloonManager, isBombMarkTarget } from './balloons.js';
import { ProjectileManager } from './projectiles.js';
import { Vignette } from '../vr/vignette.js';
import { BulletManager } from './bullets.js';
import { WaveManager } from './waves.js';
import { CardDraft } from './cardDraft.js';
import { LaserLevel } from './laser.js';
import { GlassGrid } from './glassGrid.js';
import { FlipGrid } from './flipGrid.js';
import { DragonChest } from './dragonChest.js';   // 第五十修：第12关龙族宝箱（龙 Boss 打死后先计数 5 秒）
import { RightGun } from '../vr/rightGun.js';
import { LeftSword } from '../vr/leftSword.js';
import { DragonBoss } from './dragonLevel.js';
import { CloudFx } from './cloudFx.js';
import { IntroVideo } from './introVideo.js';
import { OpeningModel } from './openingModel.js';
import { Portal } from './portal.js';
import { ShopDraft } from './shop.js';        // 第五十五修：商店关（替代原激光机制关）
import { portraitCanvas, portraitKey, PORTRAIT_STEP_MS } from './enemyPortrait.js'; // 第五十七修 v2：精英预告卡立绘
import { BuddhaFx } from './buddhaFx.js';
import { buddhaSweepDamage } from './buddhaMath.js';
import { BlackHoleFx, isBlackHoleImmune, blackHoleEliteRadius, blackHolePullDuration, blackHoleSlotAngle, blackHoleDiscSlot, segmentCrossesCarpet } from './blackHole.js';
import { LEVELS, isLaser, isBoss, isShop, levelTitleText, shouldShowLevelTitle, levelTitleDelay, shopVoiceReady } from '../content/levels.js';
import { ENEMY_TYPES } from '../content/enemies.js';
import { scriptFor } from '../content/spawnDirector.js';
import { ELITE_SCHEDULE } from '../content/eliteMonsters.js';
import { LEVEL_PLANS, LEVEL_ENEMY } from '../content/spawnPlans.js';
import { ATTR_TYPES, ATTRIBUTE_STATS, SKILL_CARDS, attrPoolForLevel, roleAttrPool, roleBannedCards, applyFireRateSteps } from '../content/cards.js';
import { isTutorialLevel, TUTORIAL, tutorialCardFor } from '../content/tutorial.js';   // 第六十修：教学关（第 1 关）脚本数据
import { TutorialRunner } from './tutorial.js';                       // 第六十修：教学关运行态
import { SHOP_ITEMS, warFeedMul, lifestealChance, strongHunterMul, mibCooldown } from '../content/shopItems.js';
import { BALLOON, BUDDHA, SHIP, SHOOT, LASER, GRID, FLIP, MOVE, EXPLOSION, BLAST_FX, SKY_PANORAMA, DEPTH_SPRITE_STRESS, DEPTH_SPRITE_TYPES, NORMAL_TEST, DDA, FACE_BOSS, PORTAL, SPAWN_RING, GUN_MODES, SCATTER, SCATTER_BURST, BLACK_HOLE, LASER_SWORD, BOSS_BGM, CLOUD, SCORE_CAP, DRAGON, OPENING_MAGICIAN, BASIC_VOICE, MAGICIAN_BOSS, INTRO_VIDEO, HIT_FEEDBACK, FX, MID_WARNING, RAPID_FIRE, levelSecondsOf, CARD, GOLD_ORB, ELITE_FEEDBACK, HEAL_LINK, LEVEL_TITLE, HEAL_ON_DEATH, DRAGON_CHEST, MASK_CHEST, CHEST_BANNER, SHOP, BOMB_LABEL, DANGER_ALARM, CHARACTERS } from '../core/constants.js';
import { basicVoiceNeed } from './basicVoice.js';   // 第六十四修：基础怪「成群」门槛（纯函数）
import { DangerAlarm } from './dangerAlarm.js';   // 第六十一修：内圈报警（滴滴提醒清场）
import { TutorialHintBoard } from './tutorialHint.js';   // 第六十二修：教学关常驻提示板（场地前上方）
import { DamageNumbers } from './damageNumbers.js';
import { FxEffects } from './fx.js';
import { WarningBanner3D, midWarningDue } from './warningBanner.js';  // 第四十二修：中场预警横幅
import { RunSummaryPanel3D } from './runSummaryPanel.js';  // 第九十二修：本局结算面板（VR 内常驻，等平台关闭）
import { advanceStreak } from './rapidFire.js';                // 第四十三修：连杀推进规则（加速期封顶）
import { setRenderer, loadBalloonModel, preCaptureDepthSprite, warmModelGpu } from './balloonModels.js';
import { DifficultyController } from './difficultyController.js';
import { VRPlusGame, VRPlus } from '../net/vrplus.js';   // VR+ 平台桥接：cmd 3 启动 / 4 开始 / 5 中途结束 + 下行 inbox 监听
import { SatelliteRig } from './characters/satellites.js';   // 第八十五修 · 蜂群浮游炮
import { BombardRig } from './characters/bombard.js';        // 第八十五修 · 爆炮手
import { blastDamage, swarmState, bombardState, plagueMaxStacks, poisonTickDamage, infectionStacks, plagueBurstLayers, plagueBurstTargets } from './characters/rules.js';

const KIND_NAME = { normal: '普通关', crisis: '危机关', bonus: '奖励关', boss: 'Boss关', laser: '激光关', shop: '商店关' };
const ORIGIN = new THREE.Vector3(0, 0, 0);
const _WORLD_UP = new THREE.Vector3(0, 1, 0);
// 第六十七修 · 黑洞：逐帧位置计算的复用临时量（不每帧 new）
const _bhPos = new THREE.Vector3();
const _bhRim = new THREE.Vector3();
const _bhDmgPos = new THREE.Vector3();
const _bhRightAxis = new THREE.Vector3();
// 第六十九修：客户端真正实现过的技能 id。技能卡来自 content 包（服务器可覆盖），可能比 APK 新；
//   不在这张表里的 id 一律不装备 / 不上架，避免「买了新技能但按了没反应」。
const SKILL_IDS = ['scatter', 'scatterburst', 'buddha', 'lightsaber', 'blackhole'];
const supportsSkill = (id) => SKILL_IDS.includes(id);
const SKILL_LABELS = {
  scatter: '能量散射', scatterburst: '散射强化', buddha: '如来神掌',
  lightsaber: '激光剑', blackhole: '黑洞',
};

// 线段 a-b 上离点 p 最近点的距离平方（命中判定用：子弹本帧轨迹 vs 怪物球心）
// 退化（a≈b）时回退为点到点距离，不会误判。
const _segAB = new THREE.Vector3();
const _segAP = new THREE.Vector3();
const _segClosest = new THREE.Vector3();
const _segN = new THREE.Vector3(); // 2D立绘命中板法线(朝相机)
const _airburstPos = new THREE.Vector3(); // 第八十八修：火箭 6 米空爆点（复用，不每帧 new）
function _pointSegDistSq(p, a, b) {
  _segAB.copy(b).sub(a);
  const ab2 = _segAB.lengthSq();
  if (ab2 < 1e-12) return p.distanceToSquared(a);
  _segAP.copy(p).sub(a);
  let t = _segAP.dot(_segAB) / ab2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  _segClosest.copy(a).addScaledVector(_segAB, t);
  return _segClosest.distanceToSquared(p);
}

// 线段 a→b 上离点 p 最近的点写入 out（复用 _segAB/_segAP 临时量）
function _closestPointOnSeg(out, p, a, b) {
  _segAB.copy(b).sub(a);
  const ab2 = _segAB.lengthSq();
  if (ab2 < 1e-12) { out.copy(a); return; }
  _segAP.copy(p).sub(a);
  let t = _segAP.dot(_segAB) / ab2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  out.copy(a).addScaledVector(_segAB, t);
}

/**
 * 第四十九修 · 收集「关卡脚本」里会出现的敌种（纯函数，便于单测）。
 *
 * 背景：第四十六修给 1/2/4/5 关加了「三层出怪」时间轴脚本（spawnDirector.SPAWN_SCRIPT），
 *   但 _buildIntroPreloadQueue 当时只收集 SPAWN_RING.pool / NORMAL_TEST.pool / LEVEL_ENEMY /
 *   ELITE_SCHEDULE —— 脚本里独有的敌种就漏在预载之外。现场代价（第 5 关）：脚本要出
 *   heart（心形怪 / 治疗术士），而 ELITE_SCHEDULE[5] 里没有它，于是首只末尾精英落地那一刻才
 *   冷加载 GLB + DepthSprite 抓帧（12 帧离屏渲染 + readRenderTargetPixels 同步回读）。
 *
 * @param {number} levelN 关卡号
 * @returns {string[]} 该关脚本里 elite 事件用到的敌种 id（去重；无脚本 → 空数组）
 */
export function scriptEnemyTypes(levelN) {
  const scr = scriptFor(levelN);
  if (!scr || !Array.isArray(scr.events)) return [];
  const out = new Set();
  for (const ev of scr.events) {
    if (!ev || ev.do !== 'elite') continue;          // 只关心精英批次（杂鱼走 pool，已在上面收集）
    for (const c of ev.combos || []) if (c && c.type) out.add(c.type);
  }
  return [...out];
}

export class Game {
  constructor(world, hud) {
    this.world = world;
    this.hud = hud;
    setRenderer(world.renderer); // 注入 renderer，供 DepthSprite 离屏捕获 GLB

    // DepthSprite 深度调试：按 D 把立绘切到「深度灰度视图」（中心亮=凸，边缘亮=凹）
    window.addEventListener('keydown', (e) => {
      if (TEST.ENABLED && e.code === 'KeyD' && e.ctrlKey && e.shiftKey && !e.repeat) {
        if (this.balloons) this.balloons.depthDebug = !this.balloons.depthDebug;
      }
    });

    this.rig = new THREE.Group();
    world.scene.add(this.rig);
    world.camera.position.set(...SHIP.POS);
    this.rig.add(world.camera);

    this.audio = null; // 由 main 注入
    this.input = null; // 由 main 注入

    // 第六十修 · 教学关（第 1 关）：运行态实例 + 「散射技能免费」标记（_loadLevel 按关重建/复位）
    this.tutorial = null;          // TutorialRunner | null
    this._tutorialFreeSkill = false;
    // 第八十八修 · 角色教学解锁：蜂群「自动追踪」/ 爆炮手「6 米空爆」在第一次教学卡前不生效，
    //   拿卡后本局一直生效（死亡重开教学关会重新上锁，见 _loadLevel）。
    this._roleUnlocks = { satelliteTrack: false, bombardAirburst: false, plagueInfect: false };
    this._satelliteAutoTrack = true;
    this._bombardAirburst = false;
    this._plagueInfect = false;    // 瘟疫医生「感染」：教学卡解锁前不传染
    this._poisonAccum = 0;         // 毒素每秒统一结算的计时器
    this._plagueBurstTimes = [];   // 疫爆连锁预算：滑动窗口内每个被感染目标的时间戳
    this._plagueSfxAt = -1e9;      // 疫爆音效节流，避免同帧多具尸体叠音

    this.player = new Player(world.scene, this.rig);
    this.balloons = new BalloonManager(world.scene);
    // 第六十一修 · 内圈报警：小怪进内圈（头顶爆字闪红）时「滴滴」提醒玩家回头清场。
    //   规则见 game/dangerAlarm.js（每区只让最近的一只发声 / 全场 2s 一个节拍 / 按方位轮转）。
    this.dangerAlarm = new DangerAlarm(DANGER_ALARM);
    this._alarmList = [];      // 复用的候选数组（每帧 length=0 重填，避免 GC）
    // 第六十二修 · 教学关常驻提示板（场地前上方，"随时能读"；只在教学关显示）。
    //   在**构造期**就建好并加进 scene：这样它永远在 _loadLevel 的 _sceneBefore 快照里，
    //   不会被开场穿云当成「本关新物体」从 0 淡入（淡入只由它自己的 FADE_IN 控制）。
    this.tutorialHint = new TutorialHintBoard(world.scene);
    this._skillCasts = 0;      // 本关放过几次技能（教学精英「先暂停移动」的解除判据之一）
    this.projectiles = new ProjectileManager(world.scene); // 远程投射物管理器（手里剑 / 鬼火 / 墨汁）
    this.balloons.setProjectileManager(this.projectiles);  // 让气球系统驱动「同种怪里最近者投掷」
    this.vignette = new Vignette(world.camera);            // 命中着色层（相机子节点，随头动）
    // 命中：扣飞船血量（飞毯无独立 HP）+ 视野周边着色（鬼火=紫 / 墨汁=黑；手里剑无 TINT → 不着色）
    this.projectiles.setOnHit((d, kind) => {
      this.player.takeDamage(d);
      this._pulseHaptic('HURT');   // 第四十修：被投射物打中 → 双手重震
      const tint = this.projectiles.tintOf(kind);
      if (tint != null) this.vignette.flash(tint);
    });
    this.bullets = new BulletManager(world.scene, world.camera);
    // 第八十五修 · 角色专属武器：浮游炮 / 爆炮手。二者都复用 BulletManager，不新增子弹系统。
    this.satellites = new SatelliteRig(world.scene, world.camera);
    this.bombard = new BombardRig();
    // DDA：内置战斗监测（每帧由 _ddaMetrics() 读取玩家/场上状态），喂给 WaveManager 调度出怪
    this.dda = new DifficultyController(() => this._ddaMetrics());
    this.waves = new WaveManager(
      world.scene, this.balloons,
      // 玩家在游戏世界中的**实际位置** = 相机（头部）世界坐标的水平投影（y 归零，沿用"脚下地面位置"语义）。
      // ⚠ 不能用 rig.getWorldPosition()：rig 只承载手柄位移，玩家「现实行走」写在相机（rig 的子节点）上，
      //   只用 rig 位置会在真实行走时让敌人/传送门/激光仍按旧位置计算，与实际站位错位。
      () => { const v = this.world.camera.getWorldPosition(new THREE.Vector3()); v.y = 0; return v; },
      this.dda,
      () => this._portals,
      () => this._playerDPS(),     // 新：玩家 DPS（内外圈调度基准）
      () => this.skillCooldown,    // 新：技能剩余冷却（>3 = 最近5秒放过技能 → 内圈系数=1）
      (dmg) => this.player.takeDamage(dmg), // 新：Boss 子系统（激光/九宫格）伤害玩家
      world.camera,                        // 新：玩家相机（通关横幅锚定准星位置）
      // ★ 第三十九修：第18关 Boss 击杀 = **本局自然结束**（不再是「回菜单」—— 回菜单不带
      //   roundOver，浏览器不关、页面停在菜单，平台下一次「启动游戏」一到就从第 1 关重开，
      //   现场表现即「Boss 打死后过一会又回到第一关」）。
      () => this._onFinalBossClear()
    );
    this.cards = new CardDraft(world.scene);
    this.rightGun = new RightGun(world.scene);   // 右手柄 AK 枪（VR 手持，纯视觉）
    this.leftSword = new LeftSword(world.scene);  // 左手柄激光剑（选卡装备后常驻，激活后5秒伤害）

    this.state = 'menu';
    this.gunMode = 'preview';   // 枪械模式：preview=初始态, full=满状态（由预览界面按钮经 start() 注入）
    this.levelIndex = 0;
    this.laser = null;       // 激光关实例（仅第3关）
    this.laserMode = false;  // 当前是否处于激光关
    this.grid = null;        // 第九关玻璃走格子实例（仅第9关）
    this.gridPhase = false;  // 是否处于走格子阶段
    this.flipGrid = null;    // 第十五关九宫格实例（仅第15关）
    this.flipPhase = false;  // 是否处于"安全解谜期"(18s 后、激光不致命)
    this.flipTimer = 0;      // 180s 倒计时剩余秒
    this.dragon = null;      // 第十二关龙 Boss 实例（boss==='dragon' 时存在）
    this.cloudFx = null;       // 关卡开场穿云特效（cloudFx.js），4秒后自动移除
    this._introActive = false; // 开场门控：true 时冻结出怪/Boss/机制动画（仅自然转头）
    this._pendingBgm = null; this._pendingOpenVoice = null; this._shopVoicePending = false; this._bossT = 0; this._bossInten = BOSS_BGM.START_INTENSITY; // 穿云结束后启动的本关音频（程序化 BGM 轨道 + Boss 升压状态）
    this._introT = 0;          // 开场计时（秒）
    this._introPreloadQueue = null; // 穿云窗顺序预载队列（[{url,radius,capture}]）
    this._introPreloadIdx = 0;     // 队列处理游标
    this._levelTasks = null;       // 第四十五修：本关「场景构建」分帧任务队列（穿云窗内每帧跑一组，见 _pumpLevelTasks）
    this.openingModel = null;  // 第3/9/15关开场动画模型（魔术师动画版），10秒后自动移除
    this._openingVoiceSeq = 0; // 开场语音联动序号：切关/回菜单自增，使未播完的 ended 回调作废
    this._gameTime = 0;        // 全局累计时间（秒）：激光剑状态/每怪1秒限频的时间基准
    this._swordUntil = 0;      // 激光剑伤害状态结束时刻（this._gameTime 基准）
    this._swordReadyMarked = false; // 激光剑「已完全展开」标记：展开那一刻才起算 DURATION 秒（展开动画不计入）
    this._hilt = new THREE.Vector3();  // 激光剑剑柄世界坐标（每帧命中检测复用）
    this._tip = new THREE.Vector3();   // 激光剑剑尖世界坐标
    this._portals = [];        // 小怪关传送门装饰（非 boss、非激光机制关，前后左右各 20m）
    this._collectedCards = [];   // 本局收集的选项卡 id 列表（供第18关通关汇总展示）
    this._runStats = { kills: 0, basic: 0, elite: 0, boss: 0 }; // 本局杀敌统计（结算面板）
    this._maxCombo = 0;          // 本局最高连击（结算面板）
    this._runSkillCasts = 0;     // 本局主动技能释放次数（结算面板）
    this._runResultShown = false;// 结算面板只弹一次
    this._runResultPanel = null; // 3D 结算面板实例
    this.score = 0;
    this._buddhaFx = null;
    this._buddhaHit = new Set(); // 当前如来神掌已命中气球集合（防止重复结算）
    this._palmWindUntil = 0;      // 第八十四修：掌风弹窗口结束时刻（_gameTime 基准）
    this._palmWindTotal = 0;      // 本次掌风弹总时长（供技能框倒计时使用）
    this._palmWindStarted = false; // 本次神掌是否已进入掌风弹阶段（防同一次横扫重复触发）
    // 第六十七修 · 黑洞（第 3 关第三张技能卡）：洞心 / 已捕获怪物 / 伤害节拍 / 视觉
    this._bhActive = false;
    this._bhFx = null;
    this._bhT = 0;
    this._bhDamageAcc = 0;
    this._bhCenter = new THREE.Vector3();
    this._bhTargets = null;
    this._cardState = null;
    this._levelSnapshot = null;  // 关卡开始时的玩家属性+分数快照
    this._explosions = [];       // 爆炸视觉特效列表
    this._blastFx = [];          // 爆炮手爆炸球壳（与气球自爆分开，避免闪屏/视觉半径失真）
    this._lastBlastFxAt = -99;
    this.damageNumbers = new DamageNumbers(world.scene); // 伤害数字（第四十修）
    this.fx = new FxEffects(world.scene);   // 档2 打击感视觉层（第四十一修）：曳光/火花/碎片/枪口焰
    this._tailDir = new THREE.Vector3();    // 曳光方向临时向量（避免每帧 new）
    this.midWarning = new WarningBanner3D(world.scene, world.camera); // 中场预警横幅（第四十二修）：每关过半弹一次
    // —— 第四十六修：三层出怪 / 精英反馈 / 金点引导 ——
    this._skillLocked = false;       // 第4关开局锁技能（横幅结束解锁，见 _updatePlaying）
    this._skillUnlockAt = 0;         // 解锁的脚本秒
    this._goldOrbs = [];             // 引导金点（批次清空 → 飞向选项卡 → 开抽卡）
    this._midDraftPending = false;   // 关卡中途抽卡进行中（挡住同帧的通关抽卡）
    this._levelClearHeld = false;    // 本关已通关，但被中途抽卡/金点在飞挡住
    this.combo = 0;              // 连击计数：HIT_FEEDBACK.COMBO.WINDOW 秒内的连续击杀数
    this._comboUntil = 0;        // 连击失效时刻（this._gameTime 基准）
    this._hapticAt = { HIT: -99, KILL: -99, ELITE: -99, HURT: -99 }; // 各档震动上次触发时刻（节流用）
    this._fxPos = new THREE.Vector3(); // 伤害数字取位临时向量（避免每次命中 new）
    // —— 第四十二修 · 连杀加速（只认子弹击杀，计数显示在枪管上，见 src/vr/streakCounter.js）——
    this._bulletStreak = 0;       // 当前连杀数
    this._bulletStreakAt = -99;   // 上次子弹击杀时刻（_gameTime 基准），超 RAPID_FIRE.GAP 清零
    this._rapidUntil = 0;         // 射速加速结束时刻（_gameTime 基准）
    this._rapidMul = 1;           // 当前生效的射速倍率（1=无加成），交给 input.setFireRateMul
    this._midWarned = false;      // 本关是否已弹过中场预警（_loadLevel 复位）
    // 第四十九修 · 关卡标题卡：开局在准星正前方弹「第 N 关 · 场景名」（见 constants.LEVEL_TITLE）
    this._levelTitleAt = 0;       // >0 = 还剩这么多秒就弹；0 = 不弹
    this._levelTitleText = null;  // 待弹文案（_queueLevelTitle 填好，_tickLevelTitle 消费）
    this._levelTitleDone = false; // 本关是否已经弹过（第四十九修返工：机制关要「语音结束后补排」，防重复弹）
    this._draftsThisLevel = 0;    // 第四十七修：本关已开过的抽卡次数（一关只给一次，_clearRoundExtras 复位）
    // 第五十修 · 第12关龙族宝箱：龙 Boss 打死后先立宝箱、5 秒射击计数换攻击力（见 src/game/dragonChest.js）
    this._chest = null;           // DragonChest 实例（首次触发时懒建；表现/计数都在它自己身上）
    this._chestDone = false;      // 本关宝箱窗口是否已经开过（_clearRoundExtras 复位）
    this._chestPending = 0;       // 宝箱出现前的 2 秒横幅倒计时（>0 时 _chestRunning 为真，挡住通关抽卡）
    this._chestCfg = null;        // 本关宝箱配置（MASK_CHEST / DRAGON_CHEST）
    this._buddhaQueue = [];       // 如来神掌分帧结算队列（第四十二修，见 _drainBuddhaQueue）
    this.enemyFreeze = 0;        // 定身咒计时(s)：>0 时敌人暂停行动（Boss 仅前 50% 时长）
    this.selectedSkill = 'scatter'; // 当前装备技能：前期默认「能量散射」；第3关商店可换 lightsaber/buddha/blackhole，左手柄 grip 触发
    this.skillCooldown = 0;      // 技能释放冷却计时(s)：>0 时握柄无效，HUD 显示剩余
    // —— 第五十五修 · 商店关（第3/9/15关，替代原激光机制关）——
    this.shopDraft = null;       // ShopDraft 实例（每进一次商店关新建，见 _enterShop）
    this.shopMode = false;       // 当前是否处于商店关
    this.shopCoin = 0;           // 商店币：击杀能量等额累积；一局（1→18 关走完）清零，与 score 完全独立
    // 第六十五修：击杀金点（fx.CoinOrbFx）的终点 = 枪上「商店币」小框的当帧世界坐标
    //   （小框没建 / 没挂上 → 返回 null ⇒ 在飞的金点立刻落地，数字照变，不会卡账）
    this._coinTarget = (out) => (this.rightGun ? this.rightGun.coinBadgeWorldPos(out) : null);
    this._itemLv = {};           // 本局道具等级 { itemId: level }（可重复购买升级）
    this._candyCount = 0;        // 串糖葫芦：全局累计已发射弹数（每满 10 发追加穿甲弹）
    this._mibUntil = 0;          // 多才是王道：临时弹道生效截止时刻（_gameTime 基准）
    this._mibNextAt = 0;         // 多才是王道：下次自动触发时刻（冷却从买完开始算）
    this._shopLeft = 0;          // 商店关剩余秒数（供腕表面板显示）
    // 追踪弹目标解析（打狗还要看主人）：目标已死 / 已离场 → 返回 null（子弹直飞）
    this._homingTarget = (b) => {
      const t = b.homing;
      if (!t || !t.alive || !this.balloons.list.includes(t)) return null;
      return t.mesh.position;
    };

    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._camPos = new THREE.Vector3(); // 每帧刷新相机世界坐标，供 2D 立绘薄板命中(法线=朝相机)

    // —— VR+ 平台下行命令监听（平台可远程「关闭」游戏）——
    // 此前只上行发 cmd3/4/5，从不处理平台下发的命令 → 表现为「平台点关闭关不掉」。
    // 现在轮询 /api/vrplus/inbox：平台发来的 关闭(cmd16=游戏通道 0x10 closeGame) 由本类响应。
    // ⚠ 2026-09-16 修 bug：inbox 里每项是**对象** `{"cmd":N,...}`（APK 侧 drainInbox 返回
    //   JSONObject 数组），旧代码把对象直接传进 _onPlatformCommand 再与数字比较 → `obj === 3`
    //   恒为 false，平台命令实际上一条都没生效。这里统一取出 cmd 数值，并把原始对象一起传下去
    //   （平台机器表 {"Machines":[...]} 会被 APK 包成 cmd=0，见 VRPlusLink.handleConnectPayload）。
    // ★ 本页「出生时刻」+ 只认本页之后入队的平台指令（见下方 startInbox 门禁）。
    //   2026-09-17 定位「打开预览界面 1 秒闪退」：APK 的 inbox 是**进程级**队列、跨会话存活
    //   （进程由 CastService 保活），平台每局结束都会给头显发一条 closeGame；若当时页面没在轮询
    //   （加载中 / 已卸载 / APK 正被 force-stop），这条 cmd=16 会一直留着，新页面首轮轮询
    //   （1000ms，首轮立即执行）一拿到就自杀 —— 症状正是「打开预览界面 1 秒闪退」，
    //   而且**与 PC 端 exe 无关**（所以把 exe 换回原版也救不了）。
    this._pageT0 = Date.now();
    VRPlus.startInbox((msg) => {
      if (msg == null) return;
      const n = (typeof msg === 'number') ? msg : Number(msg.cmd);
      if (!Number.isFinite(n)) return;
      // ★ 时序门禁：只丢「上一会话的**会话终止类**指令」（16=closeGame / 5,6=旧平台结束）。
      //   为什么不一律丢：机位表(cmd=0)是**合法早于页面**的 —— 注册握手发生在页面加载之前
      //   （APK 一被拉起就发 0x01，平台 57ms 就回表），一刀切会把这张表也丢掉。
      //   ★ 第二十修再加两条：21 = 平台「开始游戏」（见 _onPlatformCommand 的 21 分支）；
      //     3 + plat = APK 转达的平台开局。残留的这两条会让**新页面**一打开就放开「进入 VR」
      //     （= 操作员还没点「开始游戏」，头显就先冒出按钮），所以同样按残留丢弃。
      const staleKill = (n === 16 || n === 5 || n === 6 || n === 21 || (n === 3 && msg.plat))
        && msg.t && msg.t < this._pageT0;
      if (staleKill) {
        this.log(`忽略上一会话残留的关闭指令 cmd=${n}`
          + `（入队于本页启动前 ${Math.round((this._pageT0 - msg.t) / 1000)}s，已丢弃）`);
        return;
      }
      this._onPlatformCommand(n, msg);
    }, 1000);

    // 平台关闭看门狗：比 start() 更早启动，菜单态（未进入 VR）下平台关掉 APK 也能检测到。
    // requireFirstAlive: 先确认 APK 在线再计失败，避免开局加载期偶发 fetch 失败误触发退出。
    // 1.5s × 4 ≈ 6s：头显给后台页面节流时单次 fetch 失败很常见；门槛太低会在加载到一半时
    // 就把自己卸载成 about:blank（2026-09-16 实测形态「起来 3 秒进度条一半就闪退」）。
    // onTick 仅供页面诊断面板显示（见 main.js），不参与逻辑。
    this._goneHandled = false;   // 防 _onPlatformGone 重复执行
    this._confirming = false;    // 「判死复核」进行中（防重入，见 _confirmThenGone）
    this._reviveTimer = null;    // 加载期「误判自愈」定时器（见 _startReviveProbe）
    this._closedByPlatformCommand = false;  // 平台**明说**要关（0x10 closeGame）→ 禁止自愈
    // ★ 2026-09-19 四修：平台关闭后**不再卸载页面**，改为进「待机态」（见 _enterClosedIdle）。
    //   _closedIdle：当前处于待机态（供状态上报 cs=1，APK 据此判断「页面活着但要重新开局」）；
    //   _renderPaused：主循环是否跳过 game.update/world.render（待机期省 GPU、不发烫）。
    this._closedIdle = false;
    this._renderPaused = false;
    this.preloadDone = false;    // main.js 的进度条是否走完（setPreloadDone 置 true）
    this._gameEndReportedAt = 0;         // 上次上报「本局结束」的时刻（去抖，见 _reportGameEnd）
    this._masterRoundEndSent = false;    // 本局结果是否已发 CMD 7（结算面板先发一次，平台关闭时不重发）
    // ★ 2026-09-23：「本轮是否真的结束」（通关 / 平台关闭 / 主控端结束）——一次性标志，
   //   _endRound 读它并复位；玩家中途退出 VR 回菜单时**不是**本轮结束（那一局还能再进）。
    this._roundOver = false;
    // ★ 第十二修：「平台开始 / 结束」信号的回调口（main.js 用它开关「进入 VR」按钮门禁）。
    //   默认 null = 没人监听 → _platformSignal 空操作。门禁这类**界面策略**不进游戏内核，
    //   内核只负责「如实播报平台说了什么」。
    //   · onStart：平台**真的说了「开始游戏」**（inbox cmd3/4）→ 开门禁；
    //   · onEnd  ：平台结束本局（cmd16 / 旧 cmd5,6 / 进待机态）→ 关门禁；
    //   · onSeen ：**平台在场**（收到过平台下发的东西，未必是开局）→ 只用于留痕与兜底判读。
    this.platformHooks = { onStart: null, onEnd: null, onSeen: null };
    // 看门狗路径**先复核再执行**（confirm:true）：连败 4 次未必是 APK 真死 —— 头显给后台页
    // 节流时 fetch 偶发失败很常见，误判的代价是整个页面被卸载（「起来几秒闪退」）。
    VRPlus.startAliveWatch(() => this._onPlatformGone('APK 探活连续失败', { confirm: true }), {
      intervalMs: 1500, maxFails: 4, requireFirstAlive: true,
      onTick: (info) => { this._aliveInfo = info; },
    });
  }

  setSystems(audio, input, wristUI = null, pageLog = null, cast = null) {
    this.audio = audio; this.input = input; this.wristUI = wristUI; this.pageLog = pageLog;
    // ★ 2026-09-23：直播推流句柄 —— 直播模式下本局结束要**停推流**（见 _onPlatformGone 的
    //   cast 分支）。不注入时为 null，非直播场景零影响。
    this.cast = cast;
    this.leftSword.setAudio(this.audio); // 注入音效管理器，供激光剑嗡鸣随剑出现/消失
    this.waves.audio = audio; // 注入音频到波次管理器（脸谱Boss 召唤语音用）
    this.projectiles.setAudio(this.audio); // 注入音频，供投射物投掷/命中音效
  }

  /** 新一局/重新开局：清空结算面板用的统计。 */
  _resetRunStats() {
    this._runStats = { kills: 0, basic: 0, elite: 0, boss: 0 };
    this._maxCombo = 0;
    this._runSkillCasts = 0;
    this._runResultShown = false;
  }

  _recordRunKill(balloon) {
    if (!balloon) return;
    const s = this._runStats || (this._runStats = { kills: 0, basic: 0, elite: 0, boss: 0 });
    s.kills++;
    if (balloon.isBoss) s.boss++;
    else if (balloon.isElite) s.elite++;
    else s.basic++;
  }

  // 游戏内日志：同时送往左手腕面板（VR 可见）和页面日志（预览可见、最高优先）
  log(msg) {
    this.wristUI?.log(msg);
    this.pageLog?.log(msg);
  }

  // playIntro：是否播放「进入游戏」开场视频；null（默认）= 从第 1 关开局时播。
  //   真正生效还需 INTRO_VIDEO.ENABLED 且当前处于 VR 会话内（world.isPresenting）——
  //   three.js 在派发 sessionstart（main.js 里触发本方法）之前就已置 isPresenting=true，
  //   所以「桌面预览」与「关卡直达面板」自然都不播视频。
  start(atIndex = 0, gunMode = 'preview', playIntro = null, loadout = null) {
    this.gunMode = gunMode;
    this.loadout = loadout || null;        // ★ 第二十二修：本局开局加成（rapid / power / null）
    const withIntro = (playIntro === null) ? (atIndex === 0) : !!playIntro;
    this._disposeIntroVideo();  // 防御：上一次过场若异常残留，先释放并还原背景
    // 从待机态（平台已关闭本局）被唤醒时，一并清掉待机标记与渲染暂停 ——
    // 否则新一局会「逻辑在跑但画面不刷新」（_renderPaused 是 main.js 主循环的开关）。
    // 封盖也一并撤掉：只要真的开了新一局，就不该再盖着「本局已结束」。
    this._closedIdle = false;
    this._renderPaused = false;
    this._hidePlatformClosed();
    this._disposeRunResultPanel();
    this._resetRunStats();
    this._collectedCards = [];        // 新一局：清空上一局抽到的强化/技能，结算统计不串局
    this._masterRoundEndSent = false;
    this.player.reset(gunMode, this.loadout);
    this.bullets.setDefaultTint(this.player.character?.bulletTint ?? null);
    // 新一局：角色教学解锁重新上锁（教学关卡里拿卡后才开）。
    this._roleUnlocks = { satelliteTrack: false, bombardAirburst: false, plagueInfect: false };
    this._satelliteAutoTrack = true;
    this._bombardAirburst = false;
    this._plagueInfect = false;
    this._poisonAccum = 0;
    this._plagueBurstTimes.length = 0;
    this.satellites?.reset();          // 第八十五修：换角色/重开时不残留上一局的浮游炮
    this.input?.setGunMode(gunMode);
    this.player.input = this.input; // 让射速卡能触达真实节流源（input.setFireRateMul）
    this.balloons.clear();
    this.projectiles.clear(); // 清远程投射物（与气球一并复位）
    this.vignette.clear();
    this.bullets.clear();
    this.score = 0;
    this.shopCoin = 0;
    this._itemLv = {};
    this._candyCount = 0;
    this._mibUntil = 0;
    this._mibNextAt = 0;
    this.hud.showShopCoin(false);
    this.levelIndex = atIndex;
    this.gridPhase = false;
    this._lastCell = 0;
    this._failing = false;
    this._failTimer = 0;
    this.hud.hideStart();
    this.hud.clearMessage();
    this.hud.setScore(0);
    this.hud.setHp(this.player.hp, this.player.maxHp);
    this.audio?.unlock();
    this._clearExplosions();
    this._clearRoundExtras();     // 第四十六修：清金点/治疗线/技能锁
    this.damageNumbers.clear();   // 新一局：清掉上一局残留的伤害数字
    this.fx.clear();              // 档2：一并清掉上一局残留的曳光/火花/碎片/枪口焰
    this.midWarning?.hide();      // 第四十二修：收掉上一局残留的中场预警横幅
    this._bulletStreak = 0; this._rapidUntil = 0; this._setRapidMul(1);
    this._buddhaQueue.length = 0;
    this.combo = 0;
    this.attackBonus = 0;     // 新一局：攻击力加成重置，从 0 重新累计
    this._clearAttackHint();  // 清残留攻击力提示
    this.log(`游戏开始${this.loadout ? `（角色：${CHARACTERS[this.loadout]?.name || this.loadout}）` : ''}`);
    VRPlusGame.launch();   // cmd 3 启动游戏（上报平台：游戏已启动，等待握手完成）
    // 进入 VR 后播放开场视频：仅在 VR 会话内(isPresenting) 且本关是首关(withIntro) 时。
    //   ⚠ 不再以「是否独立头显」排除：PICO 浏览器伪造桌面 UA，UA 判定既不可靠又会错误跳过视频；
    //      头显上视频由 introVideo.js 的 10Hz 强制刷新兜底，实测可正常播放（含声音）。
    if (INTRO_VIDEO.ENABLED && withIntro && this.world.isPresenting) {
      this._startIntroVideo();      // state='intro'：先播开场视频，播完再 _loadLevel(0)
    } else {
      this._loadLevel(this.levelIndex);
      this.state = 'playing';
      VRPlusGame.begin();   // cmd 4 开始游戏（不走过场时直接开局）
    }
  }

  // ====== 进入游戏前的开场视频过场（VR 内播 MP4，详见 src/game/introVideo.js）======
  // 舞台：场景只留「飞毯 + 星空」（纯黑底，world.setIntroBackdrop(true)）；
  // 播完 / 出错 / 看门狗兜底任一触发 → 收尾进第 1 关（随后照常走穿云过场，同时摊本关预载）。
  _startIntroVideo() {
    this._disposeIntroVideo();
    this._introStage = true;
    this._introHandoffT = 0;
    this.world.setIntroBackdrop(true);
    // 第四十四修：把「本关（第 1 关）全景」的下载/解码/GPU 上传 + 穹顶材质编译**提前到影片期间**做完。
    //   现场现象：影片播完「转头那一下」黑边 + 卡顿。根因是交接那一帧才第一次做这些重活
    //   （全景 JPG 解码 → 4K×2K 约 33MB + initTexture(GPU 上传) + 穹顶材质编译），一帧拉长几十~几百毫秒 → WebXR 合成器补不出这么长的位移 → 视野边缘露黑边。
    //   此刻天空本来就被 setIntroBackdrop(true) 隐藏，预热对画面零影响；预热后 _loadLevel 里的
    //   setSkyPanorama 会命中「已缓存且已 _gpuReady」→ 同步套用，不再有那一下卡顿。
    try {
      const lv0 = LEVELS[this.levelIndex];
      const pano0 = lv0 ? SKY_PANORAMA[lv0.n] : null;
      if (pano0) this.world.warmSkyPano(pano0, this.world.camera);
    } catch (e) { /* 预热失败不影响开场 */ }
    // 直播（?cast=1）：影片阶段头显不解码（解码×H.264 编码争 VPU → 头显闪屏）→ 不推流，
    // 改让 PC 端本地播同一段影片：cast.js 读 scene.userData.castIntro 判定「影片阶段」，
    // 靠 notifyIntro('play'/'end') 与 PC 端对齐起止（见 src/net/cast.js）。
    try {
      if (this.world.scene?.userData) this.world.scene.userData.castIntro = true;
      window.__cast?.notifyIntro?.('play', INTRO_VIDEO.SRC);
    } catch (e) { /* 未启用直播则忽略 */ }
    this.log('开场视频开始（舞台：飞毯 + 星空）');
    this._introVideo = new IntroVideo(this.world.scene, {
      audio: this.audio,
      log: (m) => this.log(m),
      onDone: (reason) => this._onIntroVideoDone(reason),
    });
    this._introVideo.start();
    this.state = 'intro';
  }

  // 过场期间每帧驱动（该状态不跑 _updatePlaying，故玩家不能移动/射击、不出怪）
  _updateIntro(dt) {
    this._introVideo?.update(dt);   // 帧驱动看门狗（时长 + INTRO_VIDEO.WATCHDOG_PAD_S）
    // 视频已结束：画面静止 HANDOFF_DELAY_S 后再做「加载关卡」这类重活
    if (this._introHandoffT > 0) {
      this._introHandoffT -= dt;
      if (this._introHandoffT <= 0) this._commitIntroToLevel();
    }
  }

  // 视频结束（播完 / 出错 / 看门狗兜底）——**这一帧不做重活**。
  //   用户实测：视频结束瞬间会卡顿一下。根因是「解码器回收 + 关卡加载 + 淡入材质切换」与**仍在播放的视频**
  //   挤在同一帧 → 表现为视频最后几帧顿挫。改为：先暂停并保留最后一帧（静止画面），延迟 HANDOFF_DELAY_S
  //   再加载关卡；解码器回收再往后推迟到穿云期间。静止画面上的长帧基本不可感知。
  _onIntroVideoDone() {
    this._introVideo?.holdLastFrame();
    this._introHandoffT = INTRO_VIDEO.HANDOFF_DELAY_S;
  }

  // 交接：摘除视频画面（廉价）→ 还原背景舞台 → 加载第 1 关（重活，此时画面已静止）
  _commitIntroToLevel() {
    const iv = this._introVideo;
    this._introVideo = null;
    if (iv) {
      iv.detach();                              // 只从场景摘除：解码器/纹理继续存活
      this._introVideoPending = iv;             // 真正 dispose 延迟到穿云里，别和关卡加载抢同一帧
      this._introPendingT = INTRO_VIDEO.DISPOSE_DELAY_S;
    }
    if (this._introStage) {
      this._introStage = false;
      this.world.setIntroBackdrop(false);       // 天空球必须已可见（第 1 关穿云靠 setEnvOpacity(0→1) 淡入）
    }
    // 直播：先通知 PC 端结束本地影片（必须在清掉 castIntro 之前发，否则 cast.js 会立刻建离屏渲染器）
    try {
      window.__cast?.notifyIntro?.('end');
      if (this.world.scene?.userData) delete this.world.scene.userData.castIntro;
    } catch (e) { /* 未启用直播则忽略 */ }
    this._loadLevel(this.levelIndex);
    this.state = 'playing';
    VRPlusGame.begin();   // cmd 4 开始游戏（过场结束，正式进入第 1 关）
  }

  // ====== VR+ 平台下行命令处理 ======
  // 平台可远程控制游戏：cmd3/4 = 启动/开始（客户端启动后由平台驱动开局）；cmd5/6 = 中途/正常结束（关闭游戏）。
  //
  // ★ 2026-09-19 第十二修：内核只**如实播报**「平台开始了 / 平台结束了」，具体界面策略
  //   （例如「进入 VR」按钮门禁）由 main.js 注册 platformHooks 决定 —— 内核不碰 DOM。
  _platformSignal(kind, why) {
    try { this.platformHooks?.[kind]?.(why); } catch (e) { /* 监听方出错绝不影响游戏 */ }
  }

  _onPlatformCommand(cmd, payload = null) {
    if (cmd === 0) {
      // cmd 0 = APK 封装的「平台连接配置」：平台回给设备上线的 {"Machines":[机位…],"Language":…,
      // "RoomId":…,"IsPlayLogo":…}（平台侧日志叫 SendConnectMsgToGame/PlayerConnectHandle）。
      // 单机玩法用不到机位表，但这是**平台确实认到我们**的证据，记一条便于排错（不过滤、不当开局）。
      const n = (payload && Array.isArray(payload.machines)) ? payload.machines.length : 0;
      this._platformConnect = payload;
      this.log(`平台连接配置：Machines=${n}，RoomId=${payload?.roomId ?? '-'}`);
      // ⚠ 第十三修：机位表**不再**当作「平台开始了本局」。留痕实测（page-forensics (4).log）：
      //   APK 每补发一次 0x01，10ms 后平台就回一张表 ⇒ 它只是**注册回执**，任何一次 APK 启动
      //   都会有它，与「平台是否开始这一局」无关。把它当开局信号 = 门禁形同虚设（实测正是如此）。
      //   现在它只告诉界面「平台在场」（用于区分兜底的两种原因），见 main.js 的 platformHooks.onSeen。
      this._platformSignal('onSeen', `平台机位表（Machines=${n}）→ 平台在场`);
      return;
    }
    // ★ 2026-09-23（第二十修）：cmd 21 = **平台「开始游戏」**。
    //   来源：APK 的 VRPlusLink 收到游戏通道 CMD 5 `GameStart`（\x05 + JSON）就入队这一条。
    //   这是现场实测的**唯一**真正的开局帧（用户第五次反馈：「第二步是平台点开始游戏，
    //   这个时候头显里才会显示进入VR」）；cmd3/4 只是「把页面拉起来 / 叫回来」。
    if (cmd === 21) {
      this._hidePlatformClosed();          // 平台（重新）开始本局：撤掉「已结束」封盖
      this._closedIdle = false;
      this._renderPaused = false;
      this._goneHandled = false;           // 允许本局结束后再次响应平台关闭
      this._closedByPlatformCommand = false;
      if (this._reviveTimer) { clearInterval(this._reviveTimer); this._reviveTimer = null; }
      const gid = payload?.start?.gameId;
      this._platformSignal('onSeen', '平台「开始游戏」（CMD 5 GameStart）→ 平台在场');
      // ★ 开门禁：平台**本人**说了开始 → 玩家这才被允许进 VR（main.js 显示按钮）
      this._platformSignal('onStart', '平台「开始游戏」（游戏通道 CMD 5 GameStart'
        + (gid != null ? '，gameId=' + gid : '') + '）');
      this.log('平台「开始游戏」→ 已放开「进入 VR」按钮，等玩家自己进 VR 开局');
      VRPlus.reportEvent('platform-start', { cmd, gameStart: true, gameId: gid ?? null });
      return;
    }
    // cmd 3/4 = 平台「启动 / 开始游戏」（旧平台兼容路径；新平台改用 `am start` 拉起整个页面）。
    // ⚠ 2026-09-16 修正：0xff(255) **不是**开局信号（那是平台对 0x01 的心跳应答）。
    // ⚠ 2026-09-17 补充：新平台（抓包实测）根本不通过这条通道下发 3/4 —— 它用
    //   `am start -d <平台IP>` 把整个游戏拉起来，开局由页面自己完成。
    // ★ 2026-09-19 第十三修：**平台说「开始」≠ 替玩家开局。**
    //   到达这里的两类语义都只是「把游戏页拉起来 / 叫回来」；而开局**只能**由玩家手势触发
    //   （immersive-vr 会话无法程序化创建，见 main.js 的 sessionstart → game.start）。
    //   旧代码在这里顺手 start(0) 的实测后果（留痕 17:40:11 那一轮）：玩家还没进 VR（XR=off）
    //   页面就在播开场影片，影片播完自动进第 1 关 —— 与「第一次启动停在菜单等玩家点开始」
    //   行为不一致，且这一局在玩家戴上头显之前就已经走掉了。
    //   现在语义统一：**平台「开始」= 放开「进入 VR」门禁 + 把页面叫回菜单**，
    //   真正开局仍是 sessionstart 里的 game.start()。
    if (cmd === 3 || cmd === 4) {
      this._hidePlatformClosed();   // 平台（重新）拉起本局：撤掉「已结束」封盖
      this._closedIdle = false;
      this._renderPaused = false;
      this._goneHandled = false;    // 允许本局结束后再次响应平台关闭
      // 平台（重新）拉起 = 新一局 → 一并撤销上一局的「明说关闭」标记与自愈探针，
      // 否则上一局的 closeGame 会永久禁掉本局的自愈能力。
      this._closedByPlatformCommand = false;
      if (this._reviveTimer) { clearInterval(this._reviveTimer); this._reviveTimer = null; }
      this._platformSignal('onSeen', '平台拉起页面 cmd=' + cmd + '（平台在场）');
      // ★ 第二十修：cmd3/4 **不再**开门禁 —— 它只表示「把游戏页拉起来 / 叫回来」。
      //   现场实测（用户第五次反馈）：平台是**两步** —— 第一步「启动游戏」拉起页面（就是这一类
      //   动作 + APK 本地唤醒待机页），第二步「开始游戏」才该出现「进入 VR」。平台真正的开局帧
      //   是游戏通道 CMD 5 = inbox **cmd 21**（见上面 21 分支）。
      //   只有带 `plat` 标记的才照旧开门禁 —— 那是 APK 明确转达「平台已开始本局」（老链路保底）。
      if (payload?.plat) {
        this._platformSignal('onStart', 'APK 明确转达：平台已开始本局（本次拉起由平台驱动）');
        this.log('平台已开始本局（APK 转达）→ 回到菜单，等玩家点「进入 VR」');
        VRPlus.reportEvent('platform-start', { cmd, plat: true });
      } else {
        this.log('平台拉起本局页面（cmd=' + cmd + '）→ 只回菜单；等平台点「开始游戏」'
          + '（游戏通道 CMD 5）才放开「进入 VR」');
      }
      return;
    } else if (cmd === 16) {
      // 【2026-09-17 新增】平台关游戏 —— 游戏通道 `0x10 closeGame`（APK 侧已代为回 0x02 确认）。
      // 这是「平台关掉游戏」在设备侧**唯一可靠**的一条：控制通道的 `am force-stop` 杀不到
      // 浏览器里的游戏页，启动器的 `close game path` 又常为空 → 只能由页面自己退出。
      this._onPlatformCloseRequest('游戏通道 0x10 closeGame');
    } else if (cmd === 5 || cmd === 6) {
      // 关闭：中途结束 / 正常结束 → 回到菜单并退出 VR 会话（旧平台/手动触发路径）。
      // 第十二修：平台说结束 → 关门禁（按钮重新隐藏，等下一次平台「开始」）
      this._platformSignal('onSeen', '平台结束指令 cmd=' + cmd + '（平台在场）');
      this._platformSignal('onEnd', '平台结束指令 cmd=' + cmd);
      if (this.state !== 'menu') {
        this.toMenu();
        const sess = this.world?.renderer?.xr?.getSession?.();
        if (sess) sess.end().catch(() => {});   // 退出沉浸式会话，回到浏览器 / PICO 主页
      }
    }
  }

  /**
   * 平台明确要求关闭本局（游戏通道 closeGame）。
   * 与 _onPlatformGone 的区别：那条是「APK 失联」由页面看门狗推断出来的；这条是平台直说。
   * 二者共用同一套优雅退出（回菜单 → 结束 XR → 进「本局已结束」待机态，**不卸载页面**），只是无需再等轮询。
   */
  _onPlatformCloseRequest(why) {
    this.log('平台要求关闭游戏（' + why + '）');
    this._platformSignal('onSeen', '平台关闭指令（' + why + '）→ 平台在场');
    // 平台**明说**要关 → 标记为「不可自愈」：_startReviveProbe 看到它就不再复活页面。
    // （区别于「看门狗推断出来的 APK 失联」——那是可以自愈的误判。）
    this._closedByPlatformCommand = true;
    if (this._reviveTimer) { clearInterval(this._reviveTimer); this._reviveTimer = null; }
    this._onPlatformGone('平台关闭指令：' + why);   // 平台**明说**要关 → 立即执行，不做复核
  }

  /**
   * 页面预加载（main.js 的进度条）完成时由 main.js 调用。
   * ⚠ 第十三修：这里原本会执行「加载期收到的平台开局命令」（_pendingPlatformStart 挂起队列）。
   *   现在平台命令**不再代玩家开局**（开局只能由玩家手势触发，见 _onPlatformCommand 的 cmd3/4 分支），
   *   该队列已无人写入 → 一并删除。preloadDone 标志保留（状态上报 pd= 与诊断条要用）。
   */
  setPreloadDone() {
    this.preloadDone = true;
  }

  /**
   * 「本局已结束」/「与平台断连」全屏封盖。
   * 用它代替卸载页面（见 _enterClosedIdle）：黑底 + 一句话，**不留浏览器白页**。
   * @param {string} [text] 覆盖文案（默认「平台已关闭本局」）
   */
  _showPlatformClosed(text) {
    try {
      let el = document.getElementById('platform-closed');
      if (!el) {
        el = document.createElement('div');
        el.id = 'platform-closed';
        el.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#000;color:#9aa4b2;' +
          'display:flex;align-items:center;justify-content:center;text-align:center;' +
          'white-space:pre-line;font:18px/1.7 sans-serif;padding:24px;box-sizing:border-box';
        document.body.appendChild(el);
      }
      el.textContent = text || '平台已关闭本局\n等待平台重新开始…';
      el.style.display = 'flex';
    } catch (e) { /* 极端情况下忽略 */ }
  }

  _hidePlatformClosed() {
    try {
      const el = document.getElementById('platform-closed');
      if (el) el.style.display = 'none';
    } catch (e) { /* 忽略 */ }
  }

  // ====== VR+ 平台关闭看门狗触发 ======
  // 平台点「关闭」会向头显下发 TCP kill → am force-stop 我们的 APK（游戏跑在 PICO 浏览器，独立进程，杀不到）。
  // 故由游戏侧轮询 /api/vrplus/status 检测 APK 死亡（GameServer 失联），此处优雅退出 VR 并回菜单。
  _onPlatformGone(why = '平台已结束本局', { confirm = false } = {}) {
    if (this._goneHandled) return;             // 防重复执行（看门狗可能多次触发）
    // 看门狗路径：先复核再动手。误判代价太大（整个页面被卸载），而头显对后台页的节流
    // 会让 fetch 成片失败 —— 必须先确认「本地 8080 真的连不上」才认定 APK 已死。
    if (confirm) { this._confirmThenGone(why); return; }
    this._finishRound(why);
  }

  /**
   * 第18关魔术师 Boss 击杀（通关横幅到期后）= 本局自然结束。
   *
   * 第九十二修起这里只进入「结算态」：冻结战场、展示本局统计、通知 PC 端转 CMD 7 让平台弹结算，
   * **不退出 VR、不关浏览器、不自动回菜单**。真正收尾仍由平台 closeGame（cmd 16 / 旧平台 cmd 5/6）
   * 触发 _finishRound，届时才上报带 roundOver 的 game-end 让 APK 关闭浏览器/唤醒客户端。
   */
  _onFinalBossClear() {
    this._showRunSummary('第18关通关（魔术师 Boss 击杀）');
  }

  /**
   * 「本局真的结束」的统一收尾（平台关闭才走它；自然通关先去 _showRunSummary 结算态等待）。
   *
   * 顺序有讲究：先留痕（页面马上要消失）→ 回菜单并上报 cmd5/game-end(roundOver) → 退 XR 会话 →
   * 直播模式停推流并卸载页面 / 非直播进待机态。
   *
   * @param {string} why 结束原因（进留痕与日志）
   * @param {string} [dead] 留痕事件名：platform-gone（平台关闭/看门狗）| round-clear（通关）
   * @param {boolean} [explicit] 是否「平台明说关闭」（只影响留痕可读性）
   */
  _finishRound(why, { dead = 'platform-gone', explicit = this._closedByPlatformCommand === true } = {}) {
    this._goneHandled = true;
    this._roundOver = true;                    // 本轮真的结束（见 _reportGameEnd 的 roundOver）
    this.log('本局结束，正在退出…（' + why + '）');
    // ★ 留痕（2026-09-19）：页面即将退出 —— 把死因写进 APK 的统一时间线磁盘文件。
    //   页面自己的日志会随页面一起消失，而这条会留在 APK 上，事后打开 APK 配置页
    //   或浏览器访问 /api/page/forensics 就能读到「谁在几点几分让页面退出的」。
    VRPlus.reportDead(dead, {
      why,
      explicit,                                 // 平台明说 vs 看门狗推断 / 通关
      preloadDone: !!this.preloadDone,
      state: this.state,
    });
    this.toMenu();                             // 回菜单：内部上报 cmd5 + 清理实体 + 恢复天空背景
    const sess = this.world?.renderer?.xr?.getSession?.();
    if (sess) sess.end().catch(() => {});      // 退出沉浸式会话（菜单态无会话则跳过）
    // ★ 2026-09-23（用户第三次现场实测）：**直播模式**下本局结束必须收干净。
    //   原话：「由于游戏结束后只是在浏览器里提示，没有关闭浏览器，导致头显再次调起游戏后无法
    //   连接 PC 端直播」—— 旧实现在这里只盖一层黑底、把页面**留在浏览器里**，下一局被拉起时
    //   这一页的 WebRTC/信令连接还挂着，新页面就抢不到 PC 的推流端席位。
    //   做法：停推流 + 关信令（cast.dispose）→ 整页卸载成 about:blank（浏览器里不留任何会抢
    //   信令的页面）。APK 侧另有一道：收到带 roundOver 的 game-end 会关掉浏览器，见
    //   GameServer.notifyGameEndIfAny / MainActivity.restoreClientAndCloseBrowser。
    //   非直播（平台投屏）情况保持四修行为：留在待机态等平台下一次拉起/唤醒，零重载。
    if (/[?&]cast=1/.test(location.search)) {
      try { this.cast?.dispose(); } catch (e) { /* 停流失败也要继续收尾 */ }
      VRPlus.reportDead('cast-round-over', { why });
      this.log('直播模式：本局已结束 → 停推流并卸载页面（避免下一局抢不到 PC 直播）');
      setTimeout(() => { try { location.replace('about:blank'); } catch (e) { /* 忽略 */ } }, 500);
      return;
    }
    this._enterClosedIdle(why);                // ★ 四修：进待机态（**不再** replace('about:blank')）
  }

  /**
   * 「本局已结束」待机态（2026-09-19 四修 —— 替换旧的无条件 `location.replace('about:blank')`）。
   *
   * 旧实现在这里卸载页面，代价实测有两笔：
   *   ① 头显停在浏览器的 about:blank —— 整屏**白页**（操作员在平台关闭游戏后看到的就是它）；
   *   ② 页面被卸载 → 平台下一次「开始」必须**整页重载**：重跑 6~9s 预加载，
   *      且新页面首轮 inbox 轮询有捡到上一局残留 closeGame 的风险（历史踩坑，见 _pageT0 门禁）。
   *
   * 现在改为：**页面保留**，退 VR → 回菜单 → 停主循环渲染（待机期不占 GPU、不发烫）→
   * 盖一层全屏「本局已结束」，**inbox 轮询照常跑**。轮询有两重身份：
   *   · 对 APK 而言 = 「游戏页还活着」的活体信号（MainActivity.isGamePageAlive）；
   *   · 对平台而言 = 下一局把本页叫回来的唯一通道 —— APK 被平台重新拉起时会往队列里放一条
   *     **本地 cmd3**（MainActivity.reviveClosedPage），本页收到即撤盖并 start(0) 开新局，
   *     全程零重载。前提：本页保持「页面活着 + state=menu」。
   */
  _enterClosedIdle(why) {
    this._closedIdle = true;
    this._renderPaused = true;                 // main.js 主循环读这个标志，跳过 update/render
    // 第十二修：本局结束 → 关门禁（「进入 VR」按钮重新隐藏），等平台下一次「开始」再开
    this._platformSignal('onEnd', '本局结束，进入待机态（' + why + '）');
    try { this.audio?.stopBGM?.(); } catch (e) { /* 音频未初始化等，忽略 */ }
    this._showPlatformClosed(this._closedByPlatformCommand
      ? '本局已结束\n等待平台重新开始…'
      : '与平台连接中断\n等待平台重新开始…');
    this.log('进入待机态（页面保留 / 停渲染 / 继续轮询）：' + why);
    // 断连路径要能自愈：APK 回来（平台重启了它）就自动撤盖回菜单。
    // 平台**明说**关闭时不起探针 —— 那时等的是平台下一条「开始」（cmd3），不是 APK 复活。
    this._startReviveProbe();
  }

  /**
   * 「APK 复活」自愈探针（2026-09-19 三修建、四修改用途）。
   *
   * 场景：平台每轮启动都是 `kill(am force-stop 本 APK) → copyfile → am start`。
   *   某一轮的 kill 命中时，8080 会消失几百毫秒到数秒 —— 页面的看门狗连败 4 次（≈6s）就判死。
   *   但 APK 随后又被 am start 拉回来了，此时「判死」纯属误判。
   *
   * 处理（四修后不再涉及「卸载/保留页面」的取舍 —— 页面**永远**不卸载）：
   *   · APK 回来了 且 平台没有明说关闭 → 撤盖、撤销判死、恢复渲染（玩家几乎无感）；
   *   · 一直探不到（真死）→ 保持待机封盖，等平台重新拉起本 APK；
   *   · 平台**明说**关闭（游戏通道 0x10 closeGame）→ 不起探针：那是真指令，等的是下一条 cmd3。
   */
  _startReviveProbe() {
    if (this._reviveTimer || this._closedByPlatformCommand) return;
    this.log('APK 探活失败/已关闭 → 页面保持待机，每 2s 探一次（APK 回来即自动撤盖）');
    let n = 0;
    this._reviveTimer = setInterval(async () => {
      n++;
      let alive = false;
      try { alive = await VRPlus.serverAlive(); } catch { alive = false; }
      if (alive && !this._closedByPlatformCommand) {
        clearInterval(this._reviveTimer);
        this._reviveTimer = null;
        this._goneHandled = false;
        this._closedIdle = false;
        this._renderPaused = false;      // 恢复主循环渲染
        this._hidePlatformClosed();
        this.log('APK 已恢复在线 → 撤回「与平台连接中断」，回到菜单等待平台开始');
        VRPlus.reportEvent('revive-ok', { afterSec: n * 2 });
      } else if (n % 15 === 0) {                 // 每 30s 提一次，避免刷屏
        this.log(`APK 仍未恢复（已 ${n * 2}s）…`);
        VRPlus.reportEvent('revive-wait', { sec: n * 2 });
      }
    }, 2000);
  }

  /**
   * 判死复核：看门狗报「APK 连不上」后，等 2.5s 再真探一次，只有确实连不上才执行退出。
   *
   * 为什么需要（两次实测教训）：
   *   ① 头显会给**后台页面**节流，加载期主线程又被纹理上传/JSON 解析占满 → fetch 会成片失败，
   *      但 APK 其实活得好好的。旧实现凭 4 次失败就把正在加载的页面卸载成白屏
   *      （实测形态：起来几秒、进度条走到一半就闪退）；
   *   ② 平台关闭走的是 kill(force-stop APK) + 游戏通道 closeGame **双路**：后者是平台明确指令
   *      （见 _onPlatformCloseRequest，立即执行、不复核）；只有「靠探活推断」这条路才需要复核。
   * 真死时这里必然仍连不上（页面资源本身就挂在那台本地服务上），所以不会漏掉真关闭，只多 2.5s。
   */
  async _confirmThenGone(why) {
    if (this._goneHandled || this._confirming) return;
    this._confirming = true;
    // ★ 2026-09-24 第二十六修：复核**做两轮**（每轮 2.5s），而不是一轮。
    //   现场实测：平台的「启动游戏」= kill(am force-stop 本包名) → copyfile → am start，
    //   且客户端每 20.004s 重发一次整套；那一记 kill 一旦生效，本页的轮询会连着失败，
    //   若此时正好轮到判死复核，单轮复核可能恰好落在「APK 正在重启、8080 还没绑上」的窗口里
    //   → 被误判「APK 真死」→ 直播模式下就 dispose 推流 + location.replace('about:blank')
    //   + 结束 XR 会话 = 本局当场作废（玩家表现为掉出 VR / 被弹窗）。
    //   多花 2.5s 换掉这个误判：真死时页面资源本就挂在本地服务上，晚 2.5s 收工无任何影响。
    this.log('判死复核：' + why + ' → 每 2.5s 探一次，连探两轮（避免撞上 APK 重启窗口）');
    let alive = false;
    for (let round = 1; round <= 2; round++) {
      await new Promise((r) => setTimeout(r, 2500));
      alive = await VRPlus.serverAlive();
      if (this._goneHandled) { this._confirming = false; return; }
      if (alive || round === 2) break;
      this.log('判死复核：第 1 轮探不到 APK（可能正被平台重启）→ 2.5s 后再探一轮');
      VRPlus.reportEvent('gone-recheck', { round: 1 });
    }
    this._confirming = false;
    if (alive) {
      this.log('判死复核：APK 其实在线 → 撤销退出（上一次是误判，游戏继续）');
      return;
    }
    this.log('判死复核：APK 确实已失联 → 执行退出');
    this._onPlatformGone(why);
  }

  /**
   * 上报「本局结束」（2026-09-19 第十修）。
   *
   * 为什么要告诉 APK：平台每局的收尾应当是「游戏页收工 → **平台客户端回到前台**」——
   * 操作员下一步要点客户端上的「开始」。而浏览器抢着前台时，平台客户端是被压到后台的
   * （实测：平台关闭后再「启动」常常没反应，先手动点开客户端才灵）。
   * APK 侧收到这条后会按「退出策略」执行：唤醒平台客户端（必要时关闭浏览器释放内存），
   * 见 MainActivity.restoreClientAndCloseBrowser / GameServer.sOnGameEnd。
   *
   * ⚠ 直播模式（`?cast=1`，玩家用自己的 PC 端 exe 看大屏）不能关浏览器 —— payload 里带
   *   cast:true，APK 侧据此跳过（这是唯一一种「结束本局但浏览器必须留着」的场景）。
   *
   * @param {string} why 结束原因（回菜单 / 通关 / 飞船坠落 …），只为留痕可读
   */
  _reportGameEnd(why, { roundOver = false } = {}) {
    // 去抖：一条时间线里同一局只留一条（_onPlatformGone 会连着走 toMenu + 待机态两处）
    const now = Date.now();
    if (this._gameEndReportedAt && now - this._gameEndReportedAt < 5000) return;
    this._gameEndReportedAt = now;
    const castMode = /[?&]cast=1/.test(location.search);
    //   roundOver = **本轮真的结束**（通关 / 平台关闭 / 主控端结束本局），区别于「玩家中途退出 VR
    //   回菜单」（那一局还在进行，只是暂时回菜单）。
    //   退出 VR」（那一局还在进行，只是暂时回菜单）。
    VRPlus.reportEvent('game-end', {
      why, st: this.state, lvl: this.levelIndex, cast: castMode, roundOver,
    });
    // 本轮结束 → 顺手请 PC 主控端**收回「本局放行」**：不收回的话，下一局的页面一打开门禁就
    // 直接开着（= 用户实测的「一连上就能点进 VR」）。玩家自己退 VR 时不动 —— 那一局还能再进。
    if (roundOver) this._tellMasterRoundEnd(why);
  }

  /**
   * 通知 PC 主控端「本局已结束」→ 收回本局放行（fire-and-forget，失败绝不影响游玩）。
   * 头显侧经 APK 的 GameServer 代理到 PC（见 GameServer.proxyApi 的 /api/* 转发）；
   * PC 侧入口见 tools/cast-pc/main.js 的 handleRoundEnd。
   * ⚠ keepalive：直播模式收尾时本页马上要 replace('about:blank')，普通 fetch 会被取消。
   */
  _tellMasterRoundEnd(why) {
    if (this._masterRoundEndSent) return;
    this._masterRoundEndSent = true;
    try {
      fetch('/api/round/end', {
        method: 'POST', cache: 'no-store', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        // lvl / maxLvl / score 是给 PC 端上报平台用的（CMD 7 结算报文里的 curProgress /
        //   maxProgress / score）。缺了也能发 —— PC 端会退回 0，平台照样记「正常结算」
        //   （原版那一局的结算数据也是全 0）。
        body: JSON.stringify({ why, lvl: this.levelIndex, maxLvl: LEVELS.length, score: this.score }),
      }).catch(() => { /* PC 不在 / 非直播场景：忽略 */ });
    } catch (e) { /* 忽略 */ }
  }

  /** 本局收尾的唯一出口：报平台（cmd5 兜底）+ 报 APK（唤醒平台客户端 / 关浏览器） */
  _endRound(why) {
    VRPlusGame.terminate();
    this._reportGameEnd(why, { roundOver: !!this._roundOver });
    this._roundOver = false;      // 一次性标志：下一条结束路径默认不是「本轮结束」
  }

  // 释放开场视频并还原背景舞台（幂等；start / toMenu / _startIntroVideo 都会调）
  _disposeIntroVideo() {
    if (this._introVideo) { this._introVideo.dispose(); this._introVideo = null; }
    if (this._introVideoPending) { this._introVideoPending.dispose(); this._introVideoPending = null; }
    this._introHandoffT = 0;
    this._introPendingT = 0;
    if (this._introStage) {
      this._introStage = false;
      this.world.setIntroBackdrop(false);   // 恢复渐变天空球 + 解冻天空缓动（星星自行缓动回黄昏亮度）
    }
  }

  // 回到「未开始」状态：供 sessionend 调用，使再次进入 VR 时 sessionstart 守卫生效、从干净状态开局
  toMenu() {
    this.audio?.stopAllMedia();
    this._disposeRunResultPanel();
    this.state = 'menu';                       // 关键：让 sessionstart 的 game.start 守卫重新生效
    this._disposeIntroVideo();                 // 开场视频若正在播（播放中退出 VR）：释放 + 还原背景舞台
    this._endRound('本局结束（回菜单：玩家退出 / 掉会话 / 平台关闭）');
    // 释放关卡专属实例（沿用 _loadLevel 头部写法）
    if (this.laser)    { this.audio?.stopLaserHum('level'); this.laser.dispose();    this.laser = null; }
    if (this.grid)     { this.grid.dispose();     this.grid = null; }
    if (this.flipGrid) { this.flipGrid.dispose(); this.flipGrid = null; }
    if (this.dragon)   { this.dragon.dispose();   this.dragon = null; }
    if (this.cloudFx) { this.cloudFx.dispose(); this.cloudFx = null; } // 清穿云特效
    if (this.shopDraft) { this.shopDraft.dispose(); this.shopDraft = null; } // 第五十五修：清商店关场地
    this._disposeOpening(); // 清开场动画 + 作废其语音联动（防回菜单残留）
    this.world._restoreFade(); // 恢复穿云淡入改写的材质（防回菜单残留半透明）
    this._introActive = false; this._introT = 0; // 复位开场门控
    this._introPreloadQueue = null; this._introPreloadIdx = 0; // 复位预载队列
    this._levelTasks = null;       // 第四十五修：丢掉没跑完的分帧构建任务（防回菜单后还往场景里建东西）
    this._clearPortals(); // 清传送门装饰（防跨关/回菜单残留）
    this.waves.clearPending();   // 清出怪光点（防回菜单残留）
    // 清理实体
    this.balloons.clear();
    this.projectiles.clear(); // 清远程投射物（回菜单一并清理）
    this.vignette.clear();
    this.bullets.clear();
    this._clearExplosions();
    this._clearRoundExtras();     // 第四十六修：清金点/治疗线/技能锁
    this.damageNumbers.clear();   // 回菜单：清伤害数字
    this.fx.clear();              // 档2：一并清掉特效残留
    this.midWarning?.hide();      // 第四十二修：回菜单收掉中场预警横幅
    this._bulletStreak = 0; this._rapidUntil = 0; this._setRapidMul(1);
    this._buddhaQueue.length = 0;
    this.combo = 0;
    if (this._buddhaFx) { this._buddhaFx.dispose(); this._buddhaFx = null; }
    this._endBlackHole();                       // 第六十七修：回菜单释放吸附 + 清漩涡
    this.cards.clearCards();                    // 清抽卡气球（不拆除 group，可再次 open 复用）
    this._cardState = null;
    this._levelSnapshot = null;
    // 重置数值
    this.player.reset();
    this.bullets.setDefaultTint(null);
    // 回菜单：角色教学解锁一并清空，下一局从「未解锁」开始（教学关会重新发卡）。
    this._roleUnlocks = { satelliteTrack: false, bombardAirburst: false, plagueInfect: false };
    this._satelliteAutoTrack = true;
    this._bombardAirburst = false;
    this._plagueInfect = false;
    this._poisonAccum = 0;
    this._plagueBurstTimes.length = 0;
    this.satellites?.reset();     // 第八十五修：回菜单不留浮游炮
    this.score = 0;
    this.attackBonus = 0;     // 回菜单清零攻击力加成
    this.shopCoin = 0;        // 第五十五修：商店币随本局一起清零
    this._itemLv = {};
    this._candyCount = 0;
    this._mibUntil = 0;
    this._mibNextAt = 0;
    this.shopMode = false;
    this.hud.showShopCoin(false);
    this._clearAttackHint();  // 清残留攻击力提示
    this.levelIndex = 0;
    this.gridPhase = false;
    this.flipPhase = false; this.flipTimer = 0;
    this._lastCell = 0; this._failing = false; this._failTimer = 0;
    this.laserMode = false;
    // 位置 / 天空恢复预览初始态（默认天空 == dusk 预设，见 world.js 构造）
    this._resetPlayerOrigin();   // 重设映射基准（rig 归零 ⇒ XR 原点即游戏区域中心）；重生/过场不走这里
    this.world.clearSkyPanorama();
    this.world.setSkyMood('dusk');
    // HUD / 音频
    this.hud.showStart();
    this.hud.clearMessage();
    this.hud.setScore(0);
    this.hud.setHp(this.player.maxHp, this.player.maxHp);
    this.audio?.stopBGM();
  }

  _loadLevel(i) {
    this.audio?.stopAllMedia();
    this.world.resetWarm?.();   // 第六十八修：新一关重新收集要预热的材质
    const lv = LEVELS[i];
    this.normalTest = false; // 默认非测试；仅普通关且 NORMAL_TEST.enabled 时被 startLevel 翻为 true
    // 第六十修：教学关重建流程（死亡重开也走这里 → 教学从头再来），其它关一律清空
    this._tutorialFreeSkill = false;
    this.tutorial = isTutorialLevel(lv.n) ? new TutorialRunner(this) : null;
    // 第八十八修：角色教学解锁按「本局角色 + 是否教学关」重算。
    //   · 教学关：蜂群的自动追踪 / 爆炮手的 6 米空爆都要先拿教学卡；
    //   · 非教学关：两者都恢复满功能（角色核心手感，不该每关重新上锁）。
    //   · 死亡重开会走这里：本局已经拿过卡就保持解锁（不重复教学）；新一局/回菜单才重新上锁。
    {
      const role = this.player?.characterKey || null;
      const unlocks = this._roleUnlocks || { satelliteTrack: false, bombardAirburst: false, plagueInfect: false };
      this._satelliteAutoTrack = role === 'swarm'
        ? (!this.tutorial || unlocks.satelliteTrack)
        : true;
      this._bombardAirburst = role === 'bombard'
        ? (!this.tutorial || unlocks.bombardAirburst)
        : false;
      this._plagueInfect = role === 'plague'
        ? (!this.tutorial || unlocks.plagueInfect)
        : false;
    }
    // 离开上一关时清理激光关实例与玻璃网格
    if (this.laser) { this.audio?.stopLaserHum('level'); this.laser.dispose(); this.laser = null; }
    if (this.grid) { this.grid.dispose(); this.grid = null; }
    if (this.flipGrid) { this.flipGrid.dispose(); this.flipGrid = null; }
    if (this.dragon) { this.dragon.dispose(); this.dragon = null; }
    if (this.shopDraft) { this.shopDraft.dispose(); this.shopDraft = null; } // 第五十五修：清上一关商店场地
    this._disposeOpening(); // 清上一关残留的开场动画 + 作废其语音联动（防跨关泄漏）
    if (this._buddhaFx) { this._buddhaFx.dispose(); this._buddhaFx = null; } // 清上一关残留的如来神掌特效
    this._endBlackHole(); // 第六十七修：释放上一关的吸附 + 清漩涡（防跨关残留）
    this._clearPortals(); // 清上一关残留的传送门装饰
    this.waves.clearPending();   // 清上一关残留出怪光点（防光点飞到新关卡）
    this._levelTasks = null;     // 第四十五修：丢掉上一关没跑完的分帧构建任务（本函数会重建）
    this.gridPhase = false;
    this.flipPhase = false; this.flipTimer = 0;
    this._lastCell = 0;
    this._firstCardOfLevel = true;   // 每关首次抽卡才强制攻击紫（02关）
    this.balloons.clear();      // 防跨关残留气球（脸谱 Boss 装饰等）
    this.projectiles.clear();   // 防跨关残留投射物
    this.vignette.clear();      // 防跨关残留着色
    this.fx.clear();            // 档2：防跨关残留曳光/火花/碎片/枪口焰（切关瞬间的残留最显眼）
    this.midWarning?.hide();    // 第四十二修：切关收掉中场预警横幅
    this._midWarned = false;    // 新一关重新允许弹一次
    this.dangerAlarm?.reset();  // 第六十一修：报警节拍/轮转记账不跨关
    this._skillCasts = 0;       // 第六十二修：本关技能释放计数（教学精英暂停判据）
    this.tutorialHint?.hide();  // 第六十二修：常驻提示板不跨关（只在教学关显示）
    this._bulletStreak = 0; this._rapidUntil = 0; this._setRapidMul(1);  // 连杀/加速不跨关
    this._buddhaQueue.length = 0;  // 清掉上关没结算完的神掌队列
    this.bullets.clear();       // 防跨关残留子弹误击
    this.hud.clearCountdown();   // 关倒计时显示
    this.world.setSkyMood(lv.mood);
    // 飞毯显隐：第9关(laserMode='drive' 玻璃走格子)隐藏飞毯、保留脚下玻璃区域；其余关显示飞毯作玩家脚下活动区
    this.world.carpet?.setVisible(lv.laserMode !== 'drive');
    // ===== 关卡 BGM 选择（程序化，分普通关/机制关/Boss关；雾气转场期间不播，统一延迟到 _startLevelAudio）=====
    // 普通关(normal)+危机关(crisis) → 'normal'（mood=night 用黑夜变体）；机制关(laser) → 'laser'；Boss 关 → 'boss'
    // 全部由 AUDIO-SPEC.md 程序化合成（零音频文件），替换原 music/*.wav 文件 BGM。语音(_pendingOpenVoice)另走文件。
    this.audio?.stopBGM();
    this._pendingBgm = null;        // {kind, variant, intensity} 或 null
    this._pendingOpenVoice = null;  // 开场语音（L6/18；商店关走 _shopVoicePending），null=无
    this._shopVoicePending = false; // 第八十三修：商店关开场语音是否还在等「雾散 + 横幅结束」
    this._bossT = 0;                // Boss 升压计时（秒）
    this._bossInten = BOSS_BGM.START_INTENSITY; // Boss 升压当前值（与 audio.intensity 同步）
    // 机制关（3/9/15 激光关）：射击固定单发 —— 复用抽卡期间同一套 forceSingleShot
    //   （player.fire 里 n = forceSingleShot ? 1 : shotCount），避免多弹道扇形在需要精确点靶的机制关里分散火力。
    //   出关时会被下一次 _loadLevel 重算为 false；抽卡流程自身仍会在进出抽卡时置位/复位。
    this.shopMode = isShop(lv);                       // 第五十五修：本关是否商店关
    // 商店关同样强制单发（打气球点靶更准，且避免多重扇形误打相邻气球）
    this.player.forceSingleShot = isLaser(lv) || this.shopMode;
    if (isLaser(lv) || this.shopMode) {
      this._pendingBgm = { kind: 'laser', variant: null, intensity: 0.2 };          // 机制关：起步 0.2
    } else if (isBoss(lv)) {
      this._pendingBgm = { kind: 'boss',  variant: null, intensity: BOSS_BGM.START_INTENSITY }; // Boss：0.45
    } else {
      // normal / crisis：程序化 normal 关；危机(mood=night)用黑夜变体
      this._pendingBgm = { kind: 'normal', variant: lv.mood === 'night' ? 'night' : 'dusk', intensity: 0 };
    }
    // 有全景配置的关卡（如第3/15关）用全景图作天空，覆盖渐变；无配置则维持渐变天空
    const pano = SKY_PANORAMA[lv.n];
    if (pano) this.world.setSkyPanorama(pano);
    this.hud.setLevel(`第 ${lv.n} 关 · ${KIND_NAME[lv.kind]}`);
    // 切关复位射速：玩家 fireRate（发/秒）落到真实节流源（2 发/秒基线，射速卡 +2 叠加）
    this.input?.setFireRate(this.player.fireRate);
    this.laserMode = isLaser(lv);   // 机制关标记（几何实例由下面任务表建）

    // ===== 第四十六修 · 三层出怪：表现回调 + 第4关技能锁 =====
    //   waves 只管调度与光点，横幅与「金点→抽卡」这类表现由 game 提供（见 waves.hooks）。
    this._clearRoundExtras();
    if (this.waves) {
      this.waves.hooks.banner = (text) => this._showBanner(text);
      this.waves.hooks.goldToCards = () => this._goldToCards();
      // 第四十七修：精英血量按「玩家当前 DPS」结算（waves._eliteOpts），口径与 _playerDPS 一致
      this.waves.hooks.playerDps = () => this._playerDPS();
      // 第四十九修 · 返工（三轮）：治疗术士「投喂粉色加号」——
      //   ⚠ 必须挂在 **this.balloons**（BalloonManager）上：读取方是 balloons._applyHealAura，
      //     挂到 waves（WaveManager）上从没人读 ⇒ 现场「治疗术士完全没作用、看不到加号也没看到回血」的根因。
      //     （waves 现在也有转发访问器，两条路都通；但直挂读取方是最不会被误改的写法。）
      //   ① 回血量 = HEAL_LINK.PULSE_HEAL（现场 1000，超出目标上限的部分不算）；
      //      配成 0 时退回「玩家当前攻击力」；
      //   ② 表现 = 从术士飞一枚粉色加号到目标（fx.HealPlusFx）。
      this.balloons.onHealCast = (healer, target) => {
        if (HEAL_LINK.PLUS_ENABLED !== false && this.fx && healer && target) {
          this.fx.healPlus(healer.mesh.position, target.mesh.position);
        }
        return HEAL_LINK.PULSE_HEAL > 0 ? HEAL_LINK.PULSE_HEAL : Math.max(1, Math.round(this.player.atk || 0));
      };
      // 旧口径的绿色脉冲环接线（RING_ENABLED=true 时才画得出东西）
      this.balloons.onHealPulse = (pos, radius) => { if (this.fx) this.fx.healPulse(pos, radius); };
    }
    const _scr = scriptFor(lv.n);
    this._skillUnlockAt = (_scr && _scr.skillLockUntil) || 0;
    this._skillLocked = this._skillUnlockAt > 0;   // 第4关：进关即锁，横幅结束解锁

    // ===== 第四十五修 · 开场穿云：先起雾「盖章」，再把本关构建分帧做完 =====
    //   现场：开场影片播完 / 每次切关各卡一下。根因是「本关场景构建 + 首帧着色器编译」全挤在
    //   同一帧同步做完，而那一帧画面还是上一屏（没被雾盖住）⇒ 直接看见一次冻结。
    //   两步修法：
    //     ① 云雾在下面 _sceneBefore 快照**之前**建好 → 它不进「本关新物体」差集 → 不参与淡入，
    //        第一帧就满不透明地盖住画面。（改造前雾自己也是从 0 淡入，等于没遮，所以卡顿才看得见。）
    //     ② 本关物体按下面的任务表**每帧建一组**（见 _pumpLevelTasks），全程雾都盖着；
    //        每组只承担一部分「建对象 + 首帧着色器编译」的尖峰。
    //   ⚠ 顺序不能反：雾必须在快照前建，否则会被 extendFadeRoots 当成「本关新物体」从 0 淡入。
    const cover = !!CLOUD.ENABLED;
    if (cover) {
      this._introActive = true;
      this._introT = 0;
      if (this.cloudFx) this.cloudFx.dispose();   // 死亡重开等复用场景：先清旧云
      this.cloudFx = new CloudFx(this.world.scene);
      this.cloudFx.start(this.world.camera, this.rig);
    }

    // 快照场景子节点：稍后取差集即可自动采集「本关新建的场景物体」（穿云淡入 + 分帧登记都用它）
    const _sceneBefore = new Set(this.world.scene.children);
    this._fadeSceneBefore = _sceneBefore;   // 存到实例：云雾期间每帧据此补登记异步加载完成的物体

    // ===== 本关构建任务表（顺序与原实现一致；无穿云时在下面同步连跑）=====
    const tasks = [];
    // ① 第3/9/15关：世界固定点播放在「魔术师动画版」模型，循环播放 10 秒后自动消失。
    //    穿云期间(this._introActive)由 _updatePlaying 冻结其 update（不推进动画/计时），结束后才播放满 10 秒。
    //    模型经 glbCache 共享缓存、main.js 已预加载，进关即瞬时出现；淡入由穿云 extendFadeRoots 差集自动捕获。
    //    顺带把「激光关开场语音」「第18/6关 Boss 开场语音」也在这里排定（延迟到穿云结束后再播）。
    if (lv.n === 3 || lv.n === 9 || lv.n === 15) {
      tasks.push(() => {
        const _omCfg = OPENING_MAGICIAN[lv.n];   // 第3/9/15关开场魔术师模型配置（位置/缩放见 constants.OPENING_MAGICIAN）
        this.openingModel = new OpeningModel(
          this.world.scene,
          new THREE.Vector3(..._omCfg.pos),       // 模型根节点世界坐标（米：X右/Y上/Z前为负=玩家前方）
          {                                       // 目标身高(米) + 兜底时长(秒) + 到期碎片回调
            scaleHeight: _omCfg.scaleHeight,
            showSeconds: OPENING_MAGICIAN.SHOW_SECONDS,
            onExpire: () => this._shatterOpening(),
          }
        );
        this.openingModel.start();
        // 第八十三修：商店关开场语音不在这里立刻播，等「雾散 + 关卡名横幅结束」后再播（_tickShopVoice）。
        this._shopVoicePending = !!OPENING_MAGICIAN.SHOP_VOICE_ENABLED;
      });
    } else if (lv.n === 18) {
      // 第18关 Boss 开头语音：延迟到穿云结束后再播
      this._pendingOpenVoice = MAGICIAN_BOSS.INTRO.VOICE_URL;   // 第三十八修：URL 集中在 constants.MAGICIAN_BOSS.INTRO
    } else if (lv.n === 6) {
      // 第6关开局只播蓝色脸谱「儿郎冲锋」；红/黑阶段语音由脸谱Boss相位切换时播
      this._pendingOpenVoice = 'music/儿郎冲锋.mp3';
    }
    // ② 小怪关（非 boss、非激光机制）：按本关方向表生成传送门装饰（自带动画+上下浮动）
    if (!isBoss(lv) && !isLaser(lv) && !this.shopMode) tasks.push(() => this._spawnPortals(lv));
    // ③ 商店场地 / 机制关几何 / 龙 Boss / 常规出怪（互斥）
    if (this.shopMode) {
      // 第五十五修 · 商店关：正前方技能区 + 左手边道具区（不出怪、不掉血、无激光）
      tasks.push(() => this._enterShop());
    } else if (isLaser(lv)) {
      tasks.push(() => {
        // 透传 laserMode：'drive' 为第九关（生成→驱赶→保持原地→走格子），'full' 为第三关（搭阵），'flip' 为第十五关（九宫格）
        const holdDur = lv.laserMode === 'flip' ? FLIP.HOLD_DUR : undefined;
        this.laser = new LaserLevel(this.world.scene, (m) => this.log(m), lv.laserMode || 'full', holdDur);
        this.laser.start();
        if (lv.laserMode === 'drive') {
          // 第九关：在游玩区铺设玻璃走格子（编号 1–32）
          this.grid = new GlassGrid(this.world.scene);
          this.grid.setCorrect(GRID.CORRECT, GRID.WIN_CELL); // 正确格集合 + 通关格(cell 3)
          this.log(`第 ${lv.n} 关 · 激光驱赶：等待→驱赶→保持原地10秒→走格子`);
        } else {
          this.log(`第 ${lv.n} 关 · 激光驱赶：等待→驱赶→保持原地2秒→九宫格翻转`);
        }
      });
    } else if (lv.boss === 'dragon') {
      tasks.push(() => {
        // 第十二关：龙 Boss（龙头 GLB + 龙身/龙爪气球沿动画路径移动）
        this.dragon = new DragonBoss(this.world.scene, this.balloons);
        this.dragon.audio = this.audio; // 注入音效，连爆时播放
        this.dragon.start();
        this.log(`第 ${lv.n} 关 · 龙 Boss：击破龙身/龙爪气球（打爆即复活，血量清零才击杀）`);
      });
    } else {
      tasks.push(() => {
        this.waves.startLevel(lv);
        // 正常测试模式：覆盖普通关出怪曲线，独占出怪（避免与压测阵列冲突）
        this.normalTest = (this.waves.mode === 'normalTest');
        if (DEPTH_SPRITE_STRESS > 0 && !NORMAL_TEST.enabled) this._spawnStress(DEPTH_SPRITE_STRESS);
        this.log(`第 ${lv.n} 关 · ${KIND_NAME[lv.kind]}`);
      });
    }
    // ④ 非激光关在关卡加载完成后拍照快照（用于死亡重开时恢复属性+分数）
    if (!isLaser(lv) && !this.shopMode) tasks.push(() => this._snapshotState());

    if (cover) {
      // 淡入登记：先开一张**空表**（forceOn=true，见 world.setFadeRoots）——本关物体在随后几帧
      // 出现时由 _updatePlaying 的 extendFadeRoots 逐帧补登记，并对齐当时的雾进度。
      this.world.setFadeRoots([], true);
      this.world.setEnvOpacity(0);  // 环境(天空/地面/星空)从全透明开始，随云雾动画 0→1 淡入
      this._levelTasks = tasks;     // 分帧跑：每帧一组（见 _pumpLevelTasks），全程被雾盖住
    } else {
      // 无穿云：立即同步建完（与改造前完全一致），保证效果不丢
      for (const t of tasks) t();
      this._introActive = false;
      this.world._restoreFade();    // 无穿云：确保无残留半透明材质
      this.world.setEnvOpacity(1);  // 无穿云：场景直接满显
      this.balloons.flushRetired?.(Infinity); // 无穿云：没有雾可藏，直接释放完
      this._startLevelAudio();      // 无穿云：直接启动本关 BGM + 开场语音
    }
    // 第四十九修：关卡标题卡 —— 有云雾就在**雾里**弹（现场反馈：原先是雾散后才弹，和出怪撞在一起），
    //   无云雾退回旧口径（关卡正式开始后 DELAY 秒）。
    //   第四十九修（返工）：机制关(3/9/15)开局有魔术师开场动画，原先直接不弹 ⇒「机制关看不到关卡名」。
    //   现在按 MECHANIC_DELAY 先排一个**兜底**（语音缺失/ended 不触发也能弹），
    //   并把排期权交给开场语音：播完 → _bindOpeningVoice 里改排成「0.5s 后」（见 _levelTitleDone 防重）。
    this._levelTitleDone = false;
    this._levelTitleAt = 0;          // 第八十三修：切关先清旧排期，防商店语音闸门被上一关的残留卡住
    this._levelTitleText = null;
    //   第五十八修：商店关(3/9/15)开头只有魔术师动画、**没有开场语音**（第五十五修已去掉），
    //   所以不再走机制关那套「等动画收场 + 12s 兜底」，改回普通关口径 —— 和普通关一样在**雾里**弹。
    //   判据抽成纯函数 levelTitleDelay（见 levels.js / 单测）。
    this._queueLevelTitle(levelTitleDelay(lv, LEVEL_TITLE, cover));

    // ====== 关卡开场「雾气窗顺序预载」======
    // 把本关要用的敌人/装饰 GLB 模型 + DepthSprite 捕获，分散到 INTRO_DELAY 秒穿云窗内「每帧处理 1 个」，
    // 避免「首只怪出生时」一次性解码/抓帧导致的尖峰卡顿（穿云遮蔽下不可见）。
    // 无穿云(CLOUD.ENABLED=false)时立即同步预载，保证效果不丢。
    this._introPreloadIdx = 0;
    this._introPreloadQueue = this._buildIntroPreloadQueue(lv);
    if (!CLOUD.ENABLED && this._introPreloadQueue.length) {
      for (const it of this._introPreloadQueue) {
        if (it.url) loadBalloonModel(it.url);
        if (it.warm) warmModelGpu(it.url);     // 无穿云：同步预热（第三十九修）
        if (it.capture) preCaptureDepthSprite(it.url, it.radius);
      }
      this._introPreloadQueue = null;
    }
  }

  // 第四十五修 · 关卡构建分帧泵：穿云窗内每帧跑一组任务（任务表见 _loadLevel）。
  //   目的：把「本关场景构建 + 首帧着色器编译」的尖峰摊到多帧，且全程被雾盖住 —— 现场那个
  //   「影片播完 / 切关卡一下」就是它一次做完的后果。
  //   出错只记录、不中断：某一组失败时后面的照跑，避免半成品关卡把整个渲染循环带崩。
  _pumpLevelTasks() {
    const q = this._levelTasks;
    if (!q || !q.length) return;
    const t = q.shift();
    try { t(); } catch (e) { console.warn('[关卡构建] 分帧任务失败', e); this.log('关卡构建任务失败：' + ((e && e.message) || e)); }
  }

  // 兜底：穿云结束时若任务还没跑完（正常 4 秒足够），一次性补完，保证关卡完整。
  _drainLevelTasks() {
    const q = this._levelTasks;
    this._levelTasks = null;
    if (!q || !q.length) return;
    for (const t of q) {
      try { t(); } catch (e) { console.warn('[关卡构建] 兜底任务失败', e); this.log('关卡构建任务失败：' + ((e && e.message) || e)); }
    }
  }

  // 收集本关「雾气窗顺序预载」队列：敌人/装饰 GLB 模型 URL + 是否需要 DepthSprite 捕获。
  // 覆盖三种出怪配置（SPAWN_RING / NORMAL_TEST / LEVEL_ENEMY），确保开关怎么切都不会漏预载；
  // 龙 Boss 关额外预载龙头 GLB。出怪池若日后恢复全量(['basic','ninja','octopus','shield','ghost','heart'])，
  // 队列会自动跟着变长、摊在穿云窗内逐帧处理。
  _buildIntroPreloadQueue(lv) {
    const q = [];
    const addType = (typeId) => {
      const t = ENEMY_TYPES[typeId];
      if (!t || !t.model) return;
      const capture = DEPTH_SPRITE_TYPES.includes(typeId);
      // capture = 该怪走 DepthSprite 立绘：抓帧本身就会把 GLB 纹理上传一遍，故只有不走立绘的才额外 warm。
      q.push({ url: t.model, radius: t.radius || 0.5, capture, warm: !capture });
      // 第四十九修：**附属模型**也要进队列 —— 盾甲兵的 Model/盾牌.glb 原先只在 balloons._buildShield
      //   里懒加载，于是「第一个盾甲兵出现那一帧」才有一次冷加载 + 纹理上传 + 着色器编译。
      //   第 4/5 关末尾批（融合）与第 18 关玻璃阶段都吃这一下 ⇒ 现场「末尾精英合成时卡一下」。
      if (t.shieldModel) q.push({ url: t.shieldModel, radius: t.radius || 0.5, capture: false, warm: true });
    };
    // warm = 顺带预热 GPU（纹理上传 + 着色器编译，见 balloonModels.warmModelGpu）。
    //   Boss 模型都走它：GLB 的 parse 在 main.js 预载时已完成，但**第一次真正渲染**那一帧才做
    //   纹理上传 / program 编译 —— 在 PICO 上就是「Boss 一登场卡一下」（第三十九修）。
    const addUrl = (url, warm = false) => { if (url) q.push({ url, radius: 1.0, capture: false, warm }); };

    if (lv.boss === 'face') {
      // 第6关脸谱 Boss：穿云窗内预热三张脸谱 + 旗子 + 蓝阶段小怪 GLB，
      // 并把「黑阶段分身」的 DepthSprite 抓帧也提前到这里 —— 抓帧 = 12 帧离屏渲染 + readRenderTargetPixels
      // 同步回读，非常重；原先等红→黑切换那一刻才首次抓帧，正是切换卡顿的主因。
      for (const url of FACE_BOSS.MODELS) addUrl(url, true);   // 脸谱三张 + 扇子：登场首帧前预热 GPU
      addUrl(FACE_BOSS.FAN_MODEL, true);
      addUrl(ENEMY_TYPES.flagMask.model);
      addType('basic');       // 蓝阶段 3×3 小怪 GLB + 立绘抓帧
      addType('eliteKnight'); // 蓝阶段中心格 = 铁甲兵（第四十六修：与 1/2/4/5 关的精英一致）
      q.push({ url: FACE_BOSS.BLACK_CLONE_MODEL, radius: ENEMY_TYPES.blackMaskClone.radius, capture: true });
      addUrl(DRAGON_CHEST.MODEL, true);           // 第七十四修：宝箱模型在穿云窗内预载 + GPU 预热，横幅期不再露方块
    } else if (lv.boss === 'dragon') {
      addUrl(DRAGON.HEAD_MODEL, true);            // 第12关龙 Boss 龙头 GLB（未被 main 预载）+ GPU 预热
      addUrl(DRAGON_CHEST.MODEL, true);           // 第七十四修：同上，龙族宝箱提前进入缓存
      addType('basic');  addType('ninja');       // 龙 Boss 召唤用基础怪/忍者 GLB + DepthSprite 立绘：进关预载，避免首召冷加载卡顿
    } else if (lv.boss === 'magician') {
      // 第18关魔术师 Boss：召唤池（普通怪 + 三阶段精英怪：盾兵/幽灵/章鱼）的 GLB + DepthSprite 立绘抓帧
      // 全部在穿云窗内预热 —— 抓帧 = 12 帧离屏渲染 + readRenderTargetPixels 同步回读，非常重；
      // 原先本关没有预载分支，导致阶段召唤瞬间才首次抓帧，正是「召唤时明显卡顿」的主因。
      addUrl(MAGICIAN_BOSS.MODEL, true);   // Boss 本体（与 main 预载的开场动画同文件）：预热 GPU，去掉登场首帧卡顿
      addType(MAGICIAN_BOSS.POOL.BASIC_TYPE || 'basic');
      for (const _mt of Object.values(MAGICIAN_BOSS.POOL.ELITE_BY_PHASE)) addType(_mt);
    } else if (!isBoss(lv) && !isLaser(lv)) {
      // 普通/危机关（waves）：收集所有可能出怪类型
      const types = new Set();
      if (SPAWN_RING.enabled) SPAWN_RING.pool.forEach((t) => types.add(t));
      if (NORMAL_TEST.enabled) NORMAL_TEST.pool.forEach((t) => types.add(t));
      const le = LEVEL_ENEMY[lv.n];
      if (le && le.type) types.add(le.type);
      // 本关精英波敌种（ELITE_SCHEDULE）也纳入预载：避免首只精英骑士在 5s 时同步抓帧卡顿
      const es = ELITE_SCHEDULE[lv.n];
      if (es) {
        for (const key of ['early', 'mid', 'late']) {
          const ph = es[key];
          if (ph) ph.combos.forEach((c) => types.add(c.type));
        }
      }
      types.forEach(addType);
    }
    // 第四十九修：不管哪种关卡，「关卡脚本」（第四十六修的三层时间轴）里会出的怪都补进队列。
    //   原先只收集 SPAWN_RING.pool / NORMAL_TEST.pool / LEVEL_ENEMY / ELITE_SCHEDULE ⇒
    //   脚本独有的敌种（第 5 关的 heart = 心形怪/治疗术士）不在队列里，首只末尾精英落地时才冷加载 +
    //   DepthSprite 抓帧 ⇒「融合出来那一刻卡一下」。见 scriptEnemyTypes。
    for (const id of scriptEnemyTypes(lv.n)) addType(id);
    // 去重（同一模型只预载一次；如盾兵怪与骑士 Boss 共用 Model/骑士.glb）
    const seen = new Set();
    return q.filter((it) => { if (seen.has(it.url)) return false; seen.add(it.url); return true; });
  }

  // 穿云窗内每帧处理 1 个预载项：敌人 GLB 进缓存 + DepthSprite 抓帧进缓存。
  // 摊到 INTRO_DELAY 秒窗内，每帧开销极小，单帧不会穿透云雾露馅。
  _pumpIntroPreload() {
    if (!this._introPreloadQueue) return;
    if (this._introPreloadIdx >= this._introPreloadQueue.length) { this._introPreloadQueue = null; return; }
    const it = this._introPreloadQueue[this._introPreloadIdx++];
    if (it.url) loadBalloonModel(it.url).catch(() => {}); // 加载层记录失败，实体显示占位并可重试
    if (it.warm) warmModelGpu(it.url);                    // 预热 GPU：纹理上传 + 着色器编译（第三十九修）
    if (it.capture) preCaptureDepthSprite(it.url, it.radius); // 预热 DepthSprite 抓帧缓存（首帧零成本）
  }

  // 小怪关装饰：按本关方向表在场地中心四周生成传送门（FRONT=-Z BACK=+Z LEFT=-X RIGHT=+X）
  // 方向→位置/朝向全部来自 PORTAL 配置（改配置即整体调整，勿在此散落魔法数）
  // 固定布局见 PORTAL.LEVEL_DIRS；其余非机制/非Boss关从 PORTAL.RANDOM.POOL 随机抽 COUNT 个
  _spawnPortals(lv) {
    const P = PORTAL.DISTANCE_P;   // 距场地中心水平距离（米）
    const Y = PORTAL.HEIGHT_Y;     // 门中心离地高度（米）
    const R = PORTAL.ROT;          // {X/Y/Z:{LEFT,RIGHT}} 三轴旋转（弧度）
    const rotL = { x: R.X.LEFT, y: R.Y.LEFT, z: R.Z.LEFT };   // 左门三轴
    const rotR = { x: R.X.RIGHT, y: R.Y.RIGHT, z: R.Z.RIGHT }; // 右门三轴
    const DIR = {
      FRONT: { pos: new THREE.Vector3(0,  Y, -P), rot: { x: 0, y: 0, z: 0 } }, // 前：无旋转
      BACK:  { pos: new THREE.Vector3(0,  Y,  P), rot: { x: 0, y: 0, z: 0 } }, // 后：无旋转
      LEFT:  { pos: new THREE.Vector3(-P, Y, 0),  rot: rotL },                 // 左
      RIGHT: { pos: new THREE.Vector3( P, Y, 0),  rot: rotR },                 // 右
    };
    // 选方向：本关固定表优先；否则随机抽 COUNT 个（Fisher–Yates 洗牌后取前 COUNT）
    let dirs = PORTAL.LEVEL_DIRS[lv.n];
    if (!dirs) {
      const pool = PORTAL.RANDOM.POOL.slice();
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      dirs = pool.slice(0, PORTAL.RANDOM.COUNT);
    }
    dirs.forEach((k) => {
      const d = DIR[k];
      if (!d) return;
      const portal = new Portal(this.world.scene, d.pos, d.rot);
      portal.start();
      this._portals.push(portal);
    });
  }

  // 左手摇杆 → 传送门整体操控已移除（测试确认不需要，见 2026-08-25 改动）

  // 清理所有传送门（幂等）：切关、回菜单、游戏结束时调用
  _clearPortals() {
    this._portals.forEach((p) => p.dispose());
    this._portals = [];
  }

  // 玩家在游戏世界中的实际位置（水平，y=0）：相机（头部）世界坐标投影到地面。
  // 必须含「现实行走」偏移 —— rig 只承载手柄位移，现实移动写在相机（rig 子节点）上。
  _playerPos() {
    this.world.camera.getWorldPosition(this._tmp);
    this._tmp.y = 0;
    return this._tmp;
  }

  // 第六十一修 · 内圈报警：把「已进内圈的基础小怪」按玩家前向分成四区，每区只留最近的一只，
  //   交给 DangerAlarm 按节拍轮转发声（分区/节拍/音高全在 game/dangerAlarm.js，这里只筛怪 + 取朝向）。
  //   判据与头顶「爆」字**同源**（isBombMarkTarget + BOMB_LABEL.INNER_RADIUS）
  //   → 看得见闪红 ⇔ 听得到滴滴，不会「看得见却没声」或「有声却没怪」。
  _updateDangerAlarm(dt, pp) {
    if (!this.dangerAlarm || DANGER_ALARM.ENABLED === false) return;
    const R = BOMB_LABEL.INNER_RADIUS;
    const list = this._alarmList;
    list.length = 0;
    for (const b of this.balloons.list) {
      if (!isBombMarkTarget(b) || !b.mesh.visible) continue;
      const p = b.mesh.position;
      if (Math.hypot(p.x, p.z) > R) continue;      // 内圈之外不报（与「爆」字常态色一致）
      list.push(p);
    }
    if (!list.length) return;
    this.world.camera.getWorldDirection(this._fwd);
    // ★ 第六十四修 ★ 这里原来又 negate 了一次 —— 是**重复取反**，必须直接用 getWorldDirection 的结果。
    //   真因：three 的 Camera 重写了 getWorldDirection（Object3D 的那份取 +Z，Camera 那份 .negate()），
    //   所以相机上拿到的**已经是真实朝向**（见 vendor/three.module.js 的 class Camera extends Object3D）。
    //   再取反 = 把玩家的前/后、左/右整体转 180° ⇒ 现场「滴滴听着在左边，怪其实只在正前方」。
    //   （tests/danger-alarm.test.mjs 顶部的官方约定也是「调用方传真实面朝方向」。）
    const hit = this.dangerAlarm.update(
      dt,
      { x: pp.x, z: pp.z, fx: this._fwd.x, fz: this._fwd.z, inner: R },   // inner 复用上面那同一个 R
      list, this._gameTime,
    );
    if (!hit) return;
    this.audio?.playDangerAlarm(hit);
    if (DANGER_ALARM.LOG) this.log(`[报警] ${hit.name} 方向 · 距离 ${hit.dist.toFixed(1)}m（第 ${hit.count} 次）`);
  }

  // ===== 玩家位置策略（2026-09-10 定稿，全项目必读）=====
  // 前提：现实游玩场地也是 4×8 m，与游戏活动区域（|x|≤MOVE.BOUND_X、|z|≤MOVE.BOUND_Z）**一一对应**，
  //       且开局时「玩家现实站位 = 场地中心 = 游戏区域中心 = XR 原点」。
  // 结论：rig 的水平位置就是「物理场地 ↔ 游戏区域」的映射基准 —— 玩家现实里走多少，游戏里就走多少。
  //   · 重生（死亡重开 / 机制关重开）一律**不动 rig 的水平位置**：
  //       玩家现实站在哪，游戏里就还在哪 —— 即「就死在原地重生」，不会被拉回中心。
  //   · 过场（死亡 / 穿云 / 加载）期间玩家现实走动，由 XR pose 每帧自动同步（相机是 rig 的子节点），
  //       所以重开时位置 = 玩家此刻的现实站位，也不会被硬拉回「死亡瞬间」的那个点。
  //   · 因此**不需要越界拦阻**：物理场地本身就是 4×8，玩家走不出游戏区域。
  //   ⚠ 反面教材：曾用「rig = 目标 − 现实偏移」把玩家游戏内位置对齐回中心。那会把物理场地与游戏
  //     区域整体错开一个「现实偏移」的量（现实 4×8 与游戏 4×8 不再重合），正是本次要修的问题。
  // 只复位高度：踩错掉落会把 rig.y 压到 -10（见 _updateGridPhase 失败动画），重生必须拉回 0；
  //   玩家现实身高由 XR pose 提供，不占用 rig.y。
  _respawnKeepPosition() {
    this.rig.position.y = this.input?.settings.heightOffset || 0;
  }

  // 重设「物理场地 ↔ 游戏区域」映射基准：rig 归零 ⇒ XR 原点即游戏区域中心。
  // 仅【回菜单】（一局结束、重设基准）时调用；重生 / 过场一律不调，否则会把玩家从原位拉走。
  // （JOYSTICK=0 纯现实行走时 rig 水平位置恒为 0，此调用等价于只把高度拉回 0。）
  _resetPlayerOrigin() {
    this.rig.position.set(0, this.input?.settings.heightOffset || 0, 0);
    this.rig.rotation.set(0, 0, 0);
  }

  // Boss 关：给 BGM 升压 —— 血量损失与战斗时长取较大者（掉血越狠 / 拖得越久越紧张）
  // 血量来源：脸谱·骑士 Boss 取 waves.faceBoss|boss，龙 Boss 取总血量池 hpPool/maxHpPool。
  // 旧实现把 Boss 强度恒设为 0，曲内 ≥0.6 的高压层从未触发，听感自然不够紧张。
  _updateBossIntensity(dt) {
    const lv = LEVELS[this.levelIndex];
    if (!lv || !isBoss(lv)) return;
    this._bossT = (this._bossT || 0) + dt;

    let dmg = 0;
    const b = this.waves?.faceBoss || this.waves?.boss;
    if (b && b.maxHp > 0 && b.alive) {
      dmg = 1 - Math.max(0, b.hp) / b.maxHp;
    } else if (this.dragon && this.dragon.maxHpPool > 0) {
      dmg = 1 - Math.max(0, this.dragon.hpPool) / this.dragon.maxHpPool;
    }

    const prog = Math.min(1, Math.max(this._bossT / BOSS_BGM.TIME_TO_MAX, dmg));
    const v = Math.min(BOSS_BGM.MAX_INTENSITY,
      BOSS_BGM.START_INTENSITY + prog * BOSS_BGM.RISE_RANGE);
    if (Math.abs(v - this._bossInten) > 0.02) {   // 超阈值才下发，避免每帧重复赋值
      this._bossInten = v;
      this.audio?.setIntensity(v);
    }
  }

  // 同屏 DepthSprite 压测：在玩家前方生成 N 个 basic 立绘阵列（controlled 站定）。
  // 站定后仍执行 lookAt + DepthSprite 视差同步 + 受击白闪，可被子弹击落，
  // 用于验证「同屏 N 个 2D 立绘」的视觉与性能（N 见 constants.DEPTH_SPRITE_STRESS）。
  _spawnStress(n) {
    if (!n || n <= 0) return;
    const p = this._playerPos();
    const cols = Math.min(n, 6);
    const gapX = 1.8, gapY = 1.6, z0 = -9;
    for (let i = 0; i < n; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const x = p.x + (c - (cols - 1) / 2) * gapX;
      const y = 1.3 + (r % 4) * gapY;
      const z = p.z + z0 - r * gapX;
      const b = this.balloons.spawn('basic', new THREE.Vector3(x, y, z));
      b.controlled = true; // 站定：跳过朝玩家移动，但仍 lookAt + 视差同步 + 可受击
    }
    this.log(`DepthSprite 压测：已生成 ${n} 个 basic 立绘同屏`);
  }

  update(dt) {
    dt = Math.min(dt, 0.05);
    this._gameTime += dt;                            // 激光剑状态/每怪限频的时间基准
    this.world.update(dt);
    // 开场视频：画面已摘除后延迟回收解码器（藏在穿云期间，避免与关卡加载挤同一帧造成卡顿）
    if (this._introVideoPending) {
      this._introPendingT -= dt;
      if (this._introPendingT <= 0) { this._introVideoPending.dispose(); this._introVideoPending = null; }
    }
    if (this.openingModel && !this._introActive) this.openingModel.update(dt); // 开场动画模型：推进动画 + 10秒计时（穿云时冻结）
    const pp = this._playerPos();                     // 取一次玩家位置，所有门共用（同步读取，无异步滞留）
    this._portals.forEach((p) => p.update(dt, pp));   // 传送门动画 + 浮动 + 摇杆偏移 + 数值标签
    this.wristUI?.update(dt, this, this.input); // 手腕面板（VR 下显示，桌面忽略）
    this.tutorialHint?.update(dt);              // 第六十二修：教学提示板淡入 + 轻浮
    this.rightGun.update(dt, this.input, this);  // 右手柄 AK 枪 + 技能就绪提示面板（VR 手持，桌面忽略）
    this.satellites?.update(dt, this);           // 第八十五修：蜂群浮游炮跟随 + 按当前弹道数刷新
    // 枪上「商店币」小框的每帧下发见 _updateFx 末尾（第六十五修）：
    //   要先拿到**本帧金点落地金额**才能推数字，所以必须排在 fx.update 之后 —— _updateFx 正是帧末。
    this.leftSword.update(dt, this.input);        // 左手柄激光剑（VR 手持，桌面忽略）
    this._updateBuddhaFx(dt);
    this._tickPalmWind();       // 第八十四修：掌风弹到期（音效/状态复位）
    this._drainBuddhaQueue();   // 第四十二修：神掌命中分帧结算（每帧限量，削掉单帧 GPU 尖峰）
    this._updateExplosions(dt);
    this.damageNumbers.update(dt);   // 伤害数字：上浮 + 淡出 + 回池
    if (this.combo > 0 && this._gameTime > this._comboUntil) this.combo = 0; // 连击窗口过期即断连
    this._tickRapidFire();        // 第四十二修：连杀计时（超时清零）+ 加速到期还原射速
    this._updateAttackHint(dt);   // 推进攻击力提示淡出/移除（2 秒后消失）

    if (this.state === 'playing') this._updatePlaying(dt);
    else if (this.state === 'card') this._updateCard(dt);
    else if (this.state === 'intro') this._updateIntro(dt);
    // 通关横幅（魔术师Boss）：始终驱动，10s 后自动退出（不依赖关卡/抽卡状态）
    if (this.waves && this.waves._winBanner) this.waves._winBanner.update(dt);
    if (this._runResultPanel) this._runResultPanel.update(dt);
    this.midWarning?.update(dt);   // 第四十二修：中场预警横幅（淡入→停留→淡出，到点自动隐藏）
    this._updateGoldOrbs(dt);      // 第四十六修：引导金点飞向选项卡（到点开抽卡）
    this._updateHealLinks();       // 第四十六修：治疗术士的治疗线（表现）
    this.vignette.update(dt);   // 命中着色：上色→褪色，结束后自动隐藏
    this._updateFx(dt);         // 档2：曳光/火花/碎片/枪口焰（帧末取位，与弹头不会错位）
  }

  // ====== 档2 打击感视觉层（第四十一修）======
  //   曳光：每帧只扫一遍「玩家子弹 + 敌方投射物」，写进同一条 InstancedMesh（1 draw call）。
  //   必须是帧末调用（所有 update 之后）——位置才是本帧最终值，尾迹与弹头不会错位一帧。
  _updateFx(dt) {
    if (!this.fx) { this._updateShopCoinBadge(0); return; }
    // 第六十五修：本帧落地的击杀金点金额 → 推「枪上商店币小框」的数字（现场：金点飞到，数字才变）
    const coinLanded = this.fx.update(dt, this._coinTarget);
    this._updateShopCoinBadge(coinLanded);
    if (!FX.TRACER.ENABLED) return;
    const tail = this.fx.tracer;
    const d = this._tailDir;
    const palmTint = (BUDDHA.PALM_WIND && BUDDHA.PALM_WIND.TINT != null) ? BUDDHA.PALM_WIND.TINT : 0xffd76a;
    tail.begin();
    const bullets = this.bullets.active;
    for (let i = 0; i < bullets.length; i++) {
      const b = bullets[i];
      d.copy(b.vel).normalize();
      // 第四十二修：尾迹最多拖到「出生点」(b.origin)，绝不越过枪管 ——
      //   子弹出生点在枪管内部(SHOOT.SPAWN_OFFSET)，照常拖满 LENGTH 的话，
      //   弹头刚出膛那几帧整条尾迹会穿到枪管后方（玩家反馈的「曳光延伸到枪管背后」）。
      // 第四十九修：加速弹（b.boost）曳光变蓝 + 加长一倍 —— 让「射速加速」不用看面板也能一眼看出
      // 第八十四修：掌风弹曳光同步变金；若同时处于加速期，仍优先保留加速蓝与更长的尾迹。
      const col = (b.tint != null) ? b.tint
        : (b.boost ? RAPID_FIRE.VISUAL.TRACER_COLOR : (b.palm ? palmTint : FX.TRACER.COLOR));
      const trailMul = b.boost
        ? Math.max(RAPID_FIRE.VISUAL.TRACER_MUL, (b.trailMul > 1) ? b.trailMul : 1)
        : ((b.trailMul > 1) ? b.trailMul : 1);
      tail.add(b.pos, d,
        // 第五十六修：带 tint 的特殊弹（追踪弹 / 穿甲弹）曳光也用自己的颜色，并按 trailMul 加长
        col,
        b.origin ? b.pos.distanceTo(b.origin) : null,
        trailMul);
    }
    if (this.projectiles) {
      const list = this.projectiles.list;
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        d.copy(p.vel).normalize();
        const col = FX.TRACER.ENEMY_COLORS[p.kind];
        tail.add(p.mesh.position, d, col == null ? FX.TRACER.COLOR : col);
      }
    }
    tail.end();
    this.damageNumbers?.flushUploads();   // 第四十二修：把本帧超预算未上传的伤害数字贴图补上
  }

  /**
   * 第八十三修 · 商店关开场语音的起播闸门。
   *   现场口径：「等云雾和横幅过去后播放」。所以必须同时满足：
   *     ① 云雾已结束（_introActive=false）；
   *     ② 关卡名横幅已经排完并且已经收掉（_levelTitleAt / _levelTitleText / midWarning.showing）。
   *   每帧检查一次，起播后立刻清标记，不会重复播。
   */
  _tickShopVoice() {
    if (!this._shopVoicePending) return;
    if (!shopVoiceReady({
      introActive: this._introActive,
      titleAt: this._levelTitleAt,
      titleText: this._levelTitleText,
      bannerShowing: !!(this.midWarning && this.midWarning.showing),
    })) return;
    this._shopVoicePending = false;
    const url = OPENING_MAGICIAN.SHOP_VOICE_URL;
    if (!OPENING_MAGICIAN.SHOP_VOICE_ENABLED || !url) return;
    // 语音起播时重置兜底计时：确保「模型 10s 自动消失」不会抢在语音结束之前。
    this.openingModel?.restartTimer?.();
    const el = this.audio?.playVoice(url, OPENING_MAGICIAN.SHOP_VOICE_VOLUME ?? 1);
    this.log('[商店] 开场语音起播（雾散 + 关卡横幅结束）');
    this._bindOpeningVoice(el);
  }

  // 穿云结束后统一启动本关 BGM + 开场语音（雾气转场期间一律静音）
  _startLevelAudio() {
    if (this._pendingBgm) {
      const { kind, variant, intensity } = this._pendingBgm;
      this.audio?.setTrack(kind, variant);   // 设置曲目（normal/laser/boss + 变体）
      this.audio?.setIntensity(intensity);   // 起步强度
      this.audio?.startBGM();                // 起播（雾气结束才响）
      if (kind === 'boss') this.audio?.playBossSting(); // Boss 进场演出：升调+铜锣+三连太鼓
    }
    if (this._pendingOpenVoice) {
      const _voiceEl = this.audio?.playVoice(this._pendingOpenVoice);
      this._bindOpeningVoice(_voiceEl);   // 机制关(3/9/15)：语音播完 → 魔术师同步收场
    }
    this._pendingBgm = null;
    this._pendingOpenVoice = null;
    // 第四十九修：标题卡改到「进关起雾那一刻」排期（见 _loadLevel 末尾的 _queueLevelTitle），
    //   这里**不再**补排 —— 否则雾散时会重置倒计时，卡片就永远落在雾后面了。
  }

  // 开场语音联动：语音播完（ended）→ ①机制关(3/9/15)魔术师动画同步收场 ②第18关魔术师 Boss 结束开场演出、进激光阶段。
  // 解决「动画 SHOW_SECONDS(10s) 比语音(5.9~7.5s) 长 2~4 秒」的不匹配。
  // 语音加载失败 / ended 不触发时，仍由 OpeningModel.SHOW_SECONDS 与 MAGICIAN_BOSS.PHASE.INTRO 各自兜底。
  _bindOpeningVoice(el) {
    if (!el) return;
    const seq = ++this._openingVoiceSeq;
    // 第18关标定用：把语音当前时间打进留痕，便于现场确认「我就是Boss中的Boss」对应秒数
    // （对齐后改 userConfig.MAGICIAN_BOSS.INTRO.CUE_AT，或把 INTRO.LOG_VOICE 改 false 关掉）
    if (MAGICIAN_BOSS.INTRO.LOG_VOICE && LEVELS[this.levelIndex] && LEVELS[this.levelIndex].n === 18) {
      const step = MAGICIAN_BOSS.INTRO.LOG_STEP || 0.5;
      let next = step;
      el.addEventListener('timeupdate', () => {
        if (seq !== this._openingVoiceSeq) return;
        if (el.currentTime < next) return;
        next += step;
        this.log('开场语音 ' + el.currentTime.toFixed(1) + 's / ' + (el.duration || 0).toFixed(1) + 's');
      });
    }
    el.addEventListener('ended', () => {
      if (seq !== this._openingVoiceSeq) return;   // 已切关/已换关：回调作废
      if (this.openingModel && OPENING_MAGICIAN.FOLLOW_VOICE) this._shatterOpening();
      const mb = this.waves && this.waves._magicianBoss;   // 第18关：结束开场演出 → 激光阶段
      if (mb && mb.onOpeningVoiceEnd) mb.onOpeningVoiceEnd();
      // 第四十九修（返工）：机制关(3/9/15)的关卡名等到这一刻才弹 —— 魔术师刚收场，视线正前方是空的。
      //   _queueLevelTitle 内部有 _levelTitleDone 守卫，兜底那一次若已弹过就不会再弹。
      const _lvNow = LEVELS[this.levelIndex];
      if (_lvNow && isLaser(_lvNow)) this._queueLevelTitle(LEVEL_TITLE.MECHANIC_AFTER_VOICE);
    }, { once: true });
  }

  /** 第八十三修：魔术师退场 —— 先量世界包围盒，再移除模型，最后在身体范围撒紫色碎片。 */
  _shatterOpening() {
    const om = this.openingModel;
    if (!om) return;
    this.openingModel = null;
    const hit = om.shatter();
    if (!hit || !this.fx || !FX.DEBRIS.ENABLED) return;
    const { center, size } = hit;
    const color = OPENING_MAGICIAN.SHATTER_COLOR;
    const mul = OPENING_MAGICIAN.SHATTER_MUL || 1;
    const dx = Math.max(0.25, (size.x || 0) * 0.3);
    const dy = Math.max(0.25, (size.y || 0) * 0.3);
    // 身体中轴 + 左右 + 上下：5 团碎片，覆盖整个人形，避免只在一颗点爆开
    const pts = [
      center,
      new THREE.Vector3(center.x - dx, center.y, center.z),
      new THREE.Vector3(center.x + dx, center.y, center.z),
      new THREE.Vector3(center.x, center.y + dy, center.z),
      new THREE.Vector3(center.x, center.y - dy * 0.6, center.z),
    ];
    for (const p of pts) this.fx.debrisBurst(p, color, mul);
  }

  // 释放开场魔术师动画，并作废其语音联动回调（切关 / 回菜单共用）
  _disposeOpening() {
    this._openingVoiceSeq++;
    this._shopVoicePending = false;
    if (this.openingModel) { this.openingModel.dispose(); this.openingModel = null; }
  }

  // Boss 关程序化 BGM 升压：按「战斗时长」与「掉血进度」取较大者，ramp 到目标强度（0.45→1.0）
  _updateBossIntensity(dt) {
    if (!this.audio || this.audio.track !== 'boss') return; // 仅 Boss 曲生效（非 Boss 关早退）
    this._bossT += dt;                                       // 已战斗秒数
    let prog = this._bossT / BOSS_BGM.TIME_TO_MAX;           // 时长进度
    const boss = this.waves && (this.waves.faceBoss || this.waves.boss); // 脸谱/骑士 Boss
    if (boss && boss.maxHp) prog = Math.max(prog, 1 - boss.hp / boss.maxHp);
    if (this.dragon && this.dragon.maxHpPool) prog = Math.max(prog, 1 - this.dragon.hpPool / this.dragon.maxHpPool); // 龙 Boss 总血量池
    prog = Math.min(1, prog);
    const v = Math.min(BOSS_BGM.MAX_INTENSITY, BOSS_BGM.START_INTENSITY + prog * BOSS_BGM.RISE_RANGE);
    if (Math.abs(v - this._bossInten) > 0.02) {              // 超阈值才下发，避免每帧重复赋值
      this._bossInten = v;
      this.audio.setIntensity(v);
    }
  }

  _updatePlaying(dt) {
    this._updateBossIntensity(dt); // Boss 关每帧升压（非 Boss 关内部早退）
    // 第四十九修：标题卡倒计时放在**穿云冻结之前** —— 它要在开场云雾窗里就弹出来（雾散时仍在屏上）。
    this._tickLevelTitle(dt);
    // ====== 关卡开场穿云：INTRO_DELAY 秒内冻结玩法（不移动/不开火/不触发技能），仅自然转头观察 ======
    if (this._introActive) {
      this._introT += dt;
      this._pumpLevelTasks();                      // 第四十五修：本关构建分帧（每帧一组，雾盖着做完）
      if (this.cloudFx) this.cloudFx.update(dt);   // 驱动云雾动画（后飘3s → 由前向后缩短1s）
      const _ef = Math.min(1, this._introT / CLOUD.INTRO_DELAY); // 场景透明度随云雾进度 0→1 同步淡入
      this.world.setEnvOpacity(_ef);      // 环境：天空/地面/星空
      // 本关场景物体：传送门/激光几何/玻璃格/龙 等。GLB 是异步加载的，
      // 故每帧按差集补登记新出现的物体并对齐当前进度，避免云雾后半段「突然满显」。
      if (this._fadeSceneBefore) {
        this.world.extendFadeRoots(this.world.scene.children.filter((o) => !this._fadeSceneBefore.has(o)), _ef);
      }
      this.world.setObjectsOpacity(_ef);  // 统一套用当前淡入进度
      // 第六十八修：把「淡入材质恢复最终状态 + shader 重编译」摊到云雾窗内，每帧 1 份；
      //   再预热几份还没上过屏的材质/贴图 —— 转头时不再有第一次编译的长帧。
      this.world.restoreFadeStep?.(this.world.camera, 1, 2.5);
      this.world.warmSceneGpu?.(this.world.camera, 2.0);
      this.balloons.flushRetired?.(2);     // 第六十八修：上一关/融合吸收的 GPU 资源在雾里分帧释放
      this.hud.setHp(this.player.hp, this.player.maxHp);
      this._pumpIntroPreload();            // 穿云窗内每帧摊一个预载（敌人 GLB 解码 + DepthSprite 抓帧）
      if (this._introT >= CLOUD.INTRO_DELAY) {
        this._drainLevelTasks();                 // 第四十五修：兜底 —— 万一分帧没跑完，这里一次性补完
        this._introActive = false;
        if (this.cloudFx) { this.cloudFx.dispose(); this.cloudFx = null; }
        this.world.setEnvOpacity(1);       // 确保关卡正式开始时环境完全显现
        this.world.setObjectsOpacity(1);   // 物体淡入到 1 即自动恢复原始材质设置
        this.log('穿云结束 · 关卡正式开始');
        this._startLevelAudio();   // 雾气转场结束 → 启动本关 BGM + 开场语音
      }
      return;
    }
    this._tickShopVoice();   // 第八十三修：商店关语音等「雾散 + 关卡名横幅结束」后再起播
    this.input.update(dt);
    // 测试能量键（左手 X / 桌面 G）：按一下 +TEST.ADD_SCORE，用于快速测试技能（受 SCORE_CAP 上限裁剪）
    const credit = this.input.consumeCredit();
    if (credit > 0) { this._addScore(credit); this.log(`测试 +${credit} 能量`); }
    this.player.update(dt);
    this.bullets.update(dt, this._homingTarget);   // 第五十五修：追踪弹每帧转向
    const pp = this._playerPos();

    // 第四十九修：加速期（连杀 10 触发）当前打出的子弹整批染蓝 + 曳光加长，见 RAPID_FIRE.VISUAL
    const _boostShot = this._gameTime < this._rapidUntil;
    this._tickShopItems();   // 第五十五修：商店道具逐帧效果（多才是王道自动触发）
    // 第五十修：累计这一帧**实际打出**的弹数（player.fire 返回弹道数）—— 龙族宝箱按它给加成
    this._firePlayerShots(_boostShot);   // 第五十五修：统一开火入口（宝箱计数 + 串糖葫芦穿甲弹都在里面）
    // 档2：枪口焰 —— 用**真实枪口位姿**（与红射线/子弹同源）闪一下；不改动任何弹道
    //   第四十二修：连方向一起传 —— 焰光沿枪口方向前移 FX.MUZZLE.FORWARD，避免被枪管自身遮住。
    if (FX.MUZZLE.ENABLED && this.input.shots.length > 0) {
      const lastShot = this.input.shots[this.input.shots.length - 1];
      this.fx.muzzle(lastShot.position, lastShot.direction);
    }

    // 选中技能：冷却递减；左手柄 grip(或桌面 F)请求释放 → 冷却就绪则触发
    // 第六十九修：把 NaN / undefined 自愈成 0。旧包遇到「内容包卖了新技能、客户端还没实现」时，
    //   冷却曾经变成 undefined / NaN → `<= 0` 恒为 false ⇒ 左右手**永久**放不出技能。
    this.skillCooldown = Number.isFinite(this.skillCooldown)
      ? Math.max(0, this.skillCooldown - dt)
      : 0;
    // 第四十六修：第4关开局锁技能（提示「快使用技能」结束后解锁）—— 请求照常消费，只是丢弃，防误按后延迟触发
    if (this._skillLocked && this.waves && this.waves._scriptElapsed >= this._skillUnlockAt) {
      this._skillLocked = false;
      this.log('[技能] 解锁（第4关提示结束）');
    }
    if (this.input.consumeSkill()) {
      // 第六十九修：被拒时也留一行痕（头显上看不到 DOM 日志，但现场能导出留痕）
      if (this._skillLocked) this.log('[技能] 未就绪：开场提示未结束');
      else if (this.skillCooldown > 0) this.log('[技能] 冷却中 ' + this.skillCooldown.toFixed(1) + 's');
      else this._triggerSelectedSkill();
    }
    const skillLabel = this.selectedSkill === 'buddha' ? '如来神掌'
                     : this.selectedSkill === 'lightsaber' ? '激光剑'
                     : this.selectedSkill === 'scatterburst' ? '散射强化'
                     : this.selectedSkill === 'blackhole' ? '黑洞'
                     : this.selectedSkill === 'scatter' ? '能量散射' : null;
    this.hud.setSkill(this._skillLocked ? '技能锁定（等提示结束）' : skillLabel, this.skillCooldown, this._skillCdTotal());

    // 激光剑「5秒伤害状态」：完全展开那一刻才起算 DURATION 秒（展开动画 0.5+0.2+0.5 不计入）
    if (this.leftSword.active) {
      if (this.leftSword.readyForDamage && !this._swordReadyMarked) {
        this._swordReadyMarked = true;
        this._swordUntil = this._gameTime + LASER_SWORD.DURATION;
      }
      if (this._gameTime >= this._swordUntil) this.leftSword.setActive(false);
    }
    // 激光剑近战命中（所有关卡通用：激光关无普通怪则自然 no-op）
    if (this.leftSword.active && this.leftSword.readyForDamage) this._updateSwordMelee();

    // ====== 商店关（第五十五修）：无敌人，只有可购买的气球 ======
    if (this.shopMode) {
      this._updateShop(dt, pp);
      this._updateBlackHole(dt);   // 第六十九修：商店里放的洞也要走时间轴（否则停在原地不消失）
      return;
    }

    // ====== 激光关：无普通敌人，仅激光气球 ======
    if (this.laserMode) {
      this._updateLaserLevel(dt, pp);
      this._updateBlackHole(dt);   // 第六十九修：同上（当前机制关已改商店，保留兼容）
      return;
    }

    // ====== 普通关 ======
    // 气球以玩家世界位置为终点移动（所有怪追玩家）；碰飞毯区域自爆逻辑不变（见 _checkExplosions）
    this.balloons.update(dt, pp, this.world.camera);
    this._updateDangerAlarm(dt, pp);   // 第六十一修：内圈报警
    this._updateBasicVoice(dt); // 基础怪群体语音：数量达标播放一次，停顿后再判断
    this._updateDragonChest(dt); // 第五十修：龙族宝箱（计数窗口 → 化光点飞向玩家 → 放行抽卡）
    this.projectiles.update(dt, pp); // 投射物飞行/自旋/命中回收（玩家位置 pp = rig 头部世界坐标）
    if (this.dragon) {
      this.dragon.update(dt, pp);   // 龙 Boss：逐帧接管龙气球位置
    } else {
      this.waves.update(dt);
    }

    // 第六十修 · 教学关：按段落推进（出怪 / 横幅 / 单卡 / 免费技能），
    //   走完整条链后由 _finishTutorial 交回正常三选一（见 game/tutorial.js）
    this.tutorial?.update(dt);

    // 第六十七修 · 黑洞：必须排在 balloons/waves 之后 —— 接管位置时新刷出的怪也会被吸
    this._updateBlackHole(dt);

    // 第四十二修 · 中场预警：普通关/危机关过半时弹一次「更强的敌人来袭」（每关一次）
    //   判据 = 本关时间窗(levelSecondsOf) × MID_WARNING.AT；机制关/Boss 关没有倒计时，不弹。
    //   ⚠ 第四十五修：不再排除 this.normalTest —— 它是「普通关」的代名词（NORMAL_TEST.enabled 默认开），
    //     原来那句 !this.normalTest 让**所有普通关**都跳过判定 ⇒ 横幅在现场从未出现过。
    //     机制关/Boss 关没有倒计时，由 midWarningDue(seconds<=0) 自然挡住。
    if (MID_WARNING.ENABLED && !this._isTutorialLevel()) {   // 第六十修：教学关不弹中场横幅
      const lv = LEVELS[this.levelIndex];
      if (lv && !isBoss(lv) && !isLaser(lv)
          && midWarningDue(this.waves.elapsed, levelSecondsOf(lv.n), this._midWarned)) {
        this._midWarned = true;
        this.midWarning?.show();
        this.log('中场预警：更强的敌人来袭（第 ' + lv.n + ' 关已过半 ' + Math.round(this.waves.elapsed) + 's）');
      }
    }

    // 聚宝盆等脚本化死亡（寿命到期 → 标记 _pendingKill）在此结算
    for (let i = this.balloons.list.length - 1; i >= 0; i--) {
      const b = this.balloons.list[i];
      if (b._pendingKill && b.alive) { b.alive = false; this._onKilled(b); }
    }

    this._collide(); // 仅子弹vs气球（气球vs飞船已移除，改由 _checkExplosions 处理）
    this._tickPoison(dt);   // 瘟疫医生：毒素每秒统一结算

    // 气球进入4×8区域则自爆，可能伤害飞船并触发重开（龙气球为纯靶子，跳过不伤人）
    if (this._checkExplosions()) return;

    this.hud.setScore(this.score);
    this.hud.setHp(this.player.hp, this.player.maxHp);
    // 正常测试：显示"距停止补怪"倒计时，便于观察出怪曲线
    if (this.normalTest) {
      // 第六十修：教学关没有倒计时（脚本按「打完/超时」推进）→ 收起倒计时，不显示会误导的数字
      if (this._isTutorialLevel()) this.hud.clearCountdown();
      else {
        const stopAt = levelSecondsOf(this.level ? this.level.n : 0);   // 第四十一修：倒计时按关卡取（见 constants.LEVEL_SECONDS）
        this.hud.setCountdown(Math.ceil(Math.max(0, stopAt - this.waves.elapsed)));
      }
    }

    if (!this.player.alive) { this._restartLevel(); return; }
    const cleared = this.dragon ? this.dragon.cleared : this.waves.cleared;
    // 第18关魔术师Boss：通关横幅激活期间不走抽卡，改由横幅 10s 计时自动退出
    // 第18关魔术师 Boss：本关通关不走抽卡/毕业汇总（_winBanner 在跑横幅，或已击杀待收尾）
    //   —— 第三十九修：即使 WIN_BANNER_SECONDS=0（不建横幅）也要挡住，否则同一帧又去开抽卡界面。
    // 第五十修 · 第12关龙族宝箱：龙 Boss 打死后**不马上开抽卡** —— 先在选项卡位置立宝箱，
    //   5 秒内按打出的子弹数换攻击力；宝箱化光点飞向玩家后才轮到抽卡（见 _updateDragonChest）。
    if (cleared && this._chestRunning()) return;
    if (cleared && !(this.waves && (this.waves._winBanner || this.waves.magicianCleared))) {
      // 第四十六修：金点正在飞 / 中途抽卡已开 → 先挂起，等它们收尾（_onMidCardDone / 金点落地后补）
      if (this._chestDue()) this._startBossChest();
      else if (this._goldOrbs.length || this._midDraftPending) this._levelClearHeld = true;
      else if (this._draftsThisLevel > 0) {
        // 第四十七修：本关已经抽过卡（精英清场那次）→ 不再弹第二次，但关卡照常推进
        this.log('本关已抽过卡（精英清场）→ 直接进入下一关');
        this._onCardDone();
      } else this._enterCard();
    }
  }

  // 基础怪群体语音：场上存活基础怪(排除龙身部件)「成群」时播放一次，停顿 PAUSE 秒后再判断。
  //   第六十四修：门槛不再写死 —— 由 basicVoiceNeed(本关杂鱼配额) 算（原因见 constants.BASIC_VOICE 注释）
  //   ★★ 第六十六修（现场口径 · 最终结论）：**只有脸谱 Boss 的第一阶段（蓝 · 召唤阵冲锋）才放**，
  //      其它任何关卡 / 阶段一次都不放 —— 现场原话「其它关卡中不要放，因为太吵了」。
  //      ⇒ 门禁排在**计数之前**：普通关连怪都不数（见 _basicVoiceAllowed）。
  _updateBasicVoice(dt) {
    if (!this.audio) return;
    if (!this._basicVoiceAllowed()) return;   // ★ 第六十六修：不是脸谱 Boss 第一阶段 → 整段不参与
    if (this._basicVoiceTimer > 0) { this._basicVoiceTimer -= dt; return; } // 停顿中，暂不判断
    let n = 0;
    for (const b of this.balloons.list) {
      if (b.behavior === 'basic' && !b.isDragonPart && b.alive) n++;
    }
    const quota = this._basicVoiceQuota();
    const need = basicVoiceNeed(quota, BASIC_VOICE);
    if (n >= need) {
      if (this._basicVoiceEl) { try { this._basicVoiceEl.pause(); } catch (e) {} } // 重播前先停上一个，避免叠加
      this._basicVoiceEl = this.audio.playVoice(BASIC_VOICE.URL, BASIC_VOICE.VOLUME); // 播放一次（不循环）
      this._basicVoiceTimer = BASIC_VOICE.PAUSE; // 播放后停顿 PAUSE 秒再判断
      if (BASIC_VOICE.LOG) this.log(`[冲冲冲] 基础怪 ${n} 只 ≥ 门槛 ${need}（本关配额 ${quota}）`);
    }
  }

  // 本关「杂鱼配额」= 内圈 + 外圈目标（waves 每 5s 按内圈存活数重算；没有 waves 时返回 0）
  _basicVoiceQuota() {
    const w = this.waves;
    if (!w) return 0;
    return (w.innerQuota || 0) + (w.outerQuota || 0);
  }

  /**
   * ★★ 第六十六修 · 「冲冲冲」门禁：**只有脸谱 Boss 的第一阶段**允许发声。
   *
   * <p>现场口径（原话）：「冲冲冲的语音，只有第三关的脸谱Boss的第一阶段才会有，其它关卡中不要放，
   *    因为太吵了。」—— 这是一条**位置**要求，不是"门槛调高低"：其它关卡要**完全静音**。
   *
   * <p>判据 = ① 本关是脸谱 Boss 关（waves.faceBoss 在场）② 相位是 0 = 蓝 = 召唤阵冲锋。
   *    为什么认「脸谱 Boss 的相位」而不是关卡号：蓝阶段会一次召唤左右各 3×3（共 18 只，中心格骑士、
   *    其余 basic）冲过来 —— 这正是"冲冲冲"该响的地方；而普通关按配额滴流（前期 6~10 只）声势完全不同。
   *
   * <p>⚠ 必须带 alive 判断：Boss 被打死后 waves.faceBoss 仍指向那个气球（见 waves._updateFaceBoss
   *    的 cleared 分支），少了它，Boss 死的那一帧还会多喊一声。
   */
  _basicVoiceAllowed() {
    const w = this.waves;
    return !!w && !!w.faceBoss && w.faceBoss.alive === true && w.facePhase === 0;
  }

  // 激光关主循环：激光动画 + 保持期发光驱动 + 走格子/九宫格阶段分派
  _updateLaserLevel(dt, pp) {
    this.laser.update(dt, pp);
    // 激光致死判定改用「玩家头部(相机)世界坐标」：rig 地板坐标 y≈0 与激光束高度 y=2~9.5 相差 >2m，
    // 远超出 BEAM_LETHAL_R+PLAYER_R(0.55m)，用脚底判定会永远漏判 → 玩家贴脸也死不了。改头部坐标 y≈1.6 贴合受击体积。
    const php = this.world.camera.getWorldPosition(new THREE.Vector3());
    // 机制关激光嗡鸣：激光束出现(beamsVisible)时响起、消失时淡出（声音随激光出现/消失）
    if (this.laser.beamsVisible) { this.audio?.startLaserHum('level'); this.audio?.setLaserHumLevel('level', 0.7); }
    else this.audio?.stopLaserHum('level');

    // ===== flip 模式（第十五关：九宫格翻转射击）=====
    if (this.laser.mode === 'flip') {
      // 1) 16s 保持期起点：生成九宫格（用户修改①：在 16–18s 窗口内出现）
      if (!this.flipGrid && this.laser.isHoldPhase()) {
        this.flipGrid = new FlipGrid(this.world.scene);
        this.log('九宫格已生成：击破正面气球触发十字翻转');
      }
      // 2) 九宫格交互（16–18s 与 18s+ 都生效）
      if (this.flipGrid) {
        for (let i = this.bullets.active.length - 1; i >= 0; i--) {
          const b = this.bullets.active[i];
          const hit = this.flipGrid.tryHit(b);
          if (hit) {
            this.bullets.release(b);
            this.audio?.playPop();
            if (hit.reset) {
              this.flipGrid.resetState();
              this.flipTimer = FLIP.COUNTDOWN;   // 倒计时重置
              this.log('九宫格已重置，倒计时重置为180秒');
            }
          }
        }
        this.bullets.sync(); // 九宫格命中释放后刷新实例矩阵
        this.flipGrid.update(dt);
        if (!this.flipGrid.victory && this.flipGrid.checkWin()) this.flipGrid.beginVictory();
        if (this.flipGrid.victoryDone) { this._finishFlipLevel(true); return; }
      }
      // 3) 致命判定：进入安全期前激光仍致命（用户修改①：16–18s 致命）
      if (!this.flipPhase) {
        const hit = this.laser.hitTest(php, LASER.PLAYER_R);
        if (hit) { this._dieInLaserLevel(); return; }
      }
      // 4) 18s 进入安全解谜期：激光淡出不致命 + 启动 180s 倒计时（用户修改②）
      if (!this.flipPhase && this.laser.reachedGoal(pp)) {
        this.flipPhase = true;
        this.audio?.setIntensity(0.35);   // 安全解谜期：激光消散，音乐降压转安静
        this.laser.enterGridPhase();
        this.flipTimer = FLIP.COUNTDOWN;
        this.audio?.setIntensity(0.35); // 第十五关进入安全解谜期：降压到 0.35（AUDIO-SPEC §6.2）
        this.log('激光消散，180 秒倒计时解谜（解出→抽卡，归零→直接下一关）');
      }
      // 5) 安全期倒计时（用户修改②）
      if (this.flipPhase) {
        this.flipTimer -= dt;
        this.hud.setCountdown(Math.max(0, Math.ceil(this.flipTimer)));
        if (this.flipTimer <= 0) { this._finishFlipLevel(false); return; }
      }
      this.hud.setScore(this.score);
      this.hud.setHp(this.player.hp, this.player.maxHp);
      return;
    }

    // ===== drive / full 模式（第三、九关，原逻辑不变）=====
    // 保持原地期（驱赶到位后、激光未消散前）：正确格持续闪烁发光
    const holdPhase = this.laser.isHoldPhase();
    if (this.grid && !this.gridPhase) this.grid.update(dt, holdPhase);

    if (this.gridPhase) { this._updateGridPhase(dt, pp); return; }

    // ---- 激光阶段（生成 / 驱赶 / 保持原地）----
    const hit = this.laser.hitTest(php, LASER.PLAYER_R);
    if (hit) { this._dieInLaserLevel(); return; }
    if (this.laser.reachedGoal(pp)) {
      if (this.laser.mode === 'drive') {
        // 保持期结束 → 激光消散，转入走格子阶段
        this.gridPhase = true;
        this.audio?.setIntensity(1);      // 走格子阶段：节奏与滤波拉满
        this._lastCell = 0;
        this._failing = false;
        this.laser.enterGridPhase();
        this.audio?.setIntensity(1); // 第九关进入走格子阶段：升压到 1.0（AUDIO-SPEC §6.2）
        this.log('激光消散，开始走格子：踩正确格子，踩错会破碎');
      } else {
        this.audio?.stopLaserHum('level');
        this.laser.dispose();
        this.laser = null;
        this._enterCard(); // 第三关固定三张红色技能卡（如来神掌/激光剑/黑洞）
      }
      return;
    }
    this.hud.setScore(this.score);
    this.hud.setHp(this.player.hp, this.player.maxHp);
  }

  // 第九关 drive 模式：走格子阶段（激光已消散，玩家在玻璃格上行走）
  _updateGridPhase(dt, pp) {
    if (this._failing) {
      this._failTimer -= dt;
      const k = Math.min(1, 1 - Math.max(0, this._failTimer) / 0.6);
      this.rig.position.y = -10 * k * k;   // 踩错掉落 10 米（重力加速感）
      if (this._failTimer <= 0) { this._dieInLaserLevel(); return; }
    }
    const idx = this.grid ? this.grid.cellAt(pp) : 0;
    if (idx && idx !== this._lastCell) {
      this._lastCell = idx;
      const r = this.grid.onEnter(idx);
      if (r === 'wrong') {
        this.grid.breakCell(idx);          // 踩错：破碎动画
        this._failing = true;
        this._failTimer = 0.6;             // 0.6s 后本关重开
        this.log('踩到错误格子，玻璃破碎！本关重开');
        return;
      }
      if (r === 'win') {
        this.audio?.stopLaserHum('level');
        this.laser.dispose(); this.laser = null;
        // 走到底（通关格）：玻璃板块**保留在场**，不在这里 dispose，等切换关卡时由 _loadLevel 统一清理。
        //   原先此处直接 dispose → 玩家一走到终点就看到脚下玻璃板块当场消失。
        this.gridPhase = false;
        this._enterCard();
        return;
      }
    }
    if (this.grid) this.grid.update(dt, false); // 走格子阶段：激光已消散，发光关闭
    this.hud.setScore(this.score);
    this.hud.setHp(this.player.hp, this.player.maxHp);
  }

  // 激光关死亡：不触发全局 GameOver，本关从头重开、激光重新初始化
  _dieInLaserLevel() {
    this.log('失败，本关重开');
    this._respawnKeepPosition();   // 机制关重开：保留玩家水平位置（就在失败处原地重来），只把高度拉回 0
    this.player.hp = this.player.maxHp;
    if (this.laser) this.laser.reset();
    if (this.grid) this.grid.reset();   // 玻璃网格（含破碎格）一并重建
    this.world._restoreFade();           // 恢复穿云淡入改写的材质（重开会重新登记）
    if (this.flipGrid) { this.flipGrid.dispose(); this.flipGrid = null; } // 九宫格 dispose，下次 16s 由 isHoldPhase 重建为初始布局
    this.gridPhase = false;
    this.flipPhase = false; this.flipTimer = 0;
    // 走格子：把「上一次所在格」置为玩家此刻站着的格（而非 0）。否则玩家在错误格上原地重生时，
    //   下一帧 idx !== _lastCell 会立刻再次判错 → 每 0.6s 无限重开（站着不动也逃不掉）。
    //   置为当前格 = 原地站着不判，等玩家迈到别的格再判；踩错惩罚不变（仍会掉落 + 本关重开）。
    this._lastCell = this.grid ? this.grid.cellAt(this._playerPos()) : 0;
    this._failing = false;
    this._failTimer = 0;
    this.hud.clearCountdown();
  }

  // 第十五关收尾：解出→抽卡(withCard=true)；倒计时归零→直接下一关(withCard=false)
  _finishFlipLevel(withCard = true) {
    if (this.flipGrid) { this.flipGrid.dispose(); this.flipGrid = null; }
    if (this.laser) { this.audio?.stopLaserHum('level'); this.laser.dispose(); this.laser = null; }
    this.flipPhase = false;
    this.flipTimer = 0;
    this.hud.clearCountdown();
    this.laserMode = false;
    if (withCard) {
      this._enterCard();   // 解出 → 抽卡（_onCardDone 负责 levelIndex++ 与加载下一关）
    } else {
      this.levelIndex++;   // 倒计时归零 → 直接下一关，不抽卡
      if (this.levelIndex >= LEVELS.length) {
        this._showRunSummary('全部关卡完成（翻牌关收尾）');
        return;
      }
      this._loadLevel(this.levelIndex);
      this.state = 'playing';
    }
  }

  _collide() {
    // 子弹 vs 气球（反向遍历子弹：release swap-pop 后索引稳定；内循环命中即 break，无需 spread）
    const bullets = this.bullets.active;
    this.world.camera.getWorldPosition(this._camPos); // 供 2D 立绘薄板命中(法线=朝相机)使用
    // 第五十三修 · 命中剪枝（纯性能，零行为变化）：
    //   ① 只有场上真的存在 Boss 时才跑第二轮 —— 原来无条件两遍，非 Boss 关的 pass1 每帧纯空转；
    //   ② 每个 pair 先过一道「本帧线段 AABB」粗筛，绝大多数怪在这里就被剔掉 ——
    //      精确判定里的 normalize()（sqrt + 三个除法）才是开销大头。
    //   粗筛是**保守**的（线段 ⊆ 其 AABB，垫上命中半径后不可能漏判），遍历顺序与
    //   「非 Boss 优先」优先级原样保留 ⇒ 命中结果与改前完全一致。
    let hasBoss = false;
    for (const o of this.balloons.list) { if (o.alive && o.isBoss) { hasBoss = true; break; } }
    const passCount = hasBoss ? 2 : 1;
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      // 玻璃墙拦截（第18关魔术师Boss 玻璃墙阶段）：命中墙 → 消费/拦截子弹，不进气球循环
      if (this.waves.magicianGlassWall && this.waves.magicianGlassWall.tryBlock(b)) {
        if (b.blastRadius > 0) this._explodeBullet(b, b.pos);
        this.bullets.release(b);
        continue;
      }
      const list = this.balloons.list;
      // 子弹本帧轨迹的包围盒（直线段 → 盒子就是两端点分量取 min/max），供下面的粗筛用
      const p0 = b.prevPos, p1 = b.pos;
      const segMinX = p0.x < p1.x ? p0.x : p1.x, segMaxX = p0.x < p1.x ? p1.x : p0.x;
      const segMinY = p0.y < p1.y ? p0.y : p1.y, segMaxY = p0.y < p1.y ? p1.y : p0.y;
      const segMinZ = p0.z < p1.z ? p0.z : p1.z, segMaxZ = p0.z < p1.z ? p1.z : p0.z;
      // Boss 代理命中球半径较大(4m)且常位于其他可击破目标(九宫格球/精英)的正后方，
      // 若按 list 顺序优先判定会「抢走」本应命中前方目标的子弹 → 表现为「打小怪掉 Boss 血」。
      // 两遍命中：pass0 只判非 Boss 目标(最高优先)，仅当无命中时才在 pass1 判 Boss 代理。
      let hitBalloon = null;
      for (let pass = 0; pass < passCount && !hitBalloon; pass++) {
        const wantBoss = pass === 1;
        for (let j = 0; j < list.length; j++) {
          const balloon = list[j];
          if (!balloon.alive) continue; // 跳过已隐藏的龙气球（复活前），防重复触发
          if (b._hitUids && b._hitUids.has(balloon.uid)) continue; // 第五十五修：穿甲弹不重复命中同一目标
          // 幽灵怪隐身期间无视子弹（仅蓄力显形时可被击中）
          if (balloon.behavior === 'ghost' && !balloon.revealed) continue;
          if (!!balloon.isBoss !== wantBoss) continue; // pass0 跳过 Boss；pass1 仅 Boss
          const rr = balloon.hitRadius + SHOOT.HIT_PAD; // 命中球 ≈ 怪物可见半径
          // 粗筛：中心点离线段的距离 ≥ 中心点离线段 AABB 的距离 ⇒ 出盒必然打不中。
          // 立绘走薄板判定（横向吃 rr、纵深吃到板厚），垫厚取 rr+HIT_SLAB_DEPTH 作保守上界。
          const bpos = balloon.mesh.position;
          const pad = balloon.depthSprite ? rr + SHOOT.HIT_SLAB_DEPTH : rr;
          if (bpos.x < segMinX - pad || bpos.x > segMaxX + pad) continue;
          if (bpos.y < segMinY - pad || bpos.y > segMaxY + pad) continue;
          if (bpos.z < segMinZ - pad || bpos.z > segMaxZ + pad) continue;
          let _hit = false;
          if (balloon.depthSprite) {
            _closestPointOnSeg(_segClosest, balloon.mesh.position, b.prevPos, b.pos); // 轨迹上离中心最近点
            _segAB.copy(_segClosest).sub(balloon.mesh.position);                      // 最近点→中心
            _segN.copy(this._camPos).sub(balloon.mesh.position).normalize();          // 卡片法线(朝相机)
            const _depth = _segAB.dot(_segN);                                         // 纵深分量(沿法线)
            const _inPlaneSq = Math.max(0, _segAB.lengthSq() - _depth * _depth);      // 平面内横向分量²
            if (_inPlaneSq < rr * rr && Math.abs(_depth) < SHOOT.HIT_SLAB_DEPTH) _hit = true;
          } else {
            if (_pointSegDistSq(balloon.mesh.position, b.prevPos, b.pos) < rr * rr) _hit = true;
          }
          if (_hit) { hitBalloon = balloon; break; }
        }
      }
      if (hitBalloon) {
        // 盾兵怪：盾牌当前朝向玩家且在挡弹夹角内 → 挡下子弹（不扣血）
        if (hitBalloon.behavior === 'shield') {
          const sb = hitBalloon.getShieldBlock();
          if (sb) {
            this._tmp2.copy(this._playerPos()).sub(hitBalloon.mesh.position);
            this._tmp2.y = 0;
            if (this._tmp2.lengthSq() > 1e-6) {
              this._tmp2.normalize();
              if (this._tmp2.dot(sb.dir) > Math.cos(sb.arc)) {
                if (b.blastRadius > 0) this._explodeBullet(b, b.pos);
                this.bullets.release(b);
                this._spawnExplosionFx(b.pos, 0.2); // 挡弹火花
                continue; // 子弹被盾挡下，处理下一发
              }
            }
          }
        }
        // 第八十五修 · 爆炮手：火箭命中即爆炸，由 AoE 统一结算，避免「直伤 + 爆炸」双倍。
        if (b.blastRadius > 0) {
          this._explodeBullet(b, b.pos);
          this.bullets.release(b);
          continue;
        }
        const killed = hitBalloon.takeDamage(this._applyShopDamage(hitBalloon, b.dmg)); // 第五十五修：专打强者
        // 致命那一枪不再叠层：只剩 1 层毒的小怪被最后一枪打死时，不能凭空多出
        // 第二层再触发「感染」；未击杀的命中才继续叠毒。
        if (!killed) this._applyPoisonStack?.(hitBalloon);
        if (b.pierce > 0) {
          // 第五十五修 · 串糖葫芦：穿甲弹命中后不消失，记录已命中目标后继续飞
          b.pierce--;
          if (!b._hitUids) b._hitUids = new Set();
          b._hitUids.add(hitBalloon.uid);
        } else {
          this.bullets.release(b);
        }
        this._damageFeedback(hitBalloon, killed, b.pos);   // 第四十修：伤害数字 + 命中音/轻震动；档2：火花落在弹着点
        if (killed) this._onKilled(hitBalloon);
        if (killed) this._bulletKill(hitBalloon);   // 第四十二修：连杀加速只认子弹击杀
        if (killed) this._shopBulletKill(hitBalloon);   // 第五十五修：商店道具（打狗/吸血）只认子弹击杀
      } else if (b.airburst > 0) {
        // 第八十八修 · 爆炮手教学解锁：这一帧没碰到任何敌人，且已飞满 airburst 米
        //   → 在弹道上的 6 米处自动空爆（再远的目标也炸不到，避免「穿人而过」）。
        if (b.origin.distanceTo(b.pos) >= b.airburst) {
          _airburstPos.copy(b.pos).sub(b.origin).normalize().multiplyScalar(b.airburst).add(b.origin);
          this._explodeBullet(b, _airburstPos);
          this.bullets.release(b);
        }
      }
    }
    this.bullets.sync(); // 碰撞释放后立刻刷新实例矩阵（避免命中子弹滞留一帧）
    // 气球 vs 飞船碰撞已移除 → 改由 _checkExplosions() 处理
  }

  /** 第八十五修 · 火箭爆炸：对半径内所有可命中的怪结算一次 AoE，并统一走击杀/反馈链路。 */
  _explodeBullet(b, at = null, depth = 0) {
    const radius = b?.blastRadius || 0;
    if (!(radius > 0)) return;
    const pos = at || b.pos;
    this._spawnBlastFx(pos, radius);
    if (this._gameTime - (this._lastBlastAt || -99) > 0.045) {
      this._lastBlastAt = this._gameTime;
      this.audio?.playBlast?.(radius);
    }
    const base = b.dmg || 0;
    const hits = [];
    for (const t of this.balloons.list) {
      if (!t.alive) continue;
      if (t.behavior === 'ghost' && !t.revealed) continue;
      const er = t.effectiveRadius || 0;
      const d = t.mesh.position.distanceTo(pos);
      if (d > radius + er * 0.75) continue;
      const dmg = blastDamage(base, radius, Math.max(0, d - er * 0.5), b.blastEdge || 0);
      if (dmg > 0) hits.push({ t, dmg });
    }
    for (const h of hits) {
      const t = h.t;
      if (!t.alive || !this.balloons.list.includes(t)) continue;
      let dmg = this._applyShopDamage(t, h.dmg);
      // 第九十修：龙形 Boss 由多节独立气球组成，爆炮手的一次齐射会同时命中多节。
      //   这里只对「爆炮手 × 龙部件 × 爆炸」追加衰减：已有 95% 减伤再乘 0.30，
      //   等效总减伤 98.5%，不改变爆炸范围/多段命中的表现。
      if (t.isDragonPart && this.player?.characterKey === 'bombard') {
        dmg *= DRAGON.BOMBARD_AOE_TAKE_MUL ?? 0.30;
      }
      const killed = t.takeDamage(dmg);
      this._damageFeedback(t, killed, t.mesh.position);
      if (killed) {
        this._onKilled(t);
        this._bulletKill(t);
        this._shopBulletKill(t);
      }
    }

    // 第八十九修 · 爆炮手「多重爆炸」：首层爆炸后，同点追加 N 次弱化爆炸。
    //   仅首层读取 multiBlast，额外爆炸用 depth>0 阻断递归，避免无限叠加。
    //   伤害 50% / 半径 85%，3 级时总收益约 +150%（不是 4 倍），性能与手感都可控。
    const extra = (depth === 0 && this.player?.characterKey === 'bombard')
      ? (this.player.multiBlast | 0)
      : 0;
    if (extra > 0) {
      const cfg = CHARACTERS.bombard?.bombard || {};
      const echo = {
        dmg: base * (cfg.MULTI_BLAST_DMG_MUL || 0.5),
        blastRadius: radius * (cfg.MULTI_BLAST_RADIUS_MUL || 0.85),
        blastEdge: b.blastEdge || 0,
      };
      for (let i = 0; i < extra; i++) this._explodeBullet(echo, pos, depth + 1);
    }
  }

  // 玩家 DPS = 攻击力 × 多重弹道 × 射速(发/秒)。
  // 射速取 input._gunCooldown（真实节流，随枪械模式切换）；fallback 到 GUN_MODES。
  // 若日后 fireRate 卡修复为同步 input._gunCooldown，此处自动反映。
  _playerDPS() {
    const p = this.player;
    const g = GUN_MODES[this.gunMode] || GUN_MODES.preview;
    const rate = 1000 / (this.input?._gunCooldown || g.cooldown);
    const atk = p?.atk || 100;
    const mode = p?.fireMode || 'fan';
    if (mode === 'satellite') {
      // 主枪 1 发 + 浮游炮各自 1 发；浮游炮伤害按当前溢出系数计。
      const st = swarmState(p?.shotCount || 1, p?.bonusShotCount || 0, CHARACTERS.swarm.satellite);
      return atk * (1 + st.count * st.dmgMul) * rate;
    }
    if (mode === 'bombard') {
      // 主炮 + 微型火箭；dpsWeight 折算 AoE 多目标收益，避免末尾精英血量被范围伤害抬得过高。
      const st = bombardState(p?.shotCount || 1, p?.bonusShotCount || 0, CHARACTERS.bombard.bombard);
      return atk * (1 + st.count * st.dmgMul) * rate * (CHARACTERS.bombard.dpsWeight || 1);
    }
    return atk * ((p?.shotCount || 1) + (p?.bonusShotCount || 0)) * rate;
  }

  // DDA 监测信号：每帧由 DifficultyController 调用，读取玩家综合战力 / 船血 与 场上怪物综合战斗数值
  _ddaMetrics() {
    const p = this.player;
    let threat = 0;
    for (const b of this.balloons.list) {
      const t = b.type;
      if (!t) continue;
      // 威胁分 ≈ 血量 × 速度 × (1+自爆/5)，与 difficultyController 的偏好计算口径一致
      threat += (t.hp / 100) * Math.max(t.speed || 0, 0.1) * (1 + (t.selfDamage || 0) / 5);
    }
    // 玩家综合战力：基础攻击 × (1+多重%) × (大招解锁?1.5:1)
    // 爆炸系统已删除（p.explosion 不再存在）
    const power = p.atk * (1 + p.multiShotChance / 100) * (p.buddhaUnlocked ? 1.5 : 1);
    return {
      hpPct: p.hp / p.maxHp,
      power,
      onScreen: this.balloons.count,
      onScreenThreat: threat,
    };
  }

  // 统一加分并钳制到 SCORE_CAP（能量上限 500）；所有 score 增量必须走这里
  _addScore(n) {
    this.score = Math.min(this.score + (n || 0), SCORE_CAP);
    this.hud.setScore(this.score);
  }

  _onKilled(balloon) {
    this._killFeedback(balloon);   // 第四十修：击杀音色（按敌种）+ 连击升调 + 中/重震动
    // 龙 Boss 部件：隐藏并由 DragonBoss 管理「1秒复活」，不从这里永久移除（且不再连锁炸其他龙部件）
    if (balloon.isDragonPart) {
      if (this.dragon && !this.dragon.dying) {
      this._addScore(balloon.score);
      this._addShopCoin(balloon.score, balloon.mesh.position);   // 第五十五修：龙部件能量同样计入商店币
        this._spawnExplosionFx(balloon.mesh.position, balloon.effectiveRadius);
        this.dragon.notifyKilled(balloon);
      }
      balloon.alive = false;
      balloon.mesh.visible = false;
      return;
    }
    // 聚宝盆：无敌，仅寿命到期死亡；结算 = 自身携带能量 + 存活期间每死一个气球 +50
    if (balloon.behavior === 'treasure') {
      const bonus = (balloon.type.baseScore || 0) + (balloon._killsDuringLife || 0) * (balloon.type.perKillScore || 0);
      this._addScore(bonus);
      this._addShopCoin(bonus, balloon.mesh.position);           // 第五十五修：聚宝盆能量同样计入商店币
      this.balloons.remove(balloon);
      return;
    }
    this._recordRunKill(balloon);   // 第九十二修：结算面板的本局杀敌数
    // 瘟疫医生「感染」：在尸体被移除前，把一半层数传给最近的其它存活敌人。
    this._spreadPlague(balloon);
    // 第四十六修：精英击杀能量 ×ELITE_FEEDBACK.SCORE_MUL（构筑生效的正反馈）
    const _killScore = balloon.isElite ? Math.round((balloon.score || 0) * ELITE_FEEDBACK.SCORE_MUL) : (balloon.score || 0);
    this._addScore(_killScore);
    this._addShopCoin(_killScore, balloon.mesh.position);   // 第五十五修：击杀能量等额计入商店币（以战养战再加成）
    this.dda?.notifyKill();   // DDA：记录一次击杀，用于滑窗击杀率统计

    // 龙 Boss 关：每消灭1个基础怪(basic, 非龙部件) → 通知龙 Boss 计数（每5个扣1%总血量）
    if (this.dragon && !this.dragon.dying && balloon.behavior === 'basic' && !balloon.isDragonPart) {
      this.dragon.notifyBasicKilled();
    }

    // 脸谱 Boss 子实体被击杀 → 按百分比直接扣 Boss 血量（绕过 95% 减伤）
    // 旗子 2%、分身 1%、小怪 2%；Boss 死亡则递归结算（Boss 非 isFaceSub，不会无限递归）
    if (balloon.isFaceSub && balloon.faceBossRef) {
      const boss = balloon.faceBossRef;
      if (boss && boss.alive && this.balloons.list.includes(boss)) {
        let pct = FACE_BOSS.KILL_MINION_HP_PCT;
        if (balloon.type.id === 'flagMask') pct = FACE_BOSS.KILL_FLAG_HP_PCT;
        else if (balloon.type.id === 'blackMaskClone') pct = FACE_BOSS.KILL_CLONE_HP_PCT;
        const dmg = Math.round(boss.maxHp * pct);
        const bossKilled = boss.takeDamage(dmg, true);  // ignoreReduction=true，绕过减伤
        this._damageFeedback(boss, bossKilled);
        if (bossKilled)
          this._onKilled(boss);          // Boss 死亡 → 递归进入正常 Boss 结算
      }
    }
    // 心型怪（治疗术士）：击败后为**飞毯**回血（知识库 30 → 第五十修现场口径 20）
    //   数值是敌种属性（content/enemies.js 的 heart.shipHealOnDeath），表现见 _healFeedback
    //   （眼前绿色加号飞向相机 + 一行「飞毯血量 +N」横幅）。
    if (balloon.behavior === 'heal') {
      const heal = balloon.type.shipHealOnDeath || 0;
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + heal);
      this._healFeedback(heal);
    }
    // 宝箱怪：死后弹出一次选项卡（占位：暂以奖励能量代替，待 mid-level 卡片系统接入）
    if (balloon.behavior === 'chest' && balloon.type.dropCard) {
      this._addScore(50);
      this.log('宝箱怪被击破：待接入 mid-level 选项卡弹出');
      // TODO: 接入 mid-level 卡片弹窗（参考 _enterCard / cardDraft）
    }
    // 存活的聚宝盆记录「本气球死亡」计数（用于结算 +50/个）
    for (const t of this.balloons.list) {
      if (t.behavior === 'treasure' && t.alive && t !== balloon) {
        t._killsDuringLife = (t._killsDuringLife || 0) + 1;
      }
    }
    // 召唤怪被击杀：清掉其所有小怪（击杀召唤者才清场）
    if (balloon.behavior === 'summon' && balloon.minions && balloon.minions.length) {
      for (const m of balloon.minions) if (m.alive) this.balloons.remove(m);
      balloon.minions.length = 0;
    }
    // 爆炸范围伤害已移除（爆炸卡删除）
    this.balloons.remove(balloon);
  }

  // ====== 第九十一修 · 瘟疫医生：毒素 / 感染 ======

  /** 当前角色是否瘟疫医生。 */
  _isPlagueDoctor() { return this.player?.characterKey === 'plague'; }

  /** 当前毒素叠层上限：基础 5；「加大剂量」Lv.1=8，之后每级 +2。 */
  _plagueMaxStacks() {
    const lv = typeof this._itemLevel === 'function'
      ? this._itemLevel('dosage')
      : ((this._itemLv && this._itemLv.dosage) || 0);
    return plagueMaxStacks(lv, CHARACTERS.plague.poison);
  }

  /** 子弹命中叠 1 层毒；龙部件、聚宝盆等不参与，避免异常收益。 */
  _applyPoisonStack(balloon) {
    if (!this._isPlagueDoctor() || !balloon || !balloon.alive) return false;
    if (balloon.isDragonPart || balloon.type?.invincible || balloon.behavior === 'treasure') return false;
    const cap = this._plagueMaxStacks();
    const cur = Math.max(0, balloon._poisonStacks | 0);
    if (cur >= cap) return false;
    balloon._poisonStacks = cur + 1;
    return true;
  }

  /** 每秒统一结算所有中毒目标：每层 = 当前攻击力 × 25%。 */
  _tickPoison(dt) {
    if (!this._isPlagueDoctor()) { this._poisonAccum = 0; return; }
    const cfg = CHARACTERS.plague.poison;
    const tick = Math.max(0.05, Number(cfg.TICK) || 1);
    const list = this.balloons?.list || [];
    let hasPoison = false;
    for (const b of list) {
      if (b && b.alive && !b.isDragonPart && (b._poisonStacks | 0) > 0) { hasPoison = true; break; }
    }
    if (!hasPoison) { this._poisonAccum = 0; return; }
    this._poisonAccum = Math.max(0, Number(this._poisonAccum) || 0) + Math.max(0, Number(dt) || 0);
    if (this._poisonAccum + 1e-9 < tick) return;
    this._poisonAccum = Math.max(0, this._poisonAccum - tick);

    const atk = this.player?.atk || 0;
    const snapshot = list.slice();
    for (const b of snapshot) {
      if (!b || !b.alive || b.isDragonPart || !list.includes(b)) continue;
      const stacks = Math.max(0, b._poisonStacks | 0);
      if (stacks <= 0) continue;
      const dmg = poisonTickDamage(atk, stacks, cfg);
      if (!(dmg > 0)) continue;
      const killed = b.takeDamage(dmg);
      this._damageFeedback(b, killed, null, { poison: true, silent: true });
      if (killed) this._onKilled(b);
    }
  }

  /**
   * 「感染」：中毒敌人死亡时向 5 米内最多 6 只敌人扩散毒素。
   *   · 3 层起触发范围疫爆，传递 floor(层数 × 70%)；
   *   · 2 层只弱传给最近 1 只 1 层；1 层不传播；
   *   · 精英不设额外限制：可吃满传递层数，也可继续向外传播；
   *   · Boss / 龙部件只吃单体毒伤，不参与传播；
   *   · 1.5 秒滑动窗口最多影响 18 只，避免一具尸体直接清空全屏。
   */
  _spreadPlague(dead) {
    if (!this._plagueInfect || !this._isPlagueDoctor() || !dead) return 0;
    const stacks = Math.max(0, dead._poisonStacks | 0);
    if (stacks < 2) return 0;
    const from = dead.mesh && dead.mesh.position;
    if (!from) return 0;

    const cfg = CHARACTERS.plague.poison;
    const cap = this._plagueMaxStacks();
    const list = this.balloons?.list || [];
    const candidates = [];
    for (const t of list) {
      if (!t || t === dead || !t.alive || t.isDragonPart || t.isBoss) continue;
      if (t.type?.invincible || t.behavior === 'treasure' || t._pendingKill) continue;
      if ((t._poisonStacks | 0) >= cap) continue;
      candidates.push(t);
    }
    if (!candidates.length) return 0;

    const radius = Math.max(0, Number(cfg.BURST_RADIUS) || 5);
    const maxTargets = stacks < 3 ? 1 : Math.max(1, Number(cfg.BURST_TARGETS) || 6);
    let targets = plagueBurstTargets(candidates, from, radius, maxTargets);
    if (!targets.length) return 0;

    // 连锁预算：只统计「真正被感染的目标」，已满层 / 距离外的目标不占额度。
    const now = Number.isFinite(this._gameTime) ? this._gameTime : 0;
    const win = Math.max(0.1, Number(cfg.BURST_WINDOW) || 1.5);
    const budgetMax = Math.max(1, Number(cfg.BURST_MAX_TARGETS) || 18);
    const times = this._plagueBurstTimes || (this._plagueBurstTimes = []);
    while (times.length && times[0] < now - win) times.shift();
    const budget = Math.max(0, budgetMax - times.length);
    if (budget <= 0) return 0;
    targets = targets.slice(0, budget);

    const ratio = Math.max(0, Number(cfg.INFECT_RATIO) || 0.7);
    const layers = plagueBurstLayers(stacks, ratio);
    if (layers <= 0) return 0;

    let infected = 0;
    let totalAdded = 0;
    for (const t of targets) {
      const cur = Math.max(0, t._poisonStacks | 0);
      const add = infectionStacks(stacks, cur, cap, ratio);
      if (add <= 0) continue;
      t._poisonStacks = cur + add;
      times.push(now);
      infected++;
      totalAdded += add;
      if (t.mesh?.position) {
        this.fx?.spark(t.mesh.position, 0x5dff9b);
        // 明确的叠层反馈：绿色 +N层，避免玩家只看到烟环却不知道数值有没有生效。
        if (this.damageNumbers && this._fxPos) {
          this._fxPos.copy(t.mesh.position);
          this._fxPos.y += (t.effectiveRadius || 0.5) + 0.55;
          this.damageNumbers.spawn(this._fxPos, add, {
            poison: true, elite: !!t.isElite, prefix: '+', suffix: '层',
          });
        }
      }
    }
    if (infected <= 0) return 0;

    this.fx?.plagueBurst(from, radius, infected);
    if (now - this._plagueSfxAt >= 0.08) {
      this._plagueSfxAt = now;
      this.audio?.playPlagueBurst?.(infected);
    }
    this.log?.('瘟疫扩散：水平 ' + radius + 'm 内 ' + infected + ' 只，共 +' + totalAdded + ' 层'
      + (layers >= 3 ? '（疫爆）' : ''));
    return totalAdded;
  }

  // ====== 打击感（第四十修）======

  // 命中反馈统一入口：伤害数字 + 命中音 + 轻震动。
  //   killed=true 时不发命中音 —— 击杀那一击改由 _killFeedback 发击杀音，
  //   否则「命中 tick + 击杀 thump」会在同一帧叠在一起，反而糊。
  _damageFeedback(balloon, killed, hitPos, opts = null) {
    if (!balloon) return;
    const dealt = balloon._lastDamage != null ? balloon._lastDamage : 0;
    // 档2：命中火花 —— 打在怪身上的那一点（有弹着点就用弹着点，别糊在模型中心）
    if (!opts?.poison) this.fx?.spark(hitPos || balloon.mesh.position);
    if (this.damageNumbers) {
      this._fxPos.copy(balloon.mesh.position);
      this._fxPos.y += (balloon.effectiveRadius || 0.5) + 0.35;   // 抬到头顶，别糊在模型里
      this.damageNumbers.spawn(this._fxPos, dealt, {
        key: balloon, kill: killed, elite: !!balloon.isElite, poison: !!opts?.poison,
      });
    }
    if (!killed && !opts?.silent) {
      this.audio?.playHit();
      this._pulseHaptic('HIT');
    }
  }

  // 击杀反馈：按敌种换音色 + 连击升调 + 中/重震动。
  _killFeedback(balloon) {
    this._bumpCombo();
    const kind = this._killSoundKind(balloon);
    this.audio?.playKill(kind, this.combo);
    const heavy = kind === 'elite' || kind === 'boss' || kind === 'dragon';
    this._pulseHaptic(heavy ? 'ELITE' : 'KILL');
    // 档2：击杀碎片 —— 颜色取该敌种 tint（没有就兜底）；精英/Boss/龙多爆几片
    if (this.fx && balloon.mesh) {
      const t = balloon.type;
      this.fx.debrisBurst(balloon.mesh.position, t && t.tint != null ? t.tint : null,
        heavy ? FX.DEBRIS.ELITE_MUL : 1);
    }
  }

  // ====== 连杀加速（第四十二修）======

  // 只统计**子弹**击杀：技能/如来神掌/激光剑/爆炸杀的一律不计数（也不打断连杀）。
  // 满 RAPID_FIRE.KILLS → 射速 ×MULT 持续 SECONDS 秒 + 奖励音；随后从 0 重新起算。
  // 第四十三修：加速期间最多只能再攒 BOOST_CARRY_MAX 个（规则见 game/rapidFire.js 的 advanceStreak）。
  /** 连杀加速是默认角色（疾风）的专属被动；蜂群/爆炮手不参与。 */
  _rapidFireAllowed() {
    const key = this.player?.characterKey;
    return !key || key === 'rapid';
  }

  _bulletKill(balloon) {
    if (!RAPID_FIRE.ENABLED || !this._rapidFireAllowed()) return;
    const boosting = this._gameTime < this._rapidUntil;
    const { next, triggered } = advanceStreak(this._bulletStreak, boosting, RAPID_FIRE);
    this._bulletStreak = next;
    this._bulletStreakAt = this._gameTime;      // 还有子弹击杀 → 断连计时重置
    if (!triggered) return;
    this._rapidUntil = this._gameTime + RAPID_FIRE.SECONDS;
    this._setRapidMul(1 / RAPID_FIRE.MULT);
    this.audio?.playRapidFire();                // 奖励音（配方见 src/vr/audio.js）
    this.log('连杀 ' + RAPID_FIRE.KILLS + ' 达成：射速 +' + Math.round((RAPID_FIRE.MULT - 1) * 100)
             + '%，持续 ' + RAPID_FIRE.SECONDS + 's');
  }

  // 每帧：连杀超时清零 + 加速到期还原射速（幂等，用 _rapidMul 记住当前生效值）
  _tickRapidFire() {
    if (!RAPID_FIRE.ENABLED || !this._rapidFireAllowed()) {
      if (this._bulletStreak !== 0) this._bulletStreak = 0;
      if (this._rapidUntil !== 0) this._rapidUntil = 0;
      this._setRapidMul(1);
      return;
    }
    if (this._bulletStreak > 0 && this._gameTime - this._bulletStreakAt > RAPID_FIRE.GAP) this._bulletStreak = 0;
    this._setRapidMul(this._gameTime < this._rapidUntil ? 1 / RAPID_FIRE.MULT : 1);
  }

  // 改写真实节流源（input._gunCooldown = _baseGunCooldown × mul；mul<1 = 更快）
  _setRapidMul(mul) {
    if (this._rapidMul === mul) return;
    this._rapidMul = mul;
    this.input?.setFireRateMul(mul);
  }

  // ====== 如来神掌分帧结算（第四十二修）======
  //   一掌罩住几十只怪时，原来在**同一帧**给每只怪各跑一遍 takeDamage + 伤害数字
  //   （canvas 重绘 + CanvasTexture 上传）+ 击杀碎片/音效 → 单帧几十次纹理上传，
  //   在 PICO 上就是一次 GPU 尖峰，表现即「神掌一放就卡一下」。
  //   改为入队、每帧只结算 MAX_DAMAGE_PER_FRAME 个：数字照弹、击杀照结算，
  //   只是把几十只怪摊到 5~8 帧（≈0.1s）内 —— 肉眼看不出来。
  _drainBuddhaQueue() {
    const q = this._buddhaQueue;
    if (!q || !q.length) return;
    const limit = Math.max(1, BUDDHA.MAX_DAMAGE_PER_FRAME | 0);
    for (let n = 0; n < limit && q.length; n++) {
      const it = q.shift();
      const b = it.b;
      // 排队期间可能已被别的伤害打死/移除（连锁击杀、Boss 收尾）→ 直接丢弃
      if (!b || !b.alive || !this.balloons.list.includes(b)) continue;
      const stuck = b.takeDamage(it.dmg);
      this._damageFeedback(b, stuck);
      if (stuck) this._onKilled(b);
    }
  }

  // 敌人 → 击杀音色键（取值见 audio.js 的 _killVoice switch）。
  _killSoundKind(b) {
    if (!b) return 'basic';
    if (b.isBoss) return 'boss';
    if (b.isDragonPart) return 'dragon';
    if (b.isElite) return 'elite';
    return (b.type && b.type.id) || b.behavior || 'basic';
  }

  // 连击：COMBO.WINDOW 秒内的连续击杀累加；断连后从 1 重新起算。
  _bumpCombo() {
    if (this._gameTime <= this._comboUntil) this.combo = Math.min(HIT_FEEDBACK.COMBO.MAX, this.combo + 1);
    else this.combo = 1;
    if (this.combo > (this._maxCombo || 0)) this._maxCombo = this.combo;
    this._comboUntil = this._gameTime + HIT_FEEDBACK.COMBO.WINDOW;
  }

  // 手柄震动：按档位节流（同一档 MIN_GAP 秒内只震一次）；受伤双手一起震。
  _pulseHaptic(channel) {
    const H = HIT_FEEDBACK.HAPTIC;
    if (!H.ENABLED || !this.input || typeof this.input.pulseHand !== 'function') return;
    const p = H[channel];
    if (!p) return;
    if (this._gameTime - (this._hapticAt[channel] ?? -99) < H.MIN_GAP) return;
    this._hapticAt[channel] = this._gameTime;
    if (channel === 'HURT') this.input.pulseBothHands && this.input.pulseBothHands(p.intensity, p.duration);
    else this.input.pulseHand('right', p.intensity, p.duration);
  }

  _doBuddha() {
    // 技能统一计费：能量不足则不放（不进冷却，可立即重试）
    if (this.score < this.player.skillCost) { this.log(`能量不足（需${this.player.skillCost}）`); return false; }
    this.score -= this.player.skillCost;
    this.hud.setScore(this.score);
    this.log('如来神掌！');
    this.audio?.playVoice('music/如来神掌.wav'); // 释放瞬间播「如来神掌」音效
    // 伤害不再瞬间全屏秒杀：改为随特效「变化(grow)/运动(move)」阶段实时结算（见 _updateBuddhaFx）
    this._buddhaHit = new Set(); // 本次神掌已命中的气球，避免被重复结算
    // 视觉：如来神掌从 START_POS 出现 → 放大 → 沿 +Z 横扫 → 停顿 → 消失
    this._buddhaFx?.dispose();
    this._buddhaFx = new BuddhaFx(this.world.scene).start(this.world.camera);
    this._palmWindStarted = false;   // 新一次神掌：等本次横扫结束后再开启掌风弹
    return true;
  }

  /** 第八十四修 · 收掌 → 5 秒掌风弹窗口。只在新一次神掌的 pause 第一次出现时调用。 */
  _startPalmWind() {
    if (this._palmWindStarted) return;
    this._palmWindStarted = true;
    const cfg = BUDDHA.PALM_WIND || {};
    if (!cfg.ENABLED) return;
    const sec = Math.max(0, Number(cfg.DURATION) || 0);
    if (sec <= 0) return;
    this._palmWindUntil = this._gameTime + sec;
    this._palmWindTotal = sec;
    this.audio?.playPalmWindStart?.();
    this.log(`[神掌] 掌风弹 ${sec}s：子弹伤害 ×${cfg.DAMAGE_MUL || 1}，穿透 ${cfg.PIERCE || 0}`);
  }

  /** 每帧检查掌风弹到期；时间轴与主循环共用 _gameTime。 */
  _tickPalmWind() {
    if (this._palmWindUntil <= 0 || this._gameTime < this._palmWindUntil) return;
    this._palmWindUntil = 0;
    this._palmWindTotal = 0;
    this.audio?.playPalmWindEnd?.();
  }

  // ====== 第三关三技能 ======
  // 选卡：仅「装备」技能（激光剑→左手柄出现），不立即释放（释放由左手柄 grip 触发 _triggerSelectedSkill）
  /** 第六十九修：客户端真正实现过的技能 id（商店据此过滤内容包里的新卡）。 */
  _supportsSkill(id) { return supportsSkill(id); }

  _applySkillCard(id) {
    // 第六十九修：技能卡来自 content 包，可能比客户端代码新。未知 id 若直接写进 selectedSkill，
    //   会变成「装备成功但按了没反应」。这里统一收口：未知 id 不落库，保留当前可用技能；
    //   当前技能也无效则回落到默认能量散射。
    let use = id;
    if (!supportsSkill(use)) {
      const keep = supportsSkill(this.selectedSkill) ? this.selectedSkill : 'scatter';
      this.log(`[技能] 未知技能 id=${id}（客户端未实现，需更新 APK）：保留 ${keep}`);
      use = keep;
    }
    this.selectedSkill = use;
    this.skillCooldown = 0;                 // 装备即就绪，可立即按手柄释放
    if (use === 'buddha') this.player.buddhaUnlocked = true;
    this.leftSword?.setEquipped(use === 'lightsaber'); // 选到激光剑→左手出现；选别的→隐藏
    const label = use === 'buddha' ? '如来神掌' : use === 'lightsaber' ? '激光剑' : use === 'scatterburst' ? '散射强化' : use === 'blackhole' ? '黑洞' : use;
    this.log(`已装备：${label}（按左手柄 grip 释放）`);
  }

  // 左手柄 grip/桌面 F 触发：按当前装备技能分发释放，统一冷却由 this.skillCooldown 负责
  _triggerSelectedSkill() {
    let cast = false;
    switch (this.selectedSkill) {
      case 'buddha':
        if (!this.player.buddhaUnlocked) { this.log('如来神掌尚未解锁'); return false; } // 还原原语义：未解锁不放（return 不进入冷却）
        if (!this._doBuddha()) return false; // 能量不足 → 不进入冷却，可立即重试
        cast = true;
        break;
      case 'lightsaber':
        if (!this._castLaserSword()) return false; // 能量不足 → 不进入冷却，可立即重试
        cast = true;
        break;
      case 'scatterburst':
        if (!this._castScatterBurst()) return false; // 能量不足 → 不进入冷却，可立即重试
        cast = true;
        break;
      case 'blackhole':
        if (!this._castBlackHole()) return false; // 能量不足 → 不进入冷却，可立即重试
        cast = true;
        break;
      case 'scatter':
        if (!this._castScatter()) return false; // 能量不足 → 不进入冷却，可立即重试
        cast = true;
        break;
      default:
        // 第六十九修：不认识的技能（内容包比 APK 新）→ 回落默认能量散射。
        //   绝不能「什么都不放却进冷却」。
        this.log(`[技能] 未知技能 id=${this.selectedSkill}：回落能量散射`);
        this.selectedSkill = 'scatter';
        if (!this._castScatter()) return false;
        cast = true;
        break;
    }
    if (!cast) return false;
    // 第六十二修：记「本关放了几次技能」。走到这里 = 释放成功（失败的在上面就 return 了）。
    //   教学关精英用它判断「玩家已经读懂提示 → 可以放它走了」（见 content/tutorial.js 的 eliteHoldOver）。
    this._skillCasts = (this._skillCasts || 0) + 1;
    this._runSkillCasts = (this._runSkillCasts || 0) + 1;
    this.skillCooldown = (typeof this._skillCdTotal === 'function')
      ? this._skillCdTotal()
      : Math.max(SHOP.CD_FLOOR, SCATTER.COOLDOWN);
    return true;
  }
  _skillCdTotal() {
    // 第六十修：教学关精英段 —— 散射技能无消耗、无冷却（见 content/tutorial.js 的 ELITE 段）
    if (this._tutorialFreeSkill) return 0;
    if (!this.selectedSkill) return 0;   // 没装备技能 → 无冷却（历史口径）
    // 第五十五修：商店关「技能冷却-」叠加生效（只影响总冷却口径；下限 SHOP.CD_FLOOR 防 0 冷却）
    // 第六十九修：无论 id 认不认识、常量是否缺失，都返回有限正数 —— 冷却绝不允许是 undefined / NaN。
    const _down = Number.isFinite(this.player.skillCdDown) ? this.player.skillCdDown : 0;
    const cd = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(SHOP.CD_FLOOR, n - _down) : SHOP.CD_FLOOR;
    };
    if (this.selectedSkill === 'buddha') return cd(BUDDHA.COOLDOWN);
    if (this.selectedSkill === 'lightsaber') return cd(LASER_SWORD.COOLDOWN);
    if (this.selectedSkill === 'scatterburst') return cd(SCATTER_BURST.COOLDOWN);
    if (this.selectedSkill === 'blackhole') return cd(BLACK_HOLE.COOLDOWN);
    return cd(SCATTER.COOLDOWN);
  }

  // 能量散射（默认技能）：消耗 player.skillCost 能量，从枪口喷出 COUNT 弹头，轴向 DIST 米铺成半径 RADIUS 圆盘
  _castScatter() {
    // 第六十修：教学关精英段免费 —— 不扣分、不进冷却（player.skillCost 本身不动，教程结束自动恢复收费）
    if (!this._tutorialFreeSkill) {
      if (this.score < this.player.skillCost) { this.log(`能量不足（需${this.player.skillCost}）`); return false; }
      this.score -= this.player.skillCost;
      this.hud.setScore(this.score);
    }
    const muzzle = new THREE.Vector3();
    const dir = new THREE.Vector3();
    this.input.getMuzzle(muzzle, dir); // 右手柄位姿（无则回退相机）
    // 以瞄准方向 dir 为轴建正交基：right ⊥ dir（水平），up = right × dir
    const right = new THREE.Vector3().crossVectors(dir, _WORLD_UP).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    // 现场：默认一发散射打不死精英 → 基础伤害 ×3（SCATTER.DAMAGE_MUL，可调）
    const dmg = (SCATTER.DAMAGE > 0 ? SCATTER.DAMAGE : this.player.atk)
      * (SCATTER.DAMAGE_MUL || 1) * this.player.skillDamageMul;
    for (let i = 0; i < SCATTER.COUNT; i++) {
      const theta = Math.random() * Math.PI * 2;
      const r = SCATTER.SPREAD_DISC ? Math.sqrt(Math.random()) * SCATTER.RADIUS : SCATTER.RADIUS; // 实心=面积均匀，环=等半径
      // 9 米轴向处铺成半径 R 圆盘：bdir = dir*DIST + (right*cosθ + up*sinθ)*r
      const bx = dir.x * SCATTER.DIST + (right.x * Math.cos(theta) + up.x * Math.sin(theta)) * r;
      const by = dir.y * SCATTER.DIST + (right.y * Math.cos(theta) + up.y * Math.sin(theta)) * r;
      const bz = dir.z * SCATTER.DIST + (right.z * Math.cos(theta) + up.z * Math.sin(theta)) * r;
      const bdir = new THREE.Vector3(bx, by, bz).normalize();
      this.bullets.spawn(muzzle, bdir, dmg);
    }
    this.log(this._tutorialFreeSkill ? `能量散射！教学免费，喷出${SCATTER.COUNT}弹头` : `能量散射！消耗${this.player.skillCost}能量，喷出${SCATTER.COUNT}弹头`);
    return true;
  }

  // 散射强化（旧第3关技能卡）：第六十七修起卡已换成黑洞 → 本方法不再可达；保留常量/实现供子弹池测试与历史口径引用
  _castScatterBurst() {
    if (this.score < this.player.skillCost) { this.log(`能量不足（需${this.player.skillCost}）`); return false; }
    this.score -= this.player.skillCost;
    this.hud.setScore(this.score);
    const muzzle = new THREE.Vector3();
    const dir = new THREE.Vector3();
    this.input.getMuzzle(muzzle, dir); // 右手柄位姿（无则回退相机）
    const right = new THREE.Vector3().crossVectors(dir, _WORLD_UP).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    const dmg = SCATTER_BURST.DAMAGE * this.player.skillDamageMul;
    const n = SCATTER_BURST.COUNT;
    for (let i = 0; i < n; i++) {
      const theta = Math.random() * Math.PI * 2;
      const r = SCATTER_BURST.SPREAD_DISC ? Math.sqrt(Math.random()) * SCATTER_BURST.RADIUS : SCATTER_BURST.RADIUS;
      const bx = dir.x * SCATTER_BURST.DIST + (right.x * Math.cos(theta) + up.x * Math.sin(theta)) * r;
      const by = dir.y * SCATTER_BURST.DIST + (right.y * Math.cos(theta) + up.y * Math.sin(theta)) * r;
      const bz = dir.z * SCATTER_BURST.DIST + (right.z * Math.cos(theta) + up.z * Math.sin(theta)) * r;
      const bdir = new THREE.Vector3(bx, by, bz).normalize();
      this.bullets.spawn(muzzle, bdir, dmg);
    }
    this.log(`散射强化！消耗${this.player.skillCost}能量，喷出${n}弹头`);
    this.selectedSkill = 'scatter'; // 一次性技能：用后回落到默认能量散射（避免空技能）
    return true;
  }

  // ====== 第六十七修 · 黑洞（第 3 关第三张技能卡）======
  // 释放：消耗 skillCost 能量，在「头部朝向」正前方 15m 生成漩涡；洞心位置/朝向在释放瞬间锁定。
  _castBlackHole() {
    if (this.score < this.player.skillCost) { this.log(`能量不足（需${this.player.skillCost}）`); return false; }
    this.score -= this.player.skillCost;
    this.hud.setScore(this.score);
    this._startBlackHole();
    this.audio?.playBlackHole?.();
    this.log(`黑洞！消耗${this.player.skillCost}能量，吸附 ${BLACK_HOLE.DURATION} 秒（每秒 ${BLACK_HOLE.DPS} 伤害）`);
    return true;
  }

  _startBlackHole() {
    this._endBlackHole();
    const cam = this.world.camera;
    const head = cam.getWorldPosition(new THREE.Vector3());
    const dir = cam.getWorldDirection(new THREE.Vector3());
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) {
      // 极端情况：玩家正抬头/低头看 → 水平前向退化。用相机「上方向」的水平投影取偏航，避免固定回 -Z。
      const q = cam.getWorldQuaternion(new THREE.Quaternion());
      dir.set(0, 1, 0).applyQuaternion(q);
      dir.y = 0;
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    }
    dir.normalize();
    this._bhCenter.set(
      head.x + dir.x * BLACK_HOLE.DIST,
      BLACK_HOLE.CENTER_Y,
      head.z + dir.z * BLACK_HOLE.DIST,
    );
    // 吸附环整体往玩家方向前移一点点，贴在漩涡正面：
    //   环本身与黑洞同向、竖直立在与地面垂直的平面上，所有怪围成黑洞外圈；
    //   0.55m 的前移只用于避开黑色盘面的深度遮挡，不再把整圈推到远处。
    this._bhFrontDir = new THREE.Vector3(head.x - this._bhCenter.x, 0, head.z - this._bhCenter.z);
    if (this._bhFrontDir.lengthSq() < 1e-6) this._bhFrontDir.set(0, 0, 1);
    this._bhFrontDir.normalize();
    this._bhRight = _bhRightAxis.crossVectors(_WORLD_UP, this._bhFrontDir).normalize().clone();
    this._bhAbsorbCenter = this._bhCenter.clone().addScaledVector(this._bhFrontDir, BLACK_HOLE.RING_FRONT || 0);
    this._bhActive = true;
    this._bhT = 0;
    this._bhDamageAcc = 0;
    this._bhTargets = new Set();
    this._bhSlotSeq = 0;
    this._bhSlotBase = null;   // 第六十八修：第一只被吸的怪决定环的起始方位
    this._bhFx = new BlackHoleFx(this.world.scene, this._bhCenter, head);
  }

  /** 每帧：捕获新怪 → 接管位置 → 伤害节拍 → 驱动视觉。必须在 balloons/waves 之后调用。 */
  _updateBlackHole(dt) {
    if (!this._bhActive) return;
    this._bhT += dt;
    if (this._bhT >= BLACK_HOLE.DURATION) { this._endBlackHole(); return; }

    const list = this.balloons ? this.balloons.list : null;
    if (list) {
      // 先完成本帧捕获，再统一排布：新怪加入后，圆饼会以当前存活数量重新紧凑铺开。
      for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i];
        if (!b || !b.alive || b._bhCaptured || isBlackHoleImmune(b)) continue;
        this._bhCapture(b);
      }

      // 只有小怪参与圆饼填充；精英仍走外圈振荡（向前挪一点又被拉回去）。
      const basics = [];
      for (const b of this._bhTargets) {
        if (b && b.alive && b._bhCaptured && !b._bhElite) basics.push(b);
      }
      let basicSlot = 0;
      for (const b of this._bhTargets) {
        if (!b || !b.alive || !b._bhCaptured) continue;
        this._bhMoveTo(b, dt, b._bhElite ? -1 : basicSlot++, basics.length);
      }
    }

    this._bhDamageAcc += dt;
    while (this._bhDamageAcc >= BLACK_HOLE.TICK) {
      this._bhDamageAcc -= BLACK_HOLE.TICK;
      this._bhDamageTick();
    }
    this._bhFx?.update(dt);
  }

  _bhCapture(b) {
    const p = b.mesh.position;
    b._bhCaptured = true;
    b._bhPrevFrozen = !!b.moveFrozen;
    b.moveFrozen = true;
    b._bhElapsed = 0;
    b._bhDur = blackHolePullDuration(b);
    b._bhElite = !!(b.isElite || b.isClimax);
    // 第六十八修：所有怪不再沿「各自的来向」排队 —— 那会挤成一条线。
    //   以第一只的来向为基准，之后按黄金角错开，整体围成小圈。
    if (!Number.isFinite(this._bhSlotBase)) {
      this._bhSlotBase = Math.atan2(p.z - this._bhCenter.z, p.x - this._bhCenter.x);
    }
    if (!Number.isFinite(this._bhSlotSeq)) this._bhSlotSeq = 0;
    b._bhAngle = blackHoleSlotAngle(this._bhSlotSeq++, this._bhSlotBase);
    b._bhFrom = p.clone();
    b._bhArc = segmentCrossesCarpet(p, this._bhCenter, b.effectiveRadius || 0);
    b._bhCtrl = b._bhArc
      ? new THREE.Vector3(
        (p.x + this._bhCenter.x) * 0.5,
        Math.max(p.y, this._bhCenter.y) + BLACK_HOLE.ARC_HEIGHT,
        (p.z + this._bhCenter.z) * 0.5,
      )
      : null;
    b._showChargeOrb?.(false);   // 忍者蓄力球：被吸时收起，避免光球跟着飞
    this._bhTargets.add(b);
  }

  _bhMoveTo(b, dt, slotIndex = -1, slotCount = 1) {
    b._bhElapsed = (b._bhElapsed || 0) + dt;
    const dur = Math.max(0.01, b._bhDur || BLACK_HOLE.PULL_BASIC);
    const u = Math.min(1, b._bhElapsed / dur);
    const s = u * u * (3 - 2 * u);           // smoothstep：起步慢、末端快（吸力感）
    const hold = Math.max(0, b._bhElapsed - dur);
    const ring = this._bhAbsorbCenter || this._bhCenter;
    // 第六十九修 · 现场口径：吸附圈要和黑洞一样竖直，怪物围着黑洞的圆排布。
    //   旧实现用 (cos, 0, sin) 铺在水平面上，远看像一圈怪躺在地上；现在改用
    //   黑洞平面的 right / world-up 两个轴，圆环严格竖直、正对释放瞬间的玩家。
    const right = (this._bhRight && this._bhRight.lengthSq() > 1e-8)
      ? this._bhRight
      : _bhRightAxis.crossVectors(_WORLD_UP, this._bhFrontDir || _WORLD_UP).normalize();
    if (b._bhElite) {
      const rimR = blackHoleEliteRadius(hold);
      const ang = b._bhAngle + 0.35 * hold;
      _bhRim.copy(ring)
        .addScaledVector(right, Math.cos(ang) * rimR)
        .addScaledVector(_WORLD_UP, Math.sin(ang) * rimR);
    } else {
      // 第七十四修：小怪不再固定在洞缘，而是按向日葵排布填满整个竖直圆面（圆饼）。
      const slot = blackHoleDiscSlot(slotIndex, slotCount);
      _bhRim.copy(ring)
        .addScaledVector(right, slot.x)
        .addScaledVector(_WORLD_UP, slot.y);
    }
    if (b._bhCtrl) {
      const iu = 1 - s;
      _bhPos.set(0, 0, 0)
        .addScaledVector(b._bhFrom, iu * iu)
        .addScaledVector(b._bhCtrl, 2 * iu * s)
        .addScaledVector(_bhRim, s * s);
    } else {
      _bhPos.lerpVectors(b._bhFrom, _bhRim, s);
    }
    b.mesh.position.copy(_bhPos);
  }

  /** 伤害节拍：只有距洞心 DAMAGE_RADIUS 内的怪受伤（Boss/无敌/受控 Boss 实体免疫）。 */
  _bhDamageTick() {
    if (!this.balloons) return;
    const dmg = BLACK_HOLE.DPS * BLACK_HOLE.TICK * (this.player.skillDamageMul || 1);
    const r2 = BLACK_HOLE.DAMAGE_RADIUS * BLACK_HOLE.DAMAGE_RADIUS;
    const damageCenter = this._bhAbsorbCenter || this._bhCenter;
    const list = this.balloons.list.slice();
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (!b || !b.alive || !this.balloons.list.includes(b)) continue;
      if (isBlackHoleImmune(b)) continue;
      if (b.mesh.position.distanceToSquared(damageCenter) > r2) continue;
      const killed = b.takeDamage(dmg, true);
      if (this.damageNumbers) {
        _bhDmgPos.copy(b.mesh.position);
        _bhDmgPos.y += (b.effectiveRadius || 0.5) + 0.35;
        this.damageNumbers.spawn(_bhDmgPos, b._lastDamage != null ? b._lastDamage : dmg, {
          key: b, kill: killed, elite: !!b.isElite,
        });
      }
      if (killed) this._onKilled(b);
    }
  }

  /** 结束/切关/重开：清标 → 恢复原 moveFrozen → 原地放回 → 销毁视觉。 */
  _endBlackHole() {
    if (this._bhTargets) {
      for (const b of this._bhTargets) {
        if (!b) continue;
        b._bhCaptured = false;
        b.moveFrozen = !!b._bhPrevFrozen;
        b._bhFrom = null;
        b._bhCtrl = null;
        b._bhElapsed = 0;
        b._bhArc = false;
      }
      this._bhTargets.clear();
      this._bhTargets = null;
    }
    this._bhActive = false;
    this._bhT = 0;
    this._bhDamageAcc = 0;
    this._bhSlotSeq = 0;
    this._bhSlotBase = null;
    this._bhFx?.dispose();
    this._bhFx = null;
  }

  // 激光剑：消耗 player.skillCost 能量，激活左手柄「5秒伤害状态」。期间左手自由挥动，剑刃线段扫过怪物即扣血，
  // 每只怪 1 秒内只受一次（限频在 _updateSwordMelee 内）。伤害穿透脸谱95%减伤。
  _castLaserSword() {
    // 已激活时拒绝重复释放：否则 setActive(true) 会把放大动画重置回「短剑」（表现为砍一刀就缩回、还白扣能量）
    if (this.leftSword.active) { this.log('激光剑已激活'); return false; }
    if (this.score < this.player.skillCost) { this.log(`能量不足（需${this.player.skillCost}）`); return false; }
    this.score -= this.player.skillCost;
    this.hud.setScore(this.score);
    this.leftSword.setActive(true);
    this._swordReadyMarked = false;
    // 兜底结束时刻：展开动画(EXTEND_TIME)正常完成时，会被「完全展开」那一刻的精确计时（_gameTime + DURATION）覆盖
    const _grow = LASER_SWORD.EXTEND_TIME;
    this._swordUntil = this._gameTime + _grow + LASER_SWORD.DURATION;
    this.log(`激光剑激活！展开后 ${LASER_SWORD.DURATION} 秒内挥剑伤害`);
    return true;
  }

  // 激光剑每帧近战命中：剑刃线段(hilt→tip) 扫过怪物命中球即扣血，每只怪 1 秒内只受一次。
  _updateSwordMelee() {
    this.leftSword.getBlade(this._hilt, this._tip);
    const now = this._gameTime;
    // 连锁击杀可能同时移除 Boss/分身或召唤者/小怪，遍历快照保持索引稳定。
    const list = this.balloons.list.slice();
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (!b.alive || !this.balloons.list.includes(b)) continue;
      const rr = b.hitRadius; // 含立绘 0.6 系数/薄板近似，球体足够
      if (_pointSegDistSq(b.mesh.position, this._hilt, this._tip) > rr * rr) continue; // 剑刃未扫到
      if ((b._swordCdUntil || 0) > now) continue; // 同一只怪在 HIT_INTERVAL 内只受一次（剑刃持续扫到则可高频多次扣血）
      const killed = b.takeDamage(LASER_SWORD.DAMAGE * this.player.skillDamageMul, true); // ignoreReduction=true 穿透减伤（实际伤害 = DAMAGE × player.skillDamageMul）
      b._swordCdUntil = now + LASER_SWORD.HIT_INTERVAL; // 调小 HIT_INTERVAL = 更高 DPS（修复：原 1.0s 导致单次挥击只命中一次，#1）
      this._damageFeedback(b, killed);   // 第四十修：伤害数字 + 命中音（击毙音由 _onKilled 统一发）
      if (killed) this._onKilled(b);
    }
  }

  _updateBuddhaFx(dt) {
    if (!this._buddhaFx) return;
    const fx = this._buddhaFx;
    const wasDamaging = fx.isDamaging;
    const finished = fx.update(dt);
    // 第八十四修：grow/move 结束、进入 pause 的这一刻 = 神掌横扫完成 → 开始 5 秒掌风弹。
    // 不能从按下技能就开始算，否则 1.4 秒起手会吃掉强化窗口。
    if (wasDamaging && !fx.isDamaging) this._startPalmWind();
    // 仅在「变化/运动」阶段结算伤害：掌图作横扫墙，只命中其当前位置附近命中盒内的敌人（不再全屏秒杀）
    if (fx.isDamaging) {
      const s = fx.scale;                                   // 当前缩放倍数
      const halfW = BUDDHA.PLANE_WIDTH  * s * 0.5 * BUDDHA.HIT_MARGIN_XY; // 命中盒 X 半宽
      const halfH = BUDDHA.PLANE_HEIGHT * s * 0.5 * BUDDHA.HIT_MARGIN_XY; // 命中盒 Y 半高
      const zBand = BUDDHA.HIT_Z_BAND;                      // 命中盒 Z 半厚
      const px = fx.position.x, py = fx.position.y, pz = fx.position.z;
      // 击杀回调会删除多个实体；快照中的已移除对象也不能继续受伤/计分。
      const list = this.balloons.list.slice();
      for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i];
        if (!b.alive || !this.balloons.list.includes(b)) continue;
        if (this._buddhaHit.has(b)) continue;               // 本轮神掌已结算过，跳过
        const p = b.mesh.position;
        if (Math.abs(p.x - px) < halfW && Math.abs(p.y - py) < halfH && Math.abs(p.z - pz) < zBand) {
          this._buddhaHit.add(b);
          // 第四十二修：不在这里当场结算 —— 一掌罩住几十只怪时，同帧几十次 takeDamage +
          //   伤害数字纹理上传 + 击杀碎片/音效 = 一次 GPU 尖峰（「神掌一放就卡一下」）。
          //   入队交给 _drainBuddhaQueue 每帧定量消费（数字照弹、击杀照结算，只是摊到 5~8 帧）。
          this._buddhaQueue.push({ b, dmg: buddhaSweepDamage(b, this.player.skillDamageMul, BUDDHA) });
        }
      }
    }
    this._drainBuddhaQueue();   // 本帧入队的量按上限消费（剩下的交给 _update 的下一帧兜底）
    if (finished) this._buddhaFx = null;
  }

  // ====== 爆炸系统 ======

  // 检查气球是否进入4×8区域，进入则自爆并伤害飞船
  _checkExplosions() {
    for (let i = this.balloons.list.length - 1; i >= 0; i--) {
      const balloon = this.balloons.list[i];
      if (balloon.controlled) continue; // 龙 Boss 气球：纯靶子，不进入4×8自爆、不伤飞船
      if (balloon._bhCaptured) continue; // 第六十七修：被黑洞吸着的怪不结算自爆（过顶弧线会掠过飞毯）
      const pos = balloon.mesh.position;
      // 红阶段旗子"砸落"途中：仍高于 RED_FLAG_HIT_Y 时不结算命中。
      // 原判定只看 |x|/|z|（忽略高度），旗子在 23m 高空进入区域就爆 → 看不到"砸落"过程。
      if (balloon._flagSlam && pos.y > FACE_BOSS.RED_FLAG_HIT_Y) continue;
      // 4×8区域 = |x|<=BOUND_X(2), |z|<=BOUND_Z(4)；气球边缘触及区域边界即触发
      const inArea = Math.abs(pos.x) <= (MOVE.BOUND_X + balloon.effectiveRadius)
                  && Math.abs(pos.z) <= (MOVE.BOUND_Z + balloon.effectiveRadius);
      if (inArea) {
        this._spawnExplosionFx(balloon.mesh.position, balloon.effectiveRadius);
        // 第五十六修：现场「到飞毯边缘爆炸时增加爆炸特效」——除球形冲击外再补碎片 + 火花，
        //   两者都是预分配实例池（fx.js），只多几次 setMatrixAt，不新增 draw call。
        this.fx?.debrisBurst(balloon.mesh.position, EXPLOSION.COLOR, 1.8);
        this.fx?.spark(balloon.mesh.position, 0xffb066);
        this.balloons.remove(balloon);
        this.audio?.playPop();
        // 气球入侵飞船区域即造成伤害，不依赖玩家与爆炸点的距离；伤害按该气球自身自爆值
        const dead = this.player.takeDamage(balloon.isBoss ? 40 : (balloon.selfDamage ?? BALLOON.DAMAGE));
        this._pulseHaptic('HURT');   // 第四十修：被自爆气球炸到 → 双手重震
        if (dead) { this._restartLevel(); return true; }
      }
    }
    return false;
  }

  _spawnExplosionFx(position, radius) {
    const geo = new THREE.SphereGeometry(radius, 16, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: EXPLOSION.COLOR,
      transparent: true,
      opacity: EXPLOSION.START_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position);
    this.world.scene.add(mesh);
    this._explosions.push({ mesh, t: 0 });
  }

  /**
   * 爆炮手爆炸视觉：球壳半径严格等于 AoE 半径。
   *   · 线框球壳 + 普通混合，不用加色混合 ⇒ 不会糊成一块发白的「透镜」；
   *   · 50ms 节流：同一帧 1 主炮 + 6 微型火箭只留一个球壳，避免连续闪光；
   *   · 最终半径 = radius，所见即所得。
   */
  _spawnBlastFx(position, radius) {
    if (!(radius > 0)) return;
    if (this._gameTime - this._lastBlastFxAt < 0.05) return;
    this._lastBlastFxAt = this._gameTime;
    const geo = new THREE.SphereGeometry(1, 20, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: BLAST_FX.COLOR,
      transparent: true,
      opacity: BLAST_FX.OPACITY,
      wireframe: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position);
    mesh.rotation.set(this._gameTime * 0.7, this._gameTime * 1.1, this._gameTime * 0.4);
    mesh.scale.setScalar(Math.max(0.01, radius * BLAST_FX.START_SCALE));
    this.world.scene.add(mesh);
    this._blastFx.push({ mesh, radius, t: 0 });
  }

  _updateExplosions(dt) {
    for (let i = this._explosions.length - 1; i >= 0; i--) {
      const exp = this._explosions[i];
      exp.t += dt;
      const k = Math.min(1, exp.t / EXPLOSION.DURATION);
      exp.mesh.scale.setScalar(1 + k * EXPLOSION.MAX_SCALE);
      exp.mesh.material.opacity = EXPLOSION.START_OPACITY * (1 - k);
      if (k >= 1) {
        this.world.scene.remove(exp.mesh);
        exp.mesh.geometry.dispose();
        exp.mesh.material.dispose();
        this._explosions.splice(i, 1);
      }
    }
    for (let i = this._blastFx.length - 1; i >= 0; i--) {
      const fx = this._blastFx[i];
      fx.t += dt;
      const k = Math.min(1, fx.t / BLAST_FX.DURATION);
      const grow = 1 - Math.pow(1 - k, 3);
      const s = fx.radius * (BLAST_FX.START_SCALE + (1 - BLAST_FX.START_SCALE) * grow);
      fx.mesh.scale.setScalar(s);
      fx.mesh.material.opacity = BLAST_FX.OPACITY * Math.pow(1 - k, 1.4);
      if (k >= 1) {
        this.world.scene.remove(fx.mesh);
        fx.mesh.geometry.dispose();
        fx.mesh.material.dispose();
        this._blastFx.splice(i, 1);
      }
    }
  }

  _clearExplosions() {
    for (const exp of this._explosions) {
      this.world.scene.remove(exp.mesh);
      exp.mesh.geometry.dispose();
      exp.mesh.material.dispose();
    }
    this._explosions = [];
    for (const fx of this._blastFx) {
      this.world.scene.remove(fx.mesh);
      fx.mesh.geometry.dispose();
      fx.mesh.material.dispose();
    }
    this._blastFx = [];
    this._lastBlastFxAt = -99;
  }

  // ====== 快照与重开 ======

  _snapshotState() {
    const p = this.player;
    this._levelSnapshot = {
      atk: p.atk,
      shootCooldown: p.shootCooldown,
      multiShotChance: p.multiShotChance,
      shotCount: p.shotCount,
      fireRate: p.fireRate,
      skillCost: p.skillCost,
      skillDamageMul: p.skillDamageMul,
      regen: p.regen,
      maxHp: p.maxHp,
      hp: p.hp,
      buddhaUnlocked: p.buddhaUnlocked,
      buddhaCooldown: p.buddhaCooldown,
      buddhaTimer: p.buddhaTimer,
      shieldTime: p.shieldTime,
      score: this.score,
    };
  }

  _restoreSnapshot() {
    if (!this._levelSnapshot) return;
    const s = this._levelSnapshot;
    const p = this.player;
    p.atk = s.atk;
    p.shootCooldown = s.shootCooldown;
    p.multiShotChance = s.multiShotChance;
    p.shotCount = s.shotCount;
    p.fireRate = s.fireRate;
    p.skillCost = s.skillCost;
    p.skillDamageMul = s.skillDamageMul;
    p.regen = s.regen;
    p.maxHp = s.maxHp;
    p.hp = s.hp;
    p.buddhaUnlocked = s.buddhaUnlocked;
    p.buddhaCooldown = s.buddhaCooldown;
    p.buddhaTimer = s.buddhaTimer;
    p.shieldTime = s.shieldTime;
    this.score = Math.min(s.score, SCORE_CAP);
  }

  _restartLevel() {
    this.log('飞船坠毁，本关重开');
    // 死亡瞬间的攻击力（含此前所有 +50 与卡片加成）：必须在 _restoreSnapshot() 之前取，
    // 因为恢复快照会把 atk 打回「本关开始时的值」。
    const deathAtk = this.player.atk;
    this._restoreSnapshot();
    this.balloons.clear();
    this._basicVoiceTimer = 0; this._basicVoiceEl = null; // 重开：清零基础怪语音停顿计时
    this.projectiles.clear(); // 重开本关一并清投射物
    this.vignette.clear();
    this.bullets.clear();
    // 不调 _clearExplosions()：让死亡爆炸特效在 0.4s 内自然消亡
    this._clearRoundExtras();     // 第四十六修：清金点/治疗线/技能锁
    this.damageNumbers.clear();   // 死亡重开：清伤害数字，避免跨重开残留
    this.fx.clear();              // 档2：一并清掉特效残留
    this.midWarning?.hide();      // 第四十二修：重开收掉中场预警横幅
    this._bulletStreak = 0; this._rapidUntil = 0; this._setRapidMul(1);
    this._buddhaQueue.length = 0;
    this._respawnKeepPosition();   // 死亡重开：保留玩家水平位置（现实站在哪，游戏里就还在哪），只把高度拉回 0
    this._loadLevel(this.levelIndex); // 会重新拍快照（恢复后的状态）
    // 死亡重开：攻击力 +50（以「死亡前攻击力」为基准，而不是从 100 起算），立即生效并弹面前 2m 文字提示
    this.attackBonus += 50;                    // 累计加成仅作记录
    this.player.atk = deathAtk + 50;
    this.player.hp = this.player.maxHp;        // 死亡重开：飞毯血量恢复满（否则继承快照里本关开始时的非满血量）
    this._showAttackHint();
    this.hud.setScore(this.score);
    this.hud.setHp(this.player.hp, this.player.maxHp);
  }

  // 死亡重开文字提示：玩家面前 2m（相机视线方向）处悬浮文字「攻击力 +50」，2 秒后淡出消失。
  _clearAttackHint() {
    const h = this._attackHint;
    if (!h) return;
    if (this.world && this.world.scene) this.world.scene.remove(h.sprite);
    h.sprite.material.map?.dispose();
    h.sprite.material.dispose();
    this._attackHint = null;
  }

  _showAttackHint() {
    this._clearAttackHint();   // 先清旧提示，避免快速连续死亡叠加多个精灵
    if (!this.world || !this.world.camera || !this.world.scene) return;
    const cam = this.world.camera;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd); fwd.negate(); fwd.y = 0; // 相机朝向前方（水平）；与抽卡卡牌同款「面前」算法
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const pos = cam.getWorldPosition(new THREE.Vector3());
    pos.addScaledVector(fwd, 2.0);          // 面前 2m
    pos.y = Math.max(pos.y, 1.4);           // 抬到视线高度，便于看清
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const x = c.getContext('2d');
    x.fillStyle = 'rgba(0,0,0,0.55)'; x.fillRect(0, 0, 512, 256);
    x.strokeStyle = '#ffd166'; x.lineWidth = 6; x.strokeRect(8, 8, 496, 240);
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#ffd166'; x.font = 'bold 80px sans-serif';
    x.fillText('攻击力 +50', 256, 100);
    x.fillStyle = '#ffffff'; x.font = 'bold 44px sans-serif';
    x.fillText('当前 ' + this.player.atk, 256, 185);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(2.0, 1.0, 1);
    sp.position.copy(pos);
    sp.renderOrder = 1000;
    this.world.scene.add(sp);
    this._attackHint = { sprite: sp, t: 0, life: 2.0 };
  }

  // 每帧推进攻击力提示的淡出/移除（2 秒后消失）
  _updateAttackHint(dt) {
    const h = this._attackHint;
    if (!h) return;
    h.t += dt;
    const k = 1 - h.t / h.life;
    if (k <= 0) {
      this.world.scene.remove(h.sprite);
      h.sprite.material.map?.dispose();
      h.sprite.material.dispose();
      this._attackHint = null;
    } else {
      h.sprite.material.opacity = k;
    }
  }

  // ============================================================
  // 第四十六修 · 三层出怪的表现层（调度与光点在 waves.js / content/spawnDirector.js）
  // ============================================================

  /** 出怪编排的提示横幅：复用中场预警那套 Sprite（已支持任意文案），可一关多次调用 */
  _showBanner(text) {
    if (!text) return;
    this.midWarning?.show(text);
    this.log('[提示] ' + text);
  }

  /**
   * 第六十二修 · 教学关常驻提示板：把同一句横幅文案钉在**场地前上方**。
   *   现场「横幅 2s 太短来不及看清」⇒ 板上的字一直留着，直到下一块横幅把它换掉；
   *   只在教学关会被调用（TutorialRunner 是唯一调用方），切关 / 教学流程结束都会 hide。
   */
  _showTutorialHint(text) { this.tutorialHint?.show(text); }
  _hideTutorialHint() { this.tutorialHint?.hide(); }

  /**
   * 第四十九修 · 关卡标题卡：本关开局弹一次「第 N 关 · 场景名」。
   *   · 名字的唯一来源是 content/levels.js 的 lv.name（改名只动那里）；
   *   · 与精英来袭/中场预警**共用** midWarning 这个 Sprite（同一张 canvas），
   *     所以时间窗必须错开 —— 标题排在开局，精英最早 5s（见 LEVEL_TITLE 的注释）；
   *   · 机制关(3/9/15)开局有魔术师开场动画，默认 SKIP_MECHANIC=true 不叠，
   *     想强行显示把 LEVEL_TITLE.SKIP_MECHANIC 改 false 即可；
   *   · 第四十九修（续）：排期**在开场云雾窗内**（不再等雾散）——
   *     云雾关（默认）delay = LEVEL_TITLE.INTRO_DELAY，卡片在雾里淡入、雾散时仍在屏上
   *     （标题卡 depthTest:false + renderOrder 900，画在雾之上）；
   *     无云雾（CLOUD.ENABLED=false / 直接进关）退回 LEVEL_TITLE.DELAY（关卡开始后 0.8s）。
   * @param {number} [delay] 距「现在」多少秒后弹；缺省按 LEVEL_TITLE.DELAY
   */
  _queueLevelTitle(delay = LEVEL_TITLE.DELAY) {
    if (this._levelTitleDone) return;   // 本关弹过就不再排（机制关会排两次：兜底 + 语音结束）
    const lv = LEVELS[this.levelIndex];
    // 判据（总开关 / 机制关跳过 / 本关要有名字）抽成纯函数，见 levels.shouldShowLevelTitle（有单测）
    if (!shouldShowLevelTitle(lv, LEVEL_TITLE)) return;
    this._levelTitleText = levelTitleText(lv.n, LEVEL_TITLE.TEXT);
    this._levelTitleAt = Math.max(0, Number(delay) || 0);
  }

  /** 标题卡倒计时（_updatePlaying 每帧调，**含云雾窗**）：到点换 'title' 样式弹一次 */
  _tickLevelTitle(dt) {
    if (!this._levelTitleAt) return;
    this._levelTitleAt -= dt;
    if (this._levelTitleAt > 0) return;
    this._levelTitleAt = 0;
    const text = this._levelTitleText;
    this._levelTitleText = null;
    this._levelTitleDone = true;
    if (!text) return;
    this.midWarning?.show(text, 'title');
    this.log('[提示] ' + text);
  }

  // ====== 第五十修 / 第七十修 · Boss 宝箱（第 6 关脸谱箱 + 第 12 关龙族箱）======

  /** 本关该用哪份宝箱配置；非 Boss 关 / 第 18 关（直接结束本局）返回 null。 */
  _chestConfigForLevel() {
    const lv = LEVELS[this.levelIndex];
    if (!lv || !isBoss(lv)) return null;
    if (lv.n === MASK_CHEST.LEVEL && MASK_CHEST.ENABLED) return MASK_CHEST;
    if (lv.n === DRAGON_CHEST.LEVEL && DRAGON_CHEST.ENABLED) return DRAGON_CHEST;
    return null;
  }

  /** 现在该不该开宝箱：本关是配了宝箱的 Boss 关 && 本关还没开过 */
  _chestDue() {
    return !!this._chestConfigForLevel() && !this._chestDone;
  }

  /** 宝箱流程（2 秒横幅 + 计数 + 飞行）是否正在跑 —— 跑着时别去开抽卡 */
  _chestRunning() { return this._chestPending > 0 || !!(this._chest && this._chest.running); }

  /** 先弹 2 秒「宝箱出现，快攻击」，横幅收掉后再真正开计数窗口 */
  _startBossChest() {
    const cfg = this._chestConfigForLevel();
    if (!cfg) return;
    this._chestCfg = cfg;
    this._chestDone = true;                               // 先置位：本关只开一次
    this._ensureChest(cfg);                                // 第七十四修：横幅期间就建好并开始加载，保持隐身
    if (CHEST_BANNER.ENABLED && CHEST_BANNER.SECONDS > 0) {
      this._chestPending = CHEST_BANNER.SECONDS;
      this.midWarning?.show(CHEST_BANNER.TEXT, 'chest');
      this.log('宝箱预告：' + CHEST_BANNER.TEXT + '（' + CHEST_BANNER.SECONDS + 's 后开箱）');
    } else {
      this._chestPending = 0;
      this._beginChestWindow();
    }
  }

  /** 按配置复用/创建宝箱实例；创建即开始异步加载，但 group 始终隐身，等横幅结束再 start。 */
  _ensureChest(cfg) {
    if (!cfg) return null;
    if (this._chest && this._chest.cfg !== cfg) {
      this._chest.dispose();
      this._chest = null;
    }
    if (!this._chest) this._chest = new DragonChest(this.world.scene, cfg);
    return this._chest;
  }

  /** 横幅结束 → 立箱并开始计数（不同 Boss 复用同一个实例，换配置时销毁重建） */
  _beginChestWindow() {
    const cfg = this._chestCfg || this._chestConfigForLevel();
    if (!cfg) return;
    this._ensureChest(cfg);
    this._chest.start();
    if (cfg.KIND === 'fireRate') {
      this.log(cfg.NAME + '出现：' + cfg.WINDOW + ' 秒内用子弹打箱子，命中越多攻速加成越高');
    } else {
      this.log(cfg.NAME + '出现：' + cfg.WINDOW + ' 秒内越会打，攻击力加成越高');
    }
  }

  /**
   * 第五十一修：宝箱也要「吃子弹有反馈」（现场：「龙族宝箱受击没有反馈」）。
   *   宝箱不是气球、不进 _collide 的气球循环，所以这里单独判一次：命中 → 消费子弹 +
   *   火花 + 命中音 + 手柄轻震 + 箱体压一下 —— 和打别的小怪是同一套观感。
   *   只判**计数窗口内**：窗口一过箱子就化光点飞走了，不该再吸子弹。
   */
  _chestHitTest() {
    const c = this._chest;
    if (!c || !c.counting) return;
    const cfg = c.cfg || DRAGON_CHEST;
    const r = cfg.HIT_R;
    const center = c.group.position;
    const list = this.bullets.active;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (_pointSegDistSq(center, b.prevPos, b.pos) >= r * r) continue;
      this.bullets.release(b);
      c.addHit?.();
      c.punch();
      this.fx?.spark(b.pos, cfg.HIT_SPARK || DRAGON_CHEST.HIT_SPARK);
      this.audio?.playHit();
      this._pulseHaptic('HIT');
    }
  }

  /** 每帧推进宝箱；光点落地（'done'）→ 兑现奖励 → 下一帧自然放行通关抽卡 */
  _updateDragonChest(dt) {
    // 先走「宝箱出现」的 2 秒横幅；横幅没走完不计时、也不刷箱子
    if (this._chestPending > 0) {
      this._chestPending -= dt;
      if (this._chestPending > 0) return;
      this._chestPending = 0;
      this._beginChestWindow();
      return;
    }
    if (!this._chest || !this._chest.running) return;
    this._chestHitTest();
    if (this._chest.update(dt, this.world.camera) !== 'done') return;
    const cfg = this._chest.cfg || DRAGON_CHEST;
    const bonus = this._chest.bonus || 0;
    if (cfg.KIND === 'fireRate') {
      if (bonus > 0) {
        const before = this.player.fireRate || 0;
        applyFireRateSteps(this.player, bonus);
        const gained = Math.round((this.player.fireRate - before) * 100) / 100;
        this.log(cfg.NAME + '：攻速 +' + gained + ' 发/秒（' + before + ' → ' + this.player.fireRate
          + '，命中 ' + this._chest.hits + ' 发 → 数值 ' + (this._chest.value || 0).toFixed(1) + '）');
      } else {
        this.log(cfg.NAME + '：命中 ' + this._chest.hits + ' 发 → 数值 '
          + (this._chest.value || 0).toFixed(1) + '，不足 0.5 → 无攻速加成');
      }
    } else if (bonus > 0) {
      this.player.atk += bonus;
      this.log(cfg.NAME + '：攻击力 +' + bonus + '（窗口内 ' + this._chest.bullets + ' 发 → ' + this.player.atk + '）');
    } else {
      this.log(cfg.NAME + '：窗口内 0 发 → 无加成');
    }
    this._chest.hide();
  }

  /**
   * 第五十修：击败治疗术士的回血表现 —— 准星前方冒几个绿色加号飞向相机 + 一行「飞毯血量 +N」横幅。
   *   沉浸态里 DOM HUD 不可见，所以两者都必须挂在场景内（加号走 fx，横幅复用 midWarning 那个 Sprite）。
   *   回血量本身是敌种属性（content/enemies.js 的 heart.shipHealOnDeath），这里只管「让人看见」。
   */
  _healFeedback(heal) {
    if (!HEAL_ON_DEATH.ENABLED) return;
    const from = new THREE.Vector3();
    this.world.camera.getWorldPosition(from);
    const dir = new THREE.Vector3();
    this.world.camera.getWorldDirection(dir);
    dir.negate();                                  // 相机前向是 -Z（getWorldDirection 返回 +Z）
    const base = from.clone().addScaledVector(dir, HEAL_ON_DEATH.DIST);
    base.y = Math.max(0.6, base.y);                // 低头时别把加号放到地面以下
    const to = from.clone().addScaledVector(dir, HEAL_ON_DEATH.TO_DIST);
    const right = new THREE.Vector3().crossVectors(dir, _WORLD_UP).normalize();
    const n = Math.max(1, HEAL_ON_DEATH.PLUS_COUNT | 0);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const p = base.clone()
        .addScaledVector(right, Math.cos(a) * HEAL_ON_DEATH.SPREAD)
        .addScaledVector(_WORLD_UP, Math.sin(a) * HEAL_ON_DEATH.SPREAD);
      this.fx?.healPlus(p, to, HEAL_ON_DEATH.PLUS_COLOR);
    }
    if (HEAL_ON_DEATH.BANNER) this.midWarning?.show('飞毯血量 +' + Math.max(0, Math.round(heal)), 'heal');
  }

  /** 清掉本轮的引导金点 / 治疗线 / 技能锁 / 挂起标记（回菜单、重开、新一局、切关都调） */
  _clearRoundExtras() {
    for (const o of this._goldOrbs) {
      this.world.scene.remove(o.mesh);
      o.mesh.geometry.dispose();
      o.mesh.material.dispose();
    }
    this._goldOrbs.length = 0;
    this.fx?.healLinks([]);
    this._skillLocked = false;
    this._skillUnlockAt = 0;
    this._palmWindUntil = 0;       // 第八十四修：掌风弹不跨关 / 不跨局
    this._palmWindTotal = 0;
    this._palmWindStarted = false;
    this._poisonAccum = 0;         // 毒素计时不跨关/不跨局
    this._plagueBurstTimes.length = 0;
    this._midDraftPending = false;
    this._levelClearHeld = false;
    this._draftsThisLevel = 0;   // 第四十七修：一关一次（见 _enterCard / 通关分支）
    this._levelTitleAt = 0;       // 第四十九修：切关立即作废未弹的标题卡（新关卡会重新排一个）
    this._levelTitleText = null;
    this._levelTitleDone = false;
    // 第五十修：龙族宝箱（切关/重开/回菜单都要收起，否则宝箱会跨关留着）
    this._chest?.hide();
    this._chestDone = false;
    this._chestPending = 0;
    this._chestCfg = null;
  }

  /** 精英批次清空 → 金点从准星前方飞向选项卡位置（CARD 的固定世界坐标）→ 消失并弹出三张选项卡 */
  _goldToCards() {
    if (!GOLD_ORB.ENABLED) { this._enterMidCard(); return; }
    this.audio?.playEliteWipe();
    const from = new THREE.Vector3();
    this.world.camera.getWorldPosition(from);
    const dir = new THREE.Vector3();
    // 第六十五修：相机上的 getWorldDirection **已经是「看向的方向」**（three 的 Camera 重写了它，内部 .negate()）。
    //   旧注释写的「给 +Z」是错的（实测：看向 -Z 得 (0,0,-1)，见 tests/alarm-facing.test.mjs 同一结论），
    //   所以原来又 negate 一次 ⇒ 金点其实从**玩家背后** 1.2m 起飞，和这里想要的「准星前方」正相反。
    this.world.camera.getWorldDirection(dir);
    from.addScaledVector(dir, 1.2);
    from.y -= 0.35;
    const to = new THREE.Vector3(0, CARD.ROW_Y, CARD.ROW_Z);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(GOLD_ORB.SIZE, 12, 10),
      new THREE.MeshBasicMaterial({
        color: GOLD_ORB.COLOR, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
    mesh.position.copy(from);
    this.world.scene.add(mesh);
    const dur = THREE.MathUtils.clamp(from.distanceTo(to) / GOLD_ORB.SPEED, GOLD_ORB.DUR_MIN, GOLD_ORB.DUR_MAX);
    this._goldOrbs.push({ mesh, from, to, dur, t: dur, hold: 0 });
    this.log('精英批次清空：金点飞向选项卡');
  }

  _updateGoldOrbs(dt) {
    for (let i = this._goldOrbs.length - 1; i >= 0; i--) {
      const o = this._goldOrbs[i];
      if (o.t > 0) {
        o.t -= dt;
        const k = THREE.MathUtils.clamp(1 - o.t / o.dur, 0, 1);
        const e = k * k * (3 - 2 * k);
        o.mesh.position.set(
          o.from.x + (o.to.x - o.from.x) * e,
          o.from.y + (o.to.y - o.from.y) * e,
          o.from.z + (o.to.z - o.from.z) * e);
        if (o.t <= 0) o.hold = GOLD_ORB.HOLD;
        continue;
      }
      o.hold -= dt;
      if (o.hold > 0) continue;
      this.world.scene.remove(o.mesh);
      o.mesh.geometry.dispose();
      o.mesh.material.dispose();
      this._goldOrbs.splice(i, 1);
      this._enterMidCard();       // 原地消失 → 三张选项卡出现
    }
  }

  /** 治疗线（表现）：治疗术士与 healRadius 内最近的怪之间连线 + 绿色加号（healRadius 不乘 scale） */
  _updateHealLinks() {
    // 第四十九修：默认改走「脉冲环」（waves._applyHealAura → onHealPulse）。
    //   旧的每帧连线只在 HEAL_LINK.LINES=true 时才需要 —— 否则白白每帧算一遍 O(n²) 并画出线来。
    if (!HEAL_LINK.ENABLED || HEAL_LINK.LINES !== true) return;
    const pairs = [];
    const list = this.balloons.list;
    for (const b of list) {
      if (!b.alive || b.behavior !== 'heal' || !b.type) continue;
      const r = b.type.healRadius || 6;
      const near = [];
      for (const t of list) {
        if (t === b || !t.alive) continue;
        const d = b.mesh.position.distanceTo(t.mesh.position);
        if (d <= r) near.push({ d, t });
      }
      if (!near.length) continue;
      near.sort((a, c) => a.d - c.d);
      const n = Math.min(near.length, HEAL_LINK.MAX_TARGETS);
      for (let i = 0; i < n; i++) pairs.push({ a: b.mesh.position, b: near[i].t.mesh.position });
    }
    this.fx?.healLinks(pairs);
  }

  // 关卡中途抽卡（精英批次清空 → 金点落地后调用）：与通关抽卡同一套卡池，但**不推进关卡**
  _enterMidCard() {
    if (this.state !== 'playing') return;
    // 第四十七修：一关只给一次抽卡 —— 本关已经开过（金点落地时本关已经通了之类）就不再开第二次
    if (this._draftsThisLevel > 0) { this.log('本关已抽过卡（精英清场）→ 不再重复开卡'); return; }
    this._midDraftPending = true;
    this._enterCard(true);
  }

  // 中途抽卡收尾：回到游戏；若本关此时其实已经通了，再补上通关抽卡
  _onMidCardDone() {
    this.player.forceSingleShot = false;
    this.hud.clearMessage();
    this._midDraftPending = false;
    this.log('中途抽卡完成，继续本关');
    this.state = 'playing';
    if (this._levelClearHeld) {
      this._levelClearHeld = false;
      // 第四十七修：本关的抽卡刚在「精英清场」时用掉了（这次中途抽卡就是它）→ 直接推进，
      //   不再补一次通关抽卡（否则就是玩家反馈的「一局两次选项卡」）。
      this.log('本关已抽过卡（精英清场）→ 直接进入下一关');
      this._onCardDone();
    }
  }

  // ============================================================
  // 第六十修 · 教学关（第 1 关）—— 三个钩子
  //   脚本数据（段落/判据/文案）在 content/tutorial.js，运行态在 game/tutorial.js；
  //   这里只提供「是不是教学关」「单张教学卡」「收尾交回三选一」。
  // ============================================================

  /** 当前关是否教学关（倒计时 / 中场横幅 / 出怪都按它让步） */
  _isTutorialLevel() {
    const lv = LEVELS[this.levelIndex];
    return !!lv && isTutorialLevel(lv.n);
  }

  /**
   * 教学关的单张卡（选项卡位置，稿子第 3 条）：按角色给第一次选项卡。
   *   · 疾风：沿用「连杀加速」；
   *   · 蜂群：「浮游炮自动追踪前方敌人射击」——拿卡前浮游炮只沿枪管直射；
   *   · 爆炮手：「炮弹前方无敌人，就会自动在 6 米处爆炸」——拿卡前不会空爆。
   *   · 走 cardDraft 的 state.cards 显式卡表分支 —— 不查属性池、不随机、不进第 18 关汇总；
   *   · apply 为空：具体解锁在 _onTutorialCardDone 里按角色设置；
   *   · duration = 该卡的 TIMEOUT（12s 未打破 → 选项卡自动默认选择，稿子第 4 条）。
   */
  _enterTutorialCard() {
    if (this.state !== 'playing') return;
    this._clearExplosions();
    this.state = 'card';
    this.bullets.clear();
    this.player.forceSingleShot = true;      // 单卡也单发：避免多重射击扇形误打
    const pp = this._playerPos();
    this.world.camera.getWorldDirection(this._fwd);
    this._fwd.negate();                      // 相机前向是 -Z，getWorldDirection 给 +Z（同 _enterCard）
    const role = this.player?.characterKey || null;
    const card = tutorialCardFor(role);
    this._cardState = {
      player: this.player,
      getScore: () => this.score,
      spendScore: (cost) => { this.score -= cost; },
      cards: [{
        id: card.ID, label: card.LABEL, desc: card.DESC,
        color: card.COLOR, icon: card.ICON,
        apply: () => {},                     // 教学卡不给数值，只解锁角色机制
      }],
      duration: card.TIMEOUT,
    };
    this.hud.message(card.LABEL, '射击气球立即获得（' + card.TIMEOUT + 's 后自动获得）', card.COLOR);
    this.log('[教学] 弹出单张教学卡（' + (role || 'default') + '）：' + card.LABEL);
    this.cards.open(pp, this._fwd.clone(), this._cardState, () => this._onTutorialCardDone());
  }

  /** 教学卡收尾：回游戏，把控制权交还教学流程（不推关卡） */
  _onTutorialCardDone() {
    const role = this.player?.characterKey || null;
    if (role === 'swarm') {
      this._satelliteAutoTrack = true;
      if (this._roleUnlocks) this._roleUnlocks.satelliteTrack = true;
      this.log('[教学] 蜂群解锁：浮游炮自动追踪');
    } else if (role === 'bombard') {
      this._bombardAirburst = true;
      if (this._roleUnlocks) this._roleUnlocks.bombardAirburst = true;
      this.log('[教学] 爆炮手解锁：前方无敌人时 6 米空爆');
    } else if (role === 'plague') {
      this._plagueInfect = true;
      if (this._roleUnlocks) this._roleUnlocks.plagueInfect = true;
      this.log('[教学] 瘟疫医生解锁：感染（死亡时转移一半毒素层数）');
    }
    this.player.forceSingleShot = false;
    this.hud.clearMessage();
    this.state = 'playing';
    this.tutorial?.onCardDone();
  }

  /** 教学关收尾（稿子第 6 条）：交回正常三选一 → 进第 2 关 */
  _finishTutorial() {
    this._tutorialFreeSkill = false;
    this._hideTutorialHint();        // 第六十二修：出教学关就收起常驻提示板
    // 第六十二修（现场）：「完成教学关后直接送 500 商店币，给玩家更快启动」——
    //   到第 3 关商店就能直接买一件，不用先靠打怪攒币才敢进商店。
    //   ⚠ 这是**教学关专属的一次性奖励**：第 2~18 关通关**一律不奖励**（不做关卡结算奖励）。
    //     所以它跟「击杀能量入账」根本不是一类东西 —— 直接加 shopCoin 即可，
    //     不走 _addShopCoin（那条路径是给击杀入账用的，带「以战养战」加成）。
    const gift = TUTORIAL.DONE.SHOP_COIN | 0;
    if (gift > 0) {
      this.shopCoin += gift;
      this.hud.setShopCoin(this.shopCoin);
      this.log(`教学关通关奖励：+${gift} 商店币（现有 ${this.shopCoin}）`);
    }
    this.log('[教学] 教学关完成 → 正常选项卡');
    this._enterCard();
  }

  _enterCard(mid = false) {
    if (this.shopMode) { this.log('商店关不发选项卡，直接进入下一关'); this._exitShop(); return; } // 第五十五修
    this._endBlackHole(); // 第六十七修：进抽卡先收黑洞（释放被吸附的怪，避免卡在身后）
    this._draftsThisLevel = (this._draftsThisLevel || 0) + 1;  // 第四十七修：一关一次（通关分支据此跳过第二次）
    this._clearExplosions();
    this.state = 'card';
    this.bullets.clear(); // 清掉上一波残留子弹，避免误击卡气球
    this.player.forceSingleShot = true; // 抽卡期间强制单发，避免多重射击扇形误选邻卡
    this.log(mid ? '精英批次清空，选择强化（中途）' : '波次清空，选择强化');
    const pp = this._playerPos();
    this.world.camera.getWorldDirection(this._fwd);
    this._fwd.negate(); // 相机/手柄前向为 -Z，getWorldDirection 返回 +Z，需取反，否则卡牌会生成在身后

    // 逐关卡池（对齐 iMA 笔记「选项卡调整」）：抽 3 张不重复
    const lv = LEVELS[this.levelIndex];
    // 提前预热下一关全景：抽卡阶段就下载+解码+上传GPU，避开切换关时单帧 32MB 上传+mip 尖峰卡顿
    const _nxLv = LEVELS[this.levelIndex + 1];
    if (_nxLv) {
      const _nxPano = SKY_PANORAMA[_nxLv.n];
      if (_nxPano) {
        // 抽卡阶段预热下一关全景：下载+解码+GPU 上传(initTexture) 一步到位（含去重 + _gpuReady 标记），
        // 避开切换关时单帧上传卡顿；与 _loadLevel 的 setSkyPanorama 共用 _gpuReady 标记，不重复上传。
        this.world.prepareSkyPano(_nxPano).catch(() => {});
      }
    }
    let plan;
    if (lv.kind === 'laser' && lv.n === 3) {
      // 第三关：固定三张技能卡（如来神掌/激光剑/黑洞）—— 商店关已接管第 3 关，此处保留旧分支口径
      plan = { fixedSkills: ['buddha', 'lightsaber', 'blackhole'] };
    } else if (lv.n === 18) {
      // 第18关（最终 Boss）通关：展示本局获得的所有选项卡，随后进入通关结算
      this._showRunSummary();
      return;
    } else if (lv.kind === 'boss' || lv.kind === 'laser') {
      // Boss 关(6/12)：抽 4–7 池（技能消耗/技能伤害/自我修复）——hp 卡已随第五十五修移除
      plan = { pool: ['skillCost', 'skillDamage', 'selfRepair'] };
      // 第9关：必定出一张回血卡（自我修复优先，其次生命上限；两张都满级时退化为战场补给）
      if (lv.n === 9) plan.guarantee = ['selfRepair'];
    } else {
      // 普通/危机关：抽属性卡池（射速/子弹/攻击 [+技能消耗/技能伤害]）
      // 第六十修：**前两关不再出现技能相关的选项卡**（技能消耗/技能伤害）—— 此时玩家还没技能，
      //   抽到等于空卡；池子与 strictPool 口径见 cards.attrPoolForLevel（有单测锁）。
      const _attr = attrPoolForLevel(lv.n);
      plan = { pool: _attr.pool, strictPool: _attr.strictPool };
      if (lv.n === 1) plan.guarantee = 'multiShot';    // 01 关：额外子弹必出
      else if (lv.n === 2) plan.guarantee = 'fireRate'; // 02 关：射速必出
    }

    // 第八十九修 · 角色专属卡池：爆炮手的「额外子弹+1」替换为「多重爆炸」。
    //   池子、必出卡一起替换，并禁用原卡；否则第 1 关的 guarantee 会把 multiShot 硬塞回来。
    const role = this.player?.characterKey || null;
    if (plan) {
      if (plan.pool) plan.pool = roleAttrPool(plan.pool, role);
      plan.banned = roleBannedCards(role);
      if (typeof plan.guarantee === 'string') {
        plan.guarantee = roleAttrPool([plan.guarantee], role)[0];
      } else if (Array.isArray(plan.guarantee)) {
        plan.guarantee = roleAttrPool(plan.guarantee, role);
      }
    }

    this._cardState = {
      player: this.player,
      // score 访问解耦：注入回调，cardDraft 不再反向持有 game 实例
      getScore: () => this.score,
      spendScore: (cost) => { this.score -= cost; },
      pool: plan.pool || null,                 // 普通/Boss/机制关：属性卡池（抽 3 不重复）
      strictPool: !!plan.strictPool,            // 第六十修：前两关 true → 池子不足 3 张也不从全表补位
      guarantee: plan.guarantee || null,        // 必出卡：01/02 关单卡；第9关回血组（数组，取第一张可用）
      banned: plan.banned || null,              // 第八十九修：角色禁用的属性卡
      fixedSkills: plan.fixedSkills || null,    // 第三关：固定技能卡
      onSkill: (id) => this._applySkillCard(id),
      onCollect: (id) => this._collectedCards.push(id), // 本局收集：供第18关汇总
    };
    this.hud.message('选择强化', '射击对应气球进行选择（3 选 1）', '#ffd43b');
    this.cards.open(pp, this._fwd.clone(), this._cardState, () => (mid ? this._onMidCardDone() : this._onCardDone()));
  }

  /**
   * 第九十二修：本局结算。
   * 只展示统计并向平台上报结果，**不退出 VR / 不关浏览器**；平台 closeGame 才是唯一关闭入口。
   */
  _showRunSummary(why = '第18关通关') {
    if (this._runResultShown) return;
    this._runResultShown = true;
    this._roundOver = true;
    this.state = 'result';
    if (this.waves?._winBanner) {
      this.waves._winBanner.dispose();
      this.waves._winBanner = null;
    }
    // 冻结战场：保留 VR 会话和相机，只清掉会继续动/伤人的实体。
    this.balloons.clear();
    this.projectiles.clear();
    this.vignette.clear();
    this.bullets.clear();
    this.damageNumbers.clear();
    this.fx.clear();
    // 结算后仍在飞的金点会在 hold 结束时调 _enterMidCard → 抽卡会浮到结算面板之上。
    // 连同治疗线 / 宝箱 / 挂起标记一起清干净，保证 result 态只保留一个结算面板。
    this._clearRoundExtras();
    this.waves?.clearPending?.();
    this.midWarning?.hide();
    this.player.forceSingleShot = true;
    this.input?.reset();
    this.hud.clearCountdown();
    this.hud.showShopCoin(false);
    this.hud.message('本局结束', '等待平台关闭游戏', '#ffd43b');
    this.audio?.stopAllMedia();
    this.audio?.stopBGM();

    const data = this._buildRunSummaryData(why);
    this._showRunResultPanel(data);
    this._tellMasterRoundEnd(why);   // 先让平台收到 CMD 7 并弹结算；APK 不收到 roundOver game-end，不会自动关页
    this.log(`本局结算：${why}；杀敌 ${data.kills}（普通 ${data.basicKills} / 精英 ${data.eliteKills} / Boss ${data.bossKills}）`);
  }

  _buildRunSummaryData(why = '第18关通关') {
    const p = this.player || {};
    const role = CHARACTERS[p.characterKey] || p.character || null;
    const stats = this._runStats || { kills: 0, basic: 0, elite: 0, boss: 0 };
    const levelNo = Math.max(1, Math.min(LEVELS.length, (this.levelIndex | 0) + 1));

    const items = SHOP_ITEMS
      .map((def) => ({ def, lv: (this._itemLv && this._itemLv[def.id]) || 0 }))
      .filter((x) => x.lv > 0)
      .map((x) => `${x.def.label}  Lv.${x.lv}`);

    const counts = {};
    for (const id of this._collectedCards || []) {
      if (SKILL_CARDS.some((c) => c.id === id)) continue;
      counts[id] = (counts[id] || 0) + 1;
    }
    const upgrades = Object.entries(counts).map(([id, n]) => {
      const def = ATTR_TYPES.find((c) => c.id === id);
      return `${def ? def.label : id}  ×${n}`;
    });

    const skillName = SKILL_LABELS[this.selectedSkill] || '未装备';
    return {
      title: `第${levelNo}关 · 本局结算`,
      subtitle: why,
      kills: stats.kills,
      basicKills: stats.basic,
      eliteKills: stats.elite,
      bossKills: stats.boss,
      combatLines: [
        `角色  ${role ? `${role.name} · ${role.title}` : '默认角色'}`,
        `关卡  ${levelNo} / ${LEVELS.length}`,
        `杀敌  ${stats.kills} 只`,
        `普通  ${stats.basic}    精英  ${stats.elite}    Boss  ${stats.boss}`,
        `最高连击  ${this._maxCombo || 0}`,
        `飞毯血量  ${Math.max(0, Math.ceil(p.hp || 0))} / ${Math.max(0, Math.ceil(p.maxHp || 0))}`,
        `能量  ${Math.max(0, Math.round(this.score || 0))}    商店币  ${Math.max(0, Math.round(this.shopCoin || 0))}`,
      ],
      skillLines: [
        `技能  ${skillName}`,
        `技能威力  ×${p.skillDamageMul || 1}`,
        `技能消耗  ${p.skillCost || 0} 能量`,
        `冷却缩减  ${p.skillCdDown || 0} 秒`,
        `释放次数  ${this._runSkillCasts || 0}`,
      ],
      itemLines: items.length ? items : ['（未购买商店道具）'],
      upgradeLines: upgrades.length ? upgrades : ['（未获得属性强化）'],
      footer: '本局已结束 · 等待平台关闭游戏',
    };
  }

  _showRunResultPanel(data) {
    const scene = this.world && this.world.scene;
    const camera = this.world && this.world.camera;
    if (!scene || !camera) return;
    this._disposeRunResultPanel();
    this._runResultPanel = new RunSummaryPanel3D(scene, camera, data);
  }

  _disposeRunResultPanel() {
    if (this._runResultPanel) this._runResultPanel.dispose();
    this._runResultPanel = null;
  }

  // 抽卡模式：允许自由移动 + 射击，子弹命中卡气球即选卡
  _updateCard(dt) {
    this.input.update(dt);
    // 测试能量键（左手 X / 桌面 G）：抽卡阶段也可加分，方便直接测试刚选的技能
    const credit = this.input.consumeCredit();
    if (credit > 0) { this._addScore(credit); this.log(`测试 +${credit} 能量`); }
    this.player.update(dt);
    this.bullets.update(dt, this._homingTarget);   // 第五十五修：追踪弹每帧转向
    const _boostShot = this._gameTime < this._rapidUntil;
    // 第五十修：累计这一帧**实际打出**的弹数（player.fire 返回弹道数）—— 龙族宝箱按它给加成
    this._firePlayerShots(_boostShot);   // 第五十五修：统一开火入口（宝箱计数 + 串糖葫芦穿甲弹都在里面）
    this.cards.update(dt, this.bullets, this._playerPos().clone());
    this.bullets.sync(); // 抽卡模式子弹命中后刷新实例矩阵
  }

  _onCardDone() {
    this.player.forceSingleShot = false; // 退出抽卡，恢复枪械模式弹道数
    // 第3关（首个激光/机制关）选完技能后赠送 500 能量（受上限钳制），便于立即释放激光剑（消耗 500）
    const _cleared = LEVELS[this.levelIndex]; // 此刻 levelIndex 仍是刚清的关（下方才 ++）
    if (_cleared && _cleared.n === 3) { this._addScore(500); this.log('第3关奖励：+500 能量'); }
    this.hud.setScore(this.score); // game.score 已由抽卡实时维护
    this.hud.clearMessage();
    this.levelIndex++;
    if (!this.player.buddhaUnlocked) this.player.buddhaUnlocked = true; // 首波后解锁大招
    this.log('强化完成 → 进入下一关');
    if (this.levelIndex >= LEVELS.length) {
      this._showRunSummary('全部关卡完成');
      return;
    }
    this._loadLevel(this.levelIndex);
    this.state = 'playing';
  }

  // ============================================================
  // 第五十五修 · 商店关（第3/9/15关，替代原激光机制关）
  //   正前方技能区 = 技能本体×3（已有技能后 → 技能威力/消耗/冷却）+「购物完成」；
  //   左手边道具区 = 道具×3（6 选 3 不重复）+「刷新」；打中气球即购买。
  // ============================================================

  /** 玩家是否已拥有「三选一」技能（默认的能量散射不算 —— 正前方要卖技能本体） */
  _hasChosenSkill() { return !!this.selectedSkill && this.selectedSkill !== 'scatter'; }

  _itemLevel(id) { return (this._itemLv && this._itemLv[id]) || 0; }

  /**
   * 商店币入账：击杀能量等额 +「以战养战」加成（无上限；一局结束清零）。
   * 第六十五修：**入账即时**（真实值，商店扣款/切关/对账都读它），但枪上小框的数字等金点落地才变。
   * @param {number} n          本次金额（未经「以战养战」加成）
   * @param {THREE.Vector3|null} fromPos 击杀位置 = 金点起飞处（不传 → 不飞金点，数字立刻变）
   */
  _addShopCoin(n, fromPos = null) {
    const v = Math.round(n || 0);
    if (!v) return;
    const amount = Math.round(v * warFeedMul(this._itemLevel('warFeed')));
    this.shopCoin += amount;
    this.hud.setShopCoin(this.shopCoin);
    if (amount > 0 && fromPos && this.fx) this.fx.coinOrb(fromPos, amount);
  }

  /**
   * 第六十五修 · 枪上「商店币」小框（现场两条口径）。
   *   ① 「在枪上的这一块信息框给玩家在非商店关时看到商店币数量」⇒ 局内常显（playing / 抽卡），
   *      菜单与开场影片期间收起（判据见 _shopCoinBadgeOn）；
   *   ② 「怪打死后要有金色光点飞到这里接着数字变动」⇒ 数字由 shopCoinDisplay.advanceShown 推进：
   *      有金点在飞时显示值**落后**于真实值，金点一落地就把金额补上；金点全落地 / 被清掉（切关等）
   *      则自动对齐真实值 —— 所以显示值只会「慢慢追上来」，永远不会和真实值错账。
   * @param {number} landed 本帧落地的金点金额
   */
  _updateShopCoinBadge(landed = 0) {
    const rg = this.rightGun;
    if (!rg) return;
    rg.setShopCoin(this._shopCoinBadgeOn(), this.shopCoin,
      this.fx ? this.fx.coinFlightCount() : 0, landed);
  }

  /** 小框显隐：局内常显（现场要求非商店关也看得到商店币）；菜单 / 结束 / 开场影片期间收起 */
  _shopCoinBadgeOn() {
    return this.state === 'playing' || this.state === 'card';
  }

  /** 建商店场地（由 _loadLevel 的分帧任务调用，位置与 LaserLevel 相同） */
  _enterShop() {
    // 第七十八修：进店前先清掉可能残留的上一份商店（重复跑任务 / 重进关时）。
    //   旧实现直接 new ShopDraft，一旦 _enterShop 被跑两次，场景里会叠两套卡 ——
    //   现场「两张一模一样的道具卡」就是这种叠层的典型症状。
    if (this.shopDraft) { this.shopDraft.dispose(); this.shopDraft = null; }
    this.shopDraft = new ShopDraft(this.world.scene);
    this.shopDraft.open(this._playerPos(), {
      getShopCoin: () => this.shopCoin,
      getRole: () => this.player?.characterKey || null,
      spendShopCoin: (c) => { this.shopCoin = Math.max(0, this.shopCoin - c); this.hud.setShopCoin(this.shopCoin); },
      hasSkill: () => this._hasChosenSkill(),
      getItemLevels: () => this._itemLv,
      // 第五十六修：第 3 关商店价格减半（技能本体/强化/道具；刷新价不变）
      priceMul: () => (LEVELS[this.levelIndex] && LEVELS[this.levelIndex].n === 3) ? SHOP.LEVEL3_PRICE_MUL : 1,
      onBuySkill: (id) => this._applySkillCard(id),
      // 第六十九修：内容包可能比 APK 新。客户端没实现的技能卡不摆上架（避免买到「按了没反应」）。
      supportsSkill: (id) => this._supportsSkill(id),
      onBuyUpgrade: (id) => this._applySkillUpgrade(id),
      onBuyItem: (id) => this._buyShopItem(id),
      // 第五十七修：右手边「精英预告」卡要知道本店是第几关（决定预告窗口）
      shopLevel: LEVELS[this.levelIndex].n,
      onDenied: (msg) => this.midWarning?.show(msg),
      // 第七十七修：成功/提示走独立通道 —— 不再复用 onDenied（那条是「买不起」的红色提示）
      onNotice: (msg) => this.midWarning?.show(msg),
    });
    this.hud.setShopCoin(this.shopCoin);
    this.hud.showShopCoin(true);
    this._warmShopPortraits();   // 第五十七修 v2：预告卡立绘（异步逐张换图，不挡进店）
    this.hud.message('商店关 · 魔术空间',
      `首件道具免费（任选一件）· 打「购物完成」提前离开（${SHOP.COUNTDOWN}s）`, '#ffd43b');
    const preview = this.shopDraft.preview.map((p) => p.card.label).join(' / ') || '（空）';
    // 第七十七修：把这局**实际建出来的**商店内容写进留痕 —— 下次现场说「不对」时，
    //   这一行就能区分「数据/版本旧」还是「看漏了」：道具 id、首件免费、预告名单、两侧位置一次对齐。
    const items = this.shopDraft.entries.filter((e) => e.kind === 'item');
    const itemIds = items.map((e) => `s${e.slot}:${e.def.id}`).join(',');
    const dupIds = items.length !== new Set(items.map((e) => e.def.id)).size;
    this.log(`第 ${LEVELS[this.levelIndex].n} 关 · 商店关：正前方技能区 / 左手边道具区（商店币 ${this.shopCoin}）；`
      + `道具=[${itemIds}] 重复=${dupIds ? '是' : '否'} 首件免费=${this.shopDraft._freeItem ? 1 : 0}；`
      + `右手边精英预告 ${this.shopDraft.preview.length} 张：${preview}；`
      + `布局 X=${SHOP.ITEM_X}/${SHOP.PREVIEW_X} DZ=${SHOP.ITEM_DZ}/${SHOP.PREVIEW_DZ} 倒计时=${SHOP.COUNTDOWN}s`);
  }

  /**
   * 第五十七修 v2：右手边「精英预告」卡的立绘 —— 把精英的 GLB 离屏渲成正视图塞进卡面。
   * 一次只抓一张：抓帧含同步回读（readRenderTargetPixels），扎堆会连掉好几帧；
   * 抓到一张立刻换一张卡面，玩家进店看到的是「? → 立绘」逐张补齐。
   * 离店（或又进了一次店，shopDraft 已换人）立刻停手；立绘有全局缓存，下次进店命中缓存不再抓。
   */
  _warmShopPortraits() {
    const shop = this.shopDraft;
    const renderer = this.world && this.world.renderer;
    if (!shop || !renderer) return;              // 无渲染器（单测 / 无 WebGL）→ 卡面直接留在「?」
    const specs = shop.previewPortraits();
    let i = 0;
    const step = () => {
      if (this.shopDraft !== shop || !shop.active) return;   // 已经离店：停手
      const spec = specs[i++];
      if (!spec) return;
      const say = (m) => this.log && this.log('[立绘] ' + m);   // 第六十三修：头显上看不到 DevTools，诊断进留痕
      Promise.resolve(portraitCanvas(renderer, spec, say)).then((cv) => {
        if (cv && this.shopDraft === shop) shop.setPortrait(portraitKey(spec), cv);
        setTimeout(step, PORTRAIT_STEP_MS);
      });
    };
    setTimeout(step, PORTRAIT_STEP_MS);
  }

  /** 商店关每帧：气球交互 + 倒计时 + 收尾判定 */
  _updateShop(dt, pp) {
    if (!this.shopDraft) return;
    this.shopDraft.update(dt, this.bullets, pp, this.world.camera);
    this.bullets.sync();
    this._shopLeft = Math.ceil(this.shopDraft.timer);
    this.hud.setScore(this.score);
    this.hud.setShopCoin(this.shopCoin);
    this.hud.setHp(this.player.hp, this.player.maxHp);
    this.hud.setCountdown(this._shopLeft);
    if (this.shopDraft.finished) this._exitShop();
  }

  /** 离开商店关（购物完成 / 倒计时结束）→ 下一关；商店关**不发选项卡** */
  _exitShop() {
    this.shopMode = false;
    this.player.forceSingleShot = false;
    this.hud.clearCountdown();
    this.hud.showShopCoin(false);
    this.hud.clearMessage();
    const lv = LEVELS[this.levelIndex];
    if (lv && lv.n === 3) { this._addScore(500); this.log('第3关奖励：+500 能量'); }  // 保留原「选完技能赠 500」
    this.log('商店关结束 → 进入下一关');
    this.levelIndex++;
    if (!this.player.buddhaUnlocked) this.player.buddhaUnlocked = true; // 与抽卡分支同口径
    if (this.levelIndex >= LEVELS.length) {
      // 商店关在 3/9/15，正常走不到这里；保底也进结算态等平台关闭。
      this._showRunSummary('全部关卡完成（商店关收尾）');
      return;
    }
    this._loadLevel(this.levelIndex);
    this.state = 'playing';
  }

  /** 技能强化（第9/15关商店）：威力+ / 消耗- / 冷却- */
  _applySkillUpgrade(id) {
    if (id === 'skillDamageUp') {
      this.player.skillDamageMul = Math.min(5, (this.player.skillDamageMul || 1) + 1);
      this.log(`技能威力+：技能伤害 ×${this.player.skillDamageMul}`);
    } else if (id === 'skillCostDown') {
      this.player.skillCost = Math.max(100, (this.player.skillCost || 500) - 100);
      this.log(`技能消耗-：技能消耗 ${this.player.skillCost} 能量`);
    } else if (id === 'skillCdDown') {
      this.player.skillCdDown = (this.player.skillCdDown || 0) + SHOP.CD_DOWN;
      this.log(`技能冷却-：累计 -${this.player.skillCdDown}s`);
    }
  }

  /** 道具购买（可重复升级）：等级 +1；买完即生效 */
  _buyShopItem(id) {
    this._itemLv[id] = (this._itemLv[id] || 0) + 1;
    const lv = this._itemLv[id];
    if (id === 'moreIsBetter') {
      this._mibUntil = this._gameTime + SHOP.MIB_DURATION;   // 买完立刻生效
      this._mibNextAt = this._gameTime + mibCooldown(lv);    // 冷却从买完开始算
      this.log(`多才是王道 Lv.${lv}：+${SHOP.MIB_SHOTS} 弹道 ${SHOP.MIB_DURATION}s，冷却 ${mibCooldown(lv)}s`);
      return;
    }
    this.log(`道具升级：${id} Lv.${lv}`);
  }

  /** 商店道具逐帧效果（目前只有「多才是王道」的自动触发与到期收回） */
  _tickShopItems() {
    const lv = this._itemLevel('moreIsBetter');
    if (lv <= 0) { if (this.player.bonusShotCount) this.player.bonusShotCount = 0; return; }
    if (this._gameTime >= this._mibNextAt) {
      this._mibUntil = this._gameTime + SHOP.MIB_DURATION;
      this._mibNextAt = this._gameTime + mibCooldown(lv);
    }
    this.player.bonusShotCount = this._gameTime < this._mibUntil ? SHOP.MIB_SHOTS : 0;
  }

  /** 商店道具（击杀时结算）：打狗还要看主人 / 吸血子弹 —— 只认子弹击杀 */
  _shopBulletKill(balloon) {
    const dog = this._itemLevel('dogOwner');
    if (dog > 0) this._spawnHomingBullets(balloon, dog);
    const ls = this._itemLevel('lifesteal');
    if (ls > 0 && Math.random() < lifestealChance(ls) && this.player.hp < this.player.maxHp) {
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + 1);
      this.hud.setHp(this.player.hp, this.player.maxHp);
    }
  }

  /** 打狗还要看主人：向击杀点 DOG_RADIUS 内最近的精英/Boss 发射追踪弹（伤害 = 攻击力×DOG_DMG_MUL）。第五十六修：弹体更大、曳光更长，并改从**枪口**射出 */
  _spawnHomingBullets(balloon, count) {
    const at = balloon && balloon.mesh && balloon.mesh.position;
    if (!at) return;
    const r2 = SHOP.DOG_RADIUS * SHOP.DOG_RADIUS;
    let best = null, bestD = Infinity;
    for (const t of this.balloons.list) {
      if (!t.alive || t === balloon || !(t.isElite || t.isBoss)) continue;
      const d = t.mesh.position.distanceToSquared(at);
      if (d > r2 || d >= bestD) continue;
      bestD = d; best = t;
    }
    if (!best) return;   // 场上半径内没有精英 → 不生成（口径）
    const dmg = (this.player.atk || 100) * SHOP.DOG_DMG_MUL;
    // 第五十六修：追踪弹改从**枪口**射出（SHOP.DOG_FROM_MUZZLE=false 回到旧口径「从击杀点射出」）
    // 第五十七修（现场）：**不能读 input.shots** —— 那个数组每帧开头就清空、只有「本帧真开了一枪」才有值，
    //   而击杀常发生在没开火的帧（子弹飞一会儿才命中）⇒ 会退回击杀点，现场现象就是「追踪弹不是从枪口出的」。
    //   改成直接问 input.getMuzzle()：当前枪口位姿，与红射线 / 普通子弹同源。
    let from = at;
    if (SHOP.DOG_FROM_MUZZLE && this.input && typeof this.input.getMuzzle === 'function') {
      const mp = this._dogMuzzlePos || (this._dogMuzzlePos = new THREE.Vector3());
      const md = this._dogMuzzleDir || (this._dogMuzzleDir = new THREE.Vector3());
      this.input.getMuzzle(mp, md);
      from = mp;
    }
    const dir = this._tmp.copy(best.mesh.position).sub(from).normalize();
    const opts = { homing: best, tint: SHOP.DOG_COLOR, scale: SHOP.DOG_SCALE, trailMul: SHOP.DOG_TRAIL_MUL };
    for (let i = 0; i < count; i++) {
      this.bullets.spawn(from, dir, dmg, false, opts);
    }
  }

  /** 专打强者：对精英 / Boss 的最终伤害 ×(1 + 0.2×等级) */
  _applyShopDamage(target, dmg) {
    const lv = this._itemLevel('strongHunter');
    if (lv <= 0 || !target) return dmg;
    if (!(target.isElite || target.isBoss)) return dmg;
    return dmg * strongHunterMul(lv);
  }

  /** 统一开火入口：打出子弹 + 宝箱计数 + 串糖葫芦穿甲弹（返回本帧实际打出弹数） */
  _firePlayerShots(boost) {
    // 第八十四修：掌风弹窗口内，普通枪弹/散射弹统一走掌风弹 opts。
    // 只在这里注入，因此商店追踪弹/穿甲弹仍保持自己的颜色和形态。
    const pw = BUDDHA.PALM_WIND || {};
    const palmOpts = (pw.ENABLED && this._gameTime < this._palmWindUntil) ? {
      palm: true,
      dmgMul: pw.DAMAGE_MUL || 1,
      pierce: pw.PIERCE || 0,
      trailMul: pw.TRAIL_MUL || 1,
    } : null;
    const p = this.player;
    const role = p?.fireMode || 'fan';
    const special = role !== 'fan' && !p.forceSingleShot && !this.shopMode && this.state !== 'card';
    const palmMul = (palmOpts && palmOpts.dmgMul) || 1;
    let n = 0;
    for (const shot of this.input.shots) {
      if (special && role === 'satellite') {
        // 主枪固定单发；多余弹道由浮游炮分别索敌开火。
        n += p.fire(shot, this.bullets, this.audio, boost, palmOpts, true);
        n += this.satellites.fire(this, shot, boost, palmMul);
      } else if (special && role === 'bombard') {
        // 主炮 + 微型火箭；掌风窗口只继承伤害倍率，不切成掌形贴图。
        n += this.bombard.fire(this, shot, boost, palmMul);
      } else {
        n += p.fire(shot, this.bullets, this.audio, boost, palmOpts);
      }
    }
    if (n <= 0) return 0;
    this._chest?.addShots(n);
    const lv = this._itemLevel('candyString');
    if (lv > 0) {
      this._candyCount += n;
      const shot = this.input.shots[this.input.shots.length - 1];
      if (shot) {
        while (this._candyCount >= SHOP.CANDY_EVERY) {
          this._candyCount -= SHOP.CANDY_EVERY;
          for (let k = 0; k < lv; k++) {
            this.bullets.spawn(shot.position, shot.direction, this.player.atk, false,
              { pierce: SHOP.CANDY_PIERCE, tint: SHOP.CANDY_COLOR, scale: SHOP.CANDY_SCALE, trailMul: SHOP.CANDY_TRAIL_MUL });
          }
        }
      }
    }
    return n;
  }

  _gameOver() {
    this.state = 'over';
    VRPlusGame.terminate();   // cmd 5 中途结束（飞船坠落 / 失败）
    this.log('飞船坠落，游戏结束');
    this.balloons.clear();
    this.projectiles.clear(); // 游戏结束清投射物
    this.vignette.clear();
    this.bullets.clear();
    this.hud.message('飞船坠落', `得分 ${this.score} · 按「开始游戏」重来`, '#e74c3c');
    this.hud.showStart();
  }

  // 正常测试通关：停止补怪后场上清空即达成。也进结算态，不自动退出。
  _testWin() {
    this._showRunSummary('全部消灭（通关）');
  }
}
