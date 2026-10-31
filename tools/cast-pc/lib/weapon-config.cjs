// tools/cast-pc/lib/weapon-config.cjs —— 爆炮手火箭筒调参（第八十七修）
//
// 与 aim-config.cjs 同一思路：不执行 JS，只在 userConfig.js 的 BOMBARD_WEAPON 块里
// 原位替换数字。PC EXE 的输入框改的是覆盖表，下发给头显前套用；同时尽量写回
// 本地/清单那份 userConfig.js，方便提交与上传服务器。
'use strict';

const WEAPON_REL = 'src/core/userConfig.js';
const BLOCK = 'BOMBARD_WEAPON';

/** 在 src 中定位 `KEY: { ... }`，返回 body 与外层括号区间。找不到返回 null。 */
function findObject(src, key) {
  const text = String(src == null ? '' : src);
  const m = new RegExp('\\b' + key + '\\s*:\\s*\\{').exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0, quote = '', esc = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { start: m.index, open, close: i, body: text.slice(open + 1, i) };
    }
  }
  return null;
}

function readAxes(body) {
  const get = (k) => {
    const m = new RegExp('\\b' + k + ':\\s*(-?\\d+(?:\\.\\d+)?)').exec(String(body || ''));
    return m ? Number(m[1]) : NaN;
  };
  return { x: get('x'), y: get('y'), z: get('z') };
}

function rewriteAxes(body, axes) {
  let out = String(body == null ? '' : body);
  for (const k of ['x', 'y', 'z']) {
    if (!Number.isFinite(axes ? axes[k] : NaN)) continue;
    const re = new RegExp('(\\b' + k + ':\\s*)-?\\d+(?:\\.\\d+)?');
    if (re.test(out)) out = out.replace(re, '$1' + axes[k]);
  }
  return out;
}

/** 读当前 BOMBARD_WEAPON（缺块给 null） */
function readWeapon(src) {
  const hit = findObject(src, BLOCK);
  if (!hit) return null;
  const pos = findObject(hit.body, 'POSITION');
  const rot = findObject(hit.body, 'ROTATION');
  const sm = /\bSCALE\s*:\s*(-?\d+(?:\.\d+)?)/.exec(hit.body);
  const um = /\bMODEL_URL\s*:\s*['"]([^'"]+)['"]/.exec(hit.body);
  return {
    MODEL_URL: um ? um[1] : null,
    POSITION: pos ? readAxes(pos.body) : { x: NaN, y: NaN, z: NaN },
    ROTATION: rot ? readAxes(rot.body) : { x: NaN, y: NaN, z: NaN },
    SCALE: sm ? Number(sm[1]) : NaN,
  };
}

/** 清洗界面/命令行传入的 patch：只允许数字轴与正缩放。 */
function sanitize(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const key of ['POSITION', 'ROTATION']) {
    const v = patch[key];
    if (!v || typeof v !== 'object') continue;
    const ax = {};
    for (const k of ['x', 'y', 'z']) {
      const n = Number(v[k]);
      if (v[k] !== '' && v[k] != null && Number.isFinite(n)) ax[k] = n;
    }
    if (Object.keys(ax).length) out[key] = ax;
  }
  const s = Number(patch.SCALE);
  if (patch.SCALE !== '' && patch.SCALE != null && Number.isFinite(s) && s > 0) out.SCALE = s;
  return out;
}

/** 把 patch 原位套到 BOMBARD_WEAPON 块上。 */
function applyPatch(text, patch) {
  const clean = sanitize(patch);
  let src = String(text == null ? '' : text);
  const hit = findObject(src, BLOCK);
  if (!hit || !Object.keys(clean).length) return { text: src, clean, ok: false };
  let body = hit.body;
  for (const key of ['POSITION', 'ROTATION']) {
    if (!clean[key]) continue;
    const sub = findObject(body, key);
    if (!sub) continue;
    const next = rewriteAxes(sub.body, clean[key]);
    body = body.slice(0, sub.open + 1) + next + body.slice(sub.close);
  }
  if (Number.isFinite(clean.SCALE)) {
    body = body.replace(/(\bSCALE\s*:\s*)-?\d+(?:\.\d+)?/, '$1' + clean.SCALE);
  }
  src = src.slice(0, hit.open + 1) + body + src.slice(hit.close);
  return { text: src, clean, ok: true };
}

module.exports = { WEAPON_REL, BLOCK, findObject, readAxes, rewriteAxes, readWeapon, sanitize, applyPatch };
