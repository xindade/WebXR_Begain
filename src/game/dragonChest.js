// 第十二关 · 龙族宝箱（第五十修 · 现场口径）
//
//   龙 Boss 被打败后**先不弹选项卡**：
//     ① 在选项卡位置（CARD.ROW_*）立一个宝箱 —— 模型用现成的 Model/宝箱.glb，
//        名字「龙族宝箱」显示在宝箱**下方**、加成数值显示在宝箱**上方**（现场指定）；
//     ② 5 秒计数窗口：按玩家在这 5 秒里**打出的子弹数**给攻击力加成（线性，≥BULLETS_FULL 满额），
//        数值随射击实时刷新；
//     ③ 窗口结束 → 宝箱化成光点飞向玩家 → 再弹选项卡（由 game._proceedLevelClear 接手）。
//
//   为什么数值/名字用场景内 Sprite：头显沉浸态里 DOM HUD 不可见（同 winBanner / 中场预警的结论）。
//   为什么加号/数值标签自己管 canvas：要**逐帧刷新**一个数字，走 canvasTexture 工厂会每次新建贴图；
//   这里一张 canvas 复用，只在文案变化时重绘 + needsUpdate（一秒最多改几次）。
import * as THREE from 'three';
import { DRAGON_CHEST } from '../core/constants.js';
import { loadGLB } from './glbCache.js';
import { buildModelClone } from './balloonModels.js';

/**
 * 纯函数：子弹数 → 攻击力加成。线性，`>= BULLETS_FULL` 时封顶 `MAX_BONUS`。便于单测。
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

/** 纯函数：宝箱上方那一行的文案。 */
export function chestValueText(bonus) {
  return '+' + Math.max(0, Math.round(Number(bonus) || 0)) + ' 攻击力';
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
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.position.set(DRAGON_CHEST.POS[0], DRAGON_CHEST.POS[1], DRAGON_CHEST.POS[2]);
    this.group.visible = false;
    scene.add(this.group);

    this.phase = 'idle';     // idle | counting | flying
    this._punch = 0;         // 受击「压一下」的强度（第五十一修：宝箱受击要有反馈）
    this.t = 0;              // 计数窗口剩余秒
    this.bullets = 0;        // 窗口内打出的子弹数
    this.bonus = 0;          // 窗口结束时的加成（game 读它加 player.atk）
    this._disposed = false;
    this._holdLeft = null;

    // —— 宝箱本体：GLB 异步加载；未到位/失败时先摆一个棕色占位盒（绝不能挡住关卡流程）——
    const bodyHolder = new THREE.Group();
    this.group.add(bodyHolder);
    this.body = bodyHolder;
    const ph = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, 0.42, 0.46),
      new THREE.MeshStandardMaterial({ color: 0x8a5a2b, metalness: 0.1, roughness: 0.85 }));
    bodyHolder.add(ph);
    loadGLB(DRAGON_CHEST.MODEL).then((gltf) => {
      if (this._disposed || !gltf) return;
      const built = buildModelClone(gltf.scene, DRAGON_CHEST.MODEL, 0.5, null, null, 1);
      built.clone.scale.multiplyScalar(DRAGON_CHEST.SCALE || 1);
      bodyHolder.remove(ph);
      ph.geometry.dispose();
      ph.material.dispose();
      bodyHolder.add(built.clone);
    }).catch(() => { /* 加载失败：占位盒照常显示，流程不受影响 */ });

    // —— 名字（下方）与加成数值（上方）——
    this._name = liveLabel({
      color: DRAGON_CHEST.NAME_COLOR, font: 'bold 96px sans-serif',
      width: 512, height: 128, spriteW: 1.35, spriteH: 0.34,
    });
    this._name.sprite.position.set(0, DRAGON_CHEST.NAME_DY, 0);
    this._name.draw(DRAGON_CHEST.NAME);
    this.group.add(this._name.sprite);

    this._value = liveLabel({
      color: DRAGON_CHEST.VALUE_COLOR, font: 'bold 104px sans-serif',
      width: 512, height: 128, spriteW: 1.35, spriteH: 0.34,
    });
    this._value.sprite.position.set(0, DRAGON_CHEST.VALUE_DY, 0);
    this.group.add(this._value.sprite);

    // —— 「化光点飞向玩家」用的光点池（构造时建一次，之后复用）——
    const geo = new THREE.SphereGeometry(DRAGON_CHEST.ORB_SIZE, 10, 8);
    this._orbs = [];
    for (let i = 0; i < DRAGON_CHEST.ORB_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: DRAGON_CHEST.ORB_COLOR, transparent: true, opacity: 1,
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

  /** 是否正在计时/飞行（game 用它决定要不要把开火数喂进来） */
  get running() { return this.phase !== 'idle'; }

  /** 是否在 5 秒计数窗口里（受击判定只在这个窗口内有效：窗口一过箱子就化光点飞走了） */
  get counting() { return this.phase === 'counting'; }

  /** 受击表现：箱体压一下（火花/命中音由 game._chestHitTest 负责，和别的小怪同款） */
  punch() { this._punch = 1; }

  /** 打开 5 秒计数窗口 */
  start() {
    this.phase = 'counting';
    this._punch = 0;
    this.body.scale.set(1, 1, 1);
    this.t = Math.max(0.1, Number(DRAGON_CHEST.WINDOW) || 5);
    this.bullets = 0;
    this.bonus = 0;
    this._holdLeft = null;
    this.group.visible = true;
    this._value.draw(chestValueText(0));
    return this;
  }

  /** 玩家这帧打出了 n 发（只在计数窗口里累计） */
  addShots(n) {
    const v = Math.floor(Number(n) || 0);
    if (this.phase !== 'counting' || v <= 0) return;
    this.bullets += v;
  }

  /**
   * 每帧推进。
   * @returns {'idle'|'counting'|'flying'|'done'} done = 光点已落地，调用方可以读 `bonus` 并推进流程
   */
  update(dt, camera) {
    if (this.phase === 'counting') {
      this.t -= dt;
      // 受击压一下 → 回弹（横向鼓、纵向扁；回弹到 0 就精确复位，避免残留缩放）
      if (this._punch > 0) {
        this._punch = Math.max(0, this._punch - dt * (DRAGON_CHEST.PUNCH_DECAY || 5));
        const s = 1 + (DRAGON_CHEST.PUNCH_SCALE || 0) * this._punch;
        this.body.scale.set(s, 1 / s, s);
        if (this._punch === 0) this.body.scale.set(1, 1, 1);
      }
      this._value.draw(chestValueText(chestBonus(this.bullets, DRAGON_CHEST)));
      if (this.t > 0) return 'counting';
      this.bonus = chestBonus(this.bullets, DRAGON_CHEST);
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
        o.from.distanceTo(to) / (DRAGON_CHEST.ORB_SPEED || 7),
        DRAGON_CHEST.ORB_DUR_MIN, DRAGON_CHEST.ORB_DUR_MAX);
      o.delay = Math.random() * (DRAGON_CHEST.ORB_STAGGER || 0) * DRAGON_CHEST.ORB_COUNT;
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
    if (this._holdLeft == null) this._holdLeft = DRAGON_CHEST.ORB_HOLD || 0;
    this._holdLeft -= dt;
    return this._holdLeft <= 0;
  }
}
