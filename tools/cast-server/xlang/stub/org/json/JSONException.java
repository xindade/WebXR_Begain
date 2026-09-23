package org.json;

/**
 * ⚠️ JDK 下的**最小替身**，仅供 {@code tools/cast-server/xlang} 离线夹具编译/运行
 * （Android 真机用的是系统自带的 {@code org.json}）。
 *
 * <p>刻意让它与 Android 版同形：{@code JSONException extends Exception}（**受检异常**），
 * 这样夹具能连「调用方是否真的 catch 住了」一起验证。
 */
public class JSONException extends Exception {
    public JSONException(String message) {
        super(message);
    }
}
