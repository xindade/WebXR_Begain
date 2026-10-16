# 商店「精英预告」卡 · 离线预览

把第 3 / 9 / 15 关商店右侧那列**精英预告卡**（含立绘）在**不开头显**的情况下导成 PNG。

## 为什么需要它

卡面上的立绘不是美术图，而是**运行时把敌人 GLB 离屏渲成正视图**抓出来的
（`src/game/enemyPortrait.js` → `glbCapture.captureGLB`，盾甲兵是「骑士 + 盾牌」各抓一张再 2D 合成）。
所以「卡面到底长什么样」以前只能戴头显、一关一关打到商店才看得到，而且头显上看不到 DevTools。

这个工具用 Electron 开一个**真 WebGL** 的窗口，跑的就是游戏里那套代码，把 3 张卡列导成图片。

## 怎么跑（仓库根目录）

```powershell
tools\cast-pc\node_modules\electron\dist\electron.exe tools\portrait-preview\run.cjs
```

跑完会打印每个卡片的抓帧结果，并写出到系统临时目录：

```
%TEMP%\webxr-portrait-preview\
  cards-lv3.png     ← 第 3 关 5 张（铁甲兵 / 盾甲兵 / 治疗术士 / 忍者队长 / 脸谱 Boss）
  cards-lv9.png     ← 第 9 关 3 张
  cards-lv15.png    ← 第 15 关 3 张（未知 Boss 三形态：只有文案，卡面「?」）
  report.json       ← 每张卡的 hasImg / opaque（不透明像素数）/ err
  console.txt       ← 与 report 同源的文本版
```

`opaque` 是判读关键：**0 = 这张立绘事实上什么都没有**（抓帧全透明），数值很小 = 取景不对
（模型只剩一条边）。健康值：骑士约 4.6 万 px、盾牌约 3.5 万 px、合成后约 3.1 万 px（256×256 ≈ 6.5 万 px 满幅）。

## 覆盖 / 不覆盖

- 覆盖：卡面文案与换行、立绘抓帧与合成、盾牌抓不到时的「盾」简笔画兜底、Boss 卡的「?」占位。
- 不覆盖：卡片在场地里的位置 / 朝向 / 大小（那是 `src/game/shop.js` 的摆位，必须进 VR 看）。

## 注意

- 页面从**仓库根目录**起静态服务，所以 `<repo>/vendor/`（three / draco）与 `<repo>/Model/` 必须是完整 checkout。
- 电子的二进制借的是 `tools/cast-pc/node_modules/electron`（PC 端 EXE 的同一份依赖），不用另装。
- 这只读抓帧、不改任何游戏数据。