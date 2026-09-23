package com.local.webxrcast;

import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.browser.customtabs.CustomTabsIntent;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;

/**
 * 头显端入口（独立运行 + 自动推流）：
 *   1) 启动即起本地 GameServer（http://localhost:8080，作本地游玩兜底）；
 *   2) 同时启动局域网发现，监听 PC 接收端（EXE）的 UDP 组播信标；
 *   3) 应用内 WebView 只跑「最小探测页」（检测 WebXR 支持 + 显示状态），**绝不加载完整游戏**；
 *      不支持 WebXR 的 WebView 在**发现 PC 后/超时**自动改用 PICO 浏览器打开本地
 *      http://localhost:8080/?cast=1 进入 VR 并推流（游戏只在 PICO 浏览器里跑，WebGL 才可用）。
 *   4) 玩家点「进入 VR」后，由游戏内等待房间（src/game/waitingRoom.js）播放左墙开场影片，结束进第 1 关；
 *   5) 推流：游戏地址固定带 ?cast=1，origin 是 localhost（WebXR 安全上下文，PICO 浏览器才会暴露
 *      navigator.xr，否则显示「桌面模式 需 https/头显」）。GameServer 发现 PC 后，把游戏静态资源与
 *      /api 信令**同源代理到 PC**：页面 origin 仍是 localhost（保住安全上下文），资源却取自 PC（始终最新），
 *      推流信令也直达 PC。无 PC 时回退到内置 assets/game 仅供本地游玩。
 *
 * 安全上下文是硬性前提：http://<PC局域网IP>:8443 不是安全上下文，PICO 浏览器不暴露 navigator.xr，
 * 会掉进桌面模式——所以绝不能让 PICO 浏览器直连 PC 地址，必须走 localhost 再由本 APK 代理。
 */
public class MainActivity extends AppCompatActivity {

    private static final int LOCAL_PORT = 8080;
    private static final long DISCOVER_TIMEOUT_MS = 8000;

    /**
     * 是否启用「应用内 WebView」。
     *
     * false（默认，PICO 实测形态）：**不显示内嵌 WebView，只打开唯一一个网页** —— 直接用 PICO
     * 浏览器拉起游戏页。原因：PICO 内置 WebView 无 GPU、不支持 WebXR，探测页对玩家只是一个多余的
     * 空白网页（表现为「先跳一个网页，识别电脑后又跳一个网页」）；且它若加载完整游戏会在
     * new World() 处抛「WebGL context could not be created」。
     * APK 本身仍需在后台运行（GameServer 要持续提供 localhost:8080 的游戏资源与代理），
     * 只是不再占据一个可见页面；拉起浏览器后由 yieldToBrowser() 把浏览器顶到前台再收起本页
     * （四修前是单纯 moveTaskToBack，实测会让浏览器留在后面 → 玩家要手点浏览器才看得到）。
     *
     * true：保留旧行为（内嵌 WebView 先跑探测页；仅当它确实支持 WebXR 时才在应用内直接跑游戏）。
     */
    private static final boolean USE_INNER_WEBVIEW = false;

    /** 游戏地址（用户自有 cast-pc 推流用）：带 ?cast=1，并附 &pc= 让信令/资源直连 PC */
    private static final String GAME_URL = "http://localhost:" + LOCAL_PORT + "/?cast=1";

    /** 纯本地游戏地址（平台启动默认用）：不带 ?cast=1，零推流开销，直接进游戏 */
    private static final String LOCAL_GAME_URL = "http://localhost:" + LOCAL_PORT + "/";

    /**
     * 平台经 am start -d <IP> 直推的地址，是否同时用作「直播推流目标」(&pc=)。
     * false（默认）：头显直接本地启动游戏，不连直播 PC。原因——平台下发 IP 多为
     * 「平台/主机地址」(本例 192.168.31.228 跑的是平台侧 DeepmindHacker.exe，并非我们的
     * cast-pc 直播接收端+静态服务器)，若把它写进游戏 URL 或当成资源代理目标，游戏会去拉一个
     * 不存在的服务器 → 卡死在加载天空。该 IP 仅用于建立 UDP 控制桥（cmd 1/3/4/5）。
     * true：同时把该地址作为 WebRTC 推流目标（需该地址确跑着我们的 cast-pc 且端口 8443）。
     */
    private static final boolean STREAM_TO_PLATFORM_PC = false;

    /** 应用内 WebView 只跑的最小探测页：检测 WebXR 支持 + 显示状态。绝不加载完整游戏——
     *  否则头显内置 WebView（通常无 GPU/WebGL）会在 new World() 处抛
     *  「WebGL context could not be created」，且与 PICO 浏览器共用 GPU 上下文池时还会拖垮前台。 */
    private static final String PROBE_HTML =
            "<!doctype html><html><head><meta charset='utf-8'>" +
            "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
            "<style>html,body{height:100%}body{background:#101014;color:#cdd6e4;" +
            "font:16px/1.6 sans-serif;margin:0;display:flex;align-items:center;" +
            "justify-content:center;text-align:center;padding:24px;box-sizing:border-box}" +
            "small{opacity:.6}</style></head><body>" +
            "<div>正在初始化…<br>即将用 PICO 浏览器进入 VR<br>" +
            "<small>若未自动跳转，请手动用 PICO 浏览器打开<br>http://localhost:8080/?cast=1</small>" +
            "</div></body></html>";

    private EditText etPc;
    private TextView tvStatus;
    private View manualPanel;
    private SharedPreferences sp;
    private GameServer server;
    private Discovery discovery;
    private VRPlusLink vrPlusLink = null;            // VR+ 平台桥接（与 cast-pc 同机，host 取已发现 PC 的 IP）
    private String currentPc = null;             // 已接入的 PC 地址（去重：信标每 2s 一次）
    private String platformPc = null;            // 平台经 am start -d <IP> 直推的地址（ip:port），仅用于 UDP 控制桥
    private boolean xrChecked = false;           // 是否已确认过 WebXR 支持情况
    private boolean autoLaunched = false;        // WebXR 不支持时是否已自动拉起 PICO 浏览器（仅一次）
    private boolean xrUnsupported = false;        // WebView 已确认不支持 WebXR（PICO 头显通常为 true）
    private boolean probeMode = true;             // true=WebView 当前是探测页（可注入 XR 检测）；false=已加载完整游戏
    private boolean inAppPlaying = false;         // 应用内 WebView 已直接跑游戏（此时不再拉起外部浏览器）
    private volatile boolean serverReady = false; // 本地 8080 是否已可连接（避免浏览器抢跑导致 localhost 拒绝）
    private volatile boolean resumed = false;     // Activity 是否已 onResume（真前台）。后台态 startActivity 会被系统拦（BAL），
                                                  // 必须等 resumed 才拉起浏览器——平台 am start 后台拉起时这一步最容易失败。
    private int launchAttempts = 0;                // 已尝试拉起浏览器的次数（自检未接管会重试）
    private long lastLaunchAt = 0;                 // 上次尝试拉起的时刻（防抖）
    /**
     * 本次拉起是否**平台驱动**（intent 带 -d <PC_IP>）。
     * 用途：平台约每 20s 用 `am start` 重拉一次（castlog6.txt 实测 20.004s 周期），每次都会把本 Activity
     * 顶到前台建面板，把浏览器里的游戏页/XR 会话压下去 —— 玩家看到的就是「进 VR 两三秒后被弹出 = 闪退」。
     * 因此**平台驱动的**拉起在成功后直接 finish()（进程有 CastService 前台服务 + GameServer 单例，不受影响），
     * 这样后续每次重拉都走 onCreate 的「零界面」分支，不再产生任何面板；
     * 而**手动点图标**（无 -d）仍保留完整配置页，不影响人工使用。
     */
    private boolean platformDriven = false;

    /**
     * 是否由「桌面图标 / 最近任务」启动（而非平台/启动器用 `am start` 拉起）。
     *
     * 判据（2026-09-19 由留痕实测建立）：桌面 launcher 的启动 intent 标准形态是
     * `action=MAIN, categories=[android.intent.category.LAUNCHER]`；
     * 而平台/启动器执行 `am start -n <pkg>/.MainActivity`（可带 -d）**不加任何 category**。
     * 用「有没有 LAUNCHER category」区分，比只看 `intent.data` 可靠得多 ——
     * 实测平台那次是 `intent=null`，旧判据（只看 data）直接失效。
     */
    private static boolean isFromLauncher(Intent it) {
        if (it == null) return false;
        try {
            java.util.Set<String> cats = it.getCategories();
            return cats != null && cats.contains(android.content.Intent.CATEGORY_LAUNCHER);
        } catch (Throwable e) {
            return false;   // 取不到 category 时保守当作「非桌面启动」→ 平台语义
        }
    }

    /** 平台驱动 = intent 带 -d 直推地址（最硬信号），**或** 不是从桌面图标点的。 */
    private static boolean computePlatformDriven(Intent it, String data) {
        if (data != null && !data.isEmpty()) return true;
        return !isFromLauncher(it);
    }

    /**
     * 本次拉起是否**由人工从桌面图标/最近任务点的**（相对平台程序化拉起而言）。
     *
     * 判据：真 launcher 启动会带 referrer（`android-app://<launcher 包名>`）；
     * 平台/启动器执行 `am start` 没有 referrer。取不到时返回 false（= 不认定人工），
     * 即「拿不准时按平台处理」——因为把平台拉起误判成人工的代价是配置页抢前台、
     * 玩家以为「启动没反应」甚至被踢出 VR；反过来代价只是一次配置页没显示。
     */
    private boolean looksLikeManualLaunch() {
        String r = referrerStr();
        if (r == null) return false;
        // ⚠ 例外（2026-09-20 六修，实测留痕 18:20:54 那一轮）：
        //   `ref=android-app://com.GoodNet.LauncherClient` —— 平台**自己的启动器**启动我们时
        //   也会留下 referrer，与「人工点桌面图标」完全同形。旧实现把它一并当成人工 →
        //   平台重拉被判成人工启动 → 配置页不收起、不唤醒待机页、还抢前台压掉浏览器
        //   （玩家看到的就是「平台启动了但一直没反应」）。故：referrer 指向平台启动器时**不算人工**。
        if (r.contains("GoodNet")) {
            PageForensics.line("APK", "referrer=" + r + " → 是**平台启动器**（com.GoodNet.LauncherClient），"
                    + "不算人工点击 → 按平台驱动处理");
            return false;
        }
        PageForensics.line("APK", "referrer=" + r + " → 判为「人工从桌面图标启动」");
        return true;
    }

    /** 本次启动的 referrer 字符串（`android-app://<launcher 包名>`）；无/取不到 → null */
    private String referrerStr() {
        try {
            android.net.Uri r = getReferrer();
            return (r == null) ? null : r.toString();
        } catch (Throwable e) {
            return null;    // API 不支持 / 权限异常 → 当作无 referrer
        }
    }

    /**
     * 「平台重复拉起」的**会话级兜底判据**（2026-09-19 五修）。
     *
     * <h3>为什么需要（留痕实测，17:38:16 那一轮）</h3>
     * 平台那次 `am start` **既没带 -d，又带了 `-c android.intent.category.LAUNCHER`**：
     *     onCreate 平台驱动=false intent=null action=MAIN cats={android.intent.category.LAUNCHER}
     * 于是它与「用户点桌面图标」在上层完全同形，`computePlatformDriven` 判成 false →
     *   · 配置页照常建出来，且 `yieldToBrowser()` 里的 `if (platformDriven)` 不成立 → **永不关闭**；
     *   · 玩家看到的就是「平台启动了，但一直没反应」——
     *     同一条留痕里，游戏页在 17:38:23 之后**停止轮询 21 秒**（= 浏览器面板被我们的配置页盖住、
     *     Chromium 冻结后台标签），而配置页一直没退。
     *
     * <h3>判据（三个都成立才算平台）</h3>
     *   ① 本进程与平台的游戏通道**已经建立过**（收到过机位表 → VRPlusLink.connected）；
     *      —— 平台没在跑的时候，人工点图标当然照旧给配置页；
     *   ② 本进程**已经成功把游戏页拉到浏览器**（sLaunched）且**页面现在还活着**；
     *   ③ 不是人工点的（无 launcher referrer，见 looksLikeManualLaunch）。
     *
     * 三者的交集只有一种情况：**平台在跑、游戏页活着，而这次拉起又不是人点的** ⇒ 只能是平台重拉。
     * 命中后按平台语义走：不建界面 / 收掉配置页 + 把浏览器顶回前台（yieldToBrowser）。
     *
     * ⚠ 代价（已知且接受）：平台会话在线 + 游戏页活着时，人工点图标也拿不到配置页了。
     *   读留痕改用电脑端两条更好的路（头显IP:8080 + `?follow=1` 自动刷新 / `?download=1` 下载全文）。
     */
    private boolean platformRelaunchFallback() {
        // 结果缓存：onCreate 在 super.onCreate() **之前**就要用它（决定主题），绝不能算两遍
        // （算两遍会在留痕里留两条重复行，也会让两次判定出现不一致）。
        if (platformFallback != null) return platformFallback;
        boolean r = computeRelaunchFallback();
        platformFallback = r;
        return r;
    }

    /** 本次拉起的「平台重拉兜底判据」结果缓存（见 platformRelaunchFallback） */
    private Boolean platformFallback = null;

    /** 本次拉起是否走「免打扰」路径（= 平台驱动 + 已拉起过 + 页面仍活）；null = 还没算 */
    private Boolean passThrough = null;

    private boolean computeRelaunchFallback() {
        if (!platformLike()) return false;
        if (!sLaunched || !pageAliveForLaunch()) return false;                 // ② 没有活着的游戏页
        PageForensics.line("APK", "平台驱动兜底命中：平台会话在线 + 游戏页仍在 + 无 launcher referrer "
                + "→ 视为平台重拉（平台的 am start 有时不带 -d 却带 LAUNCHER，与人工点击同形）");
        return true;
    }

    /**
     * 本次拉起是否走「免打扰」路径（不建界面、不抢前台、立刻让位给浏览器）。
     *
     * ⚠ **必须在 super.onCreate() 之前算出来**：它决定用哪个主题 —— 免打扰路径要用
     *   `Theme.WebXRCast.Passthrough`（@android:style/Theme.NoDisplay，见 themes.xml）。
     *   理由（实测留痕 18:24:04）：平台重拉时，即使我们不 setContentView、立刻 finish，
     *   系统仍会加一个「空窗口」→ PICO 的 XRShell 给它建 2D 面板并顶到最前 →
     *   浏览器里那一帧 visibility:hidden → **XR 沉浸式会话当场结束**（玩家被弹出 VR）。
     *
     * 任何异常一律返回 false（退回正常主题）：看得见配置页总比摸黑强。
     */
    private boolean computePassThrough(Intent it) {
        try {
            String data = (it != null) ? it.getDataString() : null;
            boolean pd = computePlatformDriven(it, data);
            if (!pd) pd = platformRelaunchFallback();
            return pd && sLaunched && isGamePageAlive();
        } catch (Throwable e) {
            return false;
        }
    }

    /**
     * 「平台在场」判据 —— 比 `platformRelaunchFallback()` 宽一档（不含「页面已在跑」那条）：
     * 平台通道已连（收到过机位表）+ 本次不是人工点的 ⇒ 平台在场。
     *
     * 用途：**刚拉起游戏页那一刻**（新页面刚出生、`sLaunched` 可能还没置位）也要能认出平台 ——
     * 否则平台那不带 `-d` 的首拉会把配置页留在最前（玩家看到的就是「启动没反应」）。
     * 见 markLaunchSucceeded() 里的「收尾前刷新判据」。
     */
    private boolean platformLike() {
        if (platformDriven) return true;
        if (sVRPlusLink == null || !sVRPlusLink.isConnected()) return false;   // ① 平台没在跑
        return !looksLikeManualLaunch();                                      // ③ 人点的 → 不算平台
    }

    /** 平台下发的配置文件名（客户端经启动器 copyfile 往本 App 外部私有目录塞这个文件；castlog6.txt 实测） */
    private static final String PLATFORM_SETUP_FILE = "setup.xml";

    // ── 进程级单例：必须跨 Activity 重建存活（2026-09-16 实测根因）──
    // 平台会「保险」二次拉起本 APK（castlog2.txt 里 18:31:18 与 18:31:38 两次 onCreate，PID 相同）。
    // 若 server 随 Activity 销毁而 stop()，浏览器里**正在加载的游戏页**会在中途被掐断：
    //   ① 第一次表现为浏览器报「localhost 拒绝我们的请求」（模块/资源请求被拒）；
    //   ② 之后页面永远停在 index.html 的初始文案「正在加载天空资源…」——因为 main.js 从未跑起来，
    //      游戏也不会调 VRPlusGame.launch() 上报 cmd3，平台便再拉一次 → 死循环。
    // 故本地 HTTP 服务与 UDP 桥改为进程级单例：只随进程结束（含平台 force-stop）而结束。
    private static GameServer sServer = null;
    private static VRPlusLink sVRPlusLink = null;
    private static volatile boolean sLaunched = false;  // 本进程内是否已成功把游戏页拉到浏览器
    private static volatile long sLaunchedAt = 0;       // 上述成功时刻（ms）：用于「刚拉起→还在加载」的宽限期判定

    // ───────────── ★ 第十五修：LaunchGuard（「只能通过客户端启动」门禁）─────────────
    // 合法启动 = ① 由**平台客户端**拉起（同步、本地判定，见 computePlatformDriven）
    //          + ② **直播端 EXE 在线且在白名单**（首次拉起时向 EXE 要放行条，见 guardExeCheckAsync）
    //          + ③ ★ 第十七修：**拿到 EXE 下发的轻量配置**（见 fetchExeConfig）。
    // 任一不成立 → 黑底提示 → finish()，**绝不拉起浏览器**（需求方 2026-09-20 选定「直接无法启动」）。
    // 详细设计见 guardPass() 的注释。
    private static volatile boolean sGuardOk = false;        // 最近一次授权结论（供页面 /api/guard 查询）
    private static volatile long sGuardAt = 0L;              // 上述结论的时刻（ms）
    private static volatile String sGuardWhy = "尚未校验";   // 结论原因（写进留痕 / 页面展示）
    private static volatile String sPcSeen = null;           // 局域网发现的直播端地址（后台线程写，门禁阻塞等它）
    // ★ 2026-09-20 修：门禁**刚核实过**（放行条 + license + 配置都拿到了）的直播端地址（ip:port）。
    //   它才是本局的权威推流目标 —— 推流不能只认 UDP 信标：现场留痕实测 22:00 那一局，门禁靠
    //   「上次留存的地址」顺利完成放行，而信标整段窗口一个都没到 ⇒ currentPc 恒为 null ⇒
    //   拉起地址退化成 /?plat=1（无 cast=1、无 pc=）⇒ 游戏能玩、直播端一片空白。
    private static volatile String sGuardVerifiedPc = null;
    private static boolean sGuardPassed = false;             // 本进程本次启动是否已通过门禁（maybeLaunch 的硬前置）
    private static final long GUARD_CACHE_MS = 10000L;       // 授权结论缓存（ms）：重拉 / 页面查询复用
    private static final int EXE_PROBE_TIMEOUT_MS = 1200;    // **单轮**探测 EXE 的连接/读取超时（ms）
    @SuppressWarnings("unused")   // 第十六修后代码里不再引用（改为整段等待窗口），保留仅为出问题时快速回退参照
    private static final long EXE_PROBE_WAIT_MS = 2000L;     // 旧版「连地址都没有时等信标」的上限（ms）
    // ★ 第十六修：把「等 EXE 上线」从 3.2 秒上限改成「长等待 + 轮询重试」——
    //   平台是**同时**拉起 EXE 与 APK 的，Electron 冷启动要数秒到十几秒；
    //   旧实现只等 3.2s 就出结论，APK 必然先退出，而平台不会自动重试 ⇒ 现场「一闪就退，什么都测不了」。
    //   注意：等待必须放在**后台线程**（等 20s 会 ANR，而 ANR 弹窗在 PICO 上是个 2D 面板，会顶掉 XR 会话）。
    private static final long GUARD_WAIT_TOTAL_MS  = 20000L; // 「等 EXE 上线」的总预算（ms），超时才按硬闸门拒绝
    private static final long GUARD_RETRY_INTERVAL_MS = 700L;// 等待期间的重试间隔（ms）
    private volatile int sGuardWaitSeq = 0;                 // 等待轮次序列号：换轮 / Activity 销毁即作废旧线程
    private boolean gameUiInited = false;                   // initGameUi 幂等守卫（同步放行 + 异步回调都调它）
    private TextView guardT1 = null;                        // 等待页主标题（后台线程滚动更新用）
    private TextView guardT2 = null;                        // 等待页副标题
    // ★ 第十六修：地址定性缓存（每个地址只查一次 /api/info，避免每 700ms 一次 GET 刷屏）
    private final java.util.concurrent.ConcurrentHashMap<String, String> guardIdentity
            = new java.util.concurrent.ConcurrentHashMap<>();

    // ───────────── ★ 第十七修：配置下发（「文件齐全才跑得起来」的落点）─────────────
    // EXE 通过 /api/config/dump 把「轻量配置」（关卡 / 刷怪 / 数值等，清单由 EXE 侧 CONFIG_MANIFEST
    // 定义，见 cast-pc/main.js）整包交给已授权的头显；我们落到私有目录的「覆盖层」，GameServer
    // 在托管静态资源时**优先读它**，且对清单里的路径**只认覆盖层、不回落 assets** ⇒ 没经过授权
    // 就拿不到关卡定义，游戏根本跑不起来。这把「授权」从「校验通过就放行」升级成「拿到钥匙才进得来」。
    //
    // 局号（session）：EXE 每次进程启动都换一个。本机存的局号与它对不上 ⇒ 旧覆盖层视为**已失效**、
    // 整个目录清掉重下。这就是「退出即失活」的等价实现 —— 而**不在 Activity 销毁时真删文件**：
    // 平台重拉会重建 Activity，那时删等于把正在跑的游戏页资源删掉（见硬约束 52 / 35）。
    private static final String OVERLAY_DIR = "game-overlay";        // 私有目录下的覆盖层根
    private static final String OVERLAY_SESSION_KEY = "overlaySession"; // 本机覆盖层对应的局号
    private static final long CONFIG_FETCH_TIMEOUT_MS = 6000L;       // 配置下发单次超时（ms）
    private static final int CONFIG_MAX_BYTES = 4 * 1024 * 1024;     // 整包上限（byte）：防异常清单吃爆内存
    private static volatile long sOverlayCount = 0L;                 // 最近一次成功落地的文件数（供 /api/guard 展示）
    /**
     * ★ 第十七修：两端固定的共享密钥。⚠ 必须与 cast-pc/main.js 的 GUARD_SECRET_DEFAULT 逐字一致。
     *
     * <p>★ P3（2026-09-20）：它已**降级为过渡期临时鉴权**。兜底天数已拍板为 0（到期即停），
     * 真正的门禁是下面的 license 校验（见 {@link #licenseCheck} / {@link LicenseVerify}）。
     * 等「头显侧 Ka / Ka_pub」（下一轮，把 proof 迁移到头显→EXE 方向）落地后，本常量应视为死代码，
     * **绝不可重新启用为放行路径** —— 否则授权服务器形同虚设。
     */
    private static final String GUARD_SECRET_FIXED = "webxr-cast";

    // ───────────── ★ P3（2026-09-20）：直播端授权校验（license + proof）─────────────
    // 在原有三道门禁（平台拉起 / EXE 放行 / 拿到配置）之上加一道**验明正身**：
    //   ① license 由服务器签发私钥 Ks 签名 ⇒ 头显只持公钥 Ks_pub（下面这个常量），伪造不了；
    //   ② proof = Ke_sign("cast|<nonce>")，绑的是**头显当场给的随机数** ⇒ 把 license 拷到别的机器上
    //      过不了这一关（那台机器没有 Ke 私钥）—— 这是「防拷贝」的关键，也是本道门禁存在的唯一理由。
    // 校验逻辑本身在 LicenseVerify：纯 Java、零 Android 依赖（除 Base64/json），
    // 因此能在 PC 上跑**同一份源码**做跨语言互认测试（tools/cast-server/xlang/，25 条样本 + 7 项探针）。
    /**
     * 签发公钥 Ks_pub（**标准** base64 / SPKI DER）。⚠ 必须与 cast-pc/main.js 的 LICENSE_PUBKEY_B64 一致。
     *
     * <p>来源：{@code GET https://webvr123.site/api/pubkey}，fingerprint=4156b73a8b5d5e6aa7cda445。
     * <b>更新必须用「程序取回 + 双哈希自证」（见 tools/_dist/pubkey-production.json）</b> ——
     * 实测人眼转录错 1 个字符时，长度 / DER 字节数 / SPKI 头 / 点前缀**全部校验通过**，只有哈希对不上。
     */
    private static final String LICENSE_PUBKEY_B64 = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEo6rcLRUG15wFPgi/uhimaEGB1geL+jf+pa5Ae2fOdunHRSjEq5ewOO0XvPasoF0QtrkEKrP3PkJoYQG4ycRlLg==";
    private static final long LICENSE_FETCH_TIMEOUT_MS = 2500L;    // 单次取授权信息的超时（ms）
    private static final long LICENSE_SKEW_MS = 5 * 60 * 1000L;   // 容忍 ±5 分钟时钟偏差（与服务器/EXE 一致）
    private static final int LICENSE_MAX_BYTES = 64 * 1024;        // 响应体上限（byte）：一份 license 才几百字节

    private WebView webView = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // ── 第 0 步（必须在 super.onCreate 之前）：决定本次用哪个主题 ──
        // 「平台驱动 + 已拉起过 + 页面仍活」= 免打扰路径 → 换 @android:style/Theme.NoDisplay：
        // 本页不产生任何窗口 ⇒ PICO 的 XRShell 不会为它建 2D 面板 ⇒ 不会把浏览器里的
        // XR 沉浸式会话挤掉（实测 18:24:04：平台重拉 → 253ms 后 visibility:hidden → 会话结束 →
        // 玩家被打回 2D 预览界面、本局作废）。窗口建立后就改不动主题了，只能在这里。
        passThrough = computePassThrough(getIntent());
        if (passThrough) {
            setTheme(R.style.Theme_WebXRCast_Passthrough);
            PageForensics.init(getApplicationContext());   // 先初始化，下面这行才写得进留痕
            PageForensics.line("APK", "本次走「免打扰」路径（主题=无窗口 NoDisplay）：只让位给浏览器，"
                    + "不建 2D 面板、不抢前台、不打断 XR 会话");
        }
        super.onCreate(savedInstanceState);

        // ── 留痕（必须最早，且在下面任何 return 之前）──
        // 进程一被平台拉起就落一条「pid + build」，这样事后能一眼回答最关键的那个问题：
        //   平台每 20s 一轮里的 `kill`（am force-stop 本 APK）到底有没有真的把我们干掉？
        // 若日志里出现多个不同的 pid，就说明是「APK 被反复杀」而非「页面自己崩」。
        PageForensics.init(getApplicationContext());
        // 进入标记：与 CastApp 的「进程启动」行配对使用 ——
        //   · 只有「进程启动」没有本行 → Activity 没被创建（平台 am start 没到 / 被拦）；
        //   · 有本行但后面缺 onCreate 那一行 → 崩在启动路径中（崩溃栈会由 CastApp 的处理器写进来）。
        PageForensics.line("APK", "MainActivity.onCreate 进入");

        // ── 0) 与界面无关的进程级初始化（必须最先做：平台「重复拉起」时下面会直接 return，不建界面）──
        // 设备指纹：本轮日志证实要同时兼容 PICO 与 Oculus（两者浏览器包名不同），先记下是哪台。
        android.util.Log.i("CastMain", "设备 " + android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL
                + " / Android " + android.os.Build.VERSION.RELEASE + "(API " + android.os.Build.VERSION.SDK_INT + ")");
        // 诊断：记录本次启动来源（平台会经 am start -d <IP> 带上 intent data）
        android.util.Log.i("CastMain", "onCreate intent data=" + (getIntent() != null ? getIntent().getDataString() : "null")
                + " action=" + (getIntent() != null ? getIntent().getAction() : "null"));

        // 常驻前台服务：保住本进程（localhost:8080 资源服务 + VR+ 桥接），并让进程处于「前台态」
        // → 平台后台拉起时也能顺利 startActivity 打开浏览器（否则被 BAL 限制静默拦截）。见 CastService。
        CastService.start(this);
        startProcessHeartbeat();   // 诊断：每 10s 一条，用于分辨「进程被杀」还是「游戏页没了」

        // ★ 第十五修：sp 与局域网发现都要**提前到门禁之前** ——
        //   · sp：门禁要读 secret / 应急开关 / 上次记下的直播端地址；
        //   · Discovery：门禁要拿它发现的地址去问 EXE 要放行条（EXE 每 2s 一次信标，等一个周期即可）。
        //   ⚠ 回调跑在**后台线程**，所以先用 volatile 的 sPcSeen 记地址（门禁在阻塞等它），
        //     再回主线程走原有 UI 路径（此刻界面还没建，setPc 里对 UI 的操作会被门禁短路）。
        sp = getSharedPreferences("cast", MODE_PRIVATE);
        discovery = new Discovery();
        discovery.start(this, (ip, port) -> {
            sPcSeen = ip + ":" + port;
            runOnUiThread(() -> onPcFound(ip + ":" + port));
        });

        // 1) 本地游戏服务（**进程级单例**）：Activity 重建 / 平台二次拉起时复用，绝不随实例销毁。
        //    否则浏览器里正在加载的游戏页会被掐断（见 sServer 字段注释）。
        if (sServer == null) {
            server = new GameServer(getAssets(), LOCAL_PORT);
            try {
                server.start();
            } catch (IOException e) {
                // 上一次实例可能尚未释放 8080（TIME_WAIT 等）。**不 return**——交给看门狗在后台重试绑定，
                // 避免平台启动时直接停在「本地服务启动失败」配置页（表现为只看到配置页、游戏不打开）。
                android.util.Log.w("CastMain", "首次绑定 8080 失败，改由看门狗后台重试: " + e.getMessage());
            }
            sServer = server;
        } else {
            server = sServer;
            serverReady = true;          // 本进程早先实例已绑定成功：直接视为就绪
            android.util.Log.i("CastMain", "复用已在运行的本地 8080 服务（Activity 重建 / 平台二次拉起）");
        }

        // ★ 第十七修：把「直播端下发的轻量配置」覆盖层挂到本地服务上（进程级，随 sServer 复用）。
        //   清单来自上一次成功下发时落盘的 session.json。本机若还没有（从没被授权过），这里就是空集
        //   ⇒ 对受管路径一律 404 ⇒ 游戏连关卡定义都读不到 = 硬门禁，而**不是**静默回落 assets。
        mountOverlayToServer();

        // 2) 平台经 am start -d <IP> 直推地址：仅建 UDP 控制桥（cmd 1/3/4/5），不进游戏 URL、
        //    不当资源代理目标（否则游戏去连并非 cast-pc 的平台/主机地址而卡死）。
        //    默认 STREAM_TO_PLATFORM_PC=false → 头显直接本地起游戏；若确认该地址跑着我们的
        //    cast-pc，可改为 true 让其同时作为推流目标。
        applyIntentPc(getIntent());
        // ★ 平台驱动判定（2026-09-19 重做，留痕实测驱动）★
        // 旧判据 `(platformPc != null) || intent.data 非空` 在真实平台上**恒为 false**：
        //   留痕原文 `onCreate 平台驱动=false intent=null` → 平台的 am start **不带 -d**。
        // 后果很重（三处全废）：
        //   · yieldToBrowser() 里的 `if (platformDriven)` 直接不成立 → 配置页永不关闭；
        //   · 每次平台重拉（主机侧未上线时 +20s 一次）都把配置页**面板**顶到前台 → 压掉浏览器里的
        //     游戏页 / XR 会话 = 玩家说的「闪退」；
        //   · onCreate 的「零界面」分支永不命中，白建一次界面。
        // 新判据：桌面 launcher 启动**一定带 CATEGORY_LAUNCHER**；而平台/启动器执行
        // `am start -n <pkg>/.MainActivity` **不带任何 category** ⇒ 用「有没有 LAUNCHER category」
        // 区分「用户点图标」与「平台/程序拉起」。带 -d 仍算最硬信号（部分平台版本会带）。
        String launchData = (getIntent() != null) ? getIntent().getDataString() : null;
        platformDriven = computePlatformDriven(getIntent(), launchData);
        // ★ 五修：平台 am start 有时**既不带 -d 又带 LAUNCHER**（与人工点图标同形）→ 用会话级判据兜底，
        //   否则配置页会建出来且永不关闭 = 玩家看到的「平台启动了但没反应」。判据与代价见
        //   platformRelaunchFallback() 的注释。
        if (!platformDriven && platformRelaunchFallback()) platformDriven = true;
        probePlatformDir();     // 副作用即建出 .../Android/data/<pkg>/files（否则平台 copyfile 会 ENOENT）
        if (platformPc != null) {
            setControlHost(platformPc.split(":")[0]);
            if (STREAM_TO_PLATFORM_PC) setPc(platformPc);
        } else if (platformDriven) {
            // 平台不带 -d 时的兜底：setup.xml 里的 platformIP 就是平台地址（真实游戏 GameSetting 也是
            // 从这份文件取的，见 readSetupPlatformIp）。**早点建桥 = 早点把 0x01 注册发出去** —— 平台
            // 等不到这个「游戏已上线」信号就会每 20s 重发整套启动（含 am start），那正是抢前台的源头。
            String sip = readSetupPlatformIp();
            if (sip != null) {
                android.util.Log.i("CastMain", "平台驱动但 intent 无 -d → 用 setup.xml 的平台地址建桥: " + sip);
                setControlHost(sip);
            }
        }
        PageForensics.line("APK", "onCreate 平台驱动=" + platformDriven + " intent=" + launchData
                + " action=" + (getIntent() != null ? getIntent().getAction() : null)
                + " cats=" + (getIntent() != null ? getIntent().getCategories() : null)
                + " flags=0x" + ((getIntent() != null) ? Integer.toHexString(getIntent().getFlags()) : "0")
                + " ref=" + referrerStr()
                + " sLaunched=" + sLaunched + " 游戏页age=" + gamePageAgeMs() + "ms"
                + " extras=" + extrasPreview(getIntent()));
        // ★ 第十修：把 referrer 里的包名记下来 = 「平台客户端是谁」。本局结束时要把**它**顶回前台。
        rememberClientPkgFromReferrer(referrerStr());

        // ── 3) 平台「重复拉起」的最小打扰路径：游戏页仍在跑 → 连界面都不建 ──
        // castlog3 实测平台约 20s 一次 am start；每次都会把本 Activity 顶到前台，把浏览器里的
        // 游戏页（乃至 XR 沉浸会话）压到后台 → 玩家被弹出 VR（用户描述的「闪退」）。
        // 这里直接不 setContentView：补报一次 0x01 后立刻把浏览器顶前台、并 finish 掉本页。
        // ⚠ 条件用 passThrough（在 super.onCreate 之前就算好、并据此换了「无窗口」主题）——
        //   保证「换主题」与「走这条分支」永远一致；否则会出现「NoDisplay 主题下却去建配置页」
        //   = 玩家看不到任何界面的黑天鹅。
        if (passThrough) {
            // ★ 第十五修：走到这里 = 本进程此前已把游戏页拉起来过（= 当年那一次是通过门禁的），
            //   且本次是「平台重拉、页面仍活」。故直接标记已放行 —— 这条路径**不允许**再做异步
            //   校验：它必须保持「零窗口」语义（等网络会逼我们换主题、建面板，把玩家踢出 VR）。
            sGuardPassed = true;
            android.util.Log.i("CastMain", "平台重复拉起且游戏页仍在运行（age=" + gamePageAgeMs()
                    + "ms）→ 不建界面，让位给浏览器（不重开、不重载）");
            PageForensics.line("APK", "平台重复拉起：判定游戏页仍在（age=" + gamePageAgeMs()
                    + "ms state=" + pageState() + " 待机=" + pageClosed()
                    + "）→ 免打扰路径（无窗口主题）：不建界面、不重开浏览器，只唤醒待机页 + 让位给浏览器");
            notifyPlatformGameLaunched();
            // ★ 待机页唤醒（见 reviveClosedPage）：平台关过一局后页面是保留的，
            //   这里不补一条本地 cmd3 的话，平台这句「开始」对游戏就不产生任何效果。
            reviveClosedPage();
            // ★ 四修：过去这里是「moveTaskToBack + finish」，谁也没把浏览器顶上来 ——
            //   玩家看到的就是「平台启动了，但没有任何网页弹出来」（第 3 次的形态）。
            yieldToBrowser("平台重复拉起：游戏页仍在（零界面分支）");
            return;
        }
        // ── 4-pre) ★ 第十五修 LaunchGuard：不是「平台客户端拉起 + 直播端放行」就一律拒绝 ──
        // 三种结局，都在这里 return：
        //   · 拒绝   → 内部已建黑底提示页并安排 1.2 秒后 finish（不拉浏览器）；
        //   · 等待中 → ★第十六修：EXE 可能还在冷启动，内部已建「正在等待直播端启动…」进度页，
        //              onCreate 到此为止；等 EXE 上线后由后台线程回调 initGameUi() 接着建界面；
        //   · 放行   → 返回 true，继续往下走 initGameUi()。
        // 绝不能在不放行时继续 setContentView（那会把提示页覆盖掉、并把游戏开起来）。
        if (!guardPass()) return;

        initGameUi();
    }

    /**
     * 「门禁已放行」之后才做的全部初始化：建配置页 + 绑定控件 + 启动看门狗 + 超时兜底。
     *
     * <p>★ 第十六修把它从 onCreate 里抽出来：门禁改成**异步**后，放行可能发生在
     * 「等待 EXE 上线」的后台线程回调里 —— 那时 onCreate 早已返回，必须由回调重新触发这段初始化。
     *
     * <p>纯搬移，无逻辑改动。已核对：这段只用到 sp / etPc / tvStatus / manualPanel 四个**字段**，
     * 不依赖 onCreate 里的任何局部变量，所以抽出来是安全的。
     */
    private void initGameUi() {
        if (gameUiInited) return;   // 幂等：缓存命中同步放行、回调重复触发，都只初始化一次
        gameUiInited = true;
        // ── 4) 以下为「真要把游戏开起来」的路径：建界面 ──
        setContentView(R.layout.activity_main);

        etPc = findViewById(R.id.etPc);
        tvStatus = findViewById(R.id.tvStatus);
        manualPanel = findViewById(R.id.manualPanel);

        // 「上次运行到底是谁把游戏页弄没了」—— 打开本页即可读，不需要 adb、不需要连线。
        // 平台每次重拉也会经过这里（走的是「零界面」分支之外的路径时），等于自动留档。
        // 三种读法（2026-09-19 四修，都是为了「别再拿头显拍照」）：
        //   头显浏览器：http://localhost:8080/api/page/forensics            尾部 300 行纯文本
        //   电脑浏览器：http://<头显IP>:8080/api/page/forensics?follow=1     每 2 秒自动刷新
        //   电脑浏览器：http://<头显IP>:8080/api/page/forensics?download=1   下载全文 .log 文件
        try {
            android.widget.TextView tvf = findViewById(R.id.tvForensics);
            if (tvf != null) {
                tvf.setText("—— 留痕尾部（" + PageForensics.BUILD_TAG + "）——\n"
                        + "导出全文（电脑浏览器，头显IP:8080）:\n"
                        + "  /api/page/forensics?download=1 （?follow=1 自动刷新）\n"
                        + PageForensics.tail(10));
            }
        } catch (Throwable ignore) { /* 布局里没有该控件时忽略 */ }

        // sp 已在 onCreate 早期赋值（第十五修：门禁要用它）—— 这里直接用，勿重复赋值。
        etPc.setText(sp.getString("pc", ""));

        // ★ 第十修：本局结束后的退出策略开关（第十一修调整默认值）——
        //   ① 唤醒平台客户端（把客户端顶回前台，操作员下一步才点得动它上面的「开始」）→ **默认开**；
        //   ② 关闭浏览器（释放内存/GPU，代价是下一局要重新打开游戏页 ≈10s 预加载）→ **默认关**。
        //   为什么 ② 改成默认关：留痕实测（20:25:27 关掉浏览器）→ 浏览器被系统自己拉起 +
        //   还原标签，加载到 80% 就被冻结 = 幽灵页 → 下一局「启动一直没反应」（见第十一修注释③）。
        //   ⚠ 这里 setChecked 的初值必须与 isOn(...,"killBrowser",false) 一致，否则
        //     「界面显示勾着、实际不做」会把排查带歪。
        //   两项都只对「平台模式」生效；带 ?cast=1 直播时不关浏览器（见 restoreClientAndCloseBrowser）。
        try {
            android.widget.CheckBox cbClient = findViewById(R.id.cbRestoreClient);
            android.widget.CheckBox cbKill = findViewById(R.id.cbKillBrowser);
            if (cbClient != null) {
                cbClient.setChecked(!"0".equals(sp.getString("restoreClient", "1")));
                cbClient.setOnCheckedChangeListener((v, on) ->
                        sp.edit().putString("restoreClient", on ? "1" : "0").apply());
            }
            if (cbKill != null) {
                cbKill.setChecked(!"0".equals(sp.getString("killBrowser", "0")));
                cbKill.setOnCheckedChangeListener((v, on) ->
                        sp.edit().putString("killBrowser", on ? "1" : "0").apply());
            }
            // ★ 第十三修：「进入 VR」按钮门禁的**现场开关**（唯一的紧急出口）。
            //   勾上 = 网址带 ?vrbtn=1 = 页面**完全旁路门禁**（按钮常显，等同第十二修之前的行为）。
            //   什么时候勾：留痕里 `vr-gate` 的 why 出现「门禁兜底：30 秒内没有收到平台开局信号」——
            //   说明平台确实不下发「开始游戏」指令。勾上后**下次拉起即生效**，不用重打包。
            android.widget.CheckBox cbVR = findViewById(R.id.cbVrBtnAlways);
            if (cbVR != null) {
                cbVR.setChecked(!"0".equals(sp.getString("directVr", "0")));
                cbVR.setOnCheckedChangeListener((v, on) -> {
                    sp.edit().putString("directVr", on ? "1" : "0").apply();
                    PageForensics.line("APK", "配置页：直接显示「进入 VR」按钮（不等平台）=" + on
                            + "（网址下次拉起带 ?vrbtn=1 则旁路门禁）");
                });
            }
            // ★ 第十五修 / 第十七修：LaunchGuard 的配置项 ——
            //   ① 应急开关：EXE 是**硬闸门**（EXE 不在线 → 谁也启动不了），软件必须留一个
            //      不用重打包的出口，否则 EXE 一崩现场全停摆；
            //   ② 密钥：★ 第十七修起改为**两端固定的共享串**（见 guardSecret），这里只做只读展示；
            //   ③ 设备号展示：白名单按它登记（EXE 界面里删条目时对照用）。
            android.widget.CheckBox cbSkipExe = findViewById(R.id.cbSkipExe);
            if (cbSkipExe != null) {
                cbSkipExe.setChecked("1".equals(sp.getString("skipExeCheck", "0")));
                cbSkipExe.setOnCheckedChangeListener((v, on) -> {
                    sp.edit().putString("skipExeCheck", on ? "1" : "0").apply();
                    PageForensics.line("APK", "配置页：跳过直播端校验（应急）=" + on
                            + (on ? " → 之后只要求平台客户端拉起" : " → 恢复硬闸门（要求 EXE 放行）"));
                });
            }
            // ★ 第十七修：密钥输入框改为**只读**。它现在两端固定，改它没有任何意义，只会制造不一致：
            //   而本配置页在门禁**之内**（进得去才改得动）⇒ 一旦不一致，现场无法自救。
            //   顺手清掉历史遗留的自定义值，保证升级后立刻回到固定串。
            final EditText etSec = findViewById(R.id.etSecret);
            if (etSec != null) {
                String stale = sp.getString("guardSecret", "");
                if (stale != null && !stale.isEmpty() && !GUARD_SECRET_FIXED.equals(stale)) {
                    sp.edit().remove("guardSecret").apply();
                    PageForensics.line("APK", "配置页：已清除历史自定义密钥（第十七修起两端固定，无需填写）");
                }
                etSec.setText(GUARD_SECRET_FIXED);
                etSec.setEnabled(false);
            }
            android.widget.TextView tvDev = findViewById(R.id.tvDeviceId);
            if (tvDev != null) {
                tvDev.setText("本机设备号（EXE 白名单里按它登记）：" + guardDeviceId());
            }
            // 把当前认定的「平台客户端」显示出来：名字不对时一眼能看出来（包名来自 referrer 自动识别）
            android.widget.TextView tvcp = findViewById(R.id.tvClientPkg);
            if (tvcp != null) {
                tvcp.setText("平台客户端：" + (sPlatformClientPkg != null
                        ? sPlatformClientPkg : DEFAULT_CLIENT_PKG + "（默认，等平台拉起一次后自动确认）"));
            }
            // ★ 第十一修：悬浮窗权限状态 + 一键去授予（后台启动 Activity 的官方豁免项）
            refreshOverlayState(this);
            android.widget.Button btnOv = findViewById(R.id.btnOverlay);
            if (btnOv != null) {
                btnOv.setOnClickListener(v -> requestOverlayPermission(this));
            }
        } catch (Throwable ignore) { /* 布局里没有这些控件时忽略（旧布局兼容） */ }

        Button btnStart = findViewById(R.id.btnStart);
        btnStart.setOnClickListener(v -> startCast());

        // 本地 8080 可能尚未 bind 完成（NanoHTTPD.start 异步），若此刻就拉起浏览器会
        // 连到 localhost 拒绝（表现为「第一次 localhost 拒绝」）。改用看门狗轮询 8080 就绪
        // 后再拉起，杜绝抢跑；就绪后也会触发 maybeLaunch 补拉。
        startLaunchWatchdog();

        // 2) 自动发现 PC 接收端：**已在 onCreate 早期启动**（第十五修：门禁要拿它发现的地址
        //    去问 EXE 要放行条，不能等到这里），此处只更新界面文案。
        tvStatus.setText("正在搜索 PC 接收端…");
        manualPanel.setVisibility(View.GONE);

        // 3) 应用内 WebView：默认关闭（USE_INNER_WEBVIEW=false），玩家只会看到一个网页（PICO 浏览器的游戏页）
        if (USE_INNER_WEBVIEW) {
            setupGameWebView();
            revealGame();
        } else {
            hideInnerWebView();
        }

        // 4) 超时兜底：未找到 PC 也可直接游玩；给出手动输入入口（有线/特殊网络下可用）
        new android.os.Handler(getMainLooper()).postDelayed(() -> {
            if (currentPc == null) {
                tvStatus.setText("未自动找到 PC（可忽略，直接游玩）；如需推流请手动输入地址后点击启动");
                manualPanel.setVisibility(View.VISIBLE);
            }
            // 无论如何都拉起一次（maybeLaunch 有 autoLaunched 守卫，只会拉起一次）：
            // 已发现 PC 时上面已拉起；未发现则无 pc 参数，仅本地游玩。
            maybeLaunch();
        }, DISCOVER_TIMEOUT_MS);
        // ★ 2026-09-20 修：把门禁核实过的直播端地址定成本局推流目标（不依赖信标）
        adoptGuardPc();
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;                 // 已到前台：此刻 startActivity（拉起浏览器）才不会被系统拦截
        refreshOverlayState(this);      // 从系统设置授予悬浮窗权限回来时，这里刷新状态文字（第十一修）
        if (webView != null) webView.onResume();
        // 前台后补一次。maybeLaunch 内部按情况处理：
        //   · 游戏页仍在跑 → 只退后台 + 补报 cmd3（绝不重开浏览器，否则重载游戏页）；
        //   · 游戏页已失联 → 重新拉起浏览器。
        maybeLaunch();
    }

    @Override
    protected void onPause() {
        resumed = false;
        if (webView != null) webView.onPause();
        super.onPause();
    }

    // ── 应用内 WebView：渲染游戏本体 ──
    private void setupGameWebView() {
        webView = findViewById(R.id.gameWebView);
        if (webView == null) return;
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);  // WebGL/WebXR 需要硬件合成层
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);                          // WebXR / 游戏逻辑必需
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);          // 允许无手势媒体（等待房间有声影片）
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        ws.setAllowFileAccess(false);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);

        // WebRTC 推流等权限：本地安全来源直接授权（离线游戏，无外部风险）
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                final String origin = request.getOrigin() != null ? request.getOrigin().toString() : "";
                if (origin.startsWith("http://localhost")) {
                    runOnUiThread(() -> request.grant(request.getResources()));
                } else {
                    request.deny();
                }
            }
        });

        // WebXR 支持检测（注入 JS，结果经 XrCheck 回传 Java）
        webView.addJavascriptInterface(new XrCheckInterface(), "XrCheck");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                if (probeMode) view.evaluateJavascript(XR_CHECK_JS, null);
            }
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                String msg = "游戏页面加载失败(" + errorCode + "): " + description;
                android.widget.Toast.makeText(MainActivity.this, msg, android.widget.Toast.LENGTH_LONG).show();
            }
            @Override
            public void onReceivedHttpError(WebView view, android.webkit.WebResourceRequest req, android.webkit.WebResourceResponse resp) {
                if (req.getUrl() != null && req.getUrl().toString().endsWith("/")) {
                    String msg = "游戏页 HTTP " + resp.getStatusCode() + "：本地服务可能未启动";
                    android.widget.Toast.makeText(MainActivity.this, msg, android.widget.Toast.LENGTH_LONG).show();
                }
            }
        });

        // 只加载最小探测页，不加载完整游戏：避免 WebView 在 new World() 处创建 WebGL 上下文失败
        // （头显内置 WebView 通常无 GPU），以及避免与 PICO 浏览器共用 GPU 上下文池时抢资源。
        probeMode = true;
        webView.loadDataWithBaseURL("http://localhost/", PROBE_HTML, "text/html", "UTF-8", null);
    }

    // 注入到页面：检测 navigator.xr.isSessionSupported('immersive-vr')，结果回传 XrCheck.onResult
    private static final String XR_CHECK_JS =
        "(function(){" +
        "  try{" +
        "    if(!navigator.xr){ XrCheck.onResult(false); return; }" +
        "    var p = navigator.xr.isSessionSupported('immersive-vr');" +
        "    if(p && p.then){ p.then(function(s){ XrCheck.onResult(!!s); }).catch(function(){ XrCheck.onResult(false); }); }" +
        "    else { XrCheck.onResult(!!p); }" +
        "  }catch(e){ XrCheck.onResult(false); }" +
        "})();";

    private class XrCheckInterface {
        @JavascriptInterface
        public void onResult(boolean supported) {
            if (probeMode && supported) {
                // WebView 自身支持 WebXR → 直接在 WebView 内跑完整游戏，无需跳 PICO 浏览器
                probeMode = false;
                inAppPlaying = true;          // 应用内已在跑 → maybeLaunch 不再拉起外部浏览器
                runOnUiThread(() -> webView.loadUrl(GAME_URL));
                return;
            }
            // WebView 不支持 WebXR（PICO 头显通常如此）→ 标记，等 PC 发现/超时后用 PICO 浏览器拉起
            xrUnsupported = true;
            if (autoLaunched) return;
            runOnUiThread(() -> {
                xrChecked = true;
                android.widget.Toast.makeText(MainActivity.this,
                        "当前 WebView 不支持 WebXR，将用 PICO 浏览器进入 VR…",
                        android.widget.Toast.LENGTH_LONG).show();
                if (currentPc != null) maybeLaunch();   // PC 已就位 → 直接拉起 PICO 浏览器
            });
        }
    }

    private void revealGame() {
        if (webView != null) webView.setVisibility(View.VISIBLE);
    }

    /** 关闭应用内 WebView 的显示（不销毁对象）：只保留外部浏览器里的那一个游戏页 */
    private void hideInnerWebView() {
        try {
            View wv = findViewById(R.id.gameWebView);
            if (wv != null) wv.setVisibility(View.GONE);
        } catch (Exception ignore) { /* 布局里没有该 View 时忽略 */ }
    }

    // ══════════════════ ★ 第十五修：LaunchGuard（「只能通过客户端启动」门禁）══════════════════
    //
    // 【需求】手动（桌面图标 / 最近任务 / adb）**直接无法启动**；只有「平台客户端拉起」
    //   **且**「直播端 EXE 在线且在白名单」才放行。两者缺一：黑底一行提示，1.2 秒后自己退出，
    //   一秒画面都不出（连浏览器都不拉）。
    //
    // 【为什么在 Activity 层拦（而不是页面层）】页面层只能拦住「进 VR」这一步，而玩家会先看到
    //   整个预览界面 —— 那不算「无法启动」。故判定必须在 Activity 层（见 guardPass 注释）。
    //
    // 【第十六修：等 EXE 必须异步】现场实测：平台**同时**拉起 EXE 与 APK，Electron 冷启动要
    //   数秒到十几秒，而旧实现只等 3.2s ⇒ APK 必然先退出、平台又不会重试 ⇒ 「一闪就退，
    //   后面的项全测不了」。改成「进度页 + 后台轮询最多 20s」，主线程零阻塞（阻塞会 ANR）。
    //
    // 【维护出口（★ 第十七修：已从「头显侧」搬到「PC 侧」）】
    //   旧形态是「2 秒内连点图标 3 次 → 本次进维护模式（放行 + 跳过 EXE 校验 + 建出配置页）」。
    //   实测（2026-09-20 留痕）它**根本用不了**：三次「人工点图标」全被记成「2 秒内第 1 次」——
    //   PICO 上「退出 → 回应用管理 → 再点图标」的物理耗时远超 2 秒窗口，永远凑不齐 3 次。
    //   而它本该兜住的那个死锁（两端 secret 不一致）恰好就发生了，现场无路可走。
    //   现在两道措施替代了它，且都在**门禁之外**：
    //     · ① 密钥改为两端固定的共享串（见 guardSecret）⇒ 「不一致」这个死锁从根上消失；
    //     · ② PC 接收端加了「**重新配对**」按钮（清空白名单 → 重开配对窗口）⇒ 白名单把人锁住时，
    //          操作员在电脑上点一下就解开了，头显侧不需要任何界面操作。
    //   故本 Activity 侧不再保留任何旁路入口（需求方 2026-09-20 明示：不需要维护模式）。

    /**
     * 门禁主入口。**返回 false 时调用方必须立刻 return**（不能建界面、不能拉浏览器）。
     * 注意 false 有两种含义，都由本方法自己兜后续：
     *   · **已拒绝** → 黑底提示页已建好 + 1.2s 后 finish；
     *   · **等待中**（★ 第十六修）→ 「正在等待直播端启动…」进度页已建好，等 EXE 上线后
     *     由后台线程回调 `initGameUi()` 接着把界面建起来。
     *
     * <h3>规则（需求方 2026-09-20 选定）</h3>
     * 合法启动 = ① 由**平台客户端**拉起（同步、本地判定，见 computePlatformDriven）
     *          + ② **直播端 EXE 在线且在白名单**（首次拉起时向 EXE 要一张放行条，见 guardExeCheckAsync）
     *          + ③ **拿到 EXE 下发的轻量配置**（见 fetchExeConfig）。
     *
     * <h3>为什么 ① 是同步的、② 是异步的（第十六修的设计要点）</h3>
     * ① 零网络、零等待，必须在同步层判完 —— 因为**平台重拉**走的是 `passThrough` 零窗口路径
     * （为了不把浏览器里的 XR 会话挤掉），那条路一行异步代码都不能加。
     * ② 要等 EXE 冷启动（数秒~十几秒），**只能异步 + 长等待**；它只出现在「首次拉起」，
     * 那时玩家还在 2D，建一个进度页是安全且必要的（同步阻塞 20s 会 ANR）。
     * 两条的边界 = `passThrough` 分支：那一支直接标已放行并 `return`，永不进入 ②。
     */
    private boolean guardPass() {
        // 每次 onCreate 都从零判定：static 的 sGuardPassed 可能还留着**上一次**的 true
        // （例如上一轮平台启动成功过），而这次是手动点图标 → 若不清掉，拒绝路径上
        // onResume 调用的 maybeLaunch 会以为门禁已放行 → 直接把浏览器拉起来 = 门禁被绕过。
        sGuardPassed = false;
        // ① 平台证据：同步、本地、零网络。判据两条，**任一成立**即算「平台客户端拉起」：
        //     · platformDriven=true —— intent 带 -d，或**不带** CATEGORY_LAUNCHER（平台 am start 的典型形态）；
        //     · 或者**没有人工点击的 referrer** —— 真 launcher 点击一定留 `android-app://<launcher>`，
        //       而平台启动器留的是 `android-app://com.GoodNet.LauncherClient`（looksLikeManualLaunch 已特判）。
        //   ⚠ 为什么必须保留第二条（否则会误拒平台）：留痕实测 2026-09-19 17:38，平台曾用
        //     `am start -c android.intent.category.LAUNCHER`（且不带 -d）拉起我们 —— 那与人工点击在
        //     intent 形态上**完全同形**，只认 platformDriven 会把它判成手动 ⇒ **平台再也启动不了**。
        boolean manual = looksLikeManualLaunch();
        if (!platformDriven && manual) {
            // ★ 第十七修：只拒绝，不再累计「连点次数」（旧维护出口已废除，理由见上方注释）
            guardStore(false, "非平台客户端启动（人工点图标 / 最近任务）");
            guardDeny("请通过平台客户端启动游戏", "本机只能在平台上点击「开始游戏」后启动", 1200L);
            return false;
        }
        if (!platformDriven) {
            PageForensics.line("APK", "LaunchGuard：intent 形态像人工点击，但**没有人工 referrer**（ref="
                    + referrerStr() + "）→ 按平台证据放行（平台曾用 -c LAUNCHER 拉起我们）");
        }
        // ② 应急开关（配置页勾选）：EXE 是硬闸门，软件必须留一个不用重打包的出口
        if (guardSkipExe()) {
            sGuardPassed = true;
            guardStore(true, "配置页勾选了「跳过直播端校验（应急）」");
            PageForensics.line("APK", "LaunchGuard：应急开关已打开 → 跳过 EXE 校验直接放行");
            return true;
        }
        // ③ 向直播端 EXE 要放行条 + 拉取配置（★ 第十六/十七修：异步）
        //    为什么异步：平台是同时拉起 EXE 与 APK 的，Electron 冷启动要数秒~十几秒；旧实现只等 3.2s
        //    就出结论 ⇒ APK 必然先退出，而平台不会自动重试 ⇒ 现场「一闪就退，后面的项没法测」。
        //    现在改成「等待页 + 后台轮询最多 GUARD_WAIT_TOTAL_MS」，主线程零阻塞（阻塞 20s 会 ANR）。
        if (guardExeCheckAsync()) {
            sGuardPassed = true;
            return true;    // 10 秒内的结论缓存命中 → 同步放行
        }
        // 挂起中（等待页已建，放行后由后台线程回调 initGameUi）或已拒绝（提示页 + finish 已排好）
        return false;
    }

    /**
     * 向直播端 EXE 要放行条（★ 第十六修：**改成异步**）。
     *
     * <h3>为什么必须异步（现场实测的教训）</h3>
     * 旧实现在主线程阻塞等 EXE，预算只有 EXE_PROBE_WAIT_MS + EXE_PROBE_TIMEOUT_MS ≈ 3.2 秒；
     * 而平台是**同时**拉起 EXE 与 APK 的，Electron 冷启动要数秒到十几秒 —— APK 必然先超时退出，
     * 且平台不会自动重试，现场表现就是「一闪就退，后面的项根本没法测」。
     * 直接加长阻塞同样不行：主线程阻塞 &gt;5 秒会 ANR，而 ANR 弹窗在 PICO 上就是一个 2D 面板（会顶掉 XR 会话）。
     * 故：等待页 + 后台线程轮询重试，**主线程零阻塞**。
     *
     * <h3>与硬约束 52 的关系（重拉路径不受影响）</h3>
     * 本方法**只走「首次拉起」**。平台重拉走的是 `passThrough` 零窗口分支，在 guardPass() 里就被
     * 直接标为已放行，根本到不了这里 ⇒ 不会因为等网络而把玩家从 VR 里踢出来。
     *
     * @return true  = 已**同步**放行（10 秒内的结论缓存命中），调用方继续走 initGameUi()；
     *         false = 已挂起（等待页已建，后续由后台线程回调）或已拒绝，调用方直接 return
     */
    private boolean guardExeCheckAsync() {
        long now = System.currentTimeMillis();
        if (sGuardOk && (now - sGuardAt) < GUARD_CACHE_MS) {
            PageForensics.line("APK", "LaunchGuard：复用 " + (now - sGuardAt) + "ms 前的授权结论（" + sGuardWhy + "）");
            return true;
        }
        final int seq = ++sGuardWaitSeq;
        showGuardNotice("正在等待直播端启动…",
                "已等 0 秒 / 最多 " + (GUARD_WAIT_TOTAL_MS / 1000) + " 秒（EXE 一上线会立刻放行）", 0L);
        PageForensics.line("APK", "LaunchGuard：进入异步等待（上限 " + (GUARD_WAIT_TOTAL_MS / 1000)
                + "s，每 " + GUARD_RETRY_INTERVAL_MS + "ms 重试一次）");
        Thread t = new Thread(() -> guardWaitLoop(seq), "launch-guard");
        t.setDaemon(true);
        t.start();
        return false;
    }

    /**
     * 后台轮询线程：每 GUARD_RETRY_INTERVAL_MS 重试一次，直到拿到结论或超时。
     *
     * <p>★ 三种结果必须分开处理 —— 这正是旧实现最大的坑：它把「404 / 连不上」也当成「被拒绝」，
     * 于是报出误导性的「本机未获授权」，真因（EXE 是旧版 / 地址不是直播端）被彻底掩盖。
     * <ul>
     *   <li>HTTP 200 且响应体含 allow ⇒ **确实是我们的直播端**：`false` 是**真拒绝**（HMAC 不符 /
     *       不在白名单，或**它自己未激活** —— 兜底 0 天后它侧 licenseGate 会直接拒），**立刻结束**，
     *       不让玩家白等满 20 秒；`true` ⇒ ★ P3 先用内置 Ks_pub 验它的 license + proof
     *       （见 {@link #licenseCheck}），**过了才继续拉配置**（见 {@link #fetchExeConfig}），
     *       配置也齐了才算最终通过；其中「取不到授权信息」按**过渡态**留在循环里重试（见硬约束 61）；</li>
     *   <li>HTTP 404 / 200 但非 JSON ⇒ 该地址上跑的是**别的 HTTP 服务**（旧版 EXE / http-server /
     *       头显自己的 8080）⇒ **继续重试**（信标一到会自动换到权威地址）；</li>
     *   <li>连不上 / 超时 ⇒ EXE 还没启动 ⇒ 继续重试。</li>
     * </ul>
     *
     * <p>★ 第十七修：等待期**必须留痕**。旧实现 20 秒里一行都不写（实测留痕 15:07:41 → 15:08:02
     * 完全空白），现场只能靠推断「它到底在等什么」。现在：状态变化立刻写一条，另外每 3 秒无条件
     * 写一条（不刷屏，也不留空白）。用 lastWhy 的**内容**做状态签名，天然覆盖所有分支。
     */
    private void guardWaitLoop(int seq) {
        final long start = System.currentTimeMillis();
        final long deadline = start + GUARD_WAIT_TOTAL_MS;
        String lastWhy = "还没发现直播端（等它的信标广播）";
        long lastUiAt = 0L;
        long lastLogAt = 0L;
        String lastSig = null;
        while (seq == sGuardWaitSeq && System.currentTimeMillis() < deadline) {
            long now = System.currentTimeMillis();
            if (now - lastUiAt >= 900L) {          // 约每秒刷一次进度：玩家/操作员能看出程序还活着
                lastUiAt = now;
                setGuardNoticeText("正在等待直播端启动…",
                        "已等 " + ((now - start) / 1000) + " 秒 / 最多 " + (GUARD_WAIT_TOTAL_MS / 1000)
                                + " 秒（EXE 一上线会立刻放行）\n" + lastWhy);
            }
            // 每轮**重新取一次**地址：EXE 落在备用端口（8443 被占时 8444+）时靠信标自动纠正
            String base = guardExeBase();
            if (base == null) {
                lastWhy = "还没发现直播端（等它的信标广播）";
            } else {
                GuardProbe p = probeExeAuthority(base);
                if (p.isOurExe()) {
                    final String why = guardWhyOf(p.body);
                    if (!p.body.contains("\"allow\":true")) {
                        // 是我们的直播端但明确拒绝 → 真拒绝，立刻结束（别让玩家白等满 20 秒）
                        guardStore(false, "直播端拒绝：" + why);
                        // ★ P3：拒因可能来自**对面自己** —— 兜底 0 天（到期即停）后，EXE 未激活 / 已到期时
                        //   它的 licenseGate() 会直接拒，此时还写「本机未获授权」会把人引到头显这条错路上。
                        //   现场排障最贵的就是这种误导（第十五修「404 也报未授权」白绕过一轮）。
                        //   判据：licenseGate() 的文案一律以「直播端」开头。
                        final boolean exeSideProblem = why.contains("直播端");
                        runOnUiThread(() -> {
                            if (seq != sGuardWaitSeq) return;
                            guardDeny(exeSideProblem ? "直播端授权异常" : "本机未获授权",
                                    "直播端拒绝：" + why, 4000L);
                        });
                        return;
                    }
                    // ── 已确认「是本机直播端」**且它已放行** ⇒ ★ P3：先验明正身，再拿配置 ──
                    //    排在放行之后（而不是之前）是刻意的：这样既让 license 成为「继续拉配置的
                    //    必要条件」（拿不到授权 → 配置下不来 → 游戏起不来），又**一根手指都不动**
                    //    既有的四态分类（地址定性 / 旧版 EXE / 连不上），不会把硬约束 61 那个坑踩回去。
                    final LicenseVerify.Verdict lv = licenseCheck(base);
                    if (lv.retry()) {
                        // 过渡态：同一地址刚刚才回过 allow:true，这里却取不到 ⇒ 当抖动，留在循环里继续等
                        lastWhy = "已连上直播端（" + base + "），但授权信息没取到：" + lv.why;
                    } else if (!lv.ok()) {
                        final boolean oldExe = (lv.kind == LicenseVerify.KIND_ABSENT);
                        guardStore(false, "直播端授权校验未通过：" + lv.why);
                        runOnUiThread(() -> {
                            if (seq != sGuardWaitSeq) return;
                            guardDeny(oldExe ? "直播端版本过旧" : "直播端授权不合法",
                                    lv.why + "\n（授权由运营方发放 / 续期，请联系运营方）", 4000L);
                        });
                        return;
                    } else {
                        guardStore(true, "直播端放行 + 授权校验通过（" + base + "）：" + lv.why);
                        // ★ 第十七修：放行 ≠ 通过。还要把「轻量配置」整包取下来 —— 头显侧对清单里的
                        //   路径只认覆盖层、不回落 assets（见 GameServer），拿不到就是跑不起来。
                        //   本方法已在后台线程，HTTP 阻塞是允许的（主线程绝不能）。
                        final String cfgErr = fetchExeConfig(base);
                        runOnUiThread(() -> {
                            if (seq != sGuardWaitSeq) return;
                            if (cfgErr != null) {
                                PageForensics.line("APK", "LaunchGuard：配置下发失败 → 拒绝启动（" + cfgErr + "）");
                                guardDeny("配置下发失败", cfgErr + "\n请检查直播端的「游戏目录」设置后重试", 4000L);
                                return;
                            }
                            PageForensics.line("APK", "LaunchGuard：等待 "
                                    + (System.currentTimeMillis() - start) + "ms 后放行 → 建游戏界面（" + why + "）");
                            mountOverlayToServer();   // 刚下发的文件立刻生效（不等下次 Activity 重建）
                            // ★ 推流目标 = 门禁刚核实过的那台 EXE（不再等信标）
                            sGuardVerifiedPc = hostPortOf(base);
                            sGuardPassed = true;
                            initGameUi();
                        });
                        return;
                    }
                } else if (p.code > 0) {
                    // 有 HTTP 响应但不是我们的授权端点 —— 必须定性：是**旧版**接收端，还是别的服务占了这地址。
                    // 这两种处置完全不同（换 EXE vs 换地址），而它们都表现为同一个「404」。
                    String id = guardIdentity.get(base);
                    if (id == null) {
                        id = probeExeIdentity(base);
                        guardIdentity.put(base, id);
                        PageForensics.line("APK", "LaunchGuard：地址 " + base + " 定性 = " + id
                                + "（/api/launch/request 返回 HTTP " + p.code + "）");
                    }
                    lastWhy = "地址 " + base + "：" + id;
                } else {
                    lastWhy = "直播端 " + base + " 还没起来";
                }
            }
            // ★ 第十七修：等待期留痕。状态签名 = 地址 + 原因；变化即写，另外每 3 秒兜一条。
            //   （旧实现整段空白，现场无法确认它在重试什么 —— 见方法头上的注释。）
            {
                long t = System.currentTimeMillis();
                String sig = (base == null ? "-" : base) + "|" + lastWhy;
                if (!sig.equals(lastSig) || t - lastLogAt >= 3000L) {
                    lastSig = sig;
                    lastLogAt = t;
                    PageForensics.line("APK", "LaunchGuard：等待中 " + ((t - start) / 1000) + "s / "
                            + (GUARD_WAIT_TOTAL_MS / 1000) + "s —— " + lastWhy);
                }
            }
            try { Thread.sleep(GUARD_RETRY_INTERVAL_MS); } catch (InterruptedException ignore) { return; }
        }
        if (seq != sGuardWaitSeq) return;          // 已换轮 / Activity 已销毁 → 不再出结论
        final String why = lastWhy;
        guardStore(false, "等待 " + (GUARD_WAIT_TOTAL_MS / 1000) + "s 超时：按硬闸门拒绝（" + why + "）");
        runOnUiThread(() -> {
            if (seq != sGuardWaitSeq) return;
            guardDeny("未连接直播端，无法启动",
                    "等了 " + (GUARD_WAIT_TOTAL_MS / 1000) + " 秒仍没等到电脑上的直播接收端\n" + why, 1200L);
        });
    }

    /**
     * ★ 第十六修：这个地址上到底跑的是什么？—— 一次 `GET /api/info` 就能定性。
     *
     * <p>为什么需要它：只看到「HTTP 404」时分不清两种情况，而它们的处置**完全不同**：
     * <ul>
     *   <li>是**旧版**直播接收端（例如 09-11 那种整包，还没有 `/api/launch/request`）→ **换 EXE**；</li>
     *   <li>根本不是直播接收端（用户自起的 http-server / 别的服务占了这个端口）→ **换地址**。</li>
     * </ul>
     * 判据：`/api/info` 从最早版本起就有；新版还会多带 `"guard":true`。
     *
     * <p>⚠ 这条诊断是被现场教出来的：第十五修首次实测时只报了「404 → 本机未获授权」，
     * 真因（EXE 整包没换）被彻底掩盖，白绕了一轮。
     */
    private String probeExeIdentity(final String base) {
        final String[] out = new String[1];
        Thread t = new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(base + "/api/info").openConnection();
                conn.setConnectTimeout(EXE_PROBE_TIMEOUT_MS);
                conn.setReadTimeout(EXE_PROBE_TIMEOUT_MS);
                conn.setRequestMethod("GET");
                InputStream in = conn.getInputStream();
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[1024];
                int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                in.close();
                String text = new String(bo.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
                if (text.contains("\"guard\":true")) {
                    out[0] = "直播端是新版（已支持授权），但仍未放行本机 → 检查 secret / 白名单";
                } else if (text.contains("\"port\"")) {
                    out[0] = "直播端是**旧版本**（缺 /api/launch/request 授权接口）→ 必须更新电脑上的接收端 EXE";
                } else {
                    out[0] = "这个地址上不是直播接收端 → 检查 PC 地址 / 端口";
                }
            } catch (Throwable e) {
                out[0] = "连不上（" + e.getClass().getSimpleName() + "）";
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
        t.setDaemon(true);
        t.start();
        try { t.join(EXE_PROBE_TIMEOUT_MS + 500L); } catch (InterruptedException ignore) { /* 按超时处理 */ }
        return (out[0] != null) ? out[0] : "连不上";
    }

    /** 一次探测的结果：code = HTTP 状态码（&lt;=0 表示连不上 / 超时），body = 响应体文本（已截断） */
    private static final class GuardProbe {
        final int code;
        final String body;
        GuardProbe(int code, String body) { this.code = code; this.body = body; }
        /** 响应体里有 allow 字段 ⇒ 对端**确实是我们的直播接收端**（而不是别的 HTTP 服务） */
        boolean isOurExe() { return code == 200 && body != null && body.contains("\"allow\""); }
    }

    /**
     * 真正的 HTTP 请求（调用方已是后台线程；这里再起一个带超时的子线程 + join，
     * 是给「连接 + 读取」一个硬上限，保证单轮不会拖垮整个等待窗口）：
     * `POST http://&lt;直播端&gt;/api/launch/request`，body `{"dev":..,"ts":..,"sig":..}`。
     * **永不返回 null**（连不上 → code = -1）。
     */
    private GuardProbe probeExeAuthority(final String base) {
        final String dev = guardDeviceId();
        final String ts = String.valueOf(System.currentTimeMillis());
        final String sig = guardHmac(dev + "|" + ts);
        final GuardProbe[] out = new GuardProbe[1];
        Thread t = new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                byte[] body = ("{\"dev\":\"" + dev + "\",\"ts\":\"" + ts + "\",\"sig\":\"" + sig + "\"}")
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8);
                conn = (HttpURLConnection) new URL(base + "/api/launch/request").openConnection();
                conn.setConnectTimeout(EXE_PROBE_TIMEOUT_MS);
                conn.setReadTimeout(EXE_PROBE_TIMEOUT_MS);
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setFixedLengthStreamingMode(body.length);
                OutputStream os = conn.getOutputStream();
                os.write(body);
                os.flush();
                os.close();
                int code = conn.getResponseCode();
                InputStream in = (code >= 400) ? conn.getErrorStream() : conn.getInputStream();
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                if (in != null) {
                    byte[] buf = new byte[1024];
                    int n;
                    while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                    in.close();
                }
                String text = new String(bo.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
                // 404 时对端可能回一整个 HTML 页面：留痕只打前 160 字符，别把留痕撑爆
                String preview = (text.length() > 160) ? (text.substring(0, 160) + "…") : text;
                out[0] = new GuardProbe(code, (text.length() > 400) ? text.substring(0, 400) : text);
                PageForensics.line("APK", "LaunchGuard：POST " + base + "/api/launch/request dev=" + dev
                        + " sig=" + (sig.length() >= 8 ? sig.substring(0, 8) : sig) + "… → HTTP " + code
                        + " " + preview);
            } catch (Throwable e) {
                out[0] = new GuardProbe(-1, null);
                PageForensics.line("APK", "LaunchGuard：直播端探测失败 " + base + " → "
                        + e.getClass().getSimpleName() + ": " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
        t.setDaemon(true);
        t.start();
        try { t.join(EXE_PROBE_TIMEOUT_MS + 500L); } catch (InterruptedException ignore) { /* 按超时处理 */ }
        return (out[0] != null) ? out[0] : new GuardProbe(-1, null);
    }

    /**
     * ★ 第十七修：把磁盘上的覆盖层（含受管路径清单）挂到 GameServer。
     *
     * <p>为什么要「每次重建 Activity 都重挂」：GameServer 是**进程级单例**（跨 Activity 存活），
     * 而覆盖层清单是刚下发/刚读盘的 —— 不重挂就会出现「下发了但服务还在用旧清单」的鬼状态。
     * 两种路径都要覆盖到：① 刚下发完就启动；② 重启 Activity 后复用已在跑的服务。
     */
    private void mountOverlayToServer() {
        try {
            java.io.File dir = new java.io.File(getFilesDir(), OVERLAY_DIR);
            java.util.List<String> paths = new java.util.ArrayList<>();
            java.io.File mf = new java.io.File(dir, "session.json");
            if (mf.isFile()) {
                byte[] buf = new byte[(int) mf.length()];
                java.io.FileInputStream fis = new java.io.FileInputStream(mf);
                try {
                    int n = fis.read(buf);
                    if (n > 0 && n != buf.length) buf = java.util.Arrays.copyOf(buf, n);
                } finally { fis.close(); }
                org.json.JSONObject o = new org.json.JSONObject(
                        new String(buf, java.nio.charset.StandardCharsets.UTF_8));
                org.json.JSONArray arr = o.optJSONArray("paths");
                if (arr != null) for (int i = 0; i < arr.length(); i++) paths.add(arr.optString(i));
            }
            if (server != null) server.setOverlay(dir.isDirectory() ? dir : null, paths);
        } catch (Throwable e) {
            PageForensics.line("APK", "覆盖层挂载失败（按「无覆盖层」处理）：" + e);
            if (server != null) server.setOverlay(null, null);
        }
    }

    // ───────────── ★ 第十七修：配置下发（EXE → 头显的「轻量配置」）─────────────
    /**
     * 向直播端拉取「轻量配置」并落地到私有目录的**覆盖层**（filesDir/game-overlay/）。
     *
     * <h3>为什么它是门禁的第三步（而不是「顺便同步一下文件」）</h3>
     * `GameServer` 托管静态资源时**优先读覆盖层**，且对清单里的路径**只认覆盖层、不回落 assets**
     * ⇒ 没经过这一步就拿不到关卡定义（levels.js / spawnPlans.js …），游戏连第一关都跑不起来。
     * 这比「校验通过就放行」硬得多：授权从**一次判断**变成了**必要条件**。
     *
     * <h3>局号（session）与「退出即失活」</h3>
     * EXE 每次进程启动都换一个局号。本机存的局号与它对不上 ⇒ 旧覆盖层视为**已失效**，先整目录
     * 清掉再落新的。这就是「APK 退出 / 关闭后文件失效」的等价实现 —— 但**刻意不在 Activity 销毁时
     * 真删文件**：平台重拉会重建 Activity（免打扰路径），那时删等于把正在跑的游戏页资源删掉
     * （见硬约束 52 / 35，那正是会把玩家踢出 VR 的那条链）。
     *
     * <p>⚠ 本方法会做网络 IO，**只能在后台线程调用**（当前唯一调用点 guardWaitLoop 就是后台线程）。
     *
     * @param base 直播端基址（如 http://192.168.31.228:8443）
     * @return null = 成功；否则是人话原因（直接进提示页，不再启动）
     */
    private String fetchExeConfig(String base) {
        HttpURLConnection conn = null;
        try {
            String dev = guardDeviceId();
            String ts = String.valueOf(System.currentTimeMillis());
            String sig = guardHmac(dev + "|" + ts);
            String url = base + "/api/config/dump"
                    + "?dev=" + java.net.URLEncoder.encode(dev, "UTF-8")
                    + "&ts=" + java.net.URLEncoder.encode(ts, "UTF-8")
                    + "&sig=" + sig;
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout((int) CONFIG_FETCH_TIMEOUT_MS);
            conn.setReadTimeout((int) CONFIG_FETCH_TIMEOUT_MS);
            int code = conn.getResponseCode();
            InputStream in = (code >= 400) ? conn.getErrorStream() : conn.getInputStream();
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            if (in != null) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    bo.write(buf, 0, n);
                    if (bo.size() > CONFIG_MAX_BYTES) {
                        in.close();
                        return "配置包过大（> " + (CONFIG_MAX_BYTES / 1024) + "KB）";
                    }
                }
                in.close();
            }
            if (code != 200) return "配置下发失败：HTTP " + code;
            String text = new String(bo.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
            org.json.JSONObject o = new org.json.JSONObject(text);
            if (!o.optBoolean("allow", false)) {
                return "配置下发被拒：" + o.optString("why", "(无原因)");
            }
            String session = o.optString("session", "");
            org.json.JSONArray files = o.optJSONArray("files");
            if (files == null || files.length() == 0) {
                return "配置下发失败：清单为空（直播端是不是没配「游戏目录」？）";
            }

            java.io.File root = new java.io.File(getFilesDir(), OVERLAY_DIR);
            String prev = (sp == null) ? "" : sp.getString(OVERLAY_SESSION_KEY, "");
            boolean newSession = !session.isEmpty() && !session.equals(prev);
            if (newSession) {
                deleteRecursively(root);     // 换局 ⇒ 旧覆盖层作废（「退出即失活」的等价实现）
            }
            if (!root.exists() && !root.mkdirs()) return "配置下发失败：无法创建覆盖层目录";

            java.util.List<String> paths = new java.util.ArrayList<>();
            for (int i = 0; i < files.length(); i++) {
                org.json.JSONObject f = files.optJSONObject(i);
                if (f == null) continue;
                String rel = f.optString("path", "");
                if (rel.isEmpty()) return "配置下发失败：清单项缺少 path";
                // 防目录穿越：只接受干净的相对路径
                if (rel.startsWith("/") || rel.contains("..") || rel.contains("\\")) {
                    return "配置下发失败：非法路径 " + rel;
                }
                byte[] data = f.optString("content", "").getBytes(java.nio.charset.StandardCharsets.UTF_8);
                String want = f.optString("sha256", "");
                if (!want.isEmpty() && !want.equalsIgnoreCase(sha256Hex(data))) {
                    return "配置下发失败：内容校验不通过 " + rel;
                }
                java.io.File out = new java.io.File(root, rel);
                java.io.File parent = out.getParentFile();
                if (parent != null && !parent.exists() && !parent.mkdirs()) {
                    return "配置下发失败：无法创建目录 " + rel;
                }
                java.io.FileOutputStream fos = new java.io.FileOutputStream(out);
                try { fos.write(data); } finally { fos.close(); }
                paths.add(rel);
            }
            if (paths.isEmpty()) return "配置下发失败：有效文件为 0";

            // 清单落盘：GameServer 靠它决定「哪些路径只认覆盖层、不回落 assets」——
            // 这是「文件齐全才跑得起来」真正生效的地方；缺了它，门禁会退化成软校验。
            org.json.JSONObject meta = new org.json.JSONObject();
            meta.put("session", session);
            meta.put("paths", new org.json.JSONArray(paths));
            meta.put("at", System.currentTimeMillis());
            java.io.FileOutputStream mf = new java.io.FileOutputStream(new java.io.File(root, "session.json"));
            try {
                mf.write(meta.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            } finally { mf.close(); }

            if (sp != null) sp.edit().putString(OVERLAY_SESSION_KEY, session).apply();
            sOverlayCount = paths.size();
            PageForensics.line("APK", "LaunchGuard：配置下发完成 局号=" + session
                    + (newSession ? "（换局 → 旧覆盖层已清空）" : "（同局 → 覆盖刷新）")
                    + " 文件=" + paths.size() + " 共 " + bo.size() + "B 例：" + paths.get(0));
            return null;
        } catch (Throwable e) {
            PageForensics.line("APK", "LaunchGuard：配置下发异常 "
                    + e.getClass().getSimpleName() + ": " + e.getMessage());
            return "配置下发失败：" + e.getClass().getSimpleName()
                    + (e.getMessage() == null ? "" : ("（" + e.getMessage() + "）"));
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** SHA-256 的小写十六进制串（与 Node 侧 `crypto.createHash('sha256')` 对齐） */
    private static String sha256Hex(byte[] data) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(data);
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Throwable e) {
            return "";
        }
    }

    /** 递归删除（**只用于覆盖层目录**，不碰用户其它数据） */
    private static void deleteRecursively(java.io.File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            java.io.File[] kids = f.listFiles();
            if (kids != null) for (java.io.File k : kids) deleteRecursively(k);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /** 直播端地址（形如 `192.168.31.228:8443`）：局域网发现优先，其次上次记下的；无 → null */
    private String guardExeBase() {
        String pc = sPcSeen;
        if (pc == null && sp != null) pc = sp.getString("pc", null);
        if (pc == null || pc.isEmpty()) return null;
        return pc.startsWith("http") ? pc : ("http://" + pc);
    }

    /** 应急开关：配置页「跳过直播端校验」（默认关） */
    private boolean guardSkipExe() {
        try {
            return "1".equals(getSharedPreferences("cast", MODE_PRIVATE).getString("skipExeCheck", "0"));
        } catch (Throwable e) {
            return false;
        }
    }

    /**
     * 与直播端约定的共享密钥 —— ★ 第十七修：改为**两端固定的常量**。
     *
     * <p>为什么不再可配置：它只能靠人工从 EXE 窗口抄到这里，而本配置页在门禁**之内**
     * （进得去才改得动）⇒ 抄不到 / 抄错 = 两端不一致 = 一律拒绝，而且现场无法自救。
     * 实测 2026-09-20 15:08 正是卡在这一步（留痕 deny why =「HMAC 校验失败（secret 不一致？）」）。
     * 安全性改由「PC 侧白名单 + 局域网隔离」承担（需求方 2026-09-20 选定）。
     *
     * <p>⚠ 必须与 cast-pc/main.js 的 `GUARD_SECRET_DEFAULT` **逐字一致** —— 改一处就要改两处。
     *
     * <p>★ P3（2026-09-20）现状与去向：本方法服务于**头显 → EXE** 方向的请求鉴权
     * （`launch/request` / `config/dump` 的 HMAC）。方案 §4.3 拍板的 A（改用 proof 签名）需要
     * 头显自己也持有一对 `Ka` / `Ka_pub`，白名单语义随之从 `["&lt;dev&gt;"]` 变成 `[{dev, kapub}]` ——
     * 那一步**放在下一轮**（本轮刻意只做「EXE → 头显」方向：头显用 Ks_pub 验 license 与 proof，
     * 即「防假 EXE」那一半，可交付可实测）。所以这里**暂时保持原样**：
     * 本方法返回的仍是固定串，**不是** license 派生的会话密钥。
     */
    private String guardSecret() {
        return GUARD_SECRET_FIXED;
    }

    /** 本机设备号（白名单主键）。用 ANDROID_ID：比 IP 稳（IP 走 DHCP 会漂） */
    private String guardDeviceId() {
        try {
            SharedPreferences p = getSharedPreferences("cast", MODE_PRIVATE);
            String v = p.getString("deviceId", null);
            if (v != null && !v.isEmpty()) return v;
            String id = android.provider.Settings.Secure.getString(
                    getContentResolver(), android.provider.Settings.Secure.ANDROID_ID);
            if (id == null || id.isEmpty()) id = "unknown-device";
            p.edit().putString("deviceId", id).apply();
            return id;
        } catch (Throwable e) {
            return "unknown-device";
        }
    }

    /** HMAC-SHA256(secret, msg) 的小写十六进制串（与 cast-pc 的 crypto.createHmac 对齐） */
    private String guardHmac(String msg) {
        try {
            javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
            byte[] key = guardSecret().getBytes(java.nio.charset.StandardCharsets.UTF_8);
            mac.init(new javax.crypto.spec.SecretKeySpec(key, "HmacSHA256"));
            byte[] dig = mac.doFinal(msg.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : dig) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Throwable e) {
            PageForensics.line("APK", "LaunchGuard：HMAC 计算失败 " + e);
            return "";
        }
    }

    // ───────────── ★ P3（2026-09-20）：直播端授权校验（license + proof）─────────────
    /**
     * 本次要用的随机数（16 字节 → 32 位小写 hex），交给直播端去签 proof。
     *
     * <p>为什么必须**当场随机**、不能用固定值：{@code proof = Ke_sign("cast|<nonce>")}，
     * nonce 由头显当场给、直播端当场签 ⇒ 那串 proof **只对这一次有效**。
     * 若用固定 nonce，「录下一次响应、之后无限重放」就成立了（而 license 本身是长期凭据，是可以被拷走的）。
     *
     * <p>用 hex 而不是原始字节：EXE 侧 {@code handleLicenseCurrent} 会把 nonce 里的非 hex 字符清掉
     * （防注入），32 位 hex 全字符合法 ⇒ 回显必然逐字节一致，不会出现「被清洗过所以对不上」的假失败。
     */
    private String guardNonce() {
        byte[] b = new byte[16];
        new java.security.SecureRandom().nextBytes(b);
        StringBuilder sb = new StringBuilder(32);
        for (byte x : b) {
            sb.append(String.format("%02x", x & 0xff));
        }
        return sb.toString();
    }

    /** 取一次 {@code /api/license/current} 的结果：{@code code} = HTTP 状态码（&lt;=0 = 连不上 / 超时） */
    private static final class LicenseFetch {
        final int code;
        final String body;
        LicenseFetch(int code, String body) { this.code = code; this.body = body; }
    }

    /**
     * {@code GET /api/license/current?nonce=<hex>} —— **无鉴权**，对端公开出示 license + proof。
     *
     * <p>无鉴权是设计如此：license 本来就是「给人看」的凭据（像身份证），安全性不来自保密，
     * 而来自「签名不可伪造（Ks）+ proof 不可复制（Ke 绑 nonce）」。
     *
     * <p>⚠ 本方法会做网络 IO，**只能在后台线程调用**（当前唯一调用点 licenseCheck 在 guardWaitLoop 线里）。
     * 永不返回 null。
     */
    private LicenseFetch fetchExeLicense(String base, String nonce) {
        HttpURLConnection conn = null;
        try {
            String url = base + "/api/license/current?nonce="
                    + java.net.URLEncoder.encode(nonce, "UTF-8");
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout((int) LICENSE_FETCH_TIMEOUT_MS);
            conn.setReadTimeout((int) LICENSE_FETCH_TIMEOUT_MS);
            conn.setRequestMethod("GET");
            int code = conn.getResponseCode();
            InputStream in = (code >= 400) ? conn.getErrorStream() : conn.getInputStream();
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            if (in != null) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0) {
                    bo.write(buf, 0, n);
                    if (bo.size() > LICENSE_MAX_BYTES) {
                        in.close();
                        return new LicenseFetch(code, "");
                    }
                }
                in.close();
            }
            return new LicenseFetch(code,
                    new String(bo.toByteArray(), java.nio.charset.StandardCharsets.UTF_8));
        } catch (Throwable e) {
            PageForensics.line("APK", "LicenseGuard：取授权信息失败 " + base + " → "
                    + e.getClass().getSimpleName() + ": " + e.getMessage());
            return new LicenseFetch(-1, null);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * ★ P3 主入口：向直播端要 license + proof，并用内置 Ks_pub 校验（判定细节见 {@link LicenseVerify}）。
     *
     * <p>调用点：{@link #guardWaitLoop} 里「已确认是本机直播端**且已放行**」之后、拉配置之前。
     * 排在这个位置是刻意的：既让 license 成为「继续拉配置的**必要条件**」（拿不到授权 → 配置下不来 →
     * 游戏起不来），又**一根手指都不动**既有的四态分类（地址定性 / 旧版 EXE / 连不上），
     * 不会把硬约束 61 那个坑踩回去。
     *
     * @return 结论。{@code retry()} 为真 ⇒ 调用方应留在循环里继续等，**绝不当成拒绝**
     */
    private LicenseVerify.Verdict licenseCheck(String base) {
        String nonce;
        try {
            nonce = guardNonce();
        } catch (Throwable e) {
            return new LicenseVerify.Verdict(LicenseVerify.KIND_DENY,
                    "本机无法生成随机数（" + e.getClass().getSimpleName() + "）");
        }
        LicenseFetch f = fetchExeLicense(base, nonce);
        if (f.code <= 0) {
            // 同一地址刚刚才回过 allow:true，这里却连不上 ⇒ 当抖动，交给调用方重试
            return new LicenseVerify.Verdict(LicenseVerify.KIND_RETRY, "取授权信息没连上");
        }
        if (f.code == 404) {
            // ★ 与「连不上」必须分开：这是**确定的结论**，且处置完全不同（换 EXE，不是等）。
            //   旧版接收端 EXE 没有 /api/license/current；兜底 0 天后它也不能再放行，
            //   所以这里报「版本过旧」而不是「未授权」—— 现场一次就能知道该做什么。
            return new LicenseVerify.Verdict(LicenseVerify.KIND_ABSENT,
                    "直播端是旧版本（没有 /api/license/current 授权接口）→ 必须更新电脑上的接收端 EXE");
        }
        if (f.code != 200) {
            return new LicenseVerify.Verdict(LicenseVerify.KIND_RETRY, "取授权信息失败：HTTP " + f.code);
        }
        LicenseVerify.Verdict v = LicenseVerify.evaluate(f.body, nonce, LICENSE_PUBKEY_B64,
                System.currentTimeMillis(), LICENSE_SKEW_MS);
        PageForensics.line("APK", "LicenseGuard：校验结论 kind=" + v.kind + "（0=OK 1=DENY 2=旧版 3=重试）"
                + " why=" + v.why);
        return v;
    }

    /** 从直播端响应 JSON 里抠 `"why"` 字段（只为留痕/提示可读） */
    private static String guardWhyOf(String json) {
        if (json == null) return "";
        try {
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("\"why\"\\s*:\\s*\"([^\"]*)\"").matcher(json);
            return m.find() ? m.group(1) : json.trim();
        } catch (Throwable e) {
            return json.trim();
        }
    }

    /** 供 GameServer 的 `/api/guard` 读取（页面门禁据此决定按钮给不给） */
    public static boolean guardOk() { return sGuardOk; }
    public static String guardWhy() {
        return (sGuardWhy == null) ? "" : sGuardWhy.replace("\"", "'");
    }
    public static long guardAgeMs() {
        return (sGuardAt == 0L) ? -1L : (System.currentTimeMillis() - sGuardAt);
    }

    /**
     * ★ 第十七修：最近一次成功下发的配置文件数。页面 `/api/guard` 会带上它 ——
     * 现场排障时「配置真的下来了几个文件」比任何推断都直接（0 = 没下发成功）。
     */
    public static long guardOverlayCount() {
        return sOverlayCount;
    }

    /** 门禁结论落定：写缓存 + 留痕（页面 `/api/guard` 读的就是这三个静态字段） */
    private void guardStore(boolean ok, String why) {
        sGuardOk = ok;
        sGuardAt = System.currentTimeMillis();
        sGuardWhy = why;
        PageForensics.line("APK", "guard-result{ok:" + ok + ", why:\"" + why + "\"}");
    }

    /** 被拒：黑底提示页 + autoCloseMs 后退出（不拉浏览器） */
    private void guardDeny(String title, String hint, long autoCloseMs) {
        PageForensics.line("APK", "guard-deny{\"" + title + "\"} → " + autoCloseMs + "ms 后退出，不拉起浏览器");
        showGuardNotice(title, hint, autoCloseMs);
    }

    /**
     * 极简全屏提示页（黑底 + 一行大字 + 可选小字），不依赖任何布局资源。
     * ⚠ 只能在**非免打扰**路径调用（NoDisplay 主题下 setContentView 会抛异常）。
     */
    private void showGuardNotice(String title, String hint, final long autoCloseMs) {
        try {
            android.widget.LinearLayout box = new android.widget.LinearLayout(this);
            box.setOrientation(android.widget.LinearLayout.VERTICAL);
            box.setBackgroundColor(0xFF000000);
            box.setGravity(android.view.Gravity.CENTER);
            TextView t1 = new TextView(this);
            t1.setText(title);
            t1.setTextColor(0xFFFFFFFF);
            t1.setTextSize(22f);
            t1.setGravity(android.view.Gravity.CENTER);
            box.addView(t1);
            guardT1 = t1;          // ★ 第十六修：留给 setGuardNoticeText 滚动刷新（等待 EXE 时用）
            if (hint != null && !hint.isEmpty()) {
                TextView t2 = new TextView(this);
                t2.setText(hint);
                t2.setTextColor(0xFF8A8A94);
                t2.setTextSize(14f);
                t2.setGravity(android.view.Gravity.CENTER);
                t2.setPadding(0, 24, 0, 0);
                box.addView(t2);
                guardT2 = t2;
            }
            setContentView(box);
            if (autoCloseMs > 0) {
                new Handler(getMainLooper()).postDelayed(() -> finish(), autoCloseMs);
            }
        } catch (Throwable e) {
            PageForensics.line("APK", "guard 提示页构建失败（" + e.getClass().getSimpleName() + "）→ 直接退出");
            finish();
        }
    }

    /**
     * ★ 第十六修：等待页文案滚动更新（后台线程调用 → 切主线程）。
     *
     * <p>为什么需要它：等待 EXE 上线可能要十几秒，页面一动不动会让人以为「卡死了」。
     * 每秒刷一次「已等 N 秒 / 最多 20 秒」+ 当前卡在哪一步，玩家/操作员能一眼看出程序还活着。
     * 页面已销毁（被拒绝文案替换 / Activity 结束）时静默忽略。
     */
    private void setGuardNoticeText(final String title, final String hint) {
        runOnUiThread(() -> {
            try {
                if (guardT1 != null && title != null) guardT1.setText(title);
                if (guardT2 != null && hint != null) guardT2.setText(hint);
            } catch (Throwable ignore) { /* 页面已销毁 */ }
        });
    }

    /**
     * 局域网发现回调：仅当平台未直推 PC 地址时才采用（平台 -d 优先级更高，见 applyIntentPc）。
     */
    private void onPcFound(String pc) {
        if (platformPc != null) return;   // 平台已直推 PC 地址，优先用平台的，忽略局域网发现
        setPc(pc);
    }

    /**
     * 仅建立 UDP 控制桥（VRPlusLink）。
     *
     * 【候选平台地址（2026-09-16 由真实游戏日志钉死）】真实游戏是从**平台经 copyfile 下发的
     * setup.xml** 里读平台地址的（`SettingManager:LoadSetup()` → `===GetPlatformIP======<ip>`），
     * 而不是命令行参数。平台给我们 Android 端的 `-d` 未必等于平台机地址（它还兼作推流 PC 地址），
     * 所以这里把 `-d` IP 与 setup.xml 的 platformIP **并列当候选**：持续向所有候选发 0x01，
     * 谁回包谁被锁定为平台（见 VRPlusLink.recvLoop）。比猜单个地址稳。
     *
     * 与「直播推流 PC」是两回事：绝不把平台地址写进游戏 URL 或当成静态资源代理目标
     * （否则游戏去拉一个不存在的服务器 → 卡死）。
     */
    private void setControlHost(String ip) {
        if (ip == null || ip.isEmpty()) return;
        String setupIp = readSetupPlatformIp();     // setup.xml 里的 <Platform platformIP="...">
        // 进程级单例：桥接建好就不再重建（重建会掐断正在工作的 socket 与 51124 监听），
        // 新地址只做「追加候选」——候选越多越不容易因为 -d 给错地址而全盘失联。
        if (sVRPlusLink != null) {
            vrPlusLink = sVRPlusLink;
            server.setVRPlus(vrPlusLink);
            boolean a1 = sVRPlusLink.offerHost(ip);
            boolean a2 = (setupIp != null) && sVRPlusLink.offerHost(setupIp);
            android.util.Log.i("CastMain", "复用已在运行的 VR+ 控制桥接；候选 " + ip
                    + (a1 ? "(新增)" : "") + (setupIp != null ? " + setup.xml:" + setupIp + (a2 ? "(新增)" : "") : "")
                    + "，已连接=" + sVRPlusLink.isConnected());
            return;
        }
        if (vrPlusLink == null) {
            vrPlusLink = new VRPlusLink(ip);
            if (setupIp != null) vrPlusLink.offerHost(setupIp);
            vrPlusLink.start();
            server.setVRPlus(vrPlusLink);
            sVRPlusLink = vrPlusLink;
            android.util.Log.i("CastMain", "VR+ 控制桥接启动，候选平台 " + ip
                    + (setupIp != null ? " + setup.xml:" + setupIp : "") + "，端口 51234");
        }
    }

    /**
     * 读 setup.xml 里的 `<Platform platformIP=".." receivePort="51124" sendPort="51234"/>`。
     * 该文件由平台在启动游戏前经 `copyfile` 下发到本 App 的外部私有目录
     * （/storage/emulated/0/Android/data/<pkg>/files/setup.xml）。
     * 返回 null = 文件不存在 / 还没下发 / platformIP 为空（此时继续用 -d 直推地址）。
     */
    private String readSetupPlatformIp() {
        try {
            java.io.File ext = getExternalFilesDir(null);
            if (ext == null) return null;
            java.io.File f = new java.io.File(ext, PLATFORM_SETUP_FILE);
            if (!f.exists() || f.length() == 0) return null;
            byte[] buf = new byte[(int) Math.min(f.length(), 8192)];
            try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
                int n = in.read(buf);
                if (n <= 0) return null;
                String s = new String(buf, 0, n, java.nio.charset.StandardCharsets.UTF_8);
                java.util.regex.Matcher m = java.util.regex.Pattern
                        .compile("platformIP\\s*=\\s*\"([^\"]+)\"").matcher(s);
                if (m.find()) {
                    String v = m.group(1).trim();
                    if (!v.isEmpty() && !"0.0.0.0".equals(v)) return v;
                }
            }
        } catch (Throwable e) {
            android.util.Log.w("CastMain", "解析 setup.xml 失败: " + e.getClass().getSimpleName() + "/" + e.getMessage());
        }
        return null;
    }

    /**
     * 设置「直播推流 PC」地址（仅用户自有 cast-pc：局域网发现 / 手动输入 走此路径）。
     * 把地址交给本地 GameServer 的信令代理与静态资源代理，并拉起带 &pc= 的浏览器。
     * 注意：平台 -d 直推地址默认不在此处理（见 setControlHost / STREAM_TO_PLATFORM_PC）。
     */
    private void setPc(String pc) {
        if (pc == null || pc.isEmpty()) return;
        // ★ 第十五修：门禁还没放行时**只记地址**，绝不建界面、绝不拉起浏览器 ——
        //   否则「发现直播端 → 直接 maybeLaunch」会绕过 LaunchGuard（信标每 2s 一次，极易抢先）。
        sPcSeen = pc;
        if (sp != null) sp.edit().putString("pc", pc).apply();   // 持久化，供下次门禁直接单播探测
        if (!sGuardPassed) {
            PageForensics.line("APK", "发现直播端 " + pc
                    + "（门禁尚未放行）→ 只记录地址备用，不建界面、不拉起浏览器");
            return;
        }
        // ★ 第十修：一旦配置了用户自有直播 PC（= 游戏页 URL 带 ?cast=1，浏览器是推流源），
        //   「本局结束后关浏览器」就必须停手 —— 关了 = 直播中断。见 restoreClientAndCloseBrowser。
        sPcConfigured = true;
        if (pc.equals(currentPc)) return;
        currentPc = pc;
        sp.edit().putString("pc", pc).apply();
        server.setPcBase("http://" + pc);
        tvStatus.setText("已连接 PC 接收端 " + pc + "：PC 端将显示直播画面");
        manualPanel.setVisibility(View.GONE);
        // PC 已就位 → 立刻拉起 PICO 浏览器（URL 带 ?pc= 让信令直连 PC）。全程只打开一个网页。
        maybeLaunch();
    }

    /**
     * 解析平台启动 intent：am start -n <pkg>/.MainActivity -d <PC_IP> 中的 -d 即 PC 直播端 IP。
     * 平台通过此方式直推地址，比局域网 UDP 组播发现更可靠（平台网络下组播可能不可达）。
     * 仅取 IP 部分；端口按 cast-pc 约定补 8443（与手动输入 192.168.31.228:8443 一致）。
     */
    private void applyIntentPc(Intent intent) {
        if (intent == null) return;
        String raw = null;
        if (intent.getDataString() != null) raw = intent.getDataString();
        if (raw == null && intent.getData() != null) raw = intent.getData().toString();
        if (raw == null || raw.isEmpty()) raw = intent.getStringExtra("pc");
        if (raw == null || raw.isEmpty()) raw = intent.getStringExtra("data");
        if (raw == null || raw.isEmpty()) return;
        java.util.regex.Pattern p = java.util.regex.Pattern.compile("(\\d{1,3}\\.){3}\\d{1,3}(:\\d+)?");
        java.util.regex.Matcher m = p.matcher(raw);
        if (m.find()) {
            String hit = m.group();
            if (!hit.contains(":")) hit = hit + ":8443";   // 平台只给 IP，补默认推流端口
            platformPc = hit;
            android.util.Log.i("CastMain", "平台下发 PC 地址: " + platformPc);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        platformFallback = null;   // 判据按本次 intent 重算（缓存只为「super.onCreate 之前那一次」服务）
        passThrough = null;
        applyIntentPc(intent);
        android.util.Log.i("CastMain", "onNewIntent data=" + (intent != null ? intent.getDataString() : "null")
                + " platformPc=" + platformPc + " autoLaunched=" + autoLaunched + " serverReady=" + serverReady);
        // 平台「重复拉起」（castlog3.txt 实测约 20s 一次，共 4 次）。
        // 这里**不再直接 maybeLaunch + 重开浏览器**（那会把正在跑的游戏页重载掉）；
        // 统一交给 maybeLaunch 判定：游戏页存活 → 只退后台 + 补报 cmd3；失联 → 才重新拉起。
        // 平台驱动标记（onNewIntent 也要更新：首拉可能没带 -d，后用 -d 重拉）
        String d = (intent != null) ? intent.getDataString() : null;
        platformDriven = computePlatformDriven(intent, d);   // 同 onCreate：不能再只看 -d（实测平台不带）
        if (!platformDriven && platformRelaunchFallback()) platformDriven = true;   // 五修：会话级兜底（同 onCreate）
        probePlatformDir();     // 每次重拉都看一眼 setup.xml 是否已下发（见方法注释）
        PageForensics.line("APK", "onNewIntent 平台驱动=" + platformDriven + " data=" + d
                + " action=" + (intent != null ? intent.getAction() : null)
                + " cats=" + (intent != null ? intent.getCategories() : null)
                + " ref=" + referrerStr());
        rememberClientPkgFromReferrer(referrerStr());   // ★ 第十修：持续确认「平台客户端是谁」
        if (platformPc != null) {
            setControlHost(platformPc.split(":")[0]);
        } else if (platformDriven) {
            String sip = readSetupPlatformIp();
            if (sip != null) setControlHost(sip);       // 平台不带 -d 时的兜底（同 onCreate）
        }
        maybeLaunch();
    }

    private void startCast() {
        String pc = etPc.getText().toString().trim();
        if (pc.isEmpty()) {
            etPc.setError("必填：PC 接收端地址（形如 192.168.31.228:8443）");
            return;
        }
        setPc(pc);
        if (webView != null) {
            webView.setVisibility(View.VISIBLE);
            if (probeMode) webView.evaluateJavascript(XR_CHECK_JS, null);
        }
    }

    /** 从 "http://192.168.31.228:8443" 摘出 "192.168.31.228:8443"（= setPc 的入参口径）。 */
    private static String hostPortOf(String base) {
        if (base == null) return null;
        final String s = base.trim().replaceFirst("^[Hh][Tt][Tt][Pp][Ss]?://", "").trim();
        return s.isEmpty() ? null : s;
    }

    /**
     * ★ 2026-09-20 修：把「门禁刚核实过的那台直播端」登记为本局推流目标。
     *
     * <h3>为什么必须补这一刀（现场留痕实证 2026-09-20 22:00）</h3>
     * 推流地址由 {@link #getCastUrl()} 决定，而它此前只看内存里的 {@code currentPc}；
     * {@code currentPc} 全项目只有一条赋值路径 ——「收到 UDP 信标 → {@link #setPc} →
     * 且 {@code sGuardPassed} 已为 true」。于是信标不到时（实测那一局：门禁 15.513s 放行、
     * 24.981s 才拉起，中间 9.4 秒 ≈ 5 个信标周期一个都没收到）：门禁靠
     * **上次留存的地址**完成了放行 + 授权校验 + 配置下发，游戏照常起来，但
     * {@code currentPc} 始终为 null ⇒ 拉起地址 = {@code http://localhost:8080/?plat=1}
     * ⇒ 页面根本不推流 ⇒ 直播端一片空白（用户报的「直播画面没有显示了」）。
     *
     * <p>而门禁手里的地址恰恰**已被证明可用**：刚用它要到了放行条、license 与整包配置。
     * 所以「门禁核实过的地址」应当直接成为推流目标，与信标是否到达解耦。
     *
     * <p>放在 {@link #initGameUi()} 末尾而不是门禁回调里：{@link #setPc} 会写
     * {@code tvStatus} / {@code manualPanel}，这两个控件由 initGameUi 内部 findViewById 建立，
     * 早于那时调用会 NPE。
     */
    private void adoptGuardPc() {
        try {
            final String pc = sGuardVerifiedPc;
            if (pc == null || pc.isEmpty()) return;   // 应急开关跳过 EXE 校验 / 从未核实过 → 保持纯本地
            if (pc.equals(currentPc)) return;
            PageForensics.line("APK", "推流目标登记 " + pc + "（来自门禁核实，不依赖信标）");
            setPc(pc);      // 门禁已放行 ⇒ setPc 会走完：currentPc / sPcConfigured / server.setPcBase
        } catch (Throwable e) {
            PageForensics.line("APK", "推流目标登记失败：" + e.getClass().getSimpleName()
                    + " " + e.getMessage());
        }
    }

    /**
     * 用 PICO 浏览器拉起游戏进入 VR。地址由 getCastUrl 返回：
     *   - 平台启动且从未核实到直播端 → 纯本地 http://localhost:8080/，直接进游戏、零推流开销；
     *   - 已定下直播端（信标发现 或 门禁核实，见 adoptGuardPc）→ 带 ?cast=1&pc=…&mode=webrtc 推流。
     * localhost 是 WebXR 安全上下文，确保「进入 VR」按钮可见。只拉起一次（autoLaunched 守卫）。
     */
    private void maybeLaunch() {
        // ★ 第十五修：门禁未放行就不许拉起浏览器（拒绝路径上 onResume 仍会调用本方法）。
        if (!sGuardPassed) { skipLaunch("LaunchGuard 未放行（本次启动已被拒绝）"); return; }
        if (inAppPlaying) { skipLaunch("应用内 WebView 正在跑游戏（inAppPlaying）"); return; }
        if (!serverReady) { skipLaunch("本地 8080 尚未就绪（留给看门狗，避免 localhost 拒绝）"); return; }
        // ★ 2026-09-19 三修：**不再因为 !resumed 直接放弃**。
        //   留痕实测（15:38:20 那次平台拉起）：平台 `am start` 建出的 Activity 在 PICO 上**未必**
        //   进入 resumed —— XRShell 把每个 Activity 当作 2D 面板渲染，此时浏览器在前台、本页只是
        //   「有窗口」。旧代码在这里静默 return：那次「平台启动」什么都没发生（留痕里只有 onCreate、
        //   没有任何后续行），平台等不到 0x01 → 8 秒后重发 start 才成功。
        //   这正是「再次启动没有网页弹出」的形态之一：不是没拉起，是**拉起了但什么都没做**。
        //   现在：只有**非平台驱动**（用户手点配置页按钮）才要求 resumed；平台驱动照常尝试 ——
        //   startActivity 在「应用有可见窗口」时即放行（另有 CastService 前台服务保证前台态）。
        if (!resumed && !platformDriven) { skipLaunch("未到前台（resumed=false），等 onResume 再拉"); return; }
        if (!resumed) {
            PageForensics.line("APK", "maybeLaunch：平台驱动但 Activity 未 resumed → 照常尝试拉起（PICO 面板态常见）");
        }
        // 刚重启的进程里 lastPageHitMs==0：分不清「页面已死」还是「页面活着、只是还没轮到下一次轮询(≤1s)」。
        // 先等 1.2s 再判 —— 否则每次 APK 被平台 kill 后重拉，都会白白把页面重载一遍。
        if (platformDriven && !waitedFirstHit && sServer != null && sServer.lastPageHitMs() == 0) {
            waitedFirstHit = true;
            PageForensics.line("APK", "maybeLaunch：本进程尚未收到过页面请求 → 等 1.2s 再判"
                    + "（区分「页面已死」与「活着只是还没轮询」）");
            new android.os.Handler(getMainLooper()).postDelayed(this::maybeLaunch, 1200);
            return;
        }

        // ── 平台「重复拉起」场景（castlog3.txt：19:17:33 / 19:17:52 / 19:18:44 / 19:19:04 四次 am start）──
        // 游戏页仍在请求（6s 内有 /api/vrplus/* 或 /api/page/*）说明它活得好好的：
        //   · **绝不重新 openInPicoBrowser** —— 对同一个 URL 再 startActivity 会让浏览器**重载游戏页**，
        //     游戏当场重来（这就是「第二次会报错」）；玩家已在 VR 里时重载还会丢掉 XR 会话（「闪退」）；
        //   · 补报一次 0x01 —— 平台反复拉起，多半就是没收到这条「客户端已启动游戏」确认；
        //   · ★ 若页面处于「本局已结束」待机态（平台刚关过一局，页面保留未卸载）→ 入队一条**本地 cmd3**
        //     叫它开新局：整页零重载、也无浏览器白页（见 game.js _enterClosedIdle）。
        //     页面正在玩/加载时收到 cmd3 是空操作（页面侧有 state 守卫），故对「+20s 重拉」不影响；
        //   · 退后台让位，把浏览器里的游戏页让回前台。
        if (pageAliveForLaunch()) {
            android.util.Log.i("CastMain", "游戏页仍在运行（age=" + gamePageAgeMs() + "ms state="
                    + pageState() + " 待机=" + pageClosed() + "）→ 不重开浏览器：补报 0x01 + 必要时唤醒 + 退后台");
            PageForensics.line("APK", "maybeLaunch：判定游戏页仍在（age=" + gamePageAgeMs()
                    + "ms state=" + pageState() + " 待机=" + pageClosed() + " 平台驱动=" + platformDriven
                    + "）→ 不重开浏览器（防重载）" + (platformDriven
                        ? "，唤醒待机页 + 让位给浏览器" : "，人工启动 → 保留配置页、不动前台"));
            notifyPlatformGameLaunched();
            // ★ 五修：唤醒 + 让位**只对平台重拉做**。
            //   人工点图标时玩家的意图就是「看配置页」，这时去把浏览器顶前台、还顺手唤醒待机页，
            //   正好把人要看的页面盖掉（上一版就是这么把「人工打开配置页」也搞坏的）。
            if (platformDriven) {
                reviveClosedPage();
                // ★ 四修：这条分支过去只「退后台」，结果玩家什么都看不到（实测：第 2、3 次启动
                //   「没有网页弹出来」）。它防重载是对的，但**必须补上「把浏览器顶回前台」** ——
                //   否则平台那句「开始」对玩家而言等于没发生。见 yieldToBrowser()。
                yieldToBrowser("页面仍在，不重开浏览器（防重载）");
            }
            return;
        }
        // 刚拉起过、页面还没来得及发第一条请求 → 别急着重开（重开 = 重新导航 = 历史踩坑）
        if (System.currentTimeMillis() - launchStartedAt < 6000) {
            skipLaunch("刚拉起 " + (System.currentTimeMillis() - launchStartedAt)
                    + "ms，页面尚未发过请求 → 先等（重开会重新导航）");
            return;
        }
        // 已启动但游戏页已失联（浏览器被关 / 页面崩溃 / 被 platform kill 掐断）→ 允许重新拉起。
        // 注：sLaunched 与 autoLaunched 始终同生同灭（见 markLaunchSucceeded），所以这里一并清掉后
        //     无需再单独判 autoLaunched。
        boolean hadPage = sLaunched || gamePageAgeMs() >= 0;   // 区分「本进程首次拉起」与「页面真的没了」
        android.util.Log.i("CastMain", "游戏页已失联（age=" + gamePageAgeMs()
                + "ms）→ 允许重新拉起浏览器");
        PageForensics.line("APK", (hadPage
                ? ("maybeLaunch：判定游戏页已失联（age=" + gamePageAgeMs() + "ms sLaunched=" + sLaunched
                   + " 拉起次数=" + launchAttempts + "）")
                : "maybeLaunch：本进程尚无页面（首次拉起）")
                + "→ 允许拉起浏览器（会打开/重载游戏页）");
        sLaunched = false;
        autoLaunched = false;
        launchAttempts = 0;
        sLaunchedAt = 0;    // 一并清掉「刚拉起 15s 宽限期」，否则 isGamePageAlive() 会一直算活
        launchBrowserNow();
    }

    /**
     * 真正执行一次「打开游戏页」：防抖 → 清毒 → 拉起 → 2s 后自检。
     * 两个入口共用（第十一修提取）：
     *   ① `maybeLaunch` 判定「页面已失联 / 本进程首次拉起」；
     *   ② 唤醒待机页 3 次都没人取（页面疑似被冻结 / 已成幽灵页）时的**兜底重载**。
     */
    private void launchBrowserNow() {
        long now = System.currentTimeMillis();
        if (now - lastLaunchAt < 1200) {                // 防抖：1.2s 内不重复尝试
            skipLaunch("距上次拉起 " + (now - lastLaunchAt) + "ms（<1200ms 防抖）");
            return;
        }
        lastLaunchAt = now;
        launchAttempts++;
        // ★ 新会话：开新页之前，丢掉上一会话残留的平台下行指令（尤其是 closeGame 的 cmd=16）。
        //   根因（2026-09-17 定位）：VRPlusLink.downlink 是**进程级**队列且跨会话存活，而平台每局
        //   结束都会给头显发一条 `0x10 closeGame`（实测与 kill 同毫秒并发）。若那一刻游戏页正在
        //   加载 / 已被卸载 / APK 正被 force-stop，就没人 drain → 这条 cmd=16 一直躺在队列里。
        //   下一局页面一打开，首轮 inbox 轮询（1s 内）就会拿到它并直接自杀 = 玩家看到的
        //   「打开预览界面 1 秒闪退」，且**换 PC 端 exe 完全无效**（毒在 APK 内存里）。
        //   这里只在「真要开一个新页面」的路径上清 —— 页面还活着时绝不清，否则会吞掉真实关闭指令。
        if (sVRPlusLink != null) sVRPlusLink.clearStaleClose("即将打开新的游戏页（新会话）");
        // ★ 第十三修：**删掉**第十二修在这里注入的「平台已开始本局」（本地 cmd3 + plat:true）。
        //   为什么删（留痕 page-forensics (4).log 21:28:05.603 入队 → 21:28:08.800 页面据此开禁）：
        //   它发生在**拉起时刻**，于是「进入 VR」按钮门禁形同虚设 —— 平台一启动游戏、按钮当场就在
        //   （玩家的原话：「启动游戏时，进入 VR 的按钮还在…理论上应该等平台点开始游戏才出现」）。
        //   平台那句「开始游戏」在本架构里唯一的可观测形态是**平台自己下发的指令**（游戏通道
        //   cmd3/4，由 VRPlusLink 透传给页面）；APK 不再替平台说话。
        //   ⚠ 页面侧同步不再把机位表当开局信号（见 src/game/game.js 的 cmd=0 分支）。
        //   ⚠ 紧急出口：配置页勾「直接显示「进入 VR」按钮（不等平台）」= 网址带 ?vrbtn=1 = 旁路门禁。
        if (platformDriven) {
            PageForensics.line("APK", "平台驱动本次拉起：第十三修起**不再**注入「平台已开始本局」cmd3"
                    + "（那是 APK 替平台说话，机位表回执那版已证伪）；第十四修改为在 URL 带 `?plat=1`"
                    + "—— 语义 = 「本页是平台/APK 拉起的」⇒ 页面直接开门禁（按钮随预览界面出现）");
        }
        if (openInPicoBrowser()) {
            // 不立刻 moveTaskToBack：startActivity 是异步的，无法同步得知成功与否。
            // 改为 2s 后自检——若届时我们已退到后台，说明浏览器真的接管了；否则重试。
            android.util.Log.i("CastMain", "第 " + launchAttempts + " 次拉起 PICO 浏览器 URL=" + getCastUrl());
            // 留痕：起页面是「可能把正在加载的页面重载掉」的高危动作，每次都记 ——
            // 若留痕里出现两次以上的「拉起浏览器」，且第二次紧跟页面死掉，就是重载害的。
            PageForensics.line("APK", "第 " + launchAttempts + " 次拉起浏览器 URL=" + getCastUrl());
            launchStartedAt = System.currentTimeMillis();   // 自检基准：只看「这次之后」页面有没有发请求
            new android.os.Handler(getMainLooper()).postDelayed(this::verifyLaunch, 2000);
        } else {
            android.util.Log.w("CastMain", "浏览器拉起失败，1.2s 后重试 URL=" + getCastUrl());
            new android.os.Handler(getMainLooper()).postDelayed(this::maybeLaunch, 1200);
        }
    }

    /** 本轮「平台等待首条页面请求」的宽限是否已用掉（避免反复等待） */
    private boolean waitedFirstHit = false;

    /**
     * 页面「确实在请求」判据（用于决定**是否重开浏览器**）：最近 6s 内有过 /api/vrplus/* 或 /api/page/* 请求。
     *
     * ⚠ 刻意**不套** isGamePageAlive() 的 15s 加载宽限期：那个宽限是给「刚拉起、页面还在加载」用的，
     *   而在「平台重新启动本局」这条路径上，它会把「页面其实已经没了」误判成活着 →
     *   于是只退后台、不重开浏览器 → 玩家看到的正是「再次启动什么都没弹出来」。
     */
    private boolean pageAliveForLaunch() {
        if (sServer == null) return false;
        long age = gamePageAgeMs();
        // ① 页面还在轮询（6s 内有过请求）→ 铁定活着
        if (age >= 0 && age < 6000) return true;
        // ② 「本局已结束」待机页（?cs=1）→ 也当活着（四修新增）。
        //    为什么它可能「不再轮询」还活着：浏览器 panel 一旦被别的应用盖住，Chromium 会**冻结
        //    后台标签**（留痕里 `pagehide persisted=true` 正是被冻结的证据）→ 页面的 setInterval 停摆
        //    → age 无限增长 → 被①误判成「页面已死」→ 重开浏览器 = **整页重载** = 玩家看到的
        //    「网页又从头来一遍」。待机页是我们**刻意保留**的（见 game.js _enterClosedIdle），
        //    正是最不该重载的那一种，所以给它一个明确的「仍然活着」判据。
        //    上限 IDLE_TRUST_MS 只是保险丝：超过它仍无任何请求，就不再无条件相信（交给重开兜底）。
        if (pageClosed() && sLaunchedAt > 0
                && System.currentTimeMillis() - sLaunchedAt < IDLE_TRUST_MS) {
            PageForensics.line("APK", "pageAliveForLaunch：待机页 age=" + age
                    + "ms 但 cs=1 → 视为「活着但被冻结」，不重开浏览器（防整页重载）");
            return true;
        }
        return false;
    }

    /** 待机页最多被无条件信任多久（保险丝，防「页面真没了」时永远不重开） */
    private static final long IDLE_TRUST_MS = 10 * 60 * 1000L;

    /** 页面最近一次上报的游戏状态（每秒轮询带上来的 ?st=），未知返回 "?" */
    private String pageState() {
        return (sServer != null) ? sServer.lastPageState() : "?";
    }

    /** 页面是否处于「本局已结束」待机态（?cs=1：平台关闭后页面保留未卸载） */
    private boolean pageClosed() {
        return sServer != null && sServer.lastPageClosed();
    }

    /** 记录一次「没有拉起浏览器」的早退原因 —— 这类静默早退正是前几轮排查最大的黑洞。 */
    private void skipLaunch(String why) {
        android.util.Log.i("CastMain", "maybeLaunch 跳过：" + why);
        PageForensics.line("APK", "maybeLaunch 跳过：" + why);
    }

    /**
     * 唤醒「已收工但还活着」的游戏页（2026-09-19 新增）。
     *
     * 背景：平台关闭本局后，页面**不再** replace('about:blank')（那会留下浏览器白页，且下一局必须整页重载），
     * 而是留在原地进「待机态」并继续轮询（见 game.js _enterClosedIdle）。代价是：平台下一次
     * `am start` 时，APK 会看到「页面活着」→ 按老逻辑只退后台、不重开浏览器 —— 于是平台那句
     * 「开始」对游戏其实什么都没发生（玩家看到待机页一直挂着）。
     *
     * 解法：往页面下行队列入队一条**本地 cmd3**（旧协议的「启动游戏」），页面收到即撤盖回到菜单。
     *   ⚠ **五修改语义**：从「撤盖 + start(0) 开新局」改为「只撤盖回菜单，不代玩家开局」。
     *   旧语义实测后果（留痕 17:40:11 那一轮）：玩家还没进 VR（XR=off）页面就播完开场影片、
     *   自动进了第 1 关 —— 与「第一次启动停在菜单等玩家点开始」完全不一致。
     *   平台那句「开始」在本架构里的正确含义就是「把游戏页拉起来到菜单」，开局必须由玩家手势触发。
     * 只在「页面确实处于待机态」时入队，避免对无关场景动手（正在玩时页面侧也有 state 守卫）。
     */
    private void reviveClosedPage() {
        if (!pageClosed()) { wakeAttempts = 0; return; }
        final VRPlusLink link = (sVRPlusLink != null) ? sVRPlusLink : vrPlusLink;
        if (link == null) {
            PageForensics.line("APK", "唤醒待机页失败：VR+ 桥接尚未建立（页面收不到 cmd3）");
            return;
        }
        wakeAttempts++;
        link.enqueueLocal(3, "平台重新启动本局：唤醒待机中的游戏页（零重载，第 " + wakeAttempts + " 次）", true);
        PageForensics.line("APK", "已唤醒待机页：本地 cmd3 已入队（第 " + wakeAttempts
                + " 次；页面 1s 内撤盖回到菜单，等玩家点「进入 VR」）");
        // ── 复核重发（五修）──
        // 为什么需要：入队 ≠ 页面取走。页面的 inbox 轮询是 setInterval(1s)，而 PICO/Chromium 会
        // **冻结被盖住的后台标签**（留痕实测：17:38:23 之后页面 21 秒零请求）——那些轮询根本没跑，
        // 于是「唤醒」躺在队列里没人取，玩家看到待机封盖一直挂着（=「启动没反应」）。
        // 判据：页面取走唤醒后 `_closedIdle` 立刻为 false，下一轮轮询就会上报 cs=0 → lastPageClosed 转 false。
        // 仍为 true 只可能有两种情况：页面被冻结、或它根本没轮询；两种都该重发（页面侧 handler 幂等）。
        if (wakeAttempts >= 3) {
            // ★ 第十一修：不再「停止重发」了事 —— 那正是玩家看到的「启动一直没反应」。
            //   3 次（≈7.5s）都取不走，只剩两种可能：页面被冻结到连 inbox 都不跑，或它已是
            //   「幽灵页」（留痕 20:25:34：浏览器被系统重启后还原标签，加载到 80% 即被冻结）。
            //   两种都**唤不醒**了 → 兜底整页重载：慢 ~10s，但保证画面上一定有游戏页。
            PageForensics.line("APK", "唤醒复核：已重发 3 次仍未取走（页面疑似被冻结 / 已是幽灵页）"
                    + " → 兜底：强制重开浏览器（整页重载约 10s，保证有画面）");
            wakeAttempts = 0;
            forceRelaunchBrowser("唤醒待机页 3 次无效");
            return;
        }
        new android.os.Handler(getMainLooper()).postDelayed(() -> {
            if (pageClosed()) {
                PageForensics.line("APK", "唤醒复核：2.5s 后页面仍报待机（cs=1）→ 它没取到（疑似被冻结）→ 重发");
                reviveClosedPage();
            } else {
                PageForensics.line("APK", "唤醒复核：页面已退出待机（cs=0）→ 唤醒成功，不再重发");
                wakeAttempts = 0;
            }
        }, 2500);
    }

    /** 本轮待机页唤醒已重发几次（页面冻结导致「入队了但没人取」时用来兜底，最多 3 次） */
    private int wakeAttempts = 0;

    /**
     * 兜底：绕开「页面看着还活着」的所有判定，直接**整页重开**游戏页（第十一修）。
     *
     * 为什么要专门开一个口子：`maybeLaunch` 的整条设计都是「宁可什么都不做，也绝不重载页面」
     * （重载 = 整页重来 + 丢 XR 会话，历史踩坑）。但有一类状态是「看着活着、其实已经死了」：
     * 幽灵页（浏览器被系统重启后还原标签、加载到 80% 被冻结，`cs=0` 且不再打点）、被冻结到
     * 连 inbox 轮询都不跑的待机页。对这两种，唯一有效的动作就是重载 —— 且必须在**平台明确
     * 要求启动**的时刻做（本方法只由 reviveClosedPage 的 3 次失败兜底触发，不会自己冒出来）。
     */
    private void forceRelaunchBrowser(String why) {
        if (inAppPlaying) { skipLaunch("强制重开被拒：应用内 WebView 正在跑游戏（inAppPlaying）"); return; }
        if (!serverReady) { skipLaunch("强制重开被拒：本地 8080 尚未就绪"); return; }
        PageForensics.line("APK", "强制重开浏览器（" + why + "）：网页 age=" + gamePageAgeMs()
                + "ms state=" + pageState() + " 待机=" + pageClosed());
        launchBrowserNow();
    }

    /**
     * 本次「拉起浏览器」的动作时刻（ms）。用于判断**本次拉起之后**游戏页有没有真的发出过请求 ——
     * 这比 `resumed` 可靠得多，原因见 pageRequestedSinceLaunch()。
     */
    private volatile long launchStartedAt = 0;

    /**
     * 上一次**成功拉起游戏页**的那个浏览器包名（如 com.pico.browser，见 BROWSER_PKGS 注释）。
     * 用途：① yieldToBrowser() 要把浏览器顶回前台时，必须用「确实装了、确实能开我们的页面」的那一个，
     *       否则 getLaunchIntentForPackage() 会拿到 null（或顶上来一个不相干的应用）；
     *     ② 第十修起还用于「本局结束后关闭浏览器」——必须关对包，不能关错应用。
     *
     * ⚠ 第十修改为 **static**：走「免打扰」路径时本 Activity 会 finish，下一轮平台拉起是**新实例**，
     *   若仍是实例字段，跨轮次就丢了（浏览器包名丢失 → 关不掉浏览器 / 顶不上前台）。
     */
    private static volatile String lastBrowserPkg = null;

    /**
     * 本次拉起之后，游戏页是否发过请求（= 浏览器真的把页面跑起来了）。
     *
     * 为什么不能只看 `resumed`：PICO 的 XRShell 把每个 Activity 渲染成一个 2D panel，
     * `moveTaskToBack()` 之后 Activity **未必**产生标准 onPause → `resumed` 仍是 true。
     * 留痕实测（2026-09-19）：
     *   `verifyLaunch：2s 后浏览器尚未接管` → `让出前台后仍在配置页 → 再拉第 2 次` →
     *   紧跟 `第 2 次拉起浏览器` → 紧跟**又一条 `page-open`** + `pageshow pct=67`
     * —— 页面被**重新导航**了，而它当时其实跑得好好的。这正是玩家说的
     * 「第一次拉起后闪退，接着游戏网页又自动弹出三四次」。
     */
    private boolean pageRequestedSinceLaunch() {
        if (sServer == null || launchStartedAt <= 0) return false;
        long t = sServer.lastPageHitMs();
        return t > 0 && t >= launchStartedAt;
    }

    /** 「浏览器是否已接管」判据：已退到后台 **或** 本次拉起后页面发过请求 **或** 页面正在请求。 */
    private boolean launchSucceeded() {
        if (!resumed) return true;
        if (pageRequestedSinceLaunch()) return true;
        long age = gamePageAgeMs();
        return age >= 0 && age < 8000;   // ⚠ 这里**不看** isGamePageAlive 的 15s 宽限期（那会误判成功）
    }

    /** 启动成功 → 统一收尾：标记、上报 0x01、让位、平台会话下收起配置页。 */
    private void markLaunchSucceeded(String why) {
        autoLaunched = true;
        sLaunched = true;
        sLaunchedAt = System.currentTimeMillis();
        android.util.Log.i("CastMain", "启动成功（" + why + "）");
        // ★ 五修：收尾前**再刷一次**「平台在场」判据。
        //   平台的 am start 有时不带 `-d` 又带 `CATEGORY_LAUNCHER`（与人工点图标同形），onCreate 那一刻
        //   判不出来；但走到这里时（拉起后 2s）平台通道早已握手完成（机位表 57ms 就回）⇒ 此时能判出来。
        //   不刷的话 platformDriven 会一直是 false → 配置页永不收 ⇒ 它盖住浏览器 → 玩家看到「启动没反应」。
        if (!platformDriven && platformLike()) {
            platformDriven = true;
            PageForensics.line("APK", "启动收尾时刷新判据：平台通道已连 + 无 launcher referrer → 视为平台驱动（要收起配置页）");
        }
        PageForensics.line("APK", "verifyLaunch：启动成功（" + why + "）→ 上报 0x01"
                + (platformDriven ? " + 收起配置页" : "（手动启动：保留配置页）"));
        notifyPlatformGameLaunched();
        // ⚠ 顺序即语义（四修）：先「把浏览器顶到最前」，再收起本页 —— 反过来的话，
        //   收起本页的瞬间前台会落到别的应用上，浏览器那个 panel 就一直在下面（实测 8ms 后
        //   页面就 visibility:hidden）。详见 yieldToBrowser() 注释。
        yieldToBrowser("启动成功（" + why + "）");
    }

    /**
     * 拉起后自检：判断浏览器是否真的接管了前台。
     *   · 判据见 launchSucceeded()（**不再只看 resumed**）；
     *   · 真要重拉时门槛也提到最高：必须「既没退后台、页面又一条请求都没发过」才算浏览器没起来。
     *
     * 【2026-09-16 一修 / 2026-09-19 二修：重试会「重新导航」正在加载的游戏页】
     *   旧实现「2s 后仍在前台就再 openInPicoBrowser()」会让同一 URL **重新导航**；
     *   一修改成「先 moveTaskToBack 让位、再等 1.5s」，但判据仍是 resumed —— 在 PICO 上不可靠，
     *   于是照样二次 startActivity（留痕里有 `page-open` / `pageshow pct=67` 重来的铁证）。
     *   二修把判据换成「页面有没有真的发过请求」，并把重拉门槛提到最高。
     */
    private void verifyLaunch() {
        if (autoLaunched) return;
        if (launchSucceeded()) {
            markLaunchSucceeded(!resumed ? "本页已退后台" : ("游戏页已在请求 age=" + gamePageAgeMs() + "ms"));
            return;
        }
        if (launchAttempts >= 3) {
            android.util.Log.w("CastMain", "重试 " + launchAttempts + " 次后浏览器仍未接管，保留配置页（可手动点启动）");
            PageForensics.line("APK", "verifyLaunch：重试 " + launchAttempts + " 次浏览器仍未接管 → 保留配置页"
                    + "（若浏览器其实起来了，下一步靠平台的 am start 重拉补）");
            return;
        }
        // 第一步：**把浏览器顶到前台**（而不是把自己 moveTaskToBack —— 在 PICO 上那等于把前台
        // 让给别的应用，浏览器反而留在下面，见 yieldToBrowser）。不重新 startActivity、不导航。
        boolean brought = bringBrowserToFront();
        android.util.Log.i("CastMain", "浏览器尚未接管，先把浏览器顶到前台（不重开页面）置前=" + brought);
        PageForensics.line("APK", "verifyLaunch：2s 后尚未接管（resumed=" + resumed
                + " 页面age=" + gamePageAgeMs() + "ms）→ 顶前台让位（置前=" + brought + "，不重开页面）");
        if (!brought) moveTaskToBack(true);
        new android.os.Handler(getMainLooper()).postDelayed(() -> {
            if (autoLaunched) return;
            if (launchSucceeded()) {
                markLaunchSucceeded(!resumed ? "让出前台后本页已退后台"
                        : ("让出前台后游戏页已在请求 age=" + gamePageAgeMs() + "ms"));
                return;
            }
            // 第二步：只有「页面确实一条请求都没发过」才敢再拉 —— 二次 startActivity 到同一 URL
            // 会让浏览器重新导航（页面重载），代价远大于「少拉一次」（后续 onResume / 平台重拉会补）。
            android.util.Log.w("CastMain", "让出前台后仍未接管且页面零请求 → 再拉第 " + (launchAttempts + 1) + " 次");
            PageForensics.line("APK", "verifyLaunch：让出前台后仍未接管且页面零请求（age=" + gamePageAgeMs()
                    + "ms）→ 再拉第 " + (launchAttempts + 1) + " 次");
            maybeLaunch();
        }, 2500);
    }

    // 【已合并】原 finishPlatformActivity()（平台驱动时收掉配置页）于 2026-09-19 四修并入
    // yieldToBrowser() —— 因为「收起自己」必须与「把浏览器顶到前台」是同一个原子动作，
    // 单独收自己正是浏览器被压在后面的原因。收掉它的理由（面板窗口 + TouchBar 会随每次
    // 平台 am start 重新显示、把游戏页/XR 会话压下去；进程由 CastService 保活不会死）
    // 见 yieldToBrowser() 内的注释。

    // ───────────────── 把浏览器顶回前台（2026-09-19 四修）─────────────────
    /**
     * 让位给浏览器：**先把浏览器顶到最前，再收起本页**。
     *
     * <h3>为什么（三个现象其实是同一个根因）</h3>
     * 玩家实测（2026-09-19 17:05 那一轮）：
     *   · 第一次：网页能起来，但**自动回到后台，得点一下浏览器才在最上面**（玩家补了一句「之前也是」）；
     *   · 第二次：要平台再启动一次，才能在后台看到那个网页；
     *   · 第三次：**什么都没弹出来**。
     * 留痕里的对应证据（同一条时间线）：
     *   `17:05:50.169 [APK] 平台驱动启动完成 → finish 配置页`
     *   `17:05:50.177 [PAGE] visibility:hidden`   ← 只差 8ms：页面在「我们收起配置页」的瞬间被盖住
     * 以及第二次平台启动时命中「页面仍在 → 不重开浏览器（防重载）+ 退后台」那条分支 ——
     * **它虽然避免了重载，却谁也没把浏览器顶上来**，所以玩家什么也看不到。
     *
     * 真因：旧实现靠「自己 moveTaskToBack(true) + finish()，指望浏览器自然浮上来」。
     *   在 PICO 的 XRShell 上这个假设不成立 —— 我们把前台让给了**别的**应用（平台启动器），
     *   浏览器那个 panel 就一直在下面。之前几轮只在「要不要重新 startActivity」上打转，
     *   而真正缺的动作是：**主动把浏览器顶到前台**。
     *
     * <h3>怎么顶（关键：只顶前台，不导航）</h3>
     * `PackageManager.getLaunchIntentForPackage(上次成功拉起游戏的浏览器包)` —— 这是该应用的
     * **启动器 Intent**（ACTION_MAIN + CATEGORY_LAUNCHER，**不带 URL**），
     * 只把它的 task 顶到前台，**不会重新导航**。这一点至关重要：
     * 重新 startActivity 一个带 URL 的 ACTION_VIEW 会让浏览器重载游戏页（前面几轮反复踩的坑），
     * 而重载 = 预加载重来 + 丢掉 XR 会话。
     *
     * 拿不到 launcher intent 或抛异常 → 回退旧的 moveTaskToBack，行为不劣于从前。
     * 收起自己之后再补压一次（900ms）：PICO 有时会把焦点还给「上一个被启动的应用」。
     *
     * @param reason 留痕里用来说明这一次为什么让位（「启动成功」/「页面仍在，不重开浏览器」…）
     */
    private void yieldToBrowser(String reason) {
        boolean ok = bringBrowserToFront();
        PageForensics.line("APK", "让位给浏览器（" + reason + "）：顶前台=" + ok
                + " 浏览器=" + (lastBrowserPkg == null ? "(未知)" : lastBrowserPkg)
                + (ok ? "（不带 URL，不会重载）" : "（失败 → 回退 moveTaskToBack）"));
        if (!ok) moveTaskToBack(true);
        // 收起本页：Activity 只要还在，它那块 2D 面板窗口 + TouchBar 就还在，平台每次 am start
        // 都会把它重新显示出来、把浏览器里的游戏页 / XR 沉浸会话压下去（玩家形容为「被弹出」）。
        // 收掉之后，后续每次平台重拉都命中 onCreate 的「零界面」分支，重拉几乎无感。
        // 进程不会死：GameServer / VRPlusLink 是进程级静态单例，另有前台服务 CastService 保活。
        // ⚠ 这里必须 finish（不只是 moveTaskToBack）：本页只要还活着，它的窗口就还在。
        //   特别是「免打扰」路径用的是 Theme.NoDisplay —— 该主题**要求 onResume 之前 finish()**，
        //   否则系统直接抛 IllegalStateException。故条件写成 platformDriven || passThrough。
        if (platformDriven || Boolean.TRUE.equals(passThrough)) {
            PageForensics.line("APK", "收起配置页（" + reason + "）→ 之后平台重拉走「零界面」分支");
            finish();
        }
        if (!platformDriven) return;    // 手动启动：配置页保留，不需要补压
        new android.os.Handler(getMainLooper()).postDelayed(() -> {
            boolean ok2 = bringBrowserToFront();
            PageForensics.line("APK", "让位补压（收起配置页后 900ms）：顶前台=" + ok2);
        }, 900);
    }

    /**
     * 把「上次打开游戏用的那个浏览器」顶到前台。**只顶前台，不导航。**
     * @return 是否成功发出了置前请求（false → 调用方回退 moveTaskToBack）
     */
    private boolean bringBrowserToFront() {
        String pkg = (lastBrowserPkg != null) ? lastBrowserPkg : firstBrowserPkg();
        if (pkg == null) return false;
        try {
            android.content.Intent li = getPackageManager().getLaunchIntentForPackage(pkg);
            if (li == null) {
                android.util.Log.w("CastMain", "拿不到 " + pkg + " 的启动器 Intent（包不可见？）");
                return false;
            }
            // NEW_TASK：本 Activity 可能已 finish；REORDER_TO_FRONT：已有 task 就把它整体提上来
            li.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                    | android.content.Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            getApplicationContext().startActivity(li);
            lastBrowserPkg = pkg;
            return true;
        } catch (Exception e) {
            android.util.Log.w("CastMain", "顶前台失败(" + pkg + "): " + e);
            return false;
        }
    }

    /** 还没成功拉起过时的候选：BROWSER_PKGS 里第一个「装了且能拿到启动器」的包，其次动态枚举 */
    private String firstBrowserPkg() {
        android.content.pm.PackageManager pm = getPackageManager();
        for (String pkg : BROWSER_PKGS) {
            try {
                if (pm.getLaunchIntentForPackage(pkg) != null) return pkg;
            } catch (Exception ignore) { /* 下一个 */ }
        }
        java.util.List<String> dyn = dynamicBrowserPkgs();
        return dyn.isEmpty() ? null : dyn.get(0);
    }

    // ══════════════ 第十修「本局结束 → 退出策略」（2026-09-19） ══════════════
    //
    // 【现象】平台关掉游戏后，**平台客户端退到后台**（因为浏览器一直抢着前台）。
    //   用户的实测经验：平台再点「开始」常常没反应，**得先手动点开客户端**再启动才灵 —— 也就是
    //   平台的「开始」依赖它自己的客户端在前台。
    // 【期望】本局一结束（平台 `0x10 closeGame`，或页面自己报 game-end）就：
    //   ① 把**平台客户端**顶回前台；② （可选）关掉浏览器，把内存 / GPU 还给系统。
    //
    // 【为什么用 getLaunchIntentForPackage（不带 URL）】那是应用的**启动器 Intent**，只把它的
    //   task 提到前台，**不会重新导航**（带 URL 的 ACTION_VIEW 会让浏览器重载游戏页，历史踩坑）。
    //
    // 【为什么「顶客户端」必须先于「关浏览器」】`killBackgroundProcesses` 只杀**后台**进程；
    //   浏览器还在前台时杀不动。顺序反了既杀不掉，还会在 XRShell 里留一块空的 2D 面板。
    //
    // ⚠ 代价（已知并接受）：关掉浏览器后，平台下一次「开始」必须**重新打开游戏页** ——
    //   多约 10s 预加载（实测 19:37:13 page-open → 19:37:23 100%）。
    //
    // ══════════════ 第十一修「别关浏览器 + 顶客户端要**实测**」══════════════
    // 【留痕实测（2026-09-19 20:23:10 / 20:24:25 / 20:25:26 三次执行）】
    //   ① 「已顶平台客户端到前台」是**假成功**：那条日志只证明 `startActivity()` 没抛异常。
    //      执行后浏览器页**仍然 visibility:visible 且每 5s 照常上报**（20:23:15→20:23:42 共 6 次）——
    //      说明客户端**根本没上来**（真上来的话页会立刻 hidden，那 35 秒里一次都没有）。
    //   ② 「已请求关闭浏览器（killBackgroundProcesses）」同样**没生效**：页一直活着。
    //      根因：`killBackgroundProcesses` 只对**后台**进程有效，而它当时还在前台（见 ①）。
    //   ③ 关浏览器还有更坏的后果：20:25:27 关掉之后，20:25:34 浏览器进程被系统**自己拉起**并把
    //      上次的标签还原成 http://localhost:8080/（page-open），但窗口在后台 → 页面加载到 80%
    //      就被冻结（beforeunload/pagehide persisted=true/freeze，pdt=false）→ **幽灵页**：
    //      既没画面、又还在"活着"，正是玩家说的「第三次启动一直没反应」。
    //   ⇒ 结论：**默认不再关浏览器**（保留勾选框做对比实验），并且「顶客户端」必须**实测复核**。
    //   为什么要保留待机页：它才是零重载快的来源（实测平台重拉 → idle-revived，1s 内回菜单）。

    /** 平台客户端默认包名（= 每次平台拉起我们时 referrer 里的那个包；留痕实测 com.GoodNet.LauncherClient） */
    private static final String DEFAULT_CLIENT_PKG = "com.GoodNet.LauncherClient";

    /** 平台客户端包名：优先 referrer 自动识别结果，其次默认值（见 rememberClientPkgFromReferrer） */
    private static volatile String sPlatformClientPkg = null;

    /** 已配置用户自有直播 PC（= `?cast=1` 直播模式）→ 退出策略一律不动浏览器（它是推流源） */
    private static volatile boolean sPcConfigured = false;

    /** 平台关闭指令 → 延迟多久执行退出策略（留给页面退 VR + 回菜单 + 上报） */
    private static final long RESTORE_DELAY_ON_CLOSE = 2500L;

    /** 页面上报「本局结束」（打输 / 通关 / 玩家退出 VR）→ 延迟更久，让结算画面走完 */
    private static final long RESTORE_DELAY_ON_GAME_END = 8000L;

    /** 已安排的退出策略序号 / 计划执行时刻（只保留**最早**的那次；新一局开始会让它作废） */
    private static volatile long sRestoreSeq = 0;
    private static volatile long sRestoreAt = 0;
    private static volatile long sRestoreLaunchMark = 0;

    /**
     * 从 referrer（`android-app://<pkg>`）记住「是谁拉起了我们」—— 那个包就是平台客户端。
     * 自动识别优先于硬编码：不同场地的客户端包名可能不同。
     */
    private static void rememberClientPkgFromReferrer(String referrer) {
        if (referrer == null) return;
        final String scheme = "android-app://";
        int i = referrer.indexOf(scheme);
        if (i < 0) return;
        String pkg = referrer.substring(i + scheme.length()).trim();
        if (pkg.isEmpty() || pkg.indexOf('/') >= 0) return;      // 只要纯包名
        if (pkg.equals(sPlatformClientPkg)) return;
        sPlatformClientPkg = pkg;
        PageForensics.line("APK", "记住平台客户端包名 = " + pkg + "（来自 referrer）→ 本局结束时可把它顶回前台");
    }

    /** 解析「平台客户端」包名并确认它**确实有界面**（拿不到启动器 Intent 就返回 null，宁可不做） */
    private static String clientPkgForRestore(Context app) {
        String p = null;
        try {
            p = app.getSharedPreferences("cast", Context.MODE_PRIVATE).getString("clientPkg", null);
        } catch (Throwable ignore) { /* 读不到就用自动识别 */ }
        if (p == null || p.trim().isEmpty()) p = sPlatformClientPkg;
        if (p == null || p.trim().isEmpty()) p = DEFAULT_CLIENT_PKG;
        p = p.trim();
        try {
            if (app.getPackageManager().getLaunchIntentForPackage(p) == null) {
                PageForensics.line("APK", "平台客户端 " + p + " 拿不到启动器 Intent（未安装 / 包不可见 / 无界面）");
                return null;
            }
        } catch (Throwable e) {
            return null;
        }
        return p;
    }

    /** 读开关（默认开）：`cast` SharedPreferences 里的 "1"/"0" */
    private static boolean isOn(Context app, String key) {
        return isOn(app, key, true);
    }

    /**
     * 读开关，可指定**默认值**（十一修新增：`killBrowser` 默认改成关，见 restoreClientAndCloseBrowser）。
     * ⚠ 用户没动过勾选框时，SharedPreferences 里**根本没有这个键**，默认值就是这一版的行为 —— 所以
     *   改默认值必须同时改配置页的 `setChecked` 初值（两处口径要一致，否则「界面显示勾着、实际没做」）。
     */
    private static boolean isOn(Context app, String key, boolean def) {
        try {
            return !"0".equals(app.getSharedPreferences("cast", Context.MODE_PRIVATE)
                    .getString(key, def ? "1" : "0"));
        } catch (Throwable e) {
            return def;
        }
    }

    /**
     * 安排一次退出策略。两个入口：① 平台 `0x10 closeGame`；② 页面上报 game-end。
     * 只保留**最早**的那次（关游戏信令 2.5s、页面 game-end 8s，两者常同时到达，取快的那个）；
     * 执行前复核「期间没有开新的一局」（比对 sLaunchedAt），避免误伤下一局。
     */
    static void scheduleClientRestore(Context ctx, String why, long delayMs) {
        final Context app = (ctx != null) ? ctx.getApplicationContext() : CastApp.APP;
        if (app == null) { PageForensics.line("APK", "退出策略跳过：没有可用的 Context"); return; }
        final long at = System.currentTimeMillis() + delayMs;
        if (sRestoreAt != 0 && sRestoreAt <= at) {
            PageForensics.line("APK", "退出策略已在排队（" + (sRestoreAt - System.currentTimeMillis())
                    + "ms 后执行），本次（" + why + "）不重复安排");
            return;
        }
        sRestoreAt = at;
        final long seq = ++sRestoreSeq;
        sRestoreLaunchMark = sLaunchedAt;
        final String busy = isOn(app, "killBrowser", false) ? " + 关闭浏览器" : "";
        PageForensics.line("APK", "本局结束（" + why + "）→ " + delayMs + "ms 后执行退出策略（唤醒平台客户端"
                + busy + "）");
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (seq != sRestoreSeq) return;                       // 被更早/更新的一次取代
            if (sLaunchedAt != sRestoreLaunchMark) {              // 期间开了新的一局（平台又启动了）
                PageForensics.line("APK", "退出策略取消：期间已有新的一局被拉起（本局结束动作已过期）");
                sRestoreAt = 0;
                return;
            }
            sRestoreAt = 0;
            restoreClientAndCloseBrowser(app, why);
        }, delayMs);
    }

    /**
     * 真正执行退出策略：顶平台客户端到前台 →（可选）关浏览器。
     * 见上方「第十修 / 第十一修」注释块。
     */
    static void restoreClientAndCloseBrowser(Context app, String why) {
        final boolean wantClient = isOn(app, "restoreClient");
        // ★ 第十一修：默认**不关**浏览器（默认值只影响「用户从没动过勾选框」的场地）。
        //   实测关完会留下「还原到 80% 就冻住」的幽灵页（见第十一修注释③）。
        final boolean wantKill = isOn(app, "killBrowser", false);
        final boolean castMode = sPcConfigured;
        PageForensics.line("APK", "退出策略执行（" + why + "）：唤醒客户端=" + wantClient
                + " 关闭浏览器=" + wantKill + " 直播模式=" + castMode);
        if (castMode) {
            PageForensics.line("APK", "退出策略跳过：当前带 ?cast=1 直播（浏览器就是推流源，不能关）");
            return;
        }
        if (!wantClient && !wantKill) { PageForensics.line("APK", "退出策略跳过：两项都未勾选"); return; }
        if (!wantClient) {
            // 只勾了「关浏览器」：没人接管前台就杀浏览器 = 头显上什么都不剩，直接不做（老约束）。
            PageForensics.line("APK", "退出策略跳过：只勾了「关闭浏览器」而没勾「唤醒平台客户端」"
                    + " → 顶不上客户端就关浏览器会让头显上没有可用界面");
            return;
        }
        bringClientToFront(app, why);      // 结果由 verifyClientFront 在 1.4s 后**实测**后写留痕
        if (!wantKill) return;
        // 浏览器此刻究竟有没有退到后台，只有 verifyClientFront 的实测知道 —— 所以关浏览器
        // 也交给它：**实测到浏览器确实退了后台**才杀（旧代码无条件 1s 后杀，实测杀了个寂寞）。
        sPendingKillBrowser = true;
    }

    /** 「关浏览器」是否在等 verifyClientFront 的实测结论（第十一修） */
    private static volatile boolean sPendingKillBrowser = false;

    /**
     * 把平台客户端顶到前台（**只顶前台、不导航**）。
     *
     * 第十一修重写：旧版 `startActivity()` 之后**立刻**写「已顶平台客户端到前台」——
     * 那是假成功（留痕实测三次都没把客户端顶上来）。现在：
     *   ① 记下解析到的**组件名**与「我们自己当时的进程 importance」（判断有没有被后台启动限制拦住）；
     *   ② 1.4s 后**实测**浏览器页还在不在打点 → 才能真正说「生效 / 未生效」（见 verifyClientFront）。
     */
    private static void bringClientToFront(Context app, String why) {
        String pkg = clientPkgForRestore(app);
        if (pkg == null) { PageForensics.line("APK", "顶客户端跳过：包名不可用（见上一行）"); return; }
        try {
            Intent li = app.getPackageManager().getLaunchIntentForPackage(pkg);
            if (li == null) { PageForensics.line("APK", "顶客户端失败：拿不到启动器 Intent（" + pkg + "）"); return; }
            PageForensics.line("APK", "顶客户端：组件=" + li.getComponent() + " 自身importance="
                    + myImportance(app) + "（≤100=前台，>100=后台；后台态 startActivity 可能被系统静默丢弃）");
            li.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            app.startActivity(li);
            PageForensics.line("APK", "已发出「顶平台客户端到前台」请求（" + pkg
                    + "，不带 URL，不会重载任何页面）→ 1.4s 后实测复核");
        } catch (Throwable e) {
            PageForensics.line("APK", "顶平台客户端失败(" + pkg + ")/" + e.getClass().getSimpleName()
                    + ": " + e.getMessage());
            sPendingKillBrowser = false;
            return;
        }
        new Handler(Looper.getMainLooper()).postDelayed(() -> verifyClientFront(app, pkg, why), 1400);
    }

    /**
     * 复核「顶客户端」到底有没有生效（第十一修）。
     *
     * 判据：浏览器页还在不在打点。页每 ~1s 会打一次点（`/api/vrplus/*` inbox 轮询 + `/api/page/*`），
     * 所以只要客户端真的接管了前台，Chromium 会冻结后台标签 → 打点立刻停 → `age` 会涨到 >1.4s。
     * 反之 `age` 仍很小 = 浏览器还在前台 = 客户端没上来（就是留痕 20:23:10 那三次的情形）。
     *
     * 未生效时**再试一次**带 `FLAG_ACTIVITY_RESET_TASK_IF_NEEDED` 的启动：有些 Unity 启动器
     * 只有 reset 才会把它自己的主 task 提上来（旧 flags 可能只是把它的某个 splash 转了一圈）。
     */
    private static void verifyClientFront(Context app, String pkg, String why) {
        Context c = (app != null) ? app : CastApp.APP;
        if (c == null) return;
        long age = pageHitAgeMs();
        if (age < 0) {
            PageForensics.line("APK", "顶客户端复核：本进程没收到过页面请求 → 无法判定（跳过；"
                    + "本次动作=" + why + "）");
            sPendingKillBrowser = false;
            return;
        }
        if (age > 1400) {
            PageForensics.line("APK", "✅ 顶客户端已生效：浏览器页已停止打点（age=" + age
                    + "ms）→ 前台已交给 " + pkg + "（本次动作=" + why + "）");
            if (sPendingKillBrowser) {
                sPendingKillBrowser = false;
                PageForensics.line("APK", "退出策略：浏览器确已退后台 → 1s 后关闭它（释放内存）");
                new Handler(Looper.getMainLooper()).postDelayed(() -> killBrowser(c), 1000);
            }
            return;
        }
        PageForensics.line("APK", "⚠ 顶客户端疑似未生效：1.4s 后浏览器页仍在打点（age=" + age
                + "ms）→ 客户端没接管前台（旧版这里会误报成功）。改试 RESET_TASK 再顶一次");
        try {
            Intent li = c.getPackageManager().getLaunchIntentForPackage(pkg);
            if (li == null) return;
            li.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                    | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED | Intent.FLAG_ACTIVITY_BROUGHT_TO_FRONT);
            c.startActivity(li);
            PageForensics.line("APK", "已重试「顶平台客户端」（RESET_TASK_IF_NEEDED）：" + pkg);
        } catch (Throwable e) {
            PageForensics.line("APK", "重试顶客户端失败：" + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
        sPendingKillBrowser = false;       // 没实测到「浏览器退后台」→ 绝不关浏览器
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            long age2 = pageHitAgeMs();
            PageForensics.line("APK", (age2 > 1400
                    ? "✅ 重试后顶客户端生效（浏览器已停止打点 age=" + age2 + "ms）"
                    : "❌ 顶客户端两次都未生效（浏览器仍在打点 age=" + age2 + "ms）→ 悬浮窗权限="
                      + (hasOverlay(c) ? "已授予" : "**未授予**（后台 startActivity 会被系统静默丢弃，"
                        + "这就是顶不动客户端最可能的原因 → 配置页点「授予悬浮窗权限」）")
                      + "；若已授予仍顶不动 → 需平台侧配合（让客户端在游戏运行期间不要尝试回前台）"));
        }, 1500);
    }

    /** 自己进程的 oom_adj 级 importance（≤100=前台/可见，>100=后台）——诊断后台启动限制用 */
    private static int myImportance(Context app) {
        try {
            ActivityManager am = (ActivityManager) app.getSystemService(Context.ACTIVITY_SERVICE);
            if (am == null) return -1;
            int pid = android.os.Process.myPid();
            java.util.List<ActivityManager.RunningAppProcessInfo> ps = am.getRunningAppProcesses();
            if (ps == null) return -1;
            for (ActivityManager.RunningAppProcessInfo p : ps) {
                if (p.pid == pid) return p.importance;
            }
            return -1;
        } catch (Throwable e) {
            return -1;
        }
    }

    /** 页面最近一次打点距今多久（ms）；本进程从未收到过请求返回 -1。口径 = GameServer.lastPageHitMs */
    private static long pageHitAgeMs() {
        GameServer s = sServer;
        if (s == null) return -1;
        long t = s.lastPageHitMs();
        if (t <= 0) return -1;
        return System.currentTimeMillis() - t;
    }

    // ── 悬浮窗权限（SYSTEM_ALERT_WINDOW）：后台启动 Activity 的官方豁免项（第十一修） ──

    /** 是否已授予「显示在其他应用上层」（= 后台 startActivity 会被放行） */
    static boolean hasOverlay(Context c) {
        try {
            return android.provider.Settings.canDrawOverlays(c);
        } catch (Throwable e) {
            return false;
        }
    }

    /** 刷新配置页的悬浮窗权限状态文字（onCreate / onResume 都调，从系统设置回来才会变） */
    static void refreshOverlayState(android.app.Activity act) {
        try {
            android.widget.TextView tv = act.findViewById(R.id.tvOverlay);
            if (tv == null) return;
            boolean on = hasOverlay(act);
            tv.setText(on
                    ? "悬浮窗权限：✅ 已授予（后台可顶客户端到前台）"
                    : "悬浮窗权限：❌ 未授予 —— 后台 startActivity 会被系统静默丢弃，"
                      + "「本局结束后唤醒客户端」顶不动就点左边按钮去开");
            tv.setTextColor(on ? 0xFF7FD18A : 0xFFD8A657);
        } catch (Throwable ignore) { /* 旧布局没有该控件时忽略 */ }
    }

    /** 跳系统设置去授予悬浮窗权限（特殊权限，只能用户手动开一次） */
    static void requestOverlayPermission(android.app.Activity act) {
        try {
            PageForensics.line("APK", "跳系统设置授予悬浮窗权限（后台顶客户端用）");
            Intent it = new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + act.getPackageName()));
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            act.startActivity(it);
        } catch (Throwable e) {
            PageForensics.line("APK", "打不开悬浮窗权限设置页：" + e.getClass().getSimpleName()
                    + ": " + e.getMessage() + " → 请手动到「设置 → 应用 → 本应用 → 显示在其他应用上层」开启");
        }
    }

    /**
     * 关掉浏览器进程（`killBackgroundProcesses`：只对**后台**进程有效，故必须在前台让出之后调用）。
     * 失败也不影响任何东西 —— 下一轮平台启动时 maybeLaunch 会照旧判定「页面已失联」并重新打开。
     */
    private static void killBrowser(Context app) {
        String pkg = (lastBrowserPkg != null) ? lastBrowserPkg : firstBrowserPkgFor(app);
        if (pkg == null) { PageForensics.line("APK", "退出策略：不知道要关哪个浏览器包 → 跳过"); return; }
        try {
            ActivityManager am = (ActivityManager) app.getSystemService(Context.ACTIVITY_SERVICE);
            if (am == null) { PageForensics.line("APK", "退出策略：ActivityManager 不可用 → 跳过关浏览器"); return; }
            am.killBackgroundProcesses(pkg);
            PageForensics.line("APK", "退出策略：已请求关闭浏览器 " + pkg + "（killBackgroundProcesses）"
                    + " → 下一局平台启动会重新打开游戏页（预加载约 10s）");
        } catch (Throwable e) {
            PageForensics.line("APK", "关浏览器失败(" + pkg + ")/" + e.getClass().getSimpleName()
                    + ": " + e.getMessage());
        }
    }

    /** 静态版「候选浏览器包」：只查 BROWSER_PKGS（不动态枚举，退出策略要的是**确定**的那一个） */
    private static String firstBrowserPkgFor(Context app) {
        try {
            android.content.pm.PackageManager pm = app.getPackageManager();
            for (String pkg : BROWSER_PKGS) {
                if (pm.getLaunchIntentForPackage(pkg) != null) return pkg;
            }
        } catch (Throwable ignore) { /* 拿不到就算 */ }
        return null;
    }

    /**
     * 上报平台「客户端已启动游戏」= cmd3。
     *
     * 为什么必须由 APK 在浏览器一拉起时就发，而不是等游戏页自己发：
     *   游戏侧只在 game.start() 里上报（= 玩家点「进入 VR」之后）；而 main.js 的加载遮罩是
     *   6s + 3s 分段节奏 + 20s 硬超时，玩家最早也要 ~10s 才能点进 VR —— 必然晚于平台的 ~20s 超时。
     *   平台判定「没起来」→ 重发 am start → 浏览器被重新导航 → 加载被打断 → 更收不到确认，
     *   形成死循环（castlog3.txt 四次 am start 就是这个循环）。
     *
     * UDP 在局域网仍可能丢包，故连发 3 次（0/400/800ms）确保平台收到；平台收到即应停止重复拉起。
     *
     * 【2026-09-16 修复：本方法曾在主线程直接发包 → 一直失败】
     *   之前这里对每次上报都打「失败: null」，日志里连发 3 次全败（castlog4.txt）。真因是本方法
     *   经 Handler(getMainLooper()) 跑在**主线程**，而 DatagramSocket.send() 是网络操作，Android 抛
     *   NetworkOnMainThreadException —— 该类不携带 message，所以只看到 "null"。cmd3 从未发出 →
     *   平台每 20s 重发 am start → 反复把前台从游戏页/XR 会话抢走（= 用户看到的「闪退」）。
     *   现在 VRPlusLink 内部把发包统一丢到后台线程（sendCommand 只是入队），
     *   故本方法在主线程调用是安全的；日志相应改为「已提交」（真正的收发结果看 VRPlus 双标签日志）。
     */
    private void notifyPlatformGameLaunched() {
        final VRPlusLink link = (sVRPlusLink != null) ? sVRPlusLink : vrPlusLink;
        if (link == null) {
            android.util.Log.w("CastMain", "上报平台「已拉起」跳过：VR+ 桥接尚未建立");
            return;
        }
        // 平台「启动游戏」的完整动作是 kill → copyfile(setup.xml) → am start；
        // 平台的启动流程此刻正在等设备回 cmd1 —— 抓包实测：`start`(07:52:42) 后 6 秒游戏就注册了
        // (07:52:48)，此后平台全程不再重发 start。故这里在每次被拉起后**立刻补发 0x01**，
        // 而且必须「一被拉起就发」，不能等页面/预加载等任何后续状态。
        // pokeHandshake 内部已含 3 轮（间隔 400ms，抗 UDP 丢包），且整轮都在后台线程完成。
        link.pokeHandshake("平台拉起/启动指令到达");
        // 留痕（六修）：把「什么时候补发过 0x01」也写进时间线 —— 否则读日志时无法回答
        //「平台又重拉了，到底是它没收到我们的注册、还是它自己的逻辑」。
        PageForensics.line("APK", "补发 0x01 注册（平台拉起/启动指令到达）→ 平台回机位表即算上线");
        // 【2026-09-17 定稿：上行不再有第三帧】
        //   抓包（cap3.pcap 完整会话 120s/27216 包）证明玩家侧上行**只有 0x01 与 0x02**：
        //     0x01 注册 → 平台 57ms 后回机位表 {"Machines":[...]} → 之后 94 秒静默 → 平台 closeGame → 0x02 ack
        //   ① 旧 V2.9 的 {"cmd":3} 新平台不认（VRPlusLink 已改为一律拒发）；
        //   ② **0x08 身份上报是错的**：旧推断（“不回 0x08 平台就每 ~20s 重拉 am start”）已被推翻 ——
        //      整场抓包没有任何 0x08；平台日志那条 `收到客户端发来的消息啦8` 比玩家侧 cmd=1 早 7 秒，
        //      属 IsHost=1 的主机侧。已连同 setIdentity/md5/8s 兜底一并删除。
        android.util.Log.i("CastMain", "已通知 VR+ 补发 0x01 注册（平台拉起）");
    }

    /**
     * 游戏页是否还活着：GameServer 记录最近一次 /api/vrplus/* 请求时刻，游戏页每秒轮询一次，
     * 故「5s 内有过请求」即视为存活。用于决定「平台重复拉起时能不能重新打开浏览器」。
     */
    private boolean isGamePageAlive() {
        // 刚拉起后 15s 内：游戏页可能还在加载（main.js 加载遮罩 6s+3s 节奏），尚未开始轮询，
        // 此时一律当作「存活」，避免把自己的加载期误判成失联而重开浏览器（那会打断加载）。
        if (sLaunchedAt > 0 && System.currentTimeMillis() - sLaunchedAt < 15000) return true;
        long age = gamePageAgeMs();
        return age >= 0 && age < 5000;
    }

    /**
     * 距最近一次「游戏页自己发出的请求」的毫秒数；-1 = 从未有过请求。
     * 口径见 GameServer.lastPageHitMs 字段注释（含 /api/vrplus/* 与 /api/page/*；不含人读留痕那次）。
     */
    private long gamePageAgeMs() {
        if (sServer == null) return -1;
        long t = sServer.lastPageHitMs();
        return (t == 0) ? -1 : (System.currentTimeMillis() - t);
    }

    /**
     * 平台配置下发探针（每次拉起都跑一次，诊断 + 修一个真 bug）。
     *
     * 【castlog6.txt 实测的平台侧时序】
     *   客户端（PC 192.168.31.228）经启动器（com.GoodNet.LauncherClient，Unity）给头显下发一批指令：
     *     ① {"cmd":"kill", "msgData":"am force-stop --user 0 com.GoodNet.DeepmindHacker"}
     *     ② cmd == copyfile
     *     ③ {"cmd":"start","msgData":"am start --user 0 -n com.GoodNet.DeepmindHacker/.MainActivity -d <PC_IP>"}
     *   启动器日志原文：`==CopyFile error2 : /storage/emulated/0/Android/data/com.GoodNet.DeepmindHacker/
     *   files/setup.xml: open failed: ENOENT (No such file or directory)`
     *   —— 即**客户端要把 setup.xml 拷进我们的外部私有目录，但那个目录不存在**（Android 只在 App 调用过
     *   getExternalFilesDir() 之后才创建 .../Android/data/<pkg>/files）。这极可能就是「客户端判定没配好
     *   → 每 20.004s 重发整套（含 am start）→ 每次重拉都把游戏页/XR 会话顶掉 = 玩家看到的闪退」的源头。
     *
     * 故这里显式建目录，并把 setup.xml 是否到位 / 目录内容 / 文件前 1KB 打进日志：
     *   · 目录建出来后 `error2` 应消失，客户端应停止重发（需实测确认）；
     *   · 若 setup.xml 真被塞进来，日志里能直接看到平台下发的配置（房间号 / 平台地址 / 机器号等）。
     */
    private void probePlatformDir() {
        try {
            java.io.File ext = getExternalFilesDir(null);   // ← 副作用即「创建 .../Android/data/<pkg>/files」
            if (ext == null) { android.util.Log.w("CastMain", "外部私有目录不可用（无外置存储）"); return; }
            java.io.File setup = new java.io.File(ext, PLATFORM_SETUP_FILE);
            StringBuilder sb = new StringBuilder();
            java.io.File[] list = ext.listFiles();
            if (list != null) for (java.io.File f : list) sb.append(f.getName()).append('(').append(f.length()).append("B) ");
            android.util.Log.i("CastMain", "平台目录 " + ext.getAbsolutePath() + " 就绪；setup.xml="
                    + (setup.exists() ? "已到位 " + setup.length() + "B" : "暂无") + "；目录内含: " + sb);
            if (setup.exists()) {
                byte[] buf = new byte[1024];
                try (java.io.FileInputStream in = new java.io.FileInputStream(setup)) {
                    int n = in.read(buf);
                    if (n > 0) android.util.Log.i("CastMain", "setup.xml 前 " + n + " 字节: "
                            + new String(buf, 0, n, java.nio.charset.StandardCharsets.UTF_8).replace('\n', ' '));
                }
                // 真实游戏就是从这里取平台地址的（对照日志：SettingManager:LoadSetup() → ===GetPlatformIP======<ip>），
                // 所以把解析结果单独打一条，和真实游戏日志可逐行对齐。
                String pip = readSetupPlatformIp();
                android.util.Log.i("CastMain", pip != null
                        ? "===GetPlatformIP======(setup.xml) " + pip + " ← 已作为平台候选，比 -d 直推更可信"
                        : "setup.xml 已到位但未解析出 platformIP（将只用 -d 直推地址）");
            }
        } catch (Throwable e) {
            android.util.Log.w("CastMain", "平台目录探针失败: " + e.getClass().getSimpleName() + "/" + e.getMessage());
        }
    }

    /**
     * 进程存活心跳（诊断用，每 10s 一条）：
     *   · 若日志在某个时刻**停止**出现心跳 → APK 进程被系统杀了（这会连带让游戏页的
     *     aliveWatch 触发 _onPlatformGone → 游戏页被卸载 = 玩家看到的「闪退」）；
     *   · 若心跳继续但 age 变很大 → 游戏页（浏览器）自己没了。
     * 两种都能一眼分辨，便于定位闪退归因。
     */
    private static volatile boolean sHeartbeatStarted = false;
    private void startProcessHeartbeat() {
        if (sHeartbeatStarted) return;
        sHeartbeatStarted = true;
        final android.content.Context app = getApplicationContext();   // Activity 可能被销毁：用应用上下文补服务
        Thread t = new Thread(() -> {
            int ticks = 0;
            while (true) {
                try { Thread.sleep(5000); } catch (InterruptedException e) { return; }   // 5s 一条：更快暴露「进程/服务」中断
                ticks++;
                // 顺手兜住「服务被系统回收」：8080 不再可连就补绑定；前台服务没了就补起。
                // 这两件事本身都不该影响游戏，但缺了它们，浏览器里的游戏页会因资源请求失败而崩。
                boolean up = isLocalServerReady();
                if (!up && sServer != null) {
                    // ⚠ 留痕！8080 一旦失联，浏览器里正在加载的游戏页**所有资源请求都会失败**——
                    //   这本身就是「进度条跑到一半就没了」的头号嫌疑，必须落进时间线（哪怕随后重绑成功）。
                    PageForensics.line("APK", "心跳：8080 失联 → 重新绑定（此间页面请求会全部失败）");
                    try { sServer.start(); android.util.Log.i("CastMain", "心跳：8080 失联，已重新绑定"); }
                    catch (Exception e) { android.util.Log.w("CastMain", "心跳：8080 重绑失败 " + e.getMessage()); }
                }
                CastService.start(app);   // 幂等：服务已在跑则忽略
                // 平台通常「先 copyfile 下发 setup.xml，再 am start」，但两个动作间隔可能只有几毫秒；
                // 这里每 5s 复查一次，晚到的 setup.xml 也能被追加成平台候选地址（无需重启桥接）。
                try {
                    if (sVRPlusLink != null) {
                        String pip = readSetupPlatformIp();
                        if (pip != null && sVRPlusLink.offerHost(pip)) {
                            android.util.Log.i("CastMain", "心跳：setup.xml 新平台地址 " + pip + " 已加入候选");
                            PageForensics.line("APK", "心跳：setup.xml 新平台地址 " + pip + " 已加入候选");
                        }
                    }
                } catch (Throwable ignore) { /* 探针失败不影响心跳 */ }
                // 留痕里每 30s 落一条（5s×6），用于分辨「APK 死了」还是「游戏页没了」：
                //   · 留痕在此刻**戛然而止** → APK 进程被 force-stop；
                //   · 留痕继续但 age 越来越大 → APK 活着，是游戏页（浏览器）自己没了。
                if (ticks % 6 == 0 || !up) {
                    PageForensics.line("APK", "心跳 8080=" + up + " 游戏页age=" + gamePageAgeMs()
                            + "ms sLaunched=" + sLaunched + " 拉起次数=" + launchAttempts
                            + " VRPlus=" + (sVRPlusLink != null
                                ? ("connected=" + sVRPlusLink.isConnected()) : "未建桥") + " 平台="
                            + (sVRPlusLink != null ? sVRPlusLink.host() : null));
                }
                android.util.Log.i("CastMain", "心跳：APK 进程存活，8080=" + up + "，游戏页 age=" + gamePageAgeMs()
                        + "ms，sLaunched=" + sLaunched + "，launchAttempts=" + launchAttempts
                        + "，VRPlus=" + (sVRPlusLink != null
                            ? ("connected=" + sVRPlusLink.isConnected() + " 平台=" + sVRPlusLink.host()) : "未建桥"));
            }
        });
        t.setName("cast-heartbeat");
        t.setDaemon(true);
        t.start();
    }

    /**
     * 推流/游玩目标地址：http://localhost:8080/?cast=1&pc=<PC>:<port>&mode=webrtc
     *
     * 关键：localhost 是 WebXR 安全上下文，PICO 浏览器才会暴露 navigator.xr「进入 VR」按钮。
     *
     * 【2026-09-09 最终结论（实测确认）】
     * 卡顿真因**不是**传输路径，而是编码方式：
     *   · TRANSPORT='jpeg' 走 canvas.toBlob **CPU 软编码**，PICO 单帧 5~6 秒，
     *     期间中间帧全被丢弃、只抓到当前帧 → 无论怎么降分辨率/加异步/换代理都救不回来。
     *   · TRANSPORT='webrtc' 走**硬件 H.264 编码** → 实测 PC 端实时流畅。
     * 故默认与此处均改为 webrtc（jpeg 仅作 6 秒连不上时的兜底）。
     *
     * 仍保留 ?pc= 的理由（信令层）：NanoHTTPD 对 SSE 长连接支持差（易缓冲、易断），
     * 而 WebRTC 的 offer/answer/ICE 全靠信令；让信令直连 PC 可避开这一层不确定性。
     * 媒体流本身是 PICO↔PC 的 P2P，无论是否走代理都不经过 APK。
     *
     * 跨域直连的前提（PC 端 main.js 均已具备）：
     *   · applyCors() 返回 Access-Control-Allow-Origin:* 与 Access-Control-Allow-Private-Network:true
     *   · handleEvents / OPTIONS preflight 同样带这两个头
     *     （否则 Chrome 私有网络访问 PNA 会在连接建立前拦掉，服务端根本收不到请求）
     * 静态资源仍由 APK 的 GameServer 提供或代理到 PC，与帧路径无关。
     */
    private String getCastUrl() {
        // ★ 第十四修：**本页由我们拉起 = 「有人要开始这一局」** → 网址带 `?plat=1`，
        //   页面侧据此直接开「进入 VR」门禁（见 src/main.js 门禁块）。为什么用这个判据：
        //   留痕 page-forensics (5).log 证明整局平台对我们**零「开始」下行**（逐帧留痕只有 8 条
        //   机位表回执 + 1 条 closeGame；全程**没有** onNewIntent、没有第二次 am start）
        //   ⇒ 操作员点「开始游戏」在设备侧唯一的可见形态就是**拉起本页**（kill→copyfile→am start）。
        //   故「等平台下发 cmd3/4」在本部署永远等不到，只能等 30 秒兜底（= 玩家看到的「点开始游戏
        //   没反应，等时间到了才弹出进入 VR」）。
        //   ⚠ 门禁仍然保留：只有**不是**我们拉起的页面（玩家自己在 PICO 浏览器里打开
        //   localhost:8080 / 幽灵页还原）才会走 30 秒兜底。
        final String plat = "&plat=1";
        // ★ 第十三修：配置页勾「直接显示「进入 VR」按钮（不等平台）」→ 网址带 `?vrbtn=1`，
        //   页面侧语义 = **完全旁路门禁**（按钮常显，见 src/main.js 门禁块）。
        //   它是现场应急杠杆：万一平台从不下发「开始游戏」指令，勾一下即可恢复旧行为，无需重打包。
        final String vrBtn = isOn(this, "directVr", false) ? "&vrbtn=1" : "";
        // 用户自有 cast-pc → 信令/资源直连 PC + 强制 WebRTC 硬件编码（实测流畅的唯一组合）
        // ★ 2026-09-20 修：信标只是「发现手段」之一，不是判据本身。门禁**核实过**的地址同样算数 ——
        //   否则信标一旦不到（现场实测），本行就退化成纯本地地址，游戏照跑但直播端全黑。
        final String castPc = (currentPc != null) ? currentPc : sGuardVerifiedPc;
        if (castPc != null && !castPc.isEmpty())
            return GAME_URL + "&pc=" + castPc + "&mode=webrtc" + plat + vrBtn;
        // 平台启动：纯本地直接进游戏，不连直播 PC（注意 LOCAL_GAME_URL 自带收尾 /，首个参数用 ?）
        return LOCAL_GAME_URL + "?" + plat.substring(1) + vrBtn;
    }

    /**
     * 把 `am start` 的 extras 摘成短串写进留痕（第十三修新增）。
     * 用途：确认「平台是不是用同一条 `am start` 同时表示『启动』与『开始游戏』」——
     *   若操作员按「开始」时 extras 里多了标记位（如 gameState / roundId / isStart），那就是
     *   一个**可用的开局信号**，门禁就能钉在它上面（见 docs/tech/VR+平台版本号实现.md §24）。
     * 限长 200 字符，避免把留痕刷爆。
     */
    private static String extrasPreview(Intent it) {
        try {
            android.os.Bundle b = (it == null) ? null : it.getExtras();
            if (b == null || b.isEmpty()) return "（无）";
            StringBuilder sb = new StringBuilder();
            for (String k : b.keySet()) {
                sb.append(k).append('=').append(String.valueOf(b.get(k))).append(';');
                if (sb.length() > 200) { sb.append('…'); break; }
            }
            return b.size() + " 项: " + sb;
        } catch (Throwable e) {
            return "读取失败:" + e.getClass().getSimpleName();
        }
    }

    // WebXR 不可用时的兜底：自动用 PICO 浏览器全屏打开本地游戏地址进入 VR。
    // 地址由 getCastUrl 返回（localhost 保安全上下文；已发现 PC 时带 &pc= 让信令直连 PC）。
    // 静态资源由本 APK 的 GameServer 提供或代理到 PC；信令/媒体直连 PC，不经过 APK 转发。
    private boolean openInPicoBrowser() {
        try {
            Uri uri = Uri.parse(getCastUrl());
            if (launchAttempts <= 1) logViewCandidates(uri);   // 诊断：本机能打开 http 的组件有哪些
            // ① 优先直接拉起 PICO 浏览器（WebXR 支持最完整）
            for (String pkg : BROWSER_PKGS) {
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, uri);
                    i.setPackage(pkg);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                    android.util.Log.i("CastMain", "已用 PICO 浏览器(" + pkg + ")打开 " + uri);
                    lastBrowserPkg = pkg;
                    stopInnerWebView();     // 关键：见下方说明
                    return true;
                } catch (Exception e) { /* 该包名未安装/被拦，尝试下一个候选 */
                    android.util.Log.w("CastMain", "拉起 " + pkg + " 失败: " + e.getMessage());
                }
            }
            // ② 候选都没命中 → 用包管理器枚举，动态挑一个「像浏览器」的包显式拉起
            //    （比 CustomTabs 兜底可控，能确保拿到带 WebGL/WebXR 的真实浏览器）
            for (String pkg : dynamicBrowserPkgs()) {
                if (isInList(pkg, BROWSER_PKGS)) continue;      // ① 已试过
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, uri);
                    i.setPackage(pkg);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                    android.util.Log.i("CastMain", "已用动态选中浏览器(" + pkg + ")打开 " + uri);
                    lastBrowserPkg = pkg;
                    stopInnerWebView();
                    return true;
                } catch (Exception e) {
                    android.util.Log.w("CastMain", "拉起 " + pkg + " 失败: " + e.getMessage());
                }
            }
            // ③ 兜底：交给系统默认 http 处理者（Custom Tabs，隐藏工具栏降低“弹出感”）
            Intent probe = new Intent(Intent.ACTION_VIEW, uri);
            android.content.pm.ResolveInfo ri = getPackageManager().resolveActivity(probe, 0);
            android.util.Log.i("CastMain", "系统默认 http 处理者: "
                    + (ri != null ? ri.activityInfo.packageName + "/" + ri.activityInfo.name : "（无）"));
            CustomTabsIntent intent = new CustomTabsIntent.Builder()
                    .setToolbarColor(0xFF101014)
                    .setShowTitle(false)
                    .build();
            intent.launchUrl(this, uri);
            android.util.Log.i("CastMain", "已用系统浏览器(CustomTabs)打开 " + uri);
            stopInnerWebView();
            return true;
        } catch (Exception e) {
            // 连浏览器都无法拉起时（常见于后台态被系统拦截），保持配置页并等待重试
            android.util.Log.w("CastMain", "全部浏览器拉起失败: " + e);
            return false;
        }
    }

    /** 显式拉起候选浏览器（PICO 浏览器优先；需 Manifest <queries> 授权可见，否则一律 No Activity found） */
    private static final String[] BROWSER_PKGS = {
            "com.pico.browser",            // PICO 浏览器（PUI4/5 国内）
            "com.pico.browser.overseas",   // PICO 浏览器（海外版）
            "com.oculus.browser",          // ★ 2026-09-16 实测本机唯一能打开 http 的浏览器（castlog3.txt）
            "com.pico.browser.pui",        // 部分 PUI 版本的包名
            "com.android.chrome",
            "com.android.browser",
    };

    /** 枚举所有能打开 http 的组件，逐个落日志（诊断包可见性用；受限时列表为空） */
    private void logViewCandidates(Uri uri) {
        try {
            java.util.List<android.content.pm.ResolveInfo> list =
                    getPackageManager().queryIntentActivities(new Intent(Intent.ACTION_VIEW, uri), 0);
            if (list.isEmpty()) {
                android.util.Log.w("CastMain", "queryIntentActivities 为空 → 包可见性受限（检查 Manifest <queries>）");
            }
            for (android.content.pm.ResolveInfo ri : list) {
                android.util.Log.i("CastMain", "可打开 http 的组件: "
                        + ri.activityInfo.packageName + "/" + ri.activityInfo.name);
            }
        } catch (Exception e) {
            android.util.Log.w("CastMain", "枚举浏览器组件失败: " + e);
        }
    }

    /** 从包管理器动态取「像浏览器」的包名（名称含 browser/chrome/internet/vr/qt/browser…） */
    private java.util.List<String> dynamicBrowserPkgs() {
        java.util.List<String> out = new java.util.ArrayList<>();
        try {
            java.util.List<android.content.pm.ResolveInfo> list =
                    getPackageManager().queryIntentActivities(
                            new Intent(Intent.ACTION_VIEW, Uri.parse("http://localhost:8080/")), 0);
            for (android.content.pm.ResolveInfo ri : list) {
                String pkg = ri.activityInfo.packageName;
                String lp = pkg.toLowerCase();
                if ((lp.contains("browser") || lp.contains("chrome") || lp.contains("internet"))
                        && !out.contains(pkg)) {
                    out.add(pkg);
                }
            }
        } catch (Exception ignore) { /* 枚举失败则视为没有候选 */ }
        return out;
    }

    private static boolean isInList(String pkg, String[] arr) {
        for (String a : arr) if (a.equals(pkg)) return true;
        return false;
    }

    /**
     * 跳到外部浏览器后，停掉应用内 WebView 里的游戏。
     *
     * 不停会同时存在两个游戏实例，两者都向 PC 注册推流端（publisher），而 PC 端只保留最后一个；
     * 更要命的是后台 WebView 会被 Chromium 冻结/节流——JS 与 rAF 停摆，画面采集不到，
     * 却还占着信令槽位，结果就是真正在前台跑的那个反而推不出画面（PC 端表现为一直没有 offer）。
     * 这里加载 about:blank 断开页面，即可释放它的 SSE 连接与 GL 上下文。
     */
    private void stopInnerWebView() {
        if (webView == null) return;
        try {
            webView.loadUrl("about:blank");
            webView.onPause();
            webView.setVisibility(View.GONE);
        } catch (Exception ignore) { /* WebView 已销毁等情形，忽略 */ }
    }

    /** 本地 8080 是否可连接（GameServer 真正 bind 完成，避免浏览器抢跑连到拒绝） */
    private boolean isLocalServerReady() {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress("127.0.0.1", LOCAL_PORT), 200);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    /**
     * 轮询本地 8080 就绪后再拉起 PICO 浏览器：根治「server 还没 bind 完浏览器就抢跑 →
     * 第一次 localhost 拒绝」的现象。就绪后触发 maybeLaunch，带 ?pc= 的正确地址一次性拉起。
     *
     * ⚠️ 必须在【后台线程】轮询：isLocalServerReady() 会 new Socket().connect() 做网络操作，
     * 若跑在主线程会抛 NetworkOnMainThreadException → 应用直接闪退（2026-09-15 实测踩坑）。
     * 探测到就绪后改用 runOnUiThread 回主线程调 maybeLaunch（startActivity 必须主线程）。
     */
    private void startLaunchWatchdog() {
        new Thread(() -> {
            int ticks = 0;
            while (!serverReady) {
                try { Thread.sleep(200); } catch (InterruptedException e) { return; }
                if (isLocalServerReady()) {
                    serverReady = true;
                    android.util.Log.i("CastMain", "本地 8080 已可连接，再等 300ms 让 NanoHTTPD 完全接受请求");
                    try { Thread.sleep(300); } catch (InterruptedException e) { return; }
                    runOnUiThread(() -> maybeLaunch());
                    break;
                }
                // 还没就绪：若首次绑定失败过（端口被上一实例占用 / TIME_WAIT），每 ~1s 在后台补一次绑定
                if ((++ticks % 5) == 0 && server != null) {
                    try {
                        server.start();
                        android.util.Log.i("CastMain", "看门狗补绑定 8080 成功");
                    } catch (Exception e) {
                        android.util.Log.w("CastMain", "看门狗补绑定 8080 仍失败: " + e.getMessage());
                    }
                }
            }
        }).start();
    }

    @Override
    protected void onDestroy() {
        // ★ 第十六修：作废「等待直播端」的后台轮询线程（换轮序列号变了，旧线程下一轮自己退出）
        sGuardWaitSeq++;
        if (discovery != null) { discovery.stop(); discovery = null; }
        if (webView != null) { webView.destroy(); webView = null; }
        // ⚠ 不 stop sServer / sVRPlusLink：它们是**进程级单例**，浏览器里的游戏页依赖前者持续供资源。
        //   平台「保险」二次拉起会重建 Activity（实测同 PID 两次 onCreate），若在此 stop，
        //   会把正在加载的游戏页当场掐断 → 表现为「localhost 拒绝」+ 永久卡在「正在加载天空资源…」。
        //   它们只在进程结束时（含平台 force-stop）随之释放。
        android.util.Log.i("CastMain", "onDestroy：保留进程级 8080 服务与 VR+ 桥接（不随 Activity 销毁）");
        super.onDestroy();
    }
}
