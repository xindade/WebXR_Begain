'use strict';
/**
 * P3 离线夹具编排器 —— 一条命令跑完「造样本 → 编译 → 头显同款逻辑验证」。
 *
 *   cd tools/cast-server && node xlang/p3test.js
 *
 * 关键设计：**不复制粘贴校验逻辑**。本脚本把 APK 工程里那份
 * app/src/main/java/com/local/webxrcast/LicenseVerify.java 原样拷进构建目录，
 * 并打印两侧 md5 且断言一致 —— 保证「这里跑过的」就是「打进 APK 的那一份」。
 * android.util.Base64 与 org.json 由 xlang/stub/ 下的 JDK 替身提供（真机用系统实现）。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const HERE = __dirname;
const ROOT = path.join(HERE, '..');                       // tools/cast-server
const APK_SRC = path.join(ROOT, '..', 'cast-apk', 'app', 'src', 'main', 'java',
  'com', 'local', 'webxrcast', 'LicenseVerify.java');
const BUILD = path.join(HERE, 'build');
const SRC = path.join(BUILD, 'src');
const CLASSES = path.join(BUILD, 'classes');
const OUT = path.join(HERE, 'out');

function md5(p) { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); }

function findTool(name) {
  const env = process.env.JAVA_HOME;
  const cands = [];
  if (env) cands.push(path.join(env, 'bin', name + (process.platform === 'win32' ? '.exe' : '')));
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return name;
  } catch (e) { /* PATH 上跑不动，继续找 */ }
  cands.push('C:/Program Files/Common Files/Oracle/Java/javapath/' + name + '.EXE');
  for (const c of cands) {
    try {
      execFileSync(c, ['-version'], { stdio: 'ignore' });
      return c;
    } catch (e) { /* 继续 */ }
  }
  throw new Error('找不到 ' + name + '。请安装 JDK 17 或设好 JAVA_HOME');
}

// ── 0) 清理（幂等覆盖；不用 shell 的 rm —— 本机安全钩子会拦）──
try {
  fs.rmSync(BUILD, { recursive: true, force: true });
} catch (e) {
  console.log('（清理旧构建目录失败，改为覆盖写入：' + e.message + '）');
}
fs.mkdirSync(path.join(SRC, 'com', 'local', 'webxrcast'), { recursive: true });
fs.mkdirSync(CLASSES, { recursive: true });

// ── 1) 造样本 ──
console.log('────────── ① 造样本 ──────────');
execFileSync(process.execPath, [path.join(HERE, 'gen-p3.js')], { cwd: ROOT, stdio: 'inherit' });

// ── 2) 拷贝待测源码（含 md5 自证）──
console.log('────────── ② 拷贝待测源码 ──────────');
if (!fs.existsSync(APK_SRC)) {
  console.error('找不到 APK 工程里的 LicenseVerify.java：' + APK_SRC);
  process.exit(2);
}
const dest = path.join(SRC, 'com', 'local', 'webxrcast', 'LicenseVerify.java');
fs.copyFileSync(APK_SRC, dest);
const a = md5(APK_SRC);
const b = md5(dest);
console.log('  APK 工程内 ：' + a + '  ' + path.relative(ROOT, APK_SRC));
console.log('  构建目录内 ：' + b + '  ' + path.relative(ROOT, dest));
if (a !== b) {
  console.error('[FAIL] md5 不一致 —— 夹具跑的不是要打包的那一份，拒绝继续');
  process.exit(2);
}
console.log('  [OK] md5 一致（夹具跑的确实是打进 APK 的那一份）');

// ── 3) 拷贝 JDK 替身桩 + 驱动 ──
const stubRoot = path.join(HERE, 'stub');
copyTree(stubRoot, SRC);
fs.copyFileSync(path.join(HERE, 'VerifyCurrent.java'), path.join(SRC, 'VerifyCurrent.java'));
console.log('  已就位替身桩：' + listRel(stubRoot).join('  '));

// ── 4) 编译 ──
console.log('────────── ③ 编译（javac，显式 UTF-8）──────────');
const javac = findTool('javac');
const sources = listRel(SRC).filter((f) => f.endsWith('.java')).map((f) => path.join(SRC, f));
console.log('  javac = ' + javac + '，源文件 ' + sources.length + ' 个');
try {
  execFileSync(javac, ['-encoding', 'UTF-8', '-d', CLASSES, ...sources], { stdio: 'inherit' });
} catch (e) {
  console.error('[FAIL] 编译失败（这一步同时验证了 LicenseVerify.java 的语法与类型）');
  process.exit(1);
}
console.log('  [OK] 编译通过');

// ── 5) 运行 ──
console.log('────────── ④ 头显同款逻辑验证 ──────────');
const java = findTool('java');
try {
  execFileSync(java, ['-Dfile.encoding=UTF-8', '-cp', CLASSES, 'VerifyCurrent', OUT], { stdio: 'inherit' });
} catch (e) {
  process.exit(e.status || 1);
}

// ─────────────────────────────── helpers ───────────────────────────────

function copyTree(from, to) {
  for (const f of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, f.name);
    const d = path.join(to, f.name);
    if (f.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyTree(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function listRel(root) {
  const out = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  })(root);
  return out.sort();
}
