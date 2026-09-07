import * as THREE from 'three';
import { MOVE } from './constants.js';

// 飞毯（魔法地毯）布料效果 —— 接入自《飞毯方案-接入文档》
// 三层混合：① 刚性主体(PlaneGeometry + 程序化波斯花纹) ② 顶点着色器波纹(GPU，零CPU) ③ 边缘流苏(Verlet粒子链)
// 本接入：作为「玩家脚下 4×8 活动区域」的地面平台，world 固定铺在原点(0,0,0)，尺寸 = 活动区域(MOVE 边界)。
// 第9关玻璃走格子时由 game 调 setVisible(false) 隐藏，保留脚下玻璃区域。
// 参考：桌面 Demo 已验证（G:\02_AI\WebXR_MoKuai\地毯测试\）；性能数据见文档（每帧 CPU ≈0.03~0.06ms，0 次/帧分配）。

// ===== 尺寸与幅度（与活动区域严格对齐，改 MOVE 边界即自动跟随）=====
const CARPET_W = MOVE.BOUND_X * 2;   // 宽(X) = 2×2 = 4.0m
const CARPET_D = MOVE.BOUND_Z * 2;   // 纵深(Z，沿飞行前进方向) = 2×4 = 8.0m
const BASE_AMP = 0.16;               // 波纹基础幅度（与滑块相乘）
const REF_LEN  = 2.0;                // 调参时的参考纵深（当初把幅度调成 0.5 时的纵深）
const AMP_SCALE = CARPET_D / REF_LEN; // 8/2 = 4：幅度随尺寸等比，大尺寸才"看得动"
const AMP_SLIDER = 0.5;              // 运行时幅度倍率（文档已确认 0.5）
const FOOT_OFFSET = 0.0;             // 地毯平面基准高度（玩家 rig 在 y=0，脚底即贴毯面）

// 飞毯运动与玩家移动完全无关：uSpeed 用恒定基线 + 缓慢自震荡（仅制造"活"感，不随玩家速度突变）
const CARPET_BASE_SPEED    = 0.35;   // 运动基线速度（恒定，不依赖玩家移动）
const CARPET_SPEED_BREATH  = 0.12;   // 缓慢自震荡幅度（仅制造"活"感，不随玩家突变）
const CARPET_BREATH_FREQ   = 0.4;    // 自震荡频率(rad/s)，慢 → 平滑无抖动

// ===== 边缘流苏参数 =====
const TASSELS_PER_EDGE = 15;                  // 每边流苏数量（前后缘各 15）
const TASSEL_POINTS    = 7;                   // 每条链粒子数（含锚点）
const TASSEL_LEN = CARPET_D * 0.13;           // 流苏总长（取纵深 13%，随尺寸等比）
const SEG_LEN    = TASSEL_LEN / (TASSEL_POINTS - 1);
const GRAVITY    = -14.0;                      // 重力加速度
const DAMPING    = 0.985;                      // 速度阻尼
const AMBIENT_WIND = 2.2;                      // 环境风力（沿 -Z），静止时流苏仍飘动
const TASSEL_INSET = 0.15;                     // 相对左右边缘内缩，避免压在边线上

// —— 顶点着色器（波纹 + 解析法线）——
const CARPET_VERT = `
uniform float uTime;
uniform float uSpeed;
uniform float uAmp;
uniform vec2  uHalfSize;      // (半宽, 半纵深)
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  // 坐标归一化到 -1..1：波纹数量与尾缘抖动不随地毯尺寸变化，改尺寸无需重新调参
  float xn = position.x / uHalfSize.x;
  float zn = position.z / uHalfSize.y;   // +1 = 前缘, -1 = 尾缘

  float amp = uAmp * (0.5 + 0.8 * uSpeed);   // 静止时也有轻微浮动

  // 三组正弦波叠加：相位沿 -Z（从前缘向尾部）传播，模拟逆风
  float a1 = 5.0 * zn + uTime * (1.5 + uSpeed * 2.0);
  float a2 = 8.0 * zn + uTime * (2.2 + uSpeed * 3.0) + 2.0 * xn;
  float a3 = 3.5 * xn + uTime * 1.8;
  float sum = 0.35 * sin(a1) + 0.22 * sin(a2) + 0.15 * sin(a3);

  // 尾缘(zn = -1)抖动更明显
  float flap = 0.7 + 0.6 * (1.0 - (zn + 1.0) * 0.5);
  float y = amp * flap * sum;

  // 解析法线：对位移函数求导。注意归一化坐标的链式法则（dxn/dx = 1/半宽）
  float dydx = amp * flap * (0.22 * 2.0 * cos(a2) + 0.15 * 3.5 * cos(a3)) / uHalfSize.x;
  float dydz = amp * flap * (0.35 * 5.0 * cos(a1) + 0.22 * 8.0 * cos(a2)) / uHalfSize.y;

  vec3 pos = position;
  pos.y = y;
  vec3 normal = normalize(vec3(-dydx, 1.0, -dydz));

  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// —— 片元着色器（纹理 + 菲涅尔金边 + 透明度淡入）——
const CARPET_FRAG = `
uniform sampler2D uMap;
uniform float uOpacity;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  vec3 N = normalize(vNormal);
  vec3 albedo = texture2D(uMap, vUv).rgb;

  vec3 L = normalize(vec3(0.4, 0.85, 0.35));
  float diff = max(dot(N, L), 0.0);
  float amb  = 0.5;

  // 边缘金光（菲涅尔），营造"魔法"质感。cameraPosition 是 three 内置 uniform
  vec3 V = normalize(cameraPosition - vWorldPos);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.5);
  vec3 gold = vec3(1.0, 0.78, 0.35);

  gl_FragColor = vec4(albedo * (amb + diff * 0.9) + gold * fres * 0.55, uOpacity);
}
`;

// —— JS 端镜像位移函数（必须与 shader 完全一致）——
function surfaceY(x, z, t, speed, amp) {
  const xn = x / (CARPET_W / 2);
  const zn = z / (CARPET_D / 2);
  const A  = amp * (0.5 + 0.8 * speed);
  const a1 = 5.0 * zn + t * (1.5 + speed * 2.0);
  const a2 = 8.0 * zn + t * (2.2 + speed * 3.0) + 2.0 * xn;
  const a3 = 3.5 * xn + t * 1.8;
  const sum  = 0.35 * Math.sin(a1) + 0.22 * Math.sin(a2) + 0.15 * Math.sin(a3);
  const flap = 0.7 + 0.6 * (1.0 - (zn + 1.0) * 0.5);
  return A * flap * sum;
}

// —— 程序化波斯花纹纹理（深红底 + 金边 + 菱形格 + 中央徽章，无外部图片依赖）——
function generateCarpetTexture() {
  const w = 1024, h = 768;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');

  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#7a1f2b');
  bg.addColorStop(0.5, '#8f2433');
  bg.addColorStop(1, '#6e1a26');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);

  const frame = (inset, lw, color) => {
    g.strokeStyle = color; g.lineWidth = lw;
    g.strokeRect(inset, inset, w - 2 * inset, h - 2 * inset);
  };
  frame(18, 16, '#c99a3f');
  frame(42, 4,  '#e8c56a');
  frame(58, 2,  '#c99a3f');

  // 菱形格纹（两组斜线，裁剪在边框内）
  g.save();
  g.beginPath(); g.rect(60, 60, w - 120, h - 120); g.clip();
  g.strokeStyle = 'rgba(232,197,106,0.5)'; g.lineWidth = 3;
  const step = 90;
  for (let k = -12; k <= 24; k++) {
    const off = k * step;
    g.beginPath(); g.moveTo(0, off); g.lineTo(w, w + off);     g.stroke();
    g.beginPath(); g.moveTo(0, off); g.lineTo(w, off - w);     g.stroke();
  }
  g.restore();

  // 中央徽章（同心菱形）
  const cx = w / 2, cy = h / 2;
  const diamond = (rw, rh, color, lw) => {
    g.strokeStyle = color; g.lineWidth = lw;
    g.beginPath();
    g.moveTo(cx, cy - rh); g.lineTo(cx + rw, cy);
    g.lineTo(cx, cy + rh); g.lineTo(cx - rw, cy);
    g.closePath(); g.stroke();
  };
  diamond(210, 130, '#c99a3f', 6);
  diamond(180, 110, '#e8c56a', 3);
  diamond(70,   44, '#e8c56a', 4);

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Carpet {
  constructor(scene) {
    this.scene = scene;
    this._t = 0;                 // 内部时间累加（秒）
    this._speed = CARPET_BASE_SPEED;  // 当前归一化速度（驱动 uSpeed + 流苏风场），与玩家移动无关
    this._visible = true;

    // —— uniforms ——
    this.uniforms = {
      uTime:     { value: 0 },
      uSpeed:    { value: 0 },
      uAmp:      { value: BASE_AMP * AMP_SLIDER * AMP_SCALE },
      uHalfSize: { value: new THREE.Vector2(CARPET_W / 2, CARPET_D / 2) },
      uMap:      { value: generateCarpetTexture() },
      uOpacity:  { value: 1 },   // 穿云淡入：setEnvOpacity 驱动；默认 1（无 intro 时也可见）
    };

    // —— 几何体 + 材质（世界固定铺在原点，替代原蓝色活动边界）——
    const geo = new THREE.PlaneGeometry(CARPET_W, CARPET_D, 48, 48);
    geo.rotateX(-Math.PI / 2);   // 平铺到 XZ 平面，法线朝上
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: CARPET_VERT,
      fragmentShader: CARPET_FRAG,
      side: THREE.DoubleSide,
      transparent: true,         // 支持穿云淡入（仅改 uOpacity uniform，不切 transparent 避免重编译）
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(0, FOOT_OFFSET, 0);   // 贴地，长边(Z)对齐活动区域纵深
    this.mesh.rotation.order = 'YXZ';
    scene.add(this.mesh);

    // —— 边缘流苏（世界空间模拟，挂场景根，不可作 carpet 子物体）——
    this._buildTassels();

    // 首帧让流苏垂直垂下，避免被约束"拉爆"
    this.mesh.updateMatrixWorld(true);
    this._initTassels();
  }

  _buildTassels() {
    const halfW = CARPET_W / 2 - TASSEL_INSET;
    this._anchors = [];   // { local: Vector3, world: Vector3 }
    for (let e = 0; e < 2; e++) {
      const z = (e === 0 ? 1 : -1) * (CARPET_D / 2);   // 前缘 +D/2 / 尾缘 -D/2
      for (let i = 0; i < TASSELS_PER_EDGE; i++) {
        const x = -halfW + (2 * halfW * i) / (TASSELS_PER_EDGE - 1);
        this._anchors.push({ local: new THREE.Vector3(x, 0, z), world: new THREE.Vector3() });
      }
    }
    this._T = this._anchors.length;   // = 30
    this._points = [];
    this._prev = [];
    for (let t = 0; t < this._T; t++) {
      for (let p = 0; p < TASSEL_POINTS; p++) {
        this._points.push(new THREE.Vector3());
        this._prev.push(new THREE.Vector3());
      }
    }
    this._tasselPos = new Float32Array(this._T * (TASSEL_POINTS - 1) * 2 * 3);
    const tGeo = new THREE.BufferGeometry();
    tGeo.setAttribute('position', new THREE.BufferAttribute(this._tasselPos, 3));
    this.tasselLine = new THREE.LineSegments(
      tGeo,
      new THREE.LineBasicMaterial({ color: 0xe8c56a, transparent: true, opacity: 0.9 })
    );
    this.tasselLine.frustumCulled = false;   // 顶点 CPU 端变动，包围球无效
    this.scene.add(this.tasselLine);
  }

  _initTassels() {
    const amp = BASE_AMP * AMP_SLIDER * AMP_SCALE;
    for (let t = 0; t < this._T; t++) {
      const a = this._anchors[t];
      a.local.y = surfaceY(a.local.x, a.local.z, 0, 0, amp);
      a.world.copy(a.local).applyMatrix4(this.mesh.matrixWorld);
      for (let p = 0; p < TASSEL_POINTS; p++) {
        const i = t * TASSEL_POINTS + p;
        this._points[i].set(a.world.x, a.world.y - SEG_LEN * p, a.world.z);
        this._prev[i].copy(this._points[i]);
      }
    }
  }

  // 每帧更新：dt 由调用方钳制（见 main.js 已钳制）。
  // 注意：飞毯运动与玩家移动完全无关 —— uSpeed 走恒定基线 + 缓慢自震荡，
  //       流苏风场只用恒定环境风（AMBIENT_WIND），不随玩家速度变化 → 玩家停下不会抖动。
  update(dt) {
    if (!this._visible) return;

    const amp = BASE_AMP * AMP_SLIDER * AMP_SCALE;
    this._t += dt;
    const simTime = this._t;

    // 1) uSpeed：恒定基线 + 缓慢自震荡（与玩家移动无关，平滑无突变 → 避免停下时抖动）
    this._speed = CARPET_BASE_SPEED + CARPET_SPEED_BREATH * Math.sin(simTime * CARPET_BREATH_FREQ);

    // 2) 姿态（世界固定地面平台：作为玩家脚下地板保持静止，避免 VR 眩晕；
    //     "活地毯"感由顶点波纹 + 边缘流苏提供，平面本身不上下浮动/摆动）
    this.mesh.position.set(0, FOOT_OFFSET, 0);
    this.mesh.rotation.set(0, 0, 0);       // 长边沿 Z，与活动区域对齐，不偏航
    this.mesh.updateMatrixWorld();

    // 3) uniforms
    this.uniforms.uTime.value  = simTime;
    this.uniforms.uSpeed.value = this._speed;
    this.uniforms.uAmp.value   = amp;

    // 4) 更新锚点：局部 → 世界
    for (let t = 0; t < this._T; t++) {
      const a = this._anchors[t];
      a.local.y = surfaceY(a.local.x, a.local.z, simTime, this._speed, amp);
      a.world.copy(a.local).applyMatrix4(this.mesh.matrixWorld);
    }

    // 5) Verlet 积分（流苏自由粒子）：只用恒定环境风，与玩家移动无关
    const dt2 = dt * dt;
    const gust = Math.sin(simTime * 1.3) * 0.35 + Math.sin(simTime * 2.7) * 0.15;
    const wx = 0;                                       // 不再随玩家移动甩动
    const wz = -(AMBIENT_WIND + gust);
    const pts = this._points, prev = this._prev;
    for (let t = 0; t < this._T; t++) {
      for (let p = 0; p < TASSEL_POINTS; p++) {
        const i = t * TASSEL_POINTS + p;
        if (p === 0) {                       // 锚点：硬跟随地毯边缘
          prev[i].copy(this._anchors[t].world);
          pts[i].copy(this._anchors[t].world);
        } else {                             // 自由粒子：Verlet
          const cur = pts[i], pv = prev[i];
          const nvx = (cur.x - pv.x) * DAMPING;
          const nvy = (cur.y - pv.y) * DAMPING;
          const nvz = (cur.z - pv.z) * DAMPING;
          pv.copy(cur);
          cur.x += nvx + wx * dt2;
          cur.y += nvy + GRAVITY * dt2;
          cur.z += nvz + wz * dt2;
        }
      }
    }

    // 6) 段长约束迭代 3 次
    for (let iter = 0; iter < 3; iter++) {
      for (let t = 0; t < this._T; t++) {
        for (let p = 0; p < TASSEL_POINTS - 1; p++) {
          const i = t * TASSEL_POINTS + p;
          const a = pts[i], b = pts[i + 1];
          let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
          const diff = (d - SEG_LEN) / d;
          dx *= diff; dy *= diff; dz *= diff;
          if (p === 0) { b.x -= dx; b.y -= dy; b.z -= dz; }   // 锚点不动，全量修正 b
          else {
            a.x += dx * 0.5; a.y += dy * 0.5; a.z += dz * 0.5;
            b.x -= dx * 0.5; b.y -= dy * 0.5; b.z -= dz * 0.5;
          }
        }
      }
    }

    // 7) 写入顶点缓冲
    let k = 0;
    const arr = this._tasselPos;
    for (let t = 0; t < this._T; t++) {
      for (let p = 0; p < TASSEL_POINTS - 1; p++) {
        const i = t * TASSEL_POINTS + p;
        const a = pts[i], b = pts[i + 1];
        arr[k++] = a.x; arr[k++] = a.y; arr[k++] = a.z;
        arr[k++] = b.x; arr[k++] = b.y; arr[k++] = b.z;
      }
    }
    this.tasselLine.geometry.attributes.position.needsUpdate = true;
  }

  // 第9关玻璃走格子：隐藏飞毯，保留脚下玻璃区域
  setVisible(v) {
    this._visible = v;
    this.mesh.visible = v;
    this.tasselLine.visible = v;
  }

  // 穿云淡入：p 0=全隐 → 1=全显（仅改 uniform/opacity，不切 transparent，避免重编译卡顿）
  setEnvOpacity(p) {
    const o = Math.max(0, Math.min(1, p));
    this.uniforms.uOpacity.value = o;
    this.tasselLine.material.opacity = 0.9 * o;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.scene.remove(this.tasselLine);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.uniforms.uMap.value?.dispose();
    this.tasselLine.geometry.dispose();
    this.tasselLine.material.dispose();
  }
}
