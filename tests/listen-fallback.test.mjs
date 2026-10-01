// PC 端启动端口 fallback：端口被占用重试时，成功回调**必须只触发一次**（第三十七修）
//
// 背景（2026-09-28 现场）：`server.listen(port, cb)` 的 cb 被挂在一次性 'listening' 上，
// EADDRINUSE 时**不会被摘掉** ⇒ 重试成功时「旧回调 + 新回调」一起触发 ⇒ onListen 跑两遍 ⇒
// ipcMain.handle 重复注册 ⇒ 主进程弹「Attempted to register a second handler for 'cfg:get'」。
// 本用例锁住 tools/cast-pc/lib/net-listen.cjs 的语义。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listenWithFallback } = require('../tools/cast-pc/lib/net-listen.cjs');

function tryOccupy(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(null));
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}
function isFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
async function freeBase(start) {
  for (let p = start; p < start + 300; p++) {
    if (await isFree(p) && await isFree(p + 1) && await isFree(p + 2)) return p;
  }
  throw new Error('找不到连续空闲端口');
}
function closeServer(s) {
  return new Promise((r) => (s && s.close ? s.close(() => r()) : r()));
}
// 跑一次 listenWithFallback；回调后再等 120ms —— 老 bug 会在同一轮里触发第二次，留出窗口把它抓住
function run(server, base, opts = {}) {
  const calls = []; const fails = []; const logs = [];
  return new Promise((resolve) => {
    const settle = () => setTimeout(() => resolve({ calls, fails, logs }), 120);
    listenWithFallback(server, base, (p) => { calls.push(p); settle(); }, {
      host: '127.0.0.1',
      log: (m) => logs.push(m),
      onFail: (e) => { fails.push(e); settle(); },
      ...opts,
    });
  });
}

test('端口空闲：直接成功，成功回调只触发一次', async () => {
  const base = await freeBase(34000);
  const srv = net.createServer();
  const { calls, fails, logs } = await run(srv, base);
  assert.deepEqual(calls, [base]);
  assert.deepEqual(fails, []);
  assert.deepEqual(logs, []);
  assert.equal(srv.listenerCount('listening'), 0, '不应残留 listening 监听');
  assert.equal(srv.listenerCount('error'), 0, '不应残留 error 监听');
  await closeServer(srv);
});

test('端口被占用：自动 +1，且成功回调**只触发一次**（旧回调必须被摘掉）', async () => {
  const base = await freeBase(34500);
  const blocker = await tryOccupy(base);
  assert.ok(blocker, '前置条件：起始端口应被占用');
  const srv = net.createServer();
  const { calls, fails, logs } = await run(srv, base);
  assert.deepEqual(calls, [base + 1], '只应上报重试后的端口，且只上报一次');
  assert.deepEqual(fails, []);
  assert.equal(logs.length, 1, '应有一条「端口被占用」提示');
  assert.equal(srv.listenerCount('listening'), 0, '旧回调必须已被摘掉（否则 onListen 会跑两遍）');
  assert.equal(srv.listenerCount('error'), 0);
  await closeServer(srv);
  await closeServer(blocker);
});

test('连续被占用：按 maxAttempts 放弃，只回调一次失败', async () => {
  const base = await freeBase(35000);
  const b1 = await tryOccupy(base);
  const b2 = await tryOccupy(base + 1);
  const b3 = await tryOccupy(base + 2);
  assert.ok(b1 && b2 && b3, '前置条件：前三个端口都应被占用');
  const srv = net.createServer();
  const { calls, fails, logs } = await run(srv, base, { maxAttempts: 2 });
  assert.deepEqual(calls, []);
  assert.equal(fails.length, 1);
  assert.equal(fails[0].code, 'EADDRINUSE');
  assert.equal(logs.length, 2, '两次重试各一条提示');
  assert.equal(srv.listenerCount('listening'), 0);
  assert.equal(srv.listenerCount('error'), 0);
  await closeServer(srv);
  await closeServer(b1); await closeServer(b2); await closeServer(b3);
});