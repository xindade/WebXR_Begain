// P3 离线夹具 · Java 侧驱动（模拟头显）
//
//   cd tools/cast-server && node xlang/p3test.js     # 造样本 + 编译 + 跑（推荐）
//
// 它做的事：读 out/p3-cases.json，对每一条样本调用
// **与头显 APK 完全相同的那一份** com.local.webxrcast.LicenseVerify.evaluate(...)，
// 把算出的类别与 Node 侧声明值逐条比对。
//
// 为什么要这样绕：ECDSA 每次签名随机，"签名字节对不上" 没法用固定向量发现，
// 而跨语言编码差异（base64 带不带填充 / 字母表 / DER vs p1363）的现象**只有"永远验不过"**。
// 唯一的可靠办法就是让两套独立实现各算一次，结论必须一致。
//
// ⚠️ 本文件与 LicenseVerify.java 都只用 JDK 就能跑（android.util.Base64 与 org.json
//    由同目录 stub/ 下的替身提供，仅供离线夹具）。
import java.nio.file.Files;
import java.nio.file.Path;

import org.json.JSONArray;
import org.json.JSONObject;

import com.local.webxrcast.LicenseVerify;

public class VerifyCurrent {

    private static final String[] KIND_NAME = { "OK", "DENY", "ABSENT", "RETRY" };

    public static void main(String[] args) throws Exception {
        Path dir = Path.of(args.length > 0 ? args[0] : "out");
        Path casesFile = dir.resolve("p3-cases.json");
        if (!Files.isRegularFile(casesFile)) {
            System.err.println("找不到样本文件 " + casesFile + "，请先执行：node xlang/gen-p3.js");
            System.exit(2);
        }

        JSONObject root = new JSONObject(Files.readString(casesFile));
        String ksPub = root.optString("ksPubB64", "");
        JSONArray cases = root.optJSONArray("cases");
        if (cases == null) {
            System.err.println("样本文件里没有 cases 数组");
            System.exit(2);
        }

        System.out.println("== 头显侧校验逻辑（LicenseVerify.evaluate）对 " + cases.length() + " 条样本的结论 ==");
        System.out.println();

        int pass = 0;
        int fail = 0;
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.optJSONObject(i);
            if (c == null) continue;
            String name = c.optString("name", "?");
            String want = c.optString("expect", "");
            String body = c.optString("body", "");
            String nonce = c.optString("nonce", "");
            long nowMs = c.optLong("nowMs", 0L);
            long skewMs = c.optLong("skewMs", 300000L);

            // ★ 刻意**不包 try/catch**：evaluate 的契约是「永不抛异常」，
            //   一旦它抛出来，这里直接崩掉就是最响亮的失败信号。
            LicenseVerify.Verdict v = LicenseVerify.evaluate(body, nonce, ksPub, nowMs, skewMs);

            String got = (v.kind >= 0 && v.kind < KIND_NAME.length) ? KIND_NAME[v.kind] : ("kind=" + v.kind);
            boolean whyOk = v.why != null && !v.why.isEmpty();
            boolean ok = got.equals(want) && whyOk;
            if (ok) pass++; else fail++;

            System.out.printf("%s %-24s 期望 %-5s 实得 %-5s | %s%n",
                    ok ? "  PASS" : ">>FAIL", name, want, got, clamp(v.why, 96));
            if (!whyOk) System.out.println("        [!] why 为空 —— 现场排障会变成「不知道为什么被拒」");
        }

        // ── 防「永不抛」契约被破坏的额外探针：畸形入参 ──
        System.out.println();
        System.out.println("== 畸形入参（只要求不抛异常） ==");
        int probeBad = 0;
        probeBad += probe("body=null", () -> LicenseVerify.evaluate(null, "ab", ksPub, 0L, 0L));
        probeBad += probe("body=空串", () -> LicenseVerify.evaluate("", "ab", ksPub, 0L, 0L));
        probeBad += probe("nonce=null", () -> LicenseVerify.evaluate("{}", null, ksPub, 0L, 0L));
        probeBad += probe("ksPub 为空串", () -> LicenseVerify.evaluate("{\"ok\":true}", "ab", "", 0L, 0L));
        probeBad += probe("ksPub 是垃圾", () -> LicenseVerify.evaluate("{\"ok\":true}", "ab", "!!!", 0L, 0L));
        probeBad += probe("body 是数组", () -> LicenseVerify.evaluate("[1,2,3]", "ab", ksPub, 0L, 0L));
        probeBad += probe("字段类型错乱", () -> LicenseVerify.evaluate(
                "{\"ok\":true,\"license\":123,\"nonce\":{},\"proof\":[]}", "ab", ksPub, 0L, 0L));
        if (probeBad == 0) System.out.println("  全部 7 项：未抛异常 [OK]");

        System.out.println();
        if (fail > 0 || probeBad > 0) {
            System.out.println("[FAIL] 失败 " + fail + " 条（另有 " + probeBad + " 项探针抛了异常）");
            System.exit(1);
        }
        System.out.println("[OK] 全部通过：" + pass + "/" + cases.length() + " 条样本 + 7 项畸形入参探针");
    }

    private interface Probe {
        void run();
    }

    /** @return 1 = 抛了异常（失败），0 = 正常返回 */
    private static int probe(String label, Probe p) {
        try {
            p.run();
            System.out.println("  PASS " + label + " → 未抛异常");
            return 0;
        } catch (Throwable t) {
            System.out.println(">>FAIL " + label + " → 抛了 " + t.getClass().getName() + ": " + t.getMessage());
            return 1;
        }
    }

    private static String clamp(String s, int n) {
        if (s == null) return "(null)";
        return (s.length() <= n) ? s : (s.substring(0, n) + "…");
    }
}
