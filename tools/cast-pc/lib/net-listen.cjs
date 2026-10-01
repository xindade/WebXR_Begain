// tools/cast-pc/lib/net-listen.cjs —— 端口 fallback 监听（第三十七修）
//
// 为什么不能写成 `server.listen(port, () => onListen(port))` 然后重试：
//   Node 把 listen 的 callback 挂成**一次性** 'listening' 监听；EADDRINUSE 时它**不会被摘掉**，
//   「重试后成功」的那次 'listening' 会把「旧回调 + 新回调」**一起触发**。
//   本项目里的后果（2026-09-28 现场实测）：
//     ① onListen 跑两遍 → ipcMain.handle 重复注册 → 主进程抛
//        `Attempted to register a second handler for 'cfg:get'` 并弹错误框；
//     ② 第一遍已按**旧端口**建好窗口（http://localhost:8443/__cast/index.html），第二遍才把 PORT
//        改成新端口 ⇒ 窗口连的是**占用 8443 的那个程序**（通常是上一局没退干净的 EXE），
//        而本进程的服务实际在 8444 —— 平台/头显仍连 8443，表现为「PC 端没起来」。
//   → 每次尝试失败都必须**显式摘掉本次回调**；本文件另有 done 标记做第二道保险。
// 回归用例：tests/listen-fallback.test.mjs（根部 `npm test` 会跑）
'use strict';

/**
 * 在 server 上监听 startPort；被占用（EADDRINUSE）则 +1 重试，最多 maxAttempts 次。
 *
 * @param {import('net').Server} server  待监听的服务器实例
 * @param {number} startPort             起始端口（本项目默认 8443）
 * @param {(port:number)=>void} onListening 监听成功回调（**保证只触发一次**）
 * @param {{maxAttempts?:number, host?:string, log?:(msg:string)=>void, onFail?:(err:Error)=>void}} [opts]
 */
function listenWithFallback(server, startPort, onListening, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 10;
  const host = opts.host ?? '0.0.0.0';
  const log = opts.log ?? (() => {});
  const onFail = opts.onFail ?? (() => {});

  let done = false;   // ★ 保险：成功/失败合计只回调一次（即使还有残留监听）

  const attempt = (port, used) => {
    const handleListening = () => {
      server.removeListener('error', handleError);
      if (done) return;
      done = true;
      onListening(port);
    };
    const handleError = (err) => {
      server.removeListener('listening', handleListening);   // ★ 关键：失败即摘掉本次回调，防重试时二次触发
      if (err && err.code === 'EADDRINUSE' && used < maxAttempts) {
        log(`[cast-pc] 端口 ${port} 被占用，改用 ${port + 1}`
          + '（注意：平台/头显若写死 8443，会连到占用它的那个程序）');
        attempt(port + 1, used + 1);
        return;
      }
      if (done) return;
      done = true;
      onFail(err);
    };
    server.once('listening', handleListening);
    server.once('error', handleError);
    server.listen(port, host);
  };

  attempt(startPort, 0);
}

module.exports = { listenWithFallback };