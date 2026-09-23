import * as THREE from 'three';
import { saveSettings } from '../core/settings.js';

export class GameControls {
  constructor({ world, game, pause, settings, onSettings, onResume, onExit, monitor }) {
    this.world = world; this.game = game; this.pause = pause;
    const bar = document.createElement('div');
    bar.id = 'game-controls';
    const button = (label, action, parent = bar) => {
      const b = document.createElement('button'); b.textContent = label; b.onclick = action; parent.appendChild(b); return b;
    };
    button('暂停', () => { if (game.state !== 'menu') pause.add('manual'); });
    button('设置', () => {
      if (game.state !== 'menu') pause.add('manual');
      for (const [key, input] of Object.entries(inputs)) input.value = settings[key];
      document.exitPointerLock?.(); dialog.showModal();
    });
    button('日志', () => document.querySelector('.pagelog')?.classList.toggle('collapsed'));
    button('导出性能记录', () => {
      const data = { ...monitor.exportData(), settings, browser: navigator.userAgent };
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'webxr-performance.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    this.stats = document.createElement('output'); this.stats.id = 'performance-status'; bar.appendChild(this.stats);
    document.body.appendChild(bar);

    this.panel = document.createElement('div'); this.panel.id = 'pause-panel'; this.panel.hidden = true;
    const title = document.createElement('p'); title.textContent = '游戏已暂停'; this.panel.appendChild(title);
    button('继续游戏', onResume, this.panel); button('返回菜单 / 退出 VR', onExit, this.panel);
    document.body.appendChild(this.panel);

    const dialog = document.createElement('dialog'); dialog.id = 'settings-dialog';
    const heading = document.createElement('h2'); heading.textContent = '游戏设置'; dialog.appendChild(heading);
    const fields = [
      ['moveSpeed', '移动速度（米/秒）', 0, 5, 0.5], ['heightOffset', '坐姿高度补偿（米）', -0.5, 1, 0.1],
      ['volume', '总音量', 0, 1, 0.1],
      ['turnMode', '左摇杆转向', [['none', '关闭'], ['snap', '30°分段转向'], ['smooth', '平滑转向']]],
      ['dominantHand', '射击惯用手', [['right', '右手'], ['left', '左手']]],
      ['skySize', '天空质量（刷新后生效）', [[4096, '4K'], [2048, '2K（省内存）']]],
    ];
    const inputs = {};
    for (const [key, label, min, max, step] of fields) {
      const row = document.createElement('label'); row.textContent = label;
      const input = document.createElement(Array.isArray(min) ? 'select' : 'input'); input.name = key;
      if (Array.isArray(min)) for (const [value, text] of min) { const o = document.createElement('option'); o.value = value; o.textContent = text; input.appendChild(o); }
      else { input.type = 'number'; input.min = min; input.max = max; input.step = step; }
      input.value = settings[key]; inputs[key] = input; row.appendChild(input); dialog.appendChild(row);
    }
    button('保存设置', () => {
      const next = {};
      for (const [key, input] of Object.entries(inputs)) next[key] = ['turnMode', 'dominantHand'].includes(key) ? input.value : Number(input.value);
      Object.assign(settings, saveSettings(next)); onSettings(settings); dialog.close();
    }, dialog);
    button('关闭', () => dialog.close(), dialog);
    document.body.appendChild(dialog);

    // 沉浸式会话看不到 DOM：暂停说明以 3D 面板显示，右手 A 继续、B 退出。
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 384;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#171923'; ctx.fillRect(0, 0, 1024, 384);
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.font = 'bold 60px sans-serif'; ctx.fillText('游戏已暂停', 512, 120);
    ctx.font = '40px sans-serif'; ctx.fillText('右手 A：继续游戏', 512, 220); ctx.fillText('右手 B：退出 VR', 512, 295);
    this.xrPanel = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.525), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, depthWrite: false }));
    this.xrPanel.renderOrder = 9999; this.xrPanel.visible = false;
    world.scene.add(this.xrPanel);
  }
  showPaused(paused) {
    const active = paused && this.game.state !== 'menu';
    this.panel.hidden = !active || this.world.isPresenting;
    this.xrPanel.visible = active && this.world.isPresenting;
    if (this.xrPanel.visible) {
      this.world.camera.getWorldPosition(this.xrPanel.position);
      this.world.camera.getWorldQuaternion(this.xrPanel.quaternion);
      this.xrPanel.translateZ(-1.7);
    }
  }
  updateStats(sample) {
    if (!sample) return;
    this.stats.textContent = `${sample.fps.toFixed(0)} FPS · P95 ${sample.frameP95Ms.toFixed(1)}ms · ${sample.calls} calls · ${sample.textures} textures`;
  }
}
