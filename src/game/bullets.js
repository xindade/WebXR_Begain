import * as THREE from 'three';
import { SHOOT, RAPID_FIRE, SHOP, BUDDHA } from '../core/constants.js';

// 第五十五修（商店道具）复用的临时向量：追踪弹转向用，避免每帧 new
const _toTgt = new THREE.Vector3();
const _curDir = new THREE.Vector3();

// 第八十四修 · 掌风弹贴图：专用小图，白色蒙版 + alphaTest，实例色负责染金/染蓝。
// 只在浏览器生成一次；Node 测试环境没有 document 时退化为无贴图面片（不参与渲染断言）。
let _palmBulletTex;
function _roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function _getPalmBulletTexture() {
  if (_palmBulletTex !== undefined) return _palmBulletTex;
  if (typeof document === 'undefined') { _palmBulletTex = null; return null; }
  const cfg = BUDDHA.PALM_WIND || {};
  const W = Math.max(32, cfg.TEX_W | 0 || 128);
  const H = Math.max(48, cfg.TEX_H | 0 || 192);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  if (!c) { _palmBulletTex = null; return null; }
  const s = W / 128;
  c.clearRect(0, 0, W, H);
  c.fillStyle = '#ffffff';

  // 掌身 + 腕部
  _roundRectPath(c, 30 * s, 62 * s, 68 * s, 104 * s, 18 * s); c.fill();
  _roundRectPath(c, 44 * s, 150 * s, 40 * s, 34 * s, 12 * s); c.fill();

  // 四根手指
  for (const [x, y, w, h] of [[34, 22, 15, 62], [52, 12, 15, 72], [70, 18, 15, 66], [88, 34, 15, 50]]) {
    _roundRectPath(c, x * s, y * s, w * s, h * s, 7 * s); c.fill();
  }

  // 拇指（向左下斜出）
  c.save();
  c.translate(31 * s, 104 * s);
  c.rotate(-0.58);
  _roundRectPath(c, -8 * s, -28 * s, 16 * s, 56 * s, 8 * s); c.fill();
  c.restore();

  // 掌纹：只做细镂空，远景仍读成一个明确的掌形
  c.globalCompositeOperation = 'destination-out';
  c.strokeStyle = '#000000';
  c.lineCap = 'round';
  c.lineWidth = 1.8 * s;
  c.beginPath();
  c.moveTo(45 * s, 100 * s); c.quadraticCurveTo(61 * s, 120 * s, 51 * s, 151 * s);
  c.moveTo(66 * s, 91 * s); c.quadraticCurveTo(70 * s, 122 * s, 66 * s, 157 * s);
  c.moveTo(88 * s, 102 * s); c.quadraticCurveTo(79 * s, 124 * s, 88 * s, 151 * s);
  c.stroke();
  c.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  _palmBulletTex = tex;
  return tex;
}

// 子弹系统：InstancedMesh 单 Draw Call 渲染所有子弹，支持大数量（割草）
// 子弹对象只存逻辑数据（pos/vel/life/dmg），不再持有独立 Mesh，
// 渲染由 _instanced 实例矩阵统一管理 —— 无论多少颗子弹都只有 1 次 Draw Call。
export class BulletManager {
  constructor(scene, camera = null) {
    this.scene = scene;
    this._camera = camera;
    this.active = [];
    this._pool = [];
    this.capacity = SHOOT.BULLET_POOL_SIZE;
    this.defaultTint = null;   // 角色默认弹色（瘟疫医生绿色；特殊弹的 opts.tint 优先）

    // 共享几何体 + 廉价材质（发光小球不需要 PBR 光照，MeshBasicMaterial 不吃光照计算）
    const geo = new THREE.SphereGeometry(SHOOT.BULLET_RADIUS, 8, 8);
    // 基色必须是白：实例色（setColorAt）是**乘**在材质色上的，材质非白会把加速蓝乘脏。
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this._instanced = new THREE.InstancedMesh(geo, mat, this.capacity);
    this._instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // 每帧更新
    this._instanced.frustumCulled = false;  // 单实例包围盒不准，关闭裁剪避免整体消失
    this._instanced.count = 0;
    scene.add(this._instanced);

    // 第八十四修：掌风弹单独一个 InstancedMesh（最多 +1 Draw Call）。
    // 2 个三角形的面片 + 128×192 alphaTest 小图，避免每颗子弹建 Mesh。
    const pw = BUDDHA.PALM_WIND || {};
    const palmGeo = new THREE.PlaneGeometry(pw.BULLET_W || 0.16, pw.BULLET_H || 0.24);
    const palmMap = _getPalmBulletTexture();
    const palmMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: palmMap,
      alphaTest: palmMap ? (pw.ALPHA_TEST ?? 0.35) : 0,
      transparent: false,
      side: THREE.DoubleSide,
      depthWrite: true,
    });
    this._palmInstanced = new THREE.InstancedMesh(palmGeo, palmMat, this.capacity);
    this._palmInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._palmInstanced.frustumCulled = false;
    this._palmInstanced.count = 0;
    scene.add(this._palmInstanced);

    this._m = new THREE.Matrix4();

    // 第四十九修：加速弹变蓝 —— 用实例色区分「加速期打出的子弹」，不额外增加 Draw Call。
    //   这里先把整池刷成默认色，目的是**提前创建 instanceColor 缓冲**：
    //   否则第一次加速时才 setColorAt 会现场上传一整块缓冲，正是要避免的卡顿点。
    this._col = new THREE.Color();
    for (let i = 0; i < this.capacity; i++) {
      this._instanced.setColorAt(i, this._col.setHex(SHOOT.BULLET_COLOR));
      this._palmInstanced.setColorAt(i, this._col.setHex(pw.TINT != null ? pw.TINT : 0xffd76a));
    }
    if (this._instanced.instanceColor) this._instanced.instanceColor.needsUpdate = true;
    if (this._palmInstanced.instanceColor) this._palmInstanced.instanceColor.needsUpdate = true;
    this._palmQ = new THREE.Quaternion();
    this._palmScale = new THREE.Vector3(1, 1, 1);
  }

  _obtain() {
    let b = this._pool.pop();
    if (!b) {
      b = { pos: new THREE.Vector3(), prevPos: new THREE.Vector3(), origin: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, dmg: 0, alive: false, boost: false, tint: null, homing: null, pierce: 0, _hitUids: null, scale: 1, trailMul: 1, palm: false, speed: SHOOT.BULLET_SPEED, blastRadius: 0, blastEdge: 0, rocket: false, airburst: 0 };
    }
    b.alive = true;
    this.active.push(b);
    return b;
  }

  /** 角色默认弹色：普通弹使用；追踪/穿甲等显式 opts.tint 仍优先。 */
  setDefaultTint(tint) {
    this.defaultTint = (tint != null && Number.isFinite(Number(tint))) ? Number(tint) : null;
  }

  // opts：{ tint, homing, pierce, scale, trailMul, palm, dmgMul, speed, blastRadius, blastEdge, rocket, airburst }
  //   palm=true → 走掌风弹 InstancedMesh；dmgMul 在生成时乘到伤害上。
  spawn(position, direction, dmg, boost = false, opts = null) {
    // 池/容量耗尽则复用最旧的（保证 active 不超过 capacity，实例矩阵不越界）
    if (this.active.length >= this.capacity + this._pool.length) {
      this.release(this.active[0]);
    }
    const b = this._obtain();
    b.pos.copy(position);
    b.origin.copy(position);  // 出生点（第四十二修）：曳光尾迹的「后拖上限」，见 game._updateFx
    b.prevPos.copy(position); // 本帧线段起点 = 出生点（首帧线段退化为点，不误判）
    b.speed = (opts && Number.isFinite(opts.speed) && opts.speed > 0) ? opts.speed : SHOOT.BULLET_SPEED;
    b.vel.copy(direction).normalize().multiplyScalar(b.speed);
    b.life = SHOOT.BULLET_LIFE;
    b.dmg = dmg * (opts && Number.isFinite(opts.dmgMul) ? opts.dmgMul : 1);
    b.boost = !!boost;  // 加速期打出的子弹（第四十九修）：变蓝 + 曳光加长，见 game._updateFx
    b.palm = !!(opts && opts.palm);                           // 第八十四修：掌风弹
    // 弹色优先级：显式覆盖（追踪紫 / 穿甲红）> 角色默认色 > 无（普通黄/加速蓝/掌风金）
    b.tint = (opts && opts.tint != null) ? opts.tint
      : (b.palm ? null : this.defaultTint);
    b.homing = (opts && opts.homing) || null;                  // 追踪目标（气球对象；目标死亡自动直飞）
    b.pierce = (opts && opts.pierce) || 0;                     // 还能穿透几个敌人（0 = 命中即回收）
    b._hitUids = null;                                        // 穿甲弹：已命中的气球 uid 集合（防同一发反复结算）
    b.scale = (opts && opts.scale) || 1;                       // 第五十六修：弹体体积倍率（1 = 默认半径）
    b.trailMul = (opts && opts.trailMul) || 1;                 // 第五十六修：曳光长度倍率（>1 = 拖更长）
    b.blastRadius = (opts && opts.blastRadius) || 0;           // 第八十五修：爆炮手 AoE 半径（米，0 = 普通弹）
    b.blastEdge = (opts && Number.isFinite(opts.blastEdge)) ? opts.blastEdge : 0; // 边缘保留比例（0=线性到 0）
    b.rocket = !!(opts && opts.rocket);                        // 火箭：命中时结算爆炸，不走普通直伤
    b.airburst = (opts && Number.isFinite(opts.airburst) && opts.airburst > 0) ? opts.airburst : 0; // 第八十八修：飞满该距离仍无命中 → 自动空爆
  }

  release(b) {
    const i = this.active.indexOf(b);
    if (i === -1) return;
    const last = this.active.length - 1;
    if (i !== last) this.active[i] = this.active[last]; // swap-pop：O(1) 替代 splice O(n)
    this.active.pop();
    b.alive = false;
    this._pool.push(b);
  }

  // 将 active 中所有子弹位置写入 InstancedMesh 实例矩阵（碰撞/生成后调用）
  sync() {
    if (this._camera && typeof this._camera.getWorldQuaternion === 'function') {
      this._camera.getWorldQuaternion(this._palmQ);
    } else {
      this._palmQ.identity();
    }
    let ni = 0, pi = 0;
    for (let i = 0; i < this.active.length; i++) {
      const b = this.active[i];
      const col = this._col.setHex(b.tint != null ? b.tint
        : (b.boost ? RAPID_FIRE.VISUAL.BULLET_COLOR
          : (b.palm ? ((BUDDHA.PALM_WIND && BUDDHA.PALM_WIND.TINT) || 0xffd76a) : SHOOT.BULLET_COLOR)));
      if (b.palm) {
        this._palmScale.set(b.scale || 1, b.scale || 1, b.scale || 1);
        this._m.compose(b.pos, this._palmQ, this._palmScale);
        this._palmInstanced.setMatrixAt(pi, this._m);
        this._palmInstanced.setColorAt(pi, col);
        pi++;
      } else {
        if (b.scale && b.scale !== 1) this._m.makeScale(b.scale, b.scale, b.scale).setPosition(b.pos); else this._m.identity().setPosition(b.pos);
        this._instanced.setMatrixAt(ni, this._m);
        this._instanced.setColorAt(ni, col);
        ni++;
      }
    }
    this._instanced.count = ni;
    this._palmInstanced.count = pi;
    this._instanced.instanceMatrix.needsUpdate = true;
    this._palmInstanced.instanceMatrix.needsUpdate = true;
    if (this._instanced.instanceColor) this._instanced.instanceColor.needsUpdate = true;
    if (this._palmInstanced.instanceColor) this._palmInstanced.instanceColor.needsUpdate = true;
  }

  update(dt, homingFn = null) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const b = this.active[i];
      b.prevPos.copy(b.pos); // 线段判定起点 = 上一帧位置
      if (b.homing && homingFn) {             // 第五十五修：追踪弹每帧最多转 HOMING_TURN×dt 弧度
        const tgt = homingFn(b);
        if (tgt) this._steer(b, tgt, dt);
      }
      b.pos.addScaledVector(b.vel, dt);
      b.life -= dt;
      if (b.life <= 0) this.release(b);
    }
    this.sync();
  }

  // 追踪弹转向：弯得动但不会瞬间掉头（角速度上限 = SHOP.HOMING_TURN 弧度/秒）
  _steer(b, target, dt) {
    _toTgt.copy(target).sub(b.pos);
    if (_toTgt.lengthSq() < 1e-6) return;
    _toTgt.normalize();
    _curDir.copy(b.vel).normalize();
    const ang = _curDir.angleTo(_toTgt);
    if (ang < 1e-4) return;
    const maxTurn = SHOP.HOMING_TURN * dt;
    if (ang <= maxTurn) _curDir.copy(_toTgt);
    else _curDir.lerp(_toTgt, maxTurn / ang).normalize();
    b.vel.copy(_curDir).multiplyScalar(b.speed || SHOOT.BULLET_SPEED);
  }

  clear() {
    while (this.active.length > 0) this.release(this.active[this.active.length - 1]);
    this.sync();
  }
}
