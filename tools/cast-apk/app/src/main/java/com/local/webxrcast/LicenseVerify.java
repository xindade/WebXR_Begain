package com.local.webxrcast;

import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;

/**
 * ★ P3（2026-09-20 落地）：头显侧「直播端授权」校验核心。
 *
 * <p>它是方案 {@code docs/tech/08-授权服务器与License方案.md} §4.3 那七步的**③④⑤**，
 * 解决的是同一个问题：<b>怎么确认对面那台「直播端」真的是我们授权的，而不是一台假冒的 / 拷了别人
 * license 的机器？</b>
 *
 * <h3>为什么要单独一个类，而不是塞进 MainActivity</h3>
 * 因为这段逻辑必须能在 PC 上**离线跑同一份源码**（见 {@code tools/cast-server/xlang/}：Java 验签
 * 与 Node 签发互认）。塞进 Activity 就再也测不了 —— 而「跨语言签名对不齐」是本方案唯一一类
 * <b>现象只有「永远验不过」</b>的故障，只能靠这种「同一份代码、两端各跑一次」的方式定位。
 * 因此本类除 {@link Base64}（Android 平台 API，minSdk 24 下 {@code java.util.Base64} 不可用）
 * 与 {@code org.json} 外，<b>零 Android 依赖</b>，不碰 Activity / Context / 网络。
 *
 * <h3>校验链（任何一步不过 = 判 DENY，且绝不向外抛异常）</h3>
 * <ol>
 *   <li><b>nonce 回显</b>：我们当场给的随机数必须原样回来 —— 否则是重放一段旧响应；</li>
 *   <li><b>Ks_pub 验 license 签名</b>：license 由服务器签发私钥 {@code Ks} 签，头显只持有公钥
 *       {@code Ks_pub}（硬编码）⇒ 伪造不了；</li>
 *   <li><b>时间窗</b>：{@code nbf ≤ now ≤ exp}（容忍 ±skew）。纯本地判定，
 *       <b>断网也能正确判出「已到期」</b>；</li>
 *   <li><b>取 {@code ke}</b>：从 license 的 payload 里取出该 EXE 实例的公钥；</li>
 *   <li><b>用 {@code ke} 验 proof</b>：{@code proof = Ke_sign("cast|" + nonce)}，
 *       绑的是②里那个当场随机数 ⇒ <b>把 license 拷到别的机器上过不了这一关</b>
 *       （那台机器没有 {@code Ke} 私钥，签不出对应的 proof）。</li>
 * </ol>
 *
 * <h3>签名编码（跨语言对齐，改不得）</h3>
 * <ul>
 *   <li>算法 {@code ECDSA P-256 + SHA-256}；Java 侧 {@code Signature.getInstance("SHA256withECDSA")}
 *       默认就是 DER，与 Node 的默认输出一致 —— 所以<b>两端都不许传 p1363</b>；</li>
 *   <li>签名对象 = license 左侧那段 base64url <b>文本本身</b>（按 ASCII 取字节），
 *       <b>不是</b> JSON 原文 —— 否则两端 JSON 键序/空格差异会导致算不出同一串；</li>
 *   <li>base64：{@code Ks_pub} 是<b>标准</b> base64（带 {@code =}），payload 里的 {@code ke}
 *       与签名是 <b>base64url</b>（Node 的 'base64url' 不带填充）。</li>
 * </ul>
 *
 * <p>⚠️ <b>{@link #b64Decode} 刻意不用 {@code Base64.NO_PADDING}。</b>
 * AOSP 里 {@code NO_PADDING} 既影响编码也影响解码，而各版本对「缺填充 / 多填充」的容忍度并不一致；
 * 一旦解码抛异常，现象就是「永远验不过」，极难查。所以这里统一<b>先把 base64url 归一化
 * （换字符 + 按需补 {@code =}）再按 {@code Base64.DEFAULT} 解</b>，把填充问题彻底挪出平台差异区。
 */
public final class LicenseVerify {

    private LicenseVerify() { }

    // ─────────────────────────── 结论类别 ───────────────────────────
    // 调用方（MainActivity.guardWaitLoop）**必须**按类别分流 —— 这正是第十六修最大的坑：
    // 旧实现把「404 / 连不上」也当成「被拒绝」，于是报出误导性的「本机未获授权」，
    // 真因被彻底掩盖（见硬约束 61）。

    /** 校验通过：对面是拿到有效 license 的**正版直播端**。 */
    public static final int KIND_OK = 0;
    /** 有明确结论的拒绝：验签不过 / 已到期 / nonce 不符 / 对端自己说没授权。 */
    public static final int KIND_DENY = 1;
    /** 对端**没有这个接口**（HTTP 404）⇒ 是旧版接收端 EXE，应明确提示「换 EXE」。 */
    public static final int KIND_ABSENT = 2;
    /** 过渡态：连不上 / 超时 / 5xx / 响应读不成 ⇒ **继续重试**，绝不当成拒绝。 */
    public static final int KIND_RETRY = 3;

    /** 一次校验的结论（不可变）。 */
    public static final class Verdict {
        public final int kind;
        /** 人话原因：直接进留痕与提示页，所以必须能自解释 */
        public final String why;
        /** license 编号（DENY 时为空串） */
        public final String lic;
        /** 客户 / 门店标识 */
        public final String cust;
        /** 到期时刻（ms；未知为 0） */
        public final long exp;
        /** 剩余天数（可能为负，表示已过期） */
        public final int daysLeft;

        Verdict(int kind, String why) {
            this(kind, why, "", "", 0L, 0);
        }

        Verdict(int kind, String why, String lic, String cust, long exp, int daysLeft) {
            this.kind = kind;
            this.why = (why == null) ? "" : why;
            this.lic = (lic == null) ? "" : lic;
            this.cust = (cust == null) ? "" : cust;
            this.exp = exp;
            this.daysLeft = daysLeft;
        }

        /** 通过（唯一可以继续拉配置的条件） */
        public boolean ok() { return kind == KIND_OK; }

        /** 过渡态：调用方应**留在重试循环里**，而不是出结论 */
        public boolean retry() { return kind == KIND_RETRY; }
    }

    // ─────────────────────────── 主入口 ───────────────────────────

    /**
     * 判定一份 {@code GET /api/license/current} 的响应体。
     *
     * <p>调用方已完成 HTTP 层分类（404 → {@link #KIND_ABSENT}、连不上 → {@link #KIND_RETRY}），
     * 所以传到这里的一定是 <b>HTTP 200</b> 的响应体。
     *
     * @param body       响应体（EXE 侧 {@code handleLicenseCurrent} 的输出）
     * @param expectNonce 我们发出去的 nonce（必须与回显一致）
     * @param ksPubB64   内置的**标准** base64 签发公钥 {@code Ks_pub}
     * @param nowMs      当前时刻（ms）—— 作为参数传进来，便于离线夹具伪造时间
     * @param skewMs     允许的时钟偏差（ms）
     * @return 结论，**永不返回 null、永不抛异常**
     */
    public static Verdict evaluate(String body, String expectNonce, String ksPubB64,
                                   long nowMs, long skewMs) {
        try {
            if (body == null || body.trim().isEmpty()) {
                return new Verdict(KIND_RETRY, "响应为空");
            }

            JSONObject o;
            try {
                o = new JSONObject(body);
            } catch (Throwable t) {
                // 200 但读不成 JSON ⇒ 当抖动处理（让它重试到超时），不硬判「伪造」
                return new Verdict(KIND_RETRY, "响应不是 JSON（" + t.getClass().getSimpleName() + "）");
            }

            // 对端自己说不行：EXE 侧 licenseGate() 的文案就是「直播端未激活：…」「直播端授权不可用：…」
            if (!o.optBoolean("ok", false)) {
                String w = o.optString("why", "");
                return new Verdict(KIND_DENY,
                        w.isEmpty() ? "直播端出示授权失败（未激活 / 已到期）" : w);
            }

            String license = o.optString("license", "");
            String nonceIn = o.optString("nonce", "");
            String proof = o.optString("proof", "");

            // ── ① nonce 回显：防「重放一段旧响应」（旧响应里的 proof 也是旧的）──
            if (expectNonce == null || expectNonce.isEmpty()) {
                return new Verdict(KIND_DENY, "本机未生成 nonce（内部错误）");
            }
            if (!expectNonce.equals(nonceIn)) {
                return new Verdict(KIND_DENY, "nonce 回显不一致（疑似重放旧响应）");
            }

            // ── ② 拆 license：<base64url(payload)>.<base64url(签名)>，只允许一个分隔点 ──
            int dot = license.indexOf('.');
            if (dot <= 0 || dot >= license.length() - 1) {
                return new Verdict(KIND_DENY, "license 格式非法（不是 <payload>.<签名> 结构）");
            }
            String bodyB64 = license.substring(0, dot);
            String sigB64 = license.substring(dot + 1);
            if (sigB64.indexOf('.') >= 0) {
                return new Verdict(KIND_DENY, "license 格式非法（出现多个分隔点）");
            }

            // ── ③ 用内置 Ks_pub 验签发：伪造不了 ──
            PublicKey ksPub;
            try {
                ksPub = ecdsaPublicKey(b64Decode(ksPubB64));
            } catch (Throwable t) {
                // 内置常量被改坏 / 平台不支持该曲线 —— 这是我们自己的问题，必须显式报出来
                return new Verdict(KIND_DENY, "内置签发公钥不可用（内置常量损坏？" + t.getClass().getSimpleName() + "）");
            }
            if (!verifyAscii(ksPub, bodyB64, sigB64)) {
                return new Verdict(KIND_DENY, "license 签名不通过（对端不是本服务器签发的直播端，或 license 被篡改）");
            }

            // ── ④ payload + 时间窗（纯本地，断网也能判到期）──
            JSONObject p;
            try {
                p = new JSONObject(new String(b64Decode(bodyB64), StandardCharsets.UTF_8));
            } catch (Throwable t) {
                return new Verdict(KIND_DENY, "license payload 解析失败（已验签通过，不应发生）");
            }
            if (p.optInt("v", 0) != 1) {
                return new Verdict(KIND_DENY, "license 格式版本不支持（v=" + p.optInt("v", 0) + "）");
            }
            long nbf = p.optLong("nbf", 0L);
            long exp = p.optLong("exp", 0L);
            String lic = p.optString("lic", "");
            String cust = p.optString("cust", "");
            if (nbf > 0L && nowMs + skewMs < nbf) {
                return new Verdict(KIND_DENY, "直播端授权尚未生效（本机或直播端时钟偏差？）");
            }
            if (exp <= 0L) {
                return new Verdict(KIND_DENY, "license 缺少 exp 字段");
            }
            if (nowMs - skewMs > exp) {
                return new Verdict(KIND_DENY, "直播端授权已到期（到期于 " + fmtMs(exp) + "）");
            }

            // ── ⑤ 用 license 里声明的 ke 验 proof：拷贝 license 过不了这一关 ──
            String ke = p.optString("ke", "");
            if (ke.isEmpty()) {
                return new Verdict(KIND_DENY, "license 缺少 ke 字段");
            }
            PublicKey kePub;
            try {
                kePub = ecdsaPublicKey(b64Decode(ke));
            } catch (Throwable t) {
                return new Verdict(KIND_DENY, "license 里的 ke 不是合法公钥");
            }
            if (!verifyAscii(kePub, "cast|" + nonceIn, proof)) {
                return new Verdict(KIND_DENY,
                        "proof 验签不通过（对面拿的是别台机器的 license，或本机的 nonce 未被真正签名）");
            }

            // 展示用剩余天数**夹到 0 以上**：单次校验允许 ±skew 的时钟偏差，于是「已过 exp
            // 但仍在容差内」也是合法的 —— 那时 floor 会算出 -1，提示成「剩余 -1 天」会让人以为有 bug。
            int daysLeft = (int) Math.max(0.0, Math.floor((exp - nowMs) / 86400000.0));
            String who = cust.isEmpty() ? lic : (cust + " / " + lic);
            return new Verdict(KIND_OK, "直播端授权有效（" + who + "，剩余 " + daysLeft + " 天）",
                    lic, cust, exp, daysLeft);

        } catch (Throwable t) {
            // 兜底：本方法对调用方的契约是「永不抛」，任何漏网异常都降级为「抖动重试」
            return new Verdict(KIND_RETRY, "校验异常（" + t.getClass().getSimpleName() + "）");
        }
    }

    // ─────────────────────────── 密码学底座 ───────────────────────────

    /**
     * 用 SPKI DER 字节造 EC 公钥。
     * <p>license 里的 {@code ke} 与内置的 {@code Ks_pub} 都是这个格式
     * （{@code X509EncodedKeySpec} 吃的就是 SPKI）。
     */
    public static PublicKey ecdsaPublicKey(byte[] spkiDer) throws Exception {
        return KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(spkiDer));
    }

    /**
     * 验一段 ASCII 文本的 base64url 签名。
     *
     * <p>不传任何 {@code dsaEncoding} / p1363 相关设置 —— Java 的 {@code SHA256withECDSA}
     * 默认就是 DER，与 Node {@code crypto.sign('sha256', …)} 的默认输出天然对齐。
     *
     * @return false = 验签不过**或**过程异常（Java 对畸形签名是**抛异常**而不是返回 false，
     *         放任不管会让一份格式错的 license 直接崩掉 App）
     */
    public static boolean verifyAscii(PublicKey pub, String msgAscii, String sigB64u) {
        try {
            if (pub == null) return false;
            byte[] raw = b64Decode(sigB64u);
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initVerify(pub);
            s.update(msgAscii.getBytes("US-ASCII"));
            return s.verify(raw);
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * base64 / base64url → 字节，**填充问题在本地归一化后再交给平台解码器**。
     *
     * <p>为什么不用 {@code Base64.URL_SAFE|NO_WRAP|NO_PADDING} 解码：AOSP 里 {@code NO_PADDING}
     * 既作用于编码也作用于解码，且不同实现对「缺填充 / 多填充」的容忍度不一致 ——
     * 一旦抛 {@code IllegalArgumentException}，现象就是「永远验不过」。这里改成：
     * <ol>
     *   <li>{@code -} → {@code +}、{@code _} → {@code /}（base64url → 标准字母表）；</li>
     *   <li>**没有 {@code =} 时**按 {@code len % 4} 补足填充（已是 4 的倍数则不动）；</li>
     *   <li>交给 {@code Base64.DEFAULT} 解（标准字母表 + 带填充，各版本行为一致）。</li>
     * </ol>
     * 这样 base64 与 base64url、带填充与不带填充**四种写法都能解**，且不依赖 flag 语义。
     */
    public static byte[] b64Decode(String s) {
        String t = (s == null) ? "" : s.trim().replace('-', '+').replace('_', '/');
        if (t.indexOf('=') < 0) {
            int m = t.length() % 4;
            if (m == 2) t = t + "==";
            else if (m == 3) t = t + "=";
            else if (m == 1) throw new IllegalArgumentException("base64 长度非法（%4==1）");
        }
        return Base64.decode(t, Base64.DEFAULT);
    }

    /** 到期时刻 → 人话（失败给原始毫秒数，绝不因为格式化把校验搞崩） */
    public static String fmtMs(long ms) {
        try {
            return new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.US)
                    .format(new java.util.Date(ms));
        } catch (Throwable t) {
            return String.valueOf(ms);
        }
    }
}
