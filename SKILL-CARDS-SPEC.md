# 技能选项卡功能规格（第三关 · 如来神掌 / 金箍棒 / 定身咒）

> 用途：云端代码同步到本地后，照本文档一次性 AI 编程重建该功能。
> 适用关卡：第三关激光关（laserMode:'full'）通过后触发；其余关仍走原随机抽卡。

## 1. 功能目标
- 第三关激光关**通过后**，**固定弹出三张红色技能卡**，玩家射击对应气球选择其一（选卡机制沿用现有「射击绑定气球」）。
- 三技能：
  - **如来神掌（buddha）**：刷新/解锁全屏大招（秒杀级），立即可放。
  - **金箍棒（staff）**：对玩家正前方 90° 扇形（±45°）内所有敌人造成致命伤害 ≈ 四分之一全屏。
  - **定身咒（freeze）**：暂停所有敌人行动；Boss（龙）仅冻结总时长的一半。
- 其余关抽卡逻辑不变（属性卡 + 随机技能卡 bell/等 + 刷新卡，刷新卡积分不足时锁定）。

## 2. 涉及文件与改动点

### 2.1 src/core/constants.js
- 确认已有 `BUDDHA`（含 `FALL_START_SCALE:8`、`FALL_END_SCALE:1.5`，**不可缺失**，否则如来神掌大招崩溃）、`STAFF`、`FREEZE` 三块：
  - `STAFF = { DAMAGE:1000, HALF_ANGLE:45, WALL_DUR:0.6, WALL_WIDTH:12, WALL_HEIGHT:6, WALL_DIST:6 }`
  - `FREEZE = { DURATION:5, BOSS_FACTOR:0.5 }`
- 若云端版本缺这三块或字段名不同，按上述补齐/对齐。

### 2.2 src/content/cards.js
- `SKILL_CARDS` 中 `buddha` / `staff` / `freeze` 三张卡 `color` 改为 `'#ff3b3b'`（红色）。
- `buddha.apply = (p) => { p.buddhaUnlocked = true; p.buddhaTimer = 0; }`
- `staff.apply` 与 `freeze.apply` 设为 **no-op**（实际伤害/冻结由 game.js 的 onSkill 回调执行，因为需要场景/敌人上下文）。
- `bell`（金钟罩）等其它技能卡保留原样，仍走随机卡池。

### 2.3 src/game/cardDraft.js（抽卡系统）
- `_buildCards()` 新增 **fixedSkills 模式**：
  - 若 `this._state.fixedSkills` 非空，仅按给定 id 列表生成对应 `SKILL_CARDS`（kind:'skill'），**不随机、不出刷新卡**。
  - 否则走原随机逻辑（属性卡 + 随机技能卡 + 刷新卡）。
- **关键修复（必须先做）**：`canAfford` 必须提升为 `_buildCards()` 的**函数级声明**（放在 if/else 之前），不能在 else 分支内用 const 声明——否则 fixedSkills 分支的 `forEach` 引用未定义 `canAfford` 会抛 `ReferenceError`（原 169:42 报错）。
- `_finish()` 的 skill 分支：先 `sel.pick.def.apply(this._state.player)`，再 `if (this._state.onSkill) this._state.onSkill(sel.pick.def.id);` 把需场景上下文的技能交给 game 执行。
- 其余（射击碰撞、浮动、结算飞走、光点）保持不变。

### 2.4 src/game/balloons.js（冻结）
- `BalloonManager.update(dt, target, camera, opts={})` 读 `opts.freezeNormal` / `opts.freezeBoss`；
  - 冻结时跳过 `b.update()`（不移动、不攻击）。
- `_applySeparation` / `_applyHealAura` 跳过被冻结目标（`if (a._frozen) continue;`）。
- 在 `update` 内对每个气球设 `b._frozen = freezeNormal || (freezeBoss && b.isBoss)`（Boss 判定按现有 `isBoss` 字段）。

### 2.5 src/game/game.js（主流程与三技能实现）
- import 增加 `STAFF, FREEZE`（与 `BUDDHA` 同文件）。
- constructor：`this.enemyFreeze = 0;`
- 第三关 full 模式过关处：`this._forceSkillCards = ['buddha','staff','freeze']; this._enterCard();`
- `_enterCard()`：
  - `_cardState` 注入 `fixedSkills: this._forceSkillCards || null` 与 `onSkill: (id) => this._applySkillCard(id)`；
  - 调用后 `this._forceSkillCards = null;`（取用即清空）。
- 新增方法（关键签名）：
  - `_applySkillCard(id)`：buddha→解锁大招；staff→`_castStaff()`；freeze→`_castFreeze()`。
  - `_castStaff()`：取相机前向 `getWorldDirection`，对 `balloons.list` 中满足 `to·fwd >= cos(HALF_ANGLE)` 的敌人 `takeDamage(STAFF.DAMAGE)`；随后 `_spawnStaffWall(pp, fwd)`。
  - `_castFreeze()`：`this.enemyFreeze = FREEZE.DURATION;`
  - `_spawnStaffWall(pp, fwd)` / `_updateStaffFx(dt)`：前方红色光墙视觉（AdditiveBlending，WALL_DUR 后淡出并 dispose）。
- `_updatePlaying()` 普通分支：计算 `freezeNormal` / `freezeBoss` 注入 `this.balloons.update(dt, ORIGIN, camera, { freezeNormal, freezeBoss })`，并在 `enemyFreeze>0` 时递减；Boss 冻结时长 = `FREEZE.DURATION * (1 - FREEZE.BOSS_FACTOR)`。
- 主 `update(dt)` 内调用 `this._updateStaffFx(dt);`

## 3. 已知坑（重建时务必核对）
1. `cardDraft.js` 的 `canAfford` 作用域——必须函数级声明，否则第三关必崩（169:42）。
2. `BUDDHA.FALL_START_SCALE` / `FALL_END_SCALE` 必须存在，否则如来神掌大招崩溃。
3. fixedSkills 模式必须保证 `_enterCard` 传入 `player` 与 `onSkill`（否则 skill.apply / onSkill 报错）。
4. 定身咒对 Boss 只冻一半时长，靠 `enemyFreeze` 计时 + `freezeBoss` 标志实现，不要直接改敌人自身计时器导致 Boss 也被全冻。

## 4. 验收点（头显/本地实测）
- 第三关通过 → 出现 3 张红卡：如来神掌 / 金箍棒 / 定身咒。
- 选「如来神掌」→ 大招就绪（可放）；选「金箍棒」→ 正前方敌人被秒、出现红色光墙；选「定身咒」→ 小怪冻结 5s、Boss 仅冻 2.5s。
- 其余关抽卡照常（属性卡 + 随机技能卡 + 刷新锁），不受本次改动影响。
- 控制台无报错（尤其 `canAfford is not defined` 与 `FALL_START_SCALE`）。

---

## 附：同步后重建工作流（参考，非功能本身）
1. **备份当前改动（保险）**：`git stash push -m "skill-cards-wip"`（即使有文档，也先收起防丢）。
2. **同步云端**：`git fetch origin` → `git pull --rebase origin main`（本地变最新）。
3. **决策**：
   - 若云端未改动上述 5 文件 → `git stash pop` 直接恢复（极少冲突）。
   - 若云端已改动这些文件 → 放弃 stash，按本文档在最新代码上**逐文件重建**。
4. 重建后 `node --check` 五个文件，本地/头显实测验收点。
