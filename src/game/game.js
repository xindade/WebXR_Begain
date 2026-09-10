import * as THREE from 'three';
import { Player } from './player.js';
import { BalloonManager } from './balloons.js';
import { ShurikenManager } from './shurikens.js';
import { BulletManager } from './bullets.js';
import { WaveManager } from './waves.js';
import { CardDraft } from './cardDraft.js';
import { LaserLevel } from './laser.js';
import { GlassGrid } from './glassGrid.js';
import { FlipGrid } from './flipGrid.js';
import { RightGun } from '../vr/rightGun.js';
import { LeftSword } from '../vr/leftSword.js';
import { DragonBoss } from './dragonLevel.js';
import { CloudFx } from './cloudFx.js';
import { OpeningModel } from './openingModel.js';
import { Portal } from './portal.js';
import { BuddhaFx } from './buddhaFx.js';
import { LEVELS, isLaser, isBoss } from '../content/levels.js';
import { ENEMY_TYPES } from '../content/enemies.js';
import { ELITE_SCHEDULE } from '../content/eliteMonsters.js';
import { LEVEL_PLANS, LEVEL_ENEMY } from '../content/spawnPlans.js';
import { ATTR_TYPES, SKILL_CARDS } from '../content/cards.js';
import { BALLOON, BUDDHA, SHIP, SHOOT, LASER, GRID, FLIP, MOVE, EXPLOSION, SKY_PANORAMA, DEPTH_SPRITE_STRESS, DEPTH_SPRITE_TYPES, NORMAL_TEST, DDA, FACE_BOSS, PORTAL, SPAWN_RING, GUN_MODES, SCATTER, SCATTER_BURST, LASER_SWORD, BOSS_BGM, CLOUD, SCORE_CAP, DRAGON, OPENING_MAGICIAN, BASIC_VOICE, MAGICIAN_BOSS } from '../core/constants.js';
import { setRenderer, loadBalloonModel, preCaptureDepthSprite } from './balloonModels.js';
import { DifficultyController } from './difficultyController.js';

const KIND_NAME = { normal: '普通关', crisis: '危机关', bonus: '奖励关', boss: 'Boss关', laser: '激光关' };
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

export class Game {
  constructor(world, hud) {
    this.world = world;
    this.hud = hud;
    setRenderer(world.renderer); // 注入 renderer，供 DepthSprite 离屏捕获 GLB

    // DepthSprite 深度调试：按 D 把立绘切到「深度灰度视图」（中心亮=凸，边缘亮=凹）
    window.addEventListener('keydown', (e) => {
      if (e.key === 'd' || e.key === 'D') {
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
    this.shurikens = new ShurikenManager(world.scene); // 忍者气球投掷物管理器
    this.balloons.setShurikenManager(this.shurikens);  // 让气球系统驱动「最近忍者投掷」
    this.shurikens.setOnHit((d) => this.player.takeDamage(d)); // 命中扣飞船血量（飞毯无独立 HP）
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
      () => this.toMenu()                  // 新：通关横幅 10s 后自动退出游戏
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
    this.openingModel = null;  // 第3/9/15关开场动画模型（魔术师动画版），10秒后自动移除
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
    this.enemyFreeze = 0;        // 定身咒计时(s)：>0 时敌人暂停行动（Boss 仅前 50% 时长）
    this.selectedSkill = 'scatter'; // 当前装备技能：前期默认「积分散射」；第三关选卡后可替换为 lightsaber/freeze/buddha，左手柄 grip 触发
    this.skillCooldown = 0;      // 技能释放冷却计时(s)：>0 时握柄无效，HUD 显示剩余

    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._camPos = new THREE.Vector3(); // 每帧刷新相机世界坐标，供 2D 立绘薄板命中(法线=朝相机)
    this.attackBonus = 0;       // 死亡重开攻击力加成（每次 +50，可累计）；归零于 start()/toMenu()
    this._attackHint = null;    // 面前 2m 文字提示精灵（攻击力 +50），2 秒后淡出
    this._basicVoiceTimer = 0;  // 基础怪语音停顿倒计时(s)：>0 时暂停判断（播放后停顿 PAUSE 秒）
    this._basicVoiceEl = null;  // 当前播放的基础怪语音元素（重播前先暂停上一个，避免叠加）
  }

  setSystems(audio, input, wristUI = null, pageLog = null) {
    this.audio = audio; this.input = input; this.wristUI = wristUI; this.pageLog = pageLog;
    this.leftSword.setAudio(this.audio); // 注入音效管理器，供激光剑嗡鸣随剑出现/消失
    this.waves.audio = audio; // 注入音频到波次管理器（脸谱Boss 召唤语音用）
    this.shurikens.setAudio(this.audio); // 注入音频，供手里剑投掷/命中音效
  }

  // 游戏内日志：同时送往左手腕面板（VR 可见）和页面日志（预览可见、最高优先）
  log(msg) {
    this.wristUI?.log(msg);
    this.pageLog?.log(msg);
  }

  start(atIndex = 0, gunMode = 'preview') {
    this.gunMode = gunMode;
    this.player.reset(gunMode);
    this.input?.setGunMode(gunMode);
    this.player.input = this.input; // 让射速卡能触达真实节流源（input.setFireRateMul）
    this.balloons.clear();
    this.shurikens.clear(); // 清忍者投掷物（与气球一并复位）
    this.bullets.clear();
    this.score = 0;
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
    this.attackBonus = 0;     // 新一局：攻击力加成重置，从 0 重新累计
    this._clearAttackHint();  // 清残留攻击力提示
    this.log('游戏开始');
    this._loadLevel(this.levelIndex);
    this.state = 'playing';
  }

  // 回到「未开始」状态：供 sessionend 调用，使再次进入 VR 时 sessionstart 守卫生效、从干净状态开局
  toMenu() {
    this.state = 'menu';                       // 关键：让 sessionstart 的 game.start 守卫重新生效
    // 释放关卡专属实例（沿用 _loadLevel 头部写法）
    if (this.laser)    { this.audio?.stopLaserHum('level'); this.laser.dispose();    this.laser = null; }
    if (this.grid)     { this.grid.dispose();     this.grid = null; }
    if (this.flipGrid) { this.flipGrid.dispose(); this.flipGrid = null; }
    if (this.dragon)   { this.dragon.dispose();   this.dragon = null; }
    if (this.cloudFx) { this.cloudFx.dispose(); this.cloudFx = null; } // 清穿云特效
    if (this.openingModel) { this.openingModel.dispose(); this.openingModel = null; } // 清开场动画（防回菜单残留）
    this.world._restoreFade(); // 恢复穿云淡入改写的材质（防回菜单残留半透明）
    this._introActive = false; this._introT = 0; // 复位开场门控
    this._introPreloadQueue = null; this._introPreloadIdx = 0; // 复位预载队列
    this._clearPortals(); // 清传送门装饰（防跨关/回菜单残留）
    this.waves.clearPending();   // 清出怪光点（防回菜单残留）
    // 清理实体
    this.balloons.clear();
    this.shurikens.clear(); // 清忍者投掷物（回菜单一并清理）
    this.bullets.clear();
    this._clearExplosions();
    if (this._buddhaFx) { this._buddhaFx.dispose(); this._buddhaFx = null; }
    this.cards.clearCards();                    // 清抽卡气球（不拆除 group，可再次 open 复用）
    this._cardState = null;
    this._levelSnapshot = null;
    // 重置数值
    this.player.reset();
    this.score = 0;
    this.attackBonus = 0;     // 回菜单清零攻击力加成
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
    const lv = LEVELS[i];
    this.normalTest = false; // 默认非测试；仅普通关且 NORMAL_TEST.enabled 时被 startLevel 翻为 true
    // 离开上一关时清理激光关实例与玻璃网格
    if (this.laser) { this.audio?.stopLaserHum('level'); this.laser.dispose(); this.laser = null; }
    if (this.grid) { this.grid.dispose(); this.grid = null; }
    if (this.flipGrid) { this.flipGrid.dispose(); this.flipGrid = null; }
    if (this.dragon) { this.dragon.dispose(); this.dragon = null; }
    if (this.openingModel) { this.openingModel.dispose(); this.openingModel = null; } // 清上一关残留的开场动画（防跨关泄漏）
    if (this._buddhaFx) { this._buddhaFx.dispose(); this._buddhaFx = null; } // 清上一关残留的如来神掌特效
    this._clearPortals(); // 清上一关残留的传送门装饰
    this.waves.clearPending();   // 清上一关残留出怪光点（防光点飞到新关卡）
    this.gridPhase = false;
    this.flipPhase = false; this.flipTimer = 0;
    this._lastCell = 0;
    this._firstCardOfLevel = true;   // 每关首次抽卡才强制攻击紫（02关）
    this.balloons.clear();      // 防跨关残留气球（脸谱 Boss 装饰等）
    this.shurikens.clear();     // 防跨关残留手里剑
    this.bullets.clear();        // 防跨关残留子弹误击
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
    this.player.forceSingleShot = isLaser(lv);
    if (isLaser(lv)) {
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

    // 第3/9/15关开头：世界固定点播放在「魔术师动画版」模型，循环播放 10 秒后自动消失。
    // 穿云期间(this._introActive)由 _updatePlaying 冻结其 update（不推进动画/计时），结束后才播放满 10 秒。
    // 模型经 glbCache 共享缓存、main.js 已预加载，进关即瞬时出现；淡入由穿云 extendFadeRoots 差集自动捕获。
    if (lv.n === 3 || lv.n === 9 || lv.n === 15) {
      const _omCfg = OPENING_MAGICIAN[lv.n];   // 第3/9/15关开场魔术师模型配置（位置/缩放见 constants.OPENING_MAGICIAN）
      this.openingModel = new OpeningModel(
        this.world.scene,
        new THREE.Vector3(..._omCfg.pos),       // 模型根节点世界坐标（米：X右/Y上/Z前为负=玩家前方）
        { scaleHeight: _omCfg.scaleHeight, showSeconds: OPENING_MAGICIAN.SHOW_SECONDS }  // 目标身高(米) + 播放时长(秒)
      );
      this.openingModel.start();
      // 激光关开头语音：延迟到穿云结束后再播（雾气转场期间不播语音）
      if (lv.n === 3) this._pendingOpenVoice = 'music/魔法师激光阵语音.wav';
      else if (lv.n === 9) this._pendingOpenVoice = 'music/魔法师玻璃格子.wav';
      else if (lv.n === 15) this._pendingOpenVoice = 'music/魔法师九宫格.wav';
    } else if (lv.n === 18) {
      // 第18关 Boss 开头语音：延迟到穿云结束后再播
      this._pendingOpenVoice = 'music/魔术师Boss开头.wav';
    } else if (lv.n === 6) {
      // 第6关开局只播蓝色脸谱「儿郎冲锋」；红/黑阶段语音由脸谱Boss相位切换时播
      this._pendingOpenVoice = 'music/儿郎冲锋.mp3';
    }

    // 快照场景子节点：稍后取差集即可自动采集「本关新建的场景物体」（穿云淡入用）
    const _sceneBefore = new Set(this.world.scene.children);
    this._fadeSceneBefore = _sceneBefore;   // 存到实例：云雾期间每帧据此补登记异步加载完成的物体

    // 小怪关（非 boss、非激光机制）：按本关方向表生成传送门装饰（自带动画+上下浮动）
    if (!isBoss(lv) && !isLaser(lv)) this._spawnPortals(lv);
    if (isLaser(lv)) {
      this.laserMode = true;
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
    } else {
      this.laserMode = false;
      if (lv.boss === 'dragon') {
        // 第十二关：龙 Boss（龙头 GLB + 龙身/龙爪气球沿动画路径移动）
        this.dragon = new DragonBoss(this.world.scene, this.balloons);
        this.dragon.audio = this.audio; // 注入音效，连爆时播放
        this.dragon.start();
        this.log(`第 ${lv.n} 关 · 龙 Boss：击破龙身/龙爪气球（打爆即复活，血量清零才击杀）`);
      } else {
        this.waves.startLevel(lv);
        // 正常测试模式：覆盖普通关出怪曲线，独占出怪（避免与压测阵列冲突）
        this.normalTest = (this.waves.mode === 'normalTest');
        if (DEPTH_SPRITE_STRESS > 0 && !NORMAL_TEST.enabled) this._spawnStress(DEPTH_SPRITE_STRESS);
        this.log(`第 ${lv.n} 关 · ${KIND_NAME[lv.kind]}`);
      }
    }
    // 非激光关在关卡加载完成后拍照快照（用于死亡重开时恢复属性+分数）
    if (!isLaser(lv)) this._snapshotState();

    // ====== 关卡开场穿云（每关都跑：遮蔽加载卡顿 + 平滑过渡）======
    // 在场景(天空/传送门/激光几何/龙)已构建后触发；INTRO_DELAY 秒内冻结出怪与 Boss/机制动画。
    // 采集本关新建的场景物体（与开头快照的差集）：传送门 / 激光几何 / 玻璃格 / 龙 等
    const _fadeRoots = this.world.scene.children.filter((o) => !_sceneBefore.has(o));
    if (CLOUD.ENABLED) {
      this._introActive = true;
      this._introT = 0;
      this.world.setFadeRoots(_fadeRoots);  // 登记淡入材质：一次性切 transparent，从全透明开始
      if (this.cloudFx) this.cloudFx.dispose();   // 死亡重开等复用场景：先清旧云
      this.cloudFx = new CloudFx(this.world.scene);
      this.cloudFx.start(this.world.camera, this.rig);
      this.world.setEnvOpacity(0);  // 环境(天空/地面/星空)从全透明开始，随云雾动画 0→1 淡入
    } else {
      this._introActive = false;
      this.world._restoreFade();    // 无穿云：确保无残留半透明材质
      this.world.setEnvOpacity(1);  // 无穿云：场景直接满显
      this._startLevelAudio();      // 无穿云：直接启动本关 BGM + 开场语音
    }

    // ====== 关卡开场「雾气窗顺序预载」======
    // 把本关要用的敌人/装饰 GLB 模型 + DepthSprite 捕获，分散到 INTRO_DELAY 秒穿云窗内「每帧处理 1 个」，
    // 避免「首只怪出生时」一次性解码/抓帧导致的尖峰卡顿（穿云遮蔽下不可见）。
    // 无穿云(CLOUD.ENABLED=false)时立即同步预载，保证效果不丢。
    this._introPreloadIdx = 0;
    this._introPreloadQueue = this._buildIntroPreloadQueue(lv);
    if (!CLOUD.ENABLED && this._introPreloadQueue.length) {
      for (const it of this._introPreloadQueue) {
        if (it.url) loadBalloonModel(it.url);
        if (it.capture) preCaptureDepthSprite(it.url, it.radius);
      }
      this._introPreloadQueue = null;
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
      q.push({ url: t.model, radius: t.radius || 0.5, capture: DEPTH_SPRITE_TYPES.includes(typeId) });
    };
    const addUrl = (url) => { if (url) q.push({ url, radius: 1.0, capture: false }); };

    if (lv.boss === 'face') {
      // 第6关脸谱 Boss：穿云窗内预热三张脸谱 + 旗子 + 蓝阶段小怪 GLB，
      // 并把「黑阶段分身」的 DepthSprite 抓帧也提前到这里 —— 抓帧 = 12 帧离屏渲染 + readRenderTargetPixels
      // 同步回读，非常重；原先等红→黑切换那一刻才首次抓帧，正是切换卡顿的主因。
      for (const url of FACE_BOSS.MODELS) addUrl(url);
      addUrl(FACE_BOSS.FAN_MODEL);
      addUrl(ENEMY_TYPES.flagMask.model);
      addType('basic');   // 蓝阶段 3×3 小怪 GLB + 立绘抓帧
      addType('knight');  // 蓝阶段中心格骑士
      q.push({ url: FACE_BOSS.BLACK_CLONE_MODEL, radius: ENEMY_TYPES.blackMaskClone.radius, capture: true });
    } else if (lv.boss === 'dragon') {
      addUrl(DRAGON.HEAD_MODEL);                  // 第12关龙 Boss 龙头 GLB（未被 main 预载）
      addType('basic');  addType('ninja');       // 龙 Boss 召唤用基础怪/忍者 GLB + DepthSprite 立绘：进关预载，避免首召冷加载卡顿
    } else if (lv.boss === 'magician') {
      // 第18关魔术师 Boss：三阶段召唤物（25 小怪 / 5 忍者 / 10 骑士）的 GLB + DepthSprite 立绘抓帧
      // 全部在穿云窗内预热 —— 抓帧 = 12 帧离屏渲染 + readRenderTargetPixels 同步回读，非常重；
      // 原先本关没有预载分支，导致阶段召唤瞬间才首次抓帧，正是「召唤时明显卡顿」的主因。
      addType('basic');
      addType('ninja');
      addType(MAGICIAN_BOSS.SUMMON.GLASS_KNIGHT_TYPE || 'eliteKnight');
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
    if (it.url) loadBalloonModel(it.url);                  // 进 glbCache，首只怪克隆零等待
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
    this.rig.position.y = 0;
  }

  // 重设「物理场地 ↔ 游戏区域」映射基准：rig 归零 ⇒ XR 原点即游戏区域中心。
  // 仅【回菜单】（一局结束、重设基准）时调用；重生 / 过场一律不调，否则会把玩家从原位拉走。
  // （JOYSTICK=0 纯现实行走时 rig 水平位置恒为 0，此调用等价于只把高度拉回 0。）
  _resetPlayerOrigin() {
    this.rig.position.set(0, 0, 0);
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
    if (this.openingModel && !this._introActive) this.openingModel.update(dt); // 开场动画模型：推进动画 + 10秒计时（穿云时冻结）
    const pp = this._playerPos();                     // 取一次玩家位置，所有门共用（同步读取，无异步滞留）
    this._portals.forEach((p) => p.update(dt, pp));   // 传送门动画 + 浮动 + 摇杆偏移 + 数值标签
    this.wristUI?.update(dt, this, this.input); // 手腕面板（VR 下显示，桌面忽略）
    this.rightGun.update(dt, this.input, this);  // 右手柄 AK 枪 + 技能就绪提示面板（VR 手持，桌面忽略）
    this.leftSword.update(dt, this.input);        // 左手柄激光剑（VR 手持，桌面忽略）
    this._updateBuddhaFx(dt);
    this._updateExplosions(dt);
    this._updateAttackHint(dt);   // 推进攻击力提示淡出/移除（2 秒后消失）

    if (this.state === 'playing') this._updatePlaying(dt);
    else if (this.state === 'card') this._updateCard(dt);
    // 通关横幅（魔术师Boss）：始终驱动，10s 后自动退出（不依赖关卡/抽卡状态）
    if (this.waves && this.waves._winBanner) this.waves._winBanner.update(dt);
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
    if (this._pendingOpenVoice) this.audio?.playVoice(this._pendingOpenVoice);
    this._pendingBgm = null;
    this._pendingOpenVoice = null;
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
    // ====== 关卡开场穿云：INTRO_DELAY 秒内冻结玩法（不移动/不开火/不触发技能），仅自然转头观察 ======
    if (this._introActive) {
      this._introT += dt;
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
    this.bullets.update(dt);
    const pp = this._playerPos();

    for (const shot of this.input.shots) this.player.fire(shot, this.bullets, this.audio);

    // 选中技能：冷却递减；左手柄 grip(或桌面 F)请求释放 → 冷却就绪则触发
    this.skillCooldown = Math.max(0, this.skillCooldown - dt);
    if (this.input.consumeSkill() && this.selectedSkill && this.skillCooldown <= 0) this._triggerSelectedSkill();
    const skillLabel = this.selectedSkill === 'buddha' ? '如来神掌'
                     : this.selectedSkill === 'lightsaber' ? '激光剑'
                     : this.selectedSkill === 'scatterburst' ? '散射强化'
                     : this.selectedSkill === 'scatter' ? '积分散射' : null;
    this.hud.setSkill(skillLabel, this.skillCooldown, this._skillCdTotal());

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

    // ====== 激光关：无普通敌人，仅激光气球 ======
    if (this.laserMode) {
      this._updateLaserLevel(dt, pp);
      return;
    }

    // ====== 普通关 ======
    // 气球以玩家世界位置为终点移动（所有怪追玩家）；碰飞毯区域自爆逻辑不变（见 _checkExplosions）
    this.balloons.update(dt, pp, this.world.camera);
    this._updateBasicVoice(dt); // 基础怪群体语音：数量达标播放一次，停顿后再判断
    this.shurikens.update(dt, pp); // 手里剑飞行/自旋/命中回收（玩家位置 pp = rig 头部世界坐标）
    if (this.dragon) {
      this.dragon.update(dt, pp);   // 龙 Boss：逐帧接管龙气球位置
    } else {
      this.waves.update(dt);
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
      const stopAt = SPAWN_RING.enabled ? SPAWN_RING.stopAt : NORMAL_TEST.stopAt;
      this.hud.setCountdown(Math.ceil(Math.max(0, stopAt - this.waves.elapsed)));
    }

    if (!this.player.alive) { this._restartLevel(); return; }
    const cleared = this.dragon ? this.dragon.cleared : this.waves.cleared;
    // 第18关魔术师Boss：通关横幅激活期间不走抽卡，改由横幅 10s 计时自动退出
    if (cleared && !(this.waves && this.waves._winBanner)) { this._enterCard(); }
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
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      // 玻璃墙拦截（第18关魔术师Boss 玻璃墙阶段）：命中墙 → 消费/拦截子弹，不进气球循环
      if (this.waves.magicianGlassWall && this.waves.magicianGlassWall.tryBlock(b)) {
        this.bullets.release(b);
        continue;
      }
      const list = this.balloons.list;
      // Boss 代理命中球半径较大(4m)且常位于其他可击破目标(九宫格球/精英)的正后方，
      // 若按 list 顺序优先判定会「抢走」本应命中前方目标的子弹 → 表现为「打小怪掉 Boss 血」。
      // 两遍命中：pass0 只判非 Boss 目标(最高优先)，仅当无命中时才在 pass1 判 Boss 代理。
      let hitBalloon = null;
      for (let pass = 0; pass < 2 && !hitBalloon; pass++) {
        const wantBoss = pass === 1;
        for (let j = 0; j < list.length; j++) {
          const balloon = list[j];
          if (!balloon.alive) continue; // 跳过已隐藏的龙气球（复活前），防重复触发
          // 幽灵怪隐身期间无视子弹（仅蓄力显形时可被击中）
          if (balloon.behavior === 'ghost' && !balloon.revealed) continue;
          if (!!balloon.isBoss !== wantBoss) continue; // pass0 跳过 Boss；pass1 仅 Boss
          const rr = balloon.hitRadius + SHOOT.HIT_PAD; // 命中球 ≈ 怪物可见半径
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
        const killed = hitBalloon.takeDamage(b.dmg);
        this.bullets.release(b);
        this.audio?.playPop();
        if (killed) this._onKilled(hitBalloon);
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
    // 龙 Boss 部件：隐藏并由 DragonBoss 管理「1秒复活」，不从这里永久移除（且不再连锁炸其他龙部件）
    if (balloon.isDragonPart) {
      if (this.dragon && !this.dragon.dying) {
        this._addScore(balloon.score);
        this.audio?.playPop();
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
      this.audio?.playPop();
      this.balloons.remove(balloon);
      return;
    }
    this._addScore(balloon.score);
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
        if (boss.takeDamage(dmg, true))  // ignoreReduction=true，绕过减伤
          this._onKilled(boss);          // Boss 死亡 → 递归进入正常 Boss 结算
      }
    }
    // 心型怪：击败后为船恢复血量（知识库 30）
    if (balloon.behavior === 'heal') {
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + (balloon.type.shipHealOnDeath || 30));
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
    if (this.selectedSkill === 'buddha') return BUDDHA.COOLDOWN;
    if (this.selectedSkill === 'lightsaber') return LASER_SWORD.COOLDOWN;
    if (this.selectedSkill === 'scatterburst') return SCATTER_BURST.COOLDOWN;
    if (this.selectedSkill === 'scatter') return SCATTER.COOLDOWN;
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
    const list = this.balloons.list;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (!b.alive) continue;
      const rr = b.hitRadius; // 含立绘 0.6 系数/薄板近似，球体足够
      if (_pointSegDistSq(b.mesh.position, this._hilt, this._tip) > rr * rr) continue; // 剑刃未扫到
      if ((b._swordCdUntil || 0) > now) continue; // 同一只怪在 HIT_INTERVAL 内只受一次（剑刃持续扫到则可高频多次扣血）
      const killed = b.takeDamage(LASER_SWORD.DAMAGE * this.player.skillDamageMul, true); // ignoreReduction=true 穿透减伤（实际伤害 = DAMAGE × player.skillDamageMul）
      b._swordCdUntil = now + LASER_SWORD.HIT_INTERVAL; // 调小 HIT_INTERVAL = 更高 DPS（修复：原 1.0s 导致单次挥击只命中一次，#1）
      if (killed) { this.audio?.playPop(); this._onKilled(b); } // 击毙音效（修复：原激光击杀静默，#2）
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
      const list = this.balloons.list;
      for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i];
        if (this._buddhaHit.has(b)) continue;               // 本轮神掌已结算过，跳过
        const p = b.mesh.position;
        if (Math.abs(p.x - px) < halfW && Math.abs(p.y - py) < halfH && Math.abs(p.z - pz) < zBand) {
          this._buddhaHit.add(b);
          if (b.takeDamage(dmg)) this._onKilled(b);
        }
      }
    }
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
        this.balloons.remove(balloon);
        this.audio?.playPop();
        // 气球入侵飞船区域即造成伤害，不依赖玩家与爆炸点的距离；伤害按该气球自身自爆值
        const dead = this.player.takeDamage(balloon.isBoss ? 40 : (balloon.selfDamage ?? BALLOON.DAMAGE));
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
    this.shurikens.clear(); // 重开本关一并清手里剑
    this.bullets.clear();
    // 不调 _clearExplosions()：让死亡爆炸特效在 0.4s 内自然消亡
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

  _enterCard() {
    this._clearExplosions();
    this.state = 'card';
    this.bullets.clear(); // 清掉上一波残留子弹，避免误击卡气球
    this.player.forceSingleShot = true; // 抽卡期间强制单发，避免多重射击扇形误选邻卡
    this.log('波次清空，选择强化');
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
      // Boss 关(6/12) + 机制关(9/15)：抽 4–7 池（技能消耗/技能伤害/自我修复/生命）
      plan = { pool: ['skillCost', 'skillDamage', 'selfRepair', 'hp'] };
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
      guarantee: plan.guarantee || null,        // 01/02 关：指定卡必出（multiShot / fireRate）
      fixedSkills: plan.fixedSkills || null,    // 第三关：固定技能卡
      onSkill: (id) => this._applySkillCard(id),
      onCollect: (id) => this._collectedCards.push(id), // 本局收集：供第18关汇总
    };
    this.hud.message('选择强化', '射击对应气球进行选择（3 选 1）', '#ffd43b');
    this.cards.open(pp, this._fwd.clone(), this._cardState, () => this._onCardDone());
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
    this.bullets.update(dt);
    for (const shot of this.input.shots) this.player.fire(shot, this.bullets, this.audio);
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
      this.hud.message('通关！', '按「开始游戏」重新挑战', '#2ecc71');
      this.hud.showStart();
      return;
    }
    this._loadLevel(this.levelIndex);
    this.state = 'playing';
  }

  _gameOver() {
    this.state = 'over';
    this.log('飞船坠落，游戏结束');
    this.balloons.clear();
    this.shurikens.clear(); // 游戏结束清手里剑
    this.bullets.clear();
    this.hud.message('飞船坠落', `得分 ${this.score} · 按「开始游戏」重来`, '#e74c3c');
    this.hud.showStart();
  }

  // 正常测试通关：停止补怪后场上清空即达成。与 _gameOver 对称，但为绿色胜利提示。
  _testWin() {
    this.state = 'over';
    this.log('全部消灭，通关！');
    this.balloons.clear();
    this.shurikens.clear(); // 通关清手里剑
    this.bullets.clear();
    this.hud.clearCountdown();
    this.hud.message('通关！', `得分 ${this.score} · 按「开始游戏」重新挑战`, '#2ecc71');
    this.hud.showStart();
  }
}
