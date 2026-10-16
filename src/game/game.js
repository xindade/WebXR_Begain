import * as THREE from 'three';
import { TEST } from '../core/constants.js';
import { Player } from './player.js';
import { BalloonManager } from './balloons.js';
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
import { LEVELS, isLaser, isBoss, isShop, levelTitleText, shouldShowLevelTitle, levelTitleDelay } from '../content/levels.js';
import { ENEMY_TYPES } from '../content/enemies.js';
import { scriptFor } from '../content/spawnDirector.js';
import { ELITE_SCHEDULE } from '../content/eliteMonsters.js';
import { LEVEL_PLANS, LEVEL_ENEMY } from '../content/spawnPlans.js';
import { ATTR_TYPES, SKILL_CARDS } from '../content/cards.js';
import { warFeedMul, lifestealChance, strongHunterMul, mibCooldown } from '../content/shopItems.js';
import { BALLOON, BUDDHA, SHIP, SHOOT, LASER, GRID, FLIP, MOVE, EXPLOSION, SKY_PANORAMA, DEPTH_SPRITE_STRESS, DEPTH_SPRITE_TYPES, NORMAL_TEST, DDA, FACE_BOSS, PORTAL, SPAWN_RING, GUN_MODES, SCATTER, SCATTER_BURST, LASER_SWORD, BOSS_BGM, CLOUD, SCORE_CAP, DRAGON, OPENING_MAGICIAN, BASIC_VOICE, MAGICIAN_BOSS, INTRO_VIDEO, HIT_FEEDBACK, FX, MID_WARNING, RAPID_FIRE, levelSecondsOf, CARD, GOLD_ORB, ELITE_FEEDBACK, HEAL_LINK, LEVEL_TITLE, HEAL_ON_DEATH, DRAGON_CHEST, SHOP } from '../core/constants.js';
import { DamageNumbers } from './damageNumbers.js';
import { FxEffects } from './fx.js';
import { WarningBanner3D, midWarningDue } from './warningBanner.js';  // 第四十二修：中场预警横幅
import { advanceStreak } from './rapidFire.js';                // 第四十三修：连杀推进规则（加速期封顶）
import { setRenderer, loadBalloonModel, preCaptureDepthSprite, warmModelGpu } from './balloonModels.js';
import { DifficultyController } from './difficultyController.js';
import { VRPlusGame, VRPlus } from '../net/vrplus.js';   // VR+ 平台桥接：cmd 3 启动 / 4 开始 / 5 中途结束 + 下行 inbox 监听

const KIND_NAME = { normal: '普通关', crisis: '危机关', bonus: '奖励关', boss: 'Boss关', laser: '激光关', shop: '商店关' };
const ORIGIN = new THREE.Vector3(0, 0, 0);
const _WORLD_UP = new THREE.Vector3(0, 1, 0);

// 线段 a-b 上离点 p 最近点的距离平方（命中判定用：子弹本帧轨迹 vs 怪物球心）
// 退化（a≈b）时回退为点到点距离，不会误判。
const _segAB = new THREE.Vector3();
const _segAP = new THREE.Vector3();
const _segClosest = new THREE.Vector3();
const _segN = new THREE.Vector3(); // 2D立绘命中板法线(朝相机)
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

    this.player = new Player(world.scene, this.rig);
    this.balloons = new BalloonManager(world.scene);
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
    this.bullets = new BulletManager(world.scene);
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
    this._pendingBgm = null; this._pendingOpenVoice = null; this._bossT = 0; this._bossInten = BOSS_BGM.START_INTENSITY; // 穿云结束后启动的本关音频（程序化 BGM 轨道 + Boss 升压状态）
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
    this.score = 0;
    this._buddhaFx = null;
    this._buddhaHit = new Set(); // 当前如来神掌已命中气球集合（防止重复结算）
    this._cardState = null;
    this._levelSnapshot = null;  // 关卡开始时的玩家属性+分数快照
    this._explosions = [];       // 爆炸视觉特效列表
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
    this._buddhaQueue = [];       // 如来神掌分帧结算队列（第四十二修，见 _drainBuddhaQueue）
    this.enemyFreeze = 0;        // 定身咒计时(s)：>0 时敌人暂停行动（Boss 仅前 50% 时长）
    this.selectedSkill = 'scatter'; // 当前装备技能：前期默认「积分散射」；第三关选卡后可替换为 lightsaber/freeze/buddha，左手柄 grip 触发
    this.skillCooldown = 0;      // 技能释放冷却计时(s)：>0 时握柄无效，HUD 显示剩余
    // —— 第五十五修 · 商店关（第3/9/15关，替代原激光机制关）——
    this.shopDraft = null;       // ShopDraft 实例（每进一次商店关新建，见 _enterShop）
    this.shopMode = false;       // 当前是否处于商店关
    this.shopCoin = 0;           // 商店币：击杀积分等额累积；一局（1→18 关走完）清零，与 score 完全独立
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
    this.player.reset(gunMode, this.loadout);
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
    this.log(`游戏开始${this.loadout ? `（开局加成：${this.loadout}）` : ''}`);
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
   * ★ 第三十九修：第18关魔术师 Boss 被击杀 = **本局自然结束（通关）**。
   *
   * 与「平台点结束游戏」共用同一条收尾（_finishRound），只把留痕标签换成 round-clear：
   *   · 上报 game-end 带 **roundOver** → APK 按退出策略执行（唤醒平台客户端 + 关浏览器；
   *     直播模式（?cast=1）下**只有 roundOver 才允许关**，见 GameServer.notifyGameEndIfAny）；
   *   · 直播模式：停推流 + 页面卸载成 about:blank；非直播：进「本局已结束」待机态等平台下一次开始；
   *   · 这条 roundOver 还会经 PC 端转成平台的 **CMD 7 结算报文**（tools/cast-pc 的 handleRoundEnd）
   *     —— 平台据此弹本局结算。
   *
   * 为什么不用 toMenu()：toMenu() 只回菜单、**不带 roundOver** ⇒ 浏览器不关、客户端不回前台，
   *   而平台每 ~20s 会重发一次「启动游戏」⇒ 页面被叫回来时 state=menu，直接从**第 1 关**重开
   *   （现场实测：「Boss 打死后小兵还在，过一会又回到了第一关」）。
   */
  _onFinalBossClear() {
    if (this._goneHandled) return;
    // 「本局已结束，等平台下一次开始」—— 与平台明说关闭同语义：**不起复活探针**，
    // 否则探针两秒后就会把封盖撤掉、页面又回到可玩状态（那等于没收尾）。
    this._closedByPlatformCommand = true;
    // explicit=false：这是通关，不是「平台明说关闭」，留痕里别写成平台指令（排障时要能分开）。
    this._finishRound('第18关通关（魔术师 Boss 击杀）', { dead: 'round-clear', explicit: false });
  }

  /**
   * 「本局真的结束」的统一收尾（平台关闭 / 第18关通关都走它）。
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
    this.cards.clearCards();                    // 清抽卡气球（不拆除 group，可再次 open 复用）
    this._cardState = null;
    this._levelSnapshot = null;
    // 重置数值
    this.player.reset();
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
    const lv = LEVELS[i];
    this.normalTest = false; // 默认非测试；仅普通关且 NORMAL_TEST.enabled 时被 startLevel 翻为 true
    // 离开上一关时清理激光关实例与玻璃网格
    if (this.laser) { this.audio?.stopLaserHum('level'); this.laser.dispose(); this.laser = null; }
    if (this.grid) { this.grid.dispose(); this.grid = null; }
    if (this.flipGrid) { this.flipGrid.dispose(); this.flipGrid = null; }
    if (this.dragon) { this.dragon.dispose(); this.dragon = null; }
    if (this.shopDraft) { this.shopDraft.dispose(); this.shopDraft = null; } // 第五十五修：清上一关商店场地
    this._disposeOpening(); // 清上一关残留的开场动画 + 作废其语音联动（防跨关泄漏）
    if (this._buddhaFx) { this._buddhaFx.dispose(); this._buddhaFx = null; } // 清上一关残留的如来神掌特效
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
    this._pendingOpenVoice = null;  // 开场语音（L3/6/9/15/18），null=无
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
          { scaleHeight: _omCfg.scaleHeight, showSeconds: OPENING_MAGICIAN.SHOW_SECONDS }  // 目标身高(米) + 播放时长(秒)
        );
        this.openingModel.start();
      });
      // 第五十五修：商店关不再保留机制关开场语音（后续另配），只留魔术师动画；
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
      this._startLevelAudio();      // 无穿云：直接启动本关 BGM + 开场语音
    }
    // 第四十九修：关卡标题卡 —— 有云雾就在**雾里**弹（现场反馈：原先是雾散后才弹，和出怪撞在一起），
    //   无云雾退回旧口径（关卡正式开始后 DELAY 秒）。
    //   第四十九修（返工）：机制关(3/9/15)开局有魔术师开场动画，原先直接不弹 ⇒「机制关看不到关卡名」。
    //   现在按 MECHANIC_DELAY 先排一个**兜底**（语音缺失/ended 不触发也能弹），
    //   并把排期权交给开场语音：播完 → _bindOpeningVoice 里改排成「0.5s 后」（见 _levelTitleDone 防重）。
    this._levelTitleDone = false;
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
    } else if (lv.boss === 'dragon') {
      addUrl(DRAGON.HEAD_MODEL, true);            // 第12关龙 Boss 龙头 GLB（未被 main 预载）+ GPU 预热
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
    this.rightGun.update(dt, this.input, this);  // 右手柄 AK 枪 + 技能就绪提示面板（VR 手持，桌面忽略）
    this.leftSword.update(dt, this.input);        // 左手柄激光剑（VR 手持，桌面忽略）
    this._updateBuddhaFx(dt);
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
    if (!this.fx) return;
    this.fx.update(dt);
    if (!FX.TRACER.ENABLED) return;
    const tail = this.fx.tracer;
    const d = this._tailDir;
    tail.begin();
    const bullets = this.bullets.active;
    for (let i = 0; i < bullets.length; i++) {
      const b = bullets[i];
      d.copy(b.vel).normalize();
      // 第四十二修：尾迹最多拖到「出生点」(b.origin)，绝不越过枪管 ——
      //   子弹出生点在枪管内部(SHOOT.SPAWN_OFFSET)，照常拖满 LENGTH 的话，
      //   弹头刚出膛那几帧整条尾迹会穿到枪管后方（玩家反馈的「曳光延伸到枪管背后」）。
      // 第四十九修：加速弹（b.boost）曳光变蓝 + 加长一倍 —— 让「射速加速」不用看面板也能一眼看出
      tail.add(b.pos, d,
        // 第五十六修：带 tint 的特殊弹（追踪弹 / 穿甲弹）曳光也用自己的颜色，并按 trailMul 加长
        (b.tint != null) ? b.tint : (b.boost ? RAPID_FIRE.VISUAL.TRACER_COLOR : FX.TRACER.COLOR),
        b.origin ? b.pos.distanceTo(b.origin) : null,
        (b.trailMul > 1) ? b.trailMul : (b.boost ? RAPID_FIRE.VISUAL.TRACER_MUL : 1));
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
      if (this.openingModel && OPENING_MAGICIAN.FOLLOW_VOICE) { this.openingModel.dispose(); this.openingModel = null; }
      const mb = this.waves && this.waves._magicianBoss;   // 第18关：结束开场演出 → 激光阶段
      if (mb && mb.onOpeningVoiceEnd) mb.onOpeningVoiceEnd();
      // 第四十九修（返工）：机制关(3/9/15)的关卡名等到这一刻才弹 —— 魔术师刚收场，视线正前方是空的。
      //   _queueLevelTitle 内部有 _levelTitleDone 守卫，兜底那一次若已弹过就不会再弹。
      const _lvNow = LEVELS[this.levelIndex];
      if (_lvNow && isLaser(_lvNow)) this._queueLevelTitle(LEVEL_TITLE.MECHANIC_AFTER_VOICE);
    }, { once: true });
  }

  // 释放开场魔术师动画，并作废其语音联动回调（切关 / 回菜单共用）
  _disposeOpening() {
    this._openingVoiceSeq++;
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
    this.input.update(dt);
    // 测试积分键（左手 X / 桌面 G）：按一下 +TEST.ADD_SCORE，用于快速测试技能（受 SCORE_CAP 上限裁剪）
    const credit = this.input.consumeCredit();
    if (credit > 0) { this._addScore(credit); this.log(`测试 +${credit} 积分`); }
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
    this.skillCooldown = Math.max(0, this.skillCooldown - dt);
    // 第四十六修：第4关开局锁技能（提示「快使用技能」结束后解锁）—— 请求照常消费，只是丢弃，防误按后延迟触发
    if (this._skillLocked && this.waves && this.waves._scriptElapsed >= this._skillUnlockAt) {
      this._skillLocked = false;
      this.log('[技能] 解锁（第4关提示结束）');
    }
    if (this.input.consumeSkill() && !this._skillLocked && this.selectedSkill && this.skillCooldown <= 0) this._triggerSelectedSkill();
    const skillLabel = this.selectedSkill === 'buddha' ? '如来神掌'
                     : this.selectedSkill === 'lightsaber' ? '激光剑'
                     : this.selectedSkill === 'scatterburst' ? '散射强化'
                     : this.selectedSkill === 'scatter' ? '积分散射' : null;
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
      return;
    }

    // ====== 激光关：无普通敌人，仅激光气球 ======
    if (this.laserMode) {
      this._updateLaserLevel(dt, pp);
      return;
    }

    // ====== 普通关 ======
    // 气球以玩家世界位置为终点移动（所有怪追玩家）；碰飞毯区域自爆逻辑不变（见 _checkExplosions）
    this.balloons.update(dt, pp, this.world.camera);
    this._updateBasicVoice(dt); // 基础怪群体语音：数量达标播放一次，停顿后再判断
    this._updateDragonChest(dt); // 第五十修：龙族宝箱（计数窗口 → 化光点飞向玩家 → 放行抽卡）
    this.projectiles.update(dt, pp); // 投射物飞行/自旋/命中回收（玩家位置 pp = rig 头部世界坐标）
    if (this.dragon) {
      this.dragon.update(dt, pp);   // 龙 Boss：逐帧接管龙气球位置
    } else {
      this.waves.update(dt);
    }

    // 第四十二修 · 中场预警：普通关/危机关过半时弹一次「更强的敌人来袭」（每关一次）
    //   判据 = 本关时间窗(levelSecondsOf) × MID_WARNING.AT；机制关/Boss 关没有倒计时，不弹。
    //   ⚠ 第四十五修：不再排除 this.normalTest —— 它是「普通关」的代名词（NORMAL_TEST.enabled 默认开），
    //     原来那句 !this.normalTest 让**所有普通关**都跳过判定 ⇒ 横幅在现场从未出现过。
    //     机制关/Boss 关没有倒计时，由 midWarningDue(seconds<=0) 自然挡住。
    if (MID_WARNING.ENABLED) {
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

    // 气球进入4×8区域则自爆，可能伤害飞船并触发重开（龙气球为纯靶子，跳过不伤人）
    if (this._checkExplosions()) return;

    this.hud.setScore(this.score);
    this.hud.setHp(this.player.hp, this.player.maxHp);
    // 正常测试：显示"距停止补怪"倒计时，便于观察出怪曲线
    if (this.normalTest) {
      const stopAt = levelSecondsOf(this.level ? this.level.n : 0);   // 第四十一修：倒计时按关卡取（见 constants.LEVEL_SECONDS）
      this.hud.setCountdown(Math.ceil(Math.max(0, stopAt - this.waves.elapsed)));
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
      if (this._chestDue()) this._startDragonChest();
      else if (this._goldOrbs.length || this._midDraftPending) this._levelClearHeld = true;
      else if (this._draftsThisLevel > 0) {
        // 第四十七修：本关已经抽过卡（精英清场那次）→ 不再弹第二次，但关卡照常推进
        this.log('本关已抽过卡（精英清场）→ 直接进入下一关');
        this._onCardDone();
      } else this._enterCard();
    }
  }

  // 基础怪群体语音：场上存活基础怪(排除龙身部件)≥ 阈值时播放一次，停顿 PAUSE 秒后再判断
  _updateBasicVoice(dt) {
    if (!this.audio) return;
    if (this._basicVoiceTimer > 0) { this._basicVoiceTimer -= dt; return; } // 停顿中，暂不判断
    let n = 0;
    for (const b of this.balloons.list) {
      if (b.behavior === 'basic' && !b.isDragonPart && b.alive) n++;
    }
    if (n >= BASIC_VOICE.THRESHOLD) {
      if (this._basicVoiceEl) { try { this._basicVoiceEl.pause(); } catch (e) {} } // 重播前先停上一个，避免叠加
      this._basicVoiceEl = this.audio.playVoice(BASIC_VOICE.URL, BASIC_VOICE.VOLUME); // 播放一次（不循环）
      this._basicVoiceTimer = BASIC_VOICE.PAUSE; // 播放后停顿 PAUSE 秒再判断
    }
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
        this._enterCard(); // 第三关固定三张红色技能卡（如来神掌/激光剑/散射强化）
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
        this.state = 'over';
        this._roundOver = true;                 // 通关 = 本轮结束（见 _reportGameEnd）
        this._endRound('通关（翻牌关收尾）');   // cmd 5 兜底：翻牌关通关暂未实现 cmd 6 结算
        this.hud.message('通关！', '按「开始游戏」重新挑战', '#2ecc71');
        this.hud.showStart();
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
                this.bullets.release(b);
                this._spawnExplosionFx(b.pos, 0.2); // 挡弹火花
                continue; // 子弹被盾挡下，处理下一发
              }
            }
          }
        }
        const killed = hitBalloon.takeDamage(this._applyShopDamage(hitBalloon, b.dmg)); // 第五十五修：专打强者
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
      }
    }
    this.bullets.sync(); // 碰撞释放后立刻刷新实例矩阵（避免命中子弹滞留一帧）
    // 气球 vs 飞船碰撞已移除 → 改由 _checkExplosions() 处理
  }

  // 玩家 DPS = 攻击力 × 多重弹道 × 射速(发/秒)。
  // 射速取 input._gunCooldown（真实节流，随枪械模式切换）；fallback 到 GUN_MODES。
  // 若日后 fireRate 卡修复为同步 input._gunCooldown，此处自动反映。
  _playerDPS() {
    const p = this.player;
    const g = GUN_MODES[this.gunMode] || GUN_MODES.preview;
    const rate = 1000 / (this.input?._gunCooldown || g.cooldown);
    return (p?.atk || 100) * (p?.shotCount || 1) * rate;
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

  // 统一加分并钳制到 SCORE_CAP（积分上限 500）；所有 score 增量必须走这里
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
      this._addShopCoin(balloon.score);   // 第五十五修：龙部件积分同样计入商店币
        this._spawnExplosionFx(balloon.mesh.position, balloon.effectiveRadius);
        this.dragon.notifyKilled(balloon);
      }
      balloon.alive = false;
      balloon.mesh.visible = false;
      return;
    }
    // 聚宝盆：无敌，仅寿命到期死亡；结算 = 自身携带积分 + 存活期间每死一个气球 +50
    if (balloon.behavior === 'treasure') {
      const bonus = (balloon.type.baseScore || 0) + (balloon._killsDuringLife || 0) * (balloon.type.perKillScore || 0);
      this._addScore(bonus);
      this._addShopCoin(bonus);           // 第五十五修：聚宝盆积分同样计入商店币
      this.balloons.remove(balloon);
      return;
    }
    // 第四十六修：精英击杀积分 ×ELITE_FEEDBACK.SCORE_MUL（构筑生效的正反馈）
    const _killScore = balloon.isElite ? Math.round((balloon.score || 0) * ELITE_FEEDBACK.SCORE_MUL) : (balloon.score || 0);
    this._addScore(_killScore);
    this._addShopCoin(_killScore);   // 第五十五修：击杀积分等额计入商店币（以战养战再加成）
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
    // 宝箱怪：死后弹出一次选项卡（占位：暂以奖励积分代替，待 mid-level 卡片系统接入）
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

  // ====== 打击感（第四十修）======

  // 命中反馈统一入口：伤害数字 + 命中音 + 轻震动。
  //   killed=true 时不发命中音 —— 击杀那一击改由 _killFeedback 发击杀音，
  //   否则「命中 tick + 击杀 thump」会在同一帧叠在一起，反而糊。
  _damageFeedback(balloon, killed, hitPos) {
    if (!balloon) return;
    const dealt = balloon._lastDamage != null ? balloon._lastDamage : 0;
    // 档2：命中火花 —— 打在怪身上的那一点（有弹着点就用弹着点，别糊在模型中心）
    this.fx?.spark(hitPos || balloon.mesh.position);
    if (this.damageNumbers) {
      this._fxPos.copy(balloon.mesh.position);
      this._fxPos.y += (balloon.effectiveRadius || 0.5) + 0.35;   // 抬到头顶，别糊在模型里
      this.damageNumbers.spawn(this._fxPos, dealt, { key: balloon, kill: killed, elite: !!balloon.isElite });
    }
    if (!killed) {
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
  _bulletKill(balloon) {
    if (!RAPID_FIRE.ENABLED) return;
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
    if (!RAPID_FIRE.ENABLED) return;
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
    // 技能统一计费：积分不足则不放（不进冷却，可立即重试）
    if (this.score < this.player.skillCost) { this.log(`积分不足（需${this.player.skillCost}）`); return false; }
    this.score -= this.player.skillCost;
    this.hud.setScore(this.score);
    this.log('如来神掌！');
    this.audio?.playVoice('music/如来神掌.wav'); // 释放瞬间播「如来神掌」音效
    // 伤害不再瞬间全屏秒杀：改为随特效「变化(grow)/运动(move)」阶段实时结算（见 _updateBuddhaFx）
    this._buddhaHit = new Set(); // 本次神掌已命中的气球，避免被重复结算
    // 视觉：如来神掌从 START_POS 出现 → 放大 → 沿 +Z 横扫 → 停顿 → 消失
    this._buddhaFx?.dispose();
    this._buddhaFx = new BuddhaFx(this.world.scene).start(this.world.camera);
    return true;
  }

  // ====== 第三关三技能 ======
  // 选卡：仅「装备」技能（激光剑→左手柄出现），不立即释放（释放由左手柄 grip 触发 _triggerSelectedSkill）
  _applySkillCard(id) {
    this.selectedSkill = id;
    this.skillCooldown = 0;                 // 装备即就绪，可立即按手柄释放
    if (id === 'buddha') this.player.buddhaUnlocked = true;
    this.leftSword?.setEquipped(id === 'lightsaber'); // 选到激光剑→左手出现；选别的→隐藏
    const label = id === 'buddha' ? '如来神掌' : id === 'lightsaber' ? '激光剑' : id === 'scatterburst' ? '散射强化' : id;
    this.log(`已装备：${label}（按左手柄 grip 释放）`);
  }

  // 左手柄 grip/桌面 F 触发：按当前装备技能分发释放，统一冷却由 this.skillCooldown 负责
  _triggerSelectedSkill() {
    switch (this.selectedSkill) {
      case 'buddha':
        if (!this.player.buddhaUnlocked) { this.log('如来神掌尚未解锁'); return; } // 还原原语义：未解锁不放（return 不进入冷却）
        if (!this._doBuddha()) return; // 积分不足 → 不进入冷却，可立即重试
        break;
      case 'lightsaber':
        if (!this._castLaserSword()) return; // 积分不足 → 不进入冷却，可立即重试
        break;
      case 'scatterburst':
        if (!this._castScatterBurst()) return; // 积分不足 → 不进入冷却，可立即重试
        break;
      case 'scatter':
        if (!this._castScatter()) return; // 积分不足 → 不进入冷却，可立即重试
        break;
    }
    this.skillCooldown = this._skillCdTotal();
  }
  _skillCdTotal() {
    // 第五十五修：商店关「技能冷却-」叠加生效（只影响总冷却口径；下限 SHOP.CD_FLOOR 防 0 冷却）
    const _down = this.player.skillCdDown || 0;
    if (this.selectedSkill === 'buddha') return Math.max(SHOP.CD_FLOOR, BUDDHA.COOLDOWN - _down);
    if (this.selectedSkill === 'lightsaber') return Math.max(SHOP.CD_FLOOR, LASER_SWORD.COOLDOWN - _down);
    if (this.selectedSkill === 'scatterburst') return Math.max(SHOP.CD_FLOOR, SCATTER_BURST.COOLDOWN - _down);
    if (this.selectedSkill === 'scatter') return Math.max(SHOP.CD_FLOOR, SCATTER.COOLDOWN - _down);
    return 0;
  }

  // 积分散射（默认技能）：消耗 player.skillCost 积分，从枪口喷出 COUNT 弹头，轴向 DIST 米铺成半径 RADIUS 圆盘
  _castScatter() {
    if (this.score < this.player.skillCost) { this.log(`积分不足（需${this.player.skillCost}）`); return false; }
    this.score -= this.player.skillCost;
    this.hud.setScore(this.score);
    const muzzle = new THREE.Vector3();
    const dir = new THREE.Vector3();
    this.input.getMuzzle(muzzle, dir); // 右手柄位姿（无则回退相机）
    // 以瞄准方向 dir 为轴建正交基：right ⊥ dir（水平），up = right × dir
    const right = new THREE.Vector3().crossVectors(dir, _WORLD_UP).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    const dmg = (SCATTER.DAMAGE > 0 ? SCATTER.DAMAGE : this.player.atk) * this.player.skillDamageMul;
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
    this.log(`积分散射！消耗${this.player.skillCost}积分，喷出${SCATTER.COUNT}弹头`);
    return true;
  }

  // 散射强化（第3关技能卡，一次性）：消耗 player.skillCost 积分，喷出 SCATTER_BURST.COUNT 发、每发 SCATTER_BURST.DAMAGE（×倍率）
  _castScatterBurst() {
    if (this.score < this.player.skillCost) { this.log(`积分不足（需${this.player.skillCost}）`); return false; }
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
    this.log(`散射强化！消耗${this.player.skillCost}积分，喷出${n}弹头`);
    this.selectedSkill = 'scatter'; // 一次性技能：用后回落到默认积分散射（避免空技能）
    return true;
  }

  // 激光剑：消耗 player.skillCost 积分，激活左手柄「5秒伤害状态」。期间左手自由挥动，剑刃线段扫过怪物即扣血，
  // 每只怪 1 秒内只受一次（限频在 _updateSwordMelee 内）。伤害穿透脸谱95%减伤。
  _castLaserSword() {
    // 已激活时拒绝重复释放：否则 setActive(true) 会把放大动画重置回「短剑」（表现为砍一刀就缩回、还白扣积分）
    if (this.leftSword.active) { this.log('激光剑已激活'); return false; }
    if (this.score < this.player.skillCost) { this.log(`积分不足（需${this.player.skillCost}）`); return false; }
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
    const finished = this._buddhaFx.update(dt);
    // 仅在「变化/运动」阶段结算伤害：掌图作横扫墙，只命中其当前位置附近命中盒内的敌人（不再全屏秒杀）
    const fx = this._buddhaFx;
    if (fx.isDamaging) {
      // 如来神掌伤害 = 固定 BUDDHA.DAMAGE（×skillDamageMul 倍率）；对精英怪有效（命中循环无 isElite 排除）
      const dmg = BUDDHA.DAMAGE * this.player.skillDamageMul;
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
          this._buddhaQueue.push({ b, dmg });
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
  }

  _clearExplosions() {
    for (const exp of this._explosions) {
      this.world.scene.remove(exp.mesh);
      exp.mesh.geometry.dispose();
      exp.mesh.material.dispose();
    }
    this._explosions = [];
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

  // ====== 第五十修 · 第12关·龙族宝箱 ======

  /** 现在该不该开宝箱：第12关（龙 Boss）已清 && 本关还没开过（口径见 constants.DRAGON_CHEST） */
  _chestDue() {
    if (!DRAGON_CHEST.ENABLED || this._chestDone) return false;
    if (!this.dragon) return false;                       // 只有龙 Boss 关才结算宝箱
    const lv = LEVELS[this.levelIndex];
    return !!lv && lv.n === DRAGON_CHEST.LEVEL;
  }

  /** 宝箱窗口（计数/飞行）是否正在跑 —— 跑着时别去开抽卡 */
  _chestRunning() { return !!(this._chest && this._chest.running); }

  /** 打开宝箱窗口（实例懒建；名字「龙族宝箱」在箱下、加成数值在箱上，见 dragonChest.js） */
  _startDragonChest() {
    if (!this._chest) this._chest = new DragonChest(this.world.scene);
    this._chestDone = true;                               // 先置位：本关只开一次
    this._chest.start();
    this.log('龙族宝箱出现：' + DRAGON_CHEST.WINDOW + ' 秒内越会打，攻击力加成越高');
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
    const r = DRAGON_CHEST.HIT_R;
    const center = c.group.position;
    const list = this.bullets.active;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (_pointSegDistSq(center, b.prevPos, b.pos) >= r * r) continue;
      this.bullets.release(b);
      c.punch();
      this.fx?.spark(b.pos, DRAGON_CHEST.HIT_SPARK);
      this.audio?.playHit();
      this._pulseHaptic('HIT');
    }
  }

  /** 每帧推进宝箱；光点落地（'done'）→ 兑现攻击力加成 → 下一帧自然放行通关抽卡 */
  _updateDragonChest(dt) {
    if (!this._chest || !this._chest.running) return;
    this._chestHitTest();
    if (this._chest.update(dt, this.world.camera) !== 'done') return;
    const bonus = this._chest.bonus || 0;
    if (bonus > 0) {
      this.player.atk += bonus;
      this.log('龙族宝箱：攻击力 +' + bonus + '（窗口内 ' + this._chest.bullets + ' 发 → ' + this.player.atk + '）');
    } else {
      this.log('龙族宝箱：窗口内 0 发 → 无加成');
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
    this._midDraftPending = false;
    this._levelClearHeld = false;
    this._draftsThisLevel = 0;   // 第四十七修：一关一次（见 _enterCard / 通关分支）
    this._levelTitleAt = 0;       // 第四十九修：切关立即作废未弹的标题卡（新关卡会重新排一个）
    this._levelTitleText = null;
    this._levelTitleDone = false;
    // 第五十修：龙族宝箱（切关/重开/回菜单都要收起，否则宝箱会跨关留着）
    this._chest?.hide();
    this._chestDone = false;
  }

  /** 精英批次清空 → 金点从准星前方飞向选项卡位置（CARD 的固定世界坐标）→ 消失并弹出三张选项卡 */
  _goldToCards() {
    if (!GOLD_ORB.ENABLED) { this._enterMidCard(); return; }
    this.audio?.playEliteWipe();
    const from = new THREE.Vector3();
    this.world.camera.getWorldPosition(from);
    const dir = new THREE.Vector3();
    this.world.camera.getWorldDirection(dir);
    dir.negate();                       // 相机前向是 -Z（getWorldDirection 给 +Z，同 _enterCard 的处理）
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

  _enterCard(mid = false) {
    if (this.shopMode) { this.log('商店关不发选项卡，直接进入下一关'); this._exitShop(); return; } // 第五十五修
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
      // 第三关：固定三张技能卡（如来神掌/激光剑/散射强化）
      plan = { fixedSkills: ['buddha', 'lightsaber', 'scatterburst'] };
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
      // 普通/危机关：抽 1–5 池（射速/子弹/攻击/技能消耗/技能伤害）
      plan = { pool: ['fireRate', 'multiShot', 'atk', 'skillCost', 'skillDamage'] };
      if (lv.n === 1) plan.guarantee = 'multiShot';    // 01 关：额外子弹必出
      else if (lv.n === 2) plan.guarantee = 'fireRate'; // 02 关：射速必出
    }

    this._cardState = {
      player: this.player,
      // score 访问解耦：注入回调，cardDraft 不再反向持有 game 实例
      getScore: () => this.score,
      spendScore: (cost) => { this.score -= cost; },
      pool: plan.pool || null,                 // 普通/Boss/机制关：属性卡池（抽 3 不重复）
      guarantee: plan.guarantee || null,        // 必出卡：01/02 关单卡；第9关回血组（数组，取第一张可用）
      fixedSkills: plan.fixedSkills || null,    // 第三关：固定技能卡
      onSkill: (id) => this._applySkillCard(id),
      onCollect: (id) => this._collectedCards.push(id), // 本局收集：供第18关汇总
    };
    this.hud.message('选择强化', '射击对应气球进行选择（3 选 1）', '#ffd43b');
    this.cards.open(pp, this._fwd.clone(), this._cardState, () => (mid ? this._onMidCardDone() : this._onCardDone()));
  }

  // 第18关通关：汇总本局获得的所有选项卡并展示，随后进入通关结算
  _showRunSummary() {
    const counts = {};
    for (const id of this._collectedCards) counts[id] = (counts[id] || 0) + 1;
    const nameOf = (id) => {
      const s = SKILL_CARDS.find(c => c.id === id);
      const a = ATTR_TYPES.find(c => c.id === id);
      return (s && s.label) || (a && a.label) || id;
    };
    const lines = Object.entries(counts).map(([id, n]) => `${nameOf(id)}×${n}`);
    const text = lines.length ? lines.join('  ·  ') : '（本局未获得强化）';
    this.log('本局获得强化：\n' + text);
    this.state = 'over';
    this.hud.message('通关！本局强化', text, '#2ecc71');
    this.hud.showStart();
  }

  // 抽卡模式：允许自由移动 + 射击，子弹命中卡气球即选卡
  _updateCard(dt) {
    this.input.update(dt);
    // 测试积分键（左手 X / 桌面 G）：抽卡阶段也可加分，方便直接测试刚选的技能
    const credit = this.input.consumeCredit();
    if (credit > 0) { this._addScore(credit); this.log(`测试 +${credit} 积分`); }
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
    // 第3关（首个激光/机制关）选完技能后赠送 500 积分（受上限钳制），便于立即释放激光剑（消耗 500）
    const _cleared = LEVELS[this.levelIndex]; // 此刻 levelIndex 仍是刚清的关（下方才 ++）
    if (_cleared && _cleared.n === 3) { this._addScore(500); this.log('第3关奖励：+500 积分'); }
    this.hud.setScore(this.score); // game.score 已由抽卡实时维护
    this.hud.clearMessage();
    this.levelIndex++;
    if (!this.player.buddhaUnlocked) this.player.buddhaUnlocked = true; // 首波后解锁大招
    this.log('强化完成 → 进入下一关');
    if (this.levelIndex >= LEVELS.length) {
      this.state = 'over';
      VRPlusGame.terminate();   // cmd 5 兜底：抽卡关通关暂未实现 cmd 6 结算
      this.hud.message('通关！', '按「开始游戏」重新挑战', '#2ecc71');
      this.hud.showStart();
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

  /** 玩家是否已拥有「三选一」技能（默认的积分散射不算 —— 正前方要卖技能本体） */
  _hasChosenSkill() { return !!this.selectedSkill && this.selectedSkill !== 'scatter'; }

  _itemLevel(id) { return (this._itemLv && this._itemLv[id]) || 0; }

  /** 商店币入账：击杀积分等额 +「以战养战」加成（无上限；一局结束清零） */
  _addShopCoin(n) {
    const v = Math.round(n || 0);
    if (!v) return;
    this.shopCoin += Math.round(v * warFeedMul(this._itemLevel('warFeed')));
    this.hud.setShopCoin(this.shopCoin);
  }

  /** 建商店场地（由 _loadLevel 的分帧任务调用，位置与 LaserLevel 相同） */
  _enterShop() {
    this.shopDraft = new ShopDraft(this.world.scene);
    this.shopDraft.open(this._playerPos(), {
      getShopCoin: () => this.shopCoin,
      spendShopCoin: (c) => { this.shopCoin = Math.max(0, this.shopCoin - c); this.hud.setShopCoin(this.shopCoin); },
      hasSkill: () => this._hasChosenSkill(),
      getItemLevels: () => this._itemLv,
      // 第五十六修：第 3 关商店价格减半（技能本体/强化/道具；刷新价不变）
      priceMul: () => (LEVELS[this.levelIndex] && LEVELS[this.levelIndex].n === 3) ? SHOP.LEVEL3_PRICE_MUL : 1,
      onBuySkill: (id) => this._applySkillCard(id),
      onBuyUpgrade: (id) => this._applySkillUpgrade(id),
      onBuyItem: (id) => this._buyShopItem(id),
      // 第五十七修：右手边「精英预告」卡要知道本店是第几关（决定预告窗口）
      shopLevel: LEVELS[this.levelIndex].n,
      onDenied: (msg) => this.midWarning?.show(msg),
    });
    this.hud.setShopCoin(this.shopCoin);
    this.hud.showShopCoin(true);
    this._warmShopPortraits();   // 第五十七修 v2：预告卡立绘（异步逐张换图，不挡进店）
    this.hud.message('商店关 · 魔术空间', `射击气球购买 · 打「购物完成」可提前离开（${SHOP.COUNTDOWN}s）`, '#ffd43b');
    this.log(`第 ${LEVELS[this.levelIndex].n} 关 · 商店关：正前方技能区 / 左手边道具区（商店币 ${this.shopCoin}）`);
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
      Promise.resolve(portraitCanvas(renderer, spec)).then((cv) => {
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
    if (lv && lv.n === 3) { this._addScore(500); this.log('第3关奖励：+500 积分'); }  // 保留原「选完技能赠 500」
    this.log('商店关结束 → 进入下一关');
    this.levelIndex++;
    if (!this.player.buddhaUnlocked) this.player.buddhaUnlocked = true; // 与抽卡分支同口径
    if (this.levelIndex >= LEVELS.length) {
      // 商店关在 3/9/15，走不到这里；照抄抽卡分支的保底口径
      this.state = 'over';
      this._roundOver = true;
      this._endRound('通关');
      this.hud.message('通关！', '按「开始游戏」重新挑战', '#2ecc71');
      this.hud.showStart();
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
      this.log(`技能消耗-：技能消耗 ${this.player.skillCost} 积分`);
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
    let n = 0;
    for (const shot of this.input.shots) n += this.player.fire(shot, this.bullets, this.audio, boost);
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

  // 正常测试通关：停止补怪后场上清空即达成。与 _gameOver 对称，但为绿色胜利提示。
  _testWin() {
    this.state = 'over';
    this._roundOver = true;              // 通关 = 本轮结束（见 _reportGameEnd）
    this._endRound('全部消灭（通关）');   // cmd 5 兜底：通关暂未实现 cmd 6 结算，先按中途结束上报
    this.log('全部消灭，通关！');
    this.balloons.clear();
    this.projectiles.clear(); // 通关清投射物
    this.vignette.clear();
    this.bullets.clear();
    this.hud.clearCountdown();
    this.hud.message('通关！', `得分 ${this.score} · 按「开始游戏」重新挑战`, '#2ecc71');
    this.hud.showStart();
  }
}
