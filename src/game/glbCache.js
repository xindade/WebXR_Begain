// 共享 GLB 缓存（模块级）：
//  - portal.js（传送门动画.glb）与 openingModel.js（魔术师动画版.glb）共用；
//  - 缓存「完整 gltf」（含 gltf.animations），两处都要用 animations 建 AnimationMixer；
//  - main.js 预览阶段 preloadGLB 预加载 → 进关后 loadGLB 命中同一 Promise，零下载/零解码/零 parse；
//  - 资源生命周期：geometry/material/texture 由本缓存跨关持有，实例 dispose 只摘除、不释放
//    （参照 dragonLevel.js「模型由缓存跨关持有」范式）。
import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/GLTFLoader.js';
import { DRACOLoader } from '../../vendor/DRACOLoader.js';

const _cache = new Map(); // url -> Promise<gltf>

function _load(url, onProgress) {
  const draco = new DRACOLoader();
  draco.setDecoderPath('vendor/draco/'); // 离线解码器，相对 index.html
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      resolve,                                      // resolve(完整 gltf，含 animations)
      (e) => { if (onProgress) onProgress(e.loaded || 0, e.total || 1); },
      (err) => { console.error('[GLBCache] 加载失败:', url, err); reject(err); }
    );
  });
}

// 返回缓存的加载 Promise；同一 url 并发调用共享同一 Promise / 同一 gltf 对象。
export function loadGLB(url, onProgress) {
  if (_cache.has(url)) {
    onProgress?.(1, 1);
    return _cache.get(url);
  }
  const p = _load(url, onProgress).catch((err) => {
    _cache.delete(url); // 失败重试策略：删缓存项，下次调用（重进关）重新下载
    throw err;
  });
  _cache.set(url, p);
  return p;
}

// 预览阶段预加载入口：失败静默返回 false，不阻塞进度条；成功/失败都 resolve。
export async function preloadGLB(url, onProgress) {
  try { await loadGLB(url, onProgress); return true; }
  catch (e) { return false; }
}

// 克隆共享 gltf.scene 用于单个实例：deep clone + 蒙皮重绑兜底。
// 非蒙皮动画（节点/形态键）clone(true) 即正确；有 SkinnedMesh 时把 skeleton 重绑到克隆树内骨骼，
// 避免多实例共享原始骨骼导致动画串扰（本工程两个 GLB 大概率是节点动画，此分支通常不触发）。
export function cloneGLBScene(gltf) {
  const root = gltf.scene.clone(true);
  let hasSkinned = false;
  root.traverse((o) => { if (o.isSkinnedMesh) hasSkinned = true; });
  if (hasSkinned) {
    const boneByName = new Map();
    root.traverse((o) => { if (o.isBone && o.name) boneByName.set(o.name, o); });
    root.traverse((o) => {
      if (o.isSkinnedMesh && o.skeleton) {
        const bones = o.skeleton.bones.map((b) => boneByName.get(b.name) || b);
        o.skeleton = new THREE.Skeleton(bones, o.skeleton.boneInverses); // inverse 矩阵只读可共享
        o.bind(o.skeleton, o.bindMatrix);
      }
    });
  }
  return root;
}
