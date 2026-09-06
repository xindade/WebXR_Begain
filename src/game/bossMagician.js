// 第18关 · 魔术师 Boss 控制器
// 阶段循环：开场(0-10s, 正前30m播动画) → 激光(11-20s, 正前30m) → 玻璃墙(21-30s, 闪现左边30m) → 九宫格(31-40s, 闪现右边30m) → A→B→C…
// 血量动态 = HP_BASE + 玩家DPS × HP_DPS_SEC；Boss 代理气球受击即扣血，血空触发通关。
// 复用 glbCache 加载「魔术师动画版」GLB 并循环播放内嵌动画（常驻，不自动消失）；
// 视觉模型与命中代理解耦：代理气球(balloons.list) 只做命中靶子，模型独立动画 + 每帧同步位置。
import * as THREE from 'three';
import { MAGICIAN_BOSS } from '../core/constants.js';
import { ELITE_BASE_HP } from '../content/eliteMonsters.js';
import { loadGLB, cloneGLBScene } from './glbCache.js';
import { BossLaserGroup } from './bossLaserGroup.js';
import { BossGlassWall } from './bossGlassWall.js';
import { BossNineGrid } from './bossNineGrid.js';
import { BossHealthBar3D } from './bossHealthBar.js'; // Boss 头顶 3D 血条（sprite 自动面向相机）
import { WinBanner3D } from './winBanner.js';        // Boss 死亡后 VR 横幅（锚定准星、10s 后自动退出，见 winBanner.js）

const D2R = Math.PI / 180; // 度→弧度（MODEL_ROTATION 用度标注）
const WIN_BANNER_TEXT = '邪恶魔术师终于死了\n你成功拯救了公主'; // Boss 死亡 3D 横幅文案（双行）

export class MagicianBoss {
  constructor(waves) {
    this.waves = waves;
    this.scene = waves.scene;
    this.balloons = waves.balloons;
    this.getPlayerPos = waves.getPlayerPos;
    this.getPlayerDPS = waves.getPlayerDPS;
    this.damagePlayer = waves.damagePlayer || (() => {});
    this.spawn = (type, pos, opts) => waves._queueSpawn(type, pos, opts);

    this.phase = 'intro';      // intro | laser | glass | nine
    this.phaseTimer = 0;
    this._proxy = null;
    this._modelRoot = null;
    this._mixer = null;
    this._laser = null;
    this._glass = null;
    this._nine = null;
    this._disposed = false;
    this._eliteQueue = [];                       // 精英分帧消费队列（错峰，防同帧重度 GLB 解码卡死）
    this._hpBar = null;                          // Boss 头顶 3D 血条（代理落地后创建）
    this._tmpV = new THREE.Vector3();            // 血条定位临时量

    this._spawnProxy();
    this._loadModel();
  }

  _spawnProxy() {
    const pos = new THREE.Vector3(...MAGICIAN_BOSS.POSITIONS[0]);
    this.spawn('basic', pos, {
      onSpawn: (b) => {
        const hp = MAGICIAN_BOSS.HP_BASE + (this.getPlayerDPS ? this.getPlayerDPS() : 0) * MAGICIAN_BOSS.HP_DPS_SEC;
        b.maxHp = hp; b.hp = hp;
        b.isBoss = true;
        b.controlled = true;     // 由本控制器逐帧接管位置
        b.damageReduction = 0;   // 直接命中即全额扣血
        b.radius = MAGICIAN_BOSS.PROXY_RADIUS;
        b.effectiveRadius = MAGICIAN_BOSS.PROXY_RADIUS;
        b.hitRadius = MAGICIAN_BOSS.PROXY_RADIUS;
        b.score = 2000;
        b.mesh.scale.setScalar(1);
        b.mesh.visible = false; // 隐藏整个代理子树（最外层球 + 占位胶囊/眼睛/名牌子网格），避免 Boss 脚下出现"可见基础小怪"
        this._proxy = b;
        this.waves.bossSpawned = true;   // 落地即置位（防飞行期 cleared 误判）
        if (!this._hpBar) this._hpBar = new BossHealthBar3D(this.scene); // Boss 头顶 3D 血条
      },
    });
  }

  _loadModel() {
    loadGLB(MAGICIAN_BOSS.MODEL)
      .then((gltf) => {
        if (this._disposed) return;
        this._modelRoot = cloneGLBScene(gltf);
        this._modelRoot.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(this._modelRoot);
        const size = box.getSize(new THREE.Vector3());
        // 缩放：先算「2m 基准缩放」(SCALE/size.y)，再 ×MODEL_SCALE(10) → 最终放大 10 倍(20m)
        const baseScale = size.y > 0 ? MAGICIAN_BOSS.SCALE / size.y : 1;
        const s = baseScale * MAGICIAN_BOSS.MODEL_SCALE;
        this._modelRoot.scale.setScalar(s);
        // 三轴旋转（度→弧度）与相对代理的偏移（米），均集中在 constants.MAGICIAN_BOSS
        const rot = MAGICIAN_BOSS.MODEL_ROTATION;
        this._modelRoot.rotation.set(rot.x * D2R, rot.y * D2R, rot.z * D2R);
        const off = MAGICIAN_BOSS.MODEL_POSITION;
        const p0 = MAGICIAN_BOSS.POSITIONS[0];
        this._modelRoot.position.set(p0[0] + off.x, p0[1] + off.y, p0[2] + off.z);
        this.scene.add(this._modelRoot);
        if (gltf.animations && gltf.animations.length) {
          this._mixer = new THREE.AnimationMixer(this._modelRoot);
          const action = this._mixer.clipAction(gltf.animations[0]);
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.play();
        }
      })
      .catch((e) => console.warn('[MagicianBoss] 模型加载失败:', e));
  }

  update(dt) {
    if (this._disposed) return;
    if (this._mixer) this._mixer.update(dt);
    if (this._modelRoot && this._proxy && this._proxy.alive) {
      const off = MAGICIAN_BOSS.MODEL_POSITION;
      this._modelRoot.position.set(
        this._proxy.mesh.position.x + off.x,
        this._proxy.mesh.position.y + off.y,
        this._proxy.mesh.position.z + off.z
      );
    }
    // 分帧消费精英队列（错峰，防同帧多个重型 GLB 解码卡死主线程）
    if (this._eliteQueue.length) this._drainEliteQueue();
    // Boss 头顶 3D 血条：跟随代理位置（头顶上方）+ 实时血量
    if (this._hpBar && this._proxy && this._proxy.alive) {
      this._hpBar.update(this._proxy.hp, this._proxy.maxHp);
      this._hpBar.setPosition(
        this._tmpV.copy(this._proxy.mesh.position).setY(this._proxy.mesh.position.y + MAGICIAN_BOSS.HP_BAR_OFFSET_Y)
      );
    }
    // 通关判定：代理死亡或被移除
    if (!this._proxy || !this._proxy.alive || !this.balloons.list.includes(this._proxy)) {
      this._win();
      return;
    }

    this.phaseTimer += dt;
    const P = MAGICIAN_BOSS.PHASE;
    if (this.phase === 'intro') {
      if (this.phaseTimer >= P.INTRO) this._enterPhase('laser');
    } else if (this.phase === 'laser') {
      if (this._laser) this._laser.update(dt);
      if (this.phaseTimer >= P.LASER) this._enterPhase('glass');
    } else if (this.phase === 'glass') {
      if (this._glass) this._glass.update(dt);
      if (this.phaseTimer >= P.GLASS) this._enterPhase('nine');
    } else if (this.phase === 'nine') {
      if (this._nine) this._nine.update(dt);
      if (this.phaseTimer >= P.NINE) this._enterPhase('laser'); // 循环 A→B→C
    }
  }

  _enterPhase(phase) {
    this._clearPhaseSystems();
    this.phase = phase;
    this.phaseTimer = 0;
    const idx = phase === 'glass' ? 1 : phase === 'nine' ? 2 : 0;
    if (this._proxy && this._proxy.alive) this._proxy.mesh.position.set(...MAGICIAN_BOSS.POSITIONS[idx]);

    if (phase === 'laser') {
      if (this._modelRoot) this._modelRoot.rotation.y = 0;            // 回正前：复位朝向
      this._laser = new BossLaserGroup(this.scene, this.getPlayerPos, this.damagePlayer, MAGICIAN_BOSS.LASER_GROUP);
      if (MAGICIAN_BOSS.SPAWN_ENEMIES) this._summonElites(MAGICIAN_BOSS.ELITE_TYPES_LASER, MAGICIAN_BOSS.ELITE_COUNT_LASER);
    } else if (phase === 'glass') {
      if (this._modelRoot) this._modelRoot.rotation.y = Math.PI / 2;  // 向左闪现：Y 正向 +90°（头朝玩家）
      this._glass = new BossGlassWall(
        this.scene, this._proxy.mesh.position, this.getPlayerPos(),
        (dmg) => { if (this._proxy && this._proxy.alive) this._proxy.takeDamage(dmg); }
      );
      this.waves.magicianGlassWall = this._glass; // 供 game.js 子弹钩子拦截
      if (MAGICIAN_BOSS.SPAWN_ENEMIES) this._summonElites(MAGICIAN_BOSS.ELITE_TYPES_GLASS, MAGICIAN_BOSS.ELITE_COUNT_GLASS);
    } else if (phase === 'nine') {
      if (this._modelRoot) this._modelRoot.rotation.y = -Math.PI / 2; // 向右闪现：Y 反向 -90°（头朝玩家）
      this._nine = new BossNineGrid(this.scene, this.balloons, this.getPlayerPos, this.damagePlayer, this._proxy.mesh.position);
      if (MAGICIAN_BOSS.SPAWN_ENEMIES) this._summonElites(MAGICIAN_BOSS.ELITE_TYPES_NINE, MAGICIAN_BOSS.ELITE_COUNT_NINE);
    }
  }

  _clearPhaseSystems() {
    if (this._laser) { this._laser.dispose(); this._laser = null; }
    if (this._glass) { this._glass.dispose(); this._glass = null; }
    if (this._nine) { this._nine.dispose(); this._nine = null; }
    this.waves.magicianGlassWall = null;
  }

  // 将本阶段精英推入分帧队列（错峰消费，避免同帧多个重型 GLB 解码卡死主线程）
  //   types: 本阶段精英种类数组（每阶段 2 种）；count: 每种数量
  _summonElites(types, count) {
    const base = this._proxy ? this._proxy.mesh.position : new THREE.Vector3(0, 2, -30);
    for (const type of types) {
      const hp = ELITE_BASE_HP[type] != null ? ELITE_BASE_HP[type] : 500;
      for (let k = 0; k < count; k++) {
        const ang = Math.random() * Math.PI * 2;
        const r = 14 + Math.random() * 4;
        const pos = new THREE.Vector3(
          base.x + Math.cos(ang) * r,
          1 + Math.random() * 2,
          base.z + Math.sin(ang) * r
        );
        this._eliteQueue.push({ type, pos, hp });
      }
    }
  }

  // 每帧最多消费 N 只精英，把 GLB 解码摊到多帧（关键防卡死）；单只失败不影响其余
  _drainEliteQueue() {
    const MAX_PER_FRAME = 2;
    let n = 0;
    while (this._eliteQueue.length && n < MAX_PER_FRAME) {
      const item = this._eliteQueue.shift();
      try {
        this.spawn(item.type, item.pos, {
          onSpawn: (b) => {
            b.maxHp = item.hp; b.hp = item.hp;
            b.isElite = true;
          },
        });
      } catch (e) {
        console.warn('[MagicianBoss] 精英召唤失败:', item.type, e);
      }
      n++;
    }
  }

  // —— 已移除外圈基础怪：Boss 战不应出现基础怪（用户实测反馈）——
  _win() {
    if (this._disposed) return;
    this.dispose();
    this.waves.cleared = true; // 标记通关（供 game 判定），但第18关走自定义横幅+10s退出，不进抽卡
    // VR 可见通关横幅：锚定玩家准星、10s 后自动退出游戏（DOM hud.message 在头显里不可见）
    if (this.scene && this.waves.camera) {
      const banner = new WinBanner3D(this.scene, this.waves.camera, WIN_BANNER_TEXT, () => {
        if (this.waves._winBanner) { this.waves._winBanner.dispose(); this.waves._winBanner = null; }
        if (this.waves.onWinExit) this.waves.onWinExit();
      });
      this.waves._winBanner = banner; // 交 waves/game 在切关或 10s 到期时清理
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._clearPhaseSystems();
    if (this._modelRoot) { this.scene.remove(this._modelRoot); this._modelRoot = null; }
    if (this._mixer) { try { this._mixer.stopAllAction(); } catch (e) { /* ignore */ } this._mixer = null; }
    if (this._hpBar) { this._hpBar.dispose(); this._hpBar = null; }
    this._eliteQueue.length = 0;
    // 外圈小怪 / 精英由 balloons 统一管理，切关时整体清空；此处不单独移除
    this.waves.magicianGlassWall = null;
  }
}
