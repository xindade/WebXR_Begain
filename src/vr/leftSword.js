import * as THREE from 'three';
import { LASER_SWORD, INPUT } from '../core/constants.js';

const D2R = THREE.MathUtils.degToRad;

// ============ 着色器（文档《激光剑方案-接入文档》2.3/2.4/2.5，r168 验证可用）============
// 顶点：三层圆柱共用，法线经 normalMatrix 处理非均匀缩放，视线方向存 vViewDir。
const bladeVert = /* glsl */`
varying vec3 vNormal;
varying vec3 vViewDir;
varying vec2 vUv;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormal  = normalize(normalMatrix * normal);
  vViewDir = normalize(-mv.xyz);  // 视空间中相机在原点，指向相机为 -mv.xyz
  vUv = uv;
  gl_Position = projectionMatrix * mv;
}
`;

// 核心片元：正对相机最白、掠射边缘偏剑刃色；沿剑身能量流动；末尾做色彩空间转换。
const coreFrag = /* glsl */`
uniform vec3 uCoreColor;
uniform vec3 uEdgeColor;
uniform float uTime;
varying vec3 vNormal;
varying vec3 vViewDir;
varying vec2 vUv;
void main() {
  float f = abs(dot(normalize(vNormal), normalize(vViewDir)));
  vec3 col = mix(uEdgeColor, uCoreColor, pow(f, 0.65));
  float flow = 0.94 + 0.06 * sin(vUv.y * 26.0 - uTime * 9.0);
  gl_FragColor = vec4(col * flow, 1.0);
  #include <colorspace_fragment>
}
`;

// 辉光/外晕片元：pow(|dot(N,V)|,k)（非经典 fresnel）让正对相机最亮、边缘淡出，外轮廓无硬边（坑#1）。
// 加性混合下最终贡献 = uColor * a（坑#2：输出 vec4(uColor, a) 而非 vec4(uColor*a, a)）。
const glowFrag = /* glsl */`
uniform vec3 uColor;
uniform float uPower;
uniform float uIntensity;
uniform float uTime;
varying vec3 vNormal;
varying vec3 vViewDir;
varying vec2 vUv;
void main() {
  float f = abs(dot(normalize(vNormal), normalize(vViewDir)));
  float a = pow(f, uPower) * uIntensity;
  a *= 0.9 + 0.1 * sin(vUv.y * 18.0 - uTime * 7.0);
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}
`;

// 关键：把圆柱底面平移到 y=0，使 scale.y 从柄口向外长（否则两头一起长，坑#3）。
function unitCylinder(radialSeg, openEnded) {
  const g = new THREE.CylinderGeometry(1, 1, 1, radialSeg, 1, openEnded);
  g.translate(0, 0.5, 0);
  return g;
}

const easeOutBack = (t) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// 左手柄激光剑：程序化 shader 光剑（替代旧 Model/激光剑.glb 模型版）。
// 选卡装备后常驻左手（迷你态≈15cm 巴掌大小短剑）；按左手柄 grip 激活「5秒伤害状态」(setActive)，
// game.js 每帧用 getBlade() 取发射口/剑尖世界坐标做线段-球命中。伤害范围 = 当前动画剑刃长（0.05→20m）。
// 挂接模式参照 rightGun.js：每帧尝试挂载到左手柄 grip，挂上后置 _attached 跳过（控制器连接前 grip 为 null）。
export class LeftSword {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();   // 持有层：LASER_SWORD 变换作用在此层（SCALE=1 仅承载挂手柄位姿）
    this._attached = false;          // 是否已挂到左手柄（幂等）
    this._equipped = false;          // 是否装备（选卡后 true → 可见）
    this._active = false;            // 是否处于「5秒伤害状态」(用于拒绝重复释放)
    this._readyForDamage = false;    // 完全展开后才 true（完全展开后才结算伤害）
    // 伸缩状态（替代旧 phase 状态机）
    this._rawT = 0;                  // 线性进度 0=迷你 1=展开
    this._dir = 0;                   // +1 展开中 / -1 收回中 / 0 静止
    this._bladeLen = LASER_SWORD.BLADE_LEN_MIN;
    this._bladeR = LASER_SWORD.BLADE_R_MIN;
    this._hiltS = 1;
    this._eased = 0;
    this._uTime = { value: 0 };      // 共享 uniform，仅 core/glow/halo/tip/emitter 引用同一对象
    this.audio = null;               // 音效管理器（由 game.js 注入，用于激光嗡鸣）
    this._humOn = false;            // 激光嗡鸣当前是否在响
    this._build();
    this.root.visible = false;       // 未装备时不可见
  }

  // 程序化构建剑柄 + 剑刃(三层圆柱+剑尖/发射口光球) + 剑刃点光
  _build() {
    const C = LASER_SWORD;
    const bladeColor = new THREE.Color(C.BLADE_COLOR);
    const coreColor = new THREE.Color(C.CORE_COLOR);

    const makeBladeMaterial = (frag, extra) => new THREE.ShaderMaterial({
      uniforms: Object.assign({ uTime: this._uTime }, extra),
      vertexShader: bladeVert,
      fragmentShader: frag,
      transparent: true,
      blending: THREE.AdditiveBlending,  // 加性混合（坑#2）
      depthWrite: false,                 // 不写深度，避免遮挡后面（坑#1）
      side: THREE.FrontSide,
    });

    // —— 剑柄（程序化，无外部模型；hiltGroup 整体由 hiltS 缩放）——
    this.hiltGroup = new THREE.Group();
    const matDark = new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.9, roughness: 0.38 });
    const matSilver = new THREE.MeshStandardMaterial({ color: 0xb9bec7, metalness: 1.0, roughness: 0.24 });
    const matGold = new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 1.0, roughness: 0.30 });
    const addPart = (rB, rT, h, y, mat) => {
      const g = new THREE.CylinderGeometry(rT, rB, h, 24, 1);  // CylinderGeometry(radiusTop, radiusBottom, ...)
      g.translate(0, y + h / 2, 0);
      this.hiltGroup.add(new THREE.Mesh(g, mat));
    };
    addPart(0.0110, 0.0130, 0.014, 0.000, matSilver);   // 尾盖
    addPart(0.0135, 0.0135, 0.056, 0.014, matDark);     // 握把主体
    for (const y of [0.024, 0.034, 0.044]) addPart(0.0144, 0.0144, 0.0035, y, matGold); // 三道握把环
    addPart(0.0140, 0.0165, 0.016, 0.070, matSilver);   // 颈部
    addPart(0.0175, 0.0175, 0.014, 0.086, matGold);     // 发射口沿（半径 1.75cm）
    this.root.add(this.hiltGroup);

    // —— 剑刃（bladeGroup 原点=发射口，沿 +Y 生长）——
    this.bladeGroup = new THREE.Group();
    this.root.add(this.bladeGroup);

    // 核心：不透明写深度，DoubleSide
    this.coreMesh = new THREE.Mesh(unitCylinder(20, false), new THREE.ShaderMaterial({
      uniforms: {
        uTime: this._uTime,
        uCoreColor: { value: coreColor },
        uEdgeColor: { value: bladeColor },
      },
      vertexShader: bladeVert,
      fragmentShader: coreFrag,
      side: THREE.DoubleSide,
    }));
    this.bladeGroup.add(this.coreMesh);

    this.glowMesh = new THREE.Mesh(unitCylinder(20, true), makeBladeMaterial(glowFrag, {
      uColor: { value: bladeColor }, uPower: { value: C.GLOW_POWER }, uIntensity: { value: C.GLOW_INTENSITY },
    }));
    this.haloMesh = new THREE.Mesh(unitCylinder(16, true), makeBladeMaterial(glowFrag, {
      uColor: { value: bladeColor }, uPower: { value: C.HALO_POWER }, uIntensity: { value: C.HALO_INTENSITY },
    }));
    this.bladeGroup.add(this.glowMesh, this.haloMesh);

    // 剑尖 / 发射口光球：遮掩两端硬切及刃 vs 口沿的粗细差
    this.tipMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), makeBladeMaterial(glowFrag, {
      uColor: { value: bladeColor }, uPower: { value: 1.6 }, uIntensity: { value: 0.45 },
    }));
    this.emitterMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), makeBladeMaterial(glowFrag, {
      uColor: { value: bladeColor }, uPower: { value: 1.5 }, uIntensity: { value: 0.50 },
    }));
    this.bladeGroup.add(this.tipMesh, this.emitterMesh);

    // —— 剑刃点光：展开时点亮周围环境（坑#4以外的"发光感"关键）——
    this.bladeLight = new THREE.PointLight(C.BLADE_COLOR, 0, C.BLADE_LIGHT_DIST);
    this.root.add(this.bladeLight);

    this._applyBlade();  // 初始化为迷你态
  }

  // 注入音效管理器（game.js 在解锁音频后调用）
  setAudio(audio) { this.audio = audio; }

  // 每帧调用：幂等挂到左手柄，并从 LASER_SWORD 配置实时应用变换（便于控制台/刷新即时调参）
  update(dt, input) {
    this._uTime.value += dt;          // dt 已在 game.js 钳制 ≤0.05
    this._updateBlade(dt);
    this._applyTransform();
    this._updateLaserHum();           // 激光剑嗡鸣：剑刃出现(展开)时响起、消失(收回)时淡出
    if (this._attached) return;
    const anchor = input?.getGrip(INPUT.SWAP_HANDS ? 'right' : 'left');   // 左手握把空间（SWAP_HANDS 时交换到右手柄以校正 PICO 左右反）
    if (anchor) { anchor.add(this.root); this._attached = true; }
  }

  // 展开/收回动画：推进线性进度 → 缓动(easeOutBack 展开超调 / easeInOutCubic 收回) → 插值三量 → 应用
  _updateBlade(dt) {
    const C = LASER_SWORD;
    if (this._dir !== 0) {
      this._rawT += (this._dir * dt) / C.EXTEND_TIME;
      if (this._rawT >= 1) { this._rawT = 1; this._dir = 0; if (this._active) this._readyForDamage = true; } // 完全展开 → 才开始生效伤害
      else if (this._rawT <= 0) { this._rawT = 0; this._dir = 0; this._active = false; this._readyForDamage = false; }
    }
    const eased = this._dir >= 0 ? easeOutBack(this._rawT) : easeInOutCubic(this._rawT);
    const e = Math.max(0, eased);     // easeOutBack 峰值 ~1.10 允许超调但不能为负
    this._bladeLen = C.BLADE_LEN_MIN + (C.BLADE_LEN_MAX - C.BLADE_LEN_MIN) * e;
    this._bladeR = C.BLADE_R_MIN + (C.BLADE_R_MAX - C.BLADE_R_MIN) * e;
    this._hiltS = 1 + (C.HILT_SCALE_EXT - 1) * e;
    this._eased = e;
    this._applyBlade();
  }

  // 把当前 _bladeLen/_bladeR/_hiltS 应用到各子网格
  _applyBlade() {
    const C = LASER_SWORD;
    const e = this._eased;
    this.hiltGroup.scale.setScalar(this._hiltS);
    this.bladeGroup.position.y = C.HILT_LEN * this._hiltS;   // 剑刃起点跟随放大后的柄口（坑#4）
    this.coreMesh.scale.set(this._bladeR, this._bladeLen, this._bladeR);
    this.glowMesh.scale.set(this._bladeR * C.GLOW_SCALE, this._bladeLen, this._bladeR * C.GLOW_SCALE);
    this.haloMesh.scale.set(this._bladeR * C.HALO_SCALE, this._bladeLen, this._bladeR * C.HALO_SCALE);
    this.tipMesh.position.y = this._bladeLen;
    this.tipMesh.scale.setScalar(this._bladeR * 2.2);
    this.emitterMesh.position.y = 0;
    this.emitterMesh.scale.setScalar(this._bladeR * 1.4);
    // 剑刃环境光：展开时点亮周围
    this.bladeLight.position.set(0, C.HILT_LEN * this._hiltS + this._bladeLen * 0.35, 0);
    this.bladeLight.intensity = C.BLADE_LIGHT_MAX * Math.min(e, 1);
  }

  _applyTransform() {
    this.root.position.set(LASER_SWORD.POSITION.x, LASER_SWORD.POSITION.y, LASER_SWORD.POSITION.z);
    this.root.rotation.set(D2R(LASER_SWORD.ROTATION.x), D2R(LASER_SWORD.ROTATION.y), D2R(LASER_SWORD.ROTATION.z));
    this.root.scale.setScalar(LASER_SWORD.SCALE); // 恒等(=1.0)；剑尺寸由子网格 scale 决定，不再 × 动画系数
  }

  // 激光剑嗡鸣：剑刃有任何伸出(_rawT>0=激光"出现")→ 起 hum；音量随展开程度 _eased swell；
  // 完全收回(_rawT=0=激光"消失")→ 停 hum。声音随剑出现/消失自然淡入淡出。
  _updateLaserHum() {
    if (!this.audio) return;
    const visible = this._rawT > 0;
    if (visible && !this._humOn) {
      this.audio.startLaserHum('sword');
      this._humOn = true;
    }
    if (this._humOn) {
      this.audio.setLaserHumLevel('sword', this._eased); // 音量随展开程度（0→1）
      if (!visible) {
        this.audio.stopLaserHum('sword');
        this._humOn = false;
      }
    }
  }

  // 选卡装备/卸下：控制可见性（未装备时同时结束伤害状态 + 平滑收回）
  setEquipped(v) {
    this._equipped = !!v;
    this.root.visible = this._equipped;
    if (!this._equipped) {
      this._active = false;
      this._dir = -1;                 // 平滑收回
      this._readyForDamage = false;
    }
  }

  // 激活/结束「5秒伤害状态」（仅改状态标志，不改变可见性——装备后始终可见）
  setActive(v) {
    const on = !!v && this._equipped;
    if (on) {
      this._dir = 1;                  // 开始展开
      this._readyForDamage = false;
      this._active = true;           // 标记激活态（用于拒绝重复释放）
    } else {
      // 结束：若还在展开/展开中 → 平滑收回
      if (this._rawT > 0 || this._dir !== 0) {
        this._dir = -1;
        this._readyForDamage = false;
      }
      this._active = false;          // 伤害状态结束（实际伤害窗口由 game.js 计时控制）
    }
  }

  get active() { return this._active; }
  get readyForDamage() { return this._readyForDamage; }

  // 取剑刃世界线段：hilt=发射口(bladeGroup 原点)，tip=发射口 + 本地 +Y 旋转到世界 × 当前剑刃长。
  // 命中线段长度 = 当前动画剑刃长（0.05→20m），与可见剑刃完全一致。
  getBlade(outHilt, outTip) {
    this.bladeGroup.updateWorldMatrix(true, false);
    this.bladeGroup.getWorldPosition(outHilt);
    this.bladeGroup.getWorldQuaternion(_q);
    _axis.set(0, 1, 0).applyQuaternion(_q);
    outTip.copy(outHilt).addScaledVector(_axis, this._bladeLen * LASER_SWORD.SCALE);
  }
}

const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();
