// 商店「精英预告」卡 · 离线预览（第六十三修）
//
// 为什么有这个：预告卡上的立绘是**运行时把 GLB 离屏渲成正视图**抓出来的（src/game/enemyPortrait.js），
//   所以「卡面长什么样」以前只能在头显里一关一关打过去才看得到 —— 头显上既看不到 DevTools 也没法快速验证。
//   这里用 Electron 起一个**真 WebGL** 的窗口，跑的就是游戏里那套抓帧 + 卡面绘制代码，把 3 张商店的
//   预告卡列直接导成 PNG。改完 enemyPortrait / cardDraft / eliteBrief 跑一遍就能肉眼验收。
//
// 覆盖：卡文案（第 15 关的三张 Boss 形态卡也在这里）、立绘合成、盾牌兜底、Boss 卡的「?」占位。
// 不覆盖：位置/朝向/尺寸（那些是 shop.js 的场地摆位，得进 VR 看）。
import * as THREE from 'three';
import { previewCards } from '/src/content/eliteBrief.js';
import { portraitCanvas, opaquePixels } from '/src/game/enemyPortrait.js';
import { makeCardTexture } from '/src/game/cardDraft.js';
import { SHOP } from '/src/core/constants.js';

const out = [];
const log = (...a) => { console.log('[portrait-preview]', ...a); out.push(a.map(String).join(' ')); };

const CARD_W = 256, CARD_H = 456, GAP = 14, PAD = 16, SCALE = 2;   // 2 倍：接近商店里的放大口径，肉眼好判断

function sheetCanvas(cards, images) {
  const W = PAD * 2 + cards.length * CARD_W + Math.max(0, cards.length - 1) * GAP;
  const H = PAD * 2 + CARD_H;
  const cv = document.createElement('canvas');
  cv.width = W * SCALE; cv.height = H * SCALE;
  const g = cv.getContext('2d');
  g.save();
  g.scale(SCALE, SCALE);
  g.fillStyle = '#0b0e18';
  g.fillRect(0, 0, W, H);
  cards.forEach((c, i) => {
    const tex = makeCardTexture(c.label, c.sub, c.color, c.icon, {
      portrait: true,
      image: images[i] || null,
      placeholder: c.portrait ? null : '?',   // Boss 卡：不露脸，显示「?」
    });
    g.drawImage(tex.image, PAD + i * (CARD_W + GAP), PAD, CARD_W, CARD_H);
    tex.dispose();
  });
  g.restore();
  return cv;
}

async function main() {
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(256, 256, false);
  renderer.setPixelRatio(1);
  document.body.appendChild(renderer.domElement);
  log('maxTextureSize = ' + renderer.capabilities.maxTextureSize);

  const results = [];
  for (const lv of [3, 9, 15]) {
    const cards = previewCards(lv).slice(0, SHOP.PREVIEW_MAX);
    const images = [];
    for (const c of cards) {
      if (!c.portrait) {
        images.push(null);
        results.push({ lv, key: c.key, label: c.label, sub: c.sub, hasImg: false, note: 'Boss 卡不给图（画「?」）' });
        continue;
      }
      let cv = null;
      let err = null;
      try { cv = await portraitCanvas(renderer, c.portrait, (m) => log('[' + lv + ' · ' + c.label + '] ' + m)); }
      catch (e) { err = String((e && e.message) || e); }
      images.push(cv);
      results.push({ lv, key: c.key, label: c.label, sub: c.sub, hasImg: !!cv, opaque: cv ? opaquePixels(cv) : 0, err });
    }
    const sheet = sheetCanvas(cards, images);
    results.push({ lv, key: '__sheet__', png: sheet.toDataURL('image/png') });
    log('第 ' + lv + ' 关预告卡 ' + cards.length + ' 张 → 已出图');
  }

  window.__RESULT = { results, out };
  document.title = 'DONE';
}

main().catch((e) => {
  window.__RESULT = { results: [], out: out.concat('FATAL ' + String((e && e.stack) || e)) };
  document.title = 'DONE';
});