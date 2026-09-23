package com.local.webxrcast;

import android.app.Application;
import android.os.Environment;
import android.util.Log;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 应用入口：只做一件事——**捕获未处理异常（闪退）并留证据**。
 *
 * 为什么需要它：
 *   2026-09-16 用户多次报「客户端启动游戏直接闪退」，但 `adb logcat -s CastMain:V` 里既没有
 *   FATAL EXCEPTION 也没有心跳中断 —— 因为 Java 崩溃走的是 **AndroidRuntime** 标签，被过滤器挡掉了，
 *   而 APK 自己 kill 掉进程（force-stop）时更不会留下任何栈。
 *   这里把崩溃栈**同时**写到 logcat（CastMain 标签）与 APK 外部私有目录的 crash.log，
 *   这样即使当时没抓 logcat，事后也能 `adb pull` 出来看。
 *
 * 用法（排错时）：
 *   adb logcat -v time -s CastMain:V AndroidRuntime:E ActivityManager:I
 *   adb pull /sdcard/Android/data/com.GoodNet.DeepmindHacker/files/crash.log d:/crash.log
 */
public class CastApp extends Application {

    private static final String TAG = "CastMain";
    private static final String DIR = "cast-log";

    /**
     * 进程级 Application Context。给**静态**辅助方法用（读 SharedPreferences / startActivity /
     * killBackgroundProcesses）—— 第十修的「本局结束 → 退出策略」在 Activity 已 finish（免打扰路径）
     * 之后仍要能执行，拿不到 Activity 的 this。
     */
    public static volatile android.content.Context APP = null;

    @Override
    public void onCreate() {
        super.onCreate();
        APP = getApplicationContext();
        // ★ 2026-09-19：留痕**在这里**就要初始化 —— Application.onCreate 跑在任何 Activity 之前，
        //   是进程内最早的可写点。此前只在 MainActivity.onCreate 里初始化，于是「进程起来了但
        //   Activity 建到一半就崩」的情况在留痕里表现为「日志戛然而止」，事后无法分辨是没被拉起
        //   还是崩在启动路径上（2026-09-19 实测就卡在这个歧义上）。
        try { PageForensics.init(this); } catch (Throwable ignore) { /* 留痕失败不影响启动 */ }
        PageForensics.line("APK", "CastApp.onCreate（Application 级：早于任何 Activity）");
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            try {
                StringWriter sw = new StringWriter();
                e.printStackTrace(new PrintWriter(sw));
                String stack = sw.toString();

                // ① logcat（CastMain 标签，与 VRPlusLink 的双标签日志合并，一条 -s 命令看全）
                Log.e(TAG, "★ 未捕获异常（闪退）线程=" + t.getName() + "\n" + stack);

                // ② 落文件，事后可 adb pull（不依赖当时是否在抓 logcat）
                appendCrashFile(stack);

                // ③ ★ 也写进**统一时间线留痕**：页面事件 + APK 事件 + 崩溃栈同一条时间线。
                //    这样头显上打开 /api/page/forensics（或 APK 配置页尾部）就能直接看到崩溃原因，
                //    不必连 adb —— 前几轮「日志在某时刻断掉」的谜团大多要靠这条才能定案。
                PageForensics.line("CRASH", "未捕获异常 线程=" + t.getName() + " → "
                        + (e.getClass().getName() + ": " + e.getMessage()));
                PageForensics.line("CRASH", "栈 " + stack);
            } catch (Throwable ignore) {
                // 记录崩溃的过程本身绝不能崩
            }
            if (prev != null) prev.uncaughtException(t, e);
        });
        Log.i(TAG, "CastApp 启动，崩溃捕获已安装");

        // ── 第十修「本局结束 → 退出策略」的两个触发点（2026-09-19）──
        // 为什么在这里注入：本类跑在进程最早、且不随 Activity 生死 —— 而这两个入口都可能在
        // MainActivity 已 finish（免打扰路径）之后发生，回调不能吊在 Activity 实例上。
        //   ① 平台游戏通道 `0x10 closeGame` = 平台明说关游戏（最权威，2.5s 后执行）；
        //   ② 页面上报 `game-end` = 玩家打输 / 通关 / 退出 VR（页面才知道，8s 后执行，让结算走完）。
        // 目标：把**平台客户端**顶回前台（否则操作员下一个「开始」点不动），必要时关掉浏览器。
        try {
            VRPlusLink.sOnCloseGame = () -> MainActivity.scheduleClientRestore(
                    APP, "平台关闭指令 0x10 closeGame", 2500L);
            GameServer.sOnGameEnd = () -> MainActivity.scheduleClientRestore(
                    APP, "页面上报本局结束（game-end）", 8000L);
            Log.i(TAG, "退出策略回调已注入（closeGame / game-end）");
        } catch (Throwable e) {
            Log.w(TAG, "退出策略回调注入失败: " + e);
        }
    }

    /** 追加崩溃栈到 外部私有目录/cast-log/crash.log（追加式，保留历史多次崩溃） */
    private void appendCrashFile(String stack) {
        try {
            File base = getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS);
            if (base == null) base = getExternalFilesDir(null);
            if (base == null) return;
            File dir = new File(base, DIR);
            if (!dir.exists() && !dir.mkdirs()) return;
            File f = new File(dir, "crash.log");
            String ts = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date());
            try (FileWriter fw = new FileWriter(f, true)) {
                fw.write("========== " + ts + " ==========\n" + stack + "\n");
            }
            Log.e(TAG, "崩溃栈已写入 " + f.getAbsolutePath());
        } catch (Throwable ignore) {
            // 写文件失败（无存储权限等）不影响主流程
        }
    }
}
