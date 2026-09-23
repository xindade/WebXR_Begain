'use strict';
/**
 * P3 样本生成器 —— 造出一批 `GET /api/license/current` 的响应体样本（含各种「不该通过」的变体），
 * 交给 VerifyCurrent.java 用**头显同款**校验逻辑跑一遍。
 *
 *   cd tools/cast-server && node xlang/gen-p3.js        # 只造样本
 *   cd tools/cast-server && node xlang/p3test.js        # 造样本 + 编译 + 跑（推荐）
 *
 * 为什么必须两套实现各跑一次：
 *   ① 「跨语言签名对不齐」的现象**只有「永远验不过」**，而且 ECDSA 每次签名随机，没法用固定样本比对；
 *   ② 本方案多了两个容易踩的编码细节 —— `ke` 是 **base64url 无填充**、而 `Ks_pub` 是
 *      **标准 base64 带填充**；「两边各跑一次」是唯一能可靠抓住这类错的办法。
 *   所以本文件除了造样本，还会用 **lib/license.js 独立实现**把每条样本的结论**算出来**，
 *   与声明值断言一致后写进 out/p3-cases.json —— Java 侧再算出同样结论 = 真互认。
 *
 * ⚠️ 用的是 secrets/ 下的**测试**密钥（与生产的 Ks_pub 不是同一把，见 tools/_dist/pubkey-production.json）。
 *    所以本夹具能验证「算法与编码对齐」，**不能**用来验证「头显里内嵌的生产公钥是对的」——
 *    后者靠 pubkey-production.json 的双哈希自证。
 */
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../lib/license');

const SEC = path.join(__dirname, '..', 'secrets');
const OUT = path.join(__dirname, 'out');

const DAY = 86400000;
const SKEW = 5 * 60 * 1000;
const NOW = Date.now();
/** 与头显 guardNonce() 同规格：16 字节 → 32 位 hex */
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

const ksPrivPath = path.join(SEC, 'license-sign.pem');
const ksPubPath = path.join(SEC, 'public-key.txt');
if (!fs.existsSync(ksPrivPath) || !fs.existsSync(ksPubPath)) {
  console.error('缺少测试密钥 ' + SEC + '，请先在 tools/cast-server 执行：node gen-keys.js');
  process.exit(1);
}
const ksPriv = lib.asPrivateKey(fs.readFileSync(ksPrivPath));
const ksPub = fs.readFileSync(ksPubPath, 'utf8').trim();

/** 另一台「服务器」的签发私钥：造「非本服务器签发」的 license（头显内置 Ks_pub 应当拒） */
const jokerKs = lib.generateKeyPair();
/** 本机正版 EXE 实例密钥 Ke */
const keGood = pickKeWithUrlChars();
/** 另一台机器上的 Ke：造「license 拷到别的机器」（proof 由它签，与 license 里声明的 ke 不符） */
const keOther = lib.generateKeyPair();

/**
 * 挑一把 base64url 里**真的含 `-` 或 `_`** 的 Ke。
 * 目的：base64url 与标准 base64 的差异只在 `- _` 这两个字符上（以及填充），
 * 若不特意构造，样本可能恰好全是「两种解码方式结果相同」的串，
 * 于是「字母表用错」这种 bug 会被静默放过。
 */
function pickKeWithUrlChars() {
  for (let i = 0; i < 50; i++) {
    const kp = lib.generateKeyPair();
    if (/[-_]/.test(kp.publicDerB64u)) return kp;
  }
  throw new Error('试了 50 次都没生成出含 -/_ 的 base64url 公钥，环境异常');
}

// ────────────────────────────── 构造工具 ──────────────────────────────

/** 一份正常的 payload；`over` 覆盖任意字段 */
function payloadOf(over) {
  return Object.assign({
    v: 1,
    lic: 'L20260920-0007',
    cust: 'AcmeArcade-SH-01',
    dev: '9f2c1e4ad3b7',
    ke: keGood.publicDerB64u,          // base64url 无填充（Node 的 'base64url' 语义）
    iat: NOW - DAY,
    nbf: NOW - DAY,
    exp: NOW + 12 * DAY,
    n: 'b7d41c93',
  }, over || {});
}

/** payload + 私钥 → license 文本 `<base64url(payload)>.<base64url(签名)>` */
function sign(payload, priv) {
  const body = lib.encodePayload(payload);
  return body + '.' + lib.signText(priv, body);
}

/** 拼出与 EXE 侧 handleLicenseCurrent 同形的响应体 */
function resp(license, nonce, proof) {
  return JSON.stringify({
    ok: true,
    license,
    nonce,
    proof,
    state: { lic: 'L20260920-0007', cust: 'AcmeArcade-SH-01', exp: NOW + 12 * DAY, daysLeft: 12 },
  });
}

/** 正版 license（由测试 Ks 签，声明 keGood） */
const LIC_OK = sign(payloadOf(), ksPriv);
/** 正版 proof（由 keGood 私钥签当场随机数） */
const PROOF_OK = lib.signText(keGood.privateKey, 'cast|' + NONCE);

/** 篡改一位（保持长度，避免变成「长度不对」这种低级拒绝） */
function flipLast(s) {
  return s.slice(0, -1) + (s.slice(-1) === 'A' ? 'B' : 'A');
}
function flipAt(s, at) {
  return s.slice(0, at) + (s[at] === 'A' ? 'B' : 'A') + s.slice(at + 1);
}

// ────────────────────────────── 用例 ──────────────────────────────
// expect: OK | DENY | RETRY（ABSENT 由 MainActivity 的 HTTP 层判 404，离线测不到，见文件末尾说明）

const cases = [];
function add(name, expect, note, body, opts) {
  cases.push(Object.assign({
    name, expect, note, body,
    nonce: NONCE, nowMs: NOW, skewMs: SKEW,
  }, opts || {}));
}

// ① 正常
add('ok', 'OK', '正版 license + 正版 proof（ke 为 base64url 无填充）',
    resp(LIC_OK, NONCE, PROOF_OK));
add('ok_expiring', 'OK', '只剩 2 天，仍在效期内',
    resp(sign(payloadOf({ exp: NOW + 2 * DAY }), ksPriv), NONCE, PROOF_OK));
add('ok_within_skew', 'OK', '刚过期 1 分钟，落在 ±5 分钟容差内（时钟偏差容忍）',
    resp(sign(payloadOf({ exp: NOW - 60000 }), ksPriv), NONCE, PROOF_OK));
add('ok_ke_standard_padded', 'OK', 'ke 写成**标准 base64 带填充**（同一把公钥的另一种写法）',
    resp(sign(payloadOf({ ke: keGood.publicDerB64 }), ksPriv), NONCE, PROOF_OK));

// ② license 被篡改 / 非本服务器签发
add('bad_license_sig', 'DENY', '篡改 license 签名末位',
    resp(flipLast(LIC_OK), NONCE, PROOF_OK));
add('bad_license_body', 'DENY', '篡改 license payload 文本一位（签名不变）',
    resp(flipAt(LIC_OK, 5), NONCE, PROOF_OK));
add('wrong_ks', 'DENY', 'license 由**另一把**签发私钥签的（模拟别的服务器/伪造）',
    resp(sign(payloadOf(), jokerKs.privateKey), NONCE, PROOF_OK));
add('license_not_pair', 'DENY', 'license 没有分隔点',
    resp('abcdefghijklmnop', NONCE, PROOF_OK));
add('license_two_dots', 'DENY', 'license 出现两个分隔点',
    resp(LIC_OK + '.AAAA', NONCE, PROOF_OK));

// ③ 时间窗
add('expired', 'DENY', '过期 1 天，超出容差',
    resp(sign(payloadOf({ exp: NOW - DAY }), ksPriv), NONCE, PROOF_OK));
add('not_yet', 'DENY', 'nbf 在未来 1 天（尚未生效）',
    resp(sign(payloadOf({ nbf: NOW + DAY, exp: NOW + 10 * DAY }), ksPriv), NONCE, PROOF_OK));
add('no_exp', 'DENY', 'payload 缺 exp（=0）',
    resp(sign(payloadOf({ exp: 0 }), ksPriv), NONCE, PROOF_OK));
add('bad_version', 'DENY', '格式版本 v=2（本端只认 1）',
    resp(sign(payloadOf({ v: 2 }), ksPriv), NONCE, PROOF_OK));

// ④ nonce / proof —— 这两条才是「防拷贝」的核心
add('nonce_mismatch', 'DENY', 'nonce 回显与我们发出的不一致（疑似重放旧响应）',
    resp(LIC_OK, 'ffffffffffffffffffffffffffffffff', PROOF_OK));
add('proof_bad_sig', 'DENY', 'proof 被篡改',
    resp(LIC_OK, NONCE, flipLast(PROOF_OK)));
add('proof_wrong_ke', 'DENY', '★ 关键：license 声明 keGood，但 proof 由**别台机器**的 Ke 签 —— '
    + '这正是「把 license 拷到另一台机器」的形态，必须拒',
    resp(LIC_OK, NONCE, lib.signText(keOther.privateKey, 'cast|' + NONCE)));
add('proof_empty', 'DENY', 'proof 为空（对端没签）',
    resp(LIC_OK, NONCE, ''));
add('no_ke', 'DENY', 'payload 缺 ke 字段',
    resp(sign(payloadOf({ ke: '' }), ksPriv), NONCE, PROOF_OK));
add('ke_not_a_key', 'DENY', 'ke 不是合法公钥',
    resp(sign(payloadOf({ ke: 'AAAA' }), ksPriv), NONCE, PROOF_OK));
add('empty_nonce_expected', 'DENY', '本机没生成 nonce（内部错误）',
    resp(LIC_OK, NONCE, PROOF_OK), { nonce: '' });

// ⑤ 对端自己说没授权 / 响应读不了 —— 分 DENY 与 RETRY
add('exe_not_active', 'DENY', 'EXE 侧 licenseGate 的原文（未激活）',
    JSON.stringify({ ok: false, nonce: NONCE, why: '直播端未激活：请在接收端界面填入激活码', state: {} }));
add('exe_expired', 'DENY', 'EXE 侧 licenseGate 的原文（已到期）',
    JSON.stringify({ ok: false, nonce: NONCE, why: '直播端授权不可用：license 已到期', state: {} }));
add('payload_not_json', 'DENY', 'payload 解出来不是 JSON（已由 Ks 正确签名，说明是我们自己的格式问题）',
    resp(sign0Raw(), NONCE, PROOF_OK));
add('html_body', 'RETRY', '200 但响应体是 HTML（不该发生，按抖动重试到超时）', '<html>404 not found</html>');
add('empty_body', 'RETRY', '响应体为空', '');

/** 用真 Ks 签一段「body 解出来不是 JSON」的 license，验证 ④ 的兜底分支 */
function sign0Raw() {
  const body = lib.b64uEncode(Buffer.from('this is definitely not json', 'utf8'));
  return body + '.' + lib.signText(ksPriv, body);
}

// ───────────────── Node 侧独立实现：算出每条结论并与声明值断言 ─────────────────
// 故意**不复用** Java 侧代码（也不复用上面造样本的写法），只依赖 lib/license.js 的原语。

function evalNode(c) {
  const body = c.body;
  const nonce = c.nonce;
  const now = c.nowMs;
  const skew = c.skewMs;

  if (!body || !String(body).trim()) return { k: 'RETRY', why: '响应为空' };
  let o;
  try { o = JSON.parse(body); } catch (e) { return { k: 'RETRY', why: '响应不是 JSON' }; }
  if (!o || o.ok !== true) return { k: 'DENY', why: (o && o.why) || '对端说没授权' };
  if (!nonce) return { k: 'DENY', why: '本机未生成 nonce' };
  if (nonce !== String(o.nonce || '')) return { k: 'DENY', why: 'nonce 回显不一致' };

  const lic = String(o.license || '');
  const dot = lic.indexOf('.');
  if (dot <= 0 || dot >= lic.length - 1) return { k: 'DENY', why: 'license 格式非法' };
  const b = lic.slice(0, dot);
  const s = lic.slice(dot + 1);
  if (s.indexOf('.') >= 0) return { k: 'DENY', why: 'license 格式非法（多个分隔点）' };
  if (!lib.verifyText(ksPub, b, s)) return { k: 'DENY', why: 'license 签名不通过' };

  let p;
  try { p = JSON.parse(lib.b64uDecode(b).toString('utf8')); } catch (e) {
    return { k: 'DENY', why: 'payload 解析失败' };
  }
  if (Number(p.v) !== 1) return { k: 'DENY', why: '版本不支持' };
  const nbf = Number(p.nbf || 0);
  const exp = Number(p.exp || 0);
  if (nbf > 0 && now + skew < nbf) return { k: 'DENY', why: '尚未生效' };
  if (!(exp > 0)) return { k: 'DENY', why: '缺少 exp' };
  if (now - skew > exp) return { k: 'DENY', why: '已到期' };

  const ke = String(p.ke || '');
  if (!ke) return { k: 'DENY', why: '缺少 ke' };
  let kePub;
  try { kePub = lib.asPublicKey(ke); } catch (e) { return { k: 'DENY', why: 'ke 不是合法公钥' }; }
  if (!lib.verifyText(kePub, 'cast|' + String(o.nonce || ''), String(o.proof || ''))) {
    return { k: 'DENY', why: 'proof 验签不通过' };
  }
  return { k: 'OK', why: '通过' };
}

const mismatched = [];
for (const c of cases) {
  const got = evalNode(c);
  c.nodeExpect = got.k;
  c.nodeWhy = got.why;
  if (got.k !== c.expect) mismatched.push(c.name + '：声明 ' + c.expect + '，Node 实算 ' + got.k + '（' + got.why + '）');
}

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'p3-cases.json'),
  JSON.stringify({ ksPubB64: ksPub, generatedAt: NOW, nowMs: NOW, skewMs: SKEW, cases }, null, 2));

const byKind = { OK: 0, DENY: 0, RETRY: 0 };
for (const c of cases) byKind[c.expect]++;
console.log('已生成 ' + cases.length + ' 条样本 → ' + path.join(OUT, 'p3-cases.json'));
console.log('  期望分布：OK ' + byKind.OK + ' / DENY ' + byKind.DENY + ' / RETRY ' + byKind.RETRY);
console.log('  Ke（base64url）含 -/_ ? ' + /[-_]/.test(keGood.publicDerB64u)
  + '（true 才能覆盖「base64url 与标准 base64 字母表不同」这条路）');
console.log('  Ks_pub 长度 ' + ksPub.length + '，带填充? ' + (ksPub.indexOf('=') >= 0));
if (mismatched.length) {
  console.error('');
  console.error('[FAIL] 声明值与 Node 独立实现不一致（' + mismatched.length + ' 条）—— 说明用例本身写错了：');
  for (const m of mismatched) console.error('   - ' + m);
  process.exit(1);
}
console.log('  [OK] Node 独立实现与声明值逐条一致');
console.log('');
console.log('[!] 离线测不到的两种情形（属 MainActivity 的 HTTP 层，必须在真机/现场覆盖）：');
console.log('   · HTTP 404  → KIND_ABSENT（旧版接收端 EXE，提示「换 EXE」而不是「未授权」）');
console.log('   · 连不上    → KIND_RETRY（继续重试，绝不能当拒绝 —— 硬约束 61）');
