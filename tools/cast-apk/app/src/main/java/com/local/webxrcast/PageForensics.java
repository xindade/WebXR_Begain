package com.local.webxrcast;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 「游戏页死亡留痕」—— 把**页面事件**与 **APK 事件**写进同一条时间线文件。
 *
 * <h3>为什么需要它（2026-09-19）</h3>
 * 前几轮排查反复卡在同一件事上：玩家看到的是「游戏预览界面进度条跑到一半就没了」，
 * 但**没有任何设备侧证据**说明那一瞬间到底是谁干的 —— 候选有四种，症状却一模一样：
 *   ① 平台 kill（am force-stop 我们的 APK）→ 8080 没了 → 页面所有资源请求失败；
 *   ② 我们自己的看门狗误判「APK 失联」→ 页面自杀（_onPlatformGone）；
 *   ③ 平台重发 am start 把前台从浏览器抢走（PICO 的 2D 面板一次只显示一个）；
 *   ④ 浏览器标签/渲染进程自己崩（显存/内存压力）。
 * 页面自己的日志随页面一起消失，logcat 又要连线才能取 —— 于是每次只能靠猜。
 *
 * 本类把三条线索汇到**一个文件**里，且文件在 APK 进程被 force-stop 后依然留在磁盘：
 *   · 页面侧：每秒轮询带上来的 `pct/state/pd/xr`、可见性变化、pagehide、崩溃/未捕获异常、
 *     以及「平台关闭流程」触发的死因（见 vrplus.js 的 reportDead / trackLifecycle）；
 *   · APK 侧：进程启动（pid）、每次被平台拉起、8080 是否重绑、跳过了哪些重开浏览器的动作、
 *     是否收到 0x10 closeGame、清空了几条残留下行。
 * 只要读这一个文件，就能判断「那 1 秒里是谁动的手」，**不再需要 adb 连线、不再需要猜**。
 *
 * <h3>怎么读</h3>
 *   · 打开本 APK 图标 → 配置页底部直接显示最近若干行（见 MainActivity）；
 *   · 浏览器打开 http://localhost:8080/api/page/forensics → 纯文本全量；
 *   · 文件路径：getExternalFilesDir(null)/page-forensics.log（adb pull 也行）。
 *
 * 线程安全：所有写入走同一个 lock；文件超 128KB 时只保留尾部 48KB（自动轮转，不会无限增长）。
 */
public final class PageForensics {

    private static final String TAG = "Forensics";
    private static final String FILE_NAME = "page-forensics.log";
    /** 本构建的标识：装机后看留痕文件第一行即可确认「装的是不是这一版」 */
    public static final String BUILD_TAG = "2026-09-20o-guard-pair-config";

    private static final long MAX_BYTES = 128 * 1024;
    private static final long KEEP_BYTES = 48 * 1024;

    private static final Object LOCK = new Object();
    private static final SimpleDateFormat FMT = new SimpleDateFormat("HH:mm:ss.SSS", Locale.US);

    private static File file = null;
    private static String lastState = "";      // 上一次记录的状态串（内容相同则不重复写）
    private static long lastStateAt = 0;

    private PageForensics() {}

    /** 进程级初始化（幂等）。建议在 Application.onCreate 最早的时机调用一次。 */
    public static void init(Context ctx) {
        synchronized (LOCK) {
            if (file != null) return;
            // ⚠ 2026-09-19：**绝不能因为外部目录取不到就放弃留痕** ——
            //   它是「设备侧唯一的诊断通道」，一旦静默关闭，出问题时我们看到的就是
            //   「日志在某时刻戛然而止」，无法分辨是进程没起来还是写盘失败。
            //   故失败一律回退到内部私有目录（getFilesDir 基本不会失败）。
            try {
                File dir = ctx.getExternalFilesDir(null);
                if (dir == null) dir = ctx.getFilesDir();
                if (dir != null) {
                    if (!dir.exists()) dir.mkdirs();
                    file = new File(dir, FILE_NAME);
                }
            } catch (Throwable e) {
                Log.w(TAG, "外部目录不可用（" + e.getClass().getSimpleName() + "），回退内部目录");
                try {
                    File dir = ctx.getFilesDir();
                    if (dir != null) file = new File(dir, FILE_NAME);
                } catch (Throwable e2) {
                    Log.w(TAG, "初始化彻底失败 " + e2);
                    return;
                }
            }
        }
        line("APK", "==== 进程启动 build=" + BUILD_TAG + " pid=" + android.os.Process.myPid() + " ====");
        line("APK", "留痕文件 " + path() + "（若上方 pid 与上一段不同，说明上一次是被 force-stop 杀掉的）");
    }

    public static String path() {
        File f = file;
        return f == null ? "(未初始化)" : f.getAbsolutePath();
    }

    /** 追加一行（同时写 logcat，tag=Forensics）。任何异常都被吞掉——留痕绝不影响主流程。 */
    public static void line(String tag, String msg) {
        if (msg == null) msg = "";
        String row = FMT.format(new Date()) + " [" + tag + "] " + msg.replace('\r', ' ').replace('\n', ' ');
        Log.i(TAG, row);
        synchronized (LOCK) {
            if (file == null) return;
            try {
                rotateIfNeeded();
                try (FileOutputStream out = new FileOutputStream(file, true)) {
                    out.write((row + "\n").getBytes(StandardCharsets.UTF_8));
                }
            } catch (Throwable ignore) { /* 忽略 */ }
        }
    }

    /**
     * 记录页面状态（页面每秒轮询 /api/vrplus/inbox 时带上来的 pct/state/pd/xr）。
     * **只在「有变化」或距上次 ≥5s** 时落一行 —— 否则每秒一条会把文件刷爆，反而淹没关键事件。
     *
     * @param pct   preload 进度百分比（-1 = 未知）
     * @param state 游戏状态字符串（menu / playing / waiting …）
     * @param pd    preloadDone（true/false）
     * @param xr    XR 会话是否在跑（true/false）
     * @param closed 页面是否处于「本局已结束」待机态（平台关闭后页面**保留**不卸载，见 game.js _enterClosedIdle）
     */
    public static void state(int pct, String state, boolean pd, boolean xr, boolean closed) {
        String key = pct + "|" + state + "|" + pd + "|" + xr + "|" + closed;
        long now = System.currentTimeMillis();
        synchronized (LOCK) {
            if (key.equals(lastState) && now - lastStateAt < 5000) return;
            lastState = key;
            lastStateAt = now;
        }
        line("PAGE", "状态 进度=" + (pct < 0 ? "?" : pct + "%")
                + " state=" + state + " 预加载" + (pd ? "完毕" : "中") + " XR=" + (xr ? "on" : "off")
                + (closed ? " 【待机：本局已结束，等平台重新开始】" : ""));
    }

    /** 文件尾部若干行（供配置页显示 / /api/page/forensics 返回） */
    public static String tail(int n) {
        synchronized (LOCK) {
            File f = file;
            if (f == null) return "(留痕未初始化)";
            if (!f.exists()) return "(暂无留痕文件：" + f.getAbsolutePath() + ")";
            try (FileInputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[(int) Math.min(f.length(), MAX_BYTES)];
                int off = 0, r;
                while (off < buf.length && (r = in.read(buf, off, buf.length - off)) > 0) off += r;
                String[] lines = new String(buf, 0, off, StandardCharsets.UTF_8).split("\n");
                int from = Math.max(0, lines.length - n);
                StringBuilder sb = new StringBuilder();
                for (int i = from; i < lines.length; i++) sb.append(lines[i]).append('\n');
                return sb.length() == 0 ? "(留痕文件为空)" : sb.toString();
            } catch (Throwable e) {
                return "(读取失败 " + e.getClass().getSimpleName() + ")";
            }
        }
    }

    /** 文件全文（供 `?download=1` 导出）。上限 MAX_BYTES，一次读完不切行。 */
    public static String full() {
        synchronized (LOCK) {
            File f = file;
            if (f == null) return "(留痕未初始化)";
            if (!f.exists()) return "(暂无留痕文件：" + f.getAbsolutePath() + ")";
            try (FileInputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[(int) Math.min(f.length(), MAX_BYTES)];
                int off = 0, r;
                while (off < buf.length && (r = in.read(buf, off, buf.length - off)) > 0) off += r;
                return new String(buf, 0, off, StandardCharsets.UTF_8);
            } catch (Throwable e) {
                return "(读取失败 " + e.getClass().getSimpleName() + ")";
            }
        }
    }

    /** 文件超过上限时，只保留尾部 KEEP_BYTES（简单轮转，防止无限增长） */
    private static void rotateIfNeeded() {
        File f = file;
        if (f == null || !f.exists() || f.length() <= MAX_BYTES) return;
        try (RandomAccessFile raf = new RandomAccessFile(f, "rw")) {
            long len = raf.length();
            long keep = Math.min(KEEP_BYTES, len);
            byte[] tail = new byte[(int) keep];
            raf.seek(len - keep);
            raf.readFully(tail);
            raf.setLength(0);
            raf.seek(0);
            // 注：这一行特意只用 ASCII —— 历史教训：CJK 字符是 3 字节，若编译期编码被设成 GBK，
            // 字节错位会把收尾的 `"` 吞掉，报出一个和本行毫不相干的语法错（见 app/build.gradle 的 encoding）。
            raf.write(("[rotated] keep last " + (keep / 1024) + "KB\n").getBytes(StandardCharsets.UTF_8));
            raf.write(tail);
        } catch (Throwable ignore) { /* 轮转失败不影响写入 */ }
    }
}
