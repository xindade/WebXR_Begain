package com.local.webxrcast;

// ⚠️ UNVERIFIED / STAGING ───────────────────────────────────────────────────────
// 本文件是「方案A（应用内 GeckoView 跑 WebXR）」的集成代码，写在 gecko 产品风味（flavor）里。
// 它引用 org.mozilla.geckoview.* ，只有在你把自编译的 GeckoView AAR 放到
// app/libs/ 并按 ACTIVATE.md 激活 gecko 风味后才会被编译。
// API 依据 GeckoView ~128–140；若你 checkout 的 Gecko tag 不同导致编译报错，按编译器提示微调即可
// （多为方法名/返回类型变化，逻辑结构不变）。
// ──────────────────────────────────────────────────────────────────────────────

import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.browser.customtabs.CustomTabsIntent;

import org.mozilla.geckoview.AllowOrDeny;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoRuntimeSettings;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoView;
import org.mozilla.geckoview.GeckoSessionSettings;

import java.io.IOException;

/**
 * 方案A 入口：用 GeckoView（自带 WebXR / OpenXR 后端）在应用内直接渲染游戏并进入 VR，
 * 不依赖系统 WebView，也不弹外部浏览器。
 *
 * 行为：
 *   1) 启动即起本地 GameServer（assets/game 托管在 http://localhost:8080）；
 *   2) 局域网发现 PC 接收端（可选推流）；
 *   3) GeckoView 加载游戏；等待房间 / 第 1 关均在应用内运行；
 *   4) 进入 VR 由游戏内「进入 VR」触发，GeckoView 的 WebXR 后端直接对接 PICO 的 OpenXR 运行时；
 *   5) 仅保留一个手动「用 PICO 浏览器打开」兜底按钮（GeckoView 万一也不支持时人工逃生，不自动弹窗）。
 *
 * 权限：本地安全来源（http://localhost）自动放行所有站点权限（含 PERMISSION_XR、媒体、定位），
 *       以保证 WebXR 能正常请求与呈现。
 */
public class MainActivity extends AppCompatActivity {

    private static final int LOCAL_PORT = 8080;
    private static final long DISCOVER_TIMEOUT_MS = 8000;

    private EditText etPc;
    private TextView tvStatus;
    private View manualPanel;
    private Button btnBrowser;
    private SharedPreferences sp;
    private GameServer server;
    private Discovery discovery;
    private volatile boolean launched = false;          // 防止重复跳转 PC 推流

    private GeckoView geckoView;
    private GeckoRuntime runtime;
    private GeckoSession session;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        etPc = findViewById(R.id.etPc);
        tvStatus = findViewById(R.id.tvStatus);
        manualPanel = findViewById(R.id.manualPanel);
        btnBrowser = findViewById(R.id.btnBrowser);
        sp = getSharedPreferences("cast", MODE_PRIVATE);
        etPc.setText(sp.getString("pc", ""));

        Button btnStart = findViewById(R.id.btnStart);
        btnStart.setOnClickListener(v -> startCast());
        // 兜底：GeckoView 万一也不支持 WebXR 时，手动跳 PICO 浏览器（不自动弹）
        btnBrowser.setOnClickListener(v -> openInPicoBrowser());

        // 1) 起本地游戏服务
        server = new GameServer(getAssets(), LOCAL_PORT);
        try {
            server.start();
        } catch (IOException e) {
            tvStatus.setText("本地服务启动失败：" + e.getMessage());
            manualPanel.setVisibility(View.VISIBLE);
            return;
        }

        // 2) 自动发现 PC 接收端
        tvStatus.setText("正在搜索 PC 接收端…");
        manualPanel.setVisibility(View.GONE);
        discovery = new Discovery();
        discovery.start(this, (ip, port) -> runOnUiThread(() -> onPcFound(ip + ":" + port)));

        // 3) 初始化并加载游戏到 GeckoView
        setupGeckoView();

        // 4) 超时兜底：未找到 PC 才提示可手动输入（不阻断独立游玩）
        new android.os.Handler(getMainLooper()).postDelayed(() -> {
            if (!launched) {
                tvStatus.setText("未自动找到 PC（可忽略，直接游玩）；如需推流请手动输入地址后点击启动");
                manualPanel.setVisibility(View.VISIBLE);
            }
        }, DISCOVER_TIMEOUT_MS);
    }

    private void setupGeckoView() {
        geckoView = findViewById(R.id.geckoView);
        if (geckoView == null) return;

        // 运行时设置：开启 JS（WebXR/游戏逻辑必需）；开启远程调试便于排查
        GeckoRuntimeSettings settings = new GeckoRuntimeSettings.Builder()
                .javaScriptEnabled(true)
                .remoteDebuggingEnabled(true)
                .build();

        runtime = GeckoRuntime.create(this, settings);

        session = new GeckoSession();
        session.setPermissionDelegate(new PermissionDelegate());
        // 页面加载完成后可在此做 XR 能力检测（见下方注释），当前先直接进游戏
        session.setProgressDelegate(new GeckoSession.ProgressDelegate() {
            @Override
            public void onPageStop(GeckoSession session, boolean success) {
                // 可选：在此用 session.evaluateJS(...) 检测 navigator.xr.isSessionSupported('immersive-vr')，
                // 若返回 false 再显示 manualPanel/btnBrowser 作为兜底。当前版本保持简单，不自动弹窗。
            }
        });

        session.open(runtime);
        geckoView.setSession(session);
        loadGame(null);
    }

    // 构造游戏地址（与 WebView 版一致）：pc 非空 → ?cast=1&pc=… 开启推流；空 → 独立运行
    private String gameUrl(String pc) {
        return "http://localhost:" + LOCAL_PORT + "/" + (pc != null ? "?cast=1&pc=" + pc : "");
    }

    private void loadGame(String pc) {
        if (session == null) return;
        session.loadUri(gameUrl(pc));
    }

    private void onPcFound(String pc) {
        if (launched) return;
        sp.edit().putString("pc", pc).apply();
        if (discovery != null) discovery.stop();
        if (manualPanel != null) manualPanel.setVisibility(View.GONE);
        loadGame(pc);
    }

    private void startCast() {
        if (launched) return;
        String pc = etPc.getText().toString().trim();
        if (pc.isEmpty()) {
            etPc.setError("必填：PC 接收端地址");
            return;
        }
        onPcFound(pc);
    }

    // 兜底：手动用 PICO 浏览器全屏打开同一地址（仅在用户点按钮时触发，不自动弹窗）
    private void openInPicoBrowser() {
        try {
            String url = gameUrl(null);
            Uri uri = Uri.parse(url);
            String[] picoPkgs = { "com.pico.browser", "com.pico.browser.overseas" };
            for (String pkg : picoPkgs) {
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, uri);
                    i.setPackage(pkg);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                    return;
                } catch (Exception ignored) { /* 该包名未安装，尝试下一个 */ }
            }
            CustomTabsIntent intent = new CustomTabsIntent.Builder()
                    .setToolbarColor(0xFF101014)
                    .setShowTitle(false)
                    .build();
            intent.launchUrl(this, uri);
        } catch (Exception ignored) { /* 连浏览器都无法拉起时，保持应用内 GeckoView */ }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (geckoView != null) geckoView.onResume();
    }

    @Override
    protected void onPause() {
        if (geckoView != null) geckoView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (discovery != null) discovery.stop();
        if (session != null) { session.close(); session = null; }
        if (runtime != null) { runtime.shutdown(); runtime = null; }
        if (server != null) { server.stop(); server = null; }
        super.onDestroy();
    }

    /**
     * 自动放行所有本地权限：确保 WebXR（PERMISSION_XR）、媒体、定位等都能在
     * http://localhost 安全来源下被授予，游戏可直接进 VR，无需弹权限框。
     */
    private class PermissionDelegate implements GeckoSession.PermissionDelegate {
        @Override
        public void onAndroidPermissionsRequest(GeckoSession session, String[] permissions, Callback callback) {
            // 离线本地游戏：直接全部授予
            callback.grant();
        }

        @Override
        public GeckoResult<Integer> onContentPermissionRequest(GeckoSession session, ContentPermission perm) {
            // 关键：允许 PERMISSION_XR（WebXR）以及定位/通知/存储等
            return GeckoResult.fromValue(ContentPermission.VALUE_ALLOW);
        }

        @Override
        public void onMediaPermissionRequest(GeckoSession session, String uri,
                                             MediaSource[] video, MediaSource[] audio,
                                             MediaCallback callback) {
            callback.grant(
                    (video != null && video.length > 0) ? video[0] : null,
                    (audio != null && audio.length > 0) ? audio[0] : null);
        }
    }
}
