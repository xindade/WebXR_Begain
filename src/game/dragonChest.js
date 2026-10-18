// Boss 宝箱（第 6 关脸谱宝箱 / 第 12 关龙族宝箱）
//
//   现场口径：
//     · 每打死一个 Boss → 先在准星前方弹 2 秒「宝箱出现，快攻击」，再在选项卡位置立宝箱；
//     · 第 6 关脸谱宝箱：玩家**子弹命中**宝箱会把数值从 0.1 推到 2.0（每次 +0.1），持续 4 秒；
//       结算时 <0.5 → 0 条，0.5~<2.0 → 1 条，满 2.0 → 2 条额外弹道；
//     · 第 12 关龙族宝箱：口径保持不变（5 秒内打出的弹数线性换攻击力，≥30 发 +150 封顶）。
//
//   为什么数值/名字用场景内 Sprite：头显沉浸态里 DOM HUD 不可见（同 winBanner / 中场预警的结论）。
//   为什么数值标签自己管 canvas：要逐帧刷新一个数字，走 canvasTexture 工厂会每次新建贴图；
//   这里一张 canvas 复用，只在文案变化时重绘 + needsUpdate。
import * as THREE from 'three';
import { DRAGON_CHEST, MASK_CHEST } from '../core/constants.js';
import { loadGLB } from './glbCache.js';
import { buildModelClone } from './balloonModels.js';

/**
 * 纯函数：龙箱「打出的子弹数 → 攻击力加成」。线性，`>= BULLETS_FULL` 时封顶 `MAX_BONUS`。
 * @param {number} bullets 窗口内打出的子弹数
 * @param {object} cfg     DRAGON_CHEST
 */
export function chestBonus(bullets, cfg = DRAGON_CHEST) {
  const full = Number(cfg.BULLETS_FULL);
  const max = Number(cfg.MAX_BONUS);
  const b = Math.max(0, Math.floor(Number(bullets) || 0));
  if (!(max > 0)) return 0;
  if (!(full > 0)) return max;
  return Math.round(max * Math.min(1, b / full));
}

/** 纯函数：龙箱上方那一行的文案。 */
export function chestValueText(bonus) {
  return '+' + Math.max(0, Math.round(Number(bonus) || 0)) + ' 攻击力';
}

/** 纯函数：脸谱箱命中数 → 显示值（0.1 起步，每次 +0.1，封顶 2.0）。 */
export function bulletChestValue(hits, cfg = MASK_CHEST) {
  const start = Number(cfg.VALUE_START);
  const step = Number(cfg.VALUE_STEP);
  const max = Number(cfg.VALUE_MAX);
  const base = Number.isFinite(start) ? start : 0.1;
  const inc = Number.isFinite(step) && step > 0 ? step : 0.1;
  const cap = Number.isFinite(max) && max > 0 ? max : 2.0;
  const n = Math.max(0, Math.floor(Number(hits) || 0));
  return Math.min(cap, Math.round((base + inc * n) * 10) / 10);
}

/** 纯函数：脸谱箱最终结算（现场口径：<0.5→0；0.5~<2.0→1；满 2.0→2）。 */
export function bulletChestBonus(value, cfg = MASK_CHEST) {
  const v = Math.max(0, Number(value) || 0);
  const max = Number(cfg.VALUE_MAX) || 2.0;
  if (v >= max) return 2;
  return v >= 0.5 ? 1 : 0;
}

/** 纯函数：脸谱箱上方那一行的文案（保留 0.1 精度，让玩家看到实时变化）。 */
export function bulletChestValueText(value) {
  const v = Math.max(0, Number(value) || 0);
  return '+' + v.toFixed(1) + ' 子弹';
}

/** 一张自管理 canvas 的 Sprite：draw(text) 里自带去重，文案没变不重绘/不重传。 */
function liveLabel({ color, font, width, height, spriteW, spriteH }) {
  const cv = document.createElement('canvas');
  cv.width = width; cv.height = height;
  const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false,
  }));
  sprite.scale.set(spriteW, spriteH, 1);
  let last = null;
  const draw = (text) => {
    if (text === last) return;
    last = text;
    ctx.clearRect(0, 0, width, height);
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, width / 2, height / 2);
    ctx.fillStyle = color;
    ctx.fillText(text, width / 2, height / 2);
    tex.needsUpdate = true;
  };
  return { sprite, draw };
}

export class DragonChest {
  /** @param {object} [cfg] DRAGON_CHEST（默认）或 MASK_CHEST */
  constructor(scene, cfg = DRAGON_CHEST) {
    this.scene = scene;
    this.cfg = cfg;
    this.group = new THREE.Group();
    this.group.position.set(cfg.POS[0], cfg.POS[1], cfg.POS[2]);
    this.group.visible = false;
    scene.add(this.group);

    this.phase = 'idle';     // idle | counting | flying
    this._punch = 0;         // 受击「压一下」的强度（第五十一修：宝箱受击要有反馈）
    this.t = 0;              // 计数窗口剩余秒
    this.bullets = 0;        // 窗口内打出的子弹数（龙箱）
    this.hits = 0;           // 窗口内命中宝箱的子弹数（脸谱箱）
    this.value = 0;          // 脸谱箱的实时显示值
    this.bonus = 0;          // 窗口结束时的加成（game 读它加 player.atk / shotCount）
    this._disposed = false;
    this._holdLeft = null;
    this._ready = false;     // GLB 是否已就位（未就位时绝不显示占位盒）
    this._wantStart = false; // 横幅结束后已请求开箱，但模型还在加载

    // —— 宝箱本体：GLB 异步加载；加载期间整个 group 隐身，绝不把棕色占位盒露给玩家 ——
    const bodyHolder = new THREE.Group();
    this.group.add(bodyHolder);
    this.body = bodyHolder;
    const ph = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, 0.42, 0.46),
      new THREE.MeshStandardMaterial({ color: 0x8a5a2b, metalness: 0.1, roughness: 0.85 }));
    this._placeholder = ph;
    bodyHolder.add(ph);
    loadGLB(cfg.MODEL).then((gltf) => {
      if (this._disposed || !gltf) return;
      const built = buildModelClone(gltf.scene, cfg.MODEL, 0.5, null, null, 1);
      built.clone.scale.multiplyScalar(cfg.SCALE || 1);
      bodyHolder.remove(ph);
      ph.geometry.dispose();
      ph.material.dispose();
      this._placeholder = null;
      bodyHolder.add(built.clone);
      this._ready = true;
      this._startIfWaiting();
    }).catch(() => {
      // 加载失败：保留占位盒兜底，流程不能卡死；正常情况进关预载已把 GLB 放进缓存。
      this._ready = true;
      this._startIfWaiting();
    });

    // —— 名字（下方）与加成数值（上方）——
    this._name = liveLabel({
      color: cfg.NAME_COLOR, font: 'bold 96px sans-serif',
      width: 512, height: 128, spriteW: 1.35, spriteH: 0.34,
    });
    this._name.sprite.position.set(0, cfg.NAME_DY, 0);
    this._name.draw(cfg.NAME);
    this.group.add(this._name.sprite);

    this._value = liveLabel({
      color: cfg.VALUE_COLOR, font: 'bold 104px sans-serif',
      width: 512, height: 128, spriteW: 1.35, spriteH: 0.34,
    });
    this._value.sprite.position.set(0, cfg.VALUE_DY, 0);
    this.group.add(this._value.sprite);

    // —— 「化光点飞向玩家」用的光点池（构造时建一次，之后复用）——
    const geo = new THREE.SphereGeometry(cfg.ORB_SIZE, 10, 8);
    this._orbs = [];
    for (let i = 0; i < cfg.ORB_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: cfg.ORB_COLOR, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this._orbs.push({ mesh, from: new THREE.Vector3(), to: new THREE.Vector3(), dur: 1, delay: 0, t: 0, active: false });
    }
    this._orbGeo = geo;
  }

  /** 是否正在加载/计时/飞行（game 用它决定要不要把开火数喂进来、是否挡住抽卡） */
  get running() { return this.phase !== 'idle'; }

  /** 是否在计数窗口里（受击判定只在这个窗口内有效：窗口一过箱子就化光点飞走了） */
  get counting() { return this.phase === 'counting'; }

  /** 受击表现：箱体压一下（火花/命中音由 game._chestHitTest 负责，和别的小怪同款） */
  punch() { this._punch = 1; }

  /**
   * 打开计数窗口（config 里的 WINDOW：龙箱 5 秒 / 脸谱箱 4 秒）。
   * 模型没就位时只进入 loading，保持隐身；GLB 到位后才真正显示并开始倒计时。
   */
  start() {
    if (!this._ready) {
      this._wantStart = true;
      this.phase = 'loading';
      this.group.visible = false;
      return this;
    }
    this._wantStart = false;
    return this._beginCounting();
  }

  _startIfWaiting() {
    if (!this._wantStart || this._disposed) return;
    this._wantStart = false;
    this._beginCounting();
  }

  _beginCounting() {
    this.phase = 'counting';
    this._punch = 0;
    this.body.scale.set(1, 1, 1);
    this.t = Math.max(0.1, Number(this.cfg.WINDOW) || 5);
    this.bullets = 0;
    this.hits = 0;
    this.value = this.cfg.KIND === 'bullets' ? bulletChestValue(0, this.cfg) : 0;
    this.bonus = 0;
    this._holdLeft = null;
    this.group.visible = true;
    this._value.draw(this.cfg.KIND === 'bullets'
      ? bulletChestValueText(this.value)
      : chestValueText(0));
    return this;
  }

  /** 玩家这帧打出了 n 发（龙箱按开火数计；脸谱箱只认实际命中，见 addHit） */
  addShots(n) {
    const v = Math.floor(Number(n) || 0);
    if (this.phase !== 'counting' || v <= 0) return;
    this.bullets += v;
  }

  /** 子弹真正命中宝箱：只有脸谱箱用得到（每次 +0.1） */
  addHit() {
    if (this.phase !== 'counting' || this.cfg.KIND !== 'bullets') return;
    this.hits += 1;
    this.value = bulletChestValue(this.hits, this.cfg);
    this._value.draw(bulletChestValueText(this.value));
  }

  /**
   * 每帧推进。
   * @returns {'idle'|'counting'|'flying'|'done'} done = 光点已落地，调用方可以读 `bonus` 并推进流程
   */
  update(dt, camera) {
    if (this.phase === 'loading') return 'loading';
    if (this.phase === 'counting') {
      this.t -= dt;
      // 受击压一下 → 回弹（横向鼓、纵向扁；回弹到 0 就精确复位，避免残留缩放）
      if (this._punch > 0) {
        this._punch = Math.max(0, this._punch - dt * (this.cfg.PUNCH_DECAY || 5));
        const s = 1 + (this.cfg.PUNCH_SCALE || 0) * this._punch;
        this.body.scale.set(s, 1 / s, s);
        if (this._punch === 0) this.body.scale.set(1, 1, 1);
      }
      if (this.cfg.KIND === 'bullets') {
        this.value = bulletChestValue(this.hits, this.cfg);
        this._value.draw(bulletChestValueText(this.value));
      } else {
        this._value.draw(chestValueText(chestBonus(this.bullets, this.cfg)));
      }
      if (this.t > 0) return 'counting';
      this.bonus = this.cfg.KIND === 'bullets'
        ? bulletChestBonus(this.value, this.cfg)
        : chestBonus(this.bullets, this.cfg);
      this._startFlying(camera);
      this.phase = 'flying';
      return 'flying';
    }
    if (this.phase === 'flying') {
      if (this._updateOrbs(dt)) { this.phase = 'idle'; return 'done'; }
      return 'flying';
    }
    return 'idle';
  }

  /** 收起（不销毁实例）：切关 / 重开 / 回菜单都调 */
  hide() {
    this.phase = 'idle';
    this._wantStart = false;
    this.group.visible = false;
    this._holdLeft = null;
    for (const o of this._orbs) { o.active = false; o.mesh.visible = false; }
  }

  dispose() {
    this._disposed = true;
    this.hide();
    this.scene.remove(this.group);
    for (const o of this._orbs) { this.scene.remove(o.mesh); o.mesh.material.dispose(); }
    this._orbs.length = 0;
    if (this._orbGeo) { this._orbGeo.dispose(); this._orbGeo = null; }
    if (this._placeholder) {
      this._placeholder.geometry.dispose();
      this._placeholder.material.dispose();
      this._placeholder = null;
    }
    if (this._name) this._name.sprite.material.dispose();
    if (this._value) this._value.sprite.material.dispose();
  }

  // —— 内部：窗口结束 → 宝箱消失，一串光点飞向玩家 ——
  _startFlying(camera) {
    this.group.visible = false;
    const to = new THREE.Vector3();
    if (camera && camera.getWorldPosition) camera.getWorldPosition(to);
    else to.set(0, 1.6, 0);
    to.y -= 0.3;                                   // 落在胸口高度，别怼在眼睛上
    const base = this.group.position;
    for (const o of this._orbs) {
      o.from.copy(base);
      o.from.x += (Math.random() - 0.5) * 0.7;     // 起飞点散开，别从一个点齐射
      o.from.y += (Math.random() - 0.5) * 0.5;
      o.from.z += (Math.random() - 0.5) * 0.7;
      o.to.copy(to);
      o.dur = THREE.MathUtils.clamp(
        o.from.distanceTo(to) / (this.cfg.ORB_SPEED || 7),
        this.cfg.ORB_DUR_MIN, this.cfg.ORB_DUR_MAX);
      o.delay = Math.random() * (this.cfg.ORB_STAGGER || 0) * this.cfg.ORB_COUNT;
      o.t = 0;
      o.active = true;
      o.mesh.position.copy(o.from);
      o.mesh.scale.setScalar(1);
      o.mesh.material.opacity = 1;
      o.mesh.visible = true;
    }
    this._holdLeft = null;
  }

  _updateOrbs(dt) {
    let busy = false;
    for (const o of this._orbs) {
      if (!o.active) continue;
      if (o.delay > 0) { o.delay -= dt; busy = true; continue; }
      o.t += dt;
      const k = Math.min(1, o.t / o.dur);
      const e = k * k * (3 - 2 * k);
      o.mesh.position.lerpVectors(o.from, o.to, e);
      o.mesh.material.opacity = 1 - k * k * k;
      o.mesh.scale.setScalar(1 + 0.5 * Math.sin(Math.PI * k));
      if (k >= 1) { o.active = false; o.mesh.visible = false; } else busy = true;
    }
    if (busy || this._orbs.length === 0) return false;
    if (this._holdLeft == null) this._holdLeft = this.cfg.ORB_HOLD || 0;
    this._holdLeft -= dt;
    return this._holdLeft <= 0;
  }
}
