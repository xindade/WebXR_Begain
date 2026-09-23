'use strict';
/**
 * 全链路自测（本地起服务 → 走真实 HTTP）
 *
 *   node selftest.js
 *
 * 覆盖：激活 / 幂等 / 错误码 / 续期 + proof 验签 / 时间偏差 / 换机 / 吊销 / 鉴权 / 存储降级
 */
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const lib = require('./lib/license');
const db = require('./lib/db');

const PORT = 18787;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = path.join(os.tmpdir(), 'cast-selftest-' + Date.now());
const USER = 'admin';
const PASS = 'selftest-pass';
const AUTH = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  \u2705 ' + name);
  } else {
    fail++;
    console.log('  \u274c ' + name + (extra !== undefined ? '  | ' + JSON.stringify(extra) : ''));
  }
}

async function req(p, opts) {
  const o = Object.assign({}, opts || {});
  o.headers = Object.assign({}, o.headers || {});
  if (o.json !== undefined) {
    o.method = o.method || 'POST';
    o.headers['content-type'] = 'application/json';
    o.body = JSON.stringify(o.json);
    delete o.json;
  }
  if (o.admin) o.headers.authorization = AUTH;
  delete o.admin;
  const r = await fetch(BASE + p, o);
  // 先读文本再解析：401 等非 JSON 响应也能安全落地
  const txt = await r.text();
  let body;
  try {
    body = JSON.parse(txt);
  } catch (e) {
    body = { _raw: txt };
  }
  return { status: r.status, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pubB64 = fs.readFileSync(path.join(__dirname, 'secrets/public-key.txt'), 'utf8').trim();
  const ke = lib.generateKeyPair(); // 模拟 EXE 实例密钥
  const dev = 'dev-' + require('node:crypto').randomBytes(6).toString('hex');

  console.log('== 存储后端单独验证 ==');
  {
    const jdir = path.join(DATA, 'jsoncheck');
    const js = db.open(jdir, false);
    js.licenses.put({ lic: 'X1', cust: 'c', dev: 'd', ke: 'k', iat: 1, nbf: 1, exp: 2, created_at: 1 });
    ok('JSON 后端读写', js.licenses.get('X1') && js.licenses.get('X1').cust === 'c');
    js.licenses.setRevoked('X1', true, 'test', 5);
    ok('JSON 后端吊销', js.licenses.revokedList().length === 1);
    ok('JSON 后端落盘', fs.existsSync(path.join(jdir, 'license.json')));
    js.close();
  }

  console.log('\n== 启动服务 ==');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', ADMIN_USER: USER, ADMIN_PASS: PASS, DATA_DIR: DATA,
    }),
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));

  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const h = await req('/api/health');
      if (h.status === 200) {
        ready = true;
        console.log('  存储后端 = ' + h.body.store + ' | Node ' + h.body.node);
        break;
      }
    } catch (e) {
      /* retry */
    }
    await sleep(150);
  }
  if (!ready) {
    console.log('  \u274c 服务未就绪');
    console.log(out);
    child.kill();
    process.exit(1);
  }
  ok('健康检查', true);

  try {
    console.log('\n== 鉴权 ==');
    ok('无凭证访问 admin 路由 = 401', (await req('/api/admin/licenses')).status === 401);
    ok('错误密码 = 401', (await req('/api/admin/licenses', { admin: false, headers: { authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') } })).status === 401);
    ok('正确凭证 = 200', (await req('/api/admin/licenses', { admin: true })).status === 200);
    const pg = await req('/admin', { admin: true });
    ok('管理后台页面可访问', pg.status === 200 && String((pg.body && pg.body._raw) || '').indexOf('授权管理后台') >= 0, pg.status);
    ok('管理后台无凭证 = 401', (await req('/admin')).status === 401);
    ok('未知路由 = 404', (await req('/nope')).status === 404);

    console.log('\n== 激活码 ==');
    const gen = await req('/api/admin/activation', { admin: true, json: { cust: 'AcmeArcade-SH-01', maxUses: 1, note: '自测' } });
    ok('生成激活码', gen.status === 200 && /^[A-Z2-9]{4}-/.test(gen.body.code), gen.body);
    const code = gen.body.code;

    console.log('\n== 激活 ==');
    const a1 = await req('/api/license/activate', { json: { actCode: code, dev, ke: ke.publicDerB64, host: 'selftest' } });
    ok('激活成功', a1.status === 200 && a1.body.ok === true, a1.body);
    const lic = a1.body.license;
    ok('返回的 license 能被签发公钥验过', lic ? lib.checkLicense(pubB64, lic).ok : false);
    const payload1 = lib.checkLicense(pubB64, lic).payload || {};
    ok('payload 含全部字段', payload1.lic && payload1.cust === 'AcmeArcade-SH-01' && payload1.dev === dev && payload1.ke === ke.publicDerB64, payload1);
    ok('到期 ≈ 15 天', Math.abs((payload1.exp - payload1.iat) - 15 * 86400000) < 1000, { iat: payload1.iat, exp: payload1.exp });

    const a2 = await req('/api/license/activate', { json: { actCode: code, dev, ke: ke.publicDerB64 } });
    ok('同机器重复激活 = 幂等（同一编号）', a2.status === 200 && a2.body.idempotent === true && lib.checkLicense(pubB64, a2.body.license).payload.lic === payload1.lic, a2.body);

    const a3 = await req('/api/license/activate', { json: { actCode: 'ZZZZ-ZZZZ-ZZZZ', dev: 'other-dev', ke: ke.publicDerB64 } });
    ok('错误激活码 = 403 badCode', a3.status === 403 && a3.body.reason === 'badCode', a3.body);

    const a4 = await req('/api/license/activate', { json: { actCode: code, dev: 'third-dev', ke: ke.publicDerB64 } });
    ok('激活码次数用尽 = 403 codeUsed', a4.status === 403 && a4.body.reason === 'codeUsed', a4.body);

    const a5 = await req('/api/license/activate', { json: { actCode: code } });
    ok('缺参数 = 400 badParam', a5.status === 400 && a5.body.reason === 'badParam', a5.body);

    console.log('\n== 续期 ==');
    const ts = Date.now();
    const proof = lib.signText(ke.privateKey, 'renew|' + payload1.lic + '|' + ts);
    const r1 = await req('/api/license/renew', { json: { lic: payload1.lic, dev, ke: ke.publicDerB64, ts, proof } });
    ok('续期成功', r1.status === 200 && r1.body.ok === true, r1.body);
    const p2 = r1.body.license ? lib.checkLicense(pubB64, r1.body.license).payload : {};
    ok('续期后到期不早于原值', p2.exp >= payload1.exp, { old: payload1.exp, now: p2.exp });
    ok('续期换了 nonce', p2.n !== payload1.n, { old: payload1.n, now: p2.n });

    const badProof = lib.signText(ke.privateKey, 'renew|' + payload1.lic + '|' + (ts + 999));
    const r2 = await req('/api/license/renew', { json: { lic: payload1.lic, dev, ke: ke.publicDerB64, ts, proof: badProof } });
    ok('错误 proof = 403 badProof', r2.status === 403 && r2.body.reason === 'badProof', r2.body);

    const other = lib.generateKeyPair();
    const r3 = await req('/api/license/renew', { json: { lic: payload1.lic, dev, ke: other.publicDerB64, ts, proof: lib.signText(other.privateKey, 'renew|' + payload1.lic + '|' + ts) } });
    ok('换了一把 ke = 403 keyMismatch', r3.status === 403 && r3.body.reason === 'keyMismatch', r3.body);

    const r4 = await req('/api/license/renew', { json: { lic: payload1.lic, dev: 'someone-else', ke: ke.publicDerB64, ts, proof } });
    ok('换了机器 dev = 403 machineMismatch', r4.status === 403 && r4.body.reason === 'machineMismatch', r4.body);

    const r5 = await req('/api/license/renew', { json: { lic: payload1.lic, dev, ke: ke.publicDerB64, ts: ts - 10 * 60 * 1000, proof: lib.signText(ke.privateKey, 'renew|' + payload1.lic + '|' + (ts - 10 * 60 * 1000)) } });
    ok('时间戳偏差 10 分钟 = 400 stale', r5.status === 400 && r5.body.reason === 'stale', r5.body);

    const r6 = await req('/api/license/renew', { json: { lic: 'L00000000-9999', dev, ke: ke.publicDerB64, ts, proof } });
    ok('不存在的 license = 404 notFound', r6.status === 404 && r6.body.reason === 'notFound', r6.body);

    console.log('\n== 吊销名单 ==');
    const ts2 = Date.now();
    const v1 = await req('/api/license/revoked?lic=' + payload1.lic + '&ts=' + ts2 + '&proof=' + encodeURIComponent(lib.signText(ke.privateKey, 'revoked|' + payload1.lic + '|' + ts2)));
    ok('拉取吊销名单成功', v1.status === 200 && v1.body.ok === true, v1.body);
    ok('当前名单为空', v1.body.count === 0, v1.body);
    const v2 = await req('/api/license/revoked?lic=' + payload1.lic + '&ts=' + ts2 + '&proof=AAAA');
    ok('错误 proof = 403', v2.status === 403, v2.body);

    console.log('\n== 吊销生效 ==');
    const rv = await req('/api/license/revoke', { admin: true, json: { lic: payload1.lic, reason: '自测吊销' } });
    ok('吊销成功', rv.status === 200 && rv.body.revoked === true, rv.body);
    const ts3 = Date.now();
    const r7 = await req('/api/license/renew', { json: { lic: payload1.lic, dev, ke: ke.publicDerB64, ts: ts3, proof: lib.signText(ke.privateKey, 'renew|' + payload1.lic + '|' + ts3) } });
    ok('吊销后续期被拒 = 403 revoked', r7.status === 403 && r7.body.reason === 'revoked', r7.body);
    const v3 = await req('/api/license/revoked?lic=' + payload1.lic + '&ts=' + ts3 + '&proof=' + encodeURIComponent(lib.signText(ke.privateKey, 'revoked|' + payload1.lic + '|' + ts3)));
    ok('名单里出现该编号', v3.body.count === 1 && v3.body.revoked[0].lic === payload1.lic, v3.body);

    const undo = await req('/api/license/revoke', { admin: true, json: { lic: payload1.lic, undo: true } });
    ok('撤销吊销', undo.status === 200 && undo.body.revoked === false, undo.body);

    console.log('\n== 手工签发 ==');
    const i1 = await req('/api/license/issue', { admin: true, json: { cust: 'ManualCust', dev: 'manual-dev', ke: ke.publicDerB64, days: 3 } });
    ok('手工签发成功', i1.status === 200 && lib.checkLicense(pubB64, i1.body.license).ok, i1.body);

    console.log('\n== 限流 ==');
    let limited = false;
    for (let i = 0; i < 15; i++) {
      const r = await req('/api/license/activate', { json: { actCode: 'AAAA-AAAA-AAAA', dev: 'x' + i, ke: 'y' } });
      if (r.status === 429) {
        limited = true;
        break;
      }
    }
    ok('激活接口触发限流 429', limited);

    console.log('\n== 公钥自助（GET /api/pubkey） ==');
    const pk = await req('/api/pubkey');
    ok('无需鉴权即可取到公钥', pk.status === 200 && pk.body.ok === true, pk.body);
    ok('keyB64 与 secrets/public-key.txt 一致', pk.body.keyB64 === pubB64, { got: pk.body.keyB64, want: pubB64 });
    const pemTxt = fs.readFileSync(path.join(__dirname, 'secrets/license-pub.pem'), 'utf8');
    const fpWant = require('node:crypto').createHash('sha256').update(pemTxt, 'utf8').digest('hex').slice(0, 24);
    ok('fingerprint 与 install.sh 口径一致', pk.body.fingerprint === fpWant, { got: pk.body.fingerprint, want: fpWant });
    const pkPost = await req('/api/pubkey', { method: 'POST', json: {} });
    ok('POST /api/pubkey = 405', pkPost.status === 405, pkPost.body);
  } finally {
    child.kill();
    await sleep(200);
    try {
      fs.rmSync(DATA, { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
  }

  console.log('\n=====================================');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  console.log('=====================================');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
