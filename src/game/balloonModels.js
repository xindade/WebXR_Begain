import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/GLTFLoader.js';
import { DRACOLoader } from '../../vendor/DRACOLoader.js';

// 气球 GLB 模型加载/挂载助手。
// 加载范式复用 rightGun.js / dragonLevel.js：GLTFLoader + 离线 DRACOLoader( vendor/draco/ )。
// GLB 异步，气球构造是同步的，故采用「先建程序化球体 → 模型就绪后挂为子节点并隐藏球体」模式。
// 碰撞是距离判定(game.js)，隐藏球体材质不影响命中。

const _cache = new Map(); // url -> Promise<gltf.scene>

// ===== 各怪物模型「本地位置 / 旋转 / 缩放」微调表（手动修改入口）=====
// 用途：GLB 模型挂到气球上后，若朝向偏了 / 想抬高、放大，改这里即可，无需碰逻辑代码。
//   pos:   [x, y, z] 模型相对气球中心的位置偏移(米)；默认 [0,0,0] = 完美居中贴合碰撞球。想整体抬高/下沉改 y。
//   rot:   [x, y, z] 模型本地欧拉旋转(角度°)；默认 [0,0,0] = 沿用模型原生朝向。
//                      例：某盾牌正面本应朝 -Z（气球「前方」），若实测发现侧身，调对应 rot 的 y（如 90 / -90）即可转正，比弧度直观。
//   scale: 模型相对「自动贴合碰撞球」的额外缩放系数；默认 1.0 = 与碰撞体积等大。>1 放大、<1 缩小（仅改外观，不影响碰撞判定半径）。
export const MODEL_TUNING = {
  'Model/基础怪.glb': { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1.0 },
  'Model/召唤师.glb': { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1.0 },
  'Model/骑士.glb':   { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1.0 },
  'Model/盾牌.glb':   { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1.0 },
};

// 返回缓存的加载 Promise；失败则 reject（调用方兜底保留程序化球体）
export function loadBalloonModel(url) {
  if (_cache.has(url)) return _cache.get(url);
  const p = new Promise((resolve, reject) => {
    const draco = new DRACOLoader();
    draco.setDecoderPath('vendor/draco/'); // 离线解码器，相对 index.html
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    loader.load(url, (gltf) => resolve(gltf.scene), undefined, (err) => {
      console.error('[BalloonModels] 模型加载失败:', url, err);
      reject(err);
    });
  });
  _cache.set(url, p);
  return p;
}

// 把加载好的模型居中并缩放到与碰撞半径匹配：免去手猜 GLB 原生尺寸
function _fitToRadius(obj, radius) {
  obj.updateMatrixWorld(true); // 克隆体未入场景，先刷新世界矩阵再量包围盒
  let box = new THREE.Box3().setFromObject(obj);
  const center = new THREE.Vector3();
  box.getCenter(center);
  obj.position.sub(center); // 几何中心移到原点
  obj.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(obj); // 居中后重新求尺寸
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  obj.scale.setScalar((radius * 2) / maxDim);
}

// 把模型挂到气球上；fire-and-forget（async，不阻塞构造）。
// balloon.mesh 是球体(Mesh)：模型作为子节点挂上后隐藏球体材质，碰撞/血条/朝向逻辑都照常。
// tint：通用身体(基础怪)按类型染色用；专用模型传 null 不打 tint。
export function attachBalloonModel(balloon, url, radius, tint = null) {
  loadBalloonModel(url)
    .then((gltfScene) => {
      // 气球可能在加载期间已被打死/移除：直接释放克隆体，不挂场景
      if (!balloon.alive) {
        gltfScene.traverse((o) => {
          if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
        });
        return;
      }
      const clone = gltfScene.clone(true);
      _fitToRadius(clone, radius);

      // 应用手动微调：位置(米)叠加在「居中」之上；旋转(角度°)转弧度覆盖原生朝向；scale 在「自动贴合」基础上再缩放（见文件顶部 MODEL_TUNING）
      const tune = MODEL_TUNING[url] || { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1.0 };
      clone.position.add(new THREE.Vector3(tune.pos[0], tune.pos[1], tune.pos[2]));
      clone.rotation.set(
        THREE.MathUtils.degToRad(tune.rot[0]),
        THREE.MathUtils.degToRad(tune.rot[1]),
        THREE.MathUtils.degToRad(tune.rot[2])
      );
      clone.scale.multiplyScalar(tune.scale ?? 1.0); // 在 _fitToRadius 的贴合缩放之上叠加手动缩放

      // 每个气球独立克隆材质，互不影响闪烁/染色
      const modelMats = [];
      clone.traverse((o) => {
        if (o.isMesh) {
          o.material = o.material.clone();
          if (tint != null) o.material.color.setHex(tint); // 通用身体按类型 tint 染色
          modelMats.push(o.material);
        }
      });

      balloon.mesh.add(clone);
      balloon.mesh.material.visible = false; // 隐藏程序化球体（碰撞仍靠 position）
      balloon.bodyModel = clone;
      balloon._modelMats = modelMats;
    })
    .catch(() => {
      // 加载失败：恢复程序化球体（笑脸）作为兜底，避免气球不可见
      balloon.mesh.material.visible = true;
      console.warn('[BalloonModels] 降级为程序化球体:', url);
    });
}
