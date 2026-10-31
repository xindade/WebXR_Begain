import * as THREE from 'three';
import { CHARACTERS } from '../../core/constants.js';
import { bombardState, rayHitsBalloon, raySphereExitDistance, BOMBARD_AIRBURST } from './rules.js';

const _base = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _axis = new THREE.Vector3(0, 1, 0);
const D2R = Math.PI / 180;

/**
 * 第八十五修 · 爆炮手。
 *
 * 主炮固定 1 枚爆裂火箭；卡牌/调试追加的弹道全部转化为微型火箭。
 * 主炮与微型火箭都从同一枪口射出，微型火箭在 ±FAN_DEG 的窄扇形内铺开。
 * 命中结算由 game._collide 识别 bullet.blastRadius 后统一做 AoE，避免直伤与爆炸重复。
 */
export class BombardRig {
  constructor(cfg = CHARACTERS.bombard.bombard) {
    this.cfg = cfg;
  }

  state(player) {
    return bombardState(player?.shotCount || 1, player?.bonusShotCount || 0, this.cfg);
  }

  /** 返回本枪实际打出的火箭数（主炮 + 微型火箭）。 */
  fire(game, shot, boost, palmDamageMul = 1) {
    const p = game.player;
    if (!p || !shot) return 0;
    const st = this.state(p);
    const mul = Number.isFinite(palmDamageMul) ? palmDamageMul : 1;
    const atk = p.atk || 100;
    // 第八十七修：专属道具「再大一点」= 爆炸范围翻倍（只作用于爆炮手）。
    const blastMul = (game._itemLevel && game._itemLevel('blastPlus') > 0) ? 2 : 1;
    // 第八十九修：先沿弹道探测有没有敌人；有 → 不提前爆（10m 外的怪也能打到）；
    //   没有 → 在「距场地中心 8m」处自动空爆。
    const airburstOn = !!(game._bombardAirburst && p.characterKey === 'bombard');
    const airburstFor = (dir) => {
      if (!airburstOn) return 0;
      if (rayHitsBalloon(shot.position, dir, game.balloons?.list, BOMBARD_AIRBURST.MAX_SCAN)) return 0;
      return raySphereExitDistance(shot.position, dir, { x: 0, y: 0, z: 0 }, BOMBARD_AIRBURST.RADIUS);
    };
    game.audio?.playRocket?.();
    const shared = {
      tint: this.cfg.ROCKET_TINT,
      trailMul: this.cfg.TRAIL_MUL,
      rocket: true,
      speed: this.cfg.SPEED,
    };
    _base.copy(shot.direction);
    if (_base.lengthSq() < 1e-9) _base.set(0, 0, -1);
    else _base.normalize();

    // 主炮：100% 攻击力、默认 7.5m 爆炸半径（道具可再翻倍）。
    game.bullets.spawn(shot.position, _base, atk * mul, boost, {
      ...shared,
      airburst: airburstFor(_base),
      scale: this.cfg.MAIN_SCALE,
      blastRadius: this.cfg.MAIN_RADIUS * blastMul,
      blastEdge: this.cfg.MAIN_EDGE_FALLOFF,
    });

    // 微型火箭：从枪口沿 ±FAN_DEG 扇形齐射，避免全部叠在一条线上。
    for (let i = 0; i < st.count; i++) {
      const t = st.count <= 1 ? 0 : (i / (st.count - 1)) * 2 - 1;
      const theta = t * (this.cfg.FAN_DEG || 0) * D2R;
      _dir.copy(_base).applyAxisAngle(_axis, theta);
      game.bullets.spawn(shot.position, _dir, atk * st.dmgMul * mul, boost, {
        ...shared,
        airburst: airburstFor(_dir),
        scale: this.cfg.EXTRA_SCALE,
        blastRadius: this.cfg.EXTRA_RADIUS * blastMul,
        blastEdge: this.cfg.EXTRA_EDGE_FALLOFF,
      });
    }
    return 1 + st.count;
  }
}
