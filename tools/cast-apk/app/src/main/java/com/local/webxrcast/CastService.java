package com.local.webxrcast;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * 常驻前台服务 —— **保活 + 允许后台启动浏览器**。为什么必须有它（PICO 兼容的关键）：
 *
 *  本 APK 的角色是「资源宿主 + 信令桥」：游戏页跑在头显浏览器里，但它要**持续**从
 *  http://localhost:8080 取资源、并轮询 /api/vrplus/* 与平台通信。而拉起浏览器后 APK 会
 *  moveTaskToBack 退到后台 —— 于是整个链路就依赖「这个后台进程别被杀」：
 *
 *   ① 普通后台（cached）进程在头显上极易被回收（PICO 对后台应用清理比 Quest 激进）。
 *      一旦 GameServer 随进程消失，浏览器里游戏页的 aliveWatch 立刻检测到 localhost 失联 →
 *      主动 replace('about:blank') 卸载自己 → 玩家看到「直接闪退」（这正是 2026-09-16 的现象）。
 *   ② Android 10+ 限制「后台应用启动 Activity（BAL）」：平台在后台把本 APK 拉起来后，
 *      我们再去 startActivity 打开浏览器会被静默拦截（表现为停在配置页 / 打不开游戏）。
 *      而**持有前台服务的进程被视为前台态**，startActivity 直接放行。
 *
 *  也就是说：一个前台服务同时解决「进程被回收」与「后台起不了浏览器」两个 PICO 侧的坑。
 *  平台点「关闭」走的是 force-stop（LauncherClient），前台服务不阻止 force-stop，语义一致。
 *
 *  想关掉这个行为：把 ENABLED 改成 false（或删掉 Manifest 里的 <service>）即可，其余逻辑不受影响。
 */
public class CastService extends Service {

    private static final String TAG = "CastMain";
    private static final String CHANNEL = "cast_keepalive";
    private static final int NOTIF_ID = 4711;

    /** 总开关：false = 不启用常驻前台服务（退化为旧行为） */
    public static final boolean ENABLED = true;

    /** 幂等启动（重复调用安全）；任何失败都只记日志，绝不影响主流程 */
    public static void start(Context ctx) {
        if (!ENABLED) return;
        try {
            Intent i = new Intent(ctx, CastService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
        } catch (Throwable e) {
            Log.w(TAG, "前台保活服务启动失败（忽略，不影响游戏）：" + e.getClass().getSimpleName() + "/" + e.getMessage());
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) createChannel();
            Notification n = buildNotification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // Android 10+ 建议/（14+ 强制）显式声明类型；Manifest 已声明 dataSync
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIF_ID, n);
            }
            Log.i(TAG, "前台保活服务已启动（本地 8080 + VR+ 桥接常驻）");
            return START_STICKY;   // 被系统回收后自动重建
        } catch (Throwable e) {
            // ⚠⚠ 绝不能只是「记日志然后 return START_STICKY」 ****************************************************************
            // 系统对 startForegroundService() 有硬性契约：必须在规定时间内调用 startForeground()，
            // 否则抛出 RemoteServiceException("Context.startForegroundService() did not then call
            // Service.startForeground()") —— **整个进程被杀**（2026-09-16 实测形态：游戏起来约 3 秒后闪退）。
            // 这里一旦失败就主动 stopSelf()：告诉系统「本服务不做前台了」，进程即可正常存续
            // （GameServer 仍随进程存活），退化为普通后台服务——保活变弱但绝不自杀。
            Log.w(TAG, "startForeground 失败，主动 stopSelf 退化为普通后台服务（避免 RemoteServiceException 杀进程）："
                    + e.getClass().getSimpleName() + "/" + e.getMessage());
            stopSelf();
            return START_NOT_STICKY;
        }
    }

    private Notification buildNotification() {
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("DeepmindHacker 运行中")
                .setContentText("本地资源服务与平台连接保持中")
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setShowWhen(false);
        return b.build();
    }

    private void createChannel() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (nm.getNotificationChannel(CHANNEL) != null) return;
            NotificationChannel ch = new NotificationChannel(CHANNEL, "运行状态", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        } catch (Throwable ignore) {
            // 渠道创建失败不影响服务本身
        }
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
