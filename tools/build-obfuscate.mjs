// 生产构建 + 混淆脚本：把 src/**/*.js 用 terser 压缩混淆，并把 __PROD__ 折叠为 true
// （使 levels/spawnPlans/enemies 的「开发态本地关卡数据 fallback」被编译成空数组/对象 →
//  生产包不含任何本地关卡/出怪/敌人数据；必须联网拉云端配置才能初始化）。
//
// 运行：
//   node tools/build-obfuscate.mjs            # 完整构建（压缩 JS + 拷贝静态资源）到 dist/
//   SKIP_ASSET_COPY=1 node ...                # 只压缩 JS（快速校验折叠/语法，不拷 80MB 资源）
//
// 依赖 terser：装到「受管 node 工作区」即可（脚本会自动探测若干路径）。
//   cd <workbuddy node workspace> && npm install terser
//
// ⚠ 输出 dist/ 是「生产包」：SERVER_URL 仍需在 src/core/license.js 改成你的 https 激活地址。

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');          // 项目根 D:/01_AI/WebXR_Begain
const DIST = path.join(ROOT, 'dist');
const SRC = path.join(ROOT, 'src');
const SKIP_ASSET_COPY = process.env.SKIP_ASSET_COPY === '1';

// ── 解析 terser（优先 NODE_PATH / 本地，其次受管工作区已知路径） ──
const require = createRequire(import.meta.url);
let minify;
try { ({ minify } = require('terser')); }
catch {
  const candidates = [
    'C:/Users/XIn/.workbuddy/binaries/node/workspace/node_modules/terser',
  ];
  let loaded = null;
  for (const c of candidates) { try { loaded = require(c); break; } catch { /* try next */ } }
  if (!loaded) { console.error('[build] 找不到 terser：请先 `npm install terser` 或设置 NODE_PATH'); process.exit(1); }
  ({ minify } = loaded);
}

// ── terser 配置：ESM 模式 + __PROD__=true 折叠 + 混淆 ──
const TERser_OPTS = {
  module: true,                 // 输入/输出均为 ES Module：保留 import/export，不包 IIFE
  compress: {
    global_defs: { __PROD__: true },  // 关键：typeof __PROD__!=='undefined'&&__PROD__ → 恒真 → fallback 折叠为空
    passes: 2,
    drop_console: false,        // 保留 console（便于线上排障；要彻底可改 true）
  },
  mangle: true,                 // 局部变量/函数名混淆（不碰导出的绑定与属性名）
  format: { comments: false },
};

function walkJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function rmtree(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  console.log('[build] 清理 dist/ ...');
  rmtree(DIST);
  fs.mkdirSync(DIST, { recursive: true });

  // 1) 压缩所有 src JS
  const files = walkJs(SRC);
  console.log(`[build] 压缩 ${files.length} 个 JS 文件 ...`);
  let failed = 0;
  for (const f of files) {
    const rel = path.relative(SRC, f);
    const srcCode = fs.readFileSync(f, 'utf8');
    try {
      const res = await minify(srcCode, TERser_OPTS);
      if (res.error) throw res.error;
      const outPath = path.join(DIST, 'src', rel);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, res.code, 'utf8');
    } catch (e) {
      failed++;
      console.error(`[build] 压缩失败: ${rel} -> ${e.message || e}`);
    }
  }
  if (failed) { console.error(`[build] 有 ${failed} 个文件压缩失败，终止`); process.exit(1); }

  // 2) 折叠结果自检：核心三张表在生产包里必须是空（无本地数据）
  const checks = [
    ['src/content/levels.js', /export let LEVELS=\[\]/],
    ['src/content/spawnPlans.js', /export let LEVEL_ENEMY=\{\}/],
    ['src/content/enemies.js', /export let ENEMY_TYPES=\{\}/],
  ];
  let foldOk = true;
  for (const [rel, re] of checks) {
    const code = fs.readFileSync(path.join(DIST, rel), 'utf8');
    const ok = re.test(code);
    if (!ok) foldOk = false;
    console.log(`[build] 折叠自检 ${rel}: ${ok ? 'OK(空)' : '!! 未折叠'}`);
  }
  if (!foldOk) { console.error('[build] __PROD__ 折叠失败，终止'); process.exit(1); }

  if (SKIP_ASSET_COPY) {
    console.log('[build] SKIP_ASSET_COPY=1 → 跳过静态资源拷贝（快速校验模式）');
    console.log('[build] 完成（仅 JS）：dist/src');
    process.exit(0);
  }

  // 3) 拷贝静态资源（保持相对路径，使 index.html 的 importmap 与模块图继续可用）
  const COPY = [
    { from: 'index.html', to: 'index.html' },
    { from: 'vendor', to: 'vendor' },
    { from: 'assets', to: 'assets' },
    { from: 'Model', to: 'Model' },
    { from: 'Sky', to: 'Sky' },
    { from: 'music', to: 'music' },
  ];
  for (const c of COPY) {
    const src = path.join(ROOT, c.from);
    if (!fs.existsSync(src)) { console.warn(`[build] 跳过（不存在）: ${c.from}`); continue; }
    console.log(`[build] 拷贝 ${c.from} -> dist/${c.to} ...`);
    await fs.promises.cp(src, path.join(DIST, c.to), { recursive: true });
  }

  console.log('[build] 完成：dist/ 已是生产包（SERVER_URL 请确认指向你的 https 激活服务）');
  process.exit(0);
})();
