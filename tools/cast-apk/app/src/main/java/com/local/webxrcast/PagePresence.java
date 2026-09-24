package com.local.webxrcast;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

/**
 * 「游戏页还在不在」的**跨进程**记录（2026-09-24 第二十六修）。
 *
 * <h3>为什么需要它（现场实测：平台每 20s 重发一次整套启动）</h3>
 * 平台的「启动游戏」= kill → copyfile(setup.xml) → am start -n <pkg>/.MainActivity -d <PC_IP>，
 * 而平台客户端会**每 20.004 秒重发一次整套**（castlog6.txt 实测）。第二次 am start 时玩家往往
 * 已经在 VR 里 —— 此时只要本 APK 产生**任何 2D 窗口**，PICO 的 XRShell 就会弹
 * 「退出PICO浏览器 / 你需要退出当前应用才能继续操作」并把 XR 沉浸式会话挤掉
 * （该弹窗的定性见 docs/tech/VR+平台版本号实现.md §22.3）。
 *
 * 现有的「免打扰」路径（MainActivity.computePassThrough）本来就是为了这件事：
 *   「平台驱动 + 已拉起过 + 页面仍活」→ 换 NoDisplay 主题、不建界面、立刻 finish。
 * 但它有两个**只在进程存活时**成立的前提：sLaunched 与 GameServer.lastPageHitMs 都是进程内
 * 静态量。平台那套启动里带 kill（am force-stop 本包名）—— 一旦它真的生效，新进程里这两项
 * 全是空的 ⇒ 免打扰判据失效 ⇒ 走完整门禁 + 建「等待直播端启动…」提示页（2D 窗口）⇒
 * **玩家正在 VR 里，弹窗当场出现**（用户 2026-09-24 报的现象：第二次启动时弹「退出浏览器」）。
 *
 * 本类把「页面最后一条请求的时刻 / 状态 / 是否在 XR / 是否待机」写进 SharedPreferences
 * （跨进程存活），让**刚被 kill 掉又立刻被平台拉起来的新进程**也能认出「游戏页还在跑」。
 *
 * <h3>判据（刻意保守）</h3>
 *   · 6 秒内有打点 → 页面肯定还活着（它每秒都打点，6 倍余量）；
 *   · 90 秒内有打点**且当时在 XR 会话里** → 也认定活着。理由：XR 沉浸式会话只可能由一个
 *     **活着的**浏览器标签持有；会话没结束就说明页面没被卸载（平台 kill 杀不到浏览器）。
 *   · 其余一律 false（宁可多建一次配置页，也不要把「页面其实已经没了」当成活着）。
 *
 * 误判代价不对称：把「已死」当成「活着」→ 什么都不显示（有 5 秒后的兜底复核，
 * 见 MainActivity.schedulePassThroughVerify）；把「活着」当成「已死」→ 建 2D 窗口 →
 * 玩家被弹出 VR + 系统弹窗 —— 后者正是本修要消灭的那种。
 */
public final class PagePresence {

    private static final String TAG = "CastPresence";
    private static final String PREFS = "cast";
    private static final String K_HIT = "page_hit_at";
    private static final String K_STATE = "page_state";
    private static final String K_XR = "page_xr";
    private static final String K_CLOSED = "page_closed";
    /** ★ 第二十九修：本局已结束 / 页面已报死 → **在场记录作废**（下一局必须按全新一局处理） */
    private static final String K_DEAD = "page_round_over";

    /** 判据版本标记（写进留痕，事后能确认装的是哪一版判据） */
    public static final String BUILD_NOTE = "第二十九修-本局结束即作废（原第二十六修-跨进程页面在场）";

    /** 写盘节流：页面每秒打点，但没必要每秒刷盘（force-stop 前最多丢 0.7s 的证据） */
    private static final long WRITE_MIN_GAP_MS = 700L;
    /** 「刚刚还在打点」的窗口：6 倍于页面 1s 的轮询周期 */
    private static final long ALIVE_FRESH_MS = 6000L;
    /**
     * 「打点 + 当时在 XR」的窗口：XR 会话只可能由一个活着的页面持有。
     * ★ 第二十九修由 90s 收到 45s：页面只要活着就**每秒**在打点（age ≤ 6s 那条就命中了），
     * 所以这个窗口实际上只在「页面已经不在」时才起作用 ⇒ 越短，被误判成「还活着」的机会越少；
     * 45s 仍足以覆盖平台 20s 的重发周期 + 我们自己的进程重启窗口。
     */
    private static final long ALIVE_XR_MS = 45000L;

    private static long lastWriteAt = 0L;
    private static String lastWriteState = null;
    private static boolean lastWriteXr = false;
    private static boolean lastWriteClosed = false;

    private PagePresence() {}

    private static SharedPreferences prefs() {
        try {
            Context c = CastApp.APP;
            if (c == null) return null;
            return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        } catch (Throwable e) {
            return null;
        }
    }

    /** 页面又发来一条请求（没有状态信息时用，例如 /api/page/event）。 */
    public static void touch() { write(null, null, null); }

    /** 页面轮询带上来的完整状态（/api/vrplus/inbox?pct=&st=&pd=&xr=&cs=）。 */
    public static void note(String state, boolean xr, boolean closed) {
        write(state, Boolean.valueOf(xr), Boolean.valueOf(closed));
    }

    private static void write(String state, Boolean xr, Boolean closed) {
        try {
            SharedPreferences p = prefs();
            if (p == null) return;
            long now = System.currentTimeMillis();
            boolean changed = (state != null && !state.equals(lastWriteState))
                    || (xr != null && xr.booleanValue() != lastWriteXr)
                    || (closed != null && closed.booleanValue() != lastWriteClosed);
            if (!changed && now - lastWriteAt < WRITE_MIN_GAP_MS) return;
            SharedPreferences.Editor e = p.edit();
            e.putLong(K_HIT, now);
            // ★ 第二十九修：页面还在打点 = 它活着 ⇒ 撤掉「本局已结束 / 页面已死」的作废标记。
            e.putBoolean(K_DEAD, false);
            if (state != null) { e.putString(K_STATE, state); lastWriteState = state; }
            if (xr != null) { e.putBoolean(K_XR, xr.booleanValue()); lastWriteXr = xr.booleanValue(); }
            if (closed != null) { e.putBoolean(K_CLOSED, closed.booleanValue()); lastWriteClosed = closed.booleanValue(); }
            // commit（而不是 apply）：平台紧接着可能 force-stop 本进程，异步写有丢掉的风险。
            e.commit();
            lastWriteAt = now;
        } catch (Throwable e) {
            Log.w(TAG, "写页面在场记录失败（忽略）: " + e);
        }
    }

    /** 上一进程最后一次页面打点的时刻（ms）；0 = 从来没有过记录 */
    public static long lastHitAt() {
        SharedPreferences p = prefs();
        if (p == null) return 0L;
        try { return p.getLong(K_HIT, 0L); } catch (Throwable e) { return 0L; }
    }

    /** 上一进程最后看到的页面游戏状态（menu / playing / …），未知 "?" */
    public static String lastState() {
        SharedPreferences p = prefs();
        if (p == null) return "?";
        try { return p.getString(K_STATE, "?"); } catch (Throwable e) { return "?"; }
    }

    /** 上一进程最后看到的「页面是否在 XR 沉浸式会话里」 */
    public static boolean lastXr() {
        SharedPreferences p = prefs();
        if (p == null) return false;
        try { return p.getBoolean(K_XR, false); } catch (Throwable e) { return false; }
    }

    /** 上一进程最后看到的「页面是否处于本局已结束待机态」 */
    public static boolean lastClosed() {
        SharedPreferences p = prefs();
        if (p == null) return false;
        try { return p.getBoolean(K_CLOSED, false); } catch (Throwable e) { return false; }
    }

    /** 距上一进程最后一次页面打点的毫秒数；-1 = 从来没有过记录 */
    public static long ageMs() {
        long t = lastHitAt();
        return (t == 0L) ? -1L : (System.currentTimeMillis() - t);
    }

    /** ★ 第二十九修：本局是否已结束 / 页面是否已报死（在场记录作废标记） */
    public static boolean isRoundOver() {
        SharedPreferences p = prefs();
        if (p == null) return false;
        try { return p.getBoolean(K_DEAD, false); } catch (Throwable e) { return false; }
    }

    /**
     * **把在场记录作废**（第二十九修）——本局结束（退出策略）或页面报死时调。
     *
     * <h3>为什么必须作废（2026-09-24 15:47 现场：第二场起不来）</h3>
     * 上一局结束时页面是**在 XR 里**被杀的（平台 `0x10 closeGame` → 我们关浏览器），
     * 于是跨进程记录里最后一条打点带着 `xr=true`、`state=playing`。下一局平台的 `am start`
     * 落在 ~20-40s 后（仍在 90s 窗口内）⇒ `aliveNow()` 判成「页面还在跑」⇒ 走免打扰路径
     * 「不重开浏览器」⇒ **整局被吞掉**（留痕原话：
     * `上一进程最后打点 18s 前 state=playing xr=true → alive=true` → `不重开浏览器`）。
     *
     * 语义：`markRoundOver` 只置「作废」标记，**不动** `K_HIT`/`K_XR`（`EntryLock.tickRound` 还要用
     * 真实打点时刻判「页面是不是真没了」）；页面下一次打点会立刻撤掉这个标记。
     */
    public static void markRoundOver(String why) {
        try {
            SharedPreferences p = prefs();
            if (p == null) return;
            p.edit().putBoolean(K_DEAD, true).putBoolean(K_CLOSED, true).commit();
            PageForensics.line("APK", "页面在场记录已作废（" + why + "）→ 下一局平台「启动游戏」按**全新一局**处理"
                    + "（会重开浏览器），不会再被「判定页面仍在 → 不重开浏览器」吞掉"
                    + "（第二十九修-本局结束即作废）");
        } catch (Throwable e) {
            Log.w(TAG, "作废页面在场记录失败: " + e);
        }
    }

    /** 上一进程留下的证据是否足以认定「游戏页还在跑」（判据见类注释） */
    public static boolean aliveNow() {
        if (isRoundOver()) return false;      // ★ 第二十九修：本局已结束 / 页面已报死 ⇒ 绝不再当「活着」
        long age = ageMs();
        if (age < 0) return false;
        if (age <= ALIVE_FRESH_MS) return true;
        return age <= ALIVE_XR_MS && lastXr();
    }

    /** 一行可读描述（写进留痕，事后判读用） */
    public static String describe() {
        long age = ageMs();
        if (age < 0) return "无记录（本机此前从未有页面打过点）";
        return "上一进程最后打点 " + (age / 1000) + "s 前 state=" + lastState()
                + " xr=" + lastXr() + " 待机=" + lastClosed() + " 已作废=" + isRoundOver()
                + " → alive=" + aliveNow();
    }
}
