import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { InputManager } from '../src/vr/input.js';
import { SHOOT } from '../src/core/constants.js';
import * as cards from '../src/content/cards.js';
const pendingModule = path => import(path).catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
const { PauseState } = await pendingModule('../src/core/pause.js');
const { sanitizeSettings } = await pendingModule('../src/core/settings.js');
const { PerformanceMonitor } = await pendingModule('../src/core/performance.js');

test('hidden and manual pause reasons cannot accidentally resume one another', () => {
  assert.equal(typeof PauseState, 'function');
  const pause = new PauseState();
  pause.add('manual'); pause.add('hidden'); pause.remove('hidden');
  assert.equal(pause.paused, true);
  pause.remove('manual'); assert.equal(pause.paused, false);
});
test('settings reject invalid numbers and unknown enum values', () => {
  assert.equal(typeof sanitizeSettings, 'function');
  const result = sanitizeSettings({ volume: 99, moveSpeed: -2, turnMode: 'bad', skySize: 9999, heightOffset: NaN });
  assert.equal(result.volume, 1); assert.equal(result.moveSpeed, 0);
  assert.equal(result.turnMode, 'none'); assert.equal(result.skySize, 4096);
  assert.equal(result.heightOffset, 0);
});
test('performance samples retain bounded history and actual frame timing', () => {
  assert.equal(typeof PerformanceMonitor, 'function');
  const monitor = new PerformanceMonitor(2);
  for (let i = 0; i < 300; i++) monitor.record(0.02, 3, 4, { render: { calls: 10, triangles: 200 }, memory: { textures: 7 } }, { level: 1 });
  assert.equal(monitor.samples.length, 2);
  assert.ok(Math.abs(monitor.samples[1].fps - 50) < 0.01);
  assert.equal(monitor.samples[1].textures, 7);
});
test('input reset clears stuck movement, fire and queued skill after focus loss', () => {
  const input = Object.create(InputManager.prototype);
  Object.assign(input, { keys: new Set(['KeyW']), shots: [{}], desktopShooting: true, _skillQueued: true, _creditQueued: 500, _hands: {} });
  assert.equal(typeof input.reset, 'function');
  input.reset();
  assert.equal(input.keys.size, 0); assert.equal(input.desktopShooting, false);
  assert.equal(input.consumeSkill(), false); assert.equal(input.consumeCredit(), 0);
});
test('full attributes are excluded and a fully upgraded player still gets a reward', () => {
  assert.equal(typeof cards.availableAttributes, 'function');
  const player = { fireRate:14, shotCount:7, atk:750, skillCost:100, skillDamageMul:5, regen:10, maxHp:400, hp:400 };
  const available = cards.availableAttributes(player, ['fireRate','multiShot','atk','skillCost','skillDamage']);
  assert.ok(available.length > 0);
  assert.ok(available.every(c => !['fireRate','multiShot','atk','skillCost','skillDamage'].includes(c.id)));
});

test('left handed settings survive controller connection and P works on toolbar buttons', () => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = new EventTarget(); globalThis.document = new EventTarget();
  try {
    const controls = [new THREE.Group(), new THREE.Group()];
    const world = { camera: new THREE.PerspectiveCamera(), renderer: {
      domElement: new EventTarget(), xr: { getController: i => controls[i], getControllerGrip: () => new THREE.Group() },
    } };
    const input = new InputManager(world, new THREE.Group());
    input.setSettings({ ...input.settings, dominantHand: 'left' });
    controls[0].dispatchEvent({ type: 'connected', data: { handedness: 'left' } });
    assert.equal(controls[0].userData.rayLine.material.color.getHex(), SHOOT.RAY_COLOR);
    const event = new Event('keydown');
    Object.defineProperties(event, { code: { value: 'KeyP' }, target: { value: { tagName: 'BUTTON' } } });
    window.dispatchEvent(event);
    assert.equal(input._menuQueued, 'toggle');
  } finally { globalThis.window = oldWindow; globalThis.document = oldDocument; }
});
