import * as THREE from 'three';
import { MOVE, SKY_BRIGHTNESS, PANO_DOME_YAW, RENDER, SKY_PANO_MIPMAPS } from './constants.js';
import { Carpet } from './carpet.js';
import { EXRLoader } from '../../vendor/EXRLoader.js';

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

// 生成文字精灵工厂(canvasTexture.makeTextSprite)已不再需要：坐标网格移除后无数字标注需求。

export class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.0)); // 降采样，知识库要求
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.xr.enabled = true;
    // 头显实际渲染分辨率倍率（集中式可调：constants.RENDER / userConfig.RENDER.FRAMEBUFFER_SCALE）。
    // 默认 1.0 最稳；原 1.25 在 PICO 4 双目高分下填充率偏重，第3关实测 GPU 99% 掉到 10fps。
    // 若某关流畅且清晰度不足，可在 userConfig 热调到 1.25 提清晰度（更费 GPU）。
    this.renderer.xr.setFramebufferScaleFactor(RENDER.FRAMEBUFFER_SCALE);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = false; // VR 关阴影

    this.scene = new THREE.Scene();

    // 相机放在 playerRig 下，由输入层控制移动
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);

    // 全景天空：懒加载 + 缓存，避免死亡重开重复加载
    this._texLoader = new THREE.TextureLoader();
    this._exrLoader = new EXRLoader();
    this._panoCache = {};
    this._panoLoading = {}; // 在途加载 Promise（去重：同一 url 并发只起一次真实加载）
    this._panoActive = false;
    this._skydome = null; // 全景天空穹顶（环绕原点的大球，用真实网格采样贴图，完整保留 8K + 各向异性）

    this._buildLights();
    this._buildSky();
    this._buildStars();
    this._buildCarpet();          // 玩家脚下飞毯（替代原蓝色活动边界 4×8 + 坐标网格）

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

  // 纹理色彩 / 过滤配置（EXR 与 JPG 不同），抽出供 setSkyPanorama 与 loadSky 复用
  _configurePano(tex, isEXR) {
    if (isEXR) {
      // OpenEXR 为线性 HDR 数据：
      // - 不应用 sRGB 解码（否则会二次提亮），走 DataTexture 默认线性色彩；
      // - DataTexture 默认 flipY=false（与 JPG 的 flipY=true 相反），会导致画面上下颠倒，
      //   故强制 flipY=true 以与 JPG 全景在穹顶球面上的朝向一致；
      // - 开启 mipmap（DataTexture 默认 false，半浮点 WebGL2 可生成）保远距离清晰。
      tex.colorSpace = THREE.NoColorSpace;
      //tex.flipY = true;
      tex.generateMipmaps = true;
    } else {
      // 作为普通 2D 贴图（UVMapping）由穹顶球面 UV 直接采样；
      // 不设 EquirectangularReflectionMapping（那是给环境反射用的，会改采样方式）。
      tex.colorSpace = THREE.SRGBColorSpace;
      // mipmap 开关（SKY_PANO_MIPMAPS）：背景球无需 mip，关闭可省带宽 + 去切换卡顿；minFilter 在下方统一按开关设置
      tex.generateMipmaps = SKY_PANO_MIPMAPS;
    }
    // 各向异性过滤：天空在视野边缘以掠射角显示时仍能保持锐利，减少发糊。
    // 上限钳到 4：最大各向异性(常为 16)在 EXR(70MB) 上纹理带宽压力很大，钳制后肉眼差异极小但省带宽。
    tex.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    // mipmap 开关（SKY_PANO_MIPMAPS）：EXR 始终生成 mip；JPG 由开关决定 → 关闭省带宽+去切换卡顿，true 即回退原行为
    tex.minFilter = (isEXR || SKY_PANO_MIPMAPS) ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
  }

  // 预加载 / 取全景纹理（供预览阶段预加载 + 进度回调，返回 Promise）。
  // 已缓存则直接同步 resolve；在途加载去重（同一 url 并发只起一次真实加载）；
  // 否则按扩展名选 EXR/JPG 加载器，配置后入缓存。
  loadSky(url, onProgress) {
    return new Promise((resolve, reject) => {
      const isEXR = url.toLowerCase().endsWith('.exr');
      const cached = this._panoCache[url];
      if (cached) { onProgress?.(1, 1); resolve(cached); return; }
      // 在途去重：抽卡阶段预热与切关加载可能并发请求同一 pano
      if (this._panoLoading[url]) { this._panoLoading[url].then(resolve, reject); return; }
      const loader = isEXR ? this._exrLoader : this._texLoader;
      const p = new Promise((res2, rej2) => {
        loader.load(
          url,
          (tex) => { this._configurePano(tex, isEXR); this._panoCache[url] = tex; res2(tex); },
          (ev)  => { onProgress?.(ev.loaded, ev.total); },
          (err) => rej2(err)
        );
      });
      this._panoLoading[url] = p;
      p.then(() => { delete this._panoLoading[url]; }, () => { delete this._panoLoading[url]; });
      p.then(resolve, reject);
    });
  }

  // 确保全景纹理完成「下载+解码+GPU 上传(initTexture)」，返回 Promise。
  // 用于切关时强制在穿云窗内完成 GPU 上传，避免首帧渲染才上传造成的卡顿。
  // initTexture 幂等：已上传(_gpuReady)的纹理直接跳过，不重复上传。
  prepareSkyPano(url) {
    return this.loadSky(url).then((tex) => {
      if (!tex._gpuReady) {
        try { this.renderer.initTexture(tex); tex._gpuReady = true; } catch (e) { /* 忽略：首帧自然上传兜底 */ }
      }
      return tex;
    });
  }

  setSkyPanorama(url) {
    const apply = (tex) => {
      if (!this._skydome) {
        const geo = new THREE.SphereGeometry(90, 64, 48);
        const mat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false });
        this._skydome = new THREE.Mesh(geo, mat);
        this._skydome.renderOrder = -1;           // 最先绘制，作为背景层
        this._skydome.frustumCulled = false;      // 永远填满视野，勿被剔除
        this._skydome.rotation.y = PANO_DOME_YAW; // 把 360 照片正前(图中心)对齐玩家初始朝向(-Z)
        this.scene.add(this._skydome);
      }
      this._skydome.material.map = tex;
      // 亮度倍率：skydome 为 MeshBasicMaterial，color 会与贴图相乘 → 实现整体变暗/变亮。
      this._skydome.material.color.setScalar(SKY_BRIGHTNESS);
      this._skydome.material.needsUpdate = true;
      this._skydome.visible = true;

      this.sky.visible = false;                              // 隐藏渐变天空球
      this._starLayers.forEach((l) => { l.visible = false; }); // 隐藏星空（全景自带天空）
      this._panoActive = true;
    };
    const cached = this._panoCache[url];
    // 已缓存且已完成 GPU 上传 → 直接套用（无首帧上传卡顿）；否则先 prepare（含 initTexture）再 apply
    if (cached && cached._gpuReady) { apply(cached); return; }
    this.prepareSkyPano(url).then(apply).catch(() => {}); // 兜底：未预加载/未上传时也能用
  }

  // 退出全景关：恢复渐变球+星空，隐藏穹顶
  clearSkyPanorama() {
    if (this._skydome) this._skydome.visible = false;
    this.sky.visible = true;
    this._starLayers.forEach((l) => { l.visible = true; });
    this._panoActive = false;
  }

  // 关卡开场穿云：环境（天空穹顶 + 地面边界 + 星空）透明度由 0→1 淡入，与云雾动画同步。
  // p: 0=全透明(场景隐没于雾中) → 1=完全显现。英雄模型/传送门本轮不动（避免改动含 transmission 的材质）。
  setEnvOpacity(p) {
    const o = Math.max(0, Math.min(1, p));
    if (this._skydome) {
      this._skydome.material.transparent = true;
      this._skydome.material.opacity = o;
    }
    if (this.carpet) {
      this.carpet.setEnvOpacity(o);  // 飞毯淡入：仅改 uOpacity uniform + 流苏 opacity（不切 transparent，避免重编译卡顿）
    }
    if (this._starLayers) {
      for (const l of this._starLayers) { l.material.transparent = true; l.material.opacity = 0.9 * o; }
    }
  }

  // ====== 穿云淡入：本关「场景物体」透明度 0→1（与云雾进度同步）======
  // 性能要点：material.transparent 的取值变化会触发 three 着色器重编译，
  // 因此「只在登记时切一次 → 每帧仅改 opacity（廉价）→ 结束时一次性恢复」，
  // 绝不在每帧切换 transparent，否则 PICO 上会持续卡顿。
  setFadeRoots(roots) {
    this._restoreFade();                 // 先恢复上一关残留，避免共享材质被永久改写
    this._fadeMats = [];
    this._fadeSeen = new Set();
    for (const r of roots) {
      if (!r) continue;
      r.traverse((o) => {
        const m = o.material;
        if (!m) return;
        for (const mat of (Array.isArray(m) ? m : [m])) {
          if (!mat || this._fadeSeen.has(mat)) continue;  // GLB clone 共享材质：去重，避免重复改写同一材质
          this._fadeSeen.add(mat);
          this._fadeMats.push({ mat, baseOpacity: mat.opacity ?? 1, baseTransparent: !!mat.transparent });
        }
      });
    }
    // 一次性切到透明模式（每关只一次），并从全透明开始
    for (const e of this._fadeMats) { e.mat.transparent = true; e.mat.opacity = 0; }
    this._fadeOn = this._fadeMats.length > 0;
  }

  // 增量登记：GLB 是异步加载的（如传送门），进关瞬间其根节点可能还没加入场景。
  // 云雾期间每帧补登记一次新出现的物体，并立即套用当前进度 p，避免「后半段突然满显」。
  extendFadeRoots(roots, p) {
    if (!this._fadeOn || !this._fadeMats || !this._fadeSeen) return;
    const o = Math.max(0, Math.min(1, p));
    for (const r of roots) {
      if (!r) continue;
      r.traverse((obj) => {
        const m = obj.material;
        if (!m) return;
        for (const mat of (Array.isArray(m) ? m : [m])) {
          if (!mat || this._fadeSeen.has(mat)) continue;  // 已登记过的直接跳过，零重复开销
          this._fadeSeen.add(mat);
          const e = { mat, baseOpacity: mat.opacity ?? 1, baseTransparent: !!mat.transparent };
          this._fadeMats.push(e);
          mat.transparent = true;
          mat.opacity = e.baseOpacity * o;  // 与当前云雾进度对齐
        }
      });
    }
  }

  // p: 0=全透明（隐没于雾中） → 1=完全显现；到 1 即恢复原始材质设置
  setObjectsOpacity(p) {
    if (!this._fadeOn || !this._fadeMats) return;
    const o = Math.max(0, Math.min(1, p));
    if (o >= 1) { this._restoreFade(); return; }
    for (const e of this._fadeMats) e.mat.opacity = e.baseOpacity * o;
  }

  // 恢复所有登记材质到原始状态（切关/退出/淡入结束均调用，幂等）
  _restoreFade() {
    if (!this._fadeMats) return;
    for (const e of this._fadeMats) { e.mat.opacity = e.baseOpacity; e.mat.transparent = e.baseTransparent; }
    this._fadeMats = null;
    this._fadeSeen = null;
    this._fadeOn = false;
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

  // 玩家脚下飞毯：替代原蓝色活动边界，world 固定铺在原点(0,0,0)，尺寸 = 活动区域(MOVE 边界)。
  // 三层混合布料效果见 src/core/carpet.js；第9关玻璃走格子时由 game 调 setVisible(false) 隐藏。
  _buildCarpet() {
    this.carpet = new Carpet(this.scene);
  }

  // 场地坐标系已移除：玩家脚下由飞毯(4×8)作为地板与空间参照，不再绘制网格/坐标线/数字标注。

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
