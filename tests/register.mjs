import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'three') return { url: new URL('../vendor/three.module.js', import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

// Node 里没有 DOM：模型加载占位「光点」（balloonModels.dotTexture）要用 createElement('canvas')，
// 这里给一个最小 2D 桩，避免与真实渲染无关的测试因缺 canvas 而失败。
if (typeof globalThis.document === 'undefined') {
  const gradient = { addColorStop() {} };
  const ctx = new Proxy({}, {
    get: (_t, key) => (key === 'createRadialGradient' || key === 'createLinearGradient' ? () => gradient
      : key === 'measureText' ? () => ({ width: 0 })   // 血条/横幅等 Canvas2D 文本量宽
      : () => {}),
  });
  // 第四十三修：加 createElementNS + addEventListener —— buddhaFx.js 在**模块级**就预载贴图
  //   （three 的 ImageLoader 会 createElementNS('img') 并 addEventListener），少了这两个桩
  //   整个文件 import 就会炸，等于把「神掌朝向」这类纯逻辑挡在单测之外。
  const el = () => ({
    width: 0, height: 0, style: {},
    getContext: () => ctx,
    addEventListener() {}, removeEventListener() {},
  });
  globalThis.document = { createElement: el, createElementNS: el };
}
