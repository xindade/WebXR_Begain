import * as THREE from 'three';
import { SHURIKEN, PROJECTILE } from '../core/constants.js';

// ============================================================
// 远程投射物（第三十五修）
//   三种投射物共用同一套「出生 → 飞行 → 命中玩家 → 回收」通道：
//     · shuriken  手里剑（忍者怪）：低多边形 4 角星，绕飞行方向自旋
//     · ghostfire 鬼火（幽灵怪）  ：紫色发光核心 + 加色光晕
//     · ink       墨汁（章鱼怪）  ：近黑色墨团，翻滚
//
//   分工：「谁发射 / 什么时候发射」由 balloons.js 的怪行为决定
//     （忍者 = 出现→蓄力→投掷→闪现；幽灵/章鱼 = 隐身/靠近→蓄力→投掷→循环），
//     且遵循「同种怪里只有最靠近玩家的那一只真正投出」（balloons.isNearestLauncher）。
//   本模块只负责单发的几何 / 飞行 / 命中判定 / 回收，命中时回调 (伤害, 类型)。
//
//   ⚠ 数值来自 constants.js：手里剑 → SHURIKEN，鬼火/墨汁 → PROJECTILE.GHOST_FIRE / .INK。
//     两者在 userConfig.js 里都有同名块 → 改那边刷新即生效，不用动本文件。
//   ⚠ 单发伤害优先级：调用方传入的 opts.damage（= enemies.js 的 ghostFireDamage /
//     inkDamage / shurikenDamage）> constants 里的 DAMAGE。
// ============================================================

// 共享几何：模块级只建一次，所有实例复用（避免每发 new 几何的 GC 压力）。
function _buildShurikenGeometry() {
  const R = SHURIKEN.SIZE;     // 外接半径(米)
  const r = R * 0.40;          // 内凹半径(米)：尖角之间的凹口
  const shape = new THREE.Shape();
  const n = 4;                 // 4 角星
  for (let i = 0; i < n * 2; i++) {
    // 偏移 π/n 使一个尖角正朝上(+Y 投影平面)，视觉对称
    const ang = (i / (n * 2)) * Math.PI * 2 + Math.PI / n;
    const rad = (i % 2 === 0) ? R : r;
    const x = Math.cos(ang) * rad;
    const y = Math.sin(ang) * rad;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  // 中心圆孔（减重感，更像真掷星）
  const hole = new THREE.Path();
  hole.absarc(0, 0, R * 0.16, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: R * 0.22, bevelEnabled: true,
    bevelThickness: R * 0.04, bevelSize: R * 0.04, bevelSegments: 1, steps: 1,
  });
  geo.center(); // 居中：旋转轴落在几何中心，自旋才自然
  return geo;
}

// 单位几何（半径 1）：靠 mesh.scale 缩到各 kind 的 SIZE，避免每发新建几何
const _unitSphere = new THREE.SphereGeometry(1, 14, 10);   // 鬼火核心 / 光晕
const _unitBlob   = new THREE.IcosahedronGeometry(1, 0);   // 墨团（低多边形 + flatShading 出棱面感）

// 共享材质：低多边形金属感（flatShading），略带自发光以便在暗场景可见
const _shurikenMat = new THREE.MeshStandardMaterial({
  color: 0x9aa3ad, metalness: 0.9, roughness: 0.35,
  emissive: 0x223344, emissiveIntensity: 0.25, flatShading: true,
});
// 鬼火核心：自发光球（Basic 材质不吃光照 → 暗场里也清晰），不写深度避免挡光晕
const _ghostCoreMat = new THREE.MeshBasicMaterial({
  color: PROJECTILE.GHOST_FIRE.COLOR, transparent: true, opacity: 0.95, depthWrite: false,
});
// 墨汁：近黑 + 一定粗糙度，靠高光和轮廓在夜空里仍能看出飞行轨迹
const _inkMat = new THREE.MeshStandardMaterial({
  color: PROJECTILE.INK.COLOR, metalness: 0.15, roughness: 0.35, flatShading: true,
});
let _haloMat = null;   // 鬼火光晕（懒建：GLOW 为空时不建）

function _getHaloMat() {
  if (_haloMat) return _haloMat;
  _haloMat = new THREE.MeshBasicMaterial({
    color: PROJECTILE.GHOST_FIRE.GLOW, transparent: true, opacity: 0.32,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  return _haloMat;
}

// kind → 数值表（constants 里的对象；userConfig 已在 constants 里合并完成）
const _SPEC = {
  shuriken:  SHURIKEN,
  ghostfire: PROJECTILE.GHOST_FIRE,
  ink:       PROJECTILE.INK,
};

export class ProjectileManager {
  constructor(scene) {
    this.scene = scene;
    this.list = [];          // 飞行中的投射物实例
    this._onHit = null;      // 命中回调：(伤害, kind) => void
    this._audio = null;      // 音效管理器（注入）
    this._shurikenGeo = _buildShurikenGeometry();
    this._dir = new THREE.Vector3(); // 复用临时量
  }

  setOnHit(fn) { this._onHit = fn; }
  setAudio(a) { this._audio = a; }

  /** 该 kind 的数值表（未知 kind 按手里剑处理；供测试与「命中着色」查色用） */
  static specOf(kind) { return _SPEC[kind] || _SPEC.shuriken; }

  /** 命中后要染的「视野周边色」；null = 不触发着色（如手里剑） */
  tintOf(kind) {
    const t = ProjectileManager.specOf(kind).TINT;
    return t == null ? null : t;
  }

  /**
   * 发射一发。
   * @param {string} kind        'shuriken' | 'ghostfire' | 'ink'
   * @param {THREE.Vector3} originPos 出生点（调用方已算到怪头顶）
   * @param {THREE.Vector3} targetPos 目标点（玩家世界坐标，多为头部/rig 位置）
   * @param {object|null} opts   { damage } 覆盖单发伤害（不传则用 constants 的 DAMAGE）
   */
  spawn(kind, originPos, targetPos, opts = null) {
    const sp = ProjectileManager.specOf(kind);
    const mesh = this._makeMesh(kind, sp);
    mesh.position.copy(originPos); // 出生点由调用方决定（怪头顶）
    mesh.lookAt(targetPos.x, targetPos.y, targetPos.z); // 面朝飞行方向
    const dir = this._dir.copy(targetPos).sub(mesh.position);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    const dmg = (opts && opts.damage > 0) ? opts.damage : sp.DAMAGE;
    this.scene.add(mesh);
    this.list.push({ kind, spec: sp, mesh, dmg, vel: dir.multiplyScalar(sp.SPEED), life: sp.MAX_LIFE });
    if (this._audio && this._audio.playShurikenThrow) this._audio.playShurikenThrow();
  }

  update(dt, playerPos) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.mesh.position.addScaledVector(p.vel, dt);
      if (p.spec.SPIN) {
        // 手里剑绕面法线(飞行方向)自旋；球状投射物改为翻滚（自旋轴换到 X/Y 才有「滚」的观感）
        const w = THREE.MathUtils.degToRad(p.spec.SPIN) * dt;
        if (p.kind === 'shuriken') p.mesh.rotateZ(w);
        else { p.mesh.rotateX(w); p.mesh.rotateY(w * 0.7); }
      }
      p.life -= dt;
      const hit = playerPos ? p.mesh.position.distanceTo(playerPos) <= p.spec.HIT_RADIUS : false;
      if (hit) {
        if (this._onHit) this._onHit(p.dmg, p.kind); // 扣飞船血量 + 触发视野着色（由 game 接线）
        if (this._audio && this._audio.playShurikenHit) this._audio.playShurikenHit();
        this._removeAt(i);
      } else if (p.life <= 0) {
        this._removeAt(i); // 超时未命中自动回收
      }
    }
  }

  // 视觉：按 kind 组装（几何/材质均为模块级共享，实例只持有 scale）
  _makeMesh(kind, sp) {
    if (kind === 'shuriken') return new THREE.Mesh(this._shurikenGeo, _shurikenMat);
    if (kind === 'ghostfire') {
      const core = new THREE.Mesh(_unitSphere, _ghostCoreMat);
      core.scale.setScalar(sp.SIZE);
      if (sp.GLOW != null) {
        const halo = new THREE.Mesh(_unitSphere, _getHaloMat());
        halo.scale.setScalar(1.9);   // 相对核心的倍数（核心已按 SIZE 缩放，子节点继承）
        core.add(halo);
      }
      return core;
    }
    const blob = new THREE.Mesh(_unitBlob, _inkMat);
    blob.scale.setScalar(sp.SIZE);
    return blob;
  }

  _removeAt(i) {
    const p = this.list[i];
    this.scene.remove(p.mesh);
    // 几何/材质为模块级共享，不 dispose
    this.list.splice(i, 1);
  }

  clear() {
    for (let i = this.list.length - 1; i >= 0; i--) this.scene.remove(this.list[i].mesh);
    this.list.length = 0;
  }

  get count() { return this.list.length; }
}