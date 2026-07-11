import * as THREE from 'three';
import { World } from './core/world.js';
import { HUD } from './ui/hud.js';
import { AudioManager } from './vr/audio.js';
import { InputManager } from './vr/input.js';
import { WristUI } from './vr/wrist-ui.js';
import { Game } from './game/game.js';

const canvas = document.getElementById('app');
const world = new World(canvas);
const hud = new HUD();
const audio = new AudioManager();

// Game 先创建（内部建立 playerRig 并把相机挂上去）
const game = new Game(world, hud);
// 输入层拿到真实 rig
const input = new InputManager(world, game.rig);
const wristUI = new WristUI(); // 手腕面板：右手战斗信息 / 左手日志
game.setSystems(audio, input, wristUI);

// VR 进入即开局
world.xr.addEventListener('sessionstart', () => { if (game.state === 'menu') game.start(); });
// 桌面：开始按钮
hud.onStart(() => game.start());

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

// 会话结束：恢复按钮
world.xr.addEventListener('sessionend', () => {
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

enterVRBtn.onclick = () => { audio.unlock(); enterVR(); };

const clock = new THREE.Clock();
world.renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  game.update(dt);
  world.render();
});

window.__game = game; // 调试用
