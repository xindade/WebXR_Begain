import * as THREE from 'three';
import { World } from './core/world.js';
import { PauseState } from './core/pause.js';
import { loadSettings } from './core/settings.js';
import { PerformanceMonitor } from './core/performance.js';
import { GameControls } from './ui/settings.js';
import { HUD } from './ui/hud.js';
import { AudioManager } from './vr/audio.js';
import { InputManager } from './vr/input.js';
import { watchXRAvailability } from './vr/availability.js';
import { WristUI } from './vr/wrist-ui.js';
import { Game } from './game/game.js';
import { prewarmIntroVideo } from './game/introVideo.js';
import { LEVELS } from './content/levels.js';
import { preloadDragonAssets } from './game/dragonLevel.js';
import { preloadGLB } from './game/glbCache.js';
import { SKY_PANORAMA, MASTER_GATE, RELEASE_UI, LOADOUTS } from './core/constants.js';
import { MODEL_URL as PORTAL_MODEL_URL } from './game/portal.js';
import { MODEL_URL as OPENING_MODEL_URL } from './game/openingModel.js';
import { createCast } from './net/cast.js';
import { VRPlus } from './net/vrplus.js';
import { MirrorManager, isDesktopPage } from './core/mirror.js';
import { MIRROR, RENDER } from './core/constants.js';

// ── 正式版界面裁剪 + 功能裁剪（2026-09-23 需求）───────────────────────────────
// 【界面】不创建「暂停 / 继续 / 设置 / 日志 / 导出性能记录」控制条、桌面「开始游戏」按钮，
//         并隐藏右侧「关卡快捷」选关面板、枪支模式、操作提示。
// 【功能】用户明确要求「不只是标签去掉，还要把功能去掉」⇒ 正式包里这些能力**整体不存在**：
//         · 暂停：focusPause 直接返回、失焦/可见性/XR 会话三条监听不注册、主循环的 A/B 菜单键
//                 分支不走 ⇒ pause.paused 恒为 false（PauseState 对象仍在，但没有任何路径能加原因）；
//         · 设置：设置对话框只在 devUI 下创建（src/ui/settings.js），正式包无入口；
//         · 性能：PerformanceMonitor **不构造**，每帧 monitor.record() 不执行（省一份每帧开销）；
//         · PC 模式（桌面「开始游戏」）：按钮不创建、onStart 不接线；
//         · 日志：window.__pageLog.disable()（下方）+ index.html 的 body.release .pagelog 兜底；
//         · 选关：#level-panel 不建（buildLevelPanel 早退）+ CSS 隐藏。
// 判据：编译时常量 RELEASE_UI（src/core/constants.js；正式包 true）+ 网址 ?devui=1 旁路
//      （现场排障要把调试入口调回来时用，不必重打包）。
const RELEASE = RELEASE_UI && !new URLSearchParams(location.search).has('devui');
// 其余静态元素（枪支模式 / 操作提示 / 选关面板）由 index.html 的 body.release 规则隐藏
if (RELEASE) document.body.classList.add('release');
// 正式包关掉「最高优先级页面日志」整块：不只是看不见，还**不再建 DOM、不再逐条 append**。
//   接口由 src/ui/pagelog.js 提供；那里是经典脚本（拿不到 RELEASE_UI），故由这里按 RELEASE 关。
if (RELEASE) window.__pageLog?.disable?.();

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
const settings = loadSettings();
world.skyMaxDimension = settings.skySize;
const mirror = new MirrorManager(world.renderer, world.scene);  // VR 桌面镜像（独立弹出窗口显示头显第一人称）

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
  Promise.all([...skyTasks, dragonTask, glbTask]).catch(() => {}); // 触发加载（帧循环独立读取进度）
})();

const hud = new HUD({ devUI: !RELEASE });
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
game.setSystems(audio, input, wristUI, pageLog, cast);   // cast：直播模式下本局结束要停推流（见 game.js）

// ★ 正式包不构造性能监视器（2026-09-23 功能裁剪）：不采样、不问 renderer.info，
//   界面侧本来也没有读数区（GameControls.updateStats 在正式包是空实现）。
const monitor = RELEASE ? null : new PerformanceMonitor();
let controls;
const pause = new PauseState(paused => {
  input.reset(); audio.setPaused(paused);
  if (paused) document.exitPointerLock?.();
  controls?.showPaused(paused);
});
function applySettings(next) {
  game.rig.position.y += next.heightOffset - input.settings.heightOffset;
  input.setSettings(next); audio.setVolume(next.volume);
}
function resumeGame() {
  if (document.hidden || (world.xr.getSession() && world.xr.getSession().visibilityState !== 'visible')) return;
  pause.remove('manual'); pause.remove('error');
}
function exitGame() {
  if (world.isPresenting) world.xr.getSession()?.end().catch(console.warn);
  else { game.toMenu(); pause.clear(); }
}
controls = new GameControls({ world, game, pause, settings, onSettings: applySettings, onResume: resumeGame, onExit: exitGame, monitor });
applySettings(settings);
function focusPause(reason, hidden) {
  // ★ 正式包：暂停**功能**整体不存在（2026-09-23 需求：不只是藏掉「暂停/继续」按钮）。
  //   这里是最后一道保险 —— 任何残余调用都不会让正式包停住。
  if (RELEASE) return;
  if (game.state === 'menu') return;
  if (hidden) { pause.add('manual'); pause.add(reason); }
  else pause.remove(reason); // 恢复焦点仍需玩家明确继续
}
// 下面这些「失焦 / 页面不可见 / XR 会话不可见 → 暂停」的接线**只在调试包注册**：
//   正式包没有暂停功能，注册了只会白占监听器（而且一暂停就再也回不来）。
//   ⚠ 桌面自测时「指针锁丢失 = 暂停」也只有调试包才接线（正式包没有可见的「继续」界面）。
if (!RELEASE) {
  input.onUnlock = () => focusPause('manual', true);
  window.addEventListener('blur', () => focusPause('window', true));
  window.addEventListener('focus', () => pause.remove('window'));
  document.addEventListener('visibilitychange', () => focusPause('hidden', document.hidden));
  world.xr.addEventListener('sessionstart', () => {
    const session = world.xr.getSession();
    const onVisibility = () => focusPause('xr', session.visibilityState !== 'visible');
    session.addEventListener('visibilitychange', onVisibility);
    session.addEventListener('end', () => session.removeEventListener('visibilitychange', onVisibility), { once: true });
  });
}
function startGame(index, mode, intro, loadout = null) {
  pause.clear(); input.reset(); game.start(index, mode, intro, loadout);
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
// pendingPlayIntro：是否播「进入游戏」开场视频 —— 只有主按钮进第 1 关时为 true；
//   关卡直达面板为 false（直接进对应关）。最终是否播还由 game.start 里 INTRO_VIDEO.ENABLED
//   与 world.isPresenting（必须真在 VR 会话内）共同决定。
let pendingStartIndex = 0;
let pendingPlayIntro = false;
world.xr.addEventListener('sessionstart', () => {
  pageLog?.resumeScroll();
  game._renderPaused = false;      // 待机/异常路径冻结过主循环，这里恢复
  VRPlus.reportEvent('xr-start', { st: game.state, lvl: game.levelIndex });
  // ⚠ 帧缓冲缩放：本工程**不调用** renderer.xr.setFramebufferScaleFactor（保持 three 默认 1.0，
  //   原因见 enterVR 内的注释）。此处若再设置，因 sessionstart 时 isPresenting 已为 true，
  //   three 会拒绝并报警告 "Cannot change framebuffer scale while presenting"。故此处只触发开局。
  if (game.state === 'menu') startGame(pendingStartIndex, gunMode(), pendingPlayIntro, pendingLoadout);
});
// 桌面：开始按钮（idx 0=第1关，2=第3关激光测试）—— 桌面预览不播开场视频
// 桌面「开始游戏」按钮：正式包不创建（见 src/ui/hud.js 的 devUI），故只在调试包接线
if (!RELEASE) hud.onStart((idx = 0) => { audio.unlock(); startGame(idx, gunMode(), false); });

// ── 自定义 PICO 兼容 VR 进入按钮（参考 vr-controller-kit skill）──
// 不使用 three 自带 VRButton：改用 requiredFeatures:['local-floor'] + 无参回退，
// PICO 的 Chrome/105 不支持某些特性参数时才能顺利进入。
// ★ 第二十二修：「进入 VR」由单个按钮改为**二选一**开局加成（蓝=射速加倍/攻击减半，红=攻击加倍/射速减半）。
//   enterVrBtns[0] ↔ LOADOUTS.rapid（蓝）、enterVrBtns[1] ↔ LOADOUTS.power（红）；
//   点哪个都会进游戏，并把 loadout 键名一路传到 game.start → Player.reset 改初始属性。
const enterVRBox = document.getElementById('enter-vr-box');
const enterVrBtns = [
  document.getElementById('enter-vr-rapid'),
  document.getElementById('enter-vr-power'),
].filter(Boolean);
/** 兼容旧引用点（只关心「有没有按钮 / 是否忙碌」），取第一个按钮即可 */
const enterVRBtn = enterVrBtns[0] || null;
let pendingLoadout = null;      // 本局开局加成（'rapid' / 'power' / null），由 sessionstart 消费
const enterVrDisabled = () => enterVrBtns.some((b) => b.disabled);
const setEnterVrDisabled = (v) => { for (const b of enterVrBtns) b.disabled = v; };
/** 进 VR 期间：两个按钮都禁用，只有被点那个显示「启动中」 */
function setEnterVrBusy(loadoutKey) {
  setEnterVrDisabled(true);
  const idx = loadoutKey === 'power' ? 1 : (loadoutKey === 'rapid' ? 0 : -1);
  if (idx >= 0 && enterVrBtns[idx]) enterVrBtns[idx].textContent = '⏳ 启动中...';
}
/** 复位两个按钮文案（进不去 / 退出 VR 后） */
function resetEnterVrLabels() {
  if (enterVrBtns[0]) enterVrBtns[0].textContent = LOADOUTS.rapid.label;
  if (enterVrBtns[1]) enterVrBtns[1].textContent = LOADOUTS.power.label;
}
const statusMsg = document.getElementById('status-msg');
let vrStarting = false;
const mirrorBtn = document.getElementById('mirror-btn');
// ★ 第二十三修：镜像按钮 / 「PC 镜像」标签只在「游戏页跑在桌面 PC」时有意义（头显上没有第二块屏，
//   点了只会被拒）。故非桌面环境（头显）与正式包都直接不显示：给 body 加类，由 index.html 的 CSS
//   统一压掉（!important，避免 mirror.js 写行内 display 时把标签又露出来）。
if (!isDesktopPage() || RELEASE) document.body.classList.add('no-mirror');
if (mirrorBtn) {
  mirrorBtn.onclick = () => {
    if (!MIRROR.ENABLED) { showStatus('镜像功能已关闭（userConfig.MIRROR.ENABLED）'); return; }
    if (!isDesktopPage()) { showStatus('镜像需在 PC 端运行：游戏跑在头显时无法显示副窗口'); return; }
    const ok = mirror.open();
    if (!ok) showStatus('镜像窗口被拦截：请允许本站点弹窗后重试');
  };
}

function showStatus(text, isError = false) {
  if (!statusMsg) return;
  statusMsg.textContent = text;
  statusMsg.style.display = 'block';
  statusMsg.classList.toggle('error', isError);
}

// ── 「进入 VR」按钮门禁（2026-09-19 第十二修 → 2026-09-23 第十八修定型）───────────────
// 【需求】按钮**默认隐藏**，直到**平台/主控端发「开始游戏」**才显示 —— 不让人在非排期时刻从 2D
//   预览界面点进 VR，开出一局平台不知道的游戏。右侧关卡面板点任一关也会进 VR → 与按钮同生死。
//
// 【第二十修（2026-09-23 晚）：判据 = **平台点「开始游戏」**（+ PC 主控端实时结论）】
//   用户第五次现场实测：平台操作员是**两步** ——
//     ① 「启动游戏」= 启动器通道 `{"cmd":"start"}` → 拉起 PC 端 EXE + 头显里的游戏（本页）；
//     ② 「开始游戏」= **游戏通道 CMD 5 GameStart**（UDP 51124）→ **这时头显才该出现「进入 VR」**。
//   第十九修把 ①（EXE 被平台拉起）当成了开局 ⇒ 头显在②之前就冒出按钮（用户实测的错）。
//   现在两条**实时**判据并肩，谁先到算谁：
//     · 平台的 GameStart → APK 入队 inbox cmd=21 → game.js 回调 onStart → vrPlatStart = true；
//     · PC 主控端的 /api/master/allow（PC 端自己也收那一帧，或操作员手动点「▶ 开始本局」）。
//   ⚠ 页面每 2 秒问一次 PC（只带设备号，**不带**放行条 —— 放行条 TTL 只有 60 秒，第二局必然
//     过期，见 F:/desk/第二次日志.txt 19:41:20）；PC 点「结束本局 / 平台关闭」→ 关门禁并收尾。
//   ⚠ 第十三修留下的正确部分（不要回退）：inbox cmd=0 机位表**不是**开局信号，它只是注册回执。
//
// 【第十三修留下的正确部分（不要回退）】
//   ① inbox cmd=0 机位表**不是**开局信号 —— 它只是平台收到我们 0x01 注册后的**回执**，
//      任何一次 APK 启动都有它，与「是否开始这局」无关；
//   ② onSeen 只做留痕，不改门禁。
//
// 【兜底（绝不留现场软锁）】门禁**归主控端管**时（MASTER_GATE_ON 且非桌面豁免）**不做** 30 秒
//   无条件放行 —— 否则主控端还没点「开始本局」，按钮半分钟后自己冒出来 = 门禁等于没做。
//   只有「门禁不归主控端管」的场合（调试包 / ?gate=0 / 桌面预览）才保留 30 秒兜底。
// 【强制开关】网址 ?vrbtn=1 **完全旁路门禁**（按钮常显，应急/自测）；?vrbtn=0 永远隐藏。
//   改网址即可、不用重打包；APK 配置页的「直接显示进入 VR 按钮」勾选会自动加上 &vrbtn=1。
const VR_GATE_FALLBACK_MS = 30000;
const VR_GATE_FORCE = new URLSearchParams(location.search).get('vrbtn');  // '1' | '0' | null
// APK/平台拉起本页（?plat=1）——**只作留痕**，不再当开局信号（第十八修，见上）
const VR_GATE_PLAT = new URLSearchParams(location.search).get('plat') === '1';  // APK/平台拉起本页const VR_GATE_PLAT = new URLSearchParams(location.search).get('plat') === '1';  // APK/平台拉起本页
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

// ── ★ 主控门禁「允许运行」（《打包和平台对接》第 3 条；第十八修改为**轮询**）────────────
// 【需求】正式包里**必须**由 PC 主控端明确回「允许运行」才让进游戏；就算有人绕过 APK 直接在浏览器
//   里打开本页也进不去（用户原话：「exe 正常运行时会给 apk 发指令，apk 才会正常运行，否则会提示
//   『需要主控端启动』」），并且要**等平台/主控端发「开始游戏」信号后才能点**。
// 【判据来源】PC EXE 的 POST /api/master/allow —— 与 APK 的 /api/launch/request **同一套判定**
//   （tools/cast-pc/main.js 的 masterAllow）。**不另立标准**：两处判据漂移会造出「APK 放行了、
//   页面却拒绝」的现场事故。
// 【为什么是轮询而不是一次性的放行条】放行条（dev/exp/voucher）TTL 只有 60 秒，页面在第二局带着
//   上一局的条子复验必然「已过期」（F:/desk/第二次日志.txt 19:41:20）⇒ 改为每 2 秒问一次、每次只
//   报设备号 —— 判据落在 PC 的**实时**状态（主控端「开始本局 / 结束本局」）上。
// 【为什么同源就能问到 PC】头显侧本页由 APK 的 GameServer 托管，它把 /api/* 原样代理到 PC
//   （GameServer.proxyApi）⇒ 页面发 /api/master/allow 实际就是问 PC。
// 【开关】编译时常量 MASTER_GATE（正式包 true / 调试包 false）；网址 ?gate=0 旁路（优先级最高，
//   现场应急不必重打包）；?gate=1 可强制打开做对照。
// 【绝不留现场卡死】5 秒超时；失败**只记状态、不软锁**：已放行的一次传输抖动不会把场次踢回门禁外，
//   且界面常驻「重试」按钮（updateGateRetryBtn）。
const GATE_FORCE = new URLSearchParams(location.search).get('gate');   // '0' | '1' | null
const MASTER_GATE_ON = GATE_FORCE === '1' || (MASTER_GATE && GATE_FORCE !== '0');
const GATE_TIMEOUT_MS = 5000;
const GATE_POLL_MS = 2000;         // 门禁关着时的轮询间隔（等主控端「开始本局」）
const GATE_POLL_IDLE_MS = 5000;    // 已放行后的轮询间隔（只为感知「结束本局」，放慢省电）
const _gateQ = new URLSearchParams(location.search);
const vrMaster = {
  known: false,          // 是否拿到过 PC 的**明确**结论
  ok: false,             // 结论：本局是否已放行
  why: '',               // PC 给的原因（原文，进日志与现场提示）
  round: false,          // PC 回的「本轮是否已开始」（false = 还没点「开始本局」）
  armedPrev: false,      // 上一次轮询的放行结论（用来识别「结束本局」的 1→0 跳变）
  exempt: false,         // 桌面（无 VR 设备）等场景豁免：本就没有「平台不知道的一局」
  err: false,            // 最近一次查询**失败**（连不上/超时）—— 只有它才让「重试」按钮出现
  dev: _gateQ.get('dev') || '',   // 设备号：网址带的（APK 拼的）或从 /api/guard 取的（更权威）
  pc: _gateQ.get('pc') || '',     // APK 已探测到的 PC 地址（提示用）
};
/**
 * ★ 第二十修：**平台本人说了「开始游戏」**（游戏通道 CMD 5 GameStart → APK 入队 cmd=21 →
 * game.js 的 onStart 回调）。
 *
 * 为什么它单独算一条放行：现场实测平台是两步，第二步那一帧才是开局信号，且它是**平台本人**
 * 发的 —— 权威性高于任何本地推断（旧实现在这里用的是「APK 拉起页面」= 第一步，于是头显早早
 * 就冒出「进入 VR」）。抓包显示该帧可能只发给 PC 那台机器：那种情况下放行由 PC 的
 * /api/master/allow 给（PC 端自己也收这一帧，见 tools/cast-pc 的 startPlatformGameChannel）。
 * 两条路互不依赖，谁先到算谁；都没有时，现场仍有 PC 界面的「▶ 开始本局」手动口子。
 */
let vrPlatStart = false;
/** 本局的「平台已开始」是否已回报给 PC 主控端（一局只报一次，见 reportPlatformStartToMaster） */
let vrPlatStartReported = false;

/**
 * 主控门禁的最终判据（第十八修）：**PC 说本局已放行**才算过。
 *   ① 门禁没启用（调试包 / 网址 ?gate=0）→ 不拦；
 *   ② 桌面（无 VR 设备，vrMaster.exempt）→ 不拦（本就没有「平台不知道的一局」）；
 *   ③ 其余 → 只认「本页轮询到 PC 回 allow」。
 * ⚠ **不再**用「APK 拉起本页（?plat=1）」或「APK 的授权结论（/api/guard ok）」放行 —— 那两条只能
 *   证明「有人开了这一局页面」，证明不了「平台/主控端现在要开始这一局」（用户实测：头显一连上 PC
 *   就能点进 VR）。
 */
function masterGateAllowed() {
  // ★ 第二十修：平台**本人**说了「开始游戏」（vrPlatStart）也算放行 —— 见 vrPlatStart 的注释。
  return !MASTER_GATE_ON || vrMaster.exempt || vrPlatStart || (vrMaster.known && vrMaster.ok);
}
vrGateLog('主控门禁：' + (MASTER_GATE_ON ? '已启用' : '未启用')
  + (GATE_FORCE ? '（网址 ?gate=' + GATE_FORCE + '）' : '（编译时常量 MASTER_GATE=' + MASTER_GATE + '）'));

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
  // 桌面（无 VR 设备）→ 两道门禁都不适用（见 vrMaster.exempt 的两处赋值），别在现场留一行红字
  const guardBlocked = !vrMaster.exempt && vrGuard.known && !vrGuard.ok && VR_GATE_FORCE !== '1';
  // ★ 主控门禁（文档第 3 条）：**独立**于上面两道，任一不放行都不给按钮。
  //   注意 `vrMaster.known` 为 false 时也算拦 —— 没拿到 PC 的明确允许就不放行（硬闸门口径）。
  const masterBlocked = MASTER_GATE_ON && !vrMaster.exempt && !masterGateAllowed();
  const show = vrGate.open && !inXR && !guardBlocked && !masterBlocked;
  if (enterVRBox) enterVRBox.style.display = show ? 'flex' : 'none';
  // 右侧「关卡快捷」面板点任一关也会进 VR → 与按钮同生死（不留第二个入口）
  // 正式包（RELEASE）里这一块由 body.release 的 CSS 永久隐藏（选关属自测入口），不再动态改它
  if (levelPanelEl && !RELEASE) levelPanelEl.style.display = show ? 'flex' : 'none';
  updateGateRetryBtn();
  if (show) {
    if (statusMsg && !statusMsg.classList.contains('error')) statusMsg.style.display = 'none';
  } else if (guardBlocked) {
    showStatus('⛔ 未连接直播端，无法开始游戏');
  } else if (masterBlocked) {
    // 第十八修：把「正常等待」与「要人处理」分开提示 ——
    //   · PC 已达、只是还没点「开始本局」→ 等待（**不给「重试连接主控端」按钮**，
    //     那是用户实测抱怨的误导：F:/desk/第二次日志.txt）；
    //   · 从没拿到结论且查询失败（PC 连不上）或已经开始了却仍被拒（授权/白名单没过）→ 故障。
    const hardFail = (vrMaster.err && !vrMaster.known) || (vrMaster.known && vrMaster.round);
    if (!hardFail) {
      showStatus('⏳ 等待平台点「开始游戏」…（平台第二步点了之后，这里会出现「进入 VR」）');
    } else {
      showStatus('⛔ 需要主控端启动'
        + (vrMaster.why ? '（' + vrMaster.why + '）' : '')
        + '　请确认 PC 端「WebXR 直播接收端」已运行'
        + (vrMaster.pc ? '（已探测到 ' + vrMaster.pc + '）' : ''), true);
    }
  } else {
    showStatus('⏳ 等待平台点「开始游戏」…');
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
    // ★ 第十八修：把 APK 的设备号留下来给主控门禁用 —— 网址里的 dev 是 APK 拼的副本，
    //   /api/guard 这份才是权威（APK 没拼网址参数时也能拿到）。
    if (j.dev) vrMaster.dev = String(j.dev);
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

/**
 * ★ 主控门禁查询（文档第 3 条）：问 PC 主控端「允许运行吗」。
 *
 * <p>与 `gateQueryGuard()`（问 APK）并列，两者都要过 —— 这一道专门防「绕过 APK 直接开页面」：
 * 绕过去之后 /api/guard 那条路径就失去了可信来源，只有直连 PC 才是硬证据。
 *
 * <p>失败语义（**刻意不软锁**）：
 *   · 传输失败/超时，但此前已拿到过 allow ⇒ **保持放行**（一次抖动不该把现场踢回来）；
 *   · 从未拿到过 ⇒ 保持 known=false（= 拦），并把原因写进 why，界面给「重试」按钮。
 */
async function gateQueryMaster() {
  if (!MASTER_GATE_ON) {
    vrMaster.known = true; vrMaster.ok = true; vrMaster.round = true;
    vrMaster.why = '主控门禁未启用（调试包或网址 ?gate=0）';
    applyVRGate();
    return;
  }
  if (vrMaster.exempt) { applyVRGate(); return; }   // 桌面：主控门禁不适用
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch (e) { /* 忽略 */ } }, GATE_TIMEOUT_MS);
  try {
    const r = await fetch('/api/master/allow', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      signal: ac.signal,
      // ★ 只报设备号：**不带** dev/exp/voucher 放行条 —— 放行条 TTL 只有 60 秒，轮询必然过期
      //   （第二次日志 19:41:20「放行条已过期」）。设备号可从网址带（APK 拼的）或 /api/guard 取。
      body: JSON.stringify({ device: vrMaster.dev || '' }),
    });
    const j = await r.json();
    vrMaster.known = true;
    vrMaster.ok = !!j.allow;
    vrMaster.round = !!(j.round && j.round.armed);
    vrMaster.err = false;
    vrMaster.why = j.reason || j.why || '';
    gateReactToMaster();
  } catch (e) {
    const reason = (e && e.name === 'AbortError')
      ? ('超时 ' + Math.round(GATE_TIMEOUT_MS / 1000) + ' 秒没回应')
      : ('请求失败：' + (e && e.message ? e.message : e));
    // 关键：**不改** vrMaster.ok —— 已放行的场次不因一次抖动被踢回门禁外。
    vrMaster.err = true;
    vrMaster.why = vrMaster.ok ? vrMaster.why : reason;
    vrGateLog('主控端：查询失败（' + reason + '）'
      + (vrMaster.ok ? ' → 保持上次的放行结论' : ' → 暂不放行，可点「重试」'));
  } finally {
    clearTimeout(timer);
  }
  applyVRGate();
}

/**
 * 把 PC 的结论翻译成门禁开关 + 本局收尾（第十八修）。
 *
 * 关键跳变：**已放行 → 未放行** = 主控端点了「结束本局」⇒ 关门禁；若玩家此刻正在 VR 里，
 * 按「平台要求关闭本局」走同一套优雅收尾（game.js 的 _onPlatformCloseRequest），
 * 与《打包和平台对接》的现场验收「点结束游戏（PC 与 APK 均关闭）」对齐。
 */
function gateReactToMaster() {
  const allowed = masterGateAllowed();
  const wasAllowed = vrMaster.armedPrev;
  vrMaster.armedPrev = allowed;
  if (allowed) {
    // ★ 第十八修之后，这是**唯一**的正常开局路径：主控端点「开始本局」。
    setVRGate(true, '主控端已放行本局（PC 端点「开始本局」）');
    return;
  }
  setVRGate(false, '主控端未放行本局：' + (vrMaster.why || '无原因'));
  if (wasAllowed) {
    vrGateLog('主控端已结束本局 → 收尾');
    try { game._onPlatformCloseRequest('主控端结束本局'); } catch (e) { /* 收尾失败不影响页面 */ }
  }
}

/**
 * 主控门禁轮询（第十八修）。间隔：门禁关着 2s（等「开始本局」，要快）、已放行后 5s
 * （只为感知「结束本局」，放慢省电）。桌面豁免 / 门禁未启用时不轮询。
 */
let masterPollTimer = null;
function scheduleMasterPoll() {
  if (!MASTER_GATE_ON || vrMaster.exempt) return;
  clearTimeout(masterPollTimer);
  const delay = masterGateAllowed() ? GATE_POLL_IDLE_MS : GATE_POLL_MS;
  masterPollTimer = setTimeout(() => { gateQueryMaster().finally(scheduleMasterPoll); }, delay);
}

/** 主控门禁的「重试」按钮（懒创建）。失败**绝不软锁** —— 现场点一下就能再问一次 PC。 */
let gateRetryBtn = null;
function updateGateRetryBtn() {
  if (!MASTER_GATE_ON || vrMaster.exempt) return;
  // ⚠ 只有「PC 连不上/超时」或「PC 明确拒绝（授权没过）」才给重试按钮 ——
  //   「尚未开始本局」是**正常等待**，那时冒一个「重试连接主控端」出来正是用户实测抱怨的误导
  //   （F:/desk/第二次日志.txt 的情形）。
  const need = !masterGateAllowed() && (vrMaster.err || (vrMaster.known && vrMaster.round));
  if (!need) { if (gateRetryBtn) gateRetryBtn.style.display = 'none'; return; }
  if (!gateRetryBtn) {
    if (!document.body) return;
    gateRetryBtn = document.createElement('button');
    gateRetryBtn.id = 'gate-retry';
    gateRetryBtn.textContent = '🔄 重试连接主控端';
    gateRetryBtn.style.cssText = 'position:fixed;left:50%;bottom:72px;transform:translateX(-50%);'
      + 'z-index:9998;padding:10px 18px;border:none;border-radius:8px;background:#6c5ce7;color:#fff;'
      + 'font-size:15px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4);';
    gateRetryBtn.onclick = () => { gateQueryMaster(); };
    document.body.appendChild(gateRetryBtn);
  }
  gateRetryBtn.style.display = 'block';
}

function vrGateLog(msg) {
  try { game.log('[门禁] ' + msg); } catch (e) { /* 日志失败绝不影响游戏 */ }
}

/** 起「兜底放行」计时（门禁每次变化都重置；已开 / 强制隐藏 / 待机态时不计时） */
function scheduleGateFallback() {
  if (vrGate.cd) { clearTimeout(vrGate.cd); vrGate.cd = null; }
  // ★ 第十八修：门禁**归主控端管**时不做 30 秒无条件兜底 —— 主控端没点「开始本局」就永远不放行，
  //   否则按钮半分钟后自己冒出来 = 门禁等于没做（用户实测的原症状）。
  if (MASTER_GATE_ON && !vrMaster.exempt) return;
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
  onStart: (why) => {
    // ★ 第二十修：平台**真的**说了「开始游戏」→
    //   ① 开门禁（「进入 VR」按钮出现，这才是第二步该有的样子）；
    //   ② 把这个事实回报给 PC 主控端，让 PC 的「本局进行中」状态 / 推流跟平台对齐
    //      （PC 端入口见 tools/cast-pc/main.js 的 handleRoundStart）。
    vrPlatStart = true;
    setVRGate(true, why);
    reportPlatformStartToMaster(why);
  },
  onEnd: (why) => { vrPlatStart = false; vrPlatStartReported = false; setVRGate(false, why); },
  // onSeen =「平台在场」（收到过平台下发的东西，但未必是开局）→ 只影响兜底时长的判读与留痕
  onSeen: (why) => {
    if (vrGate.platformSeen) return;
    vrGate.platformSeen = true;
    VRPlus.reportEvent('vr-seen', { why });
    vrGateLog('检测到平台在场（' + why + '）→ 只做留痕，不改门禁（门禁由平台「开始游戏」与主控端决定）');
  },
};

/**
 * 把「平台已开始本局」回报给 PC 主控端（第二十修）。
 *
 * 为什么要有它：平台的开局帧（游戏通道 CMD 5）抓包实测**可能只发给 PC 那台机器** —— 那种情况
 * PC 端自己就收到了，这条只是重复确认；但若平台把它发给了头显，头显这边立刻回报一声，PC 的
 * 「本局进行中」与推流状态就跟平台同步了（否则 PC 界面显示成「还没开始」，操作员会困惑）。
 * 经 APK 的 GameServer 代理（/api/* 原样转发）→ PC 的 POST /api/round/start。
 * **fire-and-forget**：回报失败绝不影响门禁 —— 平台的开局信号本身就是权威。
 */
function reportPlatformStartToMaster(why) {
  if (vrPlatStartReported) return;
  vrPlatStartReported = true;
  try {
    fetch('/api/round/start', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ why: String(why || '').slice(0, 80) }),
    }).catch(() => { /* PC 不在 / 非直播场景：忽略 */ });
    vrGateLog('已把「平台开始本局」回报给主控端（POST /api/round/start）');
  } catch (e) { /* 忽略 */ }
}

// 启动默认（第十八修）：门禁一律**关着**，等主控端点「开始本局」。
// ★ `?plat=1`（APK/平台拉起本页）不再开门禁 —— 页面起来后一律**关着**，等主控端点「开始本局」。
//   · ?vrbtn=1 → 常显（应急/自测）；?vrbtn=0 → 永远隐藏（调试对照）。
//   · 桌面（无 VR 设备）稍后由 vrMaster.exempt + setVRGate(true) 放行，不受这里影响。
setVRGate(VR_GATE_FORCE === '1',
  VR_GATE_FORCE === '1' ? '?vrbtn=1 旁路门禁（调试）'
    : (VR_GATE_PLAT ? '页面由 APK/平台拉起（?plat=1）→ 仍需等主控端「开始本局」'
                    : '页面启动：等主控端「开始本局」'));

// ★ 第十五修：先查一次「直播端是否放行」（同源、本地、毫秒级）。
//   第十八修后两道门禁**并列**：APK 说「本页由它托管且授权通过」+ PC 主控端说「本局已放行」。
gateQueryGuard();
// ★ 主控门禁（文档第 3 条）：与上一道**并列**，两者都要过 —— 且判据是 PC 的**实时**状态，
//   故首查之后不停轮询（见 scheduleMasterPoll）：主控端点「开始本局」即刻放行。
gateQueryMaster().finally(scheduleMasterPoll);


async function enterVR(loadoutKey = null) {
  if (vrStarting || world.xr.getSession() || enterVrDisabled()) return;
  vrStarting = true;
  pendingLoadout = (loadoutKey && LOADOUTS[loadoutKey]) ? loadoutKey : null;
  vrAvailability.invalidate();
  setEnterVrBusy(pendingLoadout);
  let session;
  try {
    if (!navigator.xr) throw new Error('浏览器不支持 WebXR（需 https 或 localhost + 支持 WebXR 的头显浏览器）');

    let referenceType = 'local-floor';
    try {
      // ⚠ 关键：requestSession 必须同步在「用户手势的激活窗口」内发起，绝不能先 await 别的再调。
      //   之前先 await isSessionSupported，导致后面的 window.open(镜像) 抢先吃掉 activation →
      //   requestSession 报 "requires user activation" → 首次点进不去 VR。
      //   这里直接同步 requestSession（设备支持已在页面加载时探测并据此禁用按钮），保住激活。
      session = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'] });
    } catch (e) {
      // PICO 兼容：带参失败则无参回退
      console.log('使用 PICO 兼容模式:', e.message);
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw e;
      referenceType = 'local';
      session = await navigator.xr.requestSession('immersive-vr');
    }

    world.renderer.xr.setReferenceSpaceType(referenceType);
    // ⚠ 故意【不调用】renderer.xr.setFramebufferScaleFactor：保持 three 默认帧缓冲缩放 1.0。
    //   实测教训（2026-09-18 PICO）：独立头显上把 FRAMEBUFFER_SCALE_STANDALONE 调到 0.6/0.7 →
    //   XR 合成层(XRWebGLLayer)按缩小尺寸分配后，PICO 运行时无法正确合成 → 画面全黑（音频照常）。
    //   只有 1.0 正常。故 VR 优化【绝对禁止】下调此值（见 constants.js RENDER 注释）。
    await world.renderer.xr.setSession(session);
    // 规避 three.js r168 在 PICO 上首帧 referenceSpace 仍为空导致
    // onAnimationFrame 调 frame.getPose(gripSpace, null) 抛非致命报错的坑：
    // 预解析并强制设置自定义参考空间（与会话 'local-floor' 一致），
    // 使每帧用 customReferenceSpace 覆盖库内可能暂为空的 referenceSpace。
    try {
      const rs = await session.requestReferenceSpace(referenceType);
      world.renderer.xr.setReferenceSpace(referenceType === 'local'
        ? rs.getOffsetReferenceSpace(new XRRigidTransform({ x: 0, y: -1.6, z: 0 })) : rs);
    } catch (_) { /* 忽略：库内部 onSessionStart 也会自行解析 */ }
    if (enterVRBox) enterVRBox.style.display = 'none';
    if (statusMsg) statusMsg.style.display = 'none';
  } catch (err) {
    if (session) await session.end().catch(() => {});
    showStatus('❌ ' + err.message, true);
    setEnterVrDisabled(false);
    resetEnterVrLabels();
  } finally {
    vrStarting = false;
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
  mirror.close();          // 关闭镜像窗口并停用截帧
  game.toMenu();            // B/退出 VR 后真正回到未开始状态（state='menu' 并清场，重进 VR 即从干净状态开局）
  pause.clear();
  pendingStartIndex = 0; // 复位，下次默认从第 1 关开始
  pendingLoadout = null; // 退出 VR 后不再沿用上一局的加成（下次点按钮重新选）
  setEnterVrDisabled(false);
  resetEnterVrLabels();
  vrAvailability.refresh();
  // 第十二修：显示与否交给门禁 —— 玩家自己退出 VR 时门禁仍开着（按钮照常出现，可以再进）；
  // 平台已结束本局时门禁是关的（保持隐藏，等平台下一次「开始」再出现）。
  applyVRGate();
});

// 探测 WebXR 支持情况，给出明确提示
if (navigator.xr && navigator.xr.isSessionSupported) {
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
    if (!ok) {
      // 桌面（无 VR 设备）：二选一按钮禁用；桌面预览走关卡面板 / HUD 的「开始游戏」
      setEnterVrDisabled(true);
      if (enterVRBox) enterVRBox.title = '桌面模式（无 VR 设备）';
      // 第十二修：桌面（没有 immersive-vr）根本没得「进入 VR」，门禁对它毫无意义
      // —— 直接放行，免得桌面自测时按钮被藏 30 秒。
      // ★ 2026-09-23：主控门禁同理 —— 桌面预览不会「开出一局平台不知道的游戏」，
      //   不该被拦，否则本地看个关卡都得先把 PC 端 EXE 打开。
      vrMaster.exempt = true;
      setVRGate(true, '桌面（无 VR 设备）→ 门禁不适用，直接放行');
    }
  }).catch(() => {});
} else {
  setEnterVrDisabled(true);
  if (enterVRBox) enterVRBox.title = '桌面模式（需 https/头显）';
  vrMaster.exempt = true;      // 连 navigator.xr 都没有 ⇒ 桌面，主控门禁不适用
}

// 支持晚连接/运行时重启；暂未检测到设备时保留用户手动重试入口。
const vrAvailability = watchXRAvailability({
  xr: navigator.xr, buttons: enterVrBtns, windowTarget: window, documentTarget: document,
  isBusy: () => vrStarting || !!world.xr.getSession(),
  // 多按钮形态下**不覆盖**按钮文案（各自写着加成），需要提示时转到状态条
  onLabel: (text) => { if (!text.startsWith('🎈')) showStatus(text, true); },
});

// 进入 VR：默认第 1 关（其余关用右侧 #level-panel 面板进入）—— 主按钮进第 1 关要播开场视频
// 顺序：先 enterVR()（requestSession 占用本次手势的 user activation），再 mirror.open()。
//   · page 模式（默认）：open() 只显示页内 canvas，不调用 window.open、不抢激活 → 首次点击即可同时进 VR+出镜像，无「二次点击」问题。
//   · popup 模式：open() 用 window.open 需激活，若被先调用的 requestSession 占用会失败并注册「下次手势重试」，点「🖥 镜像」按钮也可开。
//   镜像只在桌面 PC（isDesktopPage）生效；独立头显无论哪种模式都不开启（避免拖垮 Adreno XR2）。
// 二选一：点哪个都直接进游戏，并把对应加成带到本局（键名见 core/constants.js 的 LOADOUTS）
function onEnterVrClick(loadoutKey) {
  audio.unlock();
  pendingStartIndex = 0;
  pendingPlayIntro = true;
  prewarmIntroVideo();
  enterVR(loadoutKey);
  if (MIRROR.AUTO_OPEN && isDesktopPage()) mirror.open();
}
if (enterVrBtns[0]) enterVrBtns[0].onclick = () => onEnterVrClick('rapid');
if (enterVrBtns[1]) enterVrBtns[1].onclick = () => onEnterVrClick('power');

// 预开镜像窗（仅 popup 模式需要）：在「进入 VR」之外的首次用户点击(手势)里先把镜像窗建好，
// 这样用户点「进入VR」时该窗口已存在 → mirror.open() 只 focus、不消耗激活 → VR 与镜像同一点击都能成。
//   page 模式不需要 window.open、不抢激活，无需预开（且预开会提前显示空白页内 canvas，故跳过）。
//   （浏览器规定一次手势只能提供一个 activation：requestSession 与 window.open 二选一，故分两次手势完成；
//     若用户第一下就点「进入VR」，则镜像会在你下一次点击/按键，或点「🖥 镜像」按钮时弹出。）
if (MIRROR.AUTO_OPEN && MIRROR.MODE === 'popup') {
  const tryPreopenMirror = (e) => {
    if (enterVrBtns.includes(e.target)) return;          // 进入 VR 的点击：保留激活给 requestSession
    if (!isDesktopPage() || !MIRROR.ENABLED) return;      // 独立头显不需要镜像
    if (mirror.win && !mirror.win.closed) { window.removeEventListener('pointerdown', tryPreopenMirror); return; }
    mirror.open();
    if (mirror.win && !mirror.win.closed) window.removeEventListener('pointerdown', tryPreopenMirror);
  };
  window.addEventListener('pointerdown', tryPreopenMirror);
}

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
  pendingPlayIntro = false;   // 关卡直达面板：不播开场视频，直接进对应关
  const mode = gunMode();
  const xrOk = (navigator.xr && navigator.xr.isSessionSupported)
    ? await navigator.xr.isSessionSupported('immersive-vr').catch(() => false)
    : false;
  if (xrOk) {
    // 第十二修：门禁期间不进 VR（面板此时已被 applyVRGate 藏起来，这里再兜一道，
    // 防止有人用键盘/脚本直接触发）
    if (!vrGate.open) { showStatus('⏳ 等待平台开始游戏…'); return; }
    // ★ 主控门禁（文档第 3 条）：与上面同一道兜底 —— 面板已被 applyVRGate 藏起来，
    //   这里再拦一次，防止有人用脚本/键盘直接触发。
    if (MASTER_GATE_ON && !vrMaster.exempt && !masterGateAllowed()) {
      showStatus('⛔ 需要主控端启动', true); return;
    }
    enterVR();      // 头显：进 VR 后 sessionstart 触发 startGame(pendingStartIndex, mode, false)
  } else startGame(idx, mode, false);     // 桌面：直接开局预览（不播视频）
  // 镜像放 requestSession 之后：先 enterVR 占住 activation；仅桌面 PC 自动开（独立头显不弹）
  if (MIRROR.AUTO_OPEN && xrOk && isDesktopPage()) mirror.open();
}
(function buildLevelPanel() {
  // ★ 正式包不建选关面板（#level-panel）：选关属自测入口，且点任一关都会进 VR —— 正式版只留
  //   「进入 VR」一条入口（见 RELEASE 与 index.html 的 body.release 规则）。
  if (RELEASE) return;
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
const lastErrors = new Map();
function reportError(system, error) {
  const now = performance.now();
  if (!lastErrors.has(system) || now - lastErrors.get(system) > 5000) {
    console.error(`[${system}]`, error); lastErrors.set(system, now);
  }
  // 正式包不因报错暂停：没有「继续游戏」可点，暂停 = 假死（只留日志与诊断条）
  if (!RELEASE) pause.add('error');
}
world.renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  // ★ 待机态（平台已关闭本局 / 与平台断连）：页面留着等平台叫回，但**不跑逻辑也不渲染** ——
  //   72fps 空转只会让头显发烫、掉电，而封盖下面没有任何要更新的东西。
  //   唤醒点：cmd3/4 或 startGame()（都会清 _renderPaused，见 game.js）。
  if (game._renderPaused) return;
  const menuAction = input.pollMenu();
  // ★ 正式包：菜单键（P / Esc / 右手 A / B）不再暂停、继续、退场 —— 暂停功能整体不存在
  //   （见 focusPause）。pollMenu() 仍要调用，它负责清内部队列，只是结果被丢弃。
  if (!RELEASE && game.state !== 'menu' && menuAction && !document.querySelector('dialog[open]')) {
    if (!pause.paused) pause.add('manual');
    else if (menuAction === 'exit') exitGame();
    else resumeGame();
  }
  const begin = monitor ? performance.now() : 0;
  if (!pause.paused) {
    try { game.update(dt); } catch (e) { reportError('游戏更新', e); }
    try { world.carpet?.update(Math.min(dt, 1 / 30)); } catch (e) { reportError('飞毯', e); }
  }
  const rendered = performance.now();
  try { world.render(); } catch (e) { reportError('渲染', e); }
  // VR 桌面镜像：必须在 world.render() 之后 —— 截的是本帧刚提交的 XR 帧缓冲。
  try { mirror.capture(); } catch (e) { console.error('[主循环] mirror.capture 异常:', e); }
  // 直播推流：必须在 world.render() 之后 —— 此时 camera.matrixWorld 才是本帧最终位姿；
  // 且 XR 帧已提交，观众渲染再慢也只挤占下一帧预算，不拖慢本帧。
  try { cast.update(dt); } catch (e) { console.error('[主循环] cast 异常:', e); }
  if (monitor) {
    const sample = monitor.record(dt, rendered - begin, performance.now() - rendered, world.renderer.info,
      { level: game.levelIndex + 1, state: game.state, paused: pause.paused, xr: world.isPresenting, skyCache: Object.keys(world._panoCache).length });
    controls.updateStats(sample);
  }
});

window.__game = game; // 调试用
window.__cast = cast; // 调试用（__cast.stats() 查看推流状态）
