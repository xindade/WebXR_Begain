import * as THREE from 'three';
import { World } from './core/world.js';
import { HUD } from './ui/hud.js';
import { AudioManager } from './vr/audio.js';
import { InputManager } from './vr/input.js';
import { WristUI } from './vr/wrist-ui.js';
import { Game } from './game/game.js';

window.__pageLog?.info('[main] 模块开始执行（imports 已解析）');

const canvas = document.getElementById('app');
const world = new World(canvas);
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
  enterVRBtn.textContent = '⏳ 启动中...';
  enterVRLaserBtn.textContent = '⏳ 启动中...';
  if (enterVRLevel9Btn) enterVRLevel9Btn.textContent = '⏳ 启动中...';
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
    if (statusMsg) statusMsg.style.display = 'none';
  } catch (err) {
    showStatus('❌ ' + err.message, true);
    enterVRBtn.disabled = false;
    enterVRLaserBtn.disabled = false;
    if (enterVRLevel9Btn) enterVRLevel9Btn.disabled = false;
    enterVRBtn.textContent = '🎈 进入 VR';
    enterVRLaserBtn.textContent = '🎯 进入 VR · 第三关（激光）';
    if (enterVRLevel9Btn) enterVRLevel9Btn.textContent = '🚀 进入 VR · 第九关（激光驱赶）';
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
});

// 探测 WebXR 支持情况，给出明确提示
if (navigator.xr && navigator.xr.isSessionSupported) {
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
    if (!ok) {
      enterVRBtn.textContent = '桌面模式（无 VR 设备）';
      enterVRBtn.disabled = true;
      enterVRLaserBtn.style.display = 'none'; // 桌面用 HUD 内的「第三关测试」按钮
      if (enterVRLevel9Btn) enterVRLevel9Btn.style.display = 'none';
    }
  }).catch(() => {});
} else {
  enterVRBtn.textContent = '桌面模式（需 https/头显）';
  enterVRBtn.disabled = true;
  enterVRLaserBtn.style.display = 'none';
  if (enterVRLevel9Btn) enterVRLevel9Btn.style.display = 'none';
}

// 进入 VR：默认第 1 关
enterVRBtn.onclick = () => { audio.unlock(); pendingStartIndex = 0; enterVR(); };
// 进入 VR：直接第三关（激光气球躲避关）测试
enterVRLaserBtn.onclick = () => { audio.unlock(); pendingStartIndex = 2; enterVR(); };
// 进入 VR：直接第九关（激光驱赶 + 玻璃走格子）测试
enterVRLevel9Btn.onclick = () => { audio.unlock(); pendingStartIndex = 8; enterVR(); };

const clock = new THREE.Clock();
world.renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  game.update(dt);
  world.render();
});

window.__game = game; // 调试用
