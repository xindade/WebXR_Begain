package com.local.webxrcast;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * **死人开关**的接收端（第二十七修，见 {@link EntryLock}）。
 *
 * 为什么需要一个「跨进程」的兜底：本局在 VR 里时平台入口被临时停用，而
 * 「退出 VR / 本局结束 / 页面打点停止 / 开机 / 人工点恢复入口」都要求**我们的进程还活着**。
 * 如果进程被系统回收（LMK，PICO 上很常见）而停用状态还留着，那就没人再能把它恢复 ——
 * 这时闹钟会**把我们的进程拉起来**（闹钟属于系统，进程被杀不会丢；force-stop 会丢，
 * 那种情况由 RecoverActivity 这条人工路径兜住）并在这里恢复平台入口。
 */
public class EntryFuseReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            Log.i("CastEntryLock", "死人开关触发（" + (intent != null ? intent.getAction() : "?") + "）");
            EntryLock.onFuse(context);
        } catch (Throwable e) {
            Log.w("CastEntryLock", "死人开关处理失败: " + e);
        }
    }
}
