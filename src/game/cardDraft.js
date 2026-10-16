import * as THREE from 'three';
import { pointSegmentDistanceSq } from '../core/collision.js';
import { CARD, RARITY, SHOP } from '../core/constants.js';
import { ATTR_TYPES, SKILL_CARDS, RESUPPLY_CARD, availableAttributes, attributePreview } from '../content/cards.js';

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

// 从卡池选卡（不重复）。guarantee 支持「单个 id」或「id 数组」：
//   单卡（01/02 关）：池中有则必出，没有则退回随机（原语义不变）；
//   数组（第9关回血组）：取数组中第一张池中可用的；一张都不可用（已满级）时退化为战场补给卡，
//                       保证「一定有可回血的选项卡」。
export function pickCards(pool, guarantee, count = CARD.COUNT) {
  const ids = Array.isArray(guarantee) ? guarantee : (guarantee ? [guarantee] : []);
  let gCard = ids.length ? (pool.find(a => ids.includes(a.id)) || null) : null;
  if (!gCard && ids.length > 1) gCard = RESUPPLY_CARD;   // 组保证兜底：回血卡全部满级
  const rest = pool.filter(a => a.id !== (gCard ? gCard.id : ''));
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  if (gCard) return [gCard, ...rest.slice(0, Math.max(0, count - 1))];
  return rest.slice(0, Math.min(count, rest.length));
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
//   （导出给 enemyPortrait 用：盾甲兵的盾牌抓帧失败时，左下角画这枚「盾」简笔画兜底）
export function drawSketchIcon(ctx, key, cx, cy, s, color) {
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
    // ===== 商店关（第五十五修）道具 / 按钮图标 =====
    case 'dogOwner': { // 骨头（打狗还要看主人）
      const bw = L * 0.2;
      for (const off of [-L * 0.6, L * 0.6]) {
        for (const dy of [-bw, bw]) {
          ctx.beginPath(); ctx.arc(cx + off, cy + dy, bw, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.beginPath();
      ctx.moveTo(cx - L * 0.6, cy - bw); ctx.lineTo(cx + L * 0.6, cy + bw);
      ctx.moveTo(cx - L * 0.6, cy + bw); ctx.lineTo(cx + L * 0.6, cy - bw);
      ctx.lineWidth = Math.max(6, s * 0.08); ctx.stroke();
      break;
    }
    case 'warFeed': // 硬币 + 向上箭头（以战养战：打怪换钱）
      ctx.beginPath(); ctx.arc(cx, cy, L * 0.78, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy + L * 0.42); ctx.lineTo(cx, cy - L * 0.42);
      ctx.moveTo(cx - L * 0.3, cy - L * 0.12); ctx.lineTo(cx, cy - L * 0.42);
      ctx.lineTo(cx + L * 0.3, cy - L * 0.12);
      ctx.stroke();
      break;
    case 'candyString': // 三个圆串在一根签上（糖葫芦）
      ctx.beginPath(); ctx.moveTo(cx, cy - L * 0.95); ctx.lineTo(cx, cy + L * 0.95); ctx.stroke();
      for (const dy of [-L * 0.5, 0, L * 0.5]) {
        ctx.beginPath(); ctx.arc(cx, cy + dy, L * 0.26, 0, Math.PI * 2); ctx.fill();
      }
      break;
    case 'moreIsBetter': { // 一点发散出 3 条弹道（多才是王道）
      const n = 3;
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 5 + (i / (n - 1)) * (Math.PI * 2 / 5);
        const tx = cx - L * 0.55 + Math.cos(a) * L * 1.3;
        const ty = cy + Math.sin(a) * L * 1.3;
        ctx.beginPath(); ctx.moveTo(cx - L * 0.55, cy); ctx.lineTo(tx, ty); ctx.stroke();
        ctx.beginPath(); ctx.arc(tx, ty, L * 0.14, 0, Math.PI * 2); ctx.fill();
      }
      ctx.beginPath(); ctx.arc(cx - L * 0.55, cy, L * 0.16, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case 'lifesteal': // 水滴 + 十字（吸血子弹）
      ctx.beginPath();
      ctx.moveTo(cx, cy - L * 0.85);
      ctx.quadraticCurveTo(cx + L * 0.75, cy + L * 0.15, cx, cy + L * 0.75);
      ctx.quadraticCurveTo(cx - L * 0.75, cy + L * 0.15, cx, cy - L * 0.85);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - L * 0.05); ctx.lineTo(cx, cy + L * 0.45);
      ctx.moveTo(cx - L * 0.25, cy + L * 0.2); ctx.lineTo(cx + L * 0.25, cy + L * 0.2);
      ctx.lineWidth = Math.max(6, s * 0.08); ctx.stroke();
      break;
    case 'strongHunter': // 同心圆靶（专打强者）
      for (const r of [L * 0.85, L * 0.55, L * 0.25]) {
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(cx, cy, L * 0.08, 0, Math.PI * 2); ctx.fill();
      break;
    case 'refresh': // 环形箭头（刷新）
      ctx.beginPath(); ctx.arc(cx, cy, L * 0.68, -Math.PI * 0.35, Math.PI * 1.25); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + L * 0.68 * Math.cos(-Math.PI * 0.35), cy + L * 0.68 * Math.sin(-Math.PI * 0.35));
      ctx.lineTo(cx + L * 0.68 * Math.cos(-Math.PI * 0.35) - L * 0.34, cy + L * 0.68 * Math.sin(-Math.PI * 0.35) - L * 0.1);
      ctx.lineTo(cx + L * 0.68 * Math.cos(-Math.PI * 0.35) + L * 0.16, cy + L * 0.68 * Math.sin(-Math.PI * 0.35) - L * 0.36);
      ctx.closePath(); ctx.fill();
      break;
    case 'shopDone': // 对勾（购物完成）
      ctx.lineWidth = Math.max(8, s * 0.11);
      ctx.beginPath();
      ctx.moveTo(cx - L * 0.75, cy + L * 0.05);
      ctx.lineTo(cx - L * 0.2, cy + L * 0.6);
      ctx.lineTo(cx + L * 0.8, cy - L * 0.6);
      ctx.stroke();
      break;
    case 'skillCdDown': // 表盘 + 指针（技能冷却-）
      ctx.beginPath(); ctx.arc(cx, cy, L * 0.78, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - L * 0.5);
      ctx.moveTo(cx, cy); ctx.lineTo(cx + L * 0.42, cy + L * 0.2);
      ctx.stroke();
      break;
    // ===== 商店关 · 精英预告（第五十七修）图标 =====
    //   与局内出生光点同色系；每型一个能一眼认出的剪影（颜色由卡框色给，这里只画线稿）
    case 'eKnight': { // 铁甲兵：骑士头盔（盔顶弧 + 面罩收窄 + 三条面罩缝）
      ctx.beginPath();
      ctx.arc(cx, cy - L * 0.05, L * 0.5, Math.PI, 0);
      ctx.lineTo(cx + L * 0.5, cy + L * 0.1);
      ctx.lineTo(cx + L * 0.3, cy + L * 0.62);
      ctx.lineTo(cx - L * 0.3, cy + L * 0.62);
      ctx.lineTo(cx - L * 0.5, cy + L * 0.1);
      ctx.closePath(); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - L * 0.05); ctx.lineTo(cx, cy + L * 0.62);
      ctx.moveTo(cx - L * 0.42, cy + L * 0.2); ctx.lineTo(cx + L * 0.42, cy + L * 0.2);
      ctx.moveTo(cx - L * 0.34, cy + L * 0.43); ctx.lineTo(cx + L * 0.34, cy + L * 0.43);
      ctx.stroke();
      ctx.beginPath();                                    // 盔顶缨
      ctx.moveTo(cx - L * 0.18, cy - L * 0.48); ctx.lineTo(cx, cy - L * 0.95); ctx.lineTo(cx + L * 0.18, cy - L * 0.48);
      ctx.stroke();
      break;
    }
    case 'eShield': { // 盾甲兵：盾牌 + 盾内「自转」环形箭头（盾会绕身转、挡子弹）
      ctx.beginPath();
      ctx.moveTo(cx - L * 0.5, cy - L * 0.62); ctx.lineTo(cx + L * 0.5, cy - L * 0.62);
      ctx.lineTo(cx + L * 0.5, cy + L * 0.15);
      ctx.quadraticCurveTo(cx + L * 0.5, cy + L * 0.68, cx, cy + L * 0.92);
      ctx.quadraticCurveTo(cx - L * 0.5, cy + L * 0.68, cx - L * 0.5, cy + L * 0.15);
      ctx.closePath(); ctx.stroke();
      const sr = L * 0.26, sa0 = -Math.PI * 0.15, sa1 = Math.PI * 1.05, scy = cy + L * 0.06;
      ctx.beginPath(); ctx.arc(cx, scy, sr, sa0, sa1); ctx.stroke();
      const px = cx + sr * Math.cos(sa1), py = scy + sr * Math.sin(sa1);
      const tx = -Math.sin(sa1), ty = Math.cos(sa1);          // 顺时针切向
      const nx = Math.cos(sa1), ny = Math.sin(sa1);           // 径向
      ctx.beginPath();
      ctx.moveTo(px + tx * L * 0.26, py + ty * L * 0.26);
      ctx.lineTo(px + nx * L * 0.15, py + ny * L * 0.15);
      ctx.lineTo(px - nx * L * 0.15, py - ny * L * 0.15);
      ctx.closePath(); ctx.fill();
      break;
    }
    case 'eHealer': { // 治疗术士：心 + 十字
      ctx.beginPath();
      ctx.moveTo(cx, cy + L * 0.78);
      ctx.bezierCurveTo(cx - L * 1.0, cy - L * 0.12, cx - L * 0.22, cy - L * 0.95, cx, cy - L * 0.3);
      ctx.bezierCurveTo(cx + L * 0.22, cy - L * 0.95, cx + L * 1.0, cy - L * 0.12, cx, cy + L * 0.78);
      ctx.stroke();
      ctx.lineWidth = Math.max(6, s * 0.08);
      ctx.beginPath();
      ctx.moveTo(cx, cy - L * 0.45); ctx.lineTo(cx, cy + L * 0.3);
      ctx.moveTo(cx - L * 0.36, cy - L * 0.1); ctx.lineTo(cx + L * 0.36, cy - L * 0.1);
      ctx.stroke();
      break;
    }
    case 'eNinja': { // 忍者队长：蒙面头（护额横带 + 眼缝 + 飘带）
      ctx.beginPath(); ctx.ellipse(cx, cy + L * 0.08, L * 0.6, L * 0.68, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = Math.max(10, s * 0.12);
      ctx.beginPath(); ctx.moveTo(cx - L * 0.62, cy - L * 0.22); ctx.lineTo(cx + L * 0.6, cy - L * 0.22); ctx.stroke();
      ctx.lineWidth = Math.max(5, s * 0.07);
      ctx.beginPath();                                    // 头带右端两条飘带
      ctx.moveTo(cx + L * 0.56, cy - L * 0.22); ctx.lineTo(cx + L * 0.97, cy - L * 0.56);
      ctx.moveTo(cx + L * 0.56, cy - L * 0.22); ctx.lineTo(cx + L * 0.94, cy + L * 0.13);
      ctx.stroke();
      ctx.beginPath();                                    // 眼缝（横带下方两道短斜线）
      ctx.moveTo(cx - L * 0.42, cy + L * 0.12); ctx.lineTo(cx - L * 0.12, cy + L * 0.03);
      ctx.moveTo(cx + L * 0.12, cy + L * 0.03); ctx.lineTo(cx + L * 0.42, cy + L * 0.12);
      ctx.stroke();
      break;
    }
    case 'eGhost': { // 幽灵法师：幽灵轮廓 + 波浪下摆
      ctx.beginPath();
      ctx.arc(cx, cy - L * 0.25, L * 0.62, Math.PI, 0);
      ctx.lineTo(cx + L * 0.62, cy + L * 0.5);
      for (let i = 0; i < 3; i++) {
        const x0 = cx + L * 0.62 - (i * 2 + 1) * (L * 1.24 / 6);
        const x1 = x0 - (L * 1.24 / 6);
        ctx.quadraticCurveTo(x0 - L * 0.1, cy + L * 0.88, x1, cy + L * 0.5);
      }
      ctx.lineTo(cx - L * 0.62, cy - L * 0.25);
      ctx.closePath(); ctx.stroke();
      for (const dx of [-L * 0.24, L * 0.24]) {
        ctx.beginPath(); ctx.arc(cx + dx, cy - L * 0.32, L * 0.09, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case 'eOctopus': { // 章鱼将军：圆头 + 四条触手
      ctx.beginPath(); ctx.arc(cx, cy - L * 0.25, L * 0.6, Math.PI, 0); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - L * 0.6, cy - L * 0.25); ctx.lineTo(cx - L * 0.6, cy + L * 0.1);
      ctx.moveTo(cx + L * 0.6, cy - L * 0.25); ctx.lineTo(cx + L * 0.6, cy + L * 0.1);
      ctx.stroke();
      for (let i = 0; i < 4; i++) {
        const x0 = cx - L * 0.6 + i * (L * 1.2 / 3);
        ctx.beginPath();
        ctx.moveTo(x0, cy + L * 0.1);
        ctx.quadraticCurveTo(x0 + L * 0.16, cy + L * 0.55, x0 - L * 0.1, cy + L * 0.9);
        ctx.stroke();
      }
      for (const dx of [-L * 0.24, L * 0.24]) {
        ctx.beginPath(); ctx.arc(cx + dx, cy - L * 0.36, L * 0.09, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case 'bossFace': { // 脸谱 Boss：椭圆脸 + 粗眉 + 眼点 + 额心 + 嘴（脸谱的对称纹样）
      ctx.beginPath(); ctx.ellipse(cx, cy, L * 0.68, L * 0.88, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = Math.max(8, s * 0.1);
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + sx * L * 0.12, cy - L * 0.42);
        ctx.quadraticCurveTo(cx + sx * L * 0.58, cy - L * 0.5, cx + sx * L * 0.46, cy + L * 0.02);
        ctx.stroke();
      }
      ctx.lineWidth = Math.max(5, s * 0.07);
      for (const sx of [-1, 1]) {
        ctx.beginPath(); ctx.arc(cx + sx * L * 0.26, cy + L * 0.02, L * 0.09, 0, Math.PI * 2); ctx.fill();
      }
      ctx.beginPath();
      ctx.moveTo(cx, cy - L * 0.78); ctx.lineTo(cx, cy - L * 0.56);
      ctx.moveTo(cx - L * 0.2, cy + L * 0.5);
      ctx.quadraticCurveTo(cx, cy + L * 0.68, cx + L * 0.2, cy + L * 0.5);
      ctx.stroke();
      break;
    }
    case 'bossDragon': { // 龙 Boss：正面龙头（外扬双角 + 眼 + 獠牙 + 龙须）
      ctx.beginPath();                                    // 双角：从头顶向外上方扬出
      ctx.moveTo(cx - L * 0.42, cy - L * 0.4);
      ctx.quadraticCurveTo(cx - L * 0.78, cy - L * 0.66, cx - L * 0.96, cy - L * 0.95);
      ctx.moveTo(cx + L * 0.42, cy - L * 0.4);
      ctx.quadraticCurveTo(cx + L * 0.78, cy - L * 0.66, cx + L * 0.96, cy - L * 0.95);
      ctx.stroke();
      ctx.beginPath();                                    // 头轮廓（上宽下收）
      ctx.moveTo(cx - L * 0.6, cy - L * 0.44);
      ctx.quadraticCurveTo(cx, cy - L * 0.74, cx + L * 0.6, cy - L * 0.44);
      ctx.lineTo(cx + L * 0.42, cy + L * 0.3);
      ctx.quadraticCurveTo(cx, cy + L * 0.94, cx - L * 0.42, cy + L * 0.3);
      ctx.closePath(); ctx.stroke();
      ctx.beginPath();                                    // 龙须：从嘴角向外下垂
      ctx.moveTo(cx - L * 0.42, cy + L * 0.34);
      ctx.quadraticCurveTo(cx - L * 0.96, cy + L * 0.5, cx - L * 0.86, cy + L * 0.92);
      ctx.moveTo(cx + L * 0.42, cy + L * 0.34);
      ctx.quadraticCurveTo(cx + L * 0.96, cy + L * 0.5, cx + L * 0.86, cy + L * 0.92);
      ctx.stroke();
      for (const sx of [-1, 1]) {                         // 双眼
        ctx.beginPath(); ctx.arc(cx + sx * L * 0.26, cy - L * 0.18, L * 0.1, 0, Math.PI * 2); ctx.fill();
      }
      for (const sx of [-1, 1]) {                         // 鼻孔
        ctx.beginPath(); ctx.arc(cx + sx * L * 0.1, cy + L * 0.14, L * 0.055, 0, Math.PI * 2); ctx.fill();
      }
      ctx.beginPath();                                    // 嘴 + 两颗獠牙
      ctx.moveTo(cx - L * 0.34, cy + L * 0.36);
      ctx.quadraticCurveTo(cx, cy + L * 0.5, cx + L * 0.34, cy + L * 0.36);
      ctx.moveTo(cx - L * 0.28, cy + L * 0.4); ctx.lineTo(cx - L * 0.32, cy + L * 0.68);
      ctx.moveTo(cx + L * 0.28, cy + L * 0.4); ctx.lineTo(cx + L * 0.32, cy + L * 0.68);
      ctx.stroke();
      break;
    }
    case 'bossUnknown': { // 未知 Boss：问号
      ctx.beginPath(); ctx.arc(cx, cy - L * 0.4, L * 0.42, Math.PI * 0.9, Math.PI * 2.25); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + L * 0.05, cy - L * 0.05);
      ctx.quadraticCurveTo(cx - L * 0.05, cy + L * 0.35, cx, cy + L * 0.55);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy + L * 0.88, L * 0.11, 0, Math.PI * 2); ctx.fill();
      break;
    }
    default: // 兜底：实心圆点
      ctx.beginPath(); ctx.arc(cx, cy, L * 0.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// 立绘槽：商店「精英预告」卡的图区（第五十七修 v2）—— 图上、文字下。
// 三级回退：① 有立绘 → 画模型图；② placeholder（Boss 卡）→ 画大「?」；③ 都没有 → 画该卡的简笔画图标
//（精英立绘抓帧失败时走 ③：卡面仍能认出是谁，不会变成一张「?」的 Boss 卡）。
// 现场口径：精英**露模型**、Boss **不露脸**（只显示「未知」）。
function drawPortraitSlot(ctx, W, color, image, iconKey, placeholder, compact) {
  const X0 = 16, Y0 = 22, PW = W - 32, PH = compact ? 224 : 236;   // compact = 卡面底部还要放价位大字
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(X0, Y0, PW, PH);
  ctx.globalAlpha = 0.5;                       // 图区描边：比卡框淡一档，不与卡框抢眼
  ctx.strokeStyle = color; ctx.lineWidth = 3;
  ctx.strokeRect(X0 + 1.5, Y0 + 1.5, PW - 3, PH - 3);
  ctx.globalAlpha = 1;
  if (image && image.width && image.height) {
    const k = Math.min(PW / image.width, PH / image.height);   // contain：不裁切、不变形
    const w = image.width * k, h = image.height * k;
    ctx.drawImage(image, X0 + (PW - w) / 2, Y0 + (PH - h) / 2, w, h);
  } else if (placeholder) {
    ctx.fillStyle = color;
    ctx.font = 'bold 150px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(placeholder, W / 2, Y0 + PH / 2 + 4);
    ctx.textBaseline = 'alphabetic';
  } else {
    drawSketchIcon(ctx, iconKey, W / 2, Y0 + PH / 2, 120, color);
  }
  ctx.restore();
}

// 价位：金色大字（第五十八修 · 现场「价位换个容易区分的颜色，同时放大一倍」）。
// 字号 = 说明文字（22px）的两倍，画在卡面最底一行；免费价用绿色（见 SHOP.PRICE_FREE_COLOR）。
function drawPriceText(ctx, W, text, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = 'bold 44px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, W / 2, 430);
  ctx.restore();
}

// 牌子（第五十八修）—— 商店关的「商店币 / 倒计时」小横幅：平面贴图 + canvas 文字。
//   用法：const b = makeBadge(初始文字, 颜色) → { mesh, set(text, color?), text, dispose() }
//   位置 / 朝向由调用方摆（商店关：与两列卡同口径，平行于地面的 Z 线）。
//   set() 只在**文字或颜色真的变了**时重绘 canvas 并置 needsUpdate（每帧调也只上传一次贴图）。
//   画布 512×160（aspect 3.2）＝ SHOP.BADGE_W / SHOP.BADGE_H（1.44 × 0.45 m，第五十九修放大），文字不会被拉伸。
//   第三参 size = { w, h } 可覆盖物理尺寸（第六十四修：枪上的「商店币」小框用 0.24 × 0.075）。
//   字号**自适应**：牌子物理宽度固定，而文字长短差得多（「剩余 60s」vs「技能区 · 商店币 3250」）——
//   不缩就会溢出画布被裁掉，所以每次重绘都从 84px 起量宽、按 4px 递减到放得下为止。
export function makeBadge(text, color, size = null) {
  const W = 512, H = 160;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const x = cv.getContext('2d');
  let cur = null, curColor = null;
  // 自适应字号（见上）：量宽用当前字号，故先在循环里设 font 再量，退出时 font 恰等于返回的字号。
  const FONT_MAX = 84, FONT_MIN = 28, PAD = 22;
  const fitFont = (t) => {
    let size = FONT_MAX;
    for (;;) {
      x.font = 'bold ' + size + 'px sans-serif';
      if (x.measureText(t).width <= W - PAD * 2 || size <= FONT_MIN) break;
      size -= 4;
    }
    return size;
  };
  const paint = (t, c) => {
    x.clearRect(0, 0, W, H);
    const X0 = 6, Y0 = 6, PW = W - 12, PH = H - 12, R = 26;
    x.beginPath();
    x.moveTo(X0 + R, Y0);
    x.lineTo(X0 + PW - R, Y0);
    x.quadraticCurveTo(X0 + PW, Y0, X0 + PW, Y0 + R);
    x.lineTo(X0 + PW, Y0 + PH - R);
    x.quadraticCurveTo(X0 + PW, Y0 + PH, X0 + PW - R, Y0 + PH);
    x.lineTo(X0 + R, Y0 + PH);
    x.quadraticCurveTo(X0, Y0 + PH, X0, Y0 + PH - R);
    x.lineTo(X0, Y0 + R);
    x.quadraticCurveTo(X0, Y0, X0 + R, Y0);
    x.closePath();
    x.fillStyle = 'rgba(12,14,28,0.84)';
    x.fill();
    x.lineWidth = 8;
    x.strokeStyle = c;
    x.stroke();
    x.fillStyle = c;
    x.font = 'bold ' + fitFont(t) + 'px sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(t, W / 2, H / 2 + 4);
  };
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  // 第六十四修：物理尺寸可覆盖（枪上的「商店币」小框比商店区域牌子小一号）；
  //   画布仍是 512×160（宽高比 3.2）⇒ 传进来的 w/h 也要保持 3.2 才不会被拉伸。
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry((size && size.w) || SHOP.BADGE_W, (size && size.h) || SHOP.BADGE_H),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  const set = (t, c) => {
    const tt = String(t == null ? '' : t);
    const cc = c || curColor || color;
    if (tt === cur && cc === curColor) return false;   // 没变：不重绘、不重复上传贴图
    cur = tt; curColor = cc;
    paint(tt, cc);
    tex.needsUpdate = true;
    return true;
  };
  set(text, color);
  return {
    mesh,
    set,
    get text() { return cur; },
    dispose() { mesh.geometry.dispose(); mesh.material.dispose(); tex.dispose(); },
  };
}

/**
 * 画一张卡面贴图。
 * @param {object} [opts] `{ portrait: boolean, image: CanvasImageSource|null, placeholder: string }`
 *   opts.portrait = true → 立绘版式（图区在上、文案下移）；不传则维持原「简笔画图标」版式。
 */
// 标题自适应字号（第六十三修）：立绘版式标题固定 30px 且**不换行**，而画布只有 256 宽（内边 ~236）。
//   现场把第 18 关 Boss 三张卡名从「未知 Boss ①」改成「未知 Boss 阶段一」⇒ 量出来会顶到卡框，
//   故**超宽才**逐档缩到放得下（短名如「铁甲兵」「龙 Boss」字号一点不动，版式不变）。
//   量宽要用当前字号，所以先在循环里设 font，退出时 font 恰等于返回的字号。
export const TITLE_MAX_W = 220, TITLE_FONT_MAX = 30, TITLE_FONT_MIN = 20;
export function titleFont(x, title) {
  let size = TITLE_FONT_MAX;
  for (;;) {
    x.font = 'bold ' + size + 'px sans-serif';
    if (x.measureText(String(title)).width <= TITLE_MAX_W || size <= TITLE_FONT_MIN) break;
    size -= 2;
  }
  return size;
}

export function makeCardTexture(title, sub, color, iconKey, opts = {}) {
  // 竖版画布（aspect 256/456≈0.561 ≈ CARD.WIDTH/HEIGHT 0.4/0.71≈0.563，文字不会被拉伸）
  const W = 256, H = 456;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const x = cv.getContext('2d');
  x.fillStyle = '#1b1b2f'; x.fillRect(0, 0, W, H);
  x.strokeStyle = color; x.lineWidth = 8; x.strokeRect(6, 6, W - 12, H - 12);
  // 第五十八修：带价位（商店卡）→ 版式整体上移一档，把底部让给放大一倍的价位大字
  const priced = !!opts.price;
  let titleY, subY;
  if (opts.portrait) {
    // 立绘版式：图区 + 标题 + 文案
    // 第五十九修：精英预告卡文案较长（现场「有些信息没有显示完全」）→ 字号 22 → 20、行数 3 → 4、行距 30 → 25；
    //   4 行末行 y = 330 + 3×25 = 405，仍在卡框内边（450）以内。图区 / 标题位置不动。
    titleY = priced ? 288 : 296;
    subY = priced ? 320 : 330;
    drawPortraitSlot(x, W, color, opts.image, iconKey, opts.placeholder, priced);
    x.fillStyle = color; x.textAlign = 'center';
    x.font = 'bold ' + titleFont(x, title) + 'px sans-serif';
    x.fillText(title, W / 2, titleY);
    x.font = (priced ? 22 : 20) + 'px sans-serif';
    wrapText(x, sub, W / 2, subY, W - 44, priced ? 28 : 25, priced ? 3 : 4, '#fff');
  } else {
    // 顶部简笔画图标（带价位时缩小一档上移，给底部价位让位）
    drawSketchIcon(x, iconKey, W / 2, priced ? 138 : 150, priced ? 110 : 120, color);
    // 中部标题
    x.fillStyle = color; x.textAlign = 'center';
    x.font = 'bold ' + titleFont(x, title) + 'px sans-serif';
    titleY = priced ? 288 : 300;
    subY = priced ? 320 : 350;
    x.fillText(title, W / 2, titleY);
    // 底部说明（自动换行，最多 3 行）
    x.font = '22px sans-serif';
    wrapText(x, sub, W / 2, subY, W - 50, priced ? 28 : 30, 3, '#fff');
  }
  if (priced) drawPriceText(x, W, opts.price, opts.priceColor || color);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 创建「气球」（球体 + 细绳），作为一个 Group 便于整体移动
export function makeBalloon(colorHex) {
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
    // 第六十修：卡片存在时长可由外部覆盖（教学关的单张教学卡 12s 自动获得，见 content/tutorial.js）
    this.timer = (Number.isFinite(state.duration) && state.duration > 0) ? state.duration : CARD.DURATION;
    this.refreshCost = CARD.REFRESH_BASE_COST;
    this.resolving = false;
    this.resolveT = 0;
    this.selected = null;
    this._clearLightFx();
    this.onDone = onDone;
    // 01/02 关卡片品质覆盖（来自 LEVEL_PLANS）：仅首次 open 注入，refresh 复用本对象
    this._rarity = state.rarity || null;
    this._forceAtkPurple = !!state.forceAttackPurple;
    this._guarantee = state.guarantee || null; // 必出卡：字符串（01/02 关 multiShot / fireRate）或数组（第9关回血组）
    this._buildCards();
  }

  _buildCards() {
    this._clearItems();
    this._clearLightFx();

    const picks = [];

    // 显式卡表（第六十修 · 教学关）：状态里直接给卡定义，不查池也不随机 ——
    //   教学关要一张固定文案的「连杀加速」教学卡，它不是成长项（apply 为空，见 game._enterTutorialCard）。
    if (Array.isArray(this._state.cards) && this._state.cards.length) {
      for (const c of this._state.cards) {
        picks.push({
          kind: c.kind || 'attr', def: c, rarity: c.rarity || 'gold',
          label: c.label, sub: c.desc || '', color: c.color, icon: c.icon || null,
        });
      }
    } else if (this._state.fixedSkills && this._state.fixedSkills.length) {
      // 固定技能卡模式（第三关）：只出指定技能卡（红色），不随机、不出刷新卡
      for (const id of this._state.fixedSkills) {
        const s = SKILL_CARDS.find(c => c.id === id);
        if (!s) continue;
        picks.push({ kind: 'skill', def: s, rarity: s.rarity, label: s.label, sub: s.desc, color: s.color, icon: s.icon || null });
      }
    } else {
      // 普通/Boss/机制关：从卡池抽 3 张不重复的属性卡（无刷新卡）
      const pool = availableAttributes(this._state.player, this._state.pool || undefined, !!this._state.strictPool);
      const chosen = pickCards(pool, this._guarantee);   // 必出卡优先（支持单卡 / 数组）
      for (const attr of chosen) {
        picks.push({
          kind: 'attr', def: attr, rarity: 'gold',
          label: attr.label, sub: attributePreview(attr, this._state.player), color: attr.color, icon: attr.icon || null,
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
      holder.scale.setScalar(CARD.DRAFT_SCALE);   // 第五十八修：选项卡放大 1.5 倍（卡面与气球一起缩放，细绳不脱节）
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
      it.holder.position.y = CARD.ROW_Y + CARD.BALLOON_BOB * CARD.DRAFT_SCALE * Math.sin(this.t * CARD.BALLOON_BOB_FREQ + i);
    }

    // 子弹 ↔ 卡气球 碰撞
    if (bullets && bullets.active) {
      for (const b of [...bullets.active]) {
        for (const it of this.items) {
          if (it.invincible || it.locked) continue; // 锁定的刷新气球不可击中
          // 气球世界坐标 = holder.position + 气球局部(0, BALLOON_HEIGHT, 0)
          const bx = it.holder.position.x;
          const by = it.holder.position.y + CARD.BALLOON_HEIGHT * CARD.DRAFT_SCALE;
          const bz = it.holder.position.z;
          if (pointSegmentDistanceSq({ x: bx, y: by, z: bz }, b.prevPos || b.pos, b.pos) < ((CARD.BALLOON_R + 0.12) * CARD.DRAFT_SCALE) ** 2) {
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
      const from = new THREE.Vector3(item.holder.position.x, item.holder.position.y + CARD.BALLOON_HEIGHT * CARD.DRAFT_SCALE, item.holder.position.z);
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
