import * as THREE from 'three';
import { SHOOT, RAPID_FIRE, SHOP } from '../core/constants.js';

// 第五十五修（商店道具）复用的临时向量：追踪弹转向用，避免每帧 new
const _toTgt = new THREE.Vector3();
const _curDir = new THREE.Vector3();

// 子弹系统：InstancedMesh 单 Draw Call 渲染所有子弹，支持大数量（割草）
// 子弹对象只存逻辑数据（pos/vel/life/dmg），不再持有独立 Mesh，
// 渲染由 _instanced 实例矩阵统一管理 —— 无论多少颗子弹都只有 1 次 Draw Call。
export class BulletManager {
  constructor(scene) {
    this.scene = scene;
    this.active = [];
    this._pool = [];
    this.capacity = SHOOT.BULLET_POOL_SIZE;

    // 共享几何体 + 廉价材质（发光小球不需要 PBR 光照，MeshBasicMaterial 不吃光照计算）
    const geo = new THREE.SphereGeometry(SHOOT.BULLET_RADIUS, 8, 8);
    // 基色必须是白：实例色（setColorAt）是**乘**在材质色上的，材质非白会把加速蓝乘脏。
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this._instanced = new THREE.InstancedMesh(geo, mat, this.capacity);
    this._instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // 每帧更新
    this._instanced.frustumCulled = false;  // 单实例包围盒不准，关闭裁剪避免整体消失
    this._instanced.count = 0;
    scene.add(this._instanced);

    this._m = new THREE.Matrix4();

    // 第四十九修：加速弹变蓝 —— 用实例色区分「加速期打出的子弹」，不额外增加 Draw Call。
    //   这里先把整池刷成默认色，目的是**提前创建 instanceColor 缓冲**：
    //   否则第一次加速时才 setColorAt 会现场上传一整块缓冲，正是要避免的卡顿点。
    this._col = new THREE.Color();
    for (let i = 0; i < this.capacity; i++) this._instanced.setColorAt(i, this._col.setHex(SHOOT.BULLET_COLOR));
    if (this._instanced.instanceColor) this._instanced.instanceColor.needsUpdate = true;
  }

  _obtain() {
    let b = this._pool.pop();
    if (!b) {
      b = { pos: new THREE.Vector3(), prevPos: new THREE.Vector3(), origin: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, dmg: 0, alive: false, boost: false, tint: null, homing: null, pierce: 0, _hitUids: null, scale: 1, trailMul: 1 };
    }
    b.alive = true;
    this.active.push(b);
    return b;
  }

  // opts（第五十五修，商店道具）：{ tint: 弹色覆盖, homing: 追踪目标气球, pierce: 可穿透敌人数 }
  spawn(position, direction, dmg, boost = false, opts = null) {
    // 池/容量耗尽则复用最旧的（保证 active 不超过 capacity，实例矩阵不越界）
    if (this.active.length >= this.capacity + this._pool.length) {
      this.release(this.active[0]);
    }
    const b = this._obtain();
    b.pos.copy(position);
    b.origin.copy(position);  // 出生点（第四十二修）：曳光尾迹的「后拖上限」，见 game._updateFx
    b.prevPos.copy(position); // 本帧线段起点 = 出生点（首帧线段退化为点，不误判）
    b.vel.copy(direction).normalize().multiplyScalar(SHOOT.BULLET_SPEED);
    b.life = SHOOT.BULLET_LIFE;
    b.dmg = dmg;
    b.boost = !!boost;  // 加速期打出的子弹（第四十九修）：变蓝 + 曳光加长，见 game._updateFx
    b.tint = (opts && opts.tint != null) ? opts.tint : null;   // 弹色覆盖（追踪弹紫 / 穿甲弹红）
    b.homing = (opts && opts.homing) || null;                  // 追踪目标（气球对象；目标死亡自动直飞）
    b.pierce = (opts && opts.pierce) || 0;                     // 还能穿透几个敌人（0 = 命中即回收）
    b._hitUids = null;                                        // 穿甲弹：已命中的气球 uid 集合（防同一发反复结算）
    b.scale = (opts && opts.scale) || 1;                       // 第五十六修：弹体体积倍率（1 = 默认半径）
    b.trailMul = (opts && opts.trailMul) || 1;                 // 第五十六修：曳光长度倍率（>1 = 拖更长）
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
    for (let i = 0; i < this.active.length; i++) {
      const b = this.active[i];
      if (b.scale && b.scale !== 1) this._m.makeScale(b.scale, b.scale, b.scale).setPosition(b.pos); else this._m.identity().setPosition(b.pos);
      this._instanced.setMatrixAt(i, this._m);
      // 第五十五修：tint（追踪弹/穿甲弹）优先，其次加速期蓝，最后默认色；都乘在白色材质上
      this._instanced.setColorAt(i, this._col.setHex(b.tint != null ? b.tint : (b.boost ? RAPID_FIRE.VISUAL.BULLET_COLOR : SHOOT.BULLET_COLOR)));
    }
    this._instanced.count = this.active.length;
    this._instanced.instanceMatrix.needsUpdate = true;
    if (this._instanced.instanceColor) this._instanced.instanceColor.needsUpdate = true;
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
    b.vel.copy(_curDir).multiplyScalar(SHOOT.BULLET_SPEED);
  }

  clear() {
    while (this.active.length > 0) this.release(this.active[this.active.length - 1]);
    this.sync();
  }
}
