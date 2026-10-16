// 击杀金点 → 枪上「商店币」小框（第六十五修）—— 口径、行为与接线的单测
//
// 现场口径原文：「在枪上的这一块信息框给玩家在非商店关时看到商店币数量，
//                同时怪打死后要有金色光点飞到这里接着数字变动，让玩家体验感更强。」
// 所以这里锁三件事：
//   ① 显示值推进（shopCoinDisplay.advanceShown）：有金点在飞时数字**落后**真实值，落地才补；
//      金点没了（全落地 / 被清掉 / 池满并走 / 开关关掉）→ 一帧对齐，永远不会与真实值错账；
//   ② 金点本体（fx.CoinOrbFx）：终点取**当帧**的小框世界坐标（枪拿在手上一直在动，也保证落得到）、
//      池化不增长、金额一分不丢、拿不到终点就立刻落地；
//   ③ 接线：三条入账路径都传击杀位置、真实值即时入账、且在 fx.update 之后再推数字。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { advanceShown, coinBadgeText } from '../src/game/shopCoinDisplay.js';
import { CoinOrbFx } from '../src/game/fx.js';
import { SHOP_COIN } from '../src/core/constants.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');
const GAME = SRC('src/game/game.js');
const RIGHT_GUN = SRC('src/vr/rightGun.js');
const BADGE = SRC('src/vr/shopCoinBadge.js');
const DISPLAY = SRC('src/game/shopCoinDisplay.js');
const FX_SRC = SRC('src/game/fx.js');

const DT = 1 / 60;
const DUR = SHOP_COIN.ORB.DUR;
const mk = (cfg = {}) => new CoinOrbFx(new THREE.Scene(), { ...SHOP_COIN.ORB, ...cfg });
const ORIGIN = () => new THREE.Vector3(0, 1.2, -9);
const STILL = (out) => out.set(0.2, 1.35, -0.3);   // 不动的终点（正常情况枪是动的，见下面那个用例）

// ---------- ① 显示值推进（纯函数）----------

test('显示值：有金点在飞 → 落后真实值，绝不提前跳', () => {
  assert.equal(advanceShown(0, 300, 1, 0), 0, '金点还在飞：真实值 300 也先不显示');
  assert.equal(advanceShown(0, 300, 2, 100), 100, '落一笔补一笔');
  assert.equal(advanceShown(100, 300, 1, 100), 200);
});

test('显示值：金点全落地（inflight=0）→ 一帧对齐真实值', () => {
  assert.equal(advanceShown(200, 300, 0, 100), 300);
  assert.equal(advanceShown(0, 300, 0, 0), 300, '池满被并走 / 切关清空 / 开关关掉都走这条兜底');
});

test('显示值：真实值变小（商店花钱 / 一局清零）→ 显示值只能跟着降，不许虚高', () => {
  assert.equal(advanceShown(900, 100, 2, 0), 100);
  assert.equal(advanceShown(900, 0, 0, 0), 0);
});

test('显示值：负数 / NaN 一律当 0（牌子不许写成负数）', () => {
  assert.equal(advanceShown(-5, -100, 0, -3), 0);
  assert.equal(advanceShown(NaN, NaN, NaN, NaN), 0);
});

test('小框文案：「商店币」+ 整数（与商店里两块区域牌子同口径）', () => {
  assert.equal(coinBadgeText(1234), '商店币 1234');
  assert.equal(coinBadgeText(0), '商店币 0');
  assert.equal(coinBadgeText(-9), '商店币 0');
});

// ---------- ② 金点本体（真 THREE 对象池）----------

test('金点：终点一直在动（枪拿在手上）也一定在 DUR 秒内精确落到终点上', () => {
  const fx = mk({ POOL: 2 });
  assert.equal(fx.cast(ORIGIN(), 120), true, '起了新光点');
  assert.equal(fx.inflight, 1);
  let t = 0, landed = 0;
  const last = new THREE.Vector3();
  const moving = (out) => { out.set(Math.sin(t * 3) * 2, 1.4 + Math.sin(t * 5) * 0.25, -0.3); last.copy(out); return out; };
  while (fx.inflight > 0 && t < DUR + 0.2) {   // 落地即停：再往后跑就还会问终点，last 不再是落地那一帧的
    landed += fx.update(DT, moving);
    t += DT;
  }
  assert.ok(t <= DUR + DT, '必须在 DUR + 一帧内落地（实际 ' + t.toFixed(3) + 's）');
  assert.equal(landed, 120, '落地金额 = 起飞金额（一分不丢）');
  assert.equal(fx.inflight, 0, 'DUR 之内必须落地（不靠距离阈值，所以不会漏判成"永远在飞"）');
  assert.ok(fx.slots[0].sp.position.distanceTo(last) < 1e-9,
    `最后一帧必须精确落在当帧终点上（差 ${fx.slots[0].sp.position.distanceTo(last)}m）`);
});

test('金点池：超过 POOL 不再增长，金额并进最老的槽（钱一分不丢）', () => {
  const fx = mk({ POOL: 3, DUR: 10 });
  for (let i = 0; i < 3; i++) assert.equal(fx.cast(ORIGIN(), 10), true);
  assert.equal(fx.slots.length, 3);
  assert.equal(fx.cast(ORIGIN(), 7), false, '池满 → 不起新光点');
  assert.equal(fx.slots.length, 3, '槽数不许再长（帧内不 new）');
  assert.equal(fx.inflight, 3);
  assert.equal(fx.update(DT, STILL), 0, '这一帧还没到点');
  assert.equal(fx.update(50, STILL), 37, '3×10 + 并进老槽的 7 全都要落地');
  assert.equal(fx.update(50, STILL), 0, '落地后不再重复计数');
});

test('金点：拿不到终点（小框没建 / 没挂上）→ 立刻落地，数字照变，不卡账', () => {
  const fx = mk({ POOL: 2 });
  fx.cast(ORIGIN(), 55);
  assert.equal(fx.inflight, 1);
  assert.equal(fx.update(DT, null), 55);
  assert.equal(fx.inflight, 0);
});

test('总开关：ORB.ENABLED=false → 不飞金点（数字应当立刻变动 = 旧行为）', () => {
  const fx = mk({ ENABLED: false });
  assert.equal(fx.cast(ORIGIN(), 10), false);
  assert.equal(fx.inflight, 0);
  assert.equal(advanceShown(0, 10, fx.inflight, 0), 10, '没有金点 → 显示值一帧到位');
});

test('切关 / 重开清空：在飞的金点直接消失，显示值靠 inflight=0 兜底对齐', () => {
  const fx = mk({ POOL: 2 });
  fx.cast(ORIGIN(), 10);
  fx.clear();
  assert.equal(fx.inflight, 0);
  assert.equal(advanceShown(0, 10, fx.inflight, 0), 10, '清空后不许把数字留在 0');
});

test('金点表现：金色小光点 + 穿透显示（隔着怪/枪也看得见）', () => {
  const fx = mk({ POOL: 1 });
  fx.cast(ORIGIN(), 10);
  const s = fx.slots[0].sp;
  assert.ok(s.isSprite, 'billboard：永远面向玩家');
  assert.equal(s.material.depthTest, false, 'depthTest:false → 不被怪/枪模型挡住');
  assert.equal(s.material.color.getHex(), SHOP_COIN.ORB.COLOR, '颜色 = ORB.COLOR（金）');
  assert.equal(s.renderOrder, 998);
  assert.ok(SHOP_COIN.ORB.SIZE > 0 && SHOP_COIN.ORB.SIZE < 0.3, '尺寸是"零钱"级小光点，不是出怪光点');
  assert.ok(SHOP_COIN.ORB.POOL > 0, '池必须有上限');
});

// ---------- ③ 接线 ----------

test('接线：三条入账路径都把击杀位置交给金点（不传位置 = 不飞金点）', () => {
  assert.ok(GAME.includes('this._addShopCoin(_killScore, balloon.mesh.position)'), '普通击杀');
  assert.ok(GAME.includes('this._addShopCoin(balloon.score, balloon.mesh.position)'), '龙部件');
  assert.ok(GAME.includes('this._addShopCoin(bonus, balloon.mesh.position)'), '聚宝盆');
});

test('接线：真实值即时入账 + 金点起飞，两者谁都不能顶替谁', () => {
  assert.ok(GAME.includes('this.shopCoin += amount;'), '真实值必须即时入账（商店扣款/切关都读它）');
  assert.ok(GAME.includes('if (amount > 0 && fromPos && this.fx) this.fx.coinOrb(fromPos, amount);'));
  assert.ok(GAME.includes('this.hud.setShopCoin(this.shopCoin);'), 'HUD 仍走真实值');
});

test('接线：先推进金点、再把「落地金额 + 在飞数量 + 真实值」推给小框', () => {
  assert.ok(GAME.includes('const coinLanded = this.fx.update(dt, this._coinTarget);'));
  assert.ok(GAME.includes('this._updateShopCoinBadge(coinLanded);'));
  assert.ok(GAME.includes('this.fx.coinFlightCount()'), '在飞数量取自 fx（不是自己数的）');
  assert.ok(GAME.indexOf('const coinLanded = this.fx.update') < GAME.indexOf('this._updateShopCoinBadge(coinLanded);'),
    '顺序：先进金点，再推数字');
});

test('接线：终点 = 小框当帧世界坐标（枪在动，所以每帧重新取）', () => {
  assert.ok(GAME.includes('this.rightGun.coinBadgeWorldPos(out)'));
  assert.ok(RIGHT_GUN.includes('coinBadgeWorldPos(out) { return this.coinBadge ? this.coinBadge.worldPosition(out) : null; }'));
  assert.ok(BADGE.includes('worldPosition(out) { return this.mesh.getWorldPosition(out || new THREE.Vector3()); }'));
});

test('接线：小框数字走 advanceShown（显示值滞后）+ 文案走 coinBadgeText', () => {
  assert.ok(BADGE.includes('advanceShown(this._shown, p.total, p.inflight, p.landed)'));
  assert.ok(BADGE.includes('coinBadgeText(this._shown)'));
  assert.ok(RIGHT_GUN.includes('b.update({ total: coin, inflight, landed });'));
  assert.ok(RIGHT_GUN.includes('setShopCoin(on, coin, inflight = 0, landed = 0)'));
  assert.ok(FX_SRC.includes('return this.coinOrbFx.update(dt, coinTarget);'), '门面把落地金额回传（不吞掉）');
  assert.ok(FX_SRC.includes('this.coinOrbFx = new CoinOrbFx(scene, SHOP_COIN.ORB)'));
  assert.ok(DISPLAY.includes('export function advanceShown'));
});
