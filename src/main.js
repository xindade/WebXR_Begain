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

window.__pageLog?.info('[main] 模块开始执行（imports 已解析）');

const canvas = document.getElementById('app');
const world = new World(canvas);

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

  // 真实总进度：天空与龙资源各占一半权重
  const realFrac = () => {
    const sky = skyUrls.reduce((s, u) => s + skyFrac[u], 0) / skyUrls.length;
    return (sky + dragonFrac) / 2;
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
  Promise.all([...skyTasks, dragonTask]).catch(() => {}); // 触发加载（帧循环独立读取进度）
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

// VR 进入即开局（pendingStartIndex 决定从第几关开始，默认第 1 关）
let pendingStartIndex = 0;
world.xr.addEventListener('sessionstart', () => { pageLog?.resumeScroll(); if (game.state === 'menu') game.start(pendingStartIndex); });
// 桌面：开始按钮（idx 0=第1关，2=第3关激光测试）
hud.onStart((idx = 0) => game.start(idx));

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

// 会话结束：恢复按钮；并「暂停日志滚动」防止报错信息丢失
world.xr.addEventListener('sessionend', () => {
  pageLog?.pauseScroll();
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
  const xrOk = (navigator.xr && navigator.xr.isSessionSupported)
    ? await navigator.xr.isSessionSupported('immersive-vr').catch(() => false)
    : false;
  if (xrOk) enterVR();      // 头显：进 VR 后 sessionstart 触发 game.start(pendingStartIndex)
  else game.start(idx);     // 桌面：直接开局预览
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
  try { world.render(); } catch (e) { console.error('[主循环] world.render 异常:', e); }
});

window.__game = game; // 调试用
