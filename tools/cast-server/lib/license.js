'use strict';
/**
 * license 编解码与签名 —— 授权服务器侧核心密码学
 *
 * 设计定案（与 docs/tech/08-授权服务器与License方案.md 严格一致）：
 *   · 算法：ECDSA P-256 + SHA-256
 *   · 文本格式： <base64url(payloadJSON)>.<base64url(signature)>
 *   · 签名对象 = 左边那串 base64url 文本本身（ASCII），**不是** JSON 原文
 *     —— 否则两端 JSON 键序/空格差异会导致算不出同一串（文档 §3.3）
 *
 * 跨语言对齐（已实测，见 tools/_probe_ec/）：
 *   Node crypto.sign('sha256', data, privKey) 默认输出 DER ，
 *   与 Java Signature.getInstance("SHA256withECDSA") 天然一致。
 *   ⚠️ 绝对不要传 dsaEncoding:'ieee-p1363' —— 那会变成 64 字节固定格式，Java 验不过。
 *
 * base64url 约定（P3 必读）：
 *   Node 的 'base64url' 编码**不带填充**（'='），且用 '-' '_' 代替 '+' '/'。
 *   Android 侧必须用  android.util.Base64.URL_SAFE | NO_WRAP | NO_PADDING 解码，
 *   或在 Java 里先补填充再解。用 java.util.Base64 会踩 API 26 门槛（本项目 minSdk 24）。
 */
const crypto = require('node:crypto');

/** license 格式版本，当前 1 */
const VERSION = 1;

/** license 有效期（毫秒）—— 15 天，文档 §3.3 的 exp = iat + 15d */
const TTL_MS = 15 * 24 * 60 * 60 * 1000;

/** 允许的时钟偏差（毫秒）—— 服务器与 EXE/头显都要容忍 ±5 分钟（文档 §11.5） */
const SKEW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------- 编解码

/** 任意字节 → base64url 文本（无填充） */
function b64uEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** base64url 文本 → 字节（容忍带/不带填充两种写法） */
function b64uDecode(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s, 'base64');
}

/** payload 对象 → base64url 文本；键序固定，保证同一对象稳定出串 */
function encodePayload(payload) {
  return b64uEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
}

// ---------------------------------------------------------------- 密钥

/**
 * 读取私钥（PKCS#8 PEM 或 KeyObject）
 * @param {string|Buffer|crypto.KeyObject} key
 */
function asPrivateKey(key) {
  if (key && typeof key === 'object' && key.type === 'private') return key;
  return crypto.createPrivateKey(key);
}

/**
 * 读取公钥（SPKI PEM、SPKI DER base64 文本，或 KeyObject）
 * 允许直接喂 gen-keys.js 打印的硬编码 base64，便于两侧共用同一段文本。
 */
function asPublicKey(key) {
  if (key && typeof key === 'object' && key.type === 'public') return key;
  if (Buffer.isBuffer(key)) return crypto.createPublicKey({ key, format: 'der', type: 'spki' });
  const s = String(key || '').trim();
  if (s.startsWith('-----BEGIN')) return crypto.createPublicKey(s);
  // 当作 SPKI DER 的 base64（标准或 url-safe 都吃）
  const isUrl = s.indexOf('-') >= 0 || s.indexOf('_') >= 0;
  const buf = isUrl ? b64uDecode(s) : Buffer.from(s, 'base64');
  return crypto.createPublicKey({ key: buf, format: 'der', type: 'spki' });
}

/** 生成一对 P-256 密钥（服务器签发用；EXE 实例密钥也可复用） */
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKey,
    privateKey,
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    // 这串就是要硬编码进 EXE 与 APK 的「签发公钥」
    publicDerB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    publicDerB64u: b64uEncode(publicKey.export({ type: 'spki', format: 'der' })),
  };
}

// ---------------------------------------------------------------- 签发 / 验签

/**
 * 用私钥签一段 ASCII 文本，返回 base64url（无填充）签名
 * @param {string|Buffer|crypto.KeyObject} privateKey
 * @param {string|Buffer} text
 */
function signText(privateKey, text) {
  const key = asPrivateKey(privateKey);
  const data = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'ascii');
  // 不传 dsaEncoding —— 保持 Node 默认 DER，与 Java SHA256withECDSA 对齐
  return b64uEncode(crypto.sign('sha256', data, key));
}

/**
 * 验一段 ASCII 文本的 base64url 签名
 * @returns {boolean}
 */
function verifyText(publicKey, text, sigB64u) {
  try {
    const key = asPublicKey(publicKey);
    const data = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'ascii');
    return crypto.verify('sha256', data, key, b64uDecode(sigB64u));
  } catch (e) {
    // 畸形公钥/签名一律视为验签失败，绝不向上抛（与 Android 侧 try/catch 策略一致）
    return false;
  }
}

/**
 * 签发一份 license
 * @param {string|Buffer|crypto.KeyObject} privateKey 服务器签发私钥 Ks
 * @param {object} opts { lic, cust, dev, ke, iat?, nbf?, exp?, n? }
 * @returns {{ license: string, payload: object }}
 */
function issueLicense(privateKey, opts) {
  const now = Date.now();
  const payload = {
    v: VERSION,
    lic: String(opts.lic || ''),
    cust: String(opts.cust || ''),
    dev: String(opts.dev || ''),
    ke: String(opts.ke || ''),
    iat: Number(opts.iat || now),
    nbf: Number(opts.nbf || now),
    exp: Number(opts.exp || now + TTL_MS),
    n: String(opts.n || crypto.randomBytes(6).toString('hex')),
  };
  const body = encodePayload(payload);
  const sig = signText(privateKey, body);
  return { license: body + '.' + sig, payload };
}

/**
 * 拆开 license 文本
 * @returns {{ body: string, sig: string } | null} null = 格式非法
 */
function splitLicense(text) {
  const s = String(text || '').trim();
  const dot = s.indexOf('.');
  if (dot <= 0 || dot === s.length - 1) return null;
  const body = s.slice(0, dot);
  const sig = s.slice(dot + 1);
  if (sig.indexOf('.') >= 0) return null; // 只允许一个分隔点
  return { body, sig };
}

/**
 * 验签 + 结构校验（不做时间判定，时间判定用 checkTime —— 分离是好让调用方给出精确原因）
 * @param {string|Buffer|crypto.KeyObject} publicKey 签发公钥 Ks_pub
 * @param {string} text license 文本
 * @returns {{ ok: true, payload: object } | { ok: false, reason: string, detail?: string }}
 */
function verifyLicense(publicKey, text) {
  const parts = splitLicense(text);
  if (!parts) return { ok: false, reason: 'format', detail: '不是 <payload>.<sig> 结构' };

  if (!verifyText(publicKey, parts.body, parts.sig)) {
    return { ok: false, reason: 'badSig', detail: '签名验证不通过（可能被篡改或非本服务器签发）' };
  }

  let payload;
  try {
    payload = JSON.parse(b64uDecode(parts.body).toString('utf8'));
  } catch (e) {
    return { ok: false, reason: 'payload', detail: 'payload 不是合法 JSON' };
  }

  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'payload', detail: 'payload 不是对象' };
  if (Number(payload.v) !== VERSION) return { ok: false, reason: 'version', detail: '格式版本不支持：' + payload.v };
  for (const k of ['lic', 'cust', 'dev', 'ke']) {
    if (typeof payload[k] !== 'string' || !payload[k]) return { ok: false, reason: 'field', detail: '字段缺失：' + k };
  }
  for (const k of ['iat', 'nbf', 'exp']) {
    if (!Number.isFinite(Number(payload[k]))) return { ok: false, reason: 'field', detail: '字段非数字：' + k };
  }
  if (Number(payload.exp) <= Number(payload.nbf)) return { ok: false, reason: 'field', detail: 'exp 不晚于 nbf' };

  return { ok: true, payload };
}

/**
 * 时间窗判定（与签名分离）
 * @returns {{ ok: boolean, reason?: string, detail?: string, daysLeft?: number }}
 */
function checkTime(payload, now = Date.now()) {
  const nbf = Number(payload.nbf);
  const exp = Number(payload.exp);
  if (now + SKEW_MS < nbf) {
    return { ok: false, reason: 'notYet', detail: '尚未生效（nbf 在未来）' };
  }
  if (now - SKEW_MS > exp) {
    return { ok: false, reason: 'expired', detail: '已过期' };
  }
  return { ok: true, daysLeft: Math.floor((exp - now) / 86400000) };
}

/** 验签 + 时间判定一步到位（服务器自测 / 管理后台用） */
function checkLicense(publicKey, text, now = Date.now()) {
  const v = verifyLicense(publicKey, text);
  if (!v.ok) return v;
  const t = checkTime(v.payload, now);
  if (!t.ok) return { ok: false, reason: t.reason, detail: t.detail, payload: v.payload };
  return { ok: true, payload: v.payload, daysLeft: t.daysLeft };
}

module.exports = {
  VERSION,
  TTL_MS,
  SKEW_MS,
  b64uEncode,
  b64uDecode,
  encodePayload,
  asPrivateKey,
  asPublicKey,
  generateKeyPair,
  signText,
  verifyText,
  issueLicense,
  splitLicense,
  verifyLicense,
  checkTime,
  checkLicense,
};
