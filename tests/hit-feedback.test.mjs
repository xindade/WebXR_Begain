import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DamageNumbers, damageTierIndex, damageColorOf } from '../src/game/damageNumbers.js';
import { AudioManager } from '../src/vr/audio.js';
import { InputManager } from '../src/vr/input.js';
import { DAMAGE_NUMBER, HIT_FEEDBACK } from '../src/core/constants.js';

// 第四十修 · 打击感（档1）+ 伤害数字。
//   本文件只测纯逻辑与状态机，不涉及真实渲染/音频输出：
//     ① 伤害数字的颜色分档（每满 100 加深一档）
//     ② 伤害数字的对象池 / 合并窗口 / 回收
//     ③ 击杀音色按敌种分派（用假 AudioContext 记录实际建了哪些振荡器）
//     ④ 手柄震动的节流与左右手路由

const DT = 1 / 60;

function balloonAt(x, y, z) {
  return { mesh: { position: new THREE.Vector3(x, y, z) }, effectiveRadius: 0.5, _lastDamage: 100 };
}

// ---------- ① 颜色分档 ----------

test('伤害数字：每满 100 伤害颜色加深一档，超出档位封顶在深红', () => {
  assert.equal(damageTierIndex(0), 0, '0 伤害 = 第 0 档');
  assert.equal(damageTierIndex(99), 0, '不足 100 还留在第 0 档');
  assert.equal(damageTierIndex(100), 1, '满 100 进第 1 档');
  assert.equal(damageTierIndex(199), 1);
  assert.equal(damageTierIndex(200), 2, '满 200 进第 2 档');
  assert.equal(damageTierIndex(500), 5);
  assert.equal(damageTierIndex(100000), DAMAGE_NUMBER.COLORS.length - 1, '再高也封顶在最后一档');
  assert.equal(damageColorOf(100), DAMAGE_NUMBER.COLORS[1]);
  assert.equal(damageColorOf(9999), DAMAGE_NUMBER.COLORS[DAMAGE_NUMBER.COLORS.length - 1]);
});

test('伤害数字：档位越高越偏红（红色占比单调递增，最后一档是深红）', () => {
  // 注意判据不是「红通道变大」：最后一档是**更暗**的深红(0xd41010)，红通道反而回落；
  // 真正单调的是「红色在 RGB 中的占比」。
  const redness = (hex) => {
    const r = (hex >> 16) & 0xff, g = (hex >> 8) & 0xff, b = hex & 0xff;
    return r / (r + g + b);
  };
  for (let i = 1; i < DAMAGE_NUMBER.COLORS.length; i++) {
    assert.ok(redness(DAMAGE_NUMBER.COLORS[i]) > redness(DAMAGE_NUMBER.COLORS[i - 1]),
      '第 ' + i + ' 档应比第 ' + (i - 1) + ' 档更偏红');
  }
  assert.ok(redness(DAMAGE_NUMBER.COLORS[0]) < 0.4, '第 0 档是中性白');
  assert.ok(redness(DAMAGE_NUMBER.COLORS[DAMAGE_NUMBER.COLORS.length - 1]) > 0.8, '最后一档是深红');
});

// ---------- ② 对象池 / 合并 ----------

test('伤害数字：同一只怪在合并窗口内的多次命中累加成同一个数字', () => {
  const dn = new DamageNumbers(new THREE.Scene());
  const key = {};
  const p = new THREE.Vector3(0, 1, -5);
  const a = dn.spawn(p, 100, { key });
  const b = dn.spawn(p, 100, { key });
  assert.equal(a, b, '窗口内复用同一个条目（不新建 Sprite）');
  assert.equal(a.value, 200, '两次 100 合并成 200');
  assert.equal(dn.peak, 1, '并发始终只有 1 个数字');
  assert.equal(a.tier ?? damageTierIndex(a.value), damageTierIndex(200), '颜色档位跟随合并后的数值');
});

test('伤害数字：合并窗口过后另起一个数字，不再累加', () => {
  const dn = new DamageNumbers(new THREE.Scene());
  const key = {};
  const p = new THREE.Vector3(0, 1, -5);
  const a = dn.spawn(p, 100, { key });
  for (let i = 0; i < Math.ceil(DAMAGE_NUMBER.AGGREGATE_WINDOW / DT) + 2; i++) dn.update(DT);
  const c = dn.spawn(p, 100, { key });
  assert.equal(c.value, 100, '窗口已过 → 从本次伤害重新起算，而不是继续累加');
  assert.notEqual(c.value, a.value + 100);
});

test('伤害数字：并发数封顶在 POOL，超出时回收最旧的（绝不无限新建）', () => {
  const dn = new DamageNumbers(new THREE.Scene());
  const p = new THREE.Vector3();
  for (let i = 0; i < DAMAGE_NUMBER.POOL + 15; i++) dn.spawn(p, 100 * (i + 1), { key: {} });
  assert.equal(dn._live.length, DAMAGE_NUMBER.POOL, '在播数量不超过 POOL');
  assert.ok(dn.peak <= DAMAGE_NUMBER.POOL, '峰值并发不超过 POOL');
  assert.ok(dn._pool.length <= DAMAGE_NUMBER.POOL, '创建的条目总数不超过 POOL');
});

test('伤害数字：到期回池隐藏，clear() 清空全部并断开合并表', () => {
  const dn = new DamageNumbers(new THREE.Scene());
  const e = dn.spawn(new THREE.Vector3(), 100, { key: {} });
  assert.equal(e.sprite.visible, true);
  for (let i = 0; i < Math.ceil(DAMAGE_NUMBER.LIFE / DT) + 5; i++) dn.update(DT);
  assert.equal(dn._live.length, 0, '存活期满后自动回收');
  assert.equal(e.sprite.visible, false, '回池后隐藏，不再渲染');
  dn.spawn(new THREE.Vector3(), 100, { key: {} });
  dn.clear();
  assert.equal(dn._live.length, 0);
  assert.equal(dn._agg.size, 0, 'clear 后合并表也要清空，避免残留引用');
});

// ---------- ③ 击杀音色 ----------

function makeAudioStub() {
  const oscs = [];
  const noises = [];
  const filters = [];
  const param = () => ({
    value: 0,
    setValueAtTime(v) { this.value = v; return this; },   // 记录起始值：连击升调靠它断言
    exponentialRampToValueAtTime() { return this; },
    linearRampToValueAtTime() { return this; },
  });
  const chain = { connect: (n) => n, disconnect() {} };
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    createGain: () => ({ gain: param(), ...chain }),
    createOscillator() {
      const o = { type: '', frequency: param(), ...chain, start() {}, stop() {} };
      oscs.push(o);
      return o;
    },
    createBufferSource() {
      const b = { buffer: null, ...chain, start() {}, stop() {} };
      noises.push(b);
      return b;
    },
    createBiquadFilter() {
      const f = { type: '', frequency: param(), Q: { value: 0 }, ...chain };
      filters.push(f);
      return f;
    },
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
  };
  return { ctx, oscs, noises, filters };
}

function makeAudioStubManager() {
  const a = Object.create(AudioManager.prototype);
  const stub = makeAudioStub();
  a.ctx = stub.ctx;
  a.master = { connect() {}, disconnect() {} };
  return { a, ...stub };
}

test('击杀音色：幽灵=空灵正弦、章鱼=低通噪声、盾兵=金属方波、基础怪=方波扫频', () => {
  const ghost = makeAudioStubManager();
  ghost.a.playKill('ghost', 1);
  assert.equal(ghost.oscs.length, 2, '幽灵是双正弦');
  assert.ok(ghost.oscs.every((o) => o.type === 'sine'), '幽灵用正弦（空灵）');
  assert.equal(ghost.noises.length, 0);

  const octo = makeAudioStubManager();
  octo.a.playKill('octopus', 1);
  assert.equal(octo.noises.length, 1, '章鱼用噪声源（湿润）');
  assert.ok(octo.filters.some((f) => f.type === 'lowpass'), '章鱼噪声走低通');

  const shield = makeAudioStubManager();
  shield.a.playKill('shield', 1);
  assert.ok(shield.oscs.every((o) => o.type === 'square'), '盾兵/精英骑士走方波金属敲击');

  const basic = makeAudioStubManager();
  basic.a.playKill('basic', 1);
  assert.equal(basic.oscs.length, 1);
  assert.equal(basic.oscs[0].type, 'square', '基础怪沿用方波扫频');

  const unknown = makeAudioStubManager();
  unknown.a.playKill('some-unknown-type', 1);
  assert.equal(unknown.oscs.length, 1, '未收录敌种回落到基础怪音色，不静默也不报错');
});

test('击杀音色：连击越高音高越亮（第 3 连起生效）', () => {
  const base = makeAudioStubManager();
  base.a.playKill('basic', 1);
  const f0 = base.oscs[0].frequency.value;

  const combo = makeAudioStubManager();
  combo.a.playKill('basic', HIT_FEEDBACK.COMBO.MIN_FOR_FEEDBACK + 3);
  const f1 = combo.oscs[0].frequency.value;

  assert.ok(f1 > f0, '连击后起始频率被抬高');
  assert.ok(f1 < f0 * 2, '抬升幅度克制（不是八度乱跳）');
});

test('音效抖动：抖动幅度为 0 时完全确定，正常幅度下不越界', () => {
  const { a } = makeAudioStubManager();
  assert.equal(a._jitter(200, 0), 200);
  for (let i = 0; i < 200; i++) {
    const v = a._jitter(200, HIT_FEEDBACK.SOUND.PITCH_JITTER);
    assert.ok(v >= 200 * 0.92 - 1e-9 && v <= 200 * 1.08 + 1e-9, '抖动应落在 ±8% 内');
  }
});

// ---------- ④ 手柄震动 ----------

function makeInputStub(actuatorOf) {
  const input = Object.create(InputManager.prototype);
  input.world = {
    renderer: {
      xr: {
        getSession: () => ({
          inputSources: [
            { handedness: 'left', gamepad: { hapticActuators: actuatorOf('left') } },
            { handedness: 'right', gamepad: { hapticActuators: actuatorOf('right') } },
          ],
        }),
      },
    },
  };
  return input;
}

test('手柄震动：pulse 接口、vibrationActuator 回退、以及不支持时都不得抛错', () => {
  const pulses = [];
  const input = makeInputStub((hand) => [{ pulse: (i, d) => pulses.push([hand, i, d]) }]);
  assert.equal(input.pulseHand('right', 0.5, 40), true);
  assert.deepEqual(pulses, [['right', 0.5, 40]]);
  assert.equal(input.pulseBothHands(0.8, 100), true);
  assert.equal(pulses.length, 3, '双手各一次 + 之前一次');

  const effects = [];
  const legacy = makeInputStub(() => []);
  legacy.world.renderer.xr.getSession = () => ({
    inputSources: [{ handedness: 'right', gamepad: { vibrationActuator: { playEffect: (t, o) => effects.push([t, o.duration, o.strongMagnitude]) } } }],
  });
  assert.equal(legacy.pulseHand('right', 0.6, 70), true);
  assert.deepEqual(effects, [['dual-rumble', 70, 0.6]]);

  const none = makeInputStub(() => []);
  assert.equal(none.pulseHand('right', 0.6, 70), false, '无震动硬件 → 静默返回 false');
  assert.equal(none.pulseHand('right', 0, 70), false, '强度为 0 不触发');
});

test('手柄震动：强度被钳制在 0~1', () => {
  const pulses = [];
  const input = makeInputStub(() => [{ pulse: (i, d) => pulses.push([i, d]) }]);
  input.pulseHand('right', 9, 40);
  assert.deepEqual(pulses[0], [1, 40], '超过 1 的强度被夹到 1');
});