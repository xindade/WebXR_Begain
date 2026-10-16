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
//   · 第六十三修（现场「第三关商店里盾甲兵图片丢失，目前是图标」）：
//     ① 盾甲兵的两个模型**各自**独立兜底 —— 骑士挂了也照样画盾牌（旧实现主模型一挂就整卡回退简笔画）；
//     ② 盾牌没抓到 → 左下角画「盾」简笔画（否则这张卡和铁甲兵长得一样）；
//     ③ 每一步都往 game 的**留痕**写一行（头显上看不到 DevTools，见 portraitCanvas 的 log 参数）。

import * as THREE from 'three';
import { captureGLB } from './glbCapture.js';
import { loadBalloonModel } from './balloonModels.js';   // 取景归一化由 captureGLB 自己按 radius 做，这里不再用 fitToRadius
import { drawSketchIcon } from './cardDraft.js';         // 第六十三修：盾牌抓帧失败时的「盾」简笔画兜底

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
// 第六十三修：盾牌抓帧失败时，左下角那格画「盾」简笔画用的颜色（浅钢蓝，压在深色卡面上看得清）
export const PORTRAIT_FALLBACK_COLOR = '#d7e2ee';

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
async function captureOne(renderer, url, say = null, tries = 2) {
  // 第六十四修：加**一次重试** —— 头显上抓帧偶发全透明（同样的 GLB 第二次抓就是空的），
  //   重试隔 PORTRAIT_STEP_MS 再抓一次，绝大多数情况下第二把就出图；两把都空才判失败（交回退）。
  for (let i = 1; i <= tries; i++) {
    try {
      const obj = (await loadBalloonModel(url)).clone(true);
      const sheet = await captureGLB(renderer, obj, { radius: PORTRAIT_RADIUS, frames: 1, swing: 0, cap: PORTRAIT_CAP });
      const canvas = (sheet && sheet.albedo && sheet.albedo.image) || null;
      sheet?.albedo?.dispose?.();   // 贴图包装用不上：卡面自己建 CanvasTexture，这里只要画布
      sheet?.depth?.dispose?.();
      const n = opaquePixels(canvas);
      if (n > 0) {                                  // 有像素才算成功（captureGLB 只在全透明时 reject，
        say && say(url + ' 抓帧成功（不透明像素 ' + n + '）');   //   但合成用的 canvas 仍可能是空的）
        return canvas;
      }
      say && say(url + ' 第 ' + i + ' 次抓帧为空（不透明像素 ' + n + '）' + (i < tries ? ' → 重试' : ''));
    } catch (err) {
      say && say(url + ' 第 ' + i + ' 次抓帧失败：' + (err?.message || err) + (i < tries ? ' → 重试' : ''));
    }
    if (i < tries) await new Promise((r) => setTimeout(r, PORTRAIT_STEP_MS));
  }
  throw new Error('抓帧全透明/失败：' + url);
}

// ★ 第六十四修 ★ 单模型抓帧**按 url 共享**（原来只有整张卡的缓存，键里带 shieldModel ⇒ 骑士被连抓两遍）。
//   现场「盾甲兵预告只显示了盾牌的」= 骑士那张抓空了、盾牌正常；而**同一关的铁甲兵卡（也是骑士）却好好的**
//   —— 两张卡抓的是同一个 GLB，第二次抓才空 ⇒ 只在盾甲兵那张上暴露。
//   修法：把「单模型」提升成按 url 缓存，铁甲兵与盾甲兵**共用同一张骑士**：重活一关只做一次，
//   既补上这个「第二次空」的坑，也少一次抓帧（进店更稳）。失败不缓存，下次进店还能再试。
const _modelCache = new Map();   // url -> Promise<HTMLCanvasElement|null>
function captureModel(renderer, url, say) {
  const hit = _modelCache.get(url);
  if (hit) return hit;
  const task = captureOne(renderer, url, say).catch((err) => { _modelCache.delete(url); throw err; });
  _modelCache.set(url, task);
  return task;
}

/**
 * 数一张抓帧画布上有多少「不透明像素」——**立绘诊断**用（第六十三修）。
 *   现场「盾甲兵立绘丢失」在头显上复现、桌面却正常，需要一条能被留痕带走的量化线索：
 *   0 = 这张图事实上什么都没有（抓帧全透明 / 模型全被裁掉），数值很小 = 取景不对（模型只剩一条边）。
 *   拿不到 2D 上下文（单测桩 / 非 canvas）时返回 -1，绝不抛。
 */
export function opaquePixels(cv) {
  try {
    if (!cv || !cv.width || !cv.height || !cv.getContext) return -1;
    const g = cv.getContext('2d');
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
    return n;
  } catch (e) { return -1; }
}

/**
 * 把「主模型 + 副模型」两张正视图**合成一张立绘图**（纯 2D，便于单测）。
 *   主模型（骑士）画到右上、副模型（盾牌）画到左下；两张都是透明背景，直接叠 —— 没有 3D 遮挡关系，
 *   所以不存在「盾牌穿模骑士」。任一图为空则只画有的那张（盾牌抓失败也不空卡）。
 */
export function composePortrait(main, side, size = PORTRAIT_CAP, mainFrac = PORTRAIT_MAIN_FRAC, sideFrac = PORTRAIT_SHIELD_FRAC, sideIcon = null) {
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const g = cv.getContext('2d');
  if (main) { const s = size * mainFrac; g.drawImage(main, size - s, 0, s, s); }        // 右上
  const s = size * sideFrac;
  if (side) { g.drawImage(side, 0, size - s, s, s); }                                   // 左下
  // 第六十三修：盾牌没抓到 → 左下角画「盾」简笔画。
  //   只画骑士的盾甲兵卡和铁甲兵卡长得一模一样（现场第一轮也踩过），有个「盾」字标就一眼区分得开。
  else if (sideIcon) { drawSketchIcon(g, sideIcon, s / 2, size - s / 2, s * 0.62, PORTRAIT_FALLBACK_COLOR); }
  return cv;
}

/**
 * 取某个精英模型的正视立绘（带缓存）。
 * @param {THREE.WebGLRenderer} renderer
 * @param {{url:string, shieldModel?:string|null}} spec 见 content/eliteBrief.js 的 elitePortrait()
 * @returns {Promise<HTMLCanvasElement|null>} null = 没图（调用方退回简笔画图标）
 */
export function portraitCanvas(renderer, spec, log = null) {
  const key = portraitKey(spec);
  if (!key) return Promise.resolve(null);
  if (_cache.has(key)) return _cache.get(key);
  if (!renderer) return Promise.resolve(null);
  // 诊断日志：头显上没法看 DevTools，所以把「抓到几个像素 / 哪一步失败」交给 game 的留痕通道（第六十三修）
  const say = (m) => { try { if (log) log(m); } catch (e) { /* 日志失败绝不连累立绘 */ } };

  const task = (async () => {
    // 单模型（铁甲兵 / 治疗术士 / 忍者 / 幽灵 / 章鱼）：一张抓帧就够
    if (!spec.shieldModel) return captureModel(renderer, spec.url, say);
    // 盾甲兵：骑士 + 盾牌**各抓一张**再合成。
    //   ★ 第六十三修：两张**各自**独立兜底 —— 旧实现是「主模型 await 挂了就整卡回退」，
    //     于是现场「盾甲兵图片丢失，只剩简笔画图标」。现在骑士挂了也照样把盾牌画出来。
    let main = null;
    let side = null;
    try { main = await captureModel(renderer, spec.url, say); }
    catch (err) {
      console.warn('[enemyPortrait] 盾甲兵的主模型（骑士）抓帧失败:', spec.url, err?.message || err);
      say('骑士抓帧失败：' + (err?.message || err));
    }
    try { side = await captureModel(renderer, spec.shieldModel, say); }
    catch (err) {
      console.warn('[enemyPortrait] 盾牌模型抓帧失败，只画骑士:', spec.shieldModel, err?.message || err);
      say('盾牌抓帧失败：' + (err?.message || err));
    }
    if (!main && !side) throw new Error('两个模型都没抓到');
    if (!side) say('盾牌没抓到 → 左下角退回「盾」简笔画（该卡仍与铁甲兵分得开）');
    const out = composePortrait(main, side, PORTRAIT_CAP, PORTRAIT_MAIN_FRAC, PORTRAIT_SHIELD_FRAC, spec.sideIcon || null);
    // 合成结果也报一次像素数：现场只要看到「只显示了盾牌」，这一行就能立刻区分
    //   「骑士那张是空的」还是「骑士画上去了但被挡/被裁」。
    say('合成完成（骑士 ' + (main ? '有' : '缺') + ' · 盾牌 ' + (side ? '有' : '缺') + '，不透明像素 ' + opaquePixels(out) + '）');
    return out;
  })()
    .catch((err) => {
      _cache.delete(key);           // 失败不缓存：下次进店还能再试一次
      console.warn('[enemyPortrait] 立绘抓帧失败，该卡回退简笔画:', key, err?.message || err);
      say('整卡回退简笔画：' + (err?.message || err));
      return null;
    });
  _cache.set(key, task);
  return task;
}