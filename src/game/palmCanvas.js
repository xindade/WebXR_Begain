// ============================================================================
// 程序化「如来神掌」贴图（VFX_MODE='canvas'）—— Canvas2D 矢量绘制，无任何外部素材
// 动机：原 assets/buddha-palm.jpg 是白底 JPG，运行时靠颜色键抠图，在 10~15 倍放大下
//       出现锯齿白边/高光破洞/压缩振铃；SDF 版掌形又过于抽象不够"佛教手印"。
//       本方案用贝塞尔平滑轮廓画出**真实比例手掌**，再叠金色渐变/外发光/掌纹/掌心法阵，
//       生成一张**自带软 alpha 的 1024×1536 贴图**，彻底没有抠图瑕疵。
// 成本：一次性生成（~100ms 主线程），此后每帧渲染成本与原贴图方案**完全相同**
//       （同 1 个平面 1 次绘制 1 次贴图采样），不增加任何 GPU 负担。
// 坐标约定：归一化坐标 (x, y)，原点=掌中心；+y 朝上（指尖方向），+x 朝右。
//      画面坐标系转换：px = cx + x·unit，py = cy - y·unit（Canvas 的 y 轴向下）。
// ============================================================================

// 手掌外轮廓控制点（归一化）：沿轮廓**逆时针**一圈采样——
// 从右腕 → 右掌缘 → 小指 → 无名指 → 中指 → 食指 → 左掌缘 → 拇指 → 左腕，闭合。
// 想改手型（手指长短/张开度/胖瘦）直接增删这里的点，Catmull-Rom 会自动补成平滑曲线。
// 说明：每根手指由「上行 3 点 + 指尖(最远点) + 下行 3 点」描述，圆头由曲线自动产生。
const PALM_OUTLINE = [
  // —— 右腕 → 右掌缘 ——
  [0.20, -0.95], [0.30, -0.78], [0.42, -0.62], [0.50, -0.40],
  [0.53, -0.18], [0.54, -0.02], [0.52, 0.10],
  // —— 小指 ——
  [0.50, 0.24], [0.45, 0.42], [0.41, 0.56], [0.35, 0.63],
  [0.29, 0.57], [0.27, 0.42], [0.25, 0.26],
  // —— 无名指 ——
  [0.22, 0.36], [0.18, 0.58], [0.14, 0.76], [0.10, 0.87],
  [0.05, 0.85], [0.03, 0.68], [0.02, 0.40], [0.01, 0.24],
  // —— 中指（最长）——
  [0.00, 0.30], [-0.02, 0.62], [-0.04, 0.86], [-0.06, 1.00],
  [-0.11, 0.99], [-0.13, 0.82], [-0.14, 0.56], [-0.15, 0.28],
  // —— 食指 ——
  [-0.16, 0.34], [-0.19, 0.60], [-0.21, 0.80], [-0.23, 0.92],
  [-0.28, 0.90], [-0.30, 0.74], [-0.31, 0.52], [-0.33, 0.28],
  // —— 左掌缘 ——
  [-0.40, 0.16], [-0.46, 0.04], [-0.50, -0.12],
  // —— 拇指（向左下斜伸）——
  [-0.62, -0.30], [-0.78, -0.46], [-0.90, -0.60], [-0.94, -0.73],
  [-0.86, -0.83], [-0.72, -0.83], [-0.59, -0.74],
  // —— 左腕 → 闭合回起点 ——
  [-0.47, -0.62], [-0.37, -0.72], [-0.28, -0.86], [-0.18, -0.95],
];

// 掌心三条主线（生命线/智慧线/感情线），二次贝塞尔 [起点, 控制点, 终点]
const PALM_LINES = [
  [[-0.40, 0.02], [0.00, 0.16], [0.42, 0.02]],   // 感情线
  [[-0.42, -0.08], [0.02, -0.20], [0.20, -0.48]], // 智慧线
  [[-0.40, -0.16], [-0.34, -0.52], [-0.30, -0.82]], // 生命线（绕拇指根）
];

// 确定性伪随机（LCG）：保证每次生成的火花分布一致，便于对比调参效果
function _rand(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Catmull-Rom 转三次贝塞尔，生成闭合平滑路径（自带连续性，无硬接缝）
// tension：0=折线（尖角），1=标准 Catmull-Rom（推荐），>1 更圆润但可能过冲
function _smoothPath(ctx, pts, tx, ty, tension) {
  const n = pts.length;
  const X = (p) => tx(p[0], p[1]);
  const Y = (p) => ty(p[0], p[1]);
  ctx.beginPath();
  ctx.moveTo(X(pts[0]), Y(pts[0]));
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const t = tension / 6;
    const c1x = X(p1) + (X(p2) - X(p0)) * t;
    const c1y = Y(p1) + (Y(p2) - Y(p0)) * t;
    const c2x = X(p2) - (X(p3) - X(p1)) * t;
    const c2y = Y(p2) - (Y(p3) - Y(p1)) * t;
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, X(p2), Y(p2));
  }
  ctx.closePath();
}

// 按比例把十六进制颜色混合出半透明版本（避免每次都拼 rgba 字符串出错）
function _alpha(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * 在给定 2D 上下文绘制程序化金掌
 * @param {CanvasRenderingContext2D} ctx 已清空、尺寸为 W×H 的画布上下文
 * @param {number} W 画布宽 px
 * @param {number} H 画布高 px
 * @param {object} o 绘制参数（见 constants.BUDDHA 的 CANVAS_* / COL_* / SIGIL_* / LINES_* / SPARK_*）
 */
export function drawPalm(ctx, W, H, o) {
  // —— 自适应单位：按轮廓**实际包围盒**等比缩放并居中进画布，四周留 margin ——
  // 注：必须按包围盒(min/max)而非 max(|x|) 居中。手含向左伸出的拇指，若用 max(|x|)
  //     作基准，掌体会整体偏右、左侧留白不足，拇指的外发光会被画布边缘裁切。
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of PALM_OUTLINE) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const unit = Math.min((W * o.MARGIN) / (maxX - minX), (H * o.MARGIN) / (maxY - minY));
  const gx = (minX + maxX) / 2;                  // 包围盒中心（=拇指与掌的整体视觉中心）
  const gy = (minY + maxY) / 2;
  const cx = W / 2, cy = H / 2 + H * o.OFFSET_Y; // OFFSET_Y：整体上下微移
  const tx = (x) => cx + (x - gx) * unit;
  const ty = (y) => cy - (y - gy) * unit;
  const path = () => _smoothPath(ctx, PALM_OUTLINE, tx, ty, o.TENSION);

  ctx.clearRect(0, 0, W, H);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // ============ 1) 外层弥散金光（多次 shadowBlur 叠加，越远越淡）============
  if (o.GLOW_LAYERS > 0) {
    for (let i = o.GLOW_LAYERS; i >= 1; i--) {
      const k = i / o.GLOW_LAYERS;
      ctx.save();
      ctx.shadowColor = o.GLOW_COLOR;
      ctx.shadowBlur = unit * o.GLOW_BLUR * k;
      ctx.globalAlpha = o.GLOW_ALPHA * (1.2 - k) * 0.9;
      ctx.fillStyle = o.GLOW_COLOR;
      path();
      ctx.fill();
      ctx.restore();
    }
  }

  // ============ 2) 掌体主体（线性渐变：掌根暗 → 掌尖亮）============
  const lin = ctx.createLinearGradient(0, ty(-1.0), 0, ty(1.0));
  lin.addColorStop(0.00, o.COL_DEEP);
  lin.addColorStop(0.45, o.COL_MID);
  lin.addColorStop(1.00, o.COL_BRIGHT);
  ctx.save();
  path();
  ctx.fillStyle = lin;
  ctx.fill();
  // 掌心向外的径向亮核，让掌有"内蓄能量"的体积感
  const coreG = ctx.createRadialGradient(tx(0), ty(-0.25), 0, tx(0), ty(-0.25), unit * 1.5);
  coreG.addColorStop(0.0, _alpha(o.COL_RIM, o.CORE_GLOW));
  coreG.addColorStop(0.5, _alpha(o.COL_MID, o.CORE_GLOW * 0.35));
  coreG.addColorStop(1.0, _alpha(o.COL_DEEP, 0));
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = coreG;
  ctx.fill();
  ctx.restore();

  // ============ 3) 掌内细节（限制在轮廓内）：掌纹 / 掌心法阵 / 火花 ============
  ctx.save();
  path();
  ctx.clip();

  if (o.LINES_ENABLE) {
    ctx.save();
    ctx.strokeStyle = _alpha(o.LINES_COLOR, o.LINES_ALPHA);
    ctx.lineWidth = unit * o.LINES_WIDTH;
    ctx.shadowColor = o.LINES_COLOR;
    ctx.shadowBlur = unit * 0.03;
    for (const [a, c, b] of PALM_LINES) {
      ctx.beginPath();
      ctx.moveTo(tx(a[0]), ty(a[1]));
      ctx.quadraticCurveTo(tx(c[0]), ty(c[1]), tx(b[0]), ty(b[1]));
      ctx.stroke();
    }
    ctx.restore();
  }

  if (o.SIGIL_ENABLE) {
    const sxc = tx(o.SIGIL_X), syc = ty(o.SIGIL_Y);
    const R = unit * o.SIGIL_RADIUS;
    ctx.save();
    ctx.translate(sxc, syc);
    ctx.rotate((o.SIGIL_ROT * Math.PI) / 180);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = _alpha(o.SIGIL_COLOR, o.SIGIL_ALPHA);
    ctx.shadowColor = o.SIGIL_COLOR;
    ctx.shadowBlur = unit * 0.05;
    // 同心环
    ctx.lineWidth = unit * o.SIGIL_WIDTH;
    for (let i = 0; i < o.SIGIL_RINGS; i++) {
      ctx.beginPath();
      ctx.arc(0, 0, R * (1 - i * 0.22), 0, Math.PI * 2);
      ctx.stroke();
    }
    // 最外环虚线（法阵"刻度"感）
    ctx.setLineDash([R * 0.10, R * 0.12]);
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.08, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // 放射光线
    ctx.lineWidth = unit * o.SIGIL_WIDTH * 0.7;
    for (let i = 0; i < o.SIGIL_RAYS; i++) {
      const a = (i / o.SIGIL_RAYS) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * R * 0.55, Math.sin(a) * R * 0.55);
      ctx.lineTo(Math.cos(a) * R * 0.95, Math.sin(a) * R * 0.95);
      ctx.stroke();
    }
    // 中心核
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.5);
    core.addColorStop(0, _alpha(o.SIGIL_COLOR, o.SIGIL_ALPHA));
    core.addColorStop(1, _alpha(o.SIGIL_COLOR, 0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (o.SPARK_ENABLE) {
    const rnd = _rand(20240910);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < o.SPARK_COUNT; i++) {
      // 在掌的大致范围内随机取点（长轴分布偏中部）
      const x = (rnd() * 1.7 - 0.85);
      const y = (rnd() * 1.9 - 0.95);
      const r = unit * o.SPARK_RADIUS * (0.4 + rnd() * 0.9);
      const g = ctx.createRadialGradient(tx(x), ty(y), 0, tx(x), ty(y), r);
      g.addColorStop(0, _alpha(o.SPARK_COLOR, o.SPARK_ALPHA));
      g.addColorStop(1, _alpha(o.SPARK_COLOR, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(tx(x), ty(y), r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore(); // 结束 clip

  // ============ 4) 轮廓描边：粗金边 + 细亮边（勾出清晰轮廓并提升"神圣感"）====
  if (o.STROKE_WIDTH > 0) {
    ctx.save();
    path();
    ctx.strokeStyle = _alpha(o.STROKE_COLOR, o.STROKE_ALPHA);
    ctx.lineWidth = unit * o.STROKE_WIDTH;
    ctx.shadowColor = o.STROKE_COLOR;
    ctx.shadowBlur = unit * o.STROKE_WIDTH * 1.4;
    ctx.stroke();
    ctx.restore();
    // 内侧细亮线：沿轮廓再收一圈，形成"双层描金"
    ctx.save();
    path();
    ctx.strokeStyle = _alpha(o.COL_RIM, o.STROKE_ALPHA * 0.9);
    ctx.lineWidth = unit * o.STROKE_WIDTH * 0.35;
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * 生成程序化金掌贴图承载画布（供 buddhaFx 包成 THREE.CanvasTexture）
 * @returns {HTMLCanvasElement}
 */
export function makePalmCanvas(o, W, H) {
  const cv = (typeof OffscreenCanvas !== 'undefined' && o.USE_OFFSCREEN)
    ? new OffscreenCanvas(W, H)
    : document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  drawPalm(ctx, W, H, o);
  return cv;
}
