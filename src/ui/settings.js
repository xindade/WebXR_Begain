import * as THREE from 'three';
import { saveSettings } from '../core/settings.js';

/**
 * 开发者/自测控制条：暂停 / 设置 / 日志 / 导出性能记录 + 桌面暂停面板 + 设置对话框 +
 * 沉浸式（VR 内）「已暂停」3D 面板。
 *
 * 【正式包一项都不建】2026-09-23 需求原话：「游戏还包含暂停，继续，设置，导出等功能，正式版游戏
 *   要去掉这些」。正式版的流程由平台 + PC 主控端驱动（门禁见 src/main.js、收尾见 src/game/game.js），
 *   现场玩家/操作员不该看到任何调试入口。
 *
 * 【开关】`devUI = false`（= constants.RELEASE_UI 为真且网址没带 ?devui=1，由 main.js 判定）时
 *   本类退化成**空壳**：不建 DOM、不建 3D 面板，showPaused / updateStats 成空实现。
 *   构造签名保持不变 ⇒ main.js 不需要为界面写分支。
 *
 * 【暂停机制本身保留】pause 仍会因「页面失焦 / XR 会话不可见 / 报告错误」而暂停（那是性能与安全
 *   需要，见 main.js），正式包里只是**没有可见的暂停界面** —— 恢复途径是头显右手 A 键
 *   （main.js 的 input.pollMenu → resumeGame）。也正因如此，main.js 在正式包里**不再**用
 *   「指针锁丢失」来暂停：那条只在桌面自测时触发，而桌面没有 A 键可恢复 = 假死。
 */
export class GameControls {
  constructor({ world, game, pause, settings, onSettings, onResume, onExit, monitor, devUI = false }) {
    this.world = world; this.game = game; this.pause = pause;
    if (!devUI) return;                       // 正式包：整套调试界面都不建（见类注释）
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

  /** 显示/隐藏「已暂停」界面。**正式包（devUI=false）下是空实现** —— 根本没有界面可显示。 */
  showPaused(paused) {
    if (!this.xrPanel) return;
    const active = paused && this.game.state !== 'menu';
    this.panel.hidden = !active || this.world.isPresenting;
    this.xrPanel.visible = active && this.world.isPresenting;
    if (this.xrPanel.visible) {
      this.world.camera.getWorldPosition(this.xrPanel.position);
      this.world.camera.getWorldQuaternion(this.xrPanel.quaternion);
      this.xrPanel.translateZ(-1.7);
    }
  }
  /** 刷新性能读数。**正式包（devUI=false）下是空实现** —— 没有读数区可刷。 */
  updateStats(sample) {
    if (!sample || !this.stats) return;
    this.stats.textContent = `${sample.fps.toFixed(0)} FPS · P95 ${sample.frameP95Ms.toFixed(1)}ms · ${sample.calls} calls · ${sample.textures} textures`;
  }
}