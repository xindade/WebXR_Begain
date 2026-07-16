import * as THREE from 'three';
import { CARD, RARITY } from '../core/constants.js';
import { ATTR_TYPES, SKILL_CARDS } from '../content/cards.js';

// 抽卡：固定世界坐标 (Z=-4, Y=1) 均匀排开的 3D 卡牌，每张卡上方绑一个可射击气球。
// 选卡方式 = 射击对应气球：气球爆炸 → 该卡化为光点飞向玩家；其余卡/气球无敌上飞到 10m（2s）后消失。
// 刷新保留为第 4 个可射击气球，击中后旧卡飞走并重新随机生成 3 张可射击卡。

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

// 创建「气球」（球体 + 细绳），作为一个 Group 便于整体移动
function makeBalloon(colorHex) {
  const g = new THREE.Group();
  const color = new THREE.Color(colorHex || '#ffffff');

  const sphereGeo = new THREE.SphereGeometry(CARD.BALLOON_R, 16, 12);
  const sphereMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, roughness: 0.4, metalness: 0.0 });
  const sphere = new THREE.Mesh(sphereGeo, sphereMat);
  g.add(sphere);

  // 细绳：从气球底部向下延伸到卡面
  const stringLen = CARD.BALLOON_DY;
  const stringGeo = new THREE.CylinderGeometry(0.006, 0.006, stringLen, 6);
  const stringMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.9 });
  const string = new THREE.Mesh(stringGeo, stringMat);
  string.position.y = -stringLen / 2;
  g.add(string);

  return g;
}

export class CardDraft {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.group.visible = false;

    this.items = [];          // 每项 { holder, card, balloon, pick, invincible, flying, flyVel, exploded, locked }
    this.refreshCost = CARD.REFRESH_BASE_COST;
    this.timer = 0;
    this.active = false;
    this.onDone = null;
    this._state = null;
    // 分数访问解耦：默认 no-op，open 时由外部注入 getScore/spendScore 回调（不再反向持有 game 实例）
    this._getScore = () => 0;
    this._spendScore = () => {};

    this.resolving = false;   // 是否已触发选择/刷新，进入结算动画
    this.resolveT = 0;
    this.selected = null;
    this.t = 0;

    this.lightFx = null;      // 选中卡化光点
    this._lightStart = [];
    this._lightDelay = [];
    this._lightTarget = new THREE.Vector3();
    this._lightN = 0;

    this._playerPos = new THREE.Vector3(); // 光点飞行目标（玩家位置，触发时记录）
  }

  open(playerPos, forward, state, onDone) {
    if (playerPos) this._playerPos.copy(playerPos);
    this._state = state;
    // score 访问解耦：优先用注入回调；兼容旧调用直接传 game 实例（state.game.score）
    this._getScore = state.getScore || (() => state.game?.score ?? 0);
    this._spendScore = state.spendScore || ((c) => { if (state.game) state.game.score -= c; });
    this.active = true;
    this.group.visible = true;
    this.timer = CARD.DURATION;
    this.refreshCost = CARD.REFRESH_BASE_COST;
    this.resolving = false;
    this.resolveT = 0;
    this.selected = null;
    this._clearLightFx();
    this.onDone = onDone;
    this._buildCards();
  }

  _buildCards() {
    this._clearItems();
    this._clearLightFx();

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
    // 刷新卡（第 4 个可射击气球）；积分不足以支付当前刷新费时锁定（不可击中 + 变暗）
    const canAfford = this._getScore() >= this.refreshCost;
    picks.push({
      kind: 'refresh',
      label: '刷新',
      sub: canAfford ? `${this.refreshCost}分` : '积分不足',
      color: '#888',
    });

    const N = picks.length;
    const startX = -((N - 1) * CARD.SPACING) / 2;
    picks.forEach((p, i) => {
      const x = startX + i * CARD.SPACING;

      // holder：把卡片 + 气球挂在一起，整体上下浮动，二者始终同步
      const holder = new THREE.Group();
      holder.position.set(x, CARD.ROW_Y, CARD.ROW_Z);
      this.group.add(holder);

      const card = this._makeCardMesh(p.label, p.sub, p.color);
      card.position.set(0, 0, 0);
      holder.add(card);              // 必须先挂进 holder，world 坐标才正确
      card.lookAt(0, CARD.ROW_Y, 0); // 再朝向坐标原点（保持竖直可读，正面朝玩家）

      const balloon = makeBalloon(p.color);
      balloon.position.set(0, CARD.BALLOON_DY, 0); // 相对 holder 上方
      holder.add(balloon);

      const item = {
        holder, card, balloon, pick: p,
        invincible: false, flying: false, flyVel: 0, exploded: false,
        locked: p.kind === 'refresh' && !canAfford,
      };

      if (item.locked) {
        card.material.transparent = true; card.material.opacity = 0.35;
        this._setBalloonOpacity(item, 0.3);
      }

      this.items.push(item);
    });
  }

  _makeCardMesh(title, sub, color) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD.WIDTH, CARD.HEIGHT),
      new THREE.MeshBasicMaterial({ map: makeCardTexture(title, sub, color), transparent: true })
    );
    return mesh;
  }

  _clearItems() {
    for (const it of this.items) {
      this.group.remove(it.holder);
      it.card.geometry.dispose();
      it.card.material.map?.dispose();
      it.card.material.dispose();
      it.balloon.traverse((o) => {
        if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
      });
      it.holder.clear?.(); // 释放 holder 对子对象的引用
    }
    this.items = [];
  }

  _clearLightFx() {
    if (this.lightFx) {
      this.group.remove(this.lightFx);
      this.lightFx.geometry.dispose();
      this.lightFx.material.dispose();
      this.lightFx = null;
    }
    this._lightStart = [];
    this._lightDelay = [];
    this._lightN = 0;
  }

  update(dt, bullets, playerPos) {
    if (!this.active) return;
    this.t += dt;

    if (this.resolving) { this._updateResolve(dt); return; }

    this.timer -= dt;
    if (this.timer <= 0) {
      this._triggerSelect(this.items[Math.floor(Math.random() * this.items.length)], playerPos);
      return;
    }

    // 卡片 + 气球 整体上下轻微浮动（二者同挂 holder，始终同步）
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.flying) continue;
      it.holder.position.y = CARD.ROW_Y + CARD.BALLOON_BOB * Math.sin(this.t * 1.5 + i);
    }

    // 子弹 ↔ 卡气球 碰撞
    if (bullets && bullets.active) {
      for (const b of [...bullets.active]) {
        for (const it of this.items) {
          if (it.invincible || it.locked) continue; // 锁定的刷新气球不可击中
          // 气球世界坐标 = holder.position + 气球局部(0, BALLOON_DY, 0)
          const bx = it.holder.position.x;
          const by = it.holder.position.y + CARD.BALLOON_DY;
          const bz = it.holder.position.z;
          const dx = b.mesh.position.x - bx;
          const dy = b.mesh.position.y - by;
          const dz = b.mesh.position.z - bz;
          if (dx * dx + dy * dy + dz * dz < (CARD.BALLOON_R + 0.12) ** 2) {
            bullets.release(b);
            this._triggerSelect(it, playerPos);
            return;
          }
        }
      }
    }
  }

  _triggerSelect(item, playerPos) {
    if (playerPos) this._playerPos.copy(playerPos);
    this.resolving = true;
    this.resolveT = 0;
    this.selected = item;

    const flyAll = () => {
      for (const it of this.items) {
        it.invincible = true;
        it.flying = true;
        it.flyVel = (CARD.FLY_TOP_Y - it.holder.position.y) / CARD.RESOLVE_DUR;
      }
    };

    if (item.pick.kind === 'refresh') {
      // 刷新：全部飞走（含被击中的刷新气球），不产生粒子；立即扣分清零，手腕面板实时更新
      flyAll();
      if (this._getScore() >= this.refreshCost) {
        this._spendScore(this.refreshCost);
        this.refreshCost *= 2;
      }
    } else {
      // 普通选卡：被击中气球爆炸，其余飞走；爆炸卡化为光点飞向玩家
      for (const it of this.items) {
        if (it === item) it.exploded = true;
        else { it.invincible = true; it.flying = true; it.flyVel = (CARD.FLY_TOP_Y - it.holder.position.y) / CARD.RESOLVE_DUR; }
      }
      const from = new THREE.Vector3(item.holder.position.x, item.holder.position.y + CARD.BALLOON_DY, item.holder.position.z);
      this._spawnLightFx(from, this._playerPos, item.pick.color);
    }
  }

  _updateResolve(dt) {
    this.resolveT += dt;

    for (const it of this.items) {
      if (it.exploded) {
        // 被击中的气球爆炸（放大淡出），对应卡化为光点飞走
        if (it._explodeT === undefined) it._explodeT = 0;
        it._explodeT += dt;
        const k = Math.min(it._explodeT / 0.3, 1);
        it.balloon.scale.setScalar(1 + k * 1.5);
        this._setBalloonOpacity(it, 1 - k);
        if (k >= 1) it.balloon.visible = false;
        this._setCardOpacity(it, Math.max(0, 1 - this.resolveT / CARD.LIGHT_DUR));
      } else if (it.flying) {
        // 飞走（含刷新分支的全部卡 + 普通分支的其余卡）：holder 整体上升
        const dy = it.flyVel * dt;
        it.holder.position.y += dy;
      }
    }

    // 光点飞向玩家（仅普通选卡有）：50 粒错峰出发，形成连续数据流
    if (this.lightFx) {
      const TRAVEL = CARD.LIGHT_DUR;
      const tgt = this._lightTarget;
      const pos = this.lightFx.geometry.attributes.position;
      for (let i = 0; i < this._lightN; i++) {
        const localT = this.resolveT - this._lightDelay[i];
        const k = localT <= 0 ? 0 : Math.min(localT / TRAVEL, 1);
        const e = k * k * (3 - 2 * k); // smoothstep 缓动
        const s = this._lightStart[i];
        pos.setXYZ(
          i,
          s.x + (tgt.x - s.x) * e,
          s.y + (tgt.y - s.y) * e,
          s.z + (tgt.z - s.z) * e
        );
      }
      pos.needsUpdate = true;
      // 整束在最后一粒到达玩家后开始淡出
      const fadeStart = CARD.STREAM_SPREAD + TRAVEL;
      if (this.resolveT > fadeStart) {
        this.lightFx.material.opacity = Math.max(0, 1 - (this.resolveT - fadeStart) / (CARD.RESOLVE_DUR - fadeStart));
      }
    }

    if (this.resolveT >= CARD.RESOLVE_DUR) this._finish();
  }

  _finish() {
    const sel = this.selected;

    if (sel.pick.kind === 'refresh') {
      // 扣分清零已在 _triggerSelect 即时完成；此处只重生新一批可射击卡
      this._buildCards();          // 重生新一批可射击卡（保持 active）
      this.resolving = false;
      this.resolveT = 0;
      this.selected = null;
      this.timer = CARD.DURATION;
      return;
    }

    // 选项卡：应用强化后进入下一关
    if (sel.pick.kind === 'attr') sel.pick.def.apply(this._state.player, sel.pick.def.values[sel.pick.rarity]);
    else if (sel.pick.kind === 'skill') sel.pick.def.apply(this._state.player);

    this._clearLightFx();
    this.active = false;
    this.group.visible = false;
    this._clearItems();
    const cb = this.onDone;
    this.onDone = null;
    if (cb) cb();
  }

  _spawnLightFx(from, to, colorHex) {
    const N = 50; // 小粒子 50 粒
    const positions = new Float32Array(N * 3);
    this._lightStart = [];
    this._lightDelay = [];
    for (let i = 0; i < N; i++) {
      const sx = from.x + (Math.random() - 0.5) * 0.25;
      const sy = from.y + (Math.random() - 0.5) * 0.2;
      const sz = from.z + (Math.random() - 0.5) * 0.25;
      positions[i * 3] = sx; positions[i * 3 + 1] = sy; positions[i * 3 + 2] = sz;
      this._lightStart.push(new THREE.Vector3(sx, sy, sz));
      this._lightDelay.push((i / N) * CARD.STREAM_SPREAD); // 错峰出发 → 数据流
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: new THREE.Color(colorHex || '#ffe066'),
      size: CARD.LIGHT_SIZE, transparent: true, opacity: 1, // 小粒子
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    this.group.add(pts);
    this.lightFx = pts;
    this._lightTarget.copy(to);
    this._lightN = N;
  }

  _setBalloonOpacity(it, o) {
    it.balloon.traverse((m) => { if (m.material) { m.material.transparent = true; m.material.opacity = o; } });
  }

  _setCardOpacity(it, o) {
    it.card.material.transparent = true;
    it.card.material.opacity = o;
  }

  dispose() {
    this._clearLightFx();
    this._clearItems();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}
