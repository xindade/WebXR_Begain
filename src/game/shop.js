import * as THREE from 'three';
import { pointSegmentDistanceSq } from '../core/collision.js';
import { CARD, SHOP } from '../core/constants.js';
import { SKILL_CARDS } from '../content/cards.js';
import { SHOP_ITEMS, SKILL_UPGRADES, pickShopItems, pickShopItemExcluding, shopItemPrice } from '../content/shopItems.js';
import { makeBalloon, makeCardTexture, makeBadge } from './cardDraft.js';
import { previewCards } from '../content/eliteBrief.js';
import { portraitKey } from './enemyPortrait.js';

// 商店关（第五十五修）：第 3/9/15 关替代原「激光机制关」。
//   正前方一排：技能本体×3（玩家已拥有三选一技能后 → 技能强化×3）+「购物完成」；
//   左手边一列：道具×3（6 选 3 不重复）+「刷新道具」。
//   右手边一列：**只读**的「精英预告」卡（第五十七修）——预告到下一个商店之前的精英与 Boss，
//               不可射击、不计入 entries（内容与文案见 content/eliteBrief.js）。
//   打中气球即购买；商店币不足 → 不消费、气球留在原地并闪一下（onDenied 提示）。
//   第五十八修（现场一轮反馈）：① 左右两列卡面**平行于地面的 Z 线**（不再各自朝场地原点歪一个角度）；
//   ② 道具列 / 精英预告列卡面放大 2 倍，「购物完成」保持原样；③ 价位换成金色大字（2 倍字号）；
//   ④ 「购物完成」气球上方挂倒计时、技能区 / 道具区气球上方各挂一块**商店币**牌子。
//   第五十九修（现场二轮反馈）：① 正前方「技能 / 强化」也放大 1.5 倍（「购物完成」仍原样）；
//   ② 左右两列**收进飞毯**（|X| 3.0 → 1.75）并**绕场地中心 Z=0 对称铺开**（见 columnZ）；
//   ③ 区域牌子放大（SHOP.BADGE_W/H）；④ 商店币不足只提示「商店币不足」，不再刷整串数字。
//   买走一个道具自动补位（从其余道具里随机补一个）；刷新重抽三个（价格逐次翻倍，进店重置）。
//   打「购物完成」或 60 秒倒计时结束 → finished = true，由 game._updateShop 收尾进下一关。
//
// 与 cardDraft 的关系：共用「气球 + 卡面」视觉与 canvas 卡面绘制（makeBalloon / makeCardTexture），
// 但**不复用 CardDraft 的结算流程** —— 商店关可连续购买、买完补位、可刷新，是另一套状态机。

/**
 * 一列卡沿 Z 的**对称**排布（第五十九修）：n 张卡围绕 zc 均匀铺开。
 *   z_i = zc + (i - (n-1)/2) × dz   —— i=0 是最靠前（最负 Z）的那张。
 *   纯函数、不碰 THREE：现场口径「以场地中心点为中心，在 Z 轴的正与负方向分别均匀放置」。
 *   为什么必须对称：飞毯只有 8m 深(Z ±4)，旧版从 z=-1.0 单向往后排，6 张会排到 -6.75m（毯外）。
 */
export function columnZ(zc, dz, i, n) {
  return zc + (i - (n - 1) / 2) * dz;
}

export class ShopDraft {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.group.visible = false;

    this.entries = [];        // { holder, card, balloon, kind, def, price, free, slot, baseY, exploded, _explodeT, _denyT }
    //   第五十七修：预览卡挂**独立子组** —— `_build()` 每次购买都会 _clear() 重建可买的卡，
    //   但预告卡不随购买变化（每店只建一次），所以不放进 _clear() 的清理范围。
    this.previewGroup = new THREE.Group();
    this.group.add(this.previewGroup);
    this.preview = [];        // 右手边「精英预告」只读卡 { holder, mesh }（不进 entries ⇒ 打不中）
    //   第五十七修 v2：卡面立绘（模型截图）由 game._warmShopPortraits 异步抓帧后 setPortrait 塞进来，
    //   键 = 模型 url（见 enemyPortrait.portraitKey）。Boss 卡没有 portrait ⇒ 永远走「?」占位。
    this._portraits = {};
    //   第五十八修：区域牌子（商店币 / 倒计时）挂独立子组，随 group 一起显示/隐藏
    this.badgeGroup = new THREE.Group();
    this.group.add(this.badgeGroup);
    this.coinFront = null;   // 技能区商店币牌子
    this.coinItem = null;    // 道具区商店币牌子
    this.active = false;
    this.finished = false;    // game 轮询它收尾（不在本类里直接调 game，避免重入）
    this.t = 0;
    this.timer = 0;           // 本关剩余秒数（60 → 0 自动进下一关）
    this.refreshCost = SHOP.REFRESH_BASE;
    this._state = null;
    this._upgradesBought = new Set();  // 本次进店已购买的强化项 id（每项限购 1）
    this._itemDisplay = [];            // 道具区当前展示的 3 个道具 id
    this._resolve = null;              // { t, after } 购买动画（期间不接受新购买）

    this._playerPos = new THREE.Vector3();
    this.lightFx = null;
    this._lightStart = [];
    this._lightDelay = [];
    this._lightTarget = new THREE.Vector3();
    this._lightN = 0;
  }

  /** 进店：state 为注入的回调集合（见 game._enterShop） */
  open(playerPos, state) {
    if (playerPos) this._playerPos.copy(playerPos);
    this._state = state;
    this.active = true;
    this.finished = false;
    this.group.visible = true;
    this.t = 0;
    this.timer = SHOP.COUNTDOWN;
    // 第五十六修：价格倍率（第 3 关减半）—— 进店时取一次，店内不再变。刷新价**不**参与折扣。
    this._priceMul = (state && typeof state.priceMul === 'function') ? (Number(state.priceMul()) || 1) : 1;
    this.refreshCost = SHOP.REFRESH_BASE;
    this._freeItem = true;   // 第五十七修（用户口径）：本店**第一个买到的道具**免费
    this._upgradesBought = new Set();
    this._itemDisplay = pickShopItems(3);
    this._resolve = null;
    this._clearLightFx();
    this._build();
    this._buildPreview();   // 精英预告卡：进店建一次（购买补位只重建可买的那些）
    this._buildBadges();    // 第五十八修：商店币 / 倒计时牌子
  }

  // ====== 场地 ======

  _build() {
    this._clear();
    const front = this._frontEntries();
    const items = this._itemEntries();
    const x0 = -((front.length - 1) * SHOP.FRONT_SPACING) / 2;
    // 第五十九修：正前方「技能本体 / 技能强化」放大 CARD_SCALE_FRONT，「购物完成」保持原样（逐张取缩放）
    front.forEach((e, i) => this._addEntry(e, new THREE.Vector3(x0 + i * SHOP.FRONT_SPACING, SHOP.FRONT_Y, SHOP.FRONT_Z), {
      scale: e.kind === 'done' ? SHOP.CARD_SCALE_DONE : SHOP.CARD_SCALE_FRONT, faceX: 0,
    }));
    // 第五十九修：道具列绕场地中心 Z=0 **对称**铺开（旧版单向往后排 → 甩到飞毯外）
    items.forEach((e, i) => this._addEntry(e, new THREE.Vector3(SHOP.ITEM_X, SHOP.ITEM_Y, columnZ(SHOP.ITEM_ZC, SHOP.ITEM_DZ, i, items.length)), {
      scale: SHOP.CARD_SCALE_ITEM, faceX: SHOP.SIDE_CARDS_PARALLEL_Z ? 1 : 0,
    }));
  }

  // 正前方一排：技能本体 / 技能强化 + 购物完成
  // 单价（含价格倍率；第 3 关减半）—— 卡面文案与实扣同源
  _skillPrice() { return Math.round(SHOP.SKILL_PRICE * this._priceMul); }
  _upgradePrice() { return Math.round(SHOP.UPGRADE_PRICE * this._priceMul); }

  _frontEntries() {
    const out = [];
    if (!this._state.hasSkill()) {
      for (const s of SKILL_CARDS) {
        out.push({
          kind: 'skill', def: s, label: s.label, color: s.color, icon: s.icon, price: this._skillPrice(),
          sub: '装备后按左手柄释放',
          priceText: String(this._skillPrice()), priceColor: SHOP.PRICE_COLOR,
        });
      }
    } else {
      for (const u of SKILL_UPGRADES) {
        if (this._upgradesBought.has(u.id)) continue;   // 每项限购 1 个 → 买掉即从架上消失
        out.push({
          kind: 'upgrade', def: u, label: u.label, color: u.color, icon: u.icon, price: this._upgradePrice(),
          sub: u.desc,
          priceText: String(this._upgradePrice()), priceColor: SHOP.PRICE_COLOR,
        });
      }
    }
    out.push({ kind: 'done', label: '购物完成', sub: '立即进入下一关（免费）', color: '#2ecc71', icon: 'shopDone', price: 0 });
    return out;
  }

  // 左手边一列：道具 + 刷新
  _itemEntries() {
    const lv = (this._state.getItemLevels && this._state.getItemLevels()) || {};
    const out = [];
    this._itemDisplay.forEach((id, slot) => {
      const it = SHOP_ITEMS.find((x) => x.id === id);
      if (!it) return;
      const cur = lv[id] || 0;
      // 第五十七修：买掉第一个道具之前，三个道具都显示「首次免费」（技能 / 强化 / 刷新不参与）
      const free = !!this._freeItem;
      const price = free ? 0 : Math.round(shopItemPrice(id, lv) * this._priceMul);   // 第五十六修：第 3 关减半
      out.push({
        kind: 'item', def: it, slot, label: it.label, color: it.color, icon: it.icon, price, free,
        sub: `${it.desc}｜Lv.${cur}→${cur + 1}`,
        priceText: free ? '免费' : String(price),
        priceColor: free ? SHOP.PRICE_FREE_COLOR : SHOP.PRICE_COLOR,
      });
    });
    out.push({
      kind: 'refresh', label: '刷新道具', color: '#f1c40f', icon: 'refresh', price: this.refreshCost,
      sub: '重抽三个道具',
      priceText: String(this.refreshCost), priceColor: SHOP.PRICE_COLOR,
    });
    return out;
  }

  // 右手边：精英预告（只读卡 —— 不绑气球、不进 entries，所以打不到也买不了）
  /** 立绘要抓哪些模型（game._warmShopPortraits 用）：只含精英卡，且本店预览里去重 */
  previewPortraits() {
    const n = (this._state && this._state.shopLevel) || 0;
    const out = [];
    for (const c of previewCards(n).slice(0, SHOP.PREVIEW_MAX)) {
      const spec = c.portrait;
      if (!spec) continue;                                    // Boss 卡：不给图
      const k = portraitKey(spec);
      if (!out.includes(k)) out.push(spec);
    }
    return out;
  }

  /** 立绘到位（game 抓帧回调）：换掉这一列的图；空图/重复 key 忽略 */
  setPortrait(key, canvas) {
    if (!key || !canvas || this._portraits[key]) return;
    this._portraits[key] = canvas;
    if (this.active) this._buildPreview();
  }

  _buildPreview() {
    this._clearPreview();
    const n = (this._state && this._state.shopLevel) || 0;
    const cards = previewCards(n).slice(0, SHOP.PREVIEW_MAX);
    cards.forEach((c, i) => {
      const holder = new THREE.Group();
      // 第五十九修：绕场地中心 Z=0 对称铺开（与道具列同口径，见 columnZ）
      holder.position.set(SHOP.PREVIEW_X, SHOP.PREVIEW_Y, columnZ(SHOP.PREVIEW_ZC, SHOP.PREVIEW_DZ, i, cards.length));
      holder.scale.setScalar(SHOP.CARD_SCALE_PREVIEW);   // 第五十八修：现场口径 2 倍
      this.previewGroup.add(holder);
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(CARD.WIDTH, CARD.HEIGHT),
        new THREE.MeshBasicMaterial({
          map: makeCardTexture(c.label, c.sub, c.color, c.icon, {
            // 精英卡：抓到的模型立绘就画图，没抓到退回简笔画；Boss 卡（无 portrait）只给「?」
            portrait: true,
            image: this._portraits[portraitKey(c.portrait)] || null,
            placeholder: c.portrait ? null : '?',
          }),
          transparent: true,
        })
      );
      holder.add(mesh);
      // 第五十八修：与地面的 Z 线平行（法线指向场地中线）；关掉开关退回「各自朝原点」
      if (SHOP.SIDE_CARDS_PARALLEL_Z) mesh.rotation.y = -Math.PI / 2;
      else mesh.lookAt(0, holder.position.y, 0);
      this.preview.push({ holder, mesh });
    });
  }

  /**
   * 挂一张可买的卡（卡面 + 气球 + 细绳）。
   * @param {{scale?:number, faceX?:number}} o
   *   scale = 整组缩放（卡面与气球一起缩放，细绳才不会跟气球脱节）；
   *   faceX ≠ 0 → 卡面**平行于地面的 Z 线**（法线指向 ±X，正面朝场地中线）；0 = 朝场地原点（旧行为）。
   */
  _addEntry(e, pos, o = {}) {
    const scale = o.scale || 1;
    const faceX = o.faceX || 0;
    const holder = new THREE.Group();
    holder.position.copy(pos);
    holder.scale.setScalar(scale);
    this.group.add(holder);

    const card = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD.WIDTH, CARD.HEIGHT),
      new THREE.MeshBasicMaterial({
        map: makeCardTexture(e.label, e.sub, e.color, e.icon, { price: e.priceText, priceColor: e.priceColor }),
        transparent: true,
      })
    );
    holder.add(card);
    // 先挂进 holder 再定向（世界坐标才正确）：正前方一排朝场地原点；两列平行于地面的 Z 线
    if (faceX) card.rotation.y = faceX * Math.PI / 2;
    else card.lookAt(0, pos.y, 0);

    const balloon = makeBalloon(e.color);
    balloon.position.set(0, CARD.BALLOON_HEIGHT, 0);
    holder.add(balloon);

    // 第五十八修：「购物完成」气球上方挂倒计时牌子（挂 holder 上 ⇒ 随气球缩放/浮动）
    let badge = null;
    if (e.kind === 'done') {
      badge = makeBadge('', e.color || SHOP.PRICE_COLOR);
      badge.mesh.position.set(0, CARD.BALLOON_HEIGHT + SHOP.BADGE_DY, 0);
      holder.add(badge.mesh);
    }

    this.entries.push({
      holder, card, balloon, badge, baseY: pos.y, scale,
      balloonY: CARD.BALLOON_HEIGHT * scale,          // 气球在 holder 本地的高度（随整组缩放）
      balloonHit: (CARD.BALLOON_R + 0.12) * scale,    // 命中半径同步缩放：看着多大就能打中多大
      bob: CARD.BALLOON_BOB * scale,                  // 上下浮动幅度同步缩放
      kind: e.kind, def: e.def || null, price: e.price || 0, free: !!e.free, slot: e.slot == null ? -1 : e.slot,
      priceText: e.priceText || null, priceColor: e.priceColor || null,   // 第五十八修：卡面底部大字（无 = 不画）
      exploded: false, _explodeT: 0, _denyT: 0,
    });
  }

  // ====== 区域牌子（第五十八修 · 现场「气球上方显示商店币」）======

  /**
   * 技能区 / 道具区各挂一块「商店币」牌子（位置见 open 时算一次；文字每帧刷）。
   *   挂 badgeGroup（独立子组，`_clear()` 不碰它 —— 牌子不随购买重建，只有文字在变）；
   *   朝向与两列卡同口径：平面法线指向场地中线（平行于地面的 Z 线），不各自朝原点歪角度。
   */
  _buildBadges() {
    this._clearBadges();
    // 正前方技能区：整排（技能/强化 ×3 + 购物完成）上方居中
    this.coinFront = makeBadge('', SHOP.PRICE_COLOR);
    // 第五十九修：卡列已收进毯内，牌子挂在列中心（Z=0）上方
    this.coinFront.mesh.position.set(0,
      SHOP.FRONT_Y + CARD.BALLOON_HEIGHT * SHOP.CARD_SCALE_FRONT + SHOP.BADGE_DY, SHOP.FRONT_Z);
    this.badgeGroup.add(this.coinFront.mesh);
    // 左手边道具区：本列**中心**（Z=0）上方（放大后气球更高，按缩放后的高度抬）
    this.coinItem = makeBadge('', SHOP.PRICE_COLOR);
    this.coinItem.mesh.position.set(SHOP.ITEM_X,
      SHOP.ITEM_Y + CARD.BALLOON_HEIGHT * SHOP.CARD_SCALE_ITEM + SHOP.BADGE_DY, SHOP.ITEM_ZC);   // 第五十九修：牌子挂列中心
    this.coinItem.mesh.rotation.y = Math.PI / 2;   // 面向场地中线（+X），与道具列卡面同向
    this.badgeGroup.add(this.coinItem.mesh);
    this._updateBadges();
  }

  /** 每帧刷牌子文字 —— set() 内部只在**文字真的变了**时才重绘 canvas（不变就不上传贴图） */
  _updateBadges() {
    // 文案刻意短：「技能区 · 商店币 3250」这种长度会触发字号自适应缩到 ~48px（见 cardDraft.makeBadge），
    // 短到「商店币 3250」就能吃满 84px 大字；「这块属于哪个区」由牌子挂的位置表达，不必写在字上。
    const coin = Math.floor(this._state?.getShopCoin?.() || 0);
    this.coinFront?.set(`商店币 ${coin}`);
    this.coinItem?.set(`商店币 ${coin}`);
    const done = this.entries.find((e) => e.kind === 'done' && e.badge);
    if (done) done.badge.set(`剩余 ${Math.ceil(Math.max(0, this.timer))}s`);
  }

  _clearBadges() {
    for (const b of [this.coinFront, this.coinItem]) {
      if (!b) continue;
      if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
      b.dispose();
    }
    this.coinFront = null;
    this.coinItem = null;
  }

  // ====== 每帧 ======

  update(dt, bullets, playerPos) {
    if (!this.active) return;
    this.t += dt;
    this._updateBadges();   // 第五十八修：区域牌子（每帧只在文字变化时重绘）
    if (playerPos) this._playerPos.copy(playerPos);

    if (this._resolve) { this._updateResolve(dt); return; }

    this.timer = Math.max(0, this.timer - dt);
    if (this.timer <= 0) {                       // 倒计时到点：自动进下一关（不软锁）
      this._resolve = { t: 0, after: () => this._finish() };
      return;
    }

    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      e.holder.position.y = e.baseY + e.bob * Math.sin(this.t * CARD.BALLOON_BOB_FREQ + i);
      if (e._denyT > 0) {                        // 买不起：气球弹一下再复原
        e._denyT -= dt;
        if (e._denyT <= 0) e.balloon.scale.setScalar(1);
      }
    }

    if (!bullets || !bullets.active) return;
    for (const b of [...bullets.active]) {
      for (const e of this.entries) {
        if (e.exploded) continue;
        // 气球世界坐标 = holder.position + 气球局部 (0, balloonY, 0)（balloonY 已含整组缩放）
        const bx = e.holder.position.x;
        const by = e.holder.position.y + e.balloonY;
        const bz = e.holder.position.z;
        if (pointSegmentDistanceSq({ x: bx, y: by, z: bz }, b.prevPos || b.pos, b.pos) < e.balloonHit ** 2) {
          bullets.release(b);
          if (e._denyT <= 0) this._hit(e);       // 刚被拒（0.4s 内）不重复提示
          break;
        }
      }
      if (this._resolve) break;
    }
  }

  _hit(e) {
    const coin = this._state.getShopCoin() || 0;
    if (e.price > 0 && coin < e.price) {         // 商店币不足：不消费、气球留着，只给反馈
      e._denyT = 0.4;
      e.balloon.scale.setScalar(1.25);
      // 第五十九修：只提示「商店币不足」—— 带数字的长文案在中场横幅上会被裁掉（现场「部分都被遮住了」）
      if (this._state.onDenied) this._state.onDenied('商店币不足');
      return;
    }
    if (e.price > 0) this._state.spendShopCoin(e.price);

    switch (e.kind) {
      case 'done':
        this._resolve = { t: 0, after: () => this._finish() };
        break;
      case 'refresh':
        this.refreshCost *= 2;                   // 逐次翻倍（进店重置）
        this._resolve = { t: 0, after: () => { this._itemDisplay = pickShopItems(3); this._build(); } };
        break;
      case 'skill':
        this._state.onBuySkill(e.def.id);
        this._resolve = { t: 0, after: () => this._build() };   // 有技能了 → 正前方换成强化
        break;
      case 'upgrade':
        this._upgradesBought.add(e.def.id);
        this._state.onBuyUpgrade(e.def.id);
        this._resolve = { t: 0, after: () => this._build() };
        break;
      case 'item': {
        const id = e.def.id;
        this._state.onBuyItem(id);
        if (e.free) {
          this._freeItem = false;   // 名额用掉 → 重绘后其余道具恢复原价
          if (this._state.onDenied) this._state.onDenied('本店首个道具免费！');   // 复用横幅通道给个反馈
        }
        const slot = e.slot;
        this._resolve = {
          t: 0,
          after: () => {                          // 补位：从其余道具里随机补一个，不重抽全排
            const next = pickShopItemExcluding(this._itemDisplay);
            if (next && slot >= 0 && slot < this._itemDisplay.length) this._itemDisplay[slot] = next;
            this._build();
          },
        };
        break;
      }
      default:
        return;
    }
    e.exploded = true;
    e._explodeT = 0;
    this._spawnLightFx(e);
  }

  _updateResolve(dt) {
    const r = this._resolve;
    r.t += dt;
    for (const e of this.entries) {
      if (!e.exploded) continue;
      e._explodeT += dt;
      const k = Math.min(1, e._explodeT / 0.3);
      e.balloon.scale.setScalar(1 + k * 1.5);
      this._setBalloonOpacity(e, 1 - k);
      this._setCardOpacity(e, Math.max(0, 1 - r.t / SHOP.BUY_FLY));
      if (k >= 1) e.balloon.visible = false;
    }

    if (this.lightFx) {
      const TRAVEL = SHOP.BUY_FLY;
      const tgt = this._lightTarget;
      const pos = this.lightFx.geometry.attributes.position;
      for (let i = 0; i < this._lightN; i++) {
        const localT = r.t - this._lightDelay[i];
        const k = localT <= 0 ? 0 : Math.min(localT / TRAVEL, 1);
        const s = this._lightStart[i];
        const e2 = k * k * (3 - 2 * k);
        pos.setXYZ(i, s.x + (tgt.x - s.x) * e2, s.y + (tgt.y - s.y) * e2, s.z + (tgt.z - s.z) * e2);
      }
      pos.needsUpdate = true;
    }

    if (r.t >= SHOP.BUY_FLY) {
      const after = r.after;
      this._resolve = null;
      this._clearLightFx();
      if (after) after();
    }
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    this.active = false;
    this._resolve = null;
    this._clearLightFx();
    this._clearBadges();
    this._clear();
    this.group.visible = false;
  }

  // ====== 表现 / 释放 ======

  _spawnLightFx(e) {
    this._clearLightFx();   // 先清掉上一束（它会重置 _lightStart/_lightDelay/_lightN，必须放在建粒子之前）
    const N = 24;
    const from = e.holder.position;
    const positions = new Float32Array(N * 3);
    this._lightStart = [];
    this._lightDelay = [];
    for (let i = 0; i < N; i++) {
      const sx = from.x + (Math.random() - 0.5) * 0.3;
      const sy = from.y + e.balloonY + (Math.random() - 0.5) * 0.3;
      const sz = from.z + (Math.random() - 0.5) * 0.3;
      positions[i * 3] = sx; positions[i * 3 + 1] = sy; positions[i * 3 + 2] = sz;
      this._lightStart.push(new THREE.Vector3(sx, sy, sz));
      this._lightDelay.push((i / N) * CARD.STREAM_SPREAD);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: new THREE.Color(e.color || '#ffe066'),
      size: CARD.LIGHT_SIZE, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    this.lightFx = new THREE.Points(geo, mat);
    this.group.add(this.lightFx);
    this._lightTarget.copy(this._playerPos);
    this._lightN = N;
  }

  _setBalloonOpacity(e, o) {
    e.balloon.traverse((m) => { if (m.material) { m.material.transparent = true; m.material.opacity = o; } });
  }

  _setCardOpacity(e, o) {
    e.card.material.transparent = true;
    e.card.material.opacity = o;
  }

  _clearLightFx() {
    if (this.lightFx) {
      this.group.remove(this.lightFx);
      this.lightFx.geometry.dispose();
      this.lightFx.material.dispose();
      this.lightFx = null;
    }
    this._lightStart = [];
    this._lightDelay = [];
    this._lightN = 0;
  }

  /** 只读预告卡拆掉（进/出店与 dispose 时调用；`_build()` 不管它 —— 它不随购买变化） */
  _clearPreview() {
    for (const p of this.preview) {
      this.previewGroup.remove(p.holder);
      p.mesh.geometry.dispose();
      p.mesh.material.map?.dispose();
      p.mesh.material.dispose();
    }
    this.preview = [];
  }


  _clear() {
    for (const e of this.entries) {
      this.group.remove(e.holder);
      if (e.badge) { e.badge.dispose(); e.badge = null; }
      e.card.geometry.dispose();
      e.card.material.map?.dispose();
      e.card.material.dispose();
      e.balloon.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
      e.holder.clear?.();
    }
    this.entries = [];
  }

  /** 中途清场（不拆 group，可再次 open 复用）：供 Game.toMenu 清残留商店气球 */
  clearCards() {
    this._clearPreview();
    this._clearLightFx();
    this._clearBadges();
    this._clear();
    this.active = false;
    this.finished = false;
    this.group.visible = false;
  }

  dispose() {
    this._clearPreview();
    this._clearLightFx();
    this._clearBadges();
    this._clear();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}