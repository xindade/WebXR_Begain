// 第六十一修 · 内圈报警（dangerAlarm）+ 横幅折行（wrapBannerText）
//
// 为什么值得锁死：
//   ① 分区手性（左右别搞反）在单测里最容易验 —— 现场只能靠「听左还是听右」，一旦反了很难描述；
//   ② 「每区只响最近的一只 / 同拍只响一声 / 方位轮转」是现场「别到处都是滴滴滴」的核心判据，
//      退化成每怪一声就直接变成噪音，而这类回归肉眼看不出来（画面上完全正常）；
//   ③ 折行是纯几何：给个量宽桩就能断言「折几行、每行多宽、字号降到多少」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { sectorOf, DangerAlarm, SECTOR_NAMES } from '../src/game/dangerAlarm.js';
import { wrapBannerText } from '../src/game/warningBanner.js';
import { DANGER_ALARM, BOMB_LABEL, MID_WARNING, SKILL_HINT } from '../src/core/constants.js';

// ---------- ① 扇区划分（手性）----------

// 官方前向约定：调用方传的是**玩家真实面朝方向**（相机 getWorldDirection 已取反）。
const FACE_NEG_Z = { fx: 0, fz: -1 };   // 面朝 -Z：此时 +X 在玩家的**右手边**
const FACE_POS_Z = { fx: 0, fz: 1 };    // 面朝 +Z：+X 反过来在**左手边**
const FACE_POS_X = { fx: 1, fz: 0 };    // 面朝 +X：+Z 在右手边

test('扇区：面朝 -Z 时前/右/后/左各归原位（+X 是右手边）', () => {
  const { fx, fz } = FACE_NEG_Z;
  assert.equal(sectorOf(0, -5, fx, fz), 0, '正前方');
  assert.equal(sectorOf(5, 0, fx, fz), 1, '右手边（+X）');
  assert.equal(sectorOf(0, 5, fx, fz), 2, '正后方');
  assert.equal(sectorOf(-5, 0, fx, fz), 3, '左手边（-X）');
});

test('扇区：换朝向左右跟着换（别把世界轴当玩家左右）', () => {
  const a = FACE_POS_Z;
  assert.equal(sectorOf(0, 5, a.fx, a.fz), 0, '面朝 +Z：+Z 是前');
  assert.equal(sectorOf(5, 0, a.fx, a.fz), 3, '面朝 +Z：+X 变成左手边');
  assert.equal(sectorOf(-5, 0, a.fx, a.fz), 1, '面朝 +Z：-X 变成右手边');
  assert.equal(sectorOf(0, -5, a.fx, a.fz), 2, '面朝 +Z：-Z 是背后');

  const b = FACE_POS_X;
  assert.equal(sectorOf(5, 0, b.fx, b.fz), 0, '面朝 +X：+X 是前');
  assert.equal(sectorOf(0, 1, b.fx, b.fz), 1, '面朝 +X：+Z 是右手边');
  assert.equal(sectorOf(0, -1, b.fx, b.fz), 3, '面朝 +X：-Z 是左手边');
});

test('扇区：斜前方的边界按 WEDGE_DEG 落在正前那一片', () => {
  // 面朝 -Z：正前方偏右 40° 仍在「前」（半角 45°），偏 50° 就归到右手边
  const { fx, fz } = FACE_NEG_Z;
  const at = (deg) => {
    const r = (deg * Math.PI) / 180;
    // 从 -Z 朝 +X 方向偏转 deg（右手边为正）
    return sectorOf(Math.sin(r) * 10, -Math.cos(r) * 10, fx, fz, 45);
  };
  assert.equal(at(0), 0);
  assert.equal(at(40), 0, '40° 仍在正前扇区');
  assert.equal(at(50), 1, '50° 归右手边');
  // 四个 90° 扇区以正前为中心展开：前 ±45°、右 (45,135]、后 (135,225]、左 (225,315]
  assert.equal(at(130), 1, '130° 还在右手边');
  assert.equal(at(140), 2, '140° 才归正后');
  assert.equal(at(230), 3, '230° 归左手边');
});

test('扇区：退化输入返回 -1（零向量 / 目标与玩家重合）', () => {
  assert.equal(sectorOf(0, 0, 0, -1), -1, '目标与玩家重合');
  assert.equal(sectorOf(1, 0, 0, 0), -1, '前向为零向量');
});

// ---------- ② 报警调度：每区取最近 / 同拍一声 / 方位轮转 ----------

const PLAYER = { x: 0, z: 0, fx: 0, fz: -1, inner: BOMB_LABEL.INNER_RADIUS };

test('报警：到 INTERVAL 才响（不会每帧滴一声）', () => {
  const a = new DangerAlarm(DANGER_ALARM);
  const list = [{ x: 0, z: -5 }];                 // 正前方一只
  assert.equal(a.update(0.5, PLAYER, list, 0), null, '没到节拍');
  assert.equal(a.update(0.5, PLAYER, list, 0.5), null, '累计 1.0s 仍没到 2s');
  const hit = a.update(1.1, PLAYER, list, 1.1);
  assert.ok(hit, '累计超过 INTERVAL 必须响');
  assert.equal(hit.name, 'front');
});

test('报警：同一个扇区只让**最靠近玩家**的那一只发声', () => {
  const a = new DangerAlarm(DANGER_ALARM);
  const list = [
    { x: 0, z: -8.6 },     // 正前，远
    { x: 0, z: -3.0 },     // 正前，近 ← 应选它
    { x: 0, z: -7.2 },     // 正前，中
  ];
  const hit = a.update(DANGER_ALARM.INTERVAL, PLAYER, list, 0);
  assert.ok(hit);
  assert.equal(hit.index, 1, '选中的是最近的（list[1]）');
  assert.ok(Math.abs(hit.dist - 3.0) < 1e-6);
});

test('报警：一帧最多一声，且四个方向轮流来（不会 4 声叠成一片）', () => {
  const a = new DangerAlarm(DANGER_ALARM);
  const list = [
    { x: 0, z: -5 },   // 前
    { x: 5, z: 0 },    // 右
    { x: 0, z: 5 },    // 后
    { x: -5, z: 0 },   // 左
  ];
  const seq = [];
  for (let i = 0; i < 4; i++) {
    const hit = a.update(DANGER_ALARM.INTERVAL, PLAYER, list, i * DANGER_ALARM.INTERVAL);
    assert.ok(hit, `第 ${i + 1} 个节拍要响`);
    seq.push(hit.sector);
  }
  assert.equal(new Set(seq).size, 4, '四个方向各响过一次（轮转，不偏袒某一侧）');
  // 同一拍再调一次也不会多响（节拍器刚被清零）
  assert.equal(a.update(0, PLAYER, list, 99), null, '同一拍里不能连响');
});

test('报警：某方向新出现怪时，它会立刻被照顾到（轮转看的是「最久没响」）', () => {
  const a = new DangerAlarm(DANGER_ALARM);
  const front = [{ x: 0, z: -5 }];
  const first = a.update(DANGER_ALARM.INTERVAL, PLAYER, front, 0);
  assert.equal(first.sector, 0);
  // 右侧来了一只新怪（右区从没响过 → -Infinity 最久），必须优先它
  const both = [{ x: 0, z: -5 }, { x: 5, z: 0 }];
  const next = a.update(DANGER_ALARM.INTERVAL, PLAYER, both, DANGER_ALARM.INTERVAL);
  assert.equal(next.sector, 1, '新方向优先（否则刚出现的威胁会被一直忽略）');
});

test('报警：按扇区给左右声像、越近音高越高', () => {
  const cfg = DANGER_ALARM;
  const a = new DangerAlarm(cfg);
  const right = a.update(cfg.INTERVAL, PLAYER, [{ x: 5, z: -0.1 }], 0);
  assert.equal(right.name, 'right');
  assert.ok(Math.abs(right.pan - cfg.SECTOR_PAN.right * cfg.PAN) < 1e-9, '右手边 → 声像偏右');

  const b = new DangerAlarm(cfg);
  const far = b.update(cfg.INTERVAL, PLAYER, [{ x: 0, z: -8 }], 0);
  const c = new DangerAlarm(cfg);
  const near = c.update(cfg.INTERVAL, PLAYER, [{ x: 0, z: -1 }], 0);
  assert.ok(near.freq > far.freq, '越近越尖（不用看也知道怪贴脸了）');
  assert.ok(far.freq >= cfg.FREQ, '最远也就回到基频');
});

test('报警：开关关掉 / 没有候选 / 没有玩家 → 一律不响（不软锁也不报错）', () => {
  const off = new DangerAlarm({ ...DANGER_ALARM, ENABLED: false });
  assert.equal(off.update(10, PLAYER, [{ x: 0, z: -5 }], 0), null);

  const a = new DangerAlarm(DANGER_ALARM);
  assert.equal(a.update(10, PLAYER, [], 0), null, '没有进圈的怪');
  assert.equal(a.update(10, null, [{ x: 0, z: -5 }], 0), null, '没有玩家位置');
  assert.equal(a.update(10, PLAYER, null, 0), null, '没给列表');
});

test('报警：reset 后节拍与轮转记账清零（切关不能带着上一关的账）', () => {
  const a = new DangerAlarm(DANGER_ALARM);
  a.update(DANGER_ALARM.INTERVAL, PLAYER, [{ x: 0, z: -5 }], 0);
  a.reset();
  assert.equal(a.update(0.1, PLAYER, [{ x: 0, z: -5 }], 0), null, 'reset 后要重新攒满一个节拍');
});

test('报警：危险圈半径与头顶「爆」字同源（调用方可覆盖，缺省才回落常量）', () => {
  const a = new DangerAlarm(DANGER_ALARM);
  const list = [{ x: 0, z: -5 }];
  const tight = a.update(DANGER_ALARM.INTERVAL, { ...PLAYER, inner: 2 }, list, 0);
  const loose = (() => {
    const b = new DangerAlarm(DANGER_ALARM);
    return b.update(DANGER_ALARM.INTERVAL, { ...PLAYER, inner: 9 }, list, 0);
  })();
  assert.ok(loose.freq > tight.freq, '圈越小 = 同一只怪越「贴脸」 = 音高越高');
});

test('报警：默认开启，且节拍/分区/音量都在合理区间（现场嫌吵就调这几个）', () => {
  assert.equal(DANGER_ALARM.ENABLED, true);
  assert.ok(DANGER_ALARM.INTERVAL >= 1 && DANGER_ALARM.INTERVAL <= 5, '节拍太密会烦、太疏会漏');
  assert.equal(DANGER_ALARM.WEDGE_DEG, 45, '四个 90° 扇区：前 ±45°');
  assert.ok(DANGER_ALARM.GAIN > 0 && DANGER_ALARM.GAIN <= 0.4, '报警是提醒不是主音，别盖过枪声');
  assert.equal(DANGER_ALARM.SECTOR_PAN.front, 0, '前方居中');
  assert.equal(DANGER_ALARM.SECTOR_PAN.left, -DANGER_ALARM.SECTOR_PAN.right, '左右声像必须对称');
  assert.deepEqual(SECTOR_NAMES, ['front', 'right', 'back', 'left'], '扇区编号与 SECTOR_PAN 的键一一对应');
});

// ---------- ③ 横幅折行 ----------

// 量宽桩：宽度 = 字符数 × 字号 × ratio（跟着 font 变，这样「降字号」才有意义）
function stubCtx(ratio = 0.5) {
  const c = {
    font: 'bold 88px sans-serif',
    measureText(s) {
      const m = /bold (\d+)px/.exec(c.font);
      const size = m ? Number(m[1]) : 88;
      return { width: String(s).length * size * ratio };
    },
  };
  return c;
}

test('折行：放得下就一行，字号不动', () => {
  const c = stubCtx();
  const r = wrapBannerText(c, '前方精英来袭', { maxW: 700, size: 88 });
  assert.deepEqual(r.lines, ['前方精英来袭']);
  assert.equal(r.size, 88, '短文案不许被改字号');
});

test('折行：太长就折两行，两行宽度尽量接近（别一行挤爆一行空着）', () => {
  const c = stubCtx();
  // 20 字 × 88px × 0.5 = 880px，maxW 400 → 88px 折不动（每行最多 9 字），降一档到 80px：
  // 每字 40px，正好 10 + 10
  const text = '一二三四五六七八九十一二三四五六七八九十';
  const r = wrapBannerText(c, text, { maxW: 400, size: 88 });
  assert.equal(r.lines.length, 2, '必须折成两行');
  assert.equal(r.lines.join(''), text, '折行不许丢字（拼接回来必须等于原文）');
  assert.equal(r.lines[0].length, r.lines[1].length, '两行长度接近');
  assert.ok(r.size < 88, '两行仍放不下 → 降字号');
  c.font = 'bold ' + r.size + 'px sans-serif';
  for (const l of r.lines) assert.ok(c.measureText(l).width <= 400, '每行都不能超出可用宽度');
});

test('折行：maxLines = 1 时只降字号不折行（关卡标题卡那种一行式）', () => {
  const c = stubCtx();
  const text = '一二三四五六七八九十';               // 10 字
  const r = wrapBannerText(c, text, { maxW: 400, size: 88, maxLines: 1 });
  assert.deepEqual(r.lines, [text]);
  assert.ok(r.size < 88, '放不下就降字号');
  c.font = 'bold ' + r.size + 'px sans-serif';
  assert.ok(c.measureText(text).width <= 400, '降字号后必须放得下');
});

test('折行：极端长文案不会死循环、也不会把字号缩到看不见', () => {
  const c = stubCtx();
  const text = '一二三四五六七八九十'.repeat(20);     // 200 字，怎么折都放不下
  const r = wrapBannerText(c, text, { maxW: 200, minSize: 44 });
  assert.ok(r.size >= 44, '字号有下限');
  // 退化契约：200 字塞进 2 行本就无解（maxW 200 / 每字 22px → 每行最多 9 字），
  // 所以这里**允许行数超标**，但绝不许超宽、不许丢字、不许死循环缩字号 —— 外层降字号继续兜底。
  // 真实调用方的量级远没这么大（教学板最长 19 字 / 横幅最长 20 字，见上面两个用例）。
  c.font = 'bold ' + r.size + 'px sans-serif';
  assert.ok(r.lines.every((l) => c.measureText(l).width <= 200), '退化时也不许超宽');
  assert.equal(r.lines.join(''), text, '仍然不丢字');
});

// ---------- ④ 技能框的标签/数值分色（第六十一修）----------

test('技能框：标签与数值分色 + 中文冒号（现场「直接跟数字、同色分不清」）', () => {
  assert.equal(SKILL_HINT.COLON, '：');
  const cols = [SKILL_HINT.LABEL_TEXT, SKILL_HINT.VALUE_ATK, SKILL_HINT.VALUE_SHOT, SKILL_HINT.VALUE_RATE];
  for (const col of cols) assert.ok(/^#[0-9a-f]{6}$/i.test(String(col)), '每个色值都要是合法十六进制');
  assert.equal(new Set(cols).size, cols.length, '标签与三个数值必须各自不同色');
  assert.ok(SKILL_HINT.MOUNT && SKILL_HINT.MOUNT.ENABLED !== false, '默认按枪模型自动定位');
  assert.equal(MID_WARNING.SECONDS, 4, '第六十三修：横幅 2 → 4 秒（现场来不及看清）');
});