/*
 * pagelog.js — 最高优先级页面日志面板
 * 用「经典脚本」(非 module) 实现，不依赖 importmap / three，
 * 即使 main.js 或 three 加载失败，本脚本也能跑，从而捕获“黑屏”类致命错误。
 *
 * 布局：浏览器页面最左侧，占 1/4 面积（宽 25vw、高 100vh）。
 * 行为：进入沉浸式 VR 后 DOM 不可见；一旦退出 VR 回到预览界面，自动「暂停滚动」，
 *       防止报错信息被新日志顶掉而丢失（点顶部徽标可恢复）。
 */
(function () {
  if (window.__pageLogReady) return; // 避免重复注入
  window.__pageLogReady = true;

  var MAX_LINES = 600;
  var paused = false;
  var body, badge;

  function ensureDom() {
    if (body) return;
    var root = document.createElement('div');
    root.className = 'pagelog';
    root.innerHTML =
      '<div class="pagelog-head">' +
      '<span class="pagelog-title">运行日志 · 最高优先</span>' +
      '<span class="pagelog-pause" title="点击切换自动滚动">▶ 滚动中</span>' +
      '</div>' +
      '<div class="pagelog-body"></div>';
    document.body.appendChild(root);
    body = root.querySelector('.pagelog-body');
    badge = root.querySelector('.pagelog-pause');
    badge.addEventListener('click', function () { setPaused(!paused); });
  }

  function setPaused(p) {
    paused = p;
    if (badge) {
      badge.textContent = paused ? '⏸ 已暂停滚动（点此继续）' : '▶ 滚动中';
      badge.classList.toggle('on', paused);
    }
    if (!paused) scrollToBottom();
  }

  function scrollToBottom() {
    if (body) body.scrollTop = body.scrollHeight;
  }

  function fmt(v) {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.message + (v.stack ? '\n' + v.stack : '');
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  function append(msg, level) {
    ensureDom();
    var line = document.createElement('div');
    line.className = 'pagelog-line lvl-' + (level || 'info');
    var t = new Date();
    var ts = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) +
             ':' + ('0' + t.getSeconds()).slice(-2);
    line.textContent = '[' + ts + '] ' + msg;
    body.appendChild(line);
    while (body.childElementCount > MAX_LINES) body.removeChild(body.firstChild);
    if (!paused) scrollToBottom();
  }

  // ── 捕获 console.* ──
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (fn) {
    var orig = console[fn] ? console[fn].bind(console) : function () {};
    console[fn] = function () {
      var args = Array.prototype.slice.call(arguments);
      try { orig.apply(null, args); } catch (e) {}
      var level = fn === 'error' ? 'error' : fn === 'warn' ? 'warn' : 'info';
      append(args.map(fmt).join(' '), level);
    };
  });

  // ── 捕获未处理异常 / Promise 拒绝（含模块加载失败、语法错误）──
  window.addEventListener('error', function (e) {
    var loc = e.filename ? ' @ ' + e.filename + ':' + e.lineno + ':' + e.colno : '';
    append('❌ ' + (e.message || '未知错误') + loc, 'error');
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    append('❌ Promise 拒绝: ' + (r && r.message ? r.message : fmt(r)), 'error');
  });

  // ── 对外接口 ──
  window.__pageLog = {
    log: function (m) { append(String(m), 'info'); },
    info: function (m) { append(String(m), 'info'); },
    warn: function (m) { append(String(m), 'warn'); },
    error: function (m) { append(String(m), 'error'); },
    pauseScroll: function () { setPaused(true); },
    resumeScroll: function () { setPaused(false); },
    togglePause: function () { setPaused(!paused); },
    isPaused: function () { return paused; },
  };

  // 首条：脚本已注入
  append('页面日志初始化完成（最高优先，不受 three 加载影响）', 'info');
})();
