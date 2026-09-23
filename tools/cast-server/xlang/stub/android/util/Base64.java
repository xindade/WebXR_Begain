package android.util;

/**
 * ⚠️ JDK 下的**最小替身**，仅供 {@code tools/cast-server/xlang} 离线夹具编译/运行
 * （Android 真机用的是系统自带的 {@code android.util.Base64}）。
 *
 * <p>语义对齐说明：
 * <ul>
 *   <li>{@code decode} 底层走 {@code java.util.Base64.getDecoder()} —— <b>要求填充正确</b>。
 *       这一点是<b>故意的</b>：生产代码 {@code LicenseVerify.b64Decode} 刻意在调用侧把
 *       base64url 归一化（换字母表 + 按需补 {@code =}）后才交给平台解码器，所以这里一旦
 *       填充没补对就会直接抛 {@code IllegalArgumentException}，夹具会立刻红 ——
 *       等于顺手把「填充归一化」这件事也纳入了回归。</li>
 *   <li>{@code NO_PADDING} 的差异（AOSP 里它既影响编码也影响解码，各版本容忍度还不一致）
 *       <b>不在这里模拟</b> —— 因为生产代码已经绕开了那个语义（见上一条），
 *       模拟它反而会掩盖真实运行路径。</li>
 * </ul>
 */
public final class Base64 {

    /** 标准 base64，容忍换行 / 空白 */
    public static final int DEFAULT = 0;
    public static final int NO_PADDING = 1;
    public static final int NO_WRAP = 2;
    public static final int URL_SAFE = 8;

    private Base64() { }

    /** base64 文本 → 字节（{@code java.util.Base64.getDecoder()}，要求填充正确） */
    public static byte[] decode(String str, int flags) {
        StringBuilder sb = new StringBuilder();
        String t = (str == null) ? "" : str;
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if (!Character.isWhitespace(c)) sb.append(c);
        }
        String u = sb.toString();
        if ((flags & URL_SAFE) != 0) u = u.replace('-', '+').replace('_', '/');
        return java.util.Base64.getDecoder().decode(u);
    }

    public static byte[] decode(String str) {
        return decode(str, DEFAULT);
    }

    /** 字节 → base64 文本 */
    public static String encodeToString(byte[] input, int flags) {
        String s = java.util.Base64.getEncoder().encodeToString(input);
        if ((flags & URL_SAFE) != 0) s = s.replace('+', '-').replace('/', '_');
        if ((flags & NO_PADDING) != 0) s = s.replace("=", "");
        return s;
    }

    public static String encodeToString(byte[] input) {
        return encodeToString(input, DEFAULT);
    }
}
