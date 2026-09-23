#!/usr/bin/env node
'use strict';
/**
 * P3 · EXE 侧授权门禁「实跑」端到端夹具
 * ============================================================================
 * 为什么必须实跑而不是读代码：
 *   本轮给 `verifyLicenseLocal()` 新加了「ke 必须等于本机 Ke」这条分支（main.js L727~742）。
 *   这条分支的**误判后果是「所有真实客户被锁死」** —— 代码看着对没用，必须让真的 Electron
 *   去读真的 `userData/license.json`，看三条分支各走哪一条。
 *
 * 复现的坑（写死在注释里，免得下次再踩；完整记录见 skill 的「Gotcha 30」的 ①⑤⑥）：
 *   ① 环境里若有 `ELECTRON_RUN_AS_NODE=1`（node 沙箱常设），electron.exe 会**退化成纯 Node** ——
 *      现象是 `require('electron').app` 为 undefined、栈里出现 `node:internal/modules/run_main`，
 *      看着完全像「代码写坏了」。必须在 spawn 的 env 里 delete 掉。
 *   ② 换 userData 目录**必须用 `--user-data-dir=<目录>`** —— 覆盖 `APPDATA` 对 Electron **无效**
 *      （上一轮就栽在这里：三个场景日志一模一样，等于什么都没测到）。
 *   ③ 对端是**纯 HTTP**（`http.createServer`），用 https 探它只会得到 `SSL: WRONG_VERSION_NUMBER`。
 *
 * 夹具自身纪律（对齐 skill 约束 80~86）：
 *   ① 必须打真身：改的是 `tools/cast-pc/main.js` 本体（不是某个「粘贴版」），跑完**逐字节还原**并断言 md5（约束 86）；
 *   ② 改完要断言**只替换了 1 处**，防止正则误伤别的地方；
 *   ③ 结论由**另一套独立实现**再算一遍：拿 EXE 返回的 license+proof，用 `lib/license.js`
 *      （Node 侧原语）把**头显那一整套 P3 判定链**离线重放一遍 —— 这才证明 EXE 吐出的材料
 *      真的能被头显接受，而不是「EXE 自己说有效」；且复核器**先自检**（约束 85）；
 *   ④ 每个场景单独 try/catch，不让前一个场景的异常吞掉后面的场景（约束 85）；
 *   ⑤ 不许碰真实用户目录：全部走 `--user-data-dir` + 独立端口。
 *
 * 用法：node xlang/exe-license-e2e.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const L = require('../lib/license');
// 启动真 EXE 的公共底座（三个环境坑写在那里，别再在这份文件里重复实现）
const H = require('./exe-harness');
const {
  HERE, CASTSERVER, MAIN_JS, ELECTRON, md5, ok, scenario, state,
  newKe, makeRunner, noteEnv, dumpResults,
} = H;

const OUT = path.join(HERE, 'out', 'e2e');
// 本夹具用**测试**密钥，所以下面要临时改 main.js 内置公钥；跑场景用这个绑好的 runner
const run = makeRunner({
  outDir: OUT,
  port: 18443,                              // 刻意避开生产 8443，防止撞上正在跑的 EXE
  licenseUrl: 'http://127.0.0.1:9',          // 指向 discard 端口：就算真联网也打不到生产服务器
});

// ————————————————————————————————————————————————————————————————
// 1. 测试用签发密钥 Ks（与生产那对**不同**，所以必须临时改 EXE 内置常量）
// ————————————————————————————————————————————————————————————————
function loadTestKs() {
  const pubPem = fs.readFileSync(path.join(CASTSERVER, 'secrets', 'license-pub.pem'));
  const privPem = fs.readFileSync(path.join(CASTSERVER, 'secrets', 'license-sign.pem'));
  const key = crypto.createPublicKey(pubPem);
  const spki = key.export({ type: 'spki', format: 'der' });
  const b64 = spki.toString('base64');          // 标准 base64 **带填充**，与生产常量同格式
  const declared = fs.readFileSync(path.join(CASTSERVER, 'secrets', 'public-key.txt'), 'utf8').trim();
  // ⚠ 交 `lib/license.js` 用的一定要是**字符串** PEM：
  //   它的 asPublicKey() 对 Buffer 走的是 `{format:'der'}` 分支（L67）—— 传 PEM 字节进去会被当 DER 解析，
  //   结果是**静默验签失败**（reason=badSig），看起来像「EXE 签错了」，其实是复核器被喂错了格式。
  return { pubPem: pubPem.toString('utf8'), privPem, b64, declared, spki };
}

// ————————————————————————————————————————————————————————————————
// 2. 本机 Ke / 别台机器 Ke  → 已移到 exe-harness.js 的 newKe()
// 3. 启动真 EXE / 探测接口 / 场景包装  → 已移到 exe-harness.js
// ————————————————————————————————————————————————————————————————

// ————————————————————————————————————————————————————————————————
// 4. 主流程
// ————————————————————————————————————————————————————————————————
(async function main() {
  console.log('==================================================');
  console.log('P3 · EXE 授权门禁实跑夹具（ke 绑定分支）');
  console.log('==================================================');

  if (!fs.existsSync(ELECTRON)) { console.error('[!] 找不到 electron.exe：' + ELECTRON); process.exit(2); }
  if (!fs.existsSync(MAIN_JS)) { console.error('[!] 找不到 main.js：' + MAIN_JS); process.exit(2); }
  noteEnv();

  const ks = loadTestKs();
  console.log('\n[1] 测试签发密钥 Ks');
  ok(ks.b64 === ks.declared, `Ks_pub 与 secrets/public-key.txt 声明值逐字一致（${ks.b64.length} 字符）`,
      `实测 ${ks.b64}\n         声明 ${ks.declared}`);
  console.log(`  [i]    DER ${ks.spki.length} 字节（P-256 SPKI 应为 91）`);
  // 复核器自检：先证明「我们这把尺子本身是准的」，否则复核器一坏就会把 EXE 冤枉成 badSig
  {
    const probe = 'cast|selfcheck';
    const sig = L.signText(ks.privPem, probe);
    ok(L.verifyText(ks.pubPem, probe, sig) === true, '复核器自检：Ks 签名 → Ks_pub 验签通过（尺子准）');
    ok(L.verifyText(ks.pubPem, probe + 'x', sig) === false, '复核器自检：改一个字符即验签失败（尺子有分辨力）');
  }

  const mine = newKe();
  const other = newKe();
  console.log('\n[2] 两台机器的 Ke');
  ok(mine.ke !== other.ke, '本机 Ke ≠ 别台机器 Ke（能区分开才测得出绑定）');
  const hasUrlChar = (s) => s.indexOf('-') >= 0 || s.indexOf('_') >= 0;
  console.log(`  [i]    本机 ke 长度 ${mine.ke.length}，含 -/_ ? ${hasUrlChar(mine.ke)}`);

  const DAY = 86400000;
  const now = Date.now();
  // ⚠ exp 取 9.5 天后：两端都用 Math.floor 折算天数，若正好 9 天会因毫秒流逝被折成 8，
  //   断言就变成「时快时慢地失败」。留半天余量后 daysLeft 稳定为 9。
  //   同时 9.5 天 > 3 天续期窗口 ⇒ EXE 走「有效且不联网」分支（夹具不打生产服务器）。
  const exp = now + 9 * DAY + DAY / 2;
  const licA = L.issueLicense(ks.privPem, {           // ke = 本机 → 应放行
    lic: 'L-SELFTEST-01', cust: '夹具客户 A', dev: 'self-test-dev',
    ke: mine.ke, iat: now, nbf: now - 60000, exp,
    n: 'aaaaaaaaaaaa',
  });
  const licB = L.issueLicense(ks.privPem, {           // ke = 别台机器 → 应被 ke 绑定拒
    lic: 'L-SELFTEST-02', cust: '夹具客户 B', dev: 'self-test-dev',
    ke: other.ke, iat: now, nbf: now - 60000, exp,
    n: 'bbbbbbbbbbbb',
  });

  // —— 打补丁：把 main.js 内置的**生产** Ks_pub 临时换成测试 Ks_pub ——
  const origBytes = fs.readFileSync(MAIN_JS);
  const ORIG_MD5 = md5(origBytes);
  console.log(`\n[3] 临时替换 main.js 内置公钥（原 md5 ${ORIG_MD5}）`);
  const origText = origBytes.toString('utf8');
  const patched = origText.replace(
      /(LICENSE_PUBKEY_B64\s*=\s*')([^']*)(')/,
      (_m, a, _old, c) => a + ks.b64 + c);
  const nReplace = (origText.match(/LICENSE_PUBKEY_B64\s*=\s*'[^']*'/g) || []).length;
  ok(nReplace === 1, `main.js 里 LICENSE_PUBKEY_B64 出现 1 次（实测 ${nReplace}）`);
  ok(patched !== origText, '正则确实替换到了内容（否则下面跑的还是生产公钥，等于没测）');
  fs.writeFileSync(MAIN_JS, patched, 'utf8');
  const PATCHED_MD5 = md5(fs.readFileSync(MAIN_JS));
  ok(PATCHED_MD5 !== ORIG_MD5, '补丁已生效（md5 变了）');

  const results = [];
  try {
    // ——— 场景 1：没有 license.json ———
    await scenario('[4] 场景 1 · fresh —— 无 license.json', async () => {
      const r = await run('fresh', mine.pem, null);
      results.push(r);
      ok(r.port > 0, `EXE 起来了（端口 ${r.port}）`, r.log.slice(-800));
      ok(r.api.status === 200, `GET /api/license/current 通了（HTTP ${r.api.status}${r.api.err ? ' / ' + r.api.err : ''}）`);
      ok(r.log.indexOf('⚠ 授权：**未激活**') >= 0, '启动横幅：⚠ 授权：**未激活**');
      ok(/licensePath\s*=\s*/.test(JSON.stringify(r.json || {})) || (r.json && r.json.state), '/api/license/current 回了 state（带真实路径）');
      const realUd = r.json && r.json.state ? String(r.json.state.licensePath) : '';
      ok(realUd.toLowerCase().indexOf(path.join('out', 'e2e', 'fresh').toLowerCase()) >= 0,
          'EXE 读的确实是本次 --user-data-dir（没碰真实用户目录）', `实测 licensePath=${realUd}`);
      ok(r.json && r.json.ok === false, 'API：ok=false');
      ok(r.json && r.json.why === '未激活（无 license）', `API：why=未激活（无 license）　实测「${r.json && r.json.why}」`);
    });

    // ——— 场景 2：license 的 ke = 本机 Ke ———
    await scenario('[5] 场景 2 · ke-match —— license 属于本机', async () => {
      const r = await run('ke-match', mine.pem, licA.license);
      results.push(r);
      ok(r.port > 0, `EXE 起来了（端口 ${r.port}）`, r.log.slice(-800));
      ok(r.api.status === 200, `GET /api/license/current 通了（HTTP ${r.api.status}${r.api.err ? ' / ' + r.api.err : ''}）`);
      ok(/授权：(有效|即将到期)/.test(r.log), '启动横幅：授权有效');
      ok(r.log.indexOf('L-SELFTEST-01') >= 0, '启动横幅：lic=L-SELFTEST-01');
      ok(/剩余\s*9\s*天/.test(r.log), '启动横幅：剩余 9 天（不联网，未进续期窗口）',
          (r.log.match(/\[cast-pc\] 授权[^\n]*/g) || []).join(' | '));
      ok(r.json && r.json.ok === true, 'API：ok=true', JSON.stringify(r.json && r.json.why));
      // ★ 独立重放「头显那一整套 P3 判定链」，证明材料真能被头显接受
      if (r.json && r.json.ok === true) {
        const b = r.json;
        ok(b.nonce === r.nonce, '① nonce 原样回显（头显的第一步）', `回显 ${b.nonce} / 发出 ${r.nonce}`);
        const v = L.verifyLicense(ks.pubPem, b.license);
        const pl = (v && v.payload) || {};        // ⚠ 先兜住：验签失败时 payload 是 undefined，
                                                  //   直接取 .nbf 会抛异常 ⇒ 后面的场景被整段跳过
        ok(v.ok === true, '② 用 Ks_pub 离线验 license 签名通过', v.ok ? '' : JSON.stringify(v));
        ok(pl.ke === mine.ke, '③ payload.ke 就是本机 Ke（第 ⑤ 步能验 proof 的前提）');
        const nowMs = Date.now();
        const inWin = Number(pl.nbf) - 300000 <= nowMs && nowMs - 300000 <= Number(pl.exp);
        ok(inWin, '④ 时间窗有效（nbf ≤ now ≤ exp）');
        const proofOk = (() => {
          try {
            return crypto.verify('sha256', Buffer.from('cast|' + b.nonce, 'ascii'), mine.pub, L.b64uDecode(b.proof));
          } catch (e) { return false; }
        })();
        ok(proofOk === true, '⑤ proof = Ke_sign("cast|nonce") 用 Ke 公钥验通过（反过来了：假 EXE 过不了这步）');
        ok(!(() => { try { return crypto.verify('sha256', Buffer.from('cast|' + b.nonce, 'ascii'), other.pub, L.b64uDecode(b.proof)); } catch (e) { return false; } })(),
            '⑤b 用「别台机器」的 Ke 公钥验同一份 proof **必须失败**（排除「随便签的也算过」）');
        const p2 = crypto.verify('sha256', Buffer.from('cast|' + '0'.repeat(32), 'ascii'), mine.pub, L.b64uDecode(b.proof));
        ok(p2 === false, '⑤c proof 绑定了当场 nonce（换 nonce 重放即失效）');
        ok(Number(b.state && b.state.daysLeft) === 9, `API state.daysLeft=9　实测 ${b.state && b.state.daysLeft}`);
        ok(String(b.state && b.state.lic) === 'L-SELFTEST-01', `API state.lic=L-SELFTEST-01　实测 ${b.state && b.state.lic}`);
      }
    });

    // ——— 场景 3：license 的 ke = 别台机器 Ke ———
    await scenario('[6] 场景 3 · ke-mismatch —— license 属于另一台机器（本轮新增分支）', async () => {
      const r = await run('ke-mismatch', mine.pem, licB.license);
      results.push(r);
      ok(r.port > 0, `EXE 起来了（端口 ${r.port}）`, r.log.slice(-800));
      ok(r.api.status === 200, `GET /api/license/current 通了（HTTP ${r.api.status}${r.api.err ? ' / ' + r.api.err : ''}）`);
      ok(r.log.indexOf('⚠ 授权不可用：license 属于另一台机器（ke 不匹配）→ 请在本机重新激活') >= 0,
          '启动横幅：⚠ 授权不可用：license 属于另一台机器（ke 不匹配）→ 请在本机重新激活',
          (r.log.match(/\[cast-pc\] [^\n]*授权[^\n]*/g) || []).join(' | '));
      ok(r.json && r.json.ok === false, 'API：ok=false（**没把 license 发给头显**）');
      ok(r.json && /属于另一台机器/.test(String(r.json.why)),
          `API：why 明说是 ke 不匹配　实测「${r.json && r.json.why}」`);
      ok(r.json && r.json.license === undefined, 'API：响应体里没有 license 字段（不泄漏无关凭据）');
    });
  } finally {
    // —— 无条件还原 main.js 并断言 md5 ——
    console.log('\n[7] 还原 main.js');
    fs.writeFileSync(MAIN_JS, origBytes);
    const back = md5(fs.readFileSync(MAIN_JS));
    ok(back === ORIG_MD5, `main.js 已逐字节还原（md5 ${back}）`, `原 ${ORIG_MD5}`);
  }

  console.log('\n==================================================');
  console.log(state.FAIL === 0 ? `全部通过（3 个场景）` : `有 ${state.FAIL} 项失败`);
  console.log('==================================================');
  // 留个日志快照，便于现场对不上时回看
  dumpResults(OUT, results);
  process.exit(state.FAIL === 0 ? 0 : 1);
})().catch((e) => {
  console.error('[!] 夹具自身异常：' + (e && e.stack || e));
  process.exit(3);
});
