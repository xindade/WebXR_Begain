#!/usr/bin/env node
'use strict';
/**
 * 「用备份下来的那把生产私钥，在**真 EXE** 上验收一遍」
 * ============================================================================
 * 为什么要有这一关：
 *   `deploy/backup-drill.js` 已经能把 Node 层的事说清楚（私钥能解析、派生公钥 == 两端内置常量、
 *   签样本能验通）。但它验的是**我们自己写的验签代码**。客户机器上真正跑的验签代码是 EXE 里的
 *   `verifyLicenseLocal()` —— 那份代码要不要接受这把私钥签的凭据，只有让真的 Electron 跑一遍才知道。
 *   这一关过了，才敢说「这份备份是能用的备份」。过了的**唯一证据**是：
 *     真 EXE 的启动横幅打出「授权：有效」+ `/api/license/current` 回 `ok:true`。
 *
 * 与 `exe-license-e2e.js` 的区别（别把两者搞混）：
 *   · exe-license-e2e.js 用 **secrets/ 里的测试私钥** ⇒ 生产公钥 ≠ 测试公钥，
 *     所以它必须**临时改 main.js 内置常量**才能测（跑完还原）。
 *   · 本夹具用**生产私钥** ⇒ 它本来就该跟 EXE 内置常量对得上，**一个字都不许改源码**。
 *     所以这里的「main.js md5 全程未变」本身就是一条结论：验收这份私钥不需要动源码。
 *
 * 用法：
 *   node xlang/exe-prodkey-e2e.js --key <私钥.pem> [--exe <electron.exe | 打包好的.exe>]
 *
 * 退出码：0 = 这份私钥能被真 EXE 接受；1 = 不接受（**千万别删服务器上的原件**）；2 = 用法/IO 错；3 = 夹具自身异常。
 *
 * ⚠ 本夹具签出来的是**自测编号**的 license（服务器数据库里没有它），且全程不联网
 *   （--license-url 指向 discard 端口）。它证明的是「私钥 ↔ EXE 的密码学链路通了」，
 *   **不能**替代真实装机激活（那条路要走激活码 + 生产服务器，见 tools/cast-server/README.md §3）。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const L = require('../lib/license');
const H = require('./exe-harness');
const {
  HERE, CASTSERVER, MAIN_JS, ELECTRON, DAY, state, md5, ok, scenario,
  newKe, bakedConst, readPackagedMainJs, noteEnv, makeRunner, dumpResults,
} = H;

const APK_MAIN = path.resolve(CASTSERVER, '..', 'cast-apk',
    'app', 'src', 'main', 'java', 'com', 'local', 'webxrcast', 'MainActivity.java');

const OUT = path.join(HERE, 'out', 'prodkey');
const PORT = 18445;                              // 避开 18443（另一个夹具）与生产 8443
const LICENSE_URL = 'http://127.0.0.1:9';        // discard 端口：证明全程不联网也能验收

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
const argOf = (name) => {
  const hit = argv.find((s) => s.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};
const keyArg = argOf('key') || argv.find((a) => !a.startsWith('--')) || '';
const exeArg = argOf('exe') || ELECTRON;

if (!keyArg) {
  H.die('用法：node xlang/exe-prodkey-e2e.js --key <私钥.pem> [--exe <electron.exe | 打包好的.exe>]');
}

(async function main() {
  console.log('==================================================');
  console.log('生产私钥 · 真 EXE 验收（这一步过了，备份才算备份）');
  console.log('==================================================');
  console.log('  待验收私钥：' + keyArg);
  console.log('  目标 EXE  ：' + exeArg);

  if (!fs.existsSync(exeArg)) H.die('找不到可执行文件：' + exeArg);
  if (!fs.existsSync(MAIN_JS)) H.die('找不到 main.js：' + MAIN_JS);
  noteEnv();

  // ——— [0] 目标 EXE 里到底有没有授权代码 ———
  // 现场教训：`tools/cast-pc/dist/` 里那份安装包内含的 main.js 只有 798 行、连 `license` 字样都没有
  //   （LaunchGuard 时代的旧产物）。拿这种包去验授权，只会得到一堆莫名其妙的红灯，
  //   让人误以为是密钥坏了。所以先静态确认目标里有这套代码，再谈验收。
  const isDev = path.basename(exeArg).toLowerCase() === 'electron.exe';
  console.log('\n[0] 目标自检');
  console.log(`  [i]    目标类型：${isDev ? '开发版 electron.exe（测的就是当前源码）' : '打包产物'}`);
  if (!isDev) {
    const packed = readPackagedMainJs(exeArg);
    if (!packed) {
      ok(false, '能从打包产物里读出它内含的 main.js', '读不出 resources/app.asar —— 包结构异常？');
    } else {
      console.log(`  [i]    包内 main.js：${packed.size} 字节 / md5 ${packed.md5}`);
      const hasLic = packed.text.indexOf('LICENSE_PUBKEY_B64') >= 0;
      ok(hasLic, '★ 这个包里**真的有**授权代码（LICENSE_PUBKEY_B64）',
          hasLic ? '' : '→ 这是**没含授权代码的旧包**，验它毫无意义。先重新打包：cd tools/cast-pc && npm run dist');
      if (!hasLic) { console.log('\n结论：目标 EXE 不含授权代码，无法验收。请先重新打包。'); process.exit(1); }
    }
  }

  // ——— [1] 这份私钥派生出的公钥，是不是 EXE/APK 里硬编码的那把 ———
  console.log('\n[1] 私钥 ↔ 两端内置公钥');
  if (!fs.existsSync(keyArg)) H.die('找不到私钥文件：' + keyArg);
  const raw = fs.readFileSync(keyArg, 'utf8');
  ok(raw.indexOf('-----BEGIN') >= 0, '文件是 PEM 文本',
      raw.length + ' 字节，首行 ' + (raw.split('\n')[0] || '').trim());
  let priv = null;
  try { priv = crypto.createPrivateKey(raw); ok(true, '私钥可被解析（没被截断 / 没被编辑器改坏）'); }
  catch (e) {
    ok(false, '私钥可被解析', e.message);
    console.log('\n结论：这份备份【已是废的】—— 千万别删服务器上的原件，重新备份一次。');
    process.exit(1);
  }
  const spki = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' });
  const derived = spki.toString('base64');
  ok(spki.length === 91, '派生公钥是 P-256 SPKI（91 字节）', '实测 ' + spki.length);
  ok(derived.length === 124, '公钥 base64 长度 124', '实测 ' + derived.length);

  const pcConst = bakedConst(MAIN_JS);
  const apkConst = bakedConst(APK_MAIN);
  ok(!!pcConst.b64 && !!apkConst.b64, '两端源码里都读到了内置公钥',
      path.basename(MAIN_JS) + ' / ' + path.basename(APK_MAIN));
  ok(pcConst.b64 === apkConst.b64, '两端内置公钥逐字一致（不一致说明有一端没重新注入）',
      pcConst.b64 === apkConst.b64 ? '' : 'EXE=' + String(pcConst.b64).slice(0, 24) + '…  APK=' + String(apkConst.b64).slice(0, 24) + '…');
  const match = derived === pcConst.b64;
  ok(match, '★ 这份私钥派生出的公钥 == 两端内置公钥', match ? '' : '衍生=' + derived.slice(0, 24) + '…  内置=' + String(pcConst.b64).slice(0, 24) + '…');
  if (!match) {
    console.log('');
    console.log('  这份私钥签出来的 license，客户机器【一律验不过】。常见原因：');
    console.log('   ① 拷到的是本地开发用的测试密钥（tools/cast-server/secrets/，非生产）；');
    console.log('   ② 拷到的是换密钥之前的旧文件；③ 服务器换过密钥但两端常量没重新注入。');
    console.log('  → 不要拿它当备份，也别删服务器上的原件。');
    process.exit(1);
  }
  // 复核器自检：先证明「我们这把尺子本身是准的」，否则下面复核 EXE 时会把它的沉默当成失败
  {
    const probe = 'cast|selfcheck';
    const sig = L.signText(raw, probe);
    ok(L.verifyText(derived, probe, sig) === true, '复核器自检：本私钥签名 → 该公钥验签通过（尺子准）');
    ok(L.verifyText(derived, probe + 'x', sig) === false, '复核器自检：改一个字符即失败（尺子有分辨力）');
  }

  // ——— [2] 记录 main.js 基线：本夹具**一个字都不该改它** ———
  const origBytes = fs.readFileSync(MAIN_JS);
  const ORIG_MD5 = md5(origBytes);
  console.log(`\n[2] main.js 基线 md5 ${ORIG_MD5}（本夹具全程不改源码，结尾会复核）`);

  // ——— 造两份 license：一份 ke 指向本机、一份指向别台机器 ———
  const mine = newKe();
  const other = newKe();
  const now = Date.now();
  // ⚠ exp 取 14.5 天：两端都用 Math.floor 折算天数，正好 14 天会因毫秒流逝折成 13；
  //   留半天余量后 daysLeft 稳定 14。且 14.5 天 > 3 天续期窗口 ⇒ 走「有效且不联网」分支。
  const exp = now + 14 * DAY + DAY / 2;
  const licOK = L.issueLicense(raw, {              // ke = 本机 → 应放行
    lic: 'L-BACKUP-EXE-01', cust: '备份验收（自测，非真实客户）', dev: 'prodkey-check',
    ke: mine.ke, iat: now, nbf: now - 60000, exp,
    n: 'c0c0c0c0c0c0',
  });
  const licBad = L.issueLicense(raw, {             // ke = 别台机器 → 应被拒
    lic: 'L-BACKUP-EXE-02', cust: '备份验收（自测，非真实客户）', dev: 'prodkey-check',
    ke: other.ke, iat: now, nbf: now - 60000, exp,
    n: 'd0d0d0d0d0d0',
  });

  const run = makeRunner({ outDir: OUT, port: PORT, licenseUrl: LICENSE_URL, exe: exeArg });
  const results = [];

  // ——— [3] 场景 A：真 EXE 应该认这份私钥 ———
  await scenario('[3] 场景 A · 真 EXE 是否接受「生产私钥签的」license', async () => {
    const r = await run('prodkey-match', mine.pem, licOK.license);
    results.push(r);
    ok(r.port > 0, `EXE 起来了（端口 ${r.port}）`, r.log.slice(-900));
    ok(r.api.status === 200, `GET /api/license/current 通了（HTTP ${r.api.status}${r.api.err ? ' / ' + r.api.err : ''}）`);
    ok(/\[cast-pc\] 授权：(有效|即将到期)/.test(r.log), '★ 启动横幅：真 EXE 打出「授权：有效」',
        (r.log.match(/\[cast-pc\][^\n]*授权[^\n]*/g) || []).join(' | '));
    ok(r.log.indexOf('L-BACKUP-EXE-01') >= 0, '启动横幅里是我们给的编号 lic=L-BACKUP-EXE-01');
    ok(/剩余\s*14\s*天/.test(r.log), '启动横幅：剩余 14 天（不联网 / 未进续期窗口）');
    ok(r.json && r.json.ok === true, 'API：ok=true', String(r.json && r.json.why));

    // 独立复核：拿 EXE 吐回来的 license，用**这份私钥派生出的公钥**再验一遍。
    // ⚠ 一定传**字符串** PEM：lib/license.js 的 asPublicKey() 对 Buffer 走 {format:'der'} 分支，
    //   把 PEM 字节当 DER 解析会**静默**返回 false（badSig）—— 那会把 RED 冤枉成 EXE 的错。
    const pubPem = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' }).toString('utf8');
    if (r.json && r.json.ok === true) {
      const b = r.json;
      ok(String(b.license) === String(licOK.license), 'EXE 出示的 license 就是我们喂进去的那份（逐字）');
      const v = L.verifyLicense(pubPem, b.license);
      const pl = (v && v.payload) || {};      // 先兜住：验签失败时 payload 是 undefined
      ok(v.ok === true, '② 用这份私钥派生出的公钥离线验 license 通过', v.ok ? '' : JSON.stringify(v));
      ok(pl.ke === mine.ke, '③ payload.ke == 本机 Ke（头显第 ⑤ 步能验 proof 的前提）');
      const inWin = Number(pl.nbf) - 300000 <= Date.now() && Date.now() - 300000 <= Number(pl.exp);
      ok(inWin, '④ 时间窗有效（nbf ≤ now ≤ exp）');
      const proofOk = (() => {
        try { return crypto.verify('sha256', Buffer.from('cast|' + b.nonce, 'ascii'), mine.pub, L.b64uDecode(b.proof)); }
        catch (e) { return false; }
      })();
      ok(proofOk === true, '⑤ proof = Ke_sign("cast|nonce") 用本机 Ke 公钥验通过');
      ok(!(() => { try { return crypto.verify('sha256', Buffer.from('cast|' + b.nonce, 'ascii'), other.pub, L.b64uDecode(b.proof)); } catch (e) { return false; } })(),
          '⑤b 用「别台机器」Ke 公钥验同一份 proof **必须失败**（排除「随便签的也算过」）');
      ok(b.nonce === r.nonce, '① nonce 原样回显（头显的第一步）');
      ok(Number(b.state && b.state.daysLeft) === 14, `API state.daysLeft=14　实测 ${b.state && b.state.daysLeft}`);
      ok(String(b.state && b.state.lic) === 'L-BACKUP-EXE-01', `API state.lic=L-BACKUP-EXE-01　实测 ${b.state && b.state.lic}`);
      // ⚠ 「授权有效」分支的 state 是**精简版**（只有 lic/cust/exp/daysLeft，main.js L932）——
      //   故意不回本机路径，免得把装机目录顺手透露给头显。所以这里**不能**像「未激活」分支
      //   那样断言 licensePath 存在（踩过：照抄那条断言，结果唯一一个红灯是自己造的）。
      ok(b.state && b.state.licensePath === undefined,
          '「有效」分支不回本机路径字段（设计如此：不向头显泄漏装机目录）',
          `实测 keys=${Object.keys(b.state || {}).join(',')}`);
      // 隔离性改用**反向证据**：你真实安装的 userData 里不该出现本次自测编号。
      // 开发模式（electron.exe <项目目录>）的 userData = %APPDATA%\webxr-cast-pc。
      const realUd = path.join(process.env.APPDATA || '', 'webxr-cast-pc');
      let realLic = '';
      try { realLic = fs.readFileSync(path.join(realUd, 'license.json'), 'utf8'); } catch (e) { /* 没激活过就没这个文件 */ }
      ok(realLic.indexOf('L-BACKUP-EXE-01') < 0,
          '真实安装的 userData 目录没被写入（本次全部落在临时目录）', `检查了 ${realUd}\\license.json`);
    }
  });

  // ——— [4] 场景 B：ke 绑定这条分支必须还活着 ———
  // 只验「能过」是不够的：如果 ke 绑定被谁改坏了，过与不过都变成「过」，
  // 而后果是「license 可以连密钥文件一起拷到别的机器上复用」。
  await scenario('[4] 场景 B · license 属于别台机器时必须被拒（ke 绑定仍生效）', async () => {
    const r = await run('prodkey-mismatch', mine.pem, licBad.license);
    results.push(r);
    ok(r.port > 0, `EXE 起来了（端口 ${r.port}）`, r.log.slice(-900));
    ok(r.api.status === 200, `GET /api/license/current 通了（HTTP ${r.api.status}${r.api.err ? ' / ' + r.api.err : ''}）`);
    ok(r.log.indexOf('⚠ 授权不可用：license 属于另一台机器（ke 不匹配）') >= 0,
        '启动横幅：明说 ke 不匹配、要求重新激活',
        (r.log.match(/\[cast-pc\][^\n]*授权[^\n]*/g) || []).join(' | '));
    ok(r.json && r.json.ok === false, 'API：ok=false（**没把 license 发给头显**）');
    ok(r.json && /属于另一台机器/.test(String(r.json.why)), `API：why 明说是 ke 不匹配　实测「${r.json && r.json.why}」`);
    ok(r.json && r.json.license === undefined, 'API：响应体里没有 license 字段');
  });

  // ——— [5] 收尾 ———
  console.log('\n[5] 收尾复核');
  const backMd5 = md5(fs.readFileSync(MAIN_JS));
  ok(backMd5 === ORIG_MD5, `★ 全程未改动 main.js（md5 ${backMd5}）—— 验收这份私钥不需要动源码`,
      `原 ${ORIG_MD5} 现 ${backMd5}`);
  dumpResults(OUT, results);

  console.log('\n==================================================');
  if (state.FAIL === 0) {
    console.log('结论：[OK] 这份备份可以信 —— 真 EXE 认它签出来的凭据。');
    console.log('      建议：把它 + 本报告一起归档，并存第二份到**另一个物理位置**（单份不算备份）。');
  } else {
    console.log(`结论：[FAIL] 有 ${state.FAIL} 项未通过 —— 先别删服务器上的原件，按上面红灯逐条查。`);
  }
  console.log('  注：本次签的是**自测编号**的 license（服务器数据库里没有它），且全程不联网；');
  console.log('      它证明的是「私钥 ↔ 真 EXE 的密码学链路」，**不替代**真实装机激活（激活码 + 生产服务器）。');
  console.log('==================================================');
  process.exit(state.FAIL === 0 ? 0 : 1);
})().catch((e) => {
  console.error('[!] 夹具自身异常：' + ((e && e.stack) || e));
  process.exit(3);
});
