// DifficultyController —— DDA 动态难度控制器
// 根据玩家综合战力 / 船血 / 场上威胁 / 击杀率，实时调整出怪数量、种类与节奏。
// 被 WaveManager._updateNormalTest() 每帧调用（DDA.enabled && this.dda 时）。
//
// 调用契约：
//   constructor(metricsFn)  metricsFn() → { hpPct, power, onScreen, onScreenThreat }
//   update(dt)              每帧调用，更新内部难度标量，返回 { difficulty }
//   getPlan()               返回当前出怪计划 { concurrency, cooldown, dist, spread, phase, pickType() }
//   notifyKill()            每次击杀调用，记入滑窗击杀率
//   reset()                 每关重置，清空击杀窗口与难度标量

import { DDA } from '../core/constants.js';
import { ENEMY_TYPES } from '../content/enemies.js';

export class DifficultyController {
  constructor(metricsFn) {
    this.metricsFn = metricsFn;
    this.reset();
  }

  reset() {
    this.difficulty = DDA.difficultyStart ?? 0.3;
    this._t = 0;
    this.killWindow = [];   // 滑窗内击杀时间戳
    this.killRate = 0;       // 滑窗击杀率（kills/s）
  }

  update(dt) {
    this._t += dt;

    // —— 修剪击杀滑窗 ——
    const WIN = DDA.killWindow ?? 10;
    while (this.killWindow.length > 0 && this.killWindow[0] < this._t - WIN) {
      this.killWindow.shift();
    }
    this.killRate = this.killWindow.length / WIN;

    // —— 读取玩家/场上状态 ——
    const m = this.metricsFn();
    const hpPct = m.hpPct ?? 1;
    const power = m.power ?? 100;
    const onScreen = m.onScreen ?? 0;
    const threat = m.onScreenThreat ?? 0;

    // —— 目标难度计算 ——
    // 玩家越强、血越多、击杀越快 → 难度越高
    // 场上威胁高时略微收敛，避免雪崩
    const powerNorm = Math.min(1, power / 500);          // 归一化战力
    const killNorm  = Math.min(1, this.killRate / 3);     // 归一化击杀率（3 kills/s = 满分）
    const threatPenalty = Math.min(0.3, threat / 20);      // 威胁惩罚：场上太强时降低目标难度

    let target = powerNorm * 0.35 + killNorm * 0.30 + hpPct * 0.25 - threatPenalty;
    target = Math.max(0.1, Math.min(1, target));

    // —— 平滑跟随目标 ——
    const rate = (DDA.smoothRate ?? 0.5) * dt;
    this.difficulty += (target - this.difficulty) * Math.min(1, rate);
    this.difficulty = Math.max(0.1, Math.min(1, this.difficulty));

    return { difficulty: this.difficulty };
  }

  getPlan() {
    const d = this.difficulty;
    const minC = DDA.minConcurrency ?? 8;
    const maxC = DDA.maxConcurrency ?? 70;

    return {
      concurrency: Math.round(minC + d * (maxC - minC)),
      cooldown: Math.max(0.3, 2.0 - d * 1.5),  // 2.0s → 0.5s
      dist: 12,
      spread: 8,
      phase: 3,  // 全方向出怪
      pickType: () => this._pickType(d),
    };
  }

  // 按难度选怪：低难度以 basic 为主，高难度混入更多特种怪
  _pickType(d) {
    // 权重表：难度越高，特种怪权重越大
    const weights = [
      { type: 'basic',   w: Math.max(1, 4 - d * 3) },   // 高难度时降到 1
      { type: 'ninja',   w: 0.5 + d * 1.5 },
      { type: 'octopus', w: 0.3 + d * 1.2 },
      { type: 'shield',  w: 0.2 + d * 1.0 },
      { type: 'ghost',   w: 0.2 + d * 0.8 },
      { type: 'heart',   w: 0.1 + (1 - d) * 0.5 },      // 低难度多出回血怪
    ];

    // 只选 ENEMY_TYPES 里实际存在的类型
    const valid = weights.filter(e => ENEMY_TYPES[e.type]);
    const total = valid.reduce((s, e) => s + e.w, 0);
    let r = Math.random() * total;
    for (const e of valid) {
      r -= e.w;
      if (r <= 0) return e.type;
    }
    return 'basic';
  }

  notifyKill() {
    this.killWindow.push(this._t);
  }
}
