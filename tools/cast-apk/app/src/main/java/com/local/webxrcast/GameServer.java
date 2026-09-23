package com.local.webxrcast;

import android.content.res.AssetManager;
import android.util.Log;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import fi.iki.elonen.NanoHTTPD;
import org.json.JSONArray;
import org.json.JSONObject;
import fi.iki.elonen.NanoHTTPD.IHTTPSession;
import fi.iki.elonen.NanoHTTPD.Method;
import fi.iki.elonen.NanoHTTPD.Response;

/**
 * 轻量本地 HTTP 服务（http://localhost:8080）：
 *   1) 从 APK 的 assets/game/ 托管游戏本体（localhost 是安全上下文 → WebXR 可用）；
 *   2) 把 /api/* 信令**代理**到 PC 接收端 EXE。
 *
 * 为什么要代理而不是让页面直连 PC：
 *   页面 origin 是 http://localhost:8080，PC 信令在 http://192.168.x.x:8443 —— 属跨域，
 *   且 Chrome 的「私有网络访问（PNA）」规则要求 preflight，而 SSE(EventSource) 发不出
 *   preflight，会被静默拦截（无报错、极难排查）。改成同源 /api 后由本服务转发，
 *   页面只跟自己通信，跨域/PNA/证书问题一次性全部消失。
 *
 * 另一个好处：发现 PC 后只需 setPcBase()，游戏侧信令退避重连时自然连上，
 * **不需要 reload 页面**，不会打断玩家游玩（连已经跳到 PICO 浏览器的页面也照样生效）。
 */
public class GameServer extends NanoHTTPD {

    private static final String BASE = "game"; // assets 下游戏根目录
    private static final String TAG = "CastGameServer";

    private final AssetManager assets;

    /** PC 接收端基址（如 http://192.168.31.228:8443）；null = 尚未发现 PC */
    private volatile String pcBase = null;

    /**
     * ★ 第十七修：直播端下发的「轻量配置」覆盖层根目录（私有目录 game-overlay）；null = 未启用。
     * 托管静态资源时**优先读它**，见 serveOverlay()。
     */
    private volatile java.io.File overlayDir = null;

    /**
     * ★ 第十七修：覆盖层里的「受管路径」集合（相对路径，来自下发时落盘的 session.json）。
     * 命中集合的路径**只认覆盖层、绝不回落 assets / PC 代理** —— 这是「文件齐全才跑得起来」
     * 真正生效的地方：宿主 APK 里根本没有这些文件，只能由已授权的直播端下发得到。
     */
    private volatile java.util.Set<String> overlayPaths = java.util.Collections.emptySet();

    /** VR+ 平台桥接（UDP 51234/51124）；null = 尚未启动（未发现 PC 或 VR+ 未配置） */
    private VRPlusLink vrplus = null;

    /**
     * 最近一次收到「**游戏页自己发出的**」请求的时刻（ms）。
     * 这是「游戏页是否还活着」的唯一判据：MainActivity 据此决定「平台重复拉起 / 拉起自检判定失败时，
     * 能不能再开一次浏览器」—— 活着就绝不重开（重开会重载页面），失联才允许重拉。
     *
     * 【2026-09-19 扩展：把 /api/page/* 也算进来】
     * 原来只统计 /api/vrplus/*，实测留痕出现过自相矛盾的组合：
     *   心跳 `游戏页age=56s`（判失联）←→ 同一秒却连着刷 `[PAGE] 状态 进度=80%`（页面明明在写留痕）。
     * 页面**任何**一条请求（inbox 轮询 / 状态上报 / 生命周期事件）到达都应算「活着」；否则会把活着的
     * 页面判成失联 → 重开浏览器 → 页面被重载 = 玩家看到的「网页又自动弹一次、进度条重来」。
     * ⚠ 但 `/api/page/forensics`（人 / 浏览器来读留痕）**不算** —— 否则打开留痕页就等于给游戏页续命。
     */
    private volatile long lastPageHitMs = 0;

    /** 页面最近一次上报的游戏状态（menu / playing / waiting / ?），仅供日志与决策参考 */
    private volatile String lastPageState = "?";
    /** 页面是否处于「本局已结束」待机态（?cs=1）。见 MainActivity.reviveClosedPage */
    private volatile boolean lastPageClosed = false;

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put(".html", "text/html; charset=utf-8");
        MIME.put(".js",   "text/javascript; charset=utf-8");   // ES module 必需
        MIME.put(".mjs",  "text/javascript; charset=utf-8");
        MIME.put(".json", "application/json; charset=utf-8");
        MIME.put(".css",  "text/css; charset=utf-8");
        MIME.put(".glb",  "model/gltf-binary");
        MIME.put(".gltf", "model/gltf+json");
        MIME.put(".wasm", "application/wasm");
        MIME.put(".jpg",  "image/jpeg");
        MIME.put(".jpeg", "image/jpeg");
        MIME.put(".png",  "image/png");
        MIME.put(".svg",  "image/svg+xml");
        MIME.put(".mp3",  "audio/mpeg");
        MIME.put(".ogg",  "audio/ogg");
        MIME.put(".mp4",  "video/mp4");
        MIME.put(".webm", "video/webm");
        MIME.put(".bin",  "application/octet-stream");
        MIME.put(".spz",  "application/octet-stream");
    }

    public GameServer(AssetManager am, int port) {
        super(port);
        this.assets = am;
    }

    /**
     * 设置/更新 PC 接收端地址。传入 null 表示断开（/api 会返回 503，游戏侧退避重连）。
     * 可反复调用；游戏页面无需重载。
     */
    public void setPcBase(String base) {
        this.pcBase = base;
        Log.i(TAG, "PC 接收端基址 -> " + base);
    }

    public String getPcBase() {
        return pcBase;
    }

    /**
     * ★ 第十七修：挂载/更新「直播端下发的轻量配置」覆盖层。可反复调用（换局、重新下发都要调）。
     *
     * @param dir   覆盖层根目录（filesDir/game-overlay）；null = 清空（视为无覆盖层）
     * @param paths 受管路径清单（session.json 里的 `paths`）；null/空 = 只做「有就优先用」，
     *              不做「缺失即 404」的硬拦截
     */
    public void setOverlay(java.io.File dir, java.util.List<String> paths) {
        this.overlayDir = dir;
        java.util.Set<String> set = new java.util.HashSet<>();
        if (paths != null) {
            for (String p : paths) {
                if (p != null && !p.isEmpty()) set.add(p.startsWith("/") ? p.substring(1) : p);
            }
        }
        this.overlayPaths = java.util.Collections.unmodifiableSet(set);
        Log.i(TAG, "覆盖层 -> " + (dir == null ? "（未启用）" : dir.getAbsolutePath())
                + "，受管路径 " + set.size() + " 个"
                + (set.isEmpty() ? "（空 ⇒ 受管路径会 404，门禁为硬）" : ""));
    }

    /** 设置 VR+ 平台桥接（游戏页无法发裸 UDP，由 APK 原生层收发后经 /api/vrplus/* 暴露） */
    public void setVRPlus(VRPlusLink v) {
        this.vrplus = v;
        Log.i(TAG, "VR+ 桥接已挂载");
    }

    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();
        if (uri == null || uri.isEmpty() || uri.equals("/")) {
            uri = "/index.html";
        }

        // VR+ 平台桥接端点（优先于通用 /api 代理；游戏页无法发裸 UDP，走原生层）
        if (uri.startsWith("/api/vrplus/")) {
            return vrplusApi(session, uri);
        }

        // 「游戏页死亡留痕」端点 —— ⚠ 必须排在下面的通用 /api 代理**之前**，
        // 否则 /api/page/* 会被当成资源代理转发到 PC（没接 PC 时直接 503 no-pc），
        // 页面的死因上报会在最后一步静默丢掉 —— 那正好是最需要它的时刻。
        if (uri.startsWith("/api/page/")) {
            return pageApi(session, uri);
        }

        // ★ 第十五修：页面查询「本次启动是否已获直播端放行」（LaunchGuard 的结论缓存）。
        //   ⚠ 必须排在下面通用 /api 代理**之前** —— 否则会被转发到 PC（PC 无此端点 → 404），
        //   页面据此会永远认为「未授权」，门禁再也打不开。
        if (uri.equals("/api/guard")) {
            return guardApi();
        }

        // 信令/帧代理：页面始终请求同源 /api/*，由本服务转发到 PC
        if (uri.startsWith("/api/")) {
            return proxyApi(session, uri);
        }

        // 静态资源：**本地优先** —— assets/game 就是游戏本体，与 PC 无关。
        // 关键：页面 origin 仍是 http://localhost → 仍是 WebXR 安全上下文（PICO 浏览器才会暴露
        // navigator.xr，否则掉进「桌面模式 需 https/头显」）。
        // 资源取哪里见下方：先包内，包内没有才回退 PC 代理。

        // 防目录穿越：去掉 .. 与反斜杠
        String rel = uri.replace("..", "").replace('\\', '/');
        if (rel.startsWith("/")) rel = rel.substring(1);
        if (rel.endsWith("/")) rel += "index.html";

        // ★ 第十七修：覆盖层优先 —— 直播端下发的「轻量配置」在这里生效，**排在 PC 代理与 assets 之前**。
        //   为什么必须排在 PC 代理之前：这些文件是「授权才拿到」的钥匙，若仍能从 PC 实时代理到，
        //   门禁就退化成软校验（没授权也照样跑）。两种情况要分清：
        //     · 受管路径**文件存在** → 用覆盖层那份；
        //     · 受管路径**文件缺失**（没授权过 / 换局后还没重下）→ 明确 404，**绝不回落 assets**
        //       —— 这才是「文件齐全才跑得起来」。
        //   非受管路径（GLB / 全景图等重资源）不受影响，照常走 PC 代理 / assets。
        if (overlayPaths.contains(rel)) {
            java.io.File ov = overlayDir == null ? null : new java.io.File(overlayDir, rel);
            if (ov == null || !ov.isFile()) {
                Log.w(TAG, "覆盖层缺少受管文件（不回落 assets）：" + rel);
                return newFixedLengthResponse(Response.Status.NOT_FOUND,
                        "text/plain; charset=utf-8", "config-missing " + rel);
            }
            try {
                String ext = rel.contains(".") ? rel.substring(rel.lastIndexOf('.')) : "";
                String mime = MIME.getOrDefault(ext, "text/plain; charset=utf-8");
                return newChunkedResponse(Response.Status.OK, mime, new java.io.FileInputStream(ov));
            } catch (Exception e) {
                Log.w(TAG, "覆盖层文件读取失败：" + rel + " " + e.getMessage());
                return newFixedLengthResponse(Response.Status.NOT_FOUND,
                        "text/plain; charset=utf-8", "config-unreadable " + rel);
            }
        }

        // ★ 第二十二修（档１）：删掉了旧的「发现 PC 后一律代理到 PC」——
        //   PC 端已撤掉整站托管（路径②停用），若仍先代理，`GET /index.html` 会被
        //   代理成 404 → 整个游戏页打不开（白屏）。页面本体本来就在包里，没有理由
        //   绕一圈去问 PC；而且包内响应快、无网络依赖，现场 PC 掉线也照样能玩。
        //   兜底保留：**包内确实没有**这份文件时才用 PC 代理（正常不会命中；
        //   现场万一少个重资源能救）。受管路径（config 覆盖层）已在上方直接 return，
        //   不会走到这里退化成软校验。
        String assetPath = BASE + "/" + rel;

        try {
            InputStream is = assets.open(assetPath);
            String ext = assetPath.contains(".") ? assetPath.substring(assetPath.lastIndexOf('.')) : "";
            String mime = MIME.getOrDefault(ext, "application/octet-stream");
            return newChunkedResponse(Response.Status.OK, mime, is);
        } catch (IOException e) {
            if (pcBase != null) {
                Log.w(TAG, "包内缺少 " + rel + " → 回退 PC 代理兜底");
                return proxyStatic(session, uri);
            }
            return newFixedLengthResponse(
                    Response.Status.NOT_FOUND, "text/plain; charset=utf-8", "404 " + rel);
        }
    }

    // ───────────────── ★ 第十五修：启动授权查询（/api/guard） ─────────────────
    /**
     * 页面启动时问一次：本进程这次的启动**有没有通过 LaunchGuard**（见 MainActivity.guardPass）。
     * 页面据此决定「进入 VR」按钮给不给（未授权就直接遮住，连预览都不让进 VR）。
     * 返回值同时带上 age（结论距今毫秒）与 why（原因），便于留痕与现场排查。
     */
    private Response guardApi() {
        String json = "{\"ok\":" + MainActivity.guardOk()
                + ",\"age\":" + MainActivity.guardAgeMs()
                // ★ 第十七修：把「下发了几个配置文件」也带上 —— 现场排障时这比任何推断都直接
                //   （0 = 配置没下来，游戏必然跑不起来；见 GameServer 覆盖层逻辑）
                + ",\"overlay\":" + MainActivity.guardOverlayCount()
                // ★ 2026-09-23（平台对接第 3 条）：把 EXE 签发的**放行条**也带上 ——
                //   游戏页拿它 POST /api/master/allow（经本服务代理到 PC）做独立复验。
                //   空串 = 这次没拿到放行条，页面会退回「以本结论为准」（见 src/main.js）。
                + ",\"dev\":\"" + jstr(MainActivity.guardDev0()) + "\""
                + ",\"exp\":\"" + jstr(MainActivity.guardExp0()) + "\""
                + ",\"voucher\":\"" + jstr(MainActivity.guardVoucher0()) + "\""
                + ",\"why\":\"" + MainActivity.guardWhy() + "\"}";
        return cors(newFixedLengthResponse(Response.Status.OK, "application/json", json));
    }

    // ───────────────── VR+ 平台桥接（/api/vrplus/*） ─────────────────
    // 游戏页（PICO 浏览器，origin=http://localhost:8080）与 GameServer 同源，
    // 这些端点无 CORS 问题；协议细节见 VRPlusLink.java。
    private Response vrplusApi(IHTTPSession session, String uri) {
        lastPageHitMs = System.currentTimeMillis();   // 页面心跳打点（判断游戏页是否存活）
        Method method = session.getMethod();

        // ⚠「桥接没挂载」≠「APK 已死」——绝不能回 503/404。
        // 游戏侧 startAliveWatch 只在 fetch **失败**（连不上 localhost:8080）时才判定 APK 死亡并卸载页面；
        // 若此处回 503，游戏页会把它当成非 200 失败累计次数 → 误判 APK 死了 → 自己 replace('about:blank')
        // → 玩家看到「闪退」（APK 刚重启 / 平台尚未下发 -d 时极易触发）。
        // 因此统一回 200，用 connected 字段表达「平台是否在线」。
        if (vrplus == null) {
            if (uri.equals("/api/vrplus/inbox")) {
                return cors(newFixedLengthResponse(Response.Status.OK, "application/json", "[]"));
            }
            return cors(newFixedLengthResponse(Response.Status.OK, "application/json",
                    "{\"connected\":false,\"bridgeReady\":false}"));
        }

        if (uri.equals("/api/vrplus/status")) {
            // 查询平台在线状态（握手是否完成）。
            // 2026-09-17 增加 platform 字段，便于页面诊断条一眼看出「平台地址锁没锁对」。
            // ⚠ connected 的唯一判据是**收到机位表**（抓包实测；1 字节杂散帧不作数）。
            // 旧的 identified 字段（0x08 身份上报）已随该帧一并删除 —— 玩家侧不发 0x08。
            String plat = vrplus.host();
            return cors(newFixedLengthResponse(Response.Status.OK, "application/json",
                    "{\"connected\":" + vrplus.isConnected()
                            + ",\"bridgeReady\":true"
                            + ",\"platform\":" + (plat == null ? "null" : JSONObject.quote(plat)) + "}"));
        }
        if (uri.equals("/api/vrplus/inbox")) {
            // ★ 诊断（2026-09-19）：页面每次轮询都把「当时的进度/状态」带上来（?pct=&st=&pd=&xr=&cs=），
            //   落到 PageForensics 的统一时间线磁盘文件里。这样**页面万一当场消失**，
            //   仍能从 APK 侧看到「它死之前进度是多少、什么状态、XR 起没起」——
            //   这正是前几轮靠猜「进度条跑到一半就闪退」时最缺的一条证据。
            //   页面侧见 src/net/vrplus.js 的 pollInbox（附在既有轮询请求上，零额外请求）。
            //   cs=1 = 页面处于「本局已结束」待机态（平台关闭后页面保留不卸载，见 game.js）。
            //   MainActivity 需要它来判断「页面活着但已收工」→ 平台下次开始时该唤醒而不是重开浏览器。
            try {
                Map<String, String> q = session.getParms();
                if (q != null) {
                    int pct = -1;
                    try { pct = Integer.parseInt(q.get("pct")); } catch (Throwable ignore2) { /* 缺省 -1 */ }
                    String st = q.get("st");
                    lastPageState = (st == null) ? "?" : st;
                    lastPageClosed = "1".equals(q.get("cs"));
                    PageForensics.state(pct, lastPageState,
                            "1".equals(q.get("pd")), "1".equals(q.get("xr")), lastPageClosed);
                }
            } catch (Throwable ignore) { /* 诊断失败绝不影响协议 */ }
            // 拉取平台下行命令（游戏侧轮询；平台可能远程下发 关闭游戏 等控制）
            List<JSONObject> cmds = vrplus.drainInbox();
            // ★ 诊断（2026-09-17）：把每次真正下发的内容打出来。排查「页面莫名自杀」时，
            //   日志里出现 cmd=16 且带着「几毫秒/几秒前入队」的 t，就能一眼分辨这是**本局平台
            //   真下的关闭指令**，还是**上一会话残留被新页面捡走**（后者 = 打开即闪退的根因）。
            if (!cmds.isEmpty()) {
                StringBuilder sb = new StringBuilder();
                for (JSONObject o : cmds) {
                    long age = System.currentTimeMillis() - o.optLong("t", 0);
                    sb.append("cmd=").append(o.optInt("cmd", -1))
                      .append("/n").append(o.optInt("n", -1))
                      .append("(").append(age).append("ms前) ");
                }
                android.util.Log.i("VRPlus", "→ 页面轮询取走 " + cmds.size() + " 条下行：" + sb);
            }
            return cors(newFixedLengthResponse(Response.Status.OK, "application/json",
                    new JSONArray(cmds).toString()));
        }
        if (uri.equals("/api/vrplus/send") && method == Method.POST) {
            // 游戏上行命令。⚠ 玩家侧上行**只有 0x01(注册) 与 0x02(closeGame 确认)** 两种；
            // 其他值（旧 V2.9 的 3/4/5/6、或本就属主机侧的 8）会被 VRPlusLink 拒绝并打日志。
            try {
                byte[] body = readBody(session);
                JSONObject jo = new JSONObject(
                        new String(body, java.nio.charset.StandardCharsets.UTF_8));
                vrplus.sendCommand(jo.getInt("cmd"));
                return cors(newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}"));
            } catch (Exception e) {
                return cors(newFixedLengthResponse(Response.Status.BAD_REQUEST, "text/plain", e.getMessage()));
            }
        }
        return cors(newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "404"));
    }

    /** 最近一次「游戏页自己发出的」请求时刻（ms）；0 = 从未请求过。语义见 lastPageHitMs 字段注释。 */
    public long lastPageHitMs() { return lastPageHitMs; }

    /** 页面最近一次上报的游戏状态（?st=），未知时返回 "?" */
    public String lastPageState() { return lastPageState; }

    /** 页面是否处于「本局已结束」待机态（?cs=1） */
    public boolean lastPageClosed() { return lastPageClosed; }

    // ───────────────── 「游戏页死亡留痕」(/api/page/*) ─────────────────
    // 页面 origin = http://localhost:8080，与本站点同源 → 无 CORS/PNA 问题。
    //   POST /api/page/dead      ← 页面即将消失前用 sendBeacon 发的死因（body 自由格式，一行 JSON）
    //   POST /api/page/event     ← 生命周期事件（可见性变化 / pagehide / freeze / 未捕获异常 …）
    //   GET  /api/page/forensics → 纯文本尾部；浏览器直接打开即可读，**免 adb、免连线**
    // 全部落进 PageForensics 的同一个磁盘文件（APK 被 force-stop 后依然在），
    // 这样「进度条跑到一半就没了」那一刻是谁动的手，事后能直接读出来。
    private Response pageApi(IHTTPSession session, String uri) {
        // ★ 页面**自己**发来的事件 = 「游戏页还活着」的直接证据，与 /api/vrplus/* 同等计入。
        //   但 /api/page/forensics 是给人/浏览器读留痕的诊断入口，不能算活体信号 ——
        //   否则人一打开留痕页，就等于替已经死掉的游戏页「续命」，失联判定永远不成立。
        if (!uri.equals("/api/page/forensics")) {
            lastPageHitMs = System.currentTimeMillis();
        }
        Method method = session.getMethod();
        if (uri.equals("/api/page/forensics")) {
            // ── 读留痕的三种姿势（2026-09-19 四修：不再逼着人拿头显拍照）──
            //   /api/page/forensics              纯文本，尾部 300 行（头显浏览器里看，短、够用）
            //   /api/page/forensics?follow=1     同上，但包成「每 2 秒自动刷新」的深色网页 ——
            //                                    在**电脑浏览器**里挂着，等于实时看头显日志
            //   /api/page/forensics?download=1   带 Content-Disposition 的**全文**附件 ——
            //                                    电脑上点一下就把 page-forensics.log 存到本地，
            //                                    直接把文件发给对方（不用截图、不丢行、可搜索）
            // ⚠ 电脑上要用**头显的局域网 IP**（如 http://192.168.31.242:8080/api/page/forensics），
            //   不是 localhost —— localhost 指的是电脑自己。APK 进程活着时才连得上；
            //   但留痕文件本身跨 force-stop 存活，APK 一被平台拉回来就能读到之前那段。
            Map<String, String> q = session.getParms();
            if ("1".equals(q.get("download"))) {
                Response r = newFixedLengthResponse(Response.Status.OK, "text/plain; charset=utf-8",
                        PageForensics.full());
                r.addHeader("Content-Disposition", "attachment; filename=\"page-forensics.log\"");
                return cors(r);
            }
            if ("1".equals(q.get("follow"))) {
                String body = "<!doctype html><meta charset='utf-8'><title>留痕 follow</title>"
                        + "<meta http-equiv='refresh' content='2'>"
                        + "<body style='margin:0;background:#0b0d10;color:#dfe4ea;"
                        + "font:13px/1.55 ui-monospace,Consolas,monospace'>"
                        + "<div style='padding:8px 12px;background:#161a20;color:#8ab4d8;font-family:sans-serif'>"
                        + "每 2 秒自动刷新 &nbsp;|&nbsp; 全文下载：<a style='color:#7fd1a8' href='?download=1'>"
                        + "/api/page/forensics?download=1</a></div>"
                        + "<pre style='padding:10px 12px;white-space:pre-wrap;word-break:break-all'>"
                        + htmlEscape(PageForensics.tail(300)) + "</pre></body>";
                return cors(newFixedLengthResponse(Response.Status.OK, "text/html; charset=utf-8", body));
            }
            return cors(newFixedLengthResponse(Response.Status.OK, "text/plain; charset=utf-8",
                    PageForensics.tail(300)));
        }
        if (method != Method.POST) {
            return cors(newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "404"));
        }
        try {
            byte[] body = readBody(session);
            String t = new String(body, java.nio.charset.StandardCharsets.UTF_8).trim();
            if (t.length() > 600) t = t.substring(0, 600);   // 单条限长：防止异常风暴把文件刷爆
            if (uri.equals("/api/page/dead")) {
                PageForensics.line("PAGE-DEAD", t);
            } else if (uri.equals("/api/page/event")) {
                PageForensics.line("PAGE", t);
                // ★ 第十修：页面自己报「本局结束」→ 交给「退出策略」（唤醒平台客户端 / 关浏览器）。
                notifyGameEndIfAny(t);
            } else {
                return cors(newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "404"));
            }
            return cors(newFixedLengthResponse(Response.Status.OK, "text/plain", "ok"));
        } catch (Exception e) {
            return cors(newFixedLengthResponse(Response.Status.BAD_REQUEST, "text/plain",
                    e.getClass().getSimpleName()));
        }
    }

    /**
     * 页面「本局结束」（`{"ev":"game-end",...}`）→ 触发退出策略回调（CastApp 注入）。
     *
     * 为什么由页面报，而不是 APK 自己看状态：**平台不一定发 closeGame**（玩家打输、通关、或者
     * 操作员在头显里退出 VR 都会结束本局），而这些结束动作只有页面自己知道。
     *
     * ⚠ `cast:true`（`?cast=1` 直播模式，玩家用自己的 PC 端 exe 看大屏）→ **不动**：
     *   那种场景下浏览器就是被直播的源，关掉浏览器 = 直播中断。
     */
    private void notifyGameEndIfAny(String json) {
        try {
            if (json == null || json.indexOf("game-end") < 0) return;   // 快速排除（99% 的事件都不含它）
            JSONObject o = new JSONObject(json);
            if (!"game-end".equals(o.optString("ev"))) return;
            final boolean cast = o.optBoolean("cast", false);
            // ★ 第十八修（2026-09-23）：区分「本轮真的结束」与「玩家自己退出 VR」。
            //   roundOver = 通关 / 平台关闭 / 主控端点了「结束本局」（见 game.js 的 _reportGameEnd）。
            //   · 非直播（平台投屏）：照旧执行退出策略；
            //   · 直播（?cast=1）：**只有本轮真的结束**才执行 —— 玩家自己退 VR 时那一局还在进行，
            //     浏览器就是推流源，关掉 = 直播中断（旧行为，保留）。
            final boolean roundOver = o.optBoolean("roundOver", false);
            if (cast && !roundOver) {
                PageForensics.line("APK", "页面上报本局结束（玩家自己退出 VR），当前是直播模式（?cast=1）"
                        + " → 不执行退出策略");
                return;
            }
            if (cast) {
                // 直播模式下「本轮结束」必须把页面/浏览器收干净 —— 用户第三次现场实测：
                // 「由于游戏结束后只是在浏览器里提示，没有关闭浏览器，导致头显再次调起游戏后无法
                // 连接 PC 端直播」（上一页的 WebRTC/信令还挂着，新页面抢不到推流端席位）。
                // 页面侧已经 replace('about:blank') 收工（见 game.js），这里再把浏览器一并收掉。
                sCastRoundOver = true;
                PageForensics.line("APK", "直播模式：本局结束（roundOver）→ 允许退出策略关闭浏览器");
            }
            Runnable r = sOnGameEnd;
            if (r == null) {
                PageForensics.line("APK", "页面上报本局结束，但退出策略回调未注入（CastApp 未启动？）");
                return;
            }
            r.run();
        } catch (Throwable e) {
            PageForensics.line("APK", "解析 game-end 事件失败（忽略）: " + e.getClass().getSimpleName());
        }
    }

    /** 页面报「本局结束」时的回调（由 CastApp 注入，在主线程执行）。见 notifyGameEndIfAny。 */
    public static volatile Runnable sOnGameEnd = null;

    /**
     * ★ 第十八修：本次退出策略是不是「直播模式 + 本轮真的结束」（见 notifyGameEndIfAny）。
     * 供 MainActivity.restoreClientAndCloseBrowser 判断 —— 这种场合**必须**把浏览器收掉：
     * 它已经不再是有效的推流源（页面自己收工了），留着只会让下一局抢不到 PC 的推流端席位。
     */
    public static volatile boolean sCastRoundOver = false;

    /** 最小 HTML 转义（只用于把留痕文本塞进 &lt;pre&gt;，防页面结构被日志内容破坏） */
    /** 极简 JSON 字符串转义（放行条是纯 hex，实际不会被转义；这里只为不破坏 JSON 结构）。 */
    private static String jstr(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static String htmlEscape(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    // ───────────────── /api/* 转发到 PC 接收端 ─────────────────

    private Response proxyApi(IHTTPSession session, String uri) {
        final String base = pcBase;
        if (base == null) {
            // 尚未发现 PC：返回 503，游戏侧 Signaling 会按退避策略重连
            return cors(newFixedLengthResponse(
                    Response.Status.SERVICE_UNAVAILABLE, "text/plain; charset=utf-8", "no-pc"));
        }

        Method method = session.getMethod();
        // role 是 /api/events 的唯一查询参数（publisher / viewer）
        String role = session.getParms().get("role");
        String query = (role != null) ? ("?role=" + role) : "";
        String target = base + uri + query;

        // 帧转发（/api/frame）：高频、无需响应，走后台线程异步转发 + 立即返回，
        // 避免阻塞 NanoHTTPD 连接（否则同一连接的下一帧 POST 必须等本帧完整 RTT 走完 →
        // 帧与帧串行排队，在 PICO 局域网下被压到约 0.2fps，表现为「5 秒才动一下」）。
        if (method == Method.POST && uri.endsWith("/frame")) {
            byte[] payload = readBody(session);   // 必须在主线程读全 body（session 流随响应返回被关闭）
            forwardFrameAsync(payload);           // 后台线程发给 PC，不阻塞
            return cors(newFixedLengthResponse(
                    Response.Status.OK, "text/plain; charset=utf-8", "queued"));
        }

        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(target).openConnection();
            conn.setConnectTimeout(5000);
            conn.setRequestMethod(method == Method.POST ? "POST" : "GET");
            conn.setDoInput(true);
            conn.setInstanceFollowRedirects(false);

            if (method == Method.POST) {
                byte[] payload = readBody(session);
                conn.setDoOutput(true);
                String ct = session.getHeaders().get("content-type");
                conn.setRequestProperty("Content-Type", ct != null ? ct : "application/octet-stream");
                conn.setFixedLengthStreamingMode(payload.length);
                OutputStream os = conn.getOutputStream();
                os.write(payload);
                os.flush();
                os.close();
            } else {
                conn.setRequestProperty("Accept", "text/event-stream");
                conn.setReadTimeout(0);        // SSE 长连接：不设读超时
            }

            int code = conn.getResponseCode();
            String ctype = conn.getHeaderField("Content-Type");
            if (ctype == null || ctype.isEmpty()) ctype = "application/octet-stream";
            Response.Status st = Response.Status.lookup(code);

            if (method == Method.POST) {
                // 上行（offer/answer/ice/frame）：短响应，读全后原样返回
                InputStream in = (code >= 400) ? conn.getErrorStream() : conn.getInputStream();
                byte[] body = readAll(in);
                return cors(newFixedLengthResponse(st, ctype, new String(body, "UTF-8")));
            }

            // SSE 下行：用 Piped 流在后台线程把上游字节「一收到就转发出去」。
            // 关键修复：直接把 conn.getInputStream() 交给 NanoHTTPD 的 chunked 响应时，
            // 某些 NanoHTTPD 版本会对「永不结束的 SSE 流」做整段缓冲，导致头显的 EventSource
            // 永远收不到 peer-ready / answer / ice，推流端也就永不发起 offer。
            // 改为后台线程边读边写 PipedOutputStream，NanoHTTPD 从 PipedInputStream 读到一块就
            // 立刻 flush 一块，彻底消除缓冲，长连接稳定流式转发。
            InputStream upstream = (code >= 400) ? conn.getErrorStream() : conn.getInputStream();
            final PipedInputStream pin = new PipedInputStream(16 * 1024);
            final PipedOutputStream pout = new PipedOutputStream(pin);
            final InputStream up = upstream;
            Thread pump = new Thread(() -> {
                byte[] buf = new byte[4096];
                int n;
                try {
                    while ((n = up.read(buf)) > 0) {     // 上游每来一块就写一块
                        pout.write(buf, 0, n);
                        pout.flush();                    // 立即冲刷，头显端 EventSource 立刻收到事件
                    }
                } catch (IOException ignore) {
                    // 客户端断开 / 上游关闭都会走到这里，直接结束泵送即可
                } finally {
                    try { up.close(); } catch (IOException ignore) {}
                    try { pout.close(); } catch (IOException ignore) {}
                }
            });
            pump.setName("sse-pump");
            pump.setDaemon(true);
            pump.start();
            Response r = newChunkedResponse(st, ctype, pin);
            r.addHeader("Cache-Control", "no-cache, no-transform");
            r.addHeader("X-Accel-Buffering", "no");
            return cors(r);
        } catch (Exception e) {
            Log.w(TAG, "代理失败 " + target + " : " + e.getMessage());
            // 注：NanoHTTPD 的 Status 枚举没有 502(BAD_GATEWAY)，代理异常统一用 500 表示
            return cors(newFixedLengthResponse(
                    Response.Status.INTERNAL_ERROR, "text/plain; charset=utf-8", "proxy error"));
        }
    }

    /**
     * 帧异步转发：在后台线程把 JPEG 帧 POST 给 PC，不阻塞 NanoHTTPD 的主请求线程。
     * 关键：NanoHTTPD 同一 TCP 连接的请求是串行的，若在此线程同步等 PC 响应，头显的下一帧
     * POST 必须排队等本帧 RTT 走完 → 帧率被压到 0.x fps（「5 秒才动一下」）。改为后台转发 +
     * 主线程立即返回后，连接立即空闲，头显可立刻发下一帧，链路变成真正的生产-消费管道。
     */
    private void forwardFrameAsync(final byte[] payload) {
        final String base = pcBase;
        if (base == null || payload.length == 0) return;
        Thread t = new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(base + "/api/frame").openConnection();
                conn.setConnectTimeout(5000);
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                conn.setInstanceFollowRedirects(false);
                conn.setFixedLengthStreamingMode(payload.length);
                conn.setRequestProperty("Content-Type", "application/octet-stream");
                OutputStream os = conn.getOutputStream();
                os.write(payload);
                os.flush();
                os.close();
                conn.getResponseCode();        // 触发发送并确认 PC 已收（忽略响应体）
            } catch (Exception e) {
                Log.w(TAG, "帧转发失败: " + e.getMessage());
            } finally {
                if (conn != null) try { conn.disconnect(); } catch (Exception ignore) {}
            }
        });
        t.setName("frame-fwd");
        t.setDaemon(true);
        t.start();
    }

    /**
     * 把游戏静态资源（HTML/JS/GLB/图片…）同源代理到 PC 接收端。
     *
     * ★ 第二十二修（档１）：本方法已降级为**兜底** —— 仅当包内 assets/game 确实没有该文件时才调用
     * （见 serve() 的静态分支）。之前它是首选路径，依赖 PC 端托管整站；
     * 随着路径②停用，那条路已不存在，故一律以包内为准。页面 origin 始终是
     * http://localhost → WebXR 安全上下文不变。
     * 普通短响应，读全后原样返回（用 ByteArrayInputStream 保留二进制，避免按 String 破坏 glb/图片）。
     */
    private Response proxyStatic(IHTTPSession session, String uri) {
        String query = session.getQueryParameterString();
        String target = pcBase + uri + (query != null && !query.isEmpty() ? ("?" + query) : "");
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(target).openConnection();
            conn.setConnectTimeout(5000);
            conn.setInstanceFollowRedirects(false);
            Method method = session.getMethod();
            conn.setRequestMethod(method == Method.POST ? "POST" : "GET");

            if (method == Method.POST) {
                byte[] payload = readBody(session);
                conn.setDoOutput(true);
                String ct = session.getHeaders().get("content-type");
                conn.setRequestProperty("Content-Type", ct != null ? ct : "application/octet-stream");
                conn.setFixedLengthStreamingMode(payload.length);
                OutputStream os = conn.getOutputStream();
                os.write(payload);
                os.flush();
                os.close();
            }

            int code = conn.getResponseCode();
            String ctype = conn.getHeaderField("Content-Type");
            if (ctype == null || ctype.isEmpty()) ctype = "application/octet-stream";
            InputStream in = (code >= 400) ? conn.getErrorStream() : conn.getInputStream();
            byte[] body = readAll(in);
            Response.Status st = Response.Status.lookup(code);
            Response r = newFixedLengthResponse(st, ctype, new ByteArrayInputStream(body), body.length);
            return cors(r);
        } catch (Exception e) {
            Log.w(TAG, "静态代理失败 " + target + " : " + e.getMessage());
            return cors(newFixedLengthResponse(
                    Response.Status.INTERNAL_ERROR, "text/plain; charset=utf-8", "proxy error"));
        }
    }

    /**
     * 读取 POST 原始 body（JSON 信令 / JPEG 二进制帧统一按字节处理）。
     *
     * 注意：不能用 session.parseBody() + files.get("postData")。NanoHTTPD 只对
     * multipart/form-data 与 x-www-form-urlencoded 做解析，遇到 application/json 会把
     * 整段 JSON 当成 urlencoded 的一个「键」（值为空）塞进 parms，postData 恒为 null ——
     * 结果是 offer/answer 的 body 被丢弃、转发给 PC 的是空包，接收端永远收不到 offer。
     * 因此这里直接按 Content-Length 从原始输入流读取，不经过任何解析。
     */
    private static byte[] readBody(IHTTPSession session) {
        int len = 0;
        for (Map.Entry<String, String> e : session.getHeaders().entrySet()) {
            if ("content-length".equalsIgnoreCase(e.getKey())) {
                try { len = Integer.parseInt(e.getValue().trim()); } catch (Exception ignore) { /* 非法长度按 0 处理 */ }
                break;
            }
        }
        if (len <= 0) return new byte[0];

        try {
            InputStream in = session.getInputStream();
            byte[] buf = new byte[len];
            int off = 0;
            while (off < len) {
                int r = in.read(buf, off, len - off);
                if (r < 0) break;
                off += r;
            }
            return (off == len) ? buf : java.util.Arrays.copyOf(buf, off);
        } catch (IOException e) {
            Log.w(TAG, "读取请求体失败: " + e.getMessage());
            return new byte[0];
        }
    }

    private static byte[] readAll(InputStream in) {
        if (in == null) return new byte[0];
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        try {
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
        } catch (IOException ignore) { /* 流提前关闭按已读内容处理 */ }
        return bos.toByteArray();
    }

    /** 同源场景本不需要 CORS，保留以防页面从其它来源（如 PICO 浏览器调试）直连。 */
    private static Response cors(Response r) {
        r.addHeader("Access-Control-Allow-Origin", "*");
        r.addHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        r.addHeader("Access-Control-Allow-Headers", "Content-Type");
        return r;
    }
}
