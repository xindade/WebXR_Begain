// basicVoice.js —— 基础怪群体语音（"冲冲冲"）的触发门槛（第六十四修 · 纯函数）
//
// 为什么单独一个模块：门槛算法要能在 node 单测里直接跑（把 game.js 拉起来太重）。
//
// 现场问题：「冲冲冲语音只会在某一处（Boss 成批召唤）播放」。
//   真因：门槛写死 10 只，而三层出怪改造（第四十六修）之后普通关的杂鱼改成「按配额滴流、补满即停」，
//   配额 = 内圈 + 外圈（SPAWN_RING，前期约 6~12 只，见 waves.innerQuota / outerQuota），
//   玩家边打边补 ⇒ 场上**很少**同时站够 10 只。唯一能一次涌出十几只的是 Boss 召唤。
//   改成拿本关配额当尺子：need = clamp(round(配额 × RATIO), MIN, THRESHOLD)
//     · 配额很小（Boss 关没走滴流 / 没有 waves）→ 落到下限 MIN，照样能喊；
//     · 配额很大（后期）→ 封顶 THRESHOLD，不会因为怪一多就无限循环喊（还有 PAUSE 兜着）。
//
// 纯计算：不 import three、不碰 DOM ⇒ 可单测（见 tests/basic-voice.test.mjs）。
export function basicVoiceNeed(quota, cfg = {}) {
  const THRESHOLD = Number.isFinite(cfg.THRESHOLD) && cfg.THRESHOLD > 0 ? cfg.THRESHOLD : 10;
  const MIN = Number.isFinite(cfg.MIN) && cfg.MIN > 0 ? cfg.MIN : 1;
  const RATIO = Number.isFinite(cfg.RATIO) && cfg.RATIO > 0 ? cfg.RATIO : 0.6;
  const q = Number.isFinite(quota) && quota > 0 ? quota : 0;
  return Math.min(THRESHOLD, Math.max(MIN, Math.round(q * RATIO)));
}
