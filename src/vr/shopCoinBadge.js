// shopCoinBadge.js —— 第六十四修 · 枪上的「商店币」小信息框（VR 手持，纯视觉）
//
// 现场口径：「商店币显示在枪支左侧信息框往前一点，往右一点，以枪支为它的显示框中心点，单独一个小信息框。」
// 做法：与技能信息框（vr/skillHint.js）**同一套**定位 —— 用 vr/streakCounter.barrelMount 量枪模型包围盒，
//   取最长轴当枪管轴、沿轴取 ALONG 处，再沿「玩家左手边」偏 LATERAL_GAP（见 constants.SHOP_COIN.MOUNT）：
//     · ALONG 0.68 > 信息框的 0.5    → 更靠枪口 = 「往前一点」
//     · LATERAL_GAP 0.005 < 0.07     → 更贴枪身 = 从玩家视角「往右一点」
//   牌子本体挂在 grip 上（与信息框同父、同一档 renderOrder），所以位置是「枪空间 → grip 空间」换算出来的。
//
// ⚠ 第六十五修：**不再只在商店关显示** —— 现场要求「在非商店关时看到商店币数量」，
//   所以玩家在局内（playing / 抽卡）就常显，只有菜单与开场影片期间收起（见 game._shopCoinBadgeOn）。
//   显隐与数字由 game.update 每帧下发（RightGun.setShopCoin / game._updateShopCoinBadge）；
//   数字还要「等金点落地才变」：金点由 fx.CoinOrbFx 从击杀点飞来，本类 update() 吃落地金额。
import * as THREE from 'three';
import { makeBadge } from '../game/cardDraft.js';
import { SHOP_COIN } from '../core/constants.js';
import { advanceShown, coinBadgeText } from '../game/shopCoinDisplay.js';
import { modelBoxInParentSpace, barrelMount } from './streakCounter.js';

const D2R = THREE.MathUtils.degToRad;
const _upV = new THREE.Vector3(0, 1, 0);
const _left = new THREE.Vector3();

export class ShopCoinBadge {
  constructor() {
    const cfg = SHOP_COIN;
    // 复用商店区域牌子那套 canvas 文字（makeBadge），只把物理尺寸换小一号（第三参 size）
    this.badge = makeBadge('', cfg.COLOR, { w: cfg.W, h: cfg.H });
    this.mesh = this.badge.mesh;
    this.mesh.renderOrder = 1000;             // 与技能信息框同档：画在最前，不被枪模型挡住
    this.mesh.rotation.set(D2R(cfg.ROTATION.x), D2R(cfg.ROTATION.y), D2R(cfg.ROTATION.z));
    this.mesh.visible = false;                // 默认隐藏：只在商店关由 setShopCoin 打开
    this._model = null; this._box = null; this._mountKey = null; this._mountPos = null;
    this._shown = 0;                          // 显示值：金点落地才涨（见 game/shopCoinDisplay.js）
  }

  /** 幂等挂到右手柄(grip)；anchor 与技能信息框同源，故两者相对位置稳定 */
  attach(anchor) { if (anchor && this.mesh.parent !== anchor) anchor.add(this.mesh); }

  /** 文字：makeBadge.set 内部去重（文字没变不重绘 canvas、不重传贴图） */
  set(text) { this.badge.set(text); }

  /** 显隐（第六十五修：局内常显 —— 现场要在非商店关也看得到余额） */
  show(on) { const v = !!on; if (this.mesh.visible !== v) this.mesh.visible = v; }

  /**
   * 第六十五修 · 每帧推进显示值（现场：「怪打死后有金色光点飞到这里接着数字变动」）。
   * @param {{total?:number, inflight?:number, landed?:number}} p
   *   total    = 真实商店币（即时入账，可能已经比显示值大）
   *   inflight = 还在飞的金点数量（> 0 时显示值**允许落后**，等落地补齐）
   *   landed   = 本帧落地金额（推显示值）
   */
  update(p = {}) {
    this._shown = advanceShown(this._shown, p.total, p.inflight, p.landed);
    this.set(coinBadgeText(this._shown));       // 文字没变 → 内部不重绘 canvas
  }

  /** 当帧世界坐标（金点的终点）—— 枪拿在手上一直在动，所以金点每帧都要重新问它 */
  worldPosition(out) { return this.mesh.getWorldPosition(out || new THREE.Vector3()); }

  /**
   * 按**枪模型**自动定位（与 SkillHintPanel.placeOnGun 同一套算法，原理见 constants.SKILL_HINT.MOUNT 注释）。
   *   为什么不能手填 grip 坐标：整把枪在 GUN.POSITION.y = -0.25（手腕下方 25cm），手填必然飘到枪上方。
   * @param {THREE.Object3D} model  枪模型（holder 的子节点）
   * @param {THREE.Object3D} holder 枪的持有层（GUN 变换作用于此）
   * @returns {boolean} true = 已按枪定位；false = 模型没就绪（调用方回落 SHOP_COIN.POSITION）
   */
  placeOnGun(model, holder) {
    const M = SHOP_COIN.MOUNT || {};
    if (M.ENABLED === false || !model || !holder) return false;
    if (this._model !== model) {              // 模型换了（首次 / 异步加载完成）→ 重量一次包围盒
      this._model = model;
      this._box = modelBoxInParentSpace(model);
      this._mountKey = null;
    }
    const key = [M.ALONG, M.SIDE, M.LATERAL_GAP, M.UP].join('|');
    if (this._mountKey !== key) {             // 热调 MOUNT（改 userConfig 刷新）→ 重算一次挂点
      this._mountKey = key;
      const m = barrelMount(this._box, M);
      if (m) {
        _left.copy(_upV).cross(m.axis);       // up × 枪管轴 = 玩家左手边
        if (_left.lengthSq() < 1e-8) _left.set(-1, 0, 0);   // 枪管恰好竖直时的兜底（防 NaN）
        const gap = m.radius + (M.LATERAL_GAP || 0);
        _left.normalize().multiplyScalar((M.SIDE < 0 ? 1 : -1) * gap);
        this._mountPos = m.position.clone().add(_left).addScaledVector(_upV, M.UP || 0);
      } else {
        this._mountPos = null;
      }
    }
    if (!this._mountPos) return false;
    holder.updateMatrix();                    // GUN 变换每帧 apply → 读 matrix 前先刷新（只差一帧也要对）
    this.mesh.position.copy(this._mountPos).applyMatrix4(holder.matrix);
    return true;
  }

  dispose() { this.badge.dispose(); }
}
