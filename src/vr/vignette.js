import * as THREE from 'three';
import { PROJECTILE } from '../core/constants.js';

// ============================================================
// 命中着色（第三十五修）
//   被「鬼火 / 墨汁」打中时，视野**周边**短暂染上一层颜色（中心透明、边缘着色）——
//   给玩家一个瞬时、非文字的「被击中了」反馈（紫色 = 鬼火，黑色 = 墨汁）。
//
// 为什么不用 DOM 遮罩：头显里看的是 XR 合成画面，页面上的 DOM 层在沉浸态**不可见**
//   （同 winBanner / wristUI 的结论：DOM HUD 只对桌面预览有效）。所以这里做场景内 Sprite：
//     · 挂在 world.camera 下 → 跟着头动，永远停在视野正前方（不受转头/走动影响）；
//     · depthTest:false + 高 renderOrder → 压在一切物体之上，不会被敌人模型挡住；
//     · NormalBlending（不是加色）→ 黑色也能正常「压暗」边缘（加色下黑色等于不可见）。
//
// 尺寸：按相机垂直 FOV 反推该距离上的平面尺寸，再乘 MARGIN 保证铺满视野。
//   XR 下 three 会把 camera.fov 改写成**单眼** FOV，故每帧重算最稳（本类只在着色期间重算）。
//
// 颜色来源：命中者决定 —— 见 ProjectileManager.tintOf(kind)；手里剑等 TINT 为 null 的投射物不触发。
// ============================================================

const TEX_SIZE = 256;

// 白 + alpha 的径向渐变：颜色留给 SpriteMaterial.color 决定 → 一张图可染任意色
function _buildVignetteTexture() {
  const cv = document.createElement('canvas');
  cv.width = TEX_SIZE; cv.height = TEX_SIZE;
  const ctx = cv.getContext('2d');
  const c = TEX_SIZE / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0.00, 'rgba(255,255,255,0)');
  g.addColorStop(0.42, 'rgba(255,255,255,0)');   // 中心 42% 完全透明：不挡视线、不影响瞄准
  g.addColorStop(0.74, 'rgba(255,255,255,0.65)');
  g.addColorStop(0.93, 'rgba(255,255,255,1)');
  g.addColorStop(1.00, 'rgba(255,255,255,0.85)'); // 最外缘回收一点，避免精灵边界出现硬边
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Vignette {
  /** @param {THREE.Camera} camera 挂载点（须已在场景图内，即 rig 的子节点） */
  constructor(camera) {
    this.camera = camera;
    this.enabled = PROJECTILE.VIGNETTE.ENABLED;
    this._t = Infinity;          // 本次着色已持续时间（Infinity = 未激活）
    this._tex = _buildVignetteTexture();
    this._mat = new THREE.SpriteMaterial({
      map: this._tex, transparent: true, depthTest: false, depthWrite: false,
      opacity: 0, blending: THREE.NormalBlending,
    });
    this.sprite = new THREE.Sprite(this._mat);
    this.sprite.position.set(0, 0, -PROJECTILE.VIGNETTE.DIST);
    this.sprite.renderOrder = 5000;   // 全场最高：盖在 Boss / 通关横幅之上
    this.sprite.visible = false;
    if (camera) camera.add(this.sprite);
    this._fit();
  }

  /** 触发一次着色：colorHex = 0xRRGGBB（重复命中会重新从 0 开始渐变） */
  flash(colorHex) {
    if (!this.enabled || !this.sprite) return;
    this._mat.color.setHex(colorHex >>> 0);
    this._mat.opacity = 0;
    this._t = 0;
    this.sprite.visible = true;
  }

  update(dt) {
    if (!this.enabled || this._t === Infinity) return;
    const V = PROJECTILE.VIGNETTE;
    this._t += dt;
    const total = V.RISE + V.FADE;
    if (this._t >= total) { this.clear(); return; }
    const k = this._t < V.RISE
      ? this._t / Math.max(1e-4, V.RISE)                     // 上色
      : 1 - (this._t - V.RISE) / Math.max(1e-4, V.FADE);     // 褪色
    this._mat.opacity = V.OPACITY * Math.min(1, Math.max(0, k));
    this._fit();   // 相机 FOV 在 桌面预览 ↔ XR 之间会变，着色期间每帧重算
  }

  /** 尺寸：按垂直 FOV 算出该距离上的可见平面大小，再乘余量(>1)保证铺满视野 */
  _fit() {
    if (!this.sprite) return;
    const V = PROJECTILE.VIGNETTE;
    const fov = (this.camera && this.camera.fov) || 70;
    const half = V.DIST * Math.tan(THREE.MathUtils.degToRad(fov * 0.5)) * V.MARGIN;
    this.sprite.scale.set(half * 2 * V.ASPECT, half * 2, 1);
  }

  /** 立即结束（切关 / 回菜单 / 重开时调用，避免残留着色） */
  clear() {
    this._t = Infinity;
    if (this._mat) this._mat.opacity = 0;
    if (this.sprite) this.sprite.visible = false;
  }

  dispose() {
    this.clear();
    if (this.sprite && this.sprite.parent) this.sprite.parent.remove(this.sprite);
    if (this._mat) this._mat.dispose();
    if (this._tex) this._tex.dispose();
    this.sprite = null; this._mat = null; this._tex = null; this.camera = null;
  }
}