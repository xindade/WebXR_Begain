// 生成 RSA-2048 密钥对（激活服务器私钥 + 客户端验签公钥）。
// 运行：node genkeys.js
//
// 输出：
//   keys/private.pem  —— 激活服务器私钥（被 .gitignore 忽略，切勿提交/泄露）
//   keys/public.pem   —— 客户端验签公钥（内容需同步内联到 src/core/license.js 的 PUBLIC_KEY）
//
// ⚠ 重新生成会令所有已签发的 license 失效（旧公钥验不过新私钥签的，反之亦然）。
//   若仅轮换，请妥善保留旧私钥以便过渡，或接受旧 license 全失效。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'keys');
fs.mkdirSync(dir, { recursive: true });

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

fs.writeFileSync(path.join(dir, 'private.pem'), privateKey);
fs.writeFileSync(path.join(dir, 'public.pem'), publicKey);

console.log('RSA-2048 密钥对已生成到 keys/');
console.log('  private.pem  ⚠ 激活服务器私钥，务必保密且不要提交到公开仓库（已被 .gitignore 忽略）');
console.log('  public.pem   → 需将内容同步内联到 src/core/license.js 顶部的 PUBLIC_KEY 常量');
