import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AIM, SHOOT } from '../src/core/constants.js';
import { DEFAULT_SETTINGS } from '../src/core/settings.js';
import {
  aimForceFromSearch, familyFromProfiles, familyFromUA, getAimDeg, getDeviceFamily,
  isUaPicoStrong, noteInputSource,
} from '../src/vr/deviceProfile.js';
import { InputManager } from '../src/vr/input.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

// Node 里没有 localStorage：给「残留的旧标定值」一个内存桩，用来验证它已不再影响角度
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

test('profiles 厂商串按精确前缀映射到设备槽', () => {
  assert.equal(familyFromProfiles(['pico-4']), 'pico');
  assert.equal(familyFromProfiles(['meta-quest-touch-plus']), 'quest');
  assert.equal(familyFromProfiles(['oculus-touch-v3']), 'quest');
  assert.equal(familyFromProfiles(['htc-vive-controller']), 'steamvr');
  assert.equal(familyFromProfiles(['valve-index-controller']), 'steamvr');
  // generic-* 不携带厂商信息 → 必须放行给 UA 兜底，不能短路成某厂牌
  assert.equal(familyFromProfiles(['generic-trigger-squeeze-thumbstick']), null);
  assert.equal(familyFromProfiles([]), null);
});

test('UA 强 PICO 标识优先于 Quest 伪装', () => {
  const fakeQuest = 'Mozilla/5.0 (Linux; Android 10; Quest 2) PicoBrowser/5.0 Bytedance';
  assert.equal(isUaPicoStrong(fakeQuest), true);
  assert.equal(familyFromUA(fakeQuest), 'pico');    // 不被 UA 里的 "Quest 2" 带偏
  assert.equal(isUaPicoStrong('Mozilla/5.0 OculusBrowser/33.0 Quest 3'), false);
  assert.equal(familyFromUA('Mozilla/5.0 OculusBrowser/33.0 Quest 3'), 'quest');
  assert.equal(familyFromUA('Mozilla/5.0'), null);
});

test('三级证据都判不出 → unknown（且已确认的槽不被 generic 降级）', () => {
  noteInputSource({ profiles: ['generic-trigger-squeeze-thumbstick'] });
  assert.equal(getDeviceFamily(), 'unknown');       // Node 的 UA 也不含厂商特征
});

test('角度优先级：AIM.BY_DEVICE < AIM.FORCE，AIM.DEVICE 可锁定槽', () => {
  AIM.DEVICE = null; AIM.FORCE = null; AIM.ENABLED = true;

  assert.equal(getAimDeg().x, AIM.BY_DEVICE.unknown.x);      // unknown 槽兜底
  assert.equal(getAimDeg().source, 'AIM.BY_DEVICE.unknown');

  AIM.DEVICE = 'quest';                                      // 识别不准时手动钉死
  assert.equal(getDeviceFamily(), 'quest');
  assert.equal(getAimDeg().x, AIM.BY_DEVICE.quest.x);
  assert.equal(getAimDeg().y, AIM.BY_DEVICE.quest.y);
  assert.equal(getAimDeg().source, 'AIM.BY_DEVICE.quest');

  AIM.FORCE = { x: -9 };                                     // FORCE 最高，且可只覆盖部分轴
  assert.equal(getAimDeg().x, -9);
  assert.equal(getAimDeg().y, AIM.BY_DEVICE.quest.y);
  assert.equal(getAimDeg().source, 'AIM.FORCE');
  AIM.FORCE = null;

  AIM.ENABLED = false;                                       // 总开关关 → 回到改造前单角行为
  assert.equal(getAimDeg().x, SHOOT.RIGHT_PITCH_DEG);
  assert.equal(getAimDeg().y, 0);

  AIM.ENABLED = true; AIM.DEVICE = null;
});

test('第三十四修：设备里残留的 aim-xyz 旧标定值已失效，角度只认配置表', () => {
  AIM.DEVICE = 'quest'; AIM.FORCE = null; AIM.ENABLED = true;
  store.set('aim-xyz:quest', JSON.stringify({ x: -5, y: 2, z: 0 }));   // 旧版标定工具留下的脏值
  assert.equal(getAimDeg().x, AIM.BY_DEVICE.quest.x);                 // 必须被忽略
  assert.equal(getAimDeg().y, AIM.BY_DEVICE.quest.y);
  assert.equal(getAimDeg().source, 'AIM.BY_DEVICE.quest');
  store.delete('aim-xyz:quest');
  AIM.DEVICE = null;
});

test('Quest 槽 = 2026-10-14 现场复核修正的固化角（-14 / -14 / 0）', () => {
  assert.deepEqual({ ...AIM.BY_DEVICE.quest }, { x: -14, y: -14, z: 0 });
});

test('射线与子弹共用同一补偿角，且 z(roll) 不改变方向', () => {
  AIM.DEVICE = 'steamvr'; AIM.ENABLED = true; AIM.FORCE = null;
  const im = Object.create(InputManager.prototype);
  im.settings = { ...DEFAULT_SETTINGS, dominantHand: 'right' };
  const ctrl = new THREE.Object3D();                     // 单位姿态：世界方向 == 本地方向
  const pos = new THREE.Vector3(), dir = new THREE.Vector3();

  im._rightAim(ctrl, pos, dir);
  const rayDir = new THREE.Vector3(0, 0, -1).applyEuler(im._aimEulerRad());
  near(dir.x, rayDir.x); near(dir.y, rayDir.y); near(dir.z, rayDir.z);
  const muzzle = dir.clone().multiplyScalar(SHOOT.SPAWN_OFFSET);   // 出生点 = 手柄位置沿瞄准方向前移（枪口）
  near(pos.x, muzzle.x); near(pos.y, muzzle.y); near(pos.z, muzzle.z);

  const before = dir.clone();
  AIM.FORCE = { z: 33 };                                 // 文档 §3.1：z 只改枪管姿态，不改方向
  im._rightAim(ctrl, pos, dir);
  near(dir.x, before.x); near(dir.y, before.y); near(dir.z, before.z);
  AIM.FORCE = null;

  AIM.ENABLED = false;                                   // 总开关关：退化为绕 X 单角（旧行为）
  im._rightAim(ctrl, pos, dir);
  near(dir.y, Math.sin(THREE.MathUtils.degToRad(SHOOT.RIGHT_PITCH_DEG)));
  near(dir.z, -Math.cos(THREE.MathUtils.degToRad(SHOOT.RIGHT_PITCH_DEG)));

  AIM.ENABLED = true; AIM.DEVICE = null;
});

test('第三十四修：A/B 键不再退出 VR（input 里已无退出分支）', () => {
  const im = Object.create(InputManager.prototype);
  assert.equal(typeof im._updateAimCalibration, 'undefined');   // 摇杆标定工具已删
  assert.equal(typeof im._refreshRayAims, 'undefined');
  assert.equal(InputManager.prototype._applyRayAim instanceof Function, true);  // 射线仍按补偿角刷新
});

// ---------- 第四十三修：?aim= 现场试角（只影响带参数的那台设备）----------

test('URL 现场覆盖：?aim=x,y,z 与 ?aimx= 只覆盖写到的轴', () => {
  assert.equal(aimForceFromSearch(''), null);
  assert.equal(aimForceFromSearch('?cast=1&pc=192.168.31.228'), null, '没有 aim 参数就不覆盖');
  assert.equal(aimForceFromSearch('?aim='), null, '空值不能当成 0（Number("") === 0 会误伤）');
  assert.equal(aimForceFromSearch('?aimx=abc'), null, '非数字忽略');

  assert.deepEqual(aimForceFromSearch('?aim=14,-14,0'), { x: 14, y: -14, z: 0 });
  assert.deepEqual(aimForceFromSearch('?aim=20,,5'), { x: 20, z: 5 }, '空轴跳过、其余照旧');
  assert.deepEqual(aimForceFromSearch('?aimx=20&aimy=-14'), { x: 20, y: -14 });
  assert.deepEqual(aimForceFromSearch('?cast=1&aimx=-30'), { x: -30 });
});