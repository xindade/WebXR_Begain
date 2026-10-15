# 第四十九修（续）· 卡顿预载 · Boss 预建三张脸 · 标题卡入雾 · 治疗脉冲光环 · 加速弹

> 现场来源（用户原话，2026-10-14）：
> 1. 「测试时经常发生卡顿，比如第六关 Boss 切换，末尾精英的合成，金色光点到选项卡等。分析一下目前的整体游戏，看一下该怎么规划。」
> 2. 「名字显示能否在关卡初始的云雾时间段。」
> 3. 「治疗术士不应该移动，它的回血效果表现弱，能否做成一个周期性的圆形扩散的那种，首先要是绿色的，其次要能表现出回血，最后性能上要考虑。」
> 4. 「完成杀敌十个的时候，感觉不明显，想把射击出的子弹变成蓝色，且拖尾加长一倍，是否可以。」
>
> 追问后的现场口径：① 治疗术士**站桩保持 24m**、光环放大到 **12~15m**（取 14）；② 卡顿**只做最小改动**（预载补齐 + Boss 预建三张脸），Boss 试炼场/卡面预建/精英落地分帧本轮**不做**；③ 是边推流边玩，**本轮不管推流**（只做渲染侧）。

---

## 1. 卡顿诊断：三类卡顿，两个根因

现场列出的三个卡顿点（第 6 关 Boss 变脸 / 末尾精英合成 / 金色光点飞向选项卡）看着像三件事，实测归成**两个根因**：

| 根因 | 触发点 | 机制 |
|---|---|---|
| A. 首次冷加载 + 首次 GPU 使用 | 末尾精英合成（第一只术士/盾甲兵落地那一帧） | GLB parse 未做、DepthSprite 抓帧未做、附属模型（`Model/盾牌.glb`）未加载 ⇒ 落到**出怪那一帧**才做「12 帧离屏渲染 + `readRenderTargetPixels` 同步回读 + 纹理上传 + 着色器编译」 |
| B. 材质 dispose → GL program 被释放 → 下一帧同步重编译 | 第 6 关脸谱 Boss 变脸 | `swapBalloonModel()` 会 `material.dispose()` → three 的 `releaseMaterialProgramReferences` → `programCache.releaseProgram`（引用计数归零即删 program）⇒ 下一次渲染同步重编译，就是「一变脸卡一下」 |

第 6 关脸谱 Boss 的三张脸是**同一个模型文件的三份材质变体**（不是三份不同文件），所以修法不是「预载资源」而是「**预建三份模型 + 变脸只切 `visible`**」。

> 「金色光点 → 选项卡」那一处的开销来自选项卡卡面贴图的首次上传，属于本轮**明确不做**的第 2 批（见第 6 节）。

---

## 2. 改动清单

### 2.1 预载补齐（根因 A）

`src/game/game.js`：

- `_buildIntroPreloadQueue(lv)` 的 `addType()` 重写：
  - `warm: !capture` —— 走 DepthSprite 立绘的怪（抓帧本身就会把 GLB 纹理传一遍）**不再重复预热**，只有不抓帧的才额外 `warmModelGpu`；
  - **新增附属模型入队**：`if (t.shieldModel) q.push({ url: t.shieldModel, capture: false, warm: true })`。
    原来 `Model/盾牌.glb` 只在 `balloons._buildShield` 里懒加载 ⇒ 第一个盾甲兵出现那一帧才有一次冷加载。第 4/5 关末尾批（融合）与第 18 关玻璃阶段都吃这一下。
- **新增导出纯函数 `scriptEnemyTypes(levelN)`**：读 `spawnDirector.scriptFor(n)`，只收集 `ev.do === 'elite'` 的 `combos[].type`（去重）。
  在关卡分支**之外**统一 `for (const id of scriptEnemyTypes(lv.n)) addType(id);`。
  根因：第四十六修把 1/2/4/5 关写成三层时间轴脚本，但预载队列只收 `SPAWN_RING.pool` / `NORMAL_TEST.pool` / `LEVEL_ENEMY` / `ELITE_SCHEDULE` ⇒ **脚本独有的敌种漏预载**。第 5 关脚本要出 `heart`（心形怪 / 治疗术士），`ELITE_SCHEDULE[5]` 里没有它，于是首只末尾精英落地才冷加载 + 抓帧。

### 2.2 第 6 关 Boss：三张脸预建，变脸只切 `visible`（根因 B）

`src/game/balloonModels.js`（新增 4 个导出）：

| 函数 | 作用 |
|---|---|
| `buildModelClone(gltfScene, url, radius, tint, tuningOverride, extraScale)` | 从 `attachBalloonModel` 抽出的**同一套口径**（克隆 + 材质 + 缩放）；`attachBalloonModel` 现在就是调它 |
| `prebuildBalloonVariants(balloon, urls, radius, baseUrl, tuningOverride, extraScale, tint)` | 幂等预建若干「变体脸」，挂到 `balloon._variants`；`balloon.alive` 守卫；任一张失败返回 `false` |
| `setBalloonVariant(balloon, url)` | **只切 `visible`**（把 `bodyModel`/`_modelMats` 指向当前显示的那张）；没有预建就返回 `false` |
| `dropBalloonVariants(balloon)` | 摘掉预建的脸（`swapBalloonModel` 开头调用，避免旧脸残留） |

`attachBalloonModel` 尾部新增：若 `balloon._variantActiveUrl` 已存在且与本次 url 不同 → 本次克隆**只挂上、藏着**（`visible = false`，记 `_baseModel`），**不接管 `bodyModel`**。

`src/game/waves.js`：

- `_spawnFaceBoss()` 的 `onSpawn` 尾部：`prebuildBalloonVariants(b, FACE_BOSS.MODELS.filter(u => u !== baseFace), ENEMY_TYPES.faceMask.radius, baseFace).then(ok => { if (!ok) console.warn(...) })`。
- `_faceNextPhase()`：`const faceUrl = FACE_BOSS.MODELS[this.facePhase]; if (!setBalloonVariant(b, faceUrl)) { swapBalloonModel(b, faceUrl, b.radius); log('预建脸未就绪 → 回退重建模型'); }`
  —— 预建没到位时**退回旧路径**，行为与改造前完全一致，不会因为加载慢而变脸失败。

### 2.3 关卡标题卡：挪进「进关起雾」的时间窗

`src/core/constants.js`：`LEVEL_TITLE` 新增 `INTRO_DELAY: 1.5`（`1.5 + SECONDS 2.8 = 4.3s`，正好压在 `CLOUD.INTRO_DELAY = 4.0` 雾散之后 0.3s 收尾）；原 `DELAY: 0.8` 注释改为「**无云雾时**」。

`src/game/game.js`：

- `_queueLevelTitle(delay = LEVEL_TITLE.DELAY)` 接受延迟参数；
- `_startLevelAudio()` 里**删掉**原来的 `this._queueLevelTitle()`（否则「雾散」这一刻会把倒计时重置到 0.8s，等于又回到雾散之后弹）；
- `_loadLevel()` 末尾按是否有穿云窗排期：`this._queueLevelTitle(cover ? LEVEL_TITLE.INTRO_DELAY : LEVEL_TITLE.DELAY)`；
- `_tickLevelTitle(dt)` 从「`_introActive` 早退之后」**提到之前**（`_updatePlaying()` 顶部）—— 否则穿云期间卡片根本不会被 tick。

### 2.4 治疗术士：站桩 + 周期性绿色脉冲光环

现场口径：术士不该跟着压向玩家（站桩在 24m 外），旧的「每帧 +10/s」在画面上**看不出什么时候在治**。

`src/core/constants.js` `HEAL_LINK`：`PULSE: true` / `PULSE_PERIOD: 2.0` / `PULSE_HEAL: 20`（= 旧 10/s × 2s，**总量不变**）/ `RADIUS: 14`（覆盖敌种表 `healRadius` 的 6 —— 术士站 24m 外，6m 光环罩不到前压的怪）/ `RING_ENABLED` / `RING_Y: 0.06`（贴地）/ `RING_DUR: 0.9` / `RING_OPACITY: 0.75` / `RING_POOL: 3` / `PLUS_RIDE: 4`；旧「治疗线 + 沿线加号」`LINES: false`（实现与参数全保留，改 `true` 即回）。

`src/game/balloons.js`：构造里 `if (t.behavior === 'heal') this.controlled = true`（站桩，顺便跳过分离力推挤）；`_applyHealAura(dt)` 重写为脉冲口径（到点 → 半径内其它怪 `+PULSE_HEAL`、`o.flashHeal()`、`this.onHealPulse(pos, hr)`）；新增 `flashHeal(t = 0.28)`（挨打会把绿闪复位成白闪）。

`src/game/depthSprite.js`：新增 `uFlashColor`（`vec3`），`col = mix(col, uFlashColor, uFlash)`，`setFlash(v, colorHex = null)` —— 立绘怪也能「闪绿」。

`src/game/fx.js`：新增 `HealRingFx`（`RingGeometry(0.9, 1, 48)` 靠 scale 放大、加色混合、`depthTest: false`、`renderOrder 997`、`rotation.x = -PI/2` 贴地；`PLUS_RIDE` 个 Sprite 复用 `plusTexture()`；池满复用最老的槽）+ 门面 `healPulse(pos, radius)`。**1 个环 = 1 draw call**，环数有上限。

顺带的性能收益：判定从「每帧 O(n²)」变成「每 `PULSE_PERIOD` 秒一次 O(n²)」。

### 2.5 加速弹：变蓝 + 曳光加长一倍

现场「10 连杀触发的射速加速感觉不明显」⇒ 加速期**打出的那批子弹**用**实例色**染蓝（不增加 Draw Call），曳光变蓝并加长一倍。

`src/core/constants.js` `RAPID_FIRE.VISUAL = { BULLET_COLOR: 0x49b6ff, TRACER_COLOR: 0x49b6ff, TRACER_MUL: 2 }`。

`src/game/bullets.js`：

- **材质基色改 `0xffffff`** —— `InstancedMesh` 的实例色是**乘**在材质色上的，材质带蓝会把加速蓝乘成脏色；
- 构造时把整池刷成默认色 —— 目的是**提前创建 `instanceColor` 缓冲**，否则第一次加速现场 `setColorAt` 会一次性上传整块缓冲（正是要避免的卡顿点）；
- `spawn(position, direction, dmg, boost = false)` + `b.boost`；`sync()` 里 `setColorAt(i, boost ? VISUAL.BULLET_COLOR : SHOOT.BULLET_COLOR)` 并置 `needsUpdate`。

`src/game/player.js`：`fire(shot, bullets, audio, boost = false)`，两处 `bullets.spawn` 都透传。

`src/game/game.js`：`_updatePlaying()` / `_updateCard()` 里 `const _boostShot = this._gameTime < this._rapidUntil;` 传给 `player.fire`；`_updateFx()` 的玩家子弹曳光：`b.boost ? RAPID_FIRE.VISUAL.TRACER_COLOR : FX.TRACER.COLOR` + `lenScale = b.boost ? TRACER_MUL : 1`（`back` 上限照旧生效，**不会**因此拖到枪管后面，见第四十二修）。

技能弹（积分散射 / 散射强化）**不染蓝** —— 它们不是「连杀加速打出来」的。

---

## 3. 参数表（现场可直接调）

| 参数 | 位置 | 现值 | 说明 |
|---|---|---|---|
| `LEVEL_TITLE.INTRO_DELAY` | `constants.js` | `1.5` | 有穿云窗时，从「进关起雾」起算的排期延迟 |
| `LEVEL_TITLE.DELAY` | `constants.js` | `0.8` | 无云雾时的排期延迟（原行为） |
| `HEAL_LINK.PULSE_PERIOD` | `constants.js` | `2.0` s | 回血脉冲间隔 |
| `HEAL_LINK.PULSE_HEAL` | `constants.js` | `20` | 每次脉冲回血量（旧口径 10/s ⇒ 总量不变） |
| `HEAL_LINK.RADIUS` | `constants.js` | `14` m | 光环半径（现场口径 12~15m；**覆盖**敌种表 `healRadius`） |
| `HEAL_LINK.RING_DUR` / `RING_POOL` | `constants.js` | `0.9` s / `3` | 环扩散时长 / 同时存在的环上限（性能兜底） |
| `HEAL_LINK.PLUS_RIDE` | `constants.js` | `4` | 随环扩散的「+」数量（`0` = 不画） |
| `HEAL_LINK.LINES` | `constants.js` | `false` | 旧「治疗线」总开关（改 `true` 即回，但会很乱） |
| `RAPID_FIRE.VISUAL.BULLET_COLOR` | `constants.js` | `0x49b6ff` | 加速弹颜色（连同 `TRACER_COLOR`） |
| `RAPID_FIRE.VISUAL.TRACER_MUL` | `constants.js` | `2` | 加速弹曳光长度倍率 |
| `scriptEnemyTypes` | `game.js` | — | 预载队列的「脚本独有敌种」来源，改脚本即自动跟随 |

---

## 4. 踩坑

1. **`warm` 不能无脑全开**：走 DepthSprite 立绘的怪，抓帧本身就会把 GLB 的纹理上传一遍；再叠一次 `warmModelGpu` 等于穿云窗内白烧一遍（4 秒窗口很紧）。所以 `warm: !capture`。
2. **变脸卡顿的锅不在加载，在 `material.dispose()`**：GLB 早就 parse 完、纹理也在缓存里；`swapBalloonModel` 一 `dispose` 就把 GL program 的引用计数打到 0，下一帧同步重编译。**只预载资源治不了这个病，必须预建整份模型**。
3. **预建的脸不能接管 `bodyModel`**：黑阶段要 `b.bodyModel.visible = false`、受击闪烁也走 `bodyModel`/`_modelMats`。所以变体只从 `_variants` 里切，`setBalloonVariant` 切完再把这两个字段指向「当前显示的那张」。
4. **标题卡和雾的时序**：`_startLevelAudio()` 是「雾散」那一刻调用的；标题卡排期若还留在那里，`INTRO_DELAY` 就白写了（每次雾散都会把倒计时重置成 `DELAY`）。必须把排期搬到 `_loadLevel()` 末尾、且 `_tickLevelTitle` 要能在穿云期间被调用。
5. **实例色是乘的**：`MeshBasicMaterial` 基色不是白，加速蓝会变成脏色。这条最容易在「本地看着还行、头显里发灰」时被忽略。
6. **复用池的旧对象会粘住 `boost`**：`_obtain()` 从池里捞出来的子弹必须被 `spawn` 全覆盖 `boost`（单测专门守这条），否则一颗加速弹能让它后面复用的普通弹也变蓝。

---

## 5. 验证方法

- `npm test` —— 本轮 195/195 全绿，其中新增：
  - `tests/preload-queue.test.mjs`（5 项）：`scriptEnemyTypes` 只收 elite 敌种、第 5 关队列含 `heart`、队列含 `Model/盾牌.glb`；
  - `tests/boss-face-variants.test.mjs`（8 项）：预建 / 切脸只切 `visible` / 预建失败回退重建 / `dropBalloonVariants`；
  - `tests/level-title-label.test.mjs`（追加 4 项）：`INTRO_DELAY` 排期与「雾散不重置」；
  - `tests/heal-pulse.test.mjs`（7 项）：站桩 `controlled` / 脉冲节拍与回血量 / 半径 / 环池上限；
  - `tests/boost-bullets.test.mjs`（6 项）：材质基色为白 / `instanceColor` 构造即建 / `boost` 从 `Player.fire` 透传到 `spawn` 与 `sync` / 复用不粘色 / 曳光 `lenScale` / `_updateFx` 只改加速弹。
- 现场（头显）：
  - 第 5 关末尾精英**合成那一下**不再有可感知停顿；术士落地不移动，脚下每 2 秒冒一个绿环扩散出去、被治疗的怪闪绿；
  - 第 6 关 Boss 蓝→红→黑三次变脸**不再卡**（回退日志里不应出现「预建脸未就绪」）；
  - 每关开局起雾时就能看到「第 N 关 · 场景名」标题卡，雾散时仍在屏上；
  - 10 连杀触发加速 → 枪打出**青蓝色**弹、曳光明显更长，3 秒后自动恢复；
  - 推流链路照旧（本轮未改推流）。

---

## 6. 本轮**不做**（已是双方确认的口径）

- 金色光点飞行期**预建卡面贴图**（选项卡卡一下）；
- **精英落地分帧**（把「合成那一帧」的重活摊到几帧）；
- Boss 试炼场 / `glassGrid` / `flipGrid` 预建；
- 光点 / 金点 mesh 池化；
- 每帧 `dt` 探针式的卡顿定位工具；
- 推流侧任何改动（用户明确「现在不管推流的事情」）。

---

## 7. 第二轮现场返工（2026-10-14 · 当天第二版）

现场拿第一版测完后反馈了三件事，都在这一节落地。

### 7.1 关卡名第二轮定稿（机制关统一「魔术空间」）

只动 `src/content/levels.js` 一张表（**名字的唯一来源**）：

| 关 | 名字 | 关 | 名字 | 关 | 名字 |
|---|---|---|---|---|---|
| 1 | 落日余晖 | 7 | 云海鲲鹏 | 13 | 夕阳双糖 |
| 2 | 长夜突袭 | 8 | 血月之夜 | 14 | 云卷暴风 |
| 3 | 魔术空间 | 9 | 魔术空间 | 15 | 魔术空间 |
| 4 | 双马拱日 | 10 | 彩虹之桥 | 16 | 天梯初现 |
| 5 | 暮色极光 | 11 | 雷云密布 | 17 | 黎明之前 |
| 6 | 脸谱画廊 | 12 | 巨龙云潭 | 18 | 公主堡垒 |

> 代价：3/9/15 三关**同名** ⇒ 单测里「关卡名互不相同」的判据改成
> 「机制关共用一个名字，其余唯一」（`tests/level-title-label.test.mjs`）。

### 7.2 机制关的关卡名：从「不弹」改成「等魔术师收场后再弹」

现场：「机制关好像不显示关卡名」。根因就是第 2.3 节里那条 `SKIP_MECHANIC: true` ——
当初是为了不让卡片压在魔术师开场动画上，代价是这三关**永远看不到名字**。现在：

- `SKIP_MECHANIC: false`（**保留开关**，置 `true` 仍然彻底不弹）；
- 新增 `MECHANIC_DELAY: 12.0`（兜底：从关卡开始算，晚于「云雾 4s + 魔术师动画 10s」）与 `MECHANIC_AFTER_VOICE: 0.5`；
- `_loadLevel` 对机制关排 `MECHANIC_DELAY`；`_bindOpeningVoice` 的语音 `ended` 回调里**改排** `MECHANIC_AFTER_VOICE`
  —— 语音一结束、魔术师刚收场，卡片正好出现；
- 新增 `_levelTitleDone` 守卫（本关弹过就不再排）⇒ 两次排期**谁先到算谁**，一关只弹一次；
  `_clearLevelEntities` 与 `_loadLevel` 都会复位它。

> 为什么不能只加一个固定延迟：开场语音长度是变的（5.9~7.5s，且不同关不同文件）。
> 固定值要么压在动画上、要么等到玩家已经开始打了。用「语音 ended 改排 + 一个够晚的兜底」两头都不吃亏。

### 7.3 治疗术士：绿环 → **粉色加号**（回血量 = 玩家当前攻击力）

现场：绿环「看不到」、固定回 20 点「看不出效果」。已改成：

| 项 | 旧（见第 2.4 节） | 新 |
|---|---|---|
| 目标 | 半径内**所有**怪 | 纯函数 `pickHealTarget`：**血量百分比最低**的一只；并列取**离玩家最近**的（`balloons.js`） |
| 治疗量 | 固定 `PULSE_HEAL = 20` | **玩家当前攻击力**（`game.waves.onHealCast` 回调返回，随构筑成长 ⇒ 永远看得出效果） |
| 频率 | 每 2s 一次 | 每 **1s** 一次（`PULSE_PERIOD: 1.0`，现场「每秒治疗一次」） |
| 表现 | 地面绿色扩散圆环 + 随环漂的「+」 | 一枚**粉色加号**从术士飞向目标（`fx.HealPlusFx`，抛物线飞行、末段淡出）；命中目标闪一下**粉** |
| 半径 | `RADIUS = 14` 决定治疗范围 | **不再吃半径**（术士站 24m 外，前压的怪在玩家身边，加半径反而「够不着」） |

- 圆环实现与参数**都留着**（`RING_ENABLED: false`）；旧的「治疗线」同样 `LINES: false` —— 两条回退口径都在。
- `plusTexture()` 从「画绿」改成「画白」，颜色改由各材质 tint（绿 = 旧治疗线/旧回环，粉 = 新加号）。
- `HealPlusFx` 池化（`PLUS_POOL = 8`，池满复用最老的槽），1 枚加号 = 1 draw call，
  `depthTest: false` + `renderOrder 999`（隔着怪/墙也看得见 —— 治疗反馈必须醒目）。
- 新测试文件 `tests/heal-plus.test.mjs`（13 例）取代原 `tests/heal-pulse.test.mjs`。

### 7.4 参数速查（第二轮新增 / 变更）

| 参数 | 位置 | 现值 | 说明 |
|---|---|---|---|
| `LEVEL_TITLE.SKIP_MECHANIC` | `constants.js` | `false` | 机制关是否彻底不弹（逃生开关） |
| `LEVEL_TITLE.MECHANIC_DELAY` | `constants.js` | `12.0` s | 机制关兜底延迟（等不到语音结束就它弹） |
| `LEVEL_TITLE.MECHANIC_AFTER_VOICE` | `constants.js` | `0.5` s | 开场语音 ended 之后多久弹 |
| `HEAL_LINK.PULSE_PERIOD` | `constants.js` | `1.0` s | 治疗间隔 |
| `HEAL_LINK.PLUS_COLOR` | `constants.js` | `0xff7fbf` | 加号颜色（粉，现场指定） |
| `HEAL_LINK.PLUS_DUR` / `PLUS_POOL` / `PLUS_ARC` | `constants.js` | `0.45` / `8` / `0.7` | 飞行时长 / 池上限 / 抛物弧高 |
| `HEAL_LINK.PLUS_FLASH` | `constants.js` | `true` | 命中目标是否闪粉 |
| `HEAL_LINK.PULSE_HEAL` | `constants.js` | `0` | `>0` 时退回固定治疗量（调试用） |

---

## 8. 第三轮现场返工（2026-10-14 · 当天第三版）

### 8.1 「治疗术士完全没作用」的真根因：回调挂错了对象

现场三次反馈的演进是：**绿环看不到 → 换粉色加号 → 还是没作用、加号也不见**。
前两次都在改「表现」，其实两次的现象是**同一个 bug**：

| | |
|---|---|
| 读取方 | `src/game/balloons.js` → `BalloonManager._applyHealAura()` 里读 `this.onHealCast` / `this.onHealPulse` |
| 写入方（错） | `src/game/game.js` → `this.waves.onHealCast = fn`（挂到了 **WaveManager** 上） |

WaveManager 上从来没有代码读这两个属性 ⇒ 回调恒为 `undefined` ⇒ `heal` 恒为 `0`：
**既不回血、也不飞加号**（加号是在 game 的回调里画的），上一轮的绿环同样如此。
所以这不是渲染问题，是**接线问题**。

修法（两条都做，互为保险）：

- `game.js` 直挂读取方：`this.balloons.onHealCast = …`（`game.balloons === waves.balloons`）；
- `waves.js` 增加**转发访问器**：`set onHealCast(fn) { this.balloons.onHealCast = fn; }`（get 同理），
  `onHealPulse` 一样 —— 以后无论挂哪一层都生效，不会再踩同一个坑。

回归用例：`tests/heal-plus.test.mjs` 的「★接线回归：挂在 waves 上的 onHealCast 必须落到 BalloonManager」。

### 8.2 治疗术士新口径（现场指定）

| 项 | 第三轮 | 前两轮 |
|---|---|---|
| 间隔 | **3 s**（`PULSE_PERIOD`） | 1 s / 2 s |
| 目标 | **血量百分比最低的精英怪**（`ELITE_ONLY: true`），并列取离玩家最近 | 血最少的任意怪 / 半径内所有怪 |
| 单次回血 | **1000**（`PULSE_HEAL`），**超出目标上限的部分不算** | 玩家当前攻击力 / 固定 20 |
| 表现 | 粉色加号 + 命中闪粉（**目标满血也照飞**，玩家必须看得见） | 同左 / 绿环 |
| 场上没有精英 | 什么都不做（不回调、不发射） | 兜底给任意怪 |

### 8.3 末尾批吸收场上精英（修「精英Boss 死了，还有一个精英出现」）

现场：「偶尔精英Boss死了，还有个精英出现」。根因是**只清杂鱼**：

- `_fuseSpawn` 里旧判据 `if (!b.alive || b.isElite || b.isBoss) continue;` —— 精英被排除在「化成光点」之外；
- `_updateEliteWatch` 收尾时调的是 `_clearTrash()`（`!isElite && !isBoss`）—— 同样不动精英。

于是 5/15/25s 那批**没被打死的普通精英**一直留在场上往玩家飘；末尾批清空、选项卡弹出来之后，
它还在 ⇒ 看着就像"又冒出来一个精英"。

现在（两条配套）：

1. **末尾批（`goldReturn`）融合时**，场上已有的精英**优先化成光点**被吸进融合点（视觉上就是"被吸走"），
   再清杂鱼；**非末尾批维持原口径**（精英留给玩家打）。
2. **金点批收尾时**（`_updateEliteWatch` → 抽卡那一刻）新增 `_clearElites()` 兜底：场上不许再留精英。

回归用例：`tests/climax-absorb.test.mjs`（7 例）。

### 8.4 参数速查（第三轮）

| 参数 | 位置 | 现值 | 说明 |
|---|---|---|---|
| `HEAL_LINK.PULSE_PERIOD` | `constants.js` | `3.0` s | 治疗间隔 |
| `HEAL_LINK.PULSE_HEAL` | `constants.js` | `1000` | 单次回血（超出上限不算）；配 `0` → 退回玩家当前攻击力 |
| `HEAL_LINK.ELITE_ONLY` | `constants.js` | `true` | 只奶精英；`false` = 所有怪里挑血最少的 |
| `get/set onHealCast` / `onHealPulse` | `waves.js` | 转发到 `balloons` | 接线保险（见 8.1） |
| `_clearElites()` | `waves.js` | — | 收尾清精英（与 `_fuseSpawn` 的吸收配套） |
