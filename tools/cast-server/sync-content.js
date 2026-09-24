'use strict';
/**
 * sync-content.js —— 把「轻量配置」发布到服务器内容目录（第二十四修 · 服务器清单）
 *
 * <p>为什么需要它：EXE 现在**不再从游戏目录读配置**，改成每次启动向 `GET /api/manifest` 拉一份
 * 清单（见 cast-pc/main.js 的「服务器清单」段）。服务器的内容源就是本脚本写出来的目录：
 *
 *   tools/cast-server/content/
 *     1.0.0/                      ← 一个版本一个目录；EXE 按版本精确匹配，绝不回落 current
 *       src/content/levels.js     ← 目录结构 = 项目相对路径（客户端按 path 原样落盘）
 *       src/core/userConfig.js
 *       ver.json                  ← { ver, builtAt, count, bytes, listSha256 }（发布元数据，不进清单）
 *     manifest.json               ← { versions:[], current, updatedAt }（后台展示用，不参与授权决策）
 *
 * <p>用法（在项目根或本目录都能跑）：
 *   node tools/cast-server/sync-content.js --ver 1.0.0
 *   node sync-content.js --ver 1.0.1 --src E:/AI_Work/WebXR_Begain_Platform --content ./content
 *
 * <p>发版检查单：**改过关卡/数值就必须跑一次**，并且 `--ver` 与客户端内置的 `CONTENT_VER`
 * （cast-pc/main.js，默认 1.0.0）一致，否则 EXE 会拿到 404 noContentVersion。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * 要发布的清单项 —— ⚠ 必须与 cast-pc/main.js 的 CONFIG_MANIFEST **逐字一致**
 * （目录以 / 结尾 = 整目录递归）。改一处就要改两处，否则现场会出现「列表里有、包里没有」。
 */
const MANIFEST_ITEMS = [
  'src/content/',
  'src/core/userConfig.js',
];

/** 取 `--name=值` 或 `--name 值`（两种写法都收，免得现场按帮助里写的空格形式用不了） */
function argValue(name, def) {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === `--${name}`) return (a[i + 1] != null) ? a[i + 1] : def;
    if (a[i].startsWith(`--${name}=`)) return a[i].slice(name.length + 3);
  }
  return def;
}

const VER = argValue('ver', null);
const SRC = path.resolve(argValue('src', path.join(__dirname, '..', '..')));
const CONTENT = path.resolve(argValue('content', path.join(__dirname, 'content')));

if (!VER || !/^[0-9A-Za-z._-]{1,32}$/.test(VER)) {
  console.error('用法：node sync-content.js --ver <版本号> [--src <项目根>] [--content <服务器 content 目录>]');
  console.error('  例：node sync-content.js --ver 1.0.0');
  const idx = readIndex();
  if (idx.versions.length) console.error('  服务器上已有版本：' + idx.versions.join(', ') + `（current=${idx.current}）`);
  process.exit(2);
}

function readIndex() {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(CONTENT, 'manifest.json'), 'utf8'));
    return { versions: Array.isArray(o.versions) ? o.versions.map(String) : [], current: String(o.current || '') };
  } catch (e) {
    return { versions: [], current: '' };
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = (abs) => sha256(fs.readFileSync(abs));

/** 收集一个清单项下的所有文件：[{ rel, abs }]（rel 用正斜杠的项目相对路径） */
function collect(item, acc) {
  const abs = path.join(SRC, item);
  if (!fs.existsSync(abs)) {
    console.error(`[fatal] 项目里找不到清单项：${item}（--src 指对了吗？当前 ${SRC}）`);
    process.exit(3);
  }
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(abs).sort()) collect(item.replace(/\/$/, '') + '/' + n, acc);
  } else {
    acc.push({ rel: item.split(path.sep).join('/'), abs });
  }
  return acc;
}

// ——— 1) 收集 + 校验 ———
const items = [];
for (const it of MANIFEST_ITEMS) {
  if (path.isAbsolute(it)) { console.error(`[fatal] 清单项必须是相对项目根的路径：${it}`); process.exit(3); }
  collect(it, items);
}
if (!items.length) { console.error('[fatal] 清单展开后为空'); process.exit(3); }

// ——— 2) 写入 content/<ver>/（先整目录重建，避免删过的文件残留在发布目录里）———
const dest = path.join(CONTENT, VER);
if (fs.existsSync(dest)) {
  console.log(`   已有 ${dest} → 整目录重建（防止旧文件残留）`);
  fs.rmSync(dest, { recursive: true, force: true });
}
let bytes = 0;
const list = [];
for (const it of items) {
  const buf = fs.readFileSync(it.abs);
  const target = path.join(dest, it.rel.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
  bytes += buf.length;
  list.push({ path: it.rel, sha256: sha256(buf), size: buf.length });
}
list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

// listSha256：把「path|sha256」按排序后拼接再哈希 —— 客户端可据此自证「拿到的清单没被动过顺序/内容」
const listSha256 = sha256(Buffer.from(list.map((f) => `${f.path}|${f.sha256}\n`).join(''), 'utf8'));
const builtAt = Date.now();
fs.writeFileSync(path.join(dest, 'ver.json'), JSON.stringify({ ver: VER, builtAt, count: list.length, bytes, listSha256 }, null, 2));

// ——— 3) 更新发布索引（current 只用于后台展示 / 不带 ver 的请求的兜底）———
const idx = readIndex();
const versions = Array.from(new Set(idx.versions.concat([VER]))).sort();
fs.mkdirSync(CONTENT, { recursive: true });
fs.writeFileSync(path.join(CONTENT, 'manifest.json'), JSON.stringify({ versions, current: VER, updatedAt: builtAt }, null, 2));

console.log('==================================================');
console.log(`✓ 已发布内容版本 ${VER}`);
console.log(`  源      ：${SRC}`);
console.log(`  目标    ：${dest}`);
console.log(`  文件    ：${list.length} 个，共 ${bytes}B`);
console.log(`  清单哈希：${listSha256.slice(0, 24)}…`);
console.log(`  现有版本：${versions.join(', ')}（current=${VER}）`);
console.log('  ⚠ EXE 的 CONTENT_VER 必须等于这个版本号，否则会 404 noContentVersion');
console.log('==================================================');

