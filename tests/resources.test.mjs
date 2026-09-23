import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/core/world.js';
import { loadGLB } from '../src/game/glbCache.js';
import { loadBalloonModel } from '../src/game/balloonModels.js';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { DragonBoss } from '../src/game/dragonLevel.js';

function fakeWorld() {
  const world = Object.create(World.prototype);
  Object.assign(world, {
    _panoCache: {}, _panoLoading: {}, _panoRequest: 0, panoCacheLimit: 3,
    _skydome: { material: { color: { setScalar() {} } } }, sky: {}, _starLayers: [],
    renderer: { initTexture() {} }, _configurePano() {},
  });
  return world;
}

test('leaving dragon level while assets load does not spawn discarded parts', async () => {
  const originalFetch = globalThis.fetch, originalLoad = GLTFLoader.prototype.load;
  let resolve;
  globalThis.fetch = () => new Promise(r => resolve = r);
  GLTFLoader.prototype.load = (url, done) => done({ scene: {} });
  const dragon = Object.create(DragonBoss.prototype);
  let spawned = 0;
  Object.assign(dragon, { dead: false, _buildFromData() {}, _spawnBalloons() { spawned++; }, _loadHead() {} });
  try {
    const pending = dragon.start();
    dragon.dead = true;
    resolve({ ok: true, json: async () => ({}) });
    await pending;
    assert.equal(spawned, 0);
  } finally { globalThis.fetch = originalFetch; GLTFLoader.prototype.load = originalLoad; }
});

test('late sky completion cannot replace the latest requested level', async () => {
  const world = fakeWorld(), pending = {};
  world.prepareSkyPano = url => new Promise(resolve => pending[url] = resolve);
  world.setSkyPanorama('a'); world.setSkyPanorama('b');
  pending.b({ name: 'b' }); await Promise.resolve();
  pending.a({ name: 'a' }); await Promise.resolve();
  assert.equal(world._skydome.material.map.name, 'b');
});

test('returning to menu invalidates pending sky requests', async () => {
  const world = fakeWorld(); let resolve;
  world.prepareSkyPano = () => new Promise(r => resolve = r);
  world.setSkyPanorama('a'); world.clearSkyPanorama();
  resolve({}); await Promise.resolve();
  assert.equal(world._skydome.visible, false);
});

test('sky cache stays bounded and releases evicted textures', async () => {
  const world = fakeWorld(), disposed = [];
  world._texLoader = { load(url, done) { done({ dispose() { disposed.push(url); } }); } };
  for (let i = 0; i < 18; i++) await world.prepareSkyPano(`${i}.jpg`);
  assert.ok(Object.keys(world._panoCache).length <= 3);
  assert.equal(disposed.length, 15);
});

test('balloons and generic GLB consumers share a parsed model', async () => {
  const original = GLTFLoader.prototype.load; let calls = 0;
  const scene = {};
  GLTFLoader.prototype.load = (url, done) => { calls++; done({ scene }); };
  try {
    const [gltf, balloonScene] = await Promise.all([loadGLB('shared-test.glb'), loadBalloonModel('shared-test.glb')]);
    assert.equal(calls, 1); assert.equal(gltf.scene, balloonScene);
  } finally { GLTFLoader.prototype.load = original; }
});
