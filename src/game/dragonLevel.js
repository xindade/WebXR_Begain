import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/GLTFLoader.js';
import { DRACOLoader } from '../../vendor/DRACOLoader.js';
import { DRAGON } from '../core/constants.js';

// 第十二关「龙 Boss」
//   龙头 = Model/龙头.glb（沿 headPath 跟随移动，自动按包围盒缩放贴合龙身）
//   龙身/龙爪 = 由敌人气球组成（默认 basic，受 DragonBoss 逐帧接管位置 → controlled）
//   运动数据 = DRAGON.ANIM_URL 指向的 JSON（schemaVersion 2）
//     重建配方（见 JSON 内 reconstruction）：
//       1) 弧长 s 由 speed 推进，loop 模式对总弧长取模循环；跨过 pauses 的 s 时冻结 duration 秒并轻微晃动
//       2) 龙头位置：在 headPath 按累计弧长 s 线性插值
//       3) 身体第 i 节：按弧长 (s − i*bodySpacing) 取点 → 形成龙身/龙尾
//       4) 龙爪：在「第 CLAW_NODE 节」处取切向 T、法线 N = T × 上方向；左右爪 = 节点 ± N*clawSpread
//   坐标贴合：原始数据为「世界中心」右手系米制（范围 ±180m），经 SCALE 缩放 + HOME 平移到玩家前方战场。
//   换同格式动画 = 改 DRAGON.ANIM_URL 一行（一键套用）。

const D2R = THREE.MathUtils.degToRad;
const UP = new THREE.Vector3(0, 1, 0);

export class DragonBoss {
  constructor(scene, balloons) {
    this.scene = scene;
    this.balloons = balloons;          // BalloonManager（气球自动纳入碰撞/计分，每帧位置由本类接管）
    this.dead = false;
    this.cleared = false;
    this.aliveCount = 0;

    this.headGroup = new THREE.Group(); // 龙头挂载层（位置/朝向由本类逐帧设）
    this.scene.add(this.headGroup);
    this.headModel = null;
    this.headFitScale = 1;

    // 数据（_buildFromData 填充）
    this.config = null;
    this.path = [];                     // [{s,x,y,z}]
    this.total = 0;                     // 总弧长
    this.center = new THREE.Vector3();  // headPath 包围盒中心（用于居中到 HOME）
    this.pauses = [];
    this.dScale = DRAGON.SCALE;

    // 运行状态
    this.s = 0;                         // 当前龙头弧长
    this.pauseTimer = 0;
    this.pauseWobble = 0;
    this.pauseElapsed = 0;
    this._wobbleY = 0;

    // 部件（气球引用）
    this.bodyParts = [];                // [{balloon, i}]  i=1..bodyCount
    this.clawParts = [];                // [{balloon, side}] side=-1/+1
    this.allParts = [];                 // 全部龙气球（用于 alive 统计）
  }

  // 异步加载：解析 JSON → 生成气球 → 加载龙头模型
  async start() {
    try {
      const res = await fetch(DRAGON.ANIM_URL);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      this._buildFromData(data);
      this._spawnBalloons();
      this._loadHead();
    } catch (err) {
      console.error('[DragonBoss] 加载动画数据失败:', err);
      window.__pageLog?.error('[DragonBoss] 龙动画加载失败：' + (err?.message || err));
    }
  }

  _buildFromData(data) {
    this.config = data.config || {};
    this.pauses = Array.isArray(data.pauses) ? data.pauses : [];
    this.dScale = DRAGON.SCALE;
    const raw = data.headPath || [];
    this.path = raw.map((k) => ({ s: k.s, x: k.p[0], y: k.p[1], z: k.p[2] }));
    this.path.sort((a, b) => a.s - b.s);
    this.total = this.path.length ? this.path[this.path.length - 1].s : 0;
    // 包围盒中心 → 居中到 HOME
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const k of this.path) box.expandByPoint(v.set(k.x, k.y, k.z));
    box.getCenter(this.center);
  }

  // 原始坐标(raw) → 世界坐标：以包围盒中心为锚，缩放后平移到 HOME（+ 暂停晃动）
  _toWorld(raw) {
    return new THREE.Vector3(
      DRAGON.HOME.x + this.dScale * (raw.x - this.center.x),
      DRAGON.HOME.y + this.dScale * (raw.y - this.center.y) + this._wobbleY,
      DRAGON.HOME.z + this.dScale * (raw.z - this.center.z)
    );
  }

  // 按累计弧长在 headPath 线性插值取点（越界 clamp）
  _sample(arc) {
    const s = Math.max(0, Math.min(this.total, arc));
    const path = this.path;
    if (path.length === 0) return { x: 0, y: 0, z: 0 };
    let i = 0;
    while (i < path.length - 1 && path[i + 1].s < s) i++;
    const a = path[i];
    const b = path[Math.min(i + 1, path.length - 1)];
    const span = (b.s - a.s) || 1;
    const t = Math.max(0, Math.min(1, (s - a.s) / span));
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    };
  }

  // 弧长处的单位切向
  _tangent(arc) {
    const d = Math.max(1, this.total * 0.002);
    const a = this._sample(arc - d);
    const b = this._sample(arc + d);
    const t = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
    if (t.lengthSq() < 1e-9) t.set(0, 0, 1);
    return t.normalize();
  }

  _spawnBalloons() {
    const bodyCount = this.config.bodyCount || 10;
    const clawCount = this.config.clawCount || 2;
    const hpMult = DRAGON.HP_MULT;

    // 龙身
    for (let i = 1; i <= bodyCount; i++) {
      const b = this.balloons.spawn(DRAGON.BODY_TYPE, new THREE.Vector3(0, -999, 0));
      b.controlled = true; // 跳过自动朝玩家移动 + 分离力
      if (hpMult !== 1) { b.maxHp = Math.round(b.maxHp * hpMult); b.hp = b.maxHp; }
      this.bodyParts.push({ balloon: b, i });
      this.allParts.push(b);
    }

    // 龙爪（clawCount 个，左右对称分布在节点两侧）
    for (let c = 0; c < clawCount; c++) {
      const side = c < clawCount / 2 ? -1 : 1;
      const b = this.balloons.spawn(DRAGON.CLAW_TYPE, new THREE.Vector3(0, -999, 0));
      b.controlled = true;
      if (hpMult !== 1) { b.maxHp = Math.round(b.maxHp * hpMult); b.hp = b.maxHp; }
      this.clawParts.push({ balloon: b, side });
      this.allParts.push(b);
    }

    this.aliveCount = this.allParts.length;
  }

  _loadHead() {
    const draco = new DRACOLoader();
    draco.setDecoderPath('vendor/draco/');
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    loader.load(
      DRAGON.HEAD_MODEL,
      (gltf) => {
        this.headModel = gltf.scene;
        // 自动按包围盒缩放：使龙头直径 ≈ 2 * headRadius * SCALE（与龙身尺寸一致）
        const box = new THREE.Box3().setFromObject(this.headModel);
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const desiredDiameter = 2 * (this.config.headRadius || 10) * this.dScale;
        this.headFitScale = desiredDiameter / maxDim;
        this.headModel.scale.setScalar(this.headFitScale * DRAGON.HEAD_SCALE);
        this.headGroup.add(this.headModel);
      },
      undefined,
      (err) => {
        console.error('[DragonBoss] 龙头模型加载失败:', err);
        window.__pageLog?.error('[DragonBoss] 龙头加载失败：' + (err?.message || err));
        // 红色线框占位，便于上机确认路径正确
        const m = new THREE.Mesh(
          new THREE.SphereGeometry(0.6, 12, 10),
          new THREE.MeshBasicMaterial({ color: 0xe63946, wireframe: true })
        );
        this.headGroup.add(m);
      }
    );
  }

  update(dt, playerPos) {
    if (this.dead || !this.config) return;

    // —— 推进弧长（含 pause 冻结 + 悬浮晃动）——
    if (this.pauseTimer > 0) {
      this.pauseTimer -= dt;
      this.pauseElapsed += dt;
      this._wobbleY = this.pauseWobble * this.dScale * Math.sin(this.pauseElapsed * 3);
    } else {
      this._wobbleY = 0;
      this.pauseElapsed = 0;
      const next = this.s + (this.config.speed || 180) * dt;
      let crossed = false;
      for (const p of this.pauses) {
        if (this.s < p.s && next >= p.s) {
          this.s = p.s;
          this.pauseTimer = p.duration || 0;
          this.pauseWobble = p.wobble || 0;
          crossed = true;
          break;
        }
      }
      if (!crossed) this.s = next % this.total;
    }

    // —— 龙头 ——
    const headRaw = this._sample(this.s);
    if (this.headModel) {
      this.headGroup.position.copy(this._toWorld(headRaw));
      const t = this._tangent(this.s);
      const ahead = this._toWorld({ x: headRaw.x + t.x, y: headRaw.y + t.y, z: headRaw.z + t.z });
      this.headGroup.lookAt(ahead);
      this.headGroup.rotateY(D2R(DRAGON.HEAD_YAW)); // 若龙头朝向与前进方向相反，把 HEAD_YAW 改成 180
    }

    // —— 龙身 ——
    const bodySpacing = this.config.bodySpacing || 10;
    for (const part of this.bodyParts) {
      if (!part.balloon.alive) continue;
      const arc = this.s - part.i * bodySpacing;
      part.balloon.mesh.position.copy(this._toWorld(this._sample(arc < 0 ? 0 : arc)));
    }

    // —— 龙爪：在 CLAW_NODE 节处，沿法线 N = T × 上方向 左右偏移 ——
    const nodeArc = this.s - DRAGON.CLAW_NODE * bodySpacing;
    const nodeRaw = this._sample(nodeArc < 0 ? 0 : nodeArc);
    const t = this._tangent(nodeArc < 0 ? 0 : nodeArc);
    const N = new THREE.Vector3(-t.z, 0, t.x); // T × up
    if (N.lengthSq() < 1e-9) N.set(1, 0, 0);
    N.normalize();
    const clawSpread = this.config.clawSpread || 6;
    const nodeWorld = this._toWorld(nodeRaw);
    for (const part of this.clawParts) {
      if (!part.balloon.alive) continue;
      part.balloon.mesh.position.copy(
        nodeWorld.clone().addScaledVector(N, part.side * clawSpread * this.dScale)
      );
    }

    // —— 通关判定：全部龙气球被打光 ——
    let alive = 0;
    for (const b of this.allParts) if (b.alive) alive++;
    this.aliveCount = alive;
    if (alive === 0) this.cleared = true;
  }

  dispose() {
    this.dead = true;
    // 移除龙头（含几何/材质释放）；龙气球由 game 的 balloons.clear() 统一回收，避免重复 remove
    this.scene.remove(this.headGroup);
    if (this.headModel) {
      this.headModel.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      });
      this.headGroup.remove(this.headModel);
    }
    this.headModel = null;
    this.bodyParts = [];
    this.clawParts = [];
    this.allParts = [];
  }
}
