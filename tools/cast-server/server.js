'use strict';
/**
 * 授权服务器（webvr123.site 后端）
 *
 * 零 npm 依赖：只用 node:http / node:crypto / node:fs，存储优先 node:sqlite。
 *
 * 路由
 *   POST /api/license/activate    激活（激活码）→ 首次签发
 *   POST /api/license/renew       续期（Ke 签名 proof）
 *   GET  /api/license/revoked     吊销名单（Ke 签名 proof）
 *   POST /api/license/issue       手工签发   ┐
 *   POST /api/license/revoke      吊销       │ 管理员（Basic Auth）
 *   GET  /api/admin/licenses      列表       │
 *   POST /api/admin/activation    生成激活码 ┘
 *   GET  /api/health              健康检查（无需鉴权）
 *   GET  /api/pubkey              签发公钥 + 指纹（无需鉴权；两端硬编码用）
 *   GET  /api/manifest            内容清单（共享密钥；EXE 每次启动拉取，见下方「内容清单」段）
 *   GET  /admin                   管理后台页面（Basic Auth）
 *
 * 启动
 *   node server.js                # 默认 127.0.0.1:8787
 *   PORT=8787 HOST=0.0.0.0 node server.js
 *   ADMIN_USER=admin ADMIN_PASS=xxx node server.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const lib = require('./lib/license');
const db = require('./lib/db');

// 屏蔽 node:sqlite 的 ExperimentalWarning（功能正常，只是噪声）
const _emit = process.emitWarning;
process.emitWarning = (w, ...rest) => {
  if (String(w).indexOf('SQLite') >= 0) return;
  return _emit.call(process, w, ...rest);
};

const ROOT = __dirname;
const SECRET_DIR = path.join(ROOT, 'secrets');
/** 数据目录可用 DATA_DIR 覆盖（自测时隔离用） */
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const LOG_FILE = path.join(DATA_DIR, 'server.log');
const ADMIN_FILE = path.join(SECRET_DIR, 'admin.json');

// ---------------------------------------------------------------- 配置

/** 可调参数（生产可用 config.json 覆盖，避免改代码） */
const cfg = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '127.0.0.1',
  /** license 有效期（天）—— 需求方口述的「管 15 天」 */
  ttlDays: 15,
  /** 到期前多少天开始允许续期（客户端也会按此判断，服务器只做上限校验） */
  renewWindowDays: 3,
  /** 请求体上限（字节） */
  maxBody: 64 * 1024,
  /** 单 IP 每分钟最大激活尝试次数（防爆破激活码） */
  activateRatePerMin: 10,
  /** 单 IP 每分钟最大续期次数 —— 必须与激活分开计数，否则正常续期会被激活限流误伤 */
  renewRatePerMin: 60,
  /** ★ 第二十四修：内容清单共享密钥（EXE 侧默认值必须逐字一致；生产建议用 config.json / MANIFEST_KEY 覆盖） */
  manifestKey: process.env.MANIFEST_KEY || 'webxr-manifest',
  /** 单 IP 每分钟最大清单拉取次数（每次开局一次，正常远低于它） */
  manifestRatePerMin: 120,
  /** 清单整包上限（字节）：内容都是文本，正常几十 KB；超了说明发布错了目录 */
  maxManifestBytes: 2 * 1024 * 1024,
  /** 管理员 Basic Auth —— 未设置则自动生成并落盘 */
  adminUser: process.env.ADMIN_USER || '',
  adminPass: process.env.ADMIN_PASS || '',
};
try {
  Object.assign(cfg, JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')));
} catch (e) {
  /* 无 config.json 属正常 */
}
if (process.env.ADMIN_USER) cfg.adminUser = process.env.ADMIN_USER;
if (process.env.ADMIN_PASS) cfg.adminPass = process.env.ADMIN_PASS;
// ★ 第二十四修：内容清单密钥也允许环境变量覆盖（部署脚本里 exported 更省事）
if (process.env.MANIFEST_KEY) cfg.manifestKey = process.env.MANIFEST_KEY;

const TTL_MS = cfg.ttlDays * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- 日志

function log(...a) {
  const line = new Date().toISOString() + ' ' + a.join(' ');
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 启动自检

if (!fs.existsSync(path.join(SECRET_DIR, 'license-sign.pem'))) {
  console.error('[fatal] 找不到 secrets/license-sign.pem');
  console.error('[fatal] 请先执行：node gen-keys.js');
  process.exit(1);
}
const SIGN_PRIV = fs.readFileSync(path.join(SECRET_DIR, 'license-sign.pem'));
const SIGN_PUB_B64 = fs.readFileSync(path.join(SECRET_DIR, 'public-key.txt'), 'utf8').trim();

// 管理员凭证：env > secrets/admin.json > 随机生成并落盘
if (!cfg.adminUser || !cfg.adminPass) {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
  } catch (e) {
    /* ignore */
  }
  if (saved && saved.user && saved.pass) {
    cfg.adminUser = cfg.adminUser || saved.user;
    cfg.adminPass = cfg.adminPass || saved.pass;
    // 已存在凭证时不重复打印密码，但必须给出「去哪找」的提示，
    // 否则 operator 首次部署若 secrets/admin.json 随包一起拷过去，会完全不知道该用什么登录
    log('管理员账号：' + cfg.adminUser + '（密码见 secrets/admin.json，或用 ADMIN_PASS 覆盖）');
  } else {
    cfg.adminUser = cfg.adminUser || 'admin';
    cfg.adminPass = cfg.adminPass || crypto.randomBytes(12).toString('base64url');
    fs.mkdirSync(SECRET_DIR, { recursive: true });
    fs.writeFileSync(ADMIN_FILE, JSON.stringify({ user: cfg.adminUser, pass: cfg.adminPass }, null, 2), { mode: 0o600 });
    console.log('====================================================');
    console.log(' 已生成管理员账号（请立刻保存，文件：secrets/admin.json）');
    console.log('   用户名: ' + cfg.adminUser);
    console.log('   密码  : ' + cfg.adminPass);
    console.log('====================================================');
  }
}

const store = db.open(DATA_DIR);
log('存储后端 = ' + store.kind);

// ---------------------------------------------------------------- 小工具

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function text(res, code, s) {
  const body = Buffer.from(String(s), 'utf8');
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

/** 读 JSON 请求体（带大小上限） */
function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const fail = (why) => {
      if (done) return;
      done = true;
      resolve({ ok: false, why });
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > cfg.maxBody) {
        fail('请求体过大');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({ ok: true, body: {} });
      try {
        const body = JSON.parse(raw);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return resolve({ ok: false, why: '请求体必须是 JSON 对象' });
        resolve({ ok: true, body });
      } catch (e) {
        resolve({ ok: false, why: 'JSON 解析失败' });
      }
    });
    req.on('error', () => fail('连接中断'));
  });
}

/** 取真实客户端 IP（Caddy 反代后看 X-Forwarded-For 首个） */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '-';
}

/** 滑窗限流 */
const rateMap = new Map();
function rateLimited(ip, perMin) {
  const now = Date.now();
  const arr = (rateMap.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  rateMap.set(ip, arr);
  if (rateMap.size > 5000) rateMap.clear(); // 防内存膨胀
  return arr.length > perMin;
}

function checkBasicAuth(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  let dec = '';
  try {
    dec = Buffer.from(h.slice(6), 'base64').toString('utf8');
  } catch (e) {
    return false;
  }
  const i = dec.indexOf(':');
  if (i < 0) return false;
  const u = dec.slice(0, i);
  const p = dec.slice(i + 1);
  // 定长比较，避免时序侧信道
  const a = Buffer.from(u + ':' + p);
  const b = Buffer.from(cfg.adminUser + ':' + cfg.adminPass);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res) {
  if (checkBasicAuth(req)) return true;
  res.writeHead(401, { 'www-authenticate': 'Basic realm="webvr123 admin"' });
  res.end('需要管理员认证');
  return false;
}

// license 编号：L + 日期 + 当日流水（冲突则递增）
function nextLicId() {
  const d = new Date();
  const ymd = '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const prefix = 'L' + ymd + '-';
  const today = store.licenses.list().filter((r) => String(r.lic).startsWith(prefix)).length;
  let n = today + 1;
  while (store.licenses.get(prefix + String(n).padStart(4, '0'))) n++;
  return prefix + String(n).padStart(4, '0');
}

/** 激活码：3 段 4 字符，去掉易混的 0/O/1/I */
function newActCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({ length: 4 }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
  return seg() + '-' + seg() + '-' + seg();
}

// ---------------------------------------------------------------- 业务

/**
 * 激活：POST /api/license/activate
 * body { actCode, dev, ke, host? }
 * 幂等：同一 dev 再次激活直接返回已有 license（不重复消耗配额），除非 reissue=true
 */
function handleActivate(req, res, body) {
  const ip = clientIp(req);
  const actCode = String(body.actCode || '').trim().toUpperCase();
  const dev = String(body.dev || '').trim();
  const ke = String(body.ke || '').trim();

  if (!actCode) return json(res, 400, { ok: false, reason: 'badParam', detail: '缺少 actCode' });
  if (!dev) return json(res, 400, { ok: false, reason: 'badParam', detail: '缺少 dev（机器指纹）' });
  if (!ke) return json(res, 400, { ok: false, reason: 'badParam', detail: '缺少 ke（实例公钥）' });
  if (ke.length > 4096) return json(res, 400, { ok: false, reason: 'badParam', detail: 'ke 过长' });

  // 幂等：这台机器已经激活过
  const exist = store.licenses.byDev(dev);
  if (exist && !exist.revoked && body.reissue !== true) {
    const again = lib.issueLicense(SIGN_PRIV, {
      lic: exist.lic, cust: exist.cust, dev: exist.dev, ke: exist.ke,
      iat: exist.iat, nbf: exist.nbf, exp: exist.exp,
    });
    log('activate 幂等命中 dev=' + dev + ' lic=' + exist.lic + ' ip=' + ip);
    return json(res, 200, { ok: true, license: again.license, payload: again.payload, idempotent: true, daysLeft: Math.floor((exist.exp - Date.now()) / 86400000) });
  }

  const act = store.activations.get(actCode);
  if (!act) {
    log('activate 拒绝：激活码不存在 ' + actCode + ' ip=' + ip);
    return json(res, 403, { ok: false, reason: 'badCode', detail: '激活码无效' });
  }
  if (Number(act.expires_at) > 0 && Date.now() > Number(act.expires_at)) {
    return json(res, 403, { ok: false, reason: 'codeExpired', detail: '激活码已过期' });
  }
  if (Number(act.used) >= Number(act.max_uses)) {
    return json(res, 403, { ok: false, reason: 'codeUsed', detail: '激活码已用尽（上限 ' + act.max_uses + '）' });
  }

  const lic = nextLicId();
  const now = Date.now();
  const issued = lib.issueLicense(SIGN_PRIV, {
    lic, cust: act.cust || '', dev, ke, iat: now, nbf: now, exp: now + TTL_MS,
  });
  store.licenses.put({
    lic, cust: act.cust || '', dev, ke, iat: now, nbf: now, exp: now + TTL_MS,
    note: '激活码 ' + actCode + ' / host=' + String(body.host || '').slice(0, 64),
    revoked: false, revoked_reason: '', revoked_at: 0, renew_count: 0, last_renew_at: 0, created_at: now,
  });
  store.activations.consume(actCode, lic);

  log('activate 成功 lic=' + lic + ' cust=' + (act.cust || '-') + ' dev=' + dev + ' ip=' + ip);
  return json(res, 200, { ok: true, license: issued.license, payload: issued.payload, daysLeft: cfg.ttlDays });
}

/**
 * 续期：POST /api/license/renew
 * body { lic, dev, ke, ts, proof }   proof = Ke_sign("renew|<lic>|<ts>")
 */
function handleRenew(req, res, body) {
  const ip = clientIp(req);
  const lic = String(body.lic || '').trim();
  const dev = String(body.dev || '').trim();
  const ke = String(body.ke || '').trim();
  const ts = Number(body.ts);
  const proof = String(body.proof || '').trim();

  if (!lic || !dev || !ke || !Number.isFinite(ts) || !proof) {
    return json(res, 400, { ok: false, reason: 'badParam', detail: '缺少 lic/dev/ke/ts/proof' });
  }

  const row = store.licenses.get(lic);
  if (!row) return json(res, 404, { ok: false, reason: 'notFound', detail: 'license 不存在' });
  if (row.revoked) return json(res, 403, { ok: false, reason: 'revoked', detail: row.revoked_reason || '已被吊销' });
  if (row.dev !== dev) return json(res, 403, { ok: false, reason: 'machineMismatch', detail: '机器指纹不匹配（换机需重新激活）' });
  if (row.ke !== ke) return json(res, 403, { ok: false, reason: 'keyMismatch', detail: '实例公钥不匹配（EXE 密钥被换过）' });
  if (Math.abs(Date.now() - ts) > lib.SKEW_MS) return json(res, 400, { ok: false, reason: 'stale', detail: '时间戳偏差超过 5 分钟，请校时' });

  if (!lib.verifyText(ke, 'renew|' + lic + '|' + ts, proof)) {
    log('renew 拒绝：proof 验签失败 lic=' + lic + ' ip=' + ip);
    return json(res, 403, { ok: false, reason: 'badProof', detail: '持有证明验签失败' });
  }

  const now = Date.now();
  const exp = now + TTL_MS;
  const issued = lib.issueLicense(SIGN_PRIV, { lic, cust: row.cust, dev, ke, iat: row.iat, nbf: row.nbf, exp });
  store.licenses.touchRenew(lic, exp, now);

  log('renew 成功 lic=' + lic + ' 新到期=' + new Date(exp).toISOString() + ' ip=' + ip);
  return json(res, 200, { ok: true, license: issued.license, payload: issued.payload, daysLeft: cfg.ttlDays });
}

/**
 * 吊销名单：GET /api/license/revoked?lic=&ts=&proof=
 * proof = Ke_sign("revoked|<lic>|<ts>")
 */
function handleRevoked(req, res, url) {
  const lic = String(url.searchParams.get('lic') || '').trim();
  const ts = Number(url.searchParams.get('ts'));
  const proof = String(url.searchParams.get('proof') || '').trim();
  if (!lic || !Number.isFinite(ts) || !proof) {
    return json(res, 400, { ok: false, reason: 'badParam', detail: '缺少 lic/ts/proof' });
  }
  const row = store.licenses.get(lic);
  if (!row) return json(res, 404, { ok: false, reason: 'notFound', detail: 'license 不存在' });
  if (Math.abs(Date.now() - ts) > lib.SKEW_MS) return json(res, 400, { ok: false, reason: 'stale', detail: '时间戳偏差超过 5 分钟' });
  if (!lib.verifyText(row.ke, 'revoked|' + lic + '|' + ts, proof)) {
    return json(res, 403, { ok: false, reason: 'badProof', detail: '持有证明验签失败' });
  }
  const list = store.licenses.revokedList();
  return json(res, 200, { ok: true, server: Date.now(), count: list.length, revoked: list });
}

/** 管理：手工签发 POST /api/license/issue { cust, dev, ke, days?, note? } */
function handleIssue(req, res, body) {
  const cust = String(body.cust || '').trim();
  const dev = String(body.dev || '').trim();
  const ke = String(body.ke || '').trim();
  if (!cust || !dev || !ke) return json(res, 400, { ok: false, reason: 'badParam', detail: '缺少 cust/dev/ke' });
  const days = Number(body.days) > 0 ? Number(body.days) : cfg.ttlDays;
  const lic = String(body.lic || '').trim() || nextLicId();
  const now = Date.now();
  const exp = now + days * 86400000;
  const issued = lib.issueLicense(SIGN_PRIV, { lic, cust, dev, ke, iat: now, nbf: now, exp });
  store.licenses.put({
    lic, cust, dev, ke, iat: now, nbf: now, exp,
    note: String(body.note || '手工签发').slice(0, 200),
    revoked: false, revoked_reason: '', revoked_at: 0, renew_count: 0, last_renew_at: 0, created_at: now,
  });
  log('issue 手工签发 lic=' + lic + ' cust=' + cust + ' days=' + days);
  return json(res, 200, { ok: true, license: issued.license, payload: issued.payload, daysLeft: days });
}

/** 管理：吊销 POST /api/license/revoke { lic, reason?, undo? } */
function handleRevoke(req, res, body) {
  const lic = String(body.lic || '').trim();
  if (!lic) return json(res, 400, { ok: false, reason: 'badParam', detail: '缺少 lic' });
  const row = store.licenses.get(lic);
  if (!row) return json(res, 404, { ok: false, reason: 'notFound', detail: 'license 不存在' });
  const undo = body.undo === true;
  store.licenses.setRevoked(lic, !undo, String(body.reason || '').slice(0, 200), undo ? 0 : Date.now());
  log((undo ? 'revoke 撤销 lic=' : 'revoke 吊销 lic=') + lic);
  return json(res, 200, { ok: true, lic, revoked: !undo });
}

/** 管理：生成激活码 POST /api/admin/activation { cust, maxUses?, days?, note? } */
function handleNewActivation(req, res, body) {
  const cust = String(body.cust || '').trim();
  const code = String(body.code || '').trim().toUpperCase() || newActCode();
  const maxUses = Number(body.maxUses) > 0 ? Number(body.maxUses) : 1;
  const days = Number(body.days) > 0 ? Number(body.days) : 0;
  store.activations.put({
    code, cust, max_uses: maxUses, used: 0, note: String(body.note || '').slice(0, 200),
    expires_at: days ? Date.now() + days * 86400000 : 0, used_by: '', created_at: Date.now(),
  });
  log('生成激活码 ' + code + ' cust=' + cust + ' 次数=' + maxUses);
  return json(res, 200, { ok: true, code, cust, maxUses, expiresInDays: days });
}

// ---------------------------------------------------------------- 公钥自助

/**
 * GET /api/pubkey —— 公开、无需鉴权。
 *
 * 公钥本来就是公开信息，而且两端（EXE / APK）都要把它硬编码进源码。
 * 有了这个路由，运维取公钥就不必再 SSH / VNC 进去 `cat secrets/public-key.txt` ——
 * 实测在 VNC 控制台里粘贴命令会被「Shift 卡住」打坏（连 24 字符的 cd 都能坏），
 * 而浏览器打开 URL → 复制 → 粘贴是完全无损的。指纹一并给出，便于两端核对。
 * 注意：这里只暴露【公钥】；私钥 license-sign.pem 绝不出网。
 */
function handlePubKey(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, reason: 'method' });
  let pem = '';
  try {
    pem = fs.readFileSync(path.join(SECRET_DIR, 'license-pub.pem'), 'utf8');
  } catch (e) {
    // 少数部署可能只有 base64 形态 —— 按 Node export({format:'pem'}) 的规则复算（64 字符换行 + 结尾换行）
    const b64 = Buffer.from(SIGN_PUB_B64, 'base64').toString('base64');
    pem = '-----BEGIN PUBLIC KEY-----\n' + (b64.match(/.{1,64}/g) || []).join('\n') + '\n-----END PUBLIC KEY-----\n';
  }
  return json(res, 200, {
    ok: true,
    alg: 'ECDSA-P256-SHA256',
    keyB64: SIGN_PUB_B64,
    // 与部署脚本 `sha256sum secrets/license-pub.pem | cut -c1-24` 同口径，便于核对有没有抄走样
    fingerprint: crypto.createHash('sha256').update(pem, 'utf8').digest('hex').slice(0, 24),
    derSha256: crypto.createHash('sha256').update(Buffer.from(SIGN_PUB_B64, 'base64')).digest('hex'),
    note: '两端硬编码的公钥 = keyB64（只暴露公钥，私钥绝不出网）',
  });
}

// ---------------------------------------------------------------- 内容清单（第二十四修）

/**
 * ★ 第二十四修（2026-09-24）：`GET /api/manifest` —— 「每次启动从服务器拉清单」的服务端。
 *
 * <p>需求方的口径（2026-09-24 确认）：**不再做加密狗式授权校验**（那套仍在 /api/license/*，客户端已用
 * `--license` 开关降级为可选），改成「EXE 每次启动从本接口拉一份配置清单」，并在**关闭游戏**与
 * **下次启动前**把旧时间的配置清掉。
 *
 * <p>与旧「加密狗」的区别（这条决定了实现方式）：
 *   · 不绑机器、不要激活码、不需要 Ke/proof —— 只用一个**共享密钥**（cfg.manifestKey）防「同网段乱拉」；
 *   · 强度定位诚实：这是「配置集中管理 + 版本一致 + 不留旧配置」，**不是**防破解。要防破解得回到
 *     Ks 签名那套（见 docs/tech/08-授权服务器与License方案.md）。
 *
 * <p>请求：`GET /api/manifest?key=<共享密钥>&ver=<客户端期望的内容版本>`
 * <p>响应：`{ ok, ver, builtAt, count, bytes, server, files:[{path,sha256,size,content}] }`
 *   · `path` 是**项目相对路径**（如 `src/content/levels.js`），客户端按它落盘到自己的缓存目录；
 *   · `sha256` 是 `content` 的 UTF-8 字节哈希，客户端**逐项校验**，不符即整体拒用；
 *   · `ver` **只按精确匹配**，没有就 404 `noContentVersion`，**绝不回落 current** ——
 *     否则会出「客户端 2.0 + 内容 1.0」的崩溃事故（见 docs/内容授权门禁设计.md §9）。
 *
 * <p>内容源：`<本目录>/content/<ver>/`，由 `node sync-content.js --ver <版本>` 从项目里发布。
 */
const CONTENT_DIR = process.env.CONTENT_DIR ? path.resolve(process.env.CONTENT_DIR) : path.join(ROOT, 'content');

/** 定长比较（清单密钥用；与 checkBasicAuth 同一手法，避免时序侧信道） */
function keyEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** 读 content/manifest.json（发布索引）：{ versions:[], current, updatedAt }。缺文件 = 还没发布过。 */
function readContentIndex() {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'manifest.json'), 'utf8'));
    return {
      versions: Array.isArray(o.versions) ? o.versions.map(String) : [],
      current: String(o.current || ''),
      updatedAt: Number(o.updatedAt || 0),
    };
  } catch (e) {
    return { versions: [], current: '', updatedAt: 0 };
  }
}

/** /api/health 用：内容侧一眼可见（现场排查「服务器到底有没有内容」） */
function contentIndexSummary() {
  const idx = readContentIndex();
  return { dir: CONTENT_DIR, current: idx.current, versions: idx.versions, updatedAt: idx.updatedAt };
}

/** 把一个版本目录整棵树读成清单项（path 用项目相对路径，正斜杠；ver.json 是发布元数据，不进清单） */
function readContentTree(dir) {
  const files = [];
  let bytes = 0;
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(abs).sort()) walk(path.join(rel, n));
      return;
    }
    const buf = fs.readFileSync(abs);
    bytes += buf.length;
    if (bytes > cfg.maxManifestBytes) throw new Error('内容包超过上限 ' + cfg.maxManifestBytes + 'B');
    files.push({
      path: rel.split(path.sep).join('/'),
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      size: buf.length,
      content: buf.toString('utf8'),
    });
  };
  for (const n of fs.readdirSync(dir).sort()) {
    if (n === 'ver.json') continue;
    walk(n);
  }
  return { files, bytes };
}

function handleManifest(req, res, url) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, reason: 'method' });
  const ip = clientIp(req);
  if (rateLimited('mft|' + ip, cfg.manifestRatePerMin)) {
    return json(res, 429, { ok: false, reason: 'rateLimit', detail: '清单拉取过于频繁' });
  }
  if (!keyEq(url.searchParams.get('key') || '', cfg.manifestKey)) {
    log('清单 403：密钥不对 ip=' + ip);
    return json(res, 403, {
      ok: false, reason: 'badKey',
      detail: '清单密钥不对：EXE 的 --manifest-key / MANIFEST_KEY 必须与服务器 cfg.manifestKey 一致',
    });
  }
  const idx = readContentIndex();
  const want = String(url.searchParams.get('ver') || '');
  const ver = want || idx.current;
  if (!ver) {
    return json(res, 404, {
      ok: false, reason: 'noContent',
      detail: '服务器还没发布任何内容版本（先在项目里跑 node sync-content.js --ver 1.0.0）',
    });
  }
  if (!/^[0-9A-Za-z._-]{1,32}$/.test(ver)) return json(res, 400, { ok: false, reason: 'badParam', detail: 'ver 不合法' });
  const dir = path.join(CONTENT_DIR, ver);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    log('清单 404：没有内容版本 ' + ver + '（现有：' + (idx.versions.join(', ') || '无') + '）');
    return json(res, 404, {
      ok: false, reason: 'noContentVersion',
      detail: '服务器没有内容版本 ' + ver + '（版本必须精确匹配，不回落 current）',
      versions: idx.versions,
    });
  }
  let tree;
  try {
    tree = readContentTree(dir);
  } catch (e) {
    log('!! 内容树读取失败 ver=' + ver + ' : ' + (e && e.message ? e.message : e));
    return json(res, 500, { ok: false, reason: 'badContent', detail: String((e && e.message) || e) });
  }
  if (!tree.files.length) return json(res, 404, { ok: false, reason: 'noContent', detail: '内容版本 ' + ver + ' 是空目录' });
  let verMeta = {};
  try {
    verMeta = JSON.parse(fs.readFileSync(path.join(dir, 'ver.json'), 'utf8'));
  } catch (e) { /* ver.json 可选（只有 sync-content.js 会写） */ }
  log('清单下发 ver=' + ver + ' 文件=' + tree.files.length + ' 共 ' + tree.bytes + 'B ip=' + ip);
  return json(res, 200, {
    ok: true,
    ver,
    builtAt: Number(verMeta.builtAt || 0),
    count: tree.files.length,
    bytes: tree.bytes,
    server: Date.now(),
    files: tree.files,
  });
}

// ---------------------------------------------------------------- 路由

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;
  const ip = clientIp(req);

  try {
    if (p === '/api/health') {
      return json(res, 200, {
        ok: true, server: Date.now(), store: store.kind, uptime: Math.floor(process.uptime()),
        licenses: store.licenses.list().length, revoked: store.licenses.revokedList().length,
        ttlDays: cfg.ttlDays, renewWindowDays: cfg.renewWindowDays, node: process.version,
        content: contentIndexSummary(),   // ★ 第二十四修：内容清单索引（versions / current）
      });
    }

    if (p === '/api/license/activate') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, reason: 'method' });
      if (rateLimited('act|' + ip, cfg.activateRatePerMin)) return json(res, 429, { ok: false, reason: 'rateLimit', detail: '尝试过于频繁' });
      const r = await readJson(req);
      if (!r.ok) return json(res, 400, { ok: false, reason: 'badBody', detail: r.why });
      return handleActivate(req, res, r.body);
    }

    if (p === '/api/license/renew') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, reason: 'method' });
      if (rateLimited('ren|' + ip, cfg.renewRatePerMin)) return json(res, 429, { ok: false, reason: 'rateLimit', detail: '尝试过于频繁' });
      const r = await readJson(req);
      if (!r.ok) return json(res, 400, { ok: false, reason: 'badBody', detail: r.why });
      return handleRenew(req, res, r.body);
    }

    if (p === '/api/license/revoked') {
      if (req.method !== 'GET') return json(res, 405, { ok: false, reason: 'method' });
      return handleRevoked(req, res, url);
    }

    if (p === '/api/license/issue') {
      if (!requireAdmin(req, res)) return;
      if (req.method !== 'POST') return json(res, 405, { ok: false, reason: 'method' });
      const r = await readJson(req);
      if (!r.ok) return json(res, 400, { ok: false, reason: 'badBody', detail: r.why });
      return handleIssue(req, res, r.body);
    }

    if (p === '/api/license/revoke') {
      if (!requireAdmin(req, res)) return;
      if (req.method !== 'POST') return json(res, 405, { ok: false, reason: 'method' });
      const r = await readJson(req);
      if (!r.ok) return json(res, 400, { ok: false, reason: 'badBody', detail: r.why });
      return handleRevoke(req, res, r.body);
    }

    if (p === '/api/admin/licenses') {
      if (!requireAdmin(req, res)) return;
      const now = Date.now();
      const rows = store.licenses.list().map((r) => ({
        ...r,
        daysLeft: Math.floor((Number(r.exp) - now) / 86400000),
        expired: now > Number(r.exp),
      }));
      return json(res, 200, { ok: true, count: rows.length, licenses: rows });
    }

    if (p === '/api/admin/activations') {
      if (!requireAdmin(req, res)) return;
      const rows = store.activations.list();
      return json(res, 200, { ok: true, count: rows.length, activations: rows });
    }

    if (p === '/api/admin/activation') {
      if (!requireAdmin(req, res)) return;
      if (req.method !== 'POST') return json(res, 405, { ok: false, reason: 'method' });
      const r = await readJson(req);
      if (!r.ok) return json(res, 400, { ok: false, reason: 'badBody', detail: r.why });
      return handleNewActivation(req, res, r.body);
    }

    if (p === '/api/pubkey') return handlePubKey(req, res);

    // ★ 第二十四修：内容清单（EXE 每次启动来这里换配置；共享密钥，见「内容清单」段）
    if (p === '/api/manifest') return handleManifest(req, res, url);

    if (p === '/admin' || p === '/admin.html') {
      if (!requireAdmin(req, res)) return;
      const f = path.join(ROOT, 'public', 'admin.html');
      if (!fs.existsSync(f)) return text(res, 404, 'admin.html 不存在');
      const buf = fs.readFileSync(f);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length });
      return res.end(buf);
    }

    return json(res, 404, { ok: false, reason: 'noRoute', detail: p });
  } catch (e) {
    log('!! 未捕获异常 ' + p + ' : ' + (e && e.stack ? e.stack : e));
    return json(res, 500, { ok: false, reason: 'internal', detail: String((e && e.message) || e) });
  }
});

server.headersTimeout = 15000;
server.requestTimeout = 20000;

server.listen(cfg.port, cfg.host, () => {
  log('授权服务器已启动 http://' + cfg.host + ':' + cfg.port + ' | 有效期 ' + cfg.ttlDays + ' 天');
  log('签发公钥（应硬编码进两端）: ' + SIGN_PUB_B64);
});

process.on('SIGTERM', () => {
  log('收到 SIGTERM，退出');
  try { store.close(); } catch (e) { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});

module.exports = { server, cfg, store, lib };
