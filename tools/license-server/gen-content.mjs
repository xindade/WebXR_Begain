// 本地构建工具：从浏览器端源模块提取「核心关卡配置」生成 game-content.json，
// 供 license-server 加密后通过 /api/content 下发，使游戏文件不再明文携带关卡/出怪/敌人数据。
// 仅本地运行（node gen-content.mjs），无需 npm install。
//
// 提取目标：levels.js(LEVELS) / spawnPlans.js(LEVEL_ENEMY) / enemies.js(ENEMY_TYPES)
// 这些模块是纯数据（无浏览器依赖），但为兼容 CommonJS 运行环境，这里用「去注释 + 平衡括号提取 + Function 求值」而非 import。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '../../src/content');

function readClean(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/\/\/.*$/gm, '');        // 行注释（源内 'Model/...' 为单斜杠，不会被误删）
}

function extractLiteral(cleanSrc, name) {
  // ⚠ 同时匹配 `const`/`let`（levels/spawnPlans/enemies 已改为 `let` 以支持 __PROD__ 三元 + installCloud 注入）
  // 且必须带 `export` 前缀，避免误匹配 installCloud* 函数体里的 `NAME = obj` 赋值。
  // 取值是形如 `(typeof __PROD__!=='undefined'&&__PROD__) ? [] : [...] 的顶层语句，
  // 不能用「首个括号配平」(会停在内层 `)`)，改为按 (){}[] 深度扫到顶层 `;` 为止。
  const re = new RegExp('export\\s+(?:const|let)\\s+' + name + '\\s*=');
  const m = re.exec(cleanSrc);
  if (!m) throw new Error('未找到导出: ' + name);
  let k = m.index + m[0].length;
  while (k < cleanSrc.length && /\s/.test(cleanSrc[k])) k++; // 跳过空白到值起点
  const start = k;
  let depth = 0, inStr = null;
  for (; k < cleanSrc.length; k++) {
    const c = cleanSrc[k];
    if (inStr) { if (c === '\\') { k++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth === 0) break; // 顶层语句结束
  }
  return cleanSrc.slice(start, k).trim();
}

function evalLiteral(lit) {
  // 仅用于本地生成脚本（可信输入），把数据字面量求值为对象
  return (new Function('return (' + lit + ')'))();
}

const out = {};
out.LEVELS = evalLiteral(extractLiteral(readClean(fs.readFileSync(path.join(ROOT, 'levels.js'), 'utf8')), 'LEVELS'));
out.LEVEL_ENEMY = evalLiteral(extractLiteral(readClean(fs.readFileSync(path.join(ROOT, 'spawnPlans.js'), 'utf8')), 'LEVEL_ENEMY'));
out.ENEMY_TYPES = evalLiteral(extractLiteral(readClean(fs.readFileSync(path.join(ROOT, 'enemies.js'), 'utf8')), 'ENEMY_TYPES'));

fs.writeFileSync(path.join(__dirname, 'game-content.json'), JSON.stringify(out, null, 2));
const desc = Object.keys(out).map(k =>
  k + '=' + (Array.isArray(out[k]) ? out[k].length + '项' : Object.keys(out[k]).length + '项')
).join(', ');
console.log('[gen-content] 已生成 game-content.json: ' + desc);
