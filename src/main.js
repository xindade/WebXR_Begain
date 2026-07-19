import * as THREE from 'three';
import { World } from './core/world.js';
import { SKY_PANORAMA } from './core/constants.js';
import { preloadDragonAssets } from './game/dragonLevel.js';
import { HUD } from './ui/hud.js';
import { AudioManager } from './vr/audio.js';
import { InputManager } from './vr/input.js';
import { WristUI } from './vr/wrist-ui.js';
import { Game } from './game/game.js';

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
  const skyUrls = Object.values(SKY_PANORAMA); // ['Sky/sky-arctic-6k.jpg','Sky/12.exr','Sky/sky-lake-8k.jpg']
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
const enterVRLaserBtn = document.getElementById('enter-vr-laser-btn');
const enterVRLevel9Btn = document.getElementById('enter-vr-level9-btn');
const enterVRLevel15Btn = document.getElementById('enter-vr-level15-btn');
const enterVRLevel12Btn = document.getElementById('enter-vr-level12-btn');
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
  enterVRLaserBtn.disabled = true;
  if (enterVRLevel9Btn) enterVRLevel9Btn.disabled = true;
  if (enterVRLevel15Btn) enterVRLevel15Btn.disabled = true;
  enterVRBtn.textContent = '⏳ 启动中...';
  enterVRLaserBtn.textContent = '⏳ 启动中...';
  if (enterVRLevel9Btn) enterVRLevel9Btn.textContent = '⏳ 启动中...';
  if (enterVRLevel15Btn) enterVRLevel15Btn.textContent = '⏳ 启动中...';
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
    enterVRLaserBtn.style.display = 'none';
    if (enterVRLevel9Btn) enterVRLevel9Btn.style.display = 'none';
    if (enterVRLevel15Btn) enterVRLevel15Btn.style.display = 'none';
    if (statusMsg) statusMsg.style.display = 'none';
  } catch (err) {
    showStatus('❌ ' + err.message, true);
    enterVRBtn.disabled = false;
    enterVRLaserBtn.disabled = false;
    if (enterVRLevel9Btn) enterVRLevel9Btn.disabled = false;
    if (enterVRLevel15Btn) enterVRLevel15Btn.disabled = false;
    enterVRBtn.textContent = '🎈 进入 VR';
    enterVRLaserBtn.textContent = '🎯 进入 VR · 第三关（激光）';
    if (enterVRLevel9Btn) enterVRLevel9Btn.textContent = '🚀 进入 VR · 第九关（激光驱赶）';
    if (enterVRLevel15Btn) enterVRLevel15Btn.textContent = '🎯 进入 VR · 第十五关（九宫格翻转）';
  }
}

// 会话结束：恢复按钮；并「暂停日志滚动」防止报错信息丢失
world.xr.addEventListener('sessionend', () => {
  pageLog?.pauseScroll();
  pendingStartIndex = 0; // 复位，下次默认从第 1 关开始
  enterVRBtn.disabled = false;
  enterVRBtn.style.display = 'block';
  enterVRBtn.textContent = '🎈 进入 VR';
  enterVRLaserBtn.style.display = 'block';
  enterVRLaserBtn.textContent = '🎯 进入 VR · 第三关（激光）';
  if (enterVRLevel9Btn) {
    enterVRLevel9Btn.style.display = 'block';
    enterVRLevel9Btn.textContent = '🚀 进入 VR · 第九关（激光驱赶）';
    enterVRLevel9Btn.disabled = false;
  }
  if (enterVRLevel15Btn) {
    enterVRLevel15Btn.style.display = 'block';
    enterVRLevel15Btn.textContent = '🎯 进入 VR · 第十五关（九宫格翻转）';
    enterVRLevel15Btn.disabled = false;
  }
  if (enterVRLevel12Btn) {
    enterVRLevel12Btn.style.display = 'block';
    enterVRLevel12Btn.textContent = '🐉 进入 VR · 第十二关（龙 Boss）';
    enterVRLevel12Btn.disabled = false;
  }
});

// 探测 WebXR 支持情况，给出明确提示
if (navigator.xr && navigator.xr.isSessionSupported) {
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
    if (!ok) {
      enterVRBtn.textContent = '桌面模式（无 VR 设备）';
      enterVRBtn.disabled = true;
      enterVRLaserBtn.style.display = 'none'; // 桌面用 HUD 内的「第三关测试」按钮
      if (enterVRLevel9Btn) enterVRLevel9Btn.style.display = 'none';
      if (enterVRLevel15Btn) enterVRLevel15Btn.style.display = 'none';
      if (enterVRLevel12Btn) enterVRLevel12Btn.style.display = 'none';
    }
  }).catch(() => {});
} else {
  enterVRBtn.textContent = '桌面模式（需 https/头显）';
  enterVRBtn.disabled = true;
  enterVRLaserBtn.style.display = 'none';
  if (enterVRLevel9Btn) enterVRLevel9Btn.style.display = 'none';
  if (enterVRLevel15Btn) enterVRLevel15Btn.style.display = 'none';
  if (enterVRLevel12Btn) enterVRLevel12Btn.style.display = 'none';
}

// 进入 VR：默认第 1 关
enterVRBtn.onclick = () => { audio.unlock(); pendingStartIndex = 0; enterVR(); };
// 进入 VR：直接第三关（激光气球躲避关）测试
enterVRLaserBtn.onclick = () => { audio.unlock(); pendingStartIndex = 2; enterVR(); };
// 进入 VR：直接第九关（激光驱赶 + 玻璃走格子）测试
enterVRLevel9Btn.onclick = () => { audio.unlock(); pendingStartIndex = 8; enterVR(); };
// 进入 VR：直接第十五关（激光驱赶 + 九宫格翻转）测试
if (enterVRLevel15Btn) enterVRLevel15Btn.onclick = () => { audio.unlock(); pendingStartIndex = 14; enterVR(); };
// 进入 VR：直接第十二关（龙 Boss）测试
if (enterVRLevel12Btn) enterVRLevel12Btn.onclick = () => { audio.unlock(); pendingStartIndex = 11; enterVR(); };

const clock = new THREE.Clock();
world.renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  game.update(dt);
  world.render();
});

window.__game = game; // 调试用
