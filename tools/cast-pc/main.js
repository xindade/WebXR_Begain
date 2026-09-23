// tools/cast-pc/main.js —— PC 直播接收端（Electron 主进程）
//
// 一个 HTTP 端口同时做三件事（全部同源，明文信令，免去自签证书信任问题；
// 媒体流仍由 WebRTC 自身 DTLS 加密，仅信令/帧明文，局域网内可接受）：
//   GET  /*                  静态托管游戏（让头显浏览器能直接打开）
//   GET  /api/events         SSE 下行（welcome / peer-ready / offer / answer / ice / peer-left）
//   POST /api/signal         上行信令（offer / answer / ice）
//   POST /api/frame          JPEG 兜底：游戏端推二进制帧
//   GET  /api/frame          JPEG 兜底：接收端取最新一帧
//   POST /api/launch/request 启动授权：头显 APK 首次拉起时来要放行条（HMAC，见「启动授权」段）
//   POST /api/master/allow   门禁「允许运行」：APK 与游戏页面共用（与上一行同一套判据，见 masterAllow）
//   GET  /api/config/dump    配置下发：把「轻量配置」（关卡/刷怪/数值等）整包交给已授权的头显
//                            （见「启动授权」段的 CONFIG_MANIFEST；本局局号 SESSION_ID 随包下发）
//   GET  /api/license/current 出示本机 license + proof（**无鉴权**，见「授权（License）」段）
//   GET  /api/info           返回端口 / 本机 IP / 对端在线状态（含 guard/ver：是否已支持启动授权）
//   GET  /__cast/...         接收端自己的界面（避免 file:// 导致相对路径失效）
//
// 用法：npm start [-- --port=8443 --root=<游戏目录> --no-serve --game-root=<游戏目录>
//                        --room=<房间号> --platform=<IP:端口> --game=<游戏名>
//                        --pure | --panels（强制完整面板）| --fullscreen]
//      平台拉起时还会带一个位置参数 "<exe 相对路径>$<进程名>$<平台本机 IP>"（见「平台参数」段）。

const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

// —— WebRTC：关掉 mDNS 候选混淆 ——
// Chrome 默认把 host candidate 的真实 IP 换成 xxx.local，跨设备解析失败就连不上。
// 头显侧改不了启动参数，但 PC 侧关掉后会直接提供真实 IP 候选，通常即可连通。
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'default');

// —— 音频：头显推上来的音轨要能在 PC 大屏上直接出声 ——
// Chromium 默认策略是「没有用户手势 → 带声播放被拦」，表现就是「画面有、声音没有」。
// 本窗口是现场大屏播放器，不会有人去点它，因此对这个进程整体放开自动播放。
// 注意：这是**本进程**的开关，不改系统 / Chrome 的全局策略。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ————————————————————————— 参数 —————————————————————————
// ⚠ 打包后 process.argv = [<exe>, ...平台参数]，开发时 = [<electron>, <脚本>, ...参数]。
//   原实现写死 slice(2)：开发期没问题，但**打包后会吃掉 argv[1]** —— 而平台恰恰就是用
//   那一个位置参数把「平台本机 IP」告诉游戏的（见下面「平台参数」段）。因此按是否打包区分。
const argv = process.argv.slice(app.isPackaged ? 1 : 2);
const argValue = (name, def) => {
  const hit = argv.find((s) => s.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const hasFlag = (name) => argv.includes(`--${name}`);

// —————— 平台参数（《打包和平台对接》第 4 条：EXE 由平台登记并拉起）——————
// 平台侧实测格式（见 平台指令/VRPlatform-流量取证/指令速查.md）：
//   argv[1] = "<exe 相对路径>$<进程名不含 .exe>$<平台本机 IP>"
//   例：DeadHospital2-8.0.5\DeadHospital2.exe$DeadHospital2$192.168.31.228
// 另外预留三个具名参数（命名待平台侧最终定案）：
//   --room=<房间号>   --platform=<平台本机IP:端口>   --game=<游戏名>
// 原则：**全部可选**。一个都不给 ⇒ 行为与现在完全一致（自动发现 + 手动配置游戏目录 + 端口 fallback）。
const PLATFORM_ARGV_RAW = argv.find((s) => !s.startsWith('--')) || null;
const platformPositional = (() => {
  if (!PLATFORM_ARGV_RAW) return null;
  const parts = PLATFORM_ARGV_RAW.split('$');
  if (parts.length < 3) return null;                     // 不是平台格式 → 当普通参数忽略
  return { exeRel: parts[0], procName: parts[1], host: parts[2] };
})();
const PLATFORM_ARGS = {
  room: argValue('room', null),
  platform: argValue('platform', platformPositional ? platformPositional.host : null),
  game: argValue('game', platformPositional ? platformPositional.procName : null),
  exeRel: platformPositional ? platformPositional.exeRel : null,
  raw: PLATFORM_ARGV_RAW,
};
/**
 * ★ 第二十修（2026-09-23 晚）：本次 EXE 是不是**被平台拉起**的 —— 即平台点了**第一步**「启动游戏」。
 *
 * <p>平台操作员是**两步**（用户第五次现场实测，与抓包逐帧一致）：
 *   ① 「启动游戏」→ 启动器通道 `{"cmd":"start","msgData":"<相对路径>$<进程名>$<平台IP>"}`
 *      → `DoStartGame` → **拉起本 EXE** + 拉起头显里的游戏（我们的 APK）；
 *   ② 「开始游戏」→ 游戏通道 `CMD 5 GameStart`（UDP 51124）→ **这一步才是开局信号**。
 *
 * <p>⚠ 第十九修曾把 ①（被平台拉起）当成开局信号 ⇒ 头显在操作员还没点②时就冒出「进入 VR」
 *   （用户原话：「平台首先点的是启动游戏…第二步是平台点开始游戏，这个时候头显里才会显示
 *   进入VR」）。现在 ① **只用于显示与留痕**，放行一律等 ②（见 startPlatformGameChannel()）。
 *
 * <p>判定口径与 `logPlatformArgs()` 一致：位置参数解析成功，或三个具名参数任意一个给了值。
 * 手动双击 / 现场排练时没有这些参数 ⇒ false。
 */
const PLATFORM_LAUNCHED = !!(platformPositional || PLATFORM_ARGS.room || PLATFORM_ARGS.platform
  || PLATFORM_ARGS.game || PLATFORM_ARGS.exeRel);

/** 把平台参数打进日志（打包后看不到控制台，界面顶部也会再显示一份）。 */
function logPlatformArgs() {
  if (!PLATFORM_ARGS.room && !PLATFORM_ARGS.platform && !PLATFORM_ARGS.game) {
    console.log('[cast-pc] 平台参数：未提供（按默认方式运行：自动发现 + 手动配置游戏目录）');
    return;
  }
  console.log('[cast-pc] 平台参数：'
    + `room=${PLATFORM_ARGS.room || '-'} platform=${PLATFORM_ARGS.platform || '-'} game=${PLATFORM_ARGS.game || '-'}`
    + (PLATFORM_ARGS.exeRel ? ` exeRel=${PLATFORM_ARGS.exeRel}` : ''));
  console.log('[cast-pc] 本次由平台「启动游戏」拉起（第一步）→ 本局**尚未**放行；'
    + '等平台点「开始游戏」（游戏通道 CMD 5 GameStart，本机 UDP 51124）'
    + '或操作员点「▶ 开始本局」才放行');
}

let PORT = Number(argValue('port', 8443));   // 实际启动端口由 tryListen 决定（fallback）
// 打包后（asar 内）__dirname 指向 resources/app.asar，'../..' 会算到错误的目录；
// 且 EXE 定位是「纯接收端」——游戏本体由头显 APK 自带，没必要把整个项目目录暴露出去。
// 因此打包运行默认关闭静态托管（仍可用 --root=<路径> 显式开启）。
const NO_SERVE = hasFlag('no-serve') || (typeof app.isPackaged === 'boolean' && app.isPackaged);
const ROOT = path.resolve(argValue('root', path.join(__dirname, '..', '..')));
const RENDERER_DIR = path.join(__dirname, 'renderer');

// ——— 游戏页面托管（旁路 APK 代理链的最强诊断 / 兜底） ———
// 头显浏览器直接打开 http://<电脑IP>:8443/?cast=1
//   · 游戏页面从 PC 端 GAME_ROOT 提供（替代 APK 内的 NanoHTTPD）
//   · 信令同源 /api 直接走 PC（替代 APK 代理）
// 配置优先级：CLI --game-root <路径>  >  userData/config.json  >  常见路径自动探测
let GAME_ROOT = null;            // 可变：UI 修改后立即生效
let SERVE_GAME = false;          // 仅当 GAME_ROOT 有效且包含 index.html 时为 true
const CONFIG_PATH = path.join(app.getPath('userData'), 'cast-pc-config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { return {}; }
}
function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) { console.warn('[cast-pc] 写配置失败：', e.message); }
}
function isValidGameRoot(p) {
  if (!p) return false;
  try {
    const idx = path.join(p, 'index.html');
    return fs.existsSync(idx) && fs.statSync(idx).isFile();
  } catch (e) { return false; }
}
// 常见路径自动探测（开发机常用盘符）
function autoDetectGameRoot() {
  const candidates = [
    argValue('game-root', null),
    process.cwd(),
    path.join(__dirname, '..', '..'),
    // ★ 主工程：合并后的「新玩法基线 + 推流/平台」目录（平台里登记的那个游戏目录也应是它）。
    'E:/AI_Work/WebXR_Begain_Platform',
    'G:/01_Work/AI_Codex/WebXR_Begain',
    // 历史位置：保留为兜底 —— 老现场机器上可能只有这几个目录，删掉会让自动探测失效。
    'E:/AI_Work/WebXR_Begain',
    'D:/AI_Work/WebXR_Begain',
    'C:/AI_Work/WebXR_Begain',
  ].filter(Boolean).map(p => path.resolve(p));
  for (const c of candidates) if (isValidGameRoot(c)) return c;
  return null;
}
function resolveGameRoot() {
  // 1) CLI 参数
  const cliRoot = argValue('game-root', null);
  if (cliRoot && isValidGameRoot(path.resolve(cliRoot))) return path.resolve(cliRoot);
  // 2) 持久化配置
  const cfg = loadConfig();
  if (cfg.gameRoot && isValidGameRoot(cfg.gameRoot)) return cfg.gameRoot;
  // 3) 自动探测
  return autoDetectGameRoot();
}
GAME_ROOT = resolveGameRoot();
SERVE_GAME = !!GAME_ROOT;
if (GAME_ROOT) console.log(`[cast-pc] 游戏页面托管根目录：${GAME_ROOT}`);
else console.log('[cast-pc] 未配置游戏根目录（头显请用 APK 启动，或在 UI 配置游戏目录后重启 EXE）');

// ————————————————————————— 工具 —————————————————————————
function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i && i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',     // ES module 必需，错 MIME 会被浏览器拒绝加载
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.exr': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.spz': 'application/octet-stream',
};

function sendFile(res, file) {
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

// ————————————————————————— 信令状态 —————————————————————————
let publisher = null;   // 游戏端（推流）的 SSE 响应
let viewer = null;      // 接收端界面（本进程渲染进程）的 SSE 响应
let latestFrame = null; // JPEG 兜底：最新一帧
let frameCount = 0;     // JPEG 兜底：累计收到帧数（用于诊断）
let lastFrameLog = 0;
let mainWindow = null;

function sse(res, obj) {
  if (!res || res.writableEnded) return;
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) { /* 忽略 */ }
}

function pushStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('cast:status', {
    port: PORT,
    ips: lanIPs(),
    root: NO_SERVE ? null : ROOT,
    gameRoot: GAME_ROOT,
    serveGame: SERVE_GAME,
    publisher: !!publisher,
    viewer: !!viewer,
  });
}

// ————————————————————————— 请求处理 —————————————————————————
function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');   // APK 自带本地服务时属跨域
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Chrome 私有网络访问（PNA）：localhost 页面访问私有 IP(192.168.x.x) 时需此头放行 preflight，
  // 否则跨域 EventSource/fetch 在连接前就被浏览器拦掉，服务端永远收不到请求。
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function handleEvents(req, res, role) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
  });
  res.write(':ok\n\n');

  const isPublisher = role === 'publisher';
  if (isPublisher) publisher = res; else viewer = res;
  sse(res, { type: 'welcome', role });

  const peer = isPublisher ? viewer : publisher;
  if (peer) {
    sse(res, { type: 'peer-ready' });
    sse(peer, { type: 'peer-ready' });
  }
  console.log(`[cast-pc] ${role} 上线`);
  pushStatus();

  // 心跳：防止中间设备掐断空闲连接
  const hb = setInterval(() => {
    try { res.write(':ping\n\n'); } catch (e) { /* 忽略 */ }
  }, 15000);

  req.on('close', () => {
    clearInterval(hb);
    if (publisher === res) publisher = null;
    if (viewer === res) viewer = null;
    const other = isPublisher ? viewer : publisher;
    if (other) sse(other, { type: 'peer-left' });
    console.log(`[cast-pc] ${role} 离线`);
    pushStatus();
  });
}

function readBody(req, cb) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => cb(Buffer.concat(chunks)));
}

function handleSignal(req, res) {
  readBody(req, (buf) => {
    let msg = null;
    try { msg = JSON.parse(buf.toString('utf8')); } catch (e) { /* 忽略非法 JSON */ }
    if (msg) {
      if (msg.type === 'offer') console.log('[cast-pc] 收到 WebRTC offer（推流端已发起协商）');
      if (msg.type === 'answer') console.log('[cast-pc] 收到 WebRTC answer（接收端已回应）');
      const to = msg.role === 'publisher' ? viewer : publisher;
      sse(to, msg);
    }
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
    res.end('ok');
  });
}

function handleFramePost(req, res) {
  readBody(req, (buf) => {
    if (buf.length) {
      latestFrame = buf;
      frameCount++;
      const now = Date.now();
      if (now - lastFrameLog > 3000) {
        console.log(`[cast-pc] JPEG 兜底已收 ${frameCount} 帧`);
        lastFrameLog = now;
      }
      // 关键：每收到一帧立即 IPC 直推渲染进程，取代原先「PC 每 33ms 轮询 GET」的拉模式。
      // 这样帧率实打实跟随头显编码速率（24fps），消除空帧/重复帧抖动（卡顿根因）。
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send('cast:frame', buf); } catch (e) { /* 忽略单次推送失败 */ }
      }
    }
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
    res.end('ok');
  });
}

function handleFrameGet(req, res) {
  if (!latestFrame) {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(latestFrame);
}

function handleStatic(req, res, pathname) {
  // 接收端界面（不受 --no-serve 影响）
  if (pathname.startsWith('/__cast/')) {
    const rel = pathname.slice('/__cast/'.length) || 'index.html';
    const file = path.join(RENDERER_DIR, rel);
    if (file.startsWith(RENDERER_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return sendFile(res, file);
    }
    res.writeHead(404); res.end('404'); return;
  }

  if (NO_SERVE) {
    // 优先走「游戏托管」分支：SERVE_GAME 时直接 serve GAME_ROOT
    if (SERVE_GAME) {
      // 透传到下面的通用静态处理
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        'cast-pc 信令服务运行中（未托管游戏页面）。\n'
        + '两种使用方式：\n'
        + '  1) 用 APK 在头显启动（推荐）—— APK 会自动发现本机并代理信令。\n'
        + '  2) 让本程序托管游戏页面：在本窗口「游戏目录」处配置 E:\\AI_Work\\WebXR_Begain 后重启 EXE，\n'
        + '     然后头显浏览器直接打开 http://<电脑IP>:8443/?cast=1（同源，最稳的诊断路径）。\n'
      );
      return;
    }
  }

  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (e) {
    res.writeHead(400); res.end('400'); return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';

  // 路径穿越防护：解析后必须仍在 ROOT 内
  // SERVE_GAME 模式下从 GAME_ROOT 服务（与 NO_SERVE 互不冲突，CLI --root 仍可用）
  const serveRoot = SERVE_GAME ? GAME_ROOT : ROOT;
  const file = path.resolve(serveRoot, '.' + rel);
  if (!file.startsWith(serveRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 ${rel}`);
    return;
  }
  sendFile(res, file);
}

// ————————————————————————— 启动 —————————————————————————
app.whenReady().then(() => {
  const server = http.createServer((req, res) => {
    const _rpath = (() => { try { return new URL(req.url, 'https://x').pathname; } catch (e) { return req.url; } })();
    console.log(`[cast-pc] REQ ${req.method} ${_rpath} origin=${req.headers.origin || '-'} from=${req.socket.remoteAddress}`);
    applyCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Private-Network': 'true' });
      res.end(); return;
    }

    let pathname = '/';
    try {
      pathname = new URL(req.url, `https://${req.headers.host || 'localhost'}`).pathname;
    } catch (e) { /* 忽略，保持 '/' */ }

    if (pathname === '/api/events') {
      const role = new URL(req.url, 'https://x').searchParams.get('role');
      return handleEvents(req, res, role === 'viewer' ? 'viewer' : 'publisher');
    }
    if (pathname === '/api/signal' && req.method === 'POST') return handleSignal(req, res);
    if (pathname === '/api/frame' && req.method === 'POST') return handleFramePost(req, res);
    if (pathname === '/api/frame' && req.method === 'GET') return handleFrameGet(req, res);
    // 启动授权：头显 APK 首次拉起时来要放行条（见文件顶部「启动授权」段）
    if (pathname === '/api/launch/request' && req.method === 'POST') return handleLaunchRequest(req, res);
    // ★ 门禁（文档第 3 条）：APK 与游戏页面共用的「允许运行」查询 —— 与上一行**同一套判据**。
    if (pathname === '/api/master/allow' && req.method === 'POST') return handleMasterAllow(req, res);
    // ★ 本局收尾（第十八修）：画面侧上报「本局已结束」→ 收回本局放行（见 ROUND / roundSet）。
    //   头显页面在「本轮真的结束」时调（game.js 的 _tellMasterRoundEnd），经 APK 的 GameServer
    //   代理过来；PCVR / 直连诊断时页面直接打到这里。
    if (pathname === '/api/round/end' && req.method === 'POST') return handleRoundEnd(req, res);
    // ★ 第二十修：反向那条 —— 头显先收到平台开局帧时，把「平台已开始本局」回报过来
    //   （见 src/main.js 的 reportPlatformStartToMaster）。与上一行对称，判据仍是 roundSet()。
    if (pathname === '/api/round/start' && req.method === 'POST') return handleRoundStart(req, res);
    // ★ 第十七修：配置下发。头显拿到放行条后立刻来取「轻量配置」，文件齐全才建游戏界面。
    //   只允许 GET（HMAC 参数走 query），且必须排在 handleStatic 兜底之前。
    if (pathname === '/api/config/dump') return handleConfigDump(req, res);
    // ★ 授权出示：头显开局前先来这里拿 license + proof（无鉴权，但 proof 绑它当场给的 nonce）。
    if (pathname === '/api/license/current') return handleLicenseCurrent(req, res);
    if (pathname === '/api/info') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        port: PORT, ips: lanIPs(), root: NO_SERVE ? null : ROOT,
        gameRoot: GAME_ROOT, serveGame: SERVE_GAME,
        publisher: !!publisher, viewer: !!viewer,
        // 启动授权能力标识：头显 APK 用它区分「地址上跑的是旧版接收端（没有
        // /api/launch/request）」与「这个地址根本不是直播接收端」。不带这个字段的
        // 都按旧版处理 —— 现场排障时「整包没换」是最常见的一种失败。
        guard: true, ver: '1.4.0',
        // ★ 门禁（文档第 3 条）：本端支持 /api/master/allow —— APK/页面据此区分「旧版接收端」。
        masterAllow: true,
        // ★ 本局放行（第十八修）：armed=true 表示操作员已点「开始本局」，头显页面此时才给
        //   「进入 VR」按钮。现场排障时这一行比任何推断都直接。
        round: roundSnapshot(),
        // ★ 平台参数（文档第 4 条）：平台拉起时带的房间号 / 平台 IP / 游戏名；独立运行全为 null。
        platform: PLATFORM_ARGS,
        // ★ 第二十修：平台游戏通道（UDP 51124）状态 —— 「平台到底点没点开始游戏」在 PC 侧的
        //   第一手证据（bound / lastStartAt / lastCloseAt）；现场排障时先看这一行。
        gameChannel: platformChannelSnapshot(),
        // session = 本局局号；configManifest = 会下发哪些路径（排查「文件不齐」时一眼看出）
        session: SESSION_ID, configManifest: CONFIG_MANIFEST,
        // ★ 授权状态摘要（一眼看出「EXE 到底授权没有」；完整凭据走 /api/license/current）
        //   故意不调 licenseState()：那个会去枚举网卡算指纹，不该出现在高频的 /api/info 里。
        license: licenseSummary(),
      }));
      return;
    }
    return handleStatic(req, res, pathname);
  });

  // 端口 fallback：8443 常被开发环境的 http-server / nginx 等占用。
  // 自动 +1 重试最多 10 次。APK 端通过 UDP 信标自动拿到实际端口，无需手动改。
  const tryListen = (port, attempts) => {
    server.listen(port, '0.0.0.0', () => onListen(port));
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && attempts < 10) {
        console.warn(`[cast-pc] 端口 ${port} 被占用，改用 ${port + 1}`);
        tryListen(port + 1, attempts + 1);
      } else {
        console.error(`[cast-pc] 服务启动失败：${e.message}`);
        if (e.code === 'EADDRINUSE') {
          console.error('[cast-pc] 10 次重试仍无空闲端口，请关掉占用 8443~8453 的进程，或用 --port= 指定别的端口');
        }
        process.exit(1);
      }
    });
  };
  // 把所有「启动后初始化」放进 onListen，用闭包变量覆盖模块顶部 PORT
  const onListen = (usedPort) => {
    PORT = usedPort;        // 顶部 PORT 是 let，赋新值后所有引用 PORT 的闭包自动用新值
    const ips = lanIPs();
    console.log('==================================================');
    console.log(`[cast-pc] HTTP 已启动  http://0.0.0.0:${usedPort}`);
    console.log(`[cast-pc] 本机 IP：${ips.join(', ')}`);
    console.log(`[cast-pc] 静态根目录：${NO_SERVE ? '（已关闭）' : ROOT}`);
    console.log(`[cast-pc] 游戏托管：${SERVE_GAME ? GAME_ROOT : '（未配置）'}`);
    console.log('[cast-pc] 头显请打开：' + (ips[0] ? `http://${ips[0]}:${usedPort}/?cast=1` : '(未取到局域网 IP)'));
    logPlatformArgs();
    console.log('==================================================');

    loadGuard();

    // ——— IPC：让 UI 改游戏目录配置（持久化 + 立即影响新请求） ———
    ipcMain.handle('cfg:get', () => ({
      gameRoot: GAME_ROOT,
      serveGame: SERVE_GAME,
      gameRootValid: !!GAME_ROOT,
      configPath: CONFIG_PATH,
    }));
    ipcMain.handle('cfg:set', (_e, patch) => {
      if (patch && typeof patch.gameRoot === 'string') {
        const next = patch.gameRoot.trim() ? path.resolve(patch.gameRoot.trim()) : null;
        if (next && !isValidGameRoot(next)) {
          return { ok: false, msg: '该目录不含 index.html，不是有效的游戏根' };
        }
        GAME_ROOT = next;
        SERVE_GAME = !!next;
        const cfg = loadConfig();
        cfg.gameRoot = next || null;
        saveConfig(cfg);
        console.log(`[cast-pc] 游戏根目录已更新：${GAME_ROOT || '（清空）'}`);
        return { ok: true, gameRoot: GAME_ROOT, serveGame: SERVE_GAME };
      }
      return { ok: false, msg: '无有效 patch' };
    });

    // ——— IPC：启动授权（白名单 / 自动登记 / 配对窗口） ———
    ipcMain.handle('guard:get', () => ({
      secret: GUARD.secret,
      // ★ 第十七修：secret 已是两端固定的共享串，界面上只展示、不再提供「重置」（重置只会把
      //   头显踢出去且无法自救）。要重新配对请用 resetPairing（清空白名单，重开配对窗口）。
      secretFixed: true,
      allowList: GUARD.allowList.slice(),
      autoAllow: GUARD.autoAllow,
      pairingWindow: GUARD.allowList.length === 0,
      session: SESSION_ID,
      configManifest: CONFIG_MANIFEST,
      log: GUARD.log.slice(0, 20),
    }));
    ipcMain.handle('guard:set', (_e, patch) => {
      if (!patch || typeof patch !== 'object') return { ok: false, msg: '无有效 patch' };
      if (typeof patch.autoAllow === 'boolean') GUARD.autoAllow = patch.autoAllow;
      if (typeof patch.addDev === 'string' && patch.addDev.trim()
          && !GUARD.allowList.includes(patch.addDev.trim())) {
        GUARD.allowList.push(patch.addDev.trim());
      }
      if (typeof patch.removeDev === 'string') {
        GUARD.allowList = GUARD.allowList.filter((d) => d !== patch.removeDev);
      }
      // 重新配对 = 清空白名单（回到「配对窗口」，下一台来请求的设备会被自动登记）。
      // 这是替代「重置 secret」的维护动作：secret 现在两端固定，重置它没有任何好处，
      // 只会让头显进不来且现场无法自救。
      if (patch.resetPairing === true) {
        GUARD.allowList = [];
        GUARD.autoAllow = true;
        console.log('[cast-pc] 白名单已清空 → 配对窗口重新开启（下一台来请求的设备将自动登记）');
      }
      saveGuard();
      return {
        ok: true, secret: GUARD.secret, secretFixed: true,
        allowList: GUARD.allowList.slice(), autoAllow: GUARD.autoAllow,
        pairingWindow: GUARD.allowList.length === 0, session: SESSION_ID,
      };
    });

    // ——— IPC：授权（License）—— 读状态 / 激活 / 手动续期 ———
    // 界面只做「显示 + 触发」，全部判断都在主进程 —— 渲染进程改不了门禁结果。
    // ——— IPC：本局放行（第十八修）—— PC 大屏上的「开始本局 / 结束本局」就是平台的开局信号 ———
    ipcMain.handle('round:get', () => roundSnapshot());
    ipcMain.handle('round:set', (_e, patch) => {
      const p = patch || {};
      return roundSet(!!p.armed, String(p.why || 'PC 界面'));
    });

    // ——— IPC：平台参数（文档第 4 条）—— 界面顶部原样显示平台带了什么，便于现场核对 ———
    ipcMain.handle('platform:get', () => ({ ...PLATFORM_ARGS, argv, packaged: !!app.isPackaged }));

    ipcMain.handle('license:get', () => licenseState());
    ipcMain.handle('license:set', async (_e, patch) => {
      if (!patch || typeof patch !== 'object') return { ok: false, why: '无有效 patch' };
      if (typeof patch.actCode === 'string' && patch.actCode.trim()) {
        return await licenseActivate(patch.actCode);
      }
      if (patch.renew === true) {
        const r = await licenseRenew('界面手动');
        return { ok: r.ok, why: r.why || (r.ok ? '续期成功' : '续期失败'), state: licenseState() };
      }
      if (patch.reload === true) {           // 便于手工放一份 license.json 后热载
        loadLicense();
        return { ok: LICENSE.ok, why: LICENSE.why, state: licenseState() };
      }
      return { ok: false, why: '无有效动作（actCode / renew / reload）' };
    });

    startBeacon();
    startPlatformGameChannel();

    mainWindow = new BrowserWindow({
      width: 1280, height: 780,
      title: 'WebXR 直播接收端',
      backgroundColor: '#101014',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'preload.js'),  // 暴露 castCfg（GET/SET 游戏目录）
      },
    });
    // 纯净模式默认开（现场大屏只留画面）：--panels 强制完整面板便于现场排查，--pure 显式指定。
    const pureQ = hasFlag('panels') ? '?pure=0' : (hasFlag('pure') ? '?pure=1' : '');
    mainWindow.loadURL(`http://localhost:${usedPort}/__cast/index.html${pureQ}`);
    // --fullscreen：启动即全屏（配合 --pure 就是「开机即大屏」）。也可在界面内按 F 切换。
    if (hasFlag('fullscreen')) mainWindow.setFullScreen(true);
    mainWindow.on('closed', () => { mainWindow = null; });
  };
  tryListen(PORT, 0);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ————————————————————————— 启动授权（LaunchGuard） —————————————————————————
// 头显 APK 在「首次拉起」时来这里要一张放行条 —— 拿不到就一秒画面都不出（见 MainActivity.guardPass）。
// 协议（明文 HTTP，仅局域网；secret 用来防「同网段其它设备冒充头显」）：
//   APK  → POST /api/launch/request  {"dev":"<ANDROID_ID>","ts":"<毫秒>","sig":"<hex>"}
//   EXE  → {"allow":true,"voucher":"<hex>","ttl":60,"why":"白名单命中","server":<毫秒>}
//   sig = HMAC-SHA256(secret, dev + "|" + ts)，时间窗 ±30 秒（防重放）。
// 白名单：autoAllow=true 时首次请求即自动登记并放行；否则必须手动加入（UI 可增删）。
// voucher = HMAC-SHA256(secret, dev + "|" + exp)。★ 2026-09-23 起**已强制**：游戏页面拿
//   dev+exp+voucher 调 /api/master/allow 复验（浏览器算不出 HMAC，放行条是它唯一的凭据）。
//
// ★ 2026-09-23（平台对接）：新增门禁端点，APK 与游戏页面**共用同一条判据**（文档第 3 条）：
//   APK/页面 → POST /api/master/allow {"device":"…","ts":…,"sig":…}（或 {"device":…,"exp":…,"voucher":…}）
//   EXE      → {"allow":bool,"reason":"…","voucher":"…","ttl":…,"license":{…}}
//   判定都在 masterAllow() 里 —— **不要再各写一套**：「APK 放行了、页面却拒绝」这种现场事故
//   的根因就是两处判据各自演化。

// ── ★ 第十七修：三处定案（2026-09-20，需求方逐项拍板） ──
// ① secret 改为**两端固定的共享串**，不再随机。为什么必须固定：随机 secret 只能靠人工从本窗口
//    抄进头显配置页，而配置页入口在门禁**之内**（进得去才改得动）⇒ 抄不到 = 两端必然不一致
//    = 一律拒绝，且现场无法自救。实测 2026-09-20 15:08 正是如此：deny why=「HMAC 校验失败」。
//    安全边界改由「白名单 + 局域网隔离」承担。
//    ⚠ 必须与 APK `MainActivity.guardSecret()` 的默认值**逐字一致** —— 改一处就要改两处。
//    ★★ 2026-09-20 追加：本常量的角色已变 —— 需求方拍板「兜底 0 天 ⇒ 到期即停」，
//    因此它**不再是离线兜底**，只是「授权 proof 迁移完成前」的**过渡期临时鉴权**。
//    ⚠ 迁移完成后必须视为死代码并加显著注释，**绝不可重新启用为放行路径**
//      （否则授权服务器形同虚设，收到钱也拦不住人）。真正的门禁是 licenseGate()。
const GUARD_SECRET_DEFAULT = 'webxr-cast';

// 本次进程运行期间的「局号」。头显把它随下发配置一起存盘；下次启动时若发现本机存的局号与当前
// EXE 报的不一致 ⇒ 本地下发文件视为**已失效**、整包重下。等价于「退出即失活」，但不会在错误
// 时机真删文件（Activity 销毁时真删，会把平台重拉后正在跑的游戏页资源删掉）。
const SESSION_ID = crypto.randomBytes(4).toString('hex');

// 下发给头显的「轻量配置」清单（相对**游戏根目录**；目录以 / 结尾 = 整目录递归）。
// 只收文本类文件（.js/.mjs/.json/.txt/.md/.css/.html）且单文件 <512KB —— 重资源（GLB / 全景图）
// 仍留在 APK assets + 现有静态代理，否则每次启动都要传几十 MB。
// ⚠ 这些路径在**头显侧是「只认下发、不回落 assets」**的（见 GameServer 的 overlay 逻辑）——
//    它们就是「文件齐全才跑得起来」的那把锁，别把它改成可回落。
const CONFIG_MANIFEST = [
  'src/content/',
  'src/core/userConfig.js',
];
const CONFIG_MAX_FILE = 512 * 1024;      // 单个下发文件的大小上限（byte）
const CONFIG_TEXT_EXT = ['.js', '.mjs', '.json', '.txt', '.md', '.css', '.html'];

// ————————————————————————— 授权（License） —————————————————————————
// 三把钥匙（完整方案见 docs/tech/08-授权服务器与License方案.md）：
//   Ks     = 服务器签发私钥，**永不出服务器**（丢了所有已发 license 都无法续期）
//   Ks_pub = 签发公钥，**硬编码在两端**（下面的 LICENSE_PUBKEY_B64；公开信息，泄漏无害）
//   Ke     = 本 EXE 实例的私钥，落 userData/license-key.pem，**永不出本机**
//            —— 它让 license 无法被拷到别的机器上复用：出示时要签头显当场给的随机数。
//
// license 文本 = base64url(payloadJSON) + "." + base64url(签名)
// 签名对象 = 左边那串 base64url 文本本身（ASCII）；算法 ECDSA P-256 + SHA-256。
// ⚠ 不要给 crypto.sign/verify 传 dsaEncoding —— Node 对 ECDSA **默认就是 DER**，
//   与 Java `SHA256withECDSA` 天然对齐（实测：默认 70~71 字节；`ieee-p1363` 才是 64 字节定长）。
const LICENSE_BASE = argValue('license-url', 'https://webvr123.site');
const LICENSE_PATH = path.join(app.getPath('userData'), 'license.json');
const LICENSE_KEY_PATH = path.join(app.getPath('userData'), 'license-key.pem');
// ★ 生产签发公钥（来源 `GET https://webvr123.site/api/pubkey`，
//   fingerprint=4156b73a8b5d5e6aa7cda445 / derSha256 见 tools/_dist/pubkey-production.json）
//   ⚠ 换服务器密钥 = 两端都要重新打包。更新此常量**必须**用「程序取回 + 双哈希自证」的方式，
//     绝不能靠人眼转录 —— 实测手抄错 1 个字符时，长度/DER 字节数/SPKI 头/点前缀**全部校验通过**，
//     只有哈希对不上。
const LICENSE_PUBKEY_B64 = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEo6rcLRUG15wFPgi/uhimaEGB1geL+jf+pa5Ae2fOdunHRSjEq5ewOO0XvPasoF0QtrkEKrP3PkJoYQG4ycRlLg==';

const LICENSE_RENEW_LEAD_MS = 3 * 24 * 3600 * 1000;   // 到期前 3 天进入续期窗口（方案 §4.2）
const LICENSE_RENEW_INTERVAL_MS = 6 * 3600 * 1000;    // 每 6 小时检查一次
const LICENSE_SKEW_MS = 5 * 60 * 1000;                // 容忍 ±5 分钟时钟偏差（方案 §11.5）
const LICENSE_HTTP_TIMEOUT_MS = 8000;                 // 授权服务器请求超时

// ★ 兜底天数 = 0（2026-09-20 需求方拍板「到期即停」）★
//   含义：license 一旦过了 exp 就**停放行**，不再用第十七修的固定密钥兜底 ——
//   否则「授权服务器」形同虚设。代价是服务器成了硬单点，必须靠「剩余天数常显 + 一键续期」
//   + 服务器侧监控来兜运营风险（见 licenseState() 与界面上的授权面板）。
const LICENSE_GRACE_MS = 0;

const LICENSE = {
  text: '', payload: null, ok: false, why: '未加载',
  mode: 'none',            // none | active | expiring | expired | invalid
  lastRenewAt: 0, lastRenewWhy: '', lastCheckAt: 0, lastActivateAt: 0,
};

const b64uToBuf = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const bufToB64u = (b) => Buffer.from(b).toString('base64url');   // Node 16+ 原生（无填充）

/** 载入或生成本机实例密钥 Ke（P-256 / PKCS#8 PEM）。@return {{priv, ke}} ke=base64url(SPKI DER) */
function licenseKey() {
  if (!fs.existsSync(LICENSE_KEY_PATH)) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    fs.writeFileSync(LICENSE_KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.log(`[cast-pc] 已生成本机授权密钥 Ke：${LICENSE_KEY_PATH}`);
  }
  const priv = crypto.createPrivateKey(fs.readFileSync(LICENSE_KEY_PATH));
  return { priv, ke: bufToB64u(crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' })) };
}

/** 用 Ke 对文本签名 → base64url。出示 proof 与续期 proof 共用 */
function licenseSign(text) {
  return bufToB64u(crypto.sign('sha256', Buffer.from(String(text), 'utf8'), licenseKey().priv));
}

/**
 * 机器指纹 dev = sha256(hostname + '|' + CPU 型号 + '|' + 排序后的非内网 MAC 列表)。
 * 目的：同一台机器重启 / 换网线不变；整机搬走或克隆到别的机器就变。
 * ⚠ 已知副作用：**插拔网卡会改变 dev**（如从有线切到 Wi-Fi、临时插 USB 网卡）。
 *   真发生时表现为「需重新激活」——用界面上的激活码重来一次即可（幂等，服务器不重复消耗配额）。
 *   日志会打印 hostname 便于现场判断到底是哪一项变了。
 */
function machineFingerprint() {
  const macs = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets).sort()) {
    for (const ni of nets[name] || []) {
      if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') macs.push(ni.mac.toLowerCase());
    }
  }
  macs.sort();
  const cpu = (os.cpus()[0] && os.cpus()[0].model) || '';
  const parts = [os.hostname(), cpu, macs.join(',')];
  return { dev: crypto.createHash('sha256').update(parts.join('|')).digest('hex'), parts };
}

/**
 * 本地验证 license：Ks_pub 验签 + **ke 绑定本机**（P3 加固）+ nbf/exp 时间窗。**纯本地、不联网** ——
 * 所以断网也能正确判出「已到期」，这正是方案的硬要求。
 * @return {{ok:boolean, why:string, payload:object|null}}
 */
function verifyLicenseLocal(text) {
  const r = { ok: false, why: '', payload: null };
  const s = String(text || '').trim();
  if (!s) { r.why = '未激活（无 license）'; return r; }
  const dot = s.indexOf('.');
  if (dot <= 0 || dot >= s.length - 1) { r.why = 'license 格式不合法'; return r; }
  const body = s.slice(0, dot);
  try { r.payload = JSON.parse(b64uToBuf(body).toString('utf8')); }
  catch (e) { r.why = 'payload 解析失败'; return r; }
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(LICENSE_PUBKEY_B64, 'base64'), format: 'der', type: 'spki',
    });
    if (!crypto.verify('sha256', Buffer.from(body, 'ascii'), key, b64uToBuf(s.slice(dot + 1)))) {
      r.why = '签名验证失败（伪造，或内置 Ks_pub 与服务器不是同一对）';
      return r;
    }
  } catch (e) { r.why = '验签异常：' + e.message; return r; }

  // ★ P3 加固（2026-09-20）：license 还必须**属于本机**。
  //   原先只验 Ks 签名 + 时间窗，不绑定本机身份 ⇒ 把 license.json 连同 license-key.pem 一起拷到
  //   另一台机器，**本机界面会显示「授权有效、剩余 N 天」**，而头显要到第 ⑤ 步（用 license 里声明的
  //   ke 验 proof）才拒绝 —— 现场看到「EXE 说没问题、头显说过不去」，几乎无法判读。
  //   这里补一条**确定性**的绑定：license 里声明的 ke 必须等于本机 Ke 的公钥。
  //   ⚠ 刻意**不**在这里绑 dev（机器指纹）：dev 的稳定性（换网线 / 重启是否漂移）尚未按方案 §11.3
  //   做过「重启 3 次比对」，过早绑定会把「网络变化」变成「莫名其妙要求重新激活」。
  //   （头显侧无法做这条检查 —— 它不知道 PC 的指纹，所以「防拷贝」的权威判据仍是头显的第 ⑤ 步。）
  try {
    const mine = licenseKey().ke;
    const claimed = String(r.payload.ke || '');
    if (claimed !== mine) {
      r.why = 'license 属于另一台机器（ke 不匹配）→ 请在本机重新激活';
      return r;
    }
  } catch (e) { r.why = '无法读取本机实例密钥：' + e.message; return r; }
  const now = Date.now();
  if (Number(r.payload.nbf || 0) && now + LICENSE_SKEW_MS < Number(r.payload.nbf)) {
    r.why = 'license 尚未生效（本机时钟偏慢？）'; return r;
  }
  if (Number(r.payload.exp || 0) && now - LICENSE_SKEW_MS > Number(r.payload.exp) + LICENSE_GRACE_MS) {
    r.why = 'license 已到期'; return r;
  }
  r.ok = true; r.why = '有效';
  return r;
}

function applyLicense() {
  const r = verifyLicenseLocal(LICENSE.text);
  LICENSE.ok = r.ok; LICENSE.why = r.why; LICENSE.payload = r.payload;
  if (!LICENSE.text) LICENSE.mode = 'none';
  else if (!r.ok) LICENSE.mode = r.why.indexOf('到期') >= 0 ? 'expired' : 'invalid';
  else {
    const left = Number((r.payload && r.payload.exp) || 0) - Date.now();
    LICENSE.mode = left < LICENSE_RENEW_LEAD_MS ? 'expiring' : 'active';
  }
}

function loadLicense() {
  try { LICENSE.text = fs.readFileSync(LICENSE_PATH, 'utf8').trim(); }
  catch (e) { LICENSE.text = ''; }        // 文件不存在 = 尚未激活
  applyLicense();
}

function saveLicenseText(text) {
  LICENSE.text = String(text || '').trim();
  fs.writeFileSync(LICENSE_PATH, LICENSE.text, 'utf8');
  applyLicense();
}

/** 供 UI / /api/info / /api/license/current 读的状态快照 */
function licenseState() {
  const p = LICENSE.payload || {};
  const exp = Number(p.exp || 0);
  const mf = machineFingerprint();
  return {
    ok: LICENSE.ok, mode: LICENSE.mode, why: LICENSE.why,
    lic: p.lic || '', cust: p.cust || '', exp, iat: Number(p.iat || 0),
    daysLeft: exp ? Math.floor((exp - Date.now()) / 86400000) : 0,
    hoursLeft: exp ? Math.floor((exp - Date.now()) / 3600000) : 0,
    devShort: mf.dev.slice(0, 12),
    host: mf.parts[0],
    base: LICENSE_BASE,
    grace: LICENSE_GRACE_MS,
    lastRenewAt: LICENSE.lastRenewAt, lastRenewWhy: LICENSE.lastRenewWhy,
    lastCheckAt: LICENSE.lastCheckAt, keyPath: LICENSE_KEY_PATH, licensePath: LICENSE_PATH,
  };
}

/**
 * HTTPS POST（**严格校验证书** —— 绝不写 rejectUnauthorized:false，那等于给中间人开门）。
 * @return {Promise<{ok:boolean, status?:number, body?:object, why:string}>}
 */
function licensePost(pathname, bodyObj) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(pathname, LICENSE_BASE); }
    catch (e) { return resolve({ ok: false, why: '授权服务器地址非法：' + LICENSE_BASE }); }
    const data = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const req = https.request({
      hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search,
      method: 'POST', timeout: LICENSE_HTTP_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch (e) { /* 保持 null */ }
        const httpOk = res.statusCode >= 200 && res.statusCode < 300;
        resolve({
          ok: httpOk && !!(body && body.ok), status: res.statusCode, body,
          why: body ? String(body.detail || body.reason || '') : ('HTTP ' + res.statusCode),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`超时 ${LICENSE_HTTP_TIMEOUT_MS}ms`)));
    req.on('error', (e) => resolve({ ok: false, why: '连接失败：' + e.message }));
    req.end(data);
  });
}

/** 激活：用激活码换第一份 license（后台生成激活码 → 装机时填。同机重复激活幂等，不重复消耗配额） */
async function licenseActivate(code) {
  const { ke } = licenseKey();
  const actCode = String(code || '').trim().toUpperCase();
  if (!actCode) return { ok: false, why: '请先填写激活码' };
  const r = await licensePost('/api/license/activate', {
    actCode, dev: machineFingerprint().dev, ke, host: os.hostname(),
  });
  if (!r.ok || !r.body || !r.body.license) {
    LICENSE.lastRenewWhy = '激活失败：' + (r.why || '未知');
    return { ok: false, why: LICENSE.lastRenewWhy };
  }
  const v = verifyLicenseLocal(r.body.license);
  if (!v.ok) return { ok: false, why: '服务器返回的 license 验签失败：' + v.why };
  saveLicenseText(r.body.license);
  LICENSE.lastActivateAt = Date.now();
  LICENSE.lastRenewWhy = r.body.idempotent ? '已激活（重复激活，幂等命中）' : '激活成功';
  console.log(`[cast-pc] 激活${r.body.idempotent ? '幂等命中' : '成功'} lic=${v.payload.lic}`
      + ` 客户=${v.payload.cust || '-'} 到期=${new Date(v.payload.exp).toLocaleString()}`);
  return { ok: true, why: LICENSE.lastRenewWhy, state: licenseState() };
}

/** 续期：用 Ke 签 proof 换新 license。失败**只记日志、不阻塞启动**（方案 §6 要求） */
async function licenseRenew(reason) {
  if (!LICENSE.text || !LICENSE.payload) return { ok: false, why: '未激活，无法续期' };
  const lic = String(LICENSE.payload.lic || '');
  const ts = Date.now();
  const r = await licensePost('/api/license/renew', {
    lic, dev: machineFingerprint().dev, ke: licenseKey().ke, ts,
    proof: licenseSign(`renew|${lic}|${ts}`),
  });
  LICENSE.lastRenewAt = Date.now();
  if (!r.ok || !r.body || !r.body.license) {
    LICENSE.lastRenewWhy = '续期失败：' + (r.why || '未知');
    console.warn(`[cast-pc] 续期失败（${reason}）：${LICENSE.lastRenewWhy}`);
    return { ok: false, why: LICENSE.lastRenewWhy };
  }
  const v = verifyLicenseLocal(r.body.license);
  if (!v.ok) { LICENSE.lastRenewWhy = '续期返回的 license 验签失败：' + v.why; return { ok: false, why: LICENSE.lastRenewWhy }; }
  saveLicenseText(r.body.license);
  LICENSE.lastRenewWhy = '续期成功';
  console.log(`[cast-pc] 续期成功（${reason}）lic=${lic} 新到期=${new Date(v.payload.exp).toLocaleString()}`);
  return { ok: true, state: licenseState() };
}

/** 启动跑一次，之后每 6 小时一次；只在「进入续期窗口 / 已过期」时才真去联网 */
function startLicenseWatch() {
  const tick = async (reason) => {
    LICENSE.lastCheckAt = Date.now();
    if (!LICENSE.text) {
      console.log('[cast-pc] 授权：未激活 —— 头显会被拒绝，请在本窗口填入激活码');
      return;
    }
    if (LICENSE.mode === 'invalid') {
      console.warn(`[cast-pc] 授权无效（${LICENSE.why}）—— 需要重新激活`);
      return;
    }
    const exp = Number((LICENSE.payload && LICENSE.payload.exp) || 0);
    if (exp && Date.now() < exp - LICENSE_RENEW_LEAD_MS) {
      console.log(`[cast-pc] 授权有效，剩余 ${Math.floor((exp - Date.now()) / 86400000)} 天（未进入续期窗口，不联网）`);
      return;
    }
    await licenseRenew(reason);
  };
  tick('启动');
  setInterval(() => { tick('周期'); }, LICENSE_RENEW_INTERVAL_MS);
  console.log(`[cast-pc] 授权看护已启动（每 ${LICENSE_RENEW_INTERVAL_MS / 3600000}h 一次`
      + `，到期前 ${LICENSE_RENEW_LEAD_MS / 86400000} 天开始续期）`);
}

/**
 * 门禁总闸（★ 兜底 0 天）：直播端自己授权不合法时**一律拒绝服务**。
 * 故意排在 guardVerify 之前 —— 这样「EXE 没授权」与「头显没授权」是两条独立判据，
 * 现场看返回的 why 就能区分到底该修哪一端。
 * @return {string|null} null = 放行；否则为拒绝原因
 */
function licenseGate() {
  if (LICENSE.ok) return null;
  return LICENSE.text
    ? `直播端授权不可用：${LICENSE.why}`
    : '直播端未激活：请在接收端界面填入激活码';
}

/**
 * GET /api/license/current?nonce=<hex> —— **无需鉴权**。
 * license 本身就是「给人看」的凭据（像身份证）；安全性不来自保密，而来自：
 *   ① license 由 Ks 签名 ⇒ 伪造不了（头显用内置 Ks_pub 验）；
 *   ② proof = Ke_sign("cast|<nonce>")，绑头显当场给的随机数 ⇒ 拷走 license 到别的 EXE 上
 *      过不了这一关（那台机器没有 Ke 私钥）。
 */
function handleLicenseCurrent(req, res) {
  const q = (() => { try { return new URL(req.url, 'https://x').searchParams; } catch (e) { return new URLSearchParams(''); } })();
  const nonce = String(q.get('nonce') || '').replace(/[^0-9a-fA-F]/g, '').slice(0, 64);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  const st = licenseState();
  if (!LICENSE.ok || !nonce) {
    return res.end(JSON.stringify({ ok: false, nonce, why: nonce ? st.why : '缺少 nonce（头显必须给随机数）', state: st }));
  }
  res.end(JSON.stringify({
    ok: true,
    license: LICENSE.text,
    nonce,
    proof: licenseSign('cast|' + nonce),
    state: { lic: st.lic, cust: st.cust, exp: st.exp, daysLeft: st.daysLeft },
  }));
}

const GUARD = { secret: '', allowList: [], autoAllow: false, log: [] };

function loadGuard() {
  const cfg = loadConfig();
  // ★ 第十七修：固定共享密钥（见上方 GUARD_SECRET_DEFAULT 注释），已不再随机生成。
  GUARD.secret = GUARD_SECRET_DEFAULT;
  GUARD.allowList = Array.isArray(cfg.allowList) ? cfg.allowList.slice() : [];
  // ★「配对窗口」：白名单为空 = 还没配对过任何设备 ⇒ **必须**允许自动登记首台，否则名单永远空着、
  //   谁都进不来。历史教训：「随机 secret + 空白名单 + 自动登记关」三者叠加 = 直接锁死自己。
  //   一旦登记过设备，名单非空 ⇒ 回到按配置决定（默认关），安全性改由白名单守。
  const pairing = GUARD.allowList.length === 0;
  GUARD.autoAllow = pairing ? true : (cfg.autoAllow === true);
  if (cfg.guardSecret !== GUARD.secret) cfg.guardSecret = GUARD.secret;   // 迁移掉历史随机值
  saveGuard();
  console.log('==================================================');
  console.log('[cast-pc] 启动授权已启用：固定共享密钥（两端内置同一个串，现场无需抄写）');
  console.log(`[cast-pc] 本局局号 session=${SESSION_ID}（每次 EXE 启动都换 ⇒ 头显会重新下发配置）`);
  console.log(`[cast-pc] 白名单 ${GUARD.allowList.length} 台，自动登记=${GUARD.autoAllow ? '开' : '关'}`
      + (pairing ? '　★ 配对窗口：白名单为空，首个来请求的设备将自动登记' : ''));
  console.log(`[cast-pc] 配置下发清单 ${CONFIG_MANIFEST.length} 项：${CONFIG_MANIFEST.join('  ')}`);
  if (!GAME_ROOT) {
    console.log('[cast-pc] ⚠ 未配置游戏目录 → /api/config/dump 将失败，头显会拒绝启动');
    console.log('[cast-pc]   在本窗口「游戏目录」处设置游戏项目根目录后重启 EXE');
  }
  // ★ 授权（License）：本机 Ke + license 落盘文件 + 到期状态。兜底 0 天 ⇒ 这里不合法就是停放行。
  loadLicense();
  const ls = licenseState();
  console.log(`[cast-pc] 设备指纹 dev=${ls.devShort}…（hostname=${ls.host}） 授权服务器=${ls.base}`);
  if (ls.mode === 'none') {
    console.log('[cast-pc] ⚠ 授权：**未激活** —— 头显会被拒绝，请在本窗口填入激活码');
  } else if (ls.ok) {
    console.log(`[cast-pc] 授权：${ls.mode === 'expiring' ? '即将到期' : '有效'}`
        + ` lic=${ls.lic} 客户=${ls.cust || '-'} 剩余 ${ls.daysLeft} 天（到期 ${new Date(ls.exp).toLocaleString()}）`);
  } else {
    console.log(`[cast-pc] ⚠ 授权不可用：${ls.why} —— 头显会被拒绝`);
  }
  console.log('==================================================');
  startLicenseWatch();
}

function saveGuard() {
  const cfg = loadConfig();
  cfg.guardSecret = GUARD.secret;
  cfg.allowList = GUARD.allowList;
  cfg.autoAllow = GUARD.autoAllow;
  saveConfig(cfg);
}

function guardSig(dev, ts) {
  return crypto.createHmac('sha256', GUARD.secret).update(`${dev}|${ts}`).digest('hex');
}

function guardVoucher(dev, exp) {
  return crypto.createHmac('sha256', GUARD.secret).update(`${dev}|${exp}`).digest('hex');
}

/** 放行条有效期（毫秒）。头显拿它换「允许运行」结论，游戏页面也用它做第二道校验。 */
const GUARD_VOUCHER_TTL_MS = 60000;

/**
 * 校验「放行条」。为什么需要它：游戏页面跑在**头显浏览器**里，没有 secret、算不出 HMAC 签名，
 * 但它在启动时能从 APK/EXE 那里拿到一张 voucher ⇒ 用它代替 dev|ts|sig 走**同一套白名单判定**，
 * 页面不必知道 secret。这样「页面侧第二道门禁」才可能与 APK 同源，而不是各判各的。
 * @return {{at:number,ip:string,dev:string,allow:boolean,why:string}}
 */
function guardVerifyVoucher(ip, dev, exp, voucher) {
  const entry = { at: Date.now(), ip, dev, allow: false, why: '' };
  if (!dev || !exp || !voucher) {
    entry.why = '放行条参数缺失（dev/exp/voucher 必填）';
  } else if (!Number.isFinite(Number(exp)) || Number(exp) < Date.now()) {
    entry.why = '放行条已过期（在平台里重新点一次「启动」）';
  } else if (guardVoucher(dev, Number(exp)) !== voucher) {
    entry.why = '放行条校验失败（secret 不一致？）';
  } else {
    entry.allow = true;
    entry.why = '放行条命中';
  }
  return entry;
}

function guardPush(entry) {
  GUARD.log.unshift(entry);
  GUARD.log = GUARD.log.slice(0, 50);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('guard:log', entry);
}

function handleLaunchRequest(req, res) {
  const ip = clientIp(req);
  readJsonBody(req, 4096, (body) => {
    // 判定走**唯一出口** masterAllow（授权总闸 + 凭据 + 白名单都在里面），这里只负责把结论
    // 翻译成 APK 既有的字段名（why），并签发放行条。**不要再在这里加判据** —— 见 masterAllow 注释。
    // ⚠ requireRound:false —— 这一步是「头显想连本机」，不是「这一局要开始了」。
    //   若在这里也要求「已开始本局」，头显就永远拉不起页面，操作员连等待界面都看不到。
    const r = masterAllow(ip, body, { requireRound: false });
    guardPush(r.entry);
    console.log(`[cast-pc] 启动授权 ${r.allow ? 'ALLOW' : 'DENY '} dev=${r.entry.dev || '(空)'} ip=${ip} why=${r.reason}`);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    // session：本局局号。头显把它存进下发配置里；下次启动若对不上就整包重下（见「局号失效」注释）。
    // exp 一并回给头显：它拿 dev+exp+voucher 就能在**页面侧**向 /api/master/allow 复验同一张条子。
    res.end(JSON.stringify({
      allow: r.allow, voucher: r.voucher, ttl: r.ttl, exp: r.entry.exp || null,
      why: r.reason, reason: r.reason,
      session: SESSION_ID, server: Date.now(),
    }));
  });
}

/**
 * POST /api/master/allow —— 「允许运行」门禁（《打包和平台对接》第 3 条）。
 *
 * <p>APK（UDP 发现到 PC、**拉起浏览器之前**）与游戏页面（**进 VR 之前**）共用这一个端点。
 * 与 `/api/launch/request` 是**同一套判据**（都走 masterAllow），区别只在调用时机与字段名：
 * 这里回 `reason` 并附带 `license` 摘要，为后续「授权即门禁」预留。
 *
 * <p>请求（二选一）：
 *   APK ：`{"device":"<dev>","ts":<毫秒>,"sig":"<hex>","room":"<房间号，可选>"}`
 *   页面：`{"device":"<dev>","exp":<毫秒>,"voucher":"<hex>","room":"…"}`
 * @return {{allow:boolean, reason:string, session:string, room:string|null, license:object}}
 */
function handleMasterAllow(req, res) {
  const ip = clientIp(req);
  readJsonBody(req, 4096, (body) => {
    const r = masterAllow(ip, body);
    // room 只是留痕维度：单路观众（现场一台 PC 大屏），房间号不参与放行判定。
    const room = String((body && body.room) || PLATFORM_ARGS.room || '');
    r.entry.room = room;
    guardPush(r.entry);
    console.log(`[cast-pc] 门禁查询 ${r.allow ? 'ALLOW' : 'DENY '} dev=${r.entry.dev || '(空)'}`
      + ` ip=${ip} room=${room || '-'} why=${r.reason}`);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      allow: r.allow, reason: r.reason, voucher: r.voucher, ttl: r.ttl,
      session: SESSION_ID, room: room || null, server: Date.now(),
      // ★ 第十八修：把「本轮是否已开始」一并回去 —— 页面据此把「正常等待开始」与「授权没过」
      //   两种拦分开提示（见 src/main.js 的 applyVRGate）。
      round: roundSnapshot(),
      license: licenseSummary(),
    }));
  });
}

// ——————————————————————— 配置下发（GET /api/config/dump） ———————————————————————
/**
 * 把 CONFIG_MANIFEST 展开成「相对路径 → 内容 + sha256」，供已授权的头显整包取走。
 *
 * <p>为什么这一步是**门禁的一部分**而不是"顺便同步一下文件"：头显侧对这些路径是
 * **只认下发、不回落 assets** 的（见 GameServer 的 overlay 分支）⇒ 没经过授权就拿不到它们
 * ⇒ 游戏连关卡定义都读不到，根本跑不起来。这比「校验通过就放行」硬得多。
 *
 * @return {Array<{path:string,sha256:string,size:number,content:string}>}
 * @throws  {Error} 游戏目录未配置 / 清单展开后为空
 */
function buildConfigDump() {
  if (!GAME_ROOT) throw new Error('未配置游戏目录（在本窗口「游戏目录」处设置后重启 EXE）');
  const out = [];
  const push = (abs, rel) => {
    const ext = path.extname(rel).toLowerCase();
    if (!CONFIG_TEXT_EXT.includes(ext)) return;              // 非文本类一律跳过
    const st = fs.statSync(abs);
    if (st.size > CONFIG_MAX_FILE) return;                   // 大文件跳过（重资源不走下发）
    const buf = fs.readFileSync(abs);
    out.push({
      path: rel.split(path.sep).join('/'),
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      size: buf.length,
      content: buf.toString('utf8'),
    });
  };
  const walk = (rel) => {
    const abs = path.join(GAME_ROOT, rel);
    if (!fs.existsSync(abs)) { console.warn(`[cast-pc] 下发清单项不存在，已跳过：${rel}`); return; }
    if (fs.statSync(abs).isDirectory()) {
      for (const n of fs.readdirSync(abs).sort()) walk(path.join(rel, n));
    } else {
      push(abs, rel);
    }
  };
  for (const item of CONFIG_MANIFEST) walk(item);
  if (!out.length) throw new Error('下发清单展开后为空（检查游戏目录 / CONFIG_MANIFEST）');
  return out;
}

function handleConfigDump(req, res) {
  const ip = clientIp(req);
  const q = (() => { try { return new URL(req.url, 'https://x').searchParams; } catch (e) { return new URLSearchParams(''); } })();
  const json = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  // ★ 门禁总闸（兜底 0 天）：与 launch/request 同一条判据 —— 少一处就会留下后门。
  const gate = licenseGate();
  if (gate) {
    guardPush({ at: Date.now(), ip, dev: String(q.get('dev') || ''), allow: false, why: gate + '（配置下发）' });
    console.log(`[cast-pc] 配置下发 DENY dev=${q.get('dev') || '(空)'} ip=${ip} why=${gate}`);
    return json({ allow: false, session: SESSION_ID, why: gate });
  }
  const entry = guardVerify(ip, { dev: q.get('dev'), ts: q.get('ts'), sig: q.get('sig') });
  if (!entry.allow) {
    entry.why += '（配置下发）';
    guardPush(entry);
    console.log(`[cast-pc] 配置下发 DENY dev=${entry.dev || '(空)'} ip=${ip} why=${entry.why}`);
    return json({ allow: false, session: SESSION_ID, why: entry.why });
  }
  let files;
  try {
    files = buildConfigDump();
  } catch (e) {
    console.error(`[cast-pc] 配置下发失败：${e.message}`);
    return json({ allow: false, session: SESSION_ID, why: '配置下发失败：' + e.message });
  }
  const bytes = files.reduce((a, f) => a + f.size, 0);
  entry.why += '（配置下发）';
  guardPush(entry);
  console.log(`[cast-pc] 配置下发 ALLOW dev=${entry.dev} 局号=${SESSION_ID} 文件=${files.length} 共 ${bytes}B`);
  // 一律回全量内容：清单只有 ~20KB（重资源不在此列），省一次「先清单后内容」的往返，
  // 少一个失败模式比省几十毫秒重要。
  json({ allow: true, session: SESSION_ID, count: files.length, bytes, files });
}

/** 客户端 IP（去掉 IPv6 映射前缀） */
function clientIp(req) {
  return String(req.socket.remoteAddress || '').replace('::ffff:', '');
}

/** 读 JSON 请求体（超限直接 destroy；解析失败按空对象处理 → 走「参数缺失」分支） */
function readJsonBody(req, limit, cb) {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > limit) req.destroy(); });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { /* 走「参数缺失」分支 */ }
    cb(body);
  });
}

/** 授权状态摘要（廉价版：不枚举网卡算指纹，可高频调用）。 */
function licenseSummary() {
  return {
    ok: LICENSE.ok, mode: LICENSE.mode, why: LICENSE.why,
    daysLeft: (LICENSE.payload && LICENSE.payload.exp)
      ? Math.floor((LICENSE.payload.exp - Date.now()) / 86400000) : 0,
  };
}

/**
 * ★ 门禁总判定 —— **唯一出口**（2026-09-23 平台对接新增）。
 *
 * <p>`/api/launch/request`（头显 APK）与 `/api/master/allow`（APK + 游戏页面共用）都调它，
 * 免得两套判据各自演化后出现「一边放行、一边拒绝」的现场事故 —— 本项目历史上真发生过
 * （见文件头「第十七修」：secret 随机化 + 空白名单 + 自动登记关 = 直接把自己锁死）。
 *
 * <p>判据顺序 = 优先级：
 *   ① 本机授权 licenseGate() —— EXE 自己授权不合法就一律拒，连凭据都不看；
 *   ② 凭据：dev+ts+sig（HMAC，APK 用）**或** dev+exp+voucher（放行条，页面用）；
 *   ③ 白名单命中 / 配对窗口自动登记。
 *
 * @param {string} ip 客户端 IP（仅留痕）
 * @param {object} body {device|dev, ts, sig} 或 {device|dev, exp, voucher}，可选 room
 * @return {{allow:boolean, reason:string, entry:object, voucher:string|null, ttl:number}}
 */
// ——————————————————— 本局放行（「开始本局 / 结束本局」）———————————————————
/**
 * 本局是否已由平台 / 主控端放行。**这是「等平台发开始游戏信号」的落地物**：
 * 头显页面每 2 秒问一次 /api/master/allow，只有这里为 true 才给「进入 VR」按钮。
 *
 * 为什么要有它（用户 2026-09-23 现场实测两条）：
 *   · 「第一次头显连上 PC 端后，我可以直接点进去 VR」—— 旧的 ?plat=1 判据（APK 拉起页面）
 *     把「拉起」当成了「开始游戏」，太早；
 *   · 「第二次开游戏…头显上提示重试连接主控端」—— 放行条 TTL 只有 60 秒，第二局必然过期。
 *
 * ★ 第二十修（2026-09-23 晚，用户第五次实测后定稿）：**放行的唯一权威来源 = 平台点「开始游戏」**
 *   = 游戏通道 `CMD 5 GameStart`（UDP 51124），见 startPlatformGameChannel()。
 *   三个入口都只走 roundSet()：
 *     ① 平台 GameStart —— **主路径**，本 EXE 就是平台登记并拉起的那台机器上的游戏进程，
 *        平台把这一帧发给本机 51124（抓包实录 20:49:56 `.237:58734 -> .237:51124`）；
 *     ② 头显页面把收到的同一帧回报过来（POST /api/round/start）—— 平台把它发给头显时的兜底；
 *     ③ PC 界面上的「▶ 开始本局」—— 现场排练 / 平台不在场时的手动口子。
 *   ⚠ 「EXE 被平台拉起」（第一步「启动游戏」）**不再**作为放行依据，见 PLATFORM_LAUNCHED。
 */
const ROUND = {
  armed: false,     // ★ 必须从 false 起：平台还没点「开始游戏」时，头显不能出现「进入 VR」
  at: 0,
  seq: 0,
};
const ROUND_IDLE_WHY = '尚未开始本局（等平台点「开始游戏」；或在 PC 主控端点「开始本局」）';

function roundSnapshot() { return { armed: ROUND.armed, at: ROUND.at, seq: ROUND.seq }; }

/**
 * 开/关「本局放行」。**唯一**入口：PC 界面按钮、页面 /api/round/end 上报都走它。
 * 状态没变时只打日志、不广播（避免轮询把它刷成噪声）。
 * @param {boolean} on
 * @param {string} why 谁按的（进日志，现场对账用）
 */
function roundSet(on, why) {
  const next = !!on;
  if (next !== ROUND.armed) {
    ROUND.armed = next;
    if (next) { ROUND.at = Date.now(); ROUND.seq += 1; }
    console.log(`[cast-pc] 本局放行 ` + (next ? '已开启 → 头显将出现「进入 VR」' : '已结束 → 头显收尾') + `（` + why + `）`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('round:changed', { ...roundSnapshot(), why });
    }
  } else {
    console.log(`[cast-pc] 本局放行：状态未变（` + why + `）`);
  }
  return roundSnapshot();
}

/** POST /api/round/end —— 画面侧上报「本局已结束」→ 收回本局放行（见 game.js 的 _tellMasterRoundEnd）。 */
function handleRoundEnd(req, res) {
  readJsonBody(req, 2048, (body) => {
    const why = String((body && body.why) || '本局结束').slice(0, 80);
    const r = roundSet(false, '画面侧上报：' + why);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, round: r }));
  });
}

/**
 * POST /api/round/start —— 画面侧上报「**平台已开始本局**」（第二十修）。
 *
 * 与 handleRoundEnd 对称。用途：平台的开局帧（游戏通道 CMD 5）**可能只发给 PC 那台机器**
 * （抓包实测如此），也可能同时发给头显 —— 头显侧收到时立刻回报一声，PC 的「本局进行中」
 * 状态与推流就与平台同步（否则 PC 界面会显示成「还没开始」，操作员会困惑）。
 * 谁先到算谁：本端自己收到那一帧时走的是 startPlatformGameChannel → roundSet(true)。
 */
function handleRoundStart(req, res) {
  readJsonBody(req, 2048, (body) => {
    const why = String((body && body.why) || '平台已开始本局').slice(0, 80);
    const r = roundSet(true, '画面侧上报：' + why);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, round: r }));
  });
}

/**
 * ★ 门禁总判定 —— **唯一出口**（2026-09-23 平台对接新增；第十八修加「本局放行」一档）。
 *
 * <p>调用方与要求：
 *   · /api/launch/request（头显 APK 拉起浏览器之前）→ **requireRound:false** —— 这一步只证明
 *     「头显想连本机、且凭据可信」，**不是**「这一局要开始了」（那由操作员点「开始本局」决定）。
 *     若这里也要求「已开始本局」，头显就永远拉不起页面 → 操作员连等待界面都看不到。
 *   · /api/master/allow（APK + 游戏页面）→ requireRound:true（默认）—— 这是进 VR 前的门禁。
 *
 * <p>判据顺序 = 优先级：
 *   ① 本机授权 licenseGate() —— EXE 自己授权不合法就一律拒，连凭据都不看；
 *   ② 设备凭据（三选一）：dev+ts+sig（HMAC，APK）｜dev+exp+voucher（放行条）｜**仅 device**
 *      （第十八修的页面轮询：设备须在白名单里或已开自动登记）；
 *   ③ 本局放行 ROUND.armed（仅当 requireRound）—— 操作员点了「开始本局」。
 *
 * @param {string} ip 客户端 IP（仅留痕）
 * @param {object} body {device|dev, ts, sig} 或 {device|dev, exp, voucher} 或 {device|dev}
 * @param {{requireRound?:boolean}} [opts]
 * @return {{allow:boolean, reason:string, entry:object, voucher:string|null, ttl:number}}
 */
function masterAllow(ip, body, { requireRound = true } = {}) {
  // device 是《打包和平台对接》里的字段名，dev 是本项目历史字段名 —— 两个都认，免得调用方记错。
  const dev = String((body && (body.device || body.dev)) || '');
  const deny = (entry) => ({ allow: false, reason: entry.why, entry, voucher: null, ttl: 0 });
  const roundOk = (entry) => {
    if (requireRound && !ROUND.armed) { entry.allow = false; entry.why = ROUND_IDLE_WHY; return false; }
    return true;
  };

  const gate = licenseGate();
  if (gate) {
    const entry = { at: Date.now(), ip, dev, allow: false, why: gate };
    return { allow: false, reason: gate, entry, voucher: null, ttl: 0 };
  }

  // ②-a 放行条路径（历史上给游戏页面做独立复验；第十八修后页面改成轮询、不再带放行条，
  //     这条留给外部复验）
  if (body && body.voucher && dev) {
    const entry = guardVerifyVoucher(ip, dev, Number(body.exp || 0), String(body.voucher));
    if (!entry.allow) return deny(entry);
    if (!roundOk(entry)) return deny(entry);
    return { allow: true, reason: entry.why, entry, voucher: null, ttl: 0 };
  }

  // ②-b 签名路径（头显 APK）
  if (body && body.ts && body.sig) {
    const entry = guardVerify(ip, { dev, ts: String(body.ts), sig: String(body.sig) });
    if (!entry.allow) return deny(entry);
    if (!roundOk(entry)) return deny(entry);
    entry.exp = Date.now() + GUARD_VOUCHER_TTL_MS;
    const voucher = guardVoucher(entry.dev, entry.exp);
    return { allow: true, reason: entry.why, entry, voucher, ttl: Math.round(GUARD_VOUCHER_TTL_MS / 1000) };
  }

  // ②-c 只有设备号（第十八修）：**页面轮询**「本局放行了吗」。
  //     没有设备号（页面不是 APK 托管：PCVR / 直连诊断）时只认「本局放行」—— 此时入口就在
  //     PC 本机上，且必须操作员先放行，风险可接受。
  const entry = { at: Date.now(), ip, dev, allow: false, why: '' };
  if (!dev) {
    entry.why = '未带设备号（PCVR / 直连诊断）—— 只按「本局放行」判定';
  } else if (GUARD.allowList.includes(dev)) {
    entry.why = '白名单命中';
  } else if (GUARD.autoAllow) {
    GUARD.allowList.push(dev);
    saveGuard();
    entry.why = GUARD.allowList.length === 1 ? '配对窗口：自动登记首台设备' : '自动登记并放行（新设备）';
  } else {
    entry.why = '设备不在白名单（且未开启自动登记）';
    return deny(entry);
  }
  if (!roundOk(entry)) return deny(entry);
  entry.allow = true;
  return { allow: true, reason: entry.why, entry, voucher: null, ttl: 0 };
}

/**
 * 授权判定（`/api/launch/request` 与 `/api/config/dump` **共用同一套**，避免两处判据漂移）。
 * 判定顺序即优先级：参数 → 时间窗 → HMAC → 白名单 → 自动登记。**HMAC 必须排在白名单之前**，
 * 否则「不知道 secret 的设备」也能靠白名单/自动登记混进来。
 * @return {{at:number,ip:string,dev:string,allow:boolean,why:string,exp?:number}} 已判定、未写日志的条目
 */
function guardVerify(ip, body) {
  const dev = String((body && body.dev) || '');
  const ts = String((body && body.ts) || '');
  const sig = String((body && body.sig) || '');
  const ageMs = Math.abs(Date.now() - Number(ts));
  const entry = { at: Date.now(), ip, dev, allow: false, why: '' };

  if (!dev || !ts || !sig) {
    entry.why = '参数缺失（dev/ts/sig 必填）';
  } else if (!Number.isFinite(ageMs) || ageMs > 30000) {
    entry.why = `时间戳超窗（${Math.round(ageMs / 1000)}s > 30s）`;
  } else if (guardSig(dev, ts) !== sig) {
    entry.why = 'HMAC 校验失败（secret 不一致？）';
  } else if (GUARD.allowList.includes(dev)) {
    entry.allow = true;
    entry.why = '白名单命中';
  } else if (GUARD.autoAllow) {
    GUARD.allowList.push(dev);
    saveGuard();
    entry.allow = true;
    entry.why = GUARD.allowList.length === 1
      ? '配对窗口：自动登记首台设备'
      : '自动登记并放行（新设备）';
  } else {
    entry.why = '设备不在白名单（且未开启自动登记）';
  }
  return entry;
}

// ————————————————————————— 局域网发现信标 —————————————————————————
// 周期性 UDP 组播通告本机接收端地址，头显微端 APK 监听即可自动发现，免手动输入。
// 组播组 224.0.0.100:8444，每 2 秒广播一次 "WEBXR-CAST:<业务端口>"。
function startBeacon() {
  const DISCOVERY_PORT = 8444;
  const GROUP = '224.0.0.100';
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.bind(() => { try { sock.setBroadcast(true); } catch (e) { /* ignore */ } });
  const msg = Buffer.from(`WEBXR-CAST:${PORT}`);
  const send = () => sock.send(msg, 0, msg.length, DISCOVERY_PORT, GROUP, (err) => {
    if (err) console.error('[cast-pc] beacon 发送失败:', err.message);
  });
  send();
  setInterval(send, 2000);
  console.log(`[cast-pc] 局域网发现信标已开启（组 ${GROUP}:${DISCOVERY_PORT}，每 2s 广播）`);
}

// ————————————————————— 平台游戏通道（UDP 51124）—————————————————————
/**
 * ★ 第二十修（2026-09-23）：**平台「开始游戏」的接收端**。
 *
 * <h3>为什么 PC 端要收这个通道</h3>
 * 平台操作员是**两步**（用户现场实测 + 抓包逐帧一致）：
 *   ① 「启动游戏」→ 启动器通道 `{"cmd":"start",...}` → 拉起本 EXE + 头显里的游戏（APK）；
 *   ② 「开始游戏」→ **游戏通道 `CMD 5 GameStart`（UDP 51124）** ← **这一步才是开局信号**。
 * 抓包（`平台指令/VRPlatform-流量取证/pcap-game_channel`）实测：平台的 GameStart **只发给
 * 「跑游戏的那台机器」** —— `20:49:56 .237:58734 -> .237:51124 \x05{...}`；客户端那台（.228）
 * **没有**收到，它的开局是靠游戏自己的 UNet（14568）对联机同步过去的。
 * 而本 EXE **正是平台登记并拉起的那台机器上的游戏进程** ⇒ GameStart 会打到本机。
 * （同一份抓包里，closeGame 却是 `.237:58756 -> .237:51124` **和** `.237:58758 -> .228:51124`
 *   两路同发 —— 所以「收不到 GameStart」不是端口的锅，是平台只发给主机那台。）
 *
 * <h3>本 EXE 在这里扮演什么</h3>
 * 「PC 侧的游戏实例」：启动即用**同一个 socket**（源端口必须 51124，抓包实测）向
 * `<平台IP>:51234` 发 `0x01` 注册（真实游戏是 `start` 之后约 4 秒注册），然后：
 *   · `0x05` + JSON  → **放行本局**（roundSet(true)）→ 头显页面 2 秒内出现「进入 VR」，
 *                       并按真实游戏的做法回一帧 `0x05` + 确认 JSON（`flag=1`）；
 *   · `0x10` + "closeGame" → 收回放行（roundSet(false)）并回 `0x02`（平台在等这个确认）；
 *   · `0x01` + Machines JSON → 机位表回执，只记日志（= 平台已认到本机）。
 *
 * <h3>失败也不影响任何东西</h3>
 * 平台没在跑 / 51124 被别的进程占 / 平台拉起时没给 IP ⇒ 只打日志，其余行为与以前**完全一致**
 * （头显 APK 自己也能收这一帧，并把结论经 POST /api/round/start 回报过来）。
 */
const GAME_CH_PORT = 51124;        // 平台 → 游戏（本机收；真实游戏日志里的 sendUDPPort）
const GAME_CH_ACK_PORT = 51234;    // 平台收游戏上报（recvUDPPort）
const PC_FRAME_REGISTER = 0x01;    // 本机 → 平台：注册
const PC_FRAME_CLOSE_ACK = 0x02;   // 本机 → 平台：closeGame 确认
const PC_FRAME_GAME_START = 0x05;  // 平台 → 本机：开始游戏（GameStart）
const PC_FRAME_CLOSE_GAME = 0x10;  // 平台 → 本机：关闭游戏（CloseGame）
/** 实测确认帧（与抓包逐字节一致，见 auto_client_v3.py 的 GAMESTART_ACK，118 字节） */
const GAME_START_ACK = {
  difficulty: 0, gameIntensity: 0, video: 0, guide: 0,
  posSum: 0, gameId: 0, flag: 1, levelInfo: null, recordTime: 0,
};
const PLATFORM_CH = {
  enabled: false, bound: false, frames: 0, machines: 0,
  lastStartAt: 0, lastStartFrom: null, lastCloseAt: 0, why: '未启用（EXE 不是被平台拉起的）',
};
/** 供 /api/info 显示（现场排障第一眼看这个） */
function platformChannelSnapshot() { return { ...PLATFORM_CH }; }

function startPlatformGameChannel() {
  if (hasFlag('no-game-channel')) { PLATFORM_CH.why = '被 --no-game-channel 关闭'; return; }
  const raw = String(PLATFORM_ARGS.platform || '').trim();
  const platIp = raw ? raw.split(':')[0] : null;
  let sock;
  try {
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  } catch (e) {
    PLATFORM_CH.why = 'socket 创建失败：' + e.message;
    console.warn('[cast-pc] 平台游戏通道不可用：', e.message);
    return;
  }
  PLATFORM_CH.enabled = true;
  const sendFrame = (cmd, payloadBuf, destIp) => {
    const head = Buffer.from([cmd & 0xff]);
    const frame = (payloadBuf && payloadBuf.length) ? Buffer.concat([head, payloadBuf]) : head;
    const targets = destIp ? [destIp] : [platIp, '127.0.0.1'].filter(Boolean);
    for (const t of targets) {
      try {
        sock.send(frame, 0, frame.length, GAME_CH_ACK_PORT, t, (err) => {
          if (err) console.warn(`[cast-pc] 游戏通道发送失败 → ${t}:${GAME_CH_ACK_PORT}:`, err.message);
        });
      } catch (e) { console.warn('[cast-pc] 游戏通道发送异常：', e.message); }
    }
  };
  sock.on('error', (e) => {
    PLATFORM_CH.why = 'socket 错误：' + e.message;
    console.warn('[cast-pc] 平台游戏通道错误：', e.message);
  });
  sock.on('message', (buf, rinfo) => {
    try {
      PLATFORM_CH.frames++;
      const b0 = buf[0];
      const hex = '0x' + b0.toString(16).padStart(2, '0');
      if (b0 === PC_FRAME_GAME_START) {
        let info = null;
        try { info = JSON.parse(buf.slice(1).toString('utf8').trim()); } catch (e) { /* 载荷解析失败也照样放行 */ }
        PLATFORM_CH.lastStartAt = Date.now();
        PLATFORM_CH.lastStartFrom = `${rinfo.address}:${rinfo.port}`;
        console.log(`[cast-pc] ← 平台「开始游戏」CMD 5 GameStart（来自 ${rinfo.address}:${rinfo.port}）：`
          + (info ? JSON.stringify(info) : buf.slice(1).toString('utf8').slice(0, 120)));
        roundSet(true, `平台「开始游戏」（游戏通道 CMD 5 GameStart${info && info.gameId != null ? ' gameId=' + info.gameId : ''}）`);
        sendFrame(PC_FRAME_GAME_START, Buffer.from(JSON.stringify(GAME_START_ACK)), rinfo.address);
        return;
      }
      if (b0 === PC_FRAME_CLOSE_GAME) {
        PLATFORM_CH.lastCloseAt = Date.now();
        console.log(`[cast-pc] ← 平台「关闭游戏」CMD 16 CloseGame（来自 ${rinfo.address}:${rinfo.port}）`);
        roundSet(false, '平台「关闭游戏」（游戏通道 0x10 closeGame）');
        sendFrame(PC_FRAME_CLOSE_ACK, null, rinfo.address);   // 平台在等这个确认（抓包 7ms）
        return;
      }
      if (b0 === PC_FRAME_REGISTER) {
        try {
          const s = buf.toString('utf8');
          const s0 = s.indexOf('{');
          const jo = (s0 >= 0 && s.lastIndexOf('}') > s0) ? JSON.parse(s.slice(s0, s.lastIndexOf('}') + 1)) : null;
          const ms = jo && (jo.Machines || jo.machines);
          PLATFORM_CH.machines = Array.isArray(ms) ? ms.length : 0;
          console.log(`[cast-pc] ← 平台机位表（Machines=${PLATFORM_CH.machines}）→ 平台已认到本机（注册生效）`);
        } catch (e) { /* 忽略 */ }
        return;
      }
      console.log(`[cast-pc] ← 平台游戏通道未知帧 首字节=${hex} len=${buf.length} 原文=`
        + buf.toString('utf8').replace(/[\x00-\x1f]/g, ' ').slice(0, 120));
    } catch (e) {
      console.warn('[cast-pc] 游戏通道收帧处理异常：', e.message);
    }
  });
  sock.bind(GAME_CH_PORT, '0.0.0.0', () => {
    PLATFORM_CH.bound = true;
    PLATFORM_CH.why = `已监听 UDP ${GAME_CH_PORT}` + (platIp ? `（平台 ${platIp}:${GAME_CH_ACK_PORT}）` : '（没有平台 IP，只被动接收）');
    console.log(`[cast-pc] 平台游戏通道已监听 UDP ${GAME_CH_PORT}；`
      + (platIp
        ? `将以 0x01 向 ${platIp}:${GAME_CH_ACK_PORT} 注册（源端口 51124，与真实游戏一致），等平台回机位表`
        : '本次没拿到平台 IP（EXE 不是被平台拉起的）→ 只被动等平台下发 GameStart'));
    // 注册 0x01：真实游戏是 start 之后约 4 秒注册；这里 0/1.5/3/4.5s 各发一次，抗 UDP 丢包
    [0, 1500, 3000, 4500].forEach((d) => setTimeout(() => {
      if (!PLATFORM_CH.enabled) return;
      sendFrame(PC_FRAME_REGISTER, null, null);
      console.log(`[cast-pc] → 游戏通道 0x01 注册（+${d}ms）`);
    }, d));
  });
}
