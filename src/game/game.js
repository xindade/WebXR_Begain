import * as THREE from 'three';
import { Player } from './player.js';
import { BalloonManager } from './balloons.js';
import { BulletManager } from './bullets.js';
import { WaveManager } from './waves.js';
import { CardDraft } from './cardDraft.js';
import { LaserLevel } from './laser.js';
import { GlassGrid } from './glassGrid.js';
import { FlipGrid } from './flipGrid.js';
import { RightGun } from '../vr/rightGun.js';
import { DragonBoss } from './dragonLevel.js';
import { OpeningModel } from './openingModel.js';
import { Portal } from './portal.js';
import { WaitingRoom } from './waitingRoom.js';
import { LEVELS, isLaser, isBoss } from '../content/levels.js';
import { LEVEL_PLANS } from '../content/spawnPlans.js';
import { BALLOON, BUDDHA, SHIP, SHOOT, LASER, GRID, FLIP, MOVE, EXPLOSION, SKY_PANORAMA, STAFF, FREEZE, DEPTH_SPRITE_STRESS, NORMAL_TEST, DDA, FACE_BOSS, PORTAL, SPAWN_RING, GUN_MODES, SCATTER, WAITING_ROOM, BOSS_BGM } from '../core/constants.js';
import { setRenderer } from './balloonModels.js';
import { DifficultyController } from './difficultyController.js';
import { VRPlusGame, VRPlus } from '../net/vrplus.js';   // VR+ 平台桥接：cmd 3 启动 / 4 开始 / 5 中途结束 + 下行 inbox 监听

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
    this.bullets = new BulletManager(world.scene);
    // DDA：内置战斗监测（每帧由 _ddaMetrics() 读取玩家/场上状态），喂给 WaveManager 调度出怪
    this.dda = new DifficultyController(() => this._ddaMetrics());
    this.waves = new WaveManager(
      world.scene, this.balloons,
      () => this.rig.getWorldPosition(new THREE.Vector3()),
      this.dda,
      () => this._portals,
      () => this._playerDPS(),     // 新：玩家 DPS（内外圈调度基准）
      () => this.skillCooldown     // 新：技能剩余冷却（>3 = 最近5秒放过技能 → 内圈系数=1）
    );
    this.cards = new CardDraft(world.scene);
    this.rightGun = new RightGun(world.scene);   // 右手柄 AK 枪（VR 手持，纯视觉）

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
    this.openingModel = null; // 第3/9/15关开场动画模型（魔术师），10秒后自动移除
    this.waitingRoom = null;  // 等待房间实例（进第 1 关前的开场影片，视频结束自动拆除）
    this._portals = [];        // 小怪关传送门装饰（非 boss、非激光机制关，前后左右各 20m）
    this.score = 0;
    this._buddhaFx = null;
    this._cardState = null;
    this._levelSnapshot = null;  // 关卡开始时的玩家属性+分数快照
    this._explosions = [];       // 爆炸视觉特效列表
    this.enemyFreeze = 0;        // 定身咒计时(s)：>0 时敌人暂停行动（Boss 仅前 50% 时长）
    this.selectedSkill = 'scatter'; // 当前装备技能：前期默认「积分散射」；第三关选卡后可替换为 staff/freeze/buddha，右手握柄触发
    this.skillCooldown = 0;      // 技能释放冷却计时(s)：>0 时握柄无效，HUD 显示剩余

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
      if ((n === 16 || n === 5 || n === 6) && msg.t && msg.t < this._pageT0) {
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

  setSystems(audio, input, wristUI = null, pageLog = null) {
    this.audio = audio; this.input = input; this.wristUI = wristUI; this.pageLog = pageLog;
  }

  // 游戏内日志：同时送往左手腕面板（VR 可见）和页面日志（预览可见、最高优先）
  log(msg) {
    this.wristUI?.log(msg);
    this.pageLog?.log(msg);
  }

  start(atIndex = 0, gunMode = 'preview') {
    this.gunMode = gunMode;
    // 从待机态（平台已关闭本局）被唤醒时，一并清掉待机标记与渲染暂停 ——
    // 否则新一局会「逻辑在跑但画面不刷新」（_renderPaused 是 main.js 主循环的开关）。
    // 封盖也一并撤掉：只要真的开了新一局，就不该再盖着「本局已结束」。
    this._closedIdle = false;
    this._renderPaused = false;
    this._hidePlatformClosed();
    this.player.reset(gunMode);
    this.input?.setGunMode(gunMode);
    this.player.input = this.input; // 让射速卡能触达真实节流源（input.setFireRateMul）
    this.balloons.clear();
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
    this.log('游戏开始');
    VRPlusGame.launch();   // cmd 3 启动游戏（上报平台：游戏已启动，等待握手完成）
    // 等待房间：从第 1 关开始时先进房间看开场影片（左墙视频，有声，不可跳过），
    // 视频结束后 _exitWaitingRoom 才加载第 1 关；期间不开 BGM（视频有自己的音轨）
    if (atIndex === 0 && WAITING_ROOM.ENABLED) {
      this._enterWaitingRoom();
      return;
    }
    this.audio?.startBGM();
    this._loadLevel(this.levelIndex);
    this.state = 'playing';
    VRPlusGame.begin();   // cmd 4 开始游戏（跳过等待房间时直接开始）
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
      this._platformSignal('onSeen', '平台开局指令 cmd=' + cmd + '（平台在场）');
      // ★ 开「进入 VR」门禁 = 平台真的说了开始，玩家这才被允许进 VR（main.js 显示按钮）
      this._platformSignal('onStart', payload?.local
        ? (payload?.plat ? '平台驱动的本次拉起（APK 本地通知：平台已开始本局）'
                         : '平台重新启动本局（APK 本地唤醒待机页）')
        : ('平台开局指令 cmd=' + cmd));
      this.log(payload?.plat
        ? '平台已开始本局（APK 确认本次拉起由平台驱动）→ 回到菜单，等玩家点「进入 VR」'
        : (payload?.local ? '平台已重新开始本局 → 退出待机回到菜单，等玩家点「进入 VR」'
                          : '平台「开始游戏」（cmd=' + cmd + '）→ 已放开「进入 VR」按钮，等玩家自己进 VR 开局'));
      VRPlus.reportEvent('platform-start', { cmd, plat: !!payload?.plat });
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
    this._goneHandled = true;
    this.log('平台已结束本局，正在退出…（' + why + '）');
    // ★ 留痕（2026-09-19）：页面即将退出 —— 把死因写进 APK 的统一时间线磁盘文件。
    //   页面自己的日志会随页面一起消失，而这条会留在 APK 上，事后打开 APK 配置页
    //   或浏览器访问 /api/page/forensics 就能读到「谁在几点几分让页面退出的」。
    VRPlus.reportDead('platform-gone', {
      why,
      explicit: this._closedByPlatformCommand === true,   // 平台明说 vs 看门狗推断
      preloadDone: !!this.preloadDone,
      state: this.state,
    });
    this.toMenu();                             // 回菜单：内部上报 cmd5 + 清理实体 + 恢复天空背景
    const sess = this.world?.renderer?.xr?.getSession?.();
    if (sess) sess.end().catch(() => {});      // 退出沉浸式会话（菜单态无会话则跳过）
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
    this.log('判死复核：' + why + ' → 等 2.5s 再探一次（避免后台节流误判）');
    await new Promise((r) => setTimeout(r, 2500));
    const alive = await VRPlus.serverAlive();
    this._confirming = false;
    if (this._goneHandled) return;
    if (alive) {
      this.log('判死复核：APK 其实在线 → 撤销退出（上一次是误判，游戏继续）');
      return;
    }
    this.log('判死复核：APK 确实已失联 → 执行退出');
    this._onPlatformGone(why);
  }

  // ====== 等待房间（开场影片）======
  _enterWaitingRoom() {
    this.state = 'waiting';
    this.hud.setLevel('等待房间');
    this.hud.message('开场影片播放中…', '影片结束后进入第 1 关', '#ffd43b');
    this.log('等待房间：开场影片播放中');
    this.world.setAmbientVisible(false); // 背景纯黑，仅留视频屏（退出时恢复）
    this.waitingRoom = new WaitingRoom(this.world.scene);
    // ended/error/看门狗任一触发 → 进第 1 关（视频失败不软锁）
    this.waitingRoom.start(() => this._exitWaitingRoom());
  }

  _exitWaitingRoom() {
    if (this.state !== 'waiting') return; // toMenu/重入已清理时忽略迟到回调
    if (this.waitingRoom) { this.waitingRoom.dispose(); this.waitingRoom = null; }
    this.world.setAmbientVisible(true);  // 恢复天空/星空/边界/网格等背景
    this.hud.clearMessage();
    this.audio?.startBGM();
    this._loadLevel(this.levelIndex);
    this.state = 'playing';
    VRPlusGame.begin();   // cmd 4 开始游戏（等待房间影片结束，正式进入第 1 关）
  }

  // 等待期间：允许自由走动（input.update 每帧清空 shots → 射击事件自然丢弃）
  _updateWaitingRoom(dt) {
    this.input.update(dt);
    this.player.update(dt);
    this.waitingRoom?.update(dt);
    this.hud.setHp(this.player.hp, this.player.maxHp);
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
  _reportGameEnd(why) {
    // 去抖：一条时间线里同一局只留一条（_onPlatformGone 会连着走 toMenu + 待机态两处）
    const now = Date.now();
    if (this._gameEndReportedAt && now - this._gameEndReportedAt < 5000) return;
    this._gameEndReportedAt = now;
    const castMode = /[?&]cast=1/.test(location.search);
    VRPlus.reportEvent('game-end', {
      why, st: this.state, lvl: this.levelIndex, cast: castMode,
    });
  }

  /** 本局收尾的唯一出口：报平台（cmd5 兜底）+ 报 APK（唤醒平台客户端 / 关浏览器） */
  _endRound(why) {
    VRPlusGame.terminate();
    this._reportGameEnd(why);
  }

  // 回到「未开始」状态：供 sessionend 调用，使再次进入 VR 时 sessionstart 守卫生效、从干净状态开局
  toMenu() {
    this.state = 'menu';                       // 关键：让 sessionstart 的 game.start 守卫重新生效
    this._endRound('本局结束（回菜单：玩家退出 / 掉会话 / 平台关闭）');
    if (this.waitingRoom) { this.waitingRoom.dispose(); this.waitingRoom = null; } // 清等待房间（视频中退出 VR）
    // 释放关卡专属实例（沿用 _loadLevel 头部写法）
    if (this.laser)    { this.laser.dispose();    this.laser = null; }
    if (this.grid)     { this.grid.dispose();     this.grid = null; }
    if (this.flipGrid) { this.flipGrid.dispose(); this.flipGrid = null; }
    if (this.dragon)   { this.dragon.dispose();   this.dragon = null; }
    if (this.openingModel) { this.openingModel.dispose(); this.openingModel = null; } // 清开场动画
    this._clearPortals(); // 清传送门装饰（防跨关/回菜单残留）
    this.waves.clearPending();   // 清出怪光点（防回菜单残留）
    // 清理实体
    this.balloons.clear();
    this.bullets.clear();
    this._clearExplosions();
    if (this._buddhaFx) { this.world.scene.remove(this._buddhaFx.mesh); this._buddhaFx = null; }
    this.cards.clearCards();                    // 清抽卡气球（不拆除 group，可再次 open 复用）
    this._cardState = null;
    this._levelSnapshot = null;
    // 重置数值
    this.player.reset();
    this.score = 0;
    this.levelIndex = 0;
    this.gridPhase = false;
    this.flipPhase = false; this.flipTimer = 0;
    this._lastCell = 0; this._failing = false; this._failTimer = 0;
    this.laserMode = false;
    // 位置 / 天空恢复预览初始态（默认天空 == dusk 预设，见 world.js 构造）
    this.rig.position.set(0, 0, 0);
    this.world.setAmbientVisible(true);  // 恢复背景（等待房间外退 VR 时也确保还原）
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
    if (this.laser) { this.laser.dispose(); this.laser = null; }
    if (this.grid) { this.grid.dispose(); this.grid = null; }
    if (this.flipGrid) { this.flipGrid.dispose(); this.flipGrid = null; }
    if (this.dragon) { this.dragon.dispose(); this.dragon = null; }
    if (this.openingModel) { this.openingModel.dispose(); this.openingModel = null; } // 清上一关残留的开场动画
    this._clearPortals(); // 清上一关残留的传送门装饰
    this.waves.clearPending();   // 清上一关残留出怪光点（防光点飞到新关卡）
    this.gridPhase = false;
    this.flipPhase = false; this.flipTimer = 0;
    this._lastCell = 0;
    this._firstCardOfLevel = true;   // 每关首次抽卡才强制攻击紫（02关）
    this.balloons.clear();      // 防跨关残留气球（脸谱 Boss 装饰等）
    this.bullets.clear();        // 防跨关残留子弹误击
    this.hud.clearCountdown();   // 关倒计时显示
    this.world.setSkyMood(lv.mood);
    // BGM 切轨：普通/危机 → normal（黄昏 dusk / 黑夜 night 变体）；激光机制关 → laser；Boss → boss
    // 切换在下一小节边界生效并做一次音量 duck，听感连贯（见 vr/audio.js）
    const bgmKind = isLaser(lv) ? 'laser' : (isBoss(lv) ? 'boss' : 'normal');
    this.audio?.setTrack(bgmKind, lv.mood === 'night' ? 'night' : 'dusk');
    // 机制关从「生成期」的低强度起步；Boss 关起步即有压迫层（0.45），随血量/时长升至 1
    // （旧代码把 Boss 强度恒设为 0，导致曲内所有高压层永远不触发）
    this.audio?.setIntensity(bgmKind === 'laser' ? 0.2 : (bgmKind === 'boss' ? BOSS_BGM.START_INTENSITY : 0));
    this._bossT = 0;                                  // Boss 关计时（无血量数据时用于升压）
    this._bossInten = BOSS_BGM.START_INTENSITY;
    if (isBoss(lv)) this.audio?.playBossSting();   // Boss 进场：铜锣 + 升调 + 三连太鼓
    // 有全景配置的关卡（如第3/15关）用全景图作天空，覆盖渐变；无配置则维持渐变天空
    const pano = SKY_PANORAMA[lv.n];
    if (pano) this.world.setSkyPanorama(pano);
    this.hud.setLevel(`第 ${lv.n} 关 · ${KIND_NAME[lv.kind]}`);

    // 第3/9/15关开头：世界固定点播放在「魔术师动画版」模型，循环播放 10 秒后自动消失
    if (lv.n === 3 || lv.n === 9 || lv.n === 15) {
      this.openingModel = new OpeningModel(this.world.scene, new THREE.Vector3(0, 1.4, -5));
      this.openingModel.start();
    }
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

  _playerPos() { return this.rig.getWorldPosition(this._tmp); }

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
    this.world.update(dt);
    if (this.openingModel) this.openingModel.update(dt); // 开场动画模型：推进动画 + 10秒计时
    const pp = this._playerPos();                     // 取一次玩家位置，所有门共用（同步读取，无异步滞留）
    this._portals.forEach((p) => p.update(dt, pp));   // 传送门动画 + 浮动 + 摇杆偏移 + 数值标签
    this.wristUI?.update(dt, this, this.input); // 手腕面板（VR 下显示，桌面忽略）
    this.rightGun.update(dt, this.input);        // 右手柄 AK 枪（VR 手持，桌面忽略）
    this._updateBuddhaFx(dt);
    this._updateStaffFx(dt);
    this._updateExplosions(dt);

    if (this.state === 'playing') this._updatePlaying(dt);
    else if (this.state === 'card') this._updateCard(dt);
    else if (this.state === 'waiting') this._updateWaitingRoom(dt);
  }

  _updatePlaying(dt) {
    this.input.update(dt);
    this._updateBossIntensity(dt);   // Boss 关：按血量/时长给 BGM 升压
    this.player.update(dt);
    this.bullets.update(dt);
    const pp = this._playerPos();

    for (const shot of this.input.shots) this.player.fire(shot, this.bullets, this.audio);

    // 选中技能：冷却递减；右手握柄(或桌面 F)请求释放 → 冷却就绪则触发
    this.skillCooldown = Math.max(0, this.skillCooldown - dt);
    if (this.input.consumeSkill() && this.selectedSkill && this.skillCooldown <= 0) this._triggerSelectedSkill();
    const skillLabel = this.selectedSkill === 'buddha' ? '如来神掌'
                     : this.selectedSkill === 'staff' ? '金箍棒'
                     : this.selectedSkill === 'freeze' ? '定身咒'
                     : this.selectedSkill === 'scatter' ? '积分散射' : null;
    this.hud.setSkill(skillLabel, this.skillCooldown, this._skillCdTotal());

    // ====== 激光关：无普通敌人，仅激光气球 ======
    if (this.laserMode) {
      this._updateLaserLevel(dt, pp);
      return;
    }

    // ====== 普通关 ======
    // 定身咒：冻结期间跳过敌人移动（Boss 仅前 50% 时长冻结）
    let freezeNormal = false, freezeBoss = false;
    if (this.enemyFreeze > 0) {
      this.enemyFreeze = Math.max(0, this.enemyFreeze - dt);
      freezeNormal = this.enemyFreeze > 0;
      freezeBoss   = this.enemyFreeze > FREEZE.DURATION * (1 - FREEZE.BOSS_FACTOR);
    }
    // 气球追踪原点(0,0,0)而非玩家位置
    this.balloons.update(dt, ORIGIN, this.world.camera, { freezeNormal, freezeBoss });
    if (this.dragon) {
      if (freezeBoss) this.dragon.pauseTimer = Math.max(this.dragon.pauseTimer, 0.1); // 定身：龙 Boss 暂停推进
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
    if (cleared) { this._enterCard(); }
  }

  // 激光关主循环：激光动画 + 保持期发光驱动 + 走格子/九宫格阶段分派
  _updateLaserLevel(dt, pp) {
    this.laser.update(dt, pp);

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
        const hit = this.laser.hitTest(pp, LASER.PLAYER_R);
        if (hit) { this._dieInLaserLevel(); return; }
      }
      // 4) 18s 进入安全解谜期：激光淡出不致命 + 启动 180s 倒计时（用户修改②）
      if (!this.flipPhase && this.laser.reachedGoal(pp)) {
        this.flipPhase = true;
        this.audio?.setIntensity(0.35);   // 安全解谜期：激光消散，音乐降压转安静
        this.laser.enterGridPhase();
        this.flipTimer = FLIP.COUNTDOWN;
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
    const hit = this.laser.hitTest(pp, LASER.PLAYER_R);
    if (hit) { this._dieInLaserLevel(); return; }
    if (this.laser.reachedGoal(pp)) {
      if (this.laser.mode === 'drive') {
        // 保持期结束 → 激光消散，转入走格子阶段
        this.gridPhase = true;
        this.audio?.setIntensity(1);      // 走格子阶段：节奏与滤波拉满
        this._lastCell = 0;
        this._failing = false;
        this.laser.enterGridPhase();
        this.log('激光消散，开始走格子：踩正确格子，踩错会破碎');
      } else {
        this.laser.dispose();
        this.laser = null;
        this._forceSkillCards = ['buddha', 'staff', 'freeze']; // 第三关固定三张红色技能卡
        this._enterCard();
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
        this.laser.dispose(); this.laser = null;
        if (this.grid) { this.grid.dispose(); this.grid = null; }
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
    this.rig.position.set(0, 0, 0);
    this.player.hp = this.player.maxHp;
    if (this.laser) this.laser.reset();
    if (this.grid) this.grid.reset();   // 玻璃网格（含破碎格）一并重建
    if (this.openingModel) { this.openingModel.dispose(); this.openingModel = null; } // 激光关死亡重开：清开场动画，防重复生成
    if (this.flipGrid) { this.flipGrid.dispose(); this.flipGrid = null; } // 九宫格 dispose，下次 16s 由 isHoldPhase 重建为初始布局
    this.gridPhase = false;
    this.flipPhase = false; this.flipTimer = 0;
    this._lastCell = 0;
    this._failing = false;
    this._failTimer = 0;
    this.hud.clearCountdown();
  }

  // 第十五关收尾：解出→抽卡(withCard=true)；倒计时归零→直接下一关(withCard=false)
  _finishFlipLevel(withCard = true) {
    if (this.flipGrid) { this.flipGrid.dispose(); this.flipGrid = null; }
    if (this.laser) { this.laser.dispose(); this.laser = null; }
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
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      const list = this.balloons.list;
      for (let j = 0; j < list.length; j++) {
        const balloon = list[j];
        if (!balloon.alive) continue; // 跳过已隐藏的龙气球（复活前），防重复触发
        // 幽灵怪隐身期间无视子弹（仅蓄力显形时可被击中）
        if (balloon.behavior === 'ghost' && !balloon.revealed) continue;
        const rr = balloon.hitRadius + SHOOT.HIT_PAD; // 命中球 ≈ 怪物可见半径
        // 命中判定分两类：
        //  a) 普通 3D 模型 → 线段-球心最近距离（轨迹真正穿过可见球体才命中，擦边/高速穿透不再误判）。
        //  b) 2D 立绘(DepthSprite，永远朝相机的扁平 billboard) → 改用「薄板」：立绘无厚度，3D 球会沿纵深(朝相机)
        //     伸出 rr，导致子弹在卡片正前方 rr 米(还没飞到)就误判命中；薄板仅当子弹在卡片平面内横向最近距
        //     < rr 且 纵深偏移 < HIT_SLAB_DEPTH 才命中（板厚仅给斜射时的极小微宽容）。
        let _hit = false;
        if (balloon.depthSprite) {
          _closestPointOnSeg(_segClosest, balloon.mesh.position, b.prevPos, b.pos); // 轨迹上离中心最近点
          _segAB.copy(_segClosest).sub(balloon.mesh.position);                      // 最近点→中心
          _segN.copy(this._camPos).sub(balloon.mesh.position).normalize();          // 卡片法线(朝相机)
          const _depth = _segAB.dot(_segN);                                         // 纵深分量(沿法线)
          const _inPlaneSq = Math.max(0, _segAB.lengthSq() - _depth * _depth);       // 平面内横向分量²
          if (_inPlaneSq < rr * rr && Math.abs(_depth) < SHOOT.HIT_SLAB_DEPTH) _hit = true;
        } else {
          if (_pointSegDistSq(balloon.mesh.position, b.prevPos, b.pos) < rr * rr) _hit = true;
        }
        if (_hit) {
          // 盾兵怪：盾牌当前朝向玩家且在挡弹夹角内 → 挡下子弹（不扣血）
          if (balloon.behavior === 'shield') {
            const sb = balloon.getShieldBlock();
            if (sb) {
              this._tmp2.copy(this._playerPos()).sub(balloon.mesh.position);
              this._tmp2.y = 0;
              if (this._tmp2.lengthSq() > 1e-6) {
                this._tmp2.normalize();
                if (this._tmp2.dot(sb.dir) > Math.cos(sb.arc)) {
                  this.bullets.release(b);
                  this._spawnExplosionFx(b.pos, 0.2); // 挡弹火花（_spawnExplosionFx 内部 copy，无需 clone）
                  break; // 子弹被盾挡下，退出内循环（修复原 continue 导致的双释放 bug）
                }
              }
            }
          }
          const killed = balloon.takeDamage(b.dmg);
          this.bullets.release(b);
          this.audio?.playPop();
          if (killed) this._onKilled(balloon);
          break;
        }
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

  _onKilled(balloon) {
    // 龙 Boss 部件：隐藏并由 DragonBoss 管理「1秒复活」，不从这里永久移除（且不再连锁炸其他龙部件）
    if (balloon.isDragonPart) {
      if (this.dragon && !this.dragon.dying) {
        this.score += balloon.score;
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
      this.score += bonus;
      this.audio?.playPop();
      this.balloons.remove(balloon);
      return;
    }
    this.score += balloon.score;
    this.dda?.notifyKill();   // DDA：记录一次击杀，用于滑窗击杀率统计

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
      this.score += 50;
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
    const pp = this._playerPos();
    this.log('如来神掌！');
    // 伤害范围内所有气球
    for (let i = this.balloons.list.length - 1; i >= 0; i--) {
      const b = this.balloons.list[i];
      if (b.mesh.position.distanceTo(pp) < BUDDHA.KILL_RADIUS) {
        if (b.takeDamage(BUDDHA.DAMAGE)) this._onKilled(b);
      }
    }
    // 视觉：金色巨掌从天而降
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0xffd43b, emissive: 0xffa500, emissiveIntensity: 0.6, transparent: true, opacity: 0.85 })
    );
    mesh.scale.setScalar(BUDDHA.FALL_START_SCALE);
    mesh.position.copy(pp);
    mesh.position.y += 20;
    this.world.scene.add(mesh);
    this._buddhaFx = { mesh, t: 0 };
  }

  // ====== 第三关三技能 ======
  // 选卡：仅「装备」技能到右手握柄，不立即释放（释放由握柄触发 _triggerSelectedSkill）
  _applySkillCard(id) {
    this.selectedSkill = id;
    this.skillCooldown = 0;                 // 装备即就绪，可立即按握柄释放
    if (id === 'buddha') this.player.buddhaUnlocked = true;
    const label = id === 'buddha' ? '如来神掌' : id === 'staff' ? '金箍棒' : '定身咒';
    this.log(`已装备：${label}（按右手握柄释放）`);
  }

  // 右手握柄/桌面 F 触发：按当前装备技能分发释放，统一冷却由 this.skillCooldown 负责
  _triggerSelectedSkill() {
    switch (this.selectedSkill) {
      case 'buddha':
        if (!this.player.buddhaUnlocked) { this.log('如来神掌尚未解锁'); return; } // 还原原语义：未解锁不放（return 不进入冷却）
        this._doBuddha(); break;
      case 'staff':  this._castStaff(); break;
      case 'freeze': this._castFreeze(); break;
      case 'scatter':
        if (!this._castScatter()) return; // 积分不足 → 不进入冷却，可立即重试
        break;
    }
    this.skillCooldown = this._skillCdTotal();
  }
  _skillCdTotal() {
    if (this.selectedSkill === 'buddha') return BUDDHA.COOLDOWN;
    if (this.selectedSkill === 'staff')  return STAFF.COOLDOWN;
    if (this.selectedSkill === 'freeze') return FREEZE.COOLDOWN;
    if (this.selectedSkill === 'scatter') return SCATTER.COOLDOWN;
    return 0;
  }

  // 积分散射：消耗积分，从枪口喷出 COUNT 弹头，轴向 DIST 米铺成半径 RADIUS 圆盘（实心/环）
  _castScatter() {
    if (this.score < SCATTER.COST) { this.log(`积分不足（需${SCATTER.COST}）`); return false; }
    this.score -= SCATTER.COST;
    this.hud.setScore(this.score);
    const muzzle = new THREE.Vector3();
    const dir = new THREE.Vector3();
    this.input.getMuzzle(muzzle, dir); // 右手柄位姿（无则回退相机）
    // 以瞄准方向 dir 为轴建正交基：right ⊥ dir（水平），up = right × dir
    const right = new THREE.Vector3().crossVectors(dir, _WORLD_UP).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    const dmg = SCATTER.DAMAGE > 0 ? SCATTER.DAMAGE : this.player.atk;
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
    this.log(`积分散射！消耗${SCATTER.COST}积分，喷出${SCATTER.COUNT}弹头`);
    return true;
  }

  // 金箍棒：玩家正前方 90° 扇形（±45°）内敌人受致命伤 ≈ 四分之一全屏
  _castStaff() {
    const pp = this._playerPos();
    this.world.camera.getWorldDirection(this._fwd); // 玩家看向场景内的方向
    const COS_HALF = Math.cos(THREE.MathUtils.degToRad(STAFF.HALF_ANGLE));
    for (let i = this.balloons.list.length - 1; i >= 0; i--) {
      const b = this.balloons.list[i];
      this._tmp2.copy(b.mesh.position).sub(pp);
      this._tmp2.y = 0;
      const dist = this._tmp2.length();
      if (dist < 0.001) continue;
      this._tmp2.normalize();
      if (this._tmp2.x * this._fwd.x + this._tmp2.z * this._fwd.z >= COS_HALF) { // 落在前方扇形内
        if (b.takeDamage(STAFF.DAMAGE)) this._onKilled(b);
      }
    }
    this._spawnStaffWall(pp, this._fwd);
    this.log('金箍棒！前方扇形伤害');
  }

  // 定身咒：暂停所有敌人行动；Boss（龙）仅前 50% 时长冻结（由 FREEZE.BOSS_FACTOR 控制）
  _castFreeze() {
    this.enemyFreeze = FREEZE.DURATION;
    this.log('定身咒！敌人暂停行动');
  }

  // 金箍棒视觉：玩家正前方一道红色光墙
  _spawnStaffWall(pp, fwd) {
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(STAFF.WALL_WIDTH, STAFF.WALL_HEIGHT),
      new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    wall.position.copy(pp).addScaledVector(fwd, STAFF.WALL_DIST);
    wall.position.y += STAFF.WALL_HEIGHT / 2;
    wall.lookAt(pp.x, wall.position.y, pp.z);
    this.world.scene.add(wall);
    this._staffFx = { mesh: wall, t: 0 };
  }

  _updateStaffFx(dt) {
    if (!this._staffFx) return;
    this._staffFx.t += dt;
    const k = Math.min(1, this._staffFx.t / STAFF.WALL_DUR);
    this._staffFx.mesh.material.opacity = 0.5 * (1 - k);
    if (k >= 1) {
      this.world.scene.remove(this._staffFx.mesh);
      this._staffFx.mesh.geometry.dispose();
      this._staffFx.mesh.material.dispose();
      this._staffFx = null;
    }
  }

  _updateBuddhaFx(dt) {
    if (!this._buddhaFx) return;
    this._buddhaFx.t += dt;
    const k = Math.min(1, this._buddhaFx.t / BUDDHA.FALL_DURATION);
    const s = THREE.MathUtils.lerp(BUDDHA.FALL_START_SCALE, BUDDHA.FALL_END_SCALE, k);
    this._buddhaFx.mesh.scale.setScalar(s);
    this._buddhaFx.mesh.position.y = THREE.MathUtils.lerp(20, 0, k) + this._playerPos().y;
    if (k >= 1) {
      this.world.scene.remove(this._buddhaFx.mesh);
      this._buddhaFx = null;
    }
  }

  // ====== 爆炸系统 ======

  // 检查气球是否进入4×8区域，进入则自爆并伤害飞船
  _checkExplosions() {
    for (let i = this.balloons.list.length - 1; i >= 0; i--) {
      const balloon = this.balloons.list[i];
      if (balloon.controlled) continue; // 龙 Boss 气球：纯靶子，不进入4×8自爆、不伤飞船
      const pos = balloon.mesh.position;
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
    p.maxHp = s.maxHp;
    p.hp = s.hp;
    p.buddhaUnlocked = s.buddhaUnlocked;
    p.buddhaCooldown = s.buddhaCooldown;
    p.buddhaTimer = s.buddhaTimer;
    p.shieldTime = s.shieldTime;
    this.score = s.score;
  }

  _restartLevel() {
    this.log('飞船坠毁，本关重开');
    this._restoreSnapshot();
    this.balloons.clear();
    this.bullets.clear();
    // 不调 _clearExplosions()：让死亡爆炸特效在 0.4s 内自然消亡
    this.rig.position.set(0, 0, 0);
    this._loadLevel(this.levelIndex); // 会重新拍快照（恢复后的状态）
    this.hud.setScore(this.score);
    this.hud.setHp(this.player.hp, this.player.maxHp);
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
    this._cardState = {
      player: this.player,
      // score 访问解耦：注入回调，cardDraft 不再反向持有 game 实例
      getScore: () => this.score,
      spendScore: (cost) => { this.score -= cost; },
      // 01/02 关卡片品质覆盖（见 LEVEL_PLANS）；首卡强制攻击紫仅 02 关且本关首次
      rarity: LEVEL_PLANS[LEVELS[this.levelIndex].n]?.cards || null,
      forceAttackPurple: !!(LEVEL_PLANS[LEVELS[this.levelIndex].n]?.firstCardForceAttackPurple && this._firstCardOfLevel),
      // 第三关激光关：固定弹出三张红色技能卡（如来神掌/金箍棒/定身咒），onSkill 回调执行需场景上下文的技能
      fixedSkills: this._forceSkillCards || null,
      onSkill: (id) => this._applySkillCard(id),
    };
    this._forceSkillCards = null; // 取用后清空
    this._firstCardOfLevel = false; // 翻转：本关仅首张卡强制攻击紫
    this.hud.message('选择强化', '射击对应气球进行选择（刷新气球可重roll，积分不足时锁定）', '#ffd43b');
    this.cards.open(pp, this._fwd.clone(), this._cardState, () => this._onCardDone());
  }

  // 抽卡模式：允许自由移动 + 射击，子弹命中卡气球即选卡
  _updateCard(dt) {
    this.input.update(dt);
    this.player.update(dt);
    this.bullets.update(dt);
    for (const shot of this.input.shots) this.player.fire(shot, this.bullets, this.audio);
    this.cards.update(dt, this.bullets, this._playerPos().clone());
    this.bullets.sync(); // 抽卡模式子弹命中后刷新实例矩阵
  }

  _onCardDone() {
    this.player.forceSingleShot = false; // 退出抽卡，恢复枪械模式弹道数
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

  _gameOver() {
    this.state = 'over';
    VRPlusGame.terminate();   // cmd 5 中途结束（飞船坠落 / 失败）
    this.log('飞船坠落，游戏结束');
    this.balloons.clear();
    this.bullets.clear();
    this.hud.message('飞船坠落', `得分 ${this.score} · 按「开始游戏」重来`, '#e74c3c');
    this.hud.showStart();
  }

  // 正常测试通关：停止补怪后场上清空即达成。与 _gameOver 对称，但为绿色胜利提示。
  _testWin() {
    this.state = 'over';
    this._endRound('全部消灭（通关）');   // cmd 5 兜底：通关暂未实现 cmd 6 结算，先按中途结束上报
    this.log('全部消灭，通关！');
    this.balloons.clear();
    this.bullets.clear();
    this.hud.clearCountdown();
    this.hud.message('通关！', `得分 ${this.score} · 按「开始游戏」重新挑战`, '#2ecc71');
    this.hud.showStart();
  }
}
