import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BalloonManager } from '../src/game/balloons.js';

// Game imports preload visual textures; collision tests need no browser image decoding.
const originalLoad = THREE.TextureLoader.prototype.load;
let Game;
try {
  THREE.TextureLoader.prototype.load = () => new THREE.Texture();
  ({ Game } = await import('../src/game/game.js'));
} finally { THREE.TextureLoader.prototype.load = originalLoad; }

function enemy(behavior = 'basic') {
  return {
    alive: true, behavior, type: { id: 'basic' }, score: 10, hp: 1, maxHp: 1000,
    mesh: new THREE.Object3D(), hitRadius: 1,
    takeDamage(damage) {
      if (!this.alive) return false;
      this.hp -= damage;
      if (this.hp > 0) return false;
      this.alive = false; return true;
    },
    dispose() { this.disposed = true; },
  };
}

for (const skill of ['buddha', 'sword']) {
  for (const scenario of ['face-boss', 'summoner']) {
    test(`${skill} safely handles ${scenario} removing multiple enemies during a hit`, () => {
      const game = Object.create(Game.prototype);
      const balloons = new BalloonManager(new THREE.Scene());
      let score = 0;
      Object.assign(game, {
        balloons, player: { skillDamageMul: 1 }, _addScore(value) { score += value; },
        _buddhaHit: new Set(),
        _buddhaFx: { update: () => false, isDamaging: true, scale: 1, position: new THREE.Vector3() },
        leftSword: { getBlade(hilt, tip) { hilt.set(0, 0, -1); tip.set(0, 0, 1); } },
        _hilt: new THREE.Vector3(), _tip: new THREE.Vector3(), _gameTime: 1,
      });
      const survivor = enemy();
      survivor.hp = 1e9;
      const first = enemy(), last = enemy();
      if (scenario === 'face-boss') {
        last.isFaceSub = true; last.faceBossRef = first;
      } else {
        last.behavior = 'summon'; last.minions = [first];
      }
      balloons.list.push(survivor, first, last);
      const update = () => skill === 'buddha' ? game._updateBuddhaFx(0.016) : game._updateSwordMelee();
      assert.doesNotThrow(update);
      assert.deepEqual(balloons.list, [survivor]);
      assert.ok(first.disposed && last.disposed);
      assert.equal(score, scenario === 'face-boss' ? 20 : 10);
      assert.ok(survivor.hp < 1e9, 'remaining enemy is still hit after removals');
      const hp = survivor.hp;
      update();
      assert.equal(survivor.hp, hp, 'no duplicate damage in the same cast/cooldown');
    });
  }
}
