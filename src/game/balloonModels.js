import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/GLTFLoader.js';
import { DRACOLoader } from '../../vendor/DRACOLoader.js';
import { DRAGON, DEPTH_SPRITE_MODE, DEPTH_SPRITE_TYPES, DEPTH_SPRITE_SCALE, DEPTH_SPRITE_FRAMES, DEPTH_SPRITE_SWING, DEPTH_SPRITE_HANDPAINTED, DEPTH_SPRITE_HIT_MUL } from '../core/constants.js';
import { DepthSprite } from './depthSprite.js';
import { captureModelByUrl, loadDepthSpriteSheet } from './glbCapture.js';

// 气球 GLB 模型加载/挂载助手。
// 加载范式复用 rightGun.js / dragonLevel.js：GLTFLoader + 离线 DRACOLoader( vendor/draco/ )。
// GLB 异步，气球构造是同步的，故采用「先建程序化球体 → 模型就绪后挂为子节点并隐藏球体」模式。
// 碰撞是距离判定(game.js)，隐藏球体材质不影响命中。

const _cache = new Map(); // url -> Promise<gltf.scene>

// DepthSprite 捕获需要的 renderer（由 game.js 构造时注入 world.renderer）
let _renderer = null;
export function setRenderer(r) { _renderer = r; }

// ===== 各怪物模型「本地位置 / 旋转 / 缩放」微调表（手动修改入口）=====
// 用途：GLB 模型挂到气球上后，若朝向偏了 / 想抬高、放大，改这里即可，无需碰逻辑代码。
//   pos:   [x, y, z] 模型相对气球中心的位置偏移(米)；默认 [0,0,0] = 完美居中贴合碰撞球。想整体抬高/下沉改 y。
//   rot:   [x, y, z] 模型本地欧拉旋转(角度°)；默认 [0,0,0] = 沿用模型原生朝向。
//                      例：某盾牌正面本应朝 -Z（气球「前方」），若实测发现侧身，调对应 rot 的 y（如 90 / -90）即可转正，比弧度直观。
//   scale: 模型相对「自动贴合碰撞球」的额外缩放系数；默认 1.0 = 与碰撞体积等大。>1 放大、<1 缩小（仅改外观，不影响碰撞判定半径）。
//   注意：骑士.glb 同时被「盾兵怪(普通大小)」与「骑士Boss(放大)」使用。
//        此处默认 scale=0.5 适配 Boss（配合 waves._spawnBoss 的 mesh.scale=4 → 约 6m）；
//        盾兵怪在 balloons.js 调用时传入 tuning 覆盖 {scale:1.0} → 约 1.8m 正常体型。
export const MODEL_TUNING = {
  'Model/基础怪.glb': { pos: [0, 0, 0], rot: [0, 0, 0], scale: 2.0 },
  'Model/召唤师.glb': { pos: [0, 0, 0], rot: [0, 0, 0], scale: 3.0 },
  'Model/骑士.glb':   { pos: [0, 0, 0], rot: [0, 0, 0], scale: 0.5 },
  'Model/盾牌.glb':   { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1.0 },
  'Model/龙头.glb':   { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1.0 },
  // —— 新增怪物模型微调（替换占位；pos/rot/scale 含义同上，按需微调）——
  'Model/宝箱.glb':   { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1.0 },
  'Model/幽灵.glb':   { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1.0 },
  'Model/心形怪.glb': { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1.0 },
  'Model/忍者.glb':   { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1.0 },
  'Model/章鱼.glb':   { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1.0 },
  // —— 脸谱 Boss 模型 + 装饰 ——
  // 蓝/红脸谱绕 Y 逆时针旋转 90°（正 Y = 俯视逆时针；若方向反了改回 -90）
  'Model/蓝面脸谱.glb': { pos: [0, 0, 0], rot: [0, 90, 0], scale: 1.0 },
  'Model/红面脸谱.glb': { pos: [0, 0, 0], rot: [0, 90, 0], scale: 1.0 },
  'Model/黑面脸谱.glb': { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1.0 },
  'Model/京剧扇子.glb': { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1.0 },
  'Model/旗子.glb':     { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1.0 },
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
export function fitToRadius(obj, radius) {
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
// tuningOverride：可选，覆盖 MODEL_TUNING 中该 url 的 {pos,rot,scale}（用于同一模型不同体型，如盾兵骑士 vs Boss 骑士）。
export function attachBalloonModel(balloon, url, radius, tint = null, tuningOverride = null, extraScale = 1, typeId = null) {
  // —— DepthSprite 分支（开关 + 白名单）：用 GLB 捕获的 2D 立绘替 3D GLB ——
  if (DEPTH_SPRITE_MODE && _renderer && typeId && DEPTH_SPRITE_TYPES.includes(typeId)) {
    const tune = { ...(MODEL_TUNING[url] || { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1.0 }), ...(tuningOverride || {}) };
    // 数据源：手绘/离线 sheet 优先（DEPTH_SPRITE_HANDPAINTED 映射），否则运行时多帧捕获
    const hand = DEPTH_SPRITE_HANDPAINTED[url];
    const srcPromise = hand
      ? loadDepthSpriteSheet(hand.albedo, hand.depth, { frameCount: hand.frameCount || 1, cols: hand.cols, rows: hand.rows })
      : captureModelByUrl(_renderer, url, radius, { frames: DEPTH_SPRITE_FRAMES, swing: DEPTH_SPRITE_SWING });
    srcPromise
      .then(({ albedo, depth, frameCount, cols, rows }) => {
        if (!balloon.alive) return; // 加载期间已被打死：不挂
        const dsSize = radius * 2 * (tune.scale ?? 1) * extraScale;
        const ds = new DepthSprite({ albedo, depth, frameCount, cols, rows, depthScale: DEPTH_SPRITE_SCALE, size: dsSize });
        balloon.mesh.parent.add(ds.mesh);   // 挂到 scene（与 balloon.mesh 平级）
        balloon.depthSprite = ds;
        balloon._dsScene = balloon.mesh.parent;
        balloon.mesh.material.visible = false; // 隐藏程序化球体
        // 命中半径折算取景留边：captureGLB 模型只占画幅 62.5%，立绘纹理其余为透明边；
        // 不乘系数则命中按整张半幅算，比可见角色大 ~1.6 倍。×DEPTH_SPRITE_HIT_MUL(0.6) 修正。
        balloon.hitRadius = balloon.effectiveRadius * (tune.scale ?? 1) * extraScale * DEPTH_SPRITE_HIT_MUL;
      })
      .catch(() => { balloon.mesh.material.visible = true; }); // 失败兜底保留程序化球体
    return;
  }
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
      fitToRadius(clone, radius);

      // 应用手动微调：位置(米)叠加在「居中」之上；旋转(角度°)转弧度覆盖原生朝向；scale 在「自动贴合」基础上再缩放（见文件顶部 MODEL_TUNING）
      const tune = { ...(MODEL_TUNING[url] || { pos: [0, 0, 0], rot: [0, 0, 0], scale: 1.0 }), ...(tuningOverride || {}) };
      clone.position.add(new THREE.Vector3(tune.pos[0], tune.pos[1], tune.pos[2]));
      clone.rotation.set(
        THREE.MathUtils.degToRad(tune.rot[0]),
        THREE.MathUtils.degToRad(tune.rot[1]),
        THREE.MathUtils.degToRad(tune.rot[2])
      );
      clone.scale.multiplyScalar((tune.scale ?? 1.0) * extraScale); // 在 fitToRadius 贴合缩放之上叠加手动缩放 + 逐段 taper

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
      // 命中球按模型视觉尺寸放大：fitToRadius 让模型 maxDim=2*radius，再叠加 tune.scale/extraScale；
      // effectiveRadius 已含 mesh.scale，故 hitRadius 可覆盖整个模型（含上半身）
      balloon.hitRadius = balloon.effectiveRadius * (tune.scale ?? 1.0) * extraScale;
    })
    .catch(() => {
      // 加载失败：恢复程序化球体（笑脸）作为兜底，避免气球不可见
      balloon.mesh.material.visible = true;
      console.warn('[BalloonModels] 降级为程序化球体:', url);
    });
}

// 脸谱 Boss 专用：移除旧模型并挂载新模型（用于每 10 秒变脸）
// typeId 传 null 确保走 3D GLB 路径（不走 DepthSprite）
export function swapBalloonModel(balloon, newUrl, radius) {
  // 移除并释放旧模型
  if (balloon.bodyModel) {
    balloon.mesh.remove(balloon.bodyModel);
    balloon.bodyModel.traverse((o) => {
      if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
    });
    balloon.bodyModel = null;
    balloon._modelMats = null;
  }
  // 挂载新模型（模型已在 _cache 中，克隆很快）
  attachBalloonModel(balloon, newUrl, radius, null, null, 1, null);
}

// 预捕获 DepthSprite 数据源：黑阶段留空期提前触发捕获，
// 利用 _capCache（key=url:frames:swing）使 25 个分身只捕获一次且首帧零成本。
export function preCaptureDepthSprite(url, radius) {
  if (!DEPTH_SPRITE_MODE || !_renderer) return Promise.resolve(null);
  return captureModelByUrl(_renderer, url, radius, {
    frames: DEPTH_SPRITE_FRAMES,
    swing: DEPTH_SPRITE_SWING,
  }).then(() => true).catch(() => false);
}

// 龙身/龙爪混合外观装配（龙 Boss 掉帧修复的「外观升级」版）。
// kind:
//   'model'    → 挂模型节点（默认 DRAGON.NODE_MODEL，可被 modelUrl 覆盖），taper*nodeScale 经 extraScale 应用
//   'cylinder' → 程序化黑红圆柱（黑底炭灰 + 红色发光环），沿本地 Z 躺平，像龙脊椎骨节
// taper       ：逐段缩放（头粗尾细），由 dragonLevel 按节号传入。
// modelUrl    ：仅 kind='model' 时生效，覆盖 NODE_MODEL（指向 NODE_DEFS[].model）。
// tuningOverride：仅 kind='model' 时生效，传给 attachBalloonModel 的 { pos, rot(度) }，rot 做三轴自身旋转。
// nodeScale   ：仅 kind='model' 时生效，叠加在 taper 之上的额外缩放（指向 NODE_DEFS[].scale）。
// 注意：dragonBody/dragonNode 气球在 balloons.js 构造时仅隐藏球体，此处由 dragonLevel._spawnBalloons 显式调用。
export function attachDragonSegment(balloon, radius, kind = 'cylinder', taper = 1, modelUrl = null, tuningOverride = null, nodeScale = 1) {
  if (kind === 'model') {
    // 模型节点：异步挂 GLB（命中 preload 缓存，几乎无等待）；taper*nodeScale 作为 extraScale 应用到缩放
    attachBalloonModel(balloon, modelUrl || DRAGON.NODE_MODEL, radius, null, tuningOverride, taper * nodeScale);
    balloon._hasModel = true;
    return;
  }
  // 圆柱节点：黑底炭灰 + 红色发光环带，平面着色，呈现「龙脊椎骨节」质感
  const height = radius * 1.5;
  const geo = new THREE.CylinderGeometry(radius, radius, height, 18);
  geo.rotateX(Math.PI / 2); // 默认轴沿 Y → 旋转到沿本地 Z（躺平沿脊柱方向）
  const mat = new THREE.MeshStandardMaterial({
    color: 0x111111, roughness: 0.5, metalness: 0.35, flatShading: true,
  });
  const seg = new THREE.Mesh(geo, mat);

  // 两道红色发光环（头尾各一），强化「骨节」分段感
  const ringGeo = new THREE.TorusGeometry(radius * 1.04, radius * 0.16, 8, 22);
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x8b1a1a, emissive: 0x8b1a1a, emissiveIntensity: 0.9, roughness: 0.4, metalness: 0.2,
  });
  for (const zoff of [-height * 0.32, height * 0.32]) {
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.z = zoff;
    seg.add(ring);
  }

  seg.scale.setScalar(taper); // 逐段渐细（头粗尾细）
  balloon.mesh.add(seg);
  balloon.mesh.material.visible = false; // 隐藏程序化球体（碰撞仍靠 position）
  balloon.bodyModel = seg;
  balloon._modelMats = [mat, ringMat]; // 复用受击闪烁路径
  balloon._hasModel = true;
}
