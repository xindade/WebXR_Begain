# WebXR Stability Implementation Plan

> 执行方式：当前任务按顺序实施，每阶段先复现并添加失败测试，再修复、验证。最终独立代码审查。

**Goal:** 按已批准的审查建议修复玩法、资源生命周期和基础体验，并提供可复查的验证记录。

**Architecture:** 保留静态页面与 vendored Three.js。独立小模块承载碰撞、资源、设置、暂停、性能采样；Game 仅接入必要钩子。

**Tech Stack:** ES Modules / Three.js r168 / Node 24 内置 test runner / Python 静态服务器。

- [x] 阶段 1：`tests/gameplay.test.mjs` 复现攻击 750 选卡降至 700、子弹跨过卡牌、加载失败隐藏敌人。修改 `content/cards.js`、`game/cardDraft.js`、`game/balloonModels.js`、`vr/input.js`、`game/game.js`，新增 `core/collision.js`。执行 `npm test`，确认失败用例变绿。
- [x] 阶段 2：`tests/resources.test.mjs` 验证加载失败重试、三张天空容量、乱序结果失效及释放。统一 `game/glbCache.js`；更新 `core/world.js`，新增资源加载状态模块并接入 `main.js`、`index.html`；进度不按固定时间伪造完成。执行 `npm test`。
- [x] 阶段 3：新增 `core/performance.js` 与诊断 UI、导出 JSON；测试统计与样本容量。增加 `tools/bake-depth-sprites.html` 与脚本，沿用真实捕获函数导出 PNG 和配置；运行时优先读离线图集。浏览器验证工具和诊断。
- [x] 阶段 4：新增 `core/settings.js`、`core/pause.js`、`ui/settings.js`，接入主循环、输入、音频和 XR 暂停菜单。测试设置非法值、暂停原因叠加、失焦输入清理；浏览器检查设置、暂停、恢复。
- [x] 阶段 5：更新 README、旧配置说明和 `docs/verification.md`；语法/模块检查、全量回归、浏览器冒烟、独立代码审查。真机检查明确留待 PICO/Quest 执行。

关键回归示例：`ATTR_TYPES.find(c => c.id === 'atk').apply({atk:750})` 不得低于 750；子弹从卡球前 0.375m 到后 0.375m 必须命中；请求天空 A/B 按 B/A 完成时最终仍显示 B；暂停原因为 manual+hidden 时清 hidden 不得恢复玩法。

