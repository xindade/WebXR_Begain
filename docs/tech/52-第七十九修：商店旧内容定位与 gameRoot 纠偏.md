# 第七十九修：商店「三张脸谱 Boss」定位与 gameRoot 纠偏

日期：2026-10-18

## 现场症状

第三关商店右侧出现：

- 1 张铁甲兵
- 3 张完全相同的「脸谱 Boss」
- 缺少盾甲兵 / 治疗术士

左侧道具列还出现过「刷新道具 + 两张铁甲兵卡面」的混排观感。

## 结论：不是 1.5.6 商店代码的问题，是头显吃到了旧内容

头显 `page-forensics.log` 在 18:08 那局明确记录：

```text
LaunchGuard：配置下发完成 局号=d85d771f ... 文件=11 共 152435B
```

而同一时间之后，PC `/api/info` 与服务器 `https://webvr123.site/api/manifest` 都是：

```text
count=11 bytes=146030 fp=0b163d44c8a072e9
```

`152435B` 与 `146030B` 不是同一份内容。头显那局用的 `src/content/eliteBrief.js` 是旧版，旧版 `previewCards(3)` 会生成重复 Boss 卡；1.5.6 当前源码的纯函数结果是：

```text
铁甲兵 / 盾甲兵 / 治疗术士 / 脸谱 Boss
```

`tests/shop-preview.test.mjs` 也锁死了「第 3 关共 4 张」。

## 现场已完成的验证

1. 头显 APK 包名/版本：`com.DX.WeirdTurning`，`1.5.6 (156)`。
2. 18:10 / 18:11 两局结束后，APK 已按「本局结束」清空 `files/game-overlay`。
3. 18:25 重新启动客户端后，覆盖层重新下发；逐文件 SHA-256 与 PC 清单缓存完全一致：
   - `eliteBrief.js` = `d7bf3955e89d87ec675dba757c2074ac048fa361f0fb28b1fe9f998d9ac98cad`
   - `levels.js`    = `5075e6fea03d9000b85899fa4d3d266f42f6f821044038fde9483a59188821ce`
   - `shopItems.js` = `f8c5185e84a9243e731ff7c75a70b9fa3b1ebf8a6feca165305a201b94592fae`
   - `spawnDirector.js` = `e5ba035db7b1884e66de7521a0b2353d4ca7e6c036b3536f12f6780b78de4c10`
4. 用头显覆盖层里的三份文件直接执行 `previewCards(3)`，输出正是上述 4 张正确卡。

## 代码修正

### 1. `autoDetectGameRoot()` 不再优先命中旧工程

`tools/cast-pc/main.js` 的自动探测顺序改为：

```text
E:/AI_Work/WebXR_Begain_Platform_try   ← 当前工作副本
G:/01_Work/AI_Codex/WebXR_Begain
E:/AI_Work/WebXR_Begain_Platform       ← 历史目录，仅兜底
E:/AI_Work/WebXR_Begain
...
```

旧顺序把 `E:/AI_Work/WebXR_Begain_Platform` 放在 `_try` 之前，两个目录都有 `src/content` 时，`/api/info` 的 `gameRoot` 会指到旧工程。

### 2. 配置下发回包带内容指纹

`POST /api/config/dump` 现在额外返回：

```json
{ "ver": "1.0.0", "builtAt": 1792305193404, "fp": "0b163d44c8a072e9" }
```

PC 日志也同步打印：

```text
配置下发 ALLOW ... 文件=11 共 146030B fp=0b163d44c8a072e9
```

以后现场再说「商店不对」，先看这一行：

- `bytes/fp` 与 `/api/info` 的 `manifest.bytes/fp` 一致 → 内容是最新的；
- 不一致 → 头显吃到了旧内容，重新点平台「启动游戏」即可整包重下。

## 测试口径

1. 完全退出旧 EXE，安装 `tools/cast-pc/dist/WebXR直播接收端 Setup 1.0.0.exe`。
2. `/api/info` 检查：
   - `gameRoot` 应是 `E:\AI_Work\WebXR_Begain_Platform_try`
   - `manifest.bytes` 应是 `146030`
   - `manifest.fp` 应是 `0b163d44c8a072e9`
3. 平台点「启动游戏」→「开始游戏」，进第 3 关商店。
4. 右侧预告应为 4 张：铁甲兵 / 盾甲兵 / 治疗术士 / 脸谱 Boss。
5. 左侧道具列只应有 3 个道具 + 刷新，不应出现精英卡面。

## 备注

- APK 1.5.6 本身不用重装；这次修的是 EXE 的目录探测与下发日志。
- 服务器内容版本号仍是 `1.0.0`，每次覆盖发布后建议重启 EXE 或等清单 TTL（60s）过期，确保 PC 重新拉取。

## 追加：为什么「清了浏览器缓存」还是旧卡面

18:11 的现场照片（1 铁甲兵 + 3 张同文案脸谱 Boss、左列混入精英卡）拍摄于旧覆盖层
`152435B` 那一局，早于 18:25 的覆盖层重下发，不能代表当前内容。

真正让「清缓存也不生效」的原因是：**PICO 浏览器把同一 URL 的旧标签页直接顶回前台**。
覆盖层文件已经换新，但页面没有重新导航，内存里的 ES Module 仍是上一局那套；清磁盘缓存
不会替换已运行的模块。平台重复拉起时尤其容易命中这一条。

修复（APK 侧）：

```java
private static final long BOOT_TOKEN = System.currentTimeMillis();   // 每进程一个
...
return LOCAL_GAME_URL + "?" + plat.substring(1) + vrBtn + gate + "&boot=" + BOOT_TOKEN;
```

每次客户端进程启动，URL 都带不同的 `boot`，浏览器只能重新加载页面。同一进程内保持不变，
所以重试不会开出多个标签页。该改动已打进 `1.5.6 (156)`，包名/版本不变。

验证口径：头显 `page-forensics.log` 里本次 URL 应带 `&boot=<毫秒>`；进商店后右侧应为
`铁甲兵 / 盾甲兵 / 治疗术士 / 脸谱 Boss`，左侧只有 3 个道具 + 刷新。
