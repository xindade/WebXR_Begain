# 程序化音频规格 · AUDIO-SPEC

> 《WebXR 肉鸽打气球》全部音频的技术规格。**所有声音由代码实时合成，项目零音频文件。**
> 本文件面向"另一个 AI"：只要照第 4 节的合成配方与第 5 节的编排规则实现，即可在任何支持
> **振荡器 + 噪声源 + 滤波器 + 增益包络** 的音频环境（Web Audio / Unity / SuperCollider / FMOD 等）
> 完整复现本项目的声音，无需访问源码。

| 项 | 值 |
|---|---|
| 源码 | `src/vr/audio.js`（`AudioManager` 类，729 行） |
| 运行时 | Web Audio API（`AudioContext`） |
| 音频资源 | 无（0 个音频文件） |
| 内容 | 2 个音效 + 3 套 BGM（normal / laser / boss） |
| 参数常量 | `src/core/constants.js` 的 `BOSS_BGM` 块 |
| 游戏接线 | `src/game/game.js` |
| 试听页 | `tools/bgm-preview/index.html`（自包含，双击可开） |

**约定**：时间单位秒(s)，频率 Hz，MIDI 音高按 `A4 = 69 = 440Hz`。
包络记法 `setValueAtTime(g) → expRamp(0.001, +0.16)` 表示"置为 g，随后在 0.16s 后指数衰减到 0.001"。

---

## 1. 系统架构

### 1.1 音频总线

```
                    ┌──────────────────────────────────────┐
   BGM 所有音色 ───▶ │ bgmBus (GainNode)                    │
                    │   静止 0.18 / 切轨 duck 到 0.02       │
                    └──────────────┬───────────────────────┘
                                   ▼
   音效 shoot/pop ──────────▶ master (GainNode, 0.5) ──▶ destination
```

- 音效**不经过** `bgmBus`，避免切轨 duck 把枪声一起压掉。
- `bgmBus` 在 `startBGM()` 时创建、在 `stopBGM()` 淡出后销毁（每次播放新建，不做复用）。

### 1.2 生命周期

| 阶段 | 方法 | 说明 |
|---|---|---|
| 解锁 | `unlock()` | 必须在**用户手势**内调用（浏览器自动播放策略）；创建 ctx，若 `suspended` 则 `resume()` |
| 播放 | `startBGM()` | 建 `bgmBus`（0.0001 → 0.8s 内升到 0.18），步长归零，启动 25ms 调度器 |
| 切轨 | `setTrack(kind, variant)` | 未播放时立即生效；播放中则排到**下一小节边界**并做 duck |
| 强度 | `setIntensity(0~1)` | 仅赋值（clamp 到 0..1），由编排层读取 |
| 停止 | `stopBGM()` | 清定时器，`bgmBus` 0.25s 淡出后 400ms 断开 |

### 1.3 状态字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `track` | `'normal'\|'laser'\|'boss'` | 当前曲目 |
| `variant` | `'dusk'\|'night'` | 仅 normal 有效（黄昏 / 黑夜） |
| `pendingTrack` / `pendingVariant` | 同上 / null | 待切换，小节边界生效 |
| `intensity` | 0~1 | 强度，见第 6 节 |
| `step` | 0..63 | 4 小节 × 16 分音符的绝对步号 |
| `bar` | 整数 | 已循环的小节数（供"每两小节"类事件使用） |
| `nextStepTime` | 秒 | 下一个待排音符的绝对时间 |

---

## 2. 调度器（复现的关键，务必照做）

早期版本一次性排 16 步 → **4 秒后音乐停止**。正确做法是 lookahead 调度：

```
stepDur = 60 / BPM / 4                    // 16 分音符时长
nextStepTime = currentTime + 0.1          // startBGM 时初始化

每 25ms（setInterval）执行 _schedule():
    if nextStepTime < currentTime:        // 后台/休眠恢复后落后太多 → 重新对齐，不清算补发
        nextStepTime = currentTime + 0.05
    while nextStepTime < currentTime + 0.2:      // 预排窗口 0.2s
        playStep(step, nextStepTime)             // 在该绝对时刻排下音符
        nextStepTime += stepDur
        step += 1
        if step >= 64: step = 0; bar += 1; onBar()

onBar():
    if pendingTrack: track = pendingTrack; variant = pendingVariant; 清空 pending
```

要点：

1. **用绝对时间排程**（`start(when)`），不要用 `setTimeout` 触发发声——否则主线程卡顿会导致节奏抖动。
2. 预排窗口 0.2s 足够吸收 25ms 的轮询抖动；调度器只做"排"，不做"响"。
3. 休眠恢复后**重新对齐**而非补发，否则会一次性涌出成百上千个音符。
4. 切轨只在小节边界发生，避免换和声的突兀感。

---

## 3. 通用工具

```js
_midi(n) = 440 * 2 ** ((n - 69) / 12)          // MIDI → Hz

_noiseBuffer(dur):                              // 单声道白噪声
    len = sampleRate * dur
    data[i] = Math.random() * 2 - 1             // 均匀白噪，不做加权
```

### 3.1 本规格用到的音高对照

| MIDI | 音名 | Hz | 用途 |
|---|---|---|---|
| 33 | A1 | 55.00 | laser 关 drone / 低频脉冲；boss 属音低音 |
| 38 | D2 | 73.42 | boss 主音 |
| 39 | E♭2 | 77.78 | boss 那不勒斯和弦 |
| 41 | F2 | 87.31 | normal 黑夜贝斯 |
| 45 | A2 | 110.00 | normal 黄昏/黑夜贝斯 |
| 48 | C3 | 130.81 | normal 黄昏贝斯 |
| 50 | D3 | 146.83 | boss 弦乐层（BASS+12） |
| 53 | F3 | 174.61 | normal 和弦音 |
| 55 | G3 | 196.00 | normal 黄昏和弦音 |
| 57 / 60 / 64 / 67 | A3 / C4 / E4 / G4 | 220 / 261.6 / 329.6 / 392 | normal 和弦、laser 琶音音型 |
| 62 / 63 | D4 / E♭4 | 293.7 / 311.1 | boss 铜管半音摩擦 |
| 69 | A4 | 440.00 | boss 第 4 小节属音长音 |

---

## 4. 音色库（合成配方）

共 19 个 BGM 音色 + 2 个音效。除注明外，输出一律接 `bgmBus`。
`gain` 为调用方传入值；`t` 为音符起始绝对时间。

### 4.1 鼓组

**`_kick(t, gain = 0.6)` — 底鼓**

| 项 | 值 |
|---|---|
| 源 | `sine` |
| 频率 | `150 → 48`（指数，历时 0.1s） |
| 包络 | `setValueAtTime(gain)` → `expRamp(0.001, t+0.16)` |
| 停止 | `t + 0.18` |

**`_snare(t, gain = 0.32)` — 军鼓**

| 项 | 值 |
|---|---|
| 源 | 白噪 buffer 0.2s |
| 滤波 | `highpass 1300Hz` |
| 包络 | `gain` → `expRamp(0.001, t+0.14)` |
| 停止 | `t + 0.2` |

**`_hat(t, gain = 0.1, dur = 0.045, hpFreq = 7000)` — 踩镲**

| 项 | 值 |
|---|---|
| 源 | 白噪 buffer `dur + 0.02` |
| 滤波 | `highpass hpFreq` |
| 包络 | `gain` → `expRamp(0.001, t+dur)` |
| 停止 | `t + dur + 0.02` |

**`_taiko(t, gain = 0.5)` — 太鼓**（boss 关主打击）

| 层 | 内容 |
|---|---|
| 落音 | `sine`，`95 → 45`（指数，0.18s），包络 `gain → expRamp(0.001, +0.24)`，停止 `+0.26` |
| 瞬态 | 白噪 0.05s → `bandpass 900Hz` → 包络 `gain*0.45 → expRamp(+0.05)`，停止 `+0.06` |

**`_cymbal(t, gain = 0.12, dur = 0.45)` — 钹**

| 项 | 值 |
|---|---|
| 源 | 白噪 buffer `dur` |
| 滤波 | `highpass 5000Hz` |
| 包络 | `gain` → `expRamp(0.001, t+dur)` |

### 4.2 旋律 / 和声

**`_pluck(t, freq, gain = 0.16, dur = 0.26, type = 'triangle')` — 木琴/马林巴拨奏**

| 项 | 值 |
|---|---|
| 源 | `triangle`（默认），定频 `freq` |
| 包络 | `gain` → `expRamp(0.001, t+dur)`（无 attack，即刻衰减 = 敲击感） |
| 停止 | `t + dur + 0.02` |

**`_bassPluck(t, freq, gain = 0.2, dur = 0.2)` — 拨弦贝斯**

| 项 | 值 |
|---|---|
| 源 | `sawtooth` |
| 滤波 | `lowpass 520Hz, Q 6`（谐振低通 = 拨弦的"鼻音"） |
| 包络 | `gain` → `expRamp(0.001, t+dur)` |

**`_pad(t, freq, dur, gain = 0.06, cutoff = 400)` — 持续低音 / 弦垫**

| 项 | 值 |
|---|---|
| 源 | 2 × `sawtooth`，`detune = -6 / +6`（失谐加厚） |
| 滤波 | `lowpass cutoff` |
| 包络 | `0.0001 → linearRamp(gain, t+dur*0.25) → linearRamp(0.0001, t+dur)`（慢起慢落） |
| 停止 | `t + dur + 0.05` |

**`_brass(t, freq, dur = 0.2, gain = 0.11)` — 铜管齐奏**

| 项 | 值 |
|---|---|
| 源 | 3 × `sawtooth`，`detune = -10 / 0 / +10` |
| 滤波 | `lowpass 2400Hz` |
| 包络 | `0.0001 → linearRamp(gain, +0.02)` → `setValueAtTime(gain, t+dur*0.6)` → `expRamp(0.001, t+dur)`（平台后收尾） |
| 停止 | `t + dur + 0.03` |

**`_arp(t, freq, cutoff, gain = 0.05, dur = 0.12)` — 锯齿琶音**（laser 关机械感核心）

| 项 | 值 |
|---|---|
| 源 | `sawtooth` |
| 滤波 | `lowpass cutoff, Q 8`（高 Q 谐振 = 机械/金属味） |
| 包络 | `gain` → `expRamp(0.001, t+dur)` |

**`_ost(t, freq, cutoff, gain = 0.08, dur = 0.08)` — 十六分固定音型**（boss 关推进感核心）

| 项 | 值 |
|---|---|
| 源 | `sawtooth` |
| 滤波 | `lowpass cutoff, Q 5` |
| 包络 | `gain` → `expRamp(0.001, t+dur)`，极短（0.075s）= 断续的马达感 |

**`_stab(t, freq, dur = 0.18, gain = 0.12, dissonant = false)` — 铜管短促齐奏**

| 项 | 值 |
|---|---|
| 音 | `dissonant ? [freq, freq*1.0595] : [freq]`（小二度 ≈ 半音比 1.0595） |
| 源 | 每个音 3 × `sawtooth`，`detune = -11 / 0 / +11` |
| 滤波 | `lowpass 2600Hz` |
| 包络 | `0.0001 → linearRamp(gain, +0.012)` → `setValueAtTime(gain, t+dur*0.35)` → `expRamp(0.001, t+dur)` |

**`_tremString(t, freq, dur, gain = 0.05, rate = 13, dissonant = false)` — 高速颤音弦**

| 项 | 值 |
|---|---|
| 音 | `dissonant ? [freq, freq*1.0595, freq*1.4983] : [freq, freq*1.005]`（小二度 + 五度 / 微失谐） |
| 源 | 各 1 × `sawtooth` |
| 滤波 | `lowpass 1100Hz` |
| 包络 | `0.0001 → linearRamp(gain, t+dur*0.18) → linearRamp(0.0001, t+dur)` |
| 颤音 | LFO `sine`，频率 `rate` Hz → 增益 `gain*0.75` → **叠加到包络增益上** |
| LFO 停止 | `t + dur` |

> 颤音做法要点：LFO 输出接到 `GainNode.gain`，与已有的 linearRamp 包络相加，得到"抖动的弦"。

**`_tremoloPad(t, freq, dur, gain = 0.05)` — 6Hz 颤音垫**（laser 关以外备用）

| 项 | 值 |
|---|---|
| 音 | `[freq, freq*1.5]`（八度 + 五度） |
| 滤波 | `lowpass 700Hz` |
| 颤音 | LFO `sine 6Hz` → 增益 `gain*0.6` → 叠加到包络 |
| 包络 | `0.0001 → linearRamp(gain, t+dur*0.2) → linearRamp(0.0001, t+dur)` |

### 4.3 低频与特效

**`_sub(t, f0, f1, dur = 0.32, gain = 0.45)` — 极低频 sub（心跳 / 落雷）**

| 层 | 内容 |
|---|---|
| 基频 | `sine`，`f0 → f1`（指数，历时 `dur`），包络 `0.0001 → linearRamp(gain, +0.012) → expRamp(0.001, t+dur)` |
| **二次谐波** | `sine`，`f0*2 → f1*2`，包络同形，音量 `gain * 0.4` |

> ⚠️ **硬件适配要点**：头显 / 手机扬声器对 **50Hz 以下几乎无响应**。
> 只播基频在 PICO 上会"听不见"，叠二次谐波（缺失基频技巧）后小喇叭也能感知到实体感，
> 耳机 / 外接音响则能同时感受到真正的低频。

**`_subDrop(t)` — 低频坠落**（每两小节一次"又要来了"的预感）

| 层 | 内容 |
|---|---|
| 基频 | `sine`，`95 → 26`（0.7s），包络 `0.0001 → linearRamp(0.42, +0.03) → expRamp(0.001, +0.75)` |
| 谐波 | `triangle`，`190 → 52`，音量 `0.1`，同包络（同上，保证小喇叭可闻） |
| 停止 | `t + 0.78` |

**`_blip(t, freq = 2400, gain = 0.05)` — 机械时钟脉冲**

| 项 | 值 |
|---|---|
| 源 | `sine`，定频 |
| 包络 | `gain` → `expRamp(0.001, t+0.035)` |
| 停止 | `t + 0.05` |

**`_clank(t, gain = 0.16)` — 金属撞击**

| 层 | 内容 |
|---|---|
| 噪声 | 白噪 0.12s → `bandpass 2800Hz, Q 3` → `gain → expRamp(+0.11)` |
| 音高 | `square 180Hz` → `gain*0.5 → expRamp(+0.07)` |

**`_screech(t, gain = 0.05)` — 不协和高频尖刺**

| 项 | 值 |
|---|---|
| 源 | 2 × `sine`，`1864Hz` 与 `1976Hz`（小二度，互相打架） |
| 包络 | `0.0001 → linearRamp(gain, +0.01) → expRamp(0.001, +0.16)` |

**`_gong(t)` — 铜锣**（Boss 进场）

| 层 | 内容 |
|---|---|
| 分音 | 4 × `sine`：`92 / 138 / 205 / 311` Hz，各自 `f → f*0.82`（1.6s 内下滑） |
| 分音音量 | `0.16 / (f / 92)`（越高的分音越弱） |
| 包络 | `0.0001 → linearRamp(音量, +0.02) → expRamp(0.001, +1.8)` |
| 噪声瞬态 | 白噪 1.2s → `bandpass 2200Hz, Q 1.2` → `0.1 → expRamp(+1.2)` |

**`_riser(t, dur = 1.1)` — 升调铺垫**（Boss 进场）

| 项 | 值 |
|---|---|
| 源 | `sawtooth`，`110 → 880`（指数） |
| 滤波 | `lowpass`，`400 → 6000`（指数，同步开亮） |
| 包络 | `0.0001 → linearRamp(0.12, t+dur*0.85) → expRamp(0.001, t+dur)` |

**`playBossSting()` — Boss 进场组合**（`src/vr/audio.js:474`）

```
t = currentTime
_riser(t, 1.0)                              // 1 秒升调
_gong(t + 1.0)                              // 落点：铜锣
for i in 0..2: _taiko(t + 1.0 + i*0.18, 0.45)   // 三连太鼓
```

### 4.4 音效（接 `master`，不经 `bgmBus`）

| 方法 | 配方 |
|---|---|
| `playShoot()` 射击 | 白噪 0.12s → `lowpass 3000` → `0.25 → expRamp(0.001, +0.12)` |
| `playPop()` 气球爆 | `square`，`200 → 800`（0.12s）→ `0.3 → expRamp(0.001, +0.15)` |

---

## 5. 三套 BGM 规格

通则：`step` 0..63；`s = step % 16`（小节内 16 分位置）；`b = floor(step / 16)`（第几小节）；
`barLen = stepDur * 16`；`inten = intensity`。

### 5.1 normal — 普通关 / 危机关

| 项 | 值 |
|---|---|
| 适用 | 黄昏：第 1/4/7/10/13/16 关；黑夜：第 2/5/8/11/14/17 关 |
| BPM | 黄昏 **124**，黑夜 **116**（`_bpm()`） |
| 调性 / 和声 | 黄昏 `C – Am – F – G`；黑夜 `Am – F – Dm – E` |
| 情绪 | 轻快街机，长时间循环不疲劳 |

和弦与贝斯（MIDI，按小节 `b` 取）：

| b | 黄昏和弦 | 黄昏贝斯 | 黑夜和弦 | 黑夜贝斯 |
|---|---|---|---|---|
| 0 | C `[60,64,67]` | 48 (C3) | Am `[57,60,64]` | 45 (A2) |
| 1 | Am `[57,60,64]` | 45 (A2) | F `[53,57,60]` | 41 (F2) |
| 2 | F `[53,57,60]` | 41 (F2) | Dm `[50,53,57]` | 38 (D2) |
| 3 | G `[55,59,62]` | 43 (G2) | E `[52,56,59]` | 40 (E2) |

逐层触发（`s` 为小节内 16 分位置）：

| 层 | 触发条件 | 内容 |
|---|---|---|
| 底鼓 | `s ∈ {0,4,8,12}` | `_kick(t, 黑夜 0.5 : 0.6)` |
| 弹跳鬼音 | `s === 10` **且非黑夜** | `_kick(t, 0.3)` |
| 军鼓 | `s ∈ {4,12}` | `_snare(t, 黑夜 0.26 : 0.32)` |
| 踩镲 | `s % 4 === 2`（反拍八分） | `_hat(t, 黑夜 0.07 : 0.1, 0.045, 黑夜 6000 : 7000)` |
| 贝斯 | `s ∈ {0,3,6,8,11,14}`（切分） | `_bassPluck(t, midi(BASS[b]), 黑夜 0.18 : 0.2, 0.2)` |
| 木琴琶音 | `s % 2 === 0` | 见下 |
| 夜垫 | 黑夜且 `s === 0` | `_pad(t, midi(BASS[b]-12), barLen, 0.055, 320)` |

木琴琶音算法：

```
shape = [0, 1, 2, 1]                  // 和弦音索引，形成上下行
k = (s / 2) % 8
n = chord[shape[k % 4]] + (k >= 4 ? 12 : 0)     // 后半小节升八度，增加闪亮感
_pluck(t, midi(n), 黑夜 0.12 : 0.16, 黑夜 0.3 : 0.26)
```

> 强度对 normal 无效（普通关不做强度分层）。

### 5.2 laser — 机制关（第 3 / 9 / 15 关）

| 项 | 值 |
|---|---|
| BPM | **104** |
| 调性 | A 小调，持续 A1（MIDI 33）drone |
| 设计意图 | 强调**时机**与精密感，因此**故意不放军鼓** |

| 层 | 触发条件 | 内容 |
|---|---|---|
| drone | `s === 0` | `_pad(t, midi(33), barLen, 0.07, 300 + inten*260)` |
| 时钟脉冲 | `s ∈ {0,4,8,12}` | `_blip(t, 2400, 0.05)` |
| 副脉冲 | `inten ≥ 0.5` 且 `s % 4 === 2` | `_blip(t, 1800, 0.028)` |
| 琶音 | **每一步** | `SEQ = [57,60,64,67,64,60]`，`_arp(t, midi(SEQ[s%6]), 380 + inten*1500, 0.045 + inten*0.02, 0.12)` |
| 高八度琶音 | `inten ≥ 0.7` | `_arp(t, midi(SEQ[s%6] + 12), 700 + inten*1800, 0.03, 0.1)` |
| 低频脉冲 | `s ∈ {0,8}` | `sine` 定频 `midi(33)`，`0.22 → expRamp(0.001, +0.32)` |
| 金属撞击 | `s === 8` | `_clank(t, 0.16)` |
| 踩镲 | `inten ≥ 0.5` 且 `s % 4 === 2` | `_hat(t, 0.07, 0.04, 8000)` |

### 5.3 boss — Boss 关（第 6 / 12 / 18 关，脸谱 / 龙）

| 项 | 值 |
|---|---|
| BPM | **140** |
| 和声 | **`i – i – bII – V`：Dm – Dm – E♭ – A**（`BASS = [38, 38, 39, 33]`） |
| 设计意图 | 压迫感来自**低音推进 + 不协和 + 留白**，而非"辉煌" |

> **为什么这样写**：早期版本用 `Dm–Dm–B♭–C`（bVI–bVII）配铜管**上行**五声动机，听感是"出征"而非"威压"。
> 改为**那不勒斯 E♭**（bII，转暗）+ **属和弦 A**（强烈倾向解决到 Dm，但循环又回到 Dm）——
> 制造"永远绷着不解决"的压迫循环。

**十六分固定音型（ostinato）**——推进感核心，`OST` 为相对根音的半音偏移：

```
OST = [0, 0, 7, 0, 12, 0, 7, 0, 0, 12, 7, 0, 0, 7, 12, 7]
      // 根音 - 五度 - 八度 循环，每一步都有音 = 马达式持续推进
```

**留白（breather）**：

```
breather = (b === 3 && s >= 14 && inten < 0.85)
// 第 4 小节最后两拍只留弦乐，制造「下一波砸下来」的张力
// 终期（≥0.85）取消留白 —— 不再有喘息，一路砸到循环末尾
```

逐层触发：

| # | 层 | 触发条件 | 内容 |
|---|---|---|---|
| 1 | ostinato | `!breather`（每步） | `_ost(t, midi(br + OST[s]), 240 + inten*280, 0.07 + inten*0.035, 0.075)` |
| 2 | 心跳 sub | `!breather` 且 `s ∈ {0,3,8,11}` | 强拍(s=0/8)：`_sub(t, 47, 29, 0.34, 0.5)`；弱拍：`_sub(t, 41, 27, 0.24, 0.3)` |
| 3 | 太鼓 | `!breather`，`s ∈ {0,6,8,14}` | `_taiko(t, 0.52)` |
| 3b | 加密太鼓 | `inten ≥ 0.6`，`s ∈ {3,11}` | `_taiko(t, 0.32)` |
| 3c | 终期滚奏 | `inten ≥ 0.85` 且 `b === 3` 且 `s ∈ {12,13,15}` | `_taiko(t, 0.3)`（**只补 12/13/15**，14 由第 3 层提供，避免同点叠加爆音） |
| 4 | 颤音弦 | `s === 0` | `_tremString(t, midi(br+12), barLen, 0.045 + inten*0.03, 12 + inten*6, inten ≥ 0.7)` |
| 5 | 铜管 stab | `!breather`，`b ≠ 3` 且 `s ∈ {0,6,10}` | `_stab(t, midi(s === 10 ? 63 : 62), 0.18, 0.11 + inten*0.03, inten ≥ 0.75)` |
| 5b | 属音长音 | `!breather`，`b === 3` 且 `s === 0` | `_brass(t, midi(69), barLen*0.9, 0.1 + inten*0.03)`（A4，卡住不解决） |
| 6 | 踩镲 | `!breather` | `inten ≥ 0.55`：`s % 2 === 0` → 十六分 `_hat(0.055, 0.032, 9000)`；否则 `s % 4 === 2` → 八分 `_hat(0.06, 0.04, 8000)` |
| 7 | 坠落 + 钹 | `b % 2 === 0` 且 `s === 0` | `_subDrop(t)` + `_cymbal(t, 0.11, 0.4)` |
| 8 | 尖刺 | `inten ≥ 0.8` 且 `s === 13` | `_screech(t, 0.05)` |
| 9 | 留白低吼 | `breather` 且 `s === 14` | `_pad(t, midi(br), barLen, 0.07, 180)` |
| 9b | 蓄力下坠 | `breather` 且 `s === 15` 且 `inten ≥ 0.7` | `_sub(t, 62, 30, 0.45, 0.4)`（接上下一小节的砸击） |

其中 `br = BASS[b]`。

---

## 6. 强度（intensity）语义

`intensity` 是 0~1 的标量，决定"叠多少层"。**它不是音量**，只改变编排密度与音色亮度。

### 6.1 各曲目的分层阈值

| 阈值 | normal | laser | boss |
|---|---|---|---|
| ≥ 0.5 | — | 副脉冲 + 踩镲 | — |
| ≥ 0.55 | — | — | 踩镲升为十六分 |
| ≥ 0.6 | — | — | 加密太鼓 |
| ≥ 0.7 | — | 高八度琶音 | 弦乐叠小二度；留白段加蓄力 sub |
| ≥ 0.75 | — | — | 铜管叠小二度 |
| ≥ 0.8 | — | — | 不协和尖刺 |
| ≥ 0.85 | — | — | 取消留白 + 第 4 小节十六分太鼓滚奏 |

### 6.2 游戏内的赋值来源

| 场景 | 值 | 位置 |
|---|---|---|
| 机制关进关（生成期） | 0.2 | `game.js:256` |
| 第 9 关进入走格子 | 1.0 | `game.js:546` |
| 第 15 关进入安全解谜期 | 0.35 | `game.js:516` |
| Boss 关进关 | `BOSS_BGM.START_INTENSITY` = **0.45** | `game.js:256` |
| Boss 关每帧 | 0.45 → 1.0 自动升压 | `game.js:353` `_updateBossIntensity()` |
| 普通关 | 0 | `game.js:256` |

**Boss 升压公式**（`game.js:353-373`）：

```
_bossT += dt                                   // 战斗已进行秒数
dmg = 1 - boss.hp / boss.maxHp                 // 血量进度（见下）
prog = min(1, max(_bossT / TIME_TO_MAX, dmg))  // 时长与掉血取较大者
v    = min(MAX_INTENSITY, START_INTENSITY + prog * RISE_RANGE)
if |v - _bossInten| > 0.02: setIntensity(v)    // 超阈值才下发，避免每帧重复赋值
```

血量来源：脸谱 / 骑士 Boss 取 `waves.faceBoss || waves.boss` 的 `hp/maxHp`；
龙 Boss 取 `dragon.hpPool / dragon.maxHpPool`（总血量池）。

参数常量（`src/core/constants.js:179`）：

| 参数 | 值 | 含义 |
|---|---|---|
| `START_INTENSITY` | 0.45 | 进关起步强度（一进场就有 ostinato + 心跳） |
| `MAX_INTENSITY` | 1.0 | 上限 |
| `TIME_TO_MAX` | 75 s | 拿不到血量时，多久线性升满 |
| `RISE_RANGE` | 0.55 | 上升幅度：`START + prog × RISE_RANGE` |

---

## 7. 切轨与过渡

`setTrack(kind, variant)`：

- 未播放 → 直接写 `track` / `variant`。
- 播放中 → 写入 `pendingTrack` / `pendingVariant`，并调用 `_duck()`；
  在下一个小节边界（`_onBar()`）才真正切换，保证和声连贯。

`_duck()` 参数（`src/vr/audio.js:541`）：

```
cancelScheduledValues(now)
setValueAtTime(当前值, now)
linearRamp(0.02, now + 0.18)      // 0.18s 内压到近乎静音
linearRamp(0.18, now + 0.55)      // 再 0.37s 回到正常
```

`stopBGM()`：`0.25s` 线性淡出到 0.0001，400ms 后 `disconnect()`。

---

## 8. 游戏集成（调用点速查）

| 位置 | 调用 | 说明 |
|---|---|---|
| `game.js:253` | `setTrack(bgmKind, variant)` | `isLaser → 'laser'`；`isBoss → 'boss'`；否则 `'normal'`（mood 为 night 时变体取 `night`） |
| `game.js:256` | `setIntensity(...)` | 机制关 0.2 / Boss 0.45 / 其余 0 |
| `game.js:257-258` | `this._bossT = 0; this._bossInten = START` | Boss 升压状态复位 |
| `game.js:259` | `playBossSting()` | Boss 进场演出 |
| `game.js:414` | `_updateBossIntensity(dt)` | 在 `_updatePlaying` 首行调用 |
| `game.js:516` | `setIntensity(0.35)` | 第 15 关安全解谜期 |
| `game.js:546` | `setIntensity(1)` | 第 9 关走格子阶段 |

---

## 9. 试听与验证工具

`tools/bgm-preview/`（自包含，无需服务器，双击 `index.html` 即可）：

| 文件 | 用途 |
|---|---|
| `index.html` | 三张卡片独立播放/停止，含变体切换、强度预设、步进灯、Boss 进场按钮 |
| `sync.js` | 读取 `src/vr/audio.js` 原样内嵌生成 `index.html`（改音频后跑一次即同步） |
| `smoke.js` | DOM + Web Audio 桩回归测试 |

```bash
node tools/bgm-preview/sync.js     # 改完 audio.js 后重新生成试听页
node tools/bgm-preview/smoke.js    # 回归：三轨是否发声 + Boss 分层是否递增
```

`smoke.js` 的 Boss 分层测试直接驱动 `_playStep` 跑满 4 小节并统计音频节点，
当前基线（4 小节 64 步）：

| 强度 | 振荡器 + 噪声源节点数 |
|---|---|
| 0.45 | 189 |
| 0.60 | 221 |
| 0.80 | 262 |
| 1.00 | 269 |

> 该数字必须**单调递增**，否则说明强度分层失效（早期 Boss 强度恒为 0 时，四档数字完全相同）。

---

## 10. 复现清单（Checklist）

按序实现并逐项验证：

1. [ ] 建立总线：`master(0.5) → destination`，`bgmBus(0.18) → master`；音效直连 `master`。
2. [ ] 实现 `_midi()` 与白噪 buffer 生成。
3. [ ] 实现 lookahead 调度器（25ms 轮询 + 0.2s 预排 + 落后重对齐 + 小节边界回调）。
4. [ ] 按第 4 节实现 19 个 BGM 音色；**先单独试听每个音色**再进入编排。
5. [ ] 实现 `normal`：先黄昏（124 BPM），确认 4 小节循环无缝，再加黑夜变体（116 BPM + 夜垫）。
6. [ ] 实现 `laser`（104 BPM）：确认无军鼓、drone 连续、琶音每步发声。
7. [ ] 实现 `boss`（140 BPM）：**先固定 `intensity = 0.45`** 听基础层，再逐档拉到 1.0 验证分层。
8. [ ] 接线 `setTrack` 的小节边界切换与 `_duck()`。
9. [ ] 接线游戏侧：进关设曲目与起步强度、Boss 按血量/时长升压、机制关阶段切换。
10. [ ] 在目标硬件（PICO 头显）验证：**低频在小喇叭上是否可闻**（第 4.3 节的二次谐波不可省略）。

### 常见坑

| 现象 | 原因 |
|---|---|
| 音乐 4 秒后停 | 调度器做成了"一次性排 16 步"，未循环（见第 2 节） |
| 节奏抖动 | 用 `setTimeout` 发声而非绝对时间排程 |
| 休眠恢复后爆音 | 未做"落后重对齐"，一次性补发大量音符 |
| 换了关卡没变化 | 强度恒为 0，高压层从不触发（Boss 曾踩此坑） |
| **低频在小喇叭听不见** | 未叠二次谐波（见第 4.3 节） |
| 同一点音量翻倍爆音 | 多个分层条件在同一 `s` 上重复触发（如太鼓 s=14 的基础层与滚奏层） |
| `exponentialRamp` 报错 | 目标值为 0；指数斜坡的目标必须是正数（本项目统一用 0.001） |

---

## 11. 调参指南

| 想改什么 | 改哪里 |
|---|---|
| 整体 BGM 音量 | `startBGM()` 中 `bgmBus` 的目标 0.18 |
| 某曲速度 | `_bpm()`（124 / 116 / 104 / 140） |
| 某曲调性 / 和声 | `_stepNormal` 的 `CHORDS`/`BASS`、`_stepLaser` 的 `SEQ`、`_stepBoss` 的 `BASS` |
| 推进感强弱 | boss 的 `OST` 数组（改 0/7/12 的分布） |
| 心跳力度 | `_stepBoss` 第 2 层 `_sub(...)` 的最后一个 gain 参数（0.5 / 0.3） |
| 压迫感释放节奏 | `breather` 的 `s >= 14` 阈值（越早越长的留白） |
| Boss 升压快慢 | `constants.js` 的 `START_INTENSITY` / `TIME_TO_MAX` / `RISE_RANGE` |
| 切轨过渡时长 | `_duck()` 的 0.18 / 0.55 |
| 性能不够 | 调低 `setIntensity` 上限，关闭十六分层（boss 的 3c、6 层） |

---

## 12. 已知缺口

| 项 | 说明 |
|---|---|
| 激光关 0.5 档未接线 | 规格中 `inten ≥ 0.5` 的"驱赶期"层（副脉冲 + 踩镲）在代码里**没有对应赋值点**。当前 laser 强度实际只走 `0.2 → 0.35`（第 15 关解谜）或 `0.2 → 1.0`（第 9 关走格子），中间的 0.5 档从未触发。如需"驱赶期升压"，应在 `game.js` 激光驱赶阶段开始时补一次 `setIntensity(0.5)`。 |
| normal 无强度分层 | 设计如此，普通关不随强度变化，试听页该滑块对普通关无效。 |
| 无音量持久化 | 主音量固定 0.5，未做用户设置持久化。 |
