// ============================================================
// deviceProfile.js —— 设备识别与瞄准补偿角（PICO / Quest / SteamVR 自适应）
// 设计说明：docs/设备识别与瞄准角度.md（第三十三修实现 / 第三十四修收敛为固化角）
//
// 背景：射线与子弹共用同一条瞄准基准 —— 手柄 targetRay 空间的本地 (0,0,-1) 套上
//       「补偿欧拉角 XYZ」后转世界。该角按 PICO 4 的「targetRay 空间 ↔ gripSpace
//       （枪模型所挂空间）相对姿态」标定（实测基准 x = -27°）；Quest / SteamVR 运行时
//       这两个空间的对齐约定不同 → 同一角度整体偏（射线和子弹会一起偏，因为是同一个角）。
//       故按设备槽各存一份 {x,y,z}，自动识别后取对应槽的角。
//
// 四个槽：pico（PICO 4 / Neo 系列，本机基准）/ quest（Quest / 2 / 3 / Pro）
//        / steamvr（SteamVR 串流手柄：Vive / Index / WMR，其 targetRay↔grip 约定一致故共用）
//        / unknown（识别不出时的兜底）
//
// 取值优先级（逐轴）：AIM.FORCE > AIM.BY_DEVICE[设备槽] > SHOOT.RIGHT_PITCH_DEG（仅 x，y/z 取 0）
//   · 第三十四修：VR 内「摇杆标定工具」及其落盘的 localStorage 历史值（aim-xyz:<槽>）已全部移除，
//     角度只由 constants.js / userConfig.js 的 AIM.BY_DEVICE 决定 —— 固化值不会被设备里的旧标定偷偷盖过。
//   · AIM.ENABLED = false 时跳过以上全部，恒用 SHOOT.RIGHT_PITCH_DEG（改造前的单一角度行为）
//   · AIM.DEVICE 手动锁定的优先级高于全部自动识别（含 UA 强 PICO 标识）
//
// 唯一取值出口是 getAimDeg()：射线（input._applyRayAim）与子弹（input._rightAim）都走它，
// 保证「所见即所打」，两者永不分离。
// ============================================================
import { AIM, SHOOT } from '../core/constants.js';

export const AIM_SLOTS = ['pico', 'quest', 'steamvr', 'unknown'];
export const AIM_SLOT_LABEL = { pico: 'PICO', quest: 'Quest', steamvr: 'SteamVR', unknown: '未知设备' };
export const AIM_AXES = ['x', 'y', 'z'];

// —— 三级证据：① UA 强 PICO 标识 > ② inputSource.profiles > ③ 其它 UA 兜底 ——
// ① 没人会伪装成 PICO → 最可信，压过 profiles 与其它 UA
//   （PICO 浏览器会伪装 Quest UA，也会沿用 Meta 控制器 profile 映射）
const UA_PICO_STRONG = /PicoBrowser|PICO\s*(?:4|4E|Neo|G3|Ultra)|Pico\s*OS|Pico\s*Neo|Bytedance/i;
// ③ 其它 UA 特征兜底
const UA_QUEST = /OculusBrowser|Meta\s*Quest|Quest\s*(?:2|3|Pro)|Oculus\s*Quest/i;
const UA_STEAMVR = /VIVEPORT|Vive|Valve|SteamVR|Index\s*HMD/i;
// ② profiles 厂商串：用**精确前缀**（不用 'meta-' / 'quest' 这种过宽泛前缀，宁可判不出交 UA）
//   generic-*（如 generic-trigger-squeeze-thumbstick）不携带厂商信息 → 这里不匹配，放行给 UA 兜底
const PROFILE_RULES = [
  [/^pico/, 'pico'],
  [/^meta-quest/, 'quest'],
  [/^oculus/, 'quest'],
  [/^quest-/, 'quest'],
  [/^htc-/, 'steamvr'],
  [/^vive/, 'steamvr'],
  [/^valve-/, 'steamvr'],
  [/^index-/, 'steamvr'],
  [/^knuckles/, 'steamvr'],
  [/^wmr/, 'steamvr'],
  [/^microsoft-mixed-reality/, 'steamvr'],
];

// —— 模块状态 ——
let _profiles = [];       // 见过的 inputSource.profiles（多手柄累积，generic-* 无害）
let _ua = '';             // 首次探测时缓存的 UA
let _family = null;       // 已确认的设备槽（只允许 unknown → 具体厂牌「单向升级」）
let _familyWhy = '';      // 该槽的证据来源（诊断用）
let _inited = false;

const _out = { x: 0, y: 0, z: 0, slot: 'unknown', source: '' };   // getAimDeg() 复用对象

function num(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }

function initOnce() {
  if (_inited) return;
  _inited = true;
  _ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  // 第四十三修：URL 现场覆盖（?aim=x,y,z）→ 写进 AIM.FORCE（取值链路的最高优先级、不落盘）
  try {
    const search = (typeof location !== 'undefined' && location.search) || '';
    const f = aimForceFromSearch(search);
    if (f) {
      AIM.FORCE = Object.assign({}, AIM.FORCE || {}, f);
      if (typeof console !== 'undefined') console.log('[AIM] URL 覆盖生效 AIM.FORCE =', JSON.stringify(f));
    }
  } catch (e) { /* 没有 location 的环境（单测）忽略 */ }
}

/**
 * 解析现场 URL 的瞄准角覆盖（第四十三修）。纯函数，便于单测。
 *   · `?aim=-14,-14,0`   —— x,y,z 三轴一次写完（缺的轴用默认值）
 *   · `?aimx=14&aimz=3` —— 只覆盖某几轴（其余轴保持设备槽默认值）
 * 返回值落到 AIM.FORCE：**只影响带着该参数的那台设备** —— PICO 的启动地址不带它，
 * 就完全不受影响（也就不必为了调 Quest 而改动 PICO 的固化角）。
 * @returns {{x?:number,y?:number,z?:number}|null}
 */
export function aimForceFromSearch(search) {
  const s = String(search || '');
  if (!s) return null;
  let q;
  try { q = new URLSearchParams(s); } catch (e) { return null; }
  const out = {};
  let hit = false;
  const triple = q.get('aim');
  if (triple) {
    const parts = String(triple).split(',');
    for (let i = 0; i < AIM_AXES.length; i++) {
      const raw = parts[i];
      if (raw == null || String(raw).trim() === '') continue;   // 空轴 = 不覆盖（Number('') === 0 会误伤）
      const v = Number(raw);
      if (Number.isFinite(v)) { out[AIM_AXES[i]] = v; hit = true; }
    }
  }
  for (const ax of AIM_AXES) {
    const raw = q.get('aim' + ax);
    if (raw == null || String(raw).trim() === '') continue;
    const v = Number(raw);
    if (Number.isFinite(v)) { out[ax] = v; hit = true; }
  }
  return hit ? out : null;
}

function normalizeSlot(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s || s === 'auto') return null;
  return AIM_SLOTS.includes(s) ? s : null;
}

// —— 三级证据（导出，便于排障与单测）——

// ① UA 强 PICO 标识
export function isUaPicoStrong(ua) { return UA_PICO_STRONG.test(String(ua || '')); }

// ② profiles 具体厂商串
export function familyFromProfiles(list) {
  for (const raw of list || []) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) continue;
    for (const [re, slot] of PROFILE_RULES) if (re.test(s)) return slot;
  }
  return null;
}

// ③ 其它 UA 特征兜底（PICO 强标识优先，其次 Quest，再 SteamVR）
export function familyFromUA(ua) {
  const s = String(ua || '');
  if (isUaPicoStrong(s)) return 'pico';
  if (UA_QUEST.test(s)) return 'quest';
  if (UA_STEAMVR.test(s)) return 'steamvr';
  return null;
}

// 记录手柄的 profiles（input.js 的 connected 事件里调用，多手柄累积）
export function noteInputSource(src) {
  initOnce();
  const list = src?.profiles;
  if (!Array.isArray(list)) return;
  for (const p of list) {
    const s = String(p || '').trim();
    if (s && !_profiles.includes(s)) _profiles.push(s);
  }
}

// 设备槽判定：AIM.DEVICE 锁定 > ① UA 强 PICO > ② profiles > ③ UA 兜底 > unknown
export function getDeviceFamily() {
  initOnce();
  const lock = normalizeSlot(AIM?.DEVICE);
  if (lock) return lock;                       // 手动锁定：压过全部自动识别

  let slot = null, why = '';
  if (isUaPicoStrong(_ua)) { slot = 'pico'; why = 'UA 强 PICO 标识'; }
  if (!slot) { const f = familyFromProfiles(_profiles); if (f) { slot = f; why = 'inputSource.profiles'; } }
  if (!slot) { const f = familyFromUA(_ua); if (f) { slot = f; why = 'UA 兜底'; } }

  if (slot) {
    if (_family !== slot) _familyWhy = why;    // 证据变了 → 记新的来源
    _family = slot;
    return slot;
  }
  if (_family) return _family;                 // 已确认过的槽不因后到的 generic-* 证据降级
  return 'unknown';
}

// 一行诊断：槽 / 证据链 / 冲突 / 是否锁定（进 VR 时打印，现场排障第一眼看它）
export function describeDetection() {
  initOnce();
  const lock = normalizeSlot(AIM?.DEVICE);
  const slot = getDeviceFamily();
  const p = familyFromProfiles(_profiles);
  const u = familyFromUA(_ua);
  const conflict = (p && u && p !== u) ? ` ⚠冲突(profiles=${p} / UA=${u})` : '';
  const raw = _profiles.length ? _profiles.join(',') : '无';
  return `设备槽=${slot}`
    + (lock ? `（AIM.DEVICE 锁定=${lock}）` : `（证据=${_familyWhy || '无'}）`)
    + ` profiles=[${raw}] UA判定=${u || '无'} PICO强标识=${isUaPicoStrong(_ua) ? '是' : '否'}${conflict}`;
}

// —— 角度解析 ——

// 槽配置值（AIM.BY_DEVICE[槽]）；槽没配 → 单角兜底
function slotBase(slot) {
  const cfg = (AIM?.BY_DEVICE || {})[slot];
  if (cfg && typeof cfg === 'object') {
    return { x: num(cfg.x, SHOOT.RIGHT_PITCH_DEG), y: num(cfg.y, 0), z: num(cfg.z, 0) };
  }
  return { x: num(SHOOT.RIGHT_PITCH_DEG, -27), y: 0, z: 0 };
}

/**
 * 唯一取值入口（射线 + 子弹共用）。
 * 返回**复用对象** {x,y,z,slot,source} —— 请立即读走，不要保存引用。
 */
export function resolveAimDeg(out) {
  initOnce();
  const o = out || {};

  if (AIM?.ENABLED === false) {                // 总开关关：回到改造前的单一角度行为
    o.x = num(SHOOT.RIGHT_PITCH_DEG, -27); o.y = 0; o.z = 0;
    o.slot = getDeviceFamily();
    o.source = 'SHOOT.RIGHT_PITCH_DEG（AIM.ENABLED=false）';
    return o;
  }

  const slot = getDeviceFamily();
  // 第三十四修：不再读 localStorage 历史值（旧标定值会偷偷盖过固化角），角度只来自配置表。
  let deg = slotBase(slot);
  let source = AIM?.BY_DEVICE?.[slot] ? `AIM.BY_DEVICE.${slot}` : 'SHOOT.RIGHT_PITCH_DEG（槽未配置）';

  const f = AIM?.FORCE;
  if (f && typeof f === 'object') {            // 排障强制：可只覆盖部分轴
    const merged = { x: deg.x, y: deg.y, z: deg.z };
    let hit = false;
    for (const ax of AIM_AXES) {
      const n = Number(f[ax]);
      if (Number.isFinite(n)) { merged[ax] = n; hit = true; }
    }
    if (hit) { deg = merged; source = 'AIM.FORCE'; }
  }

  o.x = deg.x; o.y = deg.y; o.z = deg.z; o.slot = slot; o.source = source;
  return o;
}

// 便捷版：同上复用对象
export function getAimDeg() { return resolveAimDeg(_out); }