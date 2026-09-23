package org.json;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * ⚠️ JDK 下的**最小替身**，仅供 {@code tools/cast-server/xlang} 离线夹具编译/运行
 * （Android 真机用的是系统自带的 {@code org.json}）。
 *
 * <p>为什么要写它：P3 的核心校验逻辑抽在 {@code com.local.webxrcast.LicenseVerify} 里，
 * 目的就是能在 PC 上跑**同一份源码**。而那个类用了 {@code org.json}（Android 自带、JDK 没有），
 * 于是这里补一个够用的实现 —— 支持对象 / 数组 / 字符串(含转义) / 数字 / true / false / null，
 * 足够解析本方案的响应体与 payload。
 *
 * <p>与 Android 版同形之处：构造函数声明 {@code throws JSONException}，且
 * {@link JSONException} 是<b>受检异常</b> —— 这样夹具会连带验证「调用方是否真的接住了异常」。
 */
public class JSONObject {

    private final Map<String, Object> map;

    /** 解析一份 JSON 对象文本 */
    @SuppressWarnings("unchecked")
    public JSONObject(String text) throws JSONException {
        try {
            Object o = new P(text == null ? "" : text).value();
            if (!(o instanceof Map)) throw new RuntimeException("顶层不是 JSON 对象");
            map = (Map<String, Object>) o;
        } catch (Throwable t) {
            throw new JSONException("不是合法 JSON 对象：" + t);
        }
    }

    private JSONObject(Map<String, Object> src) {
        this.map = src;
    }

    public boolean optBoolean(String key, boolean fallback) {
        Object v = map.get(key);
        return (v instanceof Boolean) ? (Boolean) v : fallback;
    }

    public String optString(String key, String fallback) {
        Object v = map.get(key);
        return (v == null) ? fallback : String.valueOf(v);
    }

    public String optString(String key) {
        return optString(key, "");
    }

    public int optInt(String key, int fallback) {
        Object v = map.get(key);
        if (v instanceof Number) return ((Number) v).intValue();
        try {
            return Integer.parseInt(String.valueOf(v));
        } catch (Exception e) {
            return fallback;
        }
    }

    public long optLong(String key, long fallback) {
        Object v = map.get(key);
        if (v instanceof Number) return ((Number) v).longValue();
        try {
            return Long.parseLong(String.valueOf(v));
        } catch (Exception e) {
            return fallback;
        }
    }

    public JSONObject optJSONObject(String key) {
        Object v = map.get(key);
        return (v instanceof JSONObject) ? (JSONObject) v : null;
    }

    public JSONArray optJSONArray(String key) {
        Object v = map.get(key);
        return (v instanceof JSONArray) ? (JSONArray) v : null;
    }

    public boolean has(String key) {
        return map.containsKey(key);
    }

    public Object opt(String key) {
        return map.get(key);
    }

    // ─────────────────────── 极小递归下降解析器 ───────────────────────

    private static final class P {
        private final String s;
        private int i;

        P(String s) {
            this.s = s;
            this.i = 0;
        }

        Object value() {
            skip();
            if (i >= s.length()) throw new RuntimeException("输入为空");
            char c = s.charAt(i);
            if (c == '{') return object();
            if (c == '[') return array();
            if (c == '"') return string();
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            return number();
        }

        private void skip() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        }

        private Map<String, Object> object() {
            Map<String, Object> o = new LinkedHashMap<>();
            i++;                       // '{'
            skip();
            if (i < s.length() && s.charAt(i) == '}') { i++; return o; }
            while (true) {
                skip();
                if (i >= s.length() || s.charAt(i) != '"') throw new RuntimeException("对象缺键");
                String k = string();
                skip();
                if (i >= s.length() || s.charAt(i) != ':') throw new RuntimeException("对象缺冒号");
                i++;
                o.put(k, wrapAny(value()));
                skip();
                if (i < s.length() && s.charAt(i) == ',') { i++; continue; }
                if (i < s.length() && s.charAt(i) == '}') { i++; return o; }
                throw new RuntimeException("对象未闭合");
            }
        }

        private List<Object> array() {
            List<Object> a = new ArrayList<>();
            i++;                       // '['
            skip();
            if (i < s.length() && s.charAt(i) == ']') { i++; return a; }
            while (true) {
                a.add(wrapAny(value()));
                skip();
                if (i < s.length() && s.charAt(i) == ',') { i++; continue; }
                if (i < s.length() && s.charAt(i) == ']') { i++; return a; }
                throw new RuntimeException("数组未闭合");
            }
        }

        private String string() {
            StringBuilder sb = new StringBuilder();
            i++;                       // 开引号
            while (true) {
                if (i >= s.length()) throw new RuntimeException("字符串未闭合");
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c != '\\') { sb.append(c); continue; }
                if (i >= s.length()) throw new RuntimeException("转义未完成");
                char e = s.charAt(i++);
                switch (e) {
                    case 'n': sb.append('\n'); break;
                    case 't': sb.append('\t'); break;
                    case 'r': sb.append('\r'); break;
                    case 'b': sb.append('\b'); break;
                    case 'f': sb.append('\f'); break;
                    case 'u':
                        if (i + 4 > s.length()) throw new RuntimeException("\\u 不完整");
                        sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                        i += 4;
                        break;
                    default: sb.append(e);
                }
            }
        }

        /**
         * 把解析出的裸 {@code Map} / {@code List} 提升为 {@link JSONObject} / {@link JSONArray}。
         * 真 org.json 天然就是这么组织的，替身若不提升，{@code optJSONObject/optJSONArray}
         * 会永远返回 null（本文件第一版就踩了这个坑，夹具立刻报「样本文件里没有 cases 数组」）。
         */
        @SuppressWarnings("unchecked")
        private static Object wrapAny(Object v) {
            if (v instanceof Map) return JSONObject.wrap((Map<String, Object>) v);
            if (v instanceof List) return new JSONArray((List<Object>) v);
            return v;
        }

        private Object number() {            int st = i;
            while (i < s.length()) {
                char c = s.charAt(i);
                if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') i++;
                else break;
            }
            if (st == i) throw new RuntimeException("非法字面量 @" + i);
            String t = s.substring(st, i);
            double d = Double.parseDouble(t);
            return (d == Math.rint(d) && t.indexOf('.') < 0 && t.indexOf('e') < 0 && t.indexOf('E') < 0)
                    ? (Object) Long.valueOf((long) d) : (Object) Double.valueOf(d);
        }
    }

    /** 供夹具内部构造（本替身不提供 put，用不到） */
    static JSONObject wrap(Map<String, Object> m) {
        return new JSONObject(m);
    }
}
