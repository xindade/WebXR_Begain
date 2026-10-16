// 枪上「商店币」小信息框（第六十四修 · 第六十六修改口径）—— 口径与接线的单测
//
// 现场口径原文（第六十六修，**覆盖**第六十四修那句「往前一点、往右一点」）：
//   「枪商店商店币显示现在挪到枪的右侧，和技能显示框位置对称，同时整体缩小一半。」
// 所以这里锁四件事：
//   ① 位置 = 技能信息框的**镜像**（同横截面 / 等距 / 分列两侧）——用真的 barrelMount 算出来比，不靠肉眼；
//   ② 尺寸**整体减半**且比例不被拉伸（画布 512×160 = 3.2，物理 w/h 必须同比例）；
//   ③ 接线：**局内常显**（第六十五修起不再只在商店关），数字走「金点落地才推」的显示值；
//   ④ userConfig 热调白名单（多出来的键会被 constants 的 _checkKeys 拦下）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { SHOP_COIN, SKILL_HINT, SHOP } from '../src/core/constants.js';
import { USER_CONFIG } from '../src/core/userConfig.js';
import { barrelMount } from '../src/vr/streakCounter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');
const BADGE = SRC('src/vr/shopCoinBadge.js');
const HINT = SRC('src/vr/skillHint.js');
const RIGHT_GUN = SRC('src/vr/rightGun.js');
const GAME = SRC('src/game/game.js');
const CARD_DRAFT = SRC('src/game/cardDraft.js');
const DISPLAY = SRC('src/game/shopCoinDisplay.js');   // 第六十五修：显示值推进（纯函数）

// ---------- ① 口径（第六十六修）：位置 = 技能信息框的镜像 ----------
//
// 两个面板用的是**同一套**「按枪模型自动定位」（skillHint.placeOnGun / shopCoinBadge.placeOnGun）：
//   位置 = 轴上 ALONG 处 + (up × 枪管轴) × (SIDE < 0 ? +1 : -1) × (radius + LATERAL_GAP)
// 于是「对称」被拆成三条可以算的式子：
//   ALONG 同值（同一条横截面）+ LATERAL_GAP 同值（等距）+ SIDE 反号（分列两侧）。
const BOX = new THREE.Box3(new THREE.Vector3(-0.05, -0.05, -0.4), new THREE.Vector3(0.05, 0.05, 0.4));
const UP = new THREE.Vector3(0, 1, 0);

/** 照着 placeOnGun 的公式复算一遍挂点（枪空间）—— 不改源码，只把结果拿来比 */
function mountOf(box, M) {
  const m = barrelMount(box, M);
  const off = UP.clone().cross(m.axis);                  // up × 枪管轴 = 玩家左手边
  if (off.lengthSq() < 1e-8) off.set(-1, 0, 0);
  const gap = m.radius + (M.LATERAL_GAP || 0);
  off.normalize().multiplyScalar((M.SIDE < 0 ? 1 : -1) * gap);
  return { m, off, pos: m.position.clone().add(off).addScaledVector(UP, M.UP || 0) };
}

test('商店币框 = 技能信息框的镜像：同横截面、等距、分列枪身两侧', () => {
  const panel = mountOf(BOX, SKILL_HINT.MOUNT);
  const coin = mountOf(BOX, SHOP_COIN.MOUNT);

  // ① 同一横截面 —— 「以枪支为它的显示框中心点」的那条中线
  assert.equal(SHOP_COIN.MOUNT.ALONG, SKILL_HINT.MOUNT.ALONG, 'ALONG 必须同值（同一条横截面）');
  const alongDiff = coin.pos.clone().sub(panel.pos).dot(panel.m.axis);
  assert.ok(Math.abs(alongDiff) < 1e-9, `沿轴不许有前后差（实际 ${alongDiff.toFixed(6)}m）`);

  // ② 等距 —— 镜像必须离轴一样远
  assert.equal(SHOP_COIN.MOUNT.LATERAL_GAP, SKILL_HINT.MOUNT.LATERAL_GAP, 'LATERAL_GAP 必须同值（等距）');
  assert.equal(coin.m.radius, panel.m.radius, '同一把枪、同一套算法 ⇒ 枪身半径相同');
  assert.ok(Math.abs(coin.off.length() - panel.off.length()) < 1e-12, '两侧离轴距离必须相等');

  // ③ 分列两侧 —— 两个侧向偏移互为相反向量 = 严格对称
  assert.equal(SHOP_COIN.MOUNT.SIDE, -SKILL_HINT.MOUNT.SIDE, 'SIDE 必须反号（信息框在左 ⇒ 商店币在右）');
  assert.ok(panel.off.clone().add(coin.off).length() < 1e-12,
    '偏移向量相加为零向量 ⇒ 关于枪管轴严格镜像');
});

test('商店币框在玩家**右手边**，且两侧用的是同一条侧向公式', () => {
  const coin = mountOf(BOX, SHOP_COIN.MOUNT);
  const leftDir = UP.clone().cross(coin.m.axis).normalize();   // 玩家左手边
  assert.ok(coin.off.dot(leftDir) < 0, '偏移落在「左手边」的反方向 = 右手边');
  assert.ok(coin.pos.clone().sub(coin.m.position).dot(leftDir) < 0, '整体看也在右手边');
  // 两个面板必须共用同一条公式，否则以后调一处就悄悄失去对称
  const formula = '_left.normalize().multiplyScalar((M.SIDE < 0 ? 1 : -1) * gap);';
  assert.ok(HINT.includes(formula), 'skillHint 用这条侧向公式');
  assert.ok(BADGE.includes(formula), 'shopCoinBadge 必须用**同一条**公式（改一处就失去对称）');
});

// ---------- ② 尺寸：整体缩小一半，比例对得上就不会被拉伸 ----------

test('整体缩小一半（第六十六修）：W / H 各是上一版的一半', () => {
  assert.ok(Math.abs(SHOP_COIN.W - 0.24 / 2) < 1e-12, `W 应为上一版 0.24 的一半（实际 ${SHOP_COIN.W}）`);
  assert.ok(Math.abs(SHOP_COIN.H - 0.075 / 2) < 1e-12, `H 应为上一版 0.075 的一半（实际 ${SHOP_COIN.H}）`);
});

test('商店币框：物理宽高比 = 画布宽高比 3.2（缩一半也不许拉伸）', () => {
  const aspect = SHOP_COIN.W / SHOP_COIN.H;
  const canvas = 512 / 160;                 // cardDraft.makeBadge 的画布
  assert.ok(Math.abs(aspect - canvas) < 1e-6, `物理宽高比 ${aspect} 必须等于画布 ${canvas}`);
  assert.ok(Math.abs((SHOP.BADGE_W / SHOP.BADGE_H) - canvas) < 1e-6, '商店区域牌子也是同一比例');
  assert.ok(SHOP_COIN.W > 0 && SHOP_COIN.H > 0);
  assert.ok(SHOP_COIN.W < SHOP.BADGE_W, '它是「小」信息框：比商店里那块大牌子小');
});

test('makeBadge 支持第三参覆盖物理尺寸（不传时行为完全不变）', () => {
  assert.ok(CARD_DRAFT.includes('export function makeBadge(text, color, size = null)'), '签名要带 size');
  assert.ok(CARD_DRAFT.includes('(size && size.w) || SHOP.BADGE_W'), '不传 size 必须回落原常量');
});

// ---------- ③ 接线：局内常显、走商店币余额、按枪模型定位 ----------

test('接线：game 每帧把「显隐 + 余额 + 在飞金点 + 落地金额」下发给枪上的小框', () => {
  // 第六十五修：现场要求「非商店关也要看到商店币数量」⇒ 显隐判据从 shopMode 换成「局内」，
  //   而且必须排在 fx.update 之后（要先知道本帧金点落地多少，数字才跟着变）。
  assert.ok(GAME.includes('rg.setShopCoin(this._shopCoinBadgeOn(), this.shopCoin,'),
    '显隐与数字都必须由 game 每帧下发');
  assert.ok(GAME.includes("return this.state === 'playing' || this.state === 'card';"),
    '局内常显：playing / 抽卡都显示（菜单与开场影片收起）');
  assert.ok(GAME.indexOf('this.fx.update(dt, this._coinTarget)') < GAME.indexOf('this._updateShopCoinBadge(coinLanded)'),
    '必须先推进金点、再推数字');
});

test('接线：rightGun 建它、挂到 grip、并用与信息框同一套 barrelMount 定位', () => {
  assert.ok(RIGHT_GUN.includes('new ShopCoinBadge()'), '由 RightGun 持有');
  assert.ok(RIGHT_GUN.includes('this.coinBadge.attach(anchor)'), '挂到右手柄(grip)');
  assert.ok(RIGHT_GUN.includes('this.coinBadge.placeOnGun(this.model, this.root)'), '按枪模型自动定位');
  assert.ok(BADGE.includes("from './streakCounter.js'") && BADGE.includes('barrelMount'),
    '复用枪管挂点算法（不要另写一套坐标）');
  assert.ok(DISPLAY.includes("'商店币 ' +"), '文案带「商店币」前缀（与商店里两块区域牌子同口径）');
  assert.ok(BADGE.includes('this.mesh.visible = false'), '构造时默认隐藏（显隐由 game 每帧下发）');
});

test('总开关：SHOP_COIN.ENABLED=false 时 rightGun 根本不建它（一键回退）', () => {
  assert.ok(RIGHT_GUN.includes('SHOP_COIN.ENABLED ? new ShopCoinBadge() : null'));
});

test('userConfig 镜像：SHOP_COIN 里的键必须都是 constants 里有的（热调白名单口径）', () => {
  const patch = USER_CONFIG.SHOP_COIN;
  assert.ok(patch && typeof patch === 'object', 'userConfig 要有 SHOP_COIN 段');
  const bad = Object.keys(patch).filter((k) => !(k in SHOP_COIN));
  assert.deepEqual(bad, [], '多出来的键会被 constants 的 _checkKeys 拦下，这里提前报出来');
});
