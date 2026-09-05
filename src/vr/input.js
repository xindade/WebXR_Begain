import * as THREE from 'three';
import { MOVE, SHOOT, GUN_MODES, TEST } from '../core/constants.js';

// 输入抽象层：一套接口同时支持
//  - 桌面：WASD/方向键移动 + 鼠标视角(pointer lock) + 左键射击 + F 大招
//  - VR：xr-standard 手柄，按 handedness 区分左右手（参考 vr-controller-kit skill）
//    右手扳机=射击、右手 A/B=退出 VR、任一握柄(grip)=如来神掌
//    摇杆 PICO 用 axes[2]/[3]，回退 [0]/[1]；PICO 前推为负值，移动时取反
// 未来新增手部追踪只需在此扩展，不影响游戏逻辑。

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const TRIGGER_THRESHOLD = 0.5;

export class InputManager {
  constructor(world, playerRig) {
    this.world = world;
    this.rig = playerRig;
    this.camera = world.camera;

    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.locked = false;
    this.desktopShooting = false;
    this.shots = []; // 本帧待发射：{position, direction}
    this.shotsFired = 0; // 累计开火次数（单调递增，供枪模型后坐力检测「本帧新开了几枪」）

    this._cooldowns = { desktop: 0, left: 0, right: 0 };
    this._gunCooldown = (GUN_MODES.preview || { cooldown: SHOOT.COOLDOWN }).cooldown; // 射击冷却 ms（由 setGunMode/setFireRate 设置）
    this._baseGunCooldown = this._gunCooldown; // 基线冷却
    this._fireRateMul = 1;                    // 射速倍率（旧模型遗留，保留兼容）
    this._fireRate = 2;                       // 当前射速（发/秒）：默认 2，卡 +2/上限14，切关由 game 用 player.fireRate 复位
    this._skillQueued = false;
    this._creditQueued = 0; // 测试积分待消费值（按测试键 +TEST.ADD_SCORE，由 game 消费后加分）

    // handedness -> { controller, prevTrigger, prevGrip, prevAB }
    this._hands = { left: null, right: null };
    this._controllers = []; // 索引存储，供视觉/兜底
    this._gripHands = { left: null, right: null };
    this._grips = []; // 索引存储，供手腕面板挂载

    this._bindDesktop();
    this._bindXR();
  }

  _bindDesktop() {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'KeyF') this._skillQueued = true; // 技能（桌面，触发选中技能）
      if (e.code === 'KeyG' && TEST.ENABLED && TEST.DESKTOP_KEY_G) this._creditQueued = TEST.ADD_SCORE; // 测试积分（桌面，等价于 VR 左手 X）
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    const canvas = this.world.renderer.domElement;
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (this.world.isPresenting) return;
      if (!this.locked) {
        canvas.requestPointerLock?.();
        return; // 第一次点击仅锁定
      }
      this.desktopShooting = true;
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.desktopShooting = false; });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked || this.world.isPresenting) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -1.2, 1.2);
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
  }

  _bindXR() {
    for (let i = 0; i < 2; i++) {
      const ctrl = this.world.renderer.xr.getController(i);
      const grip = this.world.renderer.xr.getControllerGrip(i);
      this._grips[i] = grip;
      ctrl.userData.hand = null;
      ctrl.userData.prevTrigger = false;
      ctrl.userData.prevGrip = false;
      ctrl.userData.prevAB = false;

      // connected 事件里拿到 handedness，正确区分左右手（不能只靠索引）
      ctrl.addEventListener('connected', (e) => {
        const hand = e.data?.handedness || (i === 0 ? 'left' : 'right');
        ctrl.userData.hand = hand;
        ctrl.userData.inputSource = e.data;
        this._hands[hand] = ctrl;
        this._gripHands[hand] = this._grips[i];
        // 右手射线：变红 + 绕 X 轴俯仰 RIGHT_PITCH_DEG（与子弹方向共用同一俯角）
        const ray = ctrl.userData.rayLine;
        if (ray && hand === 'right') {
          ray.material.color.setHex(SHOOT.RAY_COLOR);
          ray.rotation.x = THREE.MathUtils.degToRad(SHOOT.RIGHT_PITCH_DEG);
        }
      });
      ctrl.addEventListener('disconnected', () => {
        if (ctrl.userData.hand) this._hands[ctrl.userData.hand] = null;
        ctrl.userData.inputSource = null;
      });

      // 可见光标（射线）：默认左手青色、沿本地 -Z；右手在 connected 时改红并绕 X 俯仰
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: SHOOT.RAY_COLOR_LEFT }));
      line.scale.z = SHOOT.RAY_LENGTH;
      ctrl.add(line);
      ctrl.userData.rayLine = line;   // 存引用，connected 时按左右手调整颜色/俯角
      // 挂到 rig 而非 camera：控制器位姿本身已在参考空间内，
      // 再作为 camera 子节点会重复叠加头部变换导致偏移。
      this.rig.add(ctrl);
      this.rig.add(grip);
      this._controllers.push(ctrl);
    }
  }

  _applyDesktopLook() {
    if (this.world.isPresenting) return;
    const e = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(e);
  }

  // 读取某手柄的 gamepad（优先按 handedness，回退到 inputSource 缓存）
  _gamepadOf(hand) {
    const session = this.world.renderer.xr.getSession?.();
    if (session?.inputSources) {
      for (const src of session.inputSources) {
        if (src.handedness === hand && src.gamepad) return src.gamepad;
      }
    }
    return null;
  }

  // 返回本帧移动向量（本地坐标：x=右, z=前）
  _moveVector() {
    const m = { x: 0, z: 0 };
    if (this.world.isPresenting) {
      // 仅右手摇杆负责玩家移动
      const gp = this._gamepadOf('right');
      if (gp) {
        let sx = 0, sy = 0;
        if (gp.axes.length >= 4) { sx = gp.axes[2]; sy = gp.axes[3]; }
        else if (gp.axes.length >= 2) { sx = gp.axes[0]; sy = gp.axes[1]; }
        if (!(Math.abs(sx) < MOVE.DEADZONE && Math.abs(sy) < MOVE.DEADZONE)) {
          // PICO 前推为负值，取反 → z 前为正推进量，随后映射到本地 -z 前方
          m.x = sx;
          m.z = sy; // 保持原始，_applyLocomotion 使用相机前向量已含方向
        }
      }
    } else {
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) m.z -= 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) m.z += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) m.x -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) m.x += 1;
    }
    const len = Math.hypot(m.x, m.z);
    if (len > 1) { m.x /= len; m.z /= len; }
    return m;
  }

  // 左手摇杆读取已移除（测试确认不需要，见 2026-08-25 改动）

  _applyLocomotion(m, dt) {
    if (m.x === 0 && m.z === 0) return;
    const speed = MOVE.SPEED * dt;
    if (this.world.isPresenting) {
      // 顺相机水平朝向移动；PICO 摇杆前推为负 → 取反后作为前进量
      const forward = _v.set(0, 0, -1).applyQuaternion(this.camera.quaternion); forward.y = 0; forward.normalize();
      const right = _v2.set(1, 0, 0).applyQuaternion(this.camera.quaternion); right.y = 0; right.normalize();
      const fwdAmt = -m.z; // 前推(负)→前进(正)
      this.rig.position.x += (forward.x * fwdAmt + right.x * m.x) * speed;
      this.rig.position.z += (forward.z * fwdAmt + right.z * m.x) * speed;
    } else {
      const yaw = this.yaw;
      const sin = Math.sin(yaw), cos = Math.cos(yaw);
      const wx = (m.x * cos + m.z * sin);
      const wz = (-m.x * sin + m.z * cos);
      this.rig.position.x += wx * MOVE.SPEED * dt;
      this.rig.position.z += wz * MOVE.SPEED * dt;
    }
    this.rig.position.x = THREE.MathUtils.clamp(this.rig.position.x, -MOVE.BOUND_X, MOVE.BOUND_X);
    this.rig.position.z = THREE.MathUtils.clamp(this.rig.position.z, -MOVE.BOUND_Z, MOVE.BOUND_Z);
  }

  // 世界 -Z 朝向（相机/手柄的「指向前方」方向）。
  // 注意：getWorldDirection 返回的是 +Z 轴，对相机和 XR 手柄而言那是后方，
  // 必须取 -Z 才是真正的瞄准方向，否则子弹/卡牌射线会反着打。
  _forwardOf(obj, out) {
    obj.getWorldQuaternion(_q);
    return out.set(0, 0, -1).applyQuaternion(_q).normalize();
  }

  // 右手 AK 枪瞄准：方向 = 本地 -Z 绕 X 俯仰 RIGHT_PITCH_DEG 后转世界；与红色射线朝向一致。
  // 出生点 = 手柄世界位置沿该方向前移 SPAWN_OFFSET（模拟枪口）。写入 outPos / outDir。
  _rightAim(ctrl, outPos, outDir) {
    const t = THREE.MathUtils.degToRad(SHOOT.RIGHT_PITCH_DEG);
    // 本地方向：(0,0,-1) 绕 X 轴旋转 t → (0, sin t, -cos t)
    outDir.set(0, Math.sin(t), -Math.cos(t));
    ctrl.getWorldQuaternion(_q);
    outDir.applyQuaternion(_q).normalize();
    ctrl.getWorldPosition(outPos);
    outPos.addScaledVector(outDir, SHOOT.SPAWN_OFFSET);
  }

  // 枪械模式切换：preview=初始态, full=满状态（由 game.start 注入）
  // 仅复位射速基线（发/秒模型），弹道数 shotCount 由 player 维护；game 切关会再调用 setFireRate(player.fireRate)
  setGunMode(mode) {
    const g = GUN_MODES[mode] || GUN_MODES.preview;
    this.setFireRate(this._fireRate || 2); // 冷却基线复位为默认 2 发/秒（清掉上关射速卡叠加）
  }

  // 射速（发/秒）模型：卡牌/切关设置。真实改写节流源 _gunCooldown，使实际射速随之变化（2 发/秒 → 冷却 500ms）
  setFireRate(shotsPerSec) {
    this._fireRate = shotsPerSec;
    const cd = shotsPerSec > 0 ? 1000 / shotsPerSec : 1000; // 冷却 ms
    this._baseGunCooldown = cd;
    this._gunCooldown = cd;
  }

  // 射速倍率（旧模型遗留，保留兼容）：mul<1=更快
  setFireRateMul(mul) {
    this._fireRateMul = mul;
    this._gunCooldown = this._baseGunCooldown * mul;
  }

  // 枪口位姿：取右手柄世界位置 + 瞄准方向（含俯角，与红射线/子弹一致）；无右手柄（桌面）回退相机
  getMuzzle(outPos, outDir) {
    const ctrl = this._hands['right'];
    if (ctrl) { this._rightAim(ctrl, outPos, outDir); return; }
    this.camera.getWorldPosition(outPos);
    this._forwardOf(this.camera, outDir);
  }

  _tryShootDesktop(dt) {
    this._cooldowns.desktop -= dt * 1000;
    if (this.desktopShooting && !this.world.isPresenting && this._cooldowns.desktop <= 0) {
      this.camera.getWorldPosition(_v);
      this._forwardOf(this.camera, _v2);
      this.shots.push({ position: _v.clone(), direction: _v2.clone() });
      this.shotsFired++;
      this._cooldowns.desktop = this._gunCooldown;
    }
  }

  // VR：读取双手按键，处理射击/大招/确认/退出（用边缘检测避免连触）
  _updateXR(dt) {
    const session = this.world.renderer.xr.getSession?.();
    if (!session?.inputSources) return;

    this._cooldowns.right -= dt * 1000;
    this._cooldowns.left -= dt * 1000;

    for (const src of session.inputSources) {
      const gp = src.gamepad;
      if (!gp) continue;
      const hand = src.handedness;
      const ctrl = this._hands[hand];

      const triggerVal = gp.buttons[0]?.value || 0;
      const trigger = triggerVal > TRIGGER_THRESHOLD;
      const grip = gp.buttons[1]?.pressed || false;
      const btnA = gp.buttons[4]?.pressed || false; // 右:A / 左:X
      const btnB = gp.buttons[5]?.pressed || false; // 右:B / 左:Y

      // 握柄按下（边缘）→ 触发选中技能（左右手均可；激光剑是左手武器，用左手 grip 最直觉）
      if (ctrl) {
        if (grip && !ctrl.userData.prevGrip) this._skillQueued = true;
        ctrl.userData.prevGrip = grip;
      }

      if (hand === 'right') {
        // 右手扳机：射击（冷却控制）+ 抽卡确认（边缘）
        if (trigger) {
          if (ctrl && this._cooldowns.right <= 0) {
            this._rightAim(ctrl, _v, _v2);   // 方向含俯角、出生点含枪口偏移（与红色射线一致）
            this.shots.push({ position: _v.clone(), direction: _v2.clone() });
            this.shotsFired++;
            this._cooldowns.right = this._gunCooldown;
          }
        }
        if (ctrl) ctrl.userData.prevTrigger = trigger;

        // A/B（边缘）→ 退出 VR
        const ab = btnA || btnB;
        if (ctrl) {
          if (ab && !ctrl.userData.prevAB) session.end?.();
          ctrl.userData.prevAB = ab;
        }
      } else if (hand === 'left') {
        // 左手扳机：记录扳机边缘状态
        if (ctrl) ctrl.userData.prevTrigger = trigger;
        // 左手 X 键（buttons[4]，即「右:A / 左:X」的 X）边缘按下 → 测试积分（仅 TEST.ENABLED 时）
        if (ctrl) {
          const xNow = btnA;
          if (xNow && !ctrl.userData.prevX && TEST.ENABLED && TEST.VR_BUTTON_LEFT_X) this._creditQueued = TEST.ADD_SCORE;
          ctrl.userData.prevX = xNow;
        }
      }
    }
  }

  update(dt) {
    this.shots.length = 0;
    this._applyDesktopLook();
    const m = this._moveVector();
    this._applyLocomotion(m, dt);

    if (this.world.isPresenting) this._updateXR(dt);
    else this._tryShootDesktop(dt);
  }

  // 取手柄（targetRay，用于射击/瞄准/挂面板）
  getController(hand) { return this._hands[hand]; }
  // 取握把（grip，用于挂手腕面板，更贴合手背）
  getGrip(hand) { return this._gripHands[hand]; }

  // 技能触发（桌面 F / VR 右手握柄）：返回本帧是否请求释放「选中技能」
  consumeSkill() { const v = this._skillQueued; this._skillQueued = false; return v; }

  // 测试积分触发（桌面 G / VR 左手 X）：返回本帧待加的积分数（0=无），消费后清零
  consumeCredit() { const v = this._creditQueued; this._creditQueued = 0; return v; }
}
