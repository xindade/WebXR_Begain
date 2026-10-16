// 商店预告卡离线预览 · 启动器（第六十三修）
//   用法（仓库根目录）：
//     tools\cast-pc\node_modules\electron\dist\electron.exe tools\portrait-preview\run.cjs
//   做的事：起一个根目录静态服务（import map 与 Model/ 、vendor/draco/ 都靠它解析）
//   → 打开 probe.html → 等结果 → 把 3 张卡列 PNG + report.json 写到输出目录。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');          // 仓库根
const PORT = 8127;
const OUTDIR = path.join(os.tmpdir(), 'webxr-portrait-preview');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.webp': 'image/webp',
  '.png': 'image/png', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
  '.css': 'text/css',
};

function serve() {
  return http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); res.end('404 ' + p); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
      res.end(buf);
    });
  });
}

app.commandLine.appendSwitch('enable-unsafe-swiftshader');   // 没有独显 / 软件渲染也能跑
app.whenReady().then(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const server = serve();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[renderer]', msg));
  await win.loadURL('http://127.0.0.1:' + PORT + '/tools/portrait-preview/probe.html');

  let res = null;
  for (let i = 0; i < 300; i++) {
    res = await win.webContents.executeJavaScript('window.__RESULT || null').catch(() => null);
    if (res) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!res) { console.log('[失败] 等不到结果（见上面 renderer 日志）'); app.exit(2); return; }

  const cards = res.results.filter((r) => r.key !== '__sheet__')
    .map((r) => ({ lv: r.lv, key: r.key, label: r.label, sub: r.sub, hasImg: r.hasImg, opaque: r.opaque, err: r.err, note: r.note }));
  fs.writeFileSync(path.join(OUTDIR, 'report.json'), JSON.stringify(cards, null, 1));
  fs.writeFileSync(path.join(OUTDIR, 'console.txt'), res.out.join('\n'));
  for (const r of res.results) {
    if (!r.png) continue;
    fs.writeFileSync(path.join(OUTDIR, 'cards-lv' + r.lv + '.png'), Buffer.from(r.png.split(',')[1], 'base64'));
  }
  console.log('\n=== 完成 ===');
  console.log(res.out.join('\n'));
  console.log('输出目录: ' + OUTDIR);
  app.exit(0);
});