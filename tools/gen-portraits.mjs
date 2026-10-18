// 离线生成商店「精英预告」卡的本地立绘 PNG。
//
// 用法：node tools/gen-portraits.mjs
// 产物：src/assets/portraits/{knight,shield,healer,ninja,ghost,octopus}.png
//
// 为什么需要：头显上每次进店都离屏抓 GLB 会卡、会偶发全透明，而且现场出现过
//   「所有卡都变成同一只怪」的抓帧串图。立绘是静态内容，应该在开发机烧一次、随包发布。

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, 'src', 'assets', 'portraits');
await fsp.mkdir(outDir, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
};

function resolveStatic(pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

let chrome = null;
let finished = false;
function finish(code, why) {
  if (finished) return;
  finished = true;
  if (why) console.log(why);
  try { chrome && chrome.kill(); } catch {}
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 1500).unref();
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'POST' && u.pathname === '/save') {
      const name = u.searchParams.get('name') || '';
      if (!/^[a-z0-9-]+$/.test(name)) { res.writeHead(400); res.end('bad name'); return; }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (buf.length < 100) { res.writeHead(400); res.end('empty png'); return; }
      await fsp.writeFile(path.join(outDir, name + '.png'), buf);
      console.log(`[saved] ${name}.png  ${buf.length} bytes`);
      res.end('ok');
      return;
    }

    if (req.method === 'POST' && u.pathname === '/done') {
      res.end('ok');
      finish(0, '[done] all portraits generated');
      return;
    }

    if (req.method === 'POST' && u.pathname === '/fail') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      res.end('ok');
      finish(1, '[fail] ' + Buffer.concat(chunks).toString('utf8'));
      return;
    }

    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

    const file = u.pathname === '/' ? path.join(here, 'gen-portraits.html') : resolveStatic(u.pathname);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) res.writeHead(500);
    res.end(String(err && err.message || err));
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;
const exe = chromePath();
if (!exe) {
  console.error('找不到 Chrome/Edge。可设 CHROME_PATH 后重试。');
  process.exit(1);
}

console.log(`[serve] ${url}`);
console.log(`[chrome] ${exe}`);
chrome = spawn(exe, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--ignore-gpu-blocklist',
  '--enable-webgl',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--window-size=800,800',
  '--hide-scrollbars',
  url,
], { stdio: ['ignore', 'pipe', 'pipe'] });

chrome.stdout.on('data', (d) => process.stdout.write('[chrome] ' + d.toString()));
chrome.stderr.on('data', (d) => process.stderr.write('[chrome] ' + d.toString()));
chrome.on('exit', (code) => { if (!finished) finish(code || 1, '[chrome] exited before /done'); });

setTimeout(() => finish(2, '[timeout] 120s without /done'), 120000).unref();
