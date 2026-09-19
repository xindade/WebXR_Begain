// src/core/license.js
// PCVR 授权门禁：首次联网激活 + 之后离线运行。
//
// 原理：游戏「开始/进入 VR」前校验本机 license（RSA 签名，离线 WebCrypto 验签）。
//   · 首次运行无 license → 联网向激活服务器申请（机器码 + 产品）→ 服务器用私钥签名返回 → 存 localStorage。
//   · 之后运行 → 读本地 license → 内置公钥验签 + 比对机器码 + 检查有效期 → 通过才放行游戏。
//
// ── 安全边界（务必知晓，决定后续升级路径）─────────────────────────────
//   1. 纯网页没有可靠硬件指纹：machineId = 首次运行生成的随机 UUID，持久化在 localStorage。
//      这能防「随手把游戏 URL 发给别人、别人打开即玩」（别人的机器没有你的签名 license）；
//      但防不住「整段复制你的 localStorage（含 machineId+license）到同一浏览器/同机用户」。这是网页固有弱点。
//   2. 公钥内联在下方，理论上可被 patch 绕过。要更强请把验签搬进原生壳（Electron/APK 的 native 层），
//      并用真实硬件指纹做 machineId（本项目已规划 PC EXE + 头显 APK 原生壳，届时升级即可）。
//   3. 换私钥（server 端）/ 换公钥（下方 PUBLIC_KEY）会让所有已发 license 失效，相当于 revoke。
//   4. 本模块对「纯网页 / Electron / 头显浏览器」环境统一生效；若只想 PC 端强制、头显像免激活，
//      在 main.js 调用处加 isDesktopPage() 判断即可（当前未加，保持统一门禁）。
//
// ── 部署时必须改 ──────────────────────────────────────────────────────
//   SERVER_URL：改成你的激活服务器 https 地址（开发可用 http://localhost:8787）。

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuQOD1oXKhkDMJrPv4hsn
4P5gcOgjgAtk1Py+Tf9ls938Xi/dZWGCAbOeN+5wiknHpjZ/HpbkWD0uqvpdLBTo
OqNHGGOHOv0yFSLEFP8KsIbDx8xMe61R3uUuqQcq8FzMHANwHBTRzgO1UK7YrzP+
fG8+fKQpr4GtGC8vw4jaY7dAd0n22OXJdhy6Wxdp0dwRyaXPDxil32tbwKCxNw4s
LKlCEpmrrU7tNobrD2nH3cSnWdI1LxjPUzvvHig9MOI56qWK3Nc0Eve+ur//0Ccv
vuDnrxf61e1jlgsBptGfSrBXy8rDLs5+GVysS1HdxEVTwU/TW/a90s+yBjNS30DV
3wIDAQAB
-----END PUBLIC KEY-----`;

const PRODUCT = 'webxr-balloon-pcvr';
export const SERVER_URL = 'https://webvr123.site';   // ⚠ 正式域名（香港节点，免备案，Let's Encrypt 受信任证书）；本地调试可改回 http://localhost:8787
const STORAGE_KEY = 'webxr_balloon_license_v1';
const MACHINE_KEY = 'webxr_balloon_machineid_v1';

// ── 工具：base64 / PEM 互转 ──
function b64ToBuf(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
function pemToDer(pem) {
  const b64 = pem.replace(/-----BEGIN PUBLIC KEY-----/, '').replace(/-----END PUBLIC KEY-----/, '').replace(/\s+/g, '');
  return b64ToBuf(b64);
}

// 与服务器 server.js 的 canonicalPayload 保持「完全一致」的字段顺序，否则验签不匹配。
function canonicalPayload(lic) {
  return JSON.stringify({
    machineId: lic.machineId,
    product: lic.product,
    issuedAt: lic.issuedAt,
    expiresAt: lic.expiresAt,
  });
}

let _pubKeyPromise = null;
function importPublicKey() {
  if (!_pubKeyPromise) {
    const c = globalThis.crypto;
    _pubKeyPromise = c.subtle.importKey(
      'spki',
      pemToDer(PUBLIC_KEY),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  }
  return _pubKeyPromise;
}

// ── 机器码（持久化随机 UUID）──
function genUUID() {
  const c = globalThis.crypto;
  if (c && c.randomUUID) return c.randomUUID();
  // 兜底（极端环境）：用随机值拼 UUID 形态
  const a = new Uint8Array(16);
  c.getRandomValues(a);
  a[6] = (a[6] & 0x0f) | 0x40;
  a[8] = (a[8] & 0x3f) | 0x80;
  const h = (n) => n.toString(16).padStart(2, '0');
  return `${h(a[0])}${h(a[1])}${h(a[2])}${h(a[3])}-${h(a[4])}${h(a[5])}-${h(a[6])}${h(a[7])}-${h(a[8])}${h(a[9])}-${h(a[10])}${h(a[11])}${h(a[12])}${h(a[13])}${h(a[14])}${h(a[15])}`;
}
export function getMachineId() {
  try {
    let id = localStorage.getItem(MACHINE_KEY);
    if (!id) { id = genUUID(); localStorage.setItem(MACHINE_KEY, id); }
    return id;
  } catch (_) { return 'ephemeral-' + genUUID(); } // 隐私模式等 localStorage 不可用：每次临时，无法离线（会要求每次联网）
}

// ── 验签 + 机器码 + 有效期 ──
export async function verifyLicense(lic) {
  if (!lic || !lic.signature) return { ok: false, reason: 'license 缺少签名' };
  try {
    const key = await importPublicKey();
    const data = new TextEncoder().encode(canonicalPayload(lic));
    const sig = b64ToBuf(lic.signature);
    const ok = await globalThis.crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
    if (!ok) return { ok: false, reason: '签名无效（license 被篡改或非官方签发）' };
    if (lic.machineId !== getMachineId()) return { ok: false, reason: '机器码不匹配（license 不属于本机）' };
    if (lic.product !== PRODUCT) return { ok: false, reason: '产品不匹配' };
    if (lic.expiresAt && lic.expiresAt > 0 && Date.now() > lic.expiresAt) return { ok: false, reason: 'license 已过期' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: '验签异常：' + (e && e.message ? e.message : e) };
  }
}

// ── 启动器 launchToken 校验（原生层签发、以 URL 参数 token= 传入）──
// token 结构：<base64(payload)>.<base64(RSA-SHA256签名)>，payload = { machineId, iat, exp }。
// 与服务器签发时的 tokenPayloadStr 逐字一致（服务器先 JSON.stringify 再签名，此处解码同一字符串验签）。
export async function verifyLaunchToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return { ok: false, reason: 'token 格式错误' };
  try {
    const [pB64, sB64] = token.split('.');
    const payloadStr = atob(pB64);
    const payload = JSON.parse(payloadStr);
    const key = await importPublicKey();
    const data = new TextEncoder().encode(payloadStr);
    const sig = b64ToBuf(sB64);
    const ok = await globalThis.crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
    if (!ok) return { ok: false, reason: 'token 签名无效' };
    if (payload.exp && Date.now() > payload.exp) return { ok: false, reason: 'token 已过期' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'token 校验异常：' + (e && e.message ? e.message : e) };
  }
}

// ── 离线检查（启动/进入前调用）──
// 读取本地已存 license（供 contentLoader 拉取云端配置时使用）
export function getStoredLicense() {
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; }
  catch (_) { return null; }
}

export async function checkAuthorized() {
  let raw;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (_) { return { ok: false, needActivate: true, reason: '无法读取本地 license' }; }
  if (!raw) return { ok: false, needActivate: true, reason: '尚未激活' };
  let lic;
  try { lic = JSON.parse(raw); } catch (_) { return { ok: false, needActivate: true, reason: '本地 license 损坏' }; }
  const r = await verifyLicense(lic);
  return { ok: r.ok, needActivate: !r.ok, reason: r.reason };
}

// ── 首次联网激活 ──
export async function activate() {
  const machineId = getMachineId();
  let res;
  try {
    res = await fetch(SERVER_URL + '/api/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machineId, product: PRODUCT }),
    });
  } catch (e) {
    throw new Error('无法连接激活服务器（' + (e && e.message ? e.message : e) + '）');
  }
  if (!res.ok) throw new Error('激活服务器返回 ' + res.status);
  const data = await res.json();
  if (!data || !data.license || !data.license.signature) throw new Error('激活响应缺少 license');
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data.license)); } catch (_) {}
  return data.license;
}
