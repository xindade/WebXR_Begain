import { BUDDHA } from '../core/constants.js';

/**
 * 第八十四修 · 如来神掌初始横扫伤害。
 *
 * 口径：
 *   · 基础 350，技能倍率最多算到 DAMAGE_MUL_CAP（默认 3）。
 *   · 普通怪吃全额；精英 ×ELITE_MUL；Boss / 龙部件 ×BOSS_MUL。
 *
 * 这样后期基础怪（约 1000 血）在技能满级时仍能被一掌清掉，
 * 但精英与 Boss 不会因为技能倍率叠加而被顺带秒杀。
 *
 * @param {{isElite?:boolean,isBoss?:boolean,isDragonPart?:boolean}|null} target
 * @param {number} skillMul 玩家技能伤害倍率
 * @param {typeof BUDDHA} cfg
 * @returns {number}
 */
export function buddhaSweepDamage(target, skillMul, cfg = BUDDHA) {
  const cap = Number.isFinite(cfg.DAMAGE_MUL_CAP) ? cfg.DAMAGE_MUL_CAP : Infinity;
  const rawMul = Number.isFinite(skillMul) ? skillMul : 1;
  const mul = Math.min(Math.max(1, rawMul), cap);
  let dmg = (Number(cfg.DAMAGE) || 0) * mul;
  if (target && (target.isBoss || target.isDragonPart)) dmg *= (cfg.BOSS_MUL ?? 1);
  else if (target && target.isElite) dmg *= (cfg.ELITE_MUL ?? 1);
  return dmg;
}
