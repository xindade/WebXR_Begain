'use strict';
/**
 * 备份演练 —— 证明「刚备份下来的那把私钥」真的能用，而且**就是服务器上正在用的那一把**。
 *
 * 为什么必须演练：
 *   备份文件看起来永远是对的 —— 它就是一段文本。拷坏了、拷的是本地测试密钥、
 *   拷的是已经换掉的旧密钥，**肉眼完全看不出来**。等真出事（服务器没了 / 磁盘挂了）才发现
 *   备份打不开或签出来的 license 两端不认，那时已经无法补救。
 *   所以：签一份样本 license，用**两端源码里硬编码的那串公钥**去验。
 *   验过了 = 这把私钥能签出客户机器认的凭据；验不过 = 这份备份是废的。
 *
 * 用法：
 *   node deploy/backup-drill.js <私钥.pem>
 *       期望公钥自动取 `tools/cast-pc/main.js` 与 `tools/cast-apk/.../MainActivity.java`
 *       里的 LICENSE_PUBKEY_B64（并会断言两端一致）。
 *   node deploy/backup-drill.js <私钥.pem> --expect-file <public-key.txt>
 *   node deploy/backup-drill.js <私钥.pem> --expect <base64>
 *
 * 退出码：0 = 备份可用，可以拿去存档；1 = 备份不可用（**千万别删服务器上的原件**）；2 = 用法/IO 错。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LIB = require('../lib/license');

const CS_ROOT = path.join(__dirname, '..');
const PC_MAIN = path.join(CS_ROOT, '..', 'cast-pc', 'main.js');
const APK_MAIN = path.join(CS_ROOT, '..', 'cast-apk',
    'app', 'src', 'main', 'java', 'com', 'local', 'webxrcast', 'MainActivity.java');

const DAY = 86400000;
let FAIL = 0;

function ok(cond, label, detail) {
  if (!cond) FAIL++;
  console.log((cond ? '[OK]   ' : '[FAIL] ') + label + (detail ? '  —— ' + detail : ''));
}
function die(msg) { console.error('[fatal] ' + msg); process.exit(2); }

/** 从源码里抠出内置公钥常量（EXE 用单引号，Java 用双引号） */
function bakedConst(file) {
  if (!fs.existsSync(file)) return { file, b64: null, why: '文件不存在' };
  const m = fs.readFileSync(file, 'utf8').match(/LICENSE_PUBKEY_B64\s*=\s*["']([^"']*)["']/);
  if (!m) return { file, b64: null, why: '没匹配到 LICENSE_PUBKEY_B64' };
  return { file, b64: m[1], why: '' };
}

/** 与 server.js /api/pubkey 同口径的指纹：PEM 文本（64 列换行 + 结尾换行）的 sha256 前 24 位 */
function fingerprintOf(keyB64) {
  const b64 = Buffer.from(keyB64, 'base64').toString('base64');
  const pem = '-----BEGIN PUBLIC KEY-----\n'
      + (b64.match(/.{1,64}/g) || []).join('\n')
      + '\n-----END PUBLIC KEY-----\n';
  return {
    pem,
    fp: crypto.createHash('sha256').update(pem, 'utf8').digest('hex').slice(0, 24),
    derSha256: crypto.createHash('sha256').update(Buffer.from(keyB64, 'base64')).digest('hex'),
  };
}

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
const keyArg = argv.find((a) => !a.startsWith('--'));
let expect = '';
const iExp = argv.indexOf('--expect');
const iFile = argv.indexOf('--expect-file');
if (iExp >= 0) {
  expect = String(argv[iExp + 1] || '').trim();
} else if (iFile >= 0) {
  const f = argv[iFile + 1];
  if (!f || !fs.existsSync(f)) die('--expect-file 指向的文件不存在：' + f);
  expect = fs.readFileSync(f, 'utf8').trim();
}
if (!keyArg) {
  die('用法：node deploy/backup-drill.js <私钥.pem> [--expect <base64> | --expect-file <public-key.txt>]');
}

console.log('=== 私钥备份演练 ===');
console.log('  待验私钥：' + keyArg);

// ---------------------------------------------------------------- 1. 能不能读出来
if (!fs.existsSync(keyArg)) die('找不到文件：' + keyArg);
const raw = fs.readFileSync(keyArg, 'utf8');
ok(raw.indexOf('-----BEGIN') >= 0, '文件是 PEM 文本',
    raw.length + ' 字节，首行 ' + (raw.split('\n')[0] || '').trim());

let priv = null;
try {
  priv = crypto.createPrivateKey(raw);
  ok(true, '私钥可被解析（说明文件没被截断 / 没被编辑器改坏）');
} catch (e) {
  ok(false, '私钥可被解析', e.message);
  console.log('\n结论：这份备份【已是废的】—— 千万不要删服务器上的原件，重新备份一次。');
  process.exit(1);
}

// ---------------------------------------------------------------- 2. 期望公钥
if (!expect) {
  const a = bakedConst(PC_MAIN);
  const b = bakedConst(APK_MAIN);
  ok(!!a.b64 && !!b.b64, '两端源码里都读到了内置公钥',
      path.basename(PC_MAIN) + ' / ' + path.basename(APK_MAIN));
  if (a.b64 && b.b64) {
    ok(a.b64 === b.b64, '两端内置公钥逐字一致',
        a.b64 === b.b64 ? '' : 'EXE=' + a.b64.slice(0, 24) + '…  APK=' + b.b64.slice(0, 24) + '…');
  }
  expect = a.b64 || b.b64 || '';
  if (!expect) die('拿不到期望公钥，请显式给 --expect / --expect-file');
  console.log('  期望公钥：取自两端源码内置常量');
} else {
  console.log('  期望公钥：由 --expect / --expect-file 指定');
}

// ---------------------------------------------------------------- 3. 核心：这把私钥派生出的公钥对不对
const derived = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64');
const derLen = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).length;
ok(derLen === 91, '派生公钥是 P-256 SPKI（91 字节）', '实测 ' + derLen);
ok(derived.length === 124, '公钥 base64 长度 124', '实测 ' + derived.length);

const match = derived === expect;
ok(match, '★ 备份私钥派生出的公钥 == 两端内置公钥',
    match ? '' : '派生=' + derived.slice(0, 24) + '…  期望=' + expect.slice(0, 24) + '…');
if (!match) {
  console.log('');
  console.log('  这份备份签出来的 license，客户机器【一律验不过】。三种常见原因：');
  console.log('   ① 拷到的是本地开发用的【测试密钥】（tools/cast-server/secrets/，非生产）；');
  console.log('   ② 拷到的是【换过密钥之前】的旧文件；');
  console.log('   ③ 服务器上换过密钥，但两端源码里的 LICENSE_PUBKEY_B64 没重新注入。');
  console.log('  → 不要拿它当备份。请确认服务器 /opt/webvr123/secrets/ 里的原件，重新拷一份。');
  process.exit(1);
}

// ---------------------------------------------------------------- 4. 真的签一份，再用这把公钥验回来
const now = Date.now();
const sample = LIB.issueLicense(priv, {
  lic: 'BACKUP-DRILL', cust: '备份演练（非真实客户）', dev: 'backup-drill',
  ke: 'backup-drill-ke', iat: now, nbf: now - 60000, exp: now + 10 * DAY,
  n: 'd0d0d0d0d0d0',
});
const back = LIB.checkLicense(expect, sample.license);
ok(back.ok === true, '★ 用备份私钥签的样本 license 能被两端内置公钥验通过',
    back.ok ? ('剩余 ' + back.daysLeft + ' 天') : JSON.stringify(back));

// 负例：证明上面这条不是「验签器空转、永远返回真」
const dot = sample.license.indexOf('.');
const body = sample.license.slice(0, dot);
const mid = Math.floor(body.length / 2);
const swapped = body[mid] === 'A' ? 'B' : 'A';
const tampered = body.slice(0, mid) + swapped + body.slice(mid + 1) + sample.license.slice(dot);
const backBad = LIB.verifyLicense(expect, tampered);
ok(backBad.ok === false, '负例：改动 1 个字符后必须验不过（证明验签没空转）',
    backBad.ok ? '居然通过了 —— 验签逻辑有问题！' : '已按预期拒绝（' + backBad.reason + '）');

// ---------------------------------------------------------------- 5. 指纹（抄下来存档用）
const fp = fingerprintOf(expect);
console.log('');
console.log('--- 存档信息（抄进密码本 / 与 https://webvr123.site/api/pubkey 的 fingerprint 对照）---');
console.log('  公钥指纹    ' + fp.fp);
console.log('  DER sha256  ' + fp.derSha256);
console.log('  公钥 base64 ' + expect);
console.log('');

if (FAIL) {
  console.log('结论：[FAIL] ' + FAIL + ' 项未通过 —— 这份备份不可靠。');
  process.exit(1);
}
console.log('结论：[OK] 备份可用 —— 这把私钥能签出客户机器认的凭据，可以存档。');
console.log('      别忘了再存第二份到【另一个物理位置】（另一支 U 盘 / 保险柜），单份不算备份。');
