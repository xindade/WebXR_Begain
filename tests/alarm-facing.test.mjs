// 内圈报警的「朝向口径」（第六十四修）—— 现场 bug 的回归锁
//
// 现场症状：「滴滴有时候听着在左边，实际只有前面有；有时候右边也是。」
// 真因不在分区算法（dangerAlarm.sectorOf 是对的，danger-alarm.test.mjs 也锁了手性），
// 而在**调用方**：three 的 Camera 重写了 getWorldDirection（Camera 那份 .negate()），
//   所以相机上拿到的**已经是真实朝向**；game 里又 negate 了一次
//   ⇒ 前/后、左/右整体转 180°，怪在正前却从侧面出声。
// 本文件把「前提（Camera 的行为）+ 调用方不许再取反」两件事一起钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { sectorOf } from '../src/game/dangerAlarm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = fs.readFileSync(path.join(HERE, '..', 'src', 'game', 'game.js'), 'utf8');

test('前提：three 的 Camera.getWorldDirection 已经取负（相机上拿到的就是真实朝向）', () => {
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);                                  // 看向 -Z
  const d = cam.getWorldDirection(new THREE.Vector3());
  assert.ok(d.z < 0, '看向 -Z 就必须给 -Z；若这里变成 +Z，说明 three 版本换了，本修的前提要重看');
  cam.lookAt(10, 0, 0);                                  // 看向 +X
  const d2 = cam.getWorldDirection(new THREE.Vector3());
  assert.ok(d2.x > 0, '看向 +X 就必须给 +X');
});

test('★ game 的报警调用方直接传 getWorldDirection 的结果（不许再 negate 一次）', () => {
  assert.ok(!GAME.includes('fx: -this._fwd.x, fz: -this._fwd.z'),
    '★ 二次取反 = 把玩家的前/后、左/右整体转 180°（现场「声音在左边、怪在正前」就是这么来的）');
  assert.ok(GAME.includes('fx: this._fwd.x, fz: this._fwd.z'),
    '报警分区必须用**真实面朝方向**');
});

test('端到端口径：面朝 -Z、怪在正前 → 前扇区（不是左/右）', () => {
  const cam = new THREE.PerspectiveCamera();
  cam.lookAt(0, 0, -1);
  const f = cam.getWorldDirection(new THREE.Vector3());
  // 玩家在原点、怪在正前方 5m：把 game 的做法（直接用 f）走一遍
  assert.equal(sectorOf(0 - 0, -5 - 0, f.x, f.z), 0, '正前方的怪必须归「前」扇区（声像居中）');
  // 对照：若按旧写法再取反一次，就会落进「后」扇区 —— 这就是那个 bug 的形状
  assert.equal(sectorOf(0 - 0, -5 - 0, -f.x, -f.z), 2, '（对照）二次取反后正前方会变成「后」');
});
