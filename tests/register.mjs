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
    get: (_t, key) => (key === 'createRadialGradient' || key === 'createLinearGradient' ? () => gradient : () => {}),
  });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
}
