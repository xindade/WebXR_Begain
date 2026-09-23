// tools/cast-pc/renderer/renderer.js —— 接收端界面逻辑（viewer 角色）
//
// 全部走同源 HTTP：
//   GET  /api/events?role=viewer   SSE 下行（offer / ice / peer-left / peer-ready）
//   POST /api/signal               上行（answer / ice）
//   GET  /api/info                 状态轮询（端口 / IP / 对端在线 / 游戏根）
//   GET  /api/frame                JPEG 兜底模式取帧

const el = (id) => document.getElementById(id);
const video = el('video');
const img = el('img');
const intro = el('intro');
const hint = el('hint');
const logBox = el('logbox');     // ⚠️ 与 HTML #logbox 对应（之前写错成 'log' 一直拿不到）

let pc = null;
let pendingIce = [];       // 远端 candidate 先到时暂存，setRemoteDescription 后再灌入
let frameTimer = null;
let usingJpeg = false;     // JPEG 帧接收已初始化（IPC 直推或 HTTP 轮询）
let usingVideo = false;    // WebRTC 视频已接管画面（showFrame 应让位）
let iceCount = 0;          // 收到的 ICE 候选计数（用于诊断：一个都没有 = 网络不通）

let lastPub = null;        // 上次 publisher 状态，用于在变化时打日志
let lastVw = null;
let gotFrame = false;      // 是否已收到过任意一帧（决定画面区显示画面还是等待提示）
// ★ 第二十二修：头显当前推的是 960×540 的「占位画面」（预热链路）→ 不要把它铺满大屏
//   （放大后文字很糊），改用本窗口自绘的大号文案显示同样内容。
let warmupOn = false;
let introMuted = false;    // ★ 平台对接：默认**不静音** —— 现场观众要听到开场影片的声音。
                           //   （头显播影片期间不推流也不推音频，故不存在「两端声音打架」。）
let introVisible = false;  // 本地影片层是否正显示
let introEnded = false;    // 本地影片是否已播完（头显可能还在播 → 显示等待）
let introStopTimer = 0;    // 延迟隐藏影片层的定时器
let introHardTimer = 0;    // 硬兜底定时器（影片时长 +5s 必定收起）
let lastInfo = null;       // 最近一次 /api/info 结果（供 updateHint 用）

// ——————————————— 纯净模式（只保留游戏画面） ———————————————
// ★ 默认开启：现场直播/大屏只要画面，地址栏、游戏目录、授权面板与日志区按 H 全部隐藏。
// 优先级：URL ?pure=1 / ?pure=0（EXE 的 --pure / --panels 参数）> 上次手动切换（localStorage）> 默认开。
const PURE_KEY = 'castPure';
const pureParam = new URLSearchParams(location.search).get('pure');   // '1' / '0' / null
const pureStored = (() => { try { return localStorage.getItem(PURE_KEY); } catch (e) { return null; } })();
let pure = pureParam === '1' ? true
  : pureParam === '0' ? false
  : (pureStored === null ? true : pureStored === '1');

function setPure(on) {
  pure = on;
  document.body.classList.toggle('pure', on);
  try { localStorage.setItem(PURE_KEY, on ? '1' : '0'); } catch (e) { /* 隐私模式忽略 */ }
  if (!on) flushLog();             // 唤回面板：把纯净模式期间攒下的日志补上
  toast(on ? '纯净模式：仅显示画面（H 恢复面板 · F 全屏）' : '已恢复完整面板');
}

function toast(msg) {
  const t = el('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('on'), 1800);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

document.addEventListener('keydown', (e) => {
  const k = (e.key || '').toLowerCase();
  // ⚠ 输入框里打字**不算**快捷键：在「游戏目录」里输 E:\AI_Work\... 会顺手按下 E
  //   ⇒ 不设防就会当场「结束本局」（第十八修收尾）。修饰键组合同理（Ctrl+S 不该放行本局）。
  const tgt = e.target;
  if (tgt && (tgt.isContentEditable || /^(input|textarea|select)$/i.test(tgt.tagName || ''))) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === 'h') setPure(!pure);
  else if (k === 'f') toggleFullscreen();
  else if (k === 's') setRound(true, '快捷键 S');    // 本局放行：开始本局（第十八修）
  else if (k === 'e') setRound(false, '快捷键 E');   // 本局放行：结束本局
  else if (k === 'm') {                    // 开场影片声音开关（默认**开声**，观众要听得到）
    introMuted = !introMuted;
    intro.muted = introMuted;
    toast(introMuted ? '开场影片已静音（再按 M 开启）' : '开场影片已开启声音');
  }
});
document.body.classList.toggle('pure', pure);

// ——————————————— 诊断日志 ———————————————
// EXE 打包后看不到控制台，把关键事件打到界面上，便于定位「卡在哪一步」。
// ★ 默认纯净模式下日志区是隐藏的 ⇒ 每条日志都先进内存环形缓冲（保留最近 200 条），
//   按 H 唤回面板时**补渲染**。否则启动阶段的信令协商日志会白丢，黑屏时无从排查。
// force=true 的条目即使处于纯净模式也立刻写 DOM（关键诊断即时可见）。
const LOG_MAX = 200;
const logBuf = [];
function appendLog(e) {
  if (!logBox) return;
  const d = document.createElement('div');
  d.innerHTML = `<span class="l-time">[${e.t}]</span> `
    + (e.cls ? `<span class="${e.cls}">${e.msg}</span>` : e.msg);
  logBox.appendChild(d);
  while (logBox.children.length > LOG_MAX) logBox.removeChild(logBox.firstChild);
  logBox.scrollTop = logBox.scrollHeight;
}
function flushLog() {
  if (!logBox) return;
  logBox.innerHTML = '';
  for (const e of logBuf) appendLog(e);
}
function log(msg, cls, force) {
  const e = { t: new Date().toTimeString().slice(0, 8), msg, cls };
  logBuf.push(e);
  while (logBuf.length > LOG_MAX) logBuf.shift();
  if (pure && !force) return;      // 纯净模式：只入内存不写 DOM（省 CPU），唤回面板时补渲染
  appendLog(e);
}

// ——————————————— 平台参数显示（文档第 4 条）———————————————
// 现场排障第一件事就是确认「平台到底给了什么参数」。打包成 EXE 后没有控制台，只能靠界面，
// 所以直接显示在顶部：房间号 / 平台 IP / 游戏名 / 平台传来的 exe 相对路径。
function renderPlatformArgs(pf) {
  const n = el('platargs');
  if (!n) return;
  if (!pf || (!pf.room && !pf.platform && !pf.game)) {
    n.className = 'dim';
    n.textContent = '未提供（独立运行：自动发现接收端 + 手动配置游戏目录）';
    return;
  }
  n.className = 'ok';
  n.textContent = `房间 ${pf.room || '-'} · 平台 ${pf.platform || '-'} · 游戏 ${pf.game || '-'}`
    + (pf.exeRel ? ` · ${pf.exeRel}` : '');
}

// ——————————————— 本局放行（开始本局 / 结束本局，第十八修）———————————————
// 这是「平台开始游戏信号」在我们这一侧的唯一来源：头显页面（src/main.js 的主控门禁）每 2 秒问一次
// /api/master/allow，只有这里 armed=true 才会让「进入 VR」按钮出现。故它在**纯净模式下也保留**。
function renderRound(r) {
  if (!r) return;
  const on = !!r.armed;
  const st = el('roundState');
  if (st) { st.textContent = on ? '本局进行中' : '未开始'; st.style.color = on ? '#51cf66' : '#7a7a8c'; }
  const a = el('roundStart'), b = el('roundEnd');
  if (a) a.disabled = on;          // 已开始 → 「开始本局」不可点（避免重复触发）
  if (b) b.disabled = !on;         // 未开始 → 「结束本局」不可点
}

async function setRound(armed, why) {
  try {
    renderRound(await window.castCfg.roundSet({ armed, why }));
    toast(armed ? '已放行本局：头显将出现「进入 VR」' : '已结束本局：头显收尾并收掉浏览器');
  } catch (e) {
    log('本局放行设置失败：' + (e && e.message ? e.message : e), 'l-bad', true);
  }
}

if (el('roundStart')) el('roundStart').onclick = () => setRound(true, 'PC 界面点「开始本局」');
if (el('roundEnd')) el('roundEnd').onclick = () => setRound(false, 'PC 界面点「结束本局」');
// 页面侧上报的「本局结束」（通关 / 平台关闭）也会经主进程广播回来 —— 界面上要跟着变，别停在「进行中」
window.castCfg.onRoundChanged?.((r) => {
  renderRound(r);
  if (r && r.why) log(`本局放行 ${r.armed ? '已开启' : '已结束'}（${r.why}）`, r.armed ? 'l-ok' : 'l-warn', true);
});
(async () => { try { renderRound(await window.castCfg.roundGet()); } catch (e) { /* 忽略 */ } })();

// ——————————————— 状态轮询 ———————————————
async function pollInfo() {
  try {
    const r = await fetch('/api/info', { cache: 'no-store' });
    const info = await r.json();
    lastInfo = info;
    el('ips').textContent = (info.ips || []).join('  ');
    const url = info.ips && info.ips.length
      ? `http://${info.ips[0]}:${info.port}/?cast=1`
      : `http://<电脑IP>:${info.port}/?cast=1`;
    el('url').textContent = url;
    renderPlatformArgs(info.platform);
    setOnline(el('pub'), info.publisher);
    setOnline(el('vw'), info.viewer);
    if (lastPub === null || info.publisher !== lastPub) {
      if (lastPub !== null) log(`推流端 ${info.publisher ? '上线' : '离线'}`, info.publisher ? 'l-ok' : 'l-warn');
      lastPub = info.publisher;
    }
    if (lastVw === null || info.viewer !== lastVw) {
      if (lastVw !== null) log(`接收端 SSE ${info.viewer ? '已连接' : '断开'}`, info.viewer ? 'l-ok' : 'l-warn');
      lastVw = info.viewer;
    }
    // 配置来源反映到 cfgbox（第二十二修：不再有「托管整站 / 路径②」这个概念，只报配置来自哪）
    const cs = el('cfgStatus');
    if (info.extCfg) {
      cs.className = 'gs';
      cs.textContent = `✓ 外部配置：${info.gameRoot}`;
    } else if (info.bundledCfg) {
      // ★ 第二十一修：EXE 自带配置（换电脑零配置），无需再手填游戏目录
      cs.className = 'gs';
      cs.textContent = '✓ 已内置配置（随 EXE 安装，无需填写）';
    } else {
      cs.className = 'gb';
      cs.textContent = '✗ 没有可用配置（头显会被拒绝启动）';
    }
    // ★ 第二十二修：运维面板（「游戏目录」）正式包默认不显示，只有 --panels 才露出来
    if (typeof info.panels === 'boolean') document.body.classList.toggle('no-cfg', !info.panels);
    updateHint(info);      // 画面区状态提示：没帧时明确告诉用户当前卡在哪一步
  } catch (e) {
    el('ips').textContent = '（无法连接本机服务）';
  }
}
/**
 * ★ 第二十二修：占位画面的显示切换。
 *
 * <p>头显在菜单/等待房间阶段推的是 960×540 的 2D 占位画（见 src/net/cast.js 的 _startWarmup）；
 * PC 大屏把它铺满后文字很糊（现场反馈）。这里在收到 `warmup` 信令时改用本窗口渲染的
 * 大号矢量文案（#hint.big），并暂时不显示视频层；头显切到真实游戏画面后再交回常规逻辑。
 *
 * @param {boolean} on 头显是否处于占位阶段
 */
function setWarmupView(on) {
  const next = !!on;
  if (next === warmupOn) return;
  warmupOn = next;
  if (warmupOn) {
    video.classList.remove('on');
    img.classList.remove('on');
    hint.style.display = '';
    hint.classList.add('big');
    hint.innerHTML = 'PICO 直播 · 已连接'
      + '<span class="sub">等待头显开始游戏…（进入第 1 关后自动切换到游戏画面）</span>';
    log('头显当前推的是占位画面 → 大屏改用自绘文案显示（避免放大发糊）', 'l-dim', true);
    return;
  }
  hint.classList.remove('big');
  // 占位结束 = 真实游戏画面来了：有流就把视频层显示出来，否则交回 updateHint 的常规判断
  if (usingVideo && video.srcObject) {
    video.classList.add('on');
    img.classList.remove('on');
    hint.style.display = 'none';
    log('头显已切到游戏画面', 'l-ok', true);
  } else {
    updateHint(lastInfo);
  }
}

// ——————————————— 画面区等待提示 ———————————————
// 「一直黑屏、连是否连上都不知道」是最常被反馈的困惑。画面区在没有帧时按当前进度
// 显示明确状态（等待设备 / 正在协商 / 已连接等待开始游戏），而不是一句静态文案。
function updateHint(info) {
  // 本机影片先播完、头显还在播 → 停在末帧并提示等待（比切到占位画面更连贯）
  if (introVisible && introEnded) {
    hint.style.display = '';
    hint.innerHTML = '本机影片已播完<br /><span class="dim">等待头显影片结束，随后自动进入游戏画面。</span>';
    return;
  }
  // ★ 第二十二修：占位阶段 → 用本窗口自绘的大号清晰文案（替代被放大的 960×540 占位帧）
  if (warmupOn && !introVisible) {
    hint.style.display = '';
    hint.classList.add('big');
    hint.innerHTML = 'PICO 直播 · 已连接'
      + '<span class="sub">等待头显开始游戏…（进入第 1 关后自动切换到游戏画面）</span>';
    return;
  }
  hint.classList.remove('big');
  if (gotFrame || introVisible) { hint.style.display = 'none'; return; }
  hint.style.display = '';
  const rtc = pc ? pc.connectionState : '';
  let main = '等待推流端连接…';
  let sub = '在头显中打开 APK，或直接用浏览器打开上方地址，即可自动出画。';
  if (info && info.publisher) {
    if (rtc === 'connected') {
      main = '已连接，等待头显开始游戏…';
      sub = '预览与开场影片阶段只出占位画面；进入第 1 关后自动切换到游戏画面。';
    } else if (rtc === 'connecting' || rtc === 'checking' || rtc === 'new') {
      main = '推流端已上线，正在建立 P2P 连接…';
      sub = '若长时间停在这一步，多为防火墙或网段隔离，详见下方日志。';
    } else {
      main = '推流端已上线，等待其发起连接…';
      sub = '';
    }
  }
  hint.innerHTML = `${main}<br /><span class="dim">${sub}</span>`;
}

// ——————————————— 开场影片：本机同步播放 ———————————————
// 头显播影片时**不能做 H.264 编码**（视频解码 × 编码争用 VPU → 头显里影片一闪一闪），
// 那段时间 PC 大屏收不到头显画面。改为让 PC 端播**本地同一段影片**：
// 头显在开始 / 结束时各发一条 intro 信令，两端对齐；影片一结束头显立刻恢复推流，
// PC 端同步切回游戏画面 —— 观感上就是一条连续的视频。
function startIntro(src) {
  clearTimeout(introStopTimer);
  const rel = String(src || '').replace(/^\/+/, '');
  if (!rel) return;
  const url = '/' + rel;                 // 同源：由 EXE 内置目录（resources/game-cfg）提供
  if (intro.dataset.src !== url) { intro.dataset.src = url; intro.src = url; }
  intro.muted = introMuted;              // 默认静音：两端声音必然不同步，会互相干扰
  try { intro.currentTime = 0; } catch (e) { /* 尚未加载完，忽略 */ }
  introEnded = false;
  introVisible = true;
  intro.classList.add('on');
  const p = intro.play();
  if (p && p.catch) {
    p.catch((e) => {
      log(`本地影片播放失败：${e.message}（取不到 ${url}：EXE 没装内置配置，也没配外部配置目录）`, 'l-warn', true);
      stopIntro();
    });
  }
  log(`头显正在播放开场影片 → 本机同步播放 ${url}`, 'l-ok', true);
}

function stopIntro() {
  clearTimeout(introStopTimer);
  clearTimeout(introHardTimer);
  if (!introVisible) return;
  introVisible = false;
  introEnded = false;
  intro.classList.remove('on');
  try { intro.pause(); } catch (e) { /* 忽略 */ }
  log('开场影片结束，已切回头显画面', 'l-ok', true);
}

/** 延迟隐藏：等头显侧的 replaceTrack 完成再切，避免中间闪一帧占位画面 */
function scheduleStopIntro(delayMs) {
  clearTimeout(introStopTimer);
  introStopTimer = setTimeout(stopIntro, delayMs);
}

intro.addEventListener('ended', () => {
  introEnded = true;
  // 本机影片先播完（头显可能晚一点）：停在末帧提示等待，
  // 1.2s 后仍没收到头显的结束通知就自动切回（防信令丢失导致永久遮挡推流画面）。
  scheduleStopIntro(1200);
  updateHint(lastInfo);
});
intro.addEventListener('error', () => {
  if (!introVisible) return;
  log('本地影片加载失败：检查 EXE 内置配置是否完整（assets/intro/intro.mp4），或已托管完整游戏目录', 'l-warn', true);
  stopIntro();
});
// 硬兜底：无论发生什么，影片时长 +5s 后必定收起（信令丢失也不会一直挡着游戏画面）
intro.addEventListener('loadedmetadata', () => {
  clearTimeout(introHardTimer);
  const d = intro.duration;
  if (d && isFinite(d)) introHardTimer = setTimeout(stopIntro, (d + 5) * 1000);
});

function setOnline(node, on) {
  node.textContent = on ? '在线' : '离线';
  node.className = on ? 'ok' : 'bad';
}

// ——————————————— WebRTC ———————————————
function ensurePc() {
  if (pc) return pc;
  // iceServers 留空 → 只收集 host candidate，局域网直连最快；
  // 配 STUN 会引入 srflx 候选，家用路由通常不支持 NAT 回环，反而连不上。
  pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });

  pc.ontrack = (e) => {
    showVideo(e.streams[0]);
  };
  pc.onicecandidate = (e) => {
    post({ type: 'ice', candidate: e.candidate ? e.candidate.toJSON() : null });
  };
  pc.onconnectionstatechange = () => {
    el('rtc').textContent = pc.connectionState;
    el('rtc').className = pc.connectionState === 'connected' ? 'ok'
      : (pc.connectionState === 'failed' ? 'bad' : 'dim');
    log(`WebRTC 连接状态 → ${pc.connectionState}`,
        pc.connectionState === 'connected' ? 'l-ok'
        : (pc.connectionState === 'failed' ? 'l-bad' : ''));
    // 注意：这里不能只靠 failed 去切 JPEG 兜底 —— JPEG 模式下推流端压根不发 offer，
    // pc 永远不会创建，failed 事件也就永不触发。统一交给 manageJpeg() 按连接状态判断。
  };
  // ICE 状态比 connectionState 更早反映「网络是否可达」，单独打出来方便排查
  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === 'failed' || s === 'disconnected') {
      log(`ICE ${s}：头显与电脑之间的 P2P 通道不通（多为防火墙/网段隔离）`, 'l-bad');
    } else if (s === 'checking') {
      log('ICE 正在协商…');
    }
  };
  return pc;
}

function showVideo(stream) {
  // WebRTC 画面优先：若此前正在跑 JPEG 轮询，先停掉它再切到 video
  if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
  usingJpeg = false;
  usingVideo = true;
  gotFrame = true;
  video.srcObject = stream;
  // 音频（★ 平台对接）：头显把 AudioContext 总线接成音轨，跟视频一起推上来。
  // Chromium 默认拦「无手势自动播放带声」，已在 main.js 用 autoplay-policy 对本进程放开，
  // 所以这里显式开声即可 —— 现场大屏不会有人去点一下。
  const audioTracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
  if (audioTracks.length) {
    video.muted = false;
    log(`已接入远端音频轨 ${audioTracks.length} 条 → 大屏出声`, 'l-ok', true);
  }
  video.play().catch(() => {});
  // ★ 第二十二修：占位阶段先不显示视频层（那帧是 960×540 的占位画，铺满会糊）；
  //   等头显切到真实游戏画面（warmup off）再显示。
  if (!warmupOn) {
    video.classList.add('on');
    img.classList.remove('on');
    hint.style.display = 'none';
  }
  log('收到远端媒体流，开始显示画面 ✅', 'l-ok');
  startVideoWatchdog();
}

// ——————————————— 收帧诊断与自愈 ———————————————
// 「已 connected 但黑屏」是最难排查的故障：链路看着通了，其实编码器一帧都没产出。
// 每 3 秒读一次解码统计；若连上后 8 秒仍 0 帧，判定推流侧没出帧 —— 必须放开
// usingVideo（否则 showFrame() 会永久忽略 JPEG 帧 → 永远黑屏且不会自愈）。
let vwTimer = null;
let vwZeroSince = 0;
function startVideoWatchdog() {
  if (vwTimer) clearInterval(vwTimer);
  vwZeroSince = Date.now();
  vwTimer = setInterval(() => {
    if (!usingVideo) { clearInterval(vwTimer); vwTimer = null; return; }
    const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
    const total = q ? q.totalVideoFrames : 0;
    const dropped = q ? q.droppedVideoFrames : 0;
    const w = video.videoWidth || 0;
    const h = video.videoHeight || 0;
    log(`收帧诊断 ${w}×${h} 已解码=${total} 丢帧=${dropped}`,
        total > 0 ? 'l-dim' : 'l-warn', true);
    if (q ? total > 0 : w > 0) { vwZeroSince = 0; return; }   // 有帧（或至少拿到分辨率）→ 正常
    if (vwZeroSince && Date.now() - vwZeroSince > 8000) {
      vwZeroSince = 0;
      log('WebRTC 已连接但 8 秒未解出任何帧 → 放开画面，改由 JPEG 兜底接管', 'l-bad', true);
      usingVideo = false;                                    // 关键：让 showFrame() 重新生效
      if (!usingJpeg && !frameTimer) startJpegPolling();     // IPC 不可用时补上轮询
    }
  }, 3000);
}

async function onOffer(sdp) {
  const c = ensurePc();
  try {
    log(`收到推流端 offer（${sdp.length} 字节），正在应答…`);
    await c.setRemoteDescription({ type: 'offer', sdp });
    for (const cand of pendingIce) { await c.addIceCandidate(cand).catch(() => {}); }
    if (pendingIce.length) log(`已补入 ${pendingIce.length} 个先到的 ICE 候选`);
    pendingIce = [];
    const answer = await c.createAnswer();
    await c.setLocalDescription(answer);
    log('已发出 answer，等待媒体流…', 'l-ok');
    post({ type: 'answer', sdp: c.localDescription.sdp });
  } catch (e) {
    log(`处理 offer 失败：${e.message}`, 'l-bad');
    console.error('[viewer] 处理 offer 失败:', e);
  }
}

function onIce(candidate) {
  const c = ensurePc();
  if (!candidate) return;
  iceCount++;
  // ICE 候选很多，逐条打印会刷屏：只打首条与每 10 条的累计
  if (iceCount === 1) log('收到首个 ICE 候选（网络协商已启动）');
  else if (iceCount % 10 === 0) log(`已收到 ${iceCount} 个 ICE 候选，仍在协商…`, 'l-dim');
  if (c.remoteDescription) c.addIceCandidate(candidate).catch(() => {});
  else pendingIce.push(candidate);      // offer 还没到，先存着
}

function resetPc() {
  if (pc) { try { pc.close(); } catch (e) { /* 忽略 */ } }
  pc = null;
  pendingIce = [];
  iceCount = 0;
  usingVideo = false;
  gotFrame = false;          // 画面已断开 → 等待提示重新出现
  warmupOn = false;          // ★ 第二十二修：断开后占位显示一并复位
  hint.classList.remove('big');
  stopIntro();               // 链路断了，本地影片一并收起（否则会一直挡着画面）
  if (vwTimer) { clearInterval(vwTimer); vwTimer = null; }   // 停掉收帧诊断，避免误判告警
  el('rtc').textContent = '-';
  el('rtc').className = 'dim';
  video.classList.remove('on');
  video.srcObject = null;
  hint.style.display = '';
}

// ——————————————— JPEG 兜底 ———————————————
// 只要 WebRTC 没连上就轮询取帧（覆盖三种情况：
//   ① 推流端就是 JPEG 模式，永远不会来 offer；
//   ② ICE 协商失败（mDNS / 防火墙 / 多网卡）；
//   ③ 推流端还没开始推，稍后才有帧）。
function rtcConnected() {
  return !!pc && pc.connectionState === 'connected';
}

// ——————————————— JPEG 接收（IPC 直推，无轮询） ———————————————
// 主进程收到推流端 POST 的帧后，通过 IPC 'cast:frame' 直接推到本渲染进程，
// 免去原先「PC 每 33ms 轮询 GET /api/frame」的空帧/重复帧抖动（卡顿根因）。
function showFrame(buf) {
  if (usingVideo) return;                  // WebRTC 视频已接管，忽略 JPEG 帧
  // ★ 第二十二修：占位阶段（JPEG 兜底模式同理）不显示被放大的占位帧 —— 大屏用自绘文案，
  //   这里只记「活着」，等 warmup off 再照常出画。
  if (warmupOn) { gotFrame = true; return; }
  gotFrame = true;
  const blob = new Blob([buf], { type: 'image/jpeg' });
  const url = URL.createObjectURL(blob);
  const old = img.src;
  img.src = url;
  img.classList.add('on');
  video.classList.remove('on');
  hint.style.display = 'none';
  if (old && old.startsWith('blob:')) URL.revokeObjectURL(old);
}

// 优先走 IPC 直推；无钩子时退回 HTTP 轮询（理论上不会发生，因 preload 已暴露 castCfg.onFrame）
function initJpeg() {
  if (window.castCfg && typeof window.castCfg.onFrame === 'function') {
    window.castCfg.onFrame(showFrame);
    usingJpeg = true;
    console.warn('[viewer] JPEG 帧走 IPC 直推（无轮询）');
  } else {
    log('未找到 IPC 帧通道，退回 HTTP 轮询兜底', 'l-warn');
    startJpegPolling();
  }
}

function manageJpeg() {
  if (rtcConnected()) {
    if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
    usingJpeg = false;
    return;
  }
  // 仅 WebRTC 未连通时初始化一次 JPEG 接收（优先 IPC，否则轮询）
  if (!frameTimer && !usingJpeg) initJpeg();
}

function startJpegPolling() {
  if (frameTimer) return;
  usingJpeg = true;
  log('WebRTC 尚未连通，开始轮询 JPEG 兜底帧…', 'l-warn');
  console.warn('[viewer] 切换到 JPEG 兜底模式（轮询）');
  frameTimer = setInterval(async () => {
    try {
      const r = await fetch('/api/frame', { cache: 'no-store' });
      if (r.status === 204) return;                 // 还没有帧
      if (!r.ok) return;
      const blob = await r.blob();
      showFrame(await blob.arrayBuffer());
    } catch (e) { /* 忽略单次取帧失败 */ }
  }, 33);
}

// ——————————————— 上行 ———————————————
async function post(obj) {
  try {
    await fetch('/api/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...obj, role: 'viewer' }),
    });
  } catch (e) {
    log(`POST /api/signal 失败：${e.message}`, 'l-bad');
    console.error('[viewer] POST /api/signal 失败:', e.message);
  }
}

// ——————————————— SSE 下行 ———————————————
function connect() {
  const es = new EventSource('/api/events?role=viewer');
  es.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    switch (m.type) {
      case 'welcome':
        log('已注册为接收端，监听中…');
        break;
      case 'warmup':
        // ★ 第二十二修：头显告知「现在推的是占位画面」→ 切到自绘清晰文案（见 setWarmupView）
        setWarmupView(m.on);
        break;
      case 'peer-ready':
        log('推流端已上线，等待其发起 offer…', 'l-ok');
        break;
      case 'intro':
        // 头显开场影片的开始 / 结束（PC 端据此同步播放本地影片）
        if (m.stage === 'play') startIntro(m.src);
        else {
          scheduleStopIntro(400);           // 稍等，让头显的 replaceTrack 完成再切，避免闪占位画面
          // ★ 第二十二修：影片结束 = 马上进第 1 关 = 占位阶段结束。这里强制解除占位显示，
          //   兜住「warmup 信令丢失」的情况（否则大屏会一直停在自绘文案上）。
          setWarmupView(false);
        }
        break;
      case 'offer':
        onOffer(m.sdp);
        break;
      case 'ice':
        onIce(m.candidate);
        break;
      case 'peer-left':
        log('推流端已离开', 'l-warn');
        resetPc();
        break;
      default:
        break;
    }
  };
  es.onerror = () => {
    // EventSource 会自动重连，这里只更新界面提示
    setOnline(el('vw'), false);
  };
}

// ——————————————— 交互 ———————————————
el('copy').onclick = () => {
  const text = el('url').textContent;
  navigator.clipboard?.writeText(text).then(
    () => { el('copy').textContent = '已复制'; setTimeout(() => { el('copy').textContent = '复制'; }, 1200); },
    () => { console.warn('复制失败，请手动选中'); }
  );
};

// ——————————————— 游戏目录配置（IPC） ———————————————
async function refreshCfg() {
  if (!window.castCfg) return;
  try {
    const cfg = await window.castCfg.get();
    el('cfgRoot').value = cfg.gameRoot || '';
    const cs = el('cfgStatus');
    if (cfg.extCfg) { cs.className = 'gs'; cs.textContent = `✓ 外部配置：${cfg.gameRoot}`; }
    else if (cfg.bundledCfg) { cs.className = 'gs'; cs.textContent = '✓ 已内置配置（随 EXE 安装，无需填写）'; }
    else { cs.className = 'gb'; cs.textContent = '✗ 没有可用配置（头显会被拒绝启动）'; }
    if (typeof cfg.panels === 'boolean') document.body.classList.toggle('no-cfg', !cfg.panels);
  } catch (e) { /* 忽略 */ }
}
el('cfgApply').onclick = async () => {
  if (!window.castCfg) { log('当前未启用 preload，无法保存配置', 'l-bad'); return; }
  const v = el('cfgRoot').value.trim();
  el('cfgStatus').textContent = '保存中…'; el('cfgStatus').className = 'dim';
  try {
    const r = await window.castCfg.set({ gameRoot: v });
    if (r.ok) {
      log(`游戏目录已更新：${r.gameRoot || '（清空）'}`, 'l-ok');
      el('cfgStatus').className = (r.extCfg || r.bundledCfg) ? 'gs' : 'gb';
      el('cfgStatus').textContent = r.extCfg ? `✓ 外部配置：${r.gameRoot}`
        : (r.bundledCfg ? '✓ 已清空 → 改用 EXE 内置配置' : '✗ 已清空（重启 EXE 生效）');
    } else {
      el('cfgStatus').className = 'gb';
      el('cfgStatus').textContent = `✗ ${r.msg}`;
      log(`配置失败：${r.msg}`, 'l-bad');
    }
  } catch (e) {
    el('cfgStatus').className = 'gb';
    el('cfgStatus').textContent = `✗ ${e.message}`;
  }
};

// ——————————————— 授权面板（License） ———————————————
// 本机（直播端）**自己**的授权状态。★ 兜底 0 天 ⇒ 这里不合法，头显一律启动不了，
// 所以「头显为什么起不来」的第一嫌疑人永远是这一栏 —— 特意放在最上面一排。
//
// 判定逻辑全在 main.js，这里只做显示与触发：
//   activate → 用激活码（管理后台生成）换第一份 license；一次性，换机后要重来
//   renew    → 用本机 Ke 签持有证明换新 license；到期前 3 天由主进程自动跑，也可手动点
//   reload   → 手工放一份 license.json 后热载，免重启
const LIC_MODES = {
  none:     { text: '未激活', cls: 'lic-bad' },
  invalid:  { text: '授权无效', cls: 'lic-bad' },
  expired:  { text: '已到期（已停放行）', cls: 'lic-bad' },
  expiring: { text: '即将到期', cls: 'lic-warn' },
  active:   { text: '授权有效', cls: 'lic-ok' },
};

function renderLicense(s) {
  if (!s) return;
  const m = LIC_MODES[s.mode] || { text: s.mode || '未知', cls: 'lic-bad' };
  const st = el('licState');
  if (st) {
    st.className = m.cls;
    st.textContent = m.text + (s.ok ? '' : (s.why ? `（${s.why}）` : ''));
  }
  if (el('licDays')) el('licDays').textContent = s.exp ? String(s.daysLeft) : '–';
  if (el('licWho')) {
    el('licWho').textContent = s.lic
      ? `｜${s.lic}｜客户 ${s.cust || '-'}｜到期 ${s.exp ? new Date(s.exp).toLocaleString() : '-'}`
        + (s.lastRenewWhy ? `｜上次续期：${s.lastRenewWhy}` : '')
      : `｜授权服务器 ${s.base || '-'}｜兜底 ${s.grace || 0} 天`;
  }
  if (el('licDev')) el('licDev').textContent = `设备指纹 ${s.devShort || '-'}…（${s.host || '-'}）`;
}

async function refreshLicense() {
  if (!window.castCfg || !window.castCfg.licenseGet) return;
  try { renderLicense(await window.castCfg.licenseGet()); } catch (e) { /* 忽略 */ }
}

if (el('licActivate')) {
  el('licActivate').onclick = async () => {
    const code = (el('licCode') && el('licCode').value || '').trim();
    if (!code) { log('请先填入激活码（在管理后台 https://webvr123.site/admin 生成）', 'l-warn'); return; }
    el('licActivate').disabled = true;
    log('正在激活…（连接授权服务器，最长 8 秒）', 'l-dim');
    try {
      const r = await window.castCfg.licenseSet({ actCode: code });
      renderLicense(r.state);
      log(r.ok ? `激活成功：${r.why || ''}` : `激活失败：${r.why || '未知'}`, r.ok ? 'l-ok' : 'l-bad');
      if (r.ok) { el('licCode').value = ''; if (typeof toast === 'function') toast('激活成功'); }
    } finally { el('licActivate').disabled = false; }
  };
}
if (el('licRenew')) {
  el('licRenew').onclick = async () => {
    el('licRenew').disabled = true;
    log('正在续期…（用本机密钥签持有证明）', 'l-dim');
    try {
      const r = await window.castCfg.licenseSet({ renew: true });
      renderLicense(r.state);
      log(r.ok ? '续期成功' : `续期失败：${r.why || '未知'}`, r.ok ? 'l-ok' : 'l-bad');
    } finally { el('licRenew').disabled = false; }
  };
}
if (el('licReload')) {
  el('licReload').onclick = async () => {
    const r = await window.castCfg.licenseSet({ reload: true });
    renderLicense(r.state);
    log(`已重载 license 文件：${(r.state && r.state.why) || ''}`, r.ok ? 'l-ok' : 'l-warn');
  };
}

// ——————————————— 启动授权面板（LaunchGuard） ———————————————
// 主进程持有密钥与白名单；这里只做显示与增删。头显每次「首次拉起」都会来问一次，
// 结果实时推回（onGuardLog）打在下方的日志区，现场一眼能看出「为什么这台头显启动不了」。
//
// ★ 第十七修：密钥改成**两端固定的共享串**（无需抄写），界面上只展示、不再提供「重置」——
//   重置密钥只会把头显踢出去，而且头显进不了配置页 ⇒ 现场无法自救。要重新配对请用
//   「重新配对」（清空白名单 → 重开配对窗口）。
function renderGuard(g) {
  el('guardSecret').textContent = g.secret || '(未初始化)';
  el('guardAuto').checked = !!g.autoAllow;
  const ses = el('guardSession');
  if (ses) {
    ses.textContent = `局号 ${g.session || '?'}｜配置下发 ${(g.configManifest || []).length} 项`
        + (g.pairingWindow ? '｜★ 配对窗口开启中（白名单为空，下一台设备将被自动登记）' : '');
  }
  const box = el('guardList');
  box.className = 'dim';
  box.textContent = '';
  const head = document.createElement('span');
  head.textContent = `白名单（${g.allowList.length}）：`;
  box.appendChild(head);
  if (!g.allowList.length) {
    const none = document.createElement('span');
    none.textContent = '（空 —— 配对窗口开启，第一台来请求的头显会自动登记）';
    box.appendChild(none);
    return;
  }
  g.allowList.forEach((dev) => {
    const chip = document.createElement('span');
    chip.className = 'dev';
    chip.textContent = dev;
    const x = document.createElement('i');
    x.textContent = '×';
    x.title = '移出白名单（该头显下次启动会被拒绝）';
    x.onclick = async () => {
      await window.castCfg.guardSet({ removeDev: dev });
      log(`已移出白名单：${dev}`, 'l-warn');
      refreshGuard();
    };
    chip.appendChild(x);
    box.appendChild(chip);
  });
}

async function refreshGuard() {
  if (!window.castCfg || !window.castCfg.guardGet) return;
  try { renderGuard(await window.castCfg.guardGet()); } catch (e) { /* 忽略 */ }
}

el('guardReset').onclick = async () => {
  if (!confirm('「重新配对」会清空白名单 → 配对窗口重新开启，下一台来请求的头显将自动登记。\n'
      + '原本已授权的头显也会被重新登记（设备号不变，实际无影响）。继续？')) return;
  const r = await window.castCfg.guardSet({ resetPairing: true });
  renderGuard(r);
  log('白名单已清空 → 配对窗口开启，等头显来请求即自动登记；密钥两端固定，无需任何抄写。', 'l-warn');
};
el('guardAuto').onchange = async () => {
  const on = el('guardAuto').checked;
  await window.castCfg.guardSet({ autoAllow: on });
  log(on ? '新设备将自动登记进白名单（首次请求即放行）' : '新设备必须先手动加入白名单，否则启动被拒', 'l-dim');
  refreshGuard();
};
if (window.castCfg && window.castCfg.onGuardLog) {
  window.castCfg.onGuardLog((e) => {
    log(`启动授权 ${e.allow ? '放行' : '拒绝'} · 设备 ${e.dev || '(空)'} · ${e.ip || ''} · ${e.why || ''}`,
        e.allow ? 'l-ok' : 'l-bad');
    refreshGuard();   // 自动登记会改白名单，顺手刷新
  });
}

connect();
refreshCfg();
refreshGuard();
refreshLicense();
setInterval(refreshLicense, 60000);   // 剩余天数会走，每分钟刷一次（主进程 6h 才真去联网）
initJpeg();          // 启动即订阅 IPC 帧通道（收帧即显示，无轮询），避免等 manageJpeg 的首个 1s 周期
pollInfo();
log('接收端已启动；先保持本窗口运行，再到头显打开 APK（或直接打开上面地址）。', 'l-dim');
setInterval(() => {
  pollInfo();
  manageJpeg();          // 每秒判断一次：RTC 没连上就走 JPEG 兜底取帧
}, 1000);
