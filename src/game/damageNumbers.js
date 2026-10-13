import * as THREE from 'three';
import { DAMAGE_NUMBER } from '../core/constants.js';

// 伤害数字（第四十修）。
//   命中/击杀时在怪物头顶弹出伤害数值，配合「档1 打击感」给玩家即时的数值反馈。
//   颜色分档：每满 DAMAGE_NUMBER.STEP(=100) 伤害，颜色沿 COLORS 往红加深一档，字号同步放大。
//   性能约束（头显 GPU 是瓶颈，见 docs/tech）：
//     · 全部走对象池 —— 池满时回收「最旧的在播数字」，绝不每次命中 new 一个 Sprite；
//     · 同一只怪在 AGGREGATE_WINDOW 内的多次命中合并成同一个数字（高射速下既防刷屏，
//       也避免反复重绘 canvas + 上传纹理），因此并发上限 = 同时被击中的怪数。
//   贴图：每个池条目自带一张 256x128 的 canvas（只有数值变化时才 needsUpdate）。

/** 伤害 → 颜色档位索引（0 = 最浅）。每满 step 进一档，超出档位数则封顶在最后一档。 */
export function damageTierIndex(amount, step = DAMAGE_NUMBER.STEP, count = DAMAGE_NUMBER.COLORS.length) {
  const v = Number(amount) || 0;
  if (!(v > 0)) return 0;
  return Math.max(0, Math.min(count - 1, Math.floor(v / step)));
}

/** 伤害 → 颜色（0xRRGGBB）。 */
export function damageColorOf(amount) {
  return DAMAGE_NUMBER.COLORS[damageTierIndex(amount)];
}

function hexColor(n) {
  return '#' + (n >>> 0).toString(16).padStart(6, '0');
}

export class DamageNumbers {
  constructor(scene) {
    this.scene = scene;
    this.enabled = !!DAMAGE_NUMBER.ENABLED;
    this.group = new THREE.Group();
    this.group.name = 'damage-numbers';
    this.group.frustumCulled = false;
    scene.add(this.group);

    this._pool = [];    // 全部已创建的条目（空闲 + 在播）
    this._idle = [];    // 空闲条目栈
    this._live = [];    // 在播条目（按创建顺序，回收最旧时取 [0]）
    this._agg = new Map(); // key(怪物对象) → 条目：合并窗口内复用同一个数字
    this.peak = 0;      // 并发峰值（自检/报告用）
    this._uploads = 0;  // 本帧已上传的贴图数（帧边界在 update()/flushUploads 清零）
    this.peakUploads = 0; // 单帧上传峰值（自检/报告用，见 docs/tech/16）
  }

  _create() {
    const canvas = document.createElement('canvas');
    canvas.width = DAMAGE_NUMBER.TEX_W;
    canvas.height = DAMAGE_NUMBER.TEX_H;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false,
    }));
    sprite.visible = false;
    sprite.renderOrder = 999;   // depthTest=false：数字始终压在模型之上，不被敌人挡住
    this.group.add(sprite);
    return {
      sprite, canvas, ctx: canvas.getContext('2d'), tex,
      key: null, alive: false, kill: false, _texDirty: true,
      t: 0, life: DAMAGE_NUMBER.LIFE, rise: DAMAGE_NUMBER.RISE,
      pos: new THREE.Vector3(), value: 0, scale: DAMAGE_NUMBER.SIZE,
    };
  }

  _unlink(e) {
    const i = this._live.indexOf(e);
    if (i !== -1) this._live.splice(i, 1);
    if (e.key && this._agg.get(e.key) === e) this._agg.delete(e.key);
    e.key = null;
    e.alive = false;
    e.sprite.visible = false;
  }

  _obtain() {
    let e = this._idle.pop();
    if (!e && this._pool.length < DAMAGE_NUMBER.POOL) { e = this._create(); this._pool.push(e); }
    if (!e && this._live.length) {           // 池满：回收最旧的在播数字
      e = this._live[0];
      this._unlink(e);
    }
    return e || null;
  }

  /**
   * 弹出一个伤害数字（或并入同一只怪的既有数字）。
   * @param {THREE.Vector3} worldPos 世界坐标（一般是怪物位置 + 抬升）
   * @param {number} amount 伤害值
   * @param {{key?: object, kill?: boolean}} [opts] key = 合并键（传怪物对象）
   * @returns {object|null} 条目
   */
  spawn(worldPos, amount, opts = {}) {
    if (!this.enabled || !worldPos) return null;
    const value = Math.round(Number(amount) || 0);
    if (!(value > 0)) return null;
    const key = opts.key || null;
    const kill = !!opts.kill;

    let e = key ? this._agg.get(key) : null;
    if (e && e.alive && e.t <= DAMAGE_NUMBER.AGGREGATE_WINDOW) {
      e.value += value;          // 合并：数字累加，而不是在高射速下刷一屏
      e.t = 0;
      e.kill = e.kill || kill;
      e.pos.copy(worldPos);
      this._draw(e);
      return e;
    }
    if (e) { this._unlink(e); this._idle.push(e); }

    e = this._obtain();
    if (!e) return null;
    e.key = key;
    e.alive = true;
    e.kill = kill;
    e.t = 0;
    e.life = DAMAGE_NUMBER.LIFE * (kill ? 1.25 : 1);
    e.rise = DAMAGE_NUMBER.RISE * (kill ? 1.2 : 1);
    e.value = value;
    e.pos.copy(worldPos);
    e.sprite.position.copy(e.pos);
    e.sprite.visible = true;
    this._live.push(e);
    if (key) this._agg.set(key, e);
    if (this._live.length > this.peak) this.peak = this._live.length;
    this._draw(e);
    // 贴图还没上传（超预算被延后）时先别露：池复用会带着上一只怪的旧数字
    e.sprite.material.opacity = e._texDirty ? 0 : 1;
    return e;
  }

  _draw(e) {
    const ctx = e.ctx;
    const W = e.canvas.width, H = e.canvas.height;
    const amount = e.value;
    const tier = damageTierIndex(amount);
    e.tier = tier;
    ctx.clearRect(0, 0, W, H);
    ctx.font = 'bold ' + DAMAGE_NUMBER.FONT_PX + 'px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = DAMAGE_NUMBER.STROKE_PX;
    // 高档位改金色描边：暴击级伤害更醒目
    ctx.strokeStyle = tier >= DAMAGE_NUMBER.BIG_TIER ? DAMAGE_NUMBER.BIG_STROKE : DAMAGE_NUMBER.STROKE;
    const text = String(amount);
    ctx.strokeText(text, W / 2, H / 2);
    ctx.fillStyle = hexColor(damageColorOf(amount));
    ctx.fillText(text, W / 2, H / 2);
    // 纹理上传（节流，见 _flushUploads）：先补上一帧欠的账，再传自己
    this._flushUploads(e);   // 补上一帧欠的账（不含自己）
    if (this._uploads < Math.max(1, DAMAGE_NUMBER.UPLOAD_PER_FRAME | 0)) {
      e.tex.needsUpdate = true; e._texDirty = false;
      this._uploads++;
      if (this._uploads > this.peakUploads) this.peakUploads = this._uploads;
    } else {
      e._texDirty = true;   // 延后：下一帧 update() 或后续 _draw 补传
    }
    e.scale = DAMAGE_NUMBER.SIZE * (1 + tier * DAMAGE_NUMBER.TIER_SCALE_STEP) * (e.kill ? DAMAGE_NUMBER.KILL_SCALE : 1);
  }

  update(dt) {
    if (!this.enabled) return;
    this._uploads = 0;      // 帧边界：上传预算清零
    this._flushUploads();   // 把上一帧欠的上传补上
    const FADE = 0.35;   // 生命周期最后 35% 用于淡出
    for (let i = this._live.length - 1; i >= 0; i--) {
      const e = this._live[i];
      e.t += dt;
      const k = e.t / e.life;
      if (k >= 1) { this._unlink(e); this._idle.push(e); continue; }
      e.pos.y += e.rise * dt;
      e.sprite.position.copy(e.pos);
      const pop = 1 + (DAMAGE_NUMBER.POP - 1) * Math.max(0, 1 - e.t / 0.12); // 出生瞬间放大后回落
      const s = e.scale * pop;
      e.sprite.scale.set(s * (DAMAGE_NUMBER.TEX_W / DAMAGE_NUMBER.TEX_H), s, 1);
      e.sprite.material.opacity = k <= 1 - FADE ? 1 : (1 - k) / FADE;
      if (e._texDirty) e.sprite.material.opacity = 0;   // 贴图未上传 → 不许露（会显示上一轮的数字）
    }
  }

  // ---- 纹理上传节流（第四十二修）----
  // 同一帧画得太多（如来神掌横扫一片）时，canvas 重绘 + CanvasTexture 上传会在 Pico 上变成
  // 一次 3MB 级的 GPU 尖峰 —— 这就是「神掌一放就卡一下」。预算内立即上传，超预算的延后。
  /** @param {object} [skip] 跳过某一条（正在 _draw 里自己处理的那条，避免同一帧占两份预算） */
  _flushUploads(skip) {
    const budget = Math.max(1, DAMAGE_NUMBER.UPLOAD_PER_FRAME | 0);
    for (let i = 0; i < this._live.length && this._uploads < budget; i++) {
      const e = this._live[i];
      if (e === skip || !e._texDirty) continue;
      e.tex.needsUpdate = true;
      e._texDirty = false;
      this._uploads++;
      if (this._uploads > this.peakUploads) this.peakUploads = this._uploads;
    }
  }

  /** 帧末兜底：把本帧剩余未上传的数字贴图补上（game._updateFx 调用）。 */
  flushUploads() { if (this.enabled) this._flushUploads(); }

  /** 清空全部在播数字（回菜单 / 切关 / 重开用）。 */
  clear() {
    for (let i = this._live.length - 1; i >= 0; i--) {
      const e = this._live[i];
      this._unlink(e);
      this._idle.push(e);
    }
    this._live.length = 0;
    this._agg.clear();
  }
}