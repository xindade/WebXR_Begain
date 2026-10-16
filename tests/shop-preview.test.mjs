// 商店关「精英预告」卡（第五十七修）—— 纯函数口径单测
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { previewCards, shopWindow, ELITE_BRIEF, BOSS_BRIEF } from '../src/content/eliteBrief.js';
import { LEVELS } from '../src/content/levels.js';
import * as THREE from 'three';
import { SHOP, CARD } from '../src/core/constants.js';
import { ShopDraft } from '../src/game/shop.js';
import { elitePortrait } from '../src/content/eliteBrief.js';
import { ENEMY_TYPES } from '../src/content/enemies.js';
import { portraitKey, portraitCanvas, composePortrait, opaquePixels, PORTRAIT_MAIN_FRAC, PORTRAIT_SHIELD_FRAC, PORTRAIT_FALLBACK_COLOR } from '../src/game/enemyPortrait.js';
import { makeCardTexture, makeBadge, titleFont, TITLE_MAX_W, TITLE_FONT_MAX, TITLE_FONT_MIN } from '../src/game/cardDraft.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CARD_DRAFT = fs.readFileSync(path.join(HERE, '..', 'src', 'game', 'cardDraft.js'), 'utf8');

const labels = (s) => previewCards(s).map((c) => c.label);

test('预告窗口 = 本店之后 → 下一个商店之前（3→4-8 / 9→10-14 / 15→16-18）', () => {
  assert.deepEqual(shopWindow(3).levels, [4, 5, 6, 7, 8]);
  assert.deepEqual(shopWindow(9).levels, [10, 11, 12, 13, 14]);
  assert.deepEqual(shopWindow(15).levels, [16, 17, 18]);
  assert.equal(shopWindow(3).prevShop, null);
  assert.equal(shopWindow(9).prevShop, 3);
  assert.equal(shopWindow(15).prevShop, 9);
});

test('第 3 关：4-8 关新登场的四种精英 + 脸谱 Boss（共 5 张）', () => {
  assert.deepEqual(labels(3), ['铁甲兵', '盾甲兵', '治疗术士', '忍者队长', '脸谱 Boss']);
});

test('第 9 关：前面介绍过的省略，只留幽灵法师 / 章鱼将军 / 龙 Boss', () => {
  assert.deepEqual(labels(9), ['幽灵法师', '章鱼将军', '龙 Boss']);
  for (const done of ['铁甲兵', '盾甲兵', '治疗术士', '忍者队长']) {
    assert.ok(!labels(9).includes(done), `${done} 已在第 3 关介绍过，不该重复`);
  }
});

test('第 15 关：精英都介绍过了 → 只剩「未知 Boss」三形态各一张', () => {
  const cs = previewCards(15);
  assert.equal(cs.length, 3);
  assert.ok(cs.every((c) => c.label.startsWith('未知 Boss')), '三张都是未知 Boss 的形态卡');
  assert.deepEqual(cs.map((c) => c.label), ['未知 Boss 阶段一', '未知 Boss 阶段二', '未知 Boss 阶段三']);
  // 现场口径：**不剧透**是魔术师
  const text = cs.map((c) => c.label + c.sub).join('|');   // 只看卡面（key 是内部 id，上不了屏）
  assert.ok(!text.includes('魔术师'), '第 18 关 Boss 不得剧透为「魔术师」');
  assert.ok(!text.includes('magician'), '内部 id 也不能漏进卡面');
});

test('非商店关不预告（空数组，不报错）', () => {
  for (const n of [0, 1, 2, 4, 6, 12, 18, 99]) assert.deepEqual(previewCards(n), [], `第 ${n} 关不该有预告卡`);
});

test('每张卡的 icon 都必须真的画得出来（drawSketchIcon 有对应 case）', () => {
  const all = [3, 9, 15].flatMap((s) => previewCards(s));
  assert.ok(all.length > 0);
  for (const c of all) {
    assert.ok(c.icon, `${c.label} 缺 icon`);
    assert.ok(CARD_DRAFT.includes(`case '${c.icon}'`), `drawSketchIcon 缺 ${c.icon}（会退化成兜底圆点）`);
  }
});

test('卡面文案不超行（sub ≤ 3 行 × 每行约 9 字），且卡框色是 #rrggbb', () => {
  for (const c of [3, 9, 15].flatMap((s) => previewCards(s))) {
    assert.ok(c.sub.length > 0 && c.sub.length <= 27, `${c.label} 文案 ${c.sub.length} 字：${c.sub}`);
    assert.match(c.color, /^#[0-9a-f]{6}$/i, `${c.label} 颜色`);
    assert.ok(c.key && c.label, `${c.label} 缺 key/label`);
  }
});

test('介绍表覆盖脚本里会出现的一切「非杂鱼」种类（新增敌种必须补文案）', () => {
  for (const [type, b] of Object.entries(ELITE_BRIEF)) {
    assert.ok(b.name && b.icon && b.tip, `${type} 介绍不完整`);
  }
  for (const [boss, b] of Object.entries(BOSS_BRIEF)) {
    assert.ok(b.name && b.icon && b.color, `${boss} 介绍不完整`);
    if (b.phases) for (const p of b.phases) assert.ok(p.tip, `${boss} 形态缺要点`);
    else assert.ok(b.tip, `${boss} 缺要点`);
  }
  // 第 3/9 关的预告必须把「4-14 关里出现的每种精英」都覆盖到
  const shown = new Set([...previewCards(3), ...previewCards(9)].map((c) => c.key));
  for (const t of ['eliteKnight', 'shield', 'heart', 'ninja', 'ghost', 'octopus']) {
    assert.ok(shown.has(t), `${t} 从没被预告过`);
  }
});

test('商店关就是 3/9/15（预告窗口的口径前提）', () => {
  assert.deepEqual(LEVELS.filter((l) => l.kind === 'shop').map((l) => l.n), [3, 9, 15]);
});
// ---------- 挂进商店场地：生命周期（进店建一次 / 购买不重建 / 清场拆掉） ----------

function makeShopState(shopLevel, coin = 5000) {
  const itemLv = {};
  return {
    coin,
    getShopCoin() { return this.coin; },
    spendShopCoin(c) { this.coin -= c; },
    hasSkill: () => false,
    getItemLevels: () => itemLv,
    priceMul: () => 1,
    onBuySkill() {}, onBuyUpgrade() {}, onBuyItem: (id) => { itemLv[id] = (itemLv[id] || 0) + 1; }, onDenied() {},
    shopLevel,
  };
}

test('进店即建预告卡、买道具不重建、清场时拆掉', () => {
  const shop = new ShopDraft(new THREE.Scene());
  const ORIGIN = new THREE.Vector3(0, 1.6, 0);
  shop.open(ORIGIN, makeShopState(3));

  assert.equal(shop.preview.length, 5, '第 3 关进店就该有 5 张预告卡');
  assert.ok(shop.preview.every((p) => p.holder.parent === shop.previewGroup), '挂在独立子组（_clear 不碰）');
  const previewHolders = shop.preview.map((p) => p.holder);
  assert.ok(!shop.entries.some((e) => previewHolders.includes(e.holder)), '预告卡不进 entries ⇒ 打不中');
  // 位置 = 道具列的镜像位（X 取反），高度一致
  assert.ok(Math.abs(shop.preview[0].holder.position.x - -SHOP.ITEM_X) < 1e-9, 'X 是道具列的镜像');
  assert.ok(Math.abs(shop.preview[0].holder.position.y - SHOP.ITEM_Y) < 1e-9, '与道具列同高');

  // 打一发买掉第一个道具 → 场地重建（entries 换新），但预告卡原样保留
  const target = shop.entries.find((e) => e.kind === 'item');
  const p = target.holder.position.clone();
  p.y += target.balloonY;   // 第五十八修：气球高度已含整组缩放
  const bullets = { active: [{ pos: p, prevPos: p.clone(), dmg: 10 }], release() { this.active.length = 0; }, sync() {} };
  shop.update(0.016, bullets, ORIGIN);
  for (let i = 0; i < 60; i++) shop.update(0.016, null, ORIGIN);

  assert.deepEqual(shop.preview.map((x) => x.holder), previewHolders, '购买只重建可买的卡，预告卡不重建');
  assert.ok(shop.entries.length > 0 && !shop.entries.some((e) => previewHolders.includes(e.holder)));

  shop.clearCards();
  assert.equal(shop.preview.length, 0, '清场要把预告卡一起拆掉');
});

// ================= 立绘（第五十七修 v2 · 现场口径：精英露模型、Boss 只显示未知） =================

test('每张精英卡都挂真实模型立绘（与 enemies.js 同源），Boss 卡一律无图', () => {
  const all = [3, 9, 15].flatMap((s) => previewCards(s));
  assert.ok(all.length > 0);
  for (const c of all) {
    if (c.key in ELITE_BRIEF) {
      assert.ok(c.portrait && c.portrait.url, `${c.label} 缺少立绘来源`);
      assert.equal(c.portrait.url, ENEMY_TYPES[c.key].model, `${c.label} 的立绘必须就是局内那份 GLB`);
    } else {
      assert.equal(c.portrait, null, `${c.label} 是 Boss 卡：不给图，卡面只显示「?」`);
    }
  }
  // 有图的张数：第 3 关 4/5、第 9 关 2/3、第 15 关 0/3（三张都是 Boss 形态卡）
  assert.deepEqual([3, 9, 15].map((s) => previewCards(s).filter((c) => c.portrait).length), [4, 2, 0]);
});

test('盾甲兵立绘 = 骑士 + 盾牌两个模型（否则和铁甲兵长得一模一样）', () => {
  const shield = previewCards(3).find((c) => c.key === 'shield');
  assert.equal(shield.portrait.url, ENEMY_TYPES.shield.model);
  assert.equal(shield.portrait.shieldModel, ENEMY_TYPES.shield.shieldModel);
  const knight = previewCards(3).find((c) => c.key === 'eliteKnight');
  assert.notEqual(portraitKey(shield.portrait), portraitKey(knight.portrait), '两张卡的立绘不能共用同一份缓存');
  assert.equal(portraitKey(knight.portrait), ENEMY_TYPES.eliteKnight.model);
});

test('抓不到立绘也不能崩：无 renderer / 空 spec 一律 resolve(null) 走回退', async () => {
  assert.equal(await portraitCanvas(null, { url: 'Model/骑士.glb' }), null);
  assert.equal(await portraitCanvas({}, null), null);
  assert.equal(portraitKey(null), '');
  assert.equal(portraitKey({}), '');
});

test('卡面立绘版式：有图画图、没图画「?」，非立绘卡仍走简笔画', () => {
  const orig = globalThis.document.createElement;
  const record = () => {
    const calls = [];
    const ctx = new Proxy({}, {
      get: (_t, key) => (key === 'measureText' ? () => ({ width: 0 })
        : key === 'createRadialGradient' || key === 'createLinearGradient' ? () => ({ addColorStop() {} })
        : (...args) => { calls.push([key, ...args]); }),
    });
    globalThis.document.createElement = () => ({ width: 0, height: 0, style: {}, getContext: () => ctx });
    return calls;
  };
  try {
    let calls = record();
    makeCardTexture('铁甲兵', '直冲近身', '#4d9dff', 'eKnight', { portrait: true, image: { width: 512, height: 512 } });
    assert.ok(calls.some((c) => c[0] === 'drawImage'), '有立绘必须 drawImage');
    assert.ok(!calls.some((c) => c[0] === 'fillText' && c[1] === '?'), '有立绘不该再画「?」');
    assert.ok(!calls.some((c) => c[0] === 'arc'), '立绘版式不画简笔画图标');
    const title = calls.find((c) => c[0] === 'fillText' && c[1] === '铁甲兵');
    assert.ok(title && title[2] === 128, '标题仍居中');

    calls = record();
    makeCardTexture('龙 Boss', '龙头无敌', '#ffd43b', 'bossDragon', { portrait: true, image: null, placeholder: '?' });
    assert.ok(calls.some((c) => c[0] === 'fillText' && c[1] === '?'), '没立绘要画「?」占位');
    assert.ok(!calls.some((c) => c[0] === 'drawImage'), '没立绘不该 drawImage');

    // 精英卡抓帧失败（无图、无 placeholder）→ 退回简笔画图标：仍能认出是谁，不会变成 Boss 卡
    calls = record();
    makeCardTexture('铁甲兵', '直冲近身', '#4d9dff', 'eKnight', { portrait: true, image: null });
    assert.ok(calls.some((c) => c[0] === 'stroke'), '立绘失败要退回简笔画');
    assert.ok(!calls.some((c) => c[0] === 'fillText' && c[1] === '?'));

    calls = record();
    makeCardTexture('刷新道具', '重抽三个道具（200）', '#f1c40f', 'refresh');
    assert.ok(calls.some((c) => c[0] === 'stroke'), '非立绘卡照旧画简笔画');
    assert.ok(!calls.some((c) => c[0] === 'drawImage'));
  } finally {
    globalThis.document.createElement = orig;
  }
});

test('第五十八修 · 商店卡面价位：底部粗体大字、金色 / 免费绿；非商店卡不画', () => {
  const orig = globalThis.document.createElement;
  // 记录型 canvas：既要方法调用（fillText），也要属性赋值（font / fillStyle 是画笔状态）
  const rec = () => {
    const calls = []; const sets = [];
    const ctx = new Proxy({}, {
      get: (_t, key) => (key === "measureText" ? () => ({ width: 0 })
        : key === "createRadialGradient" || key === "createLinearGradient" ? () => ({ addColorStop() {} })
        : (...args) => { calls.push([key, ...args]); }),
      set: (_t, key, v) => { sets.push([key, v]); return true; },
    });
    globalThis.document.createElement = () => ({ width: 0, height: 0, style: {}, getContext: () => ctx });
    return { calls, sets, fonts: () => sets.filter((s) => s[0] === "font").map((s) => s[1]),
      fillStyles: () => sets.filter((s) => s[0] === "fillStyle").map((s) => s[1]) };
  };
  try {
    let r = rec();
    makeCardTexture("技能强化", "冷却缩短", "#33ccff", "refresh", { price: "1500", priceColor: SHOP.PRICE_COLOR });
    assert.ok(r.calls.some((c) => c[0] === "fillText" && c[1] === "1500"), "价位必须画在卡面上");
    assert.ok(r.fonts().includes("bold 44px sans-serif"), "价位用放大一倍的粗体（说明文字是 22px）");
    assert.ok(r.fillStyles().includes(SHOP.PRICE_COLOR), "价位用容易区分的金色");
    r = rec();
    makeCardTexture("吸血子弹", "击杀回血", "#e056fd", "refresh", { price: "免费", priceColor: SHOP.PRICE_FREE_COLOR });
    assert.ok(r.calls.some((c) => c[0] === "fillText" && c[1] === "免费"), "免费也要画出来");
    assert.ok(r.fillStyles().includes(SHOP.PRICE_FREE_COLOR), "免费用绿色");
    r = rec();
    makeCardTexture("落日余晖", "无价位", "#ffffff", "refresh");
    assert.ok(!r.fonts().includes("bold 44px sans-serif"), "不带价位（选项卡 / 预告卡）照旧不画底部大字");
  } finally {
    globalThis.document.createElement = orig;
  }
});

test('商店把立绘喂进卡面：previewPortraits 只报精英、按模型去重；setPortrait 换图并重建这一列', () => {
  const shop = new ShopDraft(new THREE.Scene());
  const ORIGIN = new THREE.Vector3(0, 1.6, 0);
  shop.open(ORIGIN, makeShopState(3));

  const specs = shop.previewPortraits();
  // 第 3 关：铁甲兵 / 盾甲兵（骑士+盾）/ 治疗术士 / 忍者队长 → 4 份模型（Boss 卡不抓）
  assert.equal(specs.length, 4);
  assert.ok(specs.every((s) => s && s.url), '报出来的必须都是可抓的 spec');
  assert.equal(new Set(specs.map(portraitKey)).size, specs.length, '同一个模型不能抓两次');

  const holdersBefore = shop.preview.map((p) => p.holder);
  shop.setPortrait(portraitKey(specs[0]), { width: 8, height: 8 });
  assert.equal(shop.preview.length, 5, '换图不改变卡片数量');
  assert.notEqual(shop.preview[0].holder, holdersBefore[0], 'setPortrait 要重建这一列（贴图换成新的）');
  assert.ok(shop.preview.every((p) => p.holder.parent === shop.previewGroup));

  const holders2 = shop.preview.map((p) => p.holder);
  shop.setPortrait(portraitKey(specs[0]), { width: 8, height: 8 });   // 同 key 再来一次
  shop.setPortrait('', { width: 8, height: 8 });                     // 空 key
  shop.setPortrait('whatever', null);                                // 空图
  assert.deepEqual(shop.preview.map((p) => p.holder), holders2, '重复/空输入不得反复重建');

  // 换店（第 9 关）：只抓幽灵 / 章鱼两份模型
  shop.open(ORIGIN, makeShopState(9));
  assert.deepEqual(shop.previewPortraits().map(portraitKey), [ENEMY_TYPES.ghost.model, ENEMY_TYPES.octopus.model]);

  shop.dispose();
});
test('第五十八修 · 牌子字号自适应：短文案用最大字号，长文案自动缩小到放得下', () => {
  const orig = globalThis.document.createElement;
  // 记录型 canvas：measureText 按**当前字号**估算宽度（CJK 一字 ≈ 1em），才能验证「量宽→缩字号」这个循环
  const rec = () => {
    const sets = []; let fontSize = 0;
    const ctx = new Proxy({}, {
      get: (_t, key) => (key === 'measureText' ? (s) => ({ width: [...String(s)].length * fontSize })
        : key === 'createRadialGradient' || key === 'createLinearGradient' ? () => ({ addColorStop() {} })
        : () => {}),
      set: (_t, key, v) => { sets.push([key, v]); if (key === 'font') { const m = /(\d+)px/.exec(String(v)); if (m) fontSize = Number(m[1]); } return true; },
    });
    globalThis.document.createElement = () => ({ width: 0, height: 0, style: {}, getContext: () => ctx });
    return { fonts: () => sets.filter((s) => s[0] === 'font').map((s) => s[1]) };
  };
  try {
    let r = rec();
    makeBadge('60s', SHOP.PRICE_COLOR);   // 3 字符：量宽远小于可用宽度，不该缩
    assert.equal(r.fonts().slice(-1)[0], 'bold 84px sans-serif', '短文案（3 字符）用最大字号');
    const shortSize = 84;
    r = rec();
    const text = '商店币 123456789';   // 合成超长文案：只为验证「量宽→缩字号」这个循环
    makeBadge(text, SHOP.PRICE_COLOR);
    const size = Number(/bold (\d+)px/.exec(r.fonts().slice(-1)[0])[1]);
    assert.ok(size < 84, `长文案要缩字号（否则溢出画布被裁）：实际 ${size}px`);
    assert.ok([...text].length * size <= 512 - 44, `按最终字号量宽应放得下：${[...text].length}×${size}`);
    assert.ok(size < shortSize, `越长字越小：长文案 ${size}px < 短文案 ${shortSize}px`);
  } finally {
    globalThis.document.createElement = orig;
  }
});

// ================= 第五十九修（现场二轮反馈）· 盾甲兵立绘 =================
//   现场：「盾甲兵的预告信息图片中盾牌穿模铁甲兵了」。
//   做法（改成）：骑士、盾牌**各抓一张正视帧**，再用 2D 把两张合成到一个画布上 ——
//   3D 里把两个模型摆到「刚好不穿模」是脆的（模型/半径一动就再穿），2D 叠图没有遮挡关系。

test('第五十九修 · composePortrait：骑士画右上、盾牌画左下，盾牌小一档（也就是「不穿模」）', () => {
  const orig = globalThis.document.createElement;
  const calls = [];
  const ctx = new Proxy({}, { get: (_t, key) => (...args) => { calls.push([key, ...args]); } });
  globalThis.document.createElement = () => ({ width: 0, height: 0, style: {}, getContext: () => ctx });
  try {
    const main = { width: 256, height: 256 };
    const side = { width: 256, height: 256 };
    composePortrait(main, side, 256);
    const drawn = calls.filter((c) => c[0] === 'drawImage');
    assert.equal(drawn.length, 2, '两张图各画一次（各自独立抓帧，不共用一张）');
    const [, , mx, my, mw, mh] = drawn[0];
    assert.ok(Math.abs(mx - 256 * (1 - PORTRAIT_MAIN_FRAC)) < 1e-9 && my === 0, '骑士落在右上角');
    assert.ok(Math.abs(mw - 256 * PORTRAIT_MAIN_FRAC) < 1e-9 && mw === mh, '骑士按比例等比放大');
    const [, , sx, sy, sw, sh] = drawn[1];
    assert.equal(sx, 0, '盾牌贴左边');
    assert.ok(Math.abs(sy - 256 * (1 - PORTRAIT_SHIELD_FRAC)) < 1e-9, '盾牌落左下角');
    assert.ok(sw < mw, '盾牌比骑士小一档（不是等大叠上去）');
    assert.equal(sw, sh);
    // 只有一张也要能出图（盾牌抓帧失败 → 只画骑士，绝不空卡）
    calls.length = 0;
    composePortrait(main, null, 256);
    assert.equal(calls.filter((c) => c[0] === 'drawImage').length, 1);
    calls.length = 0;
    composePortrait(null, side, 256);
    assert.equal(calls.filter((c) => c[0] === 'drawImage').length, 1);
    calls.length = 0;
    composePortrait(null, null, 256);
    assert.equal(calls.filter((c) => c[0] === 'drawImage').length, 0, '两张都没有 → 空图（上层回退简笔画）');
  } finally {
    globalThis.document.createElement = orig;
  }
});

test('第五十九修 · 盾甲兵立绘不再把两个 GLB 塞进同一个 Group（那就是穿模的根源）', () => {
  const SRC = fs.readFileSync(path.join(HERE, '..', 'src', 'game', 'enemyPortrait.js'), 'utf8');
  assert.ok(SRC.includes('composePortrait'), '盾甲兵走「分别抓帧 + 2D 合成」');
  assert.ok(SRC.includes('PORTRAIT_SHIELD_FRAC'), '盾牌在合成图里的占比是显式参数');
  for (const dead of ['SHIELD_X', 'SHIELD_Y', 'SHIELD_Z', 'SHIELD_YAW', 'SHIELD_SCALE', 'buildTarget']) {
    assert.ok(!SRC.includes(dead), `旧的 3D 摆位残留 ${dead}：就是它让盾牌穿模铁甲兵`);
  }
});

test('第五十九修 · 立绘卡文案放大到 4 行（20px / 行距 25 / 首行 y=330）——现场「信息没显示全」', () => {
  const orig = globalThis.document.createElement;
  const calls = []; const sets = [];
  const ctx = new Proxy({}, {
    get: (_t, key) => (key === 'measureText' ? () => ({ width: 0 })
      : key === 'createRadialGradient' || key === 'createLinearGradient' ? () => ({ addColorStop() {} })
      : (...args) => { calls.push([key, ...args]); }),
    set: (_t, key, v) => { sets.push([key, v]); return true; },
  });
  globalThis.document.createElement = () => ({ width: 0, height: 0, style: {}, getContext: () => ctx });
  try {
    const tip = ELITE_BRIEF.heart.tip;
    makeCardTexture('治疗术士', tip, '#4dff88', 'eHealer', { portrait: true, image: { width: 8, height: 8 } });
    const fonts = sets.filter((s) => s[0] === 'font').map((s) => s[1]);
    assert.ok(fonts.includes('20px sans-serif'), '文案字号 22 → 20（腾出第 4 行）');
    const line = calls.find((c) => c[0] === 'fillText' && c[1] === tip);
    assert.ok(line, '文案必须画出来');
    assert.equal(line[3], 330, '立绘版式首行 y = 330');
    // 行数上限 / 行距是「显示全不全」的关键 → 直接锁源码口径（本桩 measureText 恒 0，画不出真实换行）
    const SRC = fs.readFileSync(path.join(HERE, '..', 'src', 'game', 'cardDraft.js'), 'utf8');
    assert.ok(SRC.includes("wrapText(x, sub, W / 2, subY, W - 44, priced ? 28 : 25, priced ? 3 : 4, '#fff')"),
      '立绘文案：最多 4 行、行距 25、可用宽 212（原来 3 行 / 30 / 206）');
    // 4 行末行仍在卡框内边（6..450）以内
    assert.ok(330 + 3 * 25 < 450, '4 行末行不许越过卡框');
  } finally {
    globalThis.document.createElement = orig;
  }
});

test('第五十九修 · 预告卡文案全部装得下 4 行（每行约 10 字 → 上限 40 字，实测最长也短于它）', () => {
  const all = [3, 9, 15].flatMap((s) => previewCards(s));
  const longest = all.map((c) => c.sub).sort((a, b) => b.length - a.length)[0];
  assert.ok(all.every((c) => c.sub.length <= 34), `文案必须 ≤ 34 字（4 行×约 10 字留余量）：${longest}`);
  assert.ok(longest.length <= 27, `现有最长文案 ${longest.length} 字，本来就该一行不落`);
});
// ================= 第六十三修 · 盾甲兵立绘不再「整卡丢失」 =================
//   现场：「第三关商店中精英兵的预告中盾甲兵图片丢失，目前是图标。」
//   桌面离线复现（Electron + 真 WebGL）显示链路其实是**通的**（骑士 46040px / 盾牌 35045px），
//   所以本轮先把**兜底与诊断**补齐 —— 头显上再复现就能一次定位：
//     ① 两个模型各自独立兜底：旧实现是「主模型 await 一挂，整卡回退简笔画」，
//        现场看到的「图标」正是这条路径；现在骑士挂了也照样把盾牌画出来；
//     ② 盾牌没抓到 → 左下角补「盾」简笔画（否则这张卡和铁甲兵长得一模一样）；
//     ③ 每一步（抓到多少不透明像素 / 哪一步失败）都写进 game 留痕 —— 头显上看不到 DevTools。

test('第六十三修 · 盾牌没抓到：左下角补「盾」简笔画（不能退化成和铁甲兵一样的图）', () => {
  const orig = globalThis.document.createElement;
  const calls = [];
  const ctx = new Proxy({}, { get: (_t, key) => (...args) => { calls.push([key, ...args]); } });
  globalThis.document.createElement = () => ({ width: 0, height: 0, style: {}, getContext: () => ctx });
  try {
    const main = { width: 256, height: 256 };
    composePortrait(main, null, 256, PORTRAIT_MAIN_FRAC, PORTRAIT_SHIELD_FRAC, 'eShield');
    assert.equal(calls.filter((c) => c[0] === 'drawImage').length, 1, '骑士照画');
    assert.ok(calls.some((c) => c[0] === 'stroke' || c[0] === 'lineTo'), '左下角要画「盾」简笔画');
    const iconCalls = calls.filter((c) => c[0] === 'lineTo' || c[0] === 'arc');
    assert.ok(iconCalls.length > 0, '简笔画至少有线段 / 圆弧');
    // 不传兜底 key（非盾甲兵 / 老调用）→ 保持原样：只画骑士，不画任何图标
    calls.length = 0;
    composePortrait(main, null, 256);
    assert.ok(!calls.some((c) => c[0] === 'stroke' || c[0] === 'lineTo'), '没给兜底 key 就不该画简笔画');
  } finally {
    globalThis.document.createElement = orig;
  }
});

test('第六十三修 · 盾甲兵的 spec 带 sideIcon（兜底画哪枚简笔画），且不污染 portraitKey', () => {
  const shield = elitePortrait('shield');
  assert.equal(shield.sideIcon, 'eShield', '盾甲兵的兜底图标 = 「盾」简笔画');
  assert.ok(CARD_DRAFT.includes("case 'eShield'"), 'drawSketchIcon 必须真有这个 case（否则兜底只会画个圆点）');
  const knight = elitePortrait('eliteKnight');
  assert.equal(knight.sideIcon, 'eKnight');
  assert.equal(knight.shieldModel, null);
  assert.equal(portraitKey(shield), 'Model/骑士.glb|Model/盾牌.glb', '缓存键口径不变（仍是 url|shieldModel）');
});

test('第六十三修 · 抓帧失败不再拖垮整卡：两个模型各自独立兜底 + 诊断出口', () => {
  const SRC = fs.readFileSync(path.join(HERE, '..', 'src', 'game', 'enemyPortrait.js'), 'utf8');
  // 旧写法：主模型 await 直接挂在 IIFE 里 → 一挂就整卡回退（现场那个「图标」）
  assert.ok(!SRC.includes('const main = await captureOne(renderer, spec.url);\n    let side = null;'),
    '★ 主模型抓帧不许再是「一处挂全卡挂」');
  assert.ok(SRC.includes('let main = null;') && SRC.includes('if (!main && !side) throw new Error'),
    '两个模型各自 try/catch，只有**两个都没抓到**才回退整卡');
  assert.ok(SRC.includes('opaquePixels'), '要有「抓到多少不透明像素」的量（0 = 全透明才有意义）');
  assert.ok(SRC.includes('log = null'), 'portraitCanvas 要能吃一个日志出口（头显上看不到 DevTools）');
  const GAME = fs.readFileSync(path.join(HERE, '..', 'src', 'game', 'game.js'), 'utf8');
  assert.ok(GAME.includes("portraitCanvas(renderer, spec, say)"), 'game 必须把立绘诊断接到留痕通道');
});

test('第六十三修 · opaquePixels：拿不到 2D 上下文返回 -1，绝不抛（单测桩 / 非 canvas）', () => {
  assert.equal(opaquePixels(null), -1);
  assert.equal(opaquePixels({ width: 0, height: 0 }), -1);
  assert.equal(opaquePixels({}), -1);
  assert.equal(PORTRAIT_FALLBACK_COLOR, '#d7e2ee');
});

test('第六十三修 · 卡面标题自适应：「未知 Boss 阶段一」不许顶到卡框，短名一字不动', () => {
  // 假 ctx 按当前 font 里的字号量宽（模拟 CJK 全角 + 拉丁半角），这样「缩字号」才真的能收敛
  const mk = () => {
    const c = { font: '' };
    c.measureText = (s) => {
      const m = /(\d+)px/.exec(c.font);
      const size = m ? Number(m[1]) : TITLE_FONT_MAX;
      let w = 0;
      for (const ch of String(s)) w += ch.codePointAt(0) > 0x2e80 ? size : size * 0.55;
      return { width: w };
    };
    return c;
  };
  const long = '未知 Boss 阶段一';
  const c = mk();
  const size = titleFont(c, long);
  assert.ok(size < TITLE_FONT_MAX, '长名必须缩字号（否则顶到卡框）');
  assert.ok(size >= TITLE_FONT_MIN, '缩到底也要看得清');
  assert.ok(c.measureText(long).width <= TITLE_MAX_W, '缩完之后必须真的放得下');
  const short = mk();
  assert.equal(titleFont(short, '铁甲兵'), TITLE_FONT_MAX, '短名保持原字号（版式不变）');
  assert.equal(titleFont(short, '龙 Boss'), TITLE_FONT_MAX);
  assert.equal(titleFont(short, '未知 Boss 阶段一'), size, '同一口径可重复算（幂等）');
});

test('第六十四修 · 单模型抓帧按 url 共享（骑士不再被抓两遍）+ 空抓重试一次', () => {
  const SRC = fs.readFileSync(path.join(HERE, '..', 'src', 'game', 'enemyPortrait.js'), 'utf8');
  // 现场：盾甲兵卡「只显示了盾牌的」，而同关的铁甲兵卡（同样是 骑士.glb）却正常
  //   ⇒ 两张卡抓的是同一个 GLB，第二次抓空了。修法 = 按 url 共享同一张结果。
  assert.ok(SRC.includes('const _modelCache = new Map()'), '要有按**模型 url**的缓存');
  assert.ok(SRC.includes('function captureModel(renderer, url, say)'), '单模型抓帧走 captureModel');
  assert.ok(SRC.includes('captureModel(renderer, spec.url, say)') && SRC.includes('captureModel(renderer, spec.shieldModel, say)'),
    '盾甲兵的骑士与盾牌都走它 ⇒ 骑士与铁甲兵卡共用同一张');
  assert.ok(!SRC.includes('captureOne(renderer, spec.url, say)') && !SRC.includes('captureOne(renderer, spec.shieldModel, say)'),
    '★ 不许退回「同一个 GLB 每张卡各抓一遍」（就是那个第二次抓空的坑）');
  assert.ok(SRC.includes('_modelCache.delete(url)'), '失败不缓存：下次进店还能再试');
  assert.ok(SRC.includes('tries = 2') && SRC.includes('→ 重试'), '偶发全透明要重试一次（两把都空才判失败）');
  assert.ok(SRC.includes('n > 0'), '要用「不透明像素 > 0」当成功判据，不能只看 captureGLB 有没有 reject');
  assert.ok(SRC.includes('合成完成（骑士 '), '合成结果也要报像素数：一条留痕就能区分「骑士空」还是「被挡」');
});
