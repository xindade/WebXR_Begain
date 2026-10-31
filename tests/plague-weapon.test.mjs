// 第九十四修 · 瘟疫医生毒枪切换
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CHARACTERS, PLAGUE_WEAPON } from '../src/core/constants.js';
import { RightGun } from '../src/vr/rightGun.js';
import { BulletManager } from '../src/game/bullets.js';

function fakeGun() {
  const gun = Object.create(RightGun.prototype);
  gun.models = { ak: { id: 'ak' }, bombard: { id: 'bombard' }, plague: { id: 'plague' } };
  gun.model = null;
  gun._weapon = null;
  gun._wantWeapon = 'ak';
  gun.root = { position: new THREE.Vector3(), rotation: new THREE.Euler(), scale: { value: 1, setScalar(v) { this.value = v; } } };
  gun._activateModel = function (key) {
    this.model = this.models[key];
    this._weapon = key;
  };
  return gun;
}

test('毒枪配置：模型存在，Y 轴 180° 对齐 AK 的枪口方向', () => {
  assert.equal(PLAGUE_WEAPON.MODEL_URL, 'Model/毒枪械.glb');
  assert.equal(PLAGUE_WEAPON.POSITION.y, -0.28, '现场：在 -0.25 基础上垂直下移 3cm');
  assert.equal(PLAGUE_WEAPON.ROTATION.y, 180);
  assert.equal(PLAGUE_WEAPON.SCALE, 0.5);
  assert.ok(PLAGUE_WEAPON.MODEL_COLOR_MUL > 1);
  assert.ok(PLAGUE_WEAPON.MODEL_EMISSIVE > 0);
});

test('角色切换武器：瘟疫医生 = 毒枪，爆炮手 = 火箭筒，其余 = AK', () => {
  const g = fakeGun();

  g._syncWeapon({ player: { characterKey: 'plague', fireMode: 'fan' } });
  assert.equal(g._wantWeapon, 'plague');
  assert.equal(g._weapon, 'plague');

  g._syncWeapon({ player: { characterKey: 'bombard', fireMode: 'bombard' } });
  assert.equal(g._wantWeapon, 'bombard');
  assert.equal(g._weapon, 'bombard');

  g._syncWeapon({ player: { characterKey: 'rapid', fireMode: 'fan' } });
  assert.equal(g._wantWeapon, 'ak');
  assert.equal(g._weapon, 'ak');
});

test('毒枪模型应用自己的位置/旋转/缩放，不借用火箭筒配置', () => {
  const g = fakeGun();
  g.models.plague = { id: 'plague' };
  g.model = g.models.plague;
  g._weapon = 'plague';
  g._applyTransform();
  assert.equal(g.root.position.y, -0.28);
  assert.ok(Math.abs(g.root.rotation.y - Math.PI) < 1e-9);
  assert.equal(g.root.scale.value, 0.5);
});

test('毒枪提亮：只改目标模型材质，压金属度、加自发光、颜色乘系数', () => {
  const tex = new THREE.Texture();
  const mat = new THREE.MeshStandardMaterial({ color: 0x888888, map: tex, metalness: 1, roughness: 0.5 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  const root = new THREE.Group();
  root.add(mesh);
  RightGun.prototype._brightenModel.call({}, root, PLAGUE_WEAPON);
  assert.ok(mat.color.r > new THREE.Color(0x888888).r, '颜色应被提亮');
  assert.equal(mat.metalness, 0.65, '无环境贴图时金属度不得过高');
  assert.equal(mat.emissiveMap, tex);
  assert.equal(mat.emissiveIntensity, 0.25);
});

test('瘟疫普通子弹为绿色；掌风弹与显式特殊弹色不被覆盖', () => {
  const mgr = new BulletManager(new THREE.Scene());
  mgr.setDefaultTint(CHARACTERS.plague.bulletTint);
  const p = new THREE.Vector3();
  const d = new THREE.Vector3(0, 0, -1);

  mgr.spawn(p, d, 10);
  assert.equal(mgr.active[0].tint, 0x4dff88);

  mgr.spawn(p, d, 10, false, { palm: true });
  assert.equal(mgr.active[1].tint, null, '掌风弹保留自己的金色');

  mgr.spawn(p, d, 10, false, { tint: 0xff0000 });
  assert.equal(mgr.active[2].tint, 0xff0000, '追踪/穿甲等显式颜色优先');
});
