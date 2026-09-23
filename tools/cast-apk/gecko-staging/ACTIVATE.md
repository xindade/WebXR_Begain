# 激活方案A（应用内 GeckoView）步骤

> 前提：你已经在 Linux 上按 `../BUILD_GECKOVIEW.md` 编译出带 WebXR 的 GeckoView AAR，
> 并把它放到了 `app/libs/geckoview-official-withGeckoBinaries-noMinApi-release.aar`。

## 1. 放置 AAR
确认文件存在：
```
tools/cast-apk/app/libs/geckoview-official-withGeckoBinaries-noMinApi-release.aar
```
（若文件名不同，请同步修改下方第 3 步里 `geckoImplementation(name: '...')` 的名字。）

## 2. 放入 gecko 风味源码
把本目录 `app/src/gecko/` 整体复制进项目：
```
gecko-staging/app/src/gecko  →  tools/cast-apk/app/src/gecko
```
复制后结构应为：
```
tools/cast-apk/app/src/gecko/java/com/local/webxrcast/MainActivity.java
tools/cast-apk/app/src/gecko/res/layout/activity_main.xml
```
> 注意：当前 `app/src/main/java/.../MainActivity.java` 是 WebView 版（webview 风味用）。
> 两个风味各自提供自己的 `MainActivity`，manifest 里声明的 `.MainActivity` 对两者都适用，互不冲突。

## 3. 应用 Gradle 改动
按 `gecko-build.gradle.snippet.txt` 修改：
- `app/build.gradle`：加 `flavorDimensions` + `productFlavors { webview; gecko }`；
  把 `androidx.browser` 改为 `webviewImplementation`；新增 `geckoImplementation(name:'geckoview-...', ext:'aar')`。
- `settings.gradle`：在 `dependencyResolutionManagement.repositories` 内加 `flatDir { dirs 'app/libs' }`。

## 4. 构建 gecko 变体
```bash
# 在项目根 tools/cast-apk 下（用 build-apk.ps1 同款 Gradle 均可）
gradle assembleGeckoDebug
# 或 Android Studio 里选 geckoDebug 变体
```
产物：`app/build/outputs/apk/gecko/debug/app-gecko-debug.apk`

> webview 风味不受影响：`gradle assembleWebviewDebug`（或默认 `assembleDebug` 视 AGP 行为）
> 仍走原来的系统 WebView 方案，可随时回退对比。

## 5. PICO 真机实测
- 安装 `app-gecko-debug.apk`，启动后应**直接在应用内**用 GeckoView 渲染游戏；
- 点游戏内「进入 VR」→ GeckoView 的 WebXR 后端对接 PICO OpenXR 运行时进沉浸模式；
- **不再弹任何外部浏览器**。
- 若 GeckoView 也识别不了 immersive-vr：点界面底部「用 PICO 浏览器打开（兜底）」手动逃生；
  并回到 `BUILD_GECKOVIEW.md` 第 2 步的「OpenXR 后端不确定性」说明，改用 Wolvic 式带后端分支重编 AAR。

## 6. 编译报错怎么处理
`MainActivity.java` 是按 GeckoView ~128–140 写的。若你 checkout 的 Gecko tag 不同导致 API 不符
（常见：方法名/返回类型、PermissionDelegate 回调签名），编译器会精确指出，按提示微调即可，
逻辑结构无需改动。
