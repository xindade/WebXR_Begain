# 构建带 WebXR 的 GeckoView AAR（方案A 必需步骤）

> 目标：从 Mozilla 源码编译一个**自带 WebXR / OpenXR 后端**的 GeckoView AAR，
> 替换应用内 WebView，实现「真正应用内 VR、不弹外部浏览器」。
>
> **为什么必须自编译**：Maven 上的预编译 `org.mozilla.geckoview:geckoview` **不含可用的 WebXR**
> （Wolvic 文档明确说明需自编译 GeckoView + patch）。而且从源码编译 GeckoView 需要 Linux + Mozilla `mach`，
> **Windows 下无法完成**（Wolvic 文档原话）。所以这一步必须在你的 Linux 机器上跑。

---

## 0. 前置条件（Linux x86_64）
- 磁盘 ≥ 40 GB，内存 ≥ 16 GB（编译 Gecko 很重）。
- 已装：Python 3.8+、Git、Mercurial（`pip install mercurial` 或 apt `mercurial`）、
  OpenJDK 17、`unzip`、`wget`、`curl`、`rustc`/`cargo`（`mach bootstrap` 会自动拉，但建议先装）。
- Android SDK（与项目一致，compileSdk 34 / build-tools 35）。
- Android NDK（r25c 或 mach 提示的版本；mozilla-central 对 NDK 版本有要求，按 bootstrap 提示装）。
- 稳定联网（首次拉依赖较多）。

---

## 1. 取源码（用 GitHub 镜像，比 hg 方便）
```bash
git clone --depth 1 --branch FIREFOX_128_0_RELEASE https://github.com/mozilla/gecko-dev.git
cd gecko-dev
# 想用更新的稳定版就换 tag，例如 FIREFOX_140_0_RELEASE；
# 注意：集成代码是照 ~128–140 的 API 写的，换大版本后若编译报错需微调（见 gecko-staging/ACTIVATE.md）。
```

> 说明：用 release tag 而非 mozilla-central 主干，是为了让 AAR 的 Java API 与 `gecko-staging` 里的
> `MainActivity.java` 对齐，减少“编译过了但运行时 API 不符”的坑。

---

## 2. 开启 WebXR（关键）
编辑 `modules/libpref/init/StaticPrefList.yaml`，把下面两项的默认值改成 `true` / `false`：

```yaml
# Is support for WebXR APIs enabled?
- name: dom.vr.webxr.enabled
  type: RelaxedAtomicBool
  value: true          # ← 原来是 false，改成 true
  mirror: always

# Starting VR presentation is only allowed within a user gesture ...
- name: dom.vr.require-gesture
  type: RelaxedAtomicBool
  value: false         # ← 原来是 true，改成 false（避免“需系统手势才能进 VR”的卡点）
  mirror: always
```

> ⚠️ **重要不确定性（需你实测）**：上面的 pref 翻转让 WebXR *运行时可用*，但 Gecko 的 **OpenXR 后端
> （`gfx/vr/openxr`，即真正把画面送到头显的那层）在 Android 上是否被编进 AAR** 取决于构建配置。
> 若按下面步骤编出的 AAR 在 PICO 上「能识别 immersive-vr 但进不去/黑屏」，说明 OpenXR 后端没编进去，
> 需要走 Wolvic 的方式：基于带 WebXR/OpenXR 后端的 GeckoView 分支（参考
> https://github.com/Igalia/wolvic 的 `picoxr` 构建 + GeckoView 本地替换）再编一次。这一步是迭代过程，
> 不在本机一次性保证。

---

## 3. mozconfig（放源码根目录）
```bash
cat > mozconfig <<'EOF'
ac_add_options --enable-project=mobile/android
# PICO 4 是 ARM64，只编 aarch64 即可（编 x86_64 也行，但没必要）
ac_add_options --target=aarch64
ac_add_options --with-android-sdk="$ANDROID_SDK"
ac_add_options --with-android-ndk="$ANDROID_NDK"
# 可选：减小体积/加快（按需）
# ac_add_options --disable-tests
# ac_add_options --enable-release
EOF
```
> 如果没设 `$ANDROID_SDK`/`$ANDROID_NDK`，先 `export` 到你的实际路径。

---

## 4. Bootstrap + 编译 + 打出 AAR
```bash
# 自动拉取工具链（按提示同意协议；用 --no-interactive 可无人值守）
./mach --no-interactive bootstrap --application-choice="GeckoView/Firefox for Android"

# 编译（数分钟~数小时，取决于机器）
./mach build

# 打出 GeckoView AAR（关键产物）
./mach android archive-geckoview
```
产物路径（MOZ_OBJDIR 默认就是源码根）：
```
$GECKO_OBJDIR/gradle/build/mobile/android/geckoview/outputs/aar/\
geckoview-official-withGeckoBinaries-noMinApi-release.aar
```
把这个 `.aar` 复制到本项目的 `tools/cast-apk/app/libs/`，并重命名为：
```
geckoview-official-withGeckoBinaries-noMinApi-release.aar
```
（即保持原文件名，集成代码的依赖声明就是按这个名字写的。）

---

## 5. 回到 Windows / 本项目
1. 把 AAR 放到 `tools/cast-apk/app/libs/`。
2. 按 `gecko-staging/ACTIVATE.md` 把 `gecko-staging/` 里的源码与 Gradle 片段接进项目。
3. 构建 gecko 变体：`gradle assembleGeckoDebug`（或 Android Studio 选 `geckoDebug`）。
4. 装到 PICO 实测：应用内 GeckoView 能否进 `immersive-vr`。
   - 能进 → 方案A达成，不再弹外部浏览器。
   - 识别出 immersive-vr 但进不去/黑屏 → 见第 2 步的 OpenXR 后端说明，改用 Wolvic 式带后端分支重编。

---

## 常见坑
- **Windows 下 `./mach` 跑不起来**：这是预期，本方案就是在 Linux 跑。
- **NDK 版本不符**：`mach` 会报错并告诉你需要的版本，按其提示装对应 NDK 即可。
- **AAR 编出来了但应用编译报 GeckoView API 找不到/签名不符**：你 checkout 的 Gecko tag 与
  `gecko-staging/MainActivity.java` 假设 API 不一致，按编译器提示微调（多为方法名/返回类型变化）。
- **PICO 上 WebXR 仍不可用**：确认 PICO 系统「开发者选项 / 未知来源 / 允许 VR」相关开关，且游戏
  请求 session 是在用户点击「进入 VR」的手势内触发（我们已把 `dom.vr.require-gesture` 关掉，双重保险）。
