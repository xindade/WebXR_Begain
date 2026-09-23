// 跨语言验签对照工具 · Java 侧（模拟头显 APK 的验签方式）
//
//   cd tools/cast-server/xlang
//   java -Dfile.encoding=UTF-8 VerifyLicense.java
//
// 与 P3 头显侧保持同构：
//   · 签名对象 = license 左侧 base64url 文本本身，按 US-ASCII 取字节
//   · Java Signature.getInstance("SHA256withECDSA")（Node 默认输出 DER，天然对齐）
//   · 公钥 = SPKI DER 的 base64 → X509EncodedKeySpec + KeyFactory("EC")
//
// ⚠️ 两个真机（Android）上的注意点，本文件用 JDK 的等价 API 验证编码规则：
//   1) android.util.Base64 要带 NO_PADDING —— Node 的 base64url 不带 '='
//      真机写法： Base64.decode(s, URL_SAFE | NO_WRAP | NO_PADDING)
//   2) java.util.Base64 需要 API 26，本项目 minSdk 24 ⇒ 真机不能用它
//
// ⚠️ 验签必须整段 try/catch：Java 对畸形签名是**抛异常**而不是返回 false，
//    放任不管会让一份格式错的 license 直接崩掉 App。
import java.nio.file.*;
import java.security.*;
import java.security.spec.*;
import java.util.Base64;

public class VerifyLicense {

  /** base64url 解码（无填充）。真机对应 android.util.Base64.URL_SAFE|NO_WRAP|NO_PADDING */
  static byte[] b64u(String s) {
    return Base64.getUrlDecoder().decode(s);
  }

  /** 标准 base64 解码（公钥用） */
  static byte[] b64(String s) {
    return Base64.getDecoder().decode(s);
  }

  /**
   * 按头显的方式验一份 license
   * @return 人类可读的结论（永不抛异常）
   */
  static String check(String lic, PublicKey pub) {
    try {
      int dot = lic.indexOf('.');
      if (dot <= 0 || dot == lic.length() - 1) return "格式非法";
      String body = lic.substring(0, dot);
      String sig = lic.substring(dot + 1);
      if (sig.indexOf('.') >= 0) return "格式非法（多个分隔点）";

      byte[] sigRaw;
      try {
        sigRaw = b64u(sig);
      } catch (Exception e) {
        return "签名解码失败(" + e.getClass().getSimpleName() + ")";
      }

      Signature s = Signature.getInstance("SHA256withECDSA");
      s.initVerify(pub);
      s.update(body.getBytes("US-ASCII"));
      if (!s.verify(sigRaw)) return "验签不通过";
      return "验签通过 | payload=" + new String(b64u(body), "UTF-8");
    } catch (Throwable t) {
      // 任何异常一律当「验签失败」，绝不外抛
      return "异常→视为失败(" + t.getClass().getSimpleName() + ")";
    }
  }

  /** 生成一把无关的 P-256 公钥，用于验证「非本服务器签发」必然失败 */
  static byte[] otherSpki() throws Exception {
    KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
    g.initialize(new ECGenParameterSpec("secp256r1"));
    return g.generateKeyPair().getPublic().getEncoded();
  }

  public static void main(String[] a) throws Exception {
    String lic = Files.readString(Path.of("license.txt")).trim();
    String licTampered = Files.readString(Path.of("license_tampered.txt")).trim();
    String licTamperedSig = Files.readString(Path.of("license_tampered_sig.txt")).trim();
    String pubB64 = Files.readString(Path.of("pubkey.txt")).trim();

    System.out.println("license 长度 = " + lic.length() + " | 带 '='? " + (lic.indexOf('=') >= 0));
    System.out.println("含 base64url 字符 -/_ ? " + (lic.indexOf('-') >= 0 || lic.indexOf('_') >= 0));

    PublicKey pub = KeyFactory.getInstance("EC")
        .generatePublic(new X509EncodedKeySpec(b64(pubB64)));
    System.out.println("签发公钥 = " + pub.getAlgorithm() + "/" + pub.getFormat());
    System.out.println();

    System.out.println("[1] 正常 license      = " + check(lic, pub) + "   <-- 期望「验签通过」");
    System.out.println("[2] 篡改 payload 一位 = " + check(licTampered, pub) + "   <-- 期望「验签不通过」");
    System.out.println("[3] 篡改签名末位      = " + check(licTamperedSig, pub) + "   <-- 期望「验签不通过」");
    System.out.println("[4] 换一把公钥        = " + check(lic, KeyFactory.getInstance("EC")
        .generatePublic(new X509EncodedKeySpec(otherSpki()))) + "   <-- 期望「验签不通过」");
    System.out.println("[5] 空串              = " + check("", pub));
    System.out.println("[6] 无分隔点          = " + check("abcdefghij", pub));
    System.out.println("[7] 垃圾签名          = " + check(lic.substring(0, lic.indexOf('.') + 1) + "AAAA", pub));
  }
}
