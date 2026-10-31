# 第八十二修：Boss 与末尾精英强度

日期：2026-10-18

## 现场口径

1. 脸谱 Boss 血量 ×3，龙形 Boss ×2，魔术师 Boss ×5；
2. 远程精英（忍者 / 幽灵 / 章鱼）的普通精英血量整体 ×1.3；
3. 末尾精英血量改为「本体 ×1.5 + DPS×6 按只数均分」；
4. 末尾精英移动速度降低一半。

## Boss 血量

| Boss | 原值 | 现值 | 实现 |
|---|---:|---:|---|
| 脸谱 Boss | 3000 | 9000 | `FACE_BOSS.HP` |
| 龙形 Boss | `HP_MULT 1.0` | `HP_MULT 2.0` | `DRAGON.HP_MULT`，龙身 / 龙爪 / 总血池一起 ×2 |
| 魔术师 Boss | `HP_BASE 20000 + DPS×30` | 再 ×5 | `MAGICIAN_BOSS.HP_MULT = 5`，`(HP_BASE + DPS×HP_DPS_SEC) × HP_MULT` |

魔术师倍率放在最终血量上，基础值与 DPS 加成一起放大；`HP_MULT` 同时写入 `userConfig.js`，现场可热调。

## 普通远程精英

```text
忍者 / 幽灵 / 章鱼 = (本体 + 进入本关时快照 DPS × 1) × 1.3
其它普通精英       = 本体
```

常量：`enemyLevels.RANGED_NORMAL_HP_MUL = 1.3`。

## 末尾精英

```text
每只最终血量 = 该只本体 × 1.5 + 进入本关时快照 DPS × 6 ÷ 本批只数
移动速度     = 原速度 × 0.5
```

- `ELITE_TUNING.BODY_MUL = 1.5`
- `ELITE_TUNING.DPS_SECONDS = 6`（整批共享，按只数均分）
- `ELITE_TUNING.SPEED_MUL = 0.5`（同样路程从约 10 秒变 20 秒）

与第八十一修的区别：不再把整批本体压到「DPS×6」上限，也不再按本体比例分摊 DPS 池；
现在每只本体各自 ×1.5，DPS×6 只按只数平均分。

## 涉及文件

- `src/core/constants.js`：`FACE_BOSS.HP`、`DRAGON.HP_MULT`、`MAGICIAN_BOSS.HP_MULT`、`ELITE_TUNING`
- `src/core/userConfig.js`：魔术师 / 龙 Boss 倍率热调入口
- `src/game/bossMagician.js`：最终血量乘 `HP_MULT`
- `src/content/enemyLevels.js`：远程普通精英 ×1.3
- `src/content/spawnDirector.js`：末尾精英血量公式与速度
- `src/game/waves.js`：把本批只数传给末尾精英血量函数
- `tests/enemy-levels.test.mjs`、`tests/spawn-director.test.mjs`、`tests/hitbox-heal-ranged.test.mjs`

## 验证

- `npm test`：482 项全部通过。
- 末尾精英测试锁住：1 只 `本体1000 / DPS300 = 3300`；4 只 `本体1000 / DPS1000 = 每只 3000`。
- 远程普通精英测试锁住：第 8 关忍者 `(4400+1000)×1.3 = 7020`。
- Boss 倍率测试锁住：脸谱 `9000`、龙 `HP_MULT=2`、魔术师 `HP_MULT=5`。
