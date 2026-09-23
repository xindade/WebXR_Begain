package com.local.webxrcast;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * VR+ 平台桥接（APK 原生层）—— 即「接收器」/ 游戏侧。
 * 平台按包名拉起本 APK；本类负责与平台的 **UDP 游戏通道** 收发，并把平台下行命令经
 * /api/vrplus/* 透传给 PICO 浏览器里的游戏页。
 *
 * ══ 职责边界（2026-09-17 完整会话抓包 + 平台侧日志双证）═════════════════════
 *   平台只有两条通道，本类**只管第 ①条**：
 *     ① **游戏通道**：本机 bind 51124 ← 平台；本机 → 平台 51234。   ← 本类
 *     ② **启动器通道**：UDP，设备监听 62135 / 平台监听 62136（connect 走广播），承载
 *        connect/checkconnect/packagesinfo/connectsuccess/copyfile/start/kill/logcat。
 *        由头显上的 com.GoodNet.LauncherClient 承担，**不归本类**（保活也在那条通道上）。
 *
 * ══ 游戏通道的**全部**帧（cap3.pcap：一次健康会话 120s / 27216 包，实测）═══════
 *   | 帧                          | 方向      | 含义 / 平台侧日志                                   |
 *   |-----------------------------|-----------|-----------------------------------------------------|
 *   | `01`               (1B)     | 设备→平台 | 注册；平台记 `===ReceiveCall==IP==..,,cmd = 1`        |
 *   | `01 02` + JSON     (360B)   | 平台→设备 | 机位表 `{"Machines":[...],...}`；**57ms** 后就回      |
 *   | `10 closeGame␠␠`  (12B)     | 平台→设备 | 关游戏（`\x10` + `"closeGame"` + **两个空格**）；平台记 `SendCloseGameToGame == closeGame` |
 *   | `02`               (1B)     | 设备→平台 | closeGame 确认；**7ms** 后就回                        |
 *
 *   ⇒ **上行合法集只有 `0x01` 与 `0x02`。玩家侧不发 `0x08`。**
 *     （曾误以为「收到机位表要回 0x08，否则平台每 20s 重拉 am start」——抓包证明是错的：
 *      整个会话搜不到任何 `0x08`；平台全程只发一次 `start`（07:52:42），6 秒后游戏注册即静默 94 秒。
 *      平台日志里 `收到客户端发来的消息啦8` 比玩家侧 `cmd = 1` **早 7 秒**，属 IsHost=1 的主机侧。）
 *   ⇒ 游戏通道**没有保活要求**，注册后不必再发。反倒是每次 `cmd = 1` 都会让平台重跑一遍
 *     「回机位表 + SetPlayerName」，高频心跳纯属噪音。故本类策略 = **收到机位表即停**。
 *
 * ══ 端口 ════════════════════════════════════════════════════════════════════
 *   P2OthersConfig.json → GameConfig：sendUDPPort=51124（平台发） / recvUDPPort=51234（平台收）。
 *   真实游戏日志：`VRPlatformHelper LocalIP:192.168.31.228:51124, R:<平台>:51124, S:<平台>:51234`
 *   ⇒ 本机 bind 51124，向 <平台>:51234 发。
 *   ⚠ **必须用「监听 51124 的那个 socket」发送**（抓包实测：源端口就是 51124）。
 *     若用临时端口发，平台的回包会打到那个临时端口上，而我们在 51124 上永远等不到机位表。
 *
 * ══ 平台地址从哪来 ══════════════════════════════════════════════════════════
 *   `am start -d <IP>`（= 启动器 start 报文第三段 `<路径>$<游戏名>$<平台IP>`）与
 *   `setup.xml` 的 `platformIP` **都指向平台**（后者运行时已被平台 copyfile 覆盖，游戏日志
 *   `SettingManager:LoadSetup()` → `===GetPlatformIP======192.168.31.237`）。
 *   ⇒ 两者都作为候选，持续向全部候选发 0x01，**谁回包谁被锁定为平台**（比猜一个稳）。
 *
 * ══ 历史坑（勿重犯）════════════════════════════════════════════════════════
 *   · 主线程 send → NetworkOnMainThreadException（getMessage() 为 null，日志只有「失败: null」）
 *     ⇒ socket 创建与**所有** send 一律在后台线程；失败日志必须带异常类名。
 *   · 「收到回包就停发 0x01」+ 之后再无补发 → 平台重拉时已静默，认为游戏没起来 →
 *     死循环重拉抢前台。⇒ 现在：未收到机位表前每 3s 重试（有上限），
 *     平台每次拉起后 `pokeHandshake()` 再补发一轮（平台此刻正在等 cmd1）。
 */
public class VRPlusLink {
    private static final String TAG = "VRPlus";       // 协议级日志
    private static final String TAG2 = "CastMain";    // 与主日志合并，一条 -s 命令看全链路

    private static final int SEND_PORT = 51234;       // 本机 → 平台（= 平台的 recvUDPPort）
    private static final int RECV_PORT = 51124;       // 平台 → 本机（= 平台的 sendUDPPort，本类监听）

    /**
     * `0x01` 重试间隔。真实游戏只发一次（57ms 就收到机位表），这里只做「没收到就重试」的兜底，
     * 间隔取 3s（比参考值宽松，避免与平台的机位表回包互相追赶）。
     */
    private static final int HANDSHAKE_MS = 3000;
    /** `0x01` 最多重试次数（40 × 3s ≈ 2 分钟）——超时即停，避免无平台时永久刷日志/发包。 */
    private static final int HANDSHAKE_MAX_TRIES = 40;
    /** 每 N 次重试打一条汇总日志 */
    private static final int LOG_EVERY = 5;

    // ── 帧类型 ──
    private static final byte FRAME_REGISTER   = 0x01;   // 设备 → 平台：注册（平台记 cmd = 1）
    private static final byte FRAME_CLOSE_ACK  = 0x02;   // 设备 → 平台：closeGame 确认
    private static final byte FRAME_CLOSE_GAME = 0x10;   // 平台 → 设备：closeGame
    /** 0xFF 是早期猜测的「在线应答」。实测平台**从不发 1 字节下行**，仅识别并打日志，不据此判在线。 */
    private static final byte FRAME_ONLINE_ACK = (byte) 0xFF;

    /**
     * 候选平台地址（**不是**单选）：
     *   ① 平台经启动器 `-d` 直推的 IP；② setup.xml 的 platformIP。
     * 持续向全部候选发 0x01，谁回包谁被锁定为 activeHost。
     */
    private final Set<String> hosts = Collections.synchronizedSet(new LinkedHashSet<String>());
    private volatile String activeHost = null;       // 已收到回包的地址（= 真平台）

    /** 平台是否已认到本机。**唯一判据 = 收到机位表**（抓包实测；1 字节杂散帧不改变它）。 */
    private volatile boolean connected = false;
    private volatile boolean running = true;

    /**
     * 平台「关闭游戏」（游戏通道 `0x10 closeGame`）回调 —— 由 CastApp 注入，在主线程执行。
     *
     * 用途（2026-09-19 第十修「退出策略」）：本局结束后要让**平台客户端回到前台**（否则操作员
     * 下一步在客户端上点「开始」会因为客户端被浏览器压在后台而没反应），必要时再关掉浏览器
     * 释放内存。见 MainActivity.restoreClientAndCloseBrowser。
     *
     * 为什么是 static：本类是进程级单例（跟随 GameServer 一起跨 Activity 存活），而回调要能
     * 在「MainActivity 已 finish（免打扰路径）」时照常触发 —— 不能挂在 Activity 实例上。
     */
    public static volatile Runnable sOnCloseGame = null;
    /** 游戏通道的唯一 socket：bind 51124 收 + 用同一个 socket 发（保证源端口 = 51124）。boot 线程创建。 */
    private volatile DatagramSocket sock;
    private Thread sender, receiver;
    private final ConcurrentLinkedQueue<JSONObject> downlink = new ConcurrentLinkedQueue<>();
    /** 下行项序号（诊断用：日志里能看出「这条是第几条」「是不是上一会话的残留」） */
    private final AtomicLong seq = new AtomicLong();

    /** socket 建好之前发出的命令会先排队；发送线程等到就绪才真正发包 */
    private final CountDownLatch ready = new CountDownLatch(1);

    /** 发送队列（单线程串行）：保证 send 永远不在主线程执行 */
    private final ExecutorService tx = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "vrplus-tx");
        t.setDaemon(true);
        return t;
    });

    public VRPlusLink(String host) {
        offerHost(host);
    }

    /**
     * 追加一个候选平台地址（`-d` 直推 IP / setup.xml 的 platformIP 都走这里）。
     * 返回 true = 这是个新地址（调用方可据此打日志）。
     */
    public boolean offerHost(String ip) {
        if (ip == null) return false;
        String v = ip.trim();
        if (v.isEmpty()) return false;
        boolean added = hosts.add(v);
        if (added) Log.i(TAG, "新增候选平台地址: " + v + "（当前候选 " + hosts.size() + " 个）");
        return added;
    }

    /**
     * 平台每次拉起我们时调用：立刻补发 3 轮 `0x01`（间隔 400ms，局域网 UDP 仍可能丢包）。
     * 平台的启动流程此刻正在等设备回 cmd1（抓包：`start` 后 6 秒游戏就注册了），
     * 所以这里必须「一被拉起就发」，不能等任何后续状态。
     * ⚠ 整轮补发（含期间的 sleep）都在 tx 后台线程内完成 —— 本方法可能在主线程被调用，
     *   绝不能在调用线程里 sleep（那会 ANR）。
     */
    public void pokeHandshake(String why) {
        tx.execute(() -> {
            try {
                ready.await(3, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                return;
            }
            if (sock == null || sock.isClosed()) return;
            for (int i = 0; i < 3; i++) {
                int ok = sendRegisterToAllHosts();
                Log.i(TAG, "补发 0x01 第 " + (i + 1) + "/3 轮（" + why + "）成功 " + ok + "/" + hosts.size());
                if (i < 2) {
                    try {
                        Thread.sleep(400);
                    } catch (InterruptedException e) {
                        return;
                    }
                }
            }
            Log.i(TAG2, "平台拉起 → 已补发 3 轮 0x01 注册（" + why + "）");
        });
    }

    /**
     * 启动桥接。**必须在后台线程建 socket**：DatagramSocket 的创建/绑定与收发都属网络操作，
     * 在 Activity.onCreate 的主线程里做会触发 NetworkOnMainThreadException（历史上被
     * catch(Exception) 吞掉，表现为「启动失败: null」且 sock 为 null → 之后所有命令都发不出去）。
     */
    public void start() {
        Thread boot = new Thread(() -> {
            try {
                sock = new DatagramSocket(RECV_PORT);   // 绑定 51124 监听平台回包
                Log.i(TAG, "桥接启动：监听 " + RECV_PORT + "，向 " + hosts + ":" + SEND_PORT
                        + " 发 0x01 注册（来源端口 = 51124；未收到机位表则每 "
                        + (HANDSHAKE_MS / 1000.0) + "s 重试，最多 " + HANDSHAKE_MAX_TRIES + " 次）");
                Log.i(TAG2, "VR+ 桥接启动：监听 51124，候选平台 " + hosts + "，端口 51234");
                receiver = new Thread(this::recvLoop);
                receiver.setDaemon(true);
                receiver.start();
                sender = new Thread(this::handshakeLoop);
                sender.setDaemon(true);
                sender.start();
            } catch (Throwable e) {
                Log.w(TAG, "启动失败: " + e.getClass().getSimpleName() + "/" + e.getMessage());
            } finally {
                ready.countDown();                      // 无论成败都放行发送队列
            }
        }, "vrplus-boot");
        boot.setDaemon(true);
        boot.start();
    }

    /**
     * 注册循环：**收到机位表就停**。
     *
     * 为什么不是常驻心跳：① 抓包实测真实游戏只发一次，之后静默 94 秒平台也不催；
     * ② 平台每收到一次 `cmd = 1` 都会重跑「回机位表 + `SetPlayerName`」，高频心跳会让平台
     *    每分钟重设房间 20 次（纯噪音，还可能打断房间状态）。
     * 为什么仍要重试：UDP 无重传，万一注册包丢了（或平台比我们晚起来），不重试就永远上不了线；
     * 实测平台在 `start` 后 6 秒内就会看到注册，故 3s × 最多 40 次（≈2 分钟）足够。
     */
    private void handshakeLoop() {
        int tick = 0;
        while (running && !connected && tick < HANDSHAKE_MAX_TRIES) {
            if (tick > 0) {
                try {
                    Thread.sleep(HANDSHAKE_MS);
                } catch (InterruptedException e) {
                    return;
                }
                if (!running || connected) break;
            }
            int ok = sendRegisterToAllHosts();
            tick++;
            if (tick == 1 || tick % LOG_EVERY == 0) {
                Log.i(TAG, "0x01 注册 → " + hosts + "（第 " + tick + "/" + HANDSHAKE_MAX_TRIES
                        + " 次，成功 " + ok + "/" + hosts.size() + "）");
                Log.i(TAG2, "VR+ 0x01 注册 → " + hosts + "（第 " + tick + " 次）");
            }
        }
        if (connected) {
            Log.i(TAG, "已收到机位表 → 停止 0x01 注册（贴合实测：注册只发一次）");
            Log.i(TAG2, "VR+ 已上线（收到机位表），停止 0x01 注册");
        } else if (running) {
            Log.w(TAG, "0x01 已重试 " + HANDSHAKE_MAX_TRIES + " 次仍未收到机位表 → 停止重试"
                    + "（平台没开？地址不对？候选 = " + hosts + "）");
            Log.w(TAG2, "VR+ 未收到机位表，已停止 0x01 重试（候选 " + hosts + "）");
        }
    }

    /**
     * 向全部候选平台地址发一帧裸字节 `0x01`。返回成功发出的数量。
     * 只在后台线程调用（socket.send 属网络操作）。
     */
    private int sendRegisterToAllHosts() {
        if (sock == null || sock.isClosed()) return 0;
        List<String> snap = new ArrayList<>(hosts);
        int ok = 0;
        for (String h : snap) {
            try {
                // ⚠ 用本 socket（已 bind 51124）发送 ⇒ 源端口 = 51124，与真实游戏一致
                sock.send(new DatagramPacket(new byte[]{FRAME_REGISTER}, 1,
                        InetAddress.getByName(h), SEND_PORT));
                ok++;
            } catch (Throwable e) {
                Log.w(TAG, "0x01 发送失败 " + h + ": "
                        + e.getClass().getSimpleName() + "/" + e.getMessage());
            }
        }
        return ok;
    }

    /**
     * 接收线程。游戏通道的报文**都带帧头**，所以不能直接整包当 JSON：
     *   · 单字节 → 帧类型（0x01/0xFF 只记日志，**不**判在线；其他值当命令透传）；
     *   · 首字节 0x10 且含 "closeGame" → 平台关游戏；
     *   · 其余 → **从第一个 `{` 截到最后一个 `}`** 再解析 JSON（剥掉 `0x01 0x02` 之类帧头）。
     *     ⚠ 旧实现直接 `new JSONObject(整包)` → 帧头让构造抛异常 → **整条机位表被丢弃**，
     *       平台的连接确认永远收不到（本项目真实 bug，2026-09-17 抓包钉死）。
     */
    private void recvLoop() {
        byte[] b = new byte[4096];
        DatagramPacket p = new DatagramPacket(b, b.length);
        while (running) {
            try {
                sock.receive(p);
                int len = p.getLength();
                if (len <= 0) continue;
                String from = (p.getAddress() != null) ? p.getAddress().getHostAddress() : "?";
                lockHost(from);

                int b0 = b[0] & 0xFF;
                Log.i(TAG, "← 平台帧 len=" + len + " 首字节=0x" + hex(b0) + " 原文=" + preview(b, len));
                Log.i(TAG2, "← 平台帧 len=" + len + " 首字节=0x" + hex(b0));

                if (len == 1) {
                    if (b0 == (FRAME_REGISTER & 0xFF) || b0 == (FRAME_ONLINE_ACK & 0xFF)) {
                        // 实测平台从不发 1 字节下行。这里只记日志，**不**置 connected：
                        // 唯一的在线判据是机位表，否则一个杂散字节就会让注册重试提前停掉。
                        Log.i(TAG, "收到平台 1 字节帧 0x" + hex(b0) + "（不改变 connected）");
                        PageForensics.line("APK", "← 平台下行单字节 0x" + hex(b0)
                                + "（注册/心跳应答，不转给页面）");
                    } else {
                        // ★ 第十三修：单字节命令以前只进 Android 日志、**不进留痕** ——
                        //   于是「平台到底有没有下发开局指令」在留痕里查不到（page-forensics (4).log
                        //   整条只有机位表与 closeGame，无法证明平台没发过别的）。现在逐帧写留痕，
                        //   它是判定「平台会不会发 cmd3/4」的唯一证据来源。
                        Log.i(TAG, "← 平台单字节命令 cmd=" + b0);
                        PageForensics.line("APK", "← 平台下行**单字节命令 cmd=" + b0
                                + "**（已转给页面；3/4 = 旧平台的开局指令）");
                        downlink.add(new JSONObject().put("cmd", b0));
                    }
                    continue;
                }

                // 关游戏帧：0x10 + "closeGame"（平台日志里的 SendCloseGameToGame）
                if (b0 == (FRAME_CLOSE_GAME & 0xFF) && containsAscii(b, len, "closeGame")) {
                    handleCloseGame();
                    continue;
                }

                int s0 = indexOfByte(b, len, (byte) '{');
                int s1 = lastIndexOfByte(b, len, (byte) '}');
                if (s0 < 0 || s1 < s0) {
                    Log.i(TAG, "非 JSON 多字节帧（无 { }），忽略");
                    PageForensics.line("APK", "← 平台下行非 JSON 帧 len=" + len + " 首字节=0x" + hex(b0)
                            + "（已忽略 —— 若它紧跟操作员点「开始游戏」出现，把这条发来）");
                    continue;
                }
                JSONObject jo = null;
                try {
                    jo = new JSONObject(new String(b, s0, s1 - s0 + 1, StandardCharsets.UTF_8));
                } catch (Throwable e) {
                    Log.w(TAG, "JSON 解析失败: " + e.getClass().getSimpleName() + "/" + e.getMessage());
                }
                if (jo == null) continue;

                // ⚠ 机位表**没有 cmd 字段**，必须单独识别，否则会被当 cmd=-1 丢掉
                if (jo.has("Machines") || jo.has("machines")) {
                    handleConnectPayload(jo);
                    continue;
                }
                int cmd = jo.optInt("cmd", -1);
                if (cmd >= 0) {
                    Log.i(TAG, "← 平台命令(JSON) cmd=" + cmd);
                    PageForensics.line("APK", "← 平台下行**JSON 命令 cmd=" + cmd + "**（已转给页面）");
                    downlink.add(jo);
                } else {
                    Log.i(TAG, "← 平台 JSON 无 cmd 字段，忽略");
                    PageForensics.line("APK", "← 平台下行 JSON 无 cmd 字段（已忽略）："
                            + preview(b, len));   // preview 自带 200B 截断
                }
            } catch (Throwable ignore) {
                break;                  // socket 关闭（stop）即退出
            }
        }
    }

    /** 记录/锁定平台地址（回包源地址 = 真平台，可纠正 -d 给错 IP 的情况） */
    private void lockHost(String from) {
        if (activeHost == null || !activeHost.equals(from)) {
            activeHost = from;
            offerHost(from);
            Log.i(TAG, "平台实际地址=" + from + "（据回包源地址锁定）");
            Log.i(TAG2, "← 平台回包，实际平台地址=" + from);
        }
    }

    /**
     * 平台机位表（`{"Machines":[...],...}`，无 cmd 字段）：这是**平台认到我们的唯一凭证**，
     * 置 `connected`（并让注册重试自然停止）+ 透传给游戏页。
     *
     * 抓包实测：设备发 `0x01` 后 **57ms** 平台就回这张表；一次健康会话里它是平台唯一的下行业务数据。
     * 真实游戏侧对应日志：`PlayerConnectHandle Pos=..` / `VRPlatformHelper.DoInit() callback!`。
     *
     * ⚠ 不再回 `0x08`（旧实现多发，已删）：抓包证明玩家侧上行只有 `0x01` / `0x02`。
     */
    private void handleConnectPayload(JSONObject jo) {
        try {
            JSONArray ms = jo.optJSONArray("Machines");
            if (ms == null) ms = jo.optJSONArray("machines");
            int n = (ms == null) ? 0 : ms.length();
            connected = true;
            Log.i(TAG, "收到平台机位表：Machines=" + n + " 台，Language=" + jo.optInt("Language")
                    + "，RoomId=" + jo.optInt("RoomId") + "，IsPlayLogo=" + jo.optInt("IsPlayLogo")
                    + "，Setting=" + jo.optInt("Setting"));
            for (int i = 0; i < n; i++) {
                JSONObject m = ms.optJSONObject(i);
                if (m == null) continue;
                Log.i(TAG, "  机位[" + i + "] address=" + m.optString("address") + " IsHost=" + m.optInt("IsHost")
                        + " Pos=" + m.optInt("Pos") + " TeamID=" + m.optInt("TeamID")
                        + " style=" + m.optInt("style") + " weapon=" + m.optInt("weapon")
                        + " controller=" + m.optInt("controller"));
            }
            Log.i(TAG2, "← 平台机位表：Machines=" + n + " 台，RoomId=" + jo.optInt("RoomId")
                    + "，Language=" + jo.optInt("Language"));
            // 留痕：机位表 = 平台认到我们的**唯一凭证**。它出现得太晚、或根本没出现，一眼能看出。
            PageForensics.line("APK", "收到平台机位表 Machines=" + n + " 台 → 视为已上线（停止 0x01 注册）");

            JSONObject fwd = new JSONObject();
            fwd.put("cmd", 0);                  // 0 = 机位表（非业务命令，游戏页仅记录）
            fwd.put("type", "connect");
            if (ms != null) fwd.put("machines", ms);
            fwd.put("roomId", jo.optInt("RoomId"));
            fwd.put("language", jo.optInt("Language"));
            fwd.put("isPlayLogo", jo.optInt("IsPlayLogo"));
            downlink.add(fwd);
        } catch (Throwable e) {
            Log.w(TAG, "解析平台机位表失败: " + e.getClass().getSimpleName() + "/" + e.getMessage());
        }
    }

    /**
     * 平台关游戏（游戏通道 `0x10 closeGame`）：
     *   ① 通知游戏页（cmd=16）由页面优雅退出（页面可能没开/卡住，不影响下面的 ack）；
     *   ② **立即回 `0x02`** —— 平台在等这个确认（抓包实测：`10 closeGame  ` → 7ms 后 `02`）。
     * 注意：平台是**双通道并发**关游戏的 —— 启动器通道的 `{"cmd":"kill","msgData":"<游戏名>"}`
     * 归启动器 force-stop（只能杀掉本 APK 进程，**杀不掉浏览器里的游戏页**）；游戏通道这条归我们。
     * 所以这里必须让页面**自己**退（页面资源还挂在本 APK 的本地 HTTP 服务上）。
     */
    private void handleCloseGame() {
        Log.i(TAG, "← 平台关游戏（游戏通道 0x10 closeGame）→ 通知页面 + 回 0x02");
        Log.i(TAG2, "← 平台关游戏（游戏通道 0x10 closeGame）");
        // 留痕：这是「游戏页为什么会退出」的第一号**合法**原因。日后读时间线时，
        // 只要这一行存在且时间与页面消失吻合，就说明是平台真的要求关闭，不是我们误判。
        PageForensics.line("APK", "收到平台关闭指令 0x10 closeGame（已入队 cmd=16 + 回 0x02）");
        try {
            downlink.add(stamp(new JSONObject().put("cmd", 16).put("type", "closeGame")));
        } catch (Throwable ignore) { /* JSONObject.put 不会失败，保险 */ }
        tx.execute(() -> sendNow(2));
        // ★ 第十修「退出策略」：平台明说关游戏 → 本局收尾。给页面一点时间优雅退场（退 VR + 回菜单）
        //   之后，把**平台客户端顶回前台**（必要时再关浏览器）。回调由 CastApp 注入，
        //   用主线程 Handler 投递（内部要做 startActivity / killBackgroundProcesses，走主线程最稳）。
        final Runnable hook = sOnCloseGame;
        if (hook != null) {
            try {
                new android.os.Handler(android.os.Looper.getMainLooper()).post(hook);
            } catch (Throwable e) {
                Log.w(TAG, "关游戏回调投递失败: " + e);
            }
        }
    }

    /**
     * 上行命令（游戏侧 /api/vrplus/send 转发、或 APK 原生层直接调用）。
     * **队列化**：真正的 UDP send 在 tx 后台线程执行，故本方法可从任意线程（含主线程）安全调用。
     * 返回 true = 已入队（不代表已送达）。合法取值只有 1(注册) / 2(closeGame 确认)；
     * 其他值（如旧 V2.9 的 3/4/5/6，或**玩家侧本就不该发的 8**）会被忽略并打日志。
     */
    public boolean sendCommand(int cmd) {
        try {
            tx.execute(() -> sendNow(cmd));
            return true;
        } catch (Throwable e) {
            Log.w(TAG, "命令入队失败 cmd" + cmd + ": " + e);
            return false;
        }
    }

    /** 兼容旧调用名（语义同 sendCommand：入队成功即 true） */
    public boolean sendCommandSafe(int cmd) {
        return sendCommand(cmd);
    }

    /** 真正发包（只在 tx 线程执行，绝不在主线程） */
    private void sendNow(int cmd) {
        try {
            ready.await(3, TimeUnit.SECONDS);       // 等 boot 线程把 socket 建好（主线程绝不能阻塞）
            if (sock == null || sock.isClosed()) throw new IllegalStateException("UDP socket 未就绪");
            List<String> targets = new ArrayList<>(hosts);
            if (targets.isEmpty()) throw new IllegalStateException("无候选平台地址");

            switch (cmd) {
                case 1:
                    // 注册：**单字节裸值 0x01**，绝不能是 JSON
                    //（平台按首字节解析，'{'=0x7B 会被当未知命令丢掉）；源端口必须是 51124。
                    sendRegisterToAllHosts();
                    return;
                case 2:
                    sendRaw(new byte[]{FRAME_CLOSE_ACK}, "0x02 关游戏确认", targets);
                    return;
                default:
                    Log.i(TAG, "忽略非协议命令 cmd=" + cmd
                            + "（玩家侧上行只有 0x01 注册 / 0x02 closeGame 确认）");
            }
        } catch (Throwable e) {
            // ⚠ 必须打异常类名：NetworkOnMainThreadException 的 getMessage() 为 null，
            //    只打 message 会得到「失败: null」这种无法定位的日志（castlog4.txt 教训）。
            String detail = e.getClass().getSimpleName() + "/" + e.getMessage();
            Log.w(TAG, "发送 cmd" + cmd + " 失败: " + detail);
            Log.w(TAG2, "上报平台 cmd" + cmd + " 失败: " + detail);
        }
    }

    /** 把一帧原始字节 fan-out 到全部候选平台地址（只在 tx 线程调用） */
    private void sendRaw(byte[] frame, String what, List<String> targets) {
        if (sock == null || sock.isClosed()) {
            Log.w(TAG, "发送「" + what + "」失败: UDP socket 未就绪");
            return;
        }
        int ok = 0;
        for (String h : targets) {
            try {
                sock.send(new DatagramPacket(frame, frame.length, InetAddress.getByName(h), SEND_PORT));
                ok++;
            } catch (Throwable e) {
                Log.w(TAG, "发送「" + what + "」到 " + h + " 失败: "
                        + e.getClass().getSimpleName() + "/" + e.getMessage());
            }
        }
        Log.i(TAG, "→ 平台 " + what + " → " + targets + "（成功 " + ok + "/" + targets.size()
                + "，首字节=0x" + hex(frame[0] & 0xFF) + "）");
        Log.i(TAG2, "→ 平台 " + what + " → " + targets + "（首字节=0x" + hex(frame[0] & 0xFF) + "）");
    }

    /** 取出并清空平台下行命令队列（游戏侧 /api/vrplus/inbox 轮询调用） */
    public List<JSONObject> drainInbox() {
        List<JSONObject> out = new ArrayList<>();
        JSONObject c;
        while ((c = downlink.poll()) != null) out.add(c);
        return out;
    }

    /**
     * 给下行项打「入队时刻 t（epoch ms）+ 序号 n」。
     *
     * ══ 为什么必须打时间戳（2026-09-17 定位到的「打开预览界面 1 秒闪退」嫌疑根因）══
     * `downlink` 是**进程级**队列：本类是单例（MainActivity.sVRPlusLink），进程又被 CastService
     * 前台服务保活，且**平台重拉时不会重建桥接**（MainActivity.setControlHost 复用 sVRPlusLink）。
     * 于是队列**跨会话存活**：平台每局结束都会给头显发一条 `0x10 closeGame`
     * （实测：正常轮 2:52:04 / 失败轮 2:59:55，与 `kill` 同一毫秒并发下发），
     * 若那一刻游戏页恰好在加载中 / 已被卸载成 about:blank / APK 正被 force-stop，
     * 就没人来 drain → 这条 `cmd=16` **一直躺在队列里**。
     * 下一局游戏页一打开，`startInbox` 每 1s 轮询且**首轮立即执行** → 新页面在 1 秒内就收到
     * 「上一局的关闭游戏」→ 走 _onPlatformCloseRequest 直接自杀：
     * **玩家看到的正是「打开预览界面 1 秒就闪退」，而且与 PC 端 exe 毫无关系**（换 exe 也没用）。
     *
     * 有了 `t`，游戏页就能只认「本页启动之后」入队的指令（见 game.js 的 pageT0 门禁），
     * 时序上不可能误伤；同时 `n` 让日志能一眼看出残留。
     */
    private JSONObject stamp(JSONObject o) {
        try {
            o.put("t", System.currentTimeMillis());
            o.put("n", seq.incrementAndGet());
        } catch (Throwable ignore) { /* JSONObject.put 不会失败，保险 */ }
        return o;
    }

    /**
     * 丢弃下行队列里的**「会话终止类」残留**（新会话开始前调用）。
     *
     * 只丢 `cmd = 16`（游戏通道 closeGame）与旧平台的 `5/6`（中途/正常结束）——
     * 这些是「上一局已经结束了」的指令，被新页面捡走就会立刻自杀。
     * 其他指令（尤其 `cmd = 0` 机位表）照原样留在队列里：注册握手发生在**页面加载之前**
     * （APK 一被拉起就发 0x01，平台 57ms 就回表），若一并清掉，新页面就再也看不到那张表了。
     *
     * 语义边界：只该在「确认要开一个新游戏页」时调用 —— 页面还活着时绝不能清，
     * 否则会吞掉平台真实下发的关闭指令。
     * 返回丢弃条数。
     */
    public int clearStaleClose(String why) {
        List<JSONObject> all = drainInbox();
        int dropped = 0;
        StringBuilder sb = new StringBuilder();
        for (JSONObject o : all) {
            int cmd = o.optInt("cmd", -999);
            if (cmd == 16 || cmd == 5 || cmd == 6) {
                dropped++;
                sb.append("cmd=").append(cmd)
                  .append("/n").append(o.optInt("n", -1))
                  .append("(").append(System.currentTimeMillis() - o.optLong("t", 0)).append("ms前) ");
            } else {
                downlink.add(o);            // 非终止类：原样放回（机位表等）
            }
        }
        if (dropped > 0) {
            Log.w(TAG, "丢弃上一会话的关闭类残留 " + dropped + " 条：" + sb + "（" + why + "）");
            Log.w(TAG2, "VR+ 丢弃上一会话关闭类残留 " + dropped + " 条（" + why + "）");
            // 留痕：出现这条说明「跨会话残留」真的发生过（正是曾导致「打开即闪退」的根因）。
            // 若某次仍然闪退、这里却一条都没有 → 可以明确排除该根因，去查别的。
            PageForensics.line("APK", "丢弃上一会话关闭类残留 " + dropped + " 条（" + why + "）：" + sb);
        }
        return dropped;
    }

    public boolean isConnected() { return connected; }

    /**
     * 往页面下行队列里放一条**本地合成**指令（不经过 UDP，平台不知道）。
     *
     * 用途（2026-09-19）：平台关闭本局后，游戏页**不再卸载**（保留页面进「待机态」，避免浏览器白页
     * 与下次整页重载），于是平台下一次「开始」必须由我们主动把页面叫回来 —— 就是这里入队的 cmd3。
     * 页面侧 game.js._onPlatformCommand(3) 有 `state !== 'menu'` 守卫：i.e. **只在菜单/待机态生效**，
     * 玩家正在玩时收到它是空操作 —— 所以平台那套「主机没上线就 +20s 重拉 am start」不会因此打断游戏。
     *
     * 同时带 stamp()（t/n）：页面用 `t` 做上一会话残留门禁，n 便于日志对号。
     */
    public void enqueueLocal(int cmd, String why) {
        enqueueLocal(cmd, why, false);
    }

    /**
     * 同上，并标记「这条代表平台已开始本局」（`plat:true`）。
     *
     * 为什么需要这个标记（2026-09-19 第十二修）：页面侧「进入 VR」按钮**默认隐藏**，只在
     * 收到平台开局信号时才显示。而平台唯一的开局凭证（机位表 cmd=0）是**一次性**消息：
     * 它入队于页面加载之前，若页面之后才重载 / 上一轮已把它取走，新页面就再也看不到它。
     * 所以「平台驱动的**首次**拉起」也必须由我们主动补一条 —— 见 MainActivity.launchBrowserNow。
     */
    public void enqueueLocal(int cmd, String why, boolean platformStart) {
        JSONObject o = stamp(new JSONObject());
        try {
            o.put("cmd", cmd);
            o.put("local", true);          // 标记：不是平台下发的，便于日志区分
            if (platformStart) o.put("plat", true);   // 标记：代表「平台已开始本局」
        } catch (Throwable ignore) { /* JSONObject.put 不会失败，保险 */ }
        downlink.add(o);
        Log.i(TAG, "→ 入队本地指令 cmd=" + cmd + "（" + why + "）plat=" + platformStart + "，等待页面轮询取走");
        PageForensics.line("APK", "入队本地 cmd=" + cmd
                + (platformStart ? " plat=true（平台已开始本局）" : "") + "（" + why + "）");
    }

    /** 已锁定的平台地址（收到回包的那台）；尚未回包时返回第一个候选，供日志/复用判断 */
    public String host() {
        String a = activeHost;
        if (a != null) return a;
        synchronized (hosts) {
            for (String h : hosts) return h;
        }
        return null;
    }

    /** 是否已在候选列表里（MainActivity 复用桥接时判断，避免重复建 socket） */
    public boolean hasHost(String ip) {
        return ip != null && hosts.contains(ip.trim());
    }

    public void stop() {
        running = false;
        connected = false;
        if (sock != null) {
            try { sock.close(); } catch (Throwable ignore) {}
        }
        try { tx.shutdownNow(); } catch (Throwable ignore) {}
        Log.i(TAG, "桥接已停止");
    }

    // ───────────────── 小工具 ─────────────────

    private static String hex(int v) {
        String s = Integer.toHexString(v & 0xFF);
        return (s.length() < 2) ? ("0" + s) : s;
    }

    /** 字节预览：可打印字符原样，其余转 \xNN（排错时一眼看出帧头/载荷） */
    private static String preview(byte[] b, int len) {
        StringBuilder sb = new StringBuilder(Math.min(len, 200) * 4);
        int n = Math.min(len, 200);
        for (int i = 0; i < n; i++) {
            int v = b[i] & 0xFF;
            if (v >= 0x20 && v < 0x7F) sb.append((char) v);
            else sb.append("\\x").append(hex(v));
        }
        if (len > n) sb.append("…(共").append(len).append("B)");
        return sb.toString();
    }

    private static int indexOfByte(byte[] b, int len, byte t) {
        for (int i = 0; i < len; i++) if (b[i] == t) return i;
        return -1;
    }

    private static int lastIndexOfByte(byte[] b, int len, byte t) {
        for (int i = len - 1; i >= 0; i--) if (b[i] == t) return i;
        return -1;
    }

    private static boolean containsAscii(byte[] b, int len, String needle) {
        byte[] n = needle.getBytes(StandardCharsets.US_ASCII);
        outer:
        for (int i = 0; i + n.length <= len; i++) {
            for (int j = 0; j < n.length; j++) if (b[i + j] != n[j]) continue outer;
            return true;
        }
        return false;
    }
}
