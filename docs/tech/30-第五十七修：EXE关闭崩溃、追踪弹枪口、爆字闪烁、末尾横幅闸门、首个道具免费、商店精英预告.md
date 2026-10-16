# 30 · 第五十七修：EXE 关闭崩溃 · 追踪弹枪口 · 「爆」闪烁与遮挡 · 末尾横幅闸门 · 首个道具免费 · 商店精英预告（模型立绘）

> 现场一轮测试后的 6 条反馈（第 6 条先做**形状征询**、定稿后实现，见 §9）。
> 结构：**目标 → 原理 → 关键实现 → 参数表 → 踩坑 → 验证方法**。

---

## 1. 本轮 6 条与落点

| # | 现场反馈 | 落点 |
|---|---|---|
| 1 | 关闭 EXE 报错（`Converting circular structure to JSON ... _idlePrev`） | `tools/cast-pc/main.js`：句柄移出通道对象 + 白名单投影 + `safeJson` + 全局兜底（见 §2） |
| 2 | 追踪子弹不是从枪口射出、体型偏细 | `game._spawnHomingBullets` 改问 `input.getMuzzle()`；`SHOP.DOG_SCALE 2 → 3`（见 §3） |
| 3 | 「爆」字单调 → 进内圈闪烁变红，且要被别的怪遮挡 | `balloons.bombMarkColor()` 纯函数 + `BOMB_LABEL.DEPTH_TEST`（见 §4） |
| 4 | 末尾精英横幅到点要先**等场上精英清完**，再融合小怪（多的留下、少的补） | `spawnDirector.isClimaxGateBanner()` / `pickFuseAbsorb()` + `waves._holdClimaxBanner()` 脚本时钟闸门（见 §5） |
| 5 | 每个商店**第一个道具免费** | `shop._freeItem` 生命周期（见 §6） |
| 6 | 商店右侧预告「到下一个商店之前」的精英与 Boss，问什么形状好 → 追加「要图片：精英露模型图、图下文字，Boss 不显示 / 只显示未知」 | 右手边一列只读卡（形状 = 卡带、不显示数量与方位），**卡面换成精英的真实模型截图**、Boss 卡只显示「?」，见 §9 / §9.1 |

## 2. EXE 关闭报错：一根 `setTimeout` 句柄引发的循环引用

**现象**：平台点「结束游戏」→ EXE 弹一个 `TypeError: Converting circular structure to JSON` 的模态框，
框挡住 `app.quit()`，于是「关不掉」。

**原理**：第五十六修把「收到 `0x10` 后 0.8s 自己退出」的定时器**挂在了 `PLATFORM_CH` 上**：

```js
PLATFORM_CH.exitTimer = setTimeout(...);      // ← 旧写法
```

而 `/api/info` 是这么吐状态的：`platformChannelSnapshot()` 返回 `{ ...PLATFORM_CH }`。
于是这个 **Timeout 句柄**被一起展开进 JSON：Node 的 Timeout 内部持有 `_idlePrev / _idleNext`，
指向**定时器链表头 `TimersList`**，链表又指回自己 ⇒ 环 ⇒ `JSON.stringify` 抛错。
一个句柄，把「关闭」这条路整条打死了。

**修法（4 件事，缺一不可）**：

1. **句柄移出被序列化的对象**：模块级 `let closeExitTimer = null;`（`main.js:2188`）。
2. **`platformChannelSnapshot()` 改白名单投影**（`main.js:2219`）——只挑标量字段出来，顺带新增 `exitArmed`
   给界面看「退出已上膛」。**原则：凡是会被 `JSON.stringify` 的对象，只能投影，不能展开**。
3. **`safeJson(obj, why)`**（`main.js:2203`）：`/api/info`、`/api/platform/*` 等所有响应统一走它，
   序列化失败时**记日志 + 返回错误 JSON**，而不是让异常冒到 Electron 层变模态框。
4. **全局兜底**：`process.on('uncaughtException' / 'unhandledRejection')`（`main.js:131`）落盘即继续跑
   —— 接收端「带着错继续推流」比「弹窗等死」有价值。要恢复 Electron 默认行为加 `--strict-errors`。

日志落盘：`userData/cast-pc-errors.log`（`app.getPath('userData')` 下），现场直接取这个文件。
**兜底本身不修复问题，它只是保证「下次能拿到证据」** —— 环引用这条已经在第 2 步从源头断掉了。

## 3. 追踪弹为什么从击杀点冒出来

**现象**：打狗还要看主人的追踪弹从敌人身上飞出，不是枪口。

**原理**（真因，和「视觉」无关）：枪口位置来自 `input.shots`，而它是**每帧清空的临时队列**：

```js
// input.js 每帧开头
this.shots.length = 0;       // ← 本帧没开火 ⇒ 空数组
```

而「子弹击杀敌人」常发生在**没有开火的帧**（子弹飞行 0.3~1s，命中那一帧和开火那一帧不是同一帧）
⇒ `input.shots` 是空的 ⇒ 代码 `return` 退回到「击杀点」造弹 ⇒ 看起来像从怪身上飞出。

**修法**：改问**同源**的取枪口 API —— `src/vr/input.js:301 getMuzzle(mp, md)`（红射线瞄准用的就是它），
复用 `game._dogMuzzlePos/_dogMuzzleDir` 两个复用向量，零分配。同时 `SHOP.DOG_SCALE 2 → 3` 治「有点细」。

**记一条**：**凡是「每帧重建的临时缓冲」，都不能跨帧读**。要跨帧就换成查询式接口或持久状态。

## 4. 基础怪「爆」标记：进内圈闪红 + 参与深度测试

两条诉求，两条独立的线：

- **闪烁**：新增纯函数 `balloons.bombMarkColor(b, time)`（`balloons.js:84`）——
  水平距圆心 `> BOMB_LABEL.INNER_RADIUS(9)` 时常态暖黄 `COLOR`；进了内圈（危险区）按 `BLINK_ON 0.22`
  的节拍在 `BLINK_COLOR('#ff3b30')` 与常态色之间闪。每帧 `setColorAt` 逐实例改色（1 个 `InstancedMesh`，
  **不是每怪一个 Sprite**）。
- **被遮挡**：旧口径 `depthTest: false` + `renderOrder = 998` —— 「永远画在最上层」，于是糊在它**前方的怪**身上。
  改成 `DEPTH_TEST: true`（`renderOrder` 随之为 0）。**代价**：标记会被更近的怪挡住 —— 这正是诉求。

**顺带**：构造时先把整池刷成常态色（`balloons.js:915`），提前建好 `instanceColor`
—— 否则**第一次闪烁时**才创建实例色缓冲，会一次性上传整块缓冲造成那一帧的卡顿。

贴图里画的字与发光统一改成**纯白** `BOMB_LABEL.GLYPH`，真色交给实例色（否则贴图色与实例色相乘，闪不出红）。
`BOMB_LABEL` 已进 `userConfig` 热调白名单（`constants.js:2023`），现场可改。

## 5. 末尾横幅闸门 + 融合只吃 N 个

**现场口径**：末尾精英（带 `goldReturn` 的那一批）的「…精英来袭」横幅到点时，
若场上还有精英 → **先不打横幅**，等精英被杀才出横幅；出横幅后再把普通小怪化作光点融合
（多出来的小怪**留在场上**，不够的从传送门补光点）。

**实现（纯函数 + 一处闸门）**：

- `spawnDirector.isClimaxGateBanner(ev, events)`（`spawnDirector.js:343`）：判「某条 elite 事件是不是末尾批」
  —— 判据是 **banner 之后第一个 elite 事件带 `goldReturn`**。
- `spawnDirector.pickFuseAbsorb(list, count, { center, climax })`（`spawnDirector.js:364`）：
  决定「吃谁」。`climax` 为真时**先吃精英再吃杂鱼**，各档按到中心距离升序，总量 ≤ `count`。
  旧实现是**全清**，于是「多出来的小怪」被凭空抹掉 ⇒ 现在只吃 `FUSE.COUNT(5)` 个。
- `waves._holdClimaxBanner(dt)`（`waves.js:562`）+ 脚本开头闸门（`waves.js:545`）：
  到点而场上有精英 ⇒ 把**脚本时钟冻住**（不推进 `_scriptElapsed`），后续事件一并顺延；
  横幅一放行就恢复。上限 `SPAWN_LAYER.HOLD_MAX_S = 30s` 兜底（**绝不软锁**）。

### ⚠ 这个改动必须配的护栏（差点踩坑）

冻结期间 `elapsed` 已经越过 `stopAt`，于是**杀掉最后一只精英的那一帧**会立刻判通关
⇒ 末尾融合、金点、抽卡全被吞掉。所以通关判定必须加一条
（`waves.js:1421`）：

```js
if (this.elapsed >= stopAt && this._active === 0 && !this._climaxHeld) this.cleared = true;
```

**教训：给时钟加闸门，就要把所有「读时钟做判断」的地方一起复核一遍。**
`_climaxHeld` 是唯一的真值来源，别用「场上有没有精英」二次推断（会被 Boss 关的召唤物带偏）。

## 6. 每个商店第一个道具免费

口径：**本店买到的第一个道具免费**（技能 / 强化 / 刷新不参与），只免一次，下一个商店重置。

- `open()` 里 `this._freeItem = true`；`_itemEntries()` 里 `price = free ? 0 : Math.round(价 × 折扣)`，
  卡面副文案写 `首次免费`，入口带 `free` 字段。
- `_hit()` 的 `case 'item'`：真的用掉免费名额 → `_freeItem = false` + 复用横幅通道提示「本店首个道具免费！」。
- **免费期三个道具都显示「免费」**（先到先得，玩家自己挑）。

### ⚠ 本轮的**真 bug**：`_addEntry` 投影时把 `free` 丢掉了

`_addEntry(e, pos)` 把入口对象**重新投影**成实体条目时用了显式字段表：

```js
this.entries.push({ holder, card, balloon, baseY: pos.y, kind: e.kind, def: e.def || null, price: … });
//                                                                          ↑ 没有 free
```

于是 `_hit()` 里 `if (e.free)` **永远为假** ⇒ 名额永不用掉 ⇒ 该店**所有道具永远免费**；
而且 `price` 是 `_itemEntries` 算好的 0 ⇒ 扣款也是 0，所以「看起来没坏」，只是白送到底。
修法：字段表补 `free: !!e.free`。

**教训：投影式对象（显式字段表）每加一个语义字段就要同步一处 —— 新字段只在「上游构造」写一次是不够的。**

## 7. 参数表

| 常量 | 值 | 说明 |
|---|---|---|
| `SHOP.DOG_SCALE` | `3` | 追踪弹体积倍率（本轮 2→3） |
| `BOMB_LABEL.INNER_RADIUS` | `9` | 内圈半径（水平距圆心，米）—— 进圈开闪 |
| `BOMB_LABEL.BLINK_ON` | `0.22` | 闪烁节拍（秒，半周期） |
| `BOMB_LABEL.BLINK_COLOR` | `#ff3b30` | 闪烁时的红 |
| `BOMB_LABEL.DEPTH_TEST` | `true` | 参与深度测试（**会被前面的怪挡住**） |
| `BOMB_LABEL.GLYPH` | `#ffffff` | 贴图字/发光纯白，真色由实例色给 |
| `SPAWN_LAYER.HOLD_CLIMAX_BANNER` | `true` | 末尾横幅等场上精英清完 |
| `SPAWN_LAYER.HOLD_MAX_S` | `30` | 上面的兜底上限（超时放行） |
| `SHOP.PREVIEW_X / Y / Z0 / DZ` | `3.0 / 2.2 / -1.0 / -1.15` | 右手边精英预告卡列（道具列的镜像位） |
| `SHOP.PREVIEW_MAX` | `6` | 预告卡最多几张（实际 5 / 3 / 3） |
| `enemyPortrait.PORTRAIT_RADIUS` | `1.1` | 立绘取景半径（只决定画面里占多满，与敌人体型无关） |
| `enemyPortrait.PORTRAIT_CAP` | `256` | 立绘每帧分辨率（卡面只有 224px 宽） |
| `enemyPortrait.PORTRAIT_STEP_MS` | `90` | 两次抓帧的间隔（抓帧含同步回读，扎堆会连掉几帧） |
| `enemyPortrait.SHIELD_*` | `X/Y/Z = -0.5/-0.14/0.3 · SCALE 0.85 · YAW 0.6` | 盾甲兵立绘里那块盾的位置/大小/转角 |

以上除 `SPAWN_LAYER.*` 由 `userConfig` 覆盖外，其余默认值都在 `src/core/constants.js`；
`enemyPortrait.*` 是**渲染常量**（现场不会调），留在 `src/game/enemyPortrait.js`，不进热调白名单。

## 8. 踩坑清单

1. **会被 `JSON.stringify` 的对象不能展开**（只能白名单投影）—— 一个 Timeout 句柄就能锁死退出流程。
2. **每帧重建的临时缓冲不能跨帧读**（`input.shots`）—— 要用查询接口。
3. **纯函数先写测试再接线**：`isClimaxGateBanner` / `pickFuseAbsorb` / `bombMarkColor` 都是纯函数，
   所以闸门这种「时序 + 状态机」的改动才能在单测里钉死。
4. **给时钟加闸门 = 全局复核读时钟的地方**（§5 的通关护栏）。
5. **测试里的「价格断言」要在买之前取价**：买完 `onBuyItem` 已经把 `levels` 加 1 了，
   事后再算就是**下一级**的价 ⇒ 断言变成「按 2000 收费」，而实际扣的是下单时的 1000（测试自身口径错，不是代码错）。

## 9. 第 6 条（已实现 + 改版）：商店右侧「精英预告」卡列 —— 精英露模型、Boss 不露脸

**现场口径（形状征询的答复）**：形状 = **卡带** —— 右手边竖排只读小卡，与左手道具列镜像；
**只给图标、不显示数量**；**不显示来袭方位**；位置照着道具列。每张卡介绍**一种**精英 / Boss，
每个商店只预告「本店 → 下一个商店之前」**新登场**的，前面出现过的省略。

| 商店 | 窗口 | 卡片（5 / 3 / 3 张） |
|---|---|---|
| 第 3 关 | 4-8 | 铁甲兵 · 盾甲兵 · 治疗术士 · 忍者队长 · 脸谱 Boss |
| 第 9 关 | 10-14 | 幽灵法师 · 章鱼将军 · 龙 Boss（前四种已介绍过 ⇒ 省略） |
| 第 15 关 | 16-18 | 未知 Boss ①②③（三种形态各一张；**不剧透**为魔术师） |

**实现**：`src/content/eliteBrief.js`（纯函数口径）+ `game/shop.js._buildPreview()`：

- **数据不手抄**：精英种类从 `SPAWN_SCRIPT` 的 `do === 'elite'` 事件里收集，Boss 从 `LEVELS` 的 `boss` 字段取，
  卡框色用 `LAYER` 的层色（蓝 = 无技能精英 / 紫红 = 有技能精英 / 绿 = 治疗术士）—— 与局内出生光点同色。
- ⚠ **去重基线 = 上一个商店的窗口**，不是「1~n 关」：第 1/2 关虽然已经出过铁甲兵/盾甲兵，
  但它们从没有过预告卡 ⇒ 第 3 关仍要介绍（按「1~n 关」去重会缺掉这两张）。
- 卡列放在 `entries` **之外**（`this.preview`）**且挂独立子组 `previewGroup`**：不绑气球 ⇒ 打不中、买不了。
  ⚠ 必须独立子组：`_build()` 每次购买都会 `_clear()` 重建可买的卡，若把预告卡混在 `this.entries` 里，
  **买第一个道具就把预告卡一起拆了**；现在它只在 `open()` 建一次，`clearCards()` / `dispose()` 才拆。
  （`tests/shop-preview.test.mjs` 里有一条「进店即建 / 购买不重建 / 清场拆掉」把这三件事钉死。）
- 新增 9 个简笔画图标（`cardDraft.drawSketchIcon`）：铁甲兵 / 盾甲兵 / 治疗术士 / 忍者队长 / 幽灵法师 / 章鱼将军
  —— v2 起它们退居**兜底**（非立绘卡照用；精英立绘抓帧失败时补位，见 §9.1）。
  + 脸谱 / 龙 / 未知 Boss。图标只画线稿，颜色交给卡框色。
- 参数 `SHOP.PREVIEW_*`（`X / Y / Z0 / DZ / MAX`）已进 `userConfig` 热调白名单；
  默认值就是道具列的镜像位（`+3.0`、同高 `2.2`、同 Z 节奏）。

**文案口径**：只写**已实现**的机制（别写愿景）；每条 ≤ 27 字（卡面 sub 最多 3 行 × 约 9 字/行）。
第 18 关 Boss 的卡名写「未知 Boss」，形态要点照实介绍（激光扫射 / 玻璃墙只打闪烁格 / 球墙脱墙追人）。

### 9.1 立绘（v2 · 口径「做成图片显示：精英露模型 + 图下文字，Boss 不显示 / 只显示未知」）

**做法**：复用 DepthSprite 的离屏抓帧管线 `glbCapture.captureGLB()` —— 抓的就是**局内同一份 GLB**，
所以卡面长相 = 玩家马上要遇到的样子，不存在「画的跟实物不一样」。

| 文件 | 职责 |
|---|---|
| `content/eliteBrief.js` | `elitePortrait(type)`：从 `ENEMY_TYPES` 取 `model` / `shieldModel`；卡对象带 `portrait`（Boss = `null`） |
| `game/enemyPortrait.js` | **新增**：按 spec 组装模型（盾甲兵 = 骑士 + 盾牌）→ 抓帧 → 按 `url\|shieldModel` 缓存；任何失败 `resolve(null)` |
| `game/cardDraft.js` | `makeCardTexture(..., { portrait, image, placeholder })`：新增 `drawPortraitSlot()` 画图区 |
| `game/shop.js` | `previewPortraits()`（只报精英、按模型去重）+ `setPortrait()`（换图并重建这一列） |
| `game/game.js` | `_warmShopPortraits()`：进店后**一次抓一张**，抓到一张就换一张卡面 |

**版式**：图区在上（`x 16..240 / y 22..258`），标题下移到 `y 302`、文案从 `y 348` 起（仍是 3 行上限）；
图区用卡框色描边但淡一档（`globalAlpha 0.5`），不与卡框抢眼。

**三级回退**（`drawPortraitSlot`）：① 有立绘 → 画模型图（contain，不裁切不变形）；
② 精英卡抓帧失败 → 画该卡的**简笔画图标**（卡面仍认得出是谁，不会变成一张「?」的 Boss 卡）；
③ Boss 卡（`placeholder: '?'`）→ 画大「?」。

- **盾甲兵必须两个模型**：只画骑士就和铁甲兵长得一模一样。局内那块盾是「绕骑士转」，但正视图里把它摆在
  正前方（-Z）在透视相机下**只后退、不偏移 ⇒ 被骑士完全挡住**（第一版渲出来只剩一道盾边），
  所以立绘改成把盾放到**骑士左前方**并转开一点（`SHIELD_X/Y/Z/YAW`）：盾面朝前，一眼能和铁甲兵区分。
- **成本控制**：一次抓帧含两次 `readRenderTargetPixels` 同步回读，扎堆会连掉好几帧，所以
  ① 每帧分辨率降到 256（`PORTRAIT_CAP`）；② 两次抓帧间隔 90ms（`PORTRAIT_STEP_MS`）；
  ③ 按模型 url 缓存 —— 一局最多 5 份（骑士 / 骑士+盾 / 心形 / 忍者 / 幽灵 / 章鱼去重后）。
  玩家看到的是进店后约半秒内「? → 立绘」逐张补齐，店里几乎静止，看不出卡顿。
- **没有 WebGL 也不炸**：无 `renderer`（单测 / 纯逻辑环境）时 `_warmShopPortraits()` 直接返回，
  卡面停在「?」/ 简笔画；抓帧失败只 `console.warn` 一次，不影响购买与倒计时。

**渲染校验**（见 §10 的办法）：用 Electron 把**真实源码 + 真实 GLB** 离屏渲染成 PNG 逐张看过
（产物 `E:\AI_Work\WebXR_Capture\preview-57b\sheet.png`）—— 6 张精英卡都是模型图、5 张 Boss 卡都是「?」，
文案都落在 3 行内、不顶边框；盾甲兵第一版被骑士挡住，调过 `SHIELD_*` 才定稿。

## 10. 验证方法

- `npm test` —— 318 项全绿；本轮相关：`tests/bomb-label.test.mjs`（闪烁配色 + 深度测试）、
  `tests/shop-preview.test.mjs`（预告窗口 / 文案行数 / **精英必须有立绘、Boss 必须没有** / 盾甲兵两模型 /
  抓帧失败回退 / `setPortrait` 只重建这一列 / 立绘版式 `drawImage` 与「?」的分支）、
  `tests/spawn-director.test.mjs`（闸门判定 / 融合吃谁）、`tests/shop.test.mjs`（首个道具免费 + 追踪弹枪口）。
- 商店右侧预告：第 3 关 5 张（铁甲兵/盾甲兵/治疗术士/忍者队长/脸谱 Boss）、第 9 关 3 张、第 15 关 3 张；
  卡片**打不中**（朝它开枪无反应），且进/出店与可买的卡一起出现、消失。
- 渲染校验办法（改图标/文案后自查）：把 `cardDraft.js` 里的 `drawSketchIcon` / `wrapText` / `makeCardTexture`
  抽出来，用 `tools/cast-pc` 那份 electron 离屏渲染成 PNG —— 换字换形状「所见即所得」，不必进头显。
- 现场：① 平台点「结束游戏」→ EXE 直接关，**不再弹报错框**；
  ② 打狗追踪弹**从枪口**射出、明显变粗；③ 「爆」字进内圈闪红、且**被前面的怪挡住**；
  ④ 末尾精英横幅**等场上精英清完**才出，出完小怪化光点（多留少补）；
  ⑤ 商店里第一个道具**不扣钱**，买完其余恢复原价，下一个商店再来一次；
  ⑥ 进商店关看右手边：精英卡是**模型图 + 图下文字**、Boss 卡只有「?」（进店先出现「?」，约半秒内换成模型图）。