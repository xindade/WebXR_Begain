import * as THREE from 'three';
import { loadGLB, cloneGLBScene } from '../game/glbCache.js';
import { GUN, GUN_MODES, INPUT, SKILL_HINT, SHOP_COIN } from '../core/constants.js';
import { SkillHintPanel } from './skillHint.js';
import { StreakCounter } from './streakCounter.js';   // 第四十二修：枪管连杀计数
import { ShopCoinBadge } from './shopCoinBadge.js';   // 第六十四修：枪上「商店币」小信息框（只在商店关显示）

// 右手柄 AK 枪模型：加载 Ak枪.glb → 幂等挂到右手柄(grip) → 每帧从 GUN 配置应用变换
// 纯视觉叠加，不影响射击/碰撞/血量逻辑。
// 设计参考 wrist-ui.js 的 attach(input) 幂等挂载模式：模型异步加载、控制器连接前
// getGrip('right') 为 null，故每帧尝试挂载，挂上后置 _attached 跳过。

const D2R = THREE.MathUtils.degToRad;

export class RightGun {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();   // 持有层：GUN 变换作用在此层（模型作为子节点）
    this.model = null;               // 加载完成的 gltf.scene
    this._attached = false;          // 是否已挂到右手柄（幂等）
    this._recoilZ = 0;               // 当前后坐力：沿本地 +Z 后退位移（米）
    this._recoilPitch = 0;           // 当前后坐力：绕本地 X 上抬角（弧度，枪口跳）
    this._lastShots = 0;             // 上一帧记录的开火计数（用于检测本帧新开了几枪）
    this.skillHint = new SkillHintPanel();  // 技能就绪提示面板（右手枪中央，红框闪3下）
    this.coinBadge = SHOP_COIN.ENABLED ? new ShopCoinBadge() : null;  // 第六十四修：枪上商店币小框
    this.streak = new StreakCounter();      // 枪管连杀计数（第四十二修，纯视觉）
    this._load();
  }

  // 异步加载模型（GLTFLoader 回调式）；Ak枪.glb 用了 KHR_draco_mesh_compression，
  // 故挂上本地离线 DRACOLoader（解码器文件在 vendor/draco/）。失败放红色线框占位。
  _load() {
    loadGLB(GUN.MODEL_URL).then(
      (gltf) => {
        this.model = cloneGLBScene(gltf);
        this.root.add(this.model);
        this.streak.attach(this.root);       // 连杀计数：挂到枪的持有层
        this.streak.place(this.model);       // 按模型包围盒自动标定到枪管上（第四十二修）
        window.__pageLog?.info('[RightGun] AK 枪模型加载完成');
      },
      (err) => {
        console.error('[RightGun] 模型加载失败:', err);
        this.streak.attach(this.root);       // 模型挂了也把计数挂上（place 会走固定枪管位兜底）
        window.__pageLog?.error('[RightGun] AK 枪加载失败：' + (err?.message || err));
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(0.1, 0.1, 0.4),
          new THREE.MeshBasicMaterial({ color: 0xff3333, wireframe: true })
        );
        this.root.add(box);
      }
    );
  }

  // 每帧调用：幂等挂到右手柄，并从 GUN 配置实时应用变换（便于控制台/刷新即时调参）
  update(dt, input, game) {
    this._applyTransform();
    this._applyRecoil(dt, input);
    const hand = input?.shootingHand || 'right';
    const anchor = input?.getGrip(INPUT.SWAP_HANDS ? (hand === 'right' ? 'left' : 'right') : hand);
    if (anchor) {
      if (this.root.parent !== anchor) { anchor.add(this.root); this._attached = true; }
      this.skillHint.attach(anchor);          // 幂等：挂到右手柄(grip)
      // 第六十一修：技能框按**枪模型**自动定位到枪身中间偏左。
      //   手填 grip 坐标必然飘到枪上方 —— 枪整把在 GUN.POSITION.y = -0.25（手腕下方 25cm）。
      //   模型没就绪 → 回落到 SKILL_HINT.POSITION（只改 position，ROTATION 沿用构造里的值）。
      //   SKILL_HINT.DEBUG 打开时跳过（让 debugMove 的摇杆微调说了算）。
      if (!SKILL_HINT.DEBUG) {
        if (!this.skillHint.placeOnGun(this.model, this.root)) {
          const P0 = SKILL_HINT.POSITION;
          this.skillHint.mesh.position.set(P0.x, P0.y, P0.z);
        }
        // 第六十四修：商店币小框与信息框**同源定位**（同一套 barrelMount，只是 ALONG / LATERAL_GAP 不同）
        if (this.coinBadge) {
          this.coinBadge.attach(anchor);
          if (!this.coinBadge.placeOnGun(this.model, this.root)) {
            const C0 = SHOP_COIN.POSITION;
            this.coinBadge.mesh.position.set(C0.x, C0.y, C0.z);
          }
        }
      }
    }
    if (SKILL_HINT.DEBUG && input) this.skillHint.debugMove(input, dt);  // 调试：左手柄摇杆/XY键 实时微调提示框位置（调参用）
    if (game) { this.skillHint.update(dt, game); }  // 每帧驱动闪烁/就绪状态（game 直接传给面板绘制）
    this.streak.attach(this.root);          // 幂等：挂到枪上（等模型/手柄就绪）
    this.streak.update(dt, game);           // 连杀计数（值没变则完全不重绘，零纹理上传）
  }

  // 后坐力：在 _applyTransform 把基准变换重置后，叠加一层「后退 + 枪口上跳」，并指数回正。
  // 仅作用于枪模型本体，不碰射击/碰撞/血量逻辑。
  _applyRecoil(dt, input) {
    const R = GUN.RECOIL;
    if (R.ENABLED && input) {
      const fired = input.shotsFired || 0;
      const delta = fired - this._lastShots;   // 本帧新开的枪数（节流下多为 1）
      this._lastShots = fired;
      if (delta > 0) {
        // 射速归一化：preview(500ms)→0(最大幅度)，full(100ms)→1(最小幅度)
        const norm = this._fireRateNorm(input._gunCooldown);
        const k = Math.pow(norm, R.CURVE);     // 曲率：快射时幅度掉得更陡
        this._recoilZ += THREE.MathUtils.lerp(R.MAX_BACK, R.MIN_BACK, k) * delta;
        this._recoilPitch += THREE.MathUtils.lerp(R.MAX_PITCH, R.MIN_PITCH, k) * delta;
      }
    } else if (input) {
      this._lastShots = input.shotsFired || 0; // 关闭时同步计数，避免重新开启瞬间暴冲
    }
    // 帧率无关的指数回正
    const f = Math.pow(R.DECAY, dt * 60);
    this._recoilZ *= f;
    this._recoilPitch *= f;
    // 叠加到已重置的基准变换之上（本地坐标：+Z 为后退，+X 旋转为枪口上抬）
    this.root.position.z += this._recoilZ;
    this.root.rotation.x += this._recoilPitch;
  }

  // 当前射速归一化：cooldown 越小(越快) → 越接近 1（后坐力幅度越小）
  _fireRateNorm(cd) {
    const slow = GUN_MODES.preview.cooldown;  // 500
    const fast = GUN_MODES.full.cooldown;     // 100
    if (!(fast < slow)) return 0;
    const t = (slow - (cd || slow)) / (slow - fast);
    return THREE.MathUtils.clamp(t, 0, 1);
  }

  /**
   * 枪上「商店币」小信息框（第六十四修建；第六十五修改口径）。
   *   ① 显隐：现场要求「在非商店关时看到商店币数量」⇒ 局内常显（playing / 抽卡），菜单才收起
   *      （判据在 game._shopCoinBadgeOn，由 game 每帧下发，这里只负责显示/隐藏）；
   *   ② 数字：真实余额即时入账，但**显示值等金点落地**（advanceShown 内部按 inflight 兜底对齐，
   *      见 game/shopCoinDisplay.js），所以金点还在飞时数字会比真实值小一点。
   * @param {boolean} on       是否显示（局内 = true）
   * @param {number}  coin     当前商店币真实余额
   * @param {number}  inflight 还在飞的金点数量（> 0 → 显示值允许落后，等落地补齐）
   * @param {number}  landed   本帧落地的金点金额
   */
  setShopCoin(on, coin, inflight = 0, landed = 0) {
    const b = this.coinBadge;
    if (!b) return;
    b.show(on);
    b.update({ total: coin, inflight, landed });
  }

  /** 金点终点：小框当帧的世界坐标（拿不到 / 没挂上 → null ⇒ 在飞的金点立刻落地） */
  coinBadgeWorldPos(out) { return this.coinBadge ? this.coinBadge.worldPosition(out) : null; }

  _applyTransform() {
    this.root.position.set(GUN.POSITION.x, GUN.POSITION.y, GUN.POSITION.z);
    this.root.rotation.set(D2R(GUN.ROTATION.x), D2R(GUN.ROTATION.y), D2R(GUN.ROTATION.z));
    this.root.scale.setScalar(GUN.SCALE);
  }
}
