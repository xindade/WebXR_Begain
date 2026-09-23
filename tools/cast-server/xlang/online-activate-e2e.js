#!/usr/bin/env node
'use strict';
/**
 * 线上授权往返实跑（online-activate-e2e）
 * ============================================================================
 * 用法（在 tools/cast-server 下）：
 *   node xlang/online-activate-e2e.js 8JD9-5M2Y-DR28
 *   node xlang/online-activate-e2e.js <码> --new-dev      # 换一台「假机器」（会再消耗 1 次配额）
 *   node xlang/online-activate-e2e.js <码> --dev=<64hex>  # 直接指定机器指纹
 *   node xlang/online-activate-e2e.js <码> --base=https://webvr123.site
 *
 * ---------------------------------------------------------------------------
 * 为什么必须做这件事 —— 离线夹具永远测不到的那一段
 *
 * 离线夹具（p3test / exe-license-e2e）用的都是本地【测试】密钥，只能证明「算法与编码对齐」。
 * 真正会把所有客户一次锁死的 bug 只有一类：
 *       **服务器实际签发用的私钥 ≠ 两端硬编码的那串公钥**
 *   （换机迁移、误覆盖 secrets/、手工替换公钥、装了两个实例……）
 * 它离线测不到，因为离线样本是拿测试密钥自己签的；而且它**当下不报错** ——
 * /api/health 照常 200、激活也照常返回 license，要到头显拿去验签才失败。
 * 唯一能一次钉死的办法：拿【生产】服务器**真签一张**，再用【两端源码里那串字面量】去验。
 * 这就是本夹具存在的理由（断言 [3]）。
 *
 * ---------------------------------------------------------------------------
 * 执行顺序
 *   [0] /api/health（顺手量本机与服务器的时钟差）+ /api/pubkey
 *       断言 pubkey.keyB64 == cast-pc/main.js 常量 == cast-apk/MainActivity.java 常量（逐字节）
 *   [1] 造一台「假机器」：xlang/out/online/ 下生成 Ke（P-256），dev 固定派生（复跑免费）
 *   [2] 激活（消耗 1 次配额）：POST /api/license/activate {actCode, dev, ke, host}
 *   [3] ★ 用【两端源码里的公钥】离线验这张线上 license + 时间窗 + 字段
 *   [3b] 复现头显第 ⑤ 步（nonce + proof）：本机验得过 / 换机验不过 / 改 nonce 失效
 *   [4] 幂等复跑：同 dev 再激活 → idempotent=true、lic/exp 不变、**不再消耗配额**
 *   [5] 续期往返：POST /api/license/renew {lic: **编号**, dev, ke, ts, proof}
 *       ⚠ 契约：renew / revoked 的 `lic` 是**编号**（payload.lic，形如 L20260920-0001），
 *         不是整段 license 文本。传整段文本不会报「格式错」，而是 404 notFound
 *         「license 不存在」—— 极易被误读成「服务器把数据弄丢了」（本轮实测踩过）。
 *   [6] 吊销名单（P4 端点，只读）：GET /api/license/revoked?lic&ts&proof
 *   [7] 反例 5 条（全部零消耗）：错码 / 缺 ke / proof 对错消息 / 换机 / 旧时间戳 / 不存在的 lic
 *   [8] 结论 + 清理提示（给出 lic 与 dev，admin 里能定位）
 *
 * ---------------------------------------------------------------------------
 * 安全纪律
 *   · **严格校验 TLS**（绝不写 rejectUnauthorized:false —— 那等于给中间人开门）；
 *   · 只在 `xlang/out/online/`（已 gitignore）下写文件，**绝不碰真实 userData**；
 *   · 只消耗 **1 次**激活码配额：同 dev 复跑走幂等分支，免费。
 *     要换身份必须显式 `--new-dev`（那时会在报告里把「又消耗了 1 次」写清楚）。
 *
 * 退出码：0 = 全通过；1 = 有断言失败；2 = 前置条件不成立（公钥对不上 / 激活码不可用 / 连不上）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('../lib/license');

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
const hasFlag = (n) => argv.indexOf('--' + n) >= 0;
function arg(n, def) {
  const p = '--' + n + '=';
  const hit = argv.find((a) => a.indexOf(p) === 0);
  return hit ? hit.slice(p.length) : def;
}
const CODE = (argv.find((a) => a.indexOf('--') !== 0) || '').trim().toUpperCase();
const BASE = arg('base', 'https://webvr123.site').replace(/\/+$/, '');
const NEW_DEV = hasFlag('new-dev');

// ---------------------------------------------------------------- 路径
const SCRIPT_DIR = __dirname;
const CS_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(CS_ROOT, '..', '..');
const OUT = path.join(SCRIPT_DIR, 'out', 'online');
const MAIN_JS = path.join(REPO_ROOT, 'tools', 'cast-pc', 'main.js');
const MAIN_ACTIVITY = path.join(REPO_ROOT, 'tools', 'cast-apk', 'app', 'src', 'main', 'java',
  'com', 'local', 'webxrcast', 'MainActivity.java');
const KEY_PEM = path.join(OUT, 'e2e-license-key.pem');
const MACHINE = path.join(OUT, 'e2e-machine.json');

// ---------------------------------------------------------------- 输出
const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', b: '\x1b[1m', o: '\x1b[0m' };
let PASS = 0, FAIL = 0;
const INFO = [];
function sec(t) { console.log(`\n${C.b}${C.c}[${t}]${C.o}`); }
function ok(cond, label, detail) {
  if (cond) { PASS++; console.log(`  ${C.g}[OK]${C.o}   ${label}`); }
  else { FAIL++; console.log(`  ${C.r}[FAIL]${C.o} ${label}${detail ? '\n         -> ' + String(detail).slice(0, 400) : ''}`); }
}
function info(s) { INFO.push(s); console.log(`  ${C.y}[i]${C.o}    ${s}`); }
function die(s) { console.log(`\n${C.r}${C.b}[fatal]${C.o} ${s}\n`); process.exit(2); }

// ---------------------------------------------------------------- HTTP
const httpMod = BASE.indexOf('http://') === 0 ? require('node:http') : require('node:https');
function request(method, pathname, bodyObj) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(pathname, BASE); }
    catch (e) { return resolve({ status: -1, body: null, raw: '', why: 'URL 非法：' + pathname }); }
    const data = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const req = httpMod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method,
      timeout: 15000,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; if (raw.length > 262144) req.destroy(); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* 保持 null */ }
        resolve({
          status: res.statusCode, body: json, raw,
          why: json ? String(json.detail || json.reason || '') : ('HTTP ' + res.statusCode + ' ' + raw.slice(0, 140)),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时 15000ms')));
    req.on('error', (e) => resolve({ status: -1, body: null, raw: '', why: '连接失败：' + e.message }));
    req.end(data || undefined);
  });
}
const get = (p) => request('GET', p);
const post = (p, b) => request('POST', p, b);

// ---------------------------------------------------------------- 小工具
const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
function srcConst(file, re, tag) {
  let s;
  try { s = fs.readFileSync(file, 'utf8'); }
  catch (e) { die(`读不到${tag}：${file}\n  ${e.message}`); }
  const m = s.match(re);
  if (!m) die(`${tag} 里找不到 LICENSE_PUBKEY_B64 常量：${file}`);
  return m[1];
}

// ============================================================================
(async () => {
  if (!CODE) {
    die('缺激活码。用法： node xlang/online-activate-e2e.js <激活码>\n'
      + '  激活码在 https://webvr123.site/admin 生成（建议 maxUses=1 即可，因为同机复跑免费）。');
  }
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`${C.b}线上授权往返实跑${C.o}   base=${BASE}   code=${CODE}${NEW_DEV ? '   ' + C.y + '(--new-dev：会消耗配额)' + C.o : ''}`);

  // ——————————————————————————————————————— [0] 前置：公钥三方一致性
  sec('0 前置：健康检查 + 公钥三方一致性');

  const health = await get('/api/health');
  if (health.status !== 200) die(`/api/health 拿不到（HTTP ${health.status}）：${health.why}\n  先确认服务器在跑： curl -s ${BASE}/api/health`);
  ok(true, `/api/health → 200　store=${health.body.store} ttlDays=${health.body.ttlDays} node=${health.body.node} lic=${health.body.licenses}`);
  const ttlDays = Number(health.body.ttlDays) || 15;

  // 时钟差：现场最常见的「续期莫名 stale」就是机器时钟偏了（方案 §11.5 要求 ±5 分钟内）
  const skewMs = Number(health.body.server) - Date.now();
  const skewSec = (skewMs / 1000).toFixed(1);
  if (Math.abs(skewMs) > 60000) {
    info(`本机时钟与服务器相差 ${skewSec}s —— 超过 5 分钟就会让 renew 报 stale（请校时）`);
  } else {
    info(`本机时钟与服务器相差 ${skewSec}s（在 ±5 分钟容差内，正常）`);
  }

  const pk = await get('/api/pubkey');
  ok(pk.status === 200 && pk.body && pk.body.ok === true, `/api/pubkey → 200`);
  const srcPc = srcConst(MAIN_JS, /LICENSE_PUBKEY_B64\s*=\s*'([^']*)'/, 'cast-pc/main.js');
  const srcApk = srcConst(MAIN_ACTIVITY, /LICENSE_PUBKEY_B64\s*=\s*"([^"]*)"/, 'cast-apk/MainActivity.java');
  ok(srcPc === srcApk, '两端内置公钥逐字节一致（EXE == APK）',
    `EXE=${srcPc.slice(0, 32)}… / APK=${srcApk.slice(0, 32)}…`);
  ok(pk.body.keyB64 === srcPc, '★ /api/pubkey 的公钥 == 两端内置公钥（服务器没在发布另一把）',
    `/api/pubkey=${String(pk.body.keyB64).slice(0, 32)}…`);
  const der = Buffer.from(srcPc, 'base64');
  ok(pk.body.derSha256 === sha256hex(der), 'derSha256 与本地复算一致（防手抄错字符）',
    `服务端=${pk.body.derSha256} 本地=${sha256hex(der)}`);
  let pubObj = null;
  try { pubObj = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }); } catch (e) { /* 见下 */ }
  ok(!!pubObj, '内置公钥能被解析成 P-256 公钥（不是一段坏文本）');
  if (pubObj) {
    const det = pubObj.asymmetricKeyDetails || {};
    ok(pubObj.asymmetricKeyType === 'ec' && det.namedCurve === 'prime256v1',
      `曲线正确：ec/${det.namedCurve || '?'}`, JSON.stringify(det));
  }

  // ——————————————————————————————————————— [1] 假机器
  sec('1 造一台「假机器」（ke + dev）');
  // 复用同一把 Ke + 同一个 dev ⇒ 复跑会走服务器的幂等分支，**不再消耗配额**。
  // 这正是真机行为：同一台机器拿激活码重来一次，服务器不重复扣配额。
  // 要验「全新签发」这条路，必须显式 --new-dev（那就真的会再扣 1 次，报告里会写清）。
  const KEY_EXISTS = fs.existsSync(KEY_PEM);
  let pem;
  if (!NEW_DEV && KEY_EXISTS) {
    pem = fs.readFileSync(KEY_PEM, 'utf8');
  } else {
    pem = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.writeFileSync(KEY_PEM, pem, { mode: 0o600 });
  }
  let mach = null;
  if (!NEW_DEV && fs.existsSync(MACHINE)) {
    try { mach = JSON.parse(fs.readFileSync(MACHINE, 'utf8')); } catch (e) { mach = null; }
  }
  const priv = crypto.createPrivateKey(pem);
  const ke = L.b64uEncode(crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }));
  const devArg = arg('dev', null);
  const dev = devArg || (NEW_DEV
    ? sha256hex('online-activate-e2e|v1|' + crypto.randomBytes(12).toString('hex'))
    : (mach && mach.dev) || sha256hex('online-activate-e2e|v1|stable-machine'));
  if (!devArg) {
    fs.writeFileSync(MACHINE, JSON.stringify({
      dev, ke,
      createdAt: (!NEW_DEV && mach && mach.createdAt) || new Date().toISOString(),
      rerun: ((mach && Number(mach.rerun)) || 0) + 1,
    }, null, 2) + '\n', 'utf8');
  }
  const HOST = 'e2e-selftest';
  ok(!!ke && ke.length > 80, `ke = base64url(SPKI DER)，${ke.length} 字符`);
  info(`dev = ${dev.slice(0, 24)}…（${NEW_DEV ? '本次新造' : '固定派生'}；同 dev 复跑走幂等分支，不再消耗配额）`);
  info(`Ke 私钥只落在 xlang/out/online/（已 gitignore），不碰真实 userData`);

  // ——————————————————————————————————————— [2] 激活
  sec('2 激活（消耗 1 次激活码配额）');
  const act = await post('/api/license/activate', { actCode: CODE, dev, ke, host: HOST });
  if (!(act.body && act.body.ok === true)) {
    const reason = (act.body && act.body.reason) || '(无)';
    die(`激活未成功：HTTP ${act.status} / ${reason} / ${act.why}\n`
      + '  常见原因：\n'
      + '   · badCode      —— 码抄错了（形如 ABCD-EFGH-IJKL，校验时不区分大小写）\n'
      + '   · codeUsed     —— 这枚码的配额已被别人用掉（admin 里能看到 used/max_uses）\n'
      + '   · codeExpired  —— 生成时设了 expiresInDays\n'
      + '  → 到 https://webvr123.site/admin 再生成一枚，或把 maxUses 调大。');
  }
  ok(act.status === 200, `POST /api/license/activate → HTTP ${act.status}`);
  ok(!!act.body.license && act.body.license.split('.').length === 2, '返回体含 <payload>.<sig> 结构的 license');
  // 幂等命中不是失败 —— 复跑本来就该免费。这里只如实记账「这次到底有没有扣配额」。
  info(act.body.idempotent === true
    ? '服务器判定为幂等命中 ⇒ 本次**未消耗**激活码配额（要验「全新签发」请加 --new-dev）'
    : '新签发 ⇒ 本次**消耗了 1 次**激活码配额');
  const lic = String(act.body.license || '');                              // 整段 license 文本：只用于验签
  const licId = String((act.body.payload && act.body.payload.lic) || '');  // license 编号：调 renew/revoked 用这个
  ok(!!licId && !!lic, `拿到编号 lic=${licId} 与 license 文本（${lic.length} 字符）`);
  info(`cust=${(act.body.payload && act.body.payload.cust) || '-'}　API daysLeft=${act.body.daysLeft}`);

  // ——————————————————————————————————————— [3] ★ 用两端公钥验线上 license
  sec('3 ★ 用【两端源码里的公钥】验这张线上 license（本夹具的核心）');
  const v = L.verifyLicense(srcPc, lic);
  ok(v.ok === true, '★ 线上签发的 license 被两端内置公钥验签通过', JSON.stringify(v));
  if (v.ok === false) {
    die('这条失败意味着「服务器签发的凭据，两端验不过」—— 这就是会把所有客户一次锁死的那类 bug。\n'
      + '  请先核对：服务器上 /opt/webvr123/secrets/license-sign.pem 与 license-pub.pem 是不是一对。');
  }
  // 验签器的负例：证明它不是「永远返回 true」
  const tampered = lic.slice(0, 20) + (lic[20] === 'A' ? 'B' : 'A') + lic.slice(21);
  ok(L.verifyLicense(srcPc, tampered).ok === false, '（负例）把 license 正文改 1 个字符 → 验签必须失败');

  const p0 = v.payload;
  // 契约（实测踩过）：renew / revoked 的 `lic` 参数是**编号**（payload.lic），不是整段 license 文本。
  // 传整段文本并不会报「格式错」，而是 404 notFound「license 不存在」—— 很容易被误读成「服务器丢数据了」。
  ok(p0.lic === licId && licId.length > 0 && licId === licId.trim() && licId.indexOf('.') < 0,
    '★ 接口参数口径：lic = payload.lic（编号，形如 L20260920-0001），不是整段 license 文本',
    `payload.lic=${p0.lic} / 文本长度=${lic.length}`);
  const t = L.checkTime(p0, Date.now());
  ok(t.ok === true, `时间窗有效（本地纯判定，断网也算得出来）`, JSON.stringify(t));
  ok(p0.ke === ke, 'payload.ke == 本机 Ke（头显第 ⑤ 步能验 proof 的前提）');
  ok(p0.dev === dev, 'payload.dev == 本机指纹');
  ok(Number(p0.exp) - Number(p0.iat) === ttlDays * 86400000,
    `exp - iat == ${ttlDays} 天（服务器 TTL 与两端的续期窗口一致）`,
    `${(Number(p0.exp) - Number(p0.iat)) / 86400000} 天`);
  ok(Math.abs(Number(p0.nbf) - Number(p0.iat)) < 1000, 'nbf ≈ iat（激活即生效，不设延迟）');

  // 口径差异：API 报的 daysLeft 是「名义天数」，两端自己按 exp-now 算会立刻 floor 成少 1 天
  const actualDays = typeof t.daysLeft === 'number' ? t.daysLeft : null;
  if (actualDays !== null && Number(act.body.daysLeft) !== actualDays) {
    info(`口径差异（非故障）：API 报 daysLeft=${act.body.daysLeft}（名义 ${ttlDays} 天），`
      + `按 exp-now 实算 = ${actualDays} 天。两端界面按实算显示，所以激活当天看到的是 ${actualDays} 天。`);
  }

  // ——————————————————————————————————————— [3b] 头显第 ⑤ 步
  sec('3b 复现头显第 ⑤ 步（nonce + proof，防拷贝的权威判据）');
  const nonce = crypto.randomBytes(16).toString('hex');
  const proof = L.signText(priv, 'cast|' + nonce);
  ok(L.verifyText(ke, 'cast|' + nonce, proof) === true, '用 license 里声明的 ke 验 proof → 通过');
  const other = L.generateKeyPair();
  ok(L.verifyText(other.publicDerB64u, 'cast|' + nonce, proof) === false,
    '同一份 license 拷到另一台机器（换 Ke）→ proof 验不过（这就是防拷贝）');
  ok(L.verifyText(ke, 'cast|' + nonce + '0', proof) === false,
    '头显换一个 nonce 重放旧 proof → 验不过（防重放）');

  // ——————————————————————————————————————— [4] 幂等
  sec('4 幂等复跑（同 dev 再激活，不消耗配额）');
  const act2 = await post('/api/license/activate', { actCode: CODE, dev, ke, host: HOST });
  ok(act2.body && act2.body.ok === true, '再次激活仍然 ok:true');
  ok(act2.body && act2.body.idempotent === true, '标记为 idempotent:true（走的是「本机已激活」分支）');
  const v2 = act2.body && act2.body.license ? L.verifyLicense(srcPc, act2.body.license) : { ok: false };
  ok(v2.ok === true, '幂等返回的 license 同样被两端公钥验通过');
  if (v2.ok) {
    ok(v2.payload.lic === p0.lic, 'lic 编号不变（不换号）');
    ok(Number(v2.payload.exp) === Number(p0.exp), 'exp 不变（幂等**不**刷新有效期 —— 想续期要走 renew）');
    ok(v2.payload.n !== p0.n, '一次性随机数 n 每次都换（同一份 payload 也不会出同样的签名）');
  }

  // ——————————————————————————————————————— [5] 续期
  sec('5 续期往返（proof = Ke_sign("renew|<lic>|<ts>")）');
  const ts1 = Date.now();
  const rn = await post('/api/license/renew', {
    lic: licId, dev, ke, ts: ts1, proof: L.signText(priv, `renew|${licId}|${ts1}`),
  });
  ok(rn.body && rn.body.ok === true, `POST /api/license/renew → ok:true`, rn.why);
  const rv = rn.body && rn.body.license ? L.verifyLicense(srcPc, rn.body.license) : { ok: false };
  ok(rv.ok === true, '续期返回的 license 同样被两端公钥验通过', JSON.stringify(rv));
  if (rv.ok) {
    ok(rv.payload.lic === p0.lic, '续期不换号（lic 不变）');
    ok(Number(rv.payload.exp) > Number(p0.exp), '新 exp 晚于旧 exp（有效期真的被推后了）');
    ok(Math.abs(Number(rv.payload.exp) - (ts1 + ttlDays * 86400000)) < 10000,
      `新 exp ≈ 续期时刻 + ${ttlDays} 天`, `差 ${((Number(rv.payload.exp) - ts1) / 86400000).toFixed(4)} 天`);
    ok(Number(rv.payload.iat) === Number(p0.iat), 'iat 保持首次签发时间（可追溯「哪天激活的」）');
    info(`续期后 remaining = ${L.checkTime(rv.payload, Date.now()).daysLeft} 天`);
  }

  // ——————————————————————————————————————— [6] 吊销名单
  sec('6 吊销名单（P4 端点，只读）');
  const ts2 = Date.now();
  const rvk = await get('/api/license/revoked?lic=' + encodeURIComponent(licId)
    + '&ts=' + ts2 + '&proof=' + encodeURIComponent(L.signText(priv, `revoked|${licId}|${ts2}`)));
  ok(rvk.body && rvk.body.ok === true, 'GET /api/license/revoked → ok:true', rvk.why);
  if (rvk.body && rvk.body.ok === true) {
    ok(typeof rvk.body.count === 'number', `返回吊销条数（当前 count=${rvk.body.count}）`);
    ok(Array.isArray(rvk.body.revoked), 'revoked 是数组（头显可以直接遍历缓存）');
    ok((rvk.body.revoked || []).indexOf(licId) < 0, '本夹具这张 license **不在**吊销名单里（符合预期）');
  }

  // ——————————————————————————————————————— [7] 反例
  sec('7 反例（全部零消耗：不会用掉任何配额）');
  const denyDev = sha256hex('online-activate-e2e|deny-probe');

  const bad1 = await post('/api/license/activate', { actCode: 'ZZZZ-ZZZZ-ZZZZ', dev: denyDev, ke, host: HOST });
  ok(bad1.status === 403 && bad1.body && bad1.body.reason === 'badCode',
    `错码 → 403 badCode（实测 ${bad1.status}/${bad1.body && bad1.body.reason}）`);

  const bad2 = await post('/api/license/activate', { actCode: CODE, dev: denyDev, host: HOST });
  ok(bad2.status === 400 && bad2.body && bad2.body.reason === 'badParam',
    `缺 ke → 400 badParam（实测 ${bad2.status}/${bad2.body && bad2.body.reason}）`);

  const ts3 = Date.now();
  const bad3 = await post('/api/license/renew', {
    lic: licId, dev, ke, ts: ts3,
    proof: L.signText(priv, `renew|${licId}|${ts3 + 1}`),   // 签名有效，但签的是**别的消息**
  });
  ok(bad3.status === 403 && bad3.body && bad3.body.reason === 'badProof',
    `proof 签的是别的消息 → 403 badProof（实测 ${bad3.status}/${bad3.body && bad3.body.reason}）`);

  const bad4 = await post('/api/license/renew', {
    lic: licId, dev: denyDev, ke, ts: ts3, proof: L.signText(priv, `renew|${licId}|${ts3}`),
  });
  ok(bad4.status === 403 && bad4.body && bad4.body.reason === 'machineMismatch',
    `换一台机器（dev 不符）→ 403 machineMismatch（实测 ${bad4.status}/${bad4.body && bad4.body.reason}）`);

  const tsOld = Date.now() - 10 * 60 * 1000;
  const bad5 = await post('/api/license/renew', {
    lic: licId, dev, ke, ts: tsOld, proof: L.signText(priv, `renew|${licId}|${tsOld}`),
  });
  ok(bad5.status === 400 && bad5.body && bad5.body.reason === 'stale',
    `时间戳差 10 分钟 → 400 stale（实测 ${bad5.status}/${bad5.body && bad5.body.reason}）`);

  const bad6 = await post('/api/license/renew', {
    lic: 'L-NOT-EXIST', dev, ke, ts: ts3, proof: L.signText(priv, `renew|L-NOT-EXIST|${ts3}`),
  });
  ok(bad6.status === 404 && bad6.body && bad6.body.reason === 'notFound',
    `不存在的 lic → 404 notFound（实测 ${bad6.status}/${bad6.body && bad6.body.reason}）`);

  // ——————————————————————————————————————— [8] 结论
  const report = {
    at: new Date().toISOString(), base: BASE, code: CODE, dev, ke,
    lic: (v.payload && v.payload.lic) || null,
    cust: (v.payload && v.payload.cust) || null,
    exp: (v.payload && v.payload.exp) || null,
    renewExp: (rv.ok && rv.payload.exp) || null,
    pubkeyFingerprint: pk.body && pk.body.fingerprint,
    pubkeyDerSha256: pk.body && pk.body.derSha256,
    skewMs, ttlDays, pass: PASS, fail: FAIL,
    raw: {
      health: health.body, pubkey: pk.body,
      activate: act.body, activateAgain: act2.body, renew: rn.body, revoked: rvk.body,
    },
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

  sec('8 结论');
  console.log(`  ${FAIL === 0 ? C.g : C.r}${C.b}${PASS} 通过 / ${FAIL} 失败${C.o}`);
  INFO.forEach((s) => console.log(`  ${C.y}[i]${C.o}    ${s}`));
  console.log(`\n${C.b}本次在【生产服务器】上留下的痕迹（如实告知）${C.o}`);
  console.log(`  · 消耗激活码配额：本次${act.body.idempotent === true ? '走幂等分支，**未消耗**' : '**消耗 1 次**'}（码 ${CODE}）`);
  console.log(`  · 新增/命中的 license：lic=${report.lic}  cust=${report.cust || '-'}`);
  console.log(`  · 绑定的 dev（虚构机器）：${dev}`);
  console.log(`  · 这台「机器」不存在，所以它永远不会续期，${ttlDays} 天后自然过期（无害）。`);
  console.log(`  · 想立刻清掉：https://webvr123.site/admin 里吊销 ${report.lic}`);
  console.log(`  · 原始证据：xlang/out/online/report.json（含全部 HTTP 响应）`);
  console.log('');

  process.exit(FAIL === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`\n${C.r}${C.b}[fatal]${C.o} 夹具自身异常：${e && e.stack || e}\n`);
  process.exit(2);
});
