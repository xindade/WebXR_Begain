import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/GLTFLoader.js';
import { DRACOLoader } from '../../vendor/DRACOLoader.js';
import { GUN, GUN_MODES, INPUT } from '../core/constants.js';

// 右手柄 AK 枪模型：加载 Ak枪.glb → 幂等挂到右手柄(grip) → 每帧从 GUN 配置应用变换
// 纯视觉叠加，不影响射击/碰撞/血量逻辑。
// 设计参考 wrist-ui.js 的 attach(input) 幂等挂载模式：模型异步加载、控制器连接前
// getGrip('right') 为 null，故每帧尝试挂载，挂上后置 _attached 跳过。

const D2R = THREE.MathUtils.degToRad;

export class RightGun {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();   // 持有层：GUN 变换作用在此层（模型作为子节点）
    this.model = null;               // 加载完成的 gltf.scene
    this._attached = false;          // 是否已挂到右手柄（幂等）
    this._recoilZ = 0;               // 当前后坐力：沿本地 +Z 后退位移（米）
    this._recoilPitch = 0;           // 当前后坐力：绕本地 X 上抬角（弧度，枪口跳）
    this._lastShots = 0;             // 上一帧记录的开火计数（用于检测本帧新开了几枪）
    this._load();
  }

  // 异步加载模型（GLTFLoader 回调式）；Ak枪.glb 用了 KHR_draco_mesh_compression，
  // 故挂上本地离线 DRACOLoader（解码器文件在 vendor/draco/）。失败放红色线框占位。
  _load() {
    const draco = new DRACOLoader();
    draco.setDecoderPath('vendor/draco/');   // 相对 index.html；解码器离线存放于 vendor/draco
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    loader.load(
      GUN.MODEL_URL,
      (gltf) => {
        this.model = gltf.scene;
        this.root.add(this.model);
        window.__pageLog?.info('[RightGun] AK 枪模型加载完成');
      },
      undefined,
      (err) => {
        console.error('[RightGun] 模型加载失败:', err);
        window.__pageLog?.error('[RightGun] AK 枪加载失败：' + (err?.message || err));
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(0.1, 0.1, 0.4),
          new THREE.MeshBasicMaterial({ color: 0xff3333, wireframe: true })
        );
        this.root.add(box);
      }
    );
  }

  // 每帧调用：幂等挂到右手柄，并从 GUN 配置实时应用变换（便于控制台/刷新即时调参）
  update(dt, input) {
    this._applyTransform();
    this._applyRecoil(dt, input);
    if (this._attached) return;
    const anchor = input?.getGrip(INPUT.SWAP_HANDS ? 'left' : 'right');   // 右手握把空间（SWAP_HANDS 时交换到左手柄以校正 PICO 左右反）
    if (anchor) { anchor.add(this.root); this._attached = true; }
  }

  // 后坐力：在 _applyTransform 把基准变换重置后，叠加一层「后退 + 枪口上跳」，并指数回正。
  // 仅作用于枪模型本体，不碰射击/碰撞/血量逻辑。
  _applyRecoil(dt, input) {
    const R = GUN.RECOIL;
    if (R.ENABLED && input) {
      const fired = input.shotsFired || 0;
      const delta = fired - this._lastShots;   // 本帧新开的枪数（节流下多为 1）
      this._lastShots = fired;
      if (delta > 0) {
        // 射速归一化：preview(500ms)→0(最大幅度)，full(100ms)→1(最小幅度)
        const norm = this._fireRateNorm(input._gunCooldown);
        const k = Math.pow(norm, R.CURVE);     // 曲率：快射时幅度掉得更陡
        this._recoilZ += THREE.MathUtils.lerp(R.MAX_BACK, R.MIN_BACK, k) * delta;
        this._recoilPitch += THREE.MathUtils.lerp(R.MAX_PITCH, R.MIN_PITCH, k) * delta;
      }
    } else if (input) {
      this._lastShots = input.shotsFired || 0; // 关闭时同步计数，避免重新开启瞬间暴冲
    }
    // 帧率无关的指数回正
    const f = Math.pow(R.DECAY, dt * 60);
    this._recoilZ *= f;
    this._recoilPitch *= f;
    // 叠加到已重置的基准变换之上（本地坐标：+Z 为后退，+X 旋转为枪口上抬）
    this.root.position.z += this._recoilZ;
    this.root.rotation.x += this._recoilPitch;
  }

  // 当前射速归一化：cooldown 越小(越快) → 越接近 1（后坐力幅度越小）
  _fireRateNorm(cd) {
    const slow = GUN_MODES.preview.cooldown;  // 500
    const fast = GUN_MODES.full.cooldown;     // 100
    if (!(fast < slow)) return 0;
    const t = (slow - (cd || slow)) / (slow - fast);
    return THREE.MathUtils.clamp(t, 0, 1);
  }

  _applyTransform() {
    this.root.position.set(GUN.POSITION.x, GUN.POSITION.y, GUN.POSITION.z);
    this.root.rotation.set(D2R(GUN.ROTATION.x), D2R(GUN.ROTATION.y), D2R(GUN.ROTATION.z));
    this.root.scale.setScalar(GUN.SCALE);
  }
}
