// DepthSprite —— 用 2D 图 + 深度图 + 自定义着色器，在 VR 中做出真实立体视差。
// 核心：视差偏移 = dot(viewDir, 平面right/up) * depth * depthScale。
// XR 下 three 会把 cameraPosition 设为当前眼世界坐标（逐眼不同）→ 左右眼天然产生双眼视差。
// 从沙盒（图片测试/depthSprite.js）移植，新增 uFlash 受击白闪。
import * as THREE from 'three';

// 创建深度视差精灵材质（GLSL3）
export function createDepthSpriteMaterial({
  albedo,
  depth,
  frameCount = 1,
  cols = 1,
  rows = 1,
  depthScale = 0.08,
}) {
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: false, // 不透明 + discard：能与真实几何互遮，零排序问题
    depthTest: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    uniforms: {
      uAlbedo: { value: albedo },
      uDepth: { value: depth },
      uFrame: { value: 0 },
      uFrameCount: { value: frameCount },
      uCols: { value: cols },
      uRows: { value: rows },
      uDepthScale: { value: depthScale },
      uDebugDepth: { value: 0 },
      uFlash: { value: 0 },               // 受击/回血闪烁强度 0..1
    uFlashColor: { value: new THREE.Color(1, 1, 1) },  // 闪烁色（第四十九修）：受击=白 / 回血=绿
      uPlaneRight: { value: new THREE.Vector3(1, 0, 0) },
      uPlaneUp: { value: new THREE.Vector3(0, 1, 0) },
    },
    vertexShader: /* glsl */ `
      out vec2 vUv;
      out vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D uAlbedo;   // 精灵图 sheet（RGBA，alpha 作硅影遮罩）
      uniform sampler2D uDepth;    // 深度 sheet，.r = 0(平面)..1(最凸)
      uniform float uFrame, uFrameCount, uCols, uRows, uDepthScale, uDebugDepth, uFlash;
  uniform vec3 uFlashColor;
      uniform vec3 uPlaneRight;    // 平面世界 right（yaw billboard 时每帧更新）
      uniform vec3 uPlaneUp;       // 平面世界 up（通常 (0,1,0)）
      in vec2 vUv;
      in vec3 vWorldPos;
      out vec4 fragColor;

      // linear -> sRGB 编码（自定义 ShaderMaterial 不会由 three 自动编码，需手动对齐内置材质）
      vec3 sRGBTransferOETF(vec3 c) {
        vec3 lo = c * 12.92;
        vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
        return mix(lo, hi, step(vec3(0.0031308), c));
      }

      // 把单帧 uv 映射到 sheet 中第 f 帧的格子
      vec2 frameUV(vec2 uv, float f) {
        float col = mod(f, uCols);
        float row = floor(f / uCols);
        row = (uRows - 1.0) - row;              // sheet 顶部为第 0 行，纹理原点在左下 → 翻转
        vec2 cell = vec2(1.0 / uCols, 1.0 / uRows);
        return (vec2(col, row) + uv) * cell;
      }

      void main() {
        vec2 uv = frameUV(vUv, uFrame);
        float depth = texture(uDepth, uv).r;

        // 逐眼：XR 下 cameraPosition 由 three 设为当前眼世界坐标（非 XR 时为单相机）
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        // 转 viewDir 到平面局部空间，yaw 朝向后仍正确
        vec2 parallax = vec2(dot(viewDir, uPlaneRight), dot(viewDir, uPlaneUp))
                        * depth * uDepthScale;
        vec2 suv = uv + parallax;

        // 调试：直接把深度图当灰度显示，确认深度贴图正确（0=平面 1=最凸）
        if (uDebugDepth > 0.5) {
          fragColor = vec4(vec3(depth), 1.0);
          return;
        }

        // 越界丢弃：防止视差采样到相邻帧
        vec2 cellMin = vec2(floor(uv.x * uCols), floor(uv.y * uRows)) / vec2(uCols, uRows);
        vec2 cellMax = cellMin + vec2(1.0 / uCols, 1.0 / uRows);
        if (suv.x < cellMin.x || suv.x > cellMax.x || suv.y < cellMin.y || suv.y > cellMax.y)
          discard;

        vec4 tex = texture(uAlbedo, suv);
        if (tex.a < 0.5) discard;             // alpha 硅影遮罩
        vec3 col = sRGBTransferOETF(tex.rgb); // 手动 sRGB 编码，与左侧真实 GLB 对齐
        col = mix(col, uFlashColor, uFlash);  // 受击白闪 / 回血绿闪（色由 uFlashColor 决定，第四十九修）
        fragColor = vec4(col, 1.0);           // 不透明 → 像真实几何体参与深度遮挡
      }
    `,
  });
  return mat;
}

// 模块级临时量：faceYaw 每帧每立绘调用，避免 new Vector3 的 GC 压力
const _dsRight = new THREE.Vector3();
const _dsUp    = new THREE.Vector3();

// ---------------------------------------------------------------------------
// 立绘几何体：按 size 共享（第五十二修）
//
// 为什么不能逐实例 new PlaneGeometry：
//   · 同屏 N 只同型立绘 = N 个几何体 + N 次「首次渲染」时的 buffer 上传；
//   · 更要紧的是 three 的 **VAO 缓存键是「geometry.id → program.id」**（WebGLBindingStates，
//     **不含 material**）⇒ N 个不同的 geometry 就会各建一个 VAO，每帧 N 次 bindVertexArray。
//     几何体只由 size 决定，按 size 共享即可把整类立绘压到「1 个几何体 + 1 个 VAO」。
//
// 为什么材质**不**共享：
//   uFrame / uPlaneRight / uPlaneUp / uFlash / uFlashColor 全是逐实例的（各自的动画帧、朝向、
//   受击闪光）—— 共享会让所有怪同帧动画、同时闪白。纹理与 program 本来就是共享的（纹理来自
//   glbCapture 的 _capCache，program 由 three 按着色器源码去重），所以这里只省几何体，不动材质。
//
// 引用计数：dispose 是逐实例调的（死亡 / 切关 / 重开都会走），几何体必须等最后一个用户走了再释放。
const _geoCache = new Map();   // key -> { key, geo, refs }

function acquireGeometry(size) {
  const key = Number(size).toFixed(3);   // 精度到 mm 即可：浮点误差不该产生第二份几何体
  let e = _geoCache.get(key);
  if (!e) {
    e = { key, geo: new THREE.PlaneGeometry(Number(key), Number(key)), refs: 0 };
    _geoCache.set(key, e);
  }
  e.refs++;
  return e;
}

function releaseGeometry(e) {
  if (!e) return;
  if (--e.refs > 0) return;   // 还有用户在用它
  _geoCache.delete(e.key);
  e.geo.dispose();
}

/** 仅供单测：当前常驻的共享几何体份数（生产代码不调用）。 */
export function _sharedGeometryCount() { return _geoCache.size; }

// DepthSprite —— 一张图（带深度）组成一个可动画、可 yaw 朝向的平面
export class DepthSprite {
  constructor({
    albedo,
    depth,
    frameCount = 1,
    cols = 1,
    rows = 1,
    depthScale = 0.08,
    size = 1.6,
  }) {
    this.frameCount = frameCount;
    this.cols = cols;
    this.rows = rows;
    this.time = 0;
    this._disposed = false;
    // 材质逐实例（uFrame/uPlaneRight/uPlaneUp/uFlash 都不同）；几何体按 size 共享（见上方 _geoCache）
    this.material = createDepthSpriteMaterial({ albedo, depth, frameCount, cols, rows, depthScale });
    this._geo = acquireGeometry(size);
    this.geometry = this._geo.geo;
    this.mesh = new THREE.Mesh(this.geometry, this.material);
  }

  setFrame(f) { this.material.uniforms.uFrame.value = f; }
  setDepthScale(s) { this.material.uniforms.uDepthScale.value = s; }
  /** @param {number} v 强度 0..1  @param {number} [colorHex] 闪烁色（缺省保持上一次；受击走白、回血走绿） */
  setFlash(v, colorHex = null) {
    this.material.uniforms.uFlash.value = v;
    if (colorHex != null) this.material.uniforms.uFlashColor.value.setHex(colorHex);
  }

  // 推进动画帧（循环播放 idle/attack）
  advance(dt, fps = 12) {
    this.time += dt;
    const f = Math.floor(this.time * fps) % this.frameCount;
    this.setFrame(f);
  }

  // yaw billboard：仅绕 Y 转向目标，并把平面 right/up 写入 uniform（视差在转向后仍正确）
  faceYaw(targetPos) {
    const m = this.mesh;
    const dx = targetPos.x - m.position.x;
    const dz = targetPos.z - m.position.z;
    m.rotation.y = Math.atan2(dx, dz);
    m.updateMatrixWorld();
    _dsRight.set(1, 0, 0).applyQuaternion(m.quaternion);
    _dsUp.set(0, 1, 0).applyQuaternion(m.quaternion);
    this.material.uniforms.uPlaneRight.value.copy(_dsRight);
    this.material.uniforms.uPlaneUp.value.copy(_dsUp);
  }

  dispose() {
    if (this._disposed) return;   // 幂等：重复调用不能把共享几何体的引用数多减一次
    this._disposed = true;
    this.material.dispose();      // 材质是逐实例的，必须各自释放
    releaseGeometry(this._geo);   // 几何体共享 ⇒ 交给引用计数决定何时真正回收
    this._geo = null;
    this.geometry = null;         // 置空而不是留个已释放的引用，防别人再 dispose 一次（会误杀同类）
  }
}
