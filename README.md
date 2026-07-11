# WebXR 肉鸽打气球 · 可玩原型框架

> 一个基于 ima 知识库「WebXR 肉鸽打气球」设计文档，从零搭建的**多平台 WebXR** 打气球肉鸽游戏原型。
> 纯前端 ES Module + Three.js r168（**本地 vendored，无 CDN 依赖**），桌面浏览器可直接跑，标准 WebXR 头显（PICO / Quest 等）进 VR 即玩。

---

## 1. 这是什么

打气球 + Roguelike（肉鸽）的 VR 射击游戏：玩家站在可移动平台上，用枪（或手柄）射击一波波气球，清波后从 3 张随机卡牌中选 1 张强化自己，循环推进 18 关，每 6 关遇 Boss。当前为**可玩原型框架**——核心循环已跑通，美术全程序化占位，便于先验证玩法手感。

设计完全来自你的 ima 知识库，数值/敌人/关卡/卡牌全部数据驱动。

---

## 2. 技术栈与特性

| 项 | 说明 |
|---|---|
| 渲染 | Three.js r168，本地 `vendor/three.module.js`（**无外网依赖**） |
| 入口 | `index.html` 用 importmap，无需打包/构建 |
| 平台 | 标准 WebXR `immersive-vr`；桌面键鼠回退做开发调试 |
| 输入 | 统一抽象层，一套接口同时驱动桌面与头显手柄 |
| 性能 | 子弹对象池、降采样（pixelRatio≤1）、关阴影 |
| 表现 | 程序化美术（笑脸 CanvasTexture）、程序化音效/BGM（Web Audio，无音频文件） |
| 调试 | VR 左右手腕面板（右=战斗信息，左=实时日志） |

---

## 3. 目录结构

```
index.html              入口：importmap(指向本地 three) + canvas + 进入 VR 按钮
vendor/
  three.module.js       Three.js r168 本地副本（头显离线可加载的关键）
src/
  main.js               入口：建 World/Game/Input/WristUI，自定义 PICO 兼容「进入 VR」
  core/
    constants.js        所有数值常量速查表（移动/射击/气球/关卡/卡牌/稀有度）
    world.js            渲染器/场景/相机/灯光/天空/星空/行动边界/坐标系
    pool.js             通用对象池（子弹等复用，避免 GC 抖动）
  game/
    game.js             总编排：状态机(playing/card/over)、每帧更新、碰撞、波次推进
    player.js           玩家数值(HP/分数/大招) + 飞船占位（已隐藏，仅保留引用）
    balloons.js         气球工厂：13 种气球生成、移动、受击、表情
    bullets.js          子弹对象池：发射/更新/回收
    waves.js            波次管理：分阶段生成、Boss、关卡推进、剩余敌人数
    cards.js            肉鸽抽卡：3D 卡牌悬浮、射线指向、确认、刷新、超时随机
  vr/
    input.js            输入抽象层：桌面键鼠 + WebXR 手柄(handedness 判定/PICO 映射)
    wrist-ui.js         手腕面板：右手战斗信息 + 左手日志（Canvas→CanvasTexture）
    audio.js            程序化音效与 BGM（Web Audio 合成，无音频文件）
  ui/
    hud.js              桌面 2D 覆盖层（HP/关卡/分数/提示）
  content/
    enemies.js          13 种气球 + 5 Boss 概念配置
    levels.js           18 关循环配置（普通/危机/奖励/每 6 关 Boss）
    cards.js            肉鸽卡牌数据（4 属性 × 4 稀有度 + 金色技能卡）
```

---

## 4. 快速开始

ES Module + importmap **不能用 `file://` 直接打开**，必须走静态 HTTP 服务器。

```bash
# 桌面本机调试（http 即可）
python -m http.server 8123
# 浏览器打开 http://localhost:8123/ ，点「开始游戏」，WASD+鼠标玩

# 头显访问（必须 HTTPS —— WebXR 强制安全上下文）
npx http-server -S -C cert.pem -K key.pem -p 8080
# 头显浏览器打开 https://<PC局域网IP>:8080
#   自签证书首次会警告 → 点「高级 → 继续访问」
#   与头显同一 WiFi/网段；Windows 防火墙放行 8080 入站
#   点页面底部「🎈 进入 VR」按钮
```

**头显进不去的三类根因（已逐一解决）：**
1. **白屏 / 拉不到 three** → 已将 three.js 本地化到 `vendor/`，彻底不依赖 unpkg CDN。
2. **证书被拦** → WebXR 强制 HTTPS；自签证书首次需在头显手动放行。
3. **连不上** → 头显与 PC 必须同网段；防火墙放行端口（不要用 `localhost`，那是头显自己）。

---

## 5. 操作说明

| 平台 | 移动 | 视角/瞄准 | 射击 | 大招(如来神掌) | 抽卡确认 | 退出 VR |
|---|---|---|---|---|---|---|
| 桌面 | WASD / 方向键 | 鼠标（点画面锁定指针） | 左键 | F | 左键点卡牌 | — |
| VR | 右手摇杆（PICO 轴/取反已适配） | 头部 + 右手柄朝向 | 右手扳机 | 任一握柄(grip) | 扳机 | 右手 A/B |

> 手柄输入按 `source.handedness` 判定左右手；PICO 按键映射：trigger=0 / grip=1 / A=4 / B=5；摇杆 `axes[2/3]` 回退 `[0/1]`，前推为负值（已取反）。
> 子弹方向用世界 **−Z** 前向（`forwardOf` 助手，见 `vr-controller-kit` skill），与手柄可见光标一致。

**VR 里看得到的信息：**
- **脚下**：淡蓝色边界长方体（可移动范围 X±2m / Z±4m）+ 0.5m 单位坐标系（红=X 轴、绿=Z 轴、黄=原点，交点标米值）。
- **右手背**：战斗面板（关卡 / 剩余敌人 / 船血 / 分数）。
- **左手背**：实时日志（环形缓冲，记录进关/抽卡/强化/大招等事件）。

---

## 6. 核心循环（状态机）

```
playing ──(清空当前波次)──▶ card ──(选 1 张卡)──▶ playing
   │                              │
   └────(船血归零)──▶ over ───────┘(重开)
```

每帧 `game.update(dt)`：移动 → 射击(对象池) → 波次生成 → 碰撞(子弹-气球 / 气球-船) → 手腕面板/日志刷新。Boss 关生成大体型高血气球，撞船也算通关（防卡死）。

---

## 7. 已实现功能

- ✅ 多平台输入抽象层（桌面 + WebXR 手柄，逻辑层不感知平台）
- ✅ 核心战斗：飞船血 → 分阶段波次 → 子弹池 → 碰撞 → Game Over/重开
- ✅ 肉鸽抽卡：3 卡悬浮、射线指向+确认、刷新(积分翻倍)、15s 超时随机
- ✅ 敌人 13 种气球 + Boss 关（3000 血）、普通/危机/奖励关出怪区分
- ✅ 18 关循环 + 天空三预设缓动 + 程序化星空
- ✅ 行动边界占位长方体 + 0.5m 坐标系（含数字标注）
- ✅ VR 左右手腕面板（战斗信息 / 日志）
- ✅ 程序化美术、音效、降采样与对象池优化
- ✅ 本地化 three.js（头显离线可跑）、PICO 兼容 VR 会话请求

---

## 8. 关键设计决策 / 踩坑记录

| 问题 | 根因 | 解法 |
|---|---|---|
| 头显白屏进不去 | importmap 走 unpkg CDN，头显侧拉不到 three | 下载 three r168 到 `vendor/`，importmap 改本地 |
| 子弹从手柄**反方向**射出 | `getWorldDirection()` 返回 **+Z**，但相机/手柄前向是 **−Z** | 用 `forwardOf(obj)` = `getWorldQuaternion` + `set(0,0,-1).applyQuaternion`；已沉淀进 `vr-controller-kit` skill |
| 抽卡卡牌生成在身后 | 同上的方向坑（`camera.getWorldDirection` 未取反） | 取世界前向后再 `negate()` |
| 左/右手柄分不清 | 只靠 `getController(i)` 索引，PICO 可能左右颠倒 | 用 `connected` 事件读 `handedness` 区分 |
| 眼前挡视线的飞船 | 占位飞船贴在相机前 | 隐藏 `_buildShip`（保留空 Group 引用），改由边界长方体标示范围 |
| 看不到行动边界 | 移动被钳制但无视觉 | `_buildBoundary()`：半透明长方体 + 高亮边框 |
| 头显里没空间参照 | 纯空场 | `_buildCoordGrid()`：0.5m 网格 + 数字标注 |
| 日志面板太大 | 左手 Canvas 物理尺寸偏大 | 缩小到 1/6（保持 Canvas 分辨率，文字仍清晰） |

---

## 9. 待你确认 / 仍需补充（呼应「还要了解什么」）

不影响当前原型跑通，但打磨成完整产品需要拍板：

1. **美术资源**：当前全程序化占位。你提到有 `Ak48.glb` / `鲲鹏.glb` 等——是否按知识库目录放 `public/models/` 并由 GLTF 接口加载？还是 AI 生成/免费资源？
2. **Boss 具体机制**：当前 Boss 只是大体型高血气球。5 个 Boss 的专属弹幕/阶段行为需设计稿。
3. **如来神掌表现**：现为金色巨掌下落 + 范围秒杀，是否符合预期？
4. **数值平衡 / 关卡曲线**：出怪量、属性增量、抽卡权重集中在 `constants.js` / `content/*`，等可玩后一起调。
5. **发布形态**：PICO 原生 App（Capacitor 打包）还是仅 WebXR 浏览器？是否需要存档/排行榜/云同步？
6. **多语言/合规**：上架 PICO 商店需要的隐私政策、年龄分级等。

---

## 10. 已知限制

- 头显访问必须 HTTPS（WebXR 安全上下文），自签证书首次需手动放行；确认同网段 + 防火墙放行端口。
- 完整玩法验证需在真实头显或 WebXR 模拟器实测；桌面路径已用静态服务器验证可加载。
- 美术/音效均为占位，待替换正式资源。
