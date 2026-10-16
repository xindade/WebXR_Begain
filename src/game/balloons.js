import * as THREE from 'three';
import { ENEMY_TYPES } from '../content/enemies.js';
import { BOMB_LABEL, BALLOON, MOVE, SHURIKEN, PROJECTILE, ELITE_LABEL, BOSS_LABEL, HEAL_LINK } from '../core/constants.js';
import { ELITE_DISPLAY_NAME, eliteLabelText } from '../content/spawnDirector.js';
import { attachBalloonModel, fitToRadius, loadBalloonModel, attachDragonSegment, hideLoadDot } from './balloonModels.js';

// 程序化笑脸贴图（按颜色缓存）——占位怪也复用调色板
const _faceCache = new Map();
function faceTexture(hex) {
  if (_faceCache.has(hex)) return _faceCache.get(hex);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = hex;
  x.fillRect(0, 0, 128, 128);
  x.fillStyle = '#222';
  x.beginPath(); x.arc(46, 54, 9, 0, 7); x.arc(82, 54, 9, 0, 7); x.fill();
  x.lineWidth = 6; x.strokeStyle = '#222';
  x.beginPath(); x.arc(64, 66, 26, 0.2, Math.PI - 0.2); x.stroke();
  const t = new THREE.CanvasTexture(c);
  _faceCache.set(hex, t);
  return t;
}

const COLORS = ['#ff5a5f', '#ffb400', '#ffd166', '#06d6a0', '#118ab2', '#9b5de5', '#f15bb5'];

// 圆角矩形路径（名牌底板用）—— 与 warningBanner._roundRect 同源，但那份只服务横幅，故各自保留一份。
function _roundRectPath(x, rx, ry, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  x.beginPath();
  x.moveTo(rx + rr, ry);
  x.arcTo(rx + w, ry, rx + w, ry + h, rr);
  x.arcTo(rx + w, ry + h, rx, ry + h, rr);
  x.arcTo(rx, ry + h, rx, ry, rr);
  x.arcTo(rx, ry, rx + w, ry, rr);
  x.closePath();
}

// 模块级临时量：消除 update 热循环里每怪每帧 new Vector3 / new Color 的 GC 压力
const _moveDir   = new THREE.Vector3();   // update() 朝玩家方向（每怪复用，调用即消费）
const _camPos    = new THREE.Vector3();   // update() 血条 lookAt 的相机世界坐标
const _shieldSp  = new THREE.Vector3();   // getShieldBlock() 盾牌世界坐标
const _flashCol  = new THREE.Color();     // 第四十九修：闪烁色的临时量（受击白 / 回血绿），避免每帧 new
const _shieldCt  = new THREE.Vector3();   // getShieldBlock() 气球中心世界坐标
const _bombQuat  = new THREE.Quaternion(); // 「爆」标记：所有实例共用同一朝向（都正面朝相机）
const _bombPos   = new THREE.Vector3();    // 「爆」标记：实例世界坐标
const _bombScale = new THREE.Vector3();    // 「爆」标记：实例缩放
const _bombM4    = new THREE.Matrix4();    // 「爆」标记：实例矩阵

// ============================================================
// 基础怪「爆」标记（第五十六修）—— 基础小怪（L1 杂鱼，非精英/非 Boss）头顶一个「爆」字，
//   提示「撞到飞毯边缘会自爆」。用**单个 InstancedMesh**（无论多少只都只有 1 个 draw call）；
//   所有实例朝向相同（正面朝相机）⇒ 共用一个旋转矩阵，逐帧只改位置/缩放。
// ============================================================
let _bombTex = null;
function _bombLabelTexture() {
  if (_bombTex) return _bombTex;
  const S = BOMB_LABEL;
  const c = document.createElement('canvas');
  c.width = S.CANVAS; c.height = S.CANVAS;
  const x = c.getContext('2d');
  const mid = S.CANVAS / 2;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = `bold ${Math.round(S.CANVAS * 0.72)}px sans-serif`;
  x.lineJoin = 'round';
  x.lineWidth = S.OUTLINE_W;
  x.strokeStyle = S.OUTLINE;
  x.strokeText(S.TEXT, mid, mid);          // 先描边（暗红）
  // 第五十七修：字与发光都画**纯白** —— 真色由实例色决定（常态暖黄 / 内圈闪烁红），见 bombMarkColor
  x.shadowColor = S.GLOW ? (S.GLYPH || '#ffffff') : 'transparent';
  x.shadowBlur = S.GLOW || 0;
  x.fillStyle = S.GLYPH || '#ffffff';
  x.fillText(S.TEXT, mid, mid);            // 后填充（白 + 白发光，颜色交给实例色）
  _bombTex = new THREE.CanvasTexture(c);
  return _bombTex;
}

const _bombCol = new THREE.Color();                       // 「爆」标记：实例色临时量
const _bombColNormal = new THREE.Color(BOMB_LABEL.COLOR).getHex();        // 常态（暖黄）
const _bombColBlink = new THREE.Color(BOMB_LABEL.BLINK_COLOR).getHex();   // 内圈闪烁（红）

/**
 * 「爆」标记的颜色（纯函数，便于单测）。
 *   第五十七修（现场）：进内圈（水平距圆心 ≤ BOMB_LABEL.INNER_RADIUS）= 危险区 → 按 BLINK_ON 节拍闪红；
 *   内圈之外一律常态暖黄。time 由调用方累加（秒）。
 */
export function bombMarkColor(b, time) {
  const S = BOMB_LABEL;
  if (!S.BLINK || !b || !b.mesh || !b.mesh.position) return _bombColNormal;
  const p = b.mesh.position;
  if (Math.hypot(p.x, p.z) > S.INNER_RADIUS) return _bombColNormal;
  const on = Math.floor(time / Math.max(0.05, S.BLINK_ON)) % 2 === 0;
  return on ? _bombColBlink : _bombColNormal;
}

/** 「爆」标记的判定（纯函数，便于单测）：活着的**基础小怪** —— 非精英 / 非 Boss / 非龙部件 / 非受控。 */
export function isBombMarkTarget(b) {
  return !!(b && b.alive && !b.isElite && !b.isBoss && !b.isDragonPart && !b.controlled);
}
const _orbTmp    = new THREE.Vector3();   // 忍者蓄力光球定位临时量（_updateChargeOrb 复用，消除每帧 new 的 GC 压力）
let _balloonUid = 0;      // 气球唯一 id（第五十五修：穿甲弹用它记录「已命中过谁」，避免同一发反复结算）

export class Balloon {
  constructor(typeId, opts = null) {
    const t = ENEMY_TYPES[typeId] || ENEMY_TYPES.basic;
    this.type = t;
    this.maxHp = t.hp;
    this.hp = t.hp;
    // 精英怪：允许外部覆盖血量（由 waves._fireElitePhase 按敌种计算 = ELITE_BASE_HP[型] + DPS×秒，叠加式）并标记
    if (opts && opts.hp != null) { this.maxHp = opts.hp; this.hp = opts.hp; }
    this.isElite = !!(opts && opts.isElite);
    // 第四十九修：末尾精英（Boss 档）= 关卡收尾那一批（waves._eliteOpts 判定，判据是事件带 goldReturn）
    //   climax → 名牌用 BOSS_LABEL 并加「 Boss」后缀；batchId → 供 waves._updateEliteWatch 按批判定
    this.isClimax = !!(opts && opts.climax);
    this.batchId = (opts && opts.batchId) || 0;
    this.speed = t.speed;
    // 第四十七修：精英体型倍数（sizeMul）与定速（speed）由 waves._eliteOpts 传入；
    //   这里只负责「按倍数把模型/占位/盾/血条/命中球一起放大」。
    //   ⚠ sizeMul 是**总体型倍数**（覆盖 ENEMY_TYPES 的 scale），不与 t.scale 相乘：
    //     enemies.js 里 heart/ninja/ghost/octopus 已写 scale:3（「精英怪整体放大 3 倍」），
    //     再乘一次 SIZE_MUL 就成 9 倍（半径 5~8m、贴脸糊屏），故「显式倍数优先、否则退回 t.scale」。
    const _explicitSize = (opts && Number.isFinite(opts.sizeMul) && opts.sizeMul > 0) ? opts.sizeMul : 0;
    this.sizeMul = _explicitSize > 0 ? _explicitSize : (t.scale || 1);   // 总体型倍数（含 t.scale）
    if (opts && Number.isFinite(opts.speed) && opts.speed > 0) this.speed = opts.speed;
    this.radius = t.radius;
    this.effectiveRadius = t.radius * this.sizeMul; // 碰撞/分离/血条用的实际半径（sizeMul 已含 t.scale）
    this.healthBarRadius = t.barRadius != null ? t.barRadius : t.radius; // 血条宽度半径(米)：默认=基础半径(不含 scale)。血条是 mesh.scale 子节点，会被 scale 放大 → 最终宽度≈模型直径，各型一致；可用 barRadius 单独覆盖
    this.hitRadius = this.effectiveRadius;            // 子弹命中球半径（模型加载后按视觉尺寸放大；占位怪构造里再放大）
    this.score = t.score;
    this.behavior = t.behavior;
    this.selfDamage = t.selfDamage !== undefined ? t.selfDamage : BALLOON.DAMAGE;
    this.damageReduction = t.damageReduction || 0;  // 0~1 减伤比例（脸谱 Boss 95%）
    this.alive = true;
    this.uid = ++_balloonUid;
    // 召唤怪专用
    this.minions = [];
    this.summonTimer = 0;
    this.minionCap = 2;

    const hex = t.tint != null ? '#' + t.tint.toString(16).padStart(6, '0') : COLORS[Math.floor(Math.random() * COLORS.length)];
    const geo = new THREE.SphereGeometry(t.radius, 20, 16);
    // plainColor（纯色球）：直接用颜色，不套「笑脸」贴图 —— 黑白球等机制球体用（第15关/第18关Boss）
    const mat = t.plainColor != null
      ? new THREE.MeshStandardMaterial({ color: t.plainColor, roughness: 0.6, metalness: 0.0 })
      : new THREE.MeshStandardMaterial({ map: faceTexture(hex), roughness: 0.6, metalness: 0.0 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.userData.balloon = this;
    this.bodyModel = null;     // GLB 模型（若有）
    this._modelMats = null;    // 模型/占位材质数组（用于受击闪烁）
    this._hasModel = false;

    // —— 外观装配 ——
    // 1) 有专用 GLB 模型 → 挂模型并隐藏程序化球体
    if (t.model) {
      this._hasModel = true;
      // 程序化球体默认隐藏：模型加载成功由 attachBalloonModel 挂上模型（球体保持隐藏）；
      // 加载失败也保持隐藏（不再用彩色球体兜底，避免破坏沉浸），仅 console.warn 暴露 404/解码问题。
      this.mesh.material.visible = false;
      // 盾兵怪/精英骑士复用骑士模型但需正常体型（Boss 骑士用 MODEL_TUNING 默认缩小），此处覆盖 scale
      const knightTuning = (t.id === 'shield' || t.id === 'eliteKnight') ? { scale: 1.0 } : null;
      attachBalloonModel(this, t.model, t.radius, null, knightTuning, 1, t.id);
    } else if (t.dragonSegment) {
      // 2b) 龙身/龙爪：外观装配延后到 dragonLevel._spawnBalloons 显式调用 attachDragonSegment，
      //     因为逐段 taper（头粗尾细）在构造时未知，需由外部传入。
      //     此处仅隐藏程序化球体 + 标记 _hasModel（跳过锥形头盔逻辑）。
      this._hasModel = true;
      this.mesh.material.visible = false;
    } else if (t.noPlaceholder) {
      // 2c) 纯色机制球（黑白球等）：只保留球体本身，不叠加胶囊占位/名牌（视觉由调用方决定）
      this._hasModel = true; // 跳过锥形头盔显示逻辑
    } else {
      // 2) 无模型 → 程序化占位（彩色胶囊 + 眼睛），保留 _modelMats 以便受击闪烁
      this._hasModel = true; // 跳过锥形头盔显示逻辑
      this._buildPlaceholder(t);
      this._makeNameLabel(t.name); // 需求④：占位怪加名牌，防止混淆
    }

    // 精英名牌（第四十六修）：有模型的小怪平时不挂名牌 —— 精英必须挂
    //   （红字 + 描边 + 半透明底），否则玩家分不清「这只和别的不一样」，
    //   也不可能知道该先打谁（治疗术士 / 盾甲兵 / 章鱼将军的优先级全靠它传达）。
    // 第四十九修：分两档 —— 普通精英（冰蓝）与末尾精英/Boss（金红 + 「 Boss」后缀）。
    //   查不到中文名时退回 ENEMY_TYPES 的 name（eliteLabelText 只负责加后缀）。
    const labelStyle = this.isClimax ? BOSS_LABEL : ELITE_LABEL;
    if (this.isElite && labelStyle.ENABLED && t.model) {
      this._makeNameLabel(eliteLabelText(ELITE_DISPLAY_NAME[t.id] || t.name, this.isClimax), labelStyle);
    }

    // 盾兵怪：在骑士模型基础上附加「会旋转的盾牌」（绕骑士旋转，挡子弹）
    if (t.shieldModel) this._buildShield(t);

    // 血条：所有非基础怪显示（含盾兵/召唤/心/忍者/宝箱/幽灵/龙头/聚宝盆/章鱼）；龙身(noHealthBar)除外——龙用全局血量池
    if (t.id !== 'basic' && !t.noHealthBar) this._makeHealthBar(this.healthBarRadius);
    // 第四十七修：体型倍数统一作用在 mesh 上（子节点一起放大）；this.sizeMul 已含 t.scale
    if (this.sizeMul !== 1) this.mesh.scale.setScalar(this.sizeMul);

    // 幽灵怪：默认隐身，仅在自身蓄力攻击（最后 ghostFireCharge 秒）时显形 ——
    // 显形期就是玩家的攻击窗口（隐身期间子弹打不中，见 game._collide 的 revealed 过滤）
    if (t.behavior === 'ghost') {
      this.revealed = false;
      this.mesh.visible = false;
      this._fireTimer = Math.random() * (t.ghostFireInterval || 3); // 随机初相位：多只不同时开火
      this._chargeOrb = null;
    }
    // 章鱼怪：远程投射物「蓄力→投掷」循环（第三十五修，与幽灵同机制，只是边靠近边喷墨）
    if (t.behavior === 'octopus') {
      this._fireTimer = Math.random() * (t.inkInterval || 3);
      this._chargeOrb = null;
    }
    // 聚宝盆：无敌 + 寿命计时
    if (t.behavior === 'treasure') {
      this._lifespan = t.lifespan || 10;
      this._killsDuringLife = 0;
    }
    // ninja lifecycle: 出现→蓄力→投掷→闪现（全局统一，非龙Boss专属）
    if (t.behavior === 'ninja') {
      this._ninjaPhase = 'appear';
      this._ninjaTimer = 0;
      this._chargeOrb = null;
    }
    // 宝箱怪：跳跳计时
    if (t.behavior === 'chest') this._hopTimer = Math.random() * (t.hopInterval || 2);

    this._flash = 0;
    this._lastDamage = 0; // 第四十修：上一次受击的实际伤害（伤害数字读取）
    this._hop = Math.random() * Math.PI * 2;
    // 立绘气球浮动（破「整齐划一」）：每怪独立的相位/幅度/频率 → 群体不再同步
    this._bobPhase = Math.random() * Math.PI * 2;
    this._bobAmp   = (t.radius || 1) * (0.04 + Math.random() * 0.06); // 上下浮动幅度 ≈ 半径的 4%~10%
    this._bobFreq  = 0.5 + Math.random() * 0.8;                       // 浮动频率(Hz)，个体不同
    this._bobT = 0;
    this.controlled = false;   // 由外部(如龙Boss)逐帧接管位置时为 true
    // 第四十九修：治疗术士**站桩**（现场需求：「不应该移动」）。复用 controlled 的既有语义：
    //   跳过「朝玩家自动移动」+ 跳过分离力推挤（不会被别的怪拱走），但仍 lookAt / 可受击 / 血条照常。
    if (t.behavior === 'heal') this.controlled = true;
    this._flashColor = 0xffffff;  // 第四十九修：闪烁色（受击=白，回血=粉，见 flashHeal）
    this._pendingKill = false; // 聚宝盆超时等脚本化死亡标记
    this.group = this.mesh;
  }

  // 占位外观：程序化胶囊 + 眼睛（无专用模型的小怪走这里）
  _buildPlaceholder(t) {
    const grp = new THREE.Group();
    const col = t.tint != null ? t.tint : 0xcccccc;
    const capMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.7, metalness: 0.05 });
    const cap = new THREE.Mesh(new THREE.CapsuleGeometry(t.radius * 0.7, t.radius * 1.1, 6, 12), capMat);
    cap.position.y = t.radius * 0.95;
    grp.add(cap);
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(t.radius * 0.13, 8, 8), eyeMat);
      eye.position.set(sx * t.radius * 0.3, t.radius * 1.25, t.radius * 0.62);
      grp.add(eye);
    }
    this.mesh.add(grp);
    this._modelMats = [capMat, eyeMat]; // 复用模型闪烁路径
    this.mesh.material.visible = false;
    this.hitRadius = this.effectiveRadius * 2.2; // 占位胶囊+眼睛视觉高于球体，放大命中球直到上半身
  }

  // 名牌：底板 + 文字，挂在怪上方；Sprite 始终朝向相机，depthTest 关闭永不被遮挡。
  //   第四十六修：支持样式（style）。第四十九修：样式字段扩充为「渐变底 / 外描边 / 内衬发丝线 /
  //   四角括号 / 左右装饰 / 文字发光」—— 于是「普通精英（冰蓝）」与「末尾精英 Boss（金红 + 后缀）」
  //   只是两组数字（constants.ELITE_LABEL / BOSS_LABEL），绘制代码只有这一份。
  //   不传 style（占位怪的老用法）时行为与旧版一致：纯半透明底 + 描边白字，无圆角无边框。
  _makeNameLabel(text, style = null) {
    const S = style || {};
    const W = S.CANVAS_W || 256, H = S.CANVAS_H || 64;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    this._drawNameLabel(x, W, H, text, S);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const sp = new THREE.Sprite(mat);
    const sc = S.SCALE || [1.4, 0.35];
    // 第四十七修：名牌是 mesh 的子节点 → 会被 sizeMul 一起放大。这里按倒数缩回去，
    //   让「3 倍体型的精英」名牌**世界尺寸与普通怪一致**（否则字大到糊脸）。
    const inv = this.sizeMul || 1;
    sp.scale.set(sc[0] / inv, sc[1] / inv, 1);
    // 挂在怪顶：用 effectiveRadius（含 scale 放大）算高度，3 倍体型的精英也贴得住
    sp.position.y = ((this.effectiveRadius || this.radius) * 2.6 + 0.3 + (S.Y_PAD || 0)) / inv;
    sp.renderOrder = 999;
    this.mesh.add(sp);
    this.label = sp;
  }

  // 名牌绘制（纯 Canvas2D，无 THREE 依赖 —— 便于单测直接喂一个假 ctx 断言画笔调用）
  _drawNameLabel(x, W, H, text, S) {
    const bgTop = S.BG_TOP || S.BG || 'rgba(0,0,0,0.55)';
    const bgBottom = S.BG_BOTTOM || S.BG || bgTop;
    const radius = S.RADIUS || 0;
    // ① 底板：垂直渐变（上浅下深）—— 避免「一块死板的纯色方块」
    const grad = x.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, bgTop);
    grad.addColorStop(1, bgBottom);
    x.fillStyle = grad;
    if (radius > 0) { _roundRectPath(x, 0, 0, W, H, radius); x.fill(); }
    else x.fillRect(0, 0, W, H);

    // ② 外描边
    if (S.EDGE && S.EDGE_W) {
      const i = S.EDGE_W / 2;
      x.lineWidth = S.EDGE_W;
      x.strokeStyle = S.EDGE;
      if (radius > 0) { _roundRectPath(x, i, i, W - i * 2, H - i * 2, Math.max(0, radius - i)); x.stroke(); }
      else x.strokeRect(i, i, W - i * 2, H - i * 2);
    }

    // ③ 内衬发丝线（贴边一圈）—— 让底板有「双层」质感，不再是单薄的一块
    if (S.HAIRLINE) {
      const k = S.HAIRLINE_INSET || 12;
      x.lineWidth = 1.5;
      x.strokeStyle = S.HAIRLINE;
      if (radius > 0) { _roundRectPath(x, k, k, W - k * 2, H - k * 2, Math.max(0, radius - k)); x.stroke(); }
      else x.strokeRect(k, k, W - k * 2, H - k * 2);
    }

    // ④ 四角括号（只画角、不封边 —— 比整圈方框利落得多）
    if (S.CORNER && S.CORNER_W) {
      const ci = S.CORNER_INSET || 8, cl = S.CORNER_LEN || 30;
      x.strokeStyle = S.CORNER;
      x.lineWidth = S.CORNER_W;
      x.lineCap = 'round';
      for (const [cx, cy, sx, sy] of [[ci, ci, 1, 1], [W - ci, ci, -1, 1], [ci, H - ci, 1, -1], [W - ci, H - ci, -1, -1]]) {
        x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + sx * cl, cy); x.stroke();
        x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx, cy + sy * cl); x.stroke();
      }
    }

    // ⑤ 左右装饰（Boss 档：两枚菱形 + 一条短横线）—— 一眼区分「这是收尾那一只」
    if (S.ORNAMENT === 'diamond') {
      const cy = H / 2, d = Math.min(17, H * 0.14);
      x.fillStyle = S.EDGE || S.COLOR || '#ffc53d';
      for (const cx of [H * 0.26, W - H * 0.26]) {
        x.beginPath();
        x.moveTo(cx, cy - d); x.lineTo(cx + d, cy); x.lineTo(cx, cy + d); x.lineTo(cx - d, cy);
        x.closePath(); x.fill();
      }
    }

    // ⑥ 文字（先描边再压字，远看也认得出；Boss 档带外发光）
    const by = H * 0.54;                       // 基线略低一点，视觉居中（描边会比字高一点）
    x.font = S.FONT || 'bold 38px sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    if (S.GLOW) { x.shadowColor = S.EDGE || S.COLOR || '#ffffff'; x.shadowBlur = S.GLOW; }
    if (S.OUTLINE) {
      x.lineWidth = S.OUTLINE_W || 6;
      x.strokeStyle = S.OUTLINE;
      x.lineJoin = 'round';
      x.strokeText(text, W / 2, by);
    }
    x.shadowBlur = 0;
    x.fillStyle = S.COLOR || '#ffffff';
    x.fillText(text, W / 2, by);
  }

  // 盾兵怪：骑士模型 + 会旋转的盾牌（盾作为 pivot 子节点，绕骑士旋转）
  _buildShield(t) {
    const pivot = new THREE.Group();
    this.mesh.add(pivot);
    this.shieldPivot = pivot;
    this.shieldAngle = Math.random() * Math.PI * 2;          // 初相位随机，避免多盾重叠
    this.shieldSpin = (Math.PI * 2) / (t.shieldSpinPeriod || 2.0); // rad/s，知识库「每2秒旋转一圈」
    this.shieldBlockArc = THREE.MathUtils.degToRad(t.shieldBlockArc || 75);
    this.shieldDist = t.radius * 1.35;                        // 盾牌中心到骑士中心距离
    this.shieldModel = null;
    loadBalloonModel(t.shieldModel)
      .then((gltfScene) => {
        if (!this.alive) { gltfScene.traverse(o => { if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); } }); return; }
        const s = gltfScene.clone(true);
        fitToRadius(s, t.radius * 1.1);
        s.position.set(0, 0, -this.shieldDist); // 放在 pivot 前方(-Z)：pivot 旋转即绕骑士转
        s.rotation.y = Math.PI;                  // 盾正面朝外(-Z)
        pivot.add(s);
        pivot.rotation.y = this.shieldAngle;
        this.shieldModel = s;
        s.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); this._modelMats.push(o.material); } });
      })
      .catch(() => { /* 盾牌加载失败：盾兵仍可用，仅缺盾外观 */ });
  }

  // 供 game._collide 判断「子弹是否被盾挡下」：返回盾牌世界朝向与挡弹半角
  getShieldBlock() {
    if (!this.shieldPivot || !this.shieldModel) return null;
    this.shieldModel.getWorldPosition(_shieldSp);
    this.mesh.getWorldPosition(_shieldCt);
    const dir = _shieldSp.sub(_shieldCt); dir.y = 0;
    if (dir.lengthSq() < 1e-6) return null;
    dir.normalize();
    return { dir, arc: this.shieldBlockArc };
  }

  _makeHealthBar(r) {
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(r * 2, 0.12), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    const fg = new THREE.Mesh(new THREE.PlaneGeometry(r * 2, 0.1), new THREE.MeshBasicMaterial({ color: 0x2ecc71 }));
    fg.position.z = 0.01;
    this._hpFg = fg;
    const bar = new THREE.Group();
    bar.add(bg); bar.add(fg);
    bar.position.y = r * 1.4;
    this.mesh.add(bar);
    this._hpBar = bar;
  }

  takeDamage(dmg, ignoreReduction = false) {
    this._lastDamage = 0;                   // 第四十修：本次实际伤害（伤害数字用；未命中/无敌时保持 0）
    if (this.type.invincible) return false; // 聚宝盆：无敌，子弹不扣血
    if (!this.alive) return false;          // 已死亡：防止爆炸链重复触发 _onKilled 导致无限递归
    let final = dmg;
    if (this.damageReduction > 0 && (!ignoreReduction || this.isDragonPart))
      final = dmg * (1 - this.damageReduction);  // 95% 减伤 → 实际 5%（isDragonPart 强制减伤，含激光剑穿透）
    this.hp -= final;
    this._lastDamage = final;               // 第四十修：减伤后的真实伤害，供伤害数字显示
    this._flashColor = 0xffffff;             // 受击闪白：把上一次「回血粉闪」的颜色复位
    this._flash = 0.1;
    this.refreshHealthBar();
    if (this.hp <= 0) { this.alive = false; return true; }
    return false;
  }

  /**
   * 血条重画（第五十一修 · 现场「治疗术士的加号飞过去了，可精英怪血条没涨」）。
   *
   *   根因：hp 是**裸字段**，而血条只在 takeDamage 里刷过一次 —— 回血路径（_applyHealAura）改完 hp
   *   不刷血条 ⇒ 血条还停在被扣血后的长度，现场看起来就是「根本没回血」。
   *   规矩：今后凡是改 hp 的地方（扣血/回血/复活/换血）都必须调它，别再各自复制那段公式。
   */
  refreshHealthBar() {
    if (!this._hpBar) return;
    const k = Math.max(0, Math.min(1, this.hp / this.maxHp));
    this._hpFg.scale.x = k;
    this._hpFg.position.x = -((1 - k) * this.healthBarRadius);
    this._hpFg.material.color.setHSL(0.33 * k, 0.7, 0.5);
  }

  /**
   * 第四十九修 · 回血闪烁：**粉色加号命中时**把这只怪染粉一下（现场返工：原来的绿环看不到）。
   *   为什么用它当「回血」的可读表现：血条回满在远处看不清，闪一下是瞬时、醒目的；
   *   而且复用既有的受击闪烁通道（DepthSprite 走 uFlashColor，模型走 emissive），零额外 draw call。
   * @param {number} [t] 闪烁时长（秒）；比受击(0.1)长一些，才看得出来是「治疗」而不是「挨打」
   */
  flashHeal(t = 0.28) {
    if (!this.alive) return;
    this._flash = Math.max(this._flash, t);
    this._flashColor = HEAL_LINK.PLUS_COLOR != null ? HEAL_LINK.PLUS_COLOR : HEAL_LINK.COLOR;
  }

  update(dt, target, camera) {
    // 朝玩家移动（controlled 气球由外部逐帧设位置，跳过自动移动）
    if (!this.controlled) {
      _moveDir.copy(target).sub(this.mesh.position);
      _moveDir.y = 0;
      const dist = _moveDir.length();
      if (dist > 0.001) _moveDir.normalize();
      // 步长钳制到「剩余距离」：否则单帧位移 > 剩余距离时会越过目标、下一帧再折返，
      // 高速怪（红阶段大旗 26m/s → 每帧 0.36m）逼近玩家时表现为剧烈抖动。
      this.mesh.position.addScaledVector(_moveDir, Math.min(this.speed * dt, dist));
      // 普通忍者：约束在距中心点(世界原点) 10~15m 环带内（龙形 Boss 的组成忍者 isDragonPart 跳过）
      // 第五十一修：章鱼也一起夹紧 —— 现场要求「在圈外攻击、不近身」（原来它会一路贴到玩家脸上喷墨）。
      if ((this.behavior === 'ninja' || this.behavior === 'octopus') && !this.isDragonPart) this._clampToRing();
    }

    // 盾牌绕骑士旋转（盾兵怪核心机制）
    if (this.shieldPivot) {
      this.shieldAngle += this.shieldSpin * dt;
      this.shieldPivot.rotation.y = this.shieldAngle;
    }

    // 小怪特殊行为
    this._updateBehavior(dt, target);

    // 笑脸/模型朝向玩家（龙部件由 dragonLevel 逐帧接管朝向，跳过以免被 lookAt 覆盖）
    if (!this.isDragonPart) this.mesh.lookAt(target.x, target.y, target.z);

    // DepthSprite 同步：位置跟随气球 + 仅 yaw 朝向玩家（视差基于世界空间相机，XR 逐眼立体）
    if (this.depthSprite) {
      this._bobT += dt;
      // 每帧重置为气球逻辑位置（不累积），再叠加独立上下浮动 → 气球悬浮感
      this.depthSprite.mesh.position.copy(this.mesh.position);
      this.depthSprite.mesh.position.y += this._bobAmp * Math.sin(this._bobPhase + this._bobT * this._bobFreq);
      this.depthSprite.faceYaw(target);
      this.depthSprite.advance(dt); // idle 序列帧推进（多帧 sheet 循环播放）
    }

    // 受击闪烁（有模型/占位材质则闪材质，否则闪程序化球体；DepthSprite 用 uFlash 白闪）
    if (this._flash > 0) {
      this._flash -= dt;
      const inten = Math.max(0, this._flash * 6);
      const flashColor = this._flashColor || 0xffffff;   // 第四十九修：受击=白 / 回血=粉
      if (this.depthSprite) {
        this.depthSprite.setFlash(inten, flashColor);
      } else if (this._modelMats) {
        _flashCol.setHex(flashColor);
        for (const m of this._modelMats) { m.emissive.copy(_flashCol); m.emissiveIntensity = inten; }
      } else {
        _flashCol.setHex(flashColor);
        this.mesh.material.emissive.copy(_flashCol);
        this.mesh.material.emissiveIntensity = inten;
      }
    } else if (this.depthSprite) {
      this.depthSprite.setFlash(0);
    } else if (this._modelMats) {
      for (const m of this._modelMats) m.emissiveIntensity = 0;
    } else if (this.mesh.material.emissiveIntensity) {
      this.mesh.material.emissiveIntensity = 0;
    }
    // 血条朝向相机
    if (this._hpBar && camera) this._hpBar.lookAt(camera.getWorldPosition(_camPos));

    // DepthSprite 显隐跟随主体（ghost 隐身机制需要：显形时才显示立绘）
    if (this.depthSprite) this.depthSprite.mesh.visible = this.mesh.visible;
  }

  // 各小怪专属行为（占位/盾兵以外的特殊逻辑）
  _updateBehavior(dt, target) {
    const t = this.type;
    // 宝箱怪：绕着玩家短跳（2秒一次）
    if (t.behavior === 'chest') {
      this._hopTimer += dt;
      if (this._hopTimer >= (t.hopInterval || 2)) {
        this._hopTimer = 0;
        const a = Math.random() * Math.PI * 2;
        const r = 1.5 + Math.random() * 2.0;
        this.mesh.position.x = THREE.MathUtils.clamp(target.x + Math.cos(a) * r, -6, 6);
        this.mesh.position.z = THREE.MathUtils.clamp(target.z + Math.sin(a) * r, -8, 8);
      }
    }
    // 忍者怪：生命周期状态机（全局统一，非龙Boss关专属）。
    // 出现(APPEAR秒) → 蓄力(CHARGE秒, 头顶显示蓄力光球) → 投掷(仅最近忍者) → 等待(BLINK_DELAY秒) → 闪现 → 回到蓄力。
    // 龙形 Boss 的组成忍者(isDragonPart)与受控忍者(controlled)跳过，由龙逐帧接管位置。
    if (t.behavior === 'ninja' && !this.isDragonPart && !this.controlled) {
      this._ninjaTimer += dt;
      const S = SHURIKEN;
      switch (this._ninjaPhase) {
        case 'appear':  // 出现期：仅存在，不蓄力/不投掷/不闪现
          if (this._ninjaTimer >= S.APPEAR) { this._ninjaPhase = 'charge'; this._ninjaTimer = 0; this._showChargeOrb(true, 0x66ccff); }
          break;
        case 'charge':  // 蓄力期：头顶光球渐大脉动；结束即投掷（仅最近忍者真正投出）
          this._updateChargeOrb(dt, this._ninjaTimer, S.CHARGE);
          if (this._ninjaTimer >= S.CHARGE) {
            this._throwProjectile('shuriken');   // 同种怪里只有最靠近玩家的一只真的投出
            this._showChargeOrb(false);
            this._ninjaPhase = 'post'; this._ninjaTimer = 0;
          }
          break;
        case 'post':    // 投掷后等待期：BLINK_DELAY 秒后开始闪现
          if (this._ninjaTimer >= S.BLINK_DELAY) { this._ninjaPhase = 'blink'; this._ninjaTimer = 0; }
          break;
        case 'blink':   // 闪现：瞬移到「朝向玩家、距中心 10~15m 环带内」随机点，然后回到蓄力
          {
            const ang = Math.atan2(target.z, target.x) + (Math.random() - 0.5) * 1.2;
            const r = S.RANGE_MIN + Math.random() * (S.RANGE_MAX - S.RANGE_MIN);
            this.mesh.position.x = Math.cos(ang) * r;
            this.mesh.position.z = Math.sin(ang) * r;
          }
          this._ninjaPhase = 'charge'; this._ninjaTimer = 0;
          break;
      }
    }
    // 幽灵怪：隐身 → 蓄力（显形 + 头顶紫色蓄力光球）→ 投鬼火 → 回到隐身
    //   发射方式与忍者完全一致：蓄力结束时投出，且只有最靠近玩家的那只幽灵真的投（见 _throwProjectile）
    if (t.behavior === 'ghost') {
      const cycle = t.ghostFireInterval || 3;
      const charge = Math.min(cycle, t.ghostFireCharge || 2);
      const inCharge = this._updateChargeCycle(dt, cycle, charge, 'ghostfire', PROJECTILE.GHOST_FIRE.COLOR);
      this.revealed = inCharge;
      this.mesh.visible = inCharge;
    }
    // 章鱼怪：边靠近玩家边蓄力 → 每 inkInterval 秒喷一团墨（inkDuration 秒蓄力，头顶深色蓄力光球）
    if (t.behavior === 'octopus') {
      const cycle = t.inkInterval || 3;
      const charge = Math.min(cycle, t.inkDuration || 1);
      this._updateChargeCycle(dt, cycle, charge, 'ink', PROJECTILE.INK.COLOR);
    }
    // 聚宝盆：无敌存活寿命，到点标记脚本化死亡
    if (t.behavior === 'treasure') {
      this._lifespan -= dt;
      if (this._lifespan <= 0) this._pendingKill = true;
    }
    // TODO: 龙头怪 cloud(造云隐身)/fireball(火球) 的特殊攻击后续补齐（幽灵鬼火/章鱼墨汁已于第三十五修补齐）
  }

  // 将水平位置夹紧到距中心(世界原点) RANGE_MIN~RANGE_MAX 的环带内（忍者活动范围约束）
  _clampToRing() {
    const min = SHURIKEN.RANGE_MIN, max = SHURIKEN.RANGE_MAX;
    const x = this.mesh.position.x, z = this.mesh.position.z;
    const d = Math.hypot(x, z);
    if (d < 1e-4) {                       // 落在正中心：随机推到环带内界
      const a = Math.random() * Math.PI * 2;
      this.mesh.position.x = Math.cos(a) * min;
      this.mesh.position.z = Math.sin(a) * min;
      return;
    }
    if (d < min) { const s = min / d; this.mesh.position.x *= s; this.mesh.position.z *= s; }
    else if (d > max) { const s = max / d; this.mesh.position.x *= s; this.mesh.position.z *= s; }
  }

  // 蓄力光球：场景级小球，悬于忍者头顶上方，蓄力时渐大脉动，直观表现「手里剑蓄力」。
  // 场景级（非 mesh 子节点）可避开父节点可见性（DepthSprite 模式主体不可见）影响。
  _showChargeOrb(on, color = 0x66ccff) {
    if (on) {
      if (!this._chargeOrb && this.manager) {
        const R = SHURIKEN.SIZE * 1.5;
        const g = new THREE.SphereGeometry(R, 12, 10);
        const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false });
        this._chargeOrb = new THREE.Mesh(g, m);
        this._chargeOrb.renderOrder = 998;
        this.manager.scene.add(this._chargeOrb);
      }
      if (this._chargeOrb) this._chargeOrb.visible = true;
    } else if (this._chargeOrb) {
      this._chargeOrb.visible = false;
    }
  }

  _updateChargeOrb(dt, elapsed, dur) {
    if (!this._chargeOrb || !this._chargeOrb.visible) return;
    const p = this.mesh.getWorldPosition(_orbTmp);
    const top = 1.2 * (this.mesh.scale.x || 1) + 0.3; // 头顶上方（按模型缩放）
    this._chargeOrb.position.set(p.x, p.y + top, p.z);
    const k = 0.4 + 0.6 * Math.min(1, elapsed / Math.max(0.001, dur));   // 随蓄力进度放大
    const pulse = 1 + 0.15 * Math.sin(elapsed * 18);                    // 脉动
    this._chargeOrb.scale.setScalar(k * pulse);
  }


  // 通用「蓄力 → 投掷」循环（幽灵鬼火 / 章鱼墨汁共用，第三十五修）。
  //   忍者不在这里：它还要闪现（appear→charge→post→blink），走自己的状态机，但共用下面的 _throwProjectile。
  //   返回「当前是否处于蓄力窗口」——幽灵据此决定显隐。
  _updateChargeCycle(dt, cycle, charge, kind, orbColor) {
    this._fireTimer += dt;
    if (this._fireTimer >= cycle) {
      this._fireTimer -= cycle;
      this._showChargeOrb(false);
      this._throwProjectile(kind);   // 只有最靠近玩家的同种怪真的投出（见 _throwProjectile）
      return false;
    }
    const inCharge = this._fireTimer >= cycle - charge;
    if (inCharge) {
      this._showChargeOrb(true, orbColor);
      this._updateChargeOrb(dt, this._fireTimer - (cycle - charge), charge);
    } else {
      this._showChargeOrb(false);
    }
    return inCharge;
  }

  // 统一投掷：出生点在怪头顶、射向玩家；带「最靠近玩家的同种怪才投」门禁。
  //   单发伤害以敌人自身配置为准（enemies.js 的 shurikenDamage / ghostFireDamage / inkDamage），
  //   未配置时回落到 constants 里该 kind 的 DAMAGE。
  _throwProjectile(kind) {
    const mgr = this.manager;
    if (!mgr || !mgr.projectiles) return false;
    if (!mgr.isNearestLauncher(this)) return false;
    const pp = mgr._playerPos;
    if (!pp) return false;
    // 鬼火/墨汁的单发伤害以敌人自身配置为准（enemies.js）；手里剑固定用 SHURIKEN.DAMAGE
    //   —— 保持第三十五修之前的手感，不因新增机制顺手改动忍者强度。
    const t = this.type;
    const dmg = kind === 'ghostfire' ? t.ghostFireDamage
              : kind === 'ink'       ? t.inkDamage
              : 0;
    const hy = this.mesh.position.y + 1.0 * (this.mesh.scale.x || 1) + 0.3; // 头顶高度（按模型缩放）
    mgr.projectiles.spawn(kind, new THREE.Vector3(this.mesh.position.x, hy, this.mesh.position.z), pp,
      dmg > 0 ? { damage: dmg } : null);
    return true;
  }
  dispose() {
    if (this._chargeOrb) {
      this.manager?.scene?.remove(this._chargeOrb);
      this._chargeOrb.geometry.dispose();
      this._chargeOrb.material.dispose();
      this._chargeOrb = null;
    }
    hideLoadDot(this);                                   // 光点（若还挂着）随气球一起释放材质
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    if (this.bodyModel) {
      this.mesh.remove(this.bodyModel);
      this.bodyModel.traverse((o) => {
        if (o.isMesh) {
          // GLB 克隆的几何体与 glbCache(_cache) 共享（userData.sharedGeo）：不能 dispose，
          // 否则同一模型（如三张脸谱）下次使用要重新上传显存 → 变脸瞬间卡顿。
          if (!o.userData.sharedGeo) o.geometry?.dispose?.();
          o.material?.dispose?.();
        }
      });
      this.bodyModel = null;
    }
    // 脸谱 Boss 装饰物（扇子/旗子）：随 balloon 一起释放
    if (this._decorations) {
      for (const d of this._decorations) {
        this.mesh.remove(d);
        d.traverse((o) => {
          if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
        });
      }
      this._decorations = null;
    }
    if (this.shieldPivot) {
      this.shieldPivot.traverse((o) => {
        if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
      });
      this.mesh.remove(this.shieldPivot);
      this.shieldPivot = null;
    }
    if (this.label) {
      this.mesh.remove(this.label);
      this.label.material.map?.dispose();
      this.label.material.dispose();
      this.label = null;
    }
    if (this.depthSprite) {
      this._dsScene?.remove(this.depthSprite.mesh);
      this.depthSprite.dispose();
      this.depthSprite = null;
    }
  }
}

/**
 * 第四十九修（返工）· 治疗目标选择（纯函数，有单测）：
 *   在「所有活着的怪（不含术士自己）」里挑 —— **血量百分比最低**的；
 *   并列时取**离玩家最近**的那只（同一只怪会连着被喂 ⇒ 玩家看得出"这怪在被奶"）。
 *   为什么按百分比而不是绝对血量：绝对血量会永远优先喂血厚的 Boss/精英，小怪被无视；
 *   按百分比才是"最需要奶的那只"。
 *   不看距离上限：术士站桩在 24m 外，前压的怪就在玩家身边，加半径反而会「够不着」。
 * @param {Balloon[]} list      全部气球
 * @param {Balloon}   healer    施法的治疗术士（不给自己回血）
 * @param {THREE.Vector3} [playerPos] 玩家世界坐标（拿不到时并列就按遍历顺序取第一只）
 * @param {object}    [opts]    { elitesOnly } = 只考虑精英怪（现场第三轮口径：只奶精英）
 * @returns {Balloon|null}
 */
export function pickHealTarget(list, healer, playerPos, opts = {}) {
  let best = null;
  let bestPct = Infinity;
  let bestD = Infinity;
  for (const o of list) {
    if (!o || o === healer || !o.alive) continue;
    if (opts.elitesOnly && !o.isElite) continue;
    const pct = o.hp / (o.maxHp > 0 ? o.maxHp : 1);
    const d = (playerPos && o.mesh) ? o.mesh.position.distanceToSquared(playerPos) : 0;
    const better = pct < bestPct - 1e-6 || (Math.abs(pct - bestPct) <= 1e-6 && d < bestD);
    if (better) { best = o; bestPct = pct; bestD = d; }
  }
  return best;
}

export class BalloonManager {
  constructor(scene) {
    this.scene = scene;
    this.list = [];
    this._sepVec = new THREE.Vector3();
    this.depthDebug = false; // DepthSprite 深度调试：按 D 切换（中心亮=凸、边缘亮=凹）
    this.projectiles = null; // 远程投射物管理器（由 game.js 注入）；非空时忍者/幽灵/章鱼才会投掷
    this._playerPos = null;  // 每帧玩家位置（update 注入），供「最近发射者」判定
    this._bombMarks = null;  // 「爆」标记 InstancedMesh（惰性创建，见 _updateBombMarks）
  }

  setProjectileManager(m) { this.projectiles = m; }

  // 最近发射者判定：在「所有 behavior 相同、非龙部件、非受控、存活」的怪里，返回距玩家最近者。
  // 保证「每次只有最靠近玩家的那一只发射」——忍者/幽灵/章鱼共用（第三十五修由 isNearestNinja 泛化）。
  // 注意是**按 behavior 分别**判定：幽灵的最近者不会拦住章鱼的最近者。
  isNearestLauncher(b) {
    if (!b || !b.alive || b.isDragonPart || b.controlled) return false;
    const pp = this._playerPos;
    if (!pp) return false;
    const beh = b.behavior;
    let best = b, bestD = b.mesh.position.distanceToSquared(pp);
    for (const o of this.list) {
      if (o === b || !o.alive || o.isDragonPart || o.controlled || o.behavior !== beh) continue;
      const d = o.mesh.position.distanceToSquared(pp);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best === b;
  }

  spawn(typeId, position, opts = null) {
    const b = new Balloon(typeId, opts);
    b.mesh.position.copy(position);
    b.manager = this;        // 供忍者反查管理器（最近判定 / 投掷）
    this.scene.add(b.mesh);
    this.list.push(b);
    return b;
  }

  remove(b) {
    const i = this.list.indexOf(b);
    if (i !== -1) this.list.splice(i, 1);
    this.scene.remove(b.mesh);
    b.dispose();
  }

  update(dt, target, camera, opts = {}) {
    this._playerPos = target;   // cache player pos for nearest-ninja check
    const freezeNormal = !!opts.freezeNormal;
    const freezeBoss   = !!opts.freezeBoss;
    for (const b of this.list) {
      const isBossBal = b.isBoss || b.isDragonPart;
      b._frozen = isBossBal ? freezeBoss : freezeNormal;
      if (b._frozen) continue;           // 冻结：跳过移动/行为，但仍可被击中/受击/死亡（由 game 层独立处理）
      b.update(dt, target, camera);
      if (b.depthSprite) b.depthSprite.material.uniforms.uDebugDepth.value = this.depthDebug ? 1 : 0;
    }
    this._applySeparation();
    this._updateBombMarks(camera, dt);   // 第五十六修：基础怪头顶「爆」标记（1 个 InstancedMesh；dt 供内圈闪烁）
    this._applyHealAura(dt);

  }

  // 治疗术士的施法（第四十九修返工：绿色脉冲环 → **投喂粉色加号**）
  //   现场反馈：① 绿环「看不到」；② 固定回 20 点血在几百血的怪身上根本看不出来。
  //   新口径：每 HEAL_LINK.PULSE_PERIOD 秒（=1s）
  //     ① 用纯函数 pickHealTarget 选一只目标（血最少，并列取离玩家最近）；
  //     ② 向 game 要本次治疗量（this.onHealCast 返回 = **玩家当前攻击力**）—— 改成随构筑成长，
  //        所以血条肉眼可见地在涨，现场不会再"看不出治疗效果"；
  //     ③ 命中给目标闪一下粉（flashHeal）；
  //     ④ 表现（粉色加号飞行）由 game 侧的 fx.HealPlusFx 负责，这里只管数值。
  //   性能：判定从「每帧 O(n²)」降到「每 PULSE_PERIOD 秒一次 O(n²)」，而且不再遍历算半径。
  //   PULSE=false 时退回第四十六修的旧口径（每帧按半径连续回血）。
  _applyHealAura(dt) {
    for (const h of this.list) {
      if (h.behavior !== 'heal' || !h.alive || h._frozen) continue; // 冻结中的治疗者暂停治疗
      if (HEAL_LINK.PULSE === false) {
        const hr = h.type.healRadius || 6;
        const ha = h.type.healAura || 10;
        for (const o of this.list) {
          if (o === h || !o.alive) continue;
          if (o.mesh.position.distanceTo(h.mesh.position) <= hr) {
            o.hp = Math.min(o.maxHp, o.hp + ha * dt);
            if (o.refreshHealthBar) o.refreshHealthBar();   // 第五十一修：回血必须刷血条
          }
        }
        continue;
      }
      const period = Math.max(0.1, HEAL_LINK.PULSE_PERIOD || 1);
      // 刚落地（_healT 还没初始化）就先来一发：玩家一眼就知道「这只在奶人」
      h._healT = h._healT == null ? period : h._healT + dt;
      if (h._healT < period) continue;
      h._healT -= period;
      const t = pickHealTarget(this.list, h, this._playerPos, { elitesOnly: HEAL_LINK.ELITE_ONLY !== false });
      if (!t) continue;
      // 治疗量：优先用 game 的计算（默认 = PULSE_HEAL 1000）；没有回调时退回固定值。
      //   ⚠ 这里读的是 **BalloonManager 自己**的 onHealCast（waves.balloons）—— game 侧必须挂在这一层，
      //     挂到 WaveManager 上等于没挂（第三轮现场「完全没作用」的根因）。
      let heal = 0;
      if (this.onHealCast) {
        heal = Number(this.onHealCast(h, t)) || 0;
      } else if (HEAL_LINK.PULSE_HEAL > 0) {
        heal = HEAL_LINK.PULSE_HEAL;
      }
      if (heal > 0) {
        // 超出上限的部分不算（现场口径）
        t.hp = Math.min(t.maxHp, t.hp + heal);
        if (t.refreshHealthBar) t.refreshHealthBar();   // 第五十一修：回血必须刷血条（现场「血条没涨」的根因）
        if (HEAL_LINK.PLUS_FLASH !== false && t.flashHeal) t.flashHeal();
      }
      if (this.onHealPulse) this.onHealPulse(h.mesh.position, HEAL_LINK.RADIUS);
    }
  }

  // 气球间分离力：O(n²) 两两检查，最多几十个，性能无忧
  _applySeparation() {
    const GAP = 0.2;
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.controlled || a._frozen) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.controlled || b._frozen) continue;
        this._sepVec.subVectors(a.mesh.position, b.mesh.position);
        this._sepVec.y = 0;
        const dist = this._sepVec.length();
        const minDist = a.effectiveRadius + b.effectiveRadius + GAP;
        if (dist < minDist) {
          if (dist > 0.001) {
            this._sepVec.normalize();
            const overlap = (minDist - dist) * 0.5;
            a.mesh.position.addScaledVector(this._sepVec, overlap);
            b.mesh.position.addScaledVector(this._sepVec, -overlap);
          } else {
            const angle = Math.random() * Math.PI * 2;
            this._sepVec.set(Math.cos(angle), 0, Math.sin(angle));
            const push = minDist * 0.5;
            a.mesh.position.addScaledVector(this._sepVec, push);
            b.mesh.position.addScaledVector(this._sepVec, -push);
          }
        }
      }
    }
  }

  // 「爆」标记（第五十六修）：把所有基础怪头顶的「爆」字写进一个 InstancedMesh。
  //   容量 BOMB_LABEL.MAX；超出时只画前 MAX 只（正常同屏杂鱼远小于此值）。
  _updateBombMarks(camera, dt = 0) {
    const S = BOMB_LABEL;
    if (!S.ENABLED) { if (this._bombMarks) this._bombMarks.visible = false; return; }
    if (!this._bombMarks) {
      const geo = new THREE.PlaneGeometry(1, 1);
      const mat = new THREE.MeshBasicMaterial({
        map: _bombLabelTexture(), transparent: true,
        // 第五十七修（现场）：depthTest=true → 被**前面的怪**挡住。旧口径 false 会「糊在它前方的怪身上」。
        depthTest: !!S.DEPTH_TEST, depthWrite: false,
        side: THREE.DoubleSide, toneMapped: false, fog: false,
      });
      const m = new THREE.InstancedMesh(geo, mat, Math.max(1, S.MAX | 0));
      m.name = 'bomb-marks';
      m.frustumCulled = false;   // 实例位置每帧变，交给 GPU 前先关掉包围球剔除
      m.renderOrder = S.DEPTH_TEST ? (S.RENDER_ORDER || 0) : 998;   // 第五十七修：参与深度测试后不再抢最上层
      m.count = 0;
      this._bombMarks = m;
      // 第五十七修：先把整池刷成常态色 —— 提前建好 instanceColor（否则首次闪烁才上传整块缓冲）
      _bombCol.setHex(_bombColNormal);
      for (let k = 0; k < m.instanceMatrix.count; k++) m.setColorAt(k, _bombCol);
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      this.scene.add(m);
    }
    this._bombT = (this._bombT || 0) + dt;   // 第五十七修：闪烁用的内部时钟（秒）
    const inst = this._bombMarks;
    inst.visible = true;
    if (!camera) { inst.count = 0; return; }
    camera.getWorldQuaternion(_bombQuat);
    _bombScale.set(S.SIZE, S.SIZE, 1);
    let n = 0;
    for (const b of this.list) {
      if (n >= inst.instanceMatrix.count) break;
      if (!isBombMarkTarget(b) || !b.mesh.visible) continue;
      const r = b.effectiveRadius || b.radius || 0.3;
      _bombPos.set(b.mesh.position.x, b.mesh.position.y + r * 2.6 + (S.Y_PAD || 0), b.mesh.position.z);
      _bombM4.compose(_bombPos, _bombQuat, _bombScale);
      inst.setMatrixAt(n, _bombM4);
      inst.setColorAt(n, _bombCol.setHex(bombMarkColor(b, this._bombT || 0)));   // 第五十七修：内圈闪红
      n++;
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  }

  clear() {
    for (let i = this.list.length - 1; i >= 0; i--) this.remove(this.list[i]);
  }

  get count() { return this.list.length; }
}
