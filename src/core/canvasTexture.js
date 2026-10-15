// 通用「文字 → CanvasTexture」工厂。
// 消除 world / glassGrid / cards / wrist-ui / balloons 中重复的
// createElement('canvas') → getContext('2d') → 绘制 → new CanvasTexture 模板。
// P0：先接入 world（文字精灵）与 glassGrid（玻璃格编号平面）；
//     cards / wrist-ui / balloons 的特化贴图（卡片矩形 / 手腕面板 / 气球笑脸）后续再迁移。
import * as THREE from 'three';

// 在离屏 canvas 上居中绘制文字，返回 CanvasTexture。
export function makeTextTexture({
  text,
  font = 'bold 44px sans-serif',
  color = '#ffffff',
  bg = null,
  bgRadius = 0,   // 第五十一修：bg 的圆角半径（0 = 直角铺满整张画布）
  stroke = null,
  strokeW = 0,
  width = 128,
  height = 64,
} = {}) {
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext('2d');
  if (bg) {
    ctx.fillStyle = bg;
    if (bgRadius > 0) {   // 圆角底板：玻璃格编号这类「要有对比底」的场景用（见 glassGrid.numTexture）
      const r = Math.min(bgRadius, width / 2, height / 2);
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.arcTo(width, 0, width, height, r);
      ctx.arcTo(width, height, 0, height, r);
      ctx.arcTo(0, height, 0, 0, r);
      ctx.arcTo(0, 0, width, 0, r);
      ctx.closePath();
      ctx.fill();
    } else ctx.fillRect(0, 0, width, height);
  } else ctx.clearRect(0, 0, width, height);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 第五十修：可选的深色描边 —— 玻璃格编号压在淡青玻璃上时，纯亮色字在头显里对比度不足
  if (stroke && strokeW > 0) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = strokeW;
    ctx.strokeStyle = stroke;
    ctx.strokeText(String(text), width / 2, height / 2);
  }
  ctx.fillStyle = color;
  ctx.fillText(String(text), width / 2, height / 2);
  return new THREE.CanvasTexture(cv);
}

// 始终面向相机的文字精灵（用于坐标系数字标注等）
export function makeTextSprite({
  text,
  color = '#ffffff',
  font = 'bold 44px sans-serif',
  width = 128,
  height = 64,
  spriteW = 0.3,
  spriteH = 0.15,
} = {}) {
  const tex = makeTextTexture({ text, font, color, width, height });
  const sp = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false })
  );
  sp.scale.set(spriteW, spriteH, 1);
  return sp;
}

// 平躺于 XZ 面、朝上的文字平面（用于玻璃格编号贴面等）
export function makeTextPlane({
  text,
  color = '#eaffff',
  font = 'bold 80px sans-serif',
  size = 0.5,
} = {}) {
  const tex = makeTextTexture({ text, font, color, width: 128, height: 128 });
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  m.rotation.x = -Math.PI / 2; // 平躺于 XZ 面，朝上可读
  m.renderOrder = 2;
  return m;
}
