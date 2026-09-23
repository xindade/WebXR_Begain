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
import { loadGLB } from './game/glbCache.js';
import { SKY_PANORAMA } from './core/constants.js';
import { MODEL_URL as PORTAL_MODEL_URL } from './game/portal.js';
import { MODEL_URL as OPENING_MODEL_URL } from './game/openingModel.js';

window.__pageLog?.info('[main] 模块开始执行（imports 已解析）');

const canvas = document.getElementById('app');
const world = new World(canvas);
const settings = loadSettings();
world.skyMaxDimension = settings.skySize;

const hud = new HUD();
const audio = new AudioManager();

// Game 先创建（内部建立 playerRig 并把相机挂上去）
const game = new Game(world, hud);
// 输入层拿到真实 rig
const input = new InputManager(world, game.rig);
const wristUI = new WristUI(); // 手腕面板：右手战斗信息 / 左手日志
// 页面日志（最高优先，由 index.html 的经典脚本注入；three 失败时仍可用）
const pageLog = window.__pageLog || null;
game.setSystems(audio, input, wristUI, pageLog);

const monitor = new PerformanceMonitor();
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
  if (game.state === 'menu') return;
  if (hidden) { pause.add('manual'); pause.add(reason); }
  else pause.remove(reason); // 恢复焦点仍需玩家明确继续
}
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
function startGame(index, mode, intro) {
  pause.clear(); input.reset(); game.start(index, mode, intro);
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
world.xr.addEventListener('sessionstart', () => { pageLog?.resumeScroll(); if (game.state === 'menu') startGame(pendingStartIndex, gunMode(), pendingPlayIntro); });
// 桌面：开始按钮（idx 0=第1关，2=第3关激光测试）—— 桌面预览不播开场视频
hud.onStart((idx = 0) => { audio.unlock(); startGame(idx, gunMode(), false); });

// ── 自定义 PICO 兼容 VR 进入按钮（参考 vr-controller-kit skill）──
// 不使用 three 自带 VRButton：改用 requiredFeatures:['local-floor'] + 无参回退，
// PICO 的 Chrome/105 不支持某些特性参数时才能顺利进入。
const enterVRBtn = document.getElementById('enter-vr-btn');
const statusMsg = document.getElementById('status-msg');
let vrStarting = false;

function showStatus(text, isError = false) {
  if (!statusMsg) return;
  statusMsg.textContent = text;
  statusMsg.style.display = 'block';
  statusMsg.classList.toggle('error', isError);
}

async function enterVR() {
  if (vrStarting || world.xr.getSession() || enterVRBtn.disabled) return;
  vrStarting = true;
  vrAvailability.invalidate();
  enterVRBtn.disabled = true;
  enterVRBtn.textContent = '⏳ 启动中...';
  let session;
  try {
    if (!navigator.xr) throw new Error('浏览器不支持 WebXR（需 https 或 localhost + 支持 WebXR 的头显浏览器）');

    let referenceType = 'local-floor';
    try {
      session = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'] });
    } catch (e) {
      // PICO 兼容：带参失败则无参回退
      console.log('使用 PICO 兼容模式:', e.message);
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw e;
      referenceType = 'local';
      session = await navigator.xr.requestSession('immersive-vr');
    }

    world.renderer.xr.setReferenceSpaceType(referenceType);
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
    enterVRBtn.style.display = 'none';
    if (statusMsg) statusMsg.style.display = 'none';
  } catch (err) {
    if (session) await session.end().catch(() => {});
    showStatus('❌ ' + err.message, true);
    enterVRBtn.disabled = false;
    enterVRBtn.textContent = '🎈 进入 VR';
  } finally {
    vrStarting = false;
  }
}

// 会话结束：恢复按钮；并「暂停日志滚动」防止报错信息丢失
world.xr.addEventListener('sessionend', () => {
  pageLog?.pauseScroll();
  game.toMenu();            // B/退出 VR 后真正回到未开始状态（state='menu' 并清场，重进 VR 即从干净状态开局）
  pause.clear();
  pendingStartIndex = 0; // 复位，下次默认从第 1 关开始
  enterVRBtn.disabled = false;
  enterVRBtn.style.display = 'block';
  enterVRBtn.textContent = '🎈 进入 VR';
  vrAvailability.refresh();
});

// 支持晚连接/运行时重启；暂未检测到设备时保留用户手动重试入口。
const vrAvailability = watchXRAvailability({
  xr: navigator.xr, button: enterVRBtn, windowTarget: window, documentTarget: document,
  isBusy: () => vrStarting || !!world.xr.getSession(),
});

// 进入 VR：默认第 1 关（其余关用右侧 #level-panel 面板进入）—— 主按钮进第 1 关要播开场视频
enterVRBtn.onclick = () => { audio.unlock(); pendingStartIndex = 0; pendingPlayIntro = true; prewarmIntroVideo(); enterVR(); };

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
  if (xrOk) enterVR();     // 头显：进 VR 后 sessionstart 触发 game.start(pendingStartIndex, mode, false)
  else startGame(idx, mode, false);     // 桌面：直接开局预览（不播视频）
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

// 资源后台预热，不阻挡开始游戏；缺失资源沿用各模块的占位与重试处理。
const startupAssets = [
  { name: '首关天空', load: () => world.prepareSkyPano(SKY_PANORAMA[1]) },
  { name: '传送门', load: () => loadGLB(PORTAL_MODEL_URL) },
  { name: '开场模型', load: () => loadGLB(OPENING_MODEL_URL) },
];
for (const { name, load } of startupAssets) {
  Promise.resolve().then(load).catch(error => console.warn(`[后台加载] ${name}：`, error));
}

const clock = new THREE.Clock();
const lastErrors = new Map();
function reportError(system, error) {
  const now = performance.now();
  if (!lastErrors.has(system) || now - lastErrors.get(system) > 5000) {
    console.error(`[${system}]`, error); lastErrors.set(system, now);
  }
  pause.add('error');
}
world.renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  const menuAction = input.pollMenu();
  if (game.state !== 'menu' && menuAction && !document.querySelector('dialog[open]')) {
    if (!pause.paused) pause.add('manual');
    else if (menuAction === 'exit') exitGame();
    else resumeGame();
  }
  const begin = performance.now();
  if (!pause.paused) {
    try { game.update(dt); } catch (e) { reportError('游戏更新', e); }
    try { world.carpet?.update(Math.min(dt, 1 / 30)); } catch (e) { reportError('飞毯', e); }
  }
  const rendered = performance.now();
  try { world.render(); } catch (e) { reportError('渲染', e); }
  const sample = monitor.record(dt, rendered - begin, performance.now() - rendered, world.renderer.info,
    { level: game.levelIndex + 1, state: game.state, paused: pause.paused, xr: world.isPresenting, skyCache: Object.keys(world._panoCache).length });
  controls.updateStats(sample);
});

window.__game = game; // 调试用
