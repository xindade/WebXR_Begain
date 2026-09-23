// VR+ 平台桥接（游戏侧 / Web JS）。
//
// 游戏跑在 PICO 浏览器，origin = http://localhost:8080，与 APK 的 GameServer 同源，
// 所以下列请求无跨域/PNA 问题。APK 原生层（VRPlusLink.java）负责真正的 UDP 收发，
// 这里只通过同源 /api/vrplus/* 与它对话：
//   GET  /api/vrplus/status -> {"connected":bool,"bridgeReady":bool,"platform":"<ip>"}  在线状态
//   POST /api/vrplus/send   -> body {"cmd":N}   游戏上行
//   GET  /api/vrplus/inbox  -> [{"cmd":N,...}, ...]  平台下行（轮询拉取）
//
// 协议（2026-09-17 **完整会话抓包** cap3.pcap 钉死；详见 docs/tech/VR+平台版本号实现.md 第 11 节）：
//   —— APK ↔ 平台的「游戏通道」UDP 51124(本机监听) / 51234(平台) **全是带帧头的二进制**，
//      而且**一次健康会话只有 4 个帧**（120 秒 / 27216 包实测）：
//      0x01            设备→平台 注册（APK 自动发；未收到机器表前每 3s 重试，收到即停）
//      0x01 0x02 + JSON 平台→设备 机位表 {"Machines":[...]}（注册后 57ms 就回）→ 包成 inbox 的 cmd=0
//      0x10 closeGame  平台→设备 关游戏（\x10 + "closeGame" + 两个空格，共 12 字节）→ 包成 inbox 的 cmd=16
//      0x02            设备→平台 closeGame 确认（APK 自动回，7ms 内）
//   —— ⚠ 玩家侧**不发 0x08**：曾误以为「收到机器表要回 0x08，否则平台每 20s 重拉 am start」，
//      抓包证明是错的（整场没有任何 0x08；平台只发一次 start，注册后 94 秒静默也没人催）。
//      APK 里那段身份上报已删除。
//   —— ⚠ 旧 V2.9 的 cmd 3/4/5/6 数字 JSON **新平台不认**（APK 已拒发）。
//      下面的 VRPlusGame 保留仅为兼容旧平台/统计，调用后 APK 只会记一条「忽略非协议命令」。
//
// 游戏侧真正要接的下行只有：**cmd 16 = 平台关游戏**（见 game.js._onPlatformCommand）。

const BASE = '/api/vrplus';
const PAGE_API = '/api/page';   // 「死亡留痕」端点（见下）；APK 侧落盘成跨进程存活的时间线
let inboxTimer = null;
let stateProvider = null;       // () => ({pct, st, pd, xr})；由 main.js 注册（零额外请求）
let lifecycleBound = false;

/** 当前页面状态快照（供状态上报 / 死因附注使用；任何异常都退化成空对象） */
function snap() {
  try { return (stateProvider && stateProvider()) || {}; } catch { return {}; }
}

/**
 * 上报一条「留痕」事件。用 sendBeacon 优先：它在**页面正在卸载**时仍会被发出，
 * 而普通 fetch 在 pagehide/卸载过程中常被浏览器直接取消 —— 那正是我们最需要它的时候。
 * 失败静默：留痕永远不能影响游戏。
 */
function pageEvent(name, extra) {
  try {
    const body = JSON.stringify(Object.assign({ ev: name, t: Date.now() }, extra || {}, snap()));
    if (navigator.sendBeacon) {
      navigator.sendBeacon(`${PAGE_API}/event`, body);
    } else {
      fetch(`${PAGE_API}/event`, { method: 'POST', body, keepalive: true }).catch(() => {});
    }
  } catch { /* 忽略 */ }
}

async function post(cmd) {
  try {
    await fetch(`${BASE}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd }),
    });
  } catch (e) {
    console.warn('[VR+] 发送命令失败 cmd=' + cmd, e);
  }
}

async function status() {
  try {
    return await (await fetch(`${BASE}/status`)).json();
  } catch {
    return { connected: false };
  }
}

async function pollInbox(onCmd) {
  try {
    // ★ 顺带把「当前进度/状态」带上去（不增加任何请求）：APK 侧只记变化与每 5s 一条，
    //   于是页面万一当场消失，仍能从 APK 侧读到「它死之前到哪一步了」。见 PageForensics.java。
    const s = snap();
    const pct = Number.isFinite(s.pct) ? Math.round(s.pct) : -1;
    const q = `?pct=${pct}&st=${encodeURIComponent(s.st || '-')}`
      + `&pd=${s.pd ? 1 : 0}&xr=${s.xr ? 1 : 0}&cs=${s.cs ? 1 : 0}`;
    const data = await (await fetch(`${BASE}/inbox${q}`)).json();
    (data || []).forEach((c) => onCmd(c));
  } catch {
    /* 轮询失败忽略，下次再试 */
  }
}

/**
 * 业务命令封装（**旧 V2.9 遗留，新平台无意义**）。
 * 保留是为了不改动调用点：APK 侧对 3/4/5/6 一律拒发并记一条日志，
 * 不会在游戏通道上产生垃圾报文。新协议下「游戏已启动」由 APK 发的
 * 单个 0x01(注册) 表达（平台 57ms 后回机位表即算上线），与页面无关。
 */
export const VRPlusGame = {
  launch:    () => post(3),   // [legacy] 旧 cmd3 启动游戏
  begin:     () => post(4),   // [legacy] 旧 cmd4 开始游戏
  terminate: () => post(5),   // [legacy] 旧 cmd5 中途结束（含玩家主动退出/按 Home/失败兜底）
};

/** 平台下行通道（供 game.js 在 init 时调用，监听平台远程控制） */
export const VRPlus = {
  send: post,
  status,
  /**
   * 一次性「服务器是否可达」探活（真 fetch 成功 = true；连不上 localhost:8080 = false）。
   *
   * 用途：**判死前复核**。PICO 会给后台页面节流，fetch 偶发失败非常常见，
   * `startAliveWatch` 连败 4 次也不能当成 APK 真死 —— 一旦误判就会走「平台关闭」流程
   * （退 VR + 卸载页面），玩家看到的就是「游戏起来几秒忽然闪退」。
   * 真死（APK 被 force-stop）时这里必然 false，所以复核不会漏掉真关闭。
   */
  async serverAlive() {
    try {
      const r = await fetch(`${BASE}/status`, { cache: 'no-store' });
      return r.ok;
    } catch {
      return false;
    }
  },

  /**
   * 注册「当前状态」提供者（main.js 调用，返回 {pct, st, pd, xr}）。
   * 状态会附在每秒的 inbox 轮询 URL 上，APK 侧落进留痕文件 —— 零额外请求、零额外开销。
   */
  setStateProvider(fn) { stateProvider = fn; },

  /** 记一条生命周期事件（可见性变化 / freeze / JS 异常 …），进 APK 留痕时间线 */
  reportEvent(name, extra) { pageEvent(name, extra); },

  /**
   * 记一条「页面要没了」的死因。**这是排查闪退最值钱的一条**：
   * 页面自己的日志会随页面一起消失，而这一条会留在 APK 磁盘上，事后随时可读。
   * @param {string} reason 死因分类：platform-gone / pagehide / beforeunload / error …
   */
  reportDead(reason, extra) { pageEvent('DEAD:' + reason, extra); },

  /**
   * 挂上页面生命周期探针（只在 Game 初始化时调一次）。记录：
   *   page-open / visibility:visible|hidden / freeze / resume / pageshow / pagehide / 未捕获错误
   *
   * 为什么关键：PICO 上「游戏页消失」的四种嫌疑里，有两种会在这里留下明确指纹 ——
   *   · 被别的应用抢了前台 → `visibility:hidden`（页面没死，只是被压到后台）；
   *   · 被系统冻结/回收 → `freeze`（Chromium 页面生命周期），之后往往直接没有下文。
   * 与 APK 侧心跳交织着读，就能确定「是 APK 死了、还是页面被顶掉了、还是浏览器自己崩了」。
   */
  trackLifecycle() {
    if (lifecycleBound) return;
    lifecycleBound = true;
    try {
      pageEvent('page-open', { url: location.href, vis: document.visibilityState });
      document.addEventListener('visibilitychange', () => {
        pageEvent('visibility:' + document.visibilityState);
      });
      document.addEventListener('freeze', () => pageEvent('freeze'));
      document.addEventListener('resume', () => pageEvent('resume'));
      window.addEventListener('pageshow', (e) => pageEvent('pageshow', { persisted: !!(e && e.persisted) }));
      // pagehide/beforeunload：真离开页面（或被浏览器丢弃）——用 beacon，普通 fetch 常被取消
      window.addEventListener('pagehide', (e) => {
        pageEvent('DEAD:pagehide', { persisted: !!(e && e.persisted) });
      });
      window.addEventListener('beforeunload', () => {
        pageEvent('DEAD:beforeunload', {});
      });
    } catch { /* 探针失败不影响游戏 */ }
  },

  startInbox(onCmd, intervalMs = 1000) {
    if (inboxTimer) clearInterval(inboxTimer);
    inboxTimer = setInterval(() => pollInbox(onCmd), intervalMs);
    return () => { if (inboxTimer) { clearInterval(inboxTimer); inboxTimer = null; } };
  },
  /**
   * 存活看门狗：轮询 /api/vrplus/status（由 APK 的 GameServer 本地 localhost:8080 提供）。
   * 平台点「关闭」会向头显下发 TCP kill → am force-stop 我们的 APK；游戏实际跑在 PICO 浏览器
   * （独立 app 进程），force-stop APK 杀不到浏览器内的游戏，故由游戏侧检测 APK 死亡后优雅退出。
   * APK 存活时 /status 返回 200；被 force-stop 后 fetch 连续失败 → 触发 onGone。
   *
   * 【2026-09-16 修正：菜单态也能关 + 防误触发】
   * 旧实现只在 game.start() 里启动看门狗，菜单态（未进入 VR）下平台关掉 APK 检测不到 → 关不掉。
   * 现改为在 Game 构造期就启动（见 game.js），覆盖菜单态。
   * 另加 requireFirstAlive：先确认 APK 在线再开始计失败，避免开局加载期偶发 fetch 失败（网络抖动 /
   * 页面刚打开）误判 APK 已死而把游戏页提前卸载。
   *
   * 【2026-09-16 二修：门槛太低 → 加载期自己把自己卸载成 about:blank（"起来 3 秒闪退"）】
   * 旧默认 intervalMs=1000 / maxFails=3 → 最坏 3 秒就触发 onGone。实测头显会给后台页面节流，
   * 且加载期主线程被纹理上传/JSON 解析占满，fetch 超时非常常见。现默认放宽到 1.5s × 4 ≈ 6s，
   * 并由 game.js 决定「加载/菜单态绝不卸载页面」（见 _onPlatformGone）。
   * onTick：每一步的探活结果回调（供页面诊断面板显示，见 main.js），排错时一眼看出是
   * 「APK 真的没了」还是「页面在加载期误判」。
   */
  startAliveWatch(onGone, { intervalMs = 1500, maxFails = 4, requireFirstAlive = true, onTick = null } = {}) {
    let fails = 0;
    let aliveConfirmed = !requireFirstAlive;   // 不需要首活确认则直接开始计失败
    const tick = () => {
      fetch(`${BASE}/status`, { cache: 'no-store' })
        .then((r) => {
          if (r.ok) { aliveConfirmed = true; fails = 0; }   // 收到 200 → 标记在线、清零失败
          else if (aliveConfirmed) { fails++; }              // 已确认在线后非 200 才计失败
          if (onTick) onTick({ ok: r.ok, code: r.status, fails, aliveConfirmed });
        })
        .catch((e) => {
          if (aliveConfirmed) fails++;                       // 首活前不计失败（加载期忽略）
          if (onTick) onTick({ ok: false, code: 0, fails, aliveConfirmed, error: String((e && e.message) || e) });
        })
        .finally(() => {
          if (aliveConfirmed && fails >= maxFails) { onGone(); return; }
          setTimeout(tick, intervalMs);
        });
    };
    tick();
  },
};
