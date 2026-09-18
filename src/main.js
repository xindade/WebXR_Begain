import * as THREE from 'three';
import { World } from './core/world.js';
import { preloadDragonAssets } from './game/dragonLevel.js';
import { HUD } from './ui/hud.js';
import { AudioManager } from './vr/audio.js';
import { InputManager } from './vr/input.js';
import { WristUI } from './vr/wrist-ui.js';
import { Game } from './game/game.js';
import { prewarmIntroVideo } from './game/introVideo.js';
import { LEVELS } from './content/levels.js';
import { preloadGLB } from './game/glbCache.js';
import { MODEL_URL as PORTAL_MODEL_URL } from './game/portal.js';
import { MODEL_URL as OPENING_MODEL_URL } from './game/openingModel.js';
import { MirrorManager, isDesktopPage } from './core/mirror.js';
import { MIRROR, RENDER } from './core/constants.js';

window.__pageLog?.info('[main] 模块开始执行（imports 已解析）');

const canvas = document.getElementById('app');
const world = new World(canvas);
const mirror = new MirrorManager(world.renderer, world.scene);  // VR 桌面镜像（独立弹出窗口显示头显第一人称）

// 预览阶段预加载重资产（龙关动画 JSON/龙头 GLB + 传送门/激光剑 GLB + 抽卡图）。
// 进度条走完才放行 Enter VR 按钮。天空(18 张 4K 全景)改为「进对应关时按需懒加载」，
// 避免启动时一次性解码 18 张 ~600MB 占用内存；setSkyPanorama 自带异步兜底，进关即显示。
// 进度条按体感分段：80% 停 6s、95% 停 3s、最后 1s 跑到 100%。
(function preloadAll() {
  const overlay = document.getElementById('loading-overlay');
  const fill = document.getElementById('loading-bar-fill');
  const text = document.getElementById('loading-text');

  let dragonFrac = 0; // JSON 占 0.1，GLB 下载占 0.9
  const dragonTask = preloadDragonAssets((loaded, total) => {
    dragonFrac = 0.1 + 0.9 * (total ? Math.min(1, loaded / total) : 0);
  }).then(() => { dragonFrac = 1; })
    .catch(() => { dragonFrac = 1; });

  // 传送门 + 开场魔术师动画 GLB：下载+DRACO 解码+parse 一次性完成，进关零等待（glbCache 命中，零重复加载）。
  // 注：马戏团(CIRCUS)模型已按需求移除、其 GLB 不再预载；开场魔术师动画已恢复——机制关(3/9/15)进关即播放、10秒后自动消失。
  // 激光剑已改为程序化 shader 光剑（不再预载 GLB，Model/激光剑.glb 仅留作资产备份）。
  const glbParts = [0, 0];
  const glbTasks = [PORTAL_MODEL_URL, OPENING_MODEL_URL].map((u, i) =>
    preloadGLB(u, (loaded, total) => {
      glbParts[i] = total ? Math.min(1, loaded / total) : 0;
    }).then(() => { glbParts[i] = 1; })
  );
  const glbTask = Promise.all(glbTasks);

  // 真实总进度：龙资产 / 传送门+开场动画 GLB 各占一半（天空已改为逐关懒加载，不进启动进度）
  // 抽卡卡面现由 canvas 程序化绘制（简笔画图标），无需预加载 PNG。
  const realFrac = () => {
    const glb = glbParts.reduce((s, v) => s + v, 0) / glbParts.length;
    return (dragonFrac + glb) / 2;
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

    // 完成条件：资产全部就绪 且 已越过分段节奏
    if ((real >= 1 && elapsed >= HOLD_80 + HOLD_95) || elapsed >= HARD_TIMEOUT) {
      if (overlay) overlay.style.display = 'none'; // 揭开遮罩，显示 Enter VR 按钮
      return;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  Promise.all([dragonTask, glbTask]).catch(() => {}); // 触发加载（帧循环独立读取进度）
})();

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
  // ⚠ 帧缓冲缩放已在 enterVR() 内「setSession 之前」设置（见 enterVR）：此处若再设置，
  // 因 sessionstart 时 isPresenting 已为 true，three 会拒绝并报警告
  // "Cannot change framebuffer scale while presenting"。故此处只触发开局。
  if (game.state === 'menu') game.start(pendingStartIndex, gunMode(), pendingPlayIntro);
});
// 桌面：开始按钮（idx 0=第1关，2=第3关激光测试）—— 桌面预览不播开场视频
hud.onStart((idx = 0) => game.start(idx, gunMode(), false));

// ── 自定义 PICO 兼容 VR 进入按钮（参考 vr-controller-kit skill）──
// 不使用 three 自带 VRButton：改用 requiredFeatures:['local-floor'] + 无参回退，
// PICO 的 Chrome/105 不支持某些特性参数时才能顺利进入。
const enterVRBtn = document.getElementById('enter-vr-btn');
const statusMsg = document.getElementById('status-msg');
const mirrorBtn = document.getElementById('mirror-btn');
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

async function enterVR() {
  if (enterVRBtn.disabled) return;
  enterVRBtn.disabled = true;
  enterVRBtn.textContent = '⏳ 启动中...';
  try {
    if (!navigator.xr) throw new Error('浏览器不支持 WebXR（需 https 或 localhost + 支持 WebXR 的头显浏览器）');

    let session;
    try {
      // ⚠ 关键：requestSession 必须同步在「用户手势的激活窗口」内发起，绝不能先 await 别的再调。
      //   之前先 await isSessionSupported，导致后面的 window.open(镜像) 抢先吃掉 activation →
      //   requestSession 报 "requires user activation" → 首次点进不去 VR。
      //   这里直接同步 requestSession（设备支持已在页面加载时探测并据此禁用按钮），保住激活。
      session = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'] });
    } catch (e) {
      // PICO 兼容：带参失败则无参回退
      console.log('使用 PICO 兼容模式:', e.message);
      session = await navigator.xr.requestSession('immersive-vr');
    }

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
      const rs = await session.requestReferenceSpace('local-floor');
      world.renderer.xr.setReferenceSpace(rs);
    } catch (_) { /* 忽略：库内部 onSessionStart 也会自行解析 */ }
    enterVRBtn.style.display = 'none';
    if (statusMsg) statusMsg.style.display = 'none';
  } catch (err) {
    showStatus('❌ ' + err.message, true);
    enterVRBtn.disabled = false;
    enterVRBtn.textContent = '🎈 进入 VR';
  }
}

// 会话结束：恢复按钮；并「暂停日志滚动」防止报错信息丢失
world.xr.addEventListener('sessionend', () => {
  pageLog?.pauseScroll();
  mirror.close();          // 关闭镜像窗口并停用截帧
  game.toMenu();            // B/退出 VR 后真正回到未开始状态（state='menu' 并清场，重进 VR 即从干净状态开局）
  pendingStartIndex = 0; // 复位，下次默认从第 1 关开始
  enterVRBtn.disabled = false;
  enterVRBtn.style.display = 'block';
  enterVRBtn.textContent = '🎈 进入 VR';
});

// 探测 WebXR 支持情况，给出明确提示
if (navigator.xr && navigator.xr.isSessionSupported) {
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
    if (!ok) {
      enterVRBtn.textContent = '桌面模式（无 VR 设备）';
      enterVRBtn.disabled = true;
    }
  }).catch(() => {});
} else {
  enterVRBtn.textContent = '桌面模式（需 https/头显）';
  enterVRBtn.disabled = true;
}

// 进入 VR：默认第 1 关（其余关用右侧 #level-panel 面板进入）—— 主按钮进第 1 关要播开场视频
// 顺序：先 enterVR()（requestSession 占用本次手势的 user activation），再 mirror.open()。
//   · page 模式（默认）：open() 只显示页内 canvas，不调用 window.open、不抢激活 → 首次点击即可同时进 VR+出镜像，无「二次点击」问题。
//   · popup 模式：open() 用 window.open 需激活，若被先调用的 requestSession 占用会失败并注册「下次手势重试」，点「🖥 镜像」按钮也可开。
//   镜像只在桌面 PC（isDesktopPage）生效；独立头显无论哪种模式都不开启（避免拖垮 Adreno XR2）。
enterVRBtn.onclick = () => { audio.unlock(); pendingStartIndex = 0; pendingPlayIntro = true; prewarmIntroVideo(); enterVR(); if (MIRROR.AUTO_OPEN && isDesktopPage()) mirror.open(); };

// 预开镜像窗（仅 popup 模式需要）：在「进入 VR」之外的首次用户点击(手势)里先把镜像窗建好，
// 这样用户点「进入VR」时该窗口已存在 → mirror.open() 只 focus、不消耗激活 → VR 与镜像同一点击都能成。
//   page 模式不需要 window.open、不抢激活，无需预开（且预开会提前显示空白页内 canvas，故跳过）。
//   （浏览器规定一次手势只能提供一个 activation：requestSession 与 window.open 二选一，故分两次手势完成；
//     若用户第一下就点「进入VR」，则镜像会在你下一次点击/按键，或点「🖥 镜像」按钮时弹出。）
if (MIRROR.AUTO_OPEN && MIRROR.MODE === 'popup') {
  const tryPreopenMirror = (e) => {
    if (e.target === enterVRBtn) return;                 // 进入 VR 的点击：保留激活给 requestSession
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
  if (xrOk) enterVR();     // 头显：进 VR 后 sessionstart 触发 game.start(pendingStartIndex, mode, false)
  else game.start(idx, mode, false);     // 桌面：直接开局预览（不播视频）
  // 镜像放 requestSession 之后：先 enterVR 占住 activation；仅桌面 PC 自动开（独立头显不弹）
  if (MIRROR.AUTO_OPEN && xrOk && isDesktopPage()) mirror.open();
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
  // 单帧异常只记录、不向上抛：否则会中断 XR 动画循环的排帧，导致 VR 黑屏
  try { game.update(dt); } catch (e) { console.error('[主循环] game.update 异常:', e); }
  // 飞毯每帧更新：dt 钳制到 1/30，避免掉帧时 Verlet 积分爆炸（见飞毯文档坑#7）；运动与玩家移动无关（恒定基线 + 缓慢自震荡）
  try { world.carpet?.update(Math.min(dt, 1 / 30)); } catch (e) { console.error('[主循环] carpet.update 异常:', e); }
  try { world.render(); } catch (e) { console.error('[主循环] world.render 异常:', e); }
  try { mirror.capture(); } catch (e) { console.error('[主循环] mirror.capture 异常:', e); }  // VR 桌面镜像：XR 渲染后截帧发到镜像窗
});

window.__game = game; // 调试用
