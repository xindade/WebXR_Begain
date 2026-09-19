import * as THREE from 'three';
import { CARD, RARITY } from '../core/constants.js';
import { ATTR_TYPES, SKILL_CARDS } from '../content/cards.js';

// 抽卡：固定世界坐标 (Z=-4, Y=1) 均匀排开的 3D 卡牌，每张卡上方绑一个可射击气球。
// 选卡方式 = 射击对应气球：气球爆炸 → 该卡化为光点飞向玩家；其余卡/气球无敌上飞到 10m（2s）后消失。
// 每次抽 3 张不重复（来自 game 注入的卡池 pool，或固定技能卡 fixedSkills），无刷新卡。

const _up = new THREE.Vector3(0, 1, 0);

function rollRarity(weights) {
  // weights: 形如 {white:60, blue:40} 的覆盖权重（来自 LEVEL_PLANS 的 cards）；缺省用全局 RARITY
  const entries = weights
    ? Object.entries(weights).map(([k, w]) => [k, { weight: w }])
    : Object.entries(RARITY);
  const total = entries.reduce((s, [, v]) => s + v.weight, 0);
  let r = Math.random() * total;
  for (const [k, v] of entries) { if ((r -= v.weight) <= 0) return k; }
  return entries[0][0];
}

// 按宽度断行（中文按字符断），最多 maxLines 行，超出加「…」
function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines, color) {
  const chars = [...text];
  const lines = [];
  let line = '';
  for (const ch of chars) {
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      lines.push(line);
      line = ch;
      if (lines.length >= maxLines - 1) break;
    } else {
      line += ch;
    }
  }
  if (lines.length < maxLines) lines.push(line);
  else if (line) lines[maxLines - 1] = (lines[maxLines - 1] || '') + '…';
  ctx.fillStyle = color || '#fff';
  lines.forEach((ln, i) => ctx.fillText(ln, x, y + i * lineHeight));
  return lines.length;
}

// 简笔画图标：统一线稿风格（圆头线、粗描边），按 key 画不同图案
function drawSketchIcon(ctx, key, cx, cy, s, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(5, s * 0.07);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const L = s / 2; // 半尺寸
  switch (key) {
    case 'fireRate': // 两个向右 chevron >>
      for (const off of [-s * 0.12, s * 0.12]) {
        ctx.beginPath();
        ctx.moveTo(cx - L * 0.5, cy - L * 0.6 + off);
        ctx.lineTo(cx + L * 0.25, cy + off);
        ctx.lineTo(cx - L * 0.5, cy + L * 0.6 + off);
        ctx.stroke();
      }
      break;
    case 'multiShot': // 扇形散开的圆点 + 发射点
      for (let i = 0; i < 3; i++) {
        const px = cx - L * 0.55 + i * L * 0.55;
        const py = cy - L * 0.55 + (i === 1 ? 0 : L * 0.55);
        ctx.beginPath();
        ctx.arc(px, py, s * 0.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath(); ctx.arc(cx - L * 0.7, cy + L * 0.1, s * 0.09, 0, Math.PI * 2); ctx.fill();
      break;
    case 'atk': // 向上的剑/箭头
      ctx.beginPath(); ctx.moveTo(cx, cy - L * 0.8); ctx.lineTo(cx, cy + L * 0.5); ctx.stroke();
      ctx.beginPath(); // 剑尖
      ctx.moveTo(cx, cy - L); ctx.lineTo(cx - L * 0.35, cy - L * 0.55);
      ctx.lineTo(cx + L * 0.35, cy - L * 0.55); ctx.closePath(); ctx.fill();
      ctx.beginPath(); // 护手
      ctx.moveTo(cx - L * 0.5, cy + L * 0.15); ctx.lineTo(cx + L * 0.5, cy + L * 0.15); ctx.stroke();
      break;
    case 'skillCost': // 硬币 + 向下箭头（消耗）
      ctx.beginPath(); ctx.arc(cx, cy - L * 0.1, L * 0.7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - L * 0.5); ctx.lineTo(cx, cy + L * 0.4);
      ctx.moveTo(cx - L * 0.3, cy + L * 0.1); ctx.lineTo(cx, cy + L * 0.4);
      ctx.lineTo(cx + L * 0.3, cy + L * 0.1);
      ctx.stroke();
      break;
    case 'skillDamage': // 星爆
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * L * 0.3, cy + Math.sin(a) * L * 0.3);
        ctx.lineTo(cx + Math.cos(a) * L * 0.85, cy + Math.sin(a) * L * 0.85);
        ctx.stroke();
      }
      break;
    case 'selfRepair': { // 十字
      const w = L * 0.28;
      ctx.beginPath();
      ctx.moveTo(cx - w, cy - L * 0.7); ctx.lineTo(cx + w, cy - L * 0.7);
      ctx.lineTo(cx + w, cy - w); ctx.lineTo(cx + L * 0.7, cy - w);
      ctx.lineTo(cx + L * 0.7, cy + w); ctx.lineTo(cx + w, cy + w);
      ctx.lineTo(cx + w, cy + L * 0.7); ctx.lineTo(cx - w, cy + L * 0.7);
      ctx.lineTo(cx - w, cy + w); ctx.lineTo(cx - L * 0.7, cy + w);
      ctx.lineTo(cx - L * 0.7, cy - w); ctx.lineTo(cx - w, cy - w);
      ctx.closePath(); ctx.stroke();
      break;
    }
    case 'hp': // 心形
      ctx.beginPath();
      ctx.moveTo(cx, cy + L * 0.6);
      ctx.bezierCurveTo(cx - L * 0.9, cy - L * 0.2, cx - L * 0.2, cy - L * 0.9, cx, cy - L * 0.3);
      ctx.bezierCurveTo(cx + L * 0.2, cy - L * 0.9, cx + L * 0.9, cy - L * 0.2, cx, cy + L * 0.6);
      ctx.stroke();
      break;
    case 'buddha': // 张开手掌
      ctx.beginPath(); ctx.arc(cx, cy + L * 0.55, L * 0.45, Math.PI, 0); ctx.stroke();
      for (let i = 0; i < 5; i++) {
        const fx = cx - L * 0.6 + i * (L * 1.2 / 4);
        ctx.beginPath();
        ctx.moveTo(cx + (fx - cx) * 0.4, cy + L * 0.3);
        ctx.lineTo(fx, cy - L * 0.7);
        ctx.stroke();
      }
      break;
    case 'lightsaber': // 横刃 + 剑尖 + 斜柄
      ctx.beginPath(); ctx.moveTo(cx - L * 0.8, cy); ctx.lineTo(cx + L * 0.5, cy); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + L * 0.5, cy); ctx.lineTo(cx + L * 0.25, cy - L * 0.2);
      ctx.moveTo(cx + L * 0.5, cy); ctx.lineTo(cx + L * 0.25, cy + L * 0.2);
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - L * 0.8, cy); ctx.lineTo(cx - L * 0.95, cy + L * 0.35); ctx.stroke();
      break;
    case 'scatterburst': { // 扇面放射线
      const n = 7;
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 3 + (i / (n - 1)) * (Math.PI * 2 / 3);
        ctx.beginPath();
        ctx.moveTo(cx - L * 0.5, cy);
        ctx.lineTo(cx - L * 0.5 + Math.cos(a) * L * 1.2, cy + Math.sin(a) * L * 1.2);
        ctx.stroke();
      }
      break;
    }
    default: // 兜底：实心圆点
      ctx.beginPath(); ctx.arc(cx, cy, L * 0.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function makeCardTexture(title, sub, color, iconKey) {
  // 竖版画布（aspect 256/456≈0.561 ≈ CARD.WIDTH/HEIGHT 0.4/0.71≈0.563，文字不会被拉伸）
  const W = 256, H = 456;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const x = cv.getContext('2d');
  x.fillStyle = '#1b1b2f'; x.fillRect(0, 0, W, H);
  x.strokeStyle = color; x.lineWidth = 8; x.strokeRect(6, 6, W - 12, H - 12);
  // 顶部简笔画图标
  drawSketchIcon(x, iconKey, W / 2, 150, 120, color);
  // 中部标题
  x.fillStyle = color; x.font = 'bold 30px sans-serif'; x.textAlign = 'center';
  x.fillText(title, W / 2, 300);
  // 底部说明（自动换行，最多 3 行）
  x.font = '22px sans-serif';
  wrapText(x, sub, W / 2, 350, W - 50, 30, 3, '#fff');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 创建「气球」（球体 + 细绳），作为一个 Group 便于整体移动
function makeBalloon(colorHex) {
  const g = new THREE.Group();
  const color = new THREE.Color(colorHex || '#ffffff');

  const sphereGeo = new THREE.SphereGeometry(CARD.BALLOON_R, 16, 12);
  const sphereMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, roughness: 0.4, metalness: 0.0 });
  const sphere = new THREE.Mesh(sphereGeo, sphereMat);
  g.add(sphere);

  // 细绳：从气球中心向下延伸（线长 = CARD.BALLOON_STRING_LEN，颜色随该卡选项卡变化），下端接卡牌
  const stringLen = CARD.BALLOON_STRING_LEN;
  const stringGeo = new THREE.CylinderGeometry(0.006, 0.006, stringLen, 6);
  const stringMat = new THREE.MeshStandardMaterial({ color: color, roughness: 0.9, emissive: color, emissiveIntensity: 0.3 });
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

  // 卡面统一由 canvas 程序化绘制（简笔画图标 + 文字），见 makeCardTexture / drawSketchIcon
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
    // 01/02 关卡片品质覆盖（来自 LEVEL_PLANS）：仅首次 open 注入，refresh 复用本对象
    this._rarity = state.rarity || null;
    this._forceAtkPurple = !!state.forceAttackPurple;
    this._guarantee = state.guarantee || null; // 01/02 关指定卡必出（multiShot / fireRate）
    this._buildCards();
  }

  _buildCards() {
    this._clearItems();
    this._clearLightFx();

    const picks = [];

    // 固定技能卡模式（第三关）：只出指定技能卡（红色），不随机、不出刷新卡
    if (this._state.fixedSkills && this._state.fixedSkills.length) {
      for (const id of this._state.fixedSkills) {
        const s = SKILL_CARDS.find(c => c.id === id);
        if (!s) continue;
        picks.push({ kind: 'skill', def: s, rarity: s.rarity, label: s.label, sub: s.desc, color: s.color, icon: s.icon || null });
      }
    } else {
      // 普通/Boss/机制关：从卡池抽 3 张不重复的属性卡（无刷新卡）
      const pool = (this._state.pool || ATTR_TYPES.map(a => a.id))
        .map(id => ATTR_TYPES.find(a => a.id === id))
        .filter(Boolean);
      let chosen;
      const g = this._guarantee;
      if (g && pool.some(a => a.id === g)) {
        // 保证卡必出：先固定该卡，再对剩余卡洗牌取 2 张（不重复）
        const rest = pool.filter(a => a.id !== g);
        for (let i = rest.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        chosen = [pool.find(a => a.id === g), ...rest.slice(0, Math.min(2, rest.length))];
      } else {
        // 洗牌取前 3（不重复）
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        chosen = pool.slice(0, Math.min(CARD.COUNT, pool.length));
      }
      for (const attr of chosen) {
        picks.push({
          kind: 'attr', def: attr, rarity: 'gold',
          label: attr.label, sub: attr.desc, color: attr.color, icon: attr.icon || null,
        });
      }
    }

    const N = picks.length;
    const startX = -((N - 1) * CARD.SPACING) / 2;
    picks.forEach((p, i) => {
      const x = startX + i * CARD.SPACING;

      // holder：把卡片 + 气球挂在一起，整体上下浮动，二者始终同步
      const holder = new THREE.Group();
      holder.position.set(x, CARD.ROW_Y, CARD.ROW_Z);
      this.group.add(holder);

      const card = this._makeCardMesh(p.label, p.sub, p.color, p.icon);
      card.position.set(0, 0, 0);
      holder.add(card);              // 必须先挂进 holder，world 坐标才正确
      card.lookAt(0, CARD.ROW_Y, 0); // 再朝向坐标原点（保持竖直可读，正面朝玩家）

      const balloon = makeBalloon(p.color);
      balloon.position.set(0, CARD.BALLOON_HEIGHT, 0); // 气球相对卡牌的高度（BALLOON_HEIGHT）
      holder.add(balloon);

      // 每张卡面都是独立 canvas 纹理，_clearItems 直接 dispose
      const item = {
        holder, card, balloon, pick: p,
        invincible: false, flying: false, flyVel: 0, exploded: false,
        locked: false, // 刷新卡已移除，所有卡均可击中
      };

      if (item.locked) {
        card.material.transparent = true; card.material.opacity = 0.35;
        this._setBalloonOpacity(item, 0.3);
      }

      this.items.push(item);
    });
  }

  _makeCardMesh(title, sub, color, iconKey) {
    // 卡面统一 canvas 绘制：简笔画图标 + 标题 + 说明（不再依赖 PNG）
    const tex = makeCardTexture(title, sub, color, iconKey);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD.WIDTH, CARD.HEIGHT),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true })
    );
    return mesh;
  }

  _clearItems() {
    for (const it of this.items) {
      this.group.remove(it.holder);
      it.card.geometry.dispose();
      // 每张卡面都是独立 canvas 纹理，直接释放（无共享复用）
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
      it.holder.position.y = CARD.ROW_Y + CARD.BALLOON_BOB * Math.sin(this.t * CARD.BALLOON_BOB_FREQ + i);
    }

    // 子弹 ↔ 卡气球 碰撞
    if (bullets && bullets.active) {
      for (const b of [...bullets.active]) {
        for (const it of this.items) {
          if (it.invincible || it.locked) continue; // 锁定的刷新气球不可击中
          // 气球世界坐标 = holder.position + 气球局部(0, BALLOON_HEIGHT, 0)
          const bx = it.holder.position.x;
          const by = it.holder.position.y + CARD.BALLOON_HEIGHT;
          const bz = it.holder.position.z;
          const dx = b.pos.x - bx;
          const dy = b.pos.y - by;
          const dz = b.pos.z - bz;
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
      const from = new THREE.Vector3(item.holder.position.x, item.holder.position.y + CARD.BALLOON_HEIGHT, item.holder.position.z);
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
    if (sel.pick.kind === 'attr') sel.pick.def.apply(this._state.player);
    else if (sel.pick.kind === 'skill') {
      sel.pick.def.apply(this._state.player);
      // 需要游戏上下文的技能（如来神掌/激光剑/散射强化），由外部回调执行
      if (this._state.onSkill) this._state.onSkill(sel.pick.def.id);
    }
    // 本局收集：记录所选卡 id，供第18关汇总展示
    if (this._state.onCollect) this._state.onCollect(sel.pick.def.id);

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

  // 中途清场（不拆除 group，可再次 open 复用）：供 Game.toMenu 清除残留抽卡气球
  clearCards() {
    this._clearItems();
    this._clearLightFx();
    this.group.visible = false;
  }

  dispose() {
    this._clearLightFx();
    this._clearItems();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}
