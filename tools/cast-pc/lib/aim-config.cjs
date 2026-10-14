// tools/cast-pc/lib/aim-config.cjs —— 「手柄瞄准补偿角」读写（第四十五修）
//
// 为什么抽成独立模块：同一套解析/改写要同时给两个入口用，绝不能有两份实现（改一处漏一处）：
//   ① tools/set-aim.js                 —— 开发/运维命令行（改游戏目录里的 userConfig.js）
//   ② tools/cast-pc/main.js（EXE 主进程）—— 现场在 PC 界面上直接改（下发给头显前套用覆盖表）
//
// userConfig.js 里 AIM.BY_DEVICE 四个槽的形状固定为：
//     pico:    { x: -27, y: 0,   z: 0 },
//     quest:   { x: 14,  y: -14, z: 0 },
// 这里**不做 JS 求值**（那是执行任意代码），只用正则定位那一段 `{ ... }` 并原位替换数字，
// 因此不会碰文件里其它任何内容（注释、格式、别的常量一律原样保留）。
'use strict';

/** 四个设备槽（顺序 = 界面/表格展示顺序） */
const SLOTS = ['pico', 'quest', 'steamvr', 'unknown'];
/** 受管配置文件在（游戏根 / 清单里的）相对路径 —— 与 main.js 的 CONFIG_MANIFEST 逐字一致 */
const AIM_REL = 'src/core/userConfig.js';

/** 定位某个设备槽的 `{ x: .., y: .., z: .. }` 片段（含前后文，便于原位替换）。找不到返回 null。 */
function findSlot(src, slot) {
  const re = new RegExp('([ \\t]*' + slot + ':\\s*\\{)([^}]*)(\\})');
  const m = re.exec(String(src == null ? '' : src));
  if (!m) return null;
  return { start: m.index, head: m[1], body: m[2], tail: m[3], full: m[0] };
}

/** 读一个槽的三个轴（读不到的轴给 NaN） */
function readAxes(body) {
  const get = (k) => {
    const m = new RegExp('\\b' + k + ':\\s*(-?\\d+(?:\\.\\d+)?)').exec(String(body == null ? '' : body));
    return m ? Number(m[1]) : NaN;
  };
  return { x: get('x'), y: get('y'), z: get('z') };
}

/** 只覆盖给了值的轴（NaN/未定义 = 保持原样） */
function rewriteAxes(body, axes) {
  const withAxis = (src, k, v) => {
    const re = new RegExp('(\\b' + k + ':\\s*)-?\\d+(?:\\.\\d+)?');
    if (!re.test(src)) return src;
    return src.replace(re, '$1' + v);
  };
  let out = String(body == null ? '' : body);
  for (const k of ['x', 'y', 'z']) {
    if (Number.isFinite(axes ? axes[k] : NaN)) out = withAxis(out, k, axes[k]);
  }
  return out;
}

/** 读出所有槽的当前角度（找不到的槽给 null） */
function readSlots(src, slots = SLOTS) {
  const out = {};
  for (const s of slots) {
    const hit = findSlot(src, s);
    out[s] = hit ? readAxes(hit.body) : null;
  }
  return out;
}

/**
 * 清洗外部传进来的 patch：只留下认得出的槽 + 有限的数字轴。
 * 界面/命令行都可能传脏数据，这里挡在落盘之前（写坏 userConfig.js 会让头显起不来）。
 */
function sanitize(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const s of SLOTS) {
    const v = patch[s];
    if (!v || typeof v !== 'object') continue;
    const ax = {};
    for (const k of ['x', 'y', 'z']) {
      const raw = v[k];
      if (raw === undefined || raw === null || raw === '') continue;
      const n = Number(raw);
      if (Number.isFinite(n)) ax[k] = n;
    }
    if (Object.keys(ax).length) out[s] = ax;
  }
  return out;
}

/**
 * 把 patch 套到文本上。
 * @returns {{text:string, clean:object, report:Array}} text = 套用后的完整文件内容（没变化时 === 原文）
 */
function applyPatch(text, patch) {
  const clean = sanitize(patch);
  let src = String(text == null ? '' : text);
  const report = [];
  for (const s of Object.keys(clean)) {
    const hit = findSlot(src, s);
    if (!hit) { report.push({ slot: s, ok: false, why: '文件里没有这个槽' }); continue; }
    const before = readAxes(hit.body);
    const body2 = rewriteAxes(hit.body, clean[s]);
    if (body2 === hit.body) { report.push({ slot: s, ok: true, before, after: before, changed: false }); continue; }
    src = src.slice(0, hit.start) + hit.head + body2 + hit.tail + src.slice(hit.start + hit.full.length);
    report.push({ slot: s, ok: true, before, after: readAxes(body2), changed: true });
  }
  return { text: src, clean, report };
}

module.exports = { SLOTS, AIM_REL, findSlot, readAxes, rewriteAxes, readSlots, sanitize, applyPatch };