package com.local.webxrcast;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * 开机广播 → **无条件恢复平台入口**（第二十七修，见 {@link EntryLock}）。
 *
 * 场景：场地收工关机时头显里正好还留着一局的「平台入口停用」状态。
 * 开机时一定没有本局在跑，所以这里不需要任何判据 —— 直接恢复，
 * 保证平台下一次「启动游戏」一定能把我们拉起来。
 *
 * ⚠ 被 `am force-stop` 过的包处于「stopped」态，系统**不会**派发隐式广播（含开机广播）；
 * 那种极端情况靠应用列表里的「恢复入口」图标（RecoverActivity）自救。
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            PageForensics.init(context);
            PageForensics.line("APK", "开机广播（" + (intent != null ? intent.getAction() : "?")
                    + "）→ 无条件恢复平台入口");
            EntryLock.release(context, "开机：本机不可能有本局在跑");
        } catch (Throwable e) {
            Log.w("CastEntryLock", "开机恢复失败: " + e);
        }
    }
}
