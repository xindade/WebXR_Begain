package org.json;

import java.util.ArrayList;
import java.util.List;

/**
 * ⚠️ JDK 下的**最小替身**，仅供 {@code tools/cast-server/xlang} 离线夹具编译/运行。
 * 只实现夹具用得到的那几个方法（{@code length} / {@code optJSONObject}）。
 */
public class JSONArray {

    private final List<Object> list = new ArrayList<>();

    JSONArray(List<Object> src) {
        if (src != null) list.addAll(src);
    }

    public int length() {
        return list.size();
    }

    public Object opt(int index) {
        return (index >= 0 && index < list.size()) ? list.get(index) : null;
    }

    public JSONObject optJSONObject(int index) {
        Object v = opt(index);
        return (v instanceof JSONObject) ? (JSONObject) v : null;
    }

    public String optString(int index, String fallback) {
        Object v = opt(index);
        return (v == null) ? fallback : String.valueOf(v);
    }
}
