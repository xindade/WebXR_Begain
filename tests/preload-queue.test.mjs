import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LEVELS } from '../src/content/levels.js';
import { ENEMY_TYPES } from '../src/content/enemies.js';
import { DEPTH_SPRITE_TYPES } from '../src/core/constants.js';

// game.js 顶部会 preload 视觉纹理；预载队列本身不碰纹理，这里只需一个最小桩（同 boss-skills.test.mjs）
const originalLoad = THREE.TextureLoader.prototype.load;
let Game, scriptEnemyTypes;
try {
  THREE.TextureLoader.prototype.load = () => new THREE.Texture();
  ({ Game, scriptEnemyTypes } = await import('../src/game/game.js'));
} finally { THREE.TextureLoader.prototype.load = originalLoad; }

const level = (n) => LEVELS.find((l) => l.n === n);
// _buildIntroPreloadQueue 只读 lv + 模块级常量，不碰 this ⇒ 空对象当实例即可
const queueOf = (n) => Game.prototype._buildIntroPreloadQueue.call({}, level(n));
const urlsOf = (n) => queueOf(n).map((it) => it.url);

test('第四十九修 · scriptEnemyTypes：只收 elite 事件的敌种，无脚本关卡返回空', () => {
  assert.deepEqual(scriptEnemyTypes(5).sort(), ['eliteKnight', 'heart']);
  assert.ok(scriptEnemyTypes(4).includes('shield'));
  assert.ok(scriptEnemyTypes(2).includes('eliteKnight'));
  assert.deepEqual(scriptEnemyTypes(3), []);   // 机制关：无脚本
  assert.deepEqual(scriptEnemyTypes(18), []);
});

test('第四十九修 · 预载队列补齐「脚本独有」的敌种（第 5 关的 heart 不再漏）', () => {
  const q5 = urlsOf(5);
  // heart（心形怪/治疗术士）只在 SPAWN_SCRIPT[5] 里出现：ELITE_SCHEDULE[5] / LEVEL_ENEMY[5] / pool 都没有它
  assert.ok(q5.includes(ENEMY_TYPES.heart.model), '第 5 关预载队列必须含心形怪');
  // 它走 DepthSprite 立绘 ⇒ capture=true（抓帧提前到穿云窗），不需要再额外 warm
  assert.equal(queueOf(5).find((it) => it.url === ENEMY_TYPES.heart.model).capture, true);
  assert.ok(q5.includes(ENEMY_TYPES.eliteKnight.model));
});

test('第四十九修 · 预载队列含「附属模型」（盾甲的 Model/盾牌.glb）', () => {
  const shieldUrl = ENEMY_TYPES.shield.shieldModel;
  assert.ok(shieldUrl, '盾甲兵应配 shieldModel');
  // 第五十修：第 5 关的收尾批换成「治疗术士 + 铁甲兵」（文件口径），盾甲兵改从第 7 关起出现。
  for (const n of [4, 7]) {
    const it = queueOf(n).find((e) => e.url === shieldUrl);
    assert.ok(it, `第 ${n} 关预载队列必须含 ${shieldUrl}`);
    assert.equal(it.capture, false);
    assert.equal(it.warm, true);
  }
});

test('第四十九修 · 不改动既有的 Boss 关预载（第 6 关三张脸仍 warm）', () => {
  const q6 = urlsOf(6);
  for (const url of ['Model/蓝面脸谱.glb', 'Model/红面脸谱.glb', 'Model/黑面脸谱.glb']) {
    assert.ok(q6.includes(url), `第 6 关预载队列应含 ${url}`);
  }
  assert.ok(queueOf(6).filter((e) => e.warm).length >= 3, '三张脸都应 warm');
});

test('第四十九修 · 不走立绘的怪也预热 GPU（原先只有 Boss 模型 warm）', () => {
  // 盾甲兵走立绘（DEPTH_SPRITE_TYPES 白名单），它的附属「盾牌」不走 ⇒ 盾牌应 warm
  assert.equal(DEPTH_SPRITE_TYPES.includes('shield'), true);
  const q = queueOf(4);
  const knight = q.find((e) => e.url === ENEMY_TYPES.eliteKnight.model);
  assert.equal(knight.capture, true);
  assert.equal(knight.warm, false);
});
