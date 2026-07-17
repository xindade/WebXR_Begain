import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/GLTFLoader.js';
import { DRACOLoader } from '../../vendor/DRACOLoader.js';
import { GUN } from '../core/constants.js';

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
    if (this._attached) return;
    const anchor = input?.getGrip('right');   // 右手握把空间（手腕面板同此）
    if (anchor) { anchor.add(this.root); this._attached = true; }
  }

  _applyTransform() {
    this.root.position.set(GUN.POSITION.x, GUN.POSITION.y, GUN.POSITION.z);
    this.root.rotation.set(D2R(GUN.ROTATION.x), D2R(GUN.ROTATION.y), D2R(GUN.ROTATION.z));
    this.root.scale.setScalar(GUN.SCALE);
  }
}
