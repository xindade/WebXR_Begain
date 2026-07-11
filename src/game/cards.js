import * as THREE from 'three';
import { CARD, RARITY } from '../core/constants.js';
import { ATTR_TYPES, SKILL_CARDS } from '../content/cards.js';

// 抽卡：3D 卡牌悬浮在玩家前方，射线/鼠标指向 + 确认选择
// 知识库：清空一波后触发，可刷新（积分翻倍），15 秒超时随机选

const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function rollRarity() {
  const entries = Object.entries(RARITY);
  const total = entries.reduce((s, [, v]) => s + v.weight, 0);
  let r = Math.random() * total;
  for (const [k, v] of entries) { if ((r -= v.weight) <= 0) return k; }
  return 'white';
}

function makeCardTexture(title, sub, color) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 160;
  const x = cv.getContext('2d');
  x.fillStyle = '#1b1b2f'; x.fillRect(0, 0, 256, 160);
  x.strokeStyle = color; x.lineWidth = 8; x.strokeRect(6, 6, 244, 148);
  x.fillStyle = color; x.font = 'bold 30px sans-serif'; x.textAlign = 'center';
  x.fillText(title, 128, 60);
  x.fillStyle = '#fff'; x.font = '22px sans-serif';
  x.fillText(sub, 128, 110);
  return new THREE.CanvasTexture(cv);
}

export class CardDraft {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.group.visible = false;
    this.cards = [];
    this.refreshCard = null;
    this.refreshCost = CARD.REFRESH_BASE_COST;
    this.timer = 0;
    this.active = false;
    this.onDone = null;
    this.hovered = null;
    this._ray = new THREE.Raycaster();
    this._playerPos = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._state = null;
  }

  open(playerPos, forward, state, onDone) {
    this._playerPos.copy(playerPos);
    this._forward.copy(forward);
    this._state = state;
    this.active = true;
    this.group.visible = true;
    this.timer = CARD.DURATION;
    this.refreshCost = CARD.REFRESH_BASE_COST;
    this.onDone = onDone;
    this._buildCards();
  }

  _buildCards() {
    this._clearCards();
    _right.crossVectors(this._forward, _up).normalize().negate();
    const center = this._playerPos.clone().addScaledVector(this._forward, CARD.DISTANCE);
    center.y += 0.2;

    const picks = [];
    for (let i = 0; i < CARD.COUNT; i++) {
      if (Math.random() < 0.2 && SKILL_CARDS.length) {
        const s = SKILL_CARDS[Math.floor(Math.random() * SKILL_CARDS.length)];
        picks.push({ kind: 'skill', def: s, rarity: s.rarity, label: s.label, sub: s.desc, color: RARITY[s.rarity].color });
      } else {
        const attr = ATTR_TYPES[Math.floor(Math.random() * ATTR_TYPES.length)];
        const rar = rollRarity();
        picks.push({ kind: 'attr', def: attr, rarity: rar, label: attr.label, sub: `+${attr.values[rar]}`, color: RARITY[rar].color });
      }
    }

    const startX = -((CARD.COUNT - 1) * CARD.SPACING) / 2;
    picks.forEach((p, i) => {
      const mesh = this._makeCardMesh(p.label, p.sub, p.color);
      mesh.position.copy(center).addScaledVector(_right, startX + i * CARD.SPACING);
      mesh.lookAt(this._playerPos.x, mesh.position.y, this._playerPos.z);
      mesh.userData.pick = p;
      this.group.add(mesh);
      this.cards.push(mesh);
    });

    this.refreshCard = this._makeCardMesh('刷新', `${this.refreshCost}分`, '#888');
    this.refreshCard.position.copy(center).add(new THREE.Vector3(0, CARD.REFRESH_OFFSET_Y - 0.4, 0));
    this.refreshCard.lookAt(this._playerPos.x, this.refreshCard.position.y, this._playerPos.z);
    this.refreshCard.userData.pick = { kind: 'refresh' };
    this.group.add(this.refreshCard);
  }

  _makeCardMesh(title, sub, color) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD.WIDTH, CARD.HEIGHT),
      new THREE.MeshBasicMaterial({ map: makeCardTexture(title, sub, color), transparent: true })
    );
    return mesh;
  }

  _clearCards() {
    for (const c of this.cards) this.group.remove(c);
    if (this.refreshCard) this.group.remove(this.refreshCard);
    this.cards = [];
    this.refreshCard = null;
    this.hovered = null;
  }

  update(dt, aimRay) {
    if (!this.active) return;
    this.timer -= dt;
    if (this.timer <= 0) { this._select(this.cards[Math.floor(Math.random() * this.cards.length)]); return; }

    this._ray.set(aimRay.origin, aimRay.direction);
    const hits = this._ray.intersectObjects([...this.cards, this.refreshCard].filter(Boolean));
    const hovered = hits.length ? hits[0].object : null;
    if (hovered !== this.hovered) {
      if (this.hovered) this.hovered.scale.setScalar(1);
      this.hovered = hovered;
      if (this.hovered) this.hovered.scale.setScalar(1.2);
    }
  }

  confirm() {
    if (!this.active || !this.hovered) return;
    this._select(this.hovered);
  }

  _select(mesh) {
    if (!mesh) { this.close(); return; }
    const pick = mesh.userData.pick;
    if (pick.kind === 'refresh') {
      if (this._state.score >= this.refreshCost) {
        this._state.score -= this.refreshCost;
        this.refreshCost *= 2;
        this._buildCards();
      }
      return;
    }
    if (pick.kind === 'attr') pick.def.apply(this._state.player, pick.def.values[pick.rarity]);
    else if (pick.kind === 'skill') pick.def.apply(this._state.player);
    this.close();
  }

  close() {
    this.active = false;
    this.group.visible = false;
    this._clearCards();
    const cb = this.onDone;
    this.onDone = null;
    if (cb) cb();
  }
}
