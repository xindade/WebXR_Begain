import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ATTR_TYPES } from '../src/content/cards.js';
import { CardDraft } from '../src/game/cardDraft.js';
import { CARD } from '../src/core/constants.js';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { attachBalloonModel, loadBalloonModel } from '../src/game/balloonModels.js';

test('attack upgrade never removes accumulated death compensation', () => {
  const player = { atk: 750 };
  ATTR_TYPES.find(c => c.id === 'atk').apply(player);
  assert.ok(player.atk >= 750);
});

test('card selection detects a bullet crossing the whole target in one frame', () => {
  const draft = Object.create(CardDraft.prototype);
  const holder = new THREE.Group();
  const item = { holder };
  Object.assign(draft, { active: true, t: 0, timer: 10, items: [item] });
  let selected;
  draft._triggerSelect = value => { selected = value; };
  const y = CARD.ROW_Y + CARD.BALLOON_BOB * Math.sin(0.05 * CARD.BALLOON_BOB_FREQ) + CARD.BALLOON_HEIGHT;
  const bullet = { pos: new THREE.Vector3(0, y, 0.375), prevPos: new THREE.Vector3(0, y, -0.375) };
  draft.update(0.05, { active: [bullet], release() {} });
  assert.equal(selected, item);
});

test('failed enemy model restores a visible fallback and failed requests can retry', async () => {
  const original = GLTFLoader.prototype.load;
  let calls = 0;
  GLTFLoader.prototype.load = function(url, resolve, progress, reject) { calls++; reject(new Error('simulated 404')); };
  const balloon = { alive: true, mesh: new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshBasicMaterial()) };
  balloon.mesh.material.visible = false;
  try {
    attachBalloonModel(balloon, 'test-missing.glb', 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(balloon.mesh.material.visible, true);
    await assert.rejects(loadBalloonModel('test-missing.glb'));
    assert.equal(calls, 2);
  } finally { GLTFLoader.prototype.load = original; }
});
