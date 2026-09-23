'use strict';
/**
 * EXE 夹具公共底座 —— 「启动一个真的 Electron、打它的接口、再收掉它」
 * ============================================================================
 * 为什么要单独抽出来：
 *   xlang/ 下已经有多套要真启动 EXE 的夹具（`exe-license-e2e.js` 验测试密钥、
 *   `exe-prodkey-e2e.js` 验生产私钥）。启动逻辑里踩过的坑一旦在两份拷贝里各修一遍，
 *   迟早改歪一份；而这类夹具改歪的表现是「静默测不到」（看着全绿），比直接报错危险得多。
 *
 * 四个必须记住的坑（写死在这里，别在调用方重复踩）：
 *   ① 环境里若有 `ELECTRON_RUN_AS_NODE=1`（node 沙箱常设），electron.exe 会**退化成纯 Node** ——
 *      现象是 `require('electron').app` 为 undefined、栈里带 `node:internal/modules/run_main`，
 *      看着完全像「代码写坏了」。必须在 spawn 的 env 里 delete 掉。
 *   ② 换 userData 目录**必须用 `--user-data-dir=<目录>`** —— 覆盖 `APPDATA` 对 Electron 无效。
 *   ③ 对端是**纯 HTTP**（main.js 用 `http.createServer`），用 https 探只会得到
 *      `SSL: WRONG_VERSION_NUMBER` —— 看着像「接口挂了」，其实是协议错。
 *   ④ 打包版（`app.isPackaged`）的 `process.argv` 比开发模式**少一个「app 目录」参数**，
 *      而 main.js 里是 `argv = process.argv.slice(2)` ⇒ 会**吃掉第一个自定义参数**。
 *      本夹具把 `--user-data-dir=<目录>` 放在**第一位**，被吃掉的正好是 Chromium 自己也会处理的
 *      开关（userData 隔离照旧生效），`--port` / `--license-url` 仍能被 main.js 读到。
 *      ⚠ 别改成「把 --port 放第一位」—— 那样打包版会静默退回生产端口 / 生产授权服务器。
 *      （按 Electron 的 argv 约定推算；本仓库 dist/ 里的包目前还没有授权代码，故未实测。）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const HERE = __dirname;
const CASTSERVER = path.resolve(HERE, '..');
const CASTPC = path.resolve(HERE, '..', '..', 'cast-pc');
const MAIN_JS = path.join(CASTPC, 'main.js');
const ELECTRON = path.join(CASTPC, 'node_modules', 'electron', 'dist', 'electron.exe');
const PACKAGED_EXE = path.join(CASTPC, 'dist', 'win-unpacked', 'WebXR直播接收端.exe');
const DAY = 86400000;

/** 全局断言计数（各夹具共用；结尾读 state.FAIL 决定退出码） */
const state = { FAIL: 0 };

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

function ok(cond, msg, extra) {
  if (cond) { console.log(`  [OK]   ${msg}`); }
  else { state.FAIL++; console.log(`  [FAIL] ${msg}${extra ? '\n         → ' + extra : ''}`); }
  return cond;
}

function die(msg) { console.error('[fatal] ' + msg); process.exit(2); }

/**
 * 场景包装：把每个场景的异常**关在本场景内**。
 * 教训：场景 2 里 `v.payload.nbf` 抛了一次 TypeError，结果场景 3 整段没跑 ——
 * 报告上看起来像「ke-mismatch 也坏了」，实际是「根本没测」。夹具最忌讳「前面的失败隐藏后面的失败」。
 */
async function scenario(title, fn) {
  console.log('\n' + title);
  try { await fn(); } catch (e) { ok(false, `${title} 抛异常`, (e && e.stack) || String(e)); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 探测一条 GET（**http**，见文件头坑 ③） */
function httpGet(port, p) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: 'GET', timeout: 5000,
    }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => resolve({ status: r.statusCode, body: d }));
    });
    req.on('error', (e) => resolve({ status: -1, body: '', err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: -1, body: '', err: 'timeout' }); });
    req.end();
  });
}

/** 生成一对 Ke（与 main.js 的落盘格式逐字一致：PKCS#8 PEM + SPKI DER 的 base64url） */
function newKe() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub: publicKey,
    ke: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),  // 与 main.js bufToB64u 同口径
  };
}

/** 从源码里抠出内置签发公钥常量（EXE 用单引号，Java 用双引号）—— 与 deploy/backup-drill.js 同口径 */
function bakedConst(file) {
  if (!fs.existsSync(file)) return { file, b64: null, why: '文件不存在' };
  const m = fs.readFileSync(file, 'utf8').match(/LICENSE_PUBKEY_B64\s*=\s*["']([^"']*)["']/);
  if (!m) return { file, b64: null, why: '没匹配到 LICENSE_PUBKEY_B64' };
  return { file, b64: m[1], why: '' };
}

/**
 * 从一个**打包产物**（.exe / resources/app.asar）里抠出它真正带着的 main.js。
 * 用途：防止「拿一个不含授权代码的旧包去验授权」——那时会得到一堆莫名其妙的红灯，
 * 让人以为是密钥或代码坏了。asar 不压缩，所以直接按头部偏移切出来即可。
 * @returns {{text: string, size: number, md5: string, entry: string} | null}
 */
function readPackagedMainJs(exeOrAsar) {
  const asar = /\.asar$/i.test(exeOrAsar)
      ? exeOrAsar
      : path.join(path.dirname(exeOrAsar), 'resources', 'app.asar');
  if (!fs.existsSync(asar)) return null;
  const b = fs.readFileSync(asar);
  if (b.length < 16) return null;
  // asar 头部：u32@12 = header JSON 长度，JSON 从 offset 16 开始
  const hlen = b.readUInt32LE(12);
  if (hlen <= 0 || 16 + hlen > b.length) return null;
  let head;
  try { head = JSON.parse(b.subarray(16, 16 + hlen).toString('utf8')); } catch (e) { return null; }
  const ent = head && head.files && head.files['main.js'];
  // ★ 守卫**不能**写 `typeof ent.offset !== 'number'`：asar 头里的 offset/size 可能是**字符串**
  //   （实测 electron-builder 25.1.8 打出的包：offset='1597895'）。写成严格 number 判断的话，
  //   打包产物会**永远读不出来** → 被误判成「旧包 / 不含授权代码，请重新打包」，把人引向错误方向。
  //   统一用 Number() 归一后判有限即可。
  const offN = Number(ent && ent.offset);
  const szN = Number(ent && ent.size);
  if (!ent || !Number.isFinite(offN) || !Number.isFinite(szN)) return null;
  // ★ 数据区起点必须**4 字节对齐**——header JSON 从 offset 16 开始、长 hlen，其后有 1~3 字节 padding。
  //   实测（同一个包，hlen=17587）：16+hlen = 17603 若直接拿它当起点，读 renderer/index.html
  //   会得到 '\n<!DOCTYPE html>'（整体偏 1 字节）⇒ 文本首尾各错一字节、md5 永远对不上，
  //   还会让「包内公钥 / 关键字比对」在边界处误判。对齐到 17604 才对。
  //   这个坑极隐蔽：hlen 恰好 4 字节对齐时完全看不出来（早先那个旧包就是），只有不对齐时才暴露。
  const base = (16 + hlen + 3) & ~3;
  const buf = b.subarray(base + offN, base + offN + szN);
  return { text: buf.toString('utf8'), size: szN, md5: md5(buf), entry: asar };
}

/** 打印一次环境提示（宿主设了 ELECTRON_RUN_AS_NODE 时最容易误判） */
function noteEnv() {
  if (process.env.ELECTRON_RUN_AS_NODE) {
    console.log('  [i]    环境里有 ELECTRON_RUN_AS_NODE=' + process.env.ELECTRON_RUN_AS_NODE
        + ' → 已在子进程环境中摘掉（否则 electron.exe 会退化成纯 Node）');
  }
}

/**
 * 启动一个 EXE 实例，抓日志 + 打一个接口，然后收掉。
 * @param {{outDir:string, port:number, licenseUrl:string, exe?:string}} c 运行配置
 * @param {string} tag            场景名（同时是 userData 子目录名）
 * @param {string} keyPem         预置的本机 Ke 私钥（PEM 文本）
 * @param {string|null} licenseText 预置的 license 文本（null = 不放）
 * @returns {Promise<{log:string, port:number, nonce:string, api:object, json:object|null, ud:string, exe:string}>}
 */
async function runExe(c, tag, keyPem, licenseText) {
  const exe = c.exe || ELECTRON;
  const isDev = path.basename(exe).toLowerCase() === 'electron.exe';
  const ud = path.join(c.outDir, tag);
  fs.rmSync(ud, { recursive: true, force: true });
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'license-key.pem'), keyPem);
  if (licenseText) fs.writeFileSync(path.join(ud, 'license.json'), licenseText);

  // 见文件头坑 ①：宿主设着 ELECTRON_RUN_AS_NODE=1 会让 electron.exe 退化成纯 Node
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;

  const common = [`--user-data-dir=${ud}`, `--port=${c.port}`, `--license-url=${c.licenseUrl}`];
  // 开发模式 argv = [electron.exe, appDir, ...args]；打包模式没有 appDir（见文件头坑 ④）
  const args = isDev ? [CASTPC, ...common] : common;
  const child = spawn(exe, args, { cwd: CASTPC, windowsHide: true, env });
  let log = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  // 等「授权看护已启动」—— 它是 loadLicense 之后 startLicenseWatch() 的最后一行，
  // 之前所有授权日志（含启动横幅）都已打出
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    if (log.indexOf('授权看护已启动') >= 0) break;
    if (child.exitCode !== null) break;
    await sleep(250);
  }
  await sleep(400);          // 让窗口/接口就绪

  const m = log.match(/HTTP 已启动\s+http:\/\/0\.0\.0\.0:(\d+)/);
  const port = m ? Number(m[1]) : 0;
  const nonce = crypto.randomBytes(16).toString('hex');   // 头显侧同口径：16 字节 → 32 位小写 hex
  let api = { status: 0, body: '' };
  if (port) api = await httpGet(port, `/api/license/current?nonce=${nonce}`);

  // 收进程：优先连子孙一起收（Electron 有 GPU/renderer 子进程），失败再退 child.kill()
  const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  if (killed.error || killed.status !== 0) { try { child.kill(); } catch (e) { /* 已退出 */ } }
  await sleep(900);          // 等端口真的释放，免得下个场景落到备用端口

  let json = null;
  try { json = JSON.parse(api.body); } catch (e) { /* 留给断言报错 */ }
  return { log, port, nonce, api, json, ud, exe };
}

/**
 * 绑定一套运行配置，得到 `(tag, keyPem, licenseText) => Promise<结果>` 形态的跑场景函数。
 * 这样各夹具的调用点保持一行，不必每次重复 outDir/port/exe。
 */
function makeRunner(cfg) {
  const c = Object.assign({
    outDir: path.join(HERE, 'out'),
    port: 18443,
    licenseUrl: 'http://127.0.0.1:9',   // 指向 discard 端口：就算真联网也打不到生产服务器
    exe: ELECTRON,
  }, cfg || {});
  return (tag, keyPem, licenseText) => runExe(c, tag, keyPem, licenseText);
}

/** 把各场景日志/接口响应留档，便于现场对不上时回看 */
function dumpResults(outDir, results) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const r of results) {
    const tag = path.basename(r.ud);
    fs.writeFileSync(path.join(outDir, tag + '.log'), r.log, 'utf8');
    fs.writeFileSync(path.join(outDir, tag + '.api.json'),
        JSON.stringify({ httpStatus: r.api.status, httpErr: r.api.err || null, body: r.json, raw: r.api.body.slice(0, 4000) }, null, 2), 'utf8');
  }
  console.log(`日志快照：${outDir}`);
}

module.exports = {
  HERE, CASTSERVER, CASTPC, MAIN_JS, ELECTRON, PACKAGED_EXE, DAY,
  state, md5, ok, die, scenario, sleep, httpGet,
  newKe, bakedConst, readPackagedMainJs, noteEnv, runExe, makeRunner, dumpResults,
};
