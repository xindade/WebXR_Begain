package com.local.webxrcast;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.util.Log;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.InetAddress;
import java.net.MulticastSocket;

/**
 * 局域网 PC 接收端自动发现：监听 EXE 周期性发出的 UDP 组播信标。
 * 信标内容固定为 "WEBXR-CAST:<端口>"，来自 224.0.0.100:8444。
 * 收到即回调 PC 的 IP 与端口，APK 无需手动输入。
 */
public class Discovery {

    public static final int DISCOVERY_PORT = 8444;
    public static final String GROUP = "224.0.0.100";
    private static final String TAG = "WEBXR-CAST:";       // 信标前缀
    private static final String LOG = "CastDiscovery";

    public interface Callback {
        void onFound(String ip, int port);
    }

    private volatile boolean running = false;
    private MulticastSocket socket;
    private Thread thread;

    /** 开始监听；发现后会持续回调（同一 PC 可能反复触发，调用方自行去重）。 */
    public void start(Context ctx, Callback cb) {
        if (running) return;
        running = true;
        thread = new Thread(() -> {
            WifiManager.MulticastLock lock = null;
            try {
                // 部分 ROM 收组播需先持锁
                WifiManager wm = (WifiManager) ctx.getApplicationContext()
                        .getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    lock = wm.createMulticastLock("cast-discovery");
                    lock.acquire();
                }
                socket = new MulticastSocket(DISCOVERY_PORT);
                socket.joinGroup(InetAddress.getByName(GROUP));
                byte[] buf = new byte[256];
                while (running) {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    socket.receive(p);                 // 阻塞，直到收到信标
                    if (!running) break;
                    String s = new String(p.getData(), 0, p.getLength(), "UTF-8").trim();
                    if (s.startsWith(TAG)) {
                        try {
                            int port = Integer.parseInt(s.substring(TAG.length()).trim());
                            String ip = p.getAddress().getHostAddress();
                            cb.onFound(ip, port);       // 调用方拿到后自行决定停止
                        } catch (NumberFormatException ignore) { /* 非法信标，忽略 */ }
                    }
                }
            } catch (IOException e) {
                Log.e(LOG, "discover error: " + e.getMessage());
            } finally {
                if (socket != null) {
                    try { socket.leaveGroup(InetAddress.getByName(GROUP)); } catch (IOException ignore) {}
                    socket.close();
                }
                if (lock != null && lock.isHeld()) lock.release();
            }
        });
        thread.start();
    }

    /** 停止监听（收到 PC 后或退出时调用）。 */
    public void stop() {
        running = false;
        if (socket != null) {
            try { socket.close(); } catch (Exception ignore) { /* close 会唤醒 receive */ }
        }
        if (thread != null) thread.interrupt();
    }
}
