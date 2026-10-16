// enemyPortrait.js —— 商店「精英预告」卡的**模型立绘**（第五十七修 v2）。
//
// 现场口径：精英怪卡面要放它**真实模型**的正视图，图下面是文字介绍；Boss 卡不给图（只留「?」）。
// 做法：复用 DepthSprite 的离屏抓帧管线（glbCapture.captureGLB）—— 和局内气球用的是同一份 GLB，
//   所以卡面长相 = 玩家马上要遇到的样子，不存在「画的跟实物不一样」。
//
// 为什么单独一个模块：抓帧要 renderer、要异步、要按模型 url 缓存，
//   而 content/eliteBrief.js 是纯数据（要在 node 单测里跑，不能碰 WebGL）。
//
// 约束：
//   · **Boss 不抓图**：调用方只对 `card.portrait != null` 的卡调本模块（见 shop._buildPreview）。
//   · 抓帧是**两次回读**的重活 → 每帧只抓一张（调用方排队，见 game._warmShopPortraits），
//     分辨率降到 256（卡面只有 224px 宽），且按 url 缓存 → 一局最多 5 次。
//   · 任何失败（模型缺失 / 抓帧全透明 / 无 renderer）都 resolve(null)，
//     卡面自动回退（makeCardTexture 的三级回退：没图 → 简笔画图标；Boss 卡另有「?」），绝不空卡。

import * as THREE from 'three';
import { captureGLB } from './glbCapture.js';
import { loadBalloonModel } from './balloonModels.js';   // 取景归一化由 captureGLB 自己按 radius 做，这里不再用 fitToRadius

// 统一取景半径：captureGLB 把「模型包围盒最长边」归一化到 2*radius 再装进固定画幅，
// 所以这个值只决定「画面里占多满」，与敌人实际体型/血量无关。1.1 → 约占画幅 92%。
export const PORTRAIT_RADIUS = 1.1;
export const PORTRAIT_CAP = 256;          // 每帧分辨率（卡面 224px 宽足够；见文件头注释）
// 两次抓帧之间的间隔(ms)：抓帧含 2 次同步回读（readRenderTargetPixels），扎堆会连掉好几帧。
// 拉开一档后，卡片在进店后约半秒内逐张从「?」换成真图，店里几乎是静止画面，看不出卡顿。
export const PORTRAIT_STEP_MS = 90;

// 盾甲兵 = 骑士 + 盾牌两个 GLB。**第五十九修：分别抓帧 → 2D 合成**（不再把两个模型塞进同一个 Group 抓一次）。
//   为什么改：现场反馈「盾牌的立绘穿模铁甲兵」。透视相机下想把两个 3D 模型摆成「刚好不穿模」是脆的
//   —— 模型一换、取景半径一调就会再穿。分别抓帧后每张都是「整幅填满」的正视图，两个模型各自不缺边、
//   天然不存在互相遮挡，再从根上把它们摆到画布的两个角（骑士右上 / 盾牌左下），读作「骑士在盾后持盾」。
export const PORTRAIT_MAIN_FRAC = 0.72;    // 骑士（主模型）在合成图里占画布的比例
export const PORTRAIT_SHIELD_FRAC = 0.46;  // 盾牌（副模型）在合成图里占画布的比例（越小越靠边、越小）

const _cache = new Map();                 // url|shieldModel -> Promise<HTMLCanvasElement|null>

/** 立绘缓存键（同一份模型在不同卡片间共享一次抓帧） */
export function portraitKey(spec) {
  if (!spec || !spec.url) return '';
  return spec.shieldModel ? `${spec.url}|${spec.shieldModel}` : spec.url;
}

/**
 * 抓一份模型的**正视立绘**：captureGLB 自己会把模型归一化到 2×PORTRAIT_RADIUS 并居中，
 * 所以这里只负责「加载 → 克隆 → 抓帧 → 交出画布」。失败会 reject，由调用方决定回退。
 * @returns {Promise<HTMLCanvasElement|null>}
 */
async function captureOne(renderer, url) {
  const obj = (await loadBalloonModel(url)).clone(true);
  const sheet = await captureGLB(renderer, obj, { radius: PORTRAIT_RADIUS, frames: 1, swing: 0, cap: PORTRAIT_CAP });
  const canvas = (sheet && sheet.albedo && sheet.albedo.image) || null;
  sheet?.albedo?.dispose?.();   // 贴图包装用不上：卡面自己建 CanvasTexture，这里只要画布
  sheet?.depth?.dispose?.();
  return canvas;
}

/**
 * 把「主模型 + 副模型」两张正视图**合成一张立绘图**（纯 2D，便于单测）。
 *   主模型（骑士）画到右上、副模型（盾牌）画到左下；两张都是透明背景，直接叠 —— 没有 3D 遮挡关系，
 *   所以不存在「盾牌穿模骑士」。任一图为空则只画有的那张（盾牌抓失败也不空卡）。
 */
export function composePortrait(main, side, size = PORTRAIT_CAP, mainFrac = PORTRAIT_MAIN_FRAC, sideFrac = PORTRAIT_SHIELD_FRAC) {
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const g = cv.getContext('2d');
  if (main) { const s = size * mainFrac; g.drawImage(main, size - s, 0, s, s); }        // 右上
  if (side) { const s = size * sideFrac; g.drawImage(side, 0, size - s, s, s); }        // 左下
  return cv;
}

/**
 * 取某个精英模型的正视立绘（带缓存）。
 * @param {THREE.WebGLRenderer} renderer
 * @param {{url:string, shieldModel?:string|null}} spec 见 content/eliteBrief.js 的 elitePortrait()
 * @returns {Promise<HTMLCanvasElement|null>} null = 没图（调用方退回简笔画图标）
 */
export function portraitCanvas(renderer, spec) {
  const key = portraitKey(spec);
  if (!key) return Promise.resolve(null);
  if (_cache.has(key)) return _cache.get(key);
  if (!renderer) return Promise.resolve(null);

  const task = (async () => {
    // 单模型（铁甲兵 / 治疗术士 / 忍者 / 幽灵 / 章鱼）：一张抓帧就够
    if (!spec.shieldModel) return captureOne(renderer, spec.url);
    // 盾甲兵：骑士 + 盾牌**各抓一张**再合成（盾牌抓失败只画骑士，不阻断整卡）
    const main = await captureOne(renderer, spec.url);
    let side = null;
    try { side = await captureOne(renderer, spec.shieldModel); }
    catch (err) { console.warn('[enemyPortrait] 盾牌模型抓帧失败，只画骑士:', spec.shieldModel, err?.message || err); }
    return composePortrait(main, side);
  })()
    .catch((err) => {
      _cache.delete(key);           // 失败不缓存：下次进店还能再试一次
      console.warn('[enemyPortrait] 立绘抓帧失败，该卡回退简笔画:', key, err?.message || err);
      return null;
    });
  _cache.set(key, task);
  return task;
}