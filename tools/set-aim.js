#!/usr/bin/env node
// ============================================================
// 现场改「手柄瞄准补偿角」——按设备槽写进 src/core/userConfig.js 的 AIM.BY_DEVICE。
//
// 为什么要有这个工具（第四十四修）：
//   现场有 PICO 和 Quest 两种头显，各自的 targetRay↔grip 空间约定不同 ⇒ 瞄准角必须分开存。
//   但**头显浏览器里打字极难**（VR 里的软键盘几乎不可用）。本工具让你在 PC 上改：
//     改完 → 直播端(EXE)下次自动把这份 userConfig.js 下发给头显 → 各设备读自己的槽
//     （deviceProfile.getDeviceFamily() 运行时判定，见 docs/设备识别与瞄准角度.md）
//   ⇒ 头显侧一个字都不用输入，也不用重打 APK。
//
// 用法：
//   node tools/set-aim.js                          查看四个槽当前的角度（只读）
//   node tools/set-aim.js quest -14 -14 0           写 quest 槽（x=俯仰 y=偏航 z=翻滚）
//   node tools/set-aim.js quest -14                只改 x（没写的轴保持原样）
//   node tools/set-aim.js pico -27 0 0 --dry       只打印将改成什么，不落盘
//   node tools/set-aim.js --file <path> ...        改别的 userConfig.js（如 EXE 指向的游戏目录里的那份）
//
// 与「PC 端 EXE 界面直接填」的区别（第四十五修）——两条路都留，按场景选：
//   本工具：**改文件**（进仓库 / 进 content 包，可提交、可上传服务器）；
//   EXE 界面：**本机覆盖**（不用重打包、不用上传，现场两秒调好；落 EXE 的 config.json，
//            每次下发给头显前套用，配置随服务器清单刷新也不丢）。
//
// 角度含义（详见 docs/设备识别与瞄准角度.md）：
//   x = 俯仰（负=射线下压 / 正=上抬，**主要调这一个**）
//   y = 偏航（负=左偏 / 正=右偏）
//   z = 翻滚（⚠ 不改变射线方向，一般保持 0）
//
// 生效条件：改完刷新头显页面即生效；走「服务器清单」那条路时还要
//   `node tools/cast-server/sync-content.js --ver 1.0.0` 并上传（见 docs/tech/09）。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 槽名与「定位 / 读 / 改写」逻辑统一放在 cast-pc/lib/aim-config.cjs ——
// PC 端 EXE 界面（第四十五修）用的是同一份实现，避免两处漂移。
import AIMCFG from './cast-pc/lib/aim-config.cjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.join(HERE, '..', 'src', 'core', 'userConfig.js');
const { SLOTS, findSlot, readAxes, rewriteAxes } = AIMCFG;


function parseArgs(argv) {
  const out = { file: DEFAULT_FILE, dry: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') { out.file = path.resolve(argv[++i]); continue; }
    if (a.startsWith('--file=')) { out.file = path.resolve(a.slice(7)); continue; }
    if (a === '--dry' || a === '-n') { out.dry = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    out.rest.push(a);
  }
  return out;
}

function printTable(src) {
  const rows = [];
  for (const slot of SLOTS) {
    const hit = findSlot(src, slot);
    rows.push([slot, hit ? readAxes(hit.body) : null]);
  }
  console.log('设备槽           x       y       z');
  for (const [slot, a] of rows) {
    if (!a) { console.log(slot.padEnd(12) + '  —— 未在 userConfig.js 里找到该槽'); continue; }
    console.log(slot.padEnd(12) + [a.x, a.y, a.z].map((v) => String(v).padStart(6)).join('  '));
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 30).join('\n'));
    return 0;
  }
  if (!fs.existsSync(args.file)) {
    console.error('[x] 找不到文件：' + args.file);
    return 1;
  }
  const raw = fs.readFileSync(args.file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';

  const [slot, sx, sy, sz] = args.rest;
  if (!slot) {
    console.log('文件：' + args.file + eol + eol);
    printTable(raw);
    console.log(eol + '用法：node tools/set-aim.js <pico|quest|steamvr|unknown> <x> <y> <z> [--dry] [--file <path>]');
    return 0;
  }
  if (!SLOTS.includes(slot)) {
    console.error('[x] 槽名必须是：' + SLOTS.join(' / '));
    return 1;
  }
  // 允许只写部分轴：node tools/set-aim.js quest --  -- 0 之类只改 z（缺的轴原样不动）
  const axes = {};
  const given = { x: sx, y: sy, z: sz };
  for (const k of ['x', 'y', 'z']) {
    if (given[k] === undefined) continue;
    axes[k] = Number(given[k]);
    if (!Number.isFinite(axes[k])) { console.error('[x] ' + k + ' 不是数字：' + given[k]); return 1; }
  }
  if (!Object.keys(axes).length) { console.error('[x] 至少要给一个轴，例如：node tools/set-aim.js quest -14 -14 0'); return 1; }
  const hit = findSlot(raw, slot);
  if (!hit) {
    console.error('[x] userConfig.js 里没找到 BY_DEVICE.' + slot + ' —— 请手工加一行 ' + slot + ': { x: 0, y: 0, z: 0 },');
    return 1;
  }
  const before = readAxes(hit.body);
  const body2 = rewriteAxes(hit.body, axes);
  if (body2 === hit.body) {
    console.log('没有变化：' + slot + ' 已经是 x=' + before.x + ' y=' + before.y + ' z=' + before.z);
    return 0;
  }
  const next = raw.slice(0, hit.start) + hit.head + body2 + hit.tail + raw.slice(hit.start + hit.full.length);
  const after = readAxes(body2);
  console.log(slot + '：x ' + before.x + '→' + after.x + '  y ' + before.y + '→' + after.y + '  z ' + before.z + '→' + after.z);
  if (args.dry) {
    console.log('（--dry：没有写盘）');
    return 0;
  }
  fs.writeFileSync(args.file, next, 'utf8');
  console.log('已写：' + args.file);
  console.log('下一步：重新点平台的「启动游戏」让头显重新拉一次配置（头显不需要输入任何东西）；');
  console.log('        若现场走「服务器清单」那条路，还要 node tools/cast-server/sync-content.js --ver 1.0.0 并上传。');
  return 0;
}

process.exit(main());