'use strict';
/**
 * 一次性生成签发密钥对（Ks / Ks_pub）
 *
 * 用法：
 *   node gen-keys.js            # 若 secrets/ 已存在则拒绝覆盖
 *   node gen-keys.js --force    # 明确要求重新生成（会作废所有已发 license！）
 *
 * 产出：
 *   secrets/license-sign.pem    🔴 Ks 私钥（PKCS#8 PEM，权限 600）—— 绝不能进 git / 绝不能拷进 EXE
 *   secrets/license-pub.pem     🟢 Ks_pub 公钥（SPKI PEM）
 *   secrets/public-key.txt      🟢 供硬编码：SPKI DER 的 base64 单行文本
 *
 * ⚠️ 生成后**立刻离线备份** secrets/license-sign.pem。
 *    丢了 = 所有已发 license 无法续期，只能发新版换公钥（文档 §2 / §12）。
 */
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib/license');

const SECRET_DIR = path.join(__dirname, 'secrets');
const PRIV = path.join(SECRET_DIR, 'license-sign.pem');
const PUB = path.join(SECRET_DIR, 'license-pub.pem');
const PUBTXT = path.join(SECRET_DIR, 'public-key.txt');

const force = process.argv.indexOf('--force') >= 0;

if (fs.existsSync(PRIV) && !force) {
  console.error('[gen-keys] 已存在 ' + PRIV + '，拒绝覆盖（重新生成会作废所有已发 license）。');
  console.error('[gen-keys] 确实要重来请加 --force。');
  process.exit(1);
}

fs.mkdirSync(SECRET_DIR, { recursive: true });

const kp = lib.generateKeyPair();

fs.writeFileSync(PRIV, kp.privatePem, { mode: 0o600 });
fs.writeFileSync(PUB, kp.publicPem, { mode: 0o644 });
fs.writeFileSync(PUBTXT, kp.publicDerB64 + '\n', { mode: 0o644 });

try {
  fs.chmodSync(PRIV, 0o600); // Windows 上是 no-op，Linux 上生效
} catch (e) {
  /* ignore */
}

console.log('=== 签发密钥已生成 ===');
console.log('私钥（仅服务器，务必离线备份）: ' + PRIV);
console.log('公钥 PEM                      : ' + PUB);
console.log('公钥 base64（硬编码进两端）   : ' + PUBTXT);
console.log('');
console.log('--- 下面这行原文填进 cast-pc/main.js 与 MainActivity.java 的 LICENSE_PUBKEY_B64 ---');
console.log(kp.publicDerB64);
console.log('');
console.log('--- 自检：签一份样本再验一遍 ---');
const sample = lib.issueLicense(kp.privateKey, {
  lic: 'SELFTEST-0001',
  cust: 'selftest',
  dev: 'selftest-dev',
  ke: 'selftest-ke',
});
const back = lib.checkLicense(kp.publicDerB64, sample.license);
console.log('样本 license 前 60 字符: ' + sample.license.slice(0, 60) + '…');
console.log('回验结果              : ' + (back.ok ? '✅ 通过（剩余 ' + back.daysLeft + ' 天）' : '❌ ' + back.reason + ' ' + back.detail));
if (!back.ok) process.exit(2);
