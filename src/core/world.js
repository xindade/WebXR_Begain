import * as THREE from 'three';
import { MOVE } from './constants.js';
import { makeTextSprite } from './canvasTexture.js';

// 世界：渲染器、场景、相机、灯光、天空、星空
// 多平台 WebXR 标准实现，无厂商专属 hack。

const SKY_VERT = `
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const SKY_FRAG = `
uniform vec3 topColor;
uniform vec3 bottomColor;
varying vec3 vWorldPos;
void main() {
  float h = normalize(vWorldPos).y * 0.5 + 0.5;
  gl_FragColor = vec4(mix(bottomColor, topColor, smoothstep(0.0, 1.0, h)), 1.0);
}`;

// 生成文字精灵：始终面向相机，用于坐标系数字标注（复用 core/canvasTexture.js 工厂）
function _textSprite(text, color) {
  return makeTextSprite({ text, color });
}

export class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.0)); // 降采样，知识库要求
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.xr.enabled = true;
    // 提升头显实际渲染分辨率：默认 1.0 偏低，导致全景天空/整体发糊。
    // 1.5 显著变清晰（PICO 4 可承受；若实测掉帧可降到 1.25）。
    this.renderer.xr.setFramebufferScaleFactor(1.5);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = false; // VR 关阴影

    this.scene = new THREE.Scene();

    // 相机放在 playerRig 下，由输入层控制移动
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);

    // 全景天空：懒加载 + 缓存，避免死亡重开重复加载
    this._texLoader = new THREE.TextureLoader();
    this._panoCache = {};
    this._panoActive = false;
    this._skydome = null; // 全景天空穹顶（环绕原点的大球，用真实网格采样贴图，完整保留 8K + 各向异性）

    this._buildLights();
    this._buildSky();
    this._buildStars();
    this._buildBoundary();
    this._buildCoordGrid();

    window.addEventListener('resize', () => this._onResize());
  }

  _buildLights() {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x404060, 1.1);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(3, 8, 2);
    this.scene.add(dir);
  }

  _buildSky() {
    const geo = new THREE.SphereGeometry(90, 32, 16);
    this._skyUniforms = {
      topColor: { value: new THREE.Color(0x1a2a6c) },
      bottomColor: { value: new THREE.Color(0xff9a76) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this._skyUniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.scene.add(this.sky);
  }

  // 知识库：三预设（日/夜/黄昏）指数缓动过渡
  setSkyMood(mood) {
    // 若上一关是全景天空，先复原渐变球+星空，再切回渐变
    if (this._panoActive) this.clearSkyPanorama();
    const presets = {
      day:   { top: 0x4aa3ff, bottom: 0xbfe3ff },
      dusk:  { top: 0x1a2a6c, bottom: 0xff9a76 },
      night: { top: 0x05060f, bottom: 0x2a2a5a },
    };
    const p = presets[mood] || presets.dusk;
    this._skyTarget = {
      top: new THREE.Color(p.top),
      bottom: new THREE.Color(p.bottom),
    };
  }

  // 全景天空：用等距柱状全景图贴到一个「环绕原点的大球穹顶」上，
  // 用真实网格采样器渲染（不走 scene.background 的内部 equirect→平面 quad 转换，
  // 该转换会绕开各向异性、且受帧缓冲倍率限制导致发糊）。
  // 纹理缓存，重复进入同一关不重复加载。url 为同源本地路径（离线 PICO）。
  setSkyPanorama(url) {
    let tex = this._panoCache[url];
    if (!tex) {
      tex = this._texLoader.load(url);
      // 作为普通 2D 贴图（UVMapping）由穹顶球面 UV 直接采样；
      // 不设 EquirectangularReflectionMapping（那是给环境反射用的，会改采样方式）。
      tex.colorSpace = THREE.SRGBColorSpace;
      // 各向异性过滤：天空在视野边缘以掠射角显示时仍能保持锐利，减少发糊
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      this._panoCache[url] = tex;
    }

    if (!this._skydome) {
      const geo = new THREE.SphereGeometry(90, 64, 48);
      const mat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false });
      this._skydome = new THREE.Mesh(geo, mat);
      this._skydome.renderOrder = -1;           // 最先绘制，作为背景层
      this._skydome.frustumCulled = false;      // 永远填满视野，勿被剔除
      this.scene.add(this._skydome);
    }
    this._skydome.material.map = tex;
    this._skydome.material.needsUpdate = true;
    this._skydome.visible = true;

    this.sky.visible = false;                              // 隐藏渐变天空球
    this._starLayers.forEach((l) => { l.visible = false; }); // 隐藏星空（全景自带天空）
    this._panoActive = true;
  }

  // 退出全景关：恢复渐变球+星空，隐藏穹顶
  clearSkyPanorama() {
    if (this._skydome) this._skydome.visible = false;
    this.sky.visible = true;
    this._starLayers.forEach((l) => { l.visible = true; });
    this._panoActive = false;
  }

  _buildStars() {
    this._starLayers = [];
    const make = (count, radius, size) => {
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const r = radius * (0.85 + Math.random() * 0.15);
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        pos[i * 3 + 1] = Math.abs(r * Math.cos(phi)) * 0.9 + 2;
        pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({ color: 0xffffff, size, sizeAttenuation: true, transparent: true, opacity: 0.9 });
      const pts = new THREE.Points(geo, mat);
      this.scene.add(pts);
      this._starLayers.push(pts);
      return pts;
    };
    make(160, 85, 0.5);
    make(130, 80, 0.35);
    make(100, 75, 0.25);
  }

  _updateSky(dt) {
    if (this._panoActive) return; // 全景关：跳过渐变/星空缓动
    if (!this._skyTarget) return;
    const k = Math.min(1, dt * 0.6); // 指数缓动
    this._skyUniforms.topColor.value.lerp(this._skyTarget.top, k);
    this._skyUniforms.bottomColor.value.lerp(this._skyTarget.bottom, k);
    const dayness = this._skyTarget.top.getHex() === 0x4aa3ff ? 1 : (this._skyTarget.top.getHex() === 0x05060f ? 0 : 0.5);
    this._starLayers.forEach(l => { l.material.opacity = THREE.MathUtils.lerp(l.material.opacity, 1 - dayness, k); });
  }

  update(dt) {
    this._updateSky(dt);
  }

  // 玩家可移动区域占位：以 rig 原点(0,0,0) 为中心、BOUND_X*2 × BOUND_Z*2 的长方体地板。
  // 半透明板 + 高亮边框，让玩家在 VR 里清楚看到脚下行动边界（临时占位，后续可换美术边界）。
  _buildBoundary() {
    const w = MOVE.BOUND_X * 2;
    const d = MOVE.BOUND_Z * 2;
    const geo = new THREE.BoxGeometry(w, 0.1, d);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x4dabf7, transparent: true, opacity: 0.14, depthWrite: false,
    });
    this.boundary = new THREE.Mesh(geo, mat);
    this.boundary.position.set(0, 0.05, 0); // 贴地
    this.scene.add(this.boundary);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x4dabf7 })
    );
    edges.position.copy(this.boundary.position);
    this.scene.add(edges);
  }

  // 场地坐标系：以 rig 原点(0,0,0) 为中心，0.5m 为单位的网格 + 数字标注。
  // X 轴范围 [-BOUND_X, BOUND_X]，Z 轴范围 [-BOUND_Z, BOUND_Z]。
  // 用法：玩家移动被钳制在该范围内，网格帮其在 VR 里建立空间参照。
  _buildCoordGrid() {
    const step = 0.5;
    const xMin = -MOVE.BOUND_X, xMax = MOVE.BOUND_X;
    const zMin = -MOVE.BOUND_Z, zMax = MOVE.BOUND_Z;
    const y = 0.06; // 略高于边界地板(0.05)，避免 z-fighting

    // --- 1) 淡色网格线（每 0.5m 一条）---
    const gridPts = [];
    for (let x = xMin; x <= xMax + 1e-6; x += step) {
      const vx = Math.round(x * 2) / 2;
      gridPts.push(vx, y, zMin, vx, y, zMax);
    }
    for (let z = zMin; z <= zMax + 1e-6; z += step) {
      const vz = Math.round(z * 2) / 2;
      gridPts.push(xMin, y, vz, xMax, y, vz);
    }
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
    this.scene.add(new THREE.LineSegments(
      gridGeo,
      new THREE.LineBasicMaterial({ color: 0x2c4a6e, transparent: true, opacity: 0.55 })
    ));

    // --- 2) 坐标轴加亮：X 轴(红) 沿 z=0；Z 轴(绿) 沿 x=0 ---
    const axisPts = [
      xMin, y, 0, xMax, y, 0,   // X 轴
      0, y, zMin, 0, y, zMax,   // Z 轴
    ];
    const axisGeo = new THREE.BufferGeometry();
    axisGeo.setAttribute('position', new THREE.Float32BufferAttribute(axisPts, 3));
    this.scene.add(new THREE.LineSegments(
      axisGeo,
      new THREE.LineBasicMaterial({ color: 0xffd43b, transparent: true, opacity: 0.9 })
    ));

    // --- 3) 数字标注（沿两轴每 0.5m 一个，单位：米）---
    const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
    const labelY = 0.22;
    for (let x = xMin; x <= xMax + 1e-6; x += step) {
      const vx = Math.round(x * 2) / 2;
      if (vx === 0) continue; // 原点单独标
      const sp = _textSprite(fmt(vx), '#ff8787');
      sp.position.set(vx, labelY, 0);
      this.scene.add(sp);
    }
    for (let z = zMin; z <= zMax + 1e-6; z += step) {
      const vz = Math.round(z * 2) / 2;
      if (vz === 0) continue;
      const sp = _textSprite(fmt(vz), '#69db7c');
      sp.position.set(0, labelY, vz);
      this.scene.add(sp);
    }

    // --- 4) 原点标记 + 标注 “0” ---
    const origin = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.12, 0.12),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    origin.position.set(0, y + 0.03, 0);
    this.scene.add(origin);
    const oLabel = _textSprite('0', '#ffffff');
    oLabel.position.set(0, labelY + 0.05, 0);
    this.scene.add(oLabel);
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  get xr() { return this.renderer.xr; }
  get isPresenting() { return this.renderer.xr.isPresenting; }
}
