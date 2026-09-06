// 第18关魔术师Boss · 激光阶段
// 视觉完全复用第三关「激光气球」：双锥体(八面体)气球 + 三层激光束(核心/辉光/光晕)，
// 气球几何与缩放(GROUP_SCALE=0.25)均与 laser.js 一致 → 与第三关"一模一样"。
// 运动（按用户实测规格）：
//   ① 1s 内垂直上升 4m（y:0→4）；
//   ② 接着 1s 激光气球下端向下延伸 4m 激光（beam 子组 scale.y 0→1）；
//   ③ 两气球带激光从各自起点向 X=0 运动，间距 < CLOSE_DIST 时反向外扩，
//      到外边界 |x|=OSC_OUTER 再回中心，一来一回往复 OSC_TIME 秒；之后保持到阶段结束 dispose。
//   玩家处于竖直光束内（|x-bx|<HIT_HALF_WIDTH 且 y∈[球底-激光长, 球底]）受 DAMAGE*dt 伤害。
// 由 bossMagician.js 在「激光阶段」实例化，阶段结束 dispose 消失。
import * as THREE from 'three';
import { MAGICIAN_BOSS } from '../core/constants.js';
import { balloonGeo, GROUP_SCALE, LASER_LEN } from './laser.js';

// 第三关三层激光束配色（核心/辉光/光晕），与 laser.js createGroup 完全一致
const BEAM_LAYERS = [
  { r: 0.012, key: 'core', color: 0xff3300, op: 1.0,    blend: THREE.NormalBlending },
  { r: 0.05,  key: 'glow', color: 0xff5500, op: 0.3,    blend: THREE.AdditiveBlending },
  { r: 0.14,  key: 'halo', color: 0xff7700, op: 0.08,   blend: THREE.AdditiveBlending },
];

// 构建一个「与第三关完全相同」的激光气球：双锥体 + 三层光束（光束作为独立子组 beam，可缩放做延伸动画）
function createBossLaserBalloon(color) {
  const group = new THREE.Group();

  // —— 双锥体气球（半透明发光玻璃感，与第三关一致）——
  const mat = new THREE.MeshStandardMaterial({
    color, metalness: 0.0, roughness: 0.25,
    transparent: true, opacity: 0.85, depthWrite: false,
    side: THREE.DoubleSide, emissive: color, emissiveIntensity: 0.15,
  });
  const balloonMesh = new THREE.Mesh(balloonGeo, mat);
  group.add(balloonMesh);
  balloonMesh.add(new THREE.LineSegments(
    new THREE.WireframeGeometry(balloonGeo),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 })
  ));

  // —— 三层激光束（独立子组，指向下方 -Y，顶端贴气球底部）——
  const beam = new THREE.Group();
  const mats = {};
  for (const ll of BEAM_LAYERS) {
    const m = new THREE.MeshBasicMaterial({
      color: ll.color, transparent: true, opacity: ll.op,
      toneMapped: false, depthWrite: false, blending: ll.blend,
    });
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(ll.r, ll.r, LASER_LEN, ll.key === 'core' ? 6 : 8), m);
    mesh.position.y = -1.5 - LASER_LEN / 2; // 顶端贴气球底部(y=-1.5)
    beam.add(mesh);
    mats[ll.key] = m;
  }
  group.add(beam);

  group.scale.setScalar(GROUP_SCALE); // 与第三关一致缩小 0.25（气球≈0.75m、光束≈4m）
  group.userData = { balloonMesh, mat, beam, coreMat: mats.core, glowMat: mats.glow, haloMat: mats.halo };
  return group;
}

const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

export class BossLaserGroup {
  constructor(scene, getPlayerPos, damagePlayer, cfg) {
    this.scene = scene;
    this.getPlayerPos = getPlayerPos;
    this.damagePlayer = damagePlayer || (() => {});
    this.cfg = cfg || MAGICIAN_BOSS.LASER_GROUP;
    this.t = 0;
    this._disposed = false;

    // 两个激光气球：A(-4,0,0) / B(+4,0,0)（对称，确保"一来一回"交错）
    this.a = createBossLaserBalloon(0xff2222);
    this.b = createBossLaserBalloon(0x22dddd);
    this.a.position.set(this.cfg.A.x, 0, this.cfg.A.z);
    this.b.position.set(this.cfg.B.x, 0, this.cfg.B.z);
    this.a.userData.beam.scale.y = 0.01; // 初始未延伸
    this.b.userData.beam.scale.y = 0.01;
    this.scene.add(this.a, this.b);

    // 往复方向：A 从 -4 向 +x(朝0)，B 从 +4 向 -x(朝0)
    this.dirA = 1;
    this.dirB = -1;
  }

  update(dt) {
    if (this._disposed) return;
    this.t += dt;
    const C = this.cfg;
    const riseT = Math.min(this.t / C.RISE_TIME, 1);
    const y = C.RISE_HEIGHT * easeInOut(riseT);
    this.a.position.y = y;
    this.b.position.y = y;

    // ② 延伸阶段：RISE_TIME 后 1s 内 beam.scale.y 0.01→1
    const extStart = C.RISE_TIME;
    if (this.t > extStart) {
      const ek = Math.min((this.t - extStart) / C.EXTEND_TIME, 1);
      const sy = 0.01 + (1 - 0.01) * easeInOut(ek);
      this.a.userData.beam.scale.y = sy;
      this.b.userData.beam.scale.y = sy;
    }

    // ③ 往复阶段：上升+延伸完成后，向 X=0 运动，近身反向、外边界回中心
    //    去掉 OSC_TIME 时间门控 → 整个激光阶段(10s)内持续 ping-pong，直到 dispose 才停
    const oscStart = C.RISE_TIME + C.EXTEND_TIME;
    if (this.t > oscStart) {
      this.a.position.x += this.dirA * C.OSC_SPEED * dt;
      this.b.position.x += this.dirB * C.OSC_SPEED * dt;
      const dist = Math.abs(this.a.position.x - this.b.position.x);
      if (dist < C.CLOSE_DIST) { this.dirA = 1; this.dirB = -1; }      // 接近→反向外扩
      if (this.a.position.x < -C.OSC_OUTER) this.dirA = 1;             // 外边界→回中心
      if (this.a.position.x > C.OSC_OUTER) this.dirA = -1;
      if (this.b.position.x < -C.OSC_OUTER) this.dirB = 1;
      if (this.b.position.x > C.OSC_OUTER) this.dirB = -1;
    }

    this._applyBeamFlicker();
    this._checkPlayerHit(dt);
  }

  // 三层光束闪烁（与第三关同样的频率感）
  _applyBeamFlicker() {
    const t = this.t;
    const ca = 0.65 + 0.35 * (0.5 + 0.5 * Math.sin(t * 15));
    const ga = 0.15 + 0.25 * (0.5 + 0.5 * Math.sin(t * 6));
    const ha = 0.03 + 0.09 * (0.5 + 0.5 * Math.sin(t * 3));
    this.a.userData.coreMat.opacity = ca;
    this.a.userData.glowMat.opacity = ga;
    this.a.userData.haloMat.opacity = ha;
    this.b.userData.coreMat.opacity = ca;
    this.b.userData.glowMat.opacity = ga;
    this.b.userData.haloMat.opacity = ha;
  }

  // 玩家处于任一竖直光束内 → 受伤
  _checkPlayerHit(dt) {
    const pp = this.getPlayerPos ? this.getPlayerPos() : null;
    if (!pp) return;
    for (const g of [this.a, this.b]) {
      const sy = g.userData.beam.scale.y;
      if (sy < 0.05) continue; // 激光未延伸
      const balloonBottom = g.position.y - 1.5 * GROUP_SCALE;       // 气球底部世界 y
      const beamLen = LASER_LEN * GROUP_SCALE * sy;                 // 激光世界长度
      const beamBottom = balloonBottom - beamLen;
      const withinX = Math.abs(pp.x - g.position.x) < this.cfg.HIT_HALF_WIDTH;
      const withinY = pp.y > beamBottom && pp.y < balloonBottom + 0.5;
      if (withinX && withinY) this.damagePlayer(this.cfg.DAMAGE * dt);
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const g of [this.a, this.b]) {
      this.scene.remove(g);
      g.traverse((o) => {
        if (o.isMesh) {
          if (o.geometry && o.geometry !== balloonGeo) o.geometry.dispose();
          if (o.material) o.material.dispose();
        }
      });
    }
    this.a = null; this.b = null;
  }
}
