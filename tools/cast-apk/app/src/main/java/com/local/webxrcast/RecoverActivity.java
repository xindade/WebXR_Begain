package com.local.webxrcast;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Toast;

/**
 * **人工恢复入口**（第二十七修，见 {@link EntryLock}）—— 现场最后一道自救开关。
 *
 * 平时它是 `android:enabled="false"`（应用列表里看不到，图标就是 MainActivity）；
 * 只有在「本局在 VR 里 → 平台入口被临时停用」期间才被 EntryLock 置为启用。
 * 于是**任何时刻应用列表里都恰好有一个可点的入口**：
 *
 * <pre>
 * 正常态：应用图标 → MainActivity（配置页）
 * 停用态：应用图标 → RecoverActivity（本类）→ 恢复 MainActivity 并打开配置页
 * </pre>
 *
 * 为什么必须有它：`am force-stop` 会连死人开关闹钟一起取消。若平台在停用期间把我们
 * force-stop 掉，自动恢复就全失效了 —— 这时操作员点头显上的游戏图标即可恢复
 * （点图标本身就会清掉 stopped 态并启动本应用）。
 *
 * ⚠ 还有一个**防御性分支**：万一平台的 `am start` 其实是「不带 -n 的隐式 intent」
 * （`-a MAIN -c LAUNCHER`），那么停用期间它可能解析到本类。那种情况下绝不能建 2D 窗口
 * （玩家可能正在 VR 里）—— 本类用 referrer 判出「这次是平台拉起的」后只留痕 + 立刻 finish。
 */
public class RecoverActivity extends Activity {

    /** 平台/启动器拉起我们时的 referrer（见 MainActivity.looksLikeManualLaunch） */
    private boolean looksLikePlatform() {
        try {
            android.net.Uri r = getReferrer();
            String s = (r == null) ? null : r.toString();
            return (s != null) && s.contains("GoodNet");
        } catch (Throwable e) {
            return false;
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // ⚠ 判据要在 super.onCreate() 之前算好：它决定主题（NoDisplay 要求 onResume 前 finish）
        final boolean plat = looksLikePlatform();
        if (plat) {
            try { setTheme(android.R.style.Theme_NoDisplay); } catch (Throwable ignore) { /* 失败就退回普通主题 */ }
        }
        super.onCreate(savedInstanceState);
        if (plat) {
            PageForensics.line("APK", "⚠ 平台的 am start 落到了「恢复入口」上 → 说明平台用的是"
                    + "不带 -n 的隐式 intent（本条请交给平台方改成显式组件）；本次不建界面，立刻 finish");
            finish();
            return;
        }
        try {
            PageForensics.line("APK", "恢复入口被打开（应用图标）→ 恢复平台入口并显示配置页");
            EntryLock.release(this, "人工打开恢复入口");
            Intent it = new Intent(this, MainActivity.class);
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(it);
        } catch (Throwable e) {
            PageForensics.line("APK", "恢复入口：打不开配置页（" + e.getClass().getSimpleName()
                    + ": " + e.getMessage() + "）→ 再点一次图标即可");
            try {
                Toast.makeText(this, "已恢复平台入口，请再点一次图标", Toast.LENGTH_LONG).show();
            } catch (Throwable ignore) { /* 提示失败无所谓 */ }
        }
        finish();
    }
}
