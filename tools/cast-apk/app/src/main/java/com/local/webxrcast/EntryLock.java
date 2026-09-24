package com.local.webxrcast;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.SystemClock;
import android.util.Log;

/**
 * 「本局在 VR 里时，把包内所有能被 MAIN/LAUNCHER 隐式意图命中的入口**全部临时停用**」——
 * 2026-09-24 第二十七修（只停 `MainActivity`）→ **第二十八修**（连 `RecoverActivity` 一起停，包内零入口）。
 *
 * <h3>为什么必须这么做（第二十六修现场实测的结论）</h3>
 * 平台客户端每 **20.004s** 重发一次整套启动：
 * `kill`（am force-stop 本包名）→ `copyfile(setup.xml)` →
 * `am start -n &lt;pkg&gt;/.MainActivity -d &lt;PC_IP&gt;`。
 * 第二次 `am start` 到达时玩家通常已经在 VR 里。2026-09-24 14:02 那一局（build=…-p26-xr-safe-relaunch）
 * 的留痕把因果钉死了：
 *
 * <pre>
 * 14:02:18.241 [APK] 免打扰路径：页面正在 XR 会话中 → 不做任何 startActivity/顶前台动作，只 finish 本页
 * 14:02:18.330 [PAGE] xr-end st=intro byPlayer=false idle=false vis=visible   ← 89ms 后 XR 还是掉了
 * 14:02:18.644 [PAGE] visibility:hidden
 * </pre>
 *
 * 即：**哪怕我们用 `Theme.NoDisplay`、不建窗口、不 setContentView、立刻 finish**，只要我们的
 * Activity 被创建（= 平台那一次 `am start` 真的落到了我们身上），PICO 的系统仍会为它建一个
 * 2D 面板/起始窗口并顶到最前 → 浏览器失去焦点 ⇒ XR 沉浸式会话结束 ⇒ 玩家被弹出 VR +
 * 系统弹窗「退出PICO浏览器 / 你需要退出当前应用才能继续操作」。
 * （与 `MainActivity.computePassThrough()` 注释里 18:24:04 那次「空窗口也会顶掉 XR」的结论一致。）
 *
 * <h3>本修的做法</h3>
 * 既然**任何**一次 Activity 创建都会顶掉 XR，那唯一在客户端侧成立的解法就是
 * **让平台那一次 `am start` 根本落不到我们身上**：本局在 VR 期间把「平台入口组件」
 * （`com.local.webxrcast.MainActivity`）设为 `COMPONENT_ENABLED_STATE_DISABLED`。
 * 此后 `am start -n …/.MainActivity` 在**包管理器层**就解析失败，
 * 不产生 ActivityRecord、不产生窗口/面板/闪屏，也就没有那个弹窗。
 *
 * <h3>第二十八修：为什么连「人工恢复入口」也必须一起停用</h3>
 * 第二十七修把 `MainActivity` 停用了，却**顺手启用了 `RecoverActivity`**（为了让应用列表里始终有一个
 * 可点图标）。2026-09-24 14:59 那一局（build=…-p27-entry-lock）的留痕证明这个「补救」正好成了新的靶子：
 *
 * <pre>
 * 14:59:08.737 [APK] ★ 平台入口已临时停用（页面在 XR 沉浸式会话里（?xr=1））…      ← 停用生效
 * 14:59:17.418 [APK] ⚠ 平台的 am start 落到了「恢复入口」上 → 说明平台用的是不带 -n 的隐式 intent
 * 14:59:17.618 [PAGE] xr-end st=intro byPlayer=false idle=false vis=visible          ← 200ms 后 XR 又掉了
 * </pre>
 *
 * 即：平台在 `-n &lt;pkg&gt;/.MainActivity` 被拒之后会退化成**隐式** MAIN/LAUNCHER + `-p &lt;pkg&gt;`
 * （或 `getLaunchIntentForPackage`），于是解析到当时唯一启用的 `RecoverActivity`。
 * **只要包内还剩任何一个可被隐式意图解析的 Activity，平台就总能拉到它，弹窗就还在。**
 * 故本修把不变式收紧为：
 * <b>「页面在 XR 会话里」⇔「包内 MAIN/LAUNCHER 入口数 = 0」</b>（`MainActivity` 与 `RecoverActivity` 同时停用）。
 *
 * <h3>代价（现场须知）</h3>
 * 本局在 VR 里的那几分钟，**头显应用列表里点不到本游戏**（这正是要的效果 —— 平台同样点不到）。
 * 出 VR（`?xr=0`）立刻恢复；此外下面 7 条安全网任一命中都会恢复。人工恢复改走**非 Activity 通道**：
 * PC 浏览器访问 `http://&lt;头显IP&gt;:8080/api/entry/unlock`、重启头显、或重装 APK。
 *
 * <h3>安全网（停用状态绝不能把现场锁死）</h3>
 * <ol>
 *   <li>页面报「已退出 VR」（`?xr=0`）→ 立刻恢复；</li>
 *   <li>本局结束（平台 `0x10 closeGame` / 页面 `game-end`）→ 立刻恢复（见 MainActivity.scheduleClientRestore）；</li>
 *   <li>页面打点停止（浏览器没了 / 页面被卸载）→ 心跳线程 20s 内恢复（{@link #tickRound}）；</li>
 *   <li>**进程一起动就自愈**：没有「页面仍在 XR」的新鲜证据 → 恢复（{@link #onProcessStart}）；</li>
 *   <li>**死人开关**（AlarmManager，60s，见 {@link #holdForXr} / {@link #onFuse}）：
 *       停用期间每收到一条新鲜 XR 打点就续期；一旦 60s 内没有新打点（= 本进程被杀过、页面没了）
 *       → 无条件恢复。LMK 杀进程**不会**取消闹钟，所以「进程被系统回收」这条能自愈；</li>
 *   <li>开机广播 → 无条件恢复（{@link BootReceiver}）；</li>
 *   <li>**人工恢复（非 Activity 通道）**：停用期间包内**没有任何图标**，自救走
 *       `http://&lt;头显IP&gt;:8080/api/entry/unlock`（PC 浏览器即可）或重启头显。
 *       `RecoverActivity` 的实现保留（清单里 `enabled=false`），但第二十八修起**不再启用**它 ——
 *       它一旦启用就重新变成平台隐式 intent 的靶子（见上文第二十八修）。</li>
 * </ol>
 *
 * <h3>配置</h3>
 * 配置页勾选框 `cbEntryLock`（SharedPreferences `cast` / 键 `entryLock`，**默认开**）可一键关掉本机制；
 * 也可以用本机 HTTP 接口现场操作（见 GameServer 的 `/api/entry/*`）。
 */
public final class EntryLock {

    private static final String TAG = "CastEntryLock";
    private static final String PREFS = "cast";
    /** 停用状态（跨进程存活）：平台入口当前是否被我们停用 */
    private static final String K_LOCKED = "entry_locked";
    /** 停用时刻（ms），只用于留痕/诊断 */
    private static final String K_LOCKED_AT = "entry_locked_at";
    /** 配置页开关键（与 activity_main.xml 的 cbEntryLock 口径一致，默认 "1"=开） */
    public static final String K_SWITCH = "entryLock";
    /** 死人开关周期：停用期间每收到一条新鲜 XR 打点都续期 */
    private static final long FUSE_MS = 60000L;
    /** 续期节流：页面每秒轮询都会走到续期逻辑，没必要每秒重设一次系统闹钟（20s 一次足够） */
    private static final long FUSE_REARM_MIN_GAP_MS = 20000L;
    /** 心跳线程用它判断「本局还在跑吗」：页面打点超过这么久没来 = 本局已不在跑 */
    private static final long PAGE_STALE_MS = 20000L;
    /** 「页面此刻仍在 XR 里」的新鲜度门槛（与 PagePresence.ALIVE_FRESH_MS 同量级） */
    private static final long XR_FRESH_MS = 6000L;
    public static final String ACTION_FUSE = "com.local.webxrcast.ENTRY_UNLOCK_FUSE";
    /** 判据/机制版本标记（写进留痕，事后能确认装的是哪一版） */
    public static final String BUILD_NOTE = "第二十八修-包内零入口";

    /**
     * 进程内缓存：我们最后一次下发的使能状态。
     * 用途：页面每秒轮询一次 `?xr=`，若每次都去调 PackageManager 就是每秒两次无意义的系统调用
     * （也会在 logcat 里刷屏）。-1 = 未知（进程刚起来，需要先 syncCache）。
     */
    private static int appliedEntry = -1;
    private static int appliedRecover = -1;
    /** 上次续期死人开关的时刻（ELAPSED_REALTIME），用于节流 */
    private static volatile long lastFuseArmAt = 0L;
    /** 「开关关掉了」这条留痕只在进程内提示一次，别刷屏 */
    private static boolean warnedSwitchOff = false;

    private EntryLock() {}

    // ───────────────────────── 基础读写 ─────────────────────────

    private static Context ctx(Context c) {
        return (c != null) ? c : CastApp.APP;
    }

    private static SharedPreferences prefs(Context c) {
        try {
            Context a = ctx(c);
            if (a == null) return null;
            return a.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        } catch (Throwable e) {
            return null;
        }
    }

    /** 配置页开关：默认**开**（关掉 = 回到第二十六修的行为：不拦平台的重复 am start） */
    public static boolean switchOn(Context c) {
        SharedPreferences p = prefs(c);
        if (p == null) return true;
        try {
            return !"0".equals(p.getString(K_SWITCH, "1"));
        } catch (Throwable e) {
            return true;
        }
    }

    /** 现场/接口改开关（配置页勾选框也走这里，保证留痕口径一致） */
    public static void setSwitch(Context c, boolean on) {
        Context a = ctx(c);
        if (a == null) return;
        try {
            prefs(a).edit().putString(K_SWITCH, on ? "1" : "0").apply();
            PageForensics.line("APK", "本局在 VR 中临时停用平台入口=" + on
                    + (on ? " → 平台重拉会被系统直接拒绝（防弹窗）"
                          : " → 回到旧行为：平台重拉会建 2D 面板并弹「退出PICO浏览器」"));
            if (!on) release(a, "开关被关掉");
        } catch (Throwable e) {
            Log.w(TAG, "写开关失败: " + e);
        }
    }

    public static boolean isLocked(Context c) {
        SharedPreferences p = prefs(c);
        if (p == null) return false;
        try {
            return p.getBoolean(K_LOCKED, false);
        } catch (Throwable e) {
            return false;
        }
    }

    public static long lockedAt(Context c) {
        SharedPreferences p = prefs(c);
        if (p == null) return 0L;
        try {
            return p.getLong(K_LOCKED_AT, 0L);
        } catch (Throwable e) {
            return 0L;
        }
    }

    private static void setLockedFlag(Context a, boolean locked) {
        try {
            SharedPreferences.Editor e = prefs(a).edit();
            e.putBoolean(K_LOCKED, locked);
            if (locked) e.putLong(K_LOCKED_AT, System.currentTimeMillis());
            // commit（不是 apply）：平台紧接着可能 force-stop 本进程，异步写有丢的风险
            e.commit();
        } catch (Throwable e) {
            Log.w(TAG, "写停用标记失败: " + e);
        }
    }

    // ───────────────────────── 组件使能开关 ─────────────────────────

    /** 归一化：把 DEFAULT / DISABLED_USER 之类都折成「启用 / 停用」两态，便于比较 */
    private static int norm(int state) {
        switch (state) {
            case PackageManager.COMPONENT_ENABLED_STATE_DISABLED:
            case PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER:
            case PackageManager.COMPONENT_ENABLED_STATE_DISABLED_UNTIL_USED:
                return PackageManager.COMPONENT_ENABLED_STATE_DISABLED;
            default:
                return PackageManager.COMPONENT_ENABLED_STATE_ENABLED;
        }
    }

    /** 读回系统里真实的组件状态，填进进程内缓存（每个新进程进来先同步一次） */
    private static void syncCache(Context a) {
        try {
            PackageManager pm = a.getPackageManager();
            appliedEntry = pm.getComponentEnabledSetting(new ComponentName(a, MainActivity.class));
            appliedRecover = pm.getComponentEnabledSetting(new ComponentName(a, RecoverActivity.class));
        } catch (Throwable e) {
            appliedEntry = -1;
            appliedRecover = -1;
        }
    }

    /**
     * 落一次组件状态：`entry` = 平台入口 MainActivity 是否启用；`recover` = 人工恢复入口是否启用。
     * 与进程内缓存一致时**跳过**（页面每秒轮询，绝不能每秒调两次 PackageManager）。
     */
    private static void apply(Context a, boolean entry, boolean recover) {
        PackageManager pm;
        try {
            pm = a.getPackageManager();
            if (pm == null) return;
        } catch (Throwable e) {
            return;
        }
        if (appliedEntry == -1 || appliedRecover == -1) syncCache(a);
        final int wantEntry = entry
                ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                : PackageManager.COMPONENT_ENABLED_STATE_DISABLED;
        final int wantRecover = recover
                ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                : PackageManager.COMPONENT_ENABLED_STATE_DISABLED;
        if (norm(appliedEntry) != wantEntry) {
            try {
                pm.setComponentEnabledSetting(new ComponentName(a, MainActivity.class),
                        wantEntry, PackageManager.DONT_KILL_APP);
                appliedEntry = wantEntry;
                Log.i(TAG, "平台入口 MainActivity 组件状态 → " + (entry ? "启用" : "停用"));
            } catch (Throwable e) {
                Log.w(TAG, "改平台入口状态失败: " + e);
            }
        }
        if (norm(appliedRecover) != wantRecover) {
            try {
                pm.setComponentEnabledSetting(new ComponentName(a, RecoverActivity.class),
                        wantRecover, PackageManager.DONT_KILL_APP);
                appliedRecover = wantRecover;
                Log.i(TAG, "恢复入口 RecoverActivity 组件状态 → " + (recover ? "启用" : "停用"));
            } catch (Throwable e) {
                Log.w(TAG, "改恢复入口状态失败: " + e);
            }
        }
    }

    // ───────────────────────── 对外动作 ─────────────────────────

    /**
     * **停用平台入口**（页面此刻在 XR 沉浸式会话里）。
     * 幂等：已停用则只续期死人开关；页面每秒轮询都会调到这里，故必须廉价。
     */
    public static void holdForXr(Context c, String why) {
        Context a = ctx(c);
        if (a == null) return;
        if (!switchOn(a)) {
            if (!warnedSwitchOff) {
                warnedSwitchOff = true;
                PageForensics.line("APK", "入口停用机制已按配置**关闭** → 本局在 VR 中不拦平台的重复 am start"
                        + "（重拉时仍可能弹「退出PICO浏览器」）");
            }
            return;
        }
        rearmFuse(a);
        if (isLocked(a)) return;
        apply(a, false, false);         // 平台入口 + 恢复入口**都**停用 ⇒ 包内零入口（见类注释「第二十八修」）
        setLockedFlag(a, true);
        PageForensics.line("APK", "★ 平台入口已临时停用（" + why + "）：本局在 VR 里，包内**已无可被"
                + " MAIN/LAUNCHER 隐式意图解析的组件**（入口与恢复入口同时停用）→ 平台再 am start 只会解析失败，"
                + "不产生 2D 面板 / 闪屏 / 弹窗；退出 VR、本局结束、页面打点停止、死人开关 60s、开机、"
                + "或 PC 访问 /api/entry/unlock 都会恢复（" + BUILD_NOTE + "）");
    }

    /**
     * **页面轮询带来的 XR 状态**（GameServer 每秒调一次）：
     * 在 XR 里 → 停用平台入口；已退出 VR → 立刻恢复。
     */
    public static void onPageXr(Context c, boolean xr) {
        if (xr) holdForXr(c, "页面在 XR 沉浸式会话里（?xr=1）");
        else release(c, "页面已退出 VR 会话（?xr=0）");
    }

    /** **恢复平台入口**（幂等）。已是正常态时什么都不做（不刷盘、不留痕）。 */
    public static void release(Context c, String why) {
        Context a = ctx(c);
        if (a == null) return;
        if (appliedEntry == -1 || appliedRecover == -1) syncCache(a);
        final boolean was = isLocked(a);
        final boolean alreadyNormal = !was
                && norm(appliedEntry) == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                && norm(appliedRecover) == PackageManager.COMPONENT_ENABLED_STATE_DISABLED;
        if (alreadyNormal) return;
        cancelFuse(a);
        apply(a, true, false);
        if (was) {
            setLockedFlag(a, false);
            PageForensics.line("APK", "平台入口已恢复（" + why + "）→ 平台下一次「启动游戏」可正常拉起（"
                    + BUILD_NOTE + "）");
        }
    }

    /**
     * **进程启动时的自愈**（CastApp.onCreate 调）。
     * 只要有「页面仍在 XR 里」的新鲜证据就保持停用，否则一律恢复 ——
     * 这一条能兜住「上一进程在停用状态下被杀，平台又把我们拉起来了」的所有情形。
     */
    public static void onProcessStart(Context c) {
        Context a = ctx(c);
        if (a == null) return;
        syncCache(a);
        final boolean locked = isLocked(a);
        final long age = PagePresence.ageMs();
        final boolean freshXr = PagePresence.lastXr() && age >= 0 && age <= XR_FRESH_MS;
        PageForensics.line("APK", "入口停用状态(" + BUILD_NOTE + ")：locked=" + locked
                + (locked ? "（" + ((System.currentTimeMillis() - lockedAt(a)) / 1000) + "s 前锁定）" : "")
                + " 开关=" + (switchOn(a) ? "开" : "关") + " 组件=" + componentStateStr(a)
                + "；" + PagePresence.describe());
        if (!locked) {
            apply(a, true, false);
            return;
        }
        if (freshXr) {
            rearmFuse(a);
            PageForensics.line("APK", "入口停用保持：页面 " + (age / 1000) + "s 前还在 XR 会话里（本进程应是刚被系统拉起）");
            return;
        }
        release(a, "进程启动自愈：没有「页面仍在 XR」的新鲜证据（" + PagePresence.describe() + "）");
    }

    /**
     * **心跳线程（每 5s）调**：本局还在跑就保持停用；页面打点停了（浏览器没了 / 页面被卸载）
     * 就恢复。判据刻意宽松（20s），避免页面偶尔卡一下就被误导通。
     */
    public static void tickRound(Context c) {
        Context a = ctx(c);
        if (a == null) return;
        if (!isLocked(a)) return;
        final long age = PagePresence.ageMs();
        if (age >= 0 && age <= PAGE_STALE_MS) return;
        release(a, "页面打点已停止" + (age < 0 ? "（无记录）" : (" " + (age / 1000) + "s")) + "（本局已不在跑）");
    }

    /** **死人开关到点**（EntryFuseReceiver 调）：还新鲜就续期，否则无条件恢复 */
    public static void onFuse(Context c) {
        Context a = ctx(c);
        if (a == null) return;
        if (!isLocked(a)) return;
        final long age = PagePresence.ageMs();
        if (PagePresence.lastXr() && age >= 0 && age <= XR_FRESH_MS) {
            PageForensics.line("APK", "死人开关到点：页面 " + (age / 1000) + "s 前仍在 XR（本进程应是刚被拉起）"
                    + " → 续期 " + (FUSE_MS / 1000) + "s");
            rearmFuse(a);
            return;
        }
        release(a, "死人开关：" + (FUSE_MS / 1000) + "s 内没有新的 XR 打点（进程/页面已中断）");
    }

    // ───────────────────────── 死人开关（AlarmManager） ─────────────────────────

    private static PendingIntent fuseIntent(Context a) {
        Intent it = new Intent(a, EntryFuseReceiver.class);
        it.setAction(ACTION_FUSE);
        final int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        try {
            return PendingIntent.getBroadcast(a, 1001, it, flags | PendingIntent.FLAG_IMMUTABLE);
        } catch (Throwable e) {
            return PendingIntent.getBroadcast(a, 1001, it, flags);
        }
    }

    /**
     * 续期死人开关。用 `ELAPSED_REALTIME_WAKEUP`（不用 RTC）：
     * 设备重启后自动失效 —— 重启场景已由 BootReceiver 无条件恢复兜住，不会出现「重启后仍停用」。
     * 用 `set()`（非精确）：晚一点触发没关系（晚触发只意味着多停用一会儿，语义更保守），
     * 也避免 Android 12+ 的精确闹钟权限。
     */
    private static void rearmFuse(Context a) {
        try {
            final long now = SystemClock.elapsedRealtime();
            if (now - lastFuseArmAt < FUSE_REARM_MIN_GAP_MS) return;   // 节流（见常量注释）
            AlarmManager am = (AlarmManager) a.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, now + FUSE_MS, fuseIntent(a));
            lastFuseArmAt = now;
        } catch (Throwable e) {
            Log.w(TAG, "续期死人开关失败: " + e);
        }
    }

    private static void cancelFuse(Context a) {
        try {
            AlarmManager am = (AlarmManager) a.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            am.cancel(fuseIntent(a));
        } catch (Throwable e) {
            Log.w(TAG, "取消失人开关失败: " + e);
        }
    }

    // ───────────────────────── 诊断 ─────────────────────────

    /** 组件真实状态一行（诊断用：确认「停用」真的落到系统里了） */
    public static String componentStateStr(Context c) {
        try {
            PackageManager pm = c.getPackageManager();
            int e = pm.getComponentEnabledSetting(new ComponentName(c, MainActivity.class));
            int r = pm.getComponentEnabledSetting(new ComponentName(c, RecoverActivity.class));
            return "入口=" + stateName(e) + " 恢复入口=" + stateName(r);
        } catch (Throwable e) {
            return "组件状态未知";
        }
    }

    private static String stateName(int s) {
        if (s == PackageManager.COMPONENT_ENABLED_STATE_DISABLED) return "DISABLED";
        if (s == PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER) return "DISABLED_USER";
        if (s == PackageManager.COMPONENT_ENABLED_STATE_DISABLED_UNTIL_USED) return "DISABLED_UNTIL_USED";
        if (s == PackageManager.COMPONENT_ENABLED_STATE_ENABLED) return "ENABLED";
        return "DEFAULT";
    }

    /** 一行可读状态（配置页 / `/api/entry` / 留痕共用） */
    public static String describe(Context c) {
        Context a = ctx(c);
        if (a == null) return "（无 Context）";
        final boolean locked = isLocked(a);
        final long at = lockedAt(a);
        return "平台入口=" + (locked
                    ? ("已临时停用（" + ((System.currentTimeMillis() - at) / 1000) + "s 前）")
                    : "正常启用")
                + " 开关=" + (switchOn(a) ? "开" : "关")
                + " " + componentStateStr(a);
    }
}
