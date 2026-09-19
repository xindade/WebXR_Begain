// PCVR 首次联网激活服务（Node，仅依赖内置 crypto / http，无需 npm install）。
//
// 职责：接收一个 machineId（客户端首次运行生成的随机 UUID），用「私钥」对
//   { machineId, product, issuedAt, expiresAt } 做 RSA-SHA256 签名，返回 { license, launchToken }。
//   license 供原生启动器离线验签；launchToken 由启动器作为 URL 参数传给游戏，游戏 JS 校验后才放行。
//   客户端之后用内置公钥离线验签，无需再联网。
//
// 启动：node server.js   （或 npm start）
//   环境变量：
//     LICENSE_PORT    监听端口，默认 8787
//     LICENSE_PRODUCT 产品标识，默认 webxr-balloon-pcvr（须与客户端 license.js 的 PRODUCT 一致）
//
// ⚠ 安全：本服务持有私钥（keys/private.pem），必须部署在你自己可控的服务器，且不要公开源码/私钥。
//   ⚠ 换私钥 = 让所有已发 license 失效（revoke 手段）；换密钥后需同步改客户端 license.js 的 PUBLIC_KEY。
//   ⚠ 当前实现「任何 machineId 都签」= 首次联网即可激活（防离线复制 + 可 revoke）。
//     若需人工审核/白名单/限激活数，在下方 handleActivate 自行扩展。

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.LICENSE_PORT || 8787;
const PRODUCT = process.env.LICENSE_PRODUCT || 'webxr-balloon-pcvr';
const KEY_PATH = path.join(__dirname, 'keys', 'private.pem');

// ── 云端内容密钥（AES-256-CBC）：与客户端 contentLoader.js 内置同一把密钥 ──
// 用途：加密「核心关卡配置」经 /api/content 下发，使游戏文件不再明文携带关卡/出怪/敌人数据。
// ⚠ 这是「提高绕过门槛」而非绝对防破解：密钥内置于客户端（混淆后难提取），
//   攻击者需逆向混淆 + 抓包才能把配置本地化；且配置可随时在云端热更新，无需重新分发游戏。
const CONTENT_KEY = Buffer.from('9bc78bbf5e2eca1be52c1f142cf41d7b46d947ea49307a45351c05189c08d074', 'hex');
// 启动时一次性加载关卡配置（由 gen-content.mjs 从 src/content 生成）
let GAME_CONTENT = null;
try { GAME_CONTENT = JSON.parse(fs.readFileSync(path.join(__dirname, 'game-content.json'), 'utf8')); }
catch (e) { console.error('[license-server] 读取 game-content.json 失败，请先运行 `node gen-content.mjs`'); }

let privateKey;
try {
  privateKey = fs.readFileSync(KEY_PATH, 'utf8');
} catch (e) {
  console.error('[license-server] 读取私钥失败：' + KEY_PATH);
  console.error('请先运行 `node genkeys.js` 生成密钥对（私钥会被 .gitignore 忽略，切勿提交）。');
  process.exit(1);
}

// 服务端验签用「公钥」（与私钥同源；RSA verify 用公钥才是正路）。
const PUB_KEY_PATH = path.join(__dirname, 'keys', 'public.pem');
let publicKey;
try { publicKey = fs.readFileSync(PUB_KEY_PATH, 'utf8'); }
catch (e) {
  console.error('[license-server] 读取公钥失败：' + PUB_KEY_PATH);
  process.exit(1);
}

// 固定字段顺序：客户端验签用完全相同的序列化，否则验签不匹配。
function canonicalPayload(obj) {
  return JSON.stringify({
    machineId: obj.machineId,
    product: obj.product,
    issuedAt: obj.issuedAt,
    expiresAt: obj.expiresAt,
  });
}

function sign(payloadStr) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(payloadStr, 'utf8');
  return signer.sign(privateKey, 'base64');
}

function handleActivate(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bad json' }));
    }
    const machineId = parsed.machineId;
    const product = parsed.product;
    if (!machineId || typeof machineId !== 'string' || machineId.length < 8) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid machineId' }));
    }
    if (product && product !== PRODUCT) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unknown product' }));
    }
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 20 * 24 * 3600 * 1000; // 有效期 20 天（自签发时刻起算）；0 = 永久有效
    const payload = { machineId, product: PRODUCT, issuedAt, expiresAt };
    const payloadStr = canonicalPayload(payload);
    const signature = sign(payloadStr);
    const license = Object.assign({}, payload, { signature });
    // 启动器用的 launchToken：原生层验签通过后才把它作为 URL 参数传给 Chrome，
    // 游戏 JS 校验其签名+时效后才放行（无 token 的手动 Chrome 启动会被挡）。
    // 生命周期与 license 一致（同为 expiresAt=20 天），离线启动也够用。
    const tokenPayload = { machineId, iat: issuedAt, exp: expiresAt };
    const tokenPayloadStr = JSON.stringify(tokenPayload);
    const launchToken = Buffer.from(tokenPayloadStr).toString('base64') + '.' + sign(tokenPayloadStr);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ license, launchToken }));
    console.log(`[license-server] 已签发 license+launchToken -> machineId=${machineId} expiresAt=${expiresAt}`);
  });
}

// 校验 license：先用「公钥」验签，再查时效。返回 verdict：
//   'ok' 合法且未过期 | 'forged' 验签失败/缺字段 | 'expired' 签名有效但已过期 | 'bad' 结构非法
function checkLicense(lic) {
  if (!lic || typeof lic !== 'object') return 'bad';
  if (typeof lic.machineId !== 'string' || typeof lic.product !== 'string'
      || typeof lic.issuedAt !== 'number' || typeof lic.expiresAt !== 'number'
      || typeof lic.signature !== 'string') return 'bad';
  const payloadStr = canonicalPayload(lic);
  let sigOk = false;
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(payloadStr, 'utf8');
    sigOk = verifier.verify(publicKey, lic.signature, 'base64');
  } catch { sigOk = false; }
  if (!sigOk) return 'forged';
  if (Date.now() > lic.expiresAt) return 'expired';
  return 'ok';
}

// AES-256-CBC 加密关卡配置：随机 16 字节 IV，返回 { iv, data }（均 base64）。
// 与浏览器端 contentLoader.js（WebCrypto）同算法，密钥 CONTENT_KEY 两侧一致。
function encryptContent(plainObj) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', CONTENT_KEY, iv);
  const enc = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(plainObj), 'utf8')),
    cipher.final(),
  ]);
  return { iv: iv.toString('base64'), data: enc.toString('base64') };
}

// 下发加密核心关卡配置：非法/过期 license 一律不返回配置，使「删授权码」也拿不到关卡数据。
function handleContent(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bad json' }));
    }
    const lic = parsed.license;
    const verdict = checkLicense(lic);
    if (verdict === 'forged' || verdict === 'bad') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid license' }));
    }
    if (verdict === 'expired') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'license expired' }));
    }
    if (!GAME_CONTENT) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'content not ready' }));
    }
    const enc = encryptContent(GAME_CONTENT);
    console.log(`[license-server] 已下发加密关卡配置 -> machineId=${lic.machineId}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content: enc }));
  });
}

const server = http.createServer((req, res) => {
  // 允许游戏页面跨域激活（游戏与激活服务可能不同源）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'POST' && req.url === '/api/activate') return handleActivate(req, res);
  if (req.method === 'POST' && req.url === '/api/content') return handleContent(req, res);
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[license-server] 激活服务已启动 -> http://localhost:${PORT}/api/activate`);
  console.log(`[license-server] PRODUCT=${PRODUCT}  (env LICENSE_PRODUCT 可改；须与客户端一致)`);
});
