import * as THREE from 'three';
import { CLOUD } from '../core/constants.js';

const _WORLD_UP = new THREE.Vector3(0, 1, 0);

// 关卡开场「穿云」特效：每关开始先在玩家前方生成 5×9 软雾团网格，
// 整团向后飘 DRIFT_DUR 秒，再「由前向后」缩短 SHRINK_DUR 秒（表现玩家突破云层），
// 期间游戏逻辑冻结（由 Game._updatePlaying 开场门控实现）。
// 参考 openingModel.js 骨架：_t 计时 + _disposed 幂等守卫 + start/update/dispose；
// 几何/材质为本实例自建，dispose 必须释放（含共享贴图）。
export class CloudFx {
  constructor(scene) {
    this.scene = scene;
    this.group = null;
    this.puffs = [];           // { sprite, rankFront(0=最前), baseOpacity }
    this._puffTex = null;      // 所有 puff 共享的软边贴图
    this._fwd = new THREE.Vector3();
    this._back = new THREE.Vector3();
    this._t = 0;
    this._started = false;
    this._disposed = false;
  }

  // camera/rig 用于取玩家位姿；云雾一次性锚定在玩家前方世界坐标（世界固定→移动产生穿越视差）。
  // 调用时机：_loadLevel 末尾、场景(天空/传送门/激光几何/龙)已构建后。
  start(camera, rig) {
    if (this._started || this._disposed) return;
    this._started = true;

    // 玩家正前方向(水平化)；云雾从正前 FRONT_DIST 起向远处铺
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const back = fwd.clone().negate();                 // 背向 = 飘动方向(远离玩家)
    const right = new THREE.Vector3().crossVectors(fwd, _WORLD_UP).normalize();

    const pp = rig.getWorldPosition(new THREE.Vector3());

    const tex = this._makePuffTexture();
    this._puffTex = tex;

    const cols = CLOUD.COLS, rows = CLOUD.ROWS;
    const wStep = cols > 1 ? CLOUD.SPREAD_X / (cols - 1) : 0;
    const dStep = rows > 1 ? CLOUD.DEPTH / (rows - 1) : 0;

    this.group = new THREE.Group();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const xi = cols > 1 ? (c - (cols - 1) / 2) * wStep : 0;
        const zi = CLOUD.FRONT_DIST + r * dStep;        // 沿正前方向的深度（前→后）
        const pos = pp.clone()
          .addScaledVector(fwd, zi)
          .addScaledVector(right, xi)
          .addScaledVector(_WORLD_UP, CLOUD.Y + (Math.random() - 0.5) * CLOUD.Y_JITTER);
        const op = CLOUD.OPACITY * (0.7 + Math.random() * 0.3);
        const mat = new THREE.SpriteMaterial({
          map: tex,
          color: CLOUD.COLOR,
          transparent: true,
          opacity: op,
          depthWrite: false,            // 半透明云：不写深度，彼此正确叠加
          depthTest: true,
          blending: THREE.NormalBlending,
        });
        const sp = new THREE.Sprite(mat);
        const s = CLOUD.PUFF_SIZE * (0.8 + Math.random() * 0.4);
        sp.scale.set(s, s, s);
        sp.position.copy(pos);
        this.group.add(sp);
        this.puffs.push({
          sprite: sp,
          rankFront: rows > 1 ? r / (rows - 1) : 0,   // 0=最前(离玩家最近)，1=最后
          baseOpacity: op,
        });
      }
    }
    this.scene.add(this.group);
    this._fwd.copy(fwd);
    this._back.copy(back);
    this._t = 0;
  }

  update(dt) {
    if (!this._started || this._disposed) return;
    this._t += dt;
    const driftEnd = CLOUD.DRIFT_DUR;
    const shrinkEnd = CLOUD.DRIFT_DUR + CLOUD.SHRINK_DUR;
    if (this._t <= driftEnd) {
      // 阶段1：整团沿背向(远离玩家)飘动
      this.group.position.addScaledVector(this._back, CLOUD.DRIFT_SPEED * dt);
    } else if (this._t <= shrinkEnd) {
      // 阶段2：由前向后缩短——前排(rankFront=0)先淡出，后排渐次淡出，呈现「突破云层」
      const k = (this._t - driftEnd) / CLOUD.SHRINK_DUR;   // 0→1
      for (const p of this.puffs) {
        // 前排在 k 起始即淡，后排延后：局部进度 local∈[0,1]
        const local = THREE.MathUtils.clamp((k - p.rankFront * 0.6) / 0.4, 0, 1);
        p.sprite.material.opacity = p.baseOpacity * (1 - local);
        // 同时整体再后退一点，强化「穿出」感
        p.sprite.position.addScaledVector(this._back, CLOUD.DRIFT_SPEED * 0.5 * dt);
      }
    } else {
      this.dispose();
    }
  }

  // 幂等释放：移除 group，释放每个 sprite 的 material 与共享贴图
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.group) {
      for (const p of this.puffs) p.sprite.material.dispose();
      if (this._puffTex) this._puffTex.dispose();
      this.scene.remove(this.group);
      this.group = null;
    }
    this.puffs = [];
  }

  // canvas 程序化径向渐变软圆（单次生成，所有 puff 共享），作云朵 alpha
  _makePuffTexture() {
    const sz = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = sz;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(sz / 2, sz / 2, 0, sz / 2, sz / 2, sz / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.7)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, sz, sz);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
}
