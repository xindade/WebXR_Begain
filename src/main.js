import * as THREE from 'three';
import { World } from './core/world.js';
import { SKY_PANORAMA } from './core/constants.js';
import { preloadDragonAssets } from './game/dragonLevel.js';
import { HUD } from './ui/hud.js';
import { AudioManager } from './vr/audio.js';
import { InputManager } from './vr/input.js';
import { WristUI } from './vr/wrist-ui.js';
import { Game } from './game/game.js';
import { LEVELS } from './content/levels.js';
import { preloadCardImages } from './game/cardDraft.js';
import { preloadGLB } from './game/glbCache.js';
import { MODEL_URL as PORTAL_MODEL_URL } from './game/portal.js';
import { MODEL_URL as OPENING_MODEL_URL } from './game/openingModel.js';
import { createCast } from './net/cast.js';
import { VRPlus } from './net/vrplus.js';

window.__pageLog?.info('[main] 模块开始执行（imports 已解析）');

// ─────────────────────────────────────────────────────────────────────────────
// 头显端「屏上诊断条」——专治「闪退/卡住但抓不到日志」
//   为什么要有它：闪退发生在浏览器页面里（或页面被我们自己卸载），adb logcat 只能看到 APK 侧；
//   而 PICO/Oculus 上又很难adb 联机。于是在页面左下角常显一行小字：
//     预加载进度 | APK 探活结果 | 游戏状态 | 最近一次的 JS 错误
//   进 VR 后 DOM 不参与渲染，不会干扰沉浸式画面；不想要就加 ?nodiag=1。
// ─────────────────────────────────────────────────────────────────────────────
const DIAG_ON = !new URLSearchParams(location.search).has('nodiag');
let __diagEl = null;
let __diagInfo = '';
let __diagErr = '';
let __preloadPct = 0;   // 预加载进度（0~100），由 preloadAll 的帧循环写入
function __diagRender() {
  if (!__diagEl) return;
  __diagEl.textContent = '● ' + (__diagInfo || '启动中') + (__diagErr ? '\n✖ ' + __diagErr : '');
}
function __diagSet(info) { __diagInfo = info; __diagRender(); }
if (DIAG_ON) {
  try {
    __diagEl = document.createElement('div');
    __diagEl.id = 'diag-line';
    __diagEl.style.cssText =
      'position:fixed;left:0;bottom:0;z-index:100000;max-width:100vw;background:rgba(0,0,0,.78);' +
      'color:#7fe3a1;font:12px/1.45 ui-monospace,Consolas,monospace;padding:3px 8px;' +
      'white-space:pre-wrap;word-break:break-all;pointer-events:none';
    document.body.appendChild(__diagEl);
    __diagRender();
  } catch (e) { /* 诊断条本身失败绝不影响游戏 */ }
}
// 把页面内所有 JS 异常显示出来（含 Promise 未处理拒绝）——闪退时这是唯一线索
function __diagErrShow(tag, e) {
  const msg = (e && (e.stack || e.message)) || String(e);
  __diagErr = tag + ' ' + String(msg).split('\n').slice(0, 3).join(' | ');
  if (__diagEl) __diagEl.style.color = '#ff9a9a';
  __diagRender();
  console.error(tag, e);
}
window.addEventListener('error', (ev) => __diagErrShow('[error]', ev.error || ev.message));
window.addEventListener('unhandledrejection', (ev) => __diagErrShow('[promise]', ev.reason));
window.__diag = __diagSet;   // 手动打点：__diag('xxx')

// ── 页面生命周期探针（越早挂越好，最好能在「页面刚出生」就留档）──
// 它把可见性变化 / pagehide / freeze 等事件写进 APK 的留痕时间线（见 net/vrplus.js）。
// 排查「游戏页跑一半就没了」时，这些是与 APK 侧心跳交织着读的关键指纹。
VRPlus.trackLifecycle();

const canvas = document.getElementById('app');
const world = new World(canvas);

// 网页端开屏视频已移除：开场影片改为在游戏内「等待房间」(src/game/waitingRoom.js) 播放，
// 进场由 game.start() 触发（桌面=点「开始游戏」/VR=sessionstart），保证有用户手势上下文、可带声播放。
// 资源加载完成后仅隐藏 loading 遮罩，等待玩家点击开始（详见 game.start → _enterWaitingRoom）。

// 预览阶段预加载全部重资产（3 张全景天空 + 龙关动画 JSON/龙头 GLB），
// 进度条走完才放行 Enter VR 按钮。如此进第 12 关时天空与龙资源都已命中缓存，
// 不再黑屏、不再空等。进度条按体感分段：80% 停 6s、95% 停 3s、最后 1s 跑到 100%。
(function preloadAll() {
  const overlay = document.getElementById('loading-overlay');
  const fill = document.getElementById('loading-bar-fill');
  const text = document.getElementById('loading-text');

  // —— 各加载任务的实时进度（0..1）——
  // 过滤 .exr：EXRLoader 在主线程同步解析大文件（68MB），会冻结 rAF 循环导致进度条卡死+兜底超时失效
  const skyUrls = Object.values(SKY_PANORAMA).filter(u => !u.toLowerCase().endsWith('.exr'));
  const skyFrac = {}; skyUrls.forEach((u) => { skyFrac[u] = 0; });
  const skyTasks = skyUrls.map((u) => world.loadSky(u, (loaded, total) => {
    skyFrac[u] = total ? Math.min(1, loaded / total) : 0;
  }).then(() => { skyFrac[u] = 1; })
    .catch(() => { skyFrac[u] = 1; })); // 单张失败不卡死

  let dragonFrac = 0; // JSON 占 0.1，GLB 下载占 0.9
  const dragonTask = preloadDragonAssets((loaded, total) => {
    dragonFrac = 0.1 + 0.9 * (total ? Math.min(1, loaded / total) : 0);
  }).then(() => { dragonFrac = 1; })
    .catch(() => { dragonFrac = 1; });

  // 传送门 + 开场动画 GLB（2.4MB + 3.2MB）：下载+DRACO 解码+parse 一次性完成，
  // 进小怪关 / 3·9·15 关零等待（glbCache 命中，零重复加载）。两文件各占一半进度。
  const glbParts = [0, 0];
  const glbTasks = [PORTAL_MODEL_URL, OPENING_MODEL_URL].map((u, i) =>
    preloadGLB(u, (loaded, total) => {
      glbParts[i] = total ? Math.min(1, loaded / total) : 0;
    }).then(() => { glbParts[i] = 1; })
  );
  const glbTask = Promise.all(glbTasks);

  // 抽卡 PNG（3 张共 ~1.1MB，太小不进进度条；加载完直接注入 game）
  // 失败也不影响：CardDraft 自动回落到 canvas 文字卡
  const cardTask = preloadCardImages()
    .then((texMap) => { game.cards.setCardTextures(texMap); })
    .catch(() => {});

  // 真实总进度：天空 / 龙资产 / 传送门+开场动画 各占三分之一
  const realFrac = () => {
    const sky = skyUrls.reduce((s, u) => s + skyFrac[u], 0) / skyUrls.length;
    const glb = (glbParts[0] + glbParts[1]) / 2;
    return (sky + dragonFrac + glb) / 3;
  };

  // —— 分段节奏（毫秒）——
  const HOLD_80 = 6000;   // 80% 停顿 6 秒
  const HOLD_95 = 3000;   // 95% 停顿 3 秒
  const RAMP = 1000;      // 最后 1 秒冲到 100%
  const HARD_TIMEOUT = 20000; // 兜底：无论如何 20 秒后强制放行，避免软锁
  const START = performance.now();

  function frame() {
    const elapsed = performance.now() - START;
    const real = realFrac();
    let cap = 1, minShow = 0;
    if (elapsed < HOLD_80) {
      cap = 0.80;                                  // 0~6s：不超过 80%
    } else if (elapsed < HOLD_80 + HOLD_95) {
      cap = 0.95;                                  // 6~9s：不超过 95%
    } else {
      const k = Math.min(1, (elapsed - HOLD_80 - HOLD_95) / RAMP);
      minShow = 0.95 + 0.05 * k;                   // 9~10s：缓动到 100%
    }
    let p = Math.min(real, cap);
    p = Math.max(p, minShow);
    if (fill) fill.style.width = Math.round(p * 100) + '%';
    if (text) text.textContent = `正在加载游戏资源 ${Math.round(p * 100)}%`;
    __preloadPct = Math.round(p * 100);   // 供屏上诊断条显示（见顶部 __diagSet）

    // 完成条件：资产全部就绪 且 已越过分段节奏
    if ((real >= 1 && elapsed >= HOLD_80 + HOLD_95) || elapsed >= HARD_TIMEOUT) {
      if (overlay) overlay.style.display = 'none'; // 揭开遮罩（等待房间内的开场影片将在 game.start 后于场景内播放）
      // 通知 Game：加载已完成 → 若平台在加载期就发来了「开始」命令，此刻才真正开局。
      // （必须等预加载结束：两套重加载叠加是「进度条走到一半崩掉」的高危来源）
      try { game.setPreloadDone(); } catch (e) { console.error('[main] setPreloadDone 异常:', e); }
      return;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  Promise.all([...skyTasks, dragonTask, cardTask, glbTask]).catch(() => {}); // 触发加载（帧循环独立读取进度）
})();

const hud = new HUD();
const audio = new AudioManager();

// Game 先创建（内部建立 playerRig 并把相机挂上去）
const game = new Game(world, hud);

// 注册「当前页面状态」提供者：{pct 预加载进度, st 游戏状态, pd 预加载是否完毕, xr XR 会话是否在跑,
// cs 是否处于「本局已结束」待机态}。
// 它会附在每秒的 inbox 轮询 URL 上（零额外请求），由 APK 落进留痕文件 ——
// 于是**页面万一当场消失**，事后仍能读到「它死之前停在 50%、状态 menu、XR 还没起」。
VRPlus.setStateProvider(() => ({
  pct: __preloadPct,
  st: game.state,
  pd: !!game.preloadDone,
  xr: !!(world && world.renderer && world.renderer.xr
    && world.renderer.xr.getSession && world.renderer.xr.getSession()),
  cs: !!game._closedIdle,
}));
// 直播推流：仅当 URL 带 ?cast=1 时才真正启用，否则返回空实现（零开销）
// 传 game 是为了让 cast 判断「是否真的开始游玩」（预览菜单/开场影片阶段不推流，见 CAST.PAUSE_STATES）
const cast = createCast({ world, game });
// 输入层拿到真实 rig
const input = new InputManager(world, game.rig);
const wristUI = new WristUI(); // 手腕面板：右手战斗信息 / 左手日志
// 页面日志（最高优先，由 index.html 的经典脚本注入；three 失败时仍可用）
const pageLog = window.__pageLog || null;
game.setSystems(audio, input, wristUI, pageLog);

// ── 屏上诊断条：每秒汇总一次「预加载 / APK 探活 / 游戏状态 / XR 会话」 ──
// 判读要点（下次再报问题，念这一行就够）：
//   APK:ok        → 本地 8080 在线（APK 进程活着）
//   APK:fail n/4  → 连续探活失败计数；到 4 就判定「APK 已死」并执行平台关闭流程
//   state=menu    → 还没开局；playing/waiting → 已开局
if (DIAG_ON) {
  setInterval(() => {
    try {
      if (__diagErr) return;   // 有错误时保持错误显示，不被状态行覆盖
      const a = game._aliveInfo || {};
      const apk = a.aliveConfirmed
        ? `ok${a.fails ? `(fail ${a.fails}/4)` : ''}`
        : (a.ok ? 'ok' : 'pending');
      const xr = world?.renderer?.xr?.getSession?.() ? 'on' : 'off';
      __diagSet(`加载${__preloadPct}% | APK:${apk} | state=${game.state} | XR:${xr} | 门禁${vrGate.open ? '开' : '关'} | 预加载${game.preloadDone ? '完毕' : '中'}`);
    } catch (e) { /* 诊断失败忽略 */ }
  }, 1000);
}

// ── 顶部枪械模式切换（预览界面按钮）：未点=初始态，点击=满状态 ──
let gunFull = false;
const gunBtn = document.getElementById('gun-mode-btn');
if (gunBtn) {
  gunBtn.onclick = () => {
    gunFull = !gunFull;
    gunBtn.textContent = gunFull
      ? '🔫 枪支：满状态（5弹道 / 10发每秒）'
      : '🔫 枪支：初始（1弹道 / 2发每秒）';
    gunBtn.classList.toggle('full', gunFull);
  };
}
const gunMode = () => (gunFull ? 'full' : 'preview');

// VR 进入即开局（pendingStartIndex 决定从第几关开始，默认第 1 关）
let pendingStartIndex = 0;
world.xr.addEventListener('sessionstart', () => {
  pageLog?.resumeScroll();
  game._renderPaused = false;      // 待机/异常路径冻结过主循环，这里恢复
  VRPlus.reportEvent('xr-start', { st: game.state, lvl: game.levelIndex });
  if (game.state === 'menu') game.start(pendingStartIndex, gunMode());
});
// 桌面：开始按钮（idx 0=第1关，2=第3关激光测试）
hud.onStart((idx = 0) => game.start(idx, gunMode()));

// ── 自定义 PICO 兼容 VR 进入按钮（参考 vr-controller-kit skill）──
// 不使用 three 自带 VRButton：改用 requiredFeatures:['local-floor'] + 无参回退，
// PICO 的 Chrome/105 不支持某些特性参数时才能顺利进入。
const enterVRBtn = document.getElementById('enter-vr-btn');
const statusMsg = document.getElementById('status-msg');

function showStatus(text, isError = false) {
  if (!statusMsg) return;
  statusMsg.textContent = text;
  statusMsg.style.display = 'block';
  statusMsg.classList.toggle('error', isError);
}

// ── 「进入 VR」按钮门禁（2026-09-19 第十二修；**第十四修定型判据**）──────────────────
// 【需求】按钮**默认隐藏**，直到**平台发送「开始游戏」**才显示 —— 不让人在非平台排期时刻
//   从 2D 预览界面点进 VR，开出一局平台不知道的游戏。右侧关卡面板点任一关也会进 VR → 与按钮同生死。
//
// 【第十四修：判据 = `?plat=1`（本页由 APK 拉起）｜为什么不能用「平台的开始指令」】
//   page-forensics (5).log 实测整局：平台对我们**零「开始」下行** —— 逐帧留痕里只有 8 条机位表
//   回执 + 1 条 `0x10 closeGame`，**没有** cmd3/4、没有 JSON 命令、没有单字节命令，
//   而且全程**没有 onNewIntent / 没有第二次 am start**（21:46:38 那一次拉起就是操作员点「开始游戏」）。
//   ⇒ 操作员点「开始游戏」在设备侧唯一的可见形态就是**平台拉起本页**（kill→copyfile→am start）。
//   所以第十三修「只认平台下发的 cmd3/4」在本部署永远等不到，玩家只能等 30 秒兜底
//   = 用户原话「平台点开始游戏好像没有反应，等时间到了才有进入 VR 弹窗」。
//   现在：**APK 打开本页时在网址带 `?plat=1`**（`MainActivity.getCastUrl`），页面据此直接开门禁；
//   平台若改版补发真指令（cmd3/4）也照旧开门禁 —— 两条并肩，互不冲突。
//
// 【第十三修留下的正确部分（不要回退）】
//   ① inbox `cmd=0` 机位表**不是**开局信号 —— 它只是平台收到我们 `0x01` 注册后的**回执**
//      （APK 每补发一次 0x01，10ms 后就来一张表）⇒ 任何一次 APK 启动都有它，与「是否开始这局」无关；
//   ② 平台驱动的拉起**不注入**本地 `cmd3 plat:true`（那是 APK 替平台说话，已删）—— 改用上面的 URL 参数，
//      语义诚实：它表达的是「本页是 APK/平台拉起来的」，而不是伪称「平台下发了开局指令」。
//
// 【什么时候重新关】平台结束本局（inbox `cmd=16` → 待机态，或旧 `cmd=5/6`）→ 门禁重新关闭，
//   等平台下一次「开始」。玩家自己按 A/B 退出 VR **不关**（那一局还在平台排期里，可以再进）。
//   下一局平台重拉 → 待机页被本地 `cmd3`(plat:true) 唤醒 / 页面被整页重载（带 `?plat=1`）→ 门禁重新开。
//
// 【兜底（绝不留现场卡死）】关闭后 30 秒仍无平台开局信号 → **无条件放行**（需求方 2026-09-19 选定）。
//   只对「**不是**我们拉起的页面」生效（玩家自己在 PICO 浏览器里打开 localhost:8080 / 幽灵页还原）；
//   **待机态（`game._closedIdle`，平台已结束本局）不兜底** —— 否则平台关闭 30 秒后按钮自己冒出来，
//   等于门禁又失效。`platformSeen` 只用来区分兜底原因，写进留痕：
//     · 平台不在场 → 「30 秒内没收到任何平台信号」= 正常自测；
//     · 平台在场却没有开局指令 → 「平台侧没发 cmd3/4」= 该需求只能由平台补指令（这条要上报）。
// 【强制开关】`?vrbtn=1` **完全旁路门禁**（按钮常显，应急/自测）；`?vrbtn=0` 永远隐藏。
//   改网址即可、不用重打包；APK 配置页的「直接显示进入 VR 按钮」勾选会自动加上 `&vrbtn=1`。
const VR_GATE_FALLBACK_MS = 30000;
const VR_GATE_FORCE = new URLSearchParams(location.search).get('vrbtn');  // '1' | '0' | null
const VR_GATE_PLAT = new URLSearchParams(location.search).get('plat') === '1';  // APK/平台拉起本页
const levelPanelEl = document.getElementById('level-panel');
const vrGate = { open: false, why: '', cd: null, platformSeen: false };

// ── ★ 第十五修：页面侧第二道保险「直播端授权」（问 APK 的 /api/guard）────────────────
// APK 层已经拦过一次（未放行连浏览器都不拉），这里防的是**绕过 APK 直接开页面**：
//   玩家在 PICO 浏览器里手输 http://localhost:8080/ 时，APK 进程活着但本次启动没过门禁
//   → 页面自己也不能放行（否则等于从侧门进了 VR）。
// 判据来自 MainActivity 的 LaunchGuard 结论缓存（同源查询，零网络成本）：
//   {"ok":true|false,"age":<ms>,"why":"..."}
// ⚠ **fail-closed**：查不到 / 解析失败一律按「未授权」处理（需求方选定的是硬闸门）。
//   现场出口有两个，都不用重打包：APK 配置页勾「跳过直播端校验」，或网址加 `?vrbtn=1`。
const vrGuard = { known: false, ok: false, why: '' };

// ── ★ 2026-09-22 新增：PCVR 模式（桌面浏览器 + SteamVR / OpenXR 运行时）──────────────
// 背景：`/api/guard` 是**头显 APK 特有的端点**（`GameServer.java:174`），PC 端 EXE 根本没有它
//   —— 实测 `GET /api/guard` 打到真 EXE 上是 `404` + 文本 `404 /api/guard`。
//   所以在 PC（SteamVR）上用浏览器打开这个页面时，这道「问 APK 要授权」的闸门
//   **永远不可能成立** → 页面被 fail-closed 挡住，进不了 VR。
// 处置：PCVR 下页面由**直播端 EXE 或本地服务器**托管，门禁改问「页面宿主」——
//   `/api/info` 已经带 `license:{ok,mode,why,daysLeft}`（`cast-pc/main.js:434`）
//   ⇒ **不用重打包 EXE、更不用 APK**。
// 【判据】两条同时成立才算 PCVR：
//   ① 非 Android —— 头显独立模式（PICO 浏览器）UA 里必有 Android；
//   ② `navigator.xr.isSessionSupported('immersive-vr') === true` —— 桌面 Chrome/Edge 只有装了
//      OpenXR 运行时（SteamVR 设为默认 OpenXR runtime）时才为 true，普通网页恒为 false。
//   ⇒ 这条天然把「真有 PCVR 环境」和「随便打开个网页」分开，不会误开门。
// 【强制开关】`?pcvr=1` 强制按 PCVR 处理；`?pcvr=0` 强制关掉（对照实验 / 排除误判）。改网址即可。
const PCVR_FORCE = new URLSearchParams(location.search).get('pcvr');  // '1' | '0' | null

/** 是否 PCVR（桌面浏览器 + 可用 XR 运行时）。**异步** —— isSessionSupported 返回 Promise。 */
async function detectPcvr() {
  if (PCVR_FORCE === '1') return true;
  if (PCVR_FORCE === '0') return false;
  try {
    if (!navigator.xr) return false;
    // 头显独立模式（PICO / Quest / 其它 Android 系头显浏览器）→ 一律走 APK 门禁，绝不误判成 PCVR
    if (/Android|Pico|Oculus|Quest|Vive|Focus/i.test(navigator.userAgent || '')) return false;
    return await navigator.xr.isSessionSupported('immersive-vr');
  } catch (e) {
    return false;        // 查不出来就当「不是 PCVR」，保证非 PC 场景行为完全不变
  }
}

/** 把门禁状态贴到界面上：开门禁 = 显示「进入 VR」按钮 + 右侧关卡面板；关着 = 都藏起来 + 一行提示 */
function applyVRGate() {
  // XR 会话进行中绝不显示 DOM 按钮（虽然沉浸式下 DOM 本来不参与渲染，但退出瞬间会闪一下）
  const inXR = !!(world && world.renderer && world.renderer.xr && world.renderer.xr.isPresenting);
  // ★ 第十五修：再加一道「直播端是否放行」。`?vrbtn=1` 是总旁路，优先级最高。
  const guardBlocked = vrGuard.known && !vrGuard.ok && VR_GATE_FORCE !== '1';
  const show = vrGate.open && !inXR && !guardBlocked;
  if (enterVRBtn) enterVRBtn.style.display = show ? 'block' : 'none';
  // 右侧「关卡快捷」面板点任一关也会进 VR → 与按钮同生死（不留第二个入口）
  if (levelPanelEl) levelPanelEl.style.display = show ? 'flex' : 'none';
  if (show) {
    if (statusMsg && !statusMsg.classList.contains('error')) statusMsg.style.display = 'none';
  } else if (guardBlocked) {
    showStatus('⛔ 未连接直播端，无法开始游戏');
  } else {
    showStatus('⏳ 等待平台开始游戏…');
  }
}

/**
 * 查一次直播端授权。页面启动时调一次即可 ——
 * 结论在启动路径上定死，页面运行期间不会变（要变只能等下一次拉起）。
 * **两条路径**：
 *   · 头显独立模式 → 问 **APK** 的 `/api/guard`（LaunchGuard 结论）；
 *   · **PCVR**（桌面浏览器 + XR 运行时）→ 问页面宿主 **EXE** 的 `/api/info`（见 gateQueryPcvr）。
 * **fail-closed**：查到 ok=false、或请求/解析失败，一律不放行（硬闸门口径）。
 */
async function gateQueryGuard() {
  // ★ 2026-09-22：PCVR 没有 APK，也不该问 APK —— 交给「谁托管页面谁负责门禁」
  if (await detectPcvr()) return gateQueryPcvr();
  try {
    const r = await fetch('/api/guard', { cache: 'no-store' });
    const j = await r.json();
    vrGuard.known = true;
    vrGuard.ok = !!j.ok;
    vrGuard.why = j.why || '';
  } catch (e) {
    vrGuard.known = true;
    vrGuard.ok = false;                       // ← fail-closed：查不到就当未授权
    vrGuard.why = '查询失败：' + (e && e.message ? e.message : e);
  }
  vrGateLog('直播端授权：' + (vrGuard.ok ? '已放行' : '未放行') + '（' + (vrGuard.why || '无原因') + '）');
  try { VRPlus.reportEvent('vr-guard', { ok: vrGuard.ok, why: vrGuard.why }); } catch (e) { /* 留痕失败不影响游玩 */ }
  applyVRGate();
}

/**
 * ★ 2026-09-22 新增：PCVR 模式的门禁 —— 问**页面宿主（直播端 EXE）**要授权结论。
 * 语义与头显侧对齐：**谁托管这个页面，谁负责门禁**。
 *   · 头显：页面由 APK 托管 → 问 `/api/guard`（LaunchGuard 结论）
 *   · PCVR：页面由 EXE / 本地服务器托管 → 问 `/api/info` 的 `license` 字段（激活/续期结论）
 *
 * 判据三态（都写进日志与留痕，现场一眼看出走的是哪条）：
 *   ① `license.ok === true`  → **放行**（有直播端且授权有效）
 *   ② `license.ok === false` → **不放行**（直播端在、但授权无效或已到期 —— 这才是真该拦的）
 *   ③ 拿不到 `/api/info`（页面不由 EXE 托管，例如用本地静态服务器打开）→ **放行**，
 *      原因写「未发现直播端，按纯 PCVR 放行」。
 *      ⚠ ③ 是**有意为之的 fail-open**：PCVR 本就没有 APK，也允许不经 EXE 开页面。
 *      要改成严格（拿不到就拦），把下面两处 `vrGuard.ok = true` 改成 `false` 即可。
 *
 * 另：PCVR 没有 VR+ 平台，所以平台门禁也直接跟授权结论走 ——
 *   否则页面要白等 `VR_GATE_FALLBACK_MS`（30 秒）兜底才放出「进入 VR」按钮。
 */
async function gateQueryPcvr() {
  // 先问授权、再开门禁 —— 避免「进入 VR」按钮闪现一下又消失
  try {
    const r = await fetch('/api/info', { cache: 'no-store' });
    const j = await r.json();
    const lic = (j && j.license) || null;
    vrGuard.known = true;
    if (!lic) {
      vrGuard.ok = true;                        // ③ 宿主不认这个端点 → 纯 PCVR 自测
      vrGuard.why = 'PCVR：未发现直播端（页面不是 EXE 托管），按纯 PCVR 放行';
    } else {
      vrGuard.ok = !!lic.ok;                    // ① / ②
      vrGuard.why = 'PCVR · 直播端授权' + (lic.ok ? '通过' : '未通过')
        + '（' + (lic.why || lic.mode || '无原因') + '），剩余 '
        + (lic.daysLeft != null ? lic.daysLeft : '?') + ' 天';
    }
  } catch (e) {
    vrGuard.known = true;
    vrGuard.ok = true;                          // ③ 同上：宿主不是 EXE
    vrGuard.why = 'PCVR：未发现直播端（' + (e && e.message ? e.message : e) + '），按纯 PCVR 放行';
  }
  setVRGate(vrGuard.ok, 'PCVR 模式（桌面浏览器 + XR 运行时）：门禁跟随直播端授权'
    + (vrGuard.ok ? '（已放行）' : '（未放行）'));
  vrGateLog('直播端授权：' + (vrGuard.ok ? '已放行' : '未放行') + '（' + vrGuard.why + '）');
  try { VRPlus.reportEvent('vr-guard', { ok: vrGuard.ok, why: vrGuard.why, mode: 'pcvr' }); } catch (e) { /* 留痕失败不影响游玩 */ }
  applyVRGate();
}

function vrGateLog(msg) {
  try { game.log('[门禁] ' + msg); } catch (e) { /* 日志失败绝不影响游戏 */ }
}

/** 起「兜底放行」计时（门禁每次变化都重置；已开 / 强制隐藏 / 待机态时不计时） */
function scheduleGateFallback() {
  if (vrGate.cd) { clearTimeout(vrGate.cd); vrGate.cd = null; }
  if (vrGate.open || VR_GATE_FORCE === '0') return;
  // 第十四修：**待机态不兜底**。平台已结束本局（`_closedIdle`）时门禁就该一直关着等下一次「开始」，
  //   若还按 30 秒兜底放行，平台一关游戏、半分钟后按钮自己又冒出来 = 门禁等于没做。
  if (game._closedIdle) return;
  vrGate.cd = setTimeout(() => {
    vrGate.cd = null;
    // 计时期间平台把本局关了（或已进待机态）→ 撤销这次兜底（回调里再查一次，防「装计时器时还没待机」）
    if (game._closedIdle) { vrGateLog('兜底取消：本局已结束（待机态），等平台下一次开始'); return; }
    setVRGate(true, '门禁兜底：' + Math.round(VR_GATE_FALLBACK_MS / 1000) + ' 秒内没有收到平台开局信号'
      + (vrGate.platformSeen ? '（平台**在场**却没发 cmd3/4 → 该需求只能由平台侧补一条指令）'
                             : '（平台不在场，按自测处理）'));
  }, VR_GATE_FALLBACK_MS);
}

/**
 * 开关门禁。任何一次调用都会**重置兜底计时**（关闭时重新起算）。
 * @param {boolean} open
 * @param {string} why 触发原因（进日志/留痕，排查时一眼看出是谁开的门）
 */
function setVRGate(open, why) {
  if (VR_GATE_FORCE === '1') { open = true; why = '?vrbtn=1 旁路门禁（按钮常显）'; }
  else if (VR_GATE_FORCE === '0') { open = false; why = '?vrbtn=0 强制隐藏'; }
  const next = !!open;
  const changed = (next !== vrGate.open) || (why !== vrGate.why);
  vrGate.open = next;
  vrGate.why = why;
  scheduleGateFallback();
  if (changed) {
    vrGateLog('门禁' + (next ? '打开' : '关闭') + '：' + why);
    VRPlus.reportEvent('vr-gate', { open: next, why });   // 进 APK 留痕，事后可对账
  }
  applyVRGate();
}

// 平台信号 → 门禁：game.js 收到 inbox 指令时回调（见 game.js._platformSignal）
game.platformHooks = {
  onStart: (why) => setVRGate(true, why),
  onEnd: (why) => setVRGate(false, why),
  // onSeen =「平台在场」（收到过平台下发的东西，但未必是开局）→ 只影响兜底时长的判读与留痕
  onSeen: (why) => {
    if (vrGate.platformSeen) return;
    vrGate.platformSeen = true;
    VRPlus.reportEvent('vr-seen', { why });
    vrGateLog('检测到平台在场（' + why + '）→ 只做留痕，不改门禁（门禁由 ?plat=1 与 cmd3/4 决定）');
  },
};

// 启动默认：`?plat=1`（APK/平台拉起本页）→ 直接开；否则关着等平台。`?vrbtn=1` → 常显
setVRGate(VR_GATE_PLAT || VR_GATE_FORCE === '1',
  VR_GATE_PLAT ? 'APK/平台拉起本页（?plat=1）→ 视为平台已开始本局'
    : (VR_GATE_FORCE === '1' ? '?vrbtn=1 旁路门禁（调试）'
                             : '页面启动：等平台发送开始游戏'));

// ★ 第十五修：再查一次「直播端是否放行」（同源、本地、毫秒级）——
//   两者都成立才给「进入 VR」按钮：APK 说「本页是平台拉起来的」+ APK 说「直播端放行了」。
gateQueryGuard();


async function enterVR() {
  if (enterVRBtn.disabled) return;
  enterVRBtn.disabled = true;
  enterVRBtn.textContent = '⏳ 启动中...';
  try {
    if (!navigator.xr) throw new Error('浏览器不支持 WebXR（需 https 或 localhost + 支持 WebXR 的头显浏览器）');

    let session;
    try {
      if (navigator.xr.isSessionSupported) {
        const ok = await navigator.xr.isSessionSupported('immersive-vr');
        if (!ok) throw new Error('设备不支持 immersive-vr');
      }
      session = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'] });
    } catch (e) {
      // PICO 兼容：带参失败则无参回退
      console.log('使用 PICO 兼容模式:', e.message);
      session = await navigator.xr.requestSession('immersive-vr');
    }

    await world.renderer.xr.setSession(session);
    enterVRBtn.style.display = 'none';
    if (statusMsg) statusMsg.style.display = 'none';
  } catch (err) {
    showStatus('❌ ' + err.message, true);
    enterVRBtn.disabled = false;
    enterVRBtn.textContent = '🎈 进入 VR';
  }
}

// ── 会话结束 = 本局结束（2026-09-19 第十修：删掉「继续游戏」封盖）──
//
// 【为什么删】六修曾加过一套兜底：会话被别的应用抢走时保留本局 + 全屏「▶ 继续游戏（返回 VR）」。
//   第十次实测定论（page-forensics (2).log）：
//     · 19:38:24 平台重拉 → 留痕出现「本次走「免打扰」路径（主题=无窗口 NoDisplay）」，
//       页面**没有** visibility:hidden、秒级零重载唤醒成功 ⇒ 源头病根已治好；
//     · 19:39:00 玩家点那个按钮，落到的却是 **2D 预览界面**（并没有真的在 VR 里续上本局），
//       于是它从「兜底」变成了「多一次误导性点击」。
//   结论：既然不再被弹，就该把兜底一起清掉 —— 会话结束就干净地回菜单，
//   等平台/玩家重新开始，不再保留半截状态。
//
// 会话结束：恢复按钮；并「暂停日志滚动」防止报错信息丢失
world.xr.addEventListener('sessionend', (ev) => {
  pageLog?.pauseScroll();
  const st = game.state;
  const byPlayer = !!(ev && ev.session && ev.session._endedByPlayer);  // 玩家按 A/B
  const idle = !!game._closedIdle;                                     // 平台明说关闭 → 待机态
  VRPlus.reportEvent('xr-end', { st, byPlayer, idle, vis: document.visibilityState });
  game.toMenu();            // B/退出 VR 后真正回到未开始状态（state='menu' 并清场，重进 VR 即从干净状态开局）
  pendingStartIndex = 0; // 复位，下次默认从第 1 关开始
  enterVRBtn.disabled = false;
  enterVRBtn.textContent = '🎈 进入 VR';
  // 第十二修：显示与否交给门禁 —— 玩家自己退出 VR 时门禁仍开着（按钮照常出现，可以再进）；
  // 平台已结束本局时门禁是关的（保持隐藏，等平台下一次「开始」再出现）。
  applyVRGate();
});

// 探测 WebXR 支持情况，给出明确提示
if (navigator.xr && navigator.xr.isSessionSupported) {
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
    if (!ok) {
      enterVRBtn.textContent = '桌面模式（无 VR 设备）';
      enterVRBtn.disabled = true;
      // 第十二修：桌面（没有 immersive-vr）根本没得「进入 VR」，门禁对它毫无意义
      // —— 直接放行，免得桌面自测时按钮被藏 30 秒。
      setVRGate(true, '桌面（无 VR 设备）→ 门禁不适用，直接放行');
    }
  }).catch(() => {});
} else {
  enterVRBtn.textContent = '桌面模式（需 https/头显）';
  enterVRBtn.disabled = true;
}

// 进入 VR：默认第 1 关（其余关用右侧 #level-panel 面板进入）
enterVRBtn.onclick = () => { audio.unlock(); pendingStartIndex = 0; enterVR(); };

// ── 右侧关卡快捷进入面板 ──
// 普通关仅显示数字；特殊关（危机/激光/Boss）在数字后附加最多三个汉字标签。
// 点击：桌面（无 VR 设备）直接开局预览；头显（PICO 浏览器）支持 WebXR 则进 VR 后由 sessionstart 触发。
function levelShortTag(lv) {
  if (lv.kind === 'normal') return '';
  if (lv.kind === 'crisis') return '危机';
  if (lv.kind === 'laser') return '激光';
  return lv.boss === 'dragon' ? '龙关' : '首领'; // boss 子类：龙 Boss=龙关，其余=首领
}
async function startLevelAt(idx) {
  audio.unlock();
  pendingStartIndex = idx;
  const mode = gunMode();
  const xrOk = (navigator.xr && navigator.xr.isSessionSupported)
    ? await navigator.xr.isSessionSupported('immersive-vr').catch(() => false)
    : false;
  if (xrOk) {
    // 第十二修：门禁期间不进 VR（面板此时已被 applyVRGate 藏起来，这里再兜一道，
    // 防止有人用键盘/脚本直接触发）
    if (!vrGate.open) { showStatus('⏳ 等待平台开始游戏…'); return; }
    enterVR();      // 头显：进 VR 后 sessionstart 触发 game.start(pendingStartIndex, mode)
  } else game.start(idx, mode);     // 桌面：直接开局预览
}
(function buildLevelPanel() {
  const panel = document.getElementById('level-panel');
  if (!panel) return;
  LEVELS.forEach((lv, i) => {
    const tag = levelShortTag(lv);
    const btn = document.createElement('button');
    btn.className = 'level-btn ' + lv.kind;
    btn.innerHTML = `<span class="num">${lv.n}</span>` + (tag ? `<span class="tag">${tag}</span>` : '');
    btn.title = `进入第 ${lv.n} 关（${lv.kind}）`;
    btn.onclick = () => { startLevelAt(i); };
    panel.appendChild(btn);
  });
})();

const clock = new THREE.Clock();
world.renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  // ★ 待机态（平台已关闭本局 / 与平台断连）：页面留着等平台叫回，但**不跑逻辑也不渲染** ——
  //   72fps 空转只会让头显发烫、掉电，而封盖下面没有任何要更新的东西。
  //   唤醒点：cmd3/4 或 game.start()（都会清 _renderPaused，见 game.js）。
  if (game._renderPaused) return;
  // 单帧异常只记录、不向上抛：否则会中断 XR 动画循环的排帧，导致 VR 黑屏
  try { game.update(dt); } catch (e) { console.error('[主循环] game.update 异常:', e); }
  try { world.render(); } catch (e) { console.error('[主循环] world.render 异常:', e); }
  // 直播推流：必须在 world.render() 之后 —— 此时 camera.matrixWorld 才是本帧最终位姿；
  // 且 XR 帧已提交，观众渲染再慢也只挤占下一帧预算，不拖慢本帧。
  try { cast.update(dt); } catch (e) { console.error('[主循环] cast 异常:', e); }
});

window.__game = game; // 调试用
window.__cast = cast; // 调试用（__cast.stats() 查看推流状态）
