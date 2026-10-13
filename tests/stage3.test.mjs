import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TracerTail, MuzzleFlash } from '../src/game/fx.js';
import { DamageNumbers } from '../src/game/damageNumbers.js';
import { WarningBanner3D, midWarningDue } from '../src/game/warningBanner.js';
import { StreakCounter, barrelMount, modelBoxInParentSpace } from '../src/vr/streakCounter.js';
import { InputManager } from '../src/vr/input.js';
import { AudioManager } from '../src/vr/audio.js';
import { advanceStreak } from '../src/game/rapidFire.js';
import { faceCamera } from '../src/game/buddhaFx.js';
import { FX, DAMAGE_NUMBER, MID_WARNING, RAPID_FIRE, BUDDHA, SHOOT } from '../src/core/constants.js';

// 第四十二修 / 第四十三修：
//   ① 曳光「后拖不能越过枪管」（贴到出生点，太短则不画）
//   ② 枪口焰前移（不被枪管自身遮住）
//   ③ 伤害数字纹理上传节流（削掉如来神掌那一帧的 GPU 尖峰）
//   ④ 中场预警横幅（过半弹一次 + 2 秒淡入淡出）
//   ⑤ 连杀加速（10 连杀 → 射速 ×1.5 持续 3 秒）
//   ⑥ 枪管计数面板：自动标定 + 「值没变就不重绘」

const DT = 1 / 60;
const sceneOf = () => new THREE.Scene();
const vec = (x, y, z) => new THREE.Vector3(x, y, z);

function decomposeMatrix(mesh, i) {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(i, m);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  return { p, q, s };
}

// ---------- ① 曳光：后拖上限 ----------

test('曳光：后拖长度受 back 限制，最多只能拖到出生点（不再穿到枪管后方）', () => {
  const t = new TracerTail(sceneOf());
  const head = vec(0, 0, -10);
  const dir = vec(0, 0, -1);
  t.begin();
  assert.equal(t.add(head, dir, null, 0.30), true, '0.3m 的尾迹应当画出来');
  t.end();
  const { p, s } = decomposeMatrix(t.mesh, 0);
  assert.ok(Math.abs(s.y - 0.30) < 1e-6, '长轴 = back（而不是配置里的 LENGTH）');
  assert.ok(Math.abs(p.z - (-10 + 0.15)) < 1e-6, '中点 = 弹头后方 back/2');
});

test('曳光：后拖不足 MIN_BACK 时干脆不画（弹头刚出膛那几帧交给枪口焰）', () => {
  const t = new TracerTail(sceneOf());
  t.begin();
  assert.equal(t.add(vec(0, 0, -10), vec(0, 0, -1), null, 0.0), false, 'back=0 → 不画');
  assert.equal(t.add(vec(0, 0, -10), vec(0, 0, -1), null, FX.TRACER.MIN_BACK * 0.5), false, '不足 MIN_BACK → 不画');
  assert.equal(t.add(vec(0, 0, -10), vec(0, 0, -1), null, FX.TRACER.MIN_BACK * 1.5), true, '超过 MIN_BACK → 画');
  t.end();
  assert.equal(t.mesh.count, 1, '只应该写入一条');
});

test('曳光：不传 back 时行为与旧版一致（拖满 LENGTH，供敌方投射物使用）', () => {
  const t = new TracerTail(sceneOf());
  t.begin();
  assert.equal(t.add(vec(0, 0, -10), vec(0, 0, -1), null), true);
  t.end();
  const { p, s } = decomposeMatrix(t.mesh, 0);
  assert.ok(Math.abs(s.y - FX.TRACER.LENGTH) < 1e-6);
  assert.ok(Math.abs(p.z - (-10 + FX.TRACER.LENGTH * 0.5)) < 1e-6);
});

// ---------- ② 枪口焰前移 ----------

test('枪口焰：给了方向就沿枪口前移 FORWARD（出生点在枪管内部）', () => {
  const mf = new MuzzleFlash(sceneOf(), { ...FX.MUZZLE, FORWARD: 0.25 });
  mf.flash(vec(1, 2, 3), vec(0, 0, -2));   // 未归一化方向也要按单位长度前移
  const p = mf._slots[0].sp.position;
  assert.ok(Math.abs(p.x - 1) < 1e-6 && Math.abs(p.y - 2) < 1e-6, 'x/y 不动');
  assert.ok(Math.abs(p.z - (3 - 0.25)) < 1e-6, '沿 -Z 前移 0.25m');
});

test('枪口焰：不给方向时保持原行为（落在传入坐标）', () => {
  const mf = new MuzzleFlash(sceneOf(), { ...FX.MUZZLE, FORWARD: 0.25 });
  mf.flash(vec(1, 2, 3));
  assert.deepEqual(mf._slots[0].sp.position.toArray(), [1, 2, 3]);
});

// ---------- ③ 伤害数字上传节流 ----------

function dirtyCount(dn) { let n = 0; for (const e of dn._live) if (e._texDirty) n++; return n; }
function spawnMany(dn, n) {
  for (let i = 0; i < n; i++) dn.spawn(vec(i * 0.1, 1, -5), 100 * (i + 1), { key: {} });
}

test('伤害数字：同一帧的纹理上传数封顶在 UPLOAD_PER_FRAME，多出来的延后一帧', () => {
  const dn = new DamageNumbers(sceneOf());
  const budget = DAMAGE_NUMBER.UPLOAD_PER_FRAME;
  const total = budget + 4;
  spawnMany(dn, total);
  assert.ok(dn._uploads <= budget, '同帧上传数不得超过预算，实际 ' + dn._uploads);
  assert.equal(dirtyCount(dn), total - dn._uploads, '超预算的条目应处于「待上传」状态');
  dn.update(DT);                       // 下一帧：补传（又是一份预算）
  assert.equal(dirtyCount(dn), Math.max(0, total - budget * 2), '下一帧继续补传');
  assert.ok(dn.peakUploads <= budget, '单帧上传峰值同样受预算约束，实际 ' + dn.peakUploads);
});

test('伤害数字：贴图还没上传的条目必须隐形（池复用会带着上一轮的旧数字）', () => {
  const dn = new DamageNumbers(sceneOf());
  spawnMany(dn, DAMAGE_NUMBER.UPLOAD_PER_FRAME + 3);
  const last = dn._live[dn._live.length - 1];
  assert.equal(last._texDirty, true, '第 N 个（超预算）应当待上传');
  assert.equal(last.sprite.material.opacity, 0, '未上传 → 不许露');
  dn.update(DT);
  assert.equal(last._texDirty, false, '下一帧应已补传');
  dn.update(DT);
  assert.ok(last.sprite.material.opacity > 0, '上传完成后恢复可见');
});

test('伤害数字：预算内（常规命中）完全不受节流影响 —— 当帧就上传', () => {
  const dn = new DamageNumbers(sceneOf());
  dn.spawn(vec(0, 1, -5), 100, { key: {} });
  assert.equal(dn._live[0]._texDirty, false, '单个数字立即上传（不延迟）');
  assert.equal(dn._live[0].sprite.material.opacity, 1, '并且当帧可见');
});

// ---------- ④ 中场预警 ----------

test('中场预警判据：过半才弹、只弹一次、没有倒计时的关卡不弹', () => {
  assert.equal(MID_WARNING.AT, 0.5, '默认刚好过半触发');
  assert.equal(MID_WARNING.SECONDS, 2, '横幅 2 秒');
  assert.ok(MID_WARNING.TEXT && MID_WARNING.TEXT.length > 0, '要有默认文案');
  assert.equal(midWarningDue(19.99, 40, false), false, '还差一点：不弹');
  assert.equal(midWarningDue(20, 40, false), true, '刚好过半：弹');
  assert.equal(midWarningDue(21, 40, true), false, '已经弹过：不再弹（每关一次）');
  assert.equal(midWarningDue(1, 0, false), false, '没有倒计时（机制关/Boss 关）不弹');
});

test('中场预警横幅：show 后在准星前方淡入、到点自动隐藏', () => {
  const scene = sceneOf();
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(0, 1.6, 0);
  cam.lookAt(0, 1.6, -1);
  const b = new WarningBanner3D(scene, cam);
  assert.equal(b.sprite.visible, false, '未触发时不可见');
  b.show();
  assert.equal(b.sprite.visible, true);
  b.update(0.01);
  assert.ok(b.mat.opacity < 1, '刚开始要淡入而不是硬切');
  b.update(MID_WARNING.FADE_IN + 0.05);
  assert.ok(b.mat.opacity > 0.99, '淡入完成后完全不透明');
  assert.ok(Math.abs(b.sprite.position.z - (0 - MID_WARNING.DIST)) < 1e-6, '落在准星正前方');
  assert.ok(Math.abs(b.sprite.position.y - 1.6) < 1e-6, '与视线同高');
  b.update(MID_WARNING.SECONDS);
  assert.equal(b.sprite.visible, false, '到点必须自动隐藏（否则会一直挂在眼前）');
  assert.equal(b.mat.opacity, 0);
});

// ---------- ⑤ 连杀加速 ----------

test('连杀加速：配置合理（10 连杀 / ×1.5 / 3 秒 / 有断连超时）', () => {
  assert.equal(RAPID_FIRE.KILLS, 10);
  assert.ok(RAPID_FIRE.MULT > 1, '倍率必须 > 1 才是加速');
  assert.equal(RAPID_FIRE.SECONDS, 3);
  assert.ok(RAPID_FIRE.GAP >= RAPID_FIRE.SECONDS, '断连窗口不能比加速时间还短（否则永远凑不满）');
});

test('连杀加速：改写的是真实节流源 _gunCooldown，还原后回到基线', () => {
  const input = Object.create(InputManager.prototype);
  input.setFireRate(2);                       // 2 发/秒 → 冷却 500ms
  assert.equal(input._gunCooldown, 500);
  input.setFireRateMul(1 / RAPID_FIRE.MULT);  // 加速：冷却 ÷1.5
  assert.ok(Math.abs(input._gunCooldown - 500 / RAPID_FIRE.MULT) < 1e-9, '冷却应变短');
  input.setFireRateMul(1);                    // 到期还原
  assert.equal(input._gunCooldown, 500, '必须精确回到基线（不能漂移）');
});

test('连杀加速：奖励音 playRapidFire 真的产出音频节点，且没有非法包络', () => {
  const a = makeAudioStubManager();
  a.a.playRapidFire();
  assert.ok(a.oscs.length >= 4, '至少三连叮 + 一条扫频，实际 ' + a.oscs.length);
  assert.equal(a.noises.length, 1, '还有一记收尾气流');
  assert.ok(a.filters.some((f) => f.type === 'lowpass'), '扫频走低通，不能是刺耳裸锯齿');
  assert.ok(a.oscs.every((o) => o.type !== 'square'), '全程不用方波（与击杀 thump 区分开）');
});

// ---------- ⑥ 枪管连杀计数 ----------

test('枪身挂点：取最长轴当枪管轴，ALONG 0.5 = 正中、1 = 枪口端', () => {
  const box = new THREE.Box3(vec(-0.05, -0.05, -0.5), vec(0.05, 0.05, 0.5));  // 长条沿 Z
  const mid = barrelMount(box, { ALONG: 0.5 });
  assert.ok(mid, '长条应当算出挂点');
  assert.ok(Math.abs(mid.position.x) < 1e-6 && Math.abs(mid.position.y) < 1e-6);
  assert.ok(Math.abs(mid.position.z) < 1e-6, 'ALONG=0.5 → 正好在枪身正中');
  assert.ok(mid.axis.z < 0, '枪口在 -Z（手柄前方）');
  assert.ok(Math.abs(mid.axis.length() - 1) < 1e-6, '轴必须是单位向量');
  assert.ok(Math.abs(mid.length - 1) < 1e-6, '轴长 = 包围盒最长边');
  assert.ok(Math.abs(mid.radius - 0.05) < 1e-6, '横截面最大半宽 = 0.05');
  assert.ok(mid.ringRadius > mid.radius, '环半径必须大于枪身半径（红点要包在枪身外面）');
  const muzzle = barrelMount(box, { ALONG: 1 });
  assert.ok(Math.abs(muzzle.position.z - (-0.5)) < 1e-6, 'ALONG=1 → 落在枪口端');
  assert.equal(barrelMount(new THREE.Box3(), {}), null, '空盒 → 不算（走兜底位）');
});

test('枪管挂点：从真实模型（Group + 长条 Mesh）能量出包围盒', () => {
  const model = new THREE.Group();
  model.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 1.0)));
  const box = modelBoxInParentSpace(model);
  assert.ok(!box.isEmpty(), '必须量到东西');
  assert.ok(Math.abs(box.max.z - 0.5) < 1e-6, '长边沿 ±Z 各 0.5');
  const m = barrelMount(box, { ALONG: 0.7, RING_FRAC: 1.5, DOT_FRAC: 0.3 });
  assert.ok(Math.abs(m.position.z - (-0.5 * 0.4)) < 1e-6, 'ALONG 0.7 → 从中点再往枪口走 20%');
  assert.ok(Math.abs(m.ringRadius - m.radius * 1.5) < 1e-6, 'RING_FRAC 生效');
  assert.ok(Math.abs(m.dotSize - m.ringRadius * 0.3) < 1e-6, 'DOT_FRAC 生效');
});

// ---------- ④ 枪身红点环 + 加速雾气（第四十三修）----------

const streakGame = (streak, until, now) => ({ _bulletStreak: streak, _rapidUntil: until, _gameTime: now });
function dotSizes(sc) {
  const out = [];
  for (let i = 0; i < sc.dots.count; i++) out.push(decomposeMatrix(sc.dots, i).s.x);
  return out;
}

test('红点环：模型加载不出来时退回固定枪管位（不崩、不悬空）', () => {
  const sc = new StreakCounter();
  const mount = sc.place(null);
  assert.equal(sc._placed, true);
  assert.ok(mount.position.z < 0, '枪管方向 = root 的 -Z');
  assert.ok(mount.ringRadius > 0 && mount.dotSize > 0, '环半径与点径都要有兜底值');
});

test('红点环：没连杀也没加速 → 整体不显示（零 draw call）', () => {
  const sc = new StreakCounter();
  sc.place(null);
  sc.update(DT, streakGame(0, 0, 10));
  assert.equal(sc.dots.visible, false);
  assert.equal(sc.mist.visible, false);
});

test('红点环：杀一个亮一个，集齐那一帧整圈闪一下再消失，加速期间新攒的点是金色', () => {
  const sc = new StreakCounter();
  sc.place(null);
  const need = sc.dots.count;
  assert.equal(need, RAPID_FIRE.KILLS, '默认点数 = 触发连杀数');

  sc.update(DT, streakGame(3, 0, 10));
  assert.equal(sc.dots.visible, true);
  assert.equal(sc._fill, 3);
  assert.equal(dotSizes(sc).filter((s) => s > 0).length, 3, '亮 3 个点，其余点尺寸为 0');

  // 新一次加速开始（= 红点集齐的那一刻，计数已被清零）→ 整圈闪一下
  sc.update(DT, streakGame(0, 12, 10.5));
  assert.equal(sc.dots.visible, true, '集齐要整圈闪一下');
  assert.equal(dotSizes(sc).filter((s) => s > 0).length, need, '闪光时整圈都亮');

  // 闪完自动隐藏（闪光是按 dt 计时的，不是按 gameTime）
  for (let i = 0; i < Math.ceil((RAPID_FIRE.COUNTER.FLASH_TIME || 0.28) / DT) + 3; i++) {
    sc.update(DT, streakGame(0, 12, 12.5));
  }
  assert.equal(sc.dots.visible, false, '闪完必须自己收掉（否则一直挂在枪上）');

  // 加速期间新攒的点用金色（与「未集齐的红」区分）
  sc.update(DT, streakGame(2, 12, 11));
  const c = new THREE.Color();
  sc.dots.getColorAt(0, c);
  assert.equal(c.getHex(), RAPID_FIRE.COUNTER.COLOR_BOOST);
});

test('加速雾气：只在加速期间出现，加速一结束就收干净', () => {
  const sc = new StreakCounter();
  sc.place(null);
  sc.update(DT, streakGame(0, 12, 10));
  assert.equal(sc.mist.visible, true, '加速期间要有雾');
  for (let i = 0; i < 12; i++) sc.update(DT, streakGame(0, 12, 10 + i * DT));
  const alive = sc._puffs.filter((p) => p.t < RAPID_FIRE.MIST.LIFE).length;
  assert.ok(alive >= 1, '0.2s 内至少出一团雾');
  assert.ok(alive <= sc._puffs.length, '雾团数受池上限约束');

  sc.update(DT, streakGame(0, 12, 13.5));    // now > until → 加速已结束
  assert.equal(sc.mist.visible, false);
  assert.ok(sc._puffs.every((p) => !(p.t < RAPID_FIRE.MIST.LIFE)), '结束时把雾团全部作废');
});

test('连杀规则：加速期间最多再攒 BOOST_CARRY_MAX 个（不会无限续杯）', () => {
  let streak = 0;
  for (let i = 0; i < RAPID_FIRE.KILLS; i++) {
    const r = advanceStreak(streak, false, RAPID_FIRE);
    streak = r.next;
    assert.equal(r.triggered, i === RAPID_FIRE.KILLS - 1, '只有第 KILLS 个才触发');
  }
  assert.equal(streak, 0, '触发后从 0 重新攒');

  let boosted = 0;
  let secondTrigger = 0;
  for (let i = 0; i < 30; i++) {
    const r = advanceStreak(boosted, true, RAPID_FIRE);
    boosted = r.next;
    if (r.triggered) secondTrigger++;
  }
  assert.equal(secondTrigger, 0, '加速期间绝不允许二次触发（否则可以无限续杯）');
  assert.equal(boosted, RAPID_FIRE.BOOST_CARRY_MAX, '加速期间封顶在 BOOST_CARRY_MAX');

  let trig = 0;
  let s2 = boosted;
  for (let i = 0; i < 20 && !trig; i++) { const r = advanceStreak(s2, false, RAPID_FIRE); s2 = r.next; if (r.triggered) trig++; }
  assert.equal(trig, 1, '加速结束后把剩下的一半攒够，仍然会触发');
});

// ---------- ⑤ 如来神掌越过玩家不翻面 + 左手射线隐去（第四十三修）----------

test('如来神掌：越过玩家后冻结朝向（不再翻 180 度）', () => {
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(0, 0, 0);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));

  mesh.position.set(0, 0, -30);              // 起点：玩家正前方
  faceCamera(mesh, cam);
  const q0 = mesh.quaternion.clone();

  mesh.position.set(0, 0, -8);               // 还在玩家前方 → 仍朝相机
  faceCamera(mesh, cam);
  assert.ok(mesh.quaternion.angleTo(q0) < 1e-6, '没越过玩家时保持朝相机');

  mesh.position.set(0, 0, 8);                // 越过玩家到了 +Z 侧
  faceCamera(mesh, cam);
  assert.ok(mesh.quaternion.angleTo(q0) < 1e-6, '越过玩家后必须冻结在越过前的朝向');

  // 反证：关掉开关就恢复「每帧朝相机」的翻面行为（说明这条测试确实在测东西）
  const keep = BUDDHA.LATCH_FACING;
  BUDDHA.LATCH_FACING = false;
  faceCamera(mesh, cam);
  assert.ok(mesh.quaternion.angleTo(q0) > Math.PI * 0.99, '关掉开关会翻 180 度');
  BUDDHA.LATCH_FACING = keep;
});

test('左手射线：默认整条不画，只有主手那条可见', () => {
  const inp = Object.create(InputManager.prototype);
  inp.settings = { dominantHand: 'right' };   // shootingHand 是 getter，只能从 settings 设
  const mkRay = () => ({ material: { color: { setHex() {} } }, rotation: new THREE.Euler(), visible: false });
  const right = mkRay();
  const left = mkRay();
  inp._applyRayAim({ userData: { hand: 'right', rayLine: right } });
  inp._applyRayAim({ userData: { hand: 'left', rayLine: left } });
  assert.equal(SHOOT.OFFHAND_RAY, false, '现场定稿：非射击手不画');
  assert.equal(right.visible, true, '主手（瞄准基准）必须留');
  assert.equal(left.visible, false, '左手那条光要去掉');
  assert.equal(right.material.color, right.material.color);   // 只是确保没抛异常（颜色走 setHex）
});

// ---------- 音频桩（与 hit-feedback.test.mjs 同款最小实现）----------

function makeAudioStubManager() {
  const oscs = [], noises = [], filters = [];
  const param = (v = 0) => ({
    value: v,
    setValueAtTime(n) { this.value = n; return this; },
    linearRampToValueAtTime(n) { this.value = n; return this; },
    exponentialRampToValueAtTime(n) {
      if (n === 0) throw new Error('exponentialRamp 目标为 0（非法）');
      this.value = n; return this;
    },
    cancelScheduledValues() { return this; },
  });
  const chain = { connect(n) { return n; }, disconnect() {}, start() {}, stop() {} };
  const ctx = {
    currentTime: 1,
    sampleRate: 48000,
    state: 'running',
    createGain: () => ({ gain: param(1), ...chain }),
    createOscillator: () => { const o = { type: 'sine', frequency: param(440), ...chain }; oscs.push(o); return o; },
    createBiquadFilter: () => { const f = { type: '', frequency: param(0), Q: { value: 0 }, ...chain }; filters.push(f); return f; },
    createBufferSource: () => { const b = { buffer: null, ...chain }; noises.push(b); return b; },
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
  };
  const a = Object.create(AudioManager.prototype);
  a.ctx = ctx;
  a.master = { connect() {}, disconnect() {} };
  return { a, oscs, noises, filters };
}