'use strict';
/**
 * 跨语言验签对照工具 · Node 侧（生成样本）
 *
 *   cd tools/cast-server && node xlang/gen.js
 *
 * 输出到本目录：license.txt / pubkey.txt / license_tampered.txt / license_tampered_sig.txt
 * 然后用同目录的 VerifyLicense.java 按「头显 APK 的方式」验一遍。
 *
 * ⚠️ 为什么要有这个工具：
 *   两端签名算法一旦对不齐，现象只有一个 —— 「永远验不过」。
 *   而 ECDSA 每次签名的随机 k 不同，签名字节每次都变，
 *   **没法用固定样本比对**，所以必须靠这种「签一份真样本再跨语言验」的方式定位。
 *   改任何签名相关代码后都跑一次。
 */
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../lib/license');

const SEC = path.join(__dirname, '..', 'secrets');
const OUT = __dirname;

const privPath = path.join(SEC, 'license-sign.pem');
if (!fs.existsSync(privPath)) {
  console.error('找不到 ' + privPath + '，请先在 tools/cast-server 下执行：node gen-keys.js');
  process.exit(1);
}
const priv = fs.readFileSync(privPath);
const pub = fs.readFileSync(path.join(SEC, 'public-key.txt'), 'utf8').trim();

const { license, payload } = lib.issueLicense(priv, {
  lic: 'L20260920-0001',
  cust: 'AcmeArcade-SH-01',
  dev: '9f2c1e4ad3b7',
  ke: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-probe-ke',
  iat: 1789890000000,
  nbf: 1789890000000,
  exp: 1791186000000,
  n: 'b7d41c93',
});

const dot = license.indexOf('.');
const body = license.slice(0, dot);
const sig = license.slice(dot + 1);

// 篡改①：改 payload 文本中一位（签名不变）→ 必须验不过
// 注意不能去 replace 明文（如 'AcmeArcade'）—— license 是 base64url，明文根本不在里面
const at = 5;
const flipped = body.slice(0, at) + (body[at] === 'A' ? 'B' : 'A') + body.slice(at + 1);
// 篡改②：改签名末位 → 必须验不过
const sigFlipped = sig.slice(0, -1) + (sig.slice(-1) === 'A' ? 'B' : 'A');

fs.writeFileSync(path.join(OUT, 'license.txt'), license);
fs.writeFileSync(path.join(OUT, 'pubkey.txt'), pub);
fs.writeFileSync(path.join(OUT, 'license_tampered.txt'), flipped + '.' + sig);
fs.writeFileSync(path.join(OUT, 'license_tampered_sig.txt'), body + '.' + sigFlipped);

const back = lib.checkLicense(pub, license);
console.log('payload        =', JSON.stringify(payload));
console.log('license 长度   =', license.length, '| 带填充?', license.indexOf('=') >= 0);
console.log('base64url 字符 =', /[-_]/.test(license), '| 含 + / ?', /[+/]/.test(license));
console.log('篡改① 位置     =', body[at], '->', flipped[at]);
console.log('');
console.log('Node 自验 正常        =', back.ok ? 'OK（剩余 ' + back.daysLeft + ' 天）' : 'FAIL ' + back.reason);
console.log('Node 自验 篡改 payload=', lib.checkLicense(pub, flipped + '.' + sig).ok ? '❌ 竟然通过' : '✅ 已拒绝');
console.log('Node 自验 篡改 签名   =', lib.checkLicense(pub, body + '.' + sigFlipped).ok ? '❌ 竟然通过' : '✅ 已拒绝');
console.log('');
console.log('样本已写入 ' + OUT);
console.log('接着跑：cd xlang && java -Dfile.encoding=UTF-8 VerifyLicense.java');
